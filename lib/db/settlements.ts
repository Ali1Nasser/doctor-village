/**
 * lib/db/settlements.ts — the three cycles from migration 0021.
 *
 *   1. reconciliation adjustments — settling a bank/book difference
 *   2. credit operations — applying or refunding an owner's credit
 *   3. period close / reopen
 *
 * ## Every guard that matters is in the schema, not here
 *
 * ADR-024. The checks below exist to produce Arabic sentences a treasurer can
 * act on; the refusals themselves come from triggers in 0021 and hold even if
 * this entire file is deleted. Where the two appear to duplicate each other,
 * the trigger is the control and this is the message.
 *
 * ## The posting shapes
 *
 * Reconciliation adjustment (`amount` always positive; direction from `kind`):
 *
 *   bank_fee            Dr 5902 مصاريف بنكية      Cr 1102 البنك
 *   bank_interest       Dr 1102 البنك             Cr 4199 إيرادات أخرى
 *   unrecorded_receipt  Dr 1102 البنك             Cr 1901 تسوية مؤقت
 *   unrecorded_payment  Dr 1901 تسوية مؤقت        Cr 1102 البنك
 *   error_correction    direction from the sign the treasurer states
 *   timing              — no entry, ever (trg_adjustment_timing_never_posts)
 *
 * The two `unrecorded_*` kinds deliberately land in **suspense**, not in a
 * revenue or expense account. The village knows money moved and does not yet
 * know why; guessing a category here is how an unexplained 3,200 ج.م becomes a
 * "maintenance expense" nobody can ever trace back. `v_suspense_balance` puts
 * the total on /admin/health so it is visibly someone's job to clear it.
 *
 * Credit apply:   Dr 2102 أرصدة دائنة للملاك   Cr 1301 مستحقات على الملاك
 * Credit refund:  Dr 2102 أرصدة دائنة للملاك   Cr <payout asset account>
 *
 * Both debit the liability, because discharging a debt reduces it. An apply
 * clears a receivable; a refund moves cash.
 */

import type { AuthContext, Id } from '../../types/domain.js';
import { require_, can, Forbidden, assertMakerChecker } from '../rbac.js';
import type { Db } from './driver.js';
import { LedgerRefused, asRefusal } from './driver.js';
import { newId, NotFound, writeAudit, type Clock } from './index.js';

const A_BANK      = 'ACC00000000000000000001102';
const A_SUSPENSE  = 'ACC00000000000000000001901';
const A_RECEIVABLE = 'ACC00000000000000000001301';
const L_CREDIT    = 'ACC00000000000000000002102';
const I_OTHER     = 'ACC00000000000000000004199';
const E_BANKFEE   = 'ACC00000000000000000005902';

export type AdjustmentKind =
  | 'timing' | 'bank_fee' | 'bank_interest'
  | 'unrecorded_receipt' | 'unrecorded_payment' | 'error_correction';

/** Which accounts a kind posts to. `timing` has none, by construction. */
const POSTING: Record<Exclude<AdjustmentKind, 'timing'>, { dr: string; cr: string }> = {
  bank_fee:           { dr: E_BANKFEE,  cr: A_BANK },
  bank_interest:      { dr: A_BANK,     cr: I_OTHER },
  unrecorded_receipt: { dr: A_BANK,     cr: A_SUSPENSE },
  unrecorded_payment: { dr: A_SUSPENSE, cr: A_BANK },
  error_correction:   { dr: A_SUSPENSE, cr: A_BANK },
};

async function operatingFund(db: Db): Promise<string | null> {
  const f = await db.prepare(`SELECT id FROM funds WHERE kind='operating' LIMIT 1`)
    .first<{ id: string }>();
  return f?.id ?? null;
}

async function nextEntryNo(db: Db, prefix: string): Promise<string> {
  const r = await db.prepare(
    `SELECT COUNT(*) n FROM journal_entries WHERE entry_no LIKE ?`
  ).bind(`${prefix}-%`).first<{ n: number }>();
  return `${prefix}-${String((r?.n ?? 0) + 1).padStart(5, '0')}`;
}

/* ===================================================================== */
/* 1. Reconciliation adjustments                                         */
/* ===================================================================== */

export interface RequestAdjustmentInput {
  reconciliationId: Id;
  kind: AdjustmentKind;
  amountPiastres: number;
  reasonAr: string;
}

/**
 * The maker step. Recording an adjustment does not move a piastre — it opens a
 * question that a second person has to answer.
 */
