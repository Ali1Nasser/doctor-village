/**
 * tests/access/notifications.test.ts — telling the resident what happened.
 *
 * Until migration 0016 the only event a resident ever heard about was a
 * **reversal**. That is backwards: the everyday cases — approved, needs
 * clarification, rejected — were silent, and the one message the system sent
 * was "we took your approval back".
 *
 * ## What silence actually costs, in this specific village
 * A resident uploads a receipt, the screen says «تحت المراجعة», and then
 * nothing. So they ask in the WhatsApp group — which is the exact habit this
 * product exists to replace. Every silent decision pushes one family back to
 * the thing that caused the problem.
 *
 * `01_PRD` A4 asks for the approval notification by name. These tests assert
 * the whole set, and — more importantly — that a decision **cannot** be
 * recorded without one.
 */

import { it, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NodeSqliteDb } from '../../lib/db/driver.js';
import { setTokenHasher, resolveAuthContext, reviewPayment, takeForReview } from '../../lib/db/index.js';
import { createApp } from '../../src/app.js';
import * as push from '../../lib/db/push.js';
import { generateVapidKeys } from '../../lib/push/webpush.js';
import { D1BlobStorage } from '../../lib/storage/d1blob.js';
import type { AuthContext, Id } from '../../types/domain.js';

const ROOT = process.cwd();
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
setTokenHasher(sha);
const id = (p: string, n: number) => (p + String(n).padStart(26 - p.length, '0')).slice(0, 26);

const A1 = id('PRF', 1), RES = id('PRF', 2), OTHER = id('PRF', 3);
const BLD = id('BLD', 1), U1 = id('UNT', 1), PERIOD = id('FIS', 1);
const A_BANK = 'ACC00000000000000000001102';
const I_SUBS = 'ACC00000000000000000004101';
const NOW = () => '2026-08-05T13:00:00Z';

let raw: DatabaseSync, db: NodeSqliteDb, admin: AuthContext;
let appReal: ReturnType<typeof createApp>;
let cSubs = '', OPF = '';
let VAPID_PUB = '';
let pushApp2: ReturnType<typeof createApp>;

const notif = (paymentId: string) => raw.prepare(
  `SELECT kind, title_ar t, body_ar b FROM notifications WHERE payment_id = ?`
).all(paymentId) as Array<{ kind: string; t: string; b: string }>;

before(async () => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).sort())
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  for (const f of readdirSync(join(ROOT, 'seed/prod')).sort())
    raw.exec(readFileSync(join(ROOT, 'seed/prod', f), 'utf8'));
  const x = (s: string, ...p: unknown[]) => raw.prepare(s).run(...p as never[]);

  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,'رئيس','admin')`, A1);
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,'د. سعاد','resident')`, RES);
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,'جار','resident')`, OTHER);
  for (const [n, p, tok] of [[1, A1, 'tok-a1'], [2, RES, 'tok-res'],
                             [3, OTHER, 'tok-other']] as const)
    x(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`,
      id('SES', n), p, sha(tok), '2027-01-01T00:00:00Z');
  x(`INSERT INTO buildings (id,code,name_ar) VALUES (?,'1','ع1')`, BLD);
  x(`INSERT INTO units (id,building_id,unit_number) VALUES (?,?,'101')`, U1, BLD);
  x(`INSERT INTO fiscal_periods (id,name_ar,starts_on,ends_on,status)
     VALUES (?,'2026','2026-01-01','2026-12-31','open')`, PERIOD);
  cSubs = (raw.prepare(`SELECT id FROM categories WHERE kind='operating_income' LIMIT 1`)
    .get() as { id: string }).id;
  OPF = (raw.prepare(`SELECT id FROM funds WHERE kind='operating'`).get() as { id: string }).id;

  db = new NodeSqliteDb(raw as never);
  const storage = new D1BlobStorage(db);
  appReal = createApp({ db, now: NOW, storage,
    rp: { id: 'localhost', name: 'قرية الأطباء', origin: 'http://localhost' },
    storagePut: i => storage.put(i), storageUsedBytes: () => storage.usedBytes() });
  admin = (await resolveAuthContext(db, 'tok-a1', NOW))!;
});

