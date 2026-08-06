/**
 * lib/db/blobs.ts — the SQL for the receipt byte store.
 *
 * ## Why this file exists at all
 *
 * `D1BlobStorage` in `lib/storage/` originally held these five queries itself.
 * `tools/lint-no-sql.mjs` refused the build, correctly, and the tempting fix was
 * to add `lib/storage/d1blob.ts` to the allow-list — the queries touch a
 * content-addressed byte store with no resident scoping, so "it's harmless".
 *
 * That reasoning is how the rule dies. Its entire value is being absolute: the
 * moment there is one documented exception, the next one is easier, and
 * eventually a query that DOES need an ownership predicate lands in a file
 * nobody is checking. Moving five queries costs nothing. The rule stays whole.
 *
 * ## No AuthContext here, deliberately — and why that is safe
 *
 * These functions take a raw storage key and no identity, unlike everything else
 * in `lib/db/`. Authorization happens BEFORE them, in `authorizeObjectRead()`,
 * which checks `storage_objects.unit_id` against the caller's units on **every
 * request**. This layer is a dumb byte store on purpose: it cannot decide who
 * may read a file because it is never told who is asking.
 *
 * The `Db` passed in is the **RECEIPTS** binding in production — a different
 * database from the ledger (ADR-023) — so nothing here can reach a payment, a
 * journal line, or an audit row even by accident.
 */

import type { Db } from './driver.js';

export interface BlobRow { bytes: unknown; mime: string }

export async function putBlob(
  db: Db, key: string, mime: string, size: number, body: Uint8Array,
): Promise<void> {
  // Idempotent: a retried upload after a dropped connection overwrites instead
  // of erroring, so it cannot strand a payment whose row already exists.
  await db.prepare(
    `INSERT INTO receipt_blobs (storage_key, mime, size_bytes, bytes)
     VALUES (?,?,?,?)
     ON CONFLICT(storage_key) DO UPDATE SET
       mime = excluded.mime, size_bytes = excluded.size_bytes, bytes = excluded.bytes`
  ).bind(key, mime, size, body).run();
}

export async function getBlob(db: Db, key: string): Promise<BlobRow | null> {
  return db.prepare(`SELECT bytes, mime FROM receipt_blobs WHERE storage_key = ?`)
    .bind(key).first<BlobRow>();
}

/** Deleting an IMAGE never touches financial history — the payment, its journal
 *  entry and its audit trail live in the other database and are append-only. */
export async function deleteBlob(db: Db, key: string): Promise<void> {
  await db.prepare(`DELETE FROM receipt_blobs WHERE storage_key = ?`).bind(key).run();
}

export async function blobUsage(db: Db): Promise<{
  objects: number; used_bytes: number; pct_used: number;
}> {
  const r = await db.prepare(`SELECT objects, used_bytes, pct_used FROM v_blob_usage`)
    .first<{ objects: number; used_bytes: number; pct_used: number }>();
  return r ?? { objects: 0, used_bytes: 0, pct_used: 0 };
}