export async function requestAdjustment(
  ctx: AuthContext, db: Db, input: RequestAdjustmentInput, clock: Clock,
): Promise<Id> {
  require_(ctx.role, 'expense.record');
  if (!Number.isInteger(input.amountPiastres) || input.amountPiastres <= 0) {
    throw new LedgerRefused('المبلغ لازم يكون رقم صحيح أكبر من صفر');
  }
  if (String(input.reasonAr ?? '').trim().length < 8) {
    throw new LedgerRefused('اكتب سبب واضح للفرق — مش أقل من 8 حروف');
  }

  const recon = await db.prepare(`SELECT id FROM reconciliations WHERE id = ?`)
    .bind(input.reconciliationId).first<{ id: string }>();
  if (!recon) throw new NotFound('المطابقة دي مش موجودة');

  const id = newId('ADJ') as Id;
  try {
    await db.prepare(
      `INSERT INTO reconciliation_adjustments
         (id, reconciliation_id, kind, amount_piastres, reason_ar, requested_by, requested_at)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(id, input.reconciliationId, input.kind, input.amountPiastres,
           input.reasonAr.trim(), ctx.personId, clock()).run();
  } catch (e) {
    // uq_adj_one_open_per_recon: two people settling the same difference.
    throw asRefusal(e);
  }
  await writeAudit(db, ctx, 'settlement.request', 'reconciliation_adjustments', id, null,
    { kind: input.kind, amount: input.amountPiastres });
  return id;
}

/**
 * The checker step: approve AND post, in one transaction.
 *
 * Deliberately not two calls. An "approved but unposted" adjustment is a state
 * with no meaning to anybody — the board decided, so the books should say so —
 * and every extra intermediate state is another row that can be left behind.
 *
 * A `timing` adjustment is refused here and by the trigger. Approving it as
 * *examined and dismissed* is a different action (`dismissTiming`).
 */
export async function approveAndPostAdjustment(
  ctx: AuthContext, db: Db, adjustmentId: Id, periodId: Id, clock: Clock,
): Promise<{ entryId: Id }> {
  require_(ctx.role, 'expense.countersign');

  const a = await db.prepare(
    `SELECT a.id, a.kind, a.amount_piastres, a.reason_ar, a.status, a.requested_by,
            r.as_of
       FROM reconciliation_adjustments a
       JOIN reconciliations r ON r.id = a.reconciliation_id
      WHERE a.id = ?`
  ).bind(adjustmentId).first<{
    id: string; kind: AdjustmentKind; amount_piastres: number;
    reason_ar: string; status: string; requested_by: string; as_of: string;
  }>();
  if (!a) throw new NotFound('التسوية دي مش موجودة');
  if (a.status !== 'requested') {
    throw new LedgerRefused('التسوية دي مش مستنية اعتماد');
  }
  assertMakerChecker(ctx.personId, a.requested_by as Id, 'settlement.approve');

  if (a.kind === 'timing') {
    throw new LedgerRefused(
      'فرق التوقيت مش بيتقفل بقيد — الشيك هيصفّى لوحده. استخدم «اتراجع وانتهى» بدل الترحيل.');
  }

  const p = POSTING[a.kind];
  const entryId = newId('JE') as Id;
  const entryNo = await nextEntryNo(db, 'ADJ');
  const fund = await operatingFund(db);
  const ts = clock();
  const desc = `تسوية مطابقة — ${a.reason_ar}`;

  try {
    await db.batch([
      db.prepare(
        `INSERT INTO journal_entries (id, entry_no, entry_date, period_id, description_ar,
           source_type, source_id, created_by)
         VALUES (?,?,?,?,?, 'adjustment', ?, ?)`
      ).bind(entryId, entryNo, a.as_of, periodId, desc, a.id, a.requested_by),
      db.prepare(
        `INSERT INTO journal_lines (id, entry_id, line_no, account_id, fund_id,
           debit_piastres, credit_piastres, memo_ar) VALUES (?,?,1,?,?,?,0,?)`
      ).bind(newId('JL'), entryId, p.dr, fund, a.amount_piastres, a.reason_ar),
      db.prepare(
        `INSERT INTO journal_lines (id, entry_id, line_no, account_id, fund_id,
           debit_piastres, credit_piastres, memo_ar) VALUES (?,?,2,?,?,0,?,?)`
      ).bind(newId('JL'), entryId, p.cr, fund, a.amount_piastres, a.reason_ar),
      // Posting LAST — trg_entry_balanced validates here, with the lines in.
      db.prepare(`UPDATE journal_entries SET approved_by = ?, posted_at = ? WHERE id = ?`)
        .bind(ctx.personId, ts, entryId),
      db.prepare(
        `UPDATE reconciliation_adjustments
            SET status = 'posted', approved_by = ?, approved_at = ?, journal_entry_id = ?
          WHERE id = ? AND status = 'requested'`
      ).bind(ctx.personId, ts, entryId, a.id),
      db.prepare(
        `INSERT INTO audit_log (id, actor_id, actor_role, action, entity_table,
           entity_id, after_json, created_at)
         VALUES (?,?,?, 'settlement.post', 'reconciliation_adjustments', ?, ?, ?)`
      ).bind(newId('AUD'), ctx.personId, ctx.role, a.id,
             JSON.stringify({ entryId, kind: a.kind, amount: a.amount_piastres }), ts),
    ]);
  } catch (e) {
    throw asRefusal(e);
  }
  return { entryId };
}

/**
 * A timing difference, examined and closed without an entry.
 *
 * This exists so "we looked at it" is recordable. Without it the only way to
 * clear a timing difference from the queue is to post it — which is exactly the
 * mistake the trigger refuses, and a queue that cannot be cleared honestly is a
 * queue people learn to clear dishonestly.
 */
export async function dismissTiming(
  ctx: AuthContext, db: Db, adjustmentId: Id, noteAr: string, clock: Clock,
): Promise<void> {
  require_(ctx.role, 'expense.countersign');
  const a = await db.prepare(
    `SELECT kind, status, requested_by FROM reconciliation_adjustments WHERE id = ?`
  ).bind(adjustmentId).first<{ kind: string; status: string; requested_by: string }>();
  if (!a) throw new NotFound('التسوية دي مش موجودة');
  if (a.kind !== 'timing') {
    throw new LedgerRefused('ده مش فرق توقيت — لازم يترحّل أو يترفض بسبب');
  }
  assertMakerChecker(ctx.personId, a.requested_by as Id, 'settlement.dismiss');

  await db.prepare(
    `UPDATE reconciliation_adjustments
        SET status = 'rejected', approved_by = ?, approved_at = ?
      WHERE id = ? AND status = 'requested'`
  ).bind(ctx.personId, clock(), adjustmentId).run();
  await writeAudit(db, ctx, 'settlement.dismiss_timing', 'reconciliation_adjustments',
    adjustmentId, null, { note_ar: noteAr });
}

/**
 * Reverse a posted settlement. Requires a THIRD person — see 0021's header.
 * The reversal is a new balanced entry with the lines swapped; the original
 * stays visible, because a correction that hides its target is not a correction.
 */
export async function reverseAdjustment(
  ctx: AuthContext, db: Db, adjustmentId: Id, periodId: Id,
  reasonAr: string, clock: Clock,
): Promise<{ entryId: Id }> {
  require_(ctx.role, 'expense.reverse');
  if (String(reasonAr ?? '').trim().length < 8) {
    throw new LedgerRefused('اكتب سبب واضح للعكس');
  }

  const a = await db.prepare(
    `SELECT a.id, a.kind, a.amount_piastres, a.status, a.requested_by, a.approved_by, r.as_of
       FROM reconciliation_adjustments a
       JOIN reconciliations r ON r.id = a.reconciliation_id
      WHERE a.id = ?`
  ).bind(adjustmentId).first<{
    id: string; kind: Exclude<AdjustmentKind, 'timing'>; amount_piastres: number;
    status: string; requested_by: string; approved_by: string | null; as_of: string;
  }>();
  if (!a) throw new NotFound('التسوية دي مش موجودة');
  if (a.status !== 'posted') throw new LedgerRefused('التسوية دي مش مرحّلة عشان تتعكس');
  if (ctx.personId === a.requested_by || ctx.personId === a.approved_by) {
    throw new Forbidden('settlement.reverse',
      'عكس التسوية محتاج شخص تالت غير اللي طلبها واللي اعتمدها');
  }

  // `created_by` is the ORIGINAL maker, not the reverser. `trg_entry_maker_checker`
  // refuses an entry whose creator approved it, and a reverser acting alone would
  // be both — so naming themselves twice makes every reversal impossible. Using
  // the original maker is also the truer statement: this entry exists because of
  // their item, and the third person is the one approving that it be undone.
  const p = POSTING[a.kind];
  const entryId = newId('JE') as Id;
  const entryNo = await nextEntryNo(db, 'REV');
  const fund = await operatingFund(db);
  const ts = clock();

  try {
    await db.batch([
      db.prepare(
        `INSERT INTO journal_entries (id, entry_no, entry_date, period_id, description_ar,
           source_type, source_id, created_by)
         VALUES (?,?,?,?,?, 'adjustment', ?, ?)`
      ).bind(entryId, entryNo, a.as_of, periodId,
             `عكس تسوية — ${reasonAr}`, a.id, a.requested_by),
      // swapped
      db.prepare(
        `INSERT INTO journal_lines (id, entry_id, line_no, account_id, fund_id,
           debit_piastres, credit_piastres, memo_ar) VALUES (?,?,1,?,?,?,0,?)`
      ).bind(newId('JL'), entryId, p.cr, fund, a.amount_piastres, reasonAr),
      db.prepare(
        `INSERT INTO journal_lines (id, entry_id, line_no, account_id, fund_id,
           debit_piastres, credit_piastres, memo_ar) VALUES (?,?,2,?,?,0,?,?)`
      ).bind(newId('JL'), entryId, p.dr, fund, a.amount_piastres, reasonAr),
      db.prepare(`UPDATE journal_entries SET approved_by = ?, posted_at = ? WHERE id = ?`)
        .bind(ctx.personId, ts, entryId),
      db.prepare(
        `UPDATE reconciliation_adjustments
            SET status = 'reversed', reversed_by = ?, reversed_at = ?,
                reversal_entry_id = ?, reversal_reason_ar = ?
          WHERE id = ? AND status = 'posted'`
      ).bind(ctx.personId, ts, entryId, reasonAr, a.id),
      db.prepare(
        `INSERT INTO audit_log (id, actor_id, actor_role, action, entity_table,
           entity_id, after_json, created_at)
         VALUES (?,?,?, 'settlement.reverse', 'reconciliation_adjustments', ?, ?, ?)`
      ).bind(newId('AUD'), ctx.personId, ctx.role, a.id,
             JSON.stringify({ entryId, reason_ar: reasonAr }), ts),
    ]);
  } catch (e) {
    throw asRefusal(e);
  }
  return { entryId };
}

export async function listOpenSettlements(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'finance.read_totals');
  const r = await db.prepare(
    `SELECT s.*, p.full_name AS requested_by_name
       FROM v_open_settlements s
       JOIN profiles p ON p.id = s.requested_by
      ORDER BY s.requested_at DESC LIMIT 50`
  ).all();
  return r.results ?? [];
}

export async function suspenseBalance(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'finance.read_totals');
  const r = await db.prepare(`SELECT balance_piastres, entries FROM v_suspense_balance`)
    .first<{ balance_piastres: number; entries: number }>();
  return r ?? { balance_piastres: 0, entries: 0 };
}

/* ===================================================================== */
/* 2. Credit operations                                                  */
/* ===================================================================== */

export interface CreditOpInput {
  creditId: Id;
  operation: 'apply' | 'refund';
  amountPiastres: number;
  appliedToDueId?: Id;
  payoutAccountId?: Id;
  reasonAr: string;
}

export async function requestCreditOperation(
  ctx: AuthContext, db: Db, input: CreditOpInput, clock: Clock,
): Promise<Id> {
  require_(ctx.role, 'expense.record');

  const c = await db.prepare(
    `SELECT rc.id, rc.unit_id, v.remaining_piastres
       FROM resident_credits rc
       JOIN v_open_resident_credits v ON v.credit_id = rc.id
      WHERE rc.id = ?`
  ).bind(input.creditId).first<{ id: string; unit_id: string; remaining_piastres: number }>();
  if (!c) throw new NotFound('الرصيد الدائن ده مش موجود أو مقفول');

  if (input.amountPiastres > c.remaining_piastres) {
    throw new LedgerRefused(
      `المتاح من الرصيد ${(c.remaining_piastres / 100).toFixed(2)} ج.م بس`);
  }

  const id = newId('CRO') as Id;
  try {
    await db.prepare(
      `INSERT INTO credit_operations
         (id, credit_id, unit_id, operation, amount_piastres, applied_to_due_id,
          payout_account_id, reason_ar, requested_by, requested_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, input.creditId, c.unit_id, input.operation, input.amountPiastres,
           input.appliedToDueId ?? null, input.payoutAccountId ?? null,
           input.reasonAr, ctx.personId, clock()).run();
  } catch (e) {
    throw asRefusal(e);
  }
  await writeAudit(db, ctx, 'credit.request', 'credit_operations', id, null,
    { operation: input.operation, amount: input.amountPiastres });
  return id;
}

export async function approveAndPostCreditOperation(
  ctx: AuthContext, db: Db, opId: Id, periodId: Id, clock: Clock,
): Promise<{ entryId: Id }> {
  require_(ctx.role, 'expense.countersign');

  const o = await db.prepare(
    `SELECT id, credit_id, unit_id, operation, amount_piastres, applied_to_due_id,
            payout_account_id, reason_ar, status, requested_by
       FROM credit_operations WHERE id = ?`
  ).bind(opId).first<{
    id: string; credit_id: string; unit_id: string; operation: 'apply' | 'refund';
    amount_piastres: number; applied_to_due_id: string | null;
    payout_account_id: string | null; reason_ar: string;
    status: string; requested_by: string;
  }>();
  if (!o) throw new NotFound('العملية دي مش موجودة');
  if (o.status !== 'requested') throw new LedgerRefused('العملية دي مش مستنية اعتماد');
  assertMakerChecker(ctx.personId, o.requested_by as Id, 'credit.approve');

  // Dr the liability either way: discharging a debt reduces it.
  const dr = L_CREDIT;
  const cr = o.operation === 'apply' ? A_RECEIVABLE : o.payout_account_id!;

  // `journal_entries.source_type` is a closed vocabulary and has no 'credit'
  // member. Rather than widen the CHECK — which would make every existing
  // reader of that column wrong about what it can hold — each operation maps
  // onto the existing term that already describes it: giving money back is a
  // refund, and setting a credit against a receivable reclassifies one balance
  // into another without any cash moving.
  const sourceType = o.operation === 'refund' ? 'refund' : 'reclassification';
  const entryId = newId('JE') as Id;
  const entryNo = await nextEntryNo(db, 'CRD');
  const fund = await operatingFund(db);
  const ts = clock();
  const desc = o.operation === 'apply'
    ? `تطبيق رصيد دائن — ${o.reason_ar}`
    : `ردّ رصيد دائن — ${o.reason_ar}`;

  try {
    await db.batch([
      db.prepare(
        `INSERT INTO journal_entries (id, entry_no, entry_date, period_id, description_ar,
           source_type, source_id, created_by)
         VALUES (?,?,?,?,?, ?, ?, ?)`
      ).bind(entryId, entryNo, ts.slice(0, 10), periodId, desc, sourceType, o.id,
             o.requested_by),
      db.prepare(
        `INSERT INTO journal_lines (id, entry_id, line_no, account_id, fund_id,
           debit_piastres, credit_piastres, unit_id, memo_ar) VALUES (?,?,1,?,?,?,0,?,?)`
      ).bind(newId('JL'), entryId, dr, fund, o.amount_piastres, o.unit_id, o.reason_ar),
      db.prepare(
        `INSERT INTO journal_lines (id, entry_id, line_no, account_id, fund_id,
           debit_piastres, credit_piastres, unit_id, memo_ar) VALUES (?,?,2,?,?,0,?,?,?)`
      ).bind(newId('JL'), entryId, cr, fund, o.amount_piastres, o.unit_id, o.reason_ar),
      db.prepare(`UPDATE journal_entries SET approved_by = ?, posted_at = ? WHERE id = ?`)
        .bind(ctx.personId, ts, entryId),
      db.prepare(
        `UPDATE credit_operations
            SET status = 'posted', approved_by = ?, approved_at = ?, journal_entry_id = ?
          WHERE id = ? AND status = 'requested'`
      ).bind(ctx.personId, ts, entryId, o.id),
      // Close the credit only when nothing is left on it. A partial application
      // must leave the remainder claimable.
      db.prepare(
        `UPDATE resident_credits SET applied_at = ?, applied_to_due_id = ?
          WHERE id = ?
            AND amount_piastres <= (SELECT COALESCE(SUM(amount_piastres),0)
                                      FROM credit_operations
                                     WHERE credit_id = ? AND status = 'posted')`
      ).bind(ts, o.applied_to_due_id, o.credit_id, o.credit_id),
      db.prepare(
        `INSERT INTO audit_log (id, actor_id, actor_role, action, entity_table,
           entity_id, after_json, created_at)
         VALUES (?,?,?, 'credit.post', 'credit_operations', ?, ?, ?)`
      ).bind(newId('AUD'), ctx.personId, ctx.role, o.id,
             JSON.stringify({ entryId, operation: o.operation, amount: o.amount_piastres }), ts),
    ]);
  } catch (e) {
    throw asRefusal(e);
  }
  return { entryId };
}

export async function listOpenCredits(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'finance.read_totals');
  const r = await db.prepare(
    `SELECT v.credit_id, v.unit_id, v.remaining_piastres,
            b.name_ar || ' — ' || u.unit_number AS unit_label
       FROM v_open_resident_credits v
       JOIN units u ON u.id = v.unit_id
       JOIN buildings b ON b.id = u.building_id
      WHERE v.remaining_piastres > 0
      ORDER BY v.remaining_piastres DESC LIMIT 50`
  ).all();
  return r.results ?? [];
}

