-- =============================================================================
-- 0010_recovery_and_import.sql
--
-- Two tables for the two remaining human-in-the-loop processes, both of which
-- are fraud surfaces rather than features.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- recovery_requests — assisted recovery, R-023 / R-003
--
-- For the resident who lost the phone AND the printed codes. This is the most
-- likely real-world lockout, and it is also the single most abuse-prone path in
-- the system: it hands someone an account without any cryptographic proof that
-- they are who they say. 03_RBAC §6 is explicit that it needs **two different
-- admins**, and that identity is verified OFFLINE first.
--
-- The two-admin rule is enforced by CHECK below, not by application code, so a
-- bug in a route cannot complete a recovery alone.
-- -----------------------------------------------------------------------------
CREATE TABLE recovery_requests (
  id                TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  target_profile_id TEXT NOT NULL REFERENCES profiles(id),
  -- how the admin established this is really them, in their own words. Required:
  -- "I know him" is a weak answer but it is an ANSWER, and it is on the record.
  identity_check_ar TEXT NOT NULL CHECK (length(trim(identity_check_ar)) >= 10),
  requested_by      TEXT NOT NULL REFERENCES profiles(id),
  requested_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  approved_by       TEXT REFERENCES profiles(id),
  approved_at       TEXT,
  -- set once the activation link has actually been generated, so a request
  -- cannot be redeemed twice
  fulfilled_at      TEXT,
  cancelled_at      TEXT,
  cancel_reason_ar  TEXT,

  -- ⭐ The control, in the schema: the second admin is never the first.
  CHECK (approved_by IS NULL OR approved_by <> requested_by),
  -- an admin cannot recover their own account
  CHECK (target_profile_id <> requested_by),
  CHECK (approved_by IS NULL OR target_profile_id <> approved_by),
  CHECK (approved_by IS NULL OR approved_at IS NOT NULL),
  CHECK (fulfilled_at IS NULL OR approved_by IS NOT NULL),
  CHECK (cancelled_at IS NULL OR cancel_reason_ar IS NOT NULL)
) STRICT;

CREATE INDEX idx_recovery_open ON recovery_requests(target_profile_id)
  WHERE fulfilled_at IS NULL AND cancelled_at IS NULL;

-- A fulfilled or cancelled request is history and never changes again.
CREATE TRIGGER trg_recovery_immutable
BEFORE UPDATE ON recovery_requests
WHEN OLD.fulfilled_at IS NOT NULL OR OLD.cancelled_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'طلب الاسترجاع ده اتقفل خلاص — اعمل طلب جديد');
END;

-- -----------------------------------------------------------------------------
-- import_batches — the owner register, R-009
--
-- "Dirty import data: duplicate phone numbers, missing units, two owners for one
-- flat, a flat with no phone number on record." The importer previews,
-- normalizes, flags — and NEVER guesses.
--
-- The batch is recorded before anything is created, so a bad import can be
-- traced and reversed by hand, and so a second attempt can be recognised.
-- -----------------------------------------------------------------------------
CREATE TABLE import_batches (
  id            TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  filename      TEXT,
  row_count     INTEGER NOT NULL CHECK (row_count >= 0),
  ok_count      INTEGER NOT NULL DEFAULT 0,
  problem_count INTEGER NOT NULL DEFAULT 0,
  -- the full parsed preview, so what the admin SAW when they confirmed is on
  -- the record — not just what was created
  preview_json  TEXT    NOT NULL CHECK (json_valid(preview_json)),
  created_by    TEXT    NOT NULL REFERENCES profiles(id),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  confirmed_at  TEXT,
  confirmed_by  TEXT    REFERENCES profiles(id)
) STRICT;

-- Rows link back to what they created, so "where did this resident come from?"
-- has an answer two years later.
CREATE TABLE import_rows (
  id            TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  batch_id      TEXT    NOT NULL REFERENCES import_batches(id),
  row_no        INTEGER NOT NULL,
  raw_json      TEXT    NOT NULL CHECK (json_valid(raw_json)),
  status        TEXT    NOT NULL CHECK (status IN ('ok','duplicate','malformed','skipped','created')),
  problem_ar    TEXT,
  profile_id    TEXT    REFERENCES profiles(id),
  unit_id       TEXT    REFERENCES units(id),
  CHECK (status IN ('ok','created') OR problem_ar IS NOT NULL)
) STRICT;

CREATE INDEX idx_import_rows_batch ON import_rows(batch_id);
