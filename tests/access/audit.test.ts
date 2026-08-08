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
import * as av from '../../src/views/admin-pages.js';
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
// The resident context exists so self-service can be driven AS the owner —
// `updateOwnProfile` takes no target, so it can only be tested from their side.
let resident: AuthContext;

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
  resident = await ctxFor('res');
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

  it('createCategory and activateCategory are audited, and الوديعة cannot be income', async () => {
    const before = auditCount();
    const acc = raw.prepare(
      `SELECT id FROM accounts WHERE type='income' ORDER BY code LIMIT 1`).get() as { id: string };
    const liab = raw.prepare(
      `SELECT id FROM accounts WHERE type='liability' ORDER BY code LIMIT 1`).get() as { id: string };

    const cid = await m.createCategory(admin, db, {
      nameAr: 'اشتراك الصيانة الإضافي', direction: 'income',
      kind: 'operating_income', ledgerAccountId: acc.id as never, icon: '🔧',
    });
    assert.equal(lastAudit().action, 'category.create');

    // ⭐ 06 §1: a deposit category pointing at an INCOME account is the single
    // most expensive mistake in this domain. The trigger refuses it, not us.
    await assert.rejects(() => m.createCategory(admin, db, {
      nameAr: 'وديعة', direction: 'income', kind: 'deposit',
      ledgerAccountId: acc.id as never,
    }), /وديعة|التزام|liability|حساب/, 'a deposit category was booked against income');

    // ...and the correct pairing is accepted, so the refusal is about the
    // pairing and not about deposits being unusable.
    await m.createCategory(admin, db, {
      nameAr: 'وديعة الملاك', direction: 'income', kind: 'deposit',
      ledgerAccountId: liab.id as never,
    });

    await m.deactivateCategory(admin, db, cid as never);
    await m.activateCategory(admin, db, cid as never);
    assert.equal(lastAudit().action, 'category.activate');
    assert.equal(auditCount(), before + 4);   // the refused one wrote nothing
  });

  it('a retired category keeps its history rather than blocking on it', async () => {
    // The old rule refused to retire a category with ANY payment or expense
    // against it, which made retirement impossible for every category worth
    // retiring — and the "move them to another category first" it demanded
    // would have rewritten history: journal_lines carries its own category_id,
    // so moving a settled payment makes the receipt and the ledger disagree
    // about where the money went, and last year's chart changes shape.
    //
    // A closed receipt is history. Only work IN FLIGHT may block.
    const cat = raw.prepare(
      `SELECT id FROM categories WHERE direction='income' AND is_active=1 LIMIT 1`)
      .get() as { id: string };
    raw.prepare(
      `INSERT INTO payments (id,receipt_no,unit_id,submitted_by,category_id,
         claimed_amount_piastres,reviewed_by,reviewed_at,review_reason_ar,
         method,transfer_date,storage_key,status)
       VALUES (?,?,?,?,?,?,?,?,?,'instapay','2025-04-04',?,'rejected')`)
      .run(id('PAY', 90), 'R-2025-00090', U1, P_RES, cat.id, 250000,
           P_ADMIN, '2025-04-05T09:00:00Z', 'الصورة مش واضحة', 'receipts/old.webp');

    await m.deactivateCategory(admin, db, cat.id as never);

    const still = raw.prepare(
      `SELECT COUNT(*) n FROM payments WHERE category_id = ?`).get(cat.id) as { n: number };
    assert.equal(still.n, 1, 'retiring a category touched its history');

    // ...and one still under review DOES block, which is the part that protects
    // a resident from a receipt that can never be decided.
    raw.prepare(
      `INSERT INTO payments (id,receipt_no,unit_id,submitted_by,category_id,
         claimed_amount_piastres,method,transfer_date,storage_key,status)
       VALUES (?,?,?,?,?,?,'instapay','2026-04-04',?,'under_review')`)
      .run(id('PAY', 91), 'R-2026-00091', U1, P_RES, cat.id, 250000, 'receipts/new.webp');
    await m.activateCategory(admin, db, cat.id as never);
    await assert.rejects(() => m.deactivateCategory(admin, db, cat.id as never),
      /تحت المراجعة/, 'a category with a receipt under review was retired');

    raw.prepare(`DELETE FROM payments WHERE id=?`).run(id('PAY', 91));
  });

  it('setPersonActive is audited and takes the sessions and passkeys with it', async () => {
    const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...p as never[]);
    x(`INSERT INTO passkeys (id,profile_id,credential_id,public_key,sign_count,rp_id,device_label_ar)
       VALUES (?,?,?,?,?,?,?)`, id('PSK', 80), P_RES, 'cred-deact',
       new Uint8Array([7]), 1, 'localhost', 'موبايله');
    x(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`,
      id('SES', 80), P_RES, sha('tok-deact'), '2027-01-01T00:00:00Z');

    const before = auditCount();
    await m.setPersonActive(admin, db, P_RES as never, false, NOW);
    assert.equal(lastAudit().action, 'user.deactivate');
    assert.equal(auditCount(), before + 1);

    // "deactivated" means nothing if the cookie in their pocket still works
    assert.equal(await resolveAuthContext(db, 'tok-deact', NOW), null,
      'a deactivated person kept a live session');
    const pk = raw.prepare(
      `SELECT COUNT(*) n FROM passkeys WHERE profile_id=? AND revoked_at IS NULL`)
      .get(P_RES) as { n: number };
    assert.equal(pk.n, 0, 'a deactivated person kept a usable passkey');

    await m.setPersonActive(admin, db, P_RES as never, true, NOW);
    assert.equal(lastAudit().action, 'user.activate');
  });

  it('⭐ nobody changes their own role, and the developer account is untouchable', async () => {
    await assert.rejects(() => m.assignRole(admin, db, P_ADMIN as never, 'resident'),
      /بنفسك|forbidden/, 'an admin edited their own role');
    await assert.rejects(() => m.setPersonActive(admin, db, P_ADMIN as never, false, NOW),
      /بنفسك|forbidden/, 'an admin deactivated themselves');
    await assert.rejects(() => m.assignRole(dev, db, P_DEV as never, 'resident'),
      /بنفسك|المبرمج|forbidden/, 'the developer demoted themselves');
    await assert.rejects(() => m.setPersonActive(admin, db, P_DEV as never, false, NOW),
      /المبرمج|forbidden/, 'an admin deactivated the founder account');
    await assert.rejects(() => m.assignRole(dev, db, P_RES as never, 'developer' as never),
      /مش بيتوزّع|forbidden/, 'the developer role was handed out from the product');
  });

  it('addStaff and endStaff are audited, and reading a salary is not editing it', async () => {
    const before = auditCount();
    const sid = await m.addStaff(admin, db, {
      fullName: 'عم رجب الحارس', jobTitleAr: 'حارس', monthlySalaryPiastres: 350000,
      startedOn: '2026-01-01',
    });
    assert.equal(lastAudit().action, 'staff.add');
    // an operator may read the payroll and must never write it
    await assert.rejects(() => m.addStaff(operator, db, {
      fullName: 'حد تاني', jobTitleAr: 'سبّاك', monthlySalaryPiastres: 1,
    }), /صلاحيات|forbidden/, 'an operator changed the payroll');
    await m.endStaff(admin, db, sid as never, '2026-09-30');
    assert.equal(lastAudit().action, 'staff.end');
    const row = raw.prepare(`SELECT is_active, ended_on FROM staff WHERE id=?`).get(sid) as
      { is_active: number; ended_on: string };
    assert.equal(row.is_active, 0);
    assert.equal(row.ended_on, '2026-09-30');
    assert.equal(auditCount(), before + 2);
  });

  /* ---- accounts: created by the board, one corner edited by the owner ---- */

  it('createProfile makes an account that cannot yet be logged into', async () => {
    const before = auditCount();
    const newId_ = await m.createProfile(admin, db, {
      fullNameAr: 'د. منى الغنيمي', phoneE164: '+201033333333', role: 'resident',
      unitId: U1 as never,
    }, NOW);
    assert.equal(lastAudit().action, 'user.create');
    assert.equal(auditCount(), before + 1);

    const row = raw.prepare(`SELECT full_name, role, created_by FROM profiles WHERE id=?`)
      .get(newId_) as { full_name: string; role: string; created_by: string };
    assert.equal(row.role, 'resident');
    assert.equal(row.created_by, P_ADMIN, 'the creator is not on the record');
    assert.equal((raw.prepare(
      `SELECT COUNT(*) n FROM unit_owners WHERE profile_id=? AND valid_to IS NULL`)
      .get(newId_) as { n: number }).n, 1, 'the flat was not attached');

    // Creating an account mints NO credential. Until the board issues an
    // activation link there is nothing to log in with, which is what keeps
    // "create an account" from being "create a way in".
    assert.equal((raw.prepare(`SELECT COUNT(*) n FROM passkeys WHERE profile_id=?`)
      .get(newId_) as { n: number }).n, 0);
    assert.equal((raw.prepare(
      `SELECT COUNT(*) n FROM activation_challenges WHERE profile_id=?`)
      .get(newId_) as { n: number }).n, 0);
  });

  it('a phone already in use cannot be handed to a second account', async () => {
    const before = auditCount();
    await assert.rejects(() => m.createProfile(admin, db, {
      fullNameAr: 'شخص تاني', phoneE164: '+201011111111', role: 'resident',
    }, NOW), /مسجّل لحساب تاني/, 'two profiles were given the same credential');
    assert.equal(auditCount(), before, 'a refused create still wrote an audit row');
  });

  it('an operator cannot create an account, and nobody mints an admin cheaply', async () => {
    await assert.rejects(() => m.createProfile(operator, db, {
      fullNameAr: 'حد', phoneE164: '+201044444444', role: 'resident',
    }, NOW), /صلاحيات|forbidden/);
    // `assignRole` guards admin behind user.assign_admin_role; creating one has
    // to cost the same, or "create an admin" is the way around that check.
    await assert.rejects(() => m.createProfile(admin, db, {
      fullNameAr: 'أدمن جديد', phoneE164: '+201044444444', role: 'admin',
    }, NOW), /صلاحيات|forbidden/, 'an admin minted another admin at creation');
  });

  it('renameProfile fixes the register, and records what it changed from', async () => {
    const before = auditCount();
    await m.renameProfile(admin, db, P_RES as never, 'ساكن الشناوي');
    assert.equal(lastAudit().action, 'user.rename');
    // A rename that does not record what it renamed FROM is not a correction,
    // it is a substitution — `lastAudit()` projects only a few columns, so the
    // before-image is read straight from the row.
    const beforeJson = (raw.prepare(
      `SELECT before_json FROM audit_log ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get() as { before_json: string | null }).before_json;
    assert.match(String(beforeJson), /ساكن/, 'the previous name is not on the record');
    assert.equal(auditCount(), before + 1);
    await assert.rejects(() => m.renameProfile(admin, db, P_RES as never, 'أ'),
      /الاسم كامل/, 'a one-letter name was accepted into the register');
  });

  it('setUnitOwner closes the old row rather than overwriting it', async () => {
    const u2 = (raw.prepare(`SELECT id FROM units WHERE id <> ? LIMIT 1`).get(U1) as
      { id: string } | undefined);
    if (!u2) return;
    await m.setUnitOwner(admin, db, P_RES as never, u2.id as never, NOW);
    assert.equal(lastAudit().action, 'user.set_unit');

    // The January receipt still has to name whoever owned the flat in January.
    const old = raw.prepare(
      `SELECT valid_to FROM unit_owners WHERE profile_id=? AND unit_id=?`)
      .get(P_RES, U1) as { valid_to: string | null };
    assert.ok(old.valid_to, 'the previous ownership row was deleted, not closed');
    assert.equal((raw.prepare(
      `SELECT COUNT(*) n FROM unit_owners WHERE profile_id=? AND valid_to IS NULL`)
      .get(P_RES) as { n: number }).n, 1, 'a person ended up owning two flats at once');
  });

  it('updateOwnProfile can reach three columns and no others', async () => {
    const before = auditCount();
    const nameBefore = (raw.prepare(`SELECT full_name FROM profiles WHERE id=?`)
      .get(P_RES) as { full_name: string }).full_name;

    await m.updateOwnProfile(resident, db, {
      contactPhoneE164: '+201055555555',
      preferredChannel: 'sms',
      contactNoteAr: 'الشقة مؤجرة — كلّموني على الرقم ده',
    });
    assert.equal(lastAudit().action, 'profile.update_own');
    assert.equal(auditCount(), before + 1);

    const after = raw.prepare(
      `SELECT full_name, role, is_active, contact_phone_e164, preferred_channel, contact_note_ar
         FROM profiles WHERE id=?`).get(P_RES) as Record<string, unknown>;
    assert.equal(after['contact_phone_e164'], '+201055555555');
    assert.equal(after['preferred_channel'], 'sms');
    assert.match(String(after['contact_note_ar']), /مؤجرة/);

    // The wall. These are creation facts and this function cannot express them.
    assert.equal(after['full_name'], nameBefore, 'self-edit changed the register name');
    assert.equal(after['role'], 'resident', 'self-edit changed a role');
    assert.equal(after['is_active'], 1);
    // …and the credential lives in another table entirely.
    assert.equal((raw.prepare(
      `SELECT phone_e164 FROM phone_identifiers WHERE profile_id=? AND status='active'`)
      .get(P_RES) as { phone_e164: string }).phone_e164, '+201011111111',
      'self-edit reached the LOGIN number');
  });

  it("a contact number may not be somebody else's login number", async () => {
    // Nothing would be breached — a contact column cannot open a session — but
    // the board's «كلّم صاحب الوحدة» would dial the wrong person.
    await assert.rejects(() => m.updateOwnProfile(resident, db, {
      contactPhoneE164: '+201099999999',        // the chairman's login number
    }), /مسجّل لحد تاني/, "a resident claimed the chairman's number as their contact");
  });

  it('EVERY function named in MUTATING_FUNCTIONS was exercised above', () => {
    // Enumerated on purpose: adding a mutation without adding it here — and
    // therefore without a coverage test — fails this assertion.
    const exercised = new Set([
      'recordExpense', 'countersignExpense', 'deactivateCategory', 'renameCategory',
      'grantDelegate', 'revokeDelegate', 'assignRole', 'revokeAllSessions',
      'updateSettings', 'changePhoneNumber',
      'createCategory', 'activateCategory', 'setPersonActive', 'addStaff', 'endStaff',
      'createProfile', 'renameProfile', 'setUnitOwner', 'updateOwnProfile',
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

/* ===================================================================== */
/* The audit log has to be READABLE, not just complete                   */
/* ===================================================================== */

/**
 * Every action `lib/db/` writes must have Arabic on «سجل التغييرات».
 *
 * Twenty-four of the fifty-one did not, so the transparency screen — the one
 * whose entire purpose is to be read by a board of doctors — printed
 * `session.open`, `passkey.enroll` and `map.verify_feature` in English. It went
 * unnoticed because the demo seed only ever wrote the eighteen actions it
 * fabricates; the rest appeared for the first time on the deployed site, from
 * real use.
 *
 * This scans the SOURCE rather than the database, so an action added tomorrow
 * fails here on the day it is written instead of on the day somebody performs
 * it in production.
 */
describe('every audited action can be read in Arabic', () => {
  it('ACTION_AR covers everything lib/db/ writes', () => {
    const dbDir = join(process.cwd(), 'lib/db');
    const actions = new Set<string>();
    for (const f of readdirSync(dbDir).filter(f => f.endsWith('.ts'))) {
      const src = readFileSync(join(dbDir, f), 'utf8');
      // `mutate(db, ctx, { action: 'x.y', … })` — the one audited-write helper
      for (const m of src.matchAll(/action:\s*'([a-z_]+\.[a-z_]+)'/g)) actions.add(m[1]!);
      // …and the handful of places that write audit_log directly.
      for (const m of src.matchAll(/INSERT INTO audit_log[\s\S]{0,400}?'([a-z_]+\.[a-z_]+)'/g)) {
        actions.add(m[1]!);
      }
    }
    assert.ok(actions.size > 30, `only found ${actions.size} actions — the scan is broken`);

    const untranslated = [...actions].filter(a => !(a in av.ACTION_AR)).sort();
    assert.deepEqual(untranslated, [],
      `these audit actions render as English slugs on the transparency screen: ${
        untranslated.join(', ')}`);
  });
});
