/**
 * lib/db/mutations.ts — every write that is not a payment, and the mechanism
 * that makes an unaudited write hard to commit by accident.
 *
 * ## Why this file exists
 *
 * The CP-1 self-critique named the real remaining weakness: the access controls
 * held, but `writeAudit()` was called by hand on two paths and forgotten on the
 * rest. **A path that is authorized but unlogged is an attacker's best move** —
 * and it is the board's blind spot too, because the audit page looks complete.
 *
 * Calling `writeAudit()` "everywhere" is a discipline, and this project has
 * already decided (ADR-010) that discipline needs a mechanism. So:
 *
 *   `mutate()` runs the write and its audit row in ONE `db.batch()`.
 *
 * They commit together or not at all. You cannot end up with a changed row and
 * no record of who changed it, and writing an unaudited mutation now means
 * deliberately not using the only helper that exists.
 */

import type { AuthContext, Id, Role } from '../../types/domain.js';
import { require_, Forbidden, assertMakerChecker } from '../rbac.js';
import type { Db, PreparedStatement } from './driver.js';
import { LedgerRefused } from './driver.js';
import { newId, NotFound, mutate, type Clock } from './index.js';

/* ===================================================================== */
/* Phone number change — R-003, the most abuse-prone path in the system  */
/* ===================================================================== */

export interface PhoneChange {
  targetProfileId: Id;
  newPhoneE164: string;
  reasonAr: string;
  /** Required when the target holds a staff role. 03_RBAC §6 step 4. */
  secondAdminId?: Id;
}

export interface PhoneChangeResult {
  /** The old number, so the caller can notify it. Returned rather than sent
   *  here, because `lib/db/` never talks to a delivery channel. */
  previousPhoneE164: string | null;
  sessionsRevoked: number;
}

/**
 * Changing a phone number IS account recovery, and must be treated as such
 * (03_RBAC §6). A malicious or merely careless change hands over an account.
 *
 * Five things happen, atomically:
 *   1. the old identifier is closed with a mandatory written reason (history
 *      is preserved forever — nothing is deleted);
 *   2. the new identifier is created;
 *   3. **every session of that person is revoked** — otherwise the previous
 *      holder keeps a live session for up to a year after losing the number;
 *   4. an audit row is written;
 *   5. the old number is returned so the caller can notify it.
 *
 * Passkeys make this structurally safer than it used to be: the account is
 * opened by a passkey, not by a number, so a phone change alone no longer takes
 * over the account. To fully take over, an attacker needs a phone change AND a
 * passkey re-enrollment — two audited events requiring two different admins.
 */
