/**
 * tests/access/auth.test.ts — the login path's security properties.
 *
 * A full WebAuthn ceremony needs a real authenticator, so the signature
 * verification itself is `@simplewebauthn/server`'s responsibility (ADR-020) and
 * is tested upstream. What is OURS, and therefore tested here, is everything
 * around it — and it is where integrations actually go wrong:
 *
 *   · the challenge is ours, stored, and usable exactly once;
 *   · an activation link works once and then never again;
 *   · **login reveals nothing about whether a phone number is registered**;
 *   · rate limits actually refuse;
 *   · a session cookie is HttpOnly, Secure and SameSite;
 *   · the sign counter refuses to go backwards (cloned authenticator).
 */

import { it, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NodeSqliteDb } from '../../lib/db/driver.js';
import { setTokenHasher, resolveAuthContext } from '../../lib/db/index.js';
import * as adb from '../../lib/db/auth.js';
import * as passkey from '../../lib/auth/passkey.js';
import { createApp } from '../../src/app.js';
import { D1BlobStorage } from '../../lib/storage/d1blob.js';
import type { AuthContext } from '../../types/domain.js';

const ROOT = process.cwd();
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
setTokenHasher(sha);
const id = (p: string, n: number) => (p + String(n).padStart(26 - p.length, '0')).slice(0, 26);

const P_ADMIN = id('PRF', 1), P_RES = id('PRF', 2), P_NEW = id('PRF', 3);
const B1 = id('BLD', 1), U1 = id('UNT', 1);
const RP = { id: 'localhost', name: 'قرية الأطباء', origin: 'http://localhost' };
/** A tiny real WebP, shared by the upload and wizard suites. */
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4TBUAAAAvAAAAAAfQ//73v/+BiOh/AAA=', 'base64');
const webpB64 = WEBP.toString('base64url');

let raw: DatabaseSync;
let db: NodeSqliteDb;
let app: ReturnType<typeof createApp>;
let adminCtx: AuthContext;
let clock = '2026-08-04T10:00:00Z';
const NOW = () => clock;

const post = (path: string, body: unknown, token?: string) =>
  app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

/**
 * Read a response ONCE and hand back everything a test needs.
 *
 * A `Response` body is a stream: `assert.equal(r.status, 200, await r.text())`
 * followed by `await r.json()` throws "Body is unusable", which reads like an
 * application failure and is not. I made that mistake twice across two sessions
 * — the second time after writing it down in INSIGHTS.md — so it is now a
 * helper instead of a thing to remember.
 */
async function send(path: string, body: unknown, token?: string) {
  const r = await post(path, body, token);
  const text = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON; `text` still available */ }
  return { status: r.status, headers: r.headers, text, json: json as never };
}

