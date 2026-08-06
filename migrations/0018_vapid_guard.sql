-- =============================================================================
-- 0018_vapid_guard.sql — make R-069 loud instead of silent.
--
-- The VAPID public key is baked into every browser subscription at the moment
-- the resident enables notifications. Deploy a different key and nothing errors:
-- the push service accepts the request, and the browser silently drops a message
-- signed by a sender it does not recognise. Notifications stop, one resident at
-- a time, and the only signal is residents eventually saying "I don't get those
-- any more" — months later, if at all.
--
-- The failure is silent because there is nothing to compare against. So we make
-- something: the first key ever used is recorded, and every later send checks
-- against it. A mismatch refuses to send and says why, which turns "notifications
-- quietly stopped" into "notifications stopped and the reason is on the screen".
--
-- ## Why a fingerprint and not the key
-- The public key is not secret — it is in every subscription — but storing the
-- key invites someone to "fix" a mismatch by updating this row, which is exactly
-- the wrong repair: the subscriptions are already orphaned and the honest fix is
-- to put the ORIGINAL key back. A fingerprint is enough to detect, and useless
-- for papering over.
-- =============================================================================

CREATE TABLE vapid_identity (
  id            INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  fingerprint   TEXT    NOT NULL,
  first_seen_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- Written by the code, not by hand, so "who changed this and when" is on the
  -- record if anyone ever does.
  note_ar       TEXT
) STRICT;

-- The row is written once and never updated. Changing the deployed key is a
-- decision with a cost; it must not be possible to make it disappear by editing
-- a row. Putting the original key back is the fix, and it needs no edit here.
CREATE TRIGGER trg_vapid_identity_immutable
BEFORE UPDATE ON vapid_identity
BEGIN
  SELECT RAISE(ABORT,
    'مفتاح الإشعارات اتسجّل قبل كده ومينفعش يتغيّر من هنا — رجّع المفتاح الأصلي');
END;

CREATE TRIGGER trg_vapid_identity_no_delete
BEFORE DELETE ON vapid_identity
BEGIN
  SELECT RAISE(ABORT, 'مينفعش تمسح تسجيل مفتاح الإشعارات');
END;
