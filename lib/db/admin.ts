/**
 * lib/db/admin.ts — the reads behind the board's configuration screens.
 *
 * Categories, settings, people and staff all existed in the schema from CP-1
 * and none of them could be seen, let alone changed, from the product: the
 * taxonomy was whatever `seed/prod` inserted, the bank number was whatever a
 * migration said, and a resident elected to the board stayed a resident. The
 * alternative was "ask the developer to run some SQL", which is precisely the
 * dependency this project exists to remove — a village that needs a programmer
 * to change its own bank account does not own its portal.
 *
 * **Only reads live here.** Every corresponding write is in `mutations.ts`,
 * because `mutate()` puts the write and its audit row in one batch and
 * `MUTATING_FUNCTIONS` forces each one to have a coverage test. Splitting a
 * screen's reads from its writes is worth the extra import: it is what keeps
 * "add a mutation" from being a thing you can do quietly.
 */

import type { AuthContext, Id } from '../../types/domain.js';
import { require_ } from '../rbac.js';
import type { Db } from './driver.js';
import { NotFound } from './index.js';

/* ===================================================================== */
/* Categories                                                            */
/* ===================================================================== */

export interface CategoryRow {
  id: string;
  name_ar: string;
  direction: 'income' | 'expense';
  kind: string;
  icon: string | null;
  sort_order: number;
  is_active: number;
  account_code: string;
  account_name: string;
  /** Rows across the whole system that point here — what retiring it keeps. */
  usage_count: number;
  /** Work that would break if it were retired now. Drives the refusal message. */
  in_flight: number;
}

export async function listCategories(ctx: AuthContext, db: Db): Promise<CategoryRow[]> {
  require_(ctx.role, 'category.manage');
  const r = await db.prepare(
    `SELECT c.id, c.name_ar, c.direction, c.kind, c.icon, c.sort_order, c.is_active,
            a.code AS account_code, a.name_ar AS account_name,
            (SELECT COUNT(*) FROM payments p WHERE p.category_id = c.id)
          + (SELECT COUNT(*) FROM expenses e WHERE e.category_id = c.id) AS usage_count,
            (SELECT COUNT(*) FROM payments p
              WHERE p.category_id = c.id
                AND p.status IN ('draft','submitted','under_review'))
          + (SELECT COUNT(*) FROM expenses e
              WHERE e.category_id = c.id AND e.journal_entry_id IS NULL
                AND e.status <> 'reversed')                          AS in_flight
       FROM categories c
       JOIN accounts a ON a.id = c.ledger_account_id
      ORDER BY c.is_active DESC, c.direction, c.sort_order, c.name_ar`
  ).all<CategoryRow>();
  return r.results ?? [];
}

/** The funds a category may default to. A deposit category must land in a
 *  non-spendable trust fund; the form defaults by kind and the board can still
 *  choose a reserve fund deliberately. */
export async function fundChoices(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'category.manage');
  const r = await db.prepare(
    `SELECT id, name_ar, kind, is_spendable FROM funds WHERE is_active = 1 ORDER BY kind, id`
  ).all<{ id: string; name_ar: string; kind: string; is_spendable: number }>();
  return r.results ?? [];
}

/**
 * The ledger accounts a category may point at.
 *
 * Liability accounts are in the list because a **deposit** category has to
 * point at one — الوديعة is money held for an owner, not income (06 §1), and
 * `trg_category_account_matches_kind` refuses any other pairing. Offering only
 * income and expense accounts would make the correct choice unreachable.
 */
export async function accountChoices(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'category.manage');
  const r = await db.prepare(
    `SELECT id, code, name_ar, type FROM accounts
      WHERE is_active = 1 AND type IN ('income','expense','liability')
      ORDER BY code`
  ).all<{ id: string; code: string; name_ar: string; type: string }>();
  return r.results ?? [];
}

/* ===================================================================== */
/* Settings                                                              */
/* ===================================================================== */

export interface SettingsRow {
  community_name_ar: string;
  instapay_handle: string | null;
  bank_name_ar: string | null;
  bank_account_no: string | null;
  vodafone_cash_no: string | null;
  countersign_threshold_piastres: number;
  notify_quiet_from: string;
  notify_quiet_to: string;
  unit_status_public: number;
  staff_names_public: number;
  updated_at: string | null;
  updated_by_name: string | null;
}

