-- =============================================================================
-- 0022_fee_generation.sql
--
-- ⚠️ PORTABILITY NOTE — every RAISE message below is ONE string literal.
-- `RAISE(ABORT, 'a' || 'b')` parses on SQLite 3.51 and is a SYNTAX ERROR on
-- 3.45. See the note at the head of 0021 for the full story.
--
-- Makes the annual subscription something the board can create, and then makes
-- it impossible to quietly restate.
--
-- ## The thing this protects
--
-- `unit_dues.amount_piastres` is what a resident was TOLD they owe. The schema
-- comment on that column already says the amount is "computed at generation
-- then FROZEN", and until now nothing froze it: an UPDATE would have silently
-- restated every statement, every arrears figure and every "باقي عليك" line on
-- every screen, retroactively, with no trace. A resident who paid what they
-- were asked would appear to be in arrears, and the board would have no way to
-- show what the original figure was.
--
-- Publication is the line. Before it, a draft period is a working document and
-- everything about it can change. After it, residents have seen a number, and
-- the number is a statement of fact about what was asked of them.
--
-- ## Why a waiver is still allowed afterwards
--
-- `waived_piastres` is a SEPARATE column for exactly this reason (06 §4): a
-- board that decides not to collect from a widow is not rewriting what she was
-- billed, it is recording a decision. It shows on the statement as a waiver,
-- with a reason and a name against it. Editing `amount_piastres` down to zero
-- would achieve the same balance and destroy the record of the decision — so
-- one is permitted and the other refused.
--
-- ## Generation is per-unit and idempotent
--
-- `UNIQUE (fee_period_id, unit_id)` already exists, so a double-clicked
-- "generate" cannot bill a flat twice. `INSERT OR IGNORE` in lib/db/fees.ts
-- relies on that constraint rather than on the caller being careful.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A published fee period is frozen: not the name, not the dates, and above all
-- not the amount or the basis. Unpublishing is refused outright — a period that
-- residents have seen does not become a draft again; if it was wrong, the board
-- issues a corrected period and says so.
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_fee_period_frozen_after_publish
BEFORE UPDATE ON fee_periods
WHEN OLD.is_published = 1
 AND (NEW.amount_piastres <> OLD.amount_piastres
   OR NEW.basis           <> OLD.basis
   OR NEW.due_on          <> OLD.due_on
   OR NEW.starts_on       <> OLD.starts_on
   OR NEW.ends_on         <> OLD.ends_on)
BEGIN
  SELECT RAISE(ABORT, 'الاشتراك ده اتنشر خلاص والسكان شافوا الرقم — مش بيتعدّل. لو فيه غلط اعمل فترة تصحيح جديدة واكتب السبب.');
END;

CREATE TRIGGER trg_fee_period_no_unpublish
BEFORE UPDATE OF is_published ON fee_periods
WHEN OLD.is_published = 1 AND NEW.is_published = 0
BEGIN
  SELECT RAISE(ABORT, 'مش ممكن ترجّع اشتراك منشور لمسودة — السكان شافوه بالفعل.');
END;

-- -----------------------------------------------------------------------------
-- Publishing an empty period is refused. It is the single most likely mistake
-- in this flow — create the period, publish it, and only then notice that
-- nobody was billed — and it is invisible from the admin's side, because the
-- period looks published and correct. The resident's side is where it shows:
-- everyone's "المطلوب منك" stays at zero and the board thinks it collected.
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_fee_period_publish_needs_dues
BEFORE UPDATE OF is_published ON fee_periods
WHEN NEW.is_published = 1 AND OLD.is_published = 0
 AND (SELECT COUNT(*) FROM unit_dues d WHERE d.fee_period_id = OLD.id) = 0
BEGIN
  SELECT RAISE(ABORT, 'مفيش ولا وحدة اتحسب عليها الاشتراك ده. اعمل التوزيع الأول وبعدين انشر.');
END;

-- -----------------------------------------------------------------------------
-- After publication the dues are the record. No new rows (a flat missed at
-- generation is added by a corrective period, not by a quiet late insert), no
-- deletions, and no change to the billed amount.
--
-- `waived_piastres`, `waiver_reason_ar`, `waived_by` and `waived_at` are
-- deliberately absent from the refusal: a waiver is a decision recorded on top
-- of the bill, not an edit of it.
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_dues_no_insert_after_publish
BEFORE INSERT ON unit_dues
WHEN (SELECT is_published FROM fee_periods WHERE id = NEW.fee_period_id) = 1
BEGIN
  SELECT RAISE(ABORT, 'الاشتراك ده منشور — مش ممكن تضيف وحدة عليه دلوقتي.');
END;

CREATE TRIGGER trg_dues_amount_frozen_after_publish
BEFORE UPDATE OF amount_piastres ON unit_dues
WHEN (SELECT is_published FROM fee_periods WHERE id = OLD.fee_period_id) = 1
 AND NEW.amount_piastres <> OLD.amount_piastres
BEGIN
  SELECT RAISE(ABORT, 'ده الرقم اللي اتقال للساكن — مش بيتغيّر. لو المجلس قرر يعفيه، سجّلها إعفاء بسبب مكتوب.');
END;

CREATE TRIGGER trg_dues_no_delete_after_publish
BEFORE DELETE ON unit_dues
WHEN (SELECT is_published FROM fee_periods WHERE id = OLD.fee_period_id) = 1
BEGIN
  SELECT RAISE(ABORT, 'مش ممكن تمسح مستحق منشور. الإعفاء بيتسجّل، مش بيتشال.');
END;

-- -----------------------------------------------------------------------------
-- A waiver must name its reason and its author. The CHECK on the table already
-- says so; this adds the part a CHECK cannot express — that the reason is a
-- sentence somebody wrote, not a keystroke. Ten characters is a low bar, and it
-- is a bar: whatever is written here appears on the resident's statement.
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_waiver_needs_a_real_reason
BEFORE UPDATE OF waived_piastres ON unit_dues
WHEN NEW.waived_piastres > 0 AND length(trim(COALESCE(NEW.waiver_reason_ar, ''))) < 10
BEGIN
  SELECT RAISE(ABORT, 'اكتب سبب الإعفاء بالتفصيل — ده بيظهر في كشف حساب الساكن وباسم اللي وافق عليه.');
END;

-- -----------------------------------------------------------------------------
-- What the board looks at before publishing: how many flats, how much, and
-- whether any flat is missing an area on a per-sqm basis (which would have been
-- silently skipped).
-- -----------------------------------------------------------------------------
CREATE VIEW v_fee_period_summary AS
SELECT fp.id,
       fp.name_ar,
       fp.basis,
       fp.amount_piastres,
       fp.starts_on,
       fp.ends_on,
       fp.due_on,
       fp.is_published,
       fp.created_at,
       c.name_ar                                    AS category_ar,
       (SELECT COUNT(*)  FROM unit_dues d WHERE d.fee_period_id = fp.id) AS unit_count,
       (SELECT COALESCE(SUM(d.amount_piastres), 0)
          FROM unit_dues d WHERE d.fee_period_id = fp.id)                AS total_piastres,
       (SELECT COALESCE(SUM(d.waived_piastres), 0)
          FROM unit_dues d WHERE d.fee_period_id = fp.id)                AS waived_piastres,
       (SELECT COUNT(*) FROM units u
         WHERE u.is_active = 1
           AND NOT EXISTS (SELECT 1 FROM unit_dues d
                            WHERE d.fee_period_id = fp.id AND d.unit_id = u.id))
                                                                        AS missing_units
  FROM fee_periods fp
  JOIN categories c ON c.id = fp.category_id;
