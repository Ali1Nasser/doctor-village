/**
 * lib/db/onboarding.ts — assisted recovery and the owner-register import.
 *
 * Both are human processes with a database behind them, and both are fraud
 * surfaces rather than features. The controls that matter are in the schema
 * (`migrations/0010`), so a bug in a route cannot bypass them; this file is the
 * thin layer that drives them.
 */

import type { AuthContext, Id } from '../../types/domain.js';
import type { Db } from './driver.js';
import { LedgerRefused } from './driver.js';
import { newId, mutate, NotFound, type Clock } from './index.js';
import { require_, Forbidden, assertMakerChecker } from '../rbac.js';
import type { ParseResult } from '../import/owners.js';
import { createActivationChallenge } from './auth.js';
import { foldArabicLetters, LETTER_FOLD_PAIRS } from '../search/fold.js';

/* ===================================================================== */
/* Assisted recovery — R-023 / R-003                                     */
/* ===================================================================== */

/**
 * Step 1: an admin who has verified the resident's identity OFFLINE opens a
 * request. This alone grants nothing.
 */
export async function requestRecovery(
  ctx: AuthContext, db: Db, targetProfileId: Id, identityCheckAr: string,
): Promise<string> {
  require_(ctx.role, 'phone.change');
  if ((identityCheckAr ?? '').trim().length < 10) {
    // "تمام" is not an identity check. Ten characters is a low bar, and it is a
    // bar: whatever the admin writes ends up on the record beside their name.
    throw new LedgerRefused('اكتب إزاي اتأكدت إن ده هو فعلاً — الكلام ده بيتسجّل باسمك');
  }
  if (targetProfileId === ctx.personId) {
    throw new Forbidden('phone.change', 'مش ممكن تعمل استرجاع لحسابك إنت');
  }
  const id = newId('RCQ');
  await mutate(db, ctx,
    { action: 'recovery.request', table: 'recovery_requests', entityId: id,
      after: { target: targetProfileId, check: identityCheckAr } },
    db.prepare(
      `INSERT INTO recovery_requests (id, target_profile_id, identity_check_ar, requested_by)
       VALUES (?,?,?,?)`
    ).bind(id, targetProfileId, identityCheckAr.trim(), ctx.personId),
  );
  return id;
}

/**
 * Step 2: a DIFFERENT admin approves. The database enforces the difference
 * (`CHECK (approved_by <> requested_by)`), so this cannot be completed by one
 * person even if every check above it were deleted.
 *
 * Approving still issues nothing — step 3 does. Splitting them means an approval
 * can be recorded in a meeting and the link generated later, which is how a
 * volunteer board actually works.
 */
export async function approveRecovery(
  ctx: AuthContext, db: Db, requestId: Id, now: Clock,
): Promise<void> {
  require_(ctx.role, 'phone.change');
  const r = await db.prepare(
    `SELECT id, requested_by, target_profile_id, fulfilled_at, cancelled_at
       FROM recovery_requests WHERE id = ?`
  ).bind(requestId).first<{
    id: string; requested_by: string; target_profile_id: string;
    fulfilled_at: string | null; cancelled_at: string | null;
  }>();
  if (!r) throw new NotFound();
  if (r.fulfilled_at || r.cancelled_at) throw new LedgerRefused('الطلب ده اتقفل خلاص');
  assertMakerChecker(ctx.personId, r.requested_by as Id, 'recovery.approve');

  const changed = await mutate(db, ctx,
    { action: 'recovery.approve', table: 'recovery_requests', entityId: requestId,
      after: { target: r.target_profile_id } },
    db.prepare(
      `UPDATE recovery_requests SET approved_by = ?, approved_at = ?
        WHERE id = ? AND approved_by IS NULL AND requested_by <> ?`
    ).bind(ctx.personId, now(), requestId, ctx.personId),
  );
  if (changed !== 1) throw new LedgerRefused('الطلب ده متوافق عليه قبل كده أو مش مسموح ليك');
}

/**
 * Step 3: burn the approved request and hand back the target, so the caller can
 * issue an activation link. Also revokes every session and passkey — the whole
 * point is that the old device stops working.
 */
