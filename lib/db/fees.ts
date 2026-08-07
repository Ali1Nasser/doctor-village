/**
 * lib/db/fees.ts — creating the year's subscription, and billing it to flats.
 *
 * Until this file existed, `fee_periods` and `unit_dues` were populated only by
 * the demo seed. Every screen in the product reads from them — the home page's
 * «المطلوب منك», the statement, the arrears figure, `v_unit_balance` — and
 * there was no way to create one. The portal could show a year it had been
 * handed and could not begin a new one, which means it could be demonstrated
 * and not operated.
 *
 * ## Three steps, deliberately not one button
 *
 *   1. `createFeePeriod`  — a draft. Nobody sees it, everything about it is
 *                           still editable.
 *   2. `generateDues`     — work out what each flat owes and write it down.
 *                           Idempotent; safe to re-run while still a draft.
 *   3. `publishFeePeriod` — residents now see a number.
 *
 * They are separate because step 2's output is the thing the board has to look
 * at before step 3. `v_fee_period_summary` reports how many flats were billed,
 * the total, and — the one that matters — how many active flats got NOTHING,
 * which on a per-sqm basis is every flat whose area was never entered. A
 * combined "create and publish" button would bill 180 of 204 flats and look
 * like a success.
 *
 * ## Money
 *
 * Everything here is integer piastres. The per-square-metre basis is the only
 * place a multiplication happens, and it is done as
 * `area_cm2 * rate / 10_000` in **integer** arithmetic, in SQL, with the
 * division last — `area_cm2` is square centimetres precisely so this never
 * becomes a float (C4, and the comment on `units.area_cm2`).
 *
 * ## What is enforced where
 *
 * The freezing rules — a published period cannot be restated, a published due
 * cannot be edited or deleted, an empty period cannot be published — are
 * triggers in `0022`, per ADR-024. The functions below produce Arabic sentences
 * for the same conditions so a board member reads a sentence rather than a
 * constraint name. The trigger is the control; the check here is the message.
 */

import type { AuthContext, Id } from '../../types/domain.js';
import { require_ } from '../rbac.js';
import type { Db } from './driver.js';
import { LedgerRefused, asRefusal } from './driver.js';
import { newId, mutate, NotFound, type Clock } from './index.js';

export interface FeePeriodRow {
  id: string;
  name_ar: string;
  basis: 'per_unit' | 'per_sqm';
  amount_piastres: number;
  starts_on: string;
  ends_on: string;
  due_on: string;
  is_published: number;
  created_at: string;
  category_ar: string;
  unit_count: number;
  total_piastres: number;
  waived_piastres: number;
  /** Active flats this period bills NOTHING. On per_sqm, flats with no area. */
  missing_units: number;
}

export async function listFeePeriods(ctx: AuthContext, db: Db): Promise<FeePeriodRow[]> {
  require_(ctx.role, 'fee.manage');
  const r = await db.prepare(
    `SELECT * FROM v_fee_period_summary
      ORDER BY is_published, starts_on DESC, created_at DESC
      LIMIT 60`
  ).all<FeePeriodRow>();
  return r.results ?? [];
}

/** The income categories a subscription can be billed under, plus the open years. */
export async function feeFormOptions(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'fee.manage');
  const cats = await db.prepare(
    `SELECT id, name_ar, kind FROM categories
      WHERE is_active = 1 AND direction = 'income'
      ORDER BY sort_order, name_ar`
  ).all<{ id: string; name_ar: string; kind: string }>();
  const years = await db.prepare(
    `SELECT id, name_ar, starts_on, ends_on, status FROM fiscal_periods
      WHERE status <> 'closed'
      ORDER BY starts_on DESC LIMIT 12`
  ).all<{ id: string; name_ar: string; starts_on: string; ends_on: string; status: string }>();
  return { categories: cats.results ?? [], years: years.results ?? [] };
}

export interface NewFeePeriod {
  nameAr: string;
  categoryId: Id;
  fiscalPeriodId: Id;
  startsOn: string;
  endsOn: string;
  dueOn: string;
  basis: 'per_unit' | 'per_sqm';
  amountPiastres: number;
}

/**
 * Create the draft. Nothing is billed and nobody sees it.
 *
 * The date sanity checks are here rather than only in the schema because the
 * schema's CHECK can say "ends after starts" and cannot say "a due date before
 * the period even begins is almost certainly a typo in the year".
 */
