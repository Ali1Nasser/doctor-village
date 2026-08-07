-- =============================================================================
-- 0021_settlements_and_credits.sql
--
-- ⚠️ PORTABILITY NOTE — read before editing any RAISE below.
-- Every message here is ONE string literal. It must stay that way.
-- `RAISE(ABORT, 'a' || 'b')` parses on SQLite 3.51 (what node:sqlite ships) and
-- is a SYNTAX ERROR on 3.45 (what python3's sqlite3 ships) — RAISE's second
-- argument is a literal, not an expression. This file was written with `||`
-- for readability, passed every Node test, and failed the moment the Python
-- verifier loaded it. That is A-05 in miniature: D1's SQLite build is still
-- unverified, so anything that only parses on the newest engine is a deploy-day
-- failure waiting to happen. Long messages wrap in the editor; they do not
-- concatenate.
--
-- Ports the three accounting cycles the parallel v1.8 build had and this one
-- did not. The base build already carries `reconciliations` (a monthly snapshot
-- of book vs statement) and `resident_credits` (a row saying the village owes an
-- owner money) — but neither had a *cycle*. A difference could be recorded and
-- never resolved; a credit could exist and never be given back. Both are the
-- shapes that quietly become "the board is keeping my money".
--
-- Three cycles, each with its own maker–checker:
--
--   1. reconciliation_adjustments — settling a difference the bank statement
--      shows and the books do not.
--   2. credit_operations — applying an owner's credit to a due, or refunding it.
--   3. period_events — closing a fiscal period, and reopening one.
--
-- ## The rule that shapes cycle 1, and why it is not optional
--
-- A reconciliation difference has two completely different causes and only one
-- of them is an accounting event:
--
--   · **Timing.** A cheque written on the 30th that clears on the 3rd. The books
--     are RIGHT and the statement is stale. Posting an entry here would
--     DOUBLE-COUNT the payment the moment it clears.
--   · **Unrecorded.** A bank fee, interest, or a transfer nobody entered. The
--     books are WRONG and an entry is exactly what is missing.
--
-- `trg_adjustment_timing_never_posts` refuses the first outright. This is the
-- single most valuable guard in the file: "reconcile the difference away" is the
-- instinct of every treasurer under time pressure, and doing it to a timing
-- difference silently corrupts the ledger in a way the accounting equation still
-- balances through — so nothing else would catch it.
--
-- ## Reversal needs a THIRD person
--
-- Adopted from v1.8 («العكس يحتاج منفذًا ثالثًا»). Maker–checker stops one
-- person acting alone. It does not stop TWO people who agreed, posting and then
-- unposting to hide something. Requiring the reverser to be neither the maker
-- nor the checker means undoing a settlement always widens the circle of people
-- who know.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The two accounts this cycle needs — 1901 (suspense) and 5902 (bank charges) —
-- live in `seed/prod/001_chart_of_accounts.sql`, NOT here.
--
-- They were briefly inserted by this migration, which was wrong twice over:
-- the chart of accounts is seed data, not schema, and that file carries an
-- explicit launch gate requiring an accountant to sign the chart off (Q15,
-- CP-8). Adding accounts from a migration routes around that signature. It also
-- broke `verify_ledger.py`, which copies the chart between databases and found
-- the rows already present.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- reconciliation_adjustments
-- ---------------------------------------------------------------------------
CREATE TABLE reconciliation_adjustments (
  id                 TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  reconciliation_id  TEXT    NOT NULL REFERENCES reconciliations(id),
  -- Why the books and the statement disagree. 'timing' is recordable so the
  -- board can SAY "we looked at it and it was a cheque in transit" — it simply
  -- can never post.
  kind               TEXT    NOT NULL CHECK (kind IN
                       ('timing','bank_fee','bank_interest',
                        'unrecorded_receipt','unrecorded_payment','error_correction')),
  amount_piastres    INTEGER NOT NULL CHECK (amount_piastres > 0),
  reason_ar          TEXT    NOT NULL CHECK (length(trim(reason_ar)) >= 8),
  status             TEXT    NOT NULL DEFAULT 'requested'
                       CHECK (status IN ('requested','approved','posted','rejected','reversed')),
  requested_by       TEXT    NOT NULL REFERENCES profiles(id),
  requested_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  approved_by        TEXT    REFERENCES profiles(id),
  approved_at        TEXT,
  journal_entry_id   TEXT    REFERENCES journal_entries(id),
  reversed_by        TEXT    REFERENCES profiles(id),
  reversed_at        TEXT,
  reversal_entry_id  TEXT    REFERENCES journal_entries(id),
  reversal_reason_ar TEXT,
  -- maker is never checker
  CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK (status <> 'approved' OR approved_by IS NOT NULL),
  CHECK (status <> 'posted'   OR journal_entry_id IS NOT NULL),
  CHECK (status <> 'reversed' OR (reversed_by IS NOT NULL AND reversal_reason_ar IS NOT NULL))
) STRICT;

CREATE INDEX idx_adj_recon ON reconciliation_adjustments(reconciliation_id);
CREATE INDEX idx_adj_open  ON reconciliation_adjustments(status) WHERE status = 'requested';

-- One open request per reconciliation line. Two people settling the same
-- difference twice is how a village pays a bank fee to itself.
CREATE UNIQUE INDEX uq_adj_one_open_per_recon
  ON reconciliation_adjustments(reconciliation_id)
  WHERE status IN ('requested','approved');

-- ⭐ The guard this whole table exists for.
CREATE TRIGGER trg_adjustment_timing_never_posts
BEFORE UPDATE OF status ON reconciliation_adjustments
WHEN NEW.status = 'posted' AND OLD.kind = 'timing'
BEGIN
  SELECT RAISE(ABORT, 'فرق التوقيت مش بيتقفل بقيد — الشيك هيصفّى لوحده. لو رحّلته هتحسب الدفعة مرتين. (a timing difference must never post — it would double-count when it clears)');
END;

CREATE TRIGGER trg_adjustment_reverser_is_third_person
BEFORE UPDATE OF reversed_by ON reconciliation_adjustments
WHEN NEW.reversed_by IS NOT NULL
 AND (NEW.reversed_by = OLD.requested_by OR NEW.reversed_by = OLD.approved_by)
BEGIN
  SELECT RAISE(ABORT, 'عكس التسوية محتاج شخص تالت غير اللي طلبها واللي اعتمدها — reversing a settlement needs a third person');
END;

CREATE TRIGGER trg_adjustment_frozen_after_post
BEFORE UPDATE ON reconciliation_adjustments
WHEN OLD.status IN ('posted','reversed')
 AND (NEW.amount_piastres <> OLD.amount_piastres
   OR NEW.kind            <> OLD.kind
   OR NEW.journal_entry_id IS NOT OLD.journal_entry_id)
BEGIN
  SELECT RAISE(ABORT, 'التسوية المرحّلة مش بتتعدّل — post a reversal instead');
END;

CREATE TRIGGER trg_adjustment_no_delete
BEFORE DELETE ON reconciliation_adjustments
WHEN OLD.status IN ('posted','reversed')
BEGIN
  SELECT RAISE(ABORT, 'التسوية المرحّلة مش بتتمسح');
END;

-- ---------------------------------------------------------------------------
-- credit_operations — تطبيق أو ردّ رصيد دائن
--
-- `resident_credits` says the village owes an owner money (an overpayment
-- became a liability, never income — 06 §4). This table is how that debt is
-- discharged: applied against a future due, or paid back.
--
-- The two ceilings are the whole point. An apply that exceeds the credit
-- invents money; an apply that exceeds the due creates a NEW credit while
-- claiming to clear one.
-- ---------------------------------------------------------------------------
CREATE TABLE credit_operations (
  id                 TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  credit_id          TEXT    NOT NULL REFERENCES resident_credits(id),
  unit_id            TEXT    NOT NULL REFERENCES units(id),
  operation          TEXT    NOT NULL CHECK (operation IN ('apply','refund')),
  amount_piastres    INTEGER NOT NULL CHECK (amount_piastres > 0),
  -- apply → which due it clears. refund → which asset account paid it out.
  applied_to_due_id  TEXT    REFERENCES unit_dues(id),
  payout_account_id  TEXT    REFERENCES accounts(id),
  reason_ar          TEXT    NOT NULL CHECK (length(trim(reason_ar)) >= 4),
  status             TEXT    NOT NULL DEFAULT 'requested'
                       CHECK (status IN ('requested','approved','posted','rejected')),
  requested_by       TEXT    NOT NULL REFERENCES profiles(id),
  requested_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  approved_by        TEXT    REFERENCES profiles(id),
  approved_at        TEXT,
  journal_entry_id   TEXT    REFERENCES journal_entries(id),
  CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK (operation <> 'apply'  OR applied_to_due_id IS NOT NULL),
  -- A refund must name the channel it left by. "we gave it back in cash" with
  -- no account is how a refund becomes untraceable.
  CHECK (operation <> 'refund' OR payout_account_id IS NOT NULL),
  CHECK (status <> 'posted' OR journal_entry_id IS NOT NULL)
) STRICT;

CREATE INDEX idx_credop_credit ON credit_operations(credit_id);
CREATE INDEX idx_credop_unit   ON credit_operations(unit_id);

-- ⭐ Ceiling 1: never discharge more credit than exists.
-- Counts every operation that is still alive (not rejected) against the credit,
-- so two concurrent half-requests cannot together exceed it.
CREATE TRIGGER trg_credit_op_within_balance
BEFORE INSERT ON credit_operations
WHEN NEW.amount_piastres > (
       SELECT rc.amount_piastres - COALESCE((
                SELECT SUM(co.amount_piastres) FROM credit_operations co
                 WHERE co.credit_id = NEW.credit_id AND co.status <> 'rejected'), 0)
         FROM resident_credits rc WHERE rc.id = NEW.credit_id)
BEGIN
  SELECT RAISE(ABORT, 'المبلغ أكبر من الرصيد الدائن المتاح — the amount exceeds the available credit');
END;

-- ⭐ Ceiling 2: an apply never exceeds what is actually owed on that due.
CREATE TRIGGER trg_credit_apply_within_due
BEFORE INSERT ON credit_operations
WHEN NEW.operation = 'apply'
 AND NEW.amount_piastres > (
       SELECT ud.amount_piastres - ud.waived_piastres
         FROM unit_dues ud WHERE ud.id = NEW.applied_to_due_id)
BEGIN
  SELECT RAISE(ABORT, 'مينفعش تخصم من الرصيد أكتر من المستحق على الوحدة — an application cannot exceed the outstanding due');
END;

CREATE TRIGGER trg_credit_op_frozen_after_post
BEFORE UPDATE ON credit_operations
WHEN OLD.status = 'posted'
 AND (NEW.amount_piastres <> OLD.amount_piastres
   OR NEW.operation       <> OLD.operation
   OR NEW.journal_entry_id IS NOT OLD.journal_entry_id)
BEGIN
  SELECT RAISE(ABORT, 'حركة الرصيد المرحّلة مش بتتعدّل');
END;

CREATE TRIGGER trg_credit_op_no_delete
BEFORE DELETE ON credit_operations
WHEN OLD.status = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'حركة الرصيد المرحّلة مش بتتمسح');
END;

