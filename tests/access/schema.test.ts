/**
 * tests/access/schema.test.ts — the check that would have caught R-125.
 *
 * The receipts database went live created, bound, and never migrated. Every
 * receipt upload on the deployed site answered 500 with
 * `no such table: v_blob_usage`, from the first deployment until somebody drove
 * the site in a browser months later. Nothing could see it: no screen a board
 * member opens touches that view, and locally both bindings point at the same
 * SQLite file, which has everything.
 *
 * So `/admin/health` now asks each database whether it holds what the app
 * needs. Three things have to be true for that to be worth anything, and each
 * is a test below:
 *
 *   1. the expectation is DERIVED from `migrations/`, not hand-kept — a list
 *      somebody has to remember to update goes quiet exactly when it matters;
 *   2. the check actually reports a missing object, including a missing
 *      TRIGGER, which is the failure that never announces itself;
 *   3. a resident cannot read it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NodeSqliteDb } from '../../lib/db/driver.js';
import { setTokenHasher, resolveAuthContext } from '../../lib/db/index.js';
import { checkSchema, checkDeployedSchema, LEDGER_SCHEMA, RECEIPTS_SCHEMA }
  from '../../lib/db/schema.js';
import { Forbidden } from '../../lib/rbac.js';
import type { AuthContext } from '../../types/domain.js';

const ROOT = process.cwd();
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
setTokenHasher(sha);

/** A database with every migration applied — what a correct deployment holds. */
const fullDb = () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).sort()) {
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  return raw;
};

/* ===================================================================== */

/**
 * The manifest is generated, and this is what stops it drifting.
 *
 * Re-runs the generator into a temporary file and compares. A migration that
 * adds a table now fails here until `npm run gen:schema` has been run — which
 * is the whole difference between a mechanism and an intention (ADR-010).
 */
test('the manifest still matches the migrations', () => {
  const manifest = join(ROOT, 'lib/db/schema-manifest.ts');
  const before = readFileSync(manifest, 'utf8');
  try {
    execFileSync('node', [join(ROOT, 'tools/gen-schema-manifest.mjs')],
      { cwd: ROOT, stdio: 'pipe' });
    const after = readFileSync(manifest, 'utf8');
    assert.equal(after, before,
      'lib/db/schema-manifest.ts is out of date — run `npm run gen:schema` and commit it');
  } finally {
    writeFileSync(manifest, before, 'utf8');
  }
});

/**
 * `0026` rebuilds `auth_attempts`: it creates `auth_attempts_new`, drops the
 * original and renames. A generator that greps for CREATE would list a table
 * that does not exist and report a healthy database as broken forever.
 */
test('a table that was renamed away is not expected under its old name', () => {
  assert.ok(LEDGER_SCHEMA.tables.includes('auth_attempts'));
  assert.ok(!LEDGER_SCHEMA.tables.includes('auth_attempts_new'),
    'the manifest expects a scaffolding table that migration 0026 dropped');
});

test('a fully migrated database reports nothing missing', async () => {
  const raw = fullDb();
  const r = await checkSchema(new NodeSqliteDb(raw as never), LEDGER_SCHEMA, 'ledger');
  assert.deepEqual(r.missing, [], 'a correct database was reported broken');
  assert.equal(r.unreachable, false);
  assert.ok(r.expected > 100, 'the manifest is suspiciously small');
});

/**
 * ⭐ R-125 itself, reproduced: the receipts database as it actually shipped —
 * created, bound, and holding nothing at all.
 */
test('the empty receipts database is reported, by name', async () => {
  const raw = new DatabaseSync(':memory:');            // exactly what shipped
  const r = await checkSchema(new NodeSqliteDb(raw as never), RECEIPTS_SCHEMA, 'receipts');
  assert.equal(r.missing.length, r.expected, 'an empty database looked healthy');
  assert.ok(r.missing.some(m => m.name === 'v_blob_usage'),
    'the view whose absence broke every upload is not named');
  assert.ok(r.missing.some(m => m.name === 'receipt_blobs'));
});

/**
 * The failure that does not announce itself. A missing table breaks the query;
 * a missing trigger lets the write succeed with the rule silently gone —
 * which, in a project that deliberately puts its controls in the schema
 * (ADR-024), is the most expensive thing that can quietly not be there.
 */
test('a missing trigger is reported — the control that fails silently', async () => {
  const raw = fullDb();
  raw.exec('DROP TRIGGER trg_entry_balanced');
  raw.exec('DROP TRIGGER trg_no_real_payments_in_demo');

  const r = await checkSchema(new NodeSqliteDb(raw as never), LEDGER_SCHEMA, 'ledger');
  const names = r.missing.map(m => m.name);
  assert.deepEqual(names.sort(), ['trg_entry_balanced', 'trg_no_real_payments_in_demo']);
  assert.ok(r.missing.every(m => m.kind === 'trigger'));
});

test('D1 bookkeeping tables are not reported as strays', async () => {
  const raw = fullDb();
  // Cloudflare creates this in every D1 database; it is not ours and a report
  // that mentions it teaches the reader to skim.
  raw.exec('CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)');
  const r = await checkSchema(new NodeSqliteDb(raw as never), LEDGER_SCHEMA, 'ledger');
  assert.deepEqual(r.missing, []);
});

test('a database that cannot be read is unreachable, not empty', async () => {
  const broken = {
    prepare() { throw new Error('no such binding'); },
    batch() { throw new Error('no such binding'); },
  } as never;
  const r = await checkSchema(broken, RECEIPTS_SCHEMA, 'receipts');
  assert.equal(r.unreachable, true);
  assert.deepEqual(r.missing, [], 'an unreadable database was reported as missing everything');
});

/* ---- who may ask -------------------------------------------------------- */

test('a resident cannot read the shape of the database', async () => {
  const raw = fullDb();
  const pid = (p: string, n: number) => (p + String(n).padStart(23, '0')).slice(0, 26);
  const RES = pid('PRF', 1), ADMIN = pid('PRF', 2);
  raw.prepare(`INSERT INTO profiles (id, full_name, role) VALUES (?,?, 'resident')`)
     .run(RES, 'د. عمرو شاهين');
  raw.prepare(`INSERT INTO profiles (id, full_name, role) VALUES (?,?, 'admin')`)
     .run(ADMIN, 'د. خالد الشناوي');
  for (const [n, who, tok] of [[1, RES, 'tok-res'], [2, ADMIN, 'tok-admin']] as const) {
    raw.prepare(`INSERT INTO sessions (id, profile_id, token_hash, expires_at) VALUES (?,?,?,?)`)
       .run(pid('SES', n), who, sha(tok), '2027-01-01T00:00:00Z');
  }
  const db = new NodeSqliteDb(raw as never);
  const NOW = () => '2026-08-09T10:00:00Z';
  const res = await resolveAuthContext(db, 'tok-res', NOW) as AuthContext;
  const admin = await resolveAuthContext(db, 'tok-admin', NOW) as AuthContext;

  await assert.rejects(() => checkDeployedSchema(res, db, null), (e: unknown) => e instanceof Forbidden,
    'a resident read the internal shape of the database');
  const ok = await checkDeployedSchema(admin, db, null);
  assert.equal(ok.length, 1, 'with no second database, only one report is produced');
  assert.deepEqual(ok[0]!.missing, []);
});