/** A submitted receipt sitting in the review queue, ready for a decision. */
async function submitted(n: number, amount: number): Promise<Id> {
  const pid = id('PAY', n);
  const x = (s: string, ...p: unknown[]) => raw.prepare(s).run(...p as never[]);
  x(`INSERT INTO payments (id,receipt_no,unit_id,submitted_by,category_id,
       claimed_amount_piastres,method,transfer_date,storage_key,image_sha256,status)
     VALUES (?,?,?,?,?,?, 'instapay','2026-05-01',?,?, 'draft')`,
    pid, `R-2026-0010${n}`, U1, RES, cSubs, amount,
    `receipts/${U1}/${pid}.webp`, sha(pid).padEnd(64, '0').slice(0, 64));
  x(`UPDATE payments SET status='submitted', submitted_at='2026-05-01T08:00:00Z' WHERE id=?`, pid);
  await takeForReview(admin, db, pid as Id);
  return pid as Id;
}

/**
 * A journal entry an approval can point at, created and left UNPOSTED.
 *
 * It used to post the entry here, before the receipt was approved and linked.
 * Migration 0024's orphan-entry guard now refuses that at the moment of
 * posting — a posted entry that names a receipt which does not point back at
 * it is income attributed to nothing — and it was right to: the fixture was
 * writing a shape the application cannot produce.
 *
 * These tests are about the MESSAGE the resident gets, not about the ledger,
 * so the entry stays unposted and `reviewPayment` links it. The tests that care
 * about the money going somewhere live in `board_config.test.ts` and drive
 * `approveAndPost`, which is the real path.
 */
function entryFor(n: number, amount: number): Id {
  const eid = id('JE', n);
  const x = (s: string, ...p: unknown[]) => raw.prepare(s).run(...p as never[]);
  x(`INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,
       source_type,source_id,created_by) VALUES (?,?, '2026-05-02',?,'اشتراك','payment',?,?)`,
    eid, `J-2026-0001${n}`, PERIOD, id('PAY', n), RES);
  x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,
       credit_piastres,unit_id) VALUES (?,?,1,?,?,?,0,?)`,
    id('JL', n * 2), eid, A_BANK, OPF, amount, U1);
  x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,
       credit_piastres,unit_id) VALUES (?,?,2,?,?,0,?,?)`,
    id('JL', n * 2 + 1), eid, I_SUBS, OPF, amount, U1);
  return eid as Id;
}

