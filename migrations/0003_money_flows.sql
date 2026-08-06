-- =============================================================================
-- 0003_money_flows.sql — obligations, receipts, expenses, staff
-- 06_ACCOUNTING_AND_LEDGER.md §3 (nine-state machine) and §4 (allocation rules)
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- fee_periods — فترات الاشتراك
-- -----------------------------------------------------------------------------
CREATE TABLE fee_periods (
  id              TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  name_ar         TEXT    NOT NULL,                    -- "اشتراك 2026"
  category_id     TEXT    NOT NULL REFERENCES categories(id),
  fiscal_period_id TEXT   NOT NULL REFERENCES fiscal_periods(id),
  starts_on       TEXT    NOT NULL CHECK (starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ends_on         TEXT    NOT NULL CHECK (ends_on   GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  due_on          TEXT    NOT NULL CHECK (due_on    GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  basis           TEXT    NOT NULL CHECK (basis IN ('per_unit','per_sqm')),
  -- flat piastres per unit, OR piastres per square metre. Integer either way.
  amount_piastres INTEGER NOT NULL CHECK (amount_piastres > 0),
  is_published    INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0,1)),
  created_by      TEXT    NOT NULL REFERENCES profiles(id),
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (ends_on > starts_on)
) STRICT;

-- -----------------------------------------------------------------------------
-- unit_dues — المطلوب من كل وحدة
-- Amount is computed at generation then FROZEN — changing the fee later must
-- not silently restate what a resident was already told they owed.
-- -----------------------------------------------------------------------------
CREATE TABLE unit_dues (
  id              TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  fee_period_id   TEXT    NOT NULL REFERENCES fee_periods(id),
  unit_id         TEXT    NOT NULL REFERENCES units(id),
  amount_piastres INTEGER NOT NULL CHECK (amount_piastres > 0),
  waived_piastres INTEGER NOT NULL DEFAULT 0 CHECK (waived_piastres >= 0),
  waiver_reason_ar TEXT,
  waived_by       TEXT    REFERENCES profiles(id),
  waived_at       TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (fee_period_id, unit_id),
  CHECK (waived_piastres <= amount_piastres),
  -- 06 §4: a waiver requires an admin reason and is audited. It appears on the
  -- statement AS A WAIVER, never as a payment.
  CHECK (waived_piastres = 0 OR (waiver_reason_ar IS NOT NULL AND waived_by IS NOT NULL))
) STRICT;

CREATE INDEX idx_dues_unit ON unit_dues(unit_id);

-- -----------------------------------------------------------------------------
-- payment_transitions — the state machine AS DATA     (06 §3)
-- "Transitions are a table, not scattered if statements."
-- -----------------------------------------------------------------------------
CREATE TABLE payment_transitions (
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  requires_reason INTEGER NOT NULL DEFAULT 0 CHECK (requires_reason IN (0,1)),
  actor_scope TEXT NOT NULL CHECK (actor_scope IN ('resident','admin','system')),
  PRIMARY KEY (from_status, to_status)
) STRICT;

INSERT INTO payment_transitions (from_status, to_status, requires_reason, actor_scope) VALUES
  ('draft',        'submitted',    0, 'resident'),
  ('draft',        'cancelled',    0, 'resident'),
  ('submitted',    'under_review', 0, 'admin'),
  ('submitted',    'cancelled',    0, 'resident'),
  ('under_review', 'approved',     0, 'admin'),
  ('under_review', 'needs_info',   1, 'admin'),
  ('under_review', 'rejected',     1, 'admin'),
  ('under_review', 'duplicate',    1, 'admin'),
  ('under_review', 'cancelled',    0, 'resident'),
  ('needs_info',   'submitted',    0, 'resident'),
  ('needs_info',   'cancelled',    0, 'resident'),
  ('approved',     'reversed',     1, 'admin');
-- rejected / duplicate / cancelled / reversed are TERMINAL — absent by design.

-- -----------------------------------------------------------------------------
-- payments — إيصالات السداد     (nine states)
-- -----------------------------------------------------------------------------
CREATE TABLE payments (
  id                        TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  receipt_no                TEXT    NOT NULL UNIQUE,          -- R-2026-00417
  unit_id                   TEXT    NOT NULL REFERENCES units(id),
  submitted_by              TEXT    NOT NULL REFERENCES profiles(id),
  -- set when a delegate submits on behalf of the owner (logged as بالنيابة عن)
  on_behalf_of              TEXT    REFERENCES profiles(id),
  category_id               TEXT    NOT NULL REFERENCES categories(id),
  fee_period_id             TEXT    REFERENCES fee_periods(id),
  claimed_amount_piastres   INTEGER NOT NULL CHECK (claimed_amount_piastres > 0),
  approved_amount_piastres  INTEGER CHECK (approved_amount_piastres IS NULL OR approved_amount_piastres > 0),
  method                    TEXT    NOT NULL CHECK (method IN
                                    ('instapay','bank_transfer','vodafone_cash','cash','other')),
  transfer_date             TEXT    NOT NULL CHECK (transfer_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  reference_no              TEXT,
  storage_key               TEXT    NOT NULL,                 -- private object store key
  image_sha256              TEXT,                             -- duplicate detection
  note_ar                   TEXT,
  status                    TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN
                                    ('draft','submitted','under_review','needs_info',
                                     'approved','rejected','duplicate','cancelled','reversed')),
  -- UNIQUE: one payment can post at most ONE entry. Invariant 3 (06 §9) —
  -- a double-clicked approve cannot post twice even if the guard above it fails.
  journal_entry_id          TEXT    UNIQUE REFERENCES journal_entries(id),
  fund_id                   TEXT    REFERENCES funds(id),
  cost_center_id            TEXT    REFERENCES cost_centers(id),
  reviewed_by               TEXT    REFERENCES profiles(id),
  reviewed_at               TEXT,
  review_reason_ar          TEXT,
  is_reversal               INTEGER NOT NULL DEFAULT 0 CHECK (is_reversal IN (0,1)),
  reverses_payment_id       TEXT    REFERENCES payments(id),
  created_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  submitted_at              TEXT,

  -- constraints carried over verbatim from 02_DATA_MODEL.md §3
  CHECK (status <> 'approved' OR approved_amount_piastres IS NOT NULL),
  CHECK (status NOT IN ('rejected','needs_info','duplicate') OR review_reason_ar IS NOT NULL),
  CHECK (approved_amount_piastres IS NULL
         OR approved_amount_piastres = claimed_amount_piastres
         OR review_reason_ar IS NOT NULL),                    -- corrections must be explained
  -- an approved payment must carry its ledger entry; nothing half-posted (05 §7)
  CHECK (status <> 'approved' OR journal_entry_id IS NOT NULL),
  -- maker–checker: a reviewer may never be the submitter. (C8, 06 §6)
  CHECK (reviewed_by IS NULL OR reviewed_by <> submitted_by)
) STRICT;

CREATE INDEX idx_payments_unit    ON payments(unit_id);
CREATE INDEX idx_payments_status  ON payments(status);
CREATE INDEX idx_payments_queue   ON payments(created_at) WHERE status IN ('submitted','under_review');
CREATE INDEX idx_payments_sha     ON payments(image_sha256) WHERE image_sha256 IS NOT NULL;

-- ⭐ The nine-state machine, enforced by the database against the table above.
CREATE TRIGGER trg_payment_transition
BEFORE UPDATE OF status ON payments
WHEN NEW.status <> OLD.status
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM payment_transitions
                      WHERE from_status = OLD.status AND to_status = NEW.status)
      THEN RAISE(ABORT, 'انتقال حالة غير مسموح — illegal payment state transition')
    WHEN (SELECT requires_reason FROM payment_transitions
           WHERE from_status = OLD.status AND to_status = NEW.status) = 1
     AND (NEW.review_reason_ar IS NULL OR length(trim(NEW.review_reason_ar)) = 0)
      THEN RAISE(ABORT, 'لازم سبب مكتوب — this transition requires a written reason')
  END;