export async function createFeePeriod(
  ctx: AuthContext, db: Db, p: NewFeePeriod, _now: Clock,
): Promise<string> {
  require_(ctx.role, 'fee.manage');

  if (!p.nameAr?.trim()) throw new LedgerRefused('اكتب اسم للاشتراك، زي «اشتراك 2027»');
  if (!Number.isInteger(p.amountPiastres) || p.amountPiastres <= 0) {
    throw new LedgerRefused('المبلغ لازم يكون أكبر من صفر');
  }
  if (!(p.endsOn > p.startsOn)) {
    throw new LedgerRefused('تاريخ النهاية لازم يكون بعد تاريخ البداية');
  }
  if (p.dueOn < p.startsOn) {
    throw new LedgerRefused('تاريخ الاستحقاق قبل بداية الفترة — راجع السنة');
  }

  const id = newId('FEE');
  try {
    await mutate(db, ctx,
      { action: 'fee_period.create', table: 'fee_periods', entityId: id,
        after: { name: p.nameAr, basis: p.basis, amount: p.amountPiastres } },
      db.prepare(
        `INSERT INTO fee_periods (id, name_ar, category_id, fiscal_period_id,
           starts_on, ends_on, due_on, basis, amount_piastres, is_published, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,0,?)`
      ).bind(id, p.nameAr.trim(), p.categoryId, p.fiscalPeriodId,
             p.startsOn, p.endsOn, p.dueOn, p.basis, p.amountPiastres, ctx.personId),
    );
  } catch (e) {
    throw asRefusal(e);
  }
  return id;
}

export interface GenerateOutcome {
  /** Flats billed by THIS call. Zero on a re-run that changed nothing. */
  billed: number;
  /** Active flats still with no due — on per_sqm, the ones with no area. */
  missing: number;
  totalPiastres: number;
}

/**
 * Bill every active flat.
 *
 * `INSERT OR IGNORE` leans on `UNIQUE (fee_period_id, unit_id)`, so a board
 * member who taps twice on a slow connection bills each flat once. That is also
 * what makes a re-run after adding a flat's area do the right thing: it fills
 * the gap and leaves the 203 existing rows exactly as they were, including any
 * amount already computed.
 *
 * On `per_sqm`, a flat with no recorded area is SKIPPED rather than billed zero
 * — `unit_dues.amount_piastres` must be > 0, and a flat silently billed nothing
 * is the failure this whole function is arranged to surface. It comes back in
 * `missing`, and `v_fee_period_summary` keeps reporting it until it is fixed.
 */
export async function generateDues(
  ctx: AuthContext, db: Db, feePeriodId: Id, _now: Clock,
): Promise<GenerateOutcome> {
  require_(ctx.role, 'fee.manage');

  const fp = await db.prepare(
    `SELECT id, basis, amount_piastres, is_published FROM fee_periods WHERE id = ?`
  ).bind(feePeriodId).first<{
    id: string; basis: string; amount_piastres: number; is_published: number;
  }>();
  if (!fp) throw new NotFound('الاشتراك ده مش موجود');
  if (fp.is_published) {
    throw new LedgerRefused('الاشتراك ده منشور خلاص — التوزيع بيتعمل قبل النشر مش بعده');
  }

  // The amount is computed in SQL, in integers, with the division LAST:
  // area_cm2 (cm²) × piastres-per-m² ÷ 10 000 cm²/m². Doing it here rather than
  // in TypeScript keeps 204 round trips down to one statement, and keeps the
  // arithmetic out of a language with one number type. (C4)
  const amountExpr = fp.basis === 'per_sqm'
    ? `(u.area_cm2 * ${fp.amount_piastres}) / 10000`
    : String(fp.amount_piastres);
  const areaFilter = fp.basis === 'per_sqm'
    ? `AND u.area_cm2 IS NOT NULL AND (u.area_cm2 * ${fp.amount_piastres}) / 10000 > 0`
    : '';

  try {
    await mutate(db, ctx,
      { action: 'fee_period.generate', table: 'unit_dues', entityId: feePeriodId,
        after: { basis: fp.basis } },
      db.prepare(
        `INSERT OR IGNORE INTO unit_dues (id, fee_period_id, unit_id, amount_piastres)
         SELECT lower(hex(randomblob(13))), ?, u.id, ${amountExpr}
           FROM units u
          WHERE u.is_active = 1 ${areaFilter}`
      ).bind(feePeriodId),
    );
  } catch (e) {
    throw asRefusal(e);
  }

  const s = await db.prepare(
    `SELECT unit_count, total_piastres, missing_units
       FROM v_fee_period_summary WHERE id = ?`
  ).bind(feePeriodId).first<{
    unit_count: number; total_piastres: number; missing_units: number;
  }>();
  return {
    billed: s?.unit_count ?? 0,
    missing: s?.missing_units ?? 0,
    totalPiastres: s?.total_piastres ?? 0,
  };
}

/**
 * Publish. From here the numbers are what residents were told.
 *
 * `trg_fee_period_publish_needs_dues` refuses an empty period at the database;
 * the check below is so the board reads a sentence. Publishing while flats are
 * still missing is ALLOWED but named in the return value — sometimes a flat is
 * genuinely not billed (unsold, demolished), and the board is the only party
 * that can tell that apart from a missing area.
 */