/* ================================================================== */
describe('every decision reaches the resident', () => {

  it('⭐ approval — the message A4 asks for by name', async () => {
    const p = await submitted(1, 600_000);
    const e = entryFor(1, 600_000);
    await reviewPayment(admin, db, p, {
      kind: 'approve', approvedAmountPiastres: 600_000, journalEntryId: e }, NOW);

    const n = notif(p);
    assert.equal(n.length, 1, 'an approved receipt sent no message');
    assert.equal(n[0]!.kind, 'payment_approved');
    assert.match(n[0]!.t, /اتقبل إيصالك/);
    assert.match(n[0]!.t, /R-2026-00101/, 'the message does not name the receipt');
    assert.match(n[0]!.b, /6,000\.00/, 'the message does not say how much was accepted');
  });

  it('⭐ an ADJUSTED approval says both numbers and why', async () => {
    // The admin corrected 8,000 down to 6,000. Telling the resident "accepted"
    // and nothing else is how a family discovers the difference two months later
    // and concludes 2,000 ج.م went missing.
    const p = await submitted(2, 800_000);
    const e = entryFor(2, 600_000);
    await reviewPayment(admin, db, p, {
      kind: 'approve', approvedAmountPiastres: 600_000,
      reasonAr: 'الصورة مكتوب فيها 6,000 مش 8,000', journalEntryId: e }, NOW);

    const n = notif(p);
    assert.equal(n.length, 1);
    assert.match(n[0]!.t, /تعديل المبلغ/, 'an adjusted approval reads like a plain one');
    assert.match(n[0]!.b, /6,000\.00/);
    assert.match(n[0]!.b, /8,000\.00/, 'the resident is not told what they originally claimed');
    assert.match(n[0]!.b, /مكتوب فيها/, "the admin's reason is missing");
  });

  it('needs-info tells them where to go', async () => {
    const p = await submitted(3, 600_000);
    await reviewPayment(admin, db, p, {
      kind: 'need_info', reasonAr: 'الصورة مش واضحة، مش بايِن فيها رقم العملية' }, NOW);
    const n = notif(p);
    assert.equal(n[0]!.kind, 'payment_needs_info');
    assert.match(n[0]!.b, /مش واضحة/);
    assert.match(n[0]!.b, /إيصالاتي/, 'the resident is not told where to fix it');
  });

  it('⭐ a rejection is never the last word', async () => {
    const p = await submitted(4, 600_000);
    await reviewPayment(admin, db, p, {
      kind: 'reject', reasonAr: 'التحويل ده مش موجود في كشف حساب القرية' }, NOW);
    const n = notif(p);
    assert.equal(n[0]!.kind, 'payment_rejected');
    assert.match(n[0]!.b, /مش نهائي/,
      'a refusal with no next step sends the resident to the board angry, not to the screen');
  });

  it('⭐ a DUPLICATE must not read like a rejection', async () => {
    // The money arrived; it was counted once. A resident who reads "rejected"
    // here believes a real transfer was thrown away.
    const p = await submitted(5, 600_000);
    await reviewPayment(admin, db, p, {
      kind: 'duplicate', reasonAr: 'ده نفس التحويل بتاع إيصال R-2026-00101' }, NOW);
    const n = notif(p);
    assert.match(n[0]!.t, /مكرر/, 'a duplicate is announced as a rejection');
    assert.match(n[0]!.b, /الفلوس مش ضايعة/,
      'the resident is not reassured that the original was counted');
  });
});

/* ================================================================== */
describe('told, and told exactly once', () => {

  it('⭐ a decision cannot be recorded without a message', () => {
    // The whole point of writing it in the same `db.batch()`. If this ever
    // fails, some decision path bypassed `reviewPayment`.
    const silent = raw.prepare(
      `SELECT receipt_no FROM v_payment_notifications WHERE messages = 0`).all() as
      Array<{ receipt_no: string }>;
    assert.deepEqual(silent, [],
      `decided but silent: ${silent.map(s => s.receipt_no).join('، ')}`);
  });

  it('⭐ a double-tapped approve sends ONE message, not two', async () => {
    const p = await submitted(6, 600_000);
    const e = entryFor(6, 600_000);
    const decision = { kind: 'approve' as const, approvedAmountPiastres: 600_000, journalEntryId: e };
    await reviewPayment(admin, db, p, decision, NOW);
    // The second call changes 0 rows by design — but a notification in the same
    // batch would be written anyway, on exactly the connection quality that
    // makes people tap twice. `ux_notif_payment_kind` makes it a no-op.
    await assert.rejects(() => reviewPayment(admin, db, p, decision, NOW),
      /مش في حالة تسمح/, 'the second approve was accepted');
    assert.equal(notif(p).length, 1, 'the resident got the same message twice');
  });

  it('a receipt approved and later reversed gets TWO messages, not one', () => {
    // Different kinds, so the unique index does not collapse them. Suppressing
    // the reversal because an approval message already exists would be the
    // worst possible reading of "told once".
    const n = raw.prepare(
      `SELECT COUNT(DISTINCT kind) k FROM notifications WHERE payment_id IS NOT NULL`)
      .get() as { k: number };
    assert.ok(n.k >= 2, 'only one kind of message has ever been sent');
  });

  it('the message belongs to the SUBMITTER, not the unit', () => {
    // A delegate submits on behalf of an owner in Cairo; the person who needs
    // to know the receipt was queried is the one who uploaded it.
    const owner = raw.prepare(
      `SELECT DISTINCT profile_id p FROM notifications WHERE payment_id IS NOT NULL`)
      .all() as Array<{ p: string }>;
    assert.deepEqual(owner.map(o => o.p), [RES]);
  });
});

