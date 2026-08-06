-- =============================================================================
-- 0008_receipt_blobs.sql — receipt images stored in D1
--
-- ⚠️ THIS REVERSES A RULE IN THE SPEC PACK, ON EVIDENCE. See ADR-023.
--
-- `05_ZERO_COST_ARCHITECTURE.md` §2a says "never store image bytes in D1. Only
-- metadata and hashes." That rule was correct given its stated input — 500 KB
-- per receipt, 2.5 GB/year, against a 500 MB database. It would have been
-- hopeless.
--
-- The 500 KB figure was never measured; it was the pack's *pre-upload* target
-- for a raw phone photo. Measured on 2026-08-04 against WebP at 1200px q60:
--
--   bank-app screenshot ......  5 KB
--   PHOTOGRAPHED PAPER slip ..  6 KB    (the worst realistic case)
--   at 5,000 receipts/year ...  27 MB/year
--   => 18 years per 500 MB database, 10 databases on the free plan
--
-- So the constraint that made the rule true does not hold. Storing receipts in
-- D1 costs no vendor, no card, no new quota to watch, and they land inside the
-- existing nightly backup for free.
--
-- ## Why a SEPARATE table, and why it belongs in its own DATABASE in production
--
-- The ledger must stay small: the CP-8 restore drill has to be fast and
-- routine, and a dump that carries every image is neither. Bind a second D1
-- database (`RECEIPTS`) in `wrangler.toml` and apply ONLY this migration to it.
-- Locally and in tests both live in one file, which is why this is written as an
-- ordinary migration rather than a separate schema.
-- =============================================================================

PRAGMA foreign_keys = ON;

CREATE TABLE receipt_blobs (
  -- The same key used everywhere else: `receipts/<unit_id>/<payment_id>.webp`.
  -- Deliberately NOT a foreign key to storage_objects: in production this table
  -- lives in a different database, and a cross-database FK cannot exist. The
  -- authorisation check is `authorizeObjectRead()` against storage_objects,
  -- which runs BEFORE anything here is read — bytes are never served without it.
  storage_key TEXT    NOT NULL PRIMARY KEY,
  mime        TEXT    NOT NULL DEFAULT 'image/webp',
  size_bytes  INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 262144),
  bytes       BLOB    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

-- 256 KB ceiling in the CHECK above, deliberately.
-- Measured worst case is 6 KB, so 256 KB is ~40× headroom — generous enough that
-- an unusual receipt still fits, tight enough that a client which skipped
-- compression is REFUSED rather than quietly filling the database. A silent
-- 12 MB write is how a 500 MB budget disappears in a week.

CREATE INDEX idx_receipt_blobs_created ON receipt_blobs(created_at);

-- Archived years are exported and deleted, so the live database stays small.
-- Deleting a blob never touches the ledger: the payment, its journal entry and
-- its audit trail are all in the other database and are append-only.
CREATE VIEW v_blob_usage AS
SELECT COUNT(*)                       AS objects,
       COALESCE(SUM(size_bytes), 0)   AS used_bytes,
       COALESCE(MAX(size_bytes), 0)   AS largest_bytes,
       -- 500 MB per database on the free plan (verified 2026-08-04)
       524288000                      AS db_limit_bytes,
       (COALESCE(SUM(size_bytes),0) * 100) / 524288000 AS pct_used
FROM receipt_blobs;
