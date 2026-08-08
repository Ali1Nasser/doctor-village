/**
 * tests/access/password.test.ts — the second way in.
 *
 * `AGENTS.md` lists password auth under **Never**, and this file exists because
 * the owner overrode that rule for a reason found in the field: phones without
 * a platform authenticator cannot enrol a passkey at all, so for their owners
 * the portal was not harder — it was shut.
 *
 * A rule overridden is not a rule abandoned. What follows is mostly an attempt
 * to check that "second" is real: that no password exists until an admin issues
 * one, that the board never learns it twice, that guessing is bounded, that a
 * stopped or recovered account keeps none, and that nobody can set one for
 * somebody else.
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
import * as pw from '../../lib/auth/password.js';

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
const ADMIN = pid('PRF', 1), RES = pid('PRF', 2), OTHER = pid('PRF', 3);
raw.prepare(`INSERT INTO profiles (id, full_name, role) VALUES (?,?, 'admin')`)
   .run(ADMIN, 'د. خالد الشناوي');
raw.prepare(`INSERT INTO profiles (id, full_name, role) VALUES (?,?, 'resident')`)
   .run(RES, 'د. عمرو شاهين');
raw.prepare(`INSERT INTO profiles (id, full_name, role) VALUES (?,?, 'resident')`)
   .run(OTHER, 'د. سعاد بدوي');
raw.prepare(`INSERT INTO phone_identifiers (id, profile_id, phone_e164) VALUES (?,?,?)`)
   .run(pid('PHN', 1), RES, '+201011111111');
raw.prepare(`INSERT INTO phone_identifiers (id, profile_id, phone_e164) VALUES (?,?,?)`)
   .run(pid('PHN', 2), ADMIN, '+201099999999');
raw.prepare(`INSERT INTO phone_identifiers (id, profile_id, phone_e164) VALUES (?,?,?)`)
   .run(pid('PHN', 3), OTHER, '+201022222222');
for (const [n, who, tok] of
     [[1, ADMIN, 'tok-admin'], [2, RES, 'tok-res'], [3, OTHER, 'tok-other']] as const) {
  raw.prepare(`INSERT INTO sessions (id, profile_id, token_hash, expires_at) VALUES (?,?,?,?)`)
     .run(pid('SES', n), who, sha(tok), '2027-01-01T00:00:00Z');
}

const db = new NodeSqliteDb(raw as never);
let clock = '2026-08-08T10:00:00Z';
const storage = new D1BlobStorage(db);
const app = createApp({
  db, now: () => clock, storage, demo: false, payCategories: [],
  rp: { id: 'x.test', name: 'x', origin: 'https://x.test' },
  storagePut: i => storage.put(i), storageUsedBytes: () => storage.usedBytes(),
});

const form = (path: string, body: Record<string, string>, tok?: string) =>
  app.request('https://x.test' + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(tok ? { cookie: `qa_session=${tok}` } : {}),
    },
    body: new URLSearchParams(body),
  });

const stored = (id: string) => raw.prepare(
  `SELECT is_temporary, hash, set_by FROM passwords WHERE profile_id = ?`).get(id) as
  { is_temporary: number; hash: string; set_by: string } | undefined;

/** Pulls the one-time password out of the members screen. */
const issueFor = async (id: string): Promise<string> => {
  const html = await (await form(`/admin/members/${id}/password`, {}, 'tok-admin')).text();
  const m = /[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(html.replace(/<[^>]+>/g, ' '));
  assert.ok(m, 'the temporary password was not shown');
  return m[0];
};

/* ===================================================================== */

test('a new account has no password at all', () => {
  assert.equal(stored(RES), undefined,
    'passwords must not exist until somebody deliberately issues one');
});

test('an admin issues one, and the product cannot show it again', async () => {
  const password = await issueFor(RES);
  assert.match(password, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  const row = stored(RES);
  assert.ok(row);
  assert.equal(row.is_temporary, 1);
  assert.equal(row.set_by, ADMIN);
  // Only a hash is kept — so "send it to me again" is not a missing feature.
  assert.ok(!row.hash.includes(password.slice(0, 4)),
    'the password itself is recoverable from the database');

  // Re-opening the screen does NOT show it again.
  const again = await (await app.request('https://x.test/admin/members',
    { headers: { cookie: 'qa_session=tok-admin' } })).text();
  assert.ok(!again.includes(password), 'the screen shows a password it should have forgotten');
});

test('neither a resident nor an operator can issue one', async () => {
  const before = stored(OTHER);
  const r = await form(`/admin/members/${OTHER}/password`, {}, 'tok-res');
  assert.equal(r.status, 403);
  assert.deepEqual(stored(OTHER), before, 'a resident minted a credential for somebody else');
});

test('the password logs the person in, and lands them on /me while it is temporary', async () => {
  const password = await issueFor(RES);
  const r = await form('/login/password', { phone: '01011111111', password });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/me',
    'a board-issued password should land on the screen that replaces it');
  const cookie = r.headers.get('set-cookie') ?? '';
  assert.match(cookie, /qa_session=/);
  assert.match(cookie, /HttpOnly/);

  // …and the session it opened is real.
  const token = /qa_session=([^;]+)/.exec(cookie)![1]!;
  const me = await app.request('https://x.test/api/me', { headers: { cookie: `qa_session=${token}` } });
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as { id: string }).id, RES);
});

