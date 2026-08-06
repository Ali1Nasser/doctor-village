-- =============================================================================
-- 0009_payment_drafts.sql — the five-step payment wizard's memory
--
-- `04_UX_SPEC.md` §4.1: "One question per screen. A back button that never loses
-- entered data. Progress is saved as a local draft — if the connection dies at
-- step 4, nothing is retyped."
--
-- ## Why the draft lives on the SERVER and not only in sessionStorage
--
-- sessionStorage dies when the tab closes, when the phone kills the tab to
-- reclaim memory (routine on a five-year-old Android), and when the resident
-- switches to their bank app to check the amount and comes back — which is
-- exactly what they will do, at step 1, every time.
--
-- A server draft survives all three. It also means steps 1–3 and 5 work as plain
-- form posts with NO JavaScript at all, so the flow degrades to something usable
-- on any browser. Only the image needs a script, and only at step 4.
--
-- ## Why it is not a `payments` row with status='draft'
--
-- The schema already has that state, and it would have been the obvious choice.
-- But `payments` requires `unit_id`, `category_id`, `storage_key` and an amount
-- NOT NULL — none of which exist at step 1. Relaxing those columns to allow a
-- half-built payment would weaken the constraints that protect real money, to
-- serve a form. A separate table costs one migration and keeps `payments` strict.
-- =============================================================================

PRAGMA foreign_keys = ON;

CREATE TABLE payment_drafts (
  -- One live draft per session, not per person: a resident filling in a payment
  -- on their phone must not have it overwritten by the same person on a tablet.
  session_id      TEXT    NOT NULL PRIMARY KEY REFERENCES sessions(id),
  profile_id      TEXT    NOT NULL REFERENCES profiles(id),
  unit_id         TEXT    REFERENCES units(id),
  amount_piastres INTEGER CHECK (amount_piastres IS NULL OR amount_piastres > 0),
  category_id     TEXT    REFERENCES categories(id),
  method          TEXT    CHECK (method IS NULL OR method IN
                          ('instapay','bank_transfer','vodafone_cash','cash','other')),
  transfer_date   TEXT    CHECK (transfer_date IS NULL OR
                          transfer_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  reference_no    TEXT,
  note_ar         TEXT,
  -- how far the resident got, so returning to /pay resumes rather than restarts
  step            INTEGER NOT NULL DEFAULT 1 CHECK (step BETWEEN 1 AND 5),
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

-- NOTE: the image is deliberately NOT here. It is the one large field, it is
-- entered at step 4 and submitted at step 5, and round-tripping ~6 KB of base64
-- through the database on every step change would be waste. It waits in
-- sessionStorage for those few seconds; if that is lost, ONE field is re-entered
-- rather than all six.

CREATE INDEX idx_drafts_profile ON payment_drafts(profile_id);
