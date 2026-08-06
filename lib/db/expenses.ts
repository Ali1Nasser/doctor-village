/**
 * lib/db/expenses.ts — posting money OUT.
 *
 * `recordExpense` and `countersignExpense` (in `mutations.ts`) capture the fact
 * that money was spent. Neither one moves the ledger. Until this file existed a
 * recorded expense sat in `expenses` with `journal_entry_id IS NULL`, so
 * `/finance` showed every piastre the village had received and none of what it
 * had spent — the treasury overstated by the entire year's costs, invisibly.
 * That is R-043's mirror image and it is why `v_unposted_expenses` is now on
 * the admin screen.
 *
 * ## The posting shape
 *     Dr  5xxx  المصروف        (expense account, from the category)
 *         Cr  1xxx  الأصل      (cash / bank / wallet, per how it was paid)
 *
 * Both lines carry the expense's fund, and both go in **one `db.batch()`** with
 * the status update. `trg_entry_balanced` fires at posting time, and an entry is
 * legitimately unbalanced between its two line inserts — split the batch and it
 * refuses, correctly.
 *
 * ## What this file refuses, and why the refusals live in the database
 * · a fund that is not spendable (an أمانة is not the village's money);
 * · an above-threshold expense with no second signature;
 * · a closed fiscal period;
 * · a category that is not an expense category;
 * · posting the same expense twice.
 * The first three are `RAISE(ABORT)` triggers in `0014` — per ADR-024, a control
 * that must hold belongs in the schema, not in the function that happens to be
 * the caller today. The checks below exist so the resident sees Arabic instead
 * of a constraint name, and they are the message, not the control.
 */

import type { AuthContext, Id } from '../../types/domain.js';
import { require_, can, Forbidden } from '../rbac.js';
import type { Db } from './driver.js';
import { LedgerRefused, asRefusal } from './driver.js';
import { newId, NotFound, type Clock } from './index.js';

export interface PostExpenseInput {
  expenseId: Id;
  /** Which asset account the money actually left. Cash, bank, InstaPay, Vodafone. */
  creditAccountId: Id;
  periodId: Id;
}

interface ExpenseRow {
  id: string; voucher_no: string; amount_piastres: number; spent_on: string;
  description_ar: string; status: string; recorded_by: string;
  approved_by: string | null; fund_id: string | null;
  ledger_account_id: string; category_kind: string; threshold: number;
  is_reversal: number; reverses_expense_id: string | null;
}

/**
 * Post a recorded expense to the ledger.
 *
 * Returns the journal entry id. Idempotent by refusal rather than by silence:
 * a second call throws `LedgerRefused` instead of quietly succeeding, because
 * "already posted" and "just posted" are different facts and an admin tapping
 * twice on a slow connection deserves to know which happened.
 */
