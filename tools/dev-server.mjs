/**
 * tools/dev-server.mjs — the REAL app, on a real HTTP port, against the demo
 * village, with one session per role.
 *
 * `npm run screens` already renders every page, but it renders them by calling
 * `app.request()` in-process and writing the HTML to a file. That proves the
 * server produces the right markup; it proves nothing about what a browser
 * does with it — a drawer that does not open, a form that posts nowhere, a
 * button covered by the header. Those are the defects a board member actually
 * hits, and none of them are visible in a saved `.html`.
 *
 * So: a real port, a real cookie jar, a real browser. Everything here is the
 * production code path — `createApp()`, the same routes, the same `lib/db/`
 * queries. The only things added are the demo data and five pre-opened
 * sessions, printed on startup so a driver script can pick a role.
 *
 *   node tools/dev-server.mjs [port]
 *
 * ⚠️ DEMO ONLY. It seeds `seed/demo/`, whose every figure is invented, and it
 * mints sessions without a credential. `migrations/0006` makes loading demo ids
 * into a production database impossible, which is the backstop; this file is
 * not one and must never point at a real database.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';

import { NodeSqliteDb } from '../.build/lib/db/driver.js';
import { setTokenHasher, getCategoryNames, resolveAuthContext } from '../.build/lib/db/index.js';
import { createApp } from '../.build/src/app.js';
import { D1BlobStorage } from '../.build/lib/storage/d1blob.js';

const ROOT = process.cwd();
const PORT = Number(process.argv[2] ?? 8787);
const sha = t => createHash('sha256').update(t).digest('hex');
setTokenHasher(sha);

const raw = new DatabaseSync(':memory:');
raw.exec('PRAGMA foreign_keys = ON');
for (const f of readdirSync(join(ROOT, 'migrations')).sort()) {
  raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
}
for (const f of readdirSync(join(ROOT, 'seed/prod')).sort()) {
  raw.exec(readFileSync(join(ROOT, 'seed/prod', f), 'utf8'));
}
raw.prepare(`UPDATE env_guard SET environment='demo', set_by='dev-server'`).run();
for (const f of readdirSync(join(ROOT, 'seed/demo')).sort().filter(f => f.endsWith('.sql'))) {
  raw.exec(readFileSync(join(ROOT, 'seed/demo', f), 'utf8'));
}

// Same two adjustments `render_screens` makes, for the same reasons: a
// reconciliation that actually reconciles, and the per-flat table opened so it
// can be looked at. In production the second stays shut until the general
// assembly approves in writing (Q11 / R-002).
const bank = raw.prepare(`SELECT balance_piastres b FROM v_account_balances WHERE code='1102'`).get();
raw.prepare(`UPDATE reconciliations SET statement_balance_piastres=?, book_balance_piastres=?, difference_piastres=0`)
   .run(bank.b, bank.b);
raw.prepare(`UPDATE settings SET unit_status_public = 1 WHERE id = 1`).run();

/**
 * One session per role, because "does it work" has five different answers.
 *
 * The resident is chosen by DATA rather than by id — somebody with dues, a part
 * payment and an outstanding balance — so the money screens have something to
 * show. A resident with a clean sheet renders five empty states and tells you
 * nothing.
 */
const pick = sql => raw.prepare(sql).get();
const resident = pick(`
  SELECT p.id FROM profiles p
    JOIN unit_owners uo ON uo.profile_id = p.id AND uo.valid_to IS NULL
    JOIN v_unit_balance ub ON ub.unit_id = uo.unit_id
   WHERE p.role='resident' AND ub.paid_piastres > 0 AND ub.outstanding_piastres > 0 LIMIT 1`);

const WHO = {
  developer: pick(`SELECT id FROM profiles WHERE role='developer' AND is_active=1 LIMIT 1`),
  admin: pick(`SELECT id FROM profiles WHERE role='admin' AND is_active=1 LIMIT 1`),
  // The second admin, for anything that needs two different people.
  admin2: pick(`SELECT id FROM profiles WHERE role='admin' AND is_active=1
                 ORDER BY id DESC LIMIT 1`),
  operator: pick(`SELECT id FROM profiles WHERE role='operator' AND is_active=1 LIMIT 1`),
  finance_reviewer: pick(`SELECT id FROM profiles WHERE role='finance_reviewer' AND is_active=1 LIMIT 1`),
  resident,
};

let n = 0;
const TOKENS = {};
for (const [role, row] of Object.entries(WHO)) {
  if (!row) { console.error(`  ⚠ no ${role} in the demo seed`); continue; }
  const token = `tok-${role}`;
  raw.prepare(`INSERT INTO sessions (id, profile_id, token_hash, expires_at) VALUES (?,?,?,?)`)
     .run(('SES' + String(++n).padStart(23, '0')).slice(0, 26), row.id, sha(token),
          '2027-01-01T00:00:00Z');
  TOKENS[role] = { token, profileId: row.id };
}

const db = new NodeSqliteDb(raw);
const NOW = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

const adminCtx = await resolveAuthContext(db, 'tok-admin', NOW);
const cats = (await getCategoryNames(adminCtx, db))
  .filter(c => c.id.includes('IN'))
  .map(c => ({ id: c.id, nameAr: c.name_ar, icon: c.icon ?? '•' }));

const storage = new D1BlobStorage(db);
const app = createApp({
  db, now: NOW, storage, demo: true, payCategories: cats,
  rp: { id: 'localhost', name: 'بوابة قرية الأطباء', origin: `http://localhost:${PORT}` },
  storagePut: i => storage.put(i), storageUsedBytes: () => storage.usedBytes(),
});

/** Everything a driver script needs to log in as somebody, in one fetch. */
app.get('/__roles', c => c.json({
  tokens: TOKENS,
  residentUnit: pick(`SELECT unit_id FROM unit_owners WHERE profile_id='${resident.id}' AND valid_to IS NULL LIMIT 1`)?.unit_id,
  newestSlug: pick(`SELECT slug FROM posts WHERE published_at IS NOT NULL AND deleted_at IS NULL
                     ORDER BY published_at DESC LIMIT 1`)?.slug,
  albumId: pick(`SELECT id FROM albums WHERE published_at IS NOT NULL LIMIT 1`)?.id,
  buildingId: pick(`SELECT id FROM buildings LIMIT 1`)?.id,
  // The demo's review queue is `under_review`, not `submitted` — the seed puts
  // receipts in the state a board member actually finds them in.
  pendingPaymentId: pick(`SELECT id FROM payments WHERE status='under_review' LIMIT 1`)?.id,
  approvedPaymentId: pick(`SELECT id FROM payments WHERE status='approved' LIMIT 1`)?.id,
  postedExpenseId: pick(`SELECT id FROM expenses WHERE status='posted' LIMIT 1`)?.id,
  ticketId: pick(`SELECT id FROM maintenance_tickets LIMIT 1`)?.id,
  someMemberId: pick(`SELECT id FROM profiles WHERE role='resident' AND is_active=1
                       ORDER BY id DESC LIMIT 1`)?.id,
}));

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, info => {
  console.log(`  demo village on http://127.0.0.1:${info.port}`);
  for (const [role, v] of Object.entries(TOKENS)) console.log(`    ${role.padEnd(17)} ${v.token}`);
});
