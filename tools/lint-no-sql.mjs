#!/usr/bin/env node
/**
 * tools/lint-no-sql.mjs — enforces C6 / ADR-010 rule 1:
 * NO SQL EXISTS OUTSIDE lib/db/.
 *
 * ADR-010 traded Postgres RLS for application discipline. Discipline that is not
 * mechanically enforced is just a preference, and the ADR is explicit that if the
 * discipline slips we must switch to Neon + RLS. This is the mechanism that tells
 * us whether it has slipped.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const ALLOWED = ['lib/db/', 'tests/', 'seed/', 'migrations/', 'tools/'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.build', 'preview', 'dist']);
// `(?<![<\/])` — an HTML `<select>` or `</select>` is not a query.
// The rule flagged the expense form's category dropdown, which is the second
// time one of these linters has produced a false positive (the RTL rule did it
// on `let left: number`). Both times the fix was to make the RULE precise rather
// than to add a file exception: a linter you have taught yourself to ignore is
// worse than no linter, and an allow-list is how that habit starts.
const SQL = /(?<![<\/])\b(SELECT\s|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE)/i;

const offenders = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!/\.(ts|tsx|js|mjs)$/.test(name)) continue;
    const rel = relative(ROOT, p).replaceAll('\\', '/');
    if (ALLOWED.some(a => rel.startsWith(a))) continue;
    readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      const t = line.trimStart();
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
      if (SQL.test(line)) offenders.push(`${rel}:${i + 1}  ${t.slice(0, 90)}`);
    });
  }
}
walk(ROOT);

if (offenders.length) {
  console.error('\n✗ SQL found outside lib/db/ — this breaks C6 and ADR-010.\n');
  offenders.forEach(o => console.error('   ' + o));
  console.error('\n  Move the query into lib/db/, with the ownership predicate inside the');
  console.error('  query string and AuthContext as the first argument.\n');
  process.exit(1);
}
console.log('✓ no SQL outside lib/db/  (C6 / ADR-010 rule 1)');
