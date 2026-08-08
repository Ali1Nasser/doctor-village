#!/usr/bin/env node
/**
 * tools/pack-map-asset.mjs — regenerate `src/map-asset.ts` from the display
 * image. Run this after producing a new display derivative; never hand-edit the
 * generated file. See its header for why the plan ships in the bundle.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const bytes = readFileSync('assets/maps/village-map-display.webp');
const sha = createHash('sha256').update(bytes).digest('hex');
const b64 = bytes.toString('base64');
const chunks = b64.match(/.{1,100}/g) ?? [];
const existing = readFileSync('src/map-asset.ts', 'utf8');
const header = existing.slice(0, existing.indexOf('/** SHA-256'));
writeFileSync('src/map-asset.ts',
  `${header}/** SHA-256 of the bytes below. \`map_documents.display_sha256\` must match. */
export const MAP_DISPLAY_SHA256 =
  '${sha}';

export const MAP_DISPLAY_KEY = 'maps/village-map-2026-08-display.webp';
export const MAP_DISPLAY_MIME = 'image/webp';

const MAP_DISPLAY_B64 =
${chunks.map(c => `  + '${c}'`).join('\n')};

/** Decoded once per isolate, not per request. */
let cached: Uint8Array | null = null;
export function mapDisplayBytes(): Uint8Array {
  if (cached) return cached;
  const bin = atob(MAP_DISPLAY_B64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  cached = out;
  return out;
}
`);
console.log(`✓ src/map-asset.ts — ${bytes.length} bytes, sha256 ${sha}`);
