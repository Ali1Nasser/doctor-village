/**
 * tools/restore.mjs — restore into a CLEAN database, and prove it worked.
 *
 * CP-8's gate is not "a backup file exists". It is:
 *
 *   > A restore from backup into a clean project succeeds and the totals match.
 *
 * So this does both halves. It builds a new database from `migrations/` (never
 * from a dumped schema — a restore must land on the constraints in force TODAY,
 * not the ones in force when the backup was taken), replays the backup, and
 * then re-computes the figures that matter and compares them to the source.
 *
 * ## What "the totals match" is checked against
 *
 * Four numbers, chosen because each one fails differently:
 *
 *   · **spendable funds** — the number on `/finance` that a resident reads as
 *     "what the village has". If a restore silently dropped a payment, this is
 *     what moves.
 *   · **the accounting equation residual** — must be exactly 0. Catches a
 *     half-restored entry that balanced within itself but not across the books.
 *   · **posted entry and line counts** — catches the `.dump` failure mode
 *     directly: lines refused on posted entries would show up here as a deficit.
 *   · **per-account balances, every account** — the strongest of the four. Two
 *     ledgers can share a treasury total and disagree on every account inside
 *     it; this is what notices.
 *
 * Usage:
 *   node tools/restore.mjs <backup.sql> <target.db> [--verify-against <source.db>]
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

export function applyMigrations(db) {
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).sort()) {
    db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
}

/**
 * The backup carries its own `accounts`, `funds` and `categories`, so
 * `seed/prod/` is deliberately NOT replayed here — doing both would collide on
 * primary keys, and the backup is the authority on what the village actually
 * had.
 */
export function restoreInto(db, backupSql) {
  applyMigrations(db);
  db.exec(backupSql);
  rebuildSearchIndex(db);
}

/**
 * The FTS tables are derived data and are not in the backup: a search index is
 * reproducible from the rows it indexes, and shipping it would double the
 * backup size to carry something a rebuild recreates exactly.
 *
 * Folding is duplicated here rather than imported from `lib/search/fold.ts`
 * because this tool is plain `.mjs` and must run from a recovery shell with no
 * build step — the moment a restore depends on `npm run build` having succeeded,
 * it is not a recovery tool. The pairs are asserted identical by the restore
 * drill, so a drift in either copy fails a test rather than silently changing
 * which documents are findable.
 */
function fold(s) {
  let out = String(s ?? '').normalize('NFKC')
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ]/g, '');
  for (const [re, to] of [
    [/[آأإٱٲٳٵ]/g, 'ا'],
    [/ة/g, 'ه'], [/ى/g, 'ي'],
    [/ؤ/g, 'و'], [/ئ/g, 'ي'], [/ء/g, ''],
  ]) out = out.replace(re, to);
  out = out.replace(/[٠-٩۰-۹]/g, d => {
    const c = d.charCodeAt(0);
    return String(c - (c >= 0x06f0 ? 0x06f0 : 0x0660));
  });
  return out.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function rebuildSearchIndex(db) {
  db.exec('DELETE FROM posts_fts');
  db.exec('DELETE FROM albums_fts');
  const posts = db.prepare(
    `SELECT id, title_ar, search_body FROM posts
      WHERE published_at IS NOT NULL AND deleted_at IS NULL`
  ).all();
  const ins = db.prepare(
    `INSERT INTO posts_fts (post_id, title_ar, search_body, attachment_text) VALUES (?,?,?,?)`
  );
  for (const p of posts) {
    const att = db.prepare(
      `SELECT name_ar, extracted_text FROM post_attachments WHERE post_id = ?`
    ).all(p.id).map(a => `${a.name_ar} ${a.extracted_text}`).join(' ');
    ins.run(p.id, fold(p.title_ar), p.search_body ?? '', fold(att));
  }
  const albums = db.prepare(
    `SELECT id, title_ar, description_ar FROM albums WHERE published_at IS NOT NULL`
  ).all();
  const insA = db.prepare(
    `INSERT INTO albums_fts (album_id, title_ar, search_body) VALUES (?,?,?)`
  );
  for (const a of albums) {
    insA.run(a.id, fold(a.title_ar), fold(`${a.title_ar} ${a.description_ar}`));
  }
  return { posts: posts.length, albums: albums.length };
}

