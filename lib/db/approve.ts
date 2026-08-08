/**
 * lib/db/approve.ts — approving a receipt, and posting the money it represents.
 *
 * ## The hole this closes, which is the largest one found in this project
 *
 * `/admin/review` renders the queue with an «✅ اعتماد» button whose form posts
 * to `/admin/review/:id`. **That route did not exist.** A board member could
 * look at a receipt and could not accept it — from the deployed site, the
 * central act of the entire product returned 404.
 *
 * The API path was not a substitute. `reviewPayment` takes a `journalEntryId`
 * from its caller and links it; **nothing anywhere created that entry.** So the
 * only way a payment had ever been posted was the demo seed writing the ledger
 * by hand. The product could display a year of accounts it had been handed and
 * could not record one receipt.
 *
 * This is R-078 from the inside: not "a payment approved without a posting",
 * but "no code path that could post one at all".
 *
 * ## The posting shape
 *
 *     Dr  1xxx  الأصل الفعلي        (cash / bank / InstaPay / Vodafone, by method)
 *         Cr  4xxx  الإيراد          (the category's ledger account)
 *
 * and for a deposit — الوديعة is the trap this whole ledger is arranged around
 * (06 §1) — the credit leg lands on a **liability**, because the money is held
 * for the owner and will go back:
 *
 *     Dr  1xxx  الأصل                Cr  2101  ودائع مستردة
 *
 * Nothing here decides that. `categories.ledger_account_id` does, and
 * `trg_category_account_matches_kind` guarantees a `deposit` category points at
 * a liability. This function copies the account off the category rather than
 * branching on `kind`, so the rule lives in one place.
 *
 * ## Overpayment
 *
 * If the board approves more than the flat still owes, the excess is NOT
 * income: it is money the village owes back, so it splits onto `2102 أرصدة
 * دائنة للملاك` and opens a `resident_credits` row. That row is what
 * `/admin/settlements` later applies or refunds.
 *
 * ## Order inside the batch is load-bearing
 *
 * entry (unposted) → lines → **attach the receipt** → post. Migration 0024's
 * orphan-entry guard checks at the moment of posting that the payment this
 * entry names points back at it, and `trg_line_no_insert_posted` refuses a line
 * on an entry that is already posted. Between them, only this order works —
 * which is the correct order anyway: the books should not say "posted" a
 * statement before the receipt says which posting it became.
 */

import type { AuthContext, Id } from '../../types/domain.js';
import { require_, assertMakerChecker } from '../rbac.js';
import type { Db, PreparedStatement } from './driver.js';
import { LedgerRefused, asRefusal } from './driver.js';
import { newId, NotFound, type Clock } from './index.js';

/** Which asset account the money actually landed in. */
const ACCOUNT_FOR_METHOD: Record<string, string> = {
  cash: 'ACC00000000000000000001101',
  bank_transfer: 'ACC00000000000000000001102',
  instapay: 'ACC00000000000000000001103',
  vodafone_cash: 'ACC00000000000000000001104',
  other: 'ACC00000000000000000001102',
};

const ACC_OWNER_CREDITS = 'ACC00000000000000000002102';

interface PaymentForPosting {
  id: string;
  receipt_no: string;
  unit_id: string;
  submitted_by: string;
  status: string;
  method: string;
  transfer_date: string;
  claimed_amount_piastres: number;
  category_ar: string;
  category_kind: string;
  ledger_account_id: string;
  fund_id: string | null;
  fee_period_id: string | null;
  outstanding_piastres: number;
  building_code: string;
  unit_number: string;
}

/**
 * Approve a receipt and post it, in one batch.
 *
 * Returns the entry id and the credit, if the board approved more than the due.
 * Idempotent by refusal: the `WHERE status='under_review'` clause means a
 * double-tapped approve changes zero rows the second time and this throws
 * rather than posting twice (06 §9 invariant 3).
 */
