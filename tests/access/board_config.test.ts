/**
 * tests/access/board_config.test.ts — the screens that let the board run the
 * village without a programmer: fees, categories, roles, settings, staff, audit.
 *
 * Every one of these tables existed since CP-1 and none of them could be
 * changed from the product. Adding six screens adds six new ways to get
 * authorization wrong, so the tests here are about the boundaries rather than
 * about the happy path:
 *
 *   · an operator must not reach any of them;
 *   · a finance_reviewer reads the payroll and cannot change it;
 *   · a published subscription is frozen, at the DATABASE, not in a route;
 *   · nobody promotes themselves or touches the founder's account.
 *
 * The fee tests carry the CP-5 gate that was open since CP-0 — "fee periods &
 * dues generation" — and they assert the failure the whole three-step flow is
 * arranged to prevent: publishing a subscription that billed some of the flats
 * and looked like a success.
 */

import { it, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NodeSqliteDb } from '../../lib/db/driver.js';
import { setTokenHasher, resolveAuthContext } from '../../lib/db/index.js';
import * as fees from '../../lib/db/fees.js';
import * as adm from '../../lib/db/admin.js';
import * as mut from '../../lib/db/mutations.js';
import { createApp } from '../../src/app.js';
import { D1BlobStorage } from '../../lib/storage/d1blob.js';
import type { AuthContext } from '../../types/domain.js';

const ROOT = process.cwd();
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
setTokenHasher(sha);
const id = (p: string, n: number) => (p + String(n).padStart(26 - p.length, '0')).slice(0, 26);

const ADMIN = id('PRF', 1), ADMIN2 = id('PRF', 2), OP = id('PRF', 3);
const REVIEWER = id('PRF', 4), RES = id('PRF', 5), DEV = id('PRF', 6);
const BLD = id('BLD', 1), YEAR = id('FPR', 1);
const RP = { id: 'localhost', name: 'قرية الأطباء', origin: 'http://localhost' };
const NOW = () => '2026-08-07T10:00:00Z';

let raw: DatabaseSync, db: NodeSqliteDb, app: ReturnType<typeof createApp>;
let admin: AuthContext, operator: AuthContext, reviewer: AuthContext, dev: AuthContext;
let subsCategory = '';

/** How many flats exist, so "billed everybody" is asserted against a number
 *  the fixture owns rather than against a literal that drifts. */
const UNIT_COUNT = 12;