export async function postExpense(
  ctx: AuthContext, db: Db, input: PostExpenseInput, now: Clock,
): Promise<Id> {
  /* ⭐ `expense.countersign`, NOT `expense.record`.
   *
   * An operator holds `expense.record` — they type in the receipt from the
   * plumber, which is the whole point of the role. They do NOT hold
   * `expense.countersign`, because `03_RBAC §2` says an operator can never
   * approve money.
   *
   * Posting to the ledger IS approving: it stamps `approved_by` on the journal
   * entry and moves the treasury balance on every resident's screen. Guarding
   * this with `expense.record` — which is what it said, until a test that
   * expected an operator to be refused watched one succeed — would have let the
   * role that exists to have no financial authority move money. */
  require_(ctx.role, 'expense.countersign');

  const e = await db.prepare(
    `SELECT e.id, e.voucher_no, e.amount_piastres, e.spent_on, e.description_ar,
            e.status, e.recorded_by, e.approved_by, e.fund_id,
            e.is_reversal, e.reverses_expense_id,
            c.ledger_account_id, c.kind AS category_kind,
            (SELECT countersign_threshold_piastres FROM settings WHERE id = 1) AS threshold
       FROM expenses e
       JOIN categories c ON c.id = e.category_id
      WHERE e.id = ?`
  ).bind(input.expenseId).first<ExpenseRow>();
  if (!e) throw new NotFound('المصروف ده مش موجود');

  if (e.status === 'posted') throw new LedgerRefused('المصروف ده اترحّل قبل كده');
  if (e.status === 'reversed') throw new LedgerRefused('المصروف ده اتعكس، مينفعش يترحّل');
  if (e.category_kind !== 'expense') {
    throw new LedgerRefused('التصنيف ده مش تصنيف مصروفات');
  }
  // Maker–checker, stated before the trigger so the admin reads Arabic. C8: it
  // binds `developer` identically — there is no role that signs its own.
  if (e.amount_piastres >= e.threshold && !e.approved_by) {
    throw new LedgerRefused(
      'المصروف ده فوق الحد ولازم توقيع تاني من مسؤول مختلف قبل الترحيل');
  }
  if (e.approved_by === e.recorded_by) {
    throw new LedgerRefused('مينفعش نفس الشخص يسجّل ويوقّع — لازم اتنين مختلفين');
  }
  /* ⭐ The poster is never the recorder — even below the threshold.
   *
   * This is not an extra rule I invented; `trg_entry_maker_checker` already
   * refuses a journal entry whose creator is its approver, and it applies to
   * EVERY entry with no threshold. Discovering that the hard way clarified what
   * the threshold actually governs:
   *
   *   · the **threshold** decides whether a countersignature is RECORDED
   *     against the expense — a deliberate, named second approval for large
   *     amounts, which is what a board minutes;
   *   · **maker–checker** decides whether two humans touched the money at all,
   *     and per C8 that has no threshold and no exemption, including for
   *     `developer`.
   *
   * So a 300 ج.م receipt still needs a second person to post it. On a two-admin
   * board that is one tap by whoever did not type it in, and it is the whole
   * reason this system can be trusted by people who already distrust the
   * previous one. Stated here in Arabic so the admin reads a reason instead of
   * a constraint name. */
  if (ctx.personId === e.recorded_by) {
    throw new LedgerRefused('مينفعش ترحّل مصروف إنت اللي سجّلته — لازم مسؤول تاني يرحّله');
  }

  const credit = await db.prepare(
    `SELECT id, type FROM accounts WHERE id = ?`
  ).bind(input.creditAccountId).first<{ id: string; type: string }>();
  if (!credit) throw new NotFound('الحساب ده مش موجود');
  if (credit.type !== 'asset') {
    // Crediting anything else would make the entry balance while describing a
    // transaction that never happened — the R-043 failure mode, in a write.
    throw new LedgerRefused('المصروف لازم يتخصم من حساب أصول — خزنة أو بنك أو محفظة');
  }

  const entryId = newId('JE') as Id;
  const entryNo = await nextVoucher(db, 'J', input.periodId);
  const ts = now();
  const fund = e.fund_id;

  /* A reversal is the same posting with the two lines swapped: Dr asset /
   * Cr expense. Handled here rather than in a second function so that every
   * guard above — spendable fund, open period, maker–checker, threshold,
   * already-posted — applies to a correction exactly as it applies to the
   * original. A correction path with its own posting code is a correction path
   * with its own gaps. */
  const rev = e.is_reversal === 1;
  const dr = rev ? credit.id : e.ledger_account_id;
  const cr = rev ? e.ledger_account_id : credit.id;

  try {
    // ONE batch. `trg_entry_balanced` checks at posting time and the entry is
    // legitimately unbalanced between the two line inserts.
    await db.batch([
      db.prepare(
        `INSERT INTO journal_entries (id, entry_no, entry_date, period_id, description_ar,
           source_type, source_id, created_by)
         VALUES (?,?,?,?,?, 'expense', ?, ?)`
      ).bind(entryId, entryNo, e.spent_on, input.periodId,
             `${e.description_ar} — ${e.voucher_no}`, e.id, e.recorded_by),
      db.prepare(
        `INSERT INTO journal_lines (id, entry_id, line_no, account_id, fund_id,
           debit_piastres, credit_piastres, memo_ar)
         VALUES (?,?,1,?,?,?,0,?)`
      ).bind(newId('JL'), entryId, dr, fund, e.amount_piastres, e.description_ar),
      db.prepare(
        `INSERT INTO journal_lines (id, entry_id, line_no, account_id, fund_id,
           debit_piastres, credit_piastres, memo_ar)
         VALUES (?,?,2,?,?,0,?,?)`
      ).bind(newId('JL'), entryId, cr, fund, e.amount_piastres, e.description_ar),
      db.prepare(
        `UPDATE journal_entries SET approved_by = ?, posted_at = ? WHERE id = ?`
      ).bind(ctx.personId, ts, entryId),
      db.prepare(
        `UPDATE expenses SET status = 'posted', journal_entry_id = ?
          WHERE id = ? AND status IN ('recorded','countersigned')`
      ).bind(entryId, e.id),
      // The write and its audit row in ONE batch — the `mutate()` rule from
      // `mutations.ts`, applied by hand here because this batch also carries the
      // journal entry and its lines, which `mutate()` does not model.
      // Posting a reversal is what actually closes the original. Same batch, so
      // a reversal cannot exist in the books without its target being marked.
      db.prepare(
        rev
          ? `UPDATE expenses SET status = 'reversed'
              WHERE id = (SELECT reverses_expense_id FROM expenses WHERE id = ?)
                AND status = 'posted'`
          : `SELECT 1 WHERE 0`
      ).bind(...(rev ? [e.id] : [])),
      db.prepare(
        `INSERT INTO audit_log (id, actor_id, actor_role, action, entity_table,
           entity_id, after_json, created_at)
         VALUES (?,?,?, 'expense.post', 'expenses', ?, ?, ?)`
      ).bind(newId('AUD'), ctx.personId, ctx.role, e.id,
             JSON.stringify({ entryId, amount: e.amount_piastres, fund }), ts),
    ]);
  } catch (err) {
    // A trigger firing here is a CONTROL WORKING, not a crash. `asRefusal` maps
    // it to 409 with the Arabic reason the trigger raised — a lesson this
    // project learned by shipping a working control that looked like a 500.
    throw asRefusal(err);
  }
  return entryId;
}

