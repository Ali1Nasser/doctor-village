/**
 * tests/access/journeys.test.ts — the defects a BROWSER found, pinned down.
 *
 * Every assertion here started as something `tools/walkthrough.mjs` hit while
 * driving the real product in Chromium as each of the five roles. None of them
 * were visible to the existing suites, and the reason is worth writing down:
 *
 *   · `npm run screens` proves the server emits HTML;
 *   · `npm run a11y` proves that HTML has no axe violations;
 *   · the access tests prove the right people can reach the right routes.
 *
 * A form with no submit button passes all three. So does a screen that draws
 * buttons whose POST the same role is refused. So does a label that belongs to
 * a different feature. These are checks on the SHAPE of a screen — is there a
 * way forward, is the control offered to exactly the people it works for, does
 * the wording match the screen it is on.
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

/**
 * The demo village, because these are questions about SCREENS and an empty
 * database renders empty states — a review queue with nothing in it has no
 * approve button to be wrong about. `render_screens.ts` loads the same seed for
 * the same reason. Every figure in it is invented (R-037), which is fine here:
 * nothing below asserts an amount.
 */
raw.prepare(`UPDATE env_guard SET environment='demo', set_by='journeys-test'`).run();
for (const f of readdirSync(join(ROOT, 'seed/demo')).sort().filter(f => f.endsWith('.sql'))) {
  raw.exec(readFileSync(join(ROOT, 'seed/demo', f), 'utf8'));
}

const pid = (p: string, n: number) => (p + String(n).padStart(23, '0')).slice(0, 26);
const one = (sql: string) => raw.prepare(sql).get() as { id: string };
const ADMIN = one(`SELECT id FROM profiles WHERE role='admin' AND is_active=1 LIMIT 1`).id;
const REVIEWER = one(`SELECT id FROM profiles WHERE role='finance_reviewer' AND is_active=1 LIMIT 1`).id;
// A resident who owns a flat, so the payment wizard has somewhere to post to.
const RES = one(`SELECT p.id FROM profiles p
   JOIN unit_owners uo ON uo.profile_id = p.id AND uo.valid_to IS NULL
  WHERE p.role='resident' AND p.is_active=1 LIMIT 1`).id;

let sn = 0;
for (const [who, tok] of [[ADMIN, 'tok-admin'], [REVIEWER, 'tok-rev'], [RES, 'tok-res']] as const) {
  raw.prepare(`INSERT INTO sessions (id, profile_id, token_hash, expires_at) VALUES (?,?,?,?)`)
     .run(pid('SES', ++sn), who, sha(tok), '2027-01-01T00:00:00Z');
}

const db = new NodeSqliteDb(raw as never);
const NOW = () => '2026-08-09T10:00:00Z';
const storage = new D1BlobStorage(db);
const app = createApp({
  db, now: NOW, storage, demo: false,
  payCategories: [{ id: 'CAT0000000000000000000IN01', nameAr: 'اشتراك سنوي', icon: '📅' }],
  rp: { id: 'x.test', name: 'x', origin: 'https://x.test' },
  storagePut: i => storage.put(i), storageUsedBytes: () => storage.usedBytes(),
});

const get = (path: string, tok?: string) => app.request('https://x.test' + path,
  { headers: tok ? { cookie: `qa_session=${tok}` } : {} });
const text = async (path: string, tok?: string) => (await get(path, tok)).text();

/** Everything inside the one `<form>` that posts to `action`. */
const formOf = (html: string, action: string): string => {
  const re = new RegExp(`<form[^>]*action="${action.replace(/[/]/g, '\\/')}"[\\s\\S]*?<\\/form>`);
  return re.exec(html)?.[0] ?? '';
};

/* ===================================================================== */
/* The payment wizard — the central journey of the product               */
/* ===================================================================== */

/**
 * Steps 1 and 4 shipped with no submit control at all.
 *
 * Step 1 is a single text input, so a DESKTOP browser implicitly submits on
 * Enter and the bug is invisible there — but `inputmode="decimal"` gives a
 * phone a numeric keypad with no Enter key, and this village is on phones.
 * Step 4 has three fields, so implicit submission does not apply anywhere: the
 * wizard could not be finished by anybody, on any device.
 */
test('every step of the payment wizard has something to press', async () => {
  for (const step of [1, 2, 3, 4]) {
    const form = formOf(await text(`/pay/${step}`, 'tok-res'), `/pay/${step}`);
    assert.ok(form, `step ${step} has no form at all`);
    const submits = form.match(/<button[^>]*type="submit"/g) ?? [];
    assert.ok(submits.length > 0,
      `step ${step} of the payment wizard has no submit button — there is no way forward`);
  }
  // Step 5 is allowed two answers and no third: either the confirm button (a
  // JS one, because it posts JSON), or — when the draft is incomplete — a link
  // back to the step that is missing something. What must never happen is a
  // step offering neither, which is the defect this whole test is about.
  const five = await text('/pay/5', 'tok-res');
  assert.ok(/id="submit-btn"/.test(five) || /href="\/pay\/[1-4]"/.test(five),
    'step 5 offers neither a way to send nor a way back to what is missing');
});