export async function getSettings(ctx: AuthContext, db: Db): Promise<SettingsRow> {
  require_(ctx.role, 'settings.edit');
  const r = await db.prepare(
    `SELECT s.community_name_ar, s.instapay_handle, s.bank_name_ar, s.bank_account_no,
            s.vodafone_cash_no, s.countersign_threshold_piastres,
            s.notify_quiet_from, s.notify_quiet_to,
            s.unit_status_public, s.staff_names_public, s.updated_at,
            p.full_name AS updated_by_name
       FROM settings s LEFT JOIN profiles p ON p.id = s.updated_by
      WHERE s.id = 1`
  ).first<SettingsRow>();
  if (!r) throw new NotFound('الإعدادات مش موجودة');
  return r;
}

/* ===================================================================== */
/* People                                                                */
/* ===================================================================== */

export interface PersonRow {
  id: string;
  full_name: string;
  role: string;
  is_active: number;
  last_login_at: string | null;
  unit_label: string | null;
  passkeys: number;
}

/**
 * Everybody, for the roles screen.
 *
 * Board and staff roles come FIRST rather than sorting by name: this screen is
 * opened to answer "who can approve money", and the answer must not be on page
 * three of two hundred residents. Phone numbers are absent — `phone.read_any`
 * is a separate capability and a role list has no business carrying them.
 */
export async function listPeople(
  ctx: AuthContext, db: Db, query?: string,
): Promise<PersonRow[]> {
  require_(ctx.role, 'user.assign_role');
  const q = (query ?? '').trim();
  const like = q ? `%${q.replace(/[%_\\]/g, m => '\\' + m)}%` : null;
  const r = await db.prepare(
    `SELECT p.id, p.full_name, p.role, p.is_active, p.last_login_at,
            (SELECT b.name_ar || ' — ' || u.unit_number
               FROM unit_owners uo
               JOIN units u ON u.id = uo.unit_id
               JOIN buildings b ON b.id = u.building_id
              WHERE uo.profile_id = p.id AND uo.valid_to IS NULL
              LIMIT 1)                                            AS unit_label,
            (SELECT COUNT(*) FROM passkeys k
              WHERE k.profile_id = p.id AND k.revoked_at IS NULL)  AS passkeys
       FROM profiles p
      WHERE (? IS NULL OR p.full_name LIKE ? ESCAPE '\\')
      ORDER BY CASE p.role WHEN 'developer' THEN 0 WHEN 'admin' THEN 1
                           WHEN 'finance_reviewer' THEN 2 WHEN 'operator' THEN 3
                           ELSE 4 END,
               p.is_active DESC, p.full_name
      LIMIT 400`
  ).bind(like, like).all<PersonRow>();
  return r.results ?? [];
}

/* ===================================================================== */
/* Audit                                                                 */
/* ===================================================================== */

export interface AuditRow {
  id: string;
  actor_name: string | null;
  actor_role: string;
  action: string;
  entity_table: string;
  entity_id: string;
  created_at: string;
}

/**
 * The audit log with the actor's NAME resolved.
 *
 * `readAuditLog` returns `actor_id`, which is correct for an API and useless on
 * a screen: a board member cannot check "who changed the bank number" against a
 * column of ULIDs. The join is a LEFT JOIN because a deactivated person's rows
 * must keep appearing — an audit trail that loses entries when somebody leaves
 * is not an audit trail.
 *
 * Nothing here can write. There is no update or delete path for `audit_log` in
 * the entire codebase, `audit.modify` is held by no role, and
 * `trg_audit_no_update`/`trg_audit_no_delete` refuse it at the database.
 */
export async function auditFeed(ctx: AuthContext, db: Db, limit = 200): Promise<AuditRow[]> {
  require_(ctx.role, 'audit.read');
  const r = await db.prepare(
    `SELECT a.id, a.actor_role, a.action, a.entity_table, a.entity_id, a.created_at,
            p.full_name AS actor_name
       FROM audit_log a
       LEFT JOIN profiles p ON p.id = a.actor_id
      ORDER BY a.created_at DESC, a.rowid DESC
      LIMIT ?`
  ).bind(Math.min(limit, 500)).all<AuditRow>();
  return r.results ?? [];
}