/** `E-2026-00133` / `J-2026-000133`. Per-year, gap-tolerant, never reused. */
async function nextVoucher(db: Db, prefix: 'E' | 'J', periodId: Id): Promise<string> {
  const p = await db.prepare(
    `SELECT substr(starts_on, 1, 4) y FROM fiscal_periods WHERE id = ?`
  ).bind(periodId).first<{ y: string }>();
  const year = p?.y ?? '2026';
  const table = prefix === 'E' ? 'expenses' : 'journal_entries';
  const col = prefix === 'E' ? 'voucher_no' : 'entry_no';
  const width = prefix === 'E' ? 5 : 6;
  // R-051: start at the first digit after `X-YYYY-`, which is position 8.
  // Getting this wrong is invisible until the sequence gains a digit and then
  // total — the counter rewinds and every insert collides on a UNIQUE column.
  const r = await db.prepare(
    `SELECT COALESCE(MAX(CAST(substr(${col}, 8) AS INTEGER)), 0) n
       FROM ${table} WHERE ${col} LIKE ?`
  ).bind(`${prefix}-${year}-%`).first<{ n: number }>();
  return `${prefix}-${year}-${String((r?.n ?? 0) + 1).padStart(width, '0')}`;
}

export async function nextExpenseVoucher(
  ctx: AuthContext, db: Db, periodId: Id,
): Promise<string> {
  require_(ctx.role, 'expense.record');
  return nextVoucher(db, 'E', periodId);
}

/** The admin's to-do list: recorded, not yet in the books. */
export async function listExpenseQueue(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'expense.record');
  const r = await db.prepare(`SELECT * FROM v_expense_queue LIMIT 100`).all();
  return r.results;
}

/**
 * Money spent that the books do not yet show.
 *
 * Understates expenses and overstates the treasury by exactly this amount, and
 * is invisible on every other figure — the same shape as R-043, pointing the
 * other way. It belongs on a screen, not only in a query.
 */