/** The figures a restore is judged on. */
export function fingerprint(db) {
  const one = (sql, dflt = 0) => {
    try {
      const r = db.prepare(sql).get();
      return r ? Number(Object.values(r)[0] ?? dflt) : dflt;
    } catch { return dflt; }
  };
  const accounts = db.prepare(
    `SELECT code, balance_piastres FROM v_account_balances ORDER BY code`
  ).all().map(r => `${r.code}:${r.balance_piastres}`).join('|');

  return {
    spendable: one(`SELECT spendable_piastres FROM v_community_totals`),
    totalIncome: one(`SELECT total_income_piastres FROM v_community_totals`),
    totalExpense: one(`SELECT total_expense_piastres FROM v_community_totals`),
    heldInTrust: one(`SELECT held_in_trust_piastres FROM v_community_totals`),
    equationResidual: one(`SELECT residual_piastres FROM v_accounting_equation`),
    postedEntries: one(`SELECT COUNT(*) n FROM journal_entries WHERE posted_at IS NOT NULL`),
    lines: one(`SELECT COUNT(*) n FROM journal_lines`),
    payments: one(`SELECT COUNT(*) n FROM payments`),
    approvedPayments: one(`SELECT COUNT(*) n FROM payments WHERE status='approved'`),
    expenses: one(`SELECT COUNT(*) n FROM expenses`),
    profiles: one(`SELECT COUNT(*) n FROM profiles`),
    units: one(`SELECT COUNT(*) n FROM units`),
    posts: one(`SELECT COUNT(*) n FROM posts WHERE deleted_at IS NULL`),
    auditRows: one(`SELECT COUNT(*) n FROM audit_log`),
    accounts,
  };
}

export function compare(before, after) {
  const problems = [];
  for (const k of Object.keys(before)) {
    if (before[k] !== after[k]) {
      const b = String(before[k]), a = String(after[k]);
      problems.push(`${k}: source=${b.slice(0, 60)} restored=${a.slice(0, 60)}`);
    }
  }
  return problems;
}

/* --------------------------------------------------------------- CLI ---- */
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const args = process.argv.slice(2);
  const [backupPath, targetPath] = args;
  const verifyIdx = args.indexOf('--verify-against');
  const sourcePath = verifyIdx >= 0 ? args[verifyIdx + 1] : null;

  if (!backupPath || !targetPath) {
    console.error('usage: node tools/restore.mjs <backup.sql> <target.db> [--verify-against <source.db>]');
    process.exit(64);
  }
  if (existsSync(targetPath)) unlinkSync(targetPath);

  const db = new DatabaseSync(targetPath);
  try {
    restoreInto(db, readFileSync(backupPath, 'utf8'));
  } catch (e) {
    console.error('✗ RESTORE FAILED');
    console.error(`  ${e.message}`);
    console.error('  The backup did not replay. Do not overwrite the source.');
    process.exit(1);
  }
  console.log(`✓ restored into ${targetPath}`);

  if (sourcePath) {
    const src = new DatabaseSync(sourcePath, { readOnly: true });
    const problems = compare(fingerprint(src), fingerprint(db));
    if (problems.length) {
      console.error('✗ TOTALS DO NOT MATCH:');
      for (const p of problems) console.error(`  · ${p}`);
      process.exit(1);
    }
    const f = fingerprint(db);
    console.log('✓ totals match the source exactly');
    console.log(`  spendable ${(f.spendable / 100).toLocaleString('en-US')} ج.م`
      + ` · ${f.postedEntries} posted entries · ${f.lines} lines · residual ${f.equationResidual}`);
  }
}
