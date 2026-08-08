/**
 * lib/db/index.ts — THE ONLY PLACE SQL EXISTS IN THIS CODEBASE.  (C6, ADR-010)
 *
 * Three structural rules buy back the safety that Postgres RLS would have given
 * us for free. RLS fails *closed*; application checks fail *open* if you forget
 * one. These three are what make forgetting hard:
 *
 *  1. **One location.** `tools/lint-no-sql.mjs` fails the build if the string
 *     `SELECT`/`INSERT`/`UPDATE`/`DELETE` appears in any file outside `lib/db/`.
 *
 *  2. **Identity is a required argument.** Every exported function takes
 *     `ctx: AuthContext` first. There is no overload without it, so a missing
 *     identity is a COMPILE error, not a runtime surprise.
 *
 *  3. **Ownership predicates live inside the query string**, never appended by
 *     the caller. A caller cannot forget a WHERE clause it never writes.
 *
 * If that discipline ever slips — if an access test fails in review, or a second
 * developer joins — ADR-010 says switch to Neon + Postgres RLS. This file is the
 * thing being trusted.
 */

import type { AuthContext, Id, Role, PaymentStatus } from '../../types/domain.js';
import { can, require_, Forbidden, assertMakerChecker } from '../rbac.js';
import type { Db, PreparedStatement } from './driver.js';
import { LedgerRefused, asRefusal } from './driver.js';
// Notification text is user-facing CONTENT, stored in the database and read by a
// resident — so it lives in `messages/ar.json` with every other string, not
// inline here. (Refusal messages in this file are a different thing: they are
// developer-facing reasons that happen to be readable.)
import MESSAGES from '../../messages/ar.json' with { type: 'json' };

/* ===================================================================== */
/* The ownership predicates. Written once, interpolated as constants.     */
/* They are `const` string literals, never built from user input.         */
/* ===================================================================== */

/** Units the caller owns RIGHT NOW. A sold flat closes with valid_to, so a
 *  former owner drops out of this the moment the sale is recorded. (test 14) */
const OWNED_UNITS =
  `SELECT unit_id FROM unit_owners WHERE profile_id = ? AND valid_to IS NULL`;

/** Units a live delegate authorization covers. Expiry is evaluated in SQL
 *  against a caller-supplied date so a clock-advance test is possible. (test 12) */
const DELEGATED_UNITS =
  `SELECT unit_id FROM delegate_authorizations
    WHERE delegate_profile_id = ? AND revoked_at IS NULL
      AND valid_from <= ? AND valid_to >= ?`;

/** Delegated units where the grant ALSO allows seeing money. (test 13) */
const DELEGATED_FINANCIAL_UNITS =
  `SELECT unit_id FROM delegate_authorizations
    WHERE delegate_profile_id = ? AND revoked_at IS NULL
      AND can_view_financials = 1 AND valid_from <= ? AND valid_to >= ?`;

export class NotFound extends Error {
  readonly status = 404;
  constructor(readonly reasonAr = 'مش موجود') { super('not found'); }
}

const today = (now: () => string) => now().slice(0, 10);

/* ===================================================================== */
/* Auth context                                                          */
/* ===================================================================== */

export interface Clock { (): string }

export async function resolveAuthContext(
  db: Db, sessionToken: string | null, now: Clock,
): Promise<AuthContext | null> {
  if (!sessionToken) return null;
  const s = await db.prepare(
    `SELECT s.id, s.profile_id, s.reauth_at, p.role, p.is_active
       FROM sessions s JOIN profiles p ON p.id = s.profile_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`
  ).bind(await hashToken(sessionToken), now()).first<{
    id: string; profile_id: string; reauth_at: string | null; role: Role; is_active: number;
  }>();
  if (!s || !s.is_active) return null;

  const d = today(now);
  const owned = await db.prepare(OWNED_UNITS).bind(s.profile_id).all<{ unit_id: string }>();
  const deleg = await db.prepare(
    `SELECT unit_id, owner_profile_id, can_view_financials, can_submit_payments, valid_to
       FROM delegate_authorizations
      WHERE delegate_profile_id = ? AND revoked_at IS NULL
        AND valid_from <= ? AND valid_to >= ?`
  ).bind(s.profile_id, d, d).all<{
    unit_id: string; owner_profile_id: string;
    can_view_financials: number; can_submit_payments: number; valid_to: string;
  }>();

  return {
    personId: s.profile_id as Id,
    role: s.role,
    sessionId: s.id as Id,
    reauthAt: s.reauth_at as AuthContext['reauthAt'],
    ownedUnitIds: owned.results.map(r => r.unit_id as Id),
    delegatedUnits: deleg.results.map(r => ({
      unitId: r.unit_id as Id,
      ownerProfileId: r.owner_profile_id as Id,
      canViewFinancials: !!r.can_view_financials,
      canSubmitPayments: !!r.can_submit_payments,
      validTo: r.valid_to as never,
    })),
  };
}

/**
 * The caller's OWN login number, for the password-strength check.
 *
 * Reading it needs no capability because it is theirs, and it never leaves the
 * server: the only caller compares a proposed password against it so that
 * «01011111111» cannot become somebody's password. Rendering it would be a
 * different decision — `/me` deliberately shows only the last three digits.
 */
export async function getOwnPhone(ctx: AuthContext, db: Db): Promise<string | null> {
  const r = await db.prepare(
    `SELECT phone_e164 FROM phone_identifiers
      WHERE profile_id = ? AND status = 'active' LIMIT 1`
  ).bind(ctx.personId).first<{ phone_e164: string }>();
  return r?.phone_e164 ?? null;
}

/**
 * How many printed recovery codes the caller still has.
 *
 * A count, never the codes — those exist only as hashes, and the number is the
 * only honest thing `/me` can say about them. Scoped to `ctx.personId` in the
 * query string, so there is no argument that could ask about somebody else.
 */
