/**
 * lib/db/drafts.ts — the payment wizard's server-side draft.
 *
 * Scoped to the caller's SESSION, not just their person: the ownership predicate
 * here is `session_id = ?` with the session id taken from `AuthContext`, which
 * the caller cannot forge — it was resolved from their cookie. So one resident
 * cannot read or overwrite another's draft, and the same resident on two devices
 * gets two independent drafts.
 */

import type { AuthContext, Id } from '../../types/domain.js';
import type { Db } from './driver.js';
import type { Clock } from './index.js';
import { LedgerRefused } from './driver.js';

export interface Draft {
  session_id: string;
  unit_id: string | null;
  amount_piastres: number | null;
  category_id: string | null;
  method: string | null;
  transfer_date: string | null;
  reference_no: string | null;
  note_ar: string | null;
  step: number;
}

/** Fields a step may set. Anything not on this list cannot be written — a form
 *  post is otherwise a direct route to setting an arbitrary column. */
const WRITABLE = [
  'unit_id', 'amount_piastres', 'category_id', 'method',
  'transfer_date', 'reference_no', 'note_ar',
] as const;
export type DraftField = (typeof WRITABLE)[number];

export async function getDraft(ctx: AuthContext, db: Db): Promise<Draft | null> {
  return db.prepare(
    `SELECT session_id, unit_id, amount_piastres, category_id, method,
            transfer_date, reference_no, note_ar, step
       FROM payment_drafts WHERE session_id = ?`
  ).bind(ctx.sessionId).first<Draft>();
}

/**
 * Upsert one or more fields and record how far the resident got.
 *
 * Deliberately NOT routed through `mutate()`: a half-typed form is not a
 * financial event, and auditing every keystroke of an abandoned draft would bury
 * the entries that matter. The audit trail starts at `payment.submit`, where a
 * claim about money is actually made.
 */
export async function saveDraft(
  ctx: AuthContext, db: Db, patch: Partial<Record<DraftField, string | number | null>>,
  step: number, now: Clock,
): Promise<void> {
  const keys = (Object.keys(patch) as DraftField[]).filter(k => WRITABLE.includes(k));
  if (keys.length === 0 && step < 1) throw new LedgerRefused('مفيش حاجة تتحفظ');

  await db.prepare(
    `INSERT INTO payment_drafts (session_id, profile_id, step, updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(session_id) DO UPDATE SET step = excluded.step, updated_at = excluded.updated_at`
  ).bind(ctx.sessionId, ctx.personId, Math.max(1, Math.min(5, step)), now()).run();

  for (const k of keys) {
    // Column name comes from the WRITABLE allow-list above, never from input.
    await db.prepare(`UPDATE payment_drafts SET ${k} = ? WHERE session_id = ?`)
      .bind(patch[k] ?? null, ctx.sessionId).run();
  }
}

export async function clearDraft(ctx: AuthContext, db: Db): Promise<void> {
  await db.prepare(`DELETE FROM payment_drafts WHERE session_id = ?`).bind(ctx.sessionId).run();
}

/**
 * Is the draft complete enough to submit? Returns the Arabic reason if not, so
 * the review screen can say precisely which step to go back to rather than
 * failing at submit with a generic error.
 */
export function draftGaps(d: Draft | null): { field: DraftField; step: number }[] {
  if (!d) return [{ field: 'amount_piastres', step: 1 }];
  const gaps: { field: DraftField; step: number }[] = [];
  if (!d.amount_piastres) gaps.push({ field: 'amount_piastres', step: 1 });
  if (!d.category_id) gaps.push({ field: 'category_id', step: 2 });
  if (!d.method) gaps.push({ field: 'method', step: 3 });
  if (!d.transfer_date) gaps.push({ field: 'transfer_date', step: 3 });
  return gaps;
}

/** The unit a draft belongs to: the caller's own, or a delegated one they may
 *  submit for. Chosen here rather than trusted from the form. */
export function unitForDraft(ctx: AuthContext): Id | null {
  if (ctx.ownedUnitIds.length > 0) return ctx.ownedUnitIds[0]!;
  const d = ctx.delegatedUnits.find(u => u.canSubmitPayments);
  return d?.unitId ?? null;
}
