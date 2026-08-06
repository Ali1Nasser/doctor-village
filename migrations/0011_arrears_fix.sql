-- =============================================================================
-- 0011_arrears_fix.sql
--
-- 🔴 A CORRECTNESS FIX, not a feature. Read this before changing v_unit_balance.
--
-- ## The bug
-- `v_unit_balance.paid_piastres` summed **every approved payment** for a unit:
--
--     SUM(p.approved_amount_piastres) WHERE p.unit_id = u.id AND p.status='approved'
--
-- while `due_piastres` summed only dues from **published fee periods**. The two
-- sides of the subtraction were therefore measuring different things, and the
-- difference is الوديعة.
--
-- A new owner pays the 5,000 ج.م deposit on handover and has not yet paid the
-- 6,000 ج.م subscription. The deposit is approved, so it landed in
-- `paid_piastres`, and the flat reported 1,000 ج.م outstanding instead of
-- 6,000. The board looks at the arrears list, sees a flat that has nearly paid,
-- and does not chase it. Worse, `v_community_totals.receivables_piastres` reads
-- from this view, so the headline متأخرات figure on `/finance` was understated
-- by the entire deposit pool — 204 units × 5,000 ج.م is over a million pounds
-- of arrears that simply did not appear.
--
-- ## Why the existing controls did not catch it
-- This is R-020 wearing a different hat, and every defence built for R-020
-- missed it:
--   · the category→account trigger was satisfied — the deposit WAS booked to a
--     liability, correctly, in the deposit fund;
--   · `v_deposit_leakage` was clean — no deposit reached an income account;
--   · the accounting equation balanced, as ADR-018 says it always will;
--   · `verify_ledger.py`'s twelve invariants all passed.
-- Nothing was wrong in the **ledger**. The error was in a *reporting view* that
-- compared dues against payments-of-any-kind. The lesson is in INSIGHTS: a
-- correct ledger does not imply a correct report, and the report is what the
-- board actually reads.
--
-- Found by `tests/access/transparency.test.ts` — the first test to compare a
-- rendered figure against a number computed by hand rather than against another
-- query.
--
-- ## The fix
-- `paid_piastres` counts only payments **allocated to a published fee period**,
-- which is exactly what `due_piastres` counts. Both sides now measure dues.
-- Money received that is not dues — deposits, contributions, penalties — is
-- real money and is still in the ledger, in the totals, and on the unit's
-- statement. It is simply not an answer to "did this flat pay its subscription?"
-- =============================================================================

DROP VIEW IF EXISTS v_unit_balance;

CREATE VIEW v_unit_balance AS
SELECT
  u.id AS unit_id,
  b.code AS building_code,
  u.unit_number,
  COALESCE((SELECT SUM(d.amount_piastres - d.waived_piastres)
              FROM unit_dues d
              JOIN fee_periods fp ON fp.id = d.fee_period_id AND fp.is_published = 1
             WHERE d.unit_id = u.id), 0) AS due_piastres,
  -- ⭐ THE FIX: only money allocated to a published fee period counts against
  -- dues. A deposit (fee_period_id IS NULL) is money the village OWES BACK; it
  -- can never reduce what a flat owes.
  COALESCE((SELECT SUM(p.approved_amount_piastres)
              FROM payments p
              JOIN fee_periods fp2 ON fp2.id = p.fee_period_id AND fp2.is_published = 1
             WHERE p.unit_id = u.id AND p.status = 'approved'), 0) AS paid_piastres,
  -- Kept separate and visible rather than hidden, so a resident who paid a
  -- deposit can see it acknowledged instead of wondering where it went.
  COALESCE((SELECT SUM(p.approved_amount_piastres)
              FROM payments p
              JOIN categories c ON c.id = p.category_id AND c.kind = 'deposit'
             WHERE p.unit_id = u.id AND p.status = 'approved'), 0) AS deposit_paid_piastres,
  -- EVERY piastre approved for this unit, whatever it was for. This is the
  -- quantity that must reconcile against the unit's journal lines (invariant 8):
  -- "did every approved payment reach the ledger?" is a different question from
  -- "did this flat pay its subscription?", and conflating the two is what
  -- produced the bug this migration fixes.
  COALESCE((SELECT SUM(p.approved_amount_piastres)
              FROM payments p
             WHERE p.unit_id = u.id AND p.status = 'approved'), 0) AS received_piastres,
  COALESCE((SELECT SUM(d.amount_piastres - d.waived_piastres)
              FROM unit_dues d
              JOIN fee_periods fp ON fp.id = d.fee_period_id AND fp.is_published = 1
             WHERE d.unit_id = u.id), 0)
  - COALESCE((SELECT SUM(p.approved_amount_piastres)
                FROM payments p
                JOIN fee_periods fp2 ON fp2.id = p.fee_period_id AND fp2.is_published = 1
               WHERE p.unit_id = u.id AND p.status = 'approved'), 0) AS outstanding_piastres
FROM units u
JOIN buildings b ON b.id = u.building_id
WHERE u.is_active = 1;

-- -----------------------------------------------------------------------------
-- Make the class of bug unrepresentable, not just fixed.
--
-- The view now depends on "a deposit never carries a fee_period_id." That is
-- currently true by convention. A convention that a correctness fix rests on is
-- a constraint that has not been written down yet.
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_deposit_has_no_fee_period_ins
BEFORE INSERT ON payments
WHEN NEW.fee_period_id IS NOT NULL
 AND (SELECT kind FROM categories WHERE id = NEW.category_id) = 'deposit'
BEGIN
  SELECT RAISE(ABORT, 'الوديعة مش اشتراك — ما ينفعش تترّبط بفترة اشتراك، وإلا هتقلّل المتأخرات غلط');
END;

CREATE TRIGGER trg_deposit_has_no_fee_period_upd
BEFORE UPDATE OF fee_period_id, category_id ON payments
WHEN NEW.fee_period_id IS NOT NULL
 AND (SELECT kind FROM categories WHERE id = NEW.category_id) = 'deposit'
BEGIN
  SELECT RAISE(ABORT, 'الوديعة مش اشتراك — ما ينفعش تترّبط بفترة اشتراك، وإلا هتقلّل المتأخرات غلط');
END;

-- -----------------------------------------------------------------------------
-- v_unallocated_payments — the OTHER half of the same mistake.
--
-- Now that only fee-period-allocated money counts against dues, a subscription
-- payment that was approved WITHOUT a fee period silently stops counting. That
-- would be the same bug in the opposite direction: a resident who paid, marked
-- as owing. This view surfaces exactly those rows so the board can see them.
-- `/admin/health` and the arrears screen should both read it.
-- -----------------------------------------------------------------------------
CREATE VIEW v_unallocated_payments AS
SELECT p.id, p.receipt_no, p.unit_id, p.approved_amount_piastres, p.transfer_date,
       c.name_ar AS category_ar, c.kind AS category_kind
FROM payments p
JOIN categories c ON c.id = p.category_id
WHERE p.status = 'approved'
  AND p.fee_period_id IS NULL
  AND c.kind <> 'deposit';