export async function changePhoneNumber(
  ctx: AuthContext, db: Db, c: PhoneChange, now: Clock,
): Promise<PhoneChangeResult> {
  require_(ctx.role, 'phone.change');
  if (!c.reasonAr?.trim()) throw new LedgerRefused('تغيير الرقم لازم معاه سبب مكتوب');

  const target = await db.prepare(`SELECT id, role, full_name FROM profiles WHERE id = ?`)
    .bind(c.targetProfileId).first<{ id: string; role: Role; full_name: string }>();
  if (!target) throw new NotFound();

  // Two-admin rule for privileged accounts (03_RBAC §6 step 4).
  const isStaffAccount = target.role !== 'resident';
  if (isStaffAccount) {
    if (!c.secondAdminId) {
      throw new Forbidden('phone.change',
        'تغيير رقم حساب إداري محتاج موافقة أدمن تاني');
    }
    assertMakerChecker(ctx.personId, c.secondAdminId, 'phone.change');
    const second = await db.prepare(
      `SELECT id FROM profiles WHERE id = ? AND is_active = 1 AND role IN ('admin','developer')`
    ).bind(c.secondAdminId).first();
    if (!second) throw new Forbidden('phone.change', 'الأدمن التاني مش موجود أو مش نشط');
  }

  const current = await db.prepare(
    `SELECT id, phone_e164 FROM phone_identifiers
      WHERE profile_id = ? AND status = 'active' AND is_primary = 1`
  ).bind(c.targetProfileId).first<{ id: string; phone_e164: string }>();

  const newRowId = newId('PHN');
  const writes: PreparedStatement[] = [];

  // Statement ORDER matters, in three separate ways, and getting it wrong fails
  // loudly rather than silently — which is the schema doing its job:
  //   · `replaced_by_id` is a FK to the NEW row, so the new row must exist first;
  //   · `idx_phone_primary` allows one active primary per person, so the old row
  //     must stop being primary before the new one starts;
  //   · `idx_phone_active` allows one active holder per NUMBER, which is what
  //     refuses a number already live on somebody else.
  // Hence: close the old row, insert the new one, then link them.
  if (current) {
    writes.push(db.prepare(
      `UPDATE phone_identifiers
          SET status='replaced', is_primary=0, changed_by=?, change_reason_ar=?, valid_to=?
        WHERE id=? AND status='active'`
    ).bind(ctx.personId, c.reasonAr, now(), current.id));
  }
  writes.push(db.prepare(
    `INSERT INTO phone_identifiers (id, profile_id, phone_e164, is_primary, status,
       changed_by, change_reason_ar) VALUES (?,?,?,1,'active',?,?)`
  ).bind(newRowId, c.targetProfileId, c.newPhoneE164, ctx.personId, c.reasonAr));
  if (current) {
    // the chain of custody, written once both ends exist
    writes.push(db.prepare(`UPDATE phone_identifiers SET replaced_by_id=? WHERE id=?`)
      .bind(newRowId, current.id));
  }

  // Revoke every session. Without this the previous number's holder keeps a
  // live 1-year session and the change achieves nothing.
  writes.push(db.prepare(
    `UPDATE sessions SET revoked_at=?, revoked_by=? WHERE profile_id=? AND revoked_at IS NULL`
  ).bind(now(), ctx.personId, c.targetProfileId));

  await mutate(db, ctx, {
    action: 'phone.change', table: 'phone_identifiers', entityId: c.targetProfileId,
    before: { phone: current?.phone_e164 ?? null },
    after: { phone: c.newPhoneE164, reason: c.reasonAr, secondAdmin: c.secondAdminId ?? null },
  }, ...writes);

  const revoked = await db.prepare(
    `SELECT COUNT(*) n FROM sessions WHERE profile_id=? AND revoked_at IS NOT NULL`
  ).bind(c.targetProfileId).first<{ n: number }>();

  return { previousPhoneE164: current?.phone_e164 ?? null, sessionsRevoked: revoked?.n ?? 0 };
}

/* ===================================================================== */
/* Expenses                                                              */
/* ===================================================================== */

export interface NewExpense {
  id: Id; voucherNo: string; categoryId: Id; amountPiastres: number;
  spentOn: string; descriptionAr: string; vendorName: string | null;
  invoiceStorageKey: string | null; fundId: Id | null;
}

export async function recordExpense(ctx: AuthContext, db: Db, e: NewExpense): Promise<void> {
  require_(ctx.role, 'expense.record');
  await mutate(db, ctx,
    { action: 'expense.record', table: 'expenses', entityId: e.id,
      after: { amount: e.amountPiastres, category: e.categoryId, vendor: e.vendorName } },
    db.prepare(
      `INSERT INTO expenses (id, voucher_no, category_id, amount_piastres, spent_on,
         description_ar, vendor_name, invoice_storage_key, fund_id, status, recorded_by)
       VALUES (?,?,?,?,?,?,?,?,?, 'recorded', ?)`
    ).bind(e.id, e.voucherNo, e.categoryId, e.amountPiastres, e.spentOn, e.descriptionAr,
           e.vendorName, e.invoiceStorageKey, e.fundId, ctx.personId),
  );
}

