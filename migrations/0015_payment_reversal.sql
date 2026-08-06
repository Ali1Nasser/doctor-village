-- =============================================================================
-- 0015_payment_reversal.sql
--
-- Reversing a resident's approved receipt. This is the correction that RESIDENTS
-- see, and it is socially the most delicate thing this system does: someone was
-- told «اتقبل إيصالك ✅» and is now being told it did not count. The wrong
-- version of this feature loses a family's trust permanently.
--
-- ## Why the notification kind is being added, and what that costs
-- `notifications.kind` is a CHECK list with no `payment_reversed`. SQLite cannot
-- ALTER a CHECK constraint, so the table is recreated.
--
-- ⚠️ **A table recreate is destructive.** It is safe here for exactly one
-- reason: this project has never been deployed, so `notifications` is empty
-- everywhere it exists. If that stops being true before launch, this migration
-- must be rewritten to copy rows across. Do not copy this pattern onto a table
-- that holds anything.
--
-- The alternative — reusing `account_changed` for a reversal — was rejected. A
-- resident filtering their notifications would never find it, and a kind that
-- lies is worse than a migration that is honest about being destructive.
-- =============================================================================

PRAGMA foreign_keys = OFF;

CREATE TABLE notifications_new (
  id         TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  kind       TEXT NOT NULL CHECK (kind IN
             ('payment_approved','payment_rejected','payment_needs_info',
              'payment_reversed',
              'new_announcement','due_reminder','account_changed','system')),
  title_ar   TEXT NOT NULL,
  body_ar    TEXT NOT NULL,
  link_path  TEXT,
  channel    TEXT NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app','whatsapp','sms')),
  sent_at    TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

INSERT INTO notifications_new
  SELECT id, profile_id, kind, title_ar, body_ar, link_path, channel,
         sent_at, read_at, created_at
    FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX idx_notif_unread ON notifications(profile_id, read_at);

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- ⭐ The approver cannot be the reverser.
--
-- Maker–checker is normally "the person who made it cannot approve it". A
-- reversal needs the mirror rule: **the person who approved it cannot quietly
-- un-approve it.** Without this, one admin can approve a receipt, take the
-- credit for it with the family, and reverse it later with nobody else ever
-- having looked — which is the shape of every small-community embezzlement that
-- this project exists to make impossible.
--
-- In the schema, per ADR-024, so no route can be the place it is missing.
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_payment_reversal_needs_second_admin
BEFORE UPDATE OF status ON payments
WHEN NEW.status = 'reversed'
 AND NEW.reversed_by IS NOT NULL
 AND NEW.reversed_by = OLD.reviewed_by
BEGIN
  SELECT RAISE(ABORT,
    'اللي اعتمد الإيصال مينفعش يلغيه بنفسه — لازم مسؤول تاني');
END;

-- -----------------------------------------------------------------------------
-- A reversal must say who did it and why, and the reason is never blank.
-- `trg_payment_status` already demands a reason for approved → reversed
-- (`payment_transitions.requires_reason = 1`). This adds the actor, which the
-- transition table cannot express.
-- -----------------------------------------------------------------------------
ALTER TABLE payments ADD COLUMN reversed_by TEXT REFERENCES profiles(id);
ALTER TABLE payments ADD COLUMN reversed_at TEXT;

CREATE TRIGGER trg_payment_reversal_needs_actor
BEFORE UPDATE OF status ON payments
WHEN NEW.status = 'reversed' AND (NEW.reversed_by IS NULL OR NEW.reversed_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'الإلغاء لازم يتسجّل باسم اللي عمله ووقته');
END;

-- -----------------------------------------------------------------------------
-- v_reversed_payments — what a resident is owed an explanation for.
--
-- A reversal without a delivered explanation is indistinguishable from money
-- going missing. This view is what the notification job and the admin screen
-- both read, so "reversed but never told" is a state somebody can see.
-- -----------------------------------------------------------------------------
CREATE VIEW v_reversed_payments AS
SELECT p.id, p.receipt_no, p.unit_id, p.submitted_by,
       p.claimed_amount_piastres, p.approved_amount_piastres,
       p.review_reason_ar AS reason_ar, p.reversed_by, p.reversed_at,
       (SELECT COUNT(*) FROM notifications n
         WHERE n.profile_id = p.submitted_by
           AND n.kind = 'payment_reversed'
           AND n.link_path = '/payments') AS notified
FROM payments p
WHERE p.status = 'reversed';
