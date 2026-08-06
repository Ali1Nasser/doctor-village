-- =============================================================================
-- 0004_content_and_system.sql — content, search, audit, settings, quota control
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- posts — أخبار، إعلانات، قرارات، محاضر، مستندات
-- -----------------------------------------------------------------------------
CREATE TABLE posts (
  id           TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  type         TEXT    NOT NULL CHECK (type IN ('news','announcement','decision','minutes','document')),
  slug         TEXT    NOT NULL UNIQUE,
  title_ar     TEXT    NOT NULL,
  body_ar      TEXT    NOT NULL DEFAULT '',
  -- search_body is title+body with Arabic orthographic variants folded
  -- (أ إ آ ٱ -> ا ، ة -> ه ، ى -> ي ، tashkeel stripped). FTS5's unicode61
  -- tokenizer does NOT do this, so "الاجتماع" would not match "الإجتماع".
  -- Folding happens in lib/search/ before write; this column stores the result.
  search_body  TEXT    NOT NULL DEFAULT '',
  published_at TEXT,
  is_pinned    INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0,1)),
  author_id    TEXT    NOT NULL REFERENCES profiles(id),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT,
  deleted_at   TEXT
) STRICT;

CREATE INDEX idx_posts_published ON posts(published_at DESC) WHERE published_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_posts_type ON posts(type);

