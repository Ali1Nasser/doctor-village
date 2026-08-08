/**
 * render_screens.ts — boots the REAL app against the demo village and saves the
 * HTML it actually serves.
 *
 * This replaces the earlier standalone Python renderer, which drew the same
 * numbers with its own markup. That version could look right while the app
 * looked wrong — a preview that is not the product is a preview of nothing.
 * Everything written here is a genuine response from `createApp()`, produced by
 * the same routes, views and `lib/db/` queries a resident would hit.
 *
 * Run: npm run screens
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { NodeSqliteDb } from '../../lib/db/driver.js';
import { setTokenHasher, getCategoryNames, resolveAuthContext } from '../../lib/db/index.js';
import { createApp } from '../../src/app.js';
import { D1BlobStorage } from '../../lib/storage/d1blob.js';

const ROOT = process.cwd();
const OUT = join(ROOT, 'preview');
mkdirSync(OUT, { recursive: true });
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
raw.prepare(`UPDATE env_guard SET environment='demo', set_by='screens'`).run();
for (const f of readdirSync(join(ROOT, 'seed/demo')).sort().filter(f => f.endsWith('.sql'))) {
  raw.exec(readFileSync(join(ROOT, 'seed/demo', f), 'utf8'));
}
// make the reconciliation truthful so the demo shows a real "متطابق مع البنك"
const bank = raw.prepare(`SELECT balance_piastres b FROM v_account_balances WHERE code='1102'`)
  .get() as { b: number };
raw.prepare(`UPDATE reconciliations SET statement_balance_piastres=?, book_balance_piastres=?, difference_piastres=0`)
  .run(bank.b, bank.b);

// Open the transparency table so the units view can be seen. In production this
// stays 0 until the general assembly approves in writing (Q11 / R-002).
raw.prepare(`UPDATE settings SET unit_status_public = 1 WHERE id = 1`).run();

// a session for a resident who has paid part of their dues, and one for an admin
const resident = raw.prepare(
  `SELECT p.id FROM profiles p
     JOIN unit_owners uo ON uo.profile_id = p.id AND uo.valid_to IS NULL
     JOIN v_unit_balance ub ON ub.unit_id = uo.unit_id
    WHERE p.role='resident' AND ub.paid_piastres > 0 AND ub.outstanding_piastres > 0 LIMIT 1`
).get() as { id: string };
const admin = raw.prepare(`SELECT id FROM profiles WHERE role='admin' LIMIT 1`).get() as { id: string };
const sid = (n: number) => ('SES' + String(n).padStart(23, '0')).slice(0, 26);
raw.prepare(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`)
   .run(sid(1), resident.id, sha('tok-res'), '2027-01-01T00:00:00Z');
raw.prepare(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`)
   .run(sid(2), admin.id, sha('tok-admin'), '2027-01-01T00:00:00Z');

const db = new NodeSqliteDb(raw as never);
const NOW = () => '2026-08-04T10:00:00Z';

const adminCtx = await resolveAuthContext(db, 'tok-admin', NOW);
const cats = (await getCategoryNames(adminCtx!, db))
  .filter(c => c.id.includes('IN'))
  .map(c => ({ id: c.id, nameAr: c.name_ar, icon: c.icon ?? '•' }));

const storage = new D1BlobStorage(db);
const app = createApp({
  db, now: NOW, storage, demo: true, payCategories: cats,
  rp: { id: 'qaryat-atebaa.pages.dev', name: 'بوابة قرية الأطباء',
        origin: 'https://qaryat-atebaa.pages.dev' },
  storagePut: i => storage.put(i), storageUsedBytes: () => storage.usedBytes(),
});

// The newest published post, chosen from the data rather than hardcoded, so the
// preview never links to a slug the seed happened to stop emitting.
const newestSlug = (raw.prepare(
  `SELECT slug FROM posts WHERE published_at IS NOT NULL AND deleted_at IS NULL
    ORDER BY published_at DESC LIMIT 1`
).get() as { slug: string }).slug;

// The demo resident's own unit, so the statement screen renders real content
// rather than the 302 that `/payments/statement` correctly returns.
const residentUnit = (raw.prepare(
  `SELECT unit_id FROM unit_owners WHERE profile_id = ? AND valid_to IS NULL LIMIT 1`
).get(resident.id) as { unit_id: string }).unit_id;

const SCREENS: [string, string, string][] = [
  ['login',   '/login',         ''],
  ['home',    '/',              'tok-res'],
  ['pay1',    '/pay/1',         'tok-res'],
  ['pay2',    '/pay/2',         'tok-res'],
  ['pay3',    '/pay/3',         'tok-res'],
  ['payments','/payments',      'tok-res'],
  ['inbox',   '/notifications', 'tok-res'],
  ['finance', '/finance',       'tok-res'],
  ['units',   '/finance/units', 'tok-res'],
  ['health',  '/admin/health',  'tok-admin'],
  ['expenses','/admin/expenses','tok-admin'],
  ['approved','/admin/payments','tok-admin'],
  ['review',  '/admin/review',  'tok-admin'],
  // CP-6
  ['news',     '/news',            'tok-res'],
  ['post',     '/news/' + encodeURIComponent(newestSlug), 'tok-res'],
  ['archive',  '/news/archive',    'tok-res'],
  ['month',    '/news/archive/2024/08', 'tok-res'],
  ['search',   '/search?q=' + encodeURIComponent('الميزانية التقديرية'), 'tok-res'],
  ['albums',   '/albums',          'tok-res'],
  ['album',    '/albums/DEMOALB0000000000000000001', 'tok-res'],
  ['tickets',  '/maintenance',     'tok-res'],
  ['publish',  '/admin/content',   'tok-admin'],
  ['members',  '/admin/members',   'tok-admin'],
  ['fees',       '/admin/fees',       'tok-admin'],
  ['categories', '/admin/categories', 'tok-admin'],
  ['users',      '/admin/users',      'tok-admin'],
  ['settings',   '/admin/settings',   'tok-admin'],
  ['staff',      '/admin/staff',      'tok-admin'],
  ['audit',      '/admin/audit',      'tok-admin'],
  ['ledger',     '/admin/ledger',     'tok-admin'],
  ['me',         '/me',               'tok-res'],
  ['import',     '/admin/import',     'tok-admin'],
  ['recoveries', '/admin/recoveries', 'tok-admin'],
  ['settlements','/admin/settlements','tok-admin'],
  ['help',       '/help',            'tok-res'],
  ['map',        '/map',             'tok-res'],
  ['building',   '/buildings/DEMOBLD0000000000000000009', 'tok-res'],
  ['adminmap',   '/admin/map',       'tok-admin'],
  // The board's own home. `home` above is the resident's; an admin sees the
  // same page plus the board-tools card, and that card is the only route into
  // every /admin/* screen — so it gets rendered and looked at, not assumed.
  ['home-admin', '/',              'tok-admin'],
  ['statement',`/units/${residentUnit}/statement`, 'tok-res'],
  ['notfound','/nope',          'tok-res'],
];

let failed = 0;
/**
 * The preview is static files opened with `file://`, so a `/map/image/...` src
 * cannot resolve and the plan renders as a broken-image icon — which would make
 * the one screen whose whole point is the picture the one screen the preview
 * cannot show. Inlining it here keeps the rendered artefact honest.
 */