export async function approveAndPost(
  ctx: AuthContext, db: Db, paymentId: Id,
  approvedAmountPiastres: number, reasonAr: string | null, now: Clock,
): Promise<{ entryId: string; creditPiastres: number }> {
  require_(ctx.role, 'payment.review');

  const p = await db.prepare(
    `SELECT p.id, p.receipt_no, p.unit_id, p.submitted_by, p.status, p.method,
            p.transfer_date, p.claimed_amount_piastres, p.fee_period_id,
            c.name_ar AS category_ar, c.kind AS category_kind,
            c.ledger_account_id, COALESCE(p.fund_id, c.default_fund_id) AS fund_id,
            b.code AS building_code, u.unit_number,
            COALESCE((SELECT ub.outstanding_piastres FROM v_unit_balance ub
                       WHERE ub.unit_id = p.unit_id), 0) AS outstanding_piastres
       FROM payments p
       JOIN categories c ON c.id = p.category_id
       JOIN units u      ON u.id = p.unit_id
       JOIN buildings b  ON b.id = u.building_id
      WHERE p.id = ?`
  ).bind(paymentId).first<PaymentForPosting>();
  if (!p) throw new NotFound('الإيصال ده مش موجود');

  // The database enforces this too (`trg_payment_no_self_approve`); saying it
  // here means the admin reads a sentence instead of a constraint name.
  assertMakerChecker(ctx.personId, p.submitted_by as Id, 'payment.review');

  if (p.status !== 'under_review') {
    throw new LedgerRefused('الإيصال ده مش في حالة تسمح بالاعتماد — افتحه للمراجعة الأول');
  }
  if (!Number.isInteger(approvedAmountPiastres) || approvedAmountPiastres <= 0) {
    throw new LedgerRefused('المبلغ المعتمد لازم يكون أكبر من صفر');
  }
  if (approvedAmountPiastres !== p.claimed_amount_piastres && !reasonAr?.trim()) {
    throw new LedgerRefused('تعديل المبلغ لازم معاه سبب مكتوب — الساكن هيقراه');
  }
  if (!p.fund_id) throw new LedgerRefused('البند ده مش مربوط بصندوق');

  const asset = ACCOUNT_FOR_METHOD[p.method] ?? ACCOUNT_FOR_METHOD['bank_transfer']!;

  // A deposit is never an overpayment: it is not paying anything down, so the
  // whole amount belongs on the liability its category points at.
  const isDeposit = p.category_kind === 'deposit';
  const due = Math.max(0, p.outstanding_piastres);
  const excess = isDeposit ? 0 : Math.max(0, approvedAmountPiastres - due);
  const onAccount = approvedAmountPiastres - excess;

  const entryId = newId('JE');
  const ts = now();

  // `entry_no` is UNIQUE and is the number a human quotes in a dispute, so it
  // has to read like a document reference and not like an id. Year-scoped and
  // sequential: J-2027-000418.
  //
  // The first version derived it from the last characters of `entryId`, which
  // works in production and collides instantly in tests — `newId` is
  // deterministic there by design, so every entry got the same suffix. The
  // failure surfaced as a bare UNIQUE violation with no Arabic, which is how a
  // test caught it before a board member did.
  const year = p.transfer_date.slice(0, 4);
  const seq = await db.prepare(
    `SELECT COUNT(*) n FROM journal_entries WHERE entry_no LIKE ?`
  ).bind(`J-${year}-%`).first<{ n: number }>();
  const entryNo = `J-${year}-${String((seq?.n ?? 0) + 1).padStart(6, '0')}`;
  const desc = `إيصال ${p.receipt_no} — عمارة ${p.building_code} شقة ${p.unit_number}`;

  const lines: PreparedStatement[] = [];
  const line = (n: number, account: string, dr: number, cr: number, memo: string) =>
    db.prepare(
      `INSERT INTO journal_lines (id, entry_id, line_no, account_id, fund_id,
         debit_piastres, credit_piastres, unit_id, memo_ar)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(newId('JL'), entryId, n, account, p.fund_id, dr, cr, p.unit_id, memo);

  lines.push(line(1, asset, approvedAmountPiastres, 0, 'تحصيل'));
  if (onAccount > 0) {
    lines.push(line(2, p.ledger_account_id, 0, onAccount,
      isDeposit ? 'أمانة مستردة — التزام مش إيراد' : p.category_ar));
  }
  if (excess > 0) {
    // Not income. The village owes this back, and `/admin/settlements` is where
    // it gets applied to a future due or refunded.
    lines.push(line(onAccount > 0 ? 3 : 2, ACC_OWNER_CREDITS, 0, excess,
      'رصيد دائن للمالك — مش إيراد'));
  }

  const periodId = await db.prepare(
    `SELECT id FROM fiscal_periods
      WHERE ? BETWEEN starts_on AND ends_on AND status <> 'closed'
      ORDER BY starts_on DESC LIMIT 1`
  ).bind(p.transfer_date).first<{ id: string }>();
  if (!periodId) {
    throw new LedgerRefused('مفيش سنة مالية مفتوحة بتغطي تاريخ التحويل ده');
  }

  const creditId = excess > 0 ? newId('RCR') : null;

  try {
    await db.batch([
      db.prepare(
        `INSERT INTO journal_entries (id, entry_no, entry_date, period_id, description_ar,
           source_type, source_id, created_by)
         VALUES (?,?,?,?,?, 'payment', ?, ?)`
      ).bind(entryId, entryNo, p.transfer_date, periodId.id, desc, p.id, p.submitted_by),
      ...lines,
      // Attach BEFORE posting — see the header. `submitted_by <> ?` keeps the
      // self-approval refusal in the same statement that does the work, so it
      // holds even if the check above were deleted.
      db.prepare(
        `UPDATE payments
            SET status = 'approved', approved_amount_piastres = ?, journal_entry_id = ?,
                fund_id = ?, reviewed_by = ?, reviewed_at = ?,
                review_reason_ar = COALESCE(?, review_reason_ar)
          WHERE id = ? AND status = 'under_review' AND submitted_by <> ?`
      ).bind(approvedAmountPiastres, entryId, p.fund_id, ctx.personId, ts,
             reasonAr?.trim() || null, p.id, ctx.personId),
      db.prepare(
        `UPDATE journal_entries SET approved_by = ?, posted_at = ? WHERE id = ?`
      ).bind(ctx.personId, ts, entryId),
      ...(creditId
        ? [db.prepare(
            `INSERT INTO resident_credits (id, unit_id, profile_id, amount_piastres,
               source_payment_id, journal_entry_id)
             VALUES (?,?, (SELECT uo.profile_id FROM unit_owners uo
                            WHERE uo.unit_id = ? AND uo.valid_to IS NULL
                            ORDER BY uo.is_primary_contact DESC LIMIT 1), ?,?,?)`
          ).bind(creditId, p.unit_id, p.unit_id, excess, p.id, entryId)]
        : []),
      // Same batch as the decision: the resident is told, or the approval does
      // not happen (R-065). INSERT OR IGNORE + the unique index is what makes a
      // double-tap send one message rather than two.
      db.prepare(
        `INSERT OR IGNORE INTO notifications (id, profile_id, kind, payment_id,
           title_ar, body_ar, link_path)
         VALUES (?,?, 'payment_approved', ?, 'إيصالك اتقبل ✅', ?, '/payments')`
      ).bind(newId('NTF'), p.submitted_by, p.id,
             `إيصال ${p.receipt_no} اتعتمد بمبلغ ${(approvedAmountPiastres / 100).toFixed(2)} ج.م`),
      db.prepare(
        `INSERT INTO audit_log (id, actor_id, actor_role, action, entity_table,
           entity_id, after_json, created_at)
         VALUES (?,?,?, 'payment.approve', 'payments', ?, ?, ?)`
      ).bind(newId('AUD'), ctx.personId, ctx.role, p.id,
             JSON.stringify({ entryId, approved: approvedAmountPiastres, credit: excess }), ts),
    ]);
  } catch (e) {
    // A trigger firing here is a control WORKING. `asRefusal` carries its
    // Arabic to the screen instead of letting it read as a crash.
    throw asRefusal(e);
  }

  return { entryId, creditPiastres: excess };
}
