/**
 * tests/access/audit.test.ts — audit coverage, and the phone-change path.
 *
 * The CP-1 self-critique named the weakness this file closes: the access
 * controls held, but only two paths wrote an audit row. **A path that is
 * authorized but unlogged is an attacker's best move**, and it is worse than a
 * missing control because the audit page still looks complete — the board reads
 * a clean history and concludes nothing happened.
 *
 * Two things are asserted here:
 *   1. every mutating function in `lib/db/mutations.ts` leaves an audit row
 *      naming the actor, the action and the entity — enumerated, so adding a
 *      mutation without auditing it FAILS rather than slipping through;
 *   2. the phone-change path does all five things 03_RBAC §6 requires.
 */

import { it, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NodeSqliteDb } from '../../lib/db/driver.js';
import { setTokenHasher, resolveAuthContext, newId } from '../../lib/db/index.js';
import * as m from '../../lib/db/mutations.js';
import type { AuthContext } from '../../types/domain.js';

const ROOT = process.cwd();
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
setTokenHasher(sha);
const id = (p: string, n: number) => (p + String(n).padStart(26 - p.length, '0')).slice(0, 26);
const NOW = () => '2026-06-15T10:00:00Z';

const P_DEV = id('PRF', 1), P_ADMIN = id('PRF', 2), P_ADMIN2 = id('PRF', 3);
const P_OP = id('PRF', 4), P_RES = id('PRF', 5);
const B1 = id('BLD', 1), U1 = id('UNT', 1);
const CAT_EXP = 'CAT0000000000000000000EX01';
const F_OP = 'FND00000000000000000000001';

let raw: DatabaseSync;
let db: NodeSqliteDb;
let admin: AuthContext, admin2: AuthContext, operator: AuthContext, dev: AuthContext;

async function ctxFor(token: string): Promise<AuthContext> {
  const c = await resolveAuthContext(db, token, NOW);
  assert.ok(c, `no session for ${token}`);
  return c;
}

/** Count audit rows, so each test can assert its own delta. */
const auditCount = () =>
  (raw.prepare(`SELECT COUNT(*) n FROM audit_log`).get() as { n: number }).n;
const lastAudit = () =>
  raw.prepare(`SELECT * FROM audit_log ORDER BY rowid DESC LIMIT 1`).get() as
    { actor_id: string; actor_role: string; action: string; entity_table: string; entity_id: string };

