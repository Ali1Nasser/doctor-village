-- ============================================================================
-- 0025_profile_self_service.sql — what an account holder may change about
-- themselves, and the wall between that and what created the account.
--
-- The board asked for two things: the developer and the board can create and
-- edit accounts, and every account holder can edit some of their own details —
-- **but not the ones the account was created from**.
--
-- That split is the whole design, so it is worth naming both halves explicitly.
--
-- CREATED FROM (board only, and each already has its own audited mutation):
--   · full_name        — it comes from the owner register; the register is the
--                        authority on who owns a flat, not the person holding
--                        the phone. A resident renaming themselves would make
--                        the board's members list disagree with the register.
--   · the login phone  — `phone_identifiers`. It IS the credential. Changing it
--                        is `phone.change`, revokes every session, and is the
--                        single most attractive target in the product.
--   · role             — `user.assign_role`.
--   · unit ownership   — `unit_owners`, effective-dated. It decides what money
--                        is owed and by whom.
--   · is_active        — `user.deactivate`.
--
-- OWN, and added here:
--   · contact_phone_e164 — a SECOND number, for the board to reach them on.
--   · preferred_channel  — already existed on `profiles` since 0001 and nothing
--                          in the product has ever set it. It is exactly this
--                          kind of field, and it was sitting there unused.
--   · contact_note_ar    — one line to the board: «الشقة مؤجرة»، «مسافر برّه،
--                          كلّموا ابني».
--
-- None of the three can affect money, identity or permission. That is the test
-- for whether a field belongs on this side of the wall.
-- ============================================================================

-- A contact number, NOT a credential.
--
-- It is structurally incapable of being one: `resolveAuthContext` and
-- `findProfileByPhone` read `phone_identifiers` and nothing else, so a column on
-- `profiles` cannot open a session no matter what is written into it.
--
-- Same shape rule as `phone_identifiers.phone_e164`, negative-matched for the
-- same reason — real D1 refuses a GLOB with thirteen character classes
-- ("LIKE or GLOB pattern too complex", measured 2026-08-07 / R-031), and
-- `NOT ... GLOB '*[^0-9]*'` uses one class to say the same thing.
ALTER TABLE profiles ADD COLUMN contact_phone_e164 TEXT
  CHECK (contact_phone_e164 IS NULL
     OR (length(contact_phone_e164) = 13
     AND substr(contact_phone_e164, 1, 3) = '+20'
     AND NOT substr(contact_phone_e164, 4) GLOB '*[^0-9]*'));

-- One line, capped. A free-text field with no ceiling is a field somebody
-- pastes a contract into, and this one is rendered on the board's screens.
ALTER TABLE profiles ADD COLUMN contact_note_ar TEXT
  CHECK (contact_note_ar IS NULL OR length(contact_note_ar) <= 200);

-- --------------------------------------------------------------------------
-- A contact number may not be somebody ELSE's login number.
--
-- Without this, any resident could type the chairman's number into their own
-- contact field. Nothing would be breached — it cannot log anyone in — but the
-- board's «كلّم صاحب الوحدة» would dial the wrong person, and a members list
-- where two rows show the same number is one nobody trusts again.
--
-- Their OWN login number is allowed: writing it there is redundant, not wrong.
--
-- Two triggers because SQLite fires them per-statement-kind, and an UPDATE that
-- sets the column is exactly as able to collide as an INSERT.
-- --------------------------------------------------------------------------
CREATE TRIGGER trg_contact_phone_not_anothers_login_ins
BEFORE INSERT ON profiles
WHEN NEW.contact_phone_e164 IS NOT NULL
 AND EXISTS (SELECT 1 FROM phone_identifiers pi
              WHERE pi.phone_e164 = NEW.contact_phone_e164
                AND pi.status = 'active'
                AND pi.profile_id <> NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'الرقم ده مسجّل لحد تاني في القرية — اكتب رقم تواصل بتاعك إنت');
END;

CREATE TRIGGER trg_contact_phone_not_anothers_login_upd
BEFORE UPDATE OF contact_phone_e164 ON profiles
WHEN NEW.contact_phone_e164 IS NOT NULL
 AND EXISTS (SELECT 1 FROM phone_identifiers pi
              WHERE pi.phone_e164 = NEW.contact_phone_e164
                AND pi.status = 'active'
                AND pi.profile_id <> NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'الرقم ده مسجّل لحد تاني في القرية — اكتب رقم تواصل بتاعك إنت');
END;

-- --------------------------------------------------------------------------
-- …and the same in the other direction: a LOGIN number may not be taken over
-- while it is somebody else's contact number, because the board would then have
-- a contact row pointing at a person it no longer reaches.
--
-- This one clears rather than refuses. Refusing would let any resident block a
-- legitimate phone change for the whole village simply by typing the number
-- into their contact field — a denial-of-service through a text box. The
-- registration wins; the stale contact entry is dropped, and the audit row for
-- the phone change is the record of why.
-- --------------------------------------------------------------------------
CREATE TRIGGER trg_login_phone_clears_stale_contacts
AFTER INSERT ON phone_identifiers
WHEN NEW.status = 'active'
BEGIN
  UPDATE profiles SET contact_phone_e164 = NULL
   WHERE contact_phone_e164 = NEW.phone_e164
     AND id <> NEW.profile_id;
END;
