/**
 * tests/access/onboarding.test.ts — assisted recovery and the owner import.
 *
 * Both are the CP-2 gates that remain, and both are fraud surfaces rather than
 * features. The import gate is stated exactly: *"Bulk import of 50 rows with 3
 * deliberately malformed rows behaves correctly."*
 */

import { it, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NodeSqliteDb } from '../../lib/db/driver.js';
import { setTokenHasher, resolveAuthContext } from '../../lib/db/index.js';
import * as onboard from '../../lib/db/onboarding.js';
import { parseOwners } from '../../lib/import/owners.js';
import { createApp } from '../../src/app.js';
import { D1BlobStorage } from '../../lib/storage/d1blob.js';
import type { AuthContext } from '../../types/domain.js';

const ROOT = process.cwd();
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
setTokenHasher(sha);
const id = (p: string, n: number) => (p + String(n).padStart(26 - p.length, '0')).slice(0, 26);

const A1 = id('PRF', 1), A2 = id('PRF', 2), OP = id('PRF', 3), RES = id('PRF', 4);
const RP = { id: 'localhost', name: 'قرية الأطباء', origin: 'http://localhost' };
const NOW = () => '2026-08-04T10:00:00Z';

let raw: DatabaseSync, db: NodeSqliteDb, app: ReturnType<typeof createApp>;
let admin1: AuthContext, admin2: AuthContext, operator: AuthContext;

before(async () => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).sort())
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  for (const f of readdirSync(join(ROOT, 'seed/prod')).sort())
    raw.exec(readFileSync(join(ROOT, 'seed/prod', f), 'utf8'));
  const x = (s: string, ...p: unknown[]) => raw.prepare(s).run(...p as never[]);
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, A1, 'رئيس المجلس', 'admin');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, A2, 'أمين الصندوق', 'admin');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, OP, 'مشغّل', 'operator');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, RES, 'د. سعاد', 'resident');
  x(`INSERT INTO phone_identifiers (id,profile_id,phone_e164) VALUES (?,?,?)`, id('PHN',1), RES, '+201055556666');
  x(`INSERT INTO passkeys (id,profile_id,credential_id,public_key,sign_count,rp_id,device_label_ar)
     VALUES (?,?,?,?,?,?,?)`, id('PSK',1), RES, 'cred-old', new Uint8Array([1]), 3, RP.id, 'الموبايل القديم');
  x(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`,
    id('SES',1), RES, sha('tok-res'), '2027-01-01T00:00:00Z');
  for (const [n, p, tok] of [[2, A1, 'tok-a1'], [3, A2, 'tok-a2'], [4, OP, 'tok-op']] as const)
    x(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`,
      id('SES', n), p, sha(tok), '2027-01-01T00:00:00Z');

  db = new NodeSqliteDb(raw as never);
  const storage = new D1BlobStorage(db);
  app = createApp({ db, now: NOW, storage, rp: RP,
    storagePut: i => storage.put(i), storageUsedBytes: () => storage.usedBytes() });
  admin1 = (await resolveAuthContext(db, 'tok-a1', NOW))!;
  admin2 = (await resolveAuthContext(db, 'tok-a2', NOW))!;
  operator = (await resolveAuthContext(db, 'tok-op', NOW))!;
});