before(async () => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).sort()) {
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  for (const f of readdirSync(join(ROOT, 'seed/prod')).sort()) {
    raw.exec(readFileSync(join(ROOT, 'seed/prod', f), 'utf8'));
  }
  const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...p as never[]);
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, P_DEV, 'المبرمج', 'developer');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, P_ADMIN, 'رئيس المجلس', 'admin');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, P_ADMIN2, 'أمين الصندوق', 'admin');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, P_OP, 'مشغّل', 'operator');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, P_RES, 'ساكن', 'resident');
  x(`INSERT INTO phone_identifiers (id,profile_id,phone_e164) VALUES (?,?,?)`, id('PHN',1), P_RES, '+201011111111');
  x(`INSERT INTO phone_identifiers (id,profile_id,phone_e164) VALUES (?,?,?)`, id('PHN',2), P_ADMIN, '+201099999999');
  x(`INSERT INTO buildings (id,code,sort_order) VALUES (?,?,?)`, B1, '5', 5);
  x(`INSERT INTO units (id,building_id,unit_number) VALUES (?,?,?)`, U1, B1, '1');
  x(`INSERT INTO unit_owners (id,unit_id,profile_id,valid_from) VALUES (?,?,?,?)`, id('UOW',1), U1, P_RES, '2020-01-01');
  const sess = (n: number, p: string, tok: string) =>
    x(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`,
      id('SES', n), p, sha(tok), '2027-01-01T00:00:00Z');
  sess(1, P_DEV, 'dev'); sess(2, P_ADMIN, 'admin'); sess(3, P_ADMIN2, 'admin2');
  sess(4, P_OP, 'op'); sess(5, P_RES, 'res');

  db = new NodeSqliteDb(raw as never);
  dev = await ctxFor('dev'); admin = await ctxFor('admin');
  admin2 = await ctxFor('admin2'); operator = await ctxFor('op');
});

/* ================================================================== */
describe('every mutating path leaves an audit trail', () => {

  it('recordExpense is audited', async () => {
    const before = auditCount();
    const eid = id('EXP', 1);
    await m.recordExpense(operator, db, {
      id: eid as never, voucherNo: 'E-1', categoryId: CAT_EXP as never,
      amountPiastres: 320000, spentOn: '2026-06-01', descriptionAr: 'عربية مياه',
      vendorName: 'أبو زيد', invoiceStorageKey: null, fundId: F_OP as never,
    });
    assert.equal(auditCount(), before + 1);
    const a = lastAudit();
    assert.equal(a.action, 'expense.record');
    assert.equal(a.actor_id, P_OP);
    assert.equal(a.actor_role, 'operator');
    assert.equal(a.entity_id, eid);
  });

  it('countersignExpense is audited, and refuses the recorder', async () => {
    const eid = id('EXP', 2);
    await m.recordExpense(admin, db, {
      id: eid as never, voucherNo: 'E-2', categoryId: CAT_EXP as never,
      amountPiastres: 900000, spentOn: '2026-06-02', descriptionAr: 'ترميم',
      vendorName: null, invoiceStorageKey: null, fundId: F_OP as never,
    });
    // maker–checker: the admin who recorded it cannot countersign it
    await assert.rejects(() => m.countersignExpense(admin, db, eid as never, NOW));
    const before = auditCount();
    await m.countersignExpense(admin2, db, eid as never, NOW);
    assert.equal(auditCount(), before + 1);
    assert.equal(lastAudit().action, 'expense.countersign');
    assert.equal(lastAudit().actor_id, P_ADMIN2);
  });

  it('renameCategory and deactivateCategory are audited', async () => {
    const before = auditCount();
    await m.renameCategory(admin, db, CAT_EXP as never, 'الصيانة والترميم');
    assert.equal(lastAudit().action, 'category.rename');
    // deactivating a category that has entries is BLOCKED (CP-5 gate)
    await assert.rejects(() => m.deactivateCategory(admin, db, CAT_EXP as never),
      /عملية|operation|بند/, 'a category with entries was deactivated, orphaning them');
    const empty = 'CAT0000000000000000000EX07';   // حمام السباحة — unused here
    await m.deactivateCategory(admin, db, empty as never);
    assert.equal(lastAudit().action, 'category.deactivate');
    assert.equal(auditCount(), before + 2);
  });

  it('grantDelegate and revokeDelegate are audited', async () => {
    const before = auditCount();
    const did = id('DLG', 1);
    await m.grantDelegate(admin, db, {
      id: did as never, ownerProfileId: P_RES as never, delegateProfileId: P_OP as never,
      unitId: U1 as never, canViewFinancials: true, canSubmitPayments: true,
      validFrom: '2026-01-01', validTo: '2026-12-31', reasonAr: 'المالك بالقاهرة',
    });
    assert.equal(lastAudit().action, 'delegate.grant');
    await m.revokeDelegate(admin, db, did as never, NOW);
    assert.equal(lastAudit().action, 'delegate.revoke');
    assert.equal(auditCount(), before + 2);
  });

  it('assignRole is audited, and only a developer may create an admin', async () => {
    await assert.rejects(() => m.assignRole(admin, db, P_RES as never, 'admin'),
      /صلاحيات|forbidden/, 'an admin promoted somebody to admin');
    const before = auditCount();
    await m.assignRole(dev, db, P_RES as never, 'admin');
    assert.equal(auditCount(), before + 1);
    const a = lastAudit();
    assert.equal(a.action, 'user.assign_role');
    assert.equal(a.actor_role, 'developer');
    await m.assignRole(dev, db, P_RES as never, 'resident');   // put it back
  });

  it('updateSettings is audited and ignores columns not on the allow-list', async () => {
    const before = auditCount();
    await m.updateSettings(admin, db, { instapay_handle: 'qaryat@instapay' }, NOW);
    assert.equal(auditCount(), before + 1);
    assert.equal(lastAudit().action, 'settings.update');
    // a settings form is otherwise a very direct route to writing any column
    await assert.rejects(() => m.updateSettings(admin, db, { id: 2 } as never, NOW));
  });

  it('revokeAllSessions is audited', async () => {
    const before = auditCount();
    await m.revokeAllSessions(admin, db, P_OP as never, NOW);
    assert.equal(auditCount(), before + 1);
    assert.equal(lastAudit().action, 'session.revoke_all');
  });

  it('EVERY function named in MUTATING_FUNCTIONS was exercised above', () => {
    // Enumerated on purpose: adding a mutation without adding it here — and
    // therefore without a coverage test — fails this assertion.
    const exercised = new Set([
      'recordExpense', 'countersignExpense', 'deactivateCategory', 'renameCategory',
      'grantDelegate', 'revokeDelegate', 'assignRole', 'revokeAllSessions',
      'updateSettings', 'changePhoneNumber',
    ]);
    for (const name of m.MUTATING_FUNCTIONS) {
      assert.ok(exercised.has(name), `${name} has no audit-coverage test`);
      assert.equal(typeof (m as Record<string, unknown>)[name], 'function');
    }
    assert.equal(exercised.size, m.MUTATING_FUNCTIONS.length,
      'a test exists for a function no longer exported');
  });
});

/* ================================================================== */
describe('phone change — R-003, the most abuse-prone path', () => {

  it('does all five things 03_RBAC §6 requires', async () => {
    const before = auditCount();
    const r = await m.changePhoneNumber(admin, db, {
      targetProfileId: P_RES as never,
      newPhoneE164: '+201055555555',
      reasonAr: 'الساكن غيّر شريحته، اتأكدنا من شخصيته في المكتب',
    }, NOW);

    // 1. the old number is returned so the caller can notify it
    assert.equal(r.previousPhoneE164, '+201011111111');
    // 2. history is preserved — the old row still exists, marked replaced
    const hist = raw.prepare(
      `SELECT status, change_reason_ar, replaced_by_id FROM phone_identifiers
        WHERE phone_e164='+201011111111'`).get() as
      { status: string; change_reason_ar: string; replaced_by_id: string };
    assert.equal(hist.status, 'replaced');
    assert.ok(hist.change_reason_ar, 'the reason was not recorded');
    assert.ok(hist.replaced_by_id, 'the chain of custody was broken');
    // 3. the new number is active
    const now_ = raw.prepare(
      `SELECT phone_e164 FROM phone_identifiers WHERE profile_id=? AND status='active'`)
      .get(P_RES) as { phone_e164: string };
    assert.equal(now_.phone_e164, '+201055555555');
    // 4. EVERY session is revoked — otherwise the old holder keeps a year-long session
    const live = raw.prepare(
      `SELECT COUNT(*) n FROM sessions WHERE profile_id=? AND revoked_at IS NULL`)
      .get(P_RES) as { n: number };
    assert.equal(live.n, 0, 'the previous number kept a live session');
    // 5. audited, with the actor named
    assert.equal(auditCount(), before + 1);
    assert.equal(lastAudit().action, 'phone.change');
    assert.equal(lastAudit().actor_id, P_ADMIN);
  });

  it('refuses without a written reason', async () => {
    await assert.rejects(() => m.changePhoneNumber(admin, db, {
      targetProfileId: P_RES as never, newPhoneE164: '+201066666666', reasonAr: '  ',
    }, NOW), /سبب/);
  });

  it('an operator cannot change anybody\'s number', async () => {
    await assert.rejects(() => m.changePhoneNumber(operator, db, {
      targetProfileId: P_RES as never, newPhoneE164: '+201077777777', reasonAr: 'test',
    }, NOW));
  });

  it('changing a STAFF number needs a second, different admin', async () => {
    // no second admin named
    await assert.rejects(() => m.changePhoneNumber(admin, db, {
      targetProfileId: P_ADMIN2 as never, newPhoneE164: '+201088888888', reasonAr: 'سبب',
    }, NOW), /أدمن تاني/);
    // naming yourself as the second admin is not a second admin
    await assert.rejects(() => m.changePhoneNumber(admin, db, {
      targetProfileId: P_ADMIN2 as never, newPhoneE164: '+201088888888',
      reasonAr: 'سبب', secondAdminId: P_ADMIN as never,
    }, NOW));
    // a genuine second admin works
    const before = auditCount();
    await m.changePhoneNumber(admin, db, {
      targetProfileId: P_ADMIN2 as never, newPhoneE164: '+201088888888',
      reasonAr: 'اتأكدنا من شخصيته', secondAdminId: P_DEV as never,
    }, NOW);
    assert.equal(auditCount(), before + 1);
  });

  it('a failed change writes NOTHING — no half-applied state', async () => {
    const phonesBefore = (raw.prepare(`SELECT COUNT(*) n FROM phone_identifiers`).get() as { n: number }).n;
    const auditBefore = auditCount();
    await assert.rejects(() => m.changePhoneNumber(operator, db, {
      targetProfileId: P_RES as never, newPhoneE164: '+201099998888', reasonAr: 'x',
    }, NOW));
    assert.equal((raw.prepare(`SELECT COUNT(*) n FROM phone_identifiers`).get() as { n: number }).n, phonesBefore);
    assert.equal(auditCount(), auditBefore);
  });

  it('the write and its audit row commit together, or not at all', async () => {
    // Self-contained on purpose: relying on a number another test happened to
    // create makes this pass or fail depending on test order, which is exactly
    // the kind of test that lies later.
    const TAKEN = '+201044443333';
    raw.prepare(`INSERT INTO phone_identifiers (id,profile_id,phone_e164) VALUES (?,?,?)`)
       .run(id('PHN', 90), P_DEV, TAKEN);
    // A duplicate active number violates idx_phone_active. The whole batch —
    // including the audit row — must roll back, leaving no orphan entry.
    const auditBefore = auditCount();
    const phonesBefore = (raw.prepare(`SELECT COUNT(*) n FROM phone_identifiers`).get() as { n: number }).n;
    await assert.rejects(() => m.changePhoneNumber(admin, db, {
      targetProfileId: P_RES as never,
      newPhoneE164: TAKEN,
      reasonAr: 'محاولة تكرار',
    }, NOW));
    assert.equal(auditCount(), auditBefore,
      'an audit row survived a rolled-back write — mutate() is not atomic');
    assert.equal((raw.prepare(`SELECT COUNT(*) n FROM phone_identifiers`).get() as { n: number }).n,
      phonesBefore, 'a half-applied phone change survived');
    const stillActive = raw.prepare(
      `SELECT status FROM phone_identifiers WHERE profile_id=? AND status='active'`).get(P_RES) as { status: string };
    assert.ok(stillActive, 'the resident was left with NO active number by a failed change');
  });
});