/* ===================================================================== */
/* 3. Period close / reopen                                              */
/* ===================================================================== */

/**
 * Closing refuses over pending expenses and open reconciliation differences —
 * both by trigger. The messages here name which one so the treasurer knows what
 * to go and finish.
 */
export async function closePeriod(
  ctx: AuthContext, db: Db, periodId: Id, clock: Clock,
): Promise<void> {
  require_(ctx.role, 'period.close');
  const ts = clock();
  try {
    await db.batch([
      db.prepare(
        `UPDATE fiscal_periods SET status = 'closed', closed_by = ?, closed_at = ?
          WHERE id = ? AND status <> 'closed'`
      ).bind(ctx.personId, ts, periodId),
      db.prepare(
        `INSERT INTO period_events (id, period_id, event, actor_id, created_at)
         VALUES (?,?, 'closed', ?, ?)`
      ).bind(newId('PEV'), periodId, ctx.personId, ts),
    ]);
  } catch (e) {
    throw asRefusal(e);
  }
  await writeAudit(db, ctx, 'period.close', 'fiscal_periods', periodId, null, null);
}

/**
 * Reopening must be a different person from whoever closed (trigger), and needs
 * a reason of substance. Closing a period is the board saying "this year is
 * final"; one person being able to unsay that alone makes the statement empty.
 */
