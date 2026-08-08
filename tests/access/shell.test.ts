/**
 * tests/access/shell.test.ts — the frame every screen is rendered inside.
 *
 * The shell had never been tested, and it collected the kind of defect a
 * screenshot of one page does not show: a drawer that opened and could not be
 * closed, a scrim that was a `box-shadow` and therefore let taps fall through
 * to the links underneath, and a «تسجيل الخروج» string that had lived in
 * `messages/ar.json` since CP-4 with no route behind it.
 *
 * Geometry is checked in a browser by `tools/a11y-scan.mjs`'s sibling probe;
 * what is asserted HERE is everything that can be asserted from the HTML and
 * the database — that the markup which makes closing possible is present, that
 * every destination the caller may open is in the menu, and that signing out
 * actually ends the session rather than only clearing a cookie.
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
const ADMIN = pid('PRF', 1), RES = pid('PRF', 2);
raw.prepare(`INSERT INTO profiles (id, full_name, role) VALUES (?,?, 'admin')`)
   .run(ADMIN, 'د. خالد الشناوي');
raw.prepare(`INSERT INTO profiles (id, full_name, role) VALUES (?,?, 'resident')`)
   .run(RES, 'د. عمرو شاهين');
// Two live sessions for the SAME resident: one per device. Signing out of one
// must not touch the other — that distinction is the reason /logout exists
// beside «اقفل كل الجلسات», and a test with one session cannot see it.
raw.prepare(`INSERT INTO sessions (id, profile_id, token_hash, expires_at) VALUES (?,?,?,?)`)
   .run(pid('SES', 1), ADMIN, sha('tok-admin'), '2027-01-01T00:00:00Z');
raw.prepare(`INSERT INTO sessions (id, profile_id, token_hash, expires_at) VALUES (?,?,?,?)`)
   .run(pid('SES', 2), RES, sha('tok-phone'), '2027-01-01T00:00:00Z');
raw.prepare(`INSERT INTO sessions (id, profile_id, token_hash, expires_at) VALUES (?,?,?,?)`)
   .run(pid('SES', 3), RES, sha('tok-tablet'), '2027-01-01T00:00:00Z');

const db = new NodeSqliteDb(raw as never);
const storage = new D1BlobStorage(db);
const app = createApp({
  db, now: () => '2026-08-08T10:00:00Z', storage, demo: false, payCategories: [],
  rp: { id: 'x.test', name: 'x', origin: 'https://x.test' },
  storagePut: i => storage.put(i), storageUsedBytes: () => storage.usedBytes(),
});

const req = (path: string, tok?: string, init: RequestInit = {}) =>
  app.request('https://x.test' + path, {
    ...init,
    headers: { ...(tok ? { cookie: `qa_session=${tok}` } : {}), ...(init.headers ?? {}) },
  });

const live = (t: string) => (raw.prepare(
  `SELECT COUNT(*) n FROM sessions WHERE token_hash = ? AND revoked_at IS NULL`
).get(sha(t)) as { n: number }).n;

/* ===================================================================== */
/* The drawer                                                            */
/* ===================================================================== */

test('the drawer can be closed: the toggle is a summary and the dim is an element', async () => {
  const html = await (await req('/', 'tok-admin')).text();

  // Two glyphs, swapped by CSS: a control that opened something must visibly
  // become the control that closes it.
  assert.match(html, /<span class="d-menu"[^>]*>☰<\/span/);
  assert.match(html, /<span class="d-x"[^>]*>✕<\/span>/);

  // The dim behind the panel is a real node. It used to be `box-shadow: 0 0 0
  // 100vmax`, which paints but is never hit-tested — so every tap on the dark
  // area went through to whatever link happened to be underneath.
  assert.match(html, /<div class="drawer-scrim"/,
    'the scrim must be an element, or taps outside the drawer navigate the page');
});

test('the drawer names whose menu it is', async () => {
  const html = await (await req('/', 'tok-admin')).text();
  const panel = html.slice(html.indexOf('drawer-panel'), html.indexOf('</nav>'));
  assert.match(panel, /class="dwho"/);
  assert.match(panel, /د\. خالد الشناوي/);
  assert.match(panel, /مجلس الإدارة/,
    'the open panel covers the app bar, so the role has to be repeated inside it');
});

