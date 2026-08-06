-- =============================================================================
-- 0002_ledger.sql — double-entry accounting core
-- Authoritative source: 06_ACCOUNTING_AND_LEDGER.md (ADR-013)
--
-- The design goal of this file: make the three most dangerous financial errors
-- STRUCTURALLY IMPOSSIBLE rather than merely tested.
--   1. الوديعة booked as income   -> categories.kind='deposit' cannot map to an
--                                    income account (trg_category_account_kind)
--   2. an unbalanced entry posting -> trg_entry_balanced blocks posting unless
--                                    SUM(debit) = SUM(credit)
--   3. a posted entry being edited -> trg_line_no_update / trg_line_no_delete /
--                                    trg_entry_no_delete_posted
--
-- A test can only tell you an error happened. A constraint stops it happening.
-- The tests in tests/unit/ledger still exist — they assert these fire.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- accounts — شجرة الحسابات     (06 §2)
-- ⚠️ LAUNCH BLOCKER: a qualified accountant must sign off this chart and the
--    الوديعة treatment before production. CHECKPOINTS.md CP-8. See Q15.
-- -----------------------------------------------------------------------------
CREATE TABLE accounts (
  id         TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  code       TEXT    NOT NULL UNIQUE,
  name_ar    TEXT    NOT NULL,
  type       TEXT    NOT NULL CHECK (type IN ('asset','liability','fund','income','expense')),
  -- normal_balance is derived from type and stored so the posting code never
  -- has to remember which side an account increases on.
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit','credit')),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK (
    (type IN ('asset','expense')            AND normal_balance = 'debit') OR
    (type IN ('liability','fund','income')  AND normal_balance = 'credit')
  )
) STRICT;

-- -----------------------------------------------------------------------------
-- funds — الصناديق: operating | deposit | reserve     (06 §2)
-- This dimension is what lets /finance show "الفلوس المتاحة للصرف" separately
-- from "الودائع والاحتياطي — أمانات مش ملك القرية". (04_UX_SPEC §3)
-- -----------------------------------------------------------------------------
CREATE TABLE funds (
  id         TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  name_ar    TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('operating','deposit','reserve')),
  is_spendable INTEGER NOT NULL CHECK (is_spendable IN (0,1)),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  -- a deposit fund is money held in trust; it is never spendable.
  CHECK (kind <> 'deposit' OR is_spendable = 0)
) STRICT;

CREATE TABLE cost_centers (
  id         TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  name_ar    TEXT    NOT NULL,
  building_id TEXT   REFERENCES buildings(id),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
) STRICT;