export async function reopenPeriod(
  ctx: AuthContext, db: Db, periodId: Id, reasonAr: string, clock: Clock,
): Promise<void> {
  require_(ctx.role, 'period.reopen');
  if (String(reasonAr ?? '').trim().length < 8) {
    throw new LedgerRefused('إعادة فتح الفترة محتاجة سبب مكتوب واضح');
  }
  const p = await db.prepare(`SELECT status, closed_by FROM fiscal_periods WHERE id = ?`)
    .bind(periodId).first<{ status: string; closed_by: string | null }>();
  if (!p) throw new NotFound('الفترة دي مش موجودة');
  if (p.status !== 'closed') throw new LedgerRefused('الفترة دي مش مقفولة أصلًا');
  if (p.closed_by === ctx.personId) {
    throw new Forbidden('period.reopen',
      'اللي قفل الفترة مينفعش هو اللي يفتحها تاني — لازم شخص تاني من المجلس');
  }

  const ts = clock();
  try {
    await db.batch([
      db.prepare(
        `UPDATE fiscal_periods
            SET status = 'reopened', reopened_by = ?, reopened_at = ?, reopen_reason_ar = ?
          WHERE id = ? AND status = 'closed'`
      ).bind(ctx.personId, ts, reasonAr, periodId),
      db.prepare(
        `INSERT INTO period_events (id, period_id, event, actor_id, reason_ar, created_at)
         VALUES (?,?, 'reopened', ?, ?, ?)`
      ).bind(newId('PEV'), periodId, ctx.personId, reasonAr, ts),
    ]);
  } catch (e) {
    throw asRefusal(e);
  }
  await writeAudit(db, ctx, 'period.reopen', 'fiscal_periods', periodId, null,
    { reason_ar: reasonAr });
}

/**
 * Newest first. The tiebreak on `rowid` is not cosmetic: a close and a reopen
 * can land in the same second (and always do under a frozen test clock), and
 * ordering by timestamp alone then returns them in whichever order SQLite
 * happens to scan — so the screen would sometimes claim a period is closed when
 * it was just reopened.
 */
export async function periodHistory(ctx: AuthContext, db: Db, periodId: Id) {
  require_(ctx.role, 'finance.read_totals');
  const r = await db.prepare(
    `SELECT e.event, e.reason_ar, e.created_at, p.full_name AS actor_name
       FROM period_events e JOIN profiles p ON p.id = e.actor_id
      WHERE e.period_id = ?
      ORDER BY e.created_at DESC, e.rowid DESC`
  ).bind(periodId).all();
  return r.results ?? [];
}
