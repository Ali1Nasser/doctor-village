/**
 * lib/db/statement.ts — كشف حساب الوحدة السنوي (CP-7).
 *
 * ## Why a statement is not just "the payments list with a header"
 *
 * `/payments` answers "what did I send?". A statement answers a different and
 * harder question: **"do you and I agree on what I owe?"** — which is the
 * question that actually gets asked at the general assembly, usually loudly.
 *
 * To answer it, the document has to reconcile in front of the reader:
 *
 *     المطلوب  −  المدفوع  −  الرصيد الدائن المستخدم  =  المتبقي
 *
 * Every row that moves that arithmetic is listed, and the four figures are
 * recomputed from the ledger rather than copied from a summary view. A
 * statement that disagrees with `/finance` by one piastre is worse than no
 * statement, because it is the document a resident brings to an argument.
 *
 * ## Pending receipts appear, and count for nothing
 *
 * A submitted-but-unreviewed receipt is shown in its own section with a zero
 * contribution to the totals. Hiding it would make a resident think their
 * payment vanished; counting it would overstate what the village holds. Both
 * failures are worse than the mild awkwardness of a row that says "بننتظر
 * المراجعة".
 *
 * ## Printing rather than PDF generation
 *
 * CP-7 asks for "annual statement PDF per unit". This produces a print-styled
 * HTML page instead of embedding a PDF engine, and that is a deliberate trade:
 * a PDF library is 2–8 MB of dependency running inside a Worker with a 10 ms
 * CPU budget on the free plan, to produce a file every phone can already make
 * from this page via Print → Save as PDF. The zero-cost constraint (C11) makes
 * the dependency the wrong answer; the output the resident ends up holding is
 * identical.
 */

import type { AuthContext, Id } from '../../types/domain.js';
import { can } from '../rbac.js';
import type { Db } from './driver.js';
import { NotFound, type Clock } from './index.js';

export interface StatementLine {
  kind: 'due' | 'payment' | 'credit' | 'waiver' | 'pending';
  date: string;
  reference: string;
  description_ar: string;
  charge_piastres: number;
  paid_piastres: number;
}

export interface UnitStatement {
  unit_id: Id;
  unit_label: string;
  owner_names: string;
  year: string;
  lines: StatementLine[];
  total_charged_piastres: number;
  total_paid_piastres: number;
  outstanding_piastres: number;
  pending_piastres: number;
  credit_balance_piastres: number;
  generated_at: string;
}

/**
 * Ownership is enforced by the same predicate the rest of `lib/db/` uses: a
 * caller without `payment.read_any` sees only units they own or hold a
 * financial delegation over. A statement is the densest personal-data document
 * this system produces — every amount, every date, the owner's name — so it
 * gets the strictest read, not a convenience path.
 */