export async function fulfilRecovery(
  ctx: AuthContext, db: Db, requestId: Id, now: Clock,
): Promise<{ targetProfileId: string; fullName: string }> {
  require_(ctx.role, 'phone.change');
  const r = await db.prepare(
    `SELECT rr.id, rr.target_profile_id, rr.approved_by, rr.fulfilled_at, rr.cancelled_at,
            p.full_name
       FROM recovery_requests rr JOIN profiles p ON p.id = rr.target_profile_id
      WHERE rr.id = ?`
  ).bind(requestId).first<{
    id: string; target_profile_id: string; approved_by: string | null;
    fulfilled_at: string | null; cancelled_at: string | null; full_name: string;
  }>();
  if (!r) throw new NotFound();
  if (!r.approved_by) throw new Forbidden('recovery.fulfil', 'محتاج موافقة أدمن تاني الأول');
  if (r.fulfilled_at || r.cancelled_at) throw new LedgerRefused('الطلب ده اتقفل خلاص');

  const changed = await mutate(db, ctx,
    { action: 'recovery.fulfil', table: 'recovery_requests', entityId: requestId,
      after: { target: r.target_profile_id } },
    db.prepare(`UPDATE recovery_requests SET fulfilled_at = ?
                 WHERE id = ? AND fulfilled_at IS NULL AND approved_by IS NOT NULL`)
      .bind(now(), requestId),
    // the lost device loses everything — otherwise nothing was recovered
    db.prepare(`UPDATE sessions SET revoked_at = ?, revoked_by = ?
                 WHERE profile_id = ? AND revoked_at IS NULL`)
      .bind(now(), ctx.personId, r.target_profile_id),
    db.prepare(`UPDATE passkeys SET revoked_at = ?, revoked_by = ?
                 WHERE profile_id = ? AND revoked_at IS NULL`)
      .bind(now(), ctx.personId, r.target_profile_id),
  );
  if (changed !== 1) throw new LedgerRefused('الطلب ده اتنفّذ قبل كده');
  return { targetProfileId: r.target_profile_id, fullName: r.full_name };
}

export interface OpenRecovery {
  id: string;
  identity_check_ar: string;
  requested_by: string;
  requested_at: string;
  approved_by: string | null;
  approved_at: string | null;
  target_name: string;
  target_unit: string | null;
  requested_by_name: string | null;
  approved_by_name: string | null;
}

/**
 * The open recovery requests, with the names of everyone who has signed.
 *
 * This used to return bare profile ids for `requested_by` and `approved_by`,
 * which is all a JSON caller needed and all any caller could get. On a screen
 * the ids are the point: the second admin has to see WHO opened the request
 * before deciding whether to co-sign it — approving a request you cannot
 * attribute is not maker–checker, it is a second click.
 */
export async function listOpenRecoveries(ctx: AuthContext, db: Db): Promise<OpenRecovery[]> {
  require_(ctx.role, 'phone.change');
  const r = await db.prepare(
    `SELECT rr.id, rr.identity_check_ar, rr.requested_by, rr.requested_at,
            rr.approved_by, rr.approved_at,
            p.full_name  AS target_name,
            rq.full_name AS requested_by_name,
            ap.full_name AS approved_by_name,
            (SELECT b.name_ar || ' — ' || u.unit_number
               FROM unit_owners uo
               JOIN units u ON u.id = uo.unit_id
               JOIN buildings b ON b.id = u.building_id
              WHERE uo.profile_id = p.id AND uo.valid_to IS NULL
              LIMIT 1)   AS target_unit
       FROM recovery_requests rr
       JOIN profiles p ON p.id = rr.target_profile_id
       LEFT JOIN profiles rq ON rq.id = rr.requested_by
       LEFT JOIN profiles ap ON ap.id = rr.approved_by
      WHERE rr.fulfilled_at IS NULL AND rr.cancelled_at IS NULL
      ORDER BY rr.requested_at`
  ).all<OpenRecovery>();
  return r.results ?? [];
}