export async function unpostedExpenses(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'finance.read_totals');
  const r = await db.prepare(
    `SELECT n, total_piastres FROM v_unposted_expenses`
  ).first<{ n: number; total_piastres: number }>();
  return { count: Number(r?.n ?? 0), totalPiastres: Number(r?.total_piastres ?? 0) };
}

/**
 * The expense ledger.
 *
 * ## The invoice key is included ONLY when the caller may open it
 * ADR-026 made invoice photos visible to members by default, so a resident
 * should see the evidence — that is the entire point of attaching it. But when
 * the board closes `expense_invoices_public`, handing a resident a link that
 * 403s is worse than showing no link: they conclude the evidence is being
 * hidden from them specifically, which is the suspicion this feature exists to
 * remove.
 *
 * So the key is selected conditionally, in SQL, rather than filtered by a
 * template. An earlier version of this function excluded it unconditionally and
 * a test asserted that — written before ADR-026 existed. The test was right
 * about its own moment and wrong afterwards; both were updated together.
 */
export async function listPostedExpenses(ctx: AuthContext, db: Db, limit = 100) {
  require_(ctx.role, 'finance.read_categories');
  const s = await db.prepare(`SELECT expense_invoices_public p FROM settings WHERE id=1`)
    .first<{ p: number }>();
  const mayOpen = !!s?.p || can(ctx.role, 'expense.record');
  const r = await db.prepare(
    `SELECT e.id, e.voucher_no, e.amount_piastres, e.spent_on, e.description_ar,
            e.vendor_name, e.status, e.is_reversal,
            ${mayOpen ? 'e.invoice_storage_key' : 'NULL AS invoice_storage_key'},
            c.name_ar AS category_ar
       FROM expenses e
       JOIN categories c ON c.id = e.category_id
      WHERE e.status IN ('posted','reversed')
      ORDER BY e.spent_on DESC, e.voucher_no DESC
      LIMIT ?`
  ).bind(limit).all();
  return r.results;
}

/* ===================================================================== */
/* Reversal — the ONLY legitimate correction (ADR-006)                   */
/* ===================================================================== */

export interface ReverseExpenseInput {
  expenseId: Id;
  /** Shown to residents verbatim, forever. Required, and length-checked. */
  reasonAr: string;
}

/**
 * Request the reversal of a posted expense. **Does not post it.**
 *
 * ## Why an edit is not on the table
 * `trg_expense_frozen_after_post` refuses to change a posted expense's amount,
 * category or date, and ADR-006 explains why that refusal is a feature: *"a
 * corrected number that silently replaces a number residents already saw
 * destroys trust faster than the original error."* In a community built on
 * suspicion the visible history IS the product. A mistake is corrected by
 * adding a mirror entry; both stay on the record with the reason attached.
 *
 * ## Why this is two steps and not one
 * The first draft created the reversing expense AND posted it in one call, with
 * the same admin as recorder and approver. The database refused it —
 * `CHECK (approved_by IS NULL OR approved_by <> recorded_by)` — and the refusal
 * was right. **Reversing moves money back**; C8 admits no exemption, so it needs
 * two people exactly like the posting it undoes. Building a one-call reversal
 * would have made the correction path the only unguarded path in the system,
 * which is precisely where a correction path goes wrong.
 *
 * So: this creates an ordinary expense row with `is_reversal = 1`, in status
 * `recorded`. A **different** admin then posts it through `postExpense`, which
 * flips the entry's direction and marks the original `reversed`. Every guard
 * that protects an ordinary expense — spendable fund, open period, maker–checker,
 * balanced entry — protects the reversal for free, because it is not a special
 * case.
 *
 * ## What it deliberately does NOT do
 * It does not restore anything or "undo". The money left the account or it did
 * not. A reversal says *"this entry was wrong, here is the offsetting entry, and
 * here is why"* — an accounting statement, not an edit.
 */
