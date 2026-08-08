/**
 * tests/access/accounts.test.ts — who may create an account, who may edit one,
 * and the wall between the two.
 *
 * The board asked for a specific rule: the developer and the board create and
 * edit accounts, and every account holder edits some of their own details —
 * **but not the ones the account was created from**. `lib/db/mutations.ts`
 * enforces that in two ways, and both are worth testing over HTTP rather than
 * only at the data layer, because a route is where the two halves get confused:
 *
 *   1. `updateOwnProfile` takes NO target id, so it cannot name another person.
 *   2. Its SQL touches three columns, so it cannot reach a name, a role, an
 *      active flag, or the login number in `phone_identifiers`.
 *
 * Most of what follows is therefore an attempt to break rule 2 through the form
 * — because a form is exactly where somebody would try.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NodeSqliteDb } from '../../lib/db/driver.js';
import { setTokenHasher } from '../../lib/db/index.js';
import { createApp } from '../../src/app.js';
import { D1BlobStorage } from '../../lib/storage/d1blob.js';

const ROOT = process.cwd();
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
setTokenHasher(sha);

const raw = new DatabaseSync(':memory:');
raw.exec('PRAGMA foreign_keys = ON');
for (const f of readdirSync(join(ROOT, 'migrations')).sort()) {
  raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
}
for (const f of readdirSync(join(ROOT, 'seed/prod')).sort()) {
  raw.exec(readFileSync(join(ROOT, 'seed/prod', f), 'utf8'));
}

const pid = (p: string, n: number) => (p + String(n).padStart(23, '0')).slice(0, 26);
const ADMIN = pid('PRF', 1), RES = pid('PRF', 2), OP = pid('PRF', 3);
const BLD = pid('BLD', 1), U1 = pid('UNT', 1), U2 = pid('UNT', 2);

raw.prepare(`INSERT INTO profiles (id, full_name, role) VALUES (?,?, 'admin')`)
   .run(ADMIN, 'د. خالد الشناوي');
raw.prepare(`INSERT INTO profiles (id, full_name, role) VALUES (?,?, 'resident')`)
   .run(RES, 'د. عمرو شاهين');
raw.prepare(`INSERT INTO profiles (id, full_name, role) VALUES (?,?, 'operator')`)
   .run(OP, 'عم سمير');
raw.prepare(`INSERT INTO phone_identifiers (id, profile_id, phone_e164) VALUES (?,?,?)`)
   .run(pid('PHN', 1), RES, '+201011111111');
raw.prepare(`INSERT INTO phone_identifiers (id, profile_id, phone_e164) VALUES (?,?,?)`)
   .run(pid('PHN', 2), ADMIN, '+201099999999');
raw.prepare(`INSERT INTO buildings (id, code, name_ar, sort_order) VALUES (?,?,?,?)`)
   .run(BLD, '14', 'عمارة 14', 14);
raw.prepare(`INSERT INTO units (id, building_id, unit_number) VALUES (?,?,?)`).run(U1, BLD, '1');
raw.prepare(`INSERT INTO units (id, building_id, unit_number) VALUES (?,?,?)`).run(U2, BLD, '2');
raw.prepare(`INSERT INTO unit_owners (id, unit_id, profile_id, valid_from) VALUES (?,?,?,?)`)
   .run(pid('UOW', 1), U1, RES, '2020-01-01');

for (const [n, who, tok] of
     [[1, ADMIN, 'tok-admin'], [2, RES, 'tok-res'], [3, OP, 'tok-op']] as const) {
  raw.prepare(`INSERT INTO sessions (id, profile_id, token_hash, expires_at) VALUES (?,?,?,?)`)
     .run(pid('SES', n), who, sha(tok), '2027-01-01T00:00:00Z');
}

const db = new NodeSqliteDb(raw as never);
const storage = new D1BlobStorage(db);
const app = createApp({
  db, now: () => '2026-08-08T10:00:00Z', storage, demo: false, payCategories: [],
  rp: { id: 'x.test', name: 'x', origin: 'https://x.test' },
  storagePut: i => storage.put(i), storageUsedBytes: () => storage.usedBytes(),
});

const form = (path: string, tok: string, body: Record<string, string>) =>
  app.request('https://x.test' + path, {
    method: 'POST',
    headers: { cookie: `qa_session=${tok}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
const get = (path: string, tok: string) =>
  app.request('https://x.test' + path, { headers: { cookie: `qa_session=${tok}` } });

const profile = (id: string) => raw.prepare(
  `SELECT full_name, role, is_active, contact_phone_e164, preferred_channel, contact_note_ar
     FROM profiles WHERE id = ?`).get(id) as Record<string, unknown>;
const loginPhone = (id: string) => (raw.prepare(
  `SELECT phone_e164 p FROM phone_identifiers WHERE profile_id=? AND status='active'`)
  .get(id) as { p: string } | undefined)?.p;

/* ===================================================================== */
/* The board creates accounts                                            */
/* ===================================================================== */