/**
 * The people a recovery request can be opened for: those who hold a device.
 *
 * Recovery is the procedure for losing an enrolled phone, so somebody with no
 * passkey has nothing to recover — for them the answer is a first activation
 * link from `/admin/members`, which needs one signature instead of two. Offering
 * the whole village here would invite the board to run the heavy procedure by
 * default, and `issueFirstActivation` refusing afterwards is a lesson learned
 * too late.
 *
 * Gated on `phone.change`, the same capability as the request itself — this
 * screen must not need `user.create` on top, or the two doors stop being
 * separable.
 */
export async function recoveryCandidates(
  ctx: AuthContext, db: Db,
): Promise<Array<{ id: string; full_name: string; unit_label: string | null }>> {
  require_(ctx.role, 'phone.change');
  const r = await db.prepare(
    `SELECT p.id, p.full_name,
            (SELECT b.name_ar || ' — ' || u.unit_number
               FROM unit_owners uo
               JOIN units u ON u.id = uo.unit_id
               JOIN buildings b ON b.id = u.building_id
              WHERE uo.profile_id = p.id AND uo.valid_to IS NULL
              LIMIT 1) AS unit_label
       FROM profiles p
      WHERE p.is_active = 1
        AND p.id <> ?
        AND EXISTS (SELECT 1 FROM passkeys k
                     WHERE k.profile_id = p.id AND k.revoked_at IS NULL)
      ORDER BY p.full_name
      LIMIT 500`
  ).bind(ctx.personId).all<{ id: string; full_name: string; unit_label: string | null }>();
  return r.results ?? [];
}

/* ===================================================================== */
/* Owner-register import — R-009                                         */
/* ===================================================================== */

export async function stageImport(
  ctx: AuthContext, db: Db, filename: string | null, parsed: ParseResult,
): Promise<string> {
  require_(ctx.role, 'user.import');
  const batchId = newId('IMP');
  await mutate(db, ctx,
    { action: 'import.stage', table: 'import_batches', entityId: batchId,
      after: { rows: parsed.rows.length, ok: parsed.okCount, problems: parsed.problemCount } },
    db.prepare(
      `INSERT INTO import_batches (id, filename, row_count, ok_count, problem_count,
         preview_json, created_by) VALUES (?,?,?,?,?,?,?)`
    ).bind(batchId, filename, parsed.rows.length, parsed.okCount, parsed.problemCount,
           JSON.stringify(parsed.rows), ctx.personId),
  );
  const stmts = parsed.rows.map(row => db.prepare(
    `INSERT INTO import_rows (id, batch_id, row_no, raw_json, status, problem_ar)
     VALUES (?,?,?,?,?,?)`
  ).bind(newId('IRW'), batchId, row.rowNo, JSON.stringify(row.raw), row.status, row.problemAr));
  if (stmts.length) await db.batch(stmts);
  return batchId;
}

export interface ImportOutcome {
  created: number; skipped: number; buildings: number; units: number;
}

/**
 * Create accounts from a staged batch — **only the rows marked `ok`**.
 *
 * Everything else is left for a human. A malformed row is not imported "as best
 * we can", and a duplicate is not merged: `01_PRD.md` A2 says the importer
 * *"imports only after explicit confirmation"*, and R-009 says *"never guess"*.
 *
 * Idempotent by construction: buildings and units are found-or-created by their
 * codes, and a phone number that already belongs to somebody is skipped rather
 * than moved. Re-running a batch cannot duplicate a village.
 */
