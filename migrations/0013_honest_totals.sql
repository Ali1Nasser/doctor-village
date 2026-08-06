-- =============================================================================
-- 0013_honest_totals.sql
--
-- The label audit. Every Arabic caption that names a figure is a **claim about
-- what that figure contains**, and a claim nothing had ever verified. Two were
-- false, both in the four-tile summary that `04_UX_SPEC §3` calls the most
-- important thing on the screen.
--
-- Neither is a ledger error. As with R-043 and R-045…R-048, the arithmetic was
-- right and the sentence next to it was wrong — which for a resident is the
-- same thing as the arithmetic being wrong, because the sentence is all they
-- have to interpret it by.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- R-053 — «ودائع وأرصدة للملاك» included money owed to CONTRACTORS
--
-- `held_in_trust_piastres` summed **every** liability. The chart of accounts has
-- three:
--     2101 ودائع مستردة        — a resident's deposit          (owner money)
--     2102 أرصدة دائنة للملاك  — an overpayment                (owner money)
--     2103 مستحقات موردين      — an unpaid contractor invoice  (NOT owner money)
--
-- So an unpaid 50,000 ج.م invoice to the lift company rendered on `/finance`
-- under the caption "ودائع وأرصدة للملاك — أمانات، مش ملك القرية، بتترد
-- لأصحابها". A resident reading that tile would conclude the village is holding
-- 50,000 ج.م of residents' money that it is not.
--
-- The two are separated here. `spendable` still subtracts BOTH — money promised
-- to a contractor is not available to spend either — so the treasury figure is
-- unchanged and remains conservative. Only the attribution is fixed.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- R-054 — «رصيد أول المدة» was actually every fund, reserves included
--
-- The route bound `total_reserves_piastres` (the balance of ALL fund accounts:
-- 3101 رصيد أول المدة + 3102 احتياطي الصيانة + 3103 احتياطي الطوارئ) to a field
-- named `openingPiastres` and printed it under "رصيد أول المدة".
--
-- They are equal today only because both reserves are zero. The first time the
-- board moves money into احتياطي الطوارئ — which `06 §5` expects them to do —
-- the opening balance on screen silently grows by the amount reserved, and the
-- figure becomes wrong with no code change and no deploy.
-- -----------------------------------------------------------------------------

DROP VIEW IF EXISTS v_community_totals;

CREATE VIEW v_community_totals AS
SELECT
  (SELECT income_piastres      FROM v_accounting_equation) AS total_income_piastres,
  (SELECT expenses_piastres    FROM v_accounting_equation) AS total_expense_piastres,
  (SELECT liabilities_piastres FROM v_accounting_equation) AS total_liabilities_piastres,
  (SELECT funds_piastres       FROM v_accounting_equation) AS total_reserves_piastres,

  -- (1) الفلوس المتاحة للصرف — unchanged. Cash held, minus EVERYTHING owed,
  --     whether owed to a resident or to a contractor. Conservative by design.
  (SELECT COALESCE(SUM(balance_piastres),0) FROM v_account_balances WHERE type = 'asset'
     AND code NOT LIKE '13%')
  - (SELECT COALESCE(SUM(balance_piastres),0) FROM v_account_balances WHERE type = 'liability')
    AS spendable_piastres,

  -- (2) ⭐ R-053: OWNER money only — deposits and owner credits. This is what
  --     the caption "ودائع وأرصدة للملاك" has always claimed to be.
  (SELECT COALESCE(SUM(balance_piastres),0) FROM v_account_balances
    WHERE type = 'liability' AND code IN ('2101','2102')) AS held_in_trust_piastres,

  -- (2b) ⭐ R-053: money owed to suppliers, named as such and shown separately.
  (SELECT COALESCE(SUM(balance_piastres),0) FROM v_account_balances
    WHERE type = 'liability' AND code NOT IN ('2101','2102')) AS owed_to_suppliers_piastres,

  -- (3) إيصالات تحت المراجعة — مش محسوبة في الإيرادات
  (SELECT COALESCE(SUM(claimed_amount_piastres),0) FROM payments
     WHERE status IN ('submitted','under_review','needs_info'))
    AS pending_not_counted_piastres,

  -- (4) المتأخرات المطلوبة — same source as v_unit_balance, so the headline
  --     figure and the per-unit table can never disagree. (See R-043.)
  (SELECT COALESCE(SUM(MAX(0, ub.outstanding_piastres)),0) FROM v_unit_balance ub)
    AS receivables_piastres,

  -- ⭐ R-054: the opening balance is account 3101 and nothing else...
  (SELECT COALESCE(SUM(balance_piastres),0) FROM v_account_balances WHERE code = '3101')
    AS opening_balance_piastres,
  -- ...and the reserves are their own figure, so moving money into a reserve
  -- shows up as a reserve instead of quietly inflating the opening balance.
  (SELECT COALESCE(SUM(balance_piastres),0) FROM v_account_balances
    WHERE type = 'fund' AND code <> '3101') AS reserves_piastres,

  (SELECT MAX(as_of) FROM reconciliations) AS last_reconciled_on;

-- -----------------------------------------------------------------------------
-- The label claims, as a checkable rule.
--
-- Both defects above were possible because "which accounts does this caption
-- cover?" lived only in a caption. `2101` and `2102` are now load-bearing
-- string literals in a view, so a future account added to the chart must be
-- deliberately classified rather than silently swept into whichever tile it
-- happens to land in.
--
-- This view lists any liability or fund account NOT covered by a caption above.
-- It must always be empty. `tests/access/views.test.ts` asserts that, so adding
-- account 2104 without deciding where it belongs fails a test instead of
-- appearing under the wrong Arabic sentence.
-- -----------------------------------------------------------------------------
CREATE VIEW v_unclassified_accounts AS
SELECT id, code, name_ar, type
FROM accounts
WHERE type = 'liability' AND code NOT IN ('2101','2102','2103')
UNION ALL
SELECT id, code, name_ar, type
FROM accounts
WHERE type = 'fund' AND code NOT IN ('3101','3102','3103');