export async function countOwnRecoveryCodes(ctx: AuthContext, db: Db): Promise<number> {
  const r = await db.prepare(
    `SELECT COUNT(*) n FROM recovery_codes WHERE profile_id = ? AND used_at IS NULL`
  ).bind(ctx.personId).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/** Placeholder for the real hash. Swapped for SHA-256 in lib/auth/session.ts;
 *  kept here so `lib/db/` never imports crypto policy. */
let _hash: (t: string) => string | Promise<string> = (t: string) => t;
/**
 * The session-token hasher is injected because the same hash has to be
 * computable in three environments and only one of them has `node:crypto`:
 * the Node tests use `createHash`, and a Cloudflare Worker has only WebCrypto —
 * whose `subtle.digest` is asynchronous.
 *
 * So the hasher may return a promise. There is exactly ONE call site
 * (`resolveAuthContext`, below) and it is already async, which is what makes
 * this safe rather than invasive. The alternative was a hand-written
 * synchronous SHA-256 shipped solely to keep a signature — new cryptographic
 * code to avoid one `await`.
 */
export function setTokenHasher(fn: (t: string) => string | Promise<string>) { _hash = fn; }
function hashToken(t: string): string | Promise<string> { return _hash(t); }

/**
 * Sign out of THIS device, and only this one.
 *
 * Distinct from `revokeAllSessions`, which is the "somebody has my phone"
 * button on `/me` and ends every session the person has. This is the ordinary
 * one — the family iPad, the phone handed to a neighbour to show them the
 * announcement — and it existed nowhere: `messages/ar.json` has carried
 * «تسجيل الخروج» since CP-4 with nothing rendering it and no route behind it.
 *
 * The token is hashed here rather than taken as a hash, so a caller cannot pass
 * one for a session that is not theirs. Revoking is conditional on the row
 * still being live, so a double submit is a no-op rather than an error.
 */
export async function closeThisSession(
  db: Db, sessionToken: string, now: Clock,
): Promise<void> {
  const hash = await hashToken(sessionToken);
  const s = await db.prepare(
    `SELECT id, profile_id FROM sessions WHERE token_hash = ? AND revoked_at IS NULL`
  ).bind(hash).first<{ id: string; profile_id: string }>();
  if (!s) return;                        // already gone: signing out twice is fine
  await db.batch([
    db.prepare(`UPDATE sessions SET revoked_at = ?, revoked_by = ?
                 WHERE id = ? AND revoked_at IS NULL`).bind(now(), s.profile_id, s.id),
    db.prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity_table, entity_id)
       VALUES (?,?, 'session.close', 'sessions', ?)`
    ).bind(newId('AUD'), s.profile_id, s.id),
  ]);
}

export interface AuditFacts {
  action: string;
  table: string;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * The only sanctioned way to write. The audit row is built here, not by the
 * caller, so it cannot be omitted or quietly weakened.
 *
 * Returns the number of rows the FIRST statement changed, so callers can still
 * use conditional updates for idempotency (`WHERE status = 'x'` changing zero
 * rows on a replay).
 */
export async function mutate(
  db: Db, ctx: AuthContext, facts: AuditFacts, ...writes: PreparedStatement[]
): Promise<number> {
  if (writes.length === 0) throw new Error('mutate() called with no writes');
  const audit = db.prepare(
    `INSERT INTO audit_log (id, actor_id, actor_role, on_behalf_of, action, entity_table,
       entity_id, before_json, after_json)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    newId('AUD'), ctx.personId, ctx.role,
    ctx.delegatedUnits.length ? ctx.delegatedUnits[0]!.ownerProfileId : null,
    facts.action, facts.table, facts.entityId,
    facts.before === undefined ? null : JSON.stringify(facts.before),
    facts.after === undefined ? null : JSON.stringify(facts.after),
  );
  const results = await db.batch([...writes, audit]) as Array<{ changes?: number }>;
  return Number(results[0]?.changes ?? 0);
}

/* ===================================================================== */
/* Payments                                                              */
/* ===================================================================== */

export interface PaymentRow {
  id: string; receipt_no: string; unit_id: string; submitted_by: string;
  category_id: string; claimed_amount_piastres: number;
  approved_amount_piastres: number | null; method: string; transfer_date: string;
  reference_no: string | null; storage_key: string; note_ar: string | null;
  status: PaymentStatus; review_reason_ar: string | null; created_at: string;
}

/**
 * Access test 1: resident A cannot read resident B's payment.
 * The predicate is INSIDE this string. A caller cannot forget it.
 */
export async function getPayment(ctx: AuthContext, db: Db, id: Id, now: Clock): Promise<PaymentRow> {
  const d = today(now);
  const sql = can(ctx.role, 'payment.read_any')
    ? `SELECT * FROM payments WHERE id = ?`
    : `SELECT * FROM payments
        WHERE id = ?
          AND unit_id IN (${OWNED_UNITS} UNION ${DELEGATED_FINANCIAL_UNITS})`;
  const stmt = can(ctx.role, 'payment.read_any')
    ? db.prepare(sql).bind(id)
    : db.prepare(sql).bind(id, ctx.personId, ctx.personId, d, d);
  const row = await stmt.first<PaymentRow>();
  if (!row) throw new NotFound('الإيصال ده مش موجود أو مش بتاعك');
  return row;
}

export async function listMyPayments(ctx: AuthContext, db: Db, now: Clock): Promise<PaymentRow[]> {
  const d = today(now);
  const r = await db.prepare(
    `SELECT * FROM payments
      WHERE unit_id IN (${OWNED_UNITS} UNION ${DELEGATED_FINANCIAL_UNITS})
      ORDER BY created_at DESC`
  ).bind(ctx.personId, ctx.personId, d, d).all<PaymentRow>();
  return r.results;
}

export interface NewPayment {
  id: Id; receiptNo: string; unitId: Id; categoryId: Id; feePeriodId: Id | null;
  claimedAmountPiastres: number; method: string; transferDate: string;
  referenceNo: string | null; storageKey: string; imageSha256: string | null;
  noteAr: string | null;
}

/**
 * Access test 4: a resident cannot submit a payment for a unit they do not own.
 * Enforced by an INSERT…SELECT whose WHERE clause is the ownership predicate —
 * so the row simply does not come into existence, rather than being inserted
 * and then checked.
 */
export async function createPayment(ctx: AuthContext, db: Db, p: NewPayment, now: Clock): Promise<void> {
  require_(ctx.role, 'payment.submit_own');
  const d = today(now);
  const delegated = ctx.delegatedUnits.find(u => u.unitId === p.unitId);
  const onBehalf = delegated ? delegated.ownerProfileId : null;
  if (delegated && !delegated.canSubmitPayments) {
    throw new Forbidden('payment.submit_own', 'التفويض بتاعك مبيسمحش برفع إيصالات');
  }

  const res = await db.prepare(
    `INSERT INTO payments (id, receipt_no, unit_id, submitted_by, on_behalf_of, category_id,
       fee_period_id, claimed_amount_piastres, method, transfer_date, reference_no,
       storage_key, image_sha256, note_ar, status)
     SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft'
      WHERE ? IN (${OWNED_UNITS} UNION ${DELEGATED_UNITS})`
  ).bind(
    p.id, p.receiptNo, p.unitId, ctx.personId, onBehalf, p.categoryId, p.feePeriodId,
    p.claimedAmountPiastres, p.method, p.transferDate, p.referenceNo,
    p.storageKey, p.imageSha256, p.noteAr,
    p.unitId, ctx.personId, ctx.personId, d, d,
  ).run();

  if (res.meta.changes !== 1) {
    throw new Forbidden('payment.submit_own', 'الوحدة دي مش بتاعتك');
  }
  await mutate(db, ctx,
    { action: 'payment.submit', table: 'payments', entityId: p.id,
      after: { amount: p.claimedAmountPiastres, unit: p.unitId, onBehalfOf: onBehalf } },
    db.prepare(`UPDATE payments SET status='submitted', submitted_at=? WHERE id=? AND status='draft'`)
      .bind(now(), p.id),
  );
}

export type Decision =
  | { kind: 'approve'; approvedAmountPiastres: number; reasonAr?: string; journalEntryId: Id }
  | { kind: 'reject' | 'need_info' | 'duplicate'; reasonAr: string };

/**
 * The message a resident gets when their receipt is decided.
 *
 * ## Why this is in the same batch as the decision, and not a job
 * A decision the resident never hears about is the everyday version of the
 * failure R-063 describes for reversals: they uploaded a receipt, the screen
 * said "under review", and then nothing — so they ask in WhatsApp, which is the
 * habit this whole product exists to replace. Writing the notification in the
 * same `db.batch()` as the status change means "decided but silent" is not a
 * representable state, rather than a queue somebody has to remember to drain.
 *
 * ## Why `INSERT OR IGNORE`
 * `reviewPayment` is deliberately idempotent — a double-tapped approve changes
 * 0 rows the second time — but a notification in the same batch would be
 * written anyway, and the resident would get the same message twice on exactly
 * the connection quality that makes people tap twice. `ux_notif_payment_kind`
 * (migration 0016) makes the second insert a no-op **at the database**, so the
 * two properties hold together: told, and told once.
 *
 * ## Tone
 * Every message names what to do next, and none of them is the last word. Even
 * a rejection ends «الرفض ده مش نهائي» — a resident who reads a refusal with no
 * next step goes to the board angry instead of to the screen.
 */
function notifyDecision(
  db: Db, p: { id: string; receipt_no: string; submitted_by: string; claimed: number },
  decision: Decision,
): PreparedStatement {
  const M = MESSAGES.notify;
  const eg = (piastres: number) =>
    `${(piastres / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${MESSAGES.app.currency}`;
  const fill = (s: string, v: Record<string, string>) =>
    s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

  let kind: string, title: string, body: string;
  if (decision.kind === 'approve') {
    const adjusted = decision.approvedAmountPiastres !== p.claimed;
    kind = 'payment_approved';
    title = fill(adjusted ? M.approvedAdjTitle : M.approvedTitle, { receipt: p.receipt_no });
    body = adjusted
      ? fill(M.approvedAdjBody, {
          amount: eg(decision.approvedAmountPiastres), claimed: eg(p.claimed),
          reason: decision.reasonAr ?? '' })
      : fill(M.approvedBody, { amount: eg(decision.approvedAmountPiastres) });
  } else if (decision.kind === 'need_info') {
    kind = 'payment_needs_info';
    title = fill(M.needInfoTitle, { receipt: p.receipt_no });
    body = fill(M.needInfoBody, { reason: decision.reasonAr });
  } else if (decision.kind === 'duplicate') {
    // A duplicate is NOT a rejection and must not read like one — the money
    // arrived, it was simply counted once. Saying so prevents the phone call.
    kind = 'payment_rejected';
    title = fill(M.duplicateTitle, { receipt: p.receipt_no });
    body = fill(M.duplicateBody, { reason: decision.reasonAr });
  } else {
    kind = 'payment_rejected';
    title = fill(M.rejectedTitle, { receipt: p.receipt_no });
    body = fill(M.rejectedBody, { reason: decision.reasonAr });
  }

  return db.prepare(
    `INSERT OR IGNORE INTO notifications
       (id, profile_id, kind, title_ar, body_ar, link_path, payment_id)
     VALUES (?,?,?,?,?, '/payments', ?)`
  ).bind(newId('NOT'), p.submitted_by, kind, title, body, p.id);
}

/**
 * Access tests 3 and 6: a resident can never self-approve, and an operator can
 * never approve at all.
 *
 * Three independent guards, deliberately redundant, because this is the single
 * function where an error moves real money:
 *   (a) the capability check here;
 *   (b) maker–checker here — the submitter can never be the reviewer;
 *   (c) `WHERE status='under_review' AND submitted_by <> ?` in the SQL, plus
 *       the `trg_payment_transition` and `trg_payment_no_self_approve` triggers
 *       in the database itself.
 * (c) alone would hold if (a) and (b) were both deleted.
 */
export async function reviewPayment(
  ctx: AuthContext, db: Db, id: Id, decision: Decision, now: Clock,
): Promise<void> {
  require_(ctx.role, 'payment.review');

  const existing = await db.prepare(
    `SELECT id, receipt_no, submitted_by, status, claimed_amount_piastres
       FROM payments WHERE id = ?`
  ).bind(id).first<{ id: string; receipt_no: string; submitted_by: string;
                    status: string; claimed_amount_piastres: number }>();
  if (!existing) throw new NotFound();

  assertMakerChecker(ctx.personId, existing.submitted_by as Id, 'payment.review');

  if (decision.kind === 'approve') {
    if (decision.approvedAmountPiastres !== existing.claimed_amount_piastres && !decision.reasonAr) {
      throw new LedgerRefused('تعديل المبلغ لازم معاه سبب مكتوب');
    }
    // Idempotency (06 §9 invariant 3): a double-clicked approve changes 0 rows
    // the second time, so nothing posts twice. Never read-then-write.
    const changed = await mutate(db, ctx,
      { action: 'payment.approve', table: 'payments', entityId: id,
        before: { status: existing.status, claimed: existing.claimed_amount_piastres },
        after: { approved: decision.approvedAmountPiastres, entry: decision.journalEntryId } },
      db.prepare(
        `UPDATE payments
            SET status='approved', approved_amount_piastres=?, journal_entry_id=?,
                reviewed_by=?, reviewed_at=?, review_reason_ar=COALESCE(?, review_reason_ar)
          WHERE id=? AND status='under_review' AND submitted_by <> ?`
      ).bind(decision.approvedAmountPiastres, decision.journalEntryId, ctx.personId, now(),
             decision.reasonAr ?? null, id, ctx.personId),
      // Same batch: the resident is told, or the approval does not happen.
      notifyDecision(db, { ...existing, claimed: existing.claimed_amount_piastres }, decision),
    );
    if (changed !== 1) throw new LedgerRefused('الإيصال ده مش في حالة تسمح بالاعتماد');
  } else {
    // The API verb and the stored status are NOT the same word. The route takes
    // `reject`; the schema's nine-state machine stores `rejected`. Writing the
    // verb straight through produced an illegal-transition abort that looked
    // like a server crash. Map explicitly rather than passing the string along.
    const STATUS_FOR: Record<'reject' | 'need_info' | 'duplicate', PaymentStatus> = {
      reject: 'rejected', need_info: 'needs_info', duplicate: 'duplicate',
    };
    const changed = await mutate(db, ctx,
      { action: `payment.${decision.kind}`, table: 'payments', entityId: id,
        before: { status: existing.status }, after: { decision } },
      db.prepare(
        `UPDATE payments SET status=?, review_reason_ar=?, reviewed_by=?, reviewed_at=?
          WHERE id=? AND status='under_review' AND submitted_by <> ?`
      ).bind(STATUS_FOR[decision.kind], decision.reasonAr, ctx.personId, now(), id, ctx.personId),
      notifyDecision(db, { ...existing, claimed: existing.claimed_amount_piastres }, decision),
    );
    if (changed !== 1) throw new LedgerRefused('الإيصال ده مش في حالة تسمح بالقرار ده');
  }
}

/** Move a submitted receipt into the review queue. */
export async function takeForReview(ctx: AuthContext, db: Db, id: Id): Promise<void> {
  require_(ctx.role, 'payment.review');
  await db.prepare(`UPDATE payments SET status='under_review' WHERE id=? AND status='submitted'`)
    .bind(id).run();
}

/** The admin review queue — oldest first, so nobody waits longer than anyone
 *  else. Batch approve is deliberately NOT offered: approving money should cost
 *  one deliberate tap each (04_UX_SPEC §4.2). */
export async function listReviewQueue(ctx: AuthContext, db: Db, limit = 50) {
  require_(ctx.role, 'payment.read_any');
  const r = await db.prepare(
    `SELECT p.id, p.receipt_no, p.claimed_amount_piastres, p.transfer_date, p.reference_no,
            p.note_ar, c.name_ar AS category_ar, b.code AS building_code, u.unit_number
       FROM payments p
       JOIN units u      ON u.id = p.unit_id
       JOIN buildings b  ON b.id = u.building_id
       JOIN categories c ON c.id = p.category_id
      WHERE p.status IN ('submitted','under_review')
      ORDER BY p.created_at ASC LIMIT ?`
  ).bind(Math.min(limit, 200)).all();
  return r.results;
}

/** Aggregated per building — the shape /finance/units shows when unit-level
 *  detail is still locked pending the assembly's written approval (Q11). */
/**
 * Per-building collection status.
 *
 * ## R-050: "owes nothing" and "paid" are not the same thing
 * This counted `outstanding <= 0` as paid. A unit whose dues were never
 * published has `due = 0` and `paid = 0`, so `outstanding = 0`, so it counted
 * as **paid** — and a building nobody ever billed rendered as **"دفعوا ٣/٣"**.
 * That is a false all-clear on the one screen whose entire job is telling the
 * board who has not paid, and it is exactly what a forgotten building or a
 * half-finished import looks like.
 *
 * `billed` is therefore counted separately, and a building with `billed = 0`
 * says "لسه ماتحسبتش" rather than claiming a collection that never happened.
 */
export async function getBuildingTotals(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'finance.read_unit_status');
  const r = await db.prepare(
    `SELECT building_code AS code,
            COUNT(*) AS n,
            -- units that actually owe something this period
            SUM(CASE WHEN due_piastres > 0 THEN 1 ELSE 0 END) AS billed,
            -- ...of those, the ones that have settled. A unit with no dues is
            -- in NEITHER number: it is not paid and it is not in arrears.
            SUM(CASE WHEN due_piastres > 0 AND outstanding_piastres <= 0 THEN 1 ELSE 0 END) AS paid,
            SUM(paid_piastres) AS collected,
            SUM(deposit_paid_piastres) AS deposits,
            SUM(CASE WHEN outstanding_piastres > 0 THEN outstanding_piastres ELSE 0 END) AS outstanding
       FROM v_unit_balance GROUP BY building_code
      ORDER BY CAST(building_code AS INTEGER)`
  ).all();
  return r.results;
}

