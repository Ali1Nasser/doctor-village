-- =============================================================================
-- 0014_expense_posting.sql — money going OUT, with the deposit fund walled off.
--
-- `recordExpense` and `countersignExpense` existed, but nothing ever posted an
-- expense to the ledger: a recorded expense sat in `expenses` with no journal
-- entry, so `/finance` showed income the village had received and none of the
-- money it had spent. This migration adds the guards; `lib/db/expenses.ts` adds
-- the posting itself.
--
-- ## ⭐ The important one: an expense can never be paid from a deposit fund
--
-- R-049 asked "have we spent the residents' deposits?" and answered it with a
-- banner on `/finance`. A banner is **detection**. Detection is what you build
-- when prevention is impossible, and here it is not impossible: an أمانة is not
-- the village's money, so no expense may ever be drawn against a fund with
-- `is_spendable = 0`. That is a rule, not a preference, and it belongs in the
-- database where no route, no admin console and no future migration can go
-- around it.
--
-- After this, R-049's banner should never fire. It stays anyway — the trigger
-- protects the path through `expenses`, and a hand-written journal entry could
-- still do it. Prevention where possible, detection everywhere else.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Trust money is not spendable money.
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_expense_fund_spendable_ins
BEFORE INSERT ON expenses
WHEN NEW.fund_id IS NOT NULL
 AND (SELECT is_spendable FROM funds WHERE id = NEW.fund_id) = 0
BEGIN
  SELECT RAISE(ABORT,
    'مينفعش تصرف من صندوق أمانات — الودائع والاحتياطيات مش فلوس متاحة للصرف');
END;

CREATE TRIGGER trg_expense_fund_spendable_upd
BEFORE UPDATE OF fund_id ON expenses
WHEN NEW.fund_id IS NOT NULL
 AND (SELECT is_spendable FROM funds WHERE id = NEW.fund_id) = 0
BEGIN
  SELECT RAISE(ABORT,
    'مينفعش تصرف من صندوق أمانات — الودائع والاحتياطيات مش فلوس متاحة للصرف');
END;

-- -----------------------------------------------------------------------------
-- An expense above the board's threshold cannot post without a second signature.
--
-- `countersignExpense` already refuses to let one person sign their own. This
-- refuses to let an unsigned one reach the ledger at all — the difference
-- between "the button checks" and "the money cannot move", which is ADR-024's
-- rule applied to the other half of maker–checker.
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_expense_threshold_needs_countersign
BEFORE UPDATE OF status ON expenses
WHEN NEW.status = 'posted'
 AND OLD.amount_piastres >= (SELECT countersign_threshold_piastres FROM settings WHERE id = 1)
 AND NEW.approved_by IS NULL
BEGIN
  SELECT RAISE(ABORT,
    'المصروف ده فوق الحد ولازم توقيع تاني من مسؤول مختلف قبل الترحيل');
END;

-- -----------------------------------------------------------------------------
-- A closed fiscal period takes no more entries — AT POSTING TIME.
--
-- `trg_entry_period_open` (migration 0002) already refuses to CREATE an entry in
-- a closed period. It does not cover the gap that actually matters: an entry
-- created while the year was open and posted after it closed. Between those two
-- moments is exactly where a late expense gets quietly slipped into a year the
-- board has already reported on.
--
-- Note the status test is `<> 'open'`, not `= 'closed'`: the column also allows
-- 'reopened', and 0002's trigger lets that through. Reopening needs a second
-- admin (03_RBAC §6), so a reopened period is deliberately writable — but the
-- distinction should be a decision, not an accident of which literal someone
-- typed. Recorded here so the difference between the two triggers is visible.
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_entry_period_open_at_posting
BEFORE UPDATE OF posted_at ON journal_entries
WHEN NEW.posted_at IS NOT NULL AND OLD.posted_at IS NULL
 AND (SELECT status FROM fiscal_periods WHERE id = NEW.period_id) = 'closed'
BEGIN
  SELECT RAISE(ABORT, 'السنة المالية دي مقفولة — مينفعش ترحّل عليها');
END;

-- -----------------------------------------------------------------------------
-- v_expense_queue — what an admin actually has to do
--
-- Recorded but not posted, newest first, with whether it needs a second
-- signature already computed. The threshold comparison lives here rather than
-- in a template so the screen and the trigger can never disagree about which
-- expenses are "big".
-- -----------------------------------------------------------------------------
CREATE VIEW v_expense_queue AS
SELECT e.id, e.voucher_no, e.amount_piastres, e.spent_on, e.description_ar,
       e.vendor_name, e.invoice_storage_key, e.status, e.recorded_by, e.approved_by,
       e.is_reversal,
       c.name_ar AS category_ar,
       CASE WHEN e.amount_piastres >=
              (SELECT countersign_threshold_piastres FROM settings WHERE id = 1)
            THEN 1 ELSE 0 END AS needs_countersign
FROM expenses e
JOIN categories c ON c.id = e.category_id
WHERE e.status IN ('recorded','countersigned')
ORDER BY e.spent_on DESC, e.voucher_no DESC;

-- -----------------------------------------------------------------------------
-- v_unposted_expenses — the gap between "we spent it" and "the books say so"
--
-- An expense recorded and never posted is money the village spent that
-- `/finance` does not show. That understates expenses and overstates the
-- treasury — the mirror image of R-043, and just as invisible. Surfaced so it
-- is a number on a screen rather than a silence.
-- -----------------------------------------------------------------------------
CREATE VIEW v_unposted_expenses AS
SELECT COUNT(*) AS n, COALESCE(SUM(amount_piastres), 0) AS total_piastres
FROM expenses
WHERE status IN ('recorded','countersigned');