/* ===================================================================== */
/* Staff                                                                 */
/* ===================================================================== */

export interface StaffRow {
  id: string;
  full_name: string | null;
  job_title_ar: string;
  monthly_salary_piastres: number;
  started_on: string | null;
  ended_on: string | null;
  is_active: number;
}

/**
 * The payroll, for the admin screen.
 *
 * Unlike the public `getStaff`, this one always includes names: the board is
 * the party that decides whether residents see them (`staff_names_public`,
 * Q4), and it cannot make that decision about a list it cannot read. The
 * capability is what separates the two — `staff.read_names` is held by the
 * board and the finance reviewer, and by nobody else.
 */
export async function listStaffFull(ctx: AuthContext, db: Db): Promise<StaffRow[]> {
  // NOT `staff.read_salaries` — residents hold that one, because the payroll
  // total is published on purpose. Reading the list person by person is the
  // board's act, and `staff.read_names` is the capability that says so.
  require_(ctx.role, 'staff.read_names');
  const r = await db.prepare(
    `SELECT id, full_name, job_title_ar,
            monthly_salary_piastres, started_on, ended_on, is_active
       FROM staff ORDER BY is_active DESC, job_title_ar, id`
  ).all<StaffRow>();
  return r.results ?? [];
}

/* ===================================================================== */
/* The dashboard's queues                                                */
/* ===================================================================== */

export interface Queues {
  receipts: number;
  expenses: number;
  tickets: number;
  membersWaiting: number;
  settlements: number;
}

/**
 * What is waiting for somebody, right now.
 *
 * The home screen used to show a board member the same thing it showed a
 * resident: their own dues, and a list of links. A link is not a signal —
 * «مراجعة الإيصالات» looks identical whether the queue holds zero receipts or
 * eleven, so the only way to find out was to open it, and the realistic
 * outcome is that nobody opens it on the day it matters.
 *
 * One query, five counts, and the screen only draws the ones the caller may
 * act on. Capabilities are checked by the CALLER against the same `can()` the
 * routes use; this function returns the numbers.
 */
