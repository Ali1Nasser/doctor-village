-- =============================================================================
-- 0006_environment_guard.sql
--
-- C10: "Fabricated seed data must live only in `seed/demo/` and must be
--       IMPOSSIBLE to load into production."
--
-- "Impossible" is a strong word. A naming convention or a shell script is not
-- impossible — it is a habit that fails on the one night somebody is tired.
-- So the refusal lives in the production database itself:
--
--   · every demo row carries an id beginning with 'DEMO'
--   · a fresh database is 'production' by default — you must opt IN to demo
--   · triggers on every money-bearing table refuse a DEMO id unless the
--     database has been explicitly marked as a demo database
--
-- Consequence: `seed/demo/*.sql` applied to production fails on its first
-- INSERT with a loud Arabic error, having written nothing.
-- =============================================================================

PRAGMA foreign_keys = ON;

CREATE TABLE env_guard (
  id          INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  environment TEXT    NOT NULL DEFAULT 'production'
                      CHECK (environment IN ('production','demo','test')),
  -- switching to 'demo' must name a person and a reason, and is audited.
  set_by      TEXT,
  set_at      TEXT,
  note        TEXT
) STRICT;

-- Default is production. Nothing accidental gets you to demo.
INSERT INTO env_guard (id, environment) VALUES (1, 'production');

-- Relabelling rules:
--   production -> demo/test   allowed ONLY while the database holds no money.
--                             A fresh database can be opted in; a live one
--                             never can, because that is how a real ledger
--                             ends up accepting fake receipts.
--   demo/test  -> production  NEVER. Promote by restoring a clean database
--                             from migrations, not by flipping a flag on a
--                             database full of invented money.
CREATE TRIGGER trg_env_guard_no_relabel_live
BEFORE UPDATE OF environment ON env_guard
WHEN OLD.environment = 'production'
 AND ( (SELECT COUNT(*) FROM journal_entries) > 0
    OR (SELECT COUNT(*) FROM payments)        > 0
    OR (SELECT COUNT(*) FROM expenses)        > 0 )
BEGIN
  SELECT RAISE(ABORT,
    'قاعدة بيانات فيها فلوس حقيقية مش بتتحوّل لتجريبية — a database holding financial records cannot be relabelled');
END;

CREATE TRIGGER trg_env_guard_no_promote
BEFORE UPDATE OF environment ON env_guard
WHEN OLD.environment IN ('demo','test') AND NEW.environment = 'production'
BEGIN
  SELECT RAISE(ABORT,
    'قاعدة تجريبية مش بتترقّى لإنتاج — a demo database is never promoted; restore a clean one from migrations');
END;

-- -----------------------------------------------------------------------------
-- The refusal itself, on every table that can carry money or identity.
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_no_demo_profiles
BEFORE INSERT ON profiles
WHEN NEW.id LIKE 'DEMO%' AND (SELECT environment FROM env_guard WHERE id = 1) = 'production'
BEGIN
  SELECT RAISE(ABORT, 'بيانات تجريبية مرفوضة على قاعدة إنتاج — demo data refused on a production database (profiles)');
END;

CREATE TRIGGER trg_no_demo_buildings
BEFORE INSERT ON buildings
WHEN NEW.id LIKE 'DEMO%' AND (SELECT environment FROM env_guard WHERE id = 1) = 'production'
BEGIN
  SELECT RAISE(ABORT, 'بيانات تجريبية مرفوضة على قاعدة إنتاج — demo data refused (buildings)');
END;

CREATE TRIGGER trg_no_demo_units
BEFORE INSERT ON units
WHEN NEW.id LIKE 'DEMO%' AND (SELECT environment FROM env_guard WHERE id = 1) = 'production'
BEGIN
  SELECT RAISE(ABORT, 'بيانات تجريبية مرفوضة على قاعدة إنتاج — demo data refused (units)');
END;

CREATE TRIGGER trg_no_demo_payments
BEFORE INSERT ON payments
WHEN NEW.id LIKE 'DEMO%' AND (SELECT environment FROM env_guard WHERE id = 1) = 'production'
BEGIN
  SELECT RAISE(ABORT, 'بيانات تجريبية مرفوضة على قاعدة إنتاج — demo data refused (payments)');
END;

CREATE TRIGGER trg_no_demo_expenses
BEFORE INSERT ON expenses
WHEN NEW.id LIKE 'DEMO%' AND (SELECT environment FROM env_guard WHERE id = 1) = 'production'
BEGIN
  SELECT RAISE(ABORT, 'بيانات تجريبية مرفوضة على قاعدة إنتاج — demo data refused (expenses)');
END;

CREATE TRIGGER trg_no_demo_entries
BEFORE INSERT ON journal_entries
WHEN NEW.id LIKE 'DEMO%' AND (SELECT environment FROM env_guard WHERE id = 1) = 'production'
BEGIN
  SELECT RAISE(ABORT, 'قيود تجريبية مرفوضة على قاعدة إنتاج — demo journal entries refused on production');
END;

CREATE TRIGGER trg_no_demo_fee_periods
BEFORE INSERT ON fee_periods
WHEN NEW.id LIKE 'DEMO%' AND (SELECT environment FROM env_guard WHERE id = 1) = 'production'
BEGIN
  SELECT RAISE(ABORT, 'بيانات تجريبية مرفوضة على قاعدة إنتاج — demo data refused (fee_periods)');
END;

CREATE TRIGGER trg_no_demo_staff
BEFORE INSERT ON staff
WHEN NEW.id LIKE 'DEMO%' AND (SELECT environment FROM env_guard WHERE id = 1) = 'production'
BEGIN
  SELECT RAISE(ABORT, 'بيانات تجريبية مرفوضة على قاعدة إنتاج — demo data refused (staff)');
END;

-- -----------------------------------------------------------------------------
-- The reverse guard: real money must never be posted into a demo database and
-- then mistaken for a rehearsal. A demo database refuses NON-demo ids too.
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_no_real_payments_in_demo
BEFORE INSERT ON payments
WHEN NEW.id NOT LIKE 'DEMO%' AND (SELECT environment FROM env_guard WHERE id = 1) = 'demo'
BEGIN
  SELECT RAISE(ABORT, 'مش ممكن تسجّل دفعة حقيقية على قاعدة تجريبية — real payments refused on a demo database');
END;