before(async () => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).sort()) {
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  for (const f of readdirSync(join(ROOT, 'seed/prod')).sort()) {
    raw.exec(readFileSync(join(ROOT, 'seed/prod', f), 'utf8'));
  }
  const x = (s: string, ...p: unknown[]) => raw.prepare(s).run(...p as never[]);
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, P_ADMIN, 'رئيس المجلس', 'admin');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, P_RES, 'د. أحمد', 'resident');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, P_NEW, 'ساكن جديد', 'resident');
  x(`INSERT INTO phone_identifiers (id,profile_id,phone_e164) VALUES (?,?,?)`, id('PHN',1), P_RES, '+201011111111');
  x(`INSERT INTO phone_identifiers (id,profile_id,phone_e164) VALUES (?,?,?)`, id('PHN',2), P_NEW, '+201022222222');
  x(`INSERT INTO buildings (id,code,sort_order) VALUES (?,?,?)`, B1, '5', 5);
  x(`INSERT INTO units (id,building_id,unit_number) VALUES (?,?,?)`, U1, B1, '1');
  x(`INSERT INTO unit_owners (id,unit_id,profile_id,valid_from) VALUES (?,?,?,?)`, id('UOW',1), U1, P_RES, '2020-01-01');
  x(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`,
    id('SES',1), P_ADMIN, sha('tok-admin'), '2027-01-01T00:00:00Z');
  // an enrolled credential for the resident, so login has something to offer
  x(`INSERT INTO passkeys (id,profile_id,credential_id,public_key,sign_count,rp_id,device_label_ar)
     VALUES (?,?,?,?,?,?,?)`,
    id('PSK',1), P_RES, 'cred-abc', new Uint8Array([1,2,3]), 5, RP.id, 'موبايل أحمد');

  db = new NodeSqliteDb(raw as never);
  const storage = new D1BlobStorage(db);
  app = createApp({
    db, now: NOW, storage, rp: RP,
    storagePut: i => storage.put(i), storageUsedBytes: () => storage.usedBytes(),
  });
  adminCtx = (await resolveAuthContext(db, 'tok-admin', NOW))!;
});

/* ================================================================== */
describe('login reveals nothing about who lives here', () => {

  it('an unknown number gets the SAME response shape as a registered one', async () => {
    const known = await (await post('/api/auth/login/begin', { phone: '01011111111' })).json() as Record<string, unknown>;
    const unknown = await (await post('/api/auth/login/begin', { phone: '01099998888' })).json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(known).sort(), Object.keys(unknown).sort(),
      'the response shape differs, which leaks whether the number is registered');
    assert.ok(known['options'] && unknown['options'], 'both must get real options');
    assert.ok(known['key'] && unknown['key'], 'both must get a challenge key');
  });

  it('a challenge row is stored even for an unknown number', async () => {
    // Otherwise the write pattern itself — and the timing — becomes the oracle.
    const before = (raw.prepare(`SELECT COUNT(*) n FROM webauthn_challenges`).get() as { n: number }).n;
    await post('/api/auth/login/begin', { phone: '01099997777' });
    const after = (raw.prepare(`SELECT COUNT(*) n FROM webauthn_challenges`).get() as { n: number }).n;
    assert.equal(after, before + 1);
  });

  it('a malformed number is answered, not rejected with a different error', async () => {
    const r = await post('/api/auth/login/begin', { phone: 'not-a-number' });
    assert.equal(r.status, 200, 'a 400 here tells an attacker their input was parsed');
  });

  it('the response never contains a name, a unit, or a phone number', async () => {
    const body = await (await post('/api/auth/login/begin', { phone: '01011111111' })).text();
    for (const leak of ['أحمد', '+2010', P_RES, U1]) {
      assert.ok(!body.includes(leak), `login response leaked: ${leak}`);
    }
  });
});

/* ================================================================== */
describe('challenges and activation links are single-use', () => {

  it('a WebAuthn challenge cannot be taken twice', async () => {
    await adb.putWebAuthnChallenge(db, 'k1', 'chal-1', P_RES, NOW);
    const first = await adb.takeWebAuthnChallenge(db, 'k1', NOW);
    const second = await adb.takeWebAuthnChallenge(db, 'k1', NOW);
    assert.ok(first, 'the first take should succeed');
    assert.equal(second, null, 'a replayed challenge was accepted');
  });

  it('an expired challenge is not accepted', async () => {
    await adb.putWebAuthnChallenge(db, 'k2', 'chal-2', P_RES, NOW);
    clock = '2026-08-04T10:10:00Z';                 // 10 minutes later; TTL is 5
    assert.equal(await adb.takeWebAuthnChallenge(db, 'k2', NOW), null);
    clock = '2026-08-04T10:00:00Z';
  });

  it('an activation link works exactly once', async () => {
    const token = passkey.randomToken();
    await adb.createActivationChallenge(adminCtx, db, P_NEW, await passkey.sha256(token),
      'first_activation', NOW);

    const first = await app.request(`/login/activate?t=${token}`);
    assert.equal(first.status, 200);
    assert.match(await first.text(), /ساكن جديد/, 'the activation page should greet by name');

    const second = await app.request(`/login/activate?t=${token}`);
    assert.equal(second.status, 410, 'a forwarded activation link opened a second session');
  });

  it('issuing a new link invalidates the previous one', async () => {
    const a = passkey.randomToken(), b = passkey.randomToken();
    await adb.createActivationChallenge(adminCtx, db, P_NEW, await passkey.sha256(a), 'recovery', NOW);
    await adb.createActivationChallenge(adminCtx, db, P_NEW, await passkey.sha256(b), 'recovery', NOW);
    assert.equal((await app.request(`/login/activate?t=${a}`)).status, 410,
      'the superseded link still worked');
    assert.equal((await app.request(`/login/activate?t=${b}`)).status, 200);
  });

  it('a garbage token is refused without revealing anything', async () => {
    const r = await app.request('/login/activate?t=nonsense');
    assert.equal(r.status, 410);
    const body = await r.text();
    assert.ok(!body.includes('أحمد') && !body.includes('ساكن جديد'));
  });
});

/* ================================================================== */
describe('sessions and rate limiting', () => {

  it('activation sets an HttpOnly, Secure, SameSite cookie', async () => {
    const token = passkey.randomToken();
    await adb.createActivationChallenge(adminCtx, db, P_NEW, await passkey.sha256(token),
      'new_device', NOW);
    const r = await app.request(`/login/activate?t=${token}`);
    const cookie = r.headers.get('set-cookie') ?? '';
    assert.match(cookie, /qa_session=/);
    assert.match(cookie, /HttpOnly/, 'a script could read the session token');
    assert.match(cookie, /Secure/, 'the token could travel over plain HTTP');
    assert.match(cookie, /SameSite=Lax/, 'a cross-site form post could ride the session');
  });

  it('the cookie actually authenticates a later request', async () => {
    const token = passkey.randomToken();
    await adb.createActivationChallenge(adminCtx, db, P_RES, await passkey.sha256(token),
      'new_device', NOW);
    const r = await app.request(`/login/activate?t=${token}`);
    const raw_ = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
    const me = await app.request('/api/me', { headers: { cookie: raw_ } });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as { id: string }).id, P_RES);
  });

  it('the sixth login attempt on one number in 15 minutes is refused', async () => {
    const phone = '01033334444';
    for (let i = 0; i < 5; i++) {
      assert.equal((await post('/api/auth/login/begin', { phone })).status, 200, `attempt ${i + 1}`);
    }
    const sixth = await post('/api/auth/login/begin', { phone });
    assert.equal(sixth.status, 429, 'brute force was not rate limited');
    assert.match(((await sixth.json()) as { error: string }).error, /[؀-ۿ]/);
  });

  it('a cloned authenticator is detected by the sign counter', async () => {
    // The stored counter is 5. A clone replays a value the real device passed.
    assert.equal(await adb.updateSignCount(db, 'cred-abc', 4, 5, NOW), 'cloned');
    assert.equal(await adb.updateSignCount(db, 'cred-abc', 5, 5, NOW), 'cloned');
    assert.equal(await adb.updateSignCount(db, 'cred-abc', 6, 5, NOW), 'ok');
    // Touch ID and Android legitimately always report 0 — skip, do not lock out.
    assert.equal(await adb.updateSignCount(db, 'cred-abc', 0, 0, NOW), 'ok');
  });

  it('finishing a login with an unknown credential fails closed', async () => {
    await adb.putWebAuthnChallenge(db, 'k9', 'chal-9', null, NOW);
    const r = await post('/api/auth/login/finish', { key: 'k9', response: { id: 'no-such-cred' } });
    assert.equal(r.status, 401);
  });

  it('enrollment requires an already-open session', async () => {
    assert.equal((await post('/api/auth/enroll/begin', {})).status, 401,
      'anybody could enrol a passkey on any account');
  });
});

/* ================================================================== */
describe('receipt upload', () => {

  const webp = WEBP;
  const body = (over: Record<string, unknown> = {}) => ({
    unitId: U1, categoryId: 'CAT0000000000000000000IN01', amountPiastres: 600000,
    method: 'instapay', transferDate: '2026-08-01',
    imageBase64: webp.toString('base64url'), ...over,
  });

  let resToken = '';
  before(async () => {
    const token = passkey.randomToken();
    await adb.createActivationChallenge(adminCtx, db, P_RES, await passkey.sha256(token),
      'new_device', NOW);
    const r = await app.request(`/login/activate?t=${token}`);
    resToken = (r.headers.get('set-cookie') ?? '').split(';')[0]!.replace('qa_session=', '');
  });

  it('a resident can upload a receipt for their own unit', async () => {
    const r = await post('/api/payments/upload', body(), resToken);
    // Read the body ONCE — a Response body is a stream, and consuming it in the
    // assertion message leaves nothing for the parse.
    const text = await r.text();
    assert.equal(r.status, 201, text);
    const out = JSON.parse(text) as { receiptNo: string; id: string };
    assert.match(out.receiptNo, /^R-\d{4}-\d{5}$/, 'the receipt number must be quotable');
    // stored, unit-scoped, and flagged as EXIF-stripped (R-026)
    const obj = raw.prepare(
      `SELECT unit_id, exif_stripped, sha256 FROM storage_objects WHERE owner_id = ?`)
      .get(out.id) as { unit_id: string; exif_stripped: number; sha256: string };
    assert.equal(obj.unit_id, U1);
    assert.equal(obj.exif_stripped, 1);
    assert.ok(obj.sha256, 'no hash stored — duplicate detection cannot work');
    // and it lands in the queue as submitted, contributing nothing yet
    const p = raw.prepare(`SELECT status FROM payments WHERE id = ?`).get(out.id) as { status: string };
    assert.equal(p.status, 'submitted');
  });

  it('a second identical receipt is WARNED about, not blocked', async () => {
    // Blocking would be worse than a duplicate: a genuine second transfer of the
    // same amount on the same day is possible, and a refusal sends the resident
    // back to WhatsApp convinced the site is broken. (04_UX_SPEC §4.1)
    const r = await post('/api/payments/upload', body(), resToken);
    assert.equal(r.status, 201);
    const out = await r.json() as { duplicateOf: string | null };
    assert.ok(out.duplicateOf, 'the duplicate was not detected at all');
  });

  it('a resident cannot upload for a unit they do not own', async () => {
    const other = id('UNT', 9);
    raw.prepare(`INSERT INTO units (id,building_id,unit_number) VALUES (?,?,?)`).run(other, B1, '9');
    const r = await post('/api/payments/upload', body({ unitId: other }), resToken);
    assert.equal(r.status, 403);
    assert.equal((raw.prepare(`SELECT COUNT(*) n FROM payments WHERE unit_id=?`)
      .get(other) as { n: number }).n, 0);
  });

  it('an uncompressed photo is refused rather than stored', async () => {
    // One silent 12 MB write is how a 500 MB D1 budget disappears in a week.
    const huge = Buffer.alloc(3 * 1024 * 1024, 1).toString('base64url');
    const r = await post('/api/payments/upload', body({ imageBase64: huge }), resToken);
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /[؀-ۿ]/);
  });

  it('the stored bytes come back byte-for-byte through the file route', async () => {
    const r = await post('/api/payments/upload', body({ transferDate: '2026-08-02' }), resToken);
    const out = JSON.parse(await r.text()) as { id: string };
    const key = (raw.prepare(`SELECT storage_key k FROM payments WHERE id=?`)
      .get(out.id) as { k: string }).k;
    const file = await app.request(`/api/files/${key}`, {
      headers: { authorization: `Bearer ${resToken}` } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/webp');
    const got = new Uint8Array(await file.arrayBuffer());
    assert.deepEqual([...got], [...webp], 'the image came back altered');
    // and it is genuinely in D1, not in memory
    const blob = raw.prepare(`SELECT size_bytes FROM receipt_blobs WHERE storage_key=?`)
      .get(key) as { size_bytes: number };
    assert.equal(blob.size_bytes, webp.byteLength);
  });

  it('a receipt image is STILL refused to another resident (C6 holds for D1 too)', async () => {
    const key = (raw.prepare(
      `SELECT storage_key k FROM payments WHERE unit_id=? LIMIT 1`).get(U1) as { k: string }).k;
    // no session at all
    assert.equal((await app.request(`/api/files/${key}`)).status, 401);
    // a different resident with a real session
    const otherTok = passkey.randomToken();
    raw.prepare(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`)
       .run(id('SES', 77), P_NEW, sha(otherTok), '2027-01-01T00:00:00Z');
    const r = await app.request(`/api/files/${key}`,
      { headers: { authorization: `Bearer ${otherTok}` } });
    assert.equal(r.status, 404, 'a neighbour read a receipt image out of D1');
  });

  it('an empty image is refused', async () => {
    assert.equal((await post('/api/payments/upload', body({ imageBase64: '' }), resToken)).status, 409);
  });

  it('an anonymous caller cannot upload anything', async () => {
    assert.equal((await post('/api/payments/upload', body())).status, 401);
  });
});