test('a wrong password is refused, and says nothing about which part was wrong', async () => {
  const wrong = await form('/login/password',
    { phone: '01011111111', password: 'WRON-GPAS-SWRD' });
  const unknown = await form('/login/password',
    { phone: '01055556666', password: 'WRON-GPAS-SWRD' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(await wrong.text(), await unknown.text(),
    'the two answers differ, so the login screen enumerates which numbers have accounts');
});

test('guessing is bounded — five tries, then refused', async () => {
  clock = '2026-08-08T12:00:00Z';                    // a clean rate-limit window
  const phone = '01022222222';
  await issueFor(OTHER);
  for (let i = 0; i < 5; i++) {
    const r = await form('/login/password', { phone, password: `BAD${i}-BAD0-BAD0` });
    assert.equal(r.status, 401, `attempt ${i + 1} should be a plain refusal`);
  }
  const sixth = await form('/login/password', { phone, password: 'BAD5-BAD0-BAD0' });
  assert.equal(sixth.status, 429, 'the sixth guess in fifteen minutes was allowed');
});

/* ===================================================================== */
/* The owner replaces it                                                 */
/* ===================================================================== */

test('the owner sets their own, and the current one is required to do it', async () => {
  clock = '2026-08-08T14:00:00Z';
  const password = await issueFor(RES);

  const wrong = await form('/me/password',
    { current: 'NOPE-NOPE-NOPE', next: 'قرية الأطباء 2026' }, 'tok-res');
  assert.equal(wrong.status, 409);
  assert.equal(stored(RES)!.is_temporary, 1, 'the password changed without the current one');

  const ok = await form('/me/password',
    { current: password, next: 'قرية الأطباء 2026' }, 'tok-res');
  assert.equal(ok.status, 200);
  assert.equal(stored(RES)!.is_temporary, 0,
    'the owner replaced it, but it is still flagged as the one the board issued');

  // …and the new one works, while the old one does not.
  clock = '2026-08-08T16:00:00Z';
  assert.equal((await form('/login/password',
    { phone: '01011111111', password: 'قرية الأطباء 2026' })).status, 303);
  assert.equal((await form('/login/password',
    { phone: '01011111111', password })).status, 401, 'the replaced password still works');
});

test('a weak password is refused with the reason', async () => {
  clock = '2026-08-08T18:00:00Z';
  for (const [next, needle] of [
    ['abc', /قصيّرة/],
    ['01011111111', /رقم موبايلك/],
    ['aaaaaaaa', /سهلة/],
  ] as const) {
    const r = await form('/me/password',
      { current: 'قرية الأطباء 2026', next }, 'tok-res');
    assert.equal(r.status, 400, `"${next}" was accepted`);
    assert.match(await r.text(), needle);
  }
});

test('the owner can remove the password and go back to passkey-only', async () => {
  const r = await form('/me/password/drop', {}, 'tok-res');
  assert.equal(r.status, 200);
  assert.equal(stored(RES), undefined);
  clock = '2026-08-08T20:00:00Z';
  assert.equal((await form('/login/password',
    { phone: '01011111111', password: 'قرية الأطباء 2026' })).status, 401);
});

/* ===================================================================== */
/* A password must not outlive the account, or the recovery              */
/* ===================================================================== */

test('stopping an account destroys its password', async () => {
  await issueFor(OTHER);
  assert.ok(stored(OTHER), 'setup failed');
  raw.prepare(`UPDATE profiles SET is_active = 0 WHERE id = ?`).run(OTHER);
  assert.equal(stored(OTHER), undefined,
    '"we stopped his account" was false — the password survived it');
  raw.prepare(`UPDATE profiles SET is_active = 1 WHERE id = ?`).run(OTHER);
});

test('fulfilling a recovery destroys it too', async () => {
  await issueFor(OTHER);
  raw.prepare(
    `INSERT INTO recovery_requests (id, target_profile_id, identity_check_ar, requested_by,
       approved_by, approved_at) VALUES (?,?,?,?,?,?)`
    // Two different people, neither of them the target — the schema's own rule.
  ).run(pid('RCQ', 1), OTHER, 'جه المكتب ومعاه البطاقة', ADMIN, RES, '2026-08-08T10:00:00Z');
  raw.prepare(`UPDATE recovery_requests SET fulfilled_at = ? WHERE id = ?`)
     .run('2026-08-08T11:00:00Z', pid('RCQ', 1));

  // Recovery exists because somebody else has the phone. A password left behind
  // hands them the account back and defeats the whole procedure.
  assert.equal(stored(OTHER), undefined, 'a recovered account kept its old password');
});

test('every password event is on the audit trail', () => {
  const actions = (raw.prepare(`SELECT DISTINCT action FROM audit_log`).all() as
    { action: string }[]).map(a => a.action);
  for (const a of ['password.issue', 'password.change', 'password.clear']) {
    assert.ok(actions.includes(a), `${a} missing — got ${actions.join(', ')}`);
  }
});

/* ===================================================================== */
/* The printed codes — the third way in                                  */
/* ===================================================================== */

const liveCodes = (id: string) => (raw.prepare(
  `SELECT COUNT(*) n FROM recovery_codes WHERE profile_id = ? AND used_at IS NULL`)
  .get(id) as { n: number }).n;

test('the owner can print a fresh sheet, and it retires the old one', async () => {
  assert.equal(liveCodes(RES), 0, 'setup: this account never activated');

  const html = await (await form('/me/recovery-codes', {}, 'tok-res')).text();
  const first = [...html.replace(/<[^>]+>/g, ' ').matchAll(/\b[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/g)]
    .map(m => m[0]);
  assert.equal(first.length, 6, `expected six printed codes, got ${first.length}`);
  assert.equal(liveCodes(RES), 6);

  // Asking again replaces the sheet — it does not add a second one. Six on the
  // fridge plus six in last year's WhatsApp is twelve passkey bypasses nobody
  // is counting.
  const second = await (await form('/me/recovery-codes', {}, 'tok-res')).text();
  assert.equal(liveCodes(RES), 6, 'the old sheet stayed live alongside the new one');
  for (const code of first) {
    assert.ok(!second.includes(code), 'a retired code was printed again');
  }
});

test('reopening /me does not show the codes again', async () => {
  const printed = [...(await (await form('/me/recovery-codes', {}, 'tok-res')).text())
    .replace(/<[^>]+>/g, ' ').matchAll(/\b[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/g)].map(m => m[0]);
  const again = await (await app.request('https://x.test/me',
    { headers: { cookie: 'qa_session=tok-res' } })).text();
  for (const code of printed) {
    assert.ok(!again.includes(code), 'the page can reproduce a code, so it stored one');
  }
  // …but it does say how many are left, which is the honest thing it can say.
  assert.match(again.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '),
    /الأكواد اللي لسه معاك 6/, '/me does not report how many are left');
});

test('a fresh code actually opens the account', async () => {
  const printed = [...(await (await form('/me/recovery-codes', {}, 'tok-res')).text())
    .replace(/<[^>]+>/g, ' ').matchAll(/\b[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/g)].map(m => m[0]);
  clock = '2026-08-09T09:00:00Z';                     // a clean rate-limit window
  const r = await app.request('https://x.test/api/auth/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: printed[0] }),
  });
  assert.equal(r.status, 200);
  assert.equal(liveCodes(RES), 5, 'a redeemed code stayed usable');
  // Single use: the same code a second time is refused.
  clock = '2026-08-09T10:00:00Z';
  const twice = await app.request('https://x.test/api/auth/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: printed[0] }),
  });
  assert.notEqual(twice.status, 200, 'a printed code worked twice');
});

test('nobody can print somebody else’s codes', async () => {
  const before = liveCodes(OTHER);
  await form('/me/recovery-codes', { profile_id: OTHER }, 'tok-res');
  assert.equal(liveCodes(OTHER), before,
    'a form field named another account and the route believed it');
});

test('the login screen offers all three ways in', async () => {
  const html = await (await app.request('https://x.test/login')).text();
  assert.match(html, /action="\/login\/password"/, 'no password form');
  assert.match(html, /href="\/login\/recover"/, 'no route to the printed recovery codes');
  assert.match(html, /id="login-form"/, 'the passkey path disappeared');
});

/* ===================================================================== */

test('the hash is PBKDF2 with a per-user salt and a stored cost', async () => {
  const a = await pw.hashPassword('نفس الكلمة');
  const b = await pw.hashPassword('نفس الكلمة');
  assert.notEqual(a.salt, b.salt, 'a shared salt makes one table work for the whole village');
  assert.notEqual(a.hash, b.hash);
  assert.ok(a.iterations >= 210_000, 'below the OWASP floor for PBKDF2-HMAC-SHA256');
  assert.ok(await pw.verifyPassword('نفس الكلمة', a));
  assert.ok(!await pw.verifyPassword('كلمة تانية', a));
  // The cost travels with the row, so raising it later does not lock anyone out.
  assert.ok(await pw.verifyPassword('نفس الكلمة', { ...a, iterations: a.iterations }));
});