test('an admin sees every board destination in the drawer, and a resident none', async () => {
  const asAdmin = await (await req('/', 'tok-admin')).text();
  const board = ['/admin/review', '/admin/payments', '/admin/expenses', '/admin/fees',
                 '/admin/settlements', '/admin/members', '/admin/import', '/admin/recoveries',
                 '/admin/content', '/admin/ledger', '/admin/audit', '/admin/categories',
                 '/admin/users', '/admin/staff', '/admin/map', '/admin/settings',
                 '/admin/health'];
  for (const href of board) {
    assert.ok(asAdmin.includes(`href="${href}"`), `admin drawer is missing ${href}`);
  }

  const asResident = await (await req('/', 'tok-phone')).text();
  for (const href of board) {
    assert.ok(!asResident.includes(`href="${href}"`),
      `a resident was offered ${href} — the menu is built from can(), not from role names`);
  }
  // …but everything a resident IS entitled to is there.
  for (const href of ['/', '/me', '/pay', '/payments', '/notifications', '/finance',
                      '/map', '/news', '/albums', '/maintenance', '/search']) {
    assert.ok(asResident.includes(`href="${href}"`), `resident drawer is missing ${href}`);
  }
});

/**
 * The wide layout has its own navigation, and it was a different menu.
 *
 * At ≥900px `nav.bottom` used to become the sidebar — so a board member on a
 * tablet got the five RESIDENT tabs as their whole rail, with the other
 * twenty-four destinations behind a ☰ nobody looks for beside a sidebar. That
 * is the branch the owner photographed, and no phone screenshot shows it.
 *
 * Both shells are now built from one `menuBody`, which is what this asserts:
 * not that the sidebar exists, but that it carries the SAME links as the
 * drawer. A second copy that merely exists is how they drifted the first time.
 */
test('the wide layout gets the whole menu, not the five phone tabs', async () => {
  const html = await (await req('/', 'tok-admin')).text();

  const aside = html.slice(html.indexOf('<aside class="side">'),
                           html.indexOf('</aside>'));
  assert.ok(aside.length > 0, 'there is no wide-layout sidebar at all');

  const hrefs = (s: string) => [...s.matchAll(/href="([^"]+)"/g)].map(m => m[1]).sort();
  const panel = html.slice(html.indexOf('<nav class="drawer-panel"'),
                           html.indexOf('</details>'));
  assert.deepEqual(hrefs(aside), hrefs(panel),
    'the sidebar and the drawer are showing different menus');

  assert.match(aside, /action="\/logout"/, 'the sidebar has no sign-out');
  assert.match(aside, /class="dwho"/, 'the sidebar does not say whose it is');
});

/* ===================================================================== */
/* Signing out                                                           */
/* ===================================================================== */

test('every screen offers a way out', async () => {
  for (const path of ['/', '/finance', '/me', '/news']) {
    const html = await (await req(path, 'tok-phone')).text();
    assert.match(html, /action="\/logout"/, `${path} has no sign-out`);
    assert.match(html, /تسجيل الخروج/, `${path} does not name sign-out`);
  }
});

test('signing out ends THIS session and leaves the other device alone', async () => {
  assert.equal(live('tok-phone'), 1);
  assert.equal(live('tok-tablet'), 1);

  const res = await req('/logout', 'tok-phone', { method: 'POST' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location') ?? '', /^\/login/);
  // The cookie is cleared as well as the row — either alone is a half sign-out.
  assert.match(res.headers.get('set-cookie') ?? '', /qa_session=;/);

  assert.equal(live('tok-phone'), 0, 'the session row must be revoked, not just the cookie');
  assert.equal(live('tok-tablet'), 1, 'signing out of one device must not sign out the others');

  // And the dead token is dead: this is the assertion that would fail if
  // /logout only cleared a cookie an attacker already has a copy of.
  const after = await req('/', 'tok-phone');
  assert.equal(after.status, 302);
});

test('signing out twice is not an error', async () => {
  const res = await req('/logout', 'tok-phone', { method: 'POST' });
  assert.equal(res.status, 303);
});

test('the login screen says you signed out rather than just showing the form', async () => {
  const html = await (await req('/login?bye=1')).text();
  assert.match(html, /خرجت من حسابك/,
    'landing on a bare login form reads as being thrown out by an expired session');
});

test('sign-out is on the audit trail', () => {
  const n = (raw.prepare(
    `SELECT COUNT(*) n FROM audit_log WHERE action = 'session.close'`
  ).get() as { n: number }).n;
  assert.ok(n >= 1, 'a session ending is a security event and belongs in the log');
});
