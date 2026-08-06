-- =============================================================================
-- 0005_views.sql — the transparency layer
--
-- Every figure below is derived from POSTED JOURNAL LINES, never from a tally
-- of payments minus expenses (ADR-013). A pending / rejected / duplicate /
-- cancelled receipt has no journal line, so it contributes zero to every total
-- here BY CONSTRUCTION rather than by a WHERE clause someone might forget.
--
-- COALESCE(SUM(x),0) everywhere: SUM() over an empty set is NULL, and a brand
-- new community with no payments must show 0.00 ج.م on launch day, not a blank.
-- (INSIGHTS.md [money] 2026-08-03)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Posted lines only. One place decides what "posted" means.
-- -----------------------------------------------------------------------------
CREATE VIEW v_posted_lines AS
SELECT jl.*, je.entry_date, je.period_id, je.source_type, je.source_id, je.is_reversal
FROM journal_lines jl
JOIN journal_entries je ON je.id = jl.entry_id
WHERE je.posted_at IS NOT NULL;

-- -----------------------------------------------------------------------------
-- v_account_balances — رصيد كل حساب
-- Signed in the account's OWN normal direction, so every figure reads positive.
-- -----------------------------------------------------------------------------
CREATE VIEW v_account_balances AS
SELECT
  a.id            AS account_id,
  a.code,
  a.name_ar,
  a.type,
  CASE a.normal_balance
    WHEN 'debit'  THEN COALESCE(SUM(pl.debit_piastres),0) - COALESCE(SUM(pl.credit_piastres),0)
    ELSE               COALESCE(SUM(pl.credit_piastres),0) - COALESCE(SUM(pl.debit_piastres),0)
  END             AS balance_piastres
FROM accounts a
LEFT JOIN v_posted_lines pl ON pl.account_id = a.id
GROUP BY a.id, a.code, a.name_ar, a.type, a.normal_balance;

-- -----------------------------------------------------------------------------
-- v_accounting_equation — invariant 12 (06 §9)
--   assets = liabilities + funds + (income − expenses)
--
-- ⚠️ HONEST NOTE ON WHAT THIS TEST DOES AND DOES NOT CATCH.
-- 06_ACCOUNTING_AND_LEDGER.md §9 calls this "one test that catches more bugs
-- than the other eleven combined". That overstates it, and believing it would
-- be dangerous. Under balanced double-entry this identity is a TAUTOLOGY: since
-- every posted entry satisfies SUM(debit)=SUM(credit), the residual below is
-- necessarily zero regardless of whether الوديعة was booked to a liability or
-- to income. It catches half-posted entries, lines written outside the posting
-- path, and a corrupted restore — real things, but NOT the misclassification
-- that R-020 is about.
--
-- The test that actually catches R-020 is v_deposit_leakage below, plus the
-- fund split in v_community_totals. Do not let this view stand in for it.
-- Demonstrated in tests/fixtures/verify_ledger.py, which shows a deliberately
-- wrong ledger passing this check while v_deposit_leakage fails.
-- -----------------------------------------------------------------------------
CREATE VIEW v_accounting_equation AS
SELECT
  COALESCE(SUM(CASE WHEN type = 'asset'     THEN balance_piastres END),0) AS assets_piastres,
  COALESCE(SUM(CASE WHEN type = 'liability' THEN balance_piastres END),0) AS liabilities_piastres,
  COALESCE(SUM(CASE WHEN type = 'fund'      THEN balance_piastres END),0) AS funds_piastres,
  COALESCE(SUM(CASE WHEN type = 'income'    THEN balance_piastres END),0) AS income_piastres,
  COALESCE(SUM(CASE WHEN type = 'expense'   THEN balance_piastres END),0) AS expenses_piastres,
  COALESCE(SUM(CASE WHEN type = 'asset'     THEN balance_piastres END),0)
  - ( COALESCE(SUM(CASE WHEN type = 'liability' THEN balance_piastres END),0)
    + COALESCE(SUM(CASE WHEN type = 'fund'      THEN balance_piastres END),0)
    + COALESCE(SUM(CASE WHEN type = 'income'    THEN balance_piastres END),0)
    - COALESCE(SUM(CASE WHEN type = 'expense'   THEN balance_piastres END),0)
    ) AS residual_piastres          -- must be 0
FROM v_account_balances;

-- -----------------------------------------------------------------------------
-- ⭐ v_deposit_leakage — the test that actually protects against R-020.
-- Any posted line that (a) came from a payment in a category of kind 'deposit'
-- and (b) credits an account of type 'income' is a leak. Must always be empty.
-- -----------------------------------------------------------------------------
-- ⚠️ SUPERSEDED BY migrations/0012_view_audit.sql — catches a deposit credited
-- to income only, and contains a join clause that can never match (R-048).
CREATE VIEW v_deposit_leakage AS
SELECT pl.entry_id, pl.id AS line_id, p.receipt_no, c.name_ar AS category_ar,
       a.code AS account_code, a.name_ar AS account_ar, pl.credit_piastres