/** The pinned notice for the home screen. */
export async function getPinnedPost(ctx: AuthContext, db: Db) {
  return db.prepare(
    `SELECT title_ar, body_ar FROM posts
      WHERE is_pinned = 1 AND published_at IS NOT NULL AND deleted_at IS NULL
      ORDER BY published_at DESC LIMIT 1`
  ).first<{ title_ar: string; body_ar: string }>();
}

/** The caller's own display name. Reading ANOTHER person's name is a separate
 *  question and deliberately not answered here. */
export async function getDisplayName(ctx: AuthContext, db: Db): Promise<string> {
  const r = await db.prepare(`SELECT full_name FROM profiles WHERE id = ?`)
    .bind(ctx.personId).first<{ full_name: string }>();
  return r?.full_name ?? '';
}

export async function countPending(ctx: AuthContext, db: Db): Promise<number> {
  require_(ctx.role, 'finance.read_totals');
  const r = await db.prepare(
    `SELECT COUNT(*) n FROM payments WHERE status IN ('submitted','under_review','needs_info')`
  ).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function getCategoryNames(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'finance.read_categories');
  const r = await db.prepare(`SELECT id, name_ar, icon FROM categories WHERE is_active = 1 ORDER BY sort_order`)
    .all<{ id: string; name_ar: string; icon: string | null }>();
  return r.results;
}