export async function publishFeePeriod(
  ctx: AuthContext, db: Db, feePeriodId: Id, now: Clock,
): Promise<{ missing: number; unitCount: number }> {
  require_(ctx.role, 'fee.manage');

  const s = await db.prepare(
    `SELECT is_published, unit_count, missing_units FROM v_fee_period_summary WHERE id = ?`
  ).bind(feePeriodId).first<{
    is_published: number; unit_count: number; missing_units: number;
  }>();
  if (!s) throw new NotFound('الاشتراك ده مش موجود');
  if (s.is_published) throw new LedgerRefused('الاشتراك ده منشور خلاص');
  if (s.unit_count === 0) {
    throw new LedgerRefused('مفيش ولا وحدة اتحسب عليها الاشتراك ده. اعمل التوزيع الأول.');
  }

  try {
    await mutate(db, ctx,
      { action: 'fee_period.publish', table: 'fee_periods', entityId: feePeriodId,
        after: { units: s.unit_count, missing: s.missing_units, at: now() } },
      db.prepare(`UPDATE fee_periods SET is_published = 1 WHERE id = ? AND is_published = 0`)
        .bind(feePeriodId),
    );
  } catch (e) {
    throw asRefusal(e);
  }
  return { missing: s.missing_units, unitCount: s.unit_count };
}

export interface DueRow {
  id: string;
  unit_id: string;
  unit_label: string;
  owner_name: string | null;
  amount_piastres: number;
  waived_piastres: number;
  waiver_reason_ar: string | null;
  paid_piastres: number;
}

/** The billed flats, for the review-before-publish screen and for waivers. */
export async function listDues(
  ctx: AuthContext, db: Db, feePeriodId: Id, limit = 400,
): Promise<DueRow[]> {
  require_(ctx.role, 'fee.manage');
  const r = await db.prepare(
    `SELECT d.id, d.unit_id, d.amount_piastres, d.waived_piastres, d.waiver_reason_ar,
            b.name_ar || ' — ' || u.unit_number AS unit_label,
            (SELECT p.full_name FROM unit_owners uo
               JOIN profiles p ON p.id = uo.profile_id
              WHERE uo.unit_id = u.id AND uo.valid_to IS NULL
              ORDER BY uo.is_primary_contact DESC LIMIT 1)            AS owner_name,
            (SELECT COALESCE(SUM(pay.amount_piastres), 0) FROM payments pay
              WHERE pay.unit_id = u.id AND pay.status = 'approved'
                AND pay.fee_period_id = d.fee_period_id)      AS paid_piastres
       FROM unit_dues d
       JOIN units u     ON u.id = d.unit_id
       JOIN buildings b ON b.id = u.building_id
      WHERE d.fee_period_id = ?
      ORDER BY b.sort_order, b.name_ar, CAST(u.unit_number AS INTEGER), u.unit_number
      LIMIT ?`
  ).bind(feePeriodId, limit).all<DueRow>();
  return r.results ?? [];
}

/**
 * Waive part or all of one flat's due.
 *
 * This is the ONLY way a published amount changes what a flat has to pay, and
 * it does not change the amount: it records a decision beside it, with a reason
 * and a name, and it shows on the resident's statement AS A WAIVER (06 §4).
 * Editing the bill down to zero would produce the same balance and destroy the
 * record of who decided and why — `trg_dues_amount_frozen_after_publish`
 * refuses that outright.
 */
export async function waiveDue(
  ctx: AuthContext, db: Db, dueId: Id, waivePiastres: number, reasonAr: string, now: Clock,
): Promise<void> {
  require_(ctx.role, 'fee.manage');

  if ((reasonAr ?? '').trim().length < 10) {
    throw new LedgerRefused(
      'اكتب سبب الإعفاء بالتفصيل — بيظهر في كشف حساب الساكن وباسمك');
  }
  const d = await db.prepare(
    `SELECT amount_piastres, waived_piastres FROM unit_dues WHERE id = ?`
  ).bind(dueId).first<{ amount_piastres: number; waived_piastres: number }>();
  if (!d) throw new NotFound('المستحق ده مش موجود');
  if (!Number.isInteger(waivePiastres) || waivePiastres <= 0) {
    throw new LedgerRefused('مبلغ الإعفاء لازم يكون أكبر من صفر');
  }
  if (waivePiastres > d.amount_piastres) {
    throw new LedgerRefused('مبلغ الإعفاء أكبر من المطلوب من الوحدة');
  }

  try {
    await mutate(db, ctx,
      { action: 'due.waive', table: 'unit_dues', entityId: dueId,
        before: { waived: d.waived_piastres },
        after: { waived: waivePiastres, reason: reasonAr.trim() } },
      db.prepare(
        `UPDATE unit_dues
            SET waived_piastres = ?, waiver_reason_ar = ?, waived_by = ?, waived_at = ?
          WHERE id = ?`
      ).bind(waivePiastres, reasonAr.trim(), ctx.personId, now(), dueId),
    );
  } catch (e) {
    throw asRefusal(e);
  }
}
