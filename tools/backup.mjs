/**
 * tools/backup.mjs — a backup that can actually be restored.
 *
 * ## Why `sqlite3 .dump` is not the backup for this database
 *
 * CHECKPOINTS.md CP-8 records the discovery, and it is the reason this file
 * exists rather than a one-line shell alias:
 *
 *   > `sqlite3 .dump` is NOT a valid restore path here — the immutability
 *   > triggers refuse a journal line inserted into an already-posted entry, so
 *   > a dump replays in the wrong order and fails.
 *
 * A `.dump` emits `journal_entries` rows with `posted_at` already set, then the
 * `journal_lines` that belong to them. On replay, `trg_line_no_insert_posted`
 * refuses every single line — «مش ممكن تضيف سطر لقيد مرحّل». The backup looks
 * perfect, is verified by nobody, and fails on the one day it is needed. A
 * village treasury with an unrestorable backup has no backup.
 *
 * ## The shape that does work
 *
 * The same order the ledger itself writes in, because the triggers encode that
 * order deliberately:
 *
 *   1. migrations (schema only — never a dumped schema, so a restore lands on
 *      the CURRENT constraints rather than the ones in force at backup time)
 *   2. reference and parent rows, in foreign-key topological order
 *   3. `fiscal_periods` forced OPEN, whatever they were — a closed period
 *      refuses journal entries (`trg_entry_period_open`)
 *   4. `journal_entries` with `posted_at` and `approved_by` NULL
 *   5. `journal_lines` — legal now, because the entries are unposted
 *   6. **POST**: `UPDATE … SET approved_by, posted_at`, which is where
 *      `trg_entry_balanced` re-validates every entry: ≥2 lines, debits =
 *      credits, period open
 *   7. periods restored to their real status
 *
 * Step 6 is the payoff. A restore does not merely reload bytes — it re-proves
 * every entry balances, through the same trigger that guarded the original
 * write. A corrupted backup cannot restore quietly.
 *
 * ## Ordering is computed, not hardcoded
 *
 * The table order comes from `PRAGMA foreign_key_list` at runtime. A hardcoded
 * list is correct on the day it is written and silently wrong after the next
 * migration adds a table — and "silently wrong" is the failure mode this whole
 * file exists to remove.
 *
 * Usage:
 *   node tools/backup.mjs <source.db> <out.sql>
 */

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

/** Tables whose rows the migrations themselves insert. Restoring these needs
 *  INSERT OR REPLACE, because the row already exists on a fresh schema. */
const PREPOPULATED = new Set(['settings', 'env_guard', 'payment_transitions', 'notifications_new']);

/** Contentless/derived tables rebuilt from their source rows, never restored. */
const DERIVED = new Set(['posts_fts', 'albums_fts',
  'posts_fts_data', 'posts_fts_idx', 'posts_fts_content', 'posts_fts_docsize', 'posts_fts_config',
  'albums_fts_data', 'albums_fts_idx', 'albums_fts_content', 'albums_fts_docsize', 'albums_fts_config']);

export function listTables(db) {
  return db.prepare(
    `SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name`
  ).all().map(r => r.name).filter(n => !DERIVED.has(n));
}

/**
 * Topological sort on foreign keys: a table comes after every table it points
 * at. Self-references are ignored (a row order problem, not a table order one).
 * A cycle between two tables falls back to alphabetical rather than looping
 * forever — and is reported, because it would mean the schema gained a cycle
 * that a restore cannot satisfy without deferred constraints.
 */