/**
 * The date is `required` and the method tiles ARE the submit buttons, so a
 * resident who taps «إنستا باي» first gets the browser's validation bounce and
 * reads it as the button not working. Top-to-bottom order has to match the
 * order the form submits in.
 */
test('step 3 asks for the transfer date before the method that submits it', async () => {
  const form = formOf(await text('/pay/3', 'tok-res'), '/pay/3');
  const date = form.indexOf('name="transfer_date"');
  const method = form.indexOf('name="method"');
  assert.ok(date >= 0 && method >= 0);
  assert.ok(date < method,
    'the method tiles submit the form, so a required date below them can only be found by failing');
});

/**
 * The receipt photo is mandatory, and step 4 never said so.
 *
 * It lives in `sessionStorage`, so `draftGaps` — which runs on the server and
 * drives every other "go back to step N" on the review screen — cannot see it.
 * The only mention of the requirement was an error AFTER «تأكيد الإرسال», so a
 * resident filled in five steps and was refused at the end for something
 * nobody had asked them for. Found by driving the wizard to the last button.
 */
test('the step that needs a photo says the photo is needed', async () => {
  const four = formOf(await text('/pay/4', 'tok-res'), '/pay/4');
  assert.match(four, /مطلوبة/,
    'step 4 still presents the receipt photo as though it were optional');
  // …and the review step names the gap on arrival rather than on the press.
  const five = await text('/pay/5', 'tok-res');
  assert.match(five, /photoMissingBack/, 'the island cannot announce the missing photo');
  assert.match(five, /backToPhoto/);
});

/**
 * ⭐ A resident could not send a receipt on the DEMO database at all.
 *
 * `migrations/0006` guards both directions, and the reverse one matters here:
 * `trg_no_real_payments_in_demo` refuses any payment whose id does not begin
 * `DEMO`, so real money can never be posted into a rehearsal database and later
 * mistaken for one. The app minted `PAY…` unconditionally, so on the
 * deployment the board is actually shown, the wizard's last button answered
 * with the trigger's own sentence — half of it in English.
 *
 * No existing test could see it: they run against a database whose `env_guard`
 * says `test`, where the trigger does not apply. This one says `demo`, which
 * is what the deployed demo says.
 */
test('a resident can send a receipt on the demo database', async () => {
  assert.equal((raw.prepare(`SELECT environment FROM env_guard WHERE id=1`)
    .get() as { environment: string }).environment, 'demo', 'fixture is not a demo database');

  const unit = (raw.prepare(
    `SELECT unit_id FROM unit_owners WHERE profile_id=? AND valid_to IS NULL LIMIT 1`)
    .get(RES) as { unit_id: string }).unit_id;
  const category = (raw.prepare(
    `SELECT id FROM categories WHERE kind='operating_income' AND is_active=1 LIMIT 1`)
    .get() as { id: string }).id;

  const r = await app.request('https://x.test/api/payments/upload', {
    method: 'POST',
    headers: { cookie: 'qa_session=tok-res', 'content-type': 'application/json' },
    body: JSON.stringify({
      unitId: unit, categoryId: category, amountPiastres: 75000,
      method: 'instapay', transferDate: '2026-08-01', referenceNo: '900123456',
      // base64url of a real 8×8 PNG — the server sniffs magic bytes, so a
      // placeholder string is refused before it ever reaches the trigger.
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4sWUBVsQwtCQAydSHATA1Jj4AAAAASUVORK5CYII',
    }),
  });
  const body = await r.json() as { id?: string; error?: string };
  assert.equal(r.status, 201, `submitting a receipt failed: ${body.error ?? r.status}`);
  const id = body.id ?? '';
  assert.ok(id.startsWith('DEMO'),
    'the payment id does not carry the demo prefix, so the trigger will refuse it');

  // …and the row really is there, self-labelled as rehearsal data.
  assert.equal((raw.prepare(`SELECT COUNT(*) n FROM payments WHERE id = ?`)
    .get(id) as { n: number }).n, 1);
});

/* ===================================================================== */
/* The review queue — offered to exactly the people it works for         */
/* ===================================================================== */

/**
 * `listReviewQueue` requires `payment.read_any`; approving requires
 * `payment.review`. A `finance_reviewer` holds the first and deliberately not
 * the second — reviewing, in their job, means auditing. The page drew اعتماد /
 * رفض on every receipt for them anyway, and the POST answered 403.
 */