before(async () => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).sort())
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  for (const f of readdirSync(join(ROOT, 'seed/prod')).sort())
    raw.exec(readFileSync(join(ROOT, 'seed/prod', f), 'utf8'));

  const x = (s: string, ...p: unknown[]) => raw.prepare(s).run(...p as never[]);
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, ADMIN, 'رئيس المجلس', 'admin');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, ADMIN2, 'أمين الصندوق', 'admin');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, OP, 'عم سمير', 'operator');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, REVIEWER, 'أ. نبيل', 'finance_reviewer');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, RES, 'د. سعاد', 'resident');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, DEV, 'المبرمج', 'developer');

  x(`INSERT INTO buildings (id,code,name_ar,sort_order) VALUES (?,?,?,?)`, BLD, '5', 'عمارة 5', 5);
  for (let i = 1; i <= UNIT_COUNT; i++) {
    // Half the flats have a recorded area; the other half do not. That is not
    // tidy test data, it is the real state of a village register, and it is
    // what makes the per-sqm "missing units" assertion mean something.
    x(`INSERT INTO units (id,building_id,unit_number,area_cm2) VALUES (?,?,?,?)`,
      id('UNT', i), BLD, String(i), i <= UNIT_COUNT / 2 ? 1_200_000 : null);
  }
  x(`INSERT INTO unit_owners (id,unit_id,profile_id,valid_from) VALUES (?,?,?,?)`,
    id('UOW', 1), id('UNT', 1), RES, '2020-01-01');
  x(`INSERT INTO fiscal_periods (id,name_ar,starts_on,ends_on,status) VALUES (?,?,?,?,'open')`,
    YEAR, 'السنة المالية 2027', '2027-01-01', '2027-12-31');

  const sess = (n: number, p: string, tok: string) =>
    x(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`,
      id('SES', n), p, sha(tok), '2028-01-01T00:00:00Z');
  sess(1, ADMIN, 'tok-admin'); sess(2, OP, 'tok-op');
  sess(3, REVIEWER, 'tok-rev'); sess(4, RES, 'tok-res'); sess(5, DEV, 'tok-dev');

  db = new NodeSqliteDb(raw as never);
  const storage = new D1BlobStorage(db);
  app = createApp({ db, now: NOW, storage, rp: RP,
    storagePut: i => storage.put(i), storageUsedBytes: () => storage.usedBytes() });

  admin = (await resolveAuthContext(db, 'tok-admin', NOW))!;
  operator = (await resolveAuthContext(db, 'tok-op', NOW))!;
  reviewer = (await resolveAuthContext(db, 'tok-rev', NOW))!;
  dev = (await resolveAuthContext(db, 'tok-dev', NOW))!;

  subsCategory = (raw.prepare(
    `SELECT id FROM categories WHERE direction='income' AND kind='operating_income' LIMIT 1`)
    .get() as { id: string }).id;
});

const req = (path: string, token?: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return app.request(path, { ...init, headers });
};

/* ================================================================== */
describe('the board screens are closed to everybody else', () => {
  const CLOSED: [string, string[]][] = [
    ['/admin/fees',       ['tok-op', 'tok-res']],
    ['/admin/categories', ['tok-op', 'tok-res']],
    ['/admin/users',      ['tok-op', 'tok-res', 'tok-rev']],
    ['/admin/settings',   ['tok-op', 'tok-res', 'tok-rev']],
    ['/admin/staff',      ['tok-res']],
    ['/admin/audit',      ['tok-op', 'tok-res']],
  ];

  for (const [path, tokens] of CLOSED) {
    for (const tok of tokens) {
      it(`${path} refuses ${tok}`, async () => {
        assert.equal((await req(path, tok)).status, 403, `${tok} reached ${path}`);
      });
    }
    it(`${path} refuses an anonymous visitor`, async () => {
      const r = await req(path);
      assert.ok(r.status === 401 || r.status === 302, `anonymous got ${r.status} on ${path}`);
    });
  }

  it('an admin reaches every one of them', async () => {
    for (const [path] of CLOSED) {
      assert.equal((await req(path, 'tok-admin')).status, 200, `admin blocked from ${path}`);
    }
  });

  it('a finance_reviewer reads the payroll and the audit log, and changes neither', async () => {
    assert.equal((await req('/admin/staff', 'tok-rev')).status, 200);
    assert.equal((await req('/admin/audit', 'tok-rev')).status, 200);
    await assert.rejects(() => mut.addStaff(reviewer, db, {
      fullName: 'حد', jobTitleAr: 'سبّاك', monthlySalaryPiastres: 100,
    }), /صلاحيات|forbidden/, 'a reviewer changed the payroll');
  });
});

/* ================================================================== */
describe('fee periods — the CP-5 gate, open since CP-0', () => {
  let feeId = '';

  it('an operator cannot create a subscription', async () => {
    await assert.rejects(() => fees.createFeePeriod(operator, db, {
      nameAr: 'اشتراك 2027', categoryId: subsCategory as never, fiscalPeriodId: YEAR as never,
      startsOn: '2027-01-01', endsOn: '2027-12-31', dueOn: '2027-03-31',
      basis: 'per_unit', amountPiastres: 600000,
    }, NOW));
  });

  it('a draft is created and bills nobody', async () => {
    feeId = await fees.createFeePeriod(admin, db, {
      nameAr: 'اشتراك 2027', categoryId: subsCategory as never, fiscalPeriodId: YEAR as never,
      startsOn: '2027-01-01', endsOn: '2027-12-31', dueOn: '2027-03-31',
      basis: 'per_unit', amountPiastres: 600000,
    }, NOW);
    const [p] = await fees.listFeePeriods(admin, db);
    assert.equal(p!.unit_count, 0, 'creating a period billed somebody');
    assert.equal(p!.is_published, 0);
  });

  it('⭐ an EMPTY subscription cannot be published — the failure this flow exists to stop', async () => {
    await assert.rejects(() => fees.publishFeePeriod(admin, db, feeId as never, NOW),
      /التوزيع/, 'a subscription that billed nobody was published');
    // and the database refuses it even with the function bypassed (ADR-024)
    assert.throws(() => raw.prepare(`UPDATE fee_periods SET is_published=1 WHERE id=?`).run(feeId));
  });

  it('distributing bills every active flat, and doing it twice bills each once', async () => {
    const first = await fees.generateDues(admin, db, feeId as never, NOW);
    assert.equal(first.billed, UNIT_COUNT);
    assert.equal(first.totalPiastres, UNIT_COUNT * 600000);

    const again = await fees.generateDues(admin, db, feeId as never, NOW);
    assert.equal(again.billed, UNIT_COUNT, 'a second distribution billed the flats twice');
  });

  it('publishing freezes the amount — at the database, not in the route', async () => {
    await fees.publishFeePeriod(admin, db, feeId as never, NOW);

    assert.throws(() => raw.prepare(`UPDATE fee_periods SET amount_piastres=1 WHERE id=?`).run(feeId),
      /منشور|اتنشر/, 'a published subscription was restated');
    assert.throws(() => raw.prepare(`UPDATE fee_periods SET is_published=0 WHERE id=?`).run(feeId),
      /مسودة/, 'a published subscription went back to draft');
    const due = raw.prepare(`SELECT id FROM unit_dues WHERE fee_period_id=? LIMIT 1`)
      .get(feeId) as { id: string };
    assert.throws(() => raw.prepare(`UPDATE unit_dues SET amount_piastres=1 WHERE id=?`).run(due.id),
      /الرقم اللي اتقال/, "a resident's billed amount was edited after they saw it");
    assert.throws(() => raw.prepare(`DELETE FROM unit_dues WHERE id=?`).run(due.id),
      /الإعفاء بيتسجّل/, 'a published due was deleted');
  });

  it('⭐ a waiver is recorded BESIDE the amount, never instead of it (06 §4)', async () => {
    const due = raw.prepare(`SELECT id, amount_piastres FROM unit_dues WHERE fee_period_id=? LIMIT 1`)
      .get(feeId) as { id: string; amount_piastres: number };

    await assert.rejects(() => fees.waiveDue(admin, db, due.id as never, 600000, 'كده', NOW),
      /بالتفصيل/, 'a waiver was recorded with no real reason');

    await fees.waiveDue(admin, db, due.id as never, 600000,
      'قرار مجلس رقم 12 لسنة 2027 — ظروف اجتماعية موثّقة', NOW);

    const after = raw.prepare(
      `SELECT amount_piastres, waived_piastres, waived_by FROM unit_dues WHERE id=?`)
      .get(due.id) as { amount_piastres: number; waived_piastres: number; waived_by: string };
    assert.equal(after.amount_piastres, due.amount_piastres, 'the waiver rewrote the bill');
    assert.equal(after.waived_piastres, 600000);
    assert.equal(after.waived_by, ADMIN, 'the waiver has no name against it');
  });

  it('a flat with no area is SKIPPED on a per-sqm basis, and reported', async () => {
    const perSqm = await fees.createFeePeriod(admin, db, {
      nameAr: 'مساهمة الأسوار بالمتر', categoryId: subsCategory as never,
      fiscalPeriodId: YEAR as never, startsOn: '2027-01-01', endsOn: '2027-12-31',
      dueOn: '2027-06-30', basis: 'per_sqm', amountPiastres: 500,
    }, NOW);
    const out = await fees.generateDues(admin, db, perSqm as never, NOW);

    assert.equal(out.billed, UNIT_COUNT / 2, 'a flat with no area was billed anyway');
    assert.equal(out.missing, UNIT_COUNT / 2, 'the unbilled flats were not reported');
    // 120 m² × 5.00 ج.م = 600.00 — integer piastres throughout, division last
    assert.equal(out.totalPiastres, (UNIT_COUNT / 2) * 60000);

    // Publishing while flats are missing is ALLOWED — sometimes a flat really
    // is not billed — but the count stays on the screen, so it is a decision
    // rather than an accident.
    const before = await fees.publishFeePeriod(admin, db, perSqm as never, NOW);
    assert.equal(before.missing, UNIT_COUNT / 2);
  });
});

/* ================================================================== */
describe('categories, roles and settings', () => {
  it('⭐ a deposit category cannot point at an income account', async () => {
    const inc = raw.prepare(`SELECT id FROM accounts WHERE type='income' LIMIT 1`)
      .get() as { id: string };
    await assert.rejects(() => mut.createCategory(admin, db, {
      nameAr: 'وديعة الملاك', direction: 'income', kind: 'deposit',
      ledgerAccountId: inc.id as never,
    }), /وديعة|التزام|حساب/,
      'الوديعة was booked as income — the most expensive mistake in the domain');
  });

  it('the settings form can turn a publication switch back OFF', async () => {
    // An unchecked checkbox sends nothing. Treating "absent" as "leave alone"
    // makes the two assembly-level switches impossible to turn off from the
    // same form that turns them on — they would be one-way doors.
    await req('/admin/settings', 'tok-admin', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        community_name_ar: 'قرية الأطباء', threshold: '5000.00',
        quiet_from: '22:00', quiet_to: '09:00', staff_names_public: '1',
      }).toString(),
    });
    let s = await adm.getSettings(admin, db);
    assert.equal(s.staff_names_public, 1);
    assert.equal(s.unit_status_public, 0);

    await req('/admin/settings', 'tok-admin', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        community_name_ar: 'قرية الأطباء', threshold: '5000.00',
        quiet_from: '22:00', quiet_to: '09:00',
      }).toString(),
    });
    s = await adm.getSettings(admin, db);
    assert.equal(s.staff_names_public, 0, 'a publication switch could not be turned off again');
  });

  it('an admin cannot appoint another admin; a developer can', async () => {
    await assert.rejects(() => mut.assignRole(admin, db, RES as never, 'admin'),
      /صلاحيات|forbidden/, 'an admin minted another approver alone');
    await mut.assignRole(dev, db, RES as never, 'admin');
    const r = raw.prepare(`SELECT role FROM profiles WHERE id=?`).get(RES) as { role: string };
    assert.equal(r.role, 'admin');
    await mut.assignRole(dev, db, RES as never, 'resident');
  });

  it('the roles screen never offers a role the viewer cannot grant', async () => {
    const body = await (await req('/admin/users', 'tok-admin')).text();
    assert.ok(body.includes('مشغّل'), 'the roles screen offers no roles at all');
    assert.ok(!body.includes('value="admin"'),
      'an admin was offered a control that mints another admin');
    const asDev = await (await req('/admin/users', 'tok-dev')).text();
    assert.ok(asDev.includes('value="admin"'), 'a developer cannot appoint an admin either');
  });

  it('deactivating somebody logs them out of every device immediately', async () => {
    await mut.setPersonActive(admin, db, OP as never, false, NOW);
    assert.equal(await resolveAuthContext(db, 'tok-op', NOW), null,
      'a deactivated person kept a live session');
    await mut.setPersonActive(admin, db, OP as never, true, NOW);
  });
});