/** Above the board's threshold an expense needs a SECOND, different admin (06 §6). */
export async function countersignExpense(
  ctx: AuthContext, db: Db, expenseId: Id, now: Clock,
): Promise<void> {
  require_(ctx.role, 'expense.countersign');
  const e = await db.prepare(
    `SELECT id, recorded_by, amount_piastres, status FROM expenses WHERE id = ?`
  ).bind(expenseId).first<{ id: string; recorded_by: string; amount_piastres: number; status: string }>();
  if (!e) throw new NotFound();
  assertMakerChecker(ctx.personId, e.recorded_by as Id, 'expense.countersign');

  const changed = await mutate(db, ctx,
    { action: 'expense.countersign', table: 'expenses', entityId: expenseId,
      before: { status: e.status }, after: { status: 'countersigned', by: ctx.personId } },
    db.prepare(
      `UPDATE expenses SET status='countersigned', approved_by=?, approved_at=?
        WHERE id=? AND status='recorded' AND recorded_by <> ?`
    ).bind(ctx.personId, now(), expenseId, ctx.personId),
  );
  if (changed !== 1) throw new LedgerRefused('المصروف ده مش في حالة تسمح بالتوقيع');
}

/* ===================================================================== */
/* Categories                                                            */
/* ===================================================================== */

/**
 * Deactivating a category with existing entries is BLOCKED until reassignment
 * (CP-5 gate). Orphaned transactions are how a category breakdown silently
 * stops adding up to the total.
 */
export async function deactivateCategory(ctx: AuthContext, db: Db, categoryId: Id): Promise<void> {
  require_(ctx.role, 'category.manage');
  const inUse = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM payments WHERE category_id = ?)
          + (SELECT COUNT(*) FROM expenses WHERE category_id = ?) AS n`
  ).bind(categoryId, categoryId).first<{ n: number }>();
  if ((inUse?.n ?? 0) > 0) {
    throw new LedgerRefused(
      `البند ده عليه ${inUse!.n} عملية. لازم تنقلهم لبند تاني الأول قبل ما تقفله.`);
  }
  await mutate(db, ctx,
    { action: 'category.deactivate', table: 'categories', entityId: categoryId },
    db.prepare(`UPDATE categories SET is_active = 0 WHERE id = ?`).bind(categoryId),
  );
}

export async function renameCategory(
  ctx: AuthContext, db: Db, categoryId: Id, nameAr: string,
): Promise<void> {
  require_(ctx.role, 'category.manage');
  const before = await db.prepare(`SELECT name_ar FROM categories WHERE id = ?`)
    .bind(categoryId).first<{ name_ar: string }>();
  if (!before) throw new NotFound();
  await mutate(db, ctx,
    { action: 'category.rename', table: 'categories', entityId: categoryId,
      before: { name: before.name_ar }, after: { name: nameAr } },
    db.prepare(`UPDATE categories SET name_ar = ? WHERE id = ?`).bind(nameAr, categoryId),
  );
}

/* ===================================================================== */
/* Delegates — R-025                                                     */
/* ===================================================================== */

export interface NewDelegate {
  id: Id; ownerProfileId: Id; delegateProfileId: Id; unitId: Id;
  canViewFinancials: boolean; canSubmitPayments: boolean;
  validFrom: string; validTo: string; reasonAr: string | null;
}

export async function grantDelegate(ctx: AuthContext, db: Db, d: NewDelegate): Promise<void> {
  require_(ctx.role, 'user.create');
  await mutate(db, ctx,
    { action: 'delegate.grant', table: 'delegate_authorizations', entityId: d.id,
      after: { owner: d.ownerProfileId, delegate: d.delegateProfileId, unit: d.unitId,
               financials: d.canViewFinancials, until: d.validTo } },
    db.prepare(
      `INSERT INTO delegate_authorizations (id, owner_profile_id, delegate_profile_id, unit_id,
         can_view_financials, can_submit_payments, valid_from, valid_to, granted_by, reason_ar)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(d.id, d.ownerProfileId, d.delegateProfileId, d.unitId,
           d.canViewFinancials ? 1 : 0, d.canSubmitPayments ? 1 : 0,
           d.validFrom, d.validTo, ctx.personId, d.reasonAr),
  );
}