export async function requestExpenseReversal(
  ctx: AuthContext, db: Db, input: ReverseExpenseInput, now: Clock,
): Promise<Id> {
  // Not `expense.record`: proposing a reversal is a financial act, and R-058 is
  // the reminder that "who does this?" is the wrong question. `operator` and
  // `finance_reviewer` both lack it.
  require_(ctx.role, 'expense.reverse');

  const reason = (input.reasonAr ?? '').trim();
  if (reason.length < 10) {
    // "غلط" is not a reason. The audience is a resident reading the ledger two
    // years from now, and they cannot ask a follow-up question.
    throw new LedgerRefused('لازم تكتب سبب واضح للإلغاء — الساكن هيقراه بالنص');
  }

  const e = await db.prepare(
    `SELECT id, voucher_no, amount_piastres, spent_on, description_ar, status,
            recorded_by, fund_id, category_id, journal_entry_id
       FROM expenses WHERE id = ?`
  ).bind(input.expenseId).first<{
    id: string; voucher_no: string; amount_piastres: number; spent_on: string;
    description_ar: string; status: string; recorded_by: string;
    fund_id: string | null; category_id: string; journal_entry_id: string | null;
  }>();
  if (!e) throw new NotFound('المصروف ده مش موجود');
  if (e.status === 'reversed') throw new LedgerRefused('المصروف ده اتعكس قبل كده');
  if (e.status !== 'posted') {
    // An unposted expense never reached the books; there is nothing to offset,
    // and reversing it would create a credit for money that never left.
    throw new LedgerRefused('المصروف ده لسه ماترحّلش — مفيش حاجة تتعكس');
  }
  const already = await db.prepare(
    `SELECT id FROM expenses WHERE reverses_expense_id = ? AND status <> 'reversed'`
  ).bind(e.id).first<{ id: string }>();
  if (already) throw new LedgerRefused('فيه طلب إلغاء للمصروف ده مستني بالفعل');

  const period = await db.prepare(
    `SELECT id FROM fiscal_periods WHERE status IN ('open','reopened')
      ORDER BY starts_on DESC LIMIT 1`
  ).first<{ id: string }>();
  if (!period) throw new LedgerRefused('مفيش سنة مالية مفتوحة نرحّل عليها');

  const revId = newId('EXP') as Id;
  const voucher = await nextVoucher(db, 'E', period.id as Id);
  const ts = now();

  try {
    await db.batch([
      db.prepare(
        `INSERT INTO expenses (id, voucher_no, category_id, amount_piastres, spent_on,
           description_ar, fund_id, status, recorded_by, is_reversal,
           reverses_expense_id, reversal_reason_ar)
         VALUES (?,?,?,?,?,?,?, 'recorded', ?, 1, ?, ?)`
      ).bind(revId, voucher, e.category_id, e.amount_piastres, ts.slice(0, 10),
             `إلغاء ${e.voucher_no}: ${e.description_ar}`, e.fund_id,
             ctx.personId, e.id, reason),
      db.prepare(
        `INSERT INTO audit_log (id, actor_id, actor_role, action, entity_table,
           entity_id, after_json, created_at)
         VALUES (?,?,?, 'expense.reverse_requested', 'expenses', ?, ?, ?)`
      ).bind(newId('AUD'), ctx.personId, ctx.role, e.id,
             JSON.stringify({ reversalExpenseId: revId, reason }), ts),
    ]);
  } catch (err) {
    throw asRefusal(err);
  }
  return revId;
}

/* ===================================================================== */
/* What the /admin/expenses screen needs to render                       */
/* ===================================================================== */

/**
 * The categories an expense may be filed under: roll-up level, active, expense
 * direction. Same `parent_id IS NULL` rule the chart uses (R-047), so the entry
 * form cannot create an expense that the breakdown will then double-count.
 */
export async function expenseCategories(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'expense.record');
  const r = await db.prepare(
    `SELECT id, name_ar FROM categories
      WHERE direction = 'expense' AND parent_id IS NULL AND is_active = 1
      ORDER BY sort_order, name_ar`
  ).all();
  return r.results;
}

/**
 * ⭐ Only spendable funds are offered.
 *
 * `trg_expense_fund_spendable_*` refuses a non-spendable fund at the database,
 * so this is not the control — but a dropdown that lists صندوق الودائع and then
 * rejects it teaches the admin that the system is arbitrary. **The interface
 * should not offer what the rules forbid.** The trigger is the guarantee; this
 * is the courtesy.
 */
