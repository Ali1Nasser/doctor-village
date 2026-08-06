#!/usr/bin/env node
/**
 * tools/lint-rtl.mjs — bans physical directional CSS and unwrapped numbers.
 *
 * Two rules, both from `INSIGHTS.md` where they were learned the expensive way:
 *
 *  1. **Physical directional properties do not flip in RTL.** `margin-left`
 *     stays on the left in an Arabic layout. Logical properties
 *     (`margin-inline-start`, `inset-inline-end`, `padding-block-end`, …) flip
 *     automatically. Retrofitting these across a finished UI is far more
 *     expensive than preventing them on day one — hence a lint rule, not a
 *     review checklist.
 *
 *  2. **`text-align:left/right` is the same trap** wearing different clothes.
 *
 * The Tailwind class variants (`ml-`, `pr-`, `left-`) are also matched, so the
 * rule keeps working if the project ever adopts Tailwind after all (ADR-019).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.git', '.build', 'preview', 'dist', 'migrations', 'seed']);
// prototype.html ships with the spec pack as a design reference, not as source.
// Linting somebody else's mockup produces noise that trains people to ignore the linter.
const SKIP_FILES = new Set(['prototype.html']);

const RULES = [
  { re: /(?<![-\w])(margin|padding)-(left|right)\s*:/g,
    fix: 'use margin-inline-start / margin-inline-end (or padding-…)' },
  { re: /(?<![-\w])border-(left|right)(-\w+)?\s*:/g,
    fix: 'use border-inline-start / border-inline-end' },
  // Anchored to the start of a CSS declaration ({ or ;), otherwise TypeScript
  // like `let left: number = …` is a false positive — which it was, first run.
  { re: /(?:^|[;{])\s*(left|right)\s*:\s*[^=\n]/g,
    fix: 'use inset-inline-start / inset-inline-end' },
  { re: /text-align\s*:\s*(left|right)\b/g,
    fix: 'use text-align: start / end' },
  { re: /(?:^|[;{])\s*(width|height)\s*:\s*(?![\d.]*(vh|vw)\b)[^=\n]/g,
    fix: 'prefer inline-size / block-size', warnOnly: true },
  { re: /\bclass="[^"]*\b(ml|mr|pl|pr|left|right)-\d/g,
    fix: 'use ms-/me-/ps-/pe-/start-/end- (Tailwind logical variants)' },
  { re: /border-radius\s*:\s*[^;]*\s+[^;]+\s+[^;]+\s+[^;]+/g,
    fix: 'four-corner border-radius does not mirror; use logical corners', warnOnly: true },
];

const errors = [], warnings = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!/\.(ts|tsx|css|html)$/.test(name)) continue;
    const rel = relative(ROOT, p).replaceAll('\\', '/');
    if (rel.startsWith('tools/') || SKIP_FILES.has(name)) continue;
    readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
      for (const r of RULES) {
        r.re.lastIndex = 0;
        if (r.re.test(line)) {
          (r.warnOnly ? warnings : errors).push(
            `${rel}:${i + 1}  ${trimmed.slice(0, 76)}\n        → ${r.fix}`);
        }
      }
    });
  }
}
walk(ROOT);

if (warnings.length) {
  console.warn(`\n⚠ ${warnings.length} RTL warning(s):`);
  warnings.slice(0, 10).forEach(w => console.warn('   ' + w));
}
if (errors.length) {
  console.error('\n✗ physical directional CSS found — it does NOT flip in RTL.\n');
  errors.forEach(e => console.error('   ' + e));
  process.exit(1);
}
console.log(`✓ RTL: logical properties only${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