-- ---------------------------------------------------------------------------
-- period_events — إقفال وإعادة فتح الفترة المالية
--
-- `fiscal_periods` already carries closed_by / reopened_by columns. What it had
-- no record of is the SEQUENCE: a period closed, reopened, and closed again
-- leaves only the last actor's name, and the interesting question at an assembly
-- is always "how many times was this reopened, and by whom?".
-- ---------------------------------------------------------------------------
CREATE TABLE period_events (
  id         TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  period_id  TEXT NOT NULL REFERENCES fiscal_periods(id),
  event      TEXT NOT NULL CHECK (event IN ('closed','reopened')),
  actor_id   TEXT NOT NULL REFERENCES profiles(id),
  reason_ar  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (event <> 'reopened' OR (reason_ar IS NOT NULL AND length(trim(reason_ar)) >= 8))
) STRICT;

CREATE INDEX idx_period_events ON period_events(period_id, created_at DESC);

-- Append-only, like every other record of who did what.
CREATE TRIGGER trg_period_event_no_update
BEFORE UPDATE ON period_events
BEGIN SELECT RAISE(ABORT, 'سجل الفترات مش بيتعدّل'); END;

CREATE TRIGGER trg_period_event_no_delete
BEFORE DELETE ON period_events
BEGIN SELECT RAISE(ABORT, 'سجل الفترات مش بيتمسح'); END;