export async function spendableFunds(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'expense.record');
  const r = await db.prepare(
    `SELECT id, name_ar FROM funds WHERE is_spendable = 1 ORDER BY kind`
  ).all();
  return r.results;
}

/** The fiscal period an entry posts into. Refuses rather than guessing a year. */
export async function openPeriod(ctx: AuthContext, db: Db): Promise<Id> {
  require_(ctx.role, 'expense.record');
  const r = await db.prepare(
    `SELECT id FROM fiscal_periods WHERE status IN ('open','reopened')
      ORDER BY starts_on DESC LIMIT 1`
  ).first<{ id: string }>();
  if (!r) throw new LedgerRefused('مفيش سنة مالية مفتوحة — لازم الإدارة تفتح سنة الأول');
  return r.id as Id;
}

/**
 * Which asset account an expense is credited to by default.
 *
 * `TODO(owner-input)`: the board has not said which account most spending comes
 * out of (Q13 covers the transfer details, not this). Until they do, this picks
 * the bank account and the posting screen does not ask — which is a **known
 * simplification**, not a decision: a cash payment recorded against the bank
 * account will not match the bank statement at reconciliation, and CP-5's
 * monthly reconciliation is where that surfaces. Recorded in ASSUMPTIONS.
 */
export async function defaultCashAccount(ctx: AuthContext, db: Db): Promise<Id> {
  require_(ctx.role, 'expense.record');
  const r = await db.prepare(
    `SELECT id FROM accounts WHERE type = 'asset' AND code = '1102'`
  ).first<{ id: string }>();
  if (!r) throw new NotFound('حساب البنك مش موجود في دليل الحسابات');
  return r.id as Id;
}

/** One expense, for the reversal confirmation screen. */
export async function getExpense(ctx: AuthContext, db: Db, expenseId: Id) {
  require_(ctx.role, 'expense.record');
  const r = await db.prepare(
    `SELECT id, voucher_no, amount_piastres, spent_on, description_ar, status
       FROM expenses WHERE id = ?`
  ).bind(expenseId).first();
  if (!r) throw new NotFound('المصروف ده مش موجود');
  return r;
}

/* ===================================================================== */
/* Invoice photos — evidence for money going out (01_PRD C1)             */
/* ===================================================================== */

/**
 * Attach an invoice photo to a recorded expense.
 *
 * Separate from recording, on purpose. The expense form's whole design claim is
 * **five fields, no JavaScript, sixty seconds** — and an image needs JavaScript
 * to compress before upload. Bolting it onto the form would have cost the
 * property the form exists for. So the photo is a second, optional step on the
 * screen that appears after saving, and a volunteer standing next to a plumber
 * can skip it and come back.
 */
export async function attachInvoice(
  ctx: AuthContext, db: Db, expenseId: Id, storageKey: string, now: Clock,
): Promise<void> {
  require_(ctx.role, 'expense.record');
  const e = await db.prepare(`SELECT id, status FROM expenses WHERE id = ?`)
    .bind(expenseId).first<{ id: string; status: string }>();
  if (!e) throw new NotFound('المصروف ده مش موجود');
  if (e.status === 'reversed') throw new LedgerRefused('المصروف ده اتعكس');
  try {
    await db.batch([
      db.prepare(`UPDATE expenses SET invoice_storage_key = ? WHERE id = ?`)
        .bind(storageKey, expenseId),
      db.prepare(
        `INSERT INTO audit_log (id, actor_id, actor_role, action, entity_table,
           entity_id, after_json, created_at)
         VALUES (?,?,?, 'expense.attach_invoice', 'expenses', ?, ?, ?)`
      ).bind(newId('AUD'), ctx.personId, ctx.role, expenseId,
             JSON.stringify({ storageKey }), now()),
    ]);
  } catch (err) {
    throw asRefusal(err);
  }
}

/**
 * May this caller read this invoice image?
 *
 * ## The rule, and the third party it protects
 * `01_PRD` C2 makes expenses visible to all members, and evidence is the point
 * of attaching a photo. But a supplier's invoice usually carries the supplier's
 * **phone number and bank details** — personal data of someone who never
 * consented, and a live concern under PDPL 151/2020.
 *
 * So: visible to members **by default**, and `expense_invoices_public` lets the
 * board close it without a deploy if a supplier objects. Admins always see it,
 * because they have to be able to check the evidence they are countersigning.
 *
 * The key is resolved back to an expense by **lookup**, never by parsing the
 * path. A path-parsing check is one `../` away from being wrong; a lookup either
 * finds the row or does not.
 */
