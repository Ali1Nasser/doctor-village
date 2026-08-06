/**
 * tools/build-sw.mjs — inline `public/sw.js` into a TypeScript module.
 *
 * Workers has no filesystem, so the service worker has to be a string in the
 * bundle. Writing it as a string literal by hand would mean a file nobody can
 * lint, syntax-check or diff sensibly — so the readable file is the source of
 * truth and this generates the module from it. Run by `npm run build`.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('public/sw.js', 'utf8');
if (src.includes('`') || src.includes('${')) {
  // Refuse rather than escape: a backtick smuggled into the worker would break
  // the generated module in a way that only shows up at deploy time.
  console.error('✗ public/sw.js must not contain a backtick or ${ — it is embedded in a template literal');
  process.exit(1);
}
writeFileSync('src/sw.ts',
`/* GENERATED FROM public/sw.js by tools/build-sw.mjs — DO NOT EDIT. */
export const SERVICE_WORKER = \`${src}\`;
`);
console.log('✓ service worker inlined from public/sw.js');
