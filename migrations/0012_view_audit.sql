-- =============================================================================
-- 0012_view_audit.sql
--
-- The R-043 audit: every view re-read asking one question —
--   **do both sides of this comparison measure the same thing?**
--
-- Three more defects, all the same shape as R-043, all in reporting views while
-- the ledger underneath stayed correct. Two of them share an identical SQL
-- mistake that is worth naming, because it is invisible on inspection and
-- silent at runtime:
--
--     LEFT JOIN accounts a ON a.id = pl.account_id AND a.type = 'asset'
--
-- reads like a filter and is not one. A LEFT JOIN's ON clause decides whether
-- the right-hand row is attached, never whether the left-hand row survives.
-- Non-asset lines stay in the result with `a` as NULLs, and their debits and
-- credits go on being summed. The intended filter belongs in WHERE, or the join
-- must be INNER. Both views below netted income against cash and reported a
-- fund holding 600,000 ج.م as holding **zero**.
--
-- Found by `tests/access/views.test.ts`, which asserts each view against an
-- independent correlated subquery over the same posted lines.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- R-045 — v_fund_balances reported every fund as empty
--
-- The view is described in 0005 as *"what makes الفلوس المتاحة للصرف honest"*.
-- It was not honest: for the operating fund, the income credit cancelled the
-- cash debit and the fund read 0. `/finance` was spared only because
-- `v_community_totals` computes spendable from `v_account_balances` instead —
-- so the view existed, was wrong, and was believed. A view nothing reads is not
-- harmless; it is a wrong answer waiting for its first caller.
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_fund_balances;

CREATE VIEW v_fund_balances AS
SELECT
  f.id AS fund_id, f.name_ar, f.kind, f.is_spendable,
  -- Cash and bank held BY this fund. The account-type restriction is a WHERE
  -- inside a correlated subquery, so it cannot silently stop filtering.
  COALESCE((SELECT SUM(pl.debit_piastres) - SUM(pl.credit_piastres)
              FROM v_posted_lines pl
              JOIN accounts a ON a.id = pl.account_id
             WHERE pl.fund_id = f.id AND a.type = 'asset'), 0) AS net_debit_piastres,
  -- What this fund owes back. For the deposit fund these two should track each
  -- other closely; a large gap means deposit money has been spent.
  COALESCE((SELECT SUM(pl.credit_piastres) - SUM(pl.debit_piastres)
              FROM v_posted_lines pl
              JOIN accounts a ON a.id = pl.account_id
             WHERE pl.fund_id = f.id AND a.type = 'liability'), 0) AS owed_piastres
FROM funds f;

-- -----------------------------------------------------------------------------
-- R-046 — v_unit_ledger_balance: the second opinion was broken
--
-- Same LEFT JOIN mistake. This view exists to be the INDEPENDENT computation
-- that invariant 8 (`06 §9`) compares against — "two paths to one number is the
-- oldest accounting control there is", per its own comment in 0005. The control
-- itself was wrong.
--
-- It escaped notice because `seed/demo/generate.py` happens to tag only the
-- income and liability lines of a payment with `unit_id`, never the cash line.
-- Nothing enforces that convention. `tests/access/transparency.test.ts` tagged
-- every line of an entry — the obvious reading of the column — and this view
-- would have returned 0 for every unit. A control whose correctness depends on
-- an unwritten data-entry habit is not a control.
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_unit_ledger_balance;

CREATE VIEW v_unit_ledger_balance AS
SELECT
  u.id AS unit_id,
  COALESCE((SELECT SUM(pl.credit_piastres) - SUM(pl.debit_piastres)
              FROM v_posted_lines pl
              JOIN accounts a ON a.id = pl.account_id
             WHERE pl.unit_id = u.id AND a.type IN ('income','liability')), 0)
    AS paid_piastres_from_ledger
FROM units u;

-- -----------------------------------------------------------------------------
-- R-047 — v_expense_by_category could double-count, and was saved only by a
--         coincidence in the seed file
--
-- The view joins categories to their ledger account and sums the account's
-- posted lines. **Six** categories map to account 5101 (الصيانة, لمبات وإضاءة,
-- أعمال كهربائية, سباكة, دهانات وترميم, مصاعد) and three to 5201. Each of them
-- receives the FULL account total, so Σ per-category is six times the truth.
--
-- Invariant 4 ("Σ per-category == total expenses") passes today only because
-- `lib/db/getExpenseByCategory` adds `WHERE parent_id IS NULL`, and because the
-- seed happens to give each account exactly one parent-level category. Both are
-- accidents. The day the board adds a second roll-up category on an existing
-- account — "الصيانة" and "الطوارئ" both on 5101 is entirely plausible — the
-- expense chart silently doubles and invariant 4 starts failing with no clue
-- why.
--
-- Two fixes, because either alone leaves a hole:
--   1. the roll-up filter moves INTO the view, so a caller cannot forget it;
--   2. a unique index makes a second roll-up category on one account impossible.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX ux_expense_rollup_per_account
  ON categories(ledger_account_id)
  WHERE direction = 'expense' AND parent_id IS NULL AND is_active = 1;

DROP VIEW IF EXISTS v_expense_by_category;

CREATE VIEW v_expense_by_category AS
SELECT
  c.id AS category_id,
  c.name_ar,
  c.parent_id,
  COALESCE((SELECT SUM(pl.debit_piastres) - SUM(pl.credit_piastres)
              FROM v_posted_lines pl
             WHERE pl.account_id = c.ledger_account_id), 0) AS total_piastres
FROM categories c
JOIN accounts a ON a.id = c.ledger_account_id AND a.type = 'expense'
WHERE c.direction = 'expense'
  AND c.parent_id IS NULL;   -- ⭐ the roll-up filter, no longer optional

-- -----------------------------------------------------------------------------
-- R-048 — v_deposit_leakage was narrower than its name and had a dead clause
--
-- The old join read:
--     JOIN payments p ON p.id = pl.entry_id OR p.journal_entry_id = pl.entry_id
-- `p.id = pl.entry_id` compares a payment id to a journal-entry id. Different
-- tables, different prefixes: it can never match. Dead code in a security
-- control reads as breadth that is not there — and the `OR` also defeats the
-- index on `journal_entry_id`.
--
-- The bigger gap: it caught a deposit credited to **income** only. A deposit
-- credited to a **fund** (equity) account would be just as wrong — the village
-- would be treating money it owes back as its own reserve — and was invisible.
-- The rule is stated positively now: a deposit must credit a LIABILITY.
-- Anything else is a leak.
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_deposit_leakage;

CREATE VIEW v_deposit_leakage AS
SELECT pl.entry_id, pl.id AS line_id, p.receipt_no, c.name_ar AS category_ar,
       a.code AS account_code, a.name_ar AS account_ar, a.type AS account_type,
       pl.credit_piastres
FROM v_posted_lines pl
JOIN accounts   a ON a.id = pl.account_id
JOIN payments   p ON p.journal_entry_id = pl.entry_id
JOIN categories c ON c.id = p.category_id
WHERE c.kind = 'deposit'
  AND pl.credit_piastres > 0
  AND a.type <> 'liability';   -- ⭐ not "is income" — "is not a liability"
