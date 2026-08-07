-- =============================================================================
-- 0001_foundation.sql — identity, community, ownership
-- Ported from 02_DATA_MODEL.md (PostgreSQL) to SQLite / Cloudflare D1.
--
-- PORTING RULES APPLIED (00_MASTER_PROMPT <first_actions> step 4):
--   BIGINT        -> INTEGER            (SQLite INTEGER is 64-bit; piastres fit)
--   uuid          -> TEXT               (ULID, 26 chars, lexicographically sortable)
--   enum          -> TEXT + CHECK
--   timestamptz   -> TEXT, ISO-8601 UTC ('YYYY-MM-DDTHH:MM:SSZ')
--   date          -> TEXT, 'YYYY-MM-DD'
--   numeric(p,s)  -> INTEGER scaled     <-- NEVER REAL. See note below.
--   bytea         -> BLOB
--   jsonb         -> TEXT + json_valid() CHECK
--   tsvector      -> FTS5 virtual table (migration 0004)
--
-- ⚠️ numeric -> INTEGER, not REAL. The Postgres model had two numerics that
--    multiply into money: unit_owners.ownership_share numeric(5,4) and
--    units.area_sqm numeric(8,2). A naive port makes both REAL, and C4 ("money
--    is never a floating-point number") is then violated indirectly — a per-sqm
--    due or an ownership split would be computed through a float. Both are
--    stored as scaled integers here: share in basis points, area in cm².
--
-- ⚠️ Every table is STRICT. In a STRICT table SQLite rejects a value whose type
--    does not match the declared column type, so writing 12.5 into an INTEGER
--    piastres column is a database error rather than a silent truncation. This
--    makes C4 a storage-layer guarantee instead of a code convention.
--    engineering inference: D1 exposes `strict` in PRAGMA table_list, so STRICT
--    is expected to apply cleanly. VERIFY ON FIRST `wrangler d1 migrations apply`
--    (CP-1 gate). Fallback if rejected: strip the trailing ", STRICT" from each
--    CREATE TABLE — nothing else in the schema depends on it.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- profiles — الملاك والمستخدمون
-- id is the ONLY identity. Immutable. Everything references this. (C1b, ADR-012)
-- -----------------------------------------------------------------------------
CREATE TABLE profiles (
  id                TEXT    PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  full_name         TEXT    NOT NULL CHECK (length(trim(full_name)) > 0),
  role              TEXT    NOT NULL DEFAULT 'resident'
                            CHECK (role IN ('developer','admin','operator','resident','finance_reviewer')),
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  preferred_channel TEXT    NOT NULL DEFAULT 'whatsapp'
                            CHECK (preferred_channel IN ('whatsapp','sms','none')),
  created_by        TEXT    REFERENCES profiles(id),
  last_login_at     TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deactivated_at    TEXT
) STRICT;

-- NOTE: profiles.phone_e164 from 02_DATA_MODEL.md is DELIBERATELY ABSENT.
-- The Postgres model kept it as a "denormalized cache of the current primary
-- number". A cache of a security-relevant identifier is a second source of
-- truth that will drift from phone_identifiers, and drift here means a login
-- resolving to the wrong person. The current number is a one-row lookup
-- (idx_phone_active) — cheap enough that the cache buys nothing. (C1b)

CREATE INDEX idx_profiles_role ON profiles(role) WHERE is_active = 1;

-- -----------------------------------------------------------------------------
-- phone_identifiers — أرقام الموبايل وتاريخها     (ADR-012, R-021)
-- A phone number is a mutable ATTRIBUTE with history. Nothing FKs to it.
-- -----------------------------------------------------------------------------
CREATE TABLE phone_identifiers (
  id               TEXT    PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  profile_id       TEXT    NOT NULL REFERENCES profiles(id),
  -- E.164 Egypt, enforced structurally. SQLite has no regex, so length + GLOB.
  -- The normalizer lives in lib/db/; this CHECK exists so a malformed number
  -- FAILS LOUDLY at the boundary instead of being silently normalized wrong.
  --
  -- ⚠️ Written as a NEGATIVE match on purpose. The obvious form —
  --     GLOB '+20[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
  -- has thirteen character classes, and **real D1 refuses to evaluate it**:
  --     "LIKE or GLOB pattern too complex: SQLITE_ERROR"
  -- Local SQLite (3.45 and 3.51) evaluates it happily, so every test passed and
  -- the failure appeared only on the first INSERT against a deployed database.
  -- Measured 2026-08-07: ten classes are accepted, thirteen are not.
  --
  -- `NOT x GLOB '*[^0-9]*'` uses ONE class and says the same thing — "there is
  -- no non-digit anywhere in the rest of the string" — so the constraint is
  -- exactly as strict and portable. This is A-05 / R-031, found by deploying.
  phone_e164       TEXT    NOT NULL
                           CHECK (length(phone_e164) = 13
                              AND substr(phone_e164, 1, 3) = '+20'
                              AND NOT substr(phone_e164, 4) GLOB '*[^0-9]*'),
  is_primary       INTEGER NOT NULL DEFAULT 1 CHECK (is_primary IN (0,1)),
  status           TEXT    NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','replaced','revoked')),
  verified_at      TEXT,
  replaced_by_id   TEXT    REFERENCES phone_identifiers(id),
  changed_by       TEXT    REFERENCES profiles(id),
  change_reason_ar TEXT,
  valid_from       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  valid_to         TEXT,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- a status change away from 'active' must say why (03_RBAC §6 recovery trail)
  CHECK (status = 'active' OR change_reason_ar IS NOT NULL)
) STRICT;

-- One LIVE owner per number; history preserved forever. (02_DATA_MODEL §3)
CREATE UNIQUE INDEX idx_phone_active ON phone_identifiers(phone_e164) WHERE status = 'active';
-- One primary number per person at a time.
CREATE UNIQUE INDEX idx_phone_primary ON phone_identifiers(profile_id) WHERE is_primary = 1 AND status = 'active';
CREATE INDEX idx_phone_profile ON phone_identifiers(profile_id);

-- -----------------------------------------------------------------------------
-- passkeys — WebAuthn credentials     (ADR-011)
-- public_key ONLY. Never a private key, never biometric data.
-- -----------------------------------------------------------------------------
CREATE TABLE passkeys (
  id              TEXT    PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  profile_id      TEXT    NOT NULL REFERENCES profiles(id),
  credential_id   TEXT    NOT NULL UNIQUE,
  public_key      BLOB    NOT NULL,
  sign_count      INTEGER NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports      TEXT    CHECK (transports IS NULL OR json_valid(transports)),
  -- the relying-party id the credential was bound to. Recorded per credential
  -- so a domain move (R-022) can be detected per-resident instead of guessed.
  rp_id           TEXT    NOT NULL,
  device_label_ar TEXT    NOT NULL DEFAULT 'جهاز',
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_used_at    TEXT,
  revoked_at      TEXT,
  revoked_by      TEXT    REFERENCES profiles(id)
) STRICT;

CREATE INDEX idx_passkeys_profile ON passkeys(profile_id) WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
-- activation_challenges — تفعيل واسترجاع
-- Tokens are HASHED, single-use, one active per person. (02_DATA_MODEL §3)
-- -----------------------------------------------------------------------------
CREATE TABLE activation_challenges (
  id           TEXT    PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  profile_id   TEXT    NOT NULL REFERENCES profiles(id),
  token_hash   TEXT    NOT NULL UNIQUE,
  purpose      TEXT    NOT NULL CHECK (purpose IN ('first_activation','recovery','new_device')),
  channel      TEXT    NOT NULL CHECK (channel IN ('board_link','whatsapp_inbound','printed','console')),
  issued_by    TEXT    REFERENCES profiles(id),
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at   TEXT    NOT NULL,
  consumed_at  TEXT,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

-- One live challenge per person — no parallel-challenge race. (03_RBAC §4)
CREATE UNIQUE INDEX idx_activation_one_live ON activation_challenges(profile_id) WHERE consumed_at IS NULL;

-- -----------------------------------------------------------------------------
-- recovery_codes — أكواد الاسترجاع المطبوعة     (ADR-011, R-023)
-- Single-use, hashed, issued at activation.
-- -----------------------------------------------------------------------------
CREATE TABLE recovery_codes (
  id         TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  code_hash  TEXT NOT NULL UNIQUE,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

CREATE INDEX idx_recovery_profile ON recovery_codes(profile_id) WHERE used_at IS NULL;

-- -----------------------------------------------------------------------------
-- sessions — الجلسات
-- ⚠️ Sessions live in D1, NOT in KV. KV's free tier allows only 1,000 writes/day
--    (verified 2026-08-04) and it is the tightest quota in the entire stack;
--    D1 allows 100,000. Anything an unauthenticated caller can cause a write to
--    must never touch KV. KV holds read-mostly cached lookups only.
--    See INSIGHTS.md [free-tier] entry of 2026-08-04.
-- -----------------------------------------------------------------------------
CREATE TABLE sessions (
  id            TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  profile_id    TEXT NOT NULL REFERENCES profiles(id),
  token_hash    TEXT NOT NULL UNIQUE,
  -- who the session is acting AS, when a delegate is acting for an owner.
  -- NULL = acting as themselves. Every delegated action logs "بالنيابة عن".
  on_behalf_of  TEXT REFERENCES profiles(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_seen_at  TEXT,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  revoked_by    TEXT REFERENCES profiles(id),
  -- fresh passkey re-verification timestamp, for elevated actions (03_RBAC §5)
  reauth_at     TEXT,
  user_agent    TEXT,
  ip            TEXT
) STRICT;

CREATE INDEX idx_sessions_profile ON sessions(profile_id) WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
-- otp_challenges — DISABLED outbound adapter, retained per C1.
-- No code path writes here in v1. Kept so the fallback design is not lost.
-- -----------------------------------------------------------------------------
CREATE TABLE otp_challenges (
  id          TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  phone_e164  TEXT    NOT NULL,
  code_hash   TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

-- -----------------------------------------------------------------------------
-- buildings / units — العمارات والشقق
-- -----------------------------------------------------------------------------
CREATE TABLE buildings (
  id         TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  code       TEXT    NOT NULL UNIQUE,        -- "5"  → displayed as "عمارة 5"
  name_ar    TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
) STRICT;

CREATE TABLE units (
  id          TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  building_id TEXT    NOT NULL REFERENCES buildings(id),
  unit_number TEXT    NOT NULL,
  -- area in SQUARE CENTIMETRES (integer). numeric(8,2) m² would port to REAL,
  -- and a per-sqm due would then be computed through a float. (C4)
  area_cm2    INTEGER CHECK (area_cm2 IS NULL OR area_cm2 > 0),
  notes       TEXT,                          -- admin-only, never exposed to residents
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  UNIQUE (building_id, unit_number)
) STRICT;

CREATE INDEX idx_units_building ON units(building_id);

-- -----------------------------------------------------------------------------
-- unit_owners — many-to-many, EFFECTIVE-DATED
-- A sold flat closes the old row with valid_to; it is never deleted, so the
-- former owner's payments stay attributable and a dispute stays answerable.
-- -----------------------------------------------------------------------------
CREATE TABLE unit_owners (
  id                 TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  unit_id            TEXT    NOT NULL REFERENCES units(id),
  profile_id         TEXT    NOT NULL REFERENCES profiles(id),
  -- ownership share in BASIS POINTS (10000 = 100%). numeric(5,4) -> REAL would
  -- put a float on the path of any split obligation. (C4)
  share_bp           INTEGER NOT NULL DEFAULT 10000 CHECK (share_bp > 0 AND share_bp <= 10000),
  is_primary_contact INTEGER NOT NULL DEFAULT 1 CHECK (is_primary_contact IN (0,1)),
  valid_from         TEXT    NOT NULL CHECK (valid_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  valid_to           TEXT    CHECK (valid_to IS NULL OR valid_to GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
) STRICT;

-- One CURRENT ownership row per (unit, person).
CREATE UNIQUE INDEX idx_unit_owner_current ON unit_owners(unit_id, profile_id) WHERE valid_to IS NULL;
CREATE INDEX idx_unit_owners_profile ON unit_owners(profile_id);
CREATE INDEX idx_unit_owners_unit ON unit_owners(unit_id);

-- -----------------------------------------------------------------------------
-- delegate_authorizations — التفويض     (R-025)
-- Scoped to one unit, granular, and MUST expire.
-- -----------------------------------------------------------------------------
CREATE TABLE delegate_authorizations (
  id                   TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  owner_profile_id     TEXT    NOT NULL REFERENCES profiles(id),
  delegate_profile_id  TEXT    NOT NULL REFERENCES profiles(id),
  unit_id              TEXT    NOT NULL REFERENCES units(id),
  can_view_financials  INTEGER NOT NULL DEFAULT 0 CHECK (can_view_financials IN (0,1)),
  can_submit_payments  INTEGER NOT NULL DEFAULT 1 CHECK (can_submit_payments IN (0,1)),
  valid_from           TEXT    NOT NULL CHECK (valid_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- NOT NULL: an authorization with no end date is the R-025 failure mode.
  valid_to             TEXT    NOT NULL CHECK (valid_to GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  granted_by           TEXT    NOT NULL REFERENCES profiles(id),
  granted_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  revoked_at           TEXT,
  revoked_by           TEXT    REFERENCES profiles(id),
  reason_ar            TEXT,
  CHECK (valid_to > valid_from),
  CHECK (owner_profile_id <> delegate_profile_id)
) STRICT;

CREATE INDEX idx_delegate_active ON delegate_authorizations(delegate_profile_id, unit_id) WHERE revoked_at IS NULL;