END;

-- A resident can never self-approve, even through a direct write. (access test 3)
CREATE TRIGGER trg_payment_no_self_approve
BEFORE UPDATE OF status ON payments
WHEN NEW.status = 'approved' AND NEW.reviewed_by IS NOT NULL AND NEW.reviewed_by = NEW.submitted_by
BEGIN
  SELECT RAISE(ABORT, 'محدش بيعتمد إيصال هو اللي رفعه — nobody approves their own receipt');
END;

-- Once approved, the money facts are frozen. Only status may move (to reversed).
CREATE TRIGGER trg_payment_frozen_after_approval
BEFORE UPDATE ON payments
WHEN OLD.status = 'approved'
 AND (NEW.claimed_amount_piastres  <> OLD.claimed_amount_piastres
   OR NEW.approved_amount_piastres IS NOT OLD.approved_amount_piastres
   OR NEW.unit_id                  <> OLD.unit_id
   OR NEW.category_id              <> OLD.category_id
   OR NEW.journal_entry_id         IS NOT OLD.journal_entry_id)
BEGIN
  SELECT RAISE(ABORT, 'الإيصال المعتمد مش بيتعدّل — post a reversal instead');
END;

CREATE TRIGGER trg_payment_no_delete
BEFORE DELETE ON payments
WHEN OLD.status IN ('approved','reversed')
BEGIN
  SELECT RAISE(ABORT, 'الإيصالات المعتمدة مش بتتمسح — approved receipts are never deleted');