export async function pendingQueues(ctx: AuthContext, db: Db): Promise<Queues> {
  require_(ctx.role, 'profile.edit_own');
  const r = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM payments
         WHERE status IN ('submitted','under_review'))                    AS receipts,
       (SELECT COUNT(*) FROM expenses
         WHERE journal_entry_id IS NULL AND status <> 'reversed')          AS expenses,
       (SELECT COUNT(*) FROM maintenance_tickets
         WHERE status NOT IN ('resolved','closed','rejected'))                        AS tickets,
       (SELECT COUNT(*) FROM profiles p
         WHERE p.is_active = 1
           AND NOT EXISTS (SELECT 1 FROM passkeys k
                            WHERE k.profile_id = p.id AND k.revoked_at IS NULL))
                                                                          AS membersWaiting,
       (SELECT COUNT(*) FROM v_open_settlements)                           AS settlements`
  ).first<Queues>();
  return r ?? { receipts: 0, expenses: 0, tickets: 0, membersWaiting: 0, settlements: 0 };
}

/* ===================================================================== */
/* /me — the caller's own account                                        */
/* ===================================================================== */

export interface MyAccount {
  full_name: string;
  role: string;
  unit_label: string | null;
  /** Masked. The full number is `phone.read_any`, which nobody holds over
   *  themselves — and a screen that prints it is a screen somebody photographs. */
  phone_masked: string | null;
  devices: Array<{
    id: string; device_label_ar: string; created_at: string; last_used_at: string | null;
  }>;
}

/**
 * Everything a person can see about their own account.
 *
 * `/me` did not exist, which meant a resident had no way to answer the one
 * security question this product's design makes possible: **which devices can
 * open my account?** Passkeys are the whole authentication story here, and an
 * enrolled device the owner does not recognise is the only visible symptom of
 * a compromised account.
 *
 * The phone number is masked to its last three digits. `phone.read_any` is a
 * capability an admin holds over other people; nothing needs the full number
 * rendered on a page the owner will hold up in a WhatsApp video call to ask
 * their son what it says.
 */
export async function myAccount(ctx: AuthContext, db: Db): Promise<MyAccount> {
  require_(ctx.role, 'profile.edit_own');
  const p = await db.prepare(
    `SELECT p.full_name, p.role,
            (SELECT b.name_ar || ' — ' || u.unit_number
               FROM unit_owners uo
               JOIN units u ON u.id = uo.unit_id
               JOIN buildings b ON b.id = u.building_id
              WHERE uo.profile_id = p.id AND uo.valid_to IS NULL
              LIMIT 1)                                          AS unit_label,
            (SELECT '••••' || substr(pi.phone_e164, -3)
               FROM phone_identifiers pi
              WHERE pi.profile_id = p.id AND pi.status = 'active'
              LIMIT 1)                                          AS phone_masked
       FROM profiles p WHERE p.id = ?`
  ).bind(ctx.personId).first<Omit<MyAccount, 'devices'>>();
  if (!p) throw new NotFound('الحساب مش موجود');

  const k = await db.prepare(
    `SELECT id, device_label_ar, created_at, last_used_at
       FROM passkeys
      WHERE profile_id = ? AND revoked_at IS NULL
      ORDER BY COALESCE(last_used_at, created_at) DESC`
  ).bind(ctx.personId).all<{
    id: string; device_label_ar: string; created_at: string; last_used_at: string | null;
  }>();

  return { ...p, devices: k.results ?? [] };
}

/* ===================================================================== */
/* دفتر القيود — the journal                                             */
/* ===================================================================== */

export interface JournalEntryRow {
  id: string;
  entry_no: string;
  entry_date: string;
  description_ar: string;
  source_type: string;
  posted_at: string | null;
  is_reversal: number;
  amount_piastres: number;
  line_count: number;
}

/**
 * The journal, newest first.
 *
 * `/finance` answers "how much"; this answers "on what basis". A board asked
 * to approve last year's accounts needs to be able to open the actual entries,
 * and a treasurer defending a figure needs to be able to point at one — neither
 * was possible from the product, so the ledger existed and could only be read
 * with `sqlite3`.
 *
 * Only POSTED entries carry money. Unposted ones are shown too, and marked,
 * because an entry that was created and never posted is a real and confusing
 * state (it is what R-078 looked like from the inside) and hiding it would make
 * this screen agree with a wrong total.
 */
export async function journalCount(ctx: AuthContext, db: Db): Promise<number> {
  require_(ctx.role, 'audit.read');
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM journal_entries`).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function journal(
  ctx: AuthContext, db: Db, limit = 60, offset = 0,
): Promise<JournalEntryRow[]> {
  require_(ctx.role, 'audit.read');
  const r = await db.prepare(
    `SELECT e.id, e.entry_no, e.entry_date, e.description_ar, e.source_type,
            e.posted_at, e.is_reversal,
            (SELECT COALESCE(SUM(l.debit_piastres), 0) FROM journal_lines l
              WHERE l.entry_id = e.id)                       AS amount_piastres,
            (SELECT COUNT(*) FROM journal_lines l WHERE l.entry_id = e.id) AS line_count
       FROM journal_entries e
      ORDER BY e.entry_date DESC, e.rowid DESC
      LIMIT ? OFFSET ?`
  ).bind(Math.min(limit, 200), Math.max(offset, 0)).all<JournalEntryRow>();
  return r.results ?? [];
}

export interface JournalLineRow {
  line_no: number;
  account_code: string;
  account_name: string;
  fund_name: string | null;
  debit_piastres: number;
  credit_piastres: number;
  memo_ar: string | null;
  unit_label: string | null;
}

export async function journalLines(
  ctx: AuthContext, db: Db, entryId: Id,
): Promise<JournalLineRow[]> {
  require_(ctx.role, 'audit.read');
  const r = await db.prepare(
    `SELECT l.line_no, a.code AS account_code, a.name_ar AS account_name,
            f.name_ar AS fund_name, l.debit_piastres, l.credit_piastres, l.memo_ar,
            (SELECT b.name_ar || ' — ' || u.unit_number
               FROM units u JOIN buildings b ON b.id = u.building_id
              WHERE u.id = l.unit_id)                        AS unit_label
       FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id
       LEFT JOIN funds f ON f.id = l.fund_id
      WHERE l.entry_id = ?
      ORDER BY l.line_no`
  ).bind(entryId).all<JournalLineRow>();
  return r.results ?? [];
}