export async function commitImport(
  ctx: AuthContext, db: Db, batchId: Id, now: Clock,
): Promise<ImportOutcome> {
  require_(ctx.role, 'user.import');
  const batch = await db.prepare(
    `SELECT id, preview_json, confirmed_at FROM import_batches WHERE id = ?`
  ).bind(batchId).first<{ id: string; preview_json: string; confirmed_at: string | null }>();
  if (!batch) throw new NotFound();
  if (batch.confirmed_at) throw new LedgerRefused('الملف ده اتأكّد ورُفع قبل كده');

  const rows = JSON.parse(batch.preview_json) as {
    rowNo: number; fullName: string; buildingCode: string; unitNumber: string;
    phoneE164: string; status: string;
  }[];

  const out: ImportOutcome = { created: 0, skipped: 0, buildings: 0, units: 0 };

  for (const row of rows) {
    if (row.status !== 'ok') { out.skipped++; continue; }

    // a number already in use is NEVER reassigned by an import
    const taken = await db.prepare(
      `SELECT profile_id FROM phone_identifiers WHERE phone_e164 = ? AND status = 'active'`
    ).bind(row.phoneE164).first();
    if (taken) { out.skipped++; continue; }

    let building = await db.prepare(`SELECT id FROM buildings WHERE code = ?`)
      .bind(row.buildingCode).first<{ id: string }>();
    if (!building) {
      const bid = newId('BLD');
      await db.prepare(`INSERT INTO buildings (id, code, name_ar, sort_order) VALUES (?,?,?,?)`)
        .bind(bid, row.buildingCode, `عمارة ${row.buildingCode}`, Number(row.buildingCode) || 0).run();
      building = { id: bid }; out.buildings++;
    }

    let unit = await db.prepare(`SELECT id FROM units WHERE building_id = ? AND unit_number = ?`)
      .bind(building.id, row.unitNumber).first<{ id: string }>();
    if (!unit) {
      const uid = newId('UNT');
      await db.prepare(`INSERT INTO units (id, building_id, unit_number) VALUES (?,?,?)`)
        .bind(uid, building.id, row.unitNumber).run();
      unit = { id: uid }; out.units++;
    }

    const pid = newId('PRF');
    await db.batch([
      db.prepare(`INSERT INTO profiles (id, full_name, role, created_by) VALUES (?,?, 'resident', ?)`)
        .bind(pid, row.fullName, ctx.personId),
      db.prepare(`INSERT INTO phone_identifiers (id, profile_id, phone_e164, changed_by,
                    change_reason_ar) VALUES (?,?,?,?, NULL)`)
        .bind(newId('PHN'), pid, row.phoneE164, ctx.personId),
      // effective-dated from today: the register says who owns it NOW, and we do
      // not know when they bought it. Inventing a date would be inventing data.
      db.prepare(`INSERT INTO unit_owners (id, unit_id, profile_id, valid_from) VALUES (?,?,?,?)`)
        .bind(newId('UOW'), unit.id, pid, now().slice(0, 10)),
      db.prepare(`UPDATE import_rows SET status='created', profile_id=?, unit_id=?
                   WHERE batch_id=? AND row_no=?`)
        .bind(pid, unit.id, batchId, row.rowNo),
    ]);
    out.created++;
  }

  await mutate(db, ctx,
    { action: 'import.commit', table: 'import_batches', entityId: batchId, after: out },
    db.prepare(`UPDATE import_batches SET confirmed_at = ?, confirmed_by = ? WHERE id = ?`)
      .bind(now(), ctx.personId, batchId),
  );
  return out;
}

export async function getImportPreview(ctx: AuthContext, db: Db, batchId: Id) {
  require_(ctx.role, 'user.import');
  const b = await db.prepare(
    `SELECT id, filename, row_count, ok_count, problem_count, preview_json, confirmed_at
       FROM import_batches WHERE id = ?`
  ).bind(batchId).first<{
    id: string; filename: string | null; row_count: number; ok_count: number;
    problem_count: number; preview_json: string; confirmed_at: string | null;
  }>();
  if (!b) throw new NotFound();
  return { ...b, rows: JSON.parse(b.preview_json) as unknown[] };
}

/* ===================================================================== */
/* Members & first activation — the screen the board actually needs      */
/* ===================================================================== */

export interface MemberRow {
  id: Id;
  full_name: string;
  role: string;
  is_active: number;
  unit_label: string | null;
  passkeys: number;
  last_login_at: string | null;
  /** A live, unconsumed activation link is already outstanding for this person. */
  link_pending: number;
}

