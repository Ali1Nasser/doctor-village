-- =============================================================================
-- 0020_content_search.sql — make the CP-6 search index actually usable.
--
-- ## What was wrong with the index as built in 0004
--
-- `posts_fts` was created with `content = ''` — a *contentless* FTS5 table. That
-- shape stores only the inverted index and keeps no copy of the text, which is
-- efficient and completely correct **if** you also keep a stable mapping from
-- FTS rowid back to the row it describes, and never need to update or delete a
-- document. 0004 provided neither: `posts.id` is a 26-char ULID with no integer
-- key to hang a rowid on, and there are no sync triggers. In that state:
--
--   · a search can return a hit but cannot say WHICH post it hit;
--   · editing a post's title leaves the old title matchable forever;
--   · deleting a post leaves it in the index, so a retracted announcement stays
--     findable — the one failure mode with a legal edge to it.
--
-- SQLite 3.43 added `contentless_delete=1`, which fixes deletes. It is not used
-- here: D1's SQLite build version is still unverified on this project (A-05 /
-- R-031), and a migration that only applies on some SQLite builds is exactly the
-- kind of thing that passes locally and fails on deploy day.
--
-- ## What this does instead
--
-- Rebuilds `posts_fts` as an ordinary content-ful FTS5 table carrying its own
-- `post_id` as an UNINDEXED column. Ordinary FTS5 tables support INSERT, UPDATE
-- and DELETE by rowid on every SQLite that has FTS5 at all, and the UNINDEXED
-- column answers "which post was that?" without a join or a mapping table.
--
-- The cost is a second copy of the post text. For a village portal — a few
-- hundred announcements over the archive's whole life — that is kilobytes, and
-- it buys a search index that stays truthful when content changes.
--
-- ## Folding
--
-- `search_body` and `attachment_text` are written ALREADY FOLDED by
-- `lib/search/fold.ts`. The tokenizer's `remove_diacritics 2` is kept as a
-- second line of defence, but it is not what makes «الإجتماع» find «الاجتماع» —
-- unicode61 has no Arabic orthography. See that file for why.
-- =============================================================================

DROP TABLE IF EXISTS posts_fts;

CREATE VIRTUAL TABLE posts_fts USING fts5(
  post_id UNINDEXED,
  title_ar,
  search_body,
  attachment_text,
  tokenize = "unicode61 remove_diacritics 2"
);

-- -----------------------------------------------------------------------------
-- Album titles and captions are searchable too. CP-6's promise is "nothing is
-- ever lost in WhatsApp again", and a resident looking for the photos of the
-- wall repair does not care that the portal files those under a different noun
-- than announcements. One search box, both archives.
-- -----------------------------------------------------------------------------
CREATE VIRTUAL TABLE albums_fts USING fts5(
  album_id UNINDEXED,
  title_ar,
  search_body,
  tokenize = "unicode61 remove_diacritics 2"
);

-- -----------------------------------------------------------------------------
-- maintenance_tickets gains the columns the UI needs and 0004 left out:
-- a folded search column, and the resident-visible acknowledgement text.
--
-- 0004 created the table "so the expense->ticket link exists; UI is out of v1
-- scope until the owner approves docs/PROPOSALS.md item 7." The owner has now
-- asked for the complete product, so the UI is in scope and these are the
-- columns it needs. Nothing here changes the financial meaning of a ticket:
-- a ticket is still not money, and linking one to an expense still does not
-- create, approve or move a single piastre.
-- -----------------------------------------------------------------------------
ALTER TABLE maintenance_tickets ADD COLUMN search_body TEXT NOT NULL DEFAULT '';
ALTER TABLE maintenance_tickets ADD COLUMN resolution_ar TEXT NOT NULL DEFAULT '';
ALTER TABLE maintenance_tickets ADD COLUMN acknowledged_at TEXT;

CREATE INDEX idx_tickets_status ON maintenance_tickets(status, created_at DESC);
CREATE INDEX idx_tickets_reporter ON maintenance_tickets(reported_by);

-- -----------------------------------------------------------------------------
-- A published album must have had its photo-safety checklist ticked. 0004 wrote
-- that as a table CHECK, which is correct at INSERT but cannot see an UPDATE
-- that publishes a row by setting `published_at` alone... except that a table
-- CHECK in SQLite IS re-evaluated on UPDATE. So the constraint holds.
--
-- What the CHECK cannot express is the part that matters just as much: the
-- person who ticks the safety checklist must not be the only evidence that it
-- happened. This trigger refuses a publish whose safety check has no timestamp,
-- closing the shape where `safety_checked_by` is set to satisfy the CHECK and
-- the checklist was never actually opened. R-026.
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_album_publish_needs_safety
BEFORE UPDATE OF published_at ON albums
WHEN NEW.published_at IS NOT NULL
 AND (NEW.safety_checked_by IS NULL OR NEW.safety_checked_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'الألبوم لازم يعدّي مراجعة صور قبل النشر — album needs its photo-safety check first');
END;

-- -----------------------------------------------------------------------------
-- A photo whose EXIF was never stripped must never become servable. The upload
-- pipeline sets `exif_stripped`; this refuses the row outright if it did not,
-- so a future upload path that forgets the step fails loudly at write time
-- instead of quietly publishing a resident's home coordinates. R-026.
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_photo_requires_exif_strip
BEFORE INSERT ON album_photos
WHEN NEW.exif_stripped <> 1
BEGIN
  SELECT RAISE(ABORT, 'الصورة لازم تتشال منها بيانات المكان قبل الحفظ — photo EXIF must be stripped before storage');
END;

-- -----------------------------------------------------------------------------
-- v_content_archive — the "≤ 3 taps to a 2-year-old announcement" gate.
--
-- One ordered list of everything published, newest first, with the year and
-- month already computed so the archive screen can group without date parsing
-- in TypeScript (which is where timezone bugs come from). The gate is met by
-- year → month → post.
-- -----------------------------------------------------------------------------
CREATE VIEW v_content_archive AS
SELECT
  p.id            AS content_id,
  'post'          AS content_kind,
  p.type          AS content_type,
  p.slug          AS slug,
  p.title_ar      AS title_ar,
  p.published_at  AS published_at,
  substr(p.published_at, 1, 4) AS year,
  substr(p.published_at, 6, 2) AS month,
  p.is_pinned     AS is_pinned
FROM posts p
WHERE p.published_at IS NOT NULL AND p.deleted_at IS NULL
UNION ALL
SELECT
  a.id, 'album', 'album', a.id, a.title_ar, a.published_at,
  substr(a.published_at, 1, 4), substr(a.published_at, 6, 2), 0
FROM albums a
WHERE a.published_at IS NOT NULL;
