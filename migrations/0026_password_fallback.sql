-- ============================================================================
-- 0026_password_fallback.sql — a SECOND way in, for phones that cannot hold a
-- passkey.
--
-- ## This contradicts a written rule, deliberately and on the record
--
-- `AGENTS.md` lists "Email or password auth" under **Never**, and that rule was
-- right for the reason it was written: a village of 214 flats where passwords
-- are the primary credential is a village where the board spends its evenings
-- resetting them.
--
-- What changed is a fact discovered in the field, not a preference. Passkeys
-- need a *platform authenticator* — Samsung Pass, Google Password Manager, a
-- screen lock — and phones in this village do not all have one. On those
-- phones the portal was not "harder to use", it was unusable. A rule that
-- excludes residents from their own portal has to bend, and the owner decided
-- it should.
--
-- So: passwords exist, and everything here is arranged to keep them SECOND.
--
--   · There is no password until an admin issues one. A new account has none,
--     exactly as it has no passkey.
--   · The board never chooses it. `issueTemporaryPassword` generates it, shows
--     it once, and stores only a hash — the same shape as an activation link,
--     for the same reason: a product that can show you a password again is a
--     product that is storing one.
--   · It is rate limited harder than passkey login, because it is the weakest
--     factor and the only one guessable from another country.
--   · Issuing, changing and clearing are all audited.
--
-- ## Why PBKDF2 and these numbers
--
-- A Cloudflare Worker has WebCrypto and no argon2/bcrypt without pulling a
-- dependency into a project whose whole storage story is "no vendor, no card".
-- PBKDF2-SHA256 is what WebCrypto gives, so PBKDF2 is what this uses, at
-- 210,000 iterations (OWASP's 2023 floor for PBKDF2-HMAC-SHA256).
--
-- `iterations` is a COLUMN, not a constant, so the number can be raised later
-- without invalidating every stored hash: each row carries the cost it was
-- written with, and a verify uses that row's value.
-- ============================================================================

CREATE TABLE passwords (
  profile_id  TEXT    NOT NULL PRIMARY KEY REFERENCES profiles(id),
  -- Base64. Salt is per-user and random; a shared salt makes one rainbow table
  -- work for the whole village.
  salt        TEXT    NOT NULL,
  hash        TEXT    NOT NULL,
  iterations  INTEGER NOT NULL CHECK (iterations >= 100000),
  -- 1 while the password is still the one the board generated. Cleared the
  -- moment the owner sets their own, so «لسه بكلمة السر المؤقتة» is answerable
  -- without the board asking anybody.
  is_temporary INTEGER NOT NULL DEFAULT 1 CHECK (is_temporary IN (0,1)),
  set_by      TEXT    REFERENCES profiles(id),
  set_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_used_at TEXT
) STRICT;

-- A password is a credential and belongs in the same conversation as passkeys
-- and sessions, so `/me` can show one list of "ways into this account".
CREATE INDEX idx_passwords_temp ON passwords(is_temporary) WHERE is_temporary = 1;

-- --------------------------------------------------------------------------
-- A stopped account keeps no way in.
--
-- `setPersonActive(false)` already revokes sessions and passkeys. Without this
-- the password would survive it — and "we stopped his account" would be false
-- in exactly the case somebody says it out loud.
-- --------------------------------------------------------------------------
CREATE TRIGGER trg_password_dies_with_account
AFTER UPDATE OF is_active ON profiles
WHEN NEW.is_active = 0 AND OLD.is_active = 1
BEGIN
  DELETE FROM passwords WHERE profile_id = NEW.id;
END;

-- --------------------------------------------------------------------------
-- …and so does a recovered account.
--
-- `fulfilRecovery` exists because somebody lost their phone: it revokes every
-- session and every passkey precisely so the person holding that phone is out.
-- A password left behind would hand them the account back, which is the whole
-- procedure defeated by an omission.
-- --------------------------------------------------------------------------
CREATE TRIGGER trg_password_dies_on_recovery
AFTER UPDATE OF fulfilled_at ON recovery_requests
WHEN NEW.fulfilled_at IS NOT NULL AND OLD.fulfilled_at IS NULL
BEGIN
  DELETE FROM passwords WHERE profile_id = NEW.target_profile_id;
END;

-- --------------------------------------------------------------------------
-- The rate limiter has to be able to COUNT password guesses.
--
-- `auth_attempts.scope` is a closed set — `CHECK (scope IN (...))` — and it was
-- written before a password existed. Inserting `'password'` into it does not
-- silently do the wrong thing: the CHECK refuses the row, the whole login
-- request fails, and the limiter counts nothing. (That is how this was found:
-- every password login returned the refusal, not a 401.)
--
-- SQLite cannot drop a CHECK, so the table is rebuilt — the documented
-- 12-step procedure, minus the steps that only matter with foreign keys
-- pointing IN, which nothing does here. The rows are carried across: an
-- attacker mid-burst does not get their counter reset by a deployment.
-- --------------------------------------------------------------------------
CREATE TABLE auth_attempts_new (
  id         TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 26),
  scope      TEXT    NOT NULL CHECK (scope IN
               ('login_begin','login_finish','activate','recover','password')),
  key        TEXT    NOT NULL,
  ok         INTEGER NOT NULL CHECK (ok IN (0,1)),
  created_at TEXT    NOT NULL
) STRICT;

INSERT INTO auth_attempts_new (id, scope, key, ok, created_at)
  SELECT id, scope, key, ok, created_at FROM auth_attempts;

DROP TABLE auth_attempts;
ALTER TABLE auth_attempts_new RENAME TO auth_attempts;
CREATE INDEX idx_attempts_lookup ON auth_attempts(scope, key, created_at);
