-- =============================================================================
-- 0017_push_subscriptions.sql — browser push (owner answer to Q23).
--
-- The owner chose Web Push. It is the only channel that reaches a resident's
-- phone and still satisfies C11: no account, no card, no API key, and no
-- company that can start charging in October. The browser's own push service
-- delivers it, and RFC 8291 encryption means **neither Google nor Mozilla can
-- read «اتقبل إيصالك»** — they relay an opaque blob.
--
-- ## These rows are credentials, and they are as sensitive as a phone number
-- A subscription is a URL that lets the holder make a specific person's phone
-- buzz. Leaked, it is a harassment tool aimed at one family; correlated across
-- residents it is a map of who lives here. So it lives behind the same rule as
-- everything else in C6: reachable only through `lib/db/`, with `profile_id`
-- in the predicate, and never listed to anyone but its owner.
--
-- ## Why the endpoint is UNIQUE and not the primary key
-- A browser rotates the endpoint whenever it feels like it, and re-subscribing
-- must replace the old row rather than accumulate. Unique-on-endpoint plus
-- `INSERT OR REPLACE` gives that, while the id stays stable for foreign keys.
-- =============================================================================

CREATE TABLE push_subscriptions (
  id           TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  profile_id   TEXT NOT NULL REFERENCES profiles(id),
  endpoint     TEXT NOT NULL UNIQUE,
  -- The browser's P-256 public key and 16-byte auth secret, base64url. Both are
  -- needed to encrypt; neither is a secret we chose, and neither is useful
  -- without the endpoint.
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  -- So a resident can recognise which device to remove, in their own words.
  device_label_ar TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- Set when the push service says 404/410. Kept rather than deleted for a
  -- while so "notifications stopped working" has an answer on the record.
  gone_at      TEXT,
  last_ok_at   TEXT
) STRICT;

CREATE INDEX idx_push_profile ON push_subscriptions(profile_id) WHERE gone_at IS NULL;

-- -----------------------------------------------------------------------------
-- v_push_reach — how many residents this channel actually reaches.
--
-- Q23's honest weakness is that browser push needs the resident to grant
-- permission, and on iOS to add the site to the home screen first. Some
-- proportion will never do it. **That proportion must be a number the board can
-- see**, not an assumption — otherwise they will believe everyone was told.
-- -----------------------------------------------------------------------------
CREATE VIEW v_push_reach AS
SELECT
  (SELECT COUNT(*) FROM profiles WHERE is_active = 1 AND role = 'resident') AS residents,
  (SELECT COUNT(DISTINCT profile_id) FROM push_subscriptions WHERE gone_at IS NULL)
    AS reachable,
  (SELECT COUNT(*) FROM push_subscriptions WHERE gone_at IS NOT NULL) AS dead;