/* ================================================================== */
describe('the five-step wizard carries state', () => {
  let tok = '';

  before(async () => {
    const token = passkey.randomToken();
    await adb.createActivationChallenge(adminCtx, db, P_RES as never,
      await passkey.sha256(token), 'new_device', NOW);
    const r = await app.request(`/login/activate?t=${token}`);
    tok = (r.headers.get('set-cookie') ?? '').split(';')[0]!.replace('qa_session=', '');
  });

  const form = (path: string, fields: Record<string, string>) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded',
                 authorization: `Bearer ${tok}` },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    });
  const get = (path: string) =>
    app.request(path, { headers: { authorization: `Bearer ${tok}` } });

  it('steps 1-4 work as PLAIN FORM POSTS, with no JavaScript', async () => {
    // The whole flow must degrade: an old Android with a broken JS engine still
    // has to be able to tell the board what was paid.
    assert.equal((await form('/pay/1', { amount: '1,500.50' })).status, 303);
    assert.equal((await form('/pay/2', { category: 'CAT0000000000000000000IN01' })).status, 303);
    assert.equal((await form('/pay/3', { method: 'instapay', transfer_date: '2026-08-03' })).status, 303);
    assert.equal((await form('/pay/4', { reference_no: '88213' })).status, 303);
  });

  it('the review screen shows everything that was entered', async () => {
    const body = await (await get('/pay/5')).text();
    assert.ok(body.includes('1,500.50'), 'the amount was lost between steps');
    assert.ok(body.includes('اشتراك الصيانة السنوي'), 'the category was lost');
    assert.ok(body.includes('إنستا باي'), 'the method was lost, or shown as a raw code');
    assert.ok(body.includes('أغسطس'), 'the date was lost, or shown as an ISO string');
    assert.ok(body.includes('88213'), 'the reference number was lost');
  });

  it('going BACK to an earlier step re-shows what was typed', async () => {
    // 04_UX_SPEC §4.1: "a back button that never loses entered data"
    const body = await (await get('/pay/1')).text();
    assert.ok(body.includes('value="1500.50"'), 'step 1 forgot the amount on the way back');
  });

  it('/pay with no step RESUMES rather than restarting', async () => {
    const body = await (await get('/pay')).text();
    assert.ok(body.includes('aria-valuenow="5"'), 'the resident was sent back to step 1');
  });

  it('a malformed amount is refused with an Arabic reason, not a crash', async () => {
    const r = await form('/pay/1', { amount: 'ثلاثة آلاف' });
    assert.equal(r.status, 400);
    const body = await r.text();
    assert.match(body, /[؀-ۿ]/);
    assert.ok(!body.includes('NaN'), 'a parse failure leaked to the screen');
    await form('/pay/1', { amount: '1,500.50' });   // restore the draft
    await form('/pay/4', { reference_no: '88213' });
  });

  it('submitting the draft creates the payment and clears the draft', async () => {
    const r = await app.request('/api/payments/submit-draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ imageBase64: webpB64 }),
    });
    const text = await r.text();
    assert.equal(r.status, 201, text);
    const out = JSON.parse(text) as { receiptNo: string; id: string };
    const p = raw.prepare(
      `SELECT claimed_amount_piastres a, method, transfer_date, reference_no, status
         FROM payments WHERE id=?`).get(out.id) as Record<string, string | number>;
    assert.equal(p['a'], 150050, 'the amount changed between the review screen and the ledger');
    assert.equal(p['method'], 'instapay');
    assert.equal(p['transfer_date'], '2026-08-03');
    assert.equal(p['reference_no'], '88213');
    assert.equal(p['status'], 'submitted');
    // the draft is gone, so a refresh cannot submit it twice
    assert.equal((raw.prepare(`SELECT COUNT(*) n FROM payment_drafts WHERE profile_id=?`)
      .get(P_RES) as { n: number }).n, 0);
  });

  it('an incomplete draft is refused, naming the step to go back to', async () => {
    await form('/pay/1', { amount: '300' });     // amount only — no category or method
    const r = await app.request('/api/payments/submit-draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ imageBase64: webpB64 }),
    });
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /خطوة/);
  });

  it('one resident cannot see or overwrite another\'s draft', async () => {
    const otherTok = passkey.randomToken();
    raw.prepare(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`)
       .run(id('SES', 88), P_NEW, sha(otherTok), '2027-01-01T00:00:00Z');
    const body = await (await app.request('/pay/5',
      { headers: { authorization: `Bearer ${otherTok}` } })).text();
    assert.ok(!body.includes('88213'), 'a neighbour saw the reference number from another draft');
    assert.ok(!body.includes('1,500.50'), 'a neighbour saw an amount from another draft');
  });
});

/* ================================================================== */
describe('recovery by printed code — R-023', () => {
  let codes: string[] = [];

  before(async () => {
    // activation issues six codes; capture them the way a resident would
    const token = passkey.randomToken();
    await adb.createActivationChallenge(adminCtx, db, P_NEW as never,
      await passkey.sha256(token), 'first_activation', NOW);
    const html = await (await app.request(`/login/activate?t=${token}`)).text();
    codes = [...html.matchAll(/>([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})</g)].map(m => m[1]!);
  });

  it('activation issues printed recovery codes, and RETIRES any previous set', () => {
    assert.equal(codes.length, 6, 'a resident who loses their phone needs these');
    // Found by this suite: the first version APPENDED, so every activation left
    // six more permanent passkey bypasses in circulation. Six live, always.
    const live = raw.prepare(
      `SELECT COUNT(*) n FROM recovery_codes WHERE profile_id=? AND used_at IS NULL`)
      .get(P_NEW) as { n: number };
    assert.equal(live.n, 6, `${live.n} codes are live — old sets were not retired`);
    assert.ok(codes.every(c => !/[OIL01]/.test(c.replace(/-/g, ''))),
      'the alphabet must exclude 0/O/1/I/l — these get read aloud down a phone line');
  });

  it('a valid code opens a session and revokes the lost device', async () => {
    // enrol a passkey first, standing in for the phone that was lost
    raw.prepare(`INSERT INTO passkeys (id,profile_id,credential_id,public_key,sign_count,rp_id,device_label_ar)
                 VALUES (?,?,?,?,?,?,?)`)
       .run(id('PSK', 9), P_NEW, 'cred-lost', new Uint8Array([9]), 1, RP.id, 'الموبايل الضايع');

    const r = await send('/api/auth/recover', { code: codes[0] });
    assert.equal(r.status, 200, r.text);
    const out = r.json as { name: string; remaining: number; next: string };
    assert.equal(out.remaining, 5, 'the used code must be burned');
    assert.equal(out.next, '/activate', 'recovery must lead straight into enrolling a new passkey');
    assert.match(r.headers.get('set-cookie') ?? '', /qa_session=/);

    // the lost phone's credential is dead — otherwise nothing was recovered
    const live = raw.prepare(
      `SELECT COUNT(*) n FROM passkeys WHERE profile_id=? AND revoked_at IS NULL`)
      .get(P_NEW) as { n: number };
    assert.equal(live.n, 0, 'the lost device kept a working passkey');
    // Audited — BOTH events, in order: the recovery itself, then the session it
    // opened. Asserting only the last row would have missed the recovery entry
    // and passed on the session one, which is the weaker of the two.
    const actions = raw.prepare(
      `SELECT action FROM audit_log WHERE actor_id=? ORDER BY rowid DESC LIMIT 5`)
      .all(P_NEW) as { action: string }[];
    const names = actions.map(a => a.action);
    assert.ok(names.includes('account.recover'),
      `recovery was not audited; recent actions: ${names.join(', ')}`);
    assert.ok(names.includes('session.open'), 'the new session was not audited');
  });

  it('the same code cannot be used twice', async () => {
    assert.equal((await post('/api/auth/recover', { code: codes[0] })).status, 401);
  });

  it('a wrong code is refused, and looks the same as somebody else\'s code', async () => {
    const wrong = await send('/api/auth/recover', { code: 'ZZZZ-ZZZZ-ZZZZ' });
    assert.equal(wrong.status, 401);
    assert.ok(!wrong.text.includes('ساكن') && !wrong.text.includes(P_NEW),
      'the refusal leaked whose account was probed');
  });

  it('the fourth attempt in 15 minutes is rate limited', async () => {
    // A printed code is short enough to guess given enough tries. This is the
    // passkey bypass, so it is limited harder than login itself.
    const r = await post('/api/auth/recover', { code: 'AAAA-AAAA-AAAA' });
    assert.equal(r.status, 429, 'a printed code could be brute-forced');
  });

  it('the login screen offers a way to reach recovery', async () => {
    const body = await (await app.request('/login')).text();
    assert.ok(body.includes('/help') || body.includes('recover'),
      'a resident who lost their phone has no visible path forward');
  });
});
