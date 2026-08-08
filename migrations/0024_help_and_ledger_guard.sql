-- =============================================================================
-- 0024_help_and_ledger_guard.sql — two unrelated holes, both found by diffing
-- this repo against the uploaded packs (2026-08-08).
--
-- ⚠️ PORTABILITY NOTE — every RAISE message here is ONE string literal.
-- See the note at the head of 0021.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- =============================================================================
-- 1. The board's PUBLISHED contact details
--
-- Every screen renders a floating «محتاج مساعدة؟» button pointing at `/help`.
-- There is no such route: the most visible control in the product, on all 33
-- screens, has been a 404 since it was added. Building the screen needs
-- somewhere to put a phone number, and the obvious place is the wrong one.
--
-- ## Why this is not read from `phone_identifiers`
--
-- The obvious implementation is to print the chairman's number out of
-- `phone_identifiers`. That is a C6 breach with extra steps: a board member is
-- also a resident, his number is in that table because it is how he LOGS IN,
-- and storing a login identifier is not consent to broadcast it to 204 flats.
--
-- So publication is a separate, deliberate act with its own storage, NULL by
-- default. Until somebody types a number into the settings screen and means it,
-- `/help` shows no number at all. A missing number is a mild inconvenience; a
-- published one nobody agreed to publish cannot be taken back — the screenshot
-- has already gone round the compound.
-- =============================================================================

ALTER TABLE settings ADD COLUMN office_phone    TEXT;
ALTER TABLE settings ADD COLUMN office_whatsapp TEXT;
ALTER TABLE settings ADD COLUMN office_hours_ar TEXT;
ALTER TABLE settings ADD COLUMN office_label_ar TEXT;

-- Same shape rule as every other Egyptian number here. A trigger rather than a
-- CHECK because SQLite cannot add a CHECK to an existing table — and a number
-- of the wrong shape is a `tel:` link that fails silently on the one phone that
-- matters.
--
-- Note the GLOB: ten single-character classes, not thirteen. Real D1 refuses
-- thirteen with "LIKE or GLOB pattern too complex" — measured on 2026-08-07,
-- and the reason 0001's phone CHECK is written the way it is.
CREATE TRIGGER trg_office_phone_shape
BEFORE UPDATE OF office_phone, office_whatsapp ON settings
FOR EACH ROW
WHEN (NEW.office_phone IS NOT NULL AND NEW.office_phone <> ''
      AND NEW.office_phone NOT GLOB '+201[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]')
  OR (NEW.office_whatsapp IS NOT NULL AND NEW.office_whatsapp <> ''
      AND NEW.office_whatsapp NOT GLOB '+201[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]')
BEGIN
  SELECT RAISE(ABORT, 'رقم المكتب لازم يبقى بالشكل ده: +201xxxxxxxxx');
END;

-- ⭐ Refuses publishing a number that belongs to somebody who is not staff.
-- The realistic failure is not malice, it is a fat finger: an admin pastes a
-- number from the wrong row and 204 flats start phoning a retired
-- anaesthetist about the pool pump. This cannot catch a number that is merely
-- wrong; it does catch the one that is wrong AND belongs to a resident here.
CREATE TRIGGER trg_office_phone_not_a_resident
BEFORE UPDATE OF office_phone, office_whatsapp ON settings
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM phone_identifiers pi
    JOIN profiles p ON p.id = pi.profile_id
   WHERE pi.status = 'active'
     AND pi.phone_e164 IN (COALESCE(NEW.office_phone, ''), COALESCE(NEW.office_whatsapp, ''))
     AND p.role = 'resident')
BEGIN
  SELECT RAISE(ABORT, 'الرقم ده بتاع ساكن مسجّل في البوابة — مينفعش يتنشر كرقم المكتب');
END;

CREATE VIEW v_help_contacts AS
SELECT office_label_ar AS label_ar,
       office_phone    AS phone,
       office_whatsapp AS whatsapp,
       office_hours_ar AS hours_ar
  FROM settings WHERE id = 1;

-- =============================================================================
-- 2. The orphan-entry guard — the mirror of R-078
--
-- `journal_entries` carries the comment "every entry traces to an approved
-- source document. No orphan entries. (06 §2)" and a CHECK that `source_id` is
-- NOT NULL. That is not the same statement. Nothing verified that the id
-- pointed at anything, so a posting could name any `source_id` it liked and the
-- books would accept it: the ledger could carry income attributed to a receipt
-- that was rejected, or to no receipt at all.
--
-- The other direction already holds — `payments` has
-- `CHECK (status <> 'approved' OR journal_entry_id IS NOT NULL)`, and that
-- CHECK is the only reason R-078's missing posting surfaced as a loud failure
-- instead of a treasury figure that silently never moved.
--
-- With both directions in place, «كل قرش في الدفتر له إيصال، وكل إيصال معتمد له
-- قيد» is something the database enforces rather than something the code
-- intends.
--
-- ## Why it fires at POSTING and not at insert
--
-- An entry is created unposted and its payment is linked in the same batch; at
-- INSERT time the two do not yet agree, by design (it is also what makes the
-- CP-8 restore replay possible). Posting is the moment the entry becomes part
-- of the books, so posting is the moment the claim has to be true.
-- =============================================================================

CREATE TRIGGER trg_entry_payment_source_must_exist
BEFORE UPDATE OF posted_at ON journal_entries
FOR EACH ROW
WHEN NEW.posted_at IS NOT NULL AND OLD.posted_at IS NULL
 AND NEW.source_type = 'payment'
 AND NEW.is_reversal = 0
 AND NOT EXISTS (
   SELECT 1 FROM payments p
    WHERE p.id = NEW.source_id
      AND p.journal_entry_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'القيد ده بيقول إنه من إيصال، والإيصال ده مش موجود أو مش مربوط بيه');
END;

CREATE TRIGGER trg_entry_expense_source_must_exist
BEFORE UPDATE OF posted_at ON journal_entries
FOR EACH ROW
WHEN NEW.posted_at IS NOT NULL AND OLD.posted_at IS NULL
 AND NEW.source_type = 'expense'
 AND NEW.is_reversal = 0
 AND NOT EXISTS (
   SELECT 1 FROM expenses e
    WHERE e.id = NEW.source_id
      AND e.journal_entry_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'القيد ده بيقول إنه من مصروف، والمصروف ده مش موجود أو مش مربوط بيه');
END;