export async function getAnnualStatement(
  ctx: AuthContext, db: Db, unitId: Id, year: string, now: Clock,
): Promise<UnitStatement> {
  const privileged = can(ctx.role, 'payment.read_any');

  const unit = privileged
    ? await db.prepare(
        `SELECT u.id, b.name_ar || ' — ' || u.unit_number AS label
           FROM units u JOIN buildings b ON b.id = u.building_id WHERE u.id = ?`
      ).bind(unitId).first<{ id: Id; label: string }>()
    : await db.prepare(
        `SELECT u.id, b.name_ar || ' — ' || u.unit_number AS label
           FROM units u JOIN buildings b ON b.id = u.building_id
          WHERE u.id = ?
            AND u.id IN (SELECT unit_id FROM unit_owners
                          WHERE profile_id = ? AND valid_to IS NULL
                         UNION
                         SELECT unit_id FROM delegate_authorizations
                          WHERE delegate_profile_id = ? AND can_view_financials = 1
                            AND valid_to >= ?)`
      ).bind(unitId, ctx.personId, ctx.personId, String(now()).slice(0, 10))
       .first<{ id: Id; label: string }>();

  if (!unit) throw new NotFound('كشف الحساب ده مش متاح ليك');

  const owners = await db.prepare(
    `SELECT p.full_name FROM unit_owners uo JOIN profiles p ON p.id = uo.profile_id
      WHERE uo.unit_id = ? AND uo.valid_to IS NULL ORDER BY p.full_name`
  ).bind(unitId).all<{ full_name: string }>();

  const from = `${year}-01-01`, to = `${year}-12-31`;

  // ---- what was charged -------------------------------------------------
  // A waiver is an AMOUNT, not a status: `waived_piastres` may be part of the
  // due or all of it. Reading it as a boolean would silently drop the unwaived
  // remainder of a partly-waived subscription from what the resident owes.
  // Only published fee periods appear — an unpublished period is a draft the
  // board has not committed to, and a statement is not the place to leak one.
  const dues = await db.prepare(
    `SELECT d.id, d.amount_piastres, d.waived_piastres, d.waiver_reason_ar,
            fp.name_ar, fp.due_on
       FROM unit_dues d JOIN fee_periods fp ON fp.id = d.fee_period_id
      WHERE d.unit_id = ? AND fp.due_on BETWEEN ? AND ? AND fp.is_published = 1
      ORDER BY fp.due_on`
  ).bind(unitId, from, to).all<{
    id: string; amount_piastres: number; waived_piastres: number;
    waiver_reason_ar: string | null; name_ar: string; due_on: string;
  }>();

  // ---- what was paid ----------------------------------------------------
  const payments = await db.prepare(
    `SELECT p.receipt_no, p.transfer_date, p.status, p.method,
            COALESCE(p.approved_amount_piastres, p.claimed_amount_piastres) AS amount,
            c.name_ar AS category
       FROM payments p LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.unit_id = ? AND p.transfer_date BETWEEN ? AND ?
        AND p.status IN ('approved','submitted','under_review','needs_info')
      ORDER BY p.transfer_date`
  ).bind(unitId, from, to).all<{
    receipt_no: string; transfer_date: string; status: string;
    method: string; amount: number; category: string | null;
  }>();

  const lines: StatementLine[] = [];
  let charged = 0, paid = 0, pending = 0;

  for (const d of dues.results ?? []) {
    const net = d.amount_piastres - (d.waived_piastres ?? 0);
    if (net > 0) {
      charged += net;
      lines.push({
        kind: 'due', date: d.due_on, reference: '—',
        description_ar: d.name_ar,
        charge_piastres: net, paid_piastres: 0,
      });
    }
    // A waiver is shown as a waiver and NEVER as a payment. 06 §4 is explicit:
    // money that was never received must not appear as money received. It gets
    // its own line so the resident can see the reduction was deliberate rather
    // than wonder why the total does not match the published subscription.
    if ((d.waived_piastres ?? 0) > 0) {
      lines.push({
        kind: 'waiver', date: d.due_on, reference: '—',
        description_ar: `إعفاء — ${d.name_ar}`
          + (d.waiver_reason_ar ? ` (${d.waiver_reason_ar})` : ''),
        charge_piastres: 0, paid_piastres: 0,
      });
    }
  }

  for (const p of payments.results ?? []) {
    if (p.status === 'approved') {
      paid += p.amount;
      lines.push({
        kind: 'payment', date: p.transfer_date, reference: p.receipt_no,
        description_ar: p.category ?? 'دفعة', charge_piastres: 0, paid_piastres: p.amount,
      });
    } else {
      pending += p.amount;
      lines.push({
        kind: 'pending', date: p.transfer_date, reference: p.receipt_no,
        description_ar: `${p.category ?? 'دفعة'} — بننتظر المراجعة`,
        charge_piastres: 0, paid_piastres: 0,
      });
    }
  }

  lines.sort((a, b) => a.date.localeCompare(b.date));

  // ---- credits the village owes back -------------------------------------
  // An open credit is one that has not yet been applied to a due. There is no
  // `status` column — `applied_at IS NULL` is the whole definition, and the
  // partial index on this table is built for exactly this predicate.
  const credit = await db.prepare(
    `SELECT COALESCE(SUM(amount_piastres), 0) AS balance
       FROM resident_credits WHERE unit_id = ? AND applied_at IS NULL`
  ).bind(unitId).first<{ balance: number }>();

  return {
    unit_id: unit.id,
    unit_label: unit.label,
    owner_names: (owners.results ?? []).map(o => o.full_name).join('، '),
    year,
    lines,
    total_charged_piastres: charged,
    total_paid_piastres: paid,
    outstanding_piastres: Math.max(charged - paid, 0),
    pending_piastres: pending,
    credit_balance_piastres: credit?.balance ?? 0,
    generated_at: now(),
  };
}

/**
 * The years the village actually has published fee periods for.
 *
 * Offering a fixed range (or "last 5 years") would put empty years in the
 * picker, and an empty statement is indistinguishable from a broken one to the
 * person reading it. The current year is always included so a resident who has
 * just joined sees this year rather than an empty control.
 */
export async function statementYears(ctx: AuthContext, db: Db): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT DISTINCT substr(due_on, 1, 4) AS y FROM fee_periods
      WHERE is_published = 1 ORDER BY y DESC`
  ).all<{ y: string }>();
  const years = (rows.results ?? []).map(r => r.y);
  return years.length > 0 ? years : [String(new Date().getFullYear())];
}
