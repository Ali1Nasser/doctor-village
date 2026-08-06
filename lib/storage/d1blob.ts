/**
 * lib/storage/d1blob.ts — receipt images stored in Cloudflare D1.
 *
 * The owner's instruction (2026-08-04): *"استخدم الـ Cloudflare database، لو مش
 * متاح ده ملف درايف."* Measurement says it is available, comfortably — see
 * ADR-023 and the header of `migrations/0008_receipt_blobs.sql`.
 *
 * Why this is a better answer than it first looks:
 *   · **no new vendor, no card, no new quota to watch** — the strongest C11
 *     position available, and better than every alternative considered;
 *   · receipts land inside the existing nightly D1 backup automatically, so
 *     "the images were not in the backup" stops being a way to lose them;
 *   · no signing, no OAuth token custody, no refresh tokens to expire.
 *
 * What it costs, stated plainly:
 *   · a hard ceiling of 500 MB per database — ~18 years at measured sizes, but
 *     it IS a ceiling, and `usedBytes()` is what watches it;
 *   · blobs must live in a SEPARATE database from the ledger in production, or
 *     the restore drill gets slow and stops being run.
 *
 * ⚠️ This class never decides who may read a file. `authorizeObjectRead()` in
 * `lib/db/` does, against `storage_objects`, on every single request. This is a
 * dumb byte store on purpose.
 *
 * ⚠️ It also holds NO SQL. The five queries live in `lib/db/blobs.ts`, because
 * `tools/lint-no-sql.mjs` refused this file when they were here — correctly.
 * Adding an allow-list entry would have been easier and would have been the
 * first crack in a rule whose whole value is being absolute.
 */

import type { Db } from '../db/driver.js';
import { putBlob, getBlob, deleteBlob, blobUsage } from '../db/blobs.js';
import type { StorageAdapter, PutInput } from './index.js';
import { StorageFull } from './index.js';

/** 256 KB — matches the CHECK in migration 0008. ~40× the measured worst case. */
export const MAX_BLOB_BYTES = 262_144;

/** 500 MB per database (verified 2026-08-04). Warn well before the wall. */
export const D1_DB_LIMIT_BYTES = 524_288_000;
export const WARN_AT_BYTES = Math.floor(D1_DB_LIMIT_BYTES * 0.7);

export class D1BlobStorage implements StorageAdapter {
  readonly id = 'd1';

  /**
   * @param db  In production this is the SEPARATE `RECEIPTS` binding, not the
   *            ledger database. Locally they are the same database, which is
   *            fine — and is why the code must never assume they are.
   */
  constructor(private readonly db: Db) {}

  async put(i: PutInput): Promise<{ key: string; sizeBytes: number }> {
    const size = i.body.byteLength;
    if (size === 0) throw new StorageFull('الملف فاضي');
    if (size > MAX_BLOB_BYTES) {
      // A client that skipped compression must be refused, not accommodated.
      // One silent 12 MB write is how a 500 MB budget disappears in a week.
      throw new StorageFull(
        'الصورة كبيرة أوي. لازم تتصغّر في الموبايل الأول — جرّب ترفعها تاني.');
    }
    // Idempotent: re-uploading the same key overwrites rather than erroring, so
    // a retried request after a dropped connection does not strand a payment
    // whose row was already created.
    await putBlob(this.db, i.key, i.mime, size, i.body);
    return { key: i.key, sizeBytes: size };
  }

  async get(key: string): Promise<{ body: Uint8Array; mime: string } | null> {
    const r = await getBlob(this.db, key);
    if (!r) return null;
    return { body: toBytes(r.bytes), mime: r.mime };
  }

  async delete(key: string): Promise<void> {
    // Deleting the IMAGE never touches the ledger. The payment, its journal
    // entry and its audit trail live in the other database and are append-only,
    // so archiving old images cannot erase financial history. (C5)
    await deleteBlob(this.db, key);
  }

  async usedBytes(): Promise<number> {
    return (await blobUsage(this.db)).used_bytes;
  }

  /** For `/admin/health`. Residents must never learn about a quota by the site
   *  breaking (05 §7). */
  async usage(): Promise<{ objects: number; usedBytes: number; pctUsed: number; warn: boolean }> {
    const r = await blobUsage(this.db);
    return {
      objects: r.objects, usedBytes: r.used_bytes, pctUsed: r.pct_used,
      warn: r.used_bytes >= WARN_AT_BYTES,
    };
  }
}

/** D1 and node:sqlite hand back BLOBs in different shapes. Copy, don't view. */
function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (Array.isArray(v)) return new Uint8Array(v);
  if (v && typeof v === 'object' && 'buffer' in (v as ArrayBufferView)) {
    const a = v as ArrayBufferView;
    return new Uint8Array(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }
  throw new Error('receipt blob is not binary');
}
