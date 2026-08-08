-- =============================================================================
-- 0023_village_map.sql — خريطة القرية.  C13 / 07_VILLAGE_MAP_SPEC.md
--
-- ⚠️ PORTABILITY NOTE — every RAISE message here is ONE string literal.
-- `RAISE(ABORT, 'a' || 'b')` parses on SQLite 3.51 and is a SYNTAX ERROR on
-- 3.45. See the note at the head of 0021.
--
-- ## Why this arrives at session 28
--
-- `07_VILLAGE_MAP_SPEC.md` and constraint **C13** are in the v1.4 spec pack and
-- were absent from the copy this project was built from. Twenty-seven sessions
-- against a truncated specification, found by diffing the uploaded packs
-- against this repo. Village navigation is product goal FOUR in the master
-- prompt; it was not a nice-to-have that got deprioritised, it was invisible.
--
-- ## The one rule everything here exists to enforce
--
--   > "Never create production `buildings` or `units` rows from image labels."
--
-- The supplied picture is a photographed, cropped brochure plan. Labels in the
-- visible portion run 14–46. That range is **not** evidence of how many
-- buildings the village has, and buildings 1–13 are not established by it at
-- all. A map is a navigation layer over the register; the register is the
-- truth.
--
-- So `building_map_features.building_id` REFERENCES `buildings(id)`. A hotspot
-- for a building that does not exist is not representable, and a label alone
-- can never bring one into being. That is C13 made structural rather than
-- documented.
--
-- ## Coordinates are normalised integers, never pixels
--
-- 0–10,000 on each axis (spec §6). A pixel coordinate is meaningful at exactly
-- one rendered size, so an overlay built from pixels drifts the moment the
-- image is responsive — which on a phone it always is.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- map_documents — one row per version of the drawing.
-- -----------------------------------------------------------------------------
CREATE TABLE map_documents (
  id                 TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  title_ar           TEXT NOT NULL,
  -- The untouched upload is kept forever; the display copy is the rotated,
  -- metadata-stripped derivative residents actually see. Keeping both is what
  -- makes "is this really the board's plan?" answerable a decade from now.
  source_storage_key  TEXT NOT NULL,
  display_storage_key TEXT NOT NULL,
  -- UNIQUE per byte-identical source: re-uploading the same photograph is not
  -- a new version, and treating it as one turns "map history" into noise.
  source_sha256      TEXT NOT NULL UNIQUE CHECK (length(source_sha256) = 64),
  display_sha256     TEXT NOT NULL CHECK (length(display_sha256) = 64),
  version_label      TEXT NOT NULL UNIQUE,
  -- REQUIRED, and required to be non-empty. The honest sentence — «الخريطة دي
  -- جزء من القرية مش كلها» — is exactly the one a board omits by accident.
  coverage_note_ar   TEXT NOT NULL CHECK (length(trim(coverage_note_ar)) > 0),
  status             TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','published','archived')),
  created_by         TEXT NOT NULL REFERENCES profiles(id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  published_by       TEXT REFERENCES profiles(id),
  published_at       TEXT,
  -- Publication carries a signature and a time, or it is not publication.
  CHECK (status <> 'published' OR (published_by IS NOT NULL AND published_at IS NOT NULL))
) STRICT;

-- "Exactly one published map at a time" (spec §6). A partial unique index says
-- it once, in the database; application code would have to say it everywhere.
CREATE UNIQUE INDEX ux_one_published_map
  ON map_documents(status) WHERE status = 'published';

-- -----------------------------------------------------------------------------
-- building_map_features — a hotspot, and what it points at.
-- -----------------------------------------------------------------------------
CREATE TABLE building_map_features (
  id                  TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  map_document_id     TEXT NOT NULL REFERENCES map_documents(id),
  -- Nullable in draft, REQUIRED before publish (trigger below). This column is
  -- where C13 stops being a paragraph and starts being a constraint.
  building_id         TEXT REFERENCES buildings(id),
  -- Copied for display. NOT identity — the spec is explicit about this, and it
  -- is precisely the field a future reader will be tempted to join on.
  label_ar            TEXT NOT NULL,
  -- Normalised integers 0–10000, as "x,y,w,h". Parsed by the view layer, which
  -- is the only place that knows about rendered pixels.
  x                   INTEGER NOT NULL CHECK (x BETWEEN 0 AND 10000),
  y                   INTEGER NOT NULL CHECK (y BETWEEN 0 AND 10000),
  w                   INTEGER NOT NULL CHECK (w BETWEEN 1 AND 10000),
  h                   INTEGER NOT NULL CHECK (h BETWEEN 1 AND 10000),
  verification_status TEXT NOT NULL DEFAULT 'unverified'
                           CHECK (verification_status IN ('unverified','board_verified','rejected')),
  verified_by         TEXT REFERENCES profiles(id),
  verified_at         TEXT,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  CHECK (x + w <= 10000 AND y + h <= 10000),
  CHECK (verification_status <> 'board_verified'
         OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_map_features_doc ON building_map_features(map_document_id, sort_order);

-- "A building appears at most once per map version" (spec §6). Partial, because
-- several draft hotspots may legitimately have no building linked yet.
CREATE UNIQUE INDEX ux_building_once_per_map
  ON building_map_features(map_document_id, building_id)
  WHERE building_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- The publication invariants, as refusals (ADR-024).
-- -----------------------------------------------------------------------------

-- ⭐ C13 itself. An unverified or unlinked hotspot cannot reach a resident.
CREATE TRIGGER trg_map_publish_needs_verified_features
BEFORE UPDATE OF status ON map_documents
FOR EACH ROW
WHEN NEW.status = 'published' AND OLD.status <> 'published'
 AND EXISTS (
   SELECT 1 FROM building_map_features f
    WHERE f.map_document_id = NEW.id
      AND (f.building_id IS NULL OR f.verification_status <> 'board_verified'))
BEGIN
  SELECT RAISE(ABORT, 'مينفعش تنشر الخريطة وفيها مواقع لسه مش متأكد منها أو مش مربوطة بعمارة موجودة');
END;

-- A published map with no hotspots is a blank picture presented as a verified
-- plan. Refused for the same reason an empty subscription is refused.
CREATE TRIGGER trg_map_publish_needs_features
BEFORE UPDATE OF status ON map_documents
FOR EACH ROW
WHEN NEW.status = 'published' AND OLD.status <> 'published'
 AND NOT EXISTS (SELECT 1 FROM building_map_features f WHERE f.map_document_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'الخريطة دي مفيهاش أي عمارة متحددة — مينفعش تتنشر');
END;

-- The source image is immutable. A "new version" is a new row, which is what
-- keeps the checksum in the manifest meaningful.
CREATE TRIGGER trg_map_source_immutable
BEFORE UPDATE OF source_sha256, source_storage_key ON map_documents
FOR EACH ROW
WHEN NEW.source_sha256 <> OLD.source_sha256 OR NEW.source_storage_key <> OLD.source_storage_key
BEGIN
  SELECT RAISE(ABORT, 'صورة الخريطة الأصلية مش بتتغيّر — اعمل نسخة جديدة');
END;

-- Verifying a hotspot is a person's act with a name and a time against it.
-- Nothing else in this schema lets an admin say "I checked this on the ground",
-- and that sentence is the entire value of the verification column.
CREATE TRIGGER trg_map_feature_verify_needs_signature
BEFORE UPDATE OF verification_status ON building_map_features
FOR EACH ROW
WHEN NEW.verification_status = 'board_verified'
 AND (NEW.verified_by IS NULL OR NEW.verified_at IS NULL OR NEW.building_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'التأكيد لازم يبقى باسم عضو مجلس وبتاريخ، والموقع مربوط بعمارة موجودة');
END;

-- A published map is frozen. Editing a hotspot residents are already navigating
-- by is the map equivalent of restating a published due.
CREATE TRIGGER trg_map_feature_frozen_when_published
BEFORE UPDATE ON building_map_features
FOR EACH ROW
WHEN (SELECT status FROM map_documents WHERE id = OLD.map_document_id) = 'published'
 AND (NEW.x <> OLD.x OR NEW.y <> OLD.y OR NEW.w <> OLD.w OR NEW.h <> OLD.h
      OR NEW.building_id IS NOT OLD.building_id)
BEGIN
  SELECT RAISE(ABORT, 'الخريطة دي منشورة — لو فيه تعديل اعمل نسخة جديدة وانشرها');
END;

-- -----------------------------------------------------------------------------
-- Albums gain a building.
--
-- Spec §4 wants the selection panel to show "the latest public maintenance
-- item" for the building somebody just tapped, and `albums` had no way to say
-- which building an album was about. Nullable, because most albums are about
-- the village rather than one block — a pool repair belongs to everybody.
--
-- This is the map paying its way: without it, tapping a building yields a name
-- and a flat count, which a resident already knew.
-- -----------------------------------------------------------------------------
ALTER TABLE albums ADD COLUMN building_id TEXT REFERENCES buildings(id);
CREATE INDEX idx_albums_building ON albums(building_id) WHERE building_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- What a resident sees: the published map, verified hotspots only.
-- -----------------------------------------------------------------------------
CREATE VIEW v_published_map AS
SELECT d.id              AS map_id,
       d.title_ar,
       d.display_storage_key,
       d.display_sha256,
       d.version_label,
       d.coverage_note_ar,
       d.published_at,
       f.id              AS feature_id,
       f.building_id,
       f.label_ar,
       f.x, f.y, f.w, f.h,
       f.sort_order,
       b.code            AS building_code,
       b.name_ar         AS building_name_ar
  FROM map_documents d
  JOIN building_map_features f ON f.map_document_id = d.id
  JOIN buildings b             ON b.id = f.building_id
 WHERE d.status = 'published'
   AND f.verification_status = 'board_verified'
 ORDER BY f.sort_order, CAST(b.code AS INTEGER), b.code;

-- What the board still has to do before anybody sees a map. A view rather than
-- a message, so `/admin/map` can show the REASON a draft cannot be published
-- instead of only refusing it.
CREATE VIEW v_map_publication_blockers AS
SELECT d.id AS map_id,
       d.version_label,
       COUNT(f.id)                                                          AS total,
       SUM(CASE WHEN f.building_id IS NULL THEN 1 ELSE 0 END)               AS unlinked,
       SUM(CASE WHEN f.verification_status = 'unverified' THEN 1 ELSE 0 END) AS unverified,
       SUM(CASE WHEN f.verification_status = 'rejected'   THEN 1 ELSE 0 END) AS rejected
  FROM map_documents d
  LEFT JOIN building_map_features f ON f.map_document_id = d.id
 WHERE d.status = 'draft'
 GROUP BY d.id, d.version_label;