-- -----------------------------------------------------------------------------
-- fiscal_periods — الفترات المالية     (06 §5)
-- -----------------------------------------------------------------------------
CREATE TABLE fiscal_periods (
  id         TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  name_ar    TEXT    NOT NULL,
  starts_on  TEXT    NOT NULL CHECK (starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ends_on    TEXT    NOT NULL CHECK (ends_on   GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status     TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','reopened')),
  closed_by  TEXT    REFERENCES profiles(id),
  closed_at  TEXT,
  reopened_by TEXT   REFERENCES profiles(id),
  reopened_at TEXT,
  reopen_reason_ar TEXT,
  CHECK (ends_on > starts_on),
  CHECK (status <> 'closed'   OR closed_by IS NOT NULL),
  -- reopening is deliberately uncomfortable: it must name a person and a reason
  CHECK (status <> 'reopened' OR (reopened_by IS NOT NULL AND reopen_reason_ar IS NOT NULL))
) STRICT;

-- -----------------------------------------------------------------------------
-- categories — فئات الإيرادات والمصروفات
-- Every category maps to exactly one ledger account. This mapping is the
-- structural defence against R-020 (الوديعة booked as income).
-- -----------------------------------------------------------------------------
CREATE TABLE categories (
  id                TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  parent_id         TEXT    REFERENCES categories(id),
  name_ar           TEXT    NOT NULL,
  direction         TEXT    NOT NULL CHECK (direction IN ('income','expense')),
  -- 'deposit' is its own kind precisely so it can never be treated as ordinary
  -- income by accident. See 06 §1 "⚠️ الوديعة is the trap".
  kind              TEXT    NOT NULL CHECK (kind IN
                            ('operating_income','deposit','contribution','penalty','expense')),
  ledger_account_id TEXT    NOT NULL REFERENCES accounts(id),
  default_fund_id   TEXT    REFERENCES funds(id),
  icon              TEXT,
  color             TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  CHECK ((direction = 'expense') = (kind = 'expense')),
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;

CREATE INDEX idx_categories_parent ON categories(parent_id);

-- ⭐ The single most important trigger in the schema.
-- A deposit category MUST point at a liability account. An income category MUST
-- point at an income account. An expense category MUST point at an expense
-- account. Booking الوديعة as revenue is therefore not a bug you can write.
CREATE TRIGGER trg_category_account_kind_ins
BEFORE INSERT ON categories
BEGIN
  SELECT CASE
    WHEN NEW.kind = 'deposit'
     AND (SELECT type FROM accounts WHERE id = NEW.ledger_account_id) <> 'liability'
    THEN RAISE(ABORT, 'الوديعة لازم تترحّل على حساب التزام مش إيراد — deposit category must map to a liability account')
    WHEN NEW.kind IN ('operating_income','contribution','penalty')
     AND (SELECT type FROM accounts WHERE id = NEW.ledger_account_id) <> 'income'
    THEN RAISE(ABORT, 'income category must map to an income account')
    WHEN NEW.kind = 'expense'
     AND (SELECT type FROM accounts WHERE id = NEW.ledger_account_id) <> 'expense'
    THEN RAISE(ABORT, 'expense category must map to an expense account')
  END;
END;

CREATE TRIGGER trg_category_account_kind_upd
BEFORE UPDATE OF kind, ledger_account_id ON categories
BEGIN
  SELECT CASE
    WHEN NEW.kind = 'deposit'
     AND (SELECT type FROM accounts WHERE id = NEW.ledger_account_id) <> 'liability'
    THEN RAISE(ABORT, 'الوديعة لازم تترحّل على حساب التزام مش إيراد — deposit category must map to a liability account')
    WHEN NEW.kind IN ('operating_income','contribution','penalty')
     AND (SELECT type FROM accounts WHERE id = NEW.ledger_account_id) <> 'income'
    THEN RAISE(ABORT, 'income category must map to an income account')
    WHEN NEW.kind = 'expense'
     AND (SELECT type FROM accounts WHERE id = NEW.ledger_account_id) <> 'expense'
    THEN RAISE(ABORT, 'expense category must map to an expense account')
  END;
END;

-- -----------------------------------------------------------------------------
-- journal_entries / journal_lines — القيود     (06 §2)
-- -----------------------------------------------------------------------------
CREATE TABLE journal_entries (
  id                TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  entry_no          TEXT    NOT NULL UNIQUE,          -- J-2026-000417
  entry_date        TEXT    NOT NULL CHECK (entry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  period_id         TEXT    NOT NULL REFERENCES fiscal_periods(id),
  description_ar    TEXT    NOT NULL,
  -- every entry traces to an approved source document. No orphan entries. (06 §2)
  source_type       TEXT    NOT NULL CHECK (source_type IN
                            ('payment','expense','adjustment','opening_balance','refund','waiver','reclassification')),
  source_id         TEXT,
  created_by        TEXT    NOT NULL REFERENCES profiles(id),
  -- maker-checker: approved_by must differ from created_by. (06 §6)
  approved_by       TEXT    REFERENCES profiles(id),
  posted_at         TEXT,
  is_reversal       INTEGER NOT NULL DEFAULT 0 CHECK (is_reversal IN (0,1)),
  reverses_entry_id TEXT    REFERENCES journal_entries(id),
  reversal_reason_ar TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (is_reversal = 0 OR (reverses_entry_id IS NOT NULL AND reversal_reason_ar IS NOT NULL)),
  CHECK (source_type = 'opening_balance' OR source_id IS NOT NULL)
) STRICT;

CREATE INDEX idx_entries_period ON journal_entries(period_id);
CREATE INDEX idx_entries_source ON journal_entries(source_type, source_id);
CREATE INDEX idx_entries_posted ON journal_entries(posted_at) WHERE posted_at IS NOT NULL;

CREATE TABLE journal_lines (
  id             TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  entry_id       TEXT    NOT NULL REFERENCES journal_entries(id),
  line_no        INTEGER NOT NULL CHECK (line_no > 0),
  account_id     TEXT    NOT NULL REFERENCES accounts(id),
  fund_id        TEXT    REFERENCES funds(id),
  cost_center_id TEXT    REFERENCES cost_centers(id),
  -- INTEGER piastres. In a STRICT table 12.5 is a type error, not a rounding. (C4)
  debit_piastres  INTEGER NOT NULL DEFAULT 0 CHECK (debit_piastres  >= 0),
  credit_piastres INTEGER NOT NULL DEFAULT 0 CHECK (credit_piastres >= 0),
  unit_id        TEXT    REFERENCES units(id),
  profile_id     TEXT    REFERENCES profiles(id),
  memo_ar        TEXT,
  -- exactly one side non-zero (06 §2)
  CHECK ((debit_piastres = 0) <> (credit_piastres = 0)),
  UNIQUE (entry_id, line_no)
) STRICT;

CREATE INDEX idx_lines_entry   ON journal_lines(entry_id);
CREATE INDEX idx_lines_account ON journal_lines(account_id);
CREATE INDEX idx_lines_unit    ON journal_lines(unit_id);

-- ⭐ Invariant 1 (06 §9): SUM(debit) = SUM(credit) for every entry.
-- Enforced at the moment of POSTING, because lines are inserted one at a time
-- and an entry is legitimately unbalanced between the first and last insert.
-- Posting must therefore be the last statement of a d1.batch() so the whole
-- thing is atomic.
CREATE TRIGGER trg_entry_balanced
BEFORE UPDATE OF posted_at ON journal_entries
WHEN NEW.posted_at IS NOT NULL AND OLD.posted_at IS NULL
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM journal_lines WHERE entry_id = NEW.id) < 2
      THEN RAISE(ABORT, 'قيد لازم يكون فيه سطرين على الأقل — an entry needs at least two lines')
    WHEN (SELECT COALESCE(SUM(debit_piastres),0) - COALESCE(SUM(credit_piastres),0)
            FROM journal_lines WHERE entry_id = NEW.id) <> 0
      THEN RAISE(ABORT, 'القيد مش متوازن — entry does not balance: SUM(debit) <> SUM(credit)')
    WHEN (SELECT status FROM fiscal_periods WHERE id = NEW.period_id) = 'closed'
      THEN RAISE(ABORT, 'الفترة المالية مقفولة — fiscal period is closed')
  END;
END;

-- Invariant 7 (06 §9): a closed period rejects ordinary writes.
CREATE TRIGGER trg_entry_period_open
BEFORE INSERT ON journal_entries
BEGIN
  SELECT CASE
    WHEN (SELECT status FROM fiscal_periods WHERE id = NEW.period_id) = 'closed'
      THEN RAISE(ABORT, 'الفترة المالية مقفولة — cannot write to a closed fiscal period')
  END;
END;

-- Invariant 2 / access test 15: posted entries are immutable, and NO role —
-- including developer — can update or delete a journal_line. Enforced by the
-- database, so a bug in lib/db/ cannot rewrite history.
CREATE TRIGGER trg_line_no_update
BEFORE UPDATE ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'سطور القيود مش بتتعدّل — journal_lines are append-only; post a reversing entry instead');
END;

CREATE TRIGGER trg_line_no_delete
BEFORE DELETE ON journal_lines
WHEN (SELECT posted_at FROM journal_entries WHERE id = OLD.entry_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'سطور القيود المرحّلة مش بتتمسح — cannot delete a line of a posted entry');
END;

CREATE TRIGGER trg_line_no_insert_posted
BEFORE INSERT ON journal_lines
WHEN (SELECT posted_at FROM journal_entries WHERE id = NEW.entry_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'مش ممكن تضيف سطر لقيد مرحّل — cannot add a line to a posted entry');
END;

CREATE TRIGGER trg_entry_no_delete_posted
BEFORE DELETE ON journal_entries
WHEN OLD.posted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'القيود المرحّلة مش بتتمسح — a posted entry cannot be deleted; reverse it');
END;

-- A posted entry may never be un-posted or re-dated.
CREATE TRIGGER trg_entry_no_unpost
BEFORE UPDATE ON journal_entries
WHEN OLD.posted_at IS NOT NULL
  AND (NEW.posted_at IS NOT OLD.posted_at
    OR NEW.entry_date <> OLD.entry_date
    OR NEW.period_id  <> OLD.period_id)
BEGIN
  SELECT RAISE(ABORT, 'القيد المرحّل مش بيتغيّر — a posted entry is immutable');
END;

-- Maker–checker (06 §6): nobody gives final approval to their own item.
CREATE TRIGGER trg_entry_maker_checker
BEFORE UPDATE OF approved_by ON journal_entries
WHEN NEW.approved_by IS NOT NULL AND NEW.approved_by = NEW.created_by
BEGIN
  SELECT RAISE(ABORT, 'محدش بيعتمد قيد هو اللي عمله — nobody approves their own entry');
END;

-- -----------------------------------------------------------------------------
-- resident_credits — أرصدة دائنة للملاك     (06 §4)
-- An overpayment is a LIABILITY of the village toward the owner, never income.
-- -----------------------------------------------------------------------------
CREATE TABLE resident_credits (
  id                TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  unit_id           TEXT    NOT NULL REFERENCES units(id),
  profile_id        TEXT    REFERENCES profiles(id),
  amount_piastres   INTEGER NOT NULL CHECK (amount_piastres > 0),
  source_payment_id TEXT,
  journal_entry_id  TEXT    REFERENCES journal_entries(id),
  applied_to_due_id TEXT,
  applied_at        TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

CREATE INDEX idx_credits_unit ON resident_credits(unit_id) WHERE applied_at IS NULL;

-- -----------------------------------------------------------------------------
-- reconciliations — المطابقة البنكية     (06 §8)
-- "متطابق مع البنك" is worth more to a resident than any chart.
-- -----------------------------------------------------------------------------
CREATE TABLE reconciliations (
  id                         TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  account_id                 TEXT    NOT NULL REFERENCES accounts(id),
  period_id                  TEXT    NOT NULL REFERENCES fiscal_periods(id),
  as_of                      TEXT    NOT NULL CHECK (as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  statement_balance_piastres INTEGER NOT NULL,
  book_balance_piastres      INTEGER NOT NULL,
  difference_piastres        INTEGER NOT NULL,
  notes_ar                   TEXT,
  done_by                    TEXT    NOT NULL REFERENCES profiles(id),
  done_at                    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (difference_piastres = statement_balance_piastres - book_balance_piastres),
  -- a difference must be explained, never left dangling
  CHECK (difference_piastres = 0 OR notes_ar IS NOT NULL)
) STRICT;

-- -----------------------------------------------------------------------------
-- approval_events — سجل الاعتمادات     (06 §10)
-- -----------------------------------------------------------------------------
CREATE TABLE approval_events (
  id          TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  actor_id    TEXT NOT NULL REFERENCES profiles(id),
  action      TEXT NOT NULL CHECK (action IN
              ('submit','review','approve','reject','need_info','duplicate','cancel',
               'reverse','countersign','waive','refund','reopen_period','close_period')),
  reason_ar   TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- 06 §3: reject / needs_info / duplicate require a reason shown to the resident
  CHECK (action NOT IN ('reject','need_info','duplicate','reverse','waive','reopen_period')
         OR reason_ar IS NOT NULL)
) STRICT;

CREATE INDEX idx_approval_entity ON approval_events(entity_type, entity_id);

-- -----------------------------------------------------------------------------
-- report_snapshots — البيانات المالية المجمّدة     (06 §5, §7)
-- A correction posted later must never silently rewrite a figure residents have
-- already seen. The snapshot stands; the correction appears as a dated revision.
-- -----------------------------------------------------------------------------
CREATE TABLE report_snapshots (
  id            TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  period_id     TEXT NOT NULL REFERENCES fiscal_periods(id),
  kind          TEXT NOT NULL CHECK (kind IN ('monthly','annual','unit_statement','reconciliation')),
  scope_ref     TEXT,
  payload_json  TEXT NOT NULL CHECK (json_valid(payload_json)),
  basis_ar      TEXT NOT NULL DEFAULT 'أساس نقدي معدّل',
  is_provisional INTEGER NOT NULL DEFAULT 0 CHECK (is_provisional IN (0,1)),
  generated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  generated_by  TEXT REFERENCES profiles(id),
  supersedes_id TEXT REFERENCES report_snapshots(id)
) STRICT;

-- A published snapshot is immutable — that is the entire point of it.
CREATE TRIGGER trg_snapshot_immutable
BEFORE UPDATE ON report_snapshots
BEGIN
  SELECT RAISE(ABORT, 'البيان المالي المنشور مش بيتغيّر — publish a superseding revision instead');
END;