-- ⭐ Reopening is done by someone OTHER than whoever closed it.
-- Without this, a treasurer who closes a period can reopen it, change a figure
-- and close it again alone — which makes closing decorative.
CREATE TRIGGER trg_period_reopen_different_person
BEFORE UPDATE OF status ON fiscal_periods
WHEN NEW.status = 'reopened' AND OLD.status = 'closed'
 AND NEW.reopened_by IS NOT NULL AND NEW.reopened_by = OLD.closed_by
BEGIN
  SELECT RAISE(ABORT, 'اللي قفل الفترة مينفعش هو اللي يفتحها تاني — لازم شخص تاني. (the person who closed a period cannot be the one to reopen it)');
END;

-- ⭐ A period with unposted expenses cannot close: closing over them would
-- report a year that spent less than it did.
--
-- The link is `spent_on`, not a foreign key: `expenses` has no `period_id`. An
-- expense reaches a period only through the journal entry it posts to, and an
-- UNPOSTED expense has no entry yet — which is precisely the case this trigger
-- exists to catch. The date range is the only relation that exists before
-- posting, so it is the one the guard has to use.
CREATE TRIGGER trg_period_close_needs_clean_expenses
BEFORE UPDATE OF status ON fiscal_periods
WHEN NEW.status = 'closed' AND OLD.status <> 'closed'
 AND EXISTS (SELECT 1 FROM expenses e
              WHERE e.spent_on BETWEEN NEW.starts_on AND NEW.ends_on
                AND e.status NOT IN ('posted','reversed'))