END;

-- -----------------------------------------------------------------------------
-- expenses — المصروفات
-- -----------------------------------------------------------------------------
CREATE TABLE expenses (
  id                  TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  voucher_no          TEXT    NOT NULL UNIQUE,               -- E-2026-00133
  category_id         TEXT    NOT NULL REFERENCES categories(id),
  amount_piastres     INTEGER NOT NULL CHECK (amount_piastres > 0),
  spent_on            TEXT    NOT NULL CHECK (spent_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  description_ar      TEXT    NOT NULL CHECK (length(trim(description_ar)) > 0),
  vendor_name         TEXT,
  invoice_storage_key TEXT,
  fund_id             TEXT    REFERENCES funds(id),
  cost_center_id      TEXT    REFERENCES cost_centers(id),
  status              TEXT    NOT NULL DEFAULT 'recorded'
                              CHECK (status IN ('recorded','countersigned','posted','reversed')),
  recorded_by         TEXT    NOT NULL REFERENCES profiles(id),
  approved_by         TEXT    REFERENCES profiles(id),
  approved_at         TEXT,
  journal_entry_id    TEXT    UNIQUE REFERENCES journal_entries(id),
  linked_album_id     TEXT,
  linked_ticket_id    TEXT,
  is_reversal         INTEGER NOT NULL DEFAULT 0 CHECK (is_reversal IN (0,1)),
  reverses_expense_id TEXT    REFERENCES expenses(id),
  reversal_reason_ar  TEXT,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- maker–checker (06 §6): the countersigner is never the recorder.
  CHECK (approved_by IS NULL OR approved_by <> recorded_by),
  CHECK (status <> 'posted' OR journal_entry_id IS NOT NULL),
  CHECK (is_reversal = 0 OR (reverses_expense_id IS NOT NULL AND reversal_reason_ar IS NOT NULL))
) STRICT;

CREATE INDEX idx_expenses_category ON expenses(category_id);
CREATE INDEX idx_expenses_date     ON expenses(spent_on);

CREATE TRIGGER trg_expense_frozen_after_post
BEFORE UPDATE ON expenses
WHEN OLD.status = 'posted'
 AND (NEW.amount_piastres <> OLD.amount_piastres
   OR NEW.category_id     <> OLD.category_id
   OR NEW.spent_on        <> OLD.spent_on)
BEGIN
  SELECT RAISE(ABORT, 'المصروف المرحّل مش بيتعدّل — post a reversal instead');
END;

CREATE TRIGGER trg_expense_no_delete_posted
BEFORE DELETE ON expenses
WHEN OLD.status IN ('posted','reversed')
BEGIN
  SELECT RAISE(ABORT, 'المصروفات المرحّلة مش بتتمسح');
END;

-- -----------------------------------------------------------------------------
-- staff — العمالة
-- job_title_ar + salary are visible to ALL members (transparency).
-- full_name is admin/operator only — pending owner decision Q4.
-- The split lives in the VIEW (migration 0005), not in the table.
-- -----------------------------------------------------------------------------
CREATE TABLE staff (
  id                      TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  full_name               TEXT    NOT NULL,
  job_title_ar            TEXT    NOT NULL,
  monthly_salary_piastres INTEGER NOT NULL CHECK (monthly_salary_piastres >= 0),
  started_on              TEXT    CHECK (started_on IS NULL OR started_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ended_on                TEXT    CHECK (ended_on   IS NULL OR ended_on   GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  is_active               INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
) STRICT;