/**
 * Everyone the board can activate, with the ONE fact that decides what to do
 * next: has this person got a passkey yet?
 *
 * ## Why this exists
 *
 * Until now the only way to issue an activation link was the RECOVERY path —
 * two admins, a written identity check, and a JSON API with no screen. That is
 * the right amount of friction for "someone lost their phone and wants back
 * into an account that already has money in it". It is entirely the wrong
 * amount for "we are onboarding 204 people who have never logged in", and
 * because it was the only path, onboarding a village was in practice
 * impossible from the product itself.
 *
 * First activation and recovery are different acts and now have different
 * doors. A first activation reaches an account with no passkey, no session
 * history and nothing to steal; recovery reaches one that may hold a year of
 * payments. `issueFirstActivation` refuses the second case outright — the
 * moment somebody has a passkey, they go through recovery, with its second
 * admin and its identity check.
 *
 * Phone numbers are deliberately NOT selected: `phone.read_any` is a separate
 * capability an operator does not hold, and this list has no reason to carry
 * them. The link goes out through whatever channel the admin already uses.
 */
export async function listMembers(
  ctx: AuthContext, db: Db, query?: string,
): Promise<MemberRow[]> {
  require_(ctx.role, 'user.create');

  // Two hundred rows on a phone is not a list, it is a haystack. The filter is
  // a plain LIKE rather than the FTS5 index that `lib/search/fold.ts` drives:
  // that index covers published content, and profiles are deliberately not in
  // it — a resident's name is not village news.
  //
  // Both sides are folded, so «احمد» finds «أحمد». That is not a nicety: the
  // register was typed by several people over several years, and which alif
  // somebody used is not a fact the searcher knows.
  //
  // `%` and `_` are escaped because the fold deliberately does NOT strip them
  // — an unescaped `%` would turn any query into "list the whole village".
  const q = (query ?? '').trim();
  const like = q
    ? `%${foldArabicLetters(q).replace(/[%_\\]/g, m => '\\' + m)}%`
    : null;

  const r = await db.prepare(
    `SELECT p.id, p.full_name, p.role, p.is_active, p.last_login_at,
            (SELECT b.name_ar || ' — ' || u.unit_number
               FROM unit_owners uo
               JOIN units u ON u.id = uo.unit_id
               JOIN buildings b ON b.id = u.building_id
              WHERE uo.profile_id = p.id AND uo.valid_to IS NULL
              LIMIT 1)                                            AS unit_label,
            (SELECT COUNT(*) FROM passkeys k
              WHERE k.profile_id = p.id AND k.revoked_at IS NULL)  AS passkeys,
            (SELECT COUNT(*) FROM activation_challenges ac
              WHERE ac.profile_id = p.id AND ac.consumed_at IS NULL
                AND ac.expires_at > ?)                            AS link_pending
       FROM profiles p
      WHERE p.is_active = 1
        AND (? IS NULL OR ${FOLDED_NAME} LIKE ? ESCAPE '\\')
      ORDER BY (SELECT COUNT(*) FROM passkeys k2
                 WHERE k2.profile_id = p.id AND k2.revoked_at IS NULL) ASC,
               p.role, p.full_name
      LIMIT 400`
  ).bind(new Date().toISOString(), like, like).all<MemberRow>();
  return r.results ?? [];
}

/**
 * `foldArabicLetters` rendered as SQL, generated from the same list so the two
 * cannot drift. SQLite has no collation for this and D1 cannot register one, so
 * a nest of REPLACEs is the whole toolbox.
 *
 * A resident entered in the register as «أحمد» is searched for as «احمد» by
 * half the board and «أحمد» by the other half. Folding one side only is worse
 * than folding neither: it fails silently, and a board member concludes the
 * person is not in the system.
 */
const FOLDED_NAME = LETTER_FOLD_PAIRS.reduce(
  (expr, [from, to]) => `REPLACE(${expr}, '${from}', '${to}')`,
  'p.full_name',
);

/**
 * Issue a FIRST activation link. Returns the raw token exactly once — it is
 * never stored, only its hash is, so a second read is impossible by design.
 *
 * Refuses anyone who already holds a passkey. That is the whole security
 * boundary of this function: without it, an admin could mint a fresh
 * credential onto an existing account and become that resident, and the
 * recovery flow's second signature would be decoration.
 */