BEGIN
  SELECT RAISE(ABORT, 'فيه مصروفات لسه مستنية ترحيل في الفترة دي — a period with pending expenses cannot close');
END;

-- ⭐ …and neither can one with an unsettled reconciliation difference.
CREATE TRIGGER trg_period_close_needs_reconciliation
BEFORE UPDATE OF status ON fiscal_periods
WHEN NEW.status = 'closed' AND OLD.status <> 'closed'
 AND EXISTS (SELECT 1 FROM reconciliation_adjustments a
              JOIN reconciliations r ON r.id = a.reconciliation_id
             WHERE r.period_id = NEW.id AND a.status IN ('requested','approved'))
BEGIN
  SELECT RAISE(ABORT, 'فيه فروق مطابقة لسه مفتوحة في الفترة دي — an unsettled reconciliation difference is open');
END;

-- ---------------------------------------------------------------------------
-- Views for /admin/health and /finance
-- ---------------------------------------------------------------------------

-- Money nobody has explained yet. A number that only ever goes UP is a warning.
CREATE VIEW v_suspense_balance AS
SELECT COALESCE(SUM(l.debit_piastres - l.credit_piastres), 0) AS balance_piastres,
       COUNT(DISTINCT l.entry_id)                             AS entries
  FROM journal_lines l
  JOIN journal_entries e ON e.id = l.entry_id AND e.posted_at IS NOT NULL
 WHERE l.account_id = 'ACC00000000000000000001901';

-- Credit the village still owes owners, net of everything applied or refunded.
CREATE VIEW v_open_resident_credits AS
SELECT rc.id            AS credit_id,
       rc.unit_id       AS unit_id,
       rc.amount_piastres
         - COALESCE((SELECT SUM(co.amount_piastres) FROM credit_operations co
                      WHERE co.credit_id = rc.id AND co.status = 'posted'), 0)
                      AS remaining_piastres
  FROM resident_credits rc
 WHERE rc.applied_at IS NULL;

CREATE VIEW v_open_settlements AS
SELECT a.id, a.reconciliation_id, a.kind, a.amount_piastres, a.reason_ar,
       a.status, a.requested_by, a.requested_at, r.period_id, r.as_of
  FROM reconciliation_adjustments a
  JOIN reconciliations r ON r.id = a.reconciliation_id
 WHERE a.status IN ('requested','approved');
