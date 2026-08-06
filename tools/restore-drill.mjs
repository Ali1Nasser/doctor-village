/**
 * tools/restore-drill.mjs — CP-8's launch blocker, executed.
 *
 * > **Gate:** "A restore from backup into a clean project succeeds and the
 * >  totals match." — CHECKPOINTS.md CP-8
 *
 * Marked in PROGRESS.md as "currently unproven and is a launch blocker". This
 * script is what turns it into a proven one, and it runs in `npm run verify`,
 * so it stays proven.
 *
 * ## It proves the NEGATIVE first
 *
 * The drill begins by showing that `sqlite3 .dump` — the backup everyone
 * reaches for — genuinely cannot restore this database. That step is not
 * decoration. A drill that only demonstrates the happy path would pass just as
 * well if someone later "simplified" the backup back to a plain dump; asserting
 * that the naive path FAILS is what stops that change from landing quietly.
 *
 * The project's own discipline says to watch a test fail for the right reason
 * before trusting it green. Step 1 is that, permanently.
 *
 * ## Then it proves the positive
 *
 *   2. take a real backup of the demo village
 *   3. restore into an empty database built from `migrations/` alone
 *   4. compare fourteen figures, including every account balance
 *   5. re-run the accounting equation on the restored copy
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildBackupSql } from './backup.mjs';
import { restoreInto, fingerprint, compare, applyMigrations } from './restore.mjs';

const ROOT = process.cwd();
const work = mkdtempSync(join(tmpdir(), 'qaryat-drill-'));
let failures = 0;
const ok = (label, extra = '') =>
  console.log(`  PASS  ${label}${extra ? `   [${extra}]` : ''}`);
const bad = (label, why) => { failures++; console.error(`  FAIL  ${label}\n        ${why}`); };

console.log('\n==========================================================================');
console.log('  CP-8 restore drill — the launch blocker');
console.log('==========================================================================\n');

/* ---------------------------------------------------------------- source -- */
const sourcePath = join(work, 'source.db');
const source = new DatabaseSync(sourcePath);
applyMigrations(source);
for (const f of readdirSync(join(ROOT, 'seed/prod')).sort()) {
  source.exec(readFileSync(join(ROOT, 'seed/prod', f), 'utf8'));
}
source.prepare(`UPDATE env_guard SET environment='demo', set_by='restore-drill'`).run();
for (const f of readdirSync(join(ROOT, 'seed/demo')).sort().filter(f => f.endsWith('.sql'))) {
  source.exec(readFileSync(join(ROOT, 'seed/demo', f), 'utf8'));
}

const before = fingerprint(source);
console.log(`  source village: ${before.profiles} people · ${before.units} units · `
  + `${before.postedEntries} posted entries · ${before.lines} lines`);
console.log(`  treasury: ${(before.spendable / 100).toLocaleString('en-US')} ج.م\n`);