/* ================================================================== */
describe('assisted recovery needs TWO admins — R-003', () => {
  let reqId = '';

  it('an operator cannot open a recovery request at all', async () => {
    await assert.rejects(() => onboard.requestRecovery(
      operator, db, RES as never, 'أعرفه شخصيًا وشوفت بطاقته'));
  });

  it('a request needs a written identity check, not a shrug', async () => {
    await assert.rejects(
      () => onboard.requestRecovery(admin1, db, RES as never, 'تمام'),
      /اتأكدت/, '"تمام" was accepted as an identity check');
  });

  it('an admin cannot open a recovery for their OWN account', async () => {
    await assert.rejects(() => onboard.requestRecovery(
      admin1, db, A1 as never, 'أنا هو، صدقني والله'));
  });

  it('opening a request grants nothing on its own', async () => {
    reqId = await onboard.requestRecovery(
      admin1, db, RES as never, 'جه المكتب ومعاه بطاقته وعقد الشقة، واتأكدت بنفسي');
    const live = raw.prepare(
      `SELECT COUNT(*) n FROM passkeys WHERE profile_id=? AND revoked_at IS NULL`)
      .get(RES) as { n: number };
    assert.equal(live.n, 1, 'the request alone changed the account');
  });

  it('⭐ the SAME admin cannot approve their own request', async () => {
    await assert.rejects(
      () => onboard.approveRecovery(admin1, db, reqId as never, NOW),
      /محدش|forbidden/, 'ONE admin completed a recovery');
  });

  it('...and the database refuses it even with the guards removed', () => {
    // The control lives in a CHECK, not only in application code, so a bug in a
    // route cannot hand somebody an account.
    assert.throws(() => raw.prepare(
      `UPDATE recovery_requests SET approved_by=?, approved_at=? WHERE id=?`)
      .run(A1, '2026-08-04T11:00:00Z', reqId));
  });

  it('fulfilling before approval is refused', async () => {
    await assert.rejects(() => onboard.fulfilRecovery(admin1, db, reqId as never, NOW),
      /أدمن تاني/);
  });

  it('a DIFFERENT admin can approve, and then it can be fulfilled', async () => {
    await onboard.approveRecovery(admin2, db, reqId as never, NOW);
    const out = await onboard.fulfilRecovery(admin1, db, reqId as never, NOW);
    assert.equal(out.targetProfileId, RES);

    // the lost device loses everything — otherwise nothing was recovered
    const pk = raw.prepare(
      `SELECT COUNT(*) n FROM passkeys WHERE profile_id=? AND revoked_at IS NULL`).get(RES) as { n: number };
    const se = raw.prepare(
      `SELECT COUNT(*) n FROM sessions WHERE profile_id=? AND revoked_at IS NULL`).get(RES) as { n: number };
    assert.equal(pk.n, 0, 'the old passkey survived a recovery');
    assert.equal(se.n, 0, 'the old session survived a recovery');
  });

  it('a fulfilled request cannot be replayed', async () => {
    await assert.rejects(() => onboard.fulfilRecovery(admin1, db, reqId as never, NOW));
    assert.throws(() => raw.prepare(
      `UPDATE recovery_requests SET fulfilled_at=NULL WHERE id=?`).run(reqId));
  });

  it('every step is on the record with a name against it', () => {
    const actions = (raw.prepare(
      `SELECT action FROM audit_log WHERE entity_id=? ORDER BY rowid`).all(reqId) as { action: string }[])
      .map(a => a.action);
    assert.deepEqual(actions, ['recovery.request', 'recovery.approve', 'recovery.fulfil']);
  });
});