/** R-024: if the board is one active person, /admin must SAY SO. */
export async function singleAdminWarning(ctx: AuthContext, db: Db): Promise<boolean> {
  const r = await db.prepare(`SELECT show_warning FROM v_single_admin_warning`)
    .first<{ show_warning: number }>();
  return !!r?.show_warning;
}

/* ===================================================================== */
/* Receipt images — access test 2                                        */
/* ===================================================================== */

/**
 * The object store is private and there are no public URLs, ever. This is the
 * ONLY way a byte of a receipt is reached, and it re-checks ownership on every
 * single request — not once at upload time. (C6, 05 §4)
 */
export async function authorizeObjectRead(
  ctx: AuthContext, db: Db, storageKey: string, now: Clock,
): Promise<{ storageKey: string; mime: string }> {
  const d = today(now);
  const sql = can(ctx.role, 'receipt_image.read_any')
    ? `SELECT storage_key, mime FROM storage_objects WHERE storage_key = ? AND deleted_at IS NULL`
    : `SELECT storage_key, mime FROM storage_objects
        WHERE storage_key = ? AND deleted_at IS NULL
          AND unit_id IN (${OWNED_UNITS} UNION ${DELEGATED_FINANCIAL_UNITS})`;
  const stmt = can(ctx.role, 'receipt_image.read_any')
    ? db.prepare(sql).bind(storageKey)
    : db.prepare(sql).bind(storageKey, ctx.personId, ctx.personId, d, d);
  const row = await stmt.first<{ storage_key: string; mime: string }>();
  if (!row) throw new NotFound('الصورة دي مش متاحة ليك');
  return { storageKey: row.storage_key, mime: row.mime };
}

/**
 * The transfer destinations shown on step 3, at the moment the resident needs
 * them. Returns nulls until the board fills them in — C10: a plausible-looking
 * invented account number is the one fabrication that could send real money to
 * the wrong place, so the screen says "الإدارة لسه محطتش بيانات التحويل" instead.
 */
export async function getPaymentDetails(ctx: AuthContext, db: Db) {
  const r = await db.prepare(
    `SELECT instapay_handle, bank_name_ar, bank_account_no, vodafone_cash_no
       FROM settings WHERE id = 1`
  ).first<{ instapay_handle: string | null; bank_name_ar: string | null;
            bank_account_no: string | null; vodafone_cash_no: string | null }>();
  return {
    instapay: r?.instapay_handle ?? null,
    bank: r?.bank_account_no ? `${r.bank_name_ar ?? ''} ${r.bank_account_no}`.trim() : null,
    vodafone: r?.vodafone_cash_no ?? null,
  };
}

/** The board-configured hard cap on object storage (05 §2a). */
export async function getStorageCap(ctx: AuthContext, db: Db): Promise<number> {
  const r = await db.prepare(`SELECT storage_hard_cap_bytes FROM settings WHERE id = 1`)
    .first<{ storage_hard_cap_bytes: number }>();
  return r?.storage_hard_cap_bytes ?? 7_516_192_768;
}

/**
 * Duplicate detection: same image hash, OR same amount on the same day for the
 * same unit (04_UX_SPEC §4.1). Returns the earlier receipt so the resident can
 * be WARNED — never blocked. A genuine second transfer of the same amount on
 * the same day is entirely possible, and refusing it would be worse than a
 * duplicate: the resident would conclude the site is broken and go back to
 * WhatsApp. Wording is neutral by design (06 §3).
 */
export async function findDuplicateReceipt(
  ctx: AuthContext, db: Db, sha256: string, amountPiastres: number, transferDate: string,
): Promise<{ receipt_no: string; transfer_date: string } | null> {
  return db.prepare(
    `SELECT receipt_no, transfer_date FROM payments
      WHERE status NOT IN ('rejected','cancelled','duplicate')
        AND unit_id IN (${OWNED_UNITS})
        AND (image_sha256 = ?
             OR (claimed_amount_piastres = ? AND transfer_date = ?))
      ORDER BY created_at DESC LIMIT 1`
  ).bind(ctx.personId, sha256, amountPiastres, transferDate)
   .first<{ receipt_no: string; transfer_date: string }>();
}

export interface NewStorageObject {
  storageKey: string; bucket: string; ownerKind: string; ownerId: string;
  unitId: string | null; sizeBytes: number; sha256: string; mime: string;
  exifStripped: boolean;
}