export async function revokeDelegate(
  ctx: AuthContext, db: Db, delegateAuthId: Id, now: Clock,
): Promise<void> {
  require_(ctx.role, 'user.create');
  await mutate(db, ctx,
    { action: 'delegate.revoke', table: 'delegate_authorizations', entityId: delegateAuthId },
    db.prepare(`UPDATE delegate_authorizations SET revoked_at=?, revoked_by=? WHERE id=?`)
      .bind(now(), ctx.personId, delegateAuthId),
  );
}

/* ===================================================================== */
/* Roles, sessions, settings                                             */
/* ===================================================================== */

export async function assignRole(ctx: AuthContext, db: Db, targetId: Id, role: Role): Promise<void> {
  // Only a developer may create another admin (03_RBAC §2 note ¹).
  require_(ctx.role, role === 'admin' || role === 'developer' ? 'user.assign_admin_role' : 'user.assign_role');
  const before = await db.prepare(`SELECT role FROM profiles WHERE id=?`).bind(targetId)
    .first<{ role: Role }>();
  if (!before) throw new NotFound();
  await mutate(db, ctx,
    { action: 'user.assign_role', table: 'profiles', entityId: targetId,
      before: { role: before.role }, after: { role } },
    db.prepare(`UPDATE profiles SET role=? WHERE id=?`).bind(role, targetId),
  );
}

/** "سجّل خروج من كل الأجهزة" — also used by the phone-change path. */
export async function revokeAllSessions(
  ctx: AuthContext, db: Db, targetId: Id, now: Clock,
): Promise<void> {
  if (targetId !== ctx.personId) require_(ctx.role, 'user.deactivate');
  await mutate(db, ctx,
    { action: 'session.revoke_all', table: 'sessions', entityId: targetId },
    db.prepare(`UPDATE sessions SET revoked_at=?, revoked_by=? WHERE profile_id=? AND revoked_at IS NULL`)
      .bind(now(), ctx.personId, targetId),
  );
}

export async function updateSettings(
  ctx: AuthContext, db: Db, patch: Record<string, string | number>, now: Clock,
): Promise<void> {
  require_(ctx.role, 'settings.edit');
  // Column names come from a fixed allow-list, never from the caller — a settings
  // form is otherwise a very direct route to writing an arbitrary column.
  const ALLOWED = new Set([
    'community_name_ar', 'instapay_handle', 'bank_name_ar', 'bank_account_no',
    'vodafone_cash_no', 'countersign_threshold_piastres', 'notify_quiet_from',
    'notify_quiet_to', 'unit_status_public', 'staff_names_public',
  ]);
  const keys = Object.keys(patch).filter(k => ALLOWED.has(k));
  if (keys.length === 0) throw new LedgerRefused('مفيش حاجة اتغيّرت');
  const before = await db.prepare(`SELECT * FROM settings WHERE id=1`).first();
  const sets = keys.map(k => `${k} = ?`).join(', ');
  await mutate(db, ctx,
    { action: 'settings.update', table: 'settings', entityId: '1',
      before, after: patch },
    db.prepare(`UPDATE settings SET ${sets}, updated_by=?, updated_at=? WHERE id=1`)
      .bind(...keys.map(k => patch[k]!), ctx.personId, now()),
  );
}

/** Every mutating export in this file, for the audit-coverage test. Adding a
 *  mutation without adding it here fails that test. */
export const MUTATING_FUNCTIONS = [
  'changePhoneNumber', 'recordExpense', 'countersignExpense', 'deactivateCategory',
  'renameCategory', 'grantDelegate', 'revokeDelegate', 'assignRole',
  'revokeAllSessions', 'updateSettings',
] as const;