FROM v_posted_lines pl
JOIN accounts   a ON a.id = pl.account_id
JOIN payments   p ON p.id = pl.entry_id OR p.journal_entry_id = pl.entry_id
JOIN categories c ON c.id = p.category_id
WHERE c.kind = 'deposit'
  AND a.type = 'income'
  AND pl.credit_piastres > 0;

-- -----------------------------------------------------------------------------
-- v_fund_balances — الصناديق
-- This is what makes "الفلوس المتاحة للصرف" honest.
-- -----------------------------------------------------------------------------
-- ⚠️⚠️ SUPERSEDED BY migrations/0012_view_audit.sql — DO NOT COPY THIS PATTERN.
-- The `LEFT JOIN accounts … AND a.type = …` below LOOKS like a filter and is
-- not one: a LEFT JOIN's ON clause decides whether the right-hand row attaches,
-- never whether the left-hand row survives. Non-matching lines stayed in the
-- result and kept being summed. Left here unedited because migrations are
-- history — 0012 drops and recreates both views. See R-045 / R-046.
CREATE VIEW v_fund_balances AS
SELECT
  f.id AS fund_id, f.name_ar, f.kind, f.is_spendable,
  COALESCE(SUM(pl.debit_piastres),0) - COALESCE(SUM(pl.credit_piastres),0) AS net_debit_piastres
FROM funds f
LEFT JOIN v_posted_lines pl ON pl.fund_id = f.id
LEFT JOIN accounts a ON a.id = pl.account_id AND a.type = 'asset'
GROUP BY f.id, f.name_ar, f.kind, f.is_spendable;

-- -----------------------------------------------------------------------------
-- v_community_totals — the /finance headline figures
-- 04_UX_SPEC §3 requires FOUR visually distinct figures, never one merged
-- "balance". They are produced separately here so a UI bug cannot merge them.
-- -----------------------------------------------------------------------------
CREATE VIEW v_community_totals AS
SELECT
  (SELECT income_piastres      FROM v_accounting_equation) AS total_income_piastres,
  (SELECT expenses_piastres    FROM v_accounting_equation) AS total_expense_piastres,
  (SELECT liabilities_piastres FROM v_accounting_equation) AS total_liabilities_piastres,
  (SELECT funds_piastres       FROM v_accounting_equation) AS total_reserves_piastres,
  -- (1) الفلوس المتاحة للصرف — cash held, MINUS what is owed back to owners
  --     (deposits + resident credits). This is the number a board member may
  --     honestly call "our money".
  (SELECT COALESCE(SUM(balance_piastres),0) FROM v_account_balances WHERE type = 'asset'
     AND code NOT LIKE '13%')                                                        -- exclude receivables
  - (SELECT COALESCE(SUM(balance_piastres),0) FROM v_account_balances WHERE type = 'liability')
    AS spendable_piastres,
  -- (2) الودائع والاحتياطي — أمانات مش ملك القرية
  (SELECT COALESCE(SUM(balance_piastres),0) FROM v_account_balances WHERE type = 'liability')
    AS held_in_trust_piastres,
  -- (3) إيصالات تحت المراجعة — مش محسوبة في الإيرادات
  (SELECT COALESCE(SUM(claimed_amount_piastres),0) FROM payments
     WHERE status IN ('submitted','under_review','needs_info'))
    AS pending_not_counted_piastres,
  -- (4) المتأخرات المطلوبة
  -- ⚠️ Computed from unit_dues − approved payments, NOT from the receivables
  -- account. The posting model in 06 §2 is MODIFIED CASH: a payment posts
  -- Dr cash / Cr income directly, and no receivable is raised when dues are
  -- generated. So account 13xx stays at zero and reading it would report "no
  -- arrears" to a village that has plenty. Same source as v_unit_balance, so
  -- the headline figure and the per-unit table can never disagree.
  -- If the accountant (Q15) moves us to full accrual, this switches back to
  -- the 13xx balance and unit_dues stops being the source of truth.
  (SELECT COALESCE(SUM(MAX(0, ub.outstanding_piastres)),0) FROM v_unit_balance ub)
    AS receivables_piastres,
  (SELECT MAX(as_of) FROM reconciliations) AS last_reconciled_on;

-- -----------------------------------------------------------------------------
-- v_expense_by_category — invariant 4: Σ per-category == total expenses
-- -----------------------------------------------------------------------------
-- ⚠️ SUPERSEDED BY migrations/0012_view_audit.sql — this definition gives every
-- category the FULL total of its ledger account, so categories sharing an
-- account multiply the figure (R-047). History only.
CREATE VIEW v_expense_by_category AS
SELECT
  c.id AS category_id,
  c.name_ar,
  c.parent_id,
  COALESCE(SUM(pl.debit_piastres),0) - COALESCE(SUM(pl.credit_piastres),0) AS total_piastres