export async function authorizeInvoiceRead(
  ctx: AuthContext, db: Db, storageKey: string,
): Promise<{ storageKey: string }> {
  const row = await db.prepare(
    `SELECT e.invoice_storage_key k,
            (SELECT expense_invoices_public FROM settings WHERE id = 1) pub
       FROM expenses e WHERE e.invoice_storage_key = ?`
  ).bind(storageKey).first<{ k: string; pub: number }>();
  if (!row) throw new NotFound('الصورة دي مش موجودة');
  if (!row.pub && !can(ctx.role, 'expense.record')) {
    throw new Forbidden('expense_invoice.read', 'صور الفواتير مقفولة على الإدارة حاليًا');
  }
  return { storageKey: row.k };
}

/** How much posted spending has no evidence attached — a question the board will be asked. */
export async function expensesWithoutEvidence(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'finance.read_totals');
  const r = await db.prepare(
    `SELECT n, total_piastres FROM v_expenses_without_evidence`
  ).first<{ n: number; total_piastres: number }>();
  return { count: Number(r?.n ?? 0), totalPiastres: Number(r?.total_piastres ?? 0) };
}

/**
 * Remove an invoice photo.
 *
 * ## Why this exists, and why it is not "undo"
 * The upload warning (ADR-026) is advisory: an operator in a hurry taps through
 * it and a supplier's bank details reach 204 residents. Until now there was no
 * repair at all — the photo was simply out. This is the repair, and it is the
 * only one available, because **nothing can un-see an image a resident already
 * opened.** It stops further exposure; it does not undo the exposure.
 *
 * The expense keeps its ledger entry, its amount and its history untouched:
 * only the evidence link is cleared. That is deliberate — a mis-photographed
 * invoice is not a wrong expense, and reversing the money to fix a photo would
 * be a much larger lie than the photo was.
 *
 * The storage object is soft-deleted rather than dropped so the audit trail
 * still shows something was there, and so the bytes can be purged deliberately
 * rather than by a cascade nobody watched.
 */
export async function removeInvoice(
  ctx: AuthContext, db: Db, expenseId: Id, reasonAr: string, now: Clock,
): Promise<void> {
  // Not `expense.record`: removing evidence is the opposite of recording it, and
  // an operator who uploaded a bad photo should have to tell an admin. Otherwise
  // "remove the evidence" is a power the role with no financial authority holds.
  require_(ctx.role, 'expense.countersign');
  const reason = (reasonAr ?? '').trim();
  if (reason.length < 5) {
    throw new LedgerRefused('اكتب سبب لشيل الصورة — هيتسجّل في السجل');
  }
  const e = await db.prepare(
    `SELECT id, invoice_storage_key k FROM expenses WHERE id = ?`
  ).bind(expenseId).first<{ id: string; k: string | null }>();
  if (!e) throw new NotFound('المصروف ده مش موجود');
  if (!e.k) throw new LedgerRefused('مفيش صورة مرفقة على المصروف ده');

  try {
    await db.batch([
      db.prepare(`UPDATE expenses SET invoice_storage_key = NULL WHERE id = ?`).bind(expenseId),
      db.prepare(`UPDATE storage_objects SET deleted_at = ? WHERE storage_key = ?`)
        .bind(now(), e.k),
      db.prepare(
        `INSERT INTO audit_log (id, actor_id, actor_role, action, entity_table,
           entity_id, before_json, after_json, created_at)
         VALUES (?,?,?, 'expense.remove_invoice', 'expenses', ?, ?, ?, ?)`
      ).bind(newId('AUD'), ctx.personId, ctx.role, expenseId,
             JSON.stringify({ storageKey: e.k }), JSON.stringify({ reason }), now()),
    ]);
  } catch (err) {
    throw asRefusal(err);
  }
}