CREATE TABLE post_attachments (
  id          TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  post_id     TEXT    NOT NULL REFERENCES posts(id),
  storage_key TEXT    NOT NULL,
  name_ar     TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL CHECK (size_bytes > 0),
  mime        TEXT    NOT NULL,
  -- extracted PDF text, folded, so a word inside a PDF is findable (CP-6 gate)
  extracted_text TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX idx_attachments_post ON post_attachments(post_id);

-- -----------------------------------------------------------------------------
-- Arabic full-text search — tsvector -> FTS5     (CP-6 gate)
-- -----------------------------------------------------------------------------
CREATE VIRTUAL TABLE posts_fts USING fts5(
  title_ar,
  search_body,
  attachment_text,
  content = '',
  tokenize = "unicode61 remove_diacritics 2"
);

-- -----------------------------------------------------------------------------
-- albums / album_photos — أعمال الصيانة والتطوير
-- -----------------------------------------------------------------------------
CREATE TABLE albums (
  id             TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  title_ar       TEXT NOT NULL,
  description_ar TEXT NOT NULL DEFAULT '',
  happened_on    TEXT CHECK (happened_on IS NULL OR happened_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  cover_photo_id TEXT,
  linked_expense_id TEXT REFERENCES expenses(id),
  created_by     TEXT NOT NULL REFERENCES profiles(id),
  published_at   TEXT,
  -- 04_UX_SPEC §6a: an album cannot be published until the photo-safety
  -- checklist has been ticked by a named editor. R-026.
  safety_checked_by TEXT REFERENCES profiles(id),
  safety_checked_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (published_at IS NULL OR safety_checked_by IS NOT NULL)
) STRICT;

CREATE TABLE album_photos (
  id           TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  album_id     TEXT    NOT NULL REFERENCES albums(id),
  storage_key  TEXT    NOT NULL,
  caption_ar   TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  taken_at     TEXT,
  -- R-026: proof that geolocation/EXIF was stripped. An album photo without
  -- this flag cannot be served. Set by the upload pipeline, never by hand.
  exif_stripped INTEGER NOT NULL DEFAULT 0 CHECK (exif_stripped IN (0,1))
) STRICT;

CREATE INDEX idx_photos_album ON album_photos(album_id);

-- -----------------------------------------------------------------------------
-- maintenance_tickets — بلاغات الصيانة  (proposed value-add #7, not yet approved)
-- Table created now so the expense->ticket link exists; UI is out of v1 scope
-- until the owner approves docs/PROPOSALS.md item 7.
-- -----------------------------------------------------------------------------
CREATE TABLE maintenance_tickets (
  id                TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  ticket_no         TEXT    NOT NULL UNIQUE,
  reported_by       TEXT    NOT NULL REFERENCES profiles(id),
  unit_id           TEXT    REFERENCES units(id),
  category_id       TEXT    REFERENCES categories(id),
  title_ar          TEXT    NOT NULL,
  description_ar    TEXT    NOT NULL DEFAULT '',
  voice_note_key    TEXT,
  status            TEXT    NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open','acknowledged','in_progress','resolved','closed','rejected')),
  assigned_to       TEXT    REFERENCES profiles(id),
  linked_expense_id TEXT    REFERENCES expenses(id),
  resolved_at       TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

-- -----------------------------------------------------------------------------
-- notifications
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
  id         TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  kind       TEXT NOT NULL CHECK (kind IN
             ('payment_approved','payment_rejected','payment_needs_info',
              'new_announcement','due_reminder','account_changed','system')),
  title_ar   TEXT NOT NULL,
  body_ar    TEXT NOT NULL,
  link_path  TEXT,
  channel    TEXT NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app','whatsapp','sms')),
  sent_at    TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

CREATE INDEX idx_notifications_unread ON notifications(profile_id) WHERE read_at IS NULL;

-- -----------------------------------------------------------------------------
-- audit_log — INSERT ONLY. For everyone. Including developer.  (access test 8)
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
  id           TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  actor_id     TEXT REFERENCES profiles(id),
  actor_role   TEXT,
  on_behalf_of TEXT REFERENCES profiles(id),
  action       TEXT NOT NULL,
  entity_table TEXT NOT NULL,
  entity_id    TEXT,
  before_json  TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json   TEXT CHECK (after_json  IS NULL OR json_valid(after_json)),
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

CREATE INDEX idx_audit_entity ON audit_log(entity_table, entity_id);
CREATE INDEX idx_audit_actor  ON audit_log(actor_id);
CREATE INDEX idx_audit_time   ON audit_log(created_at DESC);

CREATE TRIGGER trg_audit_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'سجل المراجعة مش بيتعدّل — the audit log is insert-only');
END;

CREATE TRIGGER trg_audit_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'سجل المراجعة مش بيتمسح — the audit log is insert-only');
END;

-- -----------------------------------------------------------------------------
-- storage_objects — the hard application-level cap on object storage
-- 05_ZERO_COST_ARCHITECTURE §2a: whichever provider is chosen, the upload path
-- refuses any write that would take total usage past the configured ceiling.
-- The ceiling is enforced HERE, in our own code, not by trusting a vendor.
-- -----------------------------------------------------------------------------
CREATE TABLE storage_objects (
  storage_key  TEXT    NOT NULL PRIMARY KEY,
  bucket       TEXT    NOT NULL,
  owner_kind   TEXT    NOT NULL CHECK (owner_kind IN
               ('payment_receipt','expense_invoice','album_photo','post_attachment','backup','voice_note')),
  owner_id     TEXT    NOT NULL,
  -- unit scoping is what the file-serving route re-checks on EVERY request (C6)
  unit_id      TEXT    REFERENCES units(id),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256       TEXT,
  mime         TEXT    NOT NULL,
  exif_stripped INTEGER NOT NULL DEFAULT 0 CHECK (exif_stripped IN (0,1)),
  created_by   TEXT    REFERENCES profiles(id),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at   TEXT
) STRICT;

CREATE INDEX idx_storage_unit  ON storage_objects(unit_id);
CREATE INDEX idx_storage_owner ON storage_objects(owner_kind, owner_id);

-- -----------------------------------------------------------------------------
-- quota_snapshots — /admin/health     (05 §7, CP-3)
-- Residents must never learn about a quota by the site breaking.
-- -----------------------------------------------------------------------------
CREATE TABLE quota_snapshots (
  id            TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  service       TEXT    NOT NULL,
  metric        TEXT    NOT NULL,
  used          INTEGER NOT NULL CHECK (used >= 0),
  limit_value   INTEGER NOT NULL CHECK (limit_value > 0),
  pct_used      INTEGER NOT NULL CHECK (pct_used >= 0),
  reset_period  TEXT    NOT NULL CHECK (reset_period IN ('daily','monthly','none')),
  captured_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

CREATE INDEX idx_quota_service ON quota_snapshots(service, captured_at DESC);

-- -----------------------------------------------------------------------------
-- settings — single row
-- ⚠️ Bank / InstaPay details are TODO(owner-input) — see Q13. They must never
--    be invented. The seed inserts NULLs and the payment screen shows a clear
--    "الإدارة لسه محطتش بيانات التحويل" state until the owner supplies them.
-- -----------------------------------------------------------------------------
CREATE TABLE settings (
  id                     INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  community_name_ar      TEXT    NOT NULL DEFAULT 'قرية الأطباء — عجيبة، مرسى مطروح',
  logo_storage_key       TEXT,
  instapay_handle        TEXT,     -- TODO(owner-input) Q13
  bank_name_ar           TEXT,     -- TODO(owner-input) Q13
  bank_account_no        TEXT,     -- TODO(owner-input) Q13
  vodafone_cash_no       TEXT,     -- TODO(owner-input) Q13
  fiscal_year_start_md   TEXT     NOT NULL DEFAULT '01-01',
  countersign_threshold_piastres INTEGER NOT NULL DEFAULT 500000 CHECK (countersign_threshold_piastres > 0),
  storage_hard_cap_bytes INTEGER NOT NULL DEFAULT 7516192768 CHECK (storage_hard_cap_bytes > 0), -- 7 GiB
  notify_quiet_from      TEXT    NOT NULL DEFAULT '22:00',
  notify_quiet_to        TEXT    NOT NULL DEFAULT '09:00',
  unit_status_public     INTEGER NOT NULL DEFAULT 0 CHECK (unit_status_public IN (0,1)), -- Q11: OFF until the assembly approves
  staff_names_public     INTEGER NOT NULL DEFAULT 0 CHECK (staff_names_public IN (0,1)), -- Q4:  OFF by default
  updated_by             TEXT    REFERENCES profiles(id),
  updated_at             TEXT
) STRICT;

INSERT INTO settings (id) VALUES (1);
