/**
 * tests/access/onboarding_ui.test.ts — the two procedures a village needs on
 * its first day and its worst day, driven as HTTP forms.
 *
 * `lib/db/onboarding.ts` has been tested for a long time. What was never
 * tested — because it did not exist — is whether a board member can REACH any
 * of it: the importer and the recovery flow were JSON endpoints, so the actual
 * question ("can the secretary put 204 owners in, from a phone, without a
 * developer?") had no answer.
 *
 * So these tests post real forms and then look at the DATABASE, not at status
 * codes. A 200 from a confirm button that created nothing is exactly the
 * failure that would otherwise ship.
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

// Two admins, because half of what is under test is that ONE admin is not
// enough. A fixture with a single admin would pass a recovery flow that the
// database is supposed to refuse.
raw.prepare(`INSERT INTO profiles (id, full_name, role) VALUES (?,?, 'admin')`)
   .run(pid('PRF', 1), 'أدمن أول');
raw.prepare(`INSERT INTO profiles (id, full_name, role) VALUES (?,?, 'admin')`)
   .run(pid('PRF', 2), 'أدمن تاني');
// …and a resident who already holds a device: the only kind of person recovery
// applies to.
raw.prepare(`INSERT INTO profiles (id, full_name, role) VALUES (?,?, 'resident')`)
   .run(pid('PRF', 3), 'د. ساكن ضايع منه الموبايل');
raw.prepare(
  `INSERT INTO passkeys (id, profile_id, credential_id, public_key, rp_id, device_label_ar)
   VALUES (?,?,?,?,?,?)`
).run(pid('PSK', 1), pid('PRF', 3), 'cred-lost-phone', new Uint8Array([1, 2, 3]), 'x.test', 'موبايل قديم');
raw.prepare(`INSERT INTO sessions (id, profile_id, token_hash, expires_at) VALUES (?,?,?,?)`)
   .run(pid('SES', 9), pid('PRF', 3), sha('tok-lost'), '2027-01-01T00:00:00Z');

for (const [n, who, tok] of [[1, pid('PRF', 1), 'tok-a1'], [2, pid('PRF', 2), 'tok-a2']] as const) {
  raw.prepare(`INSERT INTO sessions (id, profile_id, token_hash, expires_at) VALUES (?,?,?,?)`)
     .run(pid('SES', n), who, sha(tok), '2027-01-01T00:00:00Z');
}

const db = new NodeSqliteDb(raw as never);
const NOW = () => '2026-08-04T10:00:00Z';
const storage = new D1BlobStorage(db);
const app = createApp({
  db, now: NOW, storage, demo: false, payCategories: [],
  rp: { id: 'x.test', name: 'x', origin: 'https://x.test' },
  storagePut: i => storage.put(i), storageUsedBytes: () => storage.usedBytes(),
});

const req = (path: string, tok: string, init: RequestInit = {}) =>
  app.request('https://x.test' + path, {
    ...init,
    headers: { cookie: `qa_session=${tok}`, ...(init.headers ?? {}) },
  });

const count = (sql: string, ...args: unknown[]) =>
  (raw.prepare(sql).get(...args as never[]) as { n: number }).n;

/* ===================================================================== */
/* Owner-register import                                                 */
/* ===================================================================== */

const REGISTER = [
  'الاسم,رقم العمارة,رقم الشقة,رقم الموبايل',
  'د. أحمد الشناوي,14,1,01001112233',
  'م. سعاد بدوي,14,2,01001112244',
  'صف ناقص,,,01001112255',              // no name, no unit — must be refused
].join('\n');

test('the import screen is reachable and refuses an empty submission', async () => {
  const get = await req('/admin/import', 'tok-a1');
  assert.equal(get.status, 200);
  const html = await get.text();
  assert.match(html, /استيراد سجل الملّاك/);
  // No JavaScript, like every other screen in this product.
  assert.ok(!html.includes('<script'), 'the import screen must ship no script');

  const body = new FormData();
  body.set('text', '   ');
  const empty = await req('/admin/import', 'tok-a1', { method: 'POST', body });
  assert.equal(empty.status, 400);
});

test('a pasted register previews without creating anything', async () => {
  const before = count(`SELECT COUNT(*) n FROM profiles`);
  const body = new FormData();
  body.set('text', REGISTER);
  const res = await req('/admin/import', 'tok-a1', { method: 'POST', body });
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.match(html, /أحمد الشناوي/);
  assert.match(html, /مراجعة قبل التنفيذ/);
  // The whole promise of the preview step: nothing happened yet.
  assert.equal(count(`SELECT COUNT(*) n FROM profiles`), before,
    'staging an import must not create a single profile');
  assert.equal(count(`SELECT COUNT(*) n FROM import_batches`), 1);
  // …and the row it could not read is reported rather than guessed at.
  assert.equal(count(`SELECT COUNT(*) n FROM import_rows WHERE status <> 'ok'`), 1);
});