test('an admin creates an account from the screen', async () => {
  const res = await form('/admin/users', 'tok-admin', {
    name: 'د. سعاد بدوي', phone: '01033333333', role: 'resident', unit: U2,
  });
  assert.equal(res.status, 200);

  const row = raw.prepare(`SELECT id, role FROM profiles WHERE full_name = ?`)
    .get('د. سعاد بدوي') as { id: string; role: string } | undefined;
  assert.ok(row, 'the account was not created');
  assert.equal(row.role, 'resident');
  assert.equal(loginPhone(row.id), '+201033333333', 'the login number was not registered');
  assert.equal((raw.prepare(
    `SELECT COUNT(*) n FROM unit_owners WHERE profile_id=? AND valid_to IS NULL`)
    .get(row.id) as { n: number }).n, 1, 'the flat was not attached');

  // …and it cannot be logged into. Creating an account is not creating a way in.
  assert.equal((raw.prepare(
    `SELECT COUNT(*) n FROM activation_challenges WHERE profile_id=?`)
    .get(row.id) as { n: number }).n, 0);
});

test('a malformed phone is refused with an Arabic reason, not a stack trace', async () => {
  const res = await form('/admin/users', 'tok-admin', {
    name: 'حد', phone: '12345', role: 'resident', unit: '',
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /موبايل مصري|11 رقم/);
});

test('neither an operator nor a resident can create an account', async () => {
  for (const tok of ['tok-op', 'tok-res']) {
    const res = await form('/admin/users', tok, {
      name: 'حساب مهرّب', phone: '01044444444', role: 'admin', unit: '',
    });
    assert.equal(res.status, 403, `${tok} created an account`);
  }
  assert.equal(raw.prepare(`SELECT COUNT(*) n FROM profiles WHERE full_name = ?`)
    .get('حساب مهرّب') as never as { n: number } && (raw.prepare(
    `SELECT COUNT(*) n FROM profiles WHERE full_name = ?`).get('حساب مهرّب') as { n: number }).n, 0);
});

test('the board renames and re-houses an account, keeping the old ownership row', async () => {
  const r1 = await form(`/admin/users/${RES}/rename`, 'tok-admin', { name: 'د. عمرو شاهين الغنيمي' });
  assert.equal(r1.status, 200);
  assert.equal(profile(RES)['full_name'], 'د. عمرو شاهين الغنيمي');

  // Building + flat, not a unit id: the picker used to be a <select> of every
  // flat repeated per row (42,842 options, 3.3 MB), and this is also how the
  // board says it — «عمارة 14 شقة 2».
  const r2 = await form(`/admin/users/${RES}/unit`, 'tok-admin', { building: '14', flat: '2' });
  assert.equal(r2.status, 200);
  assert.equal((raw.prepare(
    `SELECT unit_id FROM unit_owners WHERE profile_id=? AND valid_to IS NULL`)
    .get(RES) as { unit_id: string }).unit_id, U2, 'the flat was not resolved from its numbers');
  // January's receipt still has to name whoever owned the flat in January.
  const closed = raw.prepare(
    `SELECT valid_to FROM unit_owners WHERE profile_id=? AND unit_id=?`)
    .get(RES, U1) as { valid_to: string | null };
  assert.ok(closed.valid_to, 'the previous ownership row was deleted rather than closed');
});

/* ===================================================================== */
/* The owner edits their own corner — and only their own corner          */
/* ===================================================================== */

test('a resident saves their contact details', async () => {
  const res = await form('/me', 'tok-res', {
    contact_phone: '01055555555', channel: 'sms', note: 'الشقة مؤجرة',
  });
  assert.equal(res.status, 200);
  const p = profile(RES);
  assert.equal(p['contact_phone_e164'], '+201055555555');
  assert.equal(p['preferred_channel'], 'sms');
  assert.equal(p['contact_note_ar'], 'الشقة مؤجرة');
});

test('an empty contact number clears it rather than failing', async () => {
  const res = await form('/me', 'tok-res', { contact_phone: '', channel: 'whatsapp', note: '' });
  assert.equal(res.status, 200);
  const p = profile(RES);
  assert.equal(p['contact_phone_e164'], null, 'there is no way to undo a contact number');
  assert.equal(p['contact_note_ar'], null);
});

/**
 * The wall, attacked from the form.
 *
 * Every one of these fields is a creation fact. `updateOwnProfile`'s SQL names
 * three columns and none of them are these, so the extra inputs are simply not
 * read — the assertion is that they are not read, which is the property that
 * would silently break if somebody "helpfully" widened the UPDATE later.
 */
test('a resident cannot promote themselves, rename themselves, or move flats', async () => {
  const before = profile(RES);
  const beforeUnit = (raw.prepare(
    `SELECT unit_id FROM unit_owners WHERE profile_id=? AND valid_to IS NULL`)
    .get(RES) as { unit_id: string }).unit_id;

  const res = await form('/me', 'tok-res', {
    contact_phone: '01066666666',
    channel: 'whatsapp',
    note: 'محاولة',
    // none of these are fields the route reads — that is the point
    role: 'admin',
    name: 'المبرمج المؤسس',
    full_name: 'المبرمج المؤسس',
    is_active: '0',
    unit: U1,
    phone: '01000000000',
    id: ADMIN,
    profile_id: ADMIN,
  });
  assert.equal(res.status, 200);

  const after = profile(RES);
  assert.equal(after['role'], 'resident', 'a resident promoted themselves');
  assert.equal(after['full_name'], before['full_name'], 'a resident renamed themselves');
  assert.equal(after['is_active'], 1, 'a resident changed their own active flag');
  assert.equal(loginPhone(RES), '+201011111111', 'a resident changed their LOGIN number');
  assert.equal((raw.prepare(
    `SELECT unit_id FROM unit_owners WHERE profile_id=? AND valid_to IS NULL`)
    .get(RES) as { unit_id: string }).unit_id, beforeUnit, 'a resident moved their own flat');

  // …and the one thing they DID ask for went through, so this is a test of the
  // wall rather than of the route being broken.
  assert.equal(after['contact_phone_e164'], '+201066666666');

  // The chairman is untouched, however many ids were posted.
  assert.equal(profile(ADMIN)['role'], 'admin');
  assert.equal(profile(ADMIN)['contact_phone_e164'], null,
    "a resident's self-edit reached the chairman's row");
});

test("a resident cannot claim someone else's login number as their contact", async () => {
  const res = await form('/me', 'tok-res', {
    contact_phone: '01099999999', channel: 'whatsapp', note: '',
  });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /مسجّل لحد تاني/);
});

