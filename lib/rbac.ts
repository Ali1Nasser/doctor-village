/**
 * lib/rbac.ts — the permission matrix from 03_RBAC_AND_AUTH.md §2, as DATA.
 *
 * "The matrix is expressed once, in lib/rbac.ts, as data — and mirrored by the
 *  guards in lib/db/. A test asserts the two agree. Never scatter
 *  `if (role === 'admin')` checks through components."   — 03_RBAC §2
 *
 * Two rules that are easy to get wrong and are enforced here:
 *
 *  · **Hierarchy is not inheritance.** `developer` sitting above `admin` in the
 *    list does not silently grant it every financial power. Each capability is
 *    listed per role explicitly. Being technically able to do something is not
 *    authorization to do it. (C8)
 *
 *  · **Maker–checker overrides the matrix.** `can()` answering true never means
 *    "and therefore this specific item." A capability check says the actor may
 *    perform this KIND of action; `assertMakerChecker()` says whether they may
 *    perform it on THIS item. Both must pass. (06 §6)
 */

import type { Role, Id } from '../types/domain.js';

export const CAPABILITIES = [
  // auth & users
  'user.create', 'user.import', 'user.assign_role', 'user.assign_admin_role',
  'user.deactivate', 'phone.read_any', 'phone.change', 'profile.edit_own',
  // payments
  'payment.submit_own', 'payment.read_own', 'payment.read_any',
  'receipt_image.read_any', 'payment.review', 'payment.correct_amount', 'payment.reverse',
  // expenses
  'expense.record', 'expense.countersign', 'expense.reverse',
  // transparency (read)
  'finance.read_totals', 'finance.read_categories', 'finance.read_unit_status',
  'staff.read_salaries', 'staff.read_names',
  // config & content
  'category.manage', 'fee.manage', 'post.publish', 'minutes.publish',
  'album.create', 'settings.edit',
  // oversight
  'audit.read', 'audit.modify', 'export.all', 'export.own', 'schema.migrate',
  'period.close', 'period.reopen',
  // cost control — reading the free-tier dashboard. Read-only by construction:
  // there is no matching write capability, because nothing on that page is
  // editable. It is oversight, so `finance_reviewer` holds it too (C11).
  'system.read_quota',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Every cell of 03_RBAC §2, written out. `finance_reviewer` is the fifth role
 * the owner approved in Q21: read-and-review authority, no edit rights — it is
 * what makes maker–checker workable on a small board (R-024).
 */
const MATRIX: Record<Role, readonly Capability[]> = {
  developer: [
    // NOTE: deliberately NOT every capability. `developer` holds infrastructure
    // and break-glass powers. It does hold financial capabilities so a
    // one-person board is not locked out — but maker–checker still applies to
    // it identically, and every action is audit-logged and visible to admins.
    'user.create', 'user.import', 'user.assign_role', 'user.assign_admin_role',
    'user.deactivate', 'phone.read_any', 'phone.change', 'profile.edit_own',
    'payment.submit_own', 'payment.read_own', 'payment.read_any',
    'receipt_image.read_any', 'payment.review', 'payment.correct_amount', 'payment.reverse',
    'expense.record', 'expense.countersign', 'expense.reverse',
    'finance.read_totals', 'finance.read_categories', 'finance.read_unit_status',
    'staff.read_salaries', 'staff.read_names',
    'category.manage', 'fee.manage', 'post.publish', 'minutes.publish',
    'album.create', 'settings.edit',
    'audit.read', 'export.all', 'export.own', 'schema.migrate',
    'period.close', 'period.reopen', 'system.read_quota',
    // 'audit.modify' is absent for EVERY role, including this one.
  ],
  admin: [
    'user.create', 'user.import', 'user.assign_role', 'user.deactivate',
    'phone.read_any', 'phone.change', 'profile.edit_own',
    'payment.submit_own', 'payment.read_own', 'payment.read_any',
    'receipt_image.read_any', 'payment.review', 'payment.correct_amount', 'payment.reverse',
    'expense.record', 'expense.countersign', 'expense.reverse',
    'finance.read_totals', 'finance.read_categories', 'finance.read_unit_status',
    'staff.read_salaries', 'staff.read_names',
    'category.manage', 'fee.manage', 'post.publish', 'minutes.publish',
    'album.create', 'settings.edit',
    'audit.read', 'export.all', 'export.own',
    'period.close', 'period.reopen', 'system.read_quota',
    // NOT 'user.assign_admin_role' — only a developer creates another admin (¹)
    // NOT 'schema.migrate'
  ],
  operator: [
    'profile.edit_own',
    'payment.submit_own', 'payment.read_own',
    'expense.record',
    'finance.read_totals', 'finance.read_categories', 'finance.read_unit_status',
    'staff.read_salaries', 'staff.read_names',
    'post.publish', 'album.create',
    'export.own',
    // NOT 'phone.read_any'      — an operator can never see a phone number
    // NOT 'payment.review'      — an operator can never approve money
    // NOT 'receipt_image.read_any'
    // NOT 'minutes.publish'     — uploading is allowed, publishing needs an admin
  ],
  finance_reviewer: [
    'profile.edit_own',
    'payment.submit_own', 'payment.read_own', 'payment.read_any',
    'receipt_image.read_any',
    'finance.read_totals', 'finance.read_categories', 'finance.read_unit_status',
    'staff.read_salaries', 'staff.read_names',
    'audit.read', 'export.all', 'export.own', 'system.read_quota',
    // Reads and reviews everything financial; changes nothing. NOT
    // 'payment.review' — reviewing here means auditing, not approving.
  ],
  resident: [
    'profile.edit_own',
    'payment.submit_own', 'payment.read_own',
    'finance.read_totals', 'finance.read_categories', 'finance.read_unit_status',
    'staff.read_salaries',
    'export.own',
    // NOT 'staff.read_names' — Q4 default; flips with settings.staff_names_public
    // NOT 'phone.read_any'  — a resident sees only their own number
  ],
};

/** The single source of permission truth. Nothing else may test a role name. */
export function can(role: Role, capability: Capability): boolean {
  return MATRIX[role].includes(capability);
}

/** `audit.modify` is held by nobody. Asserted, so a future edit to the matrix
 *  that grants it fails a test rather than shipping. (access test 8) */
export function auditLogIsImmutableForEveryone(): boolean {
  return (Object.keys(MATRIX) as Role[]).every(r => !can(r, 'audit.modify'));
}

export class Forbidden extends Error {
  readonly status = 403;
  constructor(readonly capability: string, readonly reasonAr = 'مش من صلاحياتك') {
    // The Arabic reason goes in `message` as well as on the property. The HTTP
    // layer reads `reasonAr`, but everything else in the world reads `.message`
    // — logs, Sentry, a stack trace, `assert.rejects`. Keeping the user-facing
    // reason off `.message` means every one of those shows "forbidden:
    // phone.change" and the person debugging never sees what the admin was
    // actually told. Carry it in both.
    super(`forbidden: ${capability} — ${reasonAr}`);
  }
}

export function require_(role: Role, capability: Capability): void {
  if (!can(role, capability)) throw new Forbidden(capability);
}

/**
 * Maker–checker (06 §6). Separate from `can()` on purpose: holding the
 * capability to approve says nothing about whether you may approve THIS item.
 * Nobody gives final approval to their own financial item — including
 * `developer`. C8 is explicit that this "overrides the matrix".
 */
export function assertMakerChecker(actorId: Id, creatorId: Id | null, what: string): void {
  if (creatorId !== null && actorId === creatorId) {
    throw new Forbidden(what, 'محدش بيعتمد حاجة هو اللي عملها');
  }
}

/** Above the board's threshold an expense needs a SECOND, different admin. */
export function needsCountersign(amountPiastres: number, thresholdPiastres: number): boolean {
  return amountPiastres > thresholdPiastres;
}

/** Exported for the test that asserts lib/rbac and lib/db agree. */
export const _MATRIX_FOR_TESTS = MATRIX;