/* ================================================================== */
describe('owner-register import — the CP-2 gate, R-009', () => {

  /** 50 rows, 3 deliberately malformed — the gate, stated verbatim. */
  function buildSheet(): string {
    const lines = ['الاسم,رقم العمارة,رقم الشقة,رقم الموبايل'];
    for (let i = 1; i <= 47; i++) {
      lines.push(`د. مالك رقم ${i},${14 + (i % 34)},${(i % 6) + 1},010${String(10000000 + i).slice(0, 8)}`);
    }
    lines.push('د. بدون رقم,20,3,');                    // malformed: no phone
    lines.push(',21,4,01099887766');                     // malformed: no name
    lines.push('د. رقم غلط,22,5,0451234567');            // malformed: a landline
    return lines.join('\n');
  }

  let batchId = '';

  it('parses 50 rows and flags exactly the 3 bad ones', () => {
    const p = parseOwners(buildSheet());
    assert.equal(p.rows.length, 50);
    assert.equal(p.problemCount, 3, `flagged ${p.problemCount}, expected 3`);
    assert.equal(p.okCount, 47);
    const problems = p.rows.filter(r => r.status !== 'ok').map(r => r.problemAr!);
    assert.ok(problems.some(x => x.includes('الموبايل ناقص')));
    assert.ok(problems.some(x => x.includes('الاسم ناقص')));
    assert.ok(problems.some(x => x.includes('مش صحيح')), 'a landline was accepted as a mobile');
  });

  it('reads Arabic-Indic digits and messy headers', () => {
    const p = parseOwners(
      'اسم المالك\tالعمارة\tشقة\tموبايل\n' +
      'د. سعاد\t١٤\t٣\t٠١٠١٢٣٤٥٦٧٨');
    assert.equal(p.okCount, 1, JSON.stringify(p.rows[0]));
    assert.equal(p.rows[0]!.buildingCode, '14');
    assert.equal(p.rows[0]!.unitNumber, '3');
    assert.equal(p.rows[0]!.phoneE164, '+201012345678');
  });

  it('flags a duplicate phone instead of merging or dropping it', () => {
    const p = parseOwners(
      'الاسم,رقم العمارة,رقم الشقة,رقم الموبايل\n' +
      'د. أحمد,14,1,01011112222\n' +
      'د. محمود,15,2,01011112222');
    const dup = p.rows.find(r => r.status === 'duplicate');
    assert.ok(dup, 'a duplicate number was silently accepted');
    assert.match(dup!.problemAr!, /صف 1/, 'the admin must be told WHICH row it clashes with');
  });

  it('flags a shared flat as needing confirmation, not as an error', () => {
    // unit_owners is many-to-many by design; co-ownership is normal here.
    const p = parseOwners(
      'الاسم,رقم العمارة,رقم الشقة,رقم الموبايل\n' +
      'د. أحمد,14,1,01011113333\n' +
      'زوجته,14,1,01011114444');
    const dup = p.rows.find(r => r.status === 'duplicate');
    assert.match(dup!.problemAr!, /ملّاك مشتركين/);
  });

  it('reports headers it did not understand rather than half-importing', () => {
    const p = parseOwners('الاسم,حاجة غريبة,رقم الشقة,رقم الموبايل\nد. أحمد,x,1,01011115555');
    assert.ok(p.unmappedHeaders.includes('حاجة غريبة'));
    assert.equal(p.okCount, 0, 'a row with an unmapped building column was imported anyway');
  });

  it('preview creates NOTHING', async () => {
    const before = (raw.prepare(`SELECT COUNT(*) n FROM profiles`).get() as { n: number }).n;
    batchId = await onboard.stageImport(admin1, db, 'owners.csv', parseOwners(buildSheet()));
    assert.equal((raw.prepare(`SELECT COUNT(*) n FROM profiles`).get() as { n: number }).n, before,
      'preview created accounts before anybody confirmed');
  });

  it('an operator cannot confirm an import', async () => {
    await assert.rejects(() => onboard.commitImport(operator, db, batchId as never, NOW));
  });

  it('confirming creates the 47 good rows and SKIPS the 3', async () => {
    const out = await onboard.commitImport(admin1, db, batchId as never, NOW);
    assert.equal(out.created, 47);
    assert.equal(out.skipped, 3, 'a malformed row was imported "as best we could"');
    // every created resident has a unit and a number
    const orphan = raw.prepare(
      `SELECT COUNT(*) n FROM profiles p WHERE p.role='resident'
         AND NOT EXISTS (SELECT 1 FROM unit_owners uo WHERE uo.profile_id = p.id)
         AND p.id <> ?`).get(RES) as { n: number };
    assert.equal(orphan.n, 0, 'an imported resident has no unit');
  });

  it('re-confirming the same batch is refused', async () => {
    await assert.rejects(() => onboard.commitImport(admin1, db, batchId as never, NOW),
      /قبل كده/, 'a double-click created the village twice');
  });

  it('an import never reassigns a number that already belongs to somebody', async () => {
    const b = await onboard.stageImport(admin1, db, 'again.csv', parseOwners(
      'الاسم,رقم العمارة,رقم الشقة,رقم الموبايل\nحرامي,14,1,01055556666'));
    const out = await onboard.commitImport(admin1, db, b as never, NOW);
    assert.equal(out.created, 0, "an import took over an existing resident's phone number");
    assert.equal(out.skipped, 1);
    const owner = raw.prepare(
      `SELECT profile_id FROM phone_identifiers WHERE phone_e164='+201055556666' AND status='active'`)
      .get() as { profile_id: string };
    assert.equal(owner.profile_id, RES, 'the original owner lost their number');
  });

  it('the whole import is on the record', () => {
    const actions = (raw.prepare(
      `SELECT action FROM audit_log WHERE entity_id=? ORDER BY rowid`).all(batchId) as { action: string }[])
      .map(a => a.action);
    assert.deepEqual(actions, ['import.stage', 'import.commit']);
  });
});