const MAP_DATA_URI = 'data:image/webp;base64,'
  + readFileSync(join(ROOT, 'assets/maps/village-map-display.webp')).toString('base64');

for (const [name, path, token] of SCREENS) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await app.request(path, { headers });
  const body = (await res.text()).replaceAll(/src="\/map\/image\/[^"]*"/g, `src="${MAP_DATA_URI}"`);
  const ok = res.status < 400 || name === 'notfound';
  if (!ok) { failed++; console.error(`  ✗ ${name} ${path} -> ${res.status}`); }
  writeFileSync(join(OUT, `${name}.html`), body, 'utf8');
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(9)} ${String(res.status).padEnd(4)} ${path}`);
}

// One page that stitches them together, so the board can scroll the whole thing.
const frames = SCREENS.map(([n]) =>
  `<figure><figcaption>${n}</figcaption><iframe src="./${n}.html" title="${n}"></iframe></figure>`).join('');
writeFileSync(join(OUT, 'index.html'), `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>بوابة قرية الأطباء — كل الشاشات</title>
<style>
 body{margin:0;background:#e9e7e2;font-family:"IBM Plex Sans Arabic","Noto Sans Arabic",sans-serif}
 h1{text-align:center;padding:16px;margin:0;font-size:1.2rem}
 .note{max-width:880px;margin:0 auto 16px;padding:12px 16px;background:#FBEFD9;color:#A96A00;
   border-radius:12px;font-size:.9rem}
 .wrap{display:flex;flex-wrap:wrap;gap:20px;justify-content:center;padding:0 16px 40px}
 figure{margin:0}
 figcaption{text-align:center;font-size:.8rem;color:#5B615C;padding-block-end:6px;direction:ltr}
 iframe{inline-size:390px;block-size:780px;border:1px solid #cfcbc3;border-radius:22px;background:#fff}
</style></head><body>
<h1>بوابة قرية الأطباء — الشاشات كلها</h1>
<div class="note">⚠️ كل الأرقام والأسماء متخيّلة. الصفحات دي مخرجات التطبيق الحقيقي فعلاً،
مش رسم منفصل — نفس الراوتس ونفس الاستعلامات اللي الساكن هيشوفها.</div>
<div class="wrap">${frames}</div>
</body></html>`, 'utf8');

console.log(`\n  wrote ${SCREENS.length} screens + index.html to preview/`);
if (failed) { console.error(`  ${failed} screen(s) errored`); process.exit(1); }