test('/me states what only the board can change', async () => {
  const html = await (await get('/me', 'tok-res')).text();
  assert.match(html, /الحاجات دي بتتغيّر بالإدارة بس/);
  assert.match(html, /action="\/me"/, 'there is no self-edit form at all');
  // The login number stays masked even on the owner's own screen.
  assert.ok(!html.includes('+201011111111'), 'the full login number was printed');
});

test('a flat that does not exist is named as such, not silently ignored', async () => {
  const res = await form(`/admin/users/${RES}/unit`, 'tok-admin', { building: '99', flat: '7' });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /مفيش وحدة بالرقم ده/);
  // …and they are still attached to the flat they had, not detached by the typo.
  assert.equal((raw.prepare(
    `SELECT COUNT(*) n FROM unit_owners WHERE profile_id=? AND valid_to IS NULL`)
    .get(RES) as { n: number }).n, 1, 'a typo detached somebody from their flat');
});

test('every account change is on the audit trail', () => {
  const actions = (raw.prepare(
    `SELECT DISTINCT action FROM audit_log`).all() as { action: string }[]).map(a => a.action);
  for (const a of ['user.create', 'user.rename', 'user.set_unit', 'profile.update_own']) {
    assert.ok(actions.includes(a), `${a} missing — got ${actions.join(', ')}`);
  }
});