export async function issueFirstActivation(
  ctx: AuthContext, db: Db, profileId: Id, sha256: (s: string) => Promise<string>,
  randomToken: () => string, now: Clock,
): Promise<{ token: string; fullName: string; expiresAt: string }> {
  require_(ctx.role, 'user.create');

  const p = await db.prepare(
    `SELECT p.full_name,
            (SELECT COUNT(*) FROM passkeys k
              WHERE k.profile_id = p.id AND k.revoked_at IS NULL) AS passkeys
       FROM profiles p WHERE p.id = ? AND p.is_active = 1`
  ).bind(profileId).first<{ full_name: string; passkeys: number }>();
  if (!p) throw new NotFound('العضو ده مش موجود');

  if (p.passkeys > 0) {
    throw new Forbidden('user.create',
      'الشخص ده عنده بصمة مسجّلة خلاص. لو ضاع منه الموبايل استخدم مسار الاسترجاع — '
      + 'محتاج موافقة أدمن تاني وتأكيد شخصية.');
  }

  const token = randomToken();
  await createActivationChallenge(ctx, db, profileId, await sha256(token),
    'first_activation', now);

  const expiresAt = await db.prepare(
    `SELECT expires_at FROM activation_challenges
      WHERE profile_id = ? AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`
  ).bind(profileId).first<{ expires_at: string }>();

  return {
    token,
    fullName: p.full_name,
    expiresAt: expiresAt?.expires_at ?? '',
  };
}

/**
 * Issue the activation link that FOLLOWS a fulfilled recovery.
 *
 * Deliberately not `issueFirstActivation` with a different name. That function
 * exists to refuse anyone holding a passkey, which is the boundary keeping an
 * admin from minting a credential onto a live account; reusing it here would
 * work only because `fulfilRecovery` has just revoked every passkey, and the
 * next person to relax that guard would silently reopen the hole.
 *
 * This one demands the opposite proof: a recovery request for this person that
 * two admins signed and that has been fulfilled. Without it, nothing. The
 * challenge is recorded with `purpose='recovery'`, so the audit trail says
 * which door the credential came through — «إزاي ده اتفعّل» has one answer per
 * account, and both answers are on the record.
 */
export async function issueRecoveryActivation(
  ctx: AuthContext, db: Db, profileId: Id, sha256: (s: string) => Promise<string>,
  randomToken: () => string, now: Clock,
): Promise<{ token: string; fullName: string; expiresAt: string }> {
  require_(ctx.role, 'phone.change');

  const p = await db.prepare(
    `SELECT p.full_name,
            (SELECT COUNT(*) FROM passkeys k
              WHERE k.profile_id = p.id AND k.revoked_at IS NULL)   AS passkeys,
            (SELECT COUNT(*) FROM recovery_requests rr
              WHERE rr.target_profile_id = p.id
                AND rr.fulfilled_at IS NOT NULL
                AND rr.approved_by IS NOT NULL)                     AS fulfilled
       FROM profiles p WHERE p.id = ? AND p.is_active = 1`
  ).bind(profileId).first<{ full_name: string; passkeys: number; fulfilled: number }>();
  if (!p) throw new NotFound('العضو ده مش موجود');

  if (p.fulfilled === 0) {
    throw new Forbidden('phone.change',
      'مفيش طلب استرجاع متنفّذ للشخص ده. افتح طلب، وخلي أدمن تاني يوافق، وبعدين نفّذه.');
  }
  if (p.passkeys > 0) {
    // fulfilRecovery revokes every passkey in the same batch as the fulfilment,
    // so a live one here means a device was enrolled AFTER it — the link was
    // already used, and issuing a second one would hand out a second way in.
    throw new Forbidden('phone.change',
      'الشخص ده سجّل جهاز خلاص بعد الاسترجاع. لو ضاع تاني، افتح طلب استرجاع جديد.');
  }

  const token = randomToken();
  await createActivationChallenge(ctx, db, profileId, await sha256(token), 'recovery', now);

  const expiresAt = await db.prepare(
    `SELECT expires_at FROM activation_challenges
      WHERE profile_id = ? AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`
  ).bind(profileId).first<{ expires_at: string }>();

  return { token, fullName: p.full_name, expiresAt: expiresAt?.expires_at ?? '' };
}
