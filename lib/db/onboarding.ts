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

export async function listOpenRecoveries(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'phone.change');
  const r = await db.prepare(
    `SELECT rr.id, rr.identity_check_ar, rr.requested_by, rr.requested_at, rr.approved_by,
            p.full_name AS target_name
       FROM recovery_requests rr JOIN profiles p ON p.id = rr.target_profile_id
      WHERE rr.fulfilled_at IS NULL AND rr.cancelled_at IS NULL
      ORDER BY rr.requested_at`
  ).all();
  return r.results;
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