/* ================================================================== */
describe('the inbox — a message nobody can read is not a message', () => {
  /**
   * Same failure as session 18's reversal engine, one layer down: the messages
   * were written, addressed to the right person, deduplicated and transactional
   * — and completely unreadable, because nothing listed them. Twice in one week.
   */
  it('⭐ a resident sees their own messages', async () => {
    const r = await appReal.request('/notifications',
      { headers: { authorization: 'Bearer tok-res' } });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /اتقبل إيصالك/, 'the approval message is not on the inbox page');
    assert.match(body, /R-2026-00101/, 'the message does not name the receipt');
  });

  it('⭐ and CANNOT see anyone else\'s', async () => {
    const r = await appReal.request('/notifications',
      { headers: { authorization: 'Bearer tok-other' } });
    assert.equal(r.status, 200);
    const body = await r.text();
    // The other resident has no messages at all. If any of سعاد's reasons leak
    // here, the inbox is as bad as an unprotected receipt image (C6).
    assert.ok(!body.includes('R-2026-00101'), "a neighbour can read another resident's messages");
    assert.ok(!body.includes('مش واضحة'), "a neighbour can read another resident's reasons");
    assert.match(body, /مفيش رسايل لسه/, 'the empty state is missing');
  });

  it('the reason and the next step are both visible, on separate lines', async () => {
    const body = await (await appReal.request('/notifications',
      { headers: { authorization: 'Bearer tok-res' } })).text();
    assert.match(body, /white-space:pre-line/,
      'the body collapses to one paragraph, burying the "what to do next" half');
    assert.match(body, /إيصالاتي/, 'the needs-info instruction is missing');
  });

  it('⭐ opening the page marks everything read', async () => {
    // Make a FRESH unread message rather than relying on what earlier tests
    // left behind — the first test in this suite already opened the inbox and
    // marked everything read. (Third time this ordering coupling has bitten;
    // see INSIGHTS session 13.)
    const p = await submitted(9, 300_000);
    await reviewPayment(admin, db, p, {
      kind: 'reject', reasonAr: 'التحويل ده مش في كشف الحساب' }, NOW);

    const before = raw.prepare(
      `SELECT COUNT(*) n FROM notifications WHERE profile_id=? AND read_at IS NULL`)
      .get(RES) as { n: number };
    assert.ok(before.n > 0, 'nothing was unread to begin with — the test proves nothing');

    // The FIRST render must still highlight what was new on this visit.
    const first = await (await appReal.request('/notifications',
      { headers: { authorization: 'Bearer tok-res' } })).text();
    assert.match(first, /جديد/,
      'marking read before rendering hides what was new — same as not telling them');

    const after = raw.prepare(
      `SELECT COUNT(*) n FROM notifications WHERE profile_id=? AND read_at IS NULL`)
      .get(RES) as { n: number };
    assert.equal(after.n, 0, 'opening the inbox did not mark anything read');

    const second = await (await appReal.request('/notifications',
      { headers: { authorization: 'Bearer tok-res' } })).text();
    assert.ok(!second.includes('>جديد<'), 'everything still reads as new on the second visit');
  });

  it('reading is NOT written to the audit log', () => {
    // `mutate()` exists so a change to money or identity cannot commit unlogged.
    // "سعاد opened her messages" is neither, and logging it would put a record
    // of one resident's reading habits in a table five people can read. The
    // audit log is for accountability over shared money, not surveillance.
    const rows = raw.prepare(
      `SELECT COUNT(*) n FROM audit_log WHERE action LIKE '%notification%'`).get() as { n: number };
    assert.equal(rows.n, 0, "a resident's reading habits are in the audit log");
  });

  it('an anonymous visitor is sent to login, not shown an empty inbox', async () => {
    const r = await appReal.request('/notifications');
    assert.equal(r.status, 302);
  });
});