export async function registerStorageObject(
  ctx: AuthContext, db: Db, o: NewStorageObject,
): Promise<void> {
  await db.prepare(
    `INSERT INTO storage_objects (storage_key, bucket, owner_kind, owner_id, unit_id,
       size_bytes, sha256, mime, exif_stripped, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(o.storageKey, o.bucket, o.ownerKind, o.ownerId, o.unitId, o.sizeBytes,
         o.sha256, o.mime, o.exifStripped ? 1 : 0, ctx.personId).run();
}

/**
 * Human-quotable receipt number, `R-2026-00417`. Sequential per year so a
 * resident can read it down a phone line and an admin can find it.
 * MAX+1 is safe here because payment creation is not concurrent at village
 * scale; if it ever is, the UNIQUE constraint turns a race into a retry rather
 * than into two receipts with one number.
 */
export async function nextReceiptNo(ctx: AuthContext, db: Db): Promise<string> {
  const year = (await db.prepare(`SELECT strftime('%Y','now') y`).first<{ y: string }>())?.y ?? '2026';
  const r = await db.prepare(
    // R-051: this read `substr(receipt_no, 9)`, which drops the FIRST of the
    // five sequence digits. Harmless up to 9999 because the dropped digit is a
    // leading zero — and then `R-2026-10000` parses as 0, the counter rewinds
    // to 1, and every insert collides with the UNIQUE receipt_no. Receipt
    // submission would stop dead, for everyone, with a 500. Position 8 is the
    // first digit: `R-2026-` is seven characters.
    `SELECT COALESCE(MAX(CAST(substr(receipt_no, 8) AS INTEGER)), 0) n
       FROM payments WHERE receipt_no LIKE ?`
  ).bind(`R-${year}-%`).first<{ n: number }>();
  return `R-${year}-${String((r?.n ?? 0) + 1).padStart(5, '0')}`;
}

/* ===================================================================== */
/* Phone numbers — access tests 5, 7, 11                                 */
/* ===================================================================== */

/**
 * A resident sees only their own number. An operator sees NOBODY's — including
 * their own unit-mates'. The history table is covered by the same predicate, so
 * a replaced number cannot be read either. (test 11)
 */
export async function getPhoneNumbers(
  ctx: AuthContext, db: Db, profileId: Id,
): Promise<{ phone_e164: string; status: string; valid_from: string }[]> {
  if (profileId !== ctx.personId) require_(ctx.role, 'phone.read_any');
  else if (!can(ctx.role, 'phone.read_any') && !can(ctx.role, 'profile.edit_own')) {
    throw new Forbidden('phone.read_any');
  }
  const r = await db.prepare(
    `SELECT phone_e164, status, valid_from FROM phone_identifiers
      WHERE profile_id = ? AND (? = 1 OR profile_id = ?)
      ORDER BY valid_from DESC`
  ).bind(profileId, can(ctx.role, 'phone.read_any') ? 1 : 0, ctx.personId)
   .all<{ phone_e164: string; status: string; valid_from: string }>();
  return r.results;
}

/* ===================================================================== */
/* Transparency reads — access test 9                                    */
/* ===================================================================== */

export async function getCommunityTotals(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'finance.read_totals');
  return db.prepare(`SELECT * FROM v_community_totals`).first();
}

export async function getExpenseByCategory(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'finance.read_categories');
  const r = await db.prepare(
    `SELECT category_id, name_ar, total_piastres FROM v_expense_by_category
      WHERE parent_id IS NULL AND total_piastres > 0 ORDER BY total_piastres DESC`
  ).all();
  return r.results;
}

/**
 * Per-unit collection status. Aggregates ONLY — unit code, due, paid,
 * outstanding. No names, no phone numbers, no receipt images: they are not in
 * the SELECT list, so a template cannot leak what it was never given.
 *
 * Gated on `settings.unit_status_public`, which is 0 until the general assembly
 * approves in writing (Q11 / R-002).
 */
export async function getUnitBalances(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'finance.read_unit_status');
  const s = await db.prepare(`SELECT unit_status_public FROM settings WHERE id=1`)
    .first<{ unit_status_public: number }>();
  if (!s?.unit_status_public && !can(ctx.role, 'payment.read_any')) {
    // Not an error — a deliberate, explained empty state. 04_UX_SPEC §5.
    return { allowed: false as const, reasonAr: 'عرض حالة السداد لكل وحدة مقفول لحد ما الجمعية العمومية توافق كتابةً', rows: [] };
  }
  const r = await db.prepare(
    `SELECT building_code, unit_number, due_piastres, paid_piastres, outstanding_piastres
       FROM v_unit_balance ORDER BY CAST(building_code AS INTEGER), CAST(unit_number AS INTEGER)`
  ).all();
  return { allowed: true as const, rows: r.results };
}

/**
 * A unit's full personal statement. Access test 13: a delegate whose grant has
 * `can_view_financials = 0` cannot reach this by any route.
 */
export async function getUnitStatement(ctx: AuthContext, db: Db, unitId: Id, now: Clock) {
  const d = today(now);
  const sql = can(ctx.role, 'payment.read_any')
    ? `SELECT * FROM v_unit_balance WHERE unit_id = ?`
    : `SELECT * FROM v_unit_balance
        WHERE unit_id = ?
          AND unit_id IN (${OWNED_UNITS} UNION ${DELEGATED_FINANCIAL_UNITS})`;
  const stmt = can(ctx.role, 'payment.read_any')
    ? db.prepare(sql).bind(unitId)
    : db.prepare(sql).bind(unitId, ctx.personId, ctx.personId, d, d);
  const row = await stmt.first();
  if (!row) throw new NotFound('كشف الحساب ده مش متاح ليك');
  return row;
}

export async function getStaff(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'staff.read_salaries');
  const s = await db.prepare(`SELECT staff_names_public FROM settings WHERE id=1`)
    .first<{ staff_names_public: number }>();
  const namesVisible = can(ctx.role, 'staff.read_names') || !!s?.staff_names_public;
  // The column split lives in the VIEW, not in a template condition.
  const r = namesVisible
    ? await db.prepare(`SELECT id, full_name, job_title_ar, monthly_salary_piastres FROM staff WHERE is_active=1`).all()
    : await db.prepare(`SELECT id, job_title_ar, monthly_salary_piastres FROM v_staff_public WHERE is_active=1`).all();
  return r.results;
}

/* ===================================================================== */
/* Audit log — access test 8                                             */
/* ===================================================================== */

export async function readAuditLog(ctx: AuthContext, db: Db, limit = 100) {
  require_(ctx.role, 'audit.read');
  const r = await db.prepare(
    `SELECT id, actor_id, actor_role, action, entity_table, entity_id, created_at
       FROM audit_log ORDER BY created_at DESC LIMIT ?`
  ).bind(Math.min(limit, 500)).all();
  return r.results;
}

/**
 * There is NO exported function that updates or deletes an audit row, for any
 * role, and `audit.modify` is held by nobody in the matrix. The database also
 * refuses it via `trg_audit_no_update` / `trg_audit_no_delete`. Three layers,
 * because a tampered audit log makes every other control unverifiable.
 *
 * ⚠️ Prefer `mutate()`. This writes an audit row on its own, so it can drift
 * from the write it describes. It exists only for events that have no row to
 * change — a failed login attempt, a session opening. If you are changing a row,
 * use `mutate()` so the two commit together.
 */
export async function writeAudit(
  db: Db, ctx: AuthContext | null, action: string, table: string,
  entityId: string | null, before: unknown, after: unknown,
): Promise<void> {
  await db.prepare(
    `INSERT INTO audit_log (id, actor_id, actor_role, on_behalf_of, action, entity_table,
       entity_id, before_json, after_json)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    newId('AUD'), ctx?.personId ?? null, ctx?.role ?? null, null, action, table, entityId,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
  ).run();
}

/* ===================================================================== */
/* Break-glass — access test 15                                          */
/* ===================================================================== */

/**
 * Deliberately provided so the CP-1 gate can prove test 15 over HTTP: the most
 * privileged path this system has still cannot rewrite a posted journal line.
 * It is not a feature. It exists to be refused, and the test asserts it is.
 */
export async function developerAttemptJournalLineEdit(
  ctx: AuthContext, db: Db, lineId: Id, newDebit: number,
): Promise<never> {
  if (ctx.role !== 'developer') throw new Forbidden('schema.migrate');
  try {
    await db.prepare(`UPDATE journal_lines SET debit_piastres = ? WHERE id = ?`)
      .bind(newDebit, lineId).run();
  } catch (e) {
    throw new LedgerRefused('سطور القيود مش بتتعدّل، ولا حتى من المبرمج', e);
  }
  // If we reach here the database did NOT refuse, which is a critical failure.
  throw new Error('INVARIANT VIOLATED: a journal_line was mutated. Stop and fix the schema.');
}

/* ===================================================================== */

let _counter = 0;
export function newId(prefix: string): string {
  // ULID-shaped. Replaced by a real ULID in the Worker; deterministic here so
  // tests are reproducible.
  //
  // R-057: this padded to a fixed 23, which is only correct for a THREE-letter
  // prefix. `newId('JE')` returned 25 characters and every `CHECK (length(id) =
  // 26)` refused it — but only on the tables whose ids use a two-letter prefix,
  // which is journal entries and journal lines. Nothing caught it because every
  // id in the seed and in every fixture was written by hand; `newId` had only
  // ever been called with 'PAY', 'AUD' and 'UOW'. The first code path to
  // generate a journal entry at runtime — expense posting — hit it immediately.
  //
  // Pad relative to the prefix, and assert, because an id that is silently the
  // wrong length fails at the database with a message naming a constraint
  // rather than a cause.
  _counter += 1;
  const p = prefix.toUpperCase();
  const body = `${Date.now().toString(36).toUpperCase()}${_counter.toString(36).toUpperCase()}`;
  const out = (p + body.padEnd(26 - p.length, '0')).slice(0, 26);
  if (out.length !== 26) throw new Error(`newId('${prefix}') produced ${out.length} chars`);
  return out;
}

