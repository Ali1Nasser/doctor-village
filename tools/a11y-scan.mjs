#!/usr/bin/env node
/**
 * tools/a11y-scan.mjs — run axe-core over every rendered screen, narrow and wide.
 *
 * CP-7's gate says "WCAG 2.2 AA review with no unresolved blocker". A human
 * review is still the gate; this is the part a machine can hold, so that the
 * part a human found stays fixed.
 *
 * ## Why it skips instead of failing when the tools are absent
 *
 * Playwright downloads a browser. This project's whole premise is that it can
 * be rebuilt from a clone with `npm ci` on a free tier and no credit card
 * (C11), and a ~200 MB browser download in the default verify path is at odds
 * with that. So the scanner is opt-in by installation: present → it runs and
 * `npm run verify` fails on a violation; absent → it says so, in one line, and
 * exits 0.
 *
 * A silent skip would be worse than no check at all, which is why it prints
 * the exact command to make it run.
 *
 *     npm i -D playwright axe-core && npx playwright install chromium
 *
 * ## What it found the first time it ran
 *
 * `--warn` on `--warn-soft` measured 3.89:1 across nine screens — below the
 * 4.5:1 AA threshold — on the "every figure here is invented" banner, among
 * others. Fixed at the token (#A96A00 → #8F5A00), so every warn surface
 * improved together, and `.banner` went from .9rem to 1rem: a banner is where
 * the app explains a refusal, and it was the smallest text on the page against
 * a 17px floor chosen for a 71-year-old.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const PREVIEW = join(process.cwd(), 'preview');
/**
 * Two viewports, because ≥900px is not the same page.
 *
 * At that width the shell swaps its whole navigation — the bottom tab bar and
 * the ☰ drawer stand down and a permanent rail takes over — so scanning only
 * 360px left an entire second layout unchecked. It is also the layout a board
 * member is most likely to open the portal in.
 *
 * 360 is 04_UX_SPEC's floor: it must work on the narrowest phone.
 */
const WIDTHS = [360, 1100];

function skip(why) {
  console.log(`\n  a11y scan SKIPPED — ${why}`);
  console.log('  to enable:  npm i -D playwright axe-core && npx playwright install chromium\n');
  process.exit(0);
}

let chromium, AXE;
try {
  ({ chromium } = await import('playwright'));
  AXE = readFileSync(require_.resolve('axe-core/axe.min.js'), 'utf8');
} catch {
  skip('playwright and/or axe-core are not installed');
}
if (!existsSync(PREVIEW)) skip('preview/ is empty — run `npm run screens` first');

const pages = readdirSync(PREVIEW).filter(f => f.endsWith('.html') && f !== 'index.html');
if (pages.length === 0) skip('preview/ has no screens');

// The sandbox pins a browser here; fall back to Playwright's own lookup.
const exe = ['/opt/pw-browsers/chromium'].find(existsSync);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});

const found = new Map();
for (const width of WIDTHS) {
  for (const file of pages) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.goto('file://' + join(PREVIEW, file));
    await page.addScriptTag({ content: AXE });
    const res = await page.evaluate(async () => window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    }));
    for (const v of res.violations) {
      const key = `${v.id} (${v.impact})`;
      if (!found.has(key)) found.set(key, { help: v.help, screens: [], sample: v.nodes[0]?.html ?? '' });
      // The width is part of the location: "it fails on the audit screen" is
      // half an answer when one of the two layouts is fine.
      found.get(key).screens.push(`${file.replace(/\.html$/, '')}@${width}`);
    }
    await page.close();
  }
}
await browser.close();

console.log(`\n  axe-core · WCAG 2.2 AA · ${pages.length} screens at ${WIDTHS.join('px and ')}px\n`);
if (found.size === 0) {
  console.log('  PASS  no violations\n');
  process.exit(0);
}
for (const [key, v] of [...found].sort()) {
  console.log(`  FAIL  ${key} — ${v.help}`);
  console.log(`        on: ${v.screens.join(', ')}`);
  console.log(`        → ${v.sample.slice(0, 160)}\n`);
}
console.log(`  ${found.size} violation type(s). This is a CP-7 gate.\n`);
process.exit(1);