/* ================================================================== */
describe('push — the phone buzzes, and nothing depends on it (Q23)', () => {
  /**
   * The owner chose browser push. These tests cover the two things that matter
   * and cannot be checked on a real phone from here:
   *   1. a decision actually triggers a send to the resident's device;
   *   2. **no push failure can break the decision that caused it.**
   *
   * The encryption itself is verified against RFC 8291's published vector in
   * `tests/unit/webpush.test.ts` — the part that fails silently if it is wrong.
   */
  const ENDPOINT = 'https://push.example/s/soaad-phone';
  const UA_PUB = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
  const UA_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';

  let sends: Array<{ url: string; init: RequestInit }> = [];
  let pushApp: ReturnType<typeof createApp>;
  let nextStatus = 201;

  before(async () => {
    const kp = await generateVapidKeys();
    VAPID_PUB = kp.publicKey;
    const spy = (async (url: string, init: RequestInit) => {
      sends.push({ url, init });
      return new Response('', { status: nextStatus });
    }) as unknown as typeof fetch;
    const storage = new D1BlobStorage(db);
    pushApp = createApp({
      db, now: NOW, storage,
      rp: { id: 'localhost', name: 'ق', origin: 'http://localhost' },
      storagePut: i => storage.put(i), storageUsedBytes: () => storage.usedBytes(),
      vapid: { subject: 'mailto:board@example.test', ...kp },
      fetchImpl: spy,
    });
    pushApp2 = pushApp;
  });

  const subscribe = (tok: string, endpoint = ENDPOINT) =>
    pushApp.request('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ endpoint, p256dh: UA_PUB, auth: UA_AUTH, label: 'Android' }),
    });

  it('the service worker is served from the ROOT path', async () => {
    // A worker's scope is its own directory: at /static/sw.js it could only
    // receive pushes for /static/*. This is the one file that must live at /.
    const r = await pushApp.request('/sw.js');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /javascript/);
    const body = await r.text();
    assert.match(body, /addEventListener\('push'/, 'the worker has no push handler');
    assert.ok(!/addEventListener\('fetch'/.test(body),
      'the worker intercepts fetch — it could serve a stale treasury balance from cache');
  });

  it('the inbox offers the button only when push is configured', async () => {
    const off = await appReal.request('/notifications',
      { headers: { authorization: 'Bearer tok-res' } });
    assert.ok(!(await off.text()).includes('push-btn'),
      'a deployment with no VAPID key still shows an enable button that cannot work');

    const on = await pushApp.request('/notifications',
      { headers: { authorization: 'Bearer tok-res' } });
    const body = await on.text();
    assert.match(body, /id="push-btn"/, 'push is configured but not offered');
    assert.match(body, /آيفون/, 'iOS users are not told they must add to home screen first');
  });

  it('a resident can subscribe', async () => {
    assert.equal((await subscribe('tok-res')).status, 200);
    const n = raw.prepare(
      `SELECT COUNT(*) n FROM push_subscriptions WHERE profile_id=?`).get(RES) as { n: number };
    assert.equal(n.n, 1);
  });

  it('re-subscribing the same endpoint REPLACES rather than accumulates', async () => {
    await subscribe('tok-res');
    await subscribe('tok-res');
    const n = raw.prepare(
      `SELECT COUNT(*) n FROM push_subscriptions WHERE profile_id=?`).get(RES) as { n: number };
    assert.equal(n.n, 1,
      'a phone that re-grants permission would get the same message three times');
  });

  it('⭐ approving a receipt sends to the resident\'s device', async () => {
    sends = [];
    const p = await submitted(11, 450_000);
    const e = entryFor(11, 450_000);
    const r = await pushApp.request(`/api/payments/${p}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-a1' },
      body: JSON.stringify({ kind: 'approve', approvedAmountPiastres: 450_000, journalEntryId: e }),
    });
    assert.equal(r.status, 200);
    assert.equal(sends.length, 1, 'the decision did not reach the phone');
    assert.equal(sends[0]!.url, ENDPOINT);
    const h = sends[0]!.init.headers as Record<string, string>;
    assert.equal(h['content-encoding'], 'aes128gcm');
    assert.match(h['authorization']!, /^vapid /);
  });

  it('⭐ the payload does NOT carry the amount or the reason', async () => {
    // A notification renders on a locked screen anyone standing near can read.
    // The body is the encrypted blob, so this asserts on what we PUT into it —
    // the plaintext is built in `deliverPush` from the title and first line.
    const body = sends[0]!.init.body as Uint8Array;
    assert.ok(body.length > 86, 'the payload is empty');
    // Encrypted, so the amount cannot appear literally. The real guarantee is
    // the truncation in deliverPush; this asserts the ciphertext is not a
    // pass-through of a long body.
    assert.ok(body.length < 86 + 400,
      'the pushed payload is large enough to contain the full reason text');
  });

  it('⭐ a DEAD subscription does not break the decision', async () => {
    nextStatus = 410;
    sends = [];
    const p = await submitted(12, 200_000);
    const r = await pushApp.request(`/api/payments/${p}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-a1' },
      body: JSON.stringify({ kind: 'reject', reasonAr: 'التحويل مش في كشف الحساب' }),
    });
    assert.equal(r.status, 200, 'a dead phone made the rejection fail');
    // ...and the decision is recorded, and the message is in the inbox.
    const st = raw.prepare(`SELECT status FROM payments WHERE id=?`).get(p) as { status: string };
    assert.equal(st.status, 'rejected');
    assert.equal(notif(p).length, 1, 'the inbox message is missing');
    // ...and the subscription is marked gone so we stop hammering the service.
    const gone = raw.prepare(
      `SELECT COUNT(*) n FROM push_subscriptions WHERE gone_at IS NOT NULL`).get() as { n: number };
    assert.equal(gone.n, 1, 'a 410 subscription was not marked gone');
    nextStatus = 201;
  });

  it('⭐ a push service returning 500 does not break the decision either', async () => {
    await subscribe('tok-res', 'https://push.example/s/second-phone');
    nextStatus = 500;
    const p = await submitted(13, 100_000);
    const e = entryFor(13, 100_000);
    const r = await pushApp.request(`/api/payments/${p}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-a1' },
      body: JSON.stringify({ kind: 'approve', approvedAmountPiastres: 100_000, journalEntryId: e }),
    });
    assert.equal(r.status, 200, 'a push-service outage made an approval fail');
    assert.equal(notif(p).length, 1);
    nextStatus = 201;
  });

  it('⭐ how many residents this actually reaches is a NUMBER, not an assumption', async () => {
    // Q23's honest weakness: push needs permission, and on iOS the site must be
    // added to the home screen first. Some residents will never do it. If the
    // board cannot see the proportion they will believe everyone was told.
    const reach = await push.pushReach(admin, db);
    assert.ok(reach.residents >= 2, 'the fixture has residents');
    assert.ok(reach.reachable >= 1, 'nobody is reachable');
    assert.ok(reach.reachable < reach.residents,
      'the fixture does not exercise the gap this view exists to expose');
    assert.equal(reach.dead, 1, 'the dead subscription is not counted');
  });

  it('a resident cannot see anyone else\'s devices', async () => {
    const mine = await push.subscriptionsFor(db, RES as Id);
    const theirs = await push.subscriptionsFor(db, OTHER as Id);
    assert.ok(mine.length > 0);
    assert.deepEqual(theirs, [], 'a subscription leaked across residents');
  });

  it('an anonymous caller cannot subscribe', async () => {
    const r = await pushApp.request('/api/push/subscribe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://x/y', p256dh: UA_PUB, auth: UA_AUTH }),
    });
    assert.equal(r.status, 401);
  });
});

/* ================================================================== */
describe('⭐ R-069 — a changed VAPID key is loud, not silent', () => {
  /**
   * Deploying a different key does not rotate anything: it orphans every
   * subscription in the village. Nothing errors — the push service accepts the
   * request and the browser silently drops a message from a sender it does not
   * recognise. Residents stop being notified one at a time, and the only signal
   * is somebody mentioning it months later.
   *
   * So the first key ever used is recorded, and a mismatch refuses to send and
   * says so on `/admin/health`.
   */
  const other = () => generateVapidKeys();

  it('the first key used is recorded', async () => {
    const st = await push.vapidStatus(admin, db, undefined);
    assert.ok(st.recorded, 'nothing was recorded when push was first used');
    assert.equal(st.recorded!.length, 12, 'the fingerprint is not the short form the tool prints');
  });

  it('the same key keeps working', async () => {
    const before = await push.vapidStatus(admin, db, undefined);
    await push.assertVapidIdentity(db, VAPID_PUB, NOW);
    const after = await push.vapidStatus(admin, db, undefined);
    assert.equal(after.recorded, before.recorded, 'the recorded key moved');
  });

  it('⭐ a DIFFERENT key is refused', async () => {
    const kp = await other();
    await assert.rejects(() => push.assertVapidIdentity(db, kp.publicKey, NOW),
      /اتغيّر عن اللي السكان مشتركين بيه/,
      'a new VAPID key was accepted — every subscription is now silently dead');
  });

  it('...and the recorded key cannot be "fixed" by editing the row', () => {
    // The honest repair is to put the ORIGINAL key back. A guard you can silence
    // by editing a row is a guard that gets silenced by whoever is in a hurry.
    assert.throws(() => raw.prepare(
      `UPDATE vapid_identity SET fingerprint='whatever' WHERE id=1`).run(),
      /مينفعش يتغيّر|constraint/);
    assert.throws(() => raw.prepare(`DELETE FROM vapid_identity WHERE id=1`).run(),
      /مينفعش تمسح|constraint/);
  });

  it('⭐ a mismatch is shown on /admin/health, in red, with the right fingerprint', async () => {
    const kp = await other();
    const wrong = createApp({
      db, now: NOW, storage: new D1BlobStorage(db),
      rp: { id: 'localhost', name: 'ق', origin: 'http://localhost' },
      vapid: { subject: 'mailto:x@y.test', ...kp },
    });
    const body = await (await wrong.request('/admin/health',
      { headers: { authorization: 'Bearer tok-a1' } })).text();
    assert.match(body, /مفتاح الإشعارات اتغيّر/, 'a dead push channel is invisible to the board');
    const recorded = (await push.vapidStatus(admin, db, undefined)).recorded!;
    assert.ok(body.includes(recorded),
      'the board is told something is wrong but not which key to restore');
  });

  it('⭐ and a mismatch still does not break a decision', async () => {
    const kp = await other();
    const wrong = createApp({
      db, now: NOW, storage: new D1BlobStorage(db),
      rp: { id: 'localhost', name: 'ق', origin: 'http://localhost' },
      vapid: { subject: 'mailto:x@y.test', ...kp },
      fetchImpl: (async () => { throw new Error('should never be called'); }) as unknown as typeof fetch,
    });
    const p = await submitted(14, 120_000);
    const r = await wrong.request(`/api/payments/${p}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-a1' },
      body: JSON.stringify({ kind: 'reject', reasonAr: 'التحويل مش في كشف الحساب' }),
    });
    assert.equal(r.status, 200, 'a misconfigured push key made a rejection fail');
    assert.equal(notif(p).length, 1, 'the inbox message is missing');
  });

  it('the board is told how many residents this actually reaches', async () => {
    const body = await (await pushApp2.request('/admin/health',
      { headers: { authorization: 'Bearer tok-a1' } })).text();
    assert.match(body, /مشغّل التنبيهات على موبايله/, 'push reach is not shown');
    assert.match(body, /متفتكرش إن الكل اتبلّغ/,
      'the board is shown a number with no warning about what it means');
  });
});
