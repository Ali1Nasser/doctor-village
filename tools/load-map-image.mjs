#!/usr/bin/env node
/**
 * tools/load-map-image.mjs — put the village plan into blob storage.
 *
 * The map image is one file for the whole village, and it lives where every
 * other image in this project lives: a D1 blob table (ADR-023). Not R2 — R2
 * requires completing a checkout flow with a card even on its free tier, which
 * violates C11 — and not an external tile service, which C13 forbids outright.
 *
 * ## Why this is a tool and not part of the seed
 *
 * `seed/demo/*.sql` is committed text. Embedding a 109 KB image as a hex blob
 * literal would put ~220 KB of unreadable SQL in the repository and re-write it
 * on every regeneration. The bytes are already committed once, as
 * `assets/maps/village-map-display.webp`; this reads that file and writes it in.
 *
 * ## The checksum is checked, not trusted
 *
 * `map_documents.display_sha256` is what the row claims the bytes are. This
 * verifies the file on disk hashes to the same thing before writing, so a
 * re-encoded or truncated asset fails here rather than silently becoming "the
 * board's verified plan".
 *
 *   node tools/load-map-image.mjs <path-to-sqlite-db>
 *   node tools/load-map-image.mjs --remote        (via wrangler, base64 chunks)
 */

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const DISPLAY = join(ROOT, 'assets/maps/village-map-display.webp');
const KEY = 'maps/village-map-2026-08-display.webp';
const EXPECTED_SHA = '7794b99dd3638418f38141ec600e37362795e73f3a09903e697ff50f832ceb21';

const bytes = readFileSync(DISPLAY);
const sha = createHash('sha256').update(bytes).digest('hex');
if (sha !== EXPECTED_SHA) {
  console.error(`✗ ${DISPLAY}`);
  console.error(`  expected sha256 ${EXPECTED_SHA}`);
  console.error(`  found            ${sha}`);
  console.error('  The seed and migration record the expected hash. Re-encoding the');
  console.error('  display asset means a new map VERSION, not a quiet substitution.');
  process.exit(1);
}
if (bytes.length > 262144) {
  console.error(`✗ ${bytes.length} bytes exceeds the 256 KB blob cap in migration 0008.`);
  process.exit(1);
}

const target = process.argv[2];
if (!target || target === '--help') {
  console.error('usage: node tools/load-map-image.mjs <sqlite-file>|--remote');
  process.exit(2);
}

if (target === '--remote') {
  // Via a FILE, not `--command`. A 109 KB blob is 218 KB as a hex literal, and
  // an argument that size trips ARG_MAX on some shells and wrangler's own
  // argument handling on others — it failed here before it worked.
  const hex = bytes.toString('hex');
  const sqlPath = join(tmpdir(), 'load-map-image.sql');
  writeFileSync(sqlPath,
    `INSERT OR REPLACE INTO receipt_blobs (storage_key, mime, size_bytes, bytes)\n`
    + `VALUES ('${KEY}', 'image/webp', ${bytes.length}, X'${hex}');\n`);
  try {
    execFileSync('npx', [
      'wrangler', 'd1', 'execute', 'qaryat-atebaa-receipts',
      '--remote', '--yes', '--file', sqlPath,
    ], { stdio: 'inherit' });
  } finally {
    rmSync(sqlPath, { force: true });
  }
  console.log(`✓ uploaded ${bytes.length} bytes to ${KEY} (remote)`);
} else {
  const db = new DatabaseSync(target);
  db.prepare(
    `INSERT OR REPLACE INTO receipt_blobs (storage_key, mime, size_bytes, bytes)
     VALUES (?,?,?,?)`
  ).run(KEY, 'image/webp', bytes.length, bytes);
  db.close();
  console.log(`✓ wrote ${bytes.length} bytes to ${KEY} in ${target}`);
}