FROM categories c
JOIN accounts a ON a.id = c.ledger_account_id AND a.type = 'expense'
LEFT JOIN v_posted_lines pl ON pl.account_id = a.id
WHERE c.direction = 'expense'
GROUP BY c.id, c.name_ar, c.parent_id;

-- -----------------------------------------------------------------------------
-- v_unit_balance — حالة السداد لكل وحدة
-- ⚠️ Readable by every authenticated member ONLY IF settings.unit_status_public
--    = 1 (owner question Q11 — needs a written general-assembly decision, R-002).
--    The view exposes unit code, due, paid, outstanding. NO names, NO phone
--    numbers, NO receipt images — enforced by what is selected here.
-- -----------------------------------------------------------------------------
-- ⚠️ SUPERSEDED BY migrations/0011_arrears_fix.sql — this definition lets a
-- deposit cancel a flat's subscription arrears (R-043). History only.
CREATE VIEW v_unit_balance AS
SELECT
  u.id AS unit_id,
  b.code AS building_code,
  u.unit_number,
  COALESCE((SELECT SUM(d.amount_piastres - d.waived_piastres)
              FROM unit_dues d
              JOIN fee_periods fp ON fp.id = d.fee_period_id AND fp.is_published = 1
             WHERE d.unit_id = u.id), 0) AS due_piastres,
  COALESCE((SELECT SUM(p.approved_amount_piastres)
              FROM payments p
             WHERE p.unit_id = u.id AND p.status = 'approved'), 0) AS paid_piastres,
  COALESCE((SELECT SUM(d.amount_piastres - d.waived_piastres)
              FROM unit_dues d
              JOIN fee_periods fp ON fp.id = d.fee_period_id AND fp.is_published = 1
             WHERE d.unit_id = u.id), 0)
  - COALESCE((SELECT SUM(p.approved_amount_piastres)
                FROM payments p
               WHERE p.unit_id = u.id AND p.status = 'approved'), 0) AS outstanding_piastres
FROM units u
JOIN buildings b ON b.id = u.building_id
WHERE u.is_active = 1;

-- -----------------------------------------------------------------------------
-- v_unit_ledger_balance — the SECOND, INDEPENDENT computation of the same
-- number, straight from the journal. Invariant 8 (06 §9) requires that these
-- two agree. Two paths to one number is the oldest accounting control there is.
-- -----------------------------------------------------------------------------
-- ⚠️⚠️ SUPERSEDED BY migrations/0012_view_audit.sql — DO NOT COPY THIS PATTERN.
-- The `LEFT JOIN accounts … AND a.type = …` below LOOKS like a filter and is
-- not one: a LEFT JOIN's ON clause decides whether the right-hand row attaches,
-- never whether the left-hand row survives. Non-matching lines stayed in the
-- result and kept being summed. Left here unedited because migrations are
-- history — 0012 drops and recreates both views. See R-045 / R-046.
CREATE VIEW v_unit_ledger_balance AS
SELECT
  u.id AS unit_id,
  COALESCE(SUM(pl.credit_piastres),0) - COALESCE(SUM(pl.debit_piastres),0) AS paid_piastres_from_ledger
FROM units u
LEFT JOIN v_posted_lines pl ON pl.unit_id = u.id
LEFT JOIN accounts a ON a.id = pl.account_id AND a.type IN ('income','liability')
GROUP BY u.id;

-- -----------------------------------------------------------------------------
-- v_staff_public — العمالة كما يراها الساكن
-- full_name is NOT selected. The column split lives here, not in a UI check,
-- so a template cannot leak it. Q4 default: names hidden from residents.
-- -----------------------------------------------------------------------------
CREATE VIEW v_staff_public AS
SELECT id, job_title_ar, monthly_salary_piastres, started_on, ended_on, is_active
FROM staff;

-- -----------------------------------------------------------------------------
-- v_single_admin_warning — R-024 / 06 §6
-- If the board is genuinely one active person, /admin must SAY SO rather than
-- pretend maker–checker exists.
-- -----------------------------------------------------------------------------
CREATE VIEW v_single_admin_warning AS
SELECT
  COUNT(*) AS active_admin_count,
  CASE WHEN COUNT(*) < 2 THEN 1 ELSE 0 END AS show_warning
FROM profiles
WHERE role IN ('admin','developer') AND is_active = 1;

-- -----------------------------------------------------------------------------
-- v_storage_usage — the hard cap check, read before every upload
-- -----------------------------------------------------------------------------
CREATE VIEW v_storage_usage AS
SELECT
  COALESCE(SUM(size_bytes),0) AS used_bytes,
  (SELECT storage_hard_cap_bytes FROM settings WHERE id = 1) AS cap_bytes,
  CASE WHEN (SELECT storage_hard_cap_bytes FROM settings WHERE id = 1) > 0
       THEN (COALESCE(SUM(size_bytes),0) * 100)
            / (SELECT storage_hard_cap_bytes FROM settings WHERE id = 1)
       ELSE 0 END AS pct_used
FROM storage_objects
WHERE deleted_at IS NULL;