/* ===================================================================== */
/* Free-tier usage — the control that keeps C11 true AFTER launch        */
/* ===================================================================== */

/**
 * What `/admin/health` shows.
 *
 * ## Why this is a page and not a spreadsheet
 * C11 is not "the free tier is big enough", it is "this costs zero forever."
 * That is a claim about the future, and the only honest way to hold it is to
 * measure continuously and show the board the numbers. `05 §2a` asks for a
 * dashboard that goes red past 70% — early enough that the answer is "clean up
 * old receipts", not "the site stopped working."
 *
 * ## The honesty rule this function exists to enforce
 * Two kinds of number appear on that page and they are **not** the same kind of
 * fact:
 *   · `measured: true`  — counted from this database, right now.
 *   · `measured: false` — a limit published by the vendor, transcribed into
 *     `docs/QUOTA_AND_COST_REGISTER.md` on a date, by a human.
 * A request count we cannot see from inside a Worker is NOT reported as zero;
 * reporting an unmeasured metric as 0% is how a dashboard talks a board into
 * a bill. Unmeasurable rows carry `used: null` and render as "—".
 *
 * Everything here is aggregate. There is no resident-identifying data on this
 * page at all, which is why a single `require_` is the whole access story.
 */
export interface QuotaRow {
  service: string;
  metricAr: string;
  used: number | null;
  limitValue: number;
  unit: 'bytes' | 'count';
  measured: boolean;
  /** What actually happens at the limit. Verbatim from the register. */
  atLimitAr: string;
  canBill: boolean;
}

export async function getQuotaUsage(ctx: AuthContext, db: Db): Promise<{
  rows: QuotaRow[]; overThreshold: number; capOnFile: false; verifiedOn: string;
}> {
  require_(ctx.role, 'system.read_quota');

  const blob = await db.prepare(
    `SELECT objects, used_bytes, largest_bytes, db_limit_bytes FROM v_blob_usage`
  ).first<{ objects: number; used_bytes: number; largest_bytes: number; db_limit_bytes: number }>();
  const store = await db.prepare(
    `SELECT used_bytes, cap_bytes FROM v_storage_usage`
  ).first<{ used_bytes: number; cap_bytes: number }>();

  // Limits transcribed from docs/QUOTA_AND_COST_REGISTER.md, verified 2026-08-04.
  // They are duplicated here deliberately: a number the app enforces must live
  // in the app. The register is the evidence; this is the enforcement.
  const rows: QuotaRow[] = [
    {
      service: 'Cloudflare D1', metricAr: 'حجم قاعدة البيانات',
      used: blob?.used_bytes ?? 0, limitValue: blob?.db_limit_bytes ?? 524_288_000,
      unit: 'bytes', measured: true,
      atLimitAr: 'الكتابة بتقف لحد ما نفضّي مكان — مفيش أي فاتورة', canBill: false,
    },
    {
      service: 'Cloudflare D1', metricAr: 'صور الإيصالات المخزّنة',
      used: blob?.objects ?? 0, limitValue: 100_000, unit: 'count', measured: true,
      atLimitAr: 'مفيش حد على العدد نفسه — الحد هو الحجم فوق', canBill: false,
    },
    {
      service: 'Cloudflare D1', metricAr: 'صفوف مكتوبة في اليوم',
      used: null, limitValue: 100_000, unit: 'count', measured: false,
      atLimitAr: 'الاستعلامات بترفض لآخر اليوم — مفيش أي فاتورة', canBill: false,
    },
    {
      service: 'Cloudflare Workers', metricAr: 'طلبات في اليوم',
      used: null, limitValue: 100_000, unit: 'count', measured: false,
      atLimitAr: 'الطلبات بترجع خطأ — مفيش أي فاتورة', canBill: false,
    },
    {
      service: 'Cloudflare KV', metricAr: 'كتابات في اليوم',
      used: null, limitValue: 1_000, unit: 'count', measured: false,
      atLimitAr: 'العمليات بترفض. ده أضيق حد في المنظومة كلها', canBill: false,
    },
    {
      service: 'Cloudflare Pages', metricAr: 'نشر في الشهر',
      used: null, limitValue: 500, unit: 'count', measured: false,
      atLimitAr: 'النشر بيترفض — مفيش أي فاتورة', canBill: false,
    },
    {
      service: 'التخزين المسموح داخليًا', metricAr: 'الحد اللي إحنا فارضينه بنفسنا',
      used: store?.used_bytes ?? 0, limitValue: store?.cap_bytes ?? 7_516_192_768,
      unit: 'bytes', measured: true,
      atLimitAr: 'الرفع بيقف — حد إضافي بنفرضه إحنا قبل حد الخدمة', canBill: false,
    },
  ];

  const overThreshold = rows.filter(
    r => r.used !== null && r.limitValue > 0 && (r.used * 100) / r.limitValue >= 70).length;

  return {
    rows,
    overThreshold,
    // Asserted, not assumed: R2 and WhatsApp — the only two services that could
    // ever bill us — are both out of the stack (ADR-016, ADR-023). If a future
    // row arrives with canBill: true, the page must say so loudly.
    capOnFile: false,
    verifiedOn: '2026-08-04',
  };
}

/**
 * Fund solvency — "have we spent the residents' deposits?"
 *
 * The deposit fund must hold at least as much cash as it owes back. A shortfall
 * means running costs were paid out of money held in trust (أمانة), which is
 * both a legal problem and the single most damaging thing that can quietly
 * happen to a compound's finances. It is invisible in every other figure: the
 * ledger balances, the equation holds, income and expenses look normal, and the
 * treasury balance is simply *higher* than it should be.
 *
 * Nothing in this project could answer the question until `migrations/0012`
 * fixed `v_fund_balances` — before that every fund reported roughly zero.
 * R-043's lesson applies here too: a check that only exists in a test file is a
 * check the board never sees, so this one is rendered on `/finance`.
 */
export async function getFundHealth(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'finance.read_totals');
  const r = await db.prepare(
    `SELECT kind, name_ar, net_debit_piastres, owed_piastres, is_spendable
       FROM v_fund_balances ORDER BY is_spendable DESC, kind`).all();
  const rows = r.results as Array<Record<string, number | string>>;
  const dep = rows.find(f => f['kind'] === 'deposit');
  const holds = Number(dep?.['net_debit_piastres'] ?? 0);
  const owed = Number(dep?.['owed_piastres'] ?? 0);
  return {
    funds: rows,
    depositHolds: holds,
    depositOwed: owed,
    /** Positive means trust money has been spent. Zero is the only good answer. */
    depositShortfall: Math.max(0, owed - holds),
  };
}

/**
 * How many fee periods are currently published.
 *
 * R-055: `v_unit_balance.due_piastres` sums **every** published fee period,
 * with no year filter — which is right for arrears (last year's unpaid
 * subscription does not stop being owed on 1 January) and wrong for the caption
 * "المطلوب منك السنة دي" that sat above it. On the first day of the next fiscal
 * year the figure silently becomes two years combined, with no deploy and no
 * code change.
 *
 * Rather than scope the number — which would make old debt vanish from the
 * screen a resident checks — the caption now tells the truth, and says so
 * explicitly once more than one period is live.
 */