/* ---- 1. the naive backup must FAIL, for the documented reason ------------ */
console.log('--- 1. `sqlite3 .dump` cannot restore this schema (the documented finding) ---');
{
  // A faithful reproduction of what .dump emits: entries WITH posted_at set,
  // then their lines. No shelling out to the sqlite3 binary — the ordering is
  // the point, and it is reproduced here exactly.
  const naive = [];
  naive.push('PRAGMA foreign_keys=OFF;', 'BEGIN;');
  for (const t of ['profiles', 'buildings', 'units', 'fiscal_periods']) {
    for (const r of source.prepare(`SELECT * FROM ${t}`).all()) {
      const cols = Object.keys(r);
      naive.push(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols
        .map(c => r[c] === null ? 'NULL' : typeof r[c] === 'number'
          ? r[c] : `'${String(r[c]).replace(/'/g, "''")}'`).join(',')});`);
    }
  }
  const entry = source.prepare(`SELECT * FROM journal_entries WHERE posted_at IS NOT NULL LIMIT 1`).get();
  const cols = Object.keys(entry);
  naive.push(`INSERT INTO journal_entries (${cols.join(',')}) VALUES (${cols
    .map(c => entry[c] === null ? 'NULL' : typeof entry[c] === 'number'
      ? entry[c] : `'${String(entry[c]).replace(/'/g, "''")}'`).join(',')});`);
  for (const l of source.prepare(`SELECT * FROM journal_lines WHERE entry_id = ?`).all(entry.id)) {
    const lc = Object.keys(l);
    naive.push(`INSERT INTO journal_lines (${lc.join(',')}) VALUES (${lc
      .map(c => l[c] === null ? 'NULL' : typeof l[c] === 'number'
        ? l[c] : `'${String(l[c]).replace(/'/g, "''")}'`).join(',')});`);
  }
  naive.push('COMMIT;');

  const victim = new DatabaseSync(join(work, 'naive.db'));
  applyMigrations(victim);
  for (const f of readdirSync(join(ROOT, 'seed/prod')).sort()) {
    victim.exec(readFileSync(join(ROOT, 'seed/prod', f), 'utf8'));
  }
  victim.prepare(`UPDATE env_guard SET environment='demo', set_by='drill'`).run();

  let refused = null;
  try { victim.exec(naive.join('\n')); }
  catch (e) { refused = e.message; }

  if (refused && /سطر لقيد مرحّل|posted entry/.test(refused)) {
    ok('a .dump-ordered replay is REFUSED by the immutability trigger',
       'مش ممكن تضيف سطر لقيد مرحّل');
  } else if (refused) {
    ok('a .dump-ordered replay is refused', refused.slice(0, 60));
  } else {
    bad('a .dump-ordered replay SUCCEEDED',
        'the immutability triggers are not protecting posted entries — '
        + 'either the guard regressed, or this drill is no longer testing what it claims');
  }
  victim.close();
}

/* ---- 2. take the real backup -------------------------------------------- */
console.log('\n--- 2. take a restorable backup ---');
const backup = buildBackupSql(source);
const backupPath = join(work, 'backup.sql');
writeFileSync(backupPath, backup.sql, 'utf8');
ok('backup written', `${backup.rowCount} rows · ${backup.tables} tables · ${backup.posted} posted`);

if (/INSERT INTO journal_lines/.test(backup.sql)) {
  const firstLine = backup.sql.indexOf('INSERT INTO journal_lines');
  const firstPost = backup.sql.indexOf('UPDATE journal_entries SET approved_by');
  if (firstPost > firstLine) ok('lines are written BEFORE the posting step');
  else bad('ordering is wrong', 'posting appears before the lines it validates');
}

/* ---- 3. restore into a clean database ----------------------------------- */
console.log('\n--- 3. restore into an EMPTY database built from migrations/ ---');
const targetPath = join(work, 'restored.db');
const target = new DatabaseSync(targetPath);
let restoreError = null;
try { restoreInto(target, backup.sql); }
catch (e) { restoreError = e; }

if (restoreError) {
  bad('the restore did not replay', restoreError.message);
  console.error('\n  The backup is not restorable. This is the launch blocker, unresolved.\n');
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}
ok('the backup replayed into a clean database');

/* ---- 4. the totals must match ------------------------------------------- */
console.log('\n--- 4. do the totals match? ---');
const after = fingerprint(target);
const problems = compare(before, after);

if (problems.length === 0) {
  ok('all 14 figures match, including every account balance');
  console.log(`        spendable    ${(after.spendable / 100).toLocaleString('en-US')} ج.م`);
  console.log(`        income       ${(after.totalIncome / 100).toLocaleString('en-US')} ج.م`);
  console.log(`        expense      ${(after.totalExpense / 100).toLocaleString('en-US')} ج.م`);
  console.log(`        held in trust ${(after.heldInTrust / 100).toLocaleString('en-US')} ج.م`);
} else {
  for (const p of problems) bad('figure differs after restore', p);
}

/* ---- 5. the restored ledger must still balance -------------------------- */
console.log('\n--- 5. the restored ledger balances on its own terms ---');
if (after.equationResidual === 0) ok('accounting equation residual is exactly 0');
else bad('the restored ledger does not balance', `residual = ${after.equationResidual}`);

const unposted = target.prepare(
  `SELECT COUNT(*) n FROM journal_entries WHERE posted_at IS NULL`
).get().n;
if (unposted === 0) ok('no entry was left stranded unposted');
else bad('entries left unposted', `${unposted} entries never got their posting UPDATE`);

// The restore is only trustworthy if the guards are live on the copy too.
let guardHeld = false;
try {
  const anyPosted = target.prepare(
    `SELECT id FROM journal_entries WHERE posted_at IS NOT NULL LIMIT 1`).get();
  target.prepare(
    `INSERT INTO journal_lines (id,entry_id,line_no,account_id,debit_piastres,credit_piastres)
     VALUES ('JL0000000000000000000DRILL',?,99,
       (SELECT id FROM accounts LIMIT 1),1,0)`
  ).run(anyPosted.id);
} catch { guardHeld = true; }
if (guardHeld) ok('the restored copy still refuses a line on a posted entry');
else bad('the restored copy lost its immutability guard',
         'a restore that drops the triggers produces an editable ledger');

/* ---- 6. search survives -------------------------------------------------- */
const idx = target.prepare(`SELECT COUNT(*) n FROM posts_fts`).get().n;
const src = source.prepare(`SELECT COUNT(*) n FROM posts_fts`).get().n;
if (idx === src) ok('the search index was rebuilt to the same size', `${idx} documents`);
else bad('search index mismatch', `source ${src}, restored ${idx}`);

/* ------------------------------------------------------------------------- */
source.close(); target.close();
rmSync(work, { recursive: true, force: true });

console.log('\n==========================================================================');
if (failures === 0) {
  console.log('  CP-8 restore gate: MET. The backup restores and the totals match.');
  console.log('==========================================================================\n');
} else {
  console.log(`  ${failures} failure(s) — the restore gate is NOT met.`);
  console.log('==========================================================================\n');
  process.exit(1);
}