export function topologicalOrder(db, tables) {
  const deps = new Map(tables.map(t => [t, new Set()]));
  for (const t of tables) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(t)})`).all()) {
      if (fk.table !== t && deps.has(fk.table)) deps.get(t).add(fk.table);
    }
  }
  const out = [];
  const done = new Set();
  let progressed = true;
  while (out.length < tables.length && progressed) {
    progressed = false;
    for (const t of tables) {
      if (done.has(t)) continue;
      if ([...deps.get(t)].every(d => done.has(d))) {
        out.push(t); done.add(t); progressed = true;
      }
    }
  }
  if (out.length < tables.length) {
    const stuck = tables.filter(t => !done.has(t));
    console.warn(`  ⚠ foreign-key cycle among: ${stuck.join(', ')} — appended alphabetically`);
    out.push(...stuck);
  }
  return out;
}

const lit = v => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'bigint') return String(v);
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString('hex')}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};

export function buildBackupSql(db) {
  const tables = topologicalOrder(db, listTables(db));
  const lines = [];
  const P = s => lines.push(s);

  P('-- =============================================================');
  P('-- بوابة قرية الأطباء — نسخة احتياطية قابلة للاستعادة فعلًا');
  P('-- Restorable backup. Generated by tools/backup.mjs.');
  P('--');
  P('-- Restore with: node tools/restore.mjs <this-file> <new.db>');
  P('-- Do NOT replay this against a database that already holds data.');
  P('-- Do NOT use sqlite3 .dump as a substitute — see the header of');
  P('-- tools/backup.mjs for why it cannot restore this schema.');
  P(`-- Taken at: ${new Date().toISOString()}`);
  P('-- =============================================================');
  P('');
  P('PRAGMA foreign_keys = OFF;');
  P('BEGIN;');
  P('');

  // The environment label goes first: the demo guards (`trg_no_demo_*`) refuse
  // DEMO-prefixed ids on a production-labelled database, so the label must be
  // in place before a single row lands. demo -> production is refused by
  // trg_env_guard_no_promote, which is correct and is why restore never tries.
  const env = db.prepare(`SELECT * FROM env_guard LIMIT 1`).get();
  if (env) {
    P('-- environment label first — the demo guards read it on every insert');
    P(`UPDATE env_guard SET environment=${lit(env.environment)}, set_by=${lit(env.set_by)};`);
    P('');
  }

  let rowCount = 0;
  for (const table of tables) {
    if (table === 'journal_entries' || table === 'journal_lines') continue; // phased below
    const rows = db.prepare(`SELECT * FROM ${JSON.stringify(table)}`).all();
    if (rows.length === 0) continue;

    const cols = Object.keys(rows[0]);
    const verb = PREPOPULATED.has(table) ? 'INSERT OR REPLACE INTO' : 'INSERT INTO';
    P(`-- ${table} (${rows.length})`);

    if (table === 'fiscal_periods') {
      // Forced open for the duration of the restore; real status reapplied at
      // the end. A closed period refuses journal entries outright.
      P(`--   ↑ inserted as 'open'; real status reapplied after posting`);
      for (const r of rows) {
        const vals = cols.map(c => (c === 'status' ? `'open'` : lit(r[c])));
        P(`${verb} ${table} (${cols.join(',')}) VALUES (${vals.join(',')});`);
        rowCount++;
      }
    } else {
      for (const r of rows) {
        P(`${verb} ${table} (${cols.join(',')}) VALUES (${cols.map(c => lit(r[c])).join(',')});`);
        rowCount++;
      }
    }
    P('');
  }

  // ---- the ledger, in the only order the triggers accept -------------------
  const entries = db.prepare(`SELECT * FROM journal_entries`).all();
  if (entries.length > 0) {
    const cols = Object.keys(entries[0]);
    P(`-- journal_entries (${entries.length}) — UNPOSTED and UNAPPROVED first.`);
    P('--   trg_line_no_insert_posted refuses a line on a posted entry, so the');
    P('--   posting columns are deliberately withheld until the lines are in.');
    for (const e of entries) {
      const vals = cols.map(c =>
        (c === 'posted_at' || c === 'approved_by') ? 'NULL' : lit(e[c]));
      P(`INSERT INTO journal_entries (${cols.join(',')}) VALUES (${vals.join(',')});`);
      rowCount++;
    }
    P('');
  }

  const lineRows = db.prepare(`SELECT * FROM journal_lines ORDER BY entry_id, line_no`).all();
  if (lineRows.length > 0) {
    const cols = Object.keys(lineRows[0]);
    P(`-- journal_lines (${lineRows.length}) — legal now: every entry is unposted.`);
    for (const l of lineRows) {
      P(`INSERT INTO journal_lines (${cols.join(',')}) VALUES (${cols.map(c => lit(l[c])).join(',')});`);
      rowCount++;
    }
    P('');
  }

  // ---- POST: the step that re-proves the whole ledger ----------------------
  const posted = entries.filter(e => e.posted_at !== null);
  P(`-- POST ${posted.length} entries. trg_entry_balanced re-validates EACH one:`);
  P('--   >= 2 lines, SUM(debit) = SUM(credit), fiscal period open.');
  P('--   A corrupted backup fails HERE, loudly, instead of restoring quietly.');
  for (const e of posted) {
    P(`UPDATE journal_entries SET approved_by=${lit(e.approved_by)}, `
      + `posted_at=${lit(e.posted_at)} WHERE id=${lit(e.id)};`);
  }
  P('');

  // ---- reapply the real period statuses ------------------------------------
  const periods = db.prepare(`SELECT id, status FROM fiscal_periods WHERE status <> 'open'`).all();
  if (periods.length > 0) {
    P('-- periods restored to their real status, now that posting is done');
    for (const p of periods) {
      P(`UPDATE fiscal_periods SET status=${lit(p.status)} WHERE id=${lit(p.id)};`);
    }
    P('');
  }

  P('COMMIT;');
  P('PRAGMA foreign_keys = ON;');
  P('');
  P(`-- rows: ${rowCount} · tables: ${tables.length} · posted entries: ${posted.length}`);
  return { sql: lines.join('\n'), rowCount, tables: tables.length, posted: posted.length };
}

/* --------------------------------------------------------------- CLI ---- */
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) {
    console.error('usage: node tools/backup.mjs <source.db> <out.sql>');
    process.exit(64);
  }
  const db = new DatabaseSync(src, { readOnly: true });
  const r = buildBackupSql(db);
  writeFileSync(out, r.sql, 'utf8');
  console.log(`✓ backup written: ${out}`);
  console.log(`  ${r.rowCount} rows · ${r.tables} tables · ${r.posted} posted entries`);
  console.log(`  restore with: node tools/restore.mjs ${out} <new.db>`);
}