test('the review queue shows approve buttons only to people who can approve', async () => {
  const asAdmin = await text('/admin/review', 'tok-admin');
  const asReviewer = await text('/admin/review', 'tok-rev');

  assert.match(asAdmin, /value="approve"/, 'the board lost its approve button');
  assert.ok(!/value="approve"/.test(asReviewer),
    'a finance_reviewer is shown an approve button that answers 403 when pressed');
  assert.ok(!/value="reject"/.test(asReviewer));
  assert.ok(!/action="\/admin\/review\//.test(asReviewer),
    'the review form is still rendered for somebody who cannot submit it');

  // …and the page says what it IS, rather than looking like a broken queue.
  assert.match(asReviewer, /للاطّلاع والمراجعة المالية/);
});

test('a finance_reviewer is refused the POST as well as the button', async () => {
  const r = await app.request('https://x.test/admin/review/anything', {
    method: 'POST',
    headers: { cookie: 'qa_session=tok-rev', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ kind: 'approve' }),
  });
  assert.equal(r.status, 403, 'hiding the button is not the control — the route is');
});

/**
 * The menu gated `/admin/review` on the capability its BUTTONS need, so the
 * role that may read the screen was never offered a link to it and could only
 * arrive from the home-page queue card.
 */
test('everyone who can open the review queue is offered it in their menu', async () => {
  for (const [tok, who] of [['tok-admin', 'admin'], ['tok-rev', 'finance_reviewer']] as const) {
    const openable = (await get('/admin/review', tok)).status === 200;
    const inMenu = (await text('/', tok)).includes('href="/admin/review"');
    assert.equal(inMenu, openable,
      `${who}: the menu and the route disagree about /admin/review`);
  }
  // A resident can do neither, and the two still agree.
  assert.equal((await get('/admin/review', 'tok-res')).status, 403);
  assert.ok(!(await text('/', 'tok-res')).includes('href="/admin/review"'));
});

/* ===================================================================== */
/* Publishing — the words on the screen, and the answer after pressing   */
/* ===================================================================== */

/**
 * The publishing form borrowed all three of its labels from the maintenance
 * ticket, so a board member writing an announcement was asked «المشكلة في
 * إيه؟». Shared strings are good; sharing the ones that name a different
 * feature is how a screen ends up describing something else.
 */
test('the publishing form asks about a post, not about a broken light', async () => {
  const html = await text('/admin/content', 'tok-admin');
  const form = formOf(html, '/admin/content');
  assert.ok(form, 'no publishing form');
  assert.ok(!form.includes('المشكلة في إيه؟'),
    'the publishing form is still asking the maintenance question');
  assert.match(form, /العنوان/);
  assert.match(form, /النص/);
  assert.match(form, /نوع المنشور/);
});

/**
 * Publishing answered with a redirect to a page that said nothing, so the
 * board member's announcement was somewhere down a list of thirty and the
 * screen gave no sign anything had happened. The flash rides in the query
 * because a redirect cannot carry one — and it is a closed set of keys, so a
 * link cannot print arbitrary text on a board screen.
 */
test('publishing says so afterwards', async () => {
  const r = await app.request('https://x.test/admin/content', {
    method: 'POST',
    headers: { cookie: 'qa_session=tok-admin', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ type: 'announcement', title: 'اجتماع الجمعية', body: 'نص' }),
  });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/admin/content?ok=published');
  assert.match(await text('/admin/content?ok=published', 'tok-admin'), /اتنشر/);

  // Unknown keys print nothing at all.
  const junk = await text('/admin/content?ok=<script>alert(1)</script>', 'tok-admin');
  assert.ok(!junk.includes('alert(1)'), 'the flash key reached the page');
});

/* ===================================================================== */
/* The shape of every screen a role is offered                           */
/* ===================================================================== */

/**
 * The general form of the review-queue bug: a menu that offers a destination
 * the app then refuses. Asserted for every role over every menu entry, so the
 * next screen added with the wrong capability fails here rather than in front
 * of the board.
 */
test('no role is offered a menu entry the app refuses them', async () => {
  for (const [tok, who] of
       [['tok-admin', 'admin'], ['tok-rev', 'finance_reviewer'], ['tok-res', 'resident']] as const) {
    const home = await text('/', tok);
    const hrefs = [...new Set([...home.matchAll(/href="(\/[a-z0-9/-]*)"/g)].map(m => m[1]!))]
      .filter(h => !h.includes('/logout'));
    for (const href of hrefs) {
      const status = (await get(href, tok)).status;
      assert.ok(status < 400,
        `${who} is offered ${href} in their own menu and gets ${status}`);
    }
  }
});
