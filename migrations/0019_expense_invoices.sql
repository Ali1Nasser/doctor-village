-- =============================================================================
-- 0019_expense_invoices.sql — evidence for money going out.
--
-- `01_PRD` C1 asks for an optional invoice photo on an expense, and C2 says
-- expenses are "visible to all members". Until now the column existed and
-- nothing wrote it, so a 12,000 ج.م maintenance line had **no evidence
-- attached** — which is the first thing a resident asks about, and the exact
-- suspicion this whole product exists to answer.
--
-- ## ⚠️ The tension this migration is deliberately not hiding
-- A supplier's invoice usually carries the supplier's **phone number and bank
-- details**. Showing it to 204 residents publishes the personal data of a third
-- party who never consented — a live concern under PDPL 151/2020, and one the
-- transparency requirement does not dissolve.
--
-- Resolution, in order of preference:
--   1. The **upload screen tells the operator** the photo will be seen by every
--      resident, and to cover a phone number before photographing. The cheapest
--      and most effective control is the person holding the camera.
--   2. `expense_invoices_public` lets the board restrict invoices to admins if a
--      supplier objects or the board decides otherwise. Default **1** —
--      transparency is the point, and a default that hides evidence would
--      quietly undo the feature.
--   3. It is a **setting**, not a constant, so the board can change its mind
--      without a deploy. See ADR-026.
-- =============================================================================

ALTER TABLE settings ADD COLUMN expense_invoices_public INTEGER NOT NULL DEFAULT 1
  CHECK (expense_invoices_public IN (0,1));

-- -----------------------------------------------------------------------------
-- An invoice key must belong to its expense.
--
-- The path is `invoices/<expense id>/<something>`, and `authorizeInvoiceRead`
-- resolves an incoming key back to an expense by looking it up in this column —
-- never by parsing the path. This CHECK exists so a key that does not match its
-- row cannot be written in the first place, which is what makes the lookup
-- trustworthy rather than merely conventional.
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_expense_invoice_key_shape
BEFORE UPDATE OF invoice_storage_key ON expenses
WHEN NEW.invoice_storage_key IS NOT NULL
 AND NEW.invoice_storage_key NOT LIKE 'invoices/' || NEW.id || '/%'
BEGIN
  SELECT RAISE(ABORT, 'مسار صورة الفاتورة لازم يكون تحت المصروف بتاعها');
END;

-- -----------------------------------------------------------------------------
-- v_expenses_without_evidence — what the board still owes an explanation for.
--
-- Not every expense needs a photo (a bank standing order has none), so this is
-- a prompt, not a rule. But "how much of what we spent has no evidence?" is a
-- question a suspicious resident will ask at the general assembly, and the board
-- should know the answer before they are asked it.
-- -----------------------------------------------------------------------------
CREATE VIEW v_expenses_without_evidence AS
SELECT COUNT(*) AS n, COALESCE(SUM(amount_piastres), 0) AS total_piastres
FROM expenses
WHERE status = 'posted' AND is_reversal = 0 AND invoice_storage_key IS NULL;