export async function countPublishedPeriods(ctx: AuthContext, db: Db): Promise<number> {
  require_(ctx.role, 'finance.read_totals');
  const r = await db.prepare(
    `SELECT COUNT(*) n FROM fee_periods WHERE is_published = 1`).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/* ===================================================================== */
/* Payment reversal — the correction a RESIDENT sees                     */
/* ===================================================================== */

/**
 * Reverse an approved receipt.
 *
 * ## Why this is the most socially delicate operation in the system
 * The resident was told «اتقبل إيصالك ✅». Reversing it says that did not
 * count. In a compound where everyone knows everyone and the whole project
 * exists because of suspicion born of disorder, a reversal with a vague reason
 * is worse than the original error — it reads as the board taking money back.
 *
 * So three things are non-negotiable and all three are enforced, not requested:
 *   1. **A written reason**, ≥10 characters, which the resident reads verbatim.
 *      `payment_transitions.requires_reason = 1` already refuses a blank one.
 *   2. **A second admin.** Not the maker–checker rule — the mirror of it: the
 *      person who *approved* the receipt cannot be the one who un-approves it
 *      (`trg_payment_reversal_needs_second_admin`). Without that, one admin can
 *      approve a receipt, take the credit for it with the family, and reverse
 *      it later with nobody else ever having looked. That is the shape of every
 *      small-community embezzlement this project exists to prevent.
 *   3. **The resident is told.** A reversal without a delivered explanation is
 *      indistinguishable from money going missing, so the notification is
 *      written in the same batch as the reversal — it cannot be "sent later".
 *
 * ## The ledger side
 * The reversing entry is built by reading the ORIGINAL entry's lines and
 * flipping each one, rather than by assuming a shape. A subscription payment
 * with an overpayment posts three lines (Dr cash, Cr income, Cr owner credit);
 * a deposit posts two, to a different fund. Mirroring whatever is actually
 * there is the only version that is right for both — and it means the owner
 * credit is withdrawn along with the income, instead of being left behind as a
 * balance the village would still owe.
 *
 * The arrears come back automatically: `v_unit_balance` counts approved
 * payments, and this is no longer one.
 */
export async function reversePayment(
  ctx: AuthContext, db: Db, paymentId: Id, reasonAr: string,
  secondAdminId: Id, now: Clock,
): Promise<Id> {
  require_(ctx.role, 'payment.reverse');

  const reason = (reasonAr ?? '').trim();
  if (reason.length < 10) {
    throw new LedgerRefused('لازم تكتب سبب واضح للإلغاء — الساكن هيقراه بالنص');
  }

  const p = await db.prepare(
    `SELECT id, receipt_no, status, submitted_by, reviewed_by, unit_id,
            approved_amount_piastres, journal_entry_id
       FROM payments WHERE id = ?`
  ).bind(paymentId).first<{
    id: string; receipt_no: string; status: string; submitted_by: string;
    reviewed_by: string | null; unit_id: string;
    approved_amount_piastres: number | null; journal_entry_id: string | null;
  }>();
  if (!p) throw new NotFound('الإيصال ده مش موجود');
  if (p.status !== 'approved') {
    // Only an approved receipt has anything in the books to undo. A rejected or
    // pending one contributed zero to every total already (C5).
    throw new LedgerRefused('الإيصال ده مش معتمد — مفيش حاجة تتلغى');
  }
  if (ctx.personId === p.reviewed_by) {
    throw new LedgerRefused('اللي اعتمد الإيصال مينفعش يلغيه بنفسه — لازم مسؤول تاني');
  }
  if (!p.journal_entry_id) {
    throw new LedgerRefused('الإيصال ده معتمد من غير قيد — بلّغ الإدارة، ده خطأ في البيانات');
  }

  /* ⭐ A second, NAMED admin agrees to the reversal.
   *
   * `trg_entry_maker_checker` refuses any journal entry whose creator is its
   * approver, and the first version of this function set both to the caller.
   * The refusal was right, and the fix is the pattern `changePhoneNumber`
   * already uses for staff phone changes (03_RBAC §6 step 4): the caller names
   * the colleague who agreed, and BOTH names go on the record.
   *
   * That is stronger than it looks. Taking money back off a family is the one
   * operation where "the treasurer said it was fine" needs to be checkable two
   * years later — and now it is a row, not a memory. The original approver may
   * be that second admin: agreeing that your own approval was wrong is exactly
   * the situation this should support. What is refused is one person doing it
   * alone. */
  if (secondAdminId === ctx.personId) {
    throw new LedgerRefused('لازم مسؤول تاني يوافق على الإلغاء — مش نفس الشخص');
  }
  const second = await db.prepare(
    `SELECT id, role FROM profiles WHERE id = ? AND is_active = 1`
  ).bind(secondAdminId).first<{ id: string; role: Role }>();
  if (!second || !can(second.role, 'payment.reverse')) {
    throw new LedgerRefused('المسؤول التاني لازم يكون من الإدارة وليه صلاحية الإلغاء');
  }

  const orig = await db.prepare(
    `SELECT account_id, fund_id, debit_piastres, credit_piastres, unit_id
       FROM journal_lines WHERE entry_id = ? ORDER BY line_no`
  ).bind(p.journal_entry_id).all();
  const lines = orig.results as Array<Record<string, unknown>>;
  if (lines.length === 0) throw new LedgerRefused('القيد الأصلي مالوش سطور');

  const period = await db.prepare(
    `SELECT id FROM fiscal_periods WHERE status IN ('open','reopened')
      ORDER BY starts_on DESC LIMIT 1`
  ).first<{ id: string }>();
  if (!period) throw new LedgerRefused('مفيش سنة مالية مفتوحة نرحّل عليها');

  const entryId = newId('JE') as Id;
  const ts = now();
  const today = ts.slice(0, 10);
  const seq = await db.prepare(
    `SELECT COALESCE(MAX(CAST(substr(entry_no, 8) AS INTEGER)), 0) n
       FROM journal_entries WHERE entry_no LIKE ?`
  ).bind(`J-${today.slice(0, 4)}-%`).first<{ n: number }>();
  const entryNo = `J-${today.slice(0, 4)}-${String((seq?.n ?? 0) + 1).padStart(6, '0')}`;

  const stmts = [
    db.prepare(
      `INSERT INTO journal_entries (id, entry_no, entry_date, period_id, description_ar,
         source_type, source_id, created_by, is_reversal, reverses_entry_id,
         reversal_reason_ar)
       VALUES (?,?,?,?,?, 'payment', ?, ?, 1, ?, ?)`
    ).bind(entryId, entryNo, today, period.id,
           `إلغاء إيصال ${p.receipt_no} — ${reason}`, p.id, ctx.personId,
           p.journal_entry_id, reason),
    // Every original line, flipped. Not a guessed shape — see the doc comment.
    ...lines.map((l, i) => db.prepare(
      `INSERT INTO journal_lines (id, entry_id, line_no, account_id, fund_id,
         debit_piastres, credit_piastres, unit_id, memo_ar)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(newId('JL'), entryId, i + 1, l['account_id'], l['fund_id'],
           Number(l['credit_piastres']), Number(l['debit_piastres']),
           l['unit_id'], reason)),
    // The second admin is the entry's approver — two names on the record.
    db.prepare(
      `UPDATE journal_entries SET approved_by = ?, posted_at = ? WHERE id = ?`
    ).bind(secondAdminId, ts, entryId),
    db.prepare(
      `UPDATE payments SET status = 'reversed', review_reason_ar = ?,
         reversed_by = ?, reversed_at = ?
        WHERE id = ? AND status = 'approved'`
    ).bind(reason, ctx.personId, ts, p.id),
    // ⭐ Same batch as the reversal. A reversal the resident was never told
    // about is indistinguishable from money going missing, so "notify later"
    // is not a state this can be in.
    db.prepare(
      `INSERT OR IGNORE INTO notifications
         (id, profile_id, kind, title_ar, body_ar, link_path, payment_id)
       VALUES (?,?, 'payment_reversed', ?, ?, '/payments', ?)`
    ).bind(newId('NOT'), p.submitted_by, `اتلغى اعتماد إيصال ${p.receipt_no}`,
           `${reason}\n\nلو مش فاهم السبب أو شايف إن فيه غلط، كلّم الإدارة.`, p.id),
    db.prepare(
      `INSERT INTO audit_log (id, actor_id, actor_role, action, entity_table,
         entity_id, before_json, after_json, created_at)
       VALUES (?,?,?, 'payment.reverse', 'payments', ?, ?, ?, ?)`
    ).bind(newId('AUD'), ctx.personId, ctx.role, p.id,
           JSON.stringify({ status: 'approved', amount: p.approved_amount_piastres }),
           JSON.stringify({ status: 'reversed', reason, entryId, agreedBy: secondAdminId }), ts),
  ];

  try {
    await db.batch(stmts);
  } catch (err) {
    throw asRefusal(err);
  }
  return entryId;
}

/**
 * Approved receipts, for the reversal screen.
 *
 * `reviewedBy` travels with each row so the screen can hide the reverse control
 * from the admin who approved it (R-062) instead of letting them tap it and be
 * refused. Same rule as the expense screen: the interface should not offer what
 * the rules forbid.
 */
export async function listApprovedPayments(ctx: AuthContext, db: Db, limit = 50) {
  require_(ctx.role, 'payment.read_any');
  const r = await db.prepare(
    `SELECT p.id, p.receipt_no, p.approved_amount_piastres, p.transfer_date,
            p.reviewed_by, p.status, p.review_reason_ar,
            c.name_ar AS category_ar, b.code AS building_code, u.unit_number
       FROM payments p
       JOIN units u      ON u.id = p.unit_id
       JOIN buildings b  ON b.id = u.building_id
       JOIN categories c ON c.id = p.category_id
      WHERE p.status IN ('approved','reversed')
      ORDER BY p.reviewed_at DESC LIMIT ?`
  ).bind(Math.min(limit, 200)).all();
  return r.results;
}

/**
 * Who can be named as the second admin agreeing to a reversal.
 *
 * The caller is excluded from their own list — not as a security measure
 * (`reversePayment` refuses it anyway) but because a dropdown containing your
 * own name on a two-person control invites exactly the mistake the control
 * exists to prevent, and then blames you for it.
 */
export async function reversalApprovers(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'payment.reverse');
  const r = await db.prepare(
    `SELECT id, full_name FROM profiles
      WHERE is_active = 1 AND role IN ('admin','developer') AND id <> ?
      ORDER BY full_name`
  ).bind(ctx.personId).all();
  return r.results;
}

/* ===================================================================== */
/* Notifications — a resident reading their own, and nobody else's       */
/* ===================================================================== */

/**
 * A resident's own messages.
 *
 * ## The C6 predicate is `profile_id = ?` and it is inside the string
 * A notification body quotes an admin's reason verbatim — «التحويل رجع من
 * البنك», «الصورة مش واضحة» — attached to a named receipt. It is exactly as
 * private as the receipt image, and the same rule applies: the ownership
 * predicate lives in the query, not in a caller that might forget it.
 *
 * There is deliberately **no admin override**. An admin who needs to know what a
 * resident was told can read the payment's `review_reason_ar`, which is the same
 * text and is already covered by `payment.read_any`. Giving anyone a route that
 * reads another person's inbox would be a new capability nobody asked for.
 */
export async function listMyNotifications(ctx: AuthContext, db: Db, limit = 50) {
  const r = await db.prepare(
    `SELECT id, kind, title_ar, body_ar, link_path, read_at, created_at
       FROM notifications
      WHERE profile_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?`
  ).bind(ctx.personId, Math.min(limit, 200)).all();
  return r.results;
}

/** How many the resident has not opened yet — for the nav badge. */
export async function unreadCount(ctx: AuthContext, db: Db): Promise<number> {
  const r = await db.prepare(
    `SELECT COUNT(*) n FROM notifications WHERE profile_id = ? AND read_at IS NULL`
  ).bind(ctx.personId).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/**
 * Mark everything read when the resident opens the list.
 *
 * Not audited, deliberately. `mutate()` exists so a change to *money or
 * identity* cannot commit unlogged; "سعاد opened her messages" is neither, and
 * logging it would put a record of one resident's reading habits in a table
 * five people can read. The audit log is for accountability over shared money,
 * not surveillance of individuals — writing that down because the reflex to
 * "log everything" is exactly how the second thing happens by accident.
 */
export async function markNotificationsRead(ctx: AuthContext, db: Db, now: Clock): Promise<void> {
  await db.prepare(
    `UPDATE notifications SET read_at = ? WHERE profile_id = ? AND read_at IS NULL`
  ).bind(now(), ctx.personId).run();
}

/**
 * The most recent message for one person — what the push layer sends.
 *
 * No `AuthContext`: this is called by the delivery path on behalf of the
 * recipient, not by a caller reading someone's inbox. It is deliberately NOT
 * exported through any route, and `listMyNotifications` remains the only way a
 * request can reach a notification. Adding a route on top of this would be the
 * "read another person's inbox" power `listMyNotifications` refuses to grant.
 */
export async function latestNotificationFor(db: Db, profileId: Id) {
  const r = await db.prepare(
    `SELECT title_ar, body_ar, link_path FROM notifications
      WHERE profile_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).bind(profileId).all();
  return r.results;
}

/* ===================================================================== */
/* System jobs — no AuthContext, and why that is safe here               */
/* ===================================================================== */

/**
 * The nightly quota snapshot, written by the Worker's cron trigger.
 *
 * ## Why this takes no `AuthContext`
 *
 * Every other function in `lib/db/` takes one, and C6 says a data-access call
 * without an identity must be a compile error. This is the documented exception,
 * on the same reasoning as `lib/db/blobs.ts`: a cron has no caller to identify.
 * There is no session, no person, and inventing a synthetic "system" identity
 * would be worse — it would put a principal in the audit log that nobody can be
 * held to.
 *
 * What makes the exception safe is the shape of what it touches:
 * `quota_snapshots` holds counters about the deployment itself. It contains no
 * resident data, no money, and no name; there is no ownership predicate that
 * could be omitted because there is nothing owned. It is append-only and it is
 * read by `/admin/health`, which is capability-gated on its own.
 *
 * It lives here rather than in `src/worker.ts` because `tools/lint-no-sql.mjs`
 * is absolute, and correctly refused it there — the moment there is one
 * documented exception to "no SQL outside lib/db/", the next one is easier.
 */
export async function recordQuotaSnapshot(
  db: Db, now: Clock,
): Promise<{ used: number; limit: number; pct: number }> {
  const ts = now();
  const usage = await db.prepare(
    `SELECT COALESCE(SUM(size_bytes), 0) AS used FROM storage_objects WHERE deleted_at IS NULL`
  ).first<{ used: number }>();
  const cap = await db.prepare(
    `SELECT storage_hard_cap_bytes AS cap FROM settings WHERE id = 1`
  ).first<{ cap: number }>();

  const used = usage?.used ?? 0;
  // 7 GiB — the ceiling this project enforces in its own code rather than
  // trusting a vendor's free-tier limit (05 §2a).
  const limit = cap?.cap ?? 7_516_192_768;
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;

  await db.prepare(
    `INSERT INTO quota_snapshots (id, service, metric, used, limit_value, pct_used,
       reset_period, captured_at)
     VALUES (?, 'storage', 'bytes', ?, ?, ?, 'none', ?)`
  ).bind(newId('QSN'), used, limit, pct, ts).run();

  return { used, limit, pct };
}

/**
 * The board's PUBLISHED contact details, for `/help`.
 *
 * No `AuthContext`: the route already required a session, and there is nothing
 * here that varies by caller — it is one row the board chose to publish. Same
 * shape as `recordQuotaSnapshot` and the `blobs.ts` helpers, and documented for
 * the same reason: an unusual signature in this file needs to say why.
 *
 * Everything is nullable. Until somebody types a number into the settings
 * screen, `/help` shows no number — never a guess, never one lifted out of
 * `phone_identifiers`, which holds login identifiers rather than published
 * numbers (C6).
 */
export async function helpContacts(db: Db) {
  const r = await db.prepare(
    `SELECT label_ar, phone, whatsapp, hours_ar FROM v_help_contacts`
  ).first<{ label_ar: string | null; phone: string | null;
            whatsapp: string | null; hours_ar: string | null }>();
  return r ?? { label_ar: null, phone: null, whatsapp: null, hours_ar: null };
}
