-- =============================================================================
-- 0016_decision_notifications.sql
--
-- Telling the resident what happened to their receipt — for the ORDINARY
-- decisions, not just the rare bad one.
--
-- Until now the only event a resident heard about was a **reversal**. That is
-- backwards: the everyday cases (approved, needs more information, rejected)
-- were silent, and the one message the system ever sent was "we took your
-- approval back". `01_PRD` A4 asks for the approval notification by name.
--
-- ## Two problems this migration fixes at once
--
-- **1. R-063's recorded weakness.** `v_reversed_payments.notified` matched on
-- `kind` + `link_path` because `notifications` had no link to a payment. Two
-- reversals for one resident therefore counted as notified when only one
-- message existed — a weak check that read like a strong one. Notifications now
-- carry `payment_id`.
--
-- **2. Duplicate messages on a double tap.** `reviewPayment` is idempotent by
-- design: a second approve changes 0 rows. But a notification written in the
-- same batch would be inserted anyway, so the resident gets the same message
-- twice — on a slow connection, which is exactly when people tap twice.
--
-- The unique index below makes the second insert a no-op at the database rather
-- than a check in application code. `INSERT OR IGNORE` then gives us both
-- properties that matter:
--   · a decision **cannot** be recorded without the resident being told
--     (same `db.batch()` — it commits together or not at all);
--   · and they are told exactly **once**.
--
-- Duplicate-suppression by unique index rather than by "check first, then
-- insert" is the same reasoning as `mutate()`: two statements that must agree
-- are two statements that will eventually disagree.
-- =============================================================================

ALTER TABLE notifications ADD COLUMN payment_id TEXT REFERENCES payments(id);

-- One message per (receipt, kind of news). A receipt that is approved, then
-- reversed, correctly produces two rows — different kinds. A receipt approved
-- twice by a double tap produces one.
CREATE UNIQUE INDEX ux_notif_payment_kind
  ON notifications(payment_id, kind)
  WHERE payment_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- v_payment_notifications — every decision, and whether the resident was told.
--
-- Replaces `v_reversed_payments`'s weak `notified` (R-063). This joins on the
-- payment id, so "decided but silent" is a row somebody can count rather than a
-- guess. It covers every terminal decision, not only reversal: a rejected
-- receipt nobody was told about is the same failure wearing different clothes.
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_reversed_payments;

CREATE VIEW v_payment_notifications AS
SELECT p.id, p.receipt_no, p.status, p.submitted_by, p.unit_id,
       p.review_reason_ar AS reason_ar, p.reviewed_by, p.reviewed_at,
       p.reversed_by, p.reversed_at,
       (SELECT COUNT(*) FROM notifications n WHERE n.payment_id = p.id) AS messages
FROM payments p
WHERE p.status IN ('approved','rejected','needs_info','duplicate','reversed');