test('confirming the batch creates exactly the rows that were shown', async () => {
  const batch = raw.prepare(`SELECT id FROM import_batches LIMIT 1`).get() as { id: string };
  const res = await req(`/admin/import/${batch.id}/confirm`, 'tok-a1', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /خلص الاستيراد/);

  assert.equal(count(`SELECT COUNT(*) n FROM profiles WHERE role='resident'`), 3,
    'two owners imported, on top of the one the fixture created');
  assert.equal(count(`SELECT COUNT(*) n FROM units`), 2);
  assert.equal(count(`SELECT COUNT(*) n FROM buildings`), 1);
  // The owner link is what makes the account worth anything — a profile with no
  // unit cannot be billed, so importing one silently would be worse than
  // failing.
  assert.equal(count(`SELECT COUNT(*) n FROM unit_owners WHERE valid_to IS NULL`), 2);
  assert.equal(count(
    `SELECT COUNT(*) n FROM phone_identifiers WHERE phone_e164 = '+201001112233'`), 1);
});

test('the same batch cannot be committed twice', async () => {
  const batch = raw.prepare(`SELECT id FROM import_batches LIMIT 1`).get() as { id: string };
  const res = await req(`/admin/import/${batch.id}/confirm`, 'tok-a1', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(count(`SELECT COUNT(*) n FROM profiles WHERE role='resident'`), 3,
    'a double submit must not double the village');
});

/* ===================================================================== */
/* Assisted recovery — two signatures, enforced                          */
/* ===================================================================== */

test('a recovery request needs a written identity check', async () => {
  const body = new URLSearchParams({ target: pid('PRF', 3), check: 'تمام' });
  const res = await req('/admin/recoveries', 'tok-a1', {
    method: 'POST', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(res.status, 409);
  assert.equal(count(`SELECT COUNT(*) n FROM recovery_requests`), 0);
});

test('the admin who opened a request cannot approve it', async () => {
  const body = new URLSearchParams({
    target: pid('PRF', 3),
    check: 'جه المكتب ومعاه بطاقة الرقم القومي واتطابقت مع السجل',
  });
  const opened = await req('/admin/recoveries', 'tok-a1', {
    method: 'POST', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(opened.status, 200);
  const r = raw.prepare(`SELECT id FROM recovery_requests`).get() as { id: string };

  const self = await req(`/admin/recoveries/${r.id}/approve`, 'tok-a1', { method: 'POST' });
  assert.ok(self.status === 403 || self.status === 409, `got ${self.status}`);
  assert.equal(count(
    `SELECT COUNT(*) n FROM recovery_requests WHERE approved_by IS NOT NULL`), 0,
    'one admin must never be able to complete a recovery alone');
});

test('fulfilment needs the second signature first', async () => {
  const r = raw.prepare(`SELECT id FROM recovery_requests`).get() as { id: string };
  const early = await req(`/admin/recoveries/${r.id}/fulfil`, 'tok-a2', { method: 'POST' });
  assert.equal(early.status, 403);
  assert.equal(count(`SELECT COUNT(*) n FROM passkeys WHERE revoked_at IS NOT NULL`), 0,
    'a refused fulfilment must not have revoked anything');
});

test('two admins recover the account, and the old phone stops working', async () => {
  const r = raw.prepare(`SELECT id FROM recovery_requests`).get() as { id: string };

  const approved = await req(`/admin/recoveries/${r.id}/approve`, 'tok-a2', { method: 'POST' });
  assert.equal(approved.status, 200);

  const done = await req(`/admin/recoveries/${r.id}/fulfil`, 'tok-a2', { method: 'POST' });
  assert.equal(done.status, 200);
  const html = await done.text();
  // The link is handed over in the same response — a resident locked out
  // between two screens is the moment the procedure fails in practice.
  assert.match(html, /login\/activate\?t=/);

  assert.equal(count(
    `SELECT COUNT(*) n FROM passkeys WHERE profile_id=? AND revoked_at IS NULL`,
    pid('PRF', 3)), 0, 'the lost phone must lose its passkey');
  assert.equal(count(
    `SELECT COUNT(*) n FROM sessions WHERE profile_id=? AND revoked_at IS NULL`,
    pid('PRF', 3)), 0, 'the lost phone must lose its session');
  assert.equal(count(
    `SELECT COUNT(*) n FROM activation_challenges WHERE profile_id=? AND purpose='recovery'`,
    pid('PRF', 3)), 1, 'the new link must be recorded as a RECOVERY, not a first activation');

  // And the stolen phone's cookie is now worthless — the point of all of it.
  const stolen = await req('/', 'tok-lost');
  assert.equal(stolen.status, 302);
});

test('every step of both flows is on the audit trail', async () => {
  const actions = (raw.prepare(
    `SELECT DISTINCT action FROM audit_log ORDER BY action`
  ).all() as { action: string }[]).map(a => a.action);
  for (const a of ['import.stage', 'import.commit',
                   'recovery.request', 'recovery.approve', 'recovery.fulfil',
                   'activation.issue']) {
    assert.ok(actions.includes(a), `${a} missing from the audit log — got ${actions.join(', ')}`);
  }
});
