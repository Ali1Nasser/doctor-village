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
import * as vmap from '../../lib/db/map.js';
import { createApp } from '../../src/app.js';
import { D1BlobStorage } from '../../lib/storage/d1blob.js';
import type { AuthContext } from '../../types/domain.js';

const ROOT = process.cwd();
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
setTokenHasher(sha);
const id = (p: string, n: number) => (p + String(n).padStart(26 - p.length, '0')).slice(0, 26);

const ADMIN = id('PRF', 1), ADMIN2 = id('PRF', 2), OP = id('PRF', 3);
const REVIEWER = id('PRF', 4), RES = id('PRF', 5), DEV = id('PRF', 6);
const BLD = id('BLD', 1), BLD2 = id('BLD', 2), YEAR = id('FPR', 1);
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
  x(`INSERT INTO buildings (id,code,name_ar,sort_order) VALUES (?,?,?,?)`, BLD2, '6', 'عمارة 6', 6);
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
    ['/admin/ledger',     ['tok-op', 'tok-res']],
    // Two doors onto the same village register, and neither is an operator's.
    // `user.import` creates people; `phone.change` re-credentials one. An
    // operator records receipts and expenses, and holds neither.
    ['/admin/import',     ['tok-op', 'tok-res', 'tok-rev']],
    ['/admin/recoveries', ['tok-op', 'tok-res', 'tok-rev']],
    // ⭐ Residents hold `finance.read_totals` on purpose — the village totals
    // are published. This screen names which FLATS the village owes money to,
    // which is a different fact about a different person, so it sits behind
    // `payment.read_any`.
    ['/admin/settlements', ['tok-op', 'tok-res']],
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

  it('a finance_reviewer reaches the settlements screen — it is oversight', async () => {
    assert.equal((await req('/admin/settlements', 'tok-rev')).status, 200);
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

/* ================================================================== */
/**
 * ⭐ Approving a receipt from the screen the board actually uses.
 *
 * `/admin/review` has rendered an «✅ اعتماد» button since CP-4 whose form
 * posts to `/admin/review/:id`. That route did not exist — the central act of
 * the entire product returned 404 on every deployment. And the API path was no
 * substitute: `reviewPayment` links a `journalEntryId` its caller must supply,
 * and nothing anywhere created one, so the only receipts ever posted were the
 * ones the demo seed wrote by hand.
 *
 * These tests drive the real form, over HTTP, and then check the LEDGER —
 * because "the request returned 200" is exactly the assertion that would have
 * passed while the money went nowhere.
 */
describe('⭐ approving a receipt posts real money', () => {
  const RES2 = id('PRF', 7);
  let payId = '';

  const submit = (n: number, amount: number, kind: 'subs' | 'deposit' = 'subs') => {
    const pid = id('PAY', n);
    const cat = raw.prepare(
      kind === 'deposit'
        ? `SELECT id FROM categories WHERE kind='deposit' LIMIT 1`
        : `SELECT id FROM categories WHERE kind='operating_income' LIMIT 1`)
      .get() as { id: string };
    raw.prepare(
      `INSERT INTO payments (id,receipt_no,unit_id,submitted_by,category_id,
         claimed_amount_piastres,method,transfer_date,storage_key,status,submitted_at)
       VALUES (?,?,?,?,?,?,'instapay','2027-02-01',?,'submitted','2027-02-01T09:00:00Z')`)
      .run(pid, 'R-2027-' + n, id('UNT', 1), RES2, cat.id, amount, `receipts/r${n}.webp`);
    return pid;
  };

  const ledger = (entryId: string) => raw.prepare(
    `SELECT account_id, debit_piastres dr, credit_piastres cr FROM journal_lines
      WHERE entry_id = ? ORDER BY line_no`).all(entryId) as
    Array<{ account_id: string; dr: number; cr: number }>;

  before(() => {
    const x = (s: string, ...p: unknown[]) => raw.prepare(s).run(...p as never[]);
    x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, RES2, 'د. ليلى', 'resident');
    x(`INSERT INTO unit_owners (id,unit_id,profile_id,valid_from) VALUES (?,?,?,?)`,
      id('UOW', 7), id('UNT', 1), RES2, '2020-01-01');
    // A fresh operator session: `tok-op` was revoked earlier by the
    // deactivate/reactivate test, and correctly not restored — reactivating an
    // account does not un-revoke the sessions that were killed with it.
    x(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`,
      id('SES', 9), OP, sha('tok-op2'), '2028-01-01T00:00:00Z');
  });

  it('the route the button posts to EXISTS', async () => {
    payId = submit(50, 600000);
    const r = await req(`/admin/review/${payId}`, 'tok-admin', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ kind: 'approve' }).toString(),
    });
    assert.notEqual(r.status, 404, 'the approve button still posts to nowhere');
    assert.equal(r.status, 200);
  });

  it('⭐ the money is in the books, balanced, and posted', () => {
    const p = raw.prepare(
      `SELECT status, approved_amount_piastres, journal_entry_id FROM payments WHERE id=?`)
      .get(payId) as { status: string; approved_amount_piastres: number; journal_entry_id: string };
    assert.equal(p.status, 'approved');
    assert.equal(p.approved_amount_piastres, 600000);
    assert.ok(p.journal_entry_id, 'an approved receipt with no journal entry — this is R-078');

    const e = raw.prepare(`SELECT posted_at, source_id FROM journal_entries WHERE id=?`)
      .get(p.journal_entry_id) as { posted_at: string | null; source_id: string };
    assert.ok(e.posted_at, 'the entry was created and never posted');
    assert.equal(e.source_id, payId, 'the entry does not name the receipt it came from');

    const lines = ledger(p.journal_entry_id);
    const dr = lines.reduce((n, l) => n + l.dr, 0);
    const cr = lines.reduce((n, l) => n + l.cr, 0);
    assert.equal(dr, cr, 'the entry does not balance');
    assert.equal(dr, 600000);
    // instapay in, subscription income out
    assert.equal(lines[0]!.account_id, 'ACC00000000000000000001103');
  });

  it('the resident is told, in the same act', () => {
    const n = raw.prepare(
      `SELECT kind, title_ar FROM notifications WHERE payment_id=?`).all(payId) as
      Array<{ kind: string; title_ar: string }>;
    assert.equal(n.length, 1, 'the resident was told zero times, or twice');
    assert.equal(n[0]!.kind, 'payment_approved');
  });

  it('a double-tapped approve is refused, not posted twice', async () => {
    const before = (raw.prepare(`SELECT COUNT(*) n FROM journal_entries`)
      .get() as { n: number }).n;
    const r = await req(`/admin/review/${payId}`, 'tok-admin', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ kind: 'approve' }).toString(),
    });
    assert.equal(r.status, 409);
    assert.equal((raw.prepare(`SELECT COUNT(*) n FROM journal_entries`)
      .get() as { n: number }).n, before, 'a replayed approval posted a second entry');
  });

  it('⭐ الوديعة lands on a LIABILITY, never on income (06 §1)', async () => {
    const dep = submit(51, 300000, 'deposit');
    const rr = await req(`/admin/review/${dep}`, 'tok-admin', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ kind: 'approve' }).toString(),
    });
    assert.equal(rr.status, 200);

    const eid = (raw.prepare(`SELECT journal_entry_id j FROM payments WHERE id=?`)
      .get(dep) as { j: string }).j;
    const credited = ledger(eid).find(l => l.cr > 0)!;
    const acc = raw.prepare(`SELECT type FROM accounts WHERE id=?`)
      .get(credited.account_id) as { type: string };
    assert.equal(acc.type, 'liability',
      'a deposit was booked as income — the most expensive mistake in this domain');
  });

  it('⭐ paying more than the due opens a CREDIT, not extra income', async () => {
    // The excess is computed against what the flat ACTUALLY still owes, which
    // earlier tests in this file have moved around. Reading it here rather than
    // hard-coding is the point: the split has to follow the ledger, not a
    // number the test happened to know.
    const owed = (raw.prepare(
      `SELECT COALESCE(outstanding_piastres, 0) o FROM v_unit_balance WHERE unit_id = ?`)
      .get(id('UNT', 1)) as { o: number } | undefined)?.o ?? 0;
    const amount = owed + 250000;
    const over = submit(52, amount);
    await req(`/admin/review/${over}`, 'tok-admin', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ kind: 'approve' }).toString(),
    });
    const eid = (raw.prepare(`SELECT journal_entry_id j FROM payments WHERE id=?`)
      .get(over) as { j: string }).j;
    const credit = ledger(eid).find(l => l.account_id === 'ACC00000000000000000002102');
    assert.ok(credit, 'an overpayment was booked as income');
    assert.equal(credit!.cr, 250000, 'the excess over the due was not what became the credit');

    const row = raw.prepare(
      `SELECT amount_piastres FROM resident_credits WHERE source_payment_id=?`)
      .get(over) as { amount_piastres: number } | undefined;
    assert.ok(row, 'no credit row — the village owes money it has not written down');
    assert.equal(row!.amount_piastres, 250000);
  });

  it('an operator cannot approve, and the maker cannot approve their own', async () => {
    const p2 = submit(53, 100000);
    assert.equal((await req(`/admin/review/${p2}`, 'tok-op2', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ kind: 'approve' }).toString(),
    })).status, 403);

    // an admin submitting for themselves, then trying to accept it
    const own = id('PAY', 54);
    const cat = raw.prepare(`SELECT id FROM categories WHERE kind='operating_income' LIMIT 1`)
      .get() as { id: string };
    raw.prepare(
      `INSERT INTO payments (id,receipt_no,unit_id,submitted_by,category_id,
         claimed_amount_piastres,method,transfer_date,storage_key,status)
       VALUES (?,?,?,?,?,?,'cash','2027-02-01',?,'submitted')`)
      .run(own, 'R-2027-OWN', id('UNT', 1), ADMIN, cat.id, 5000, 'receipts/own.webp');
    const r = await req(`/admin/review/${own}`, 'tok-admin', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ kind: 'approve' }).toString(),
    });
    assert.equal(r.status, 403, 'an admin approved a receipt they submitted themselves');
  });

  it('rejecting needs a reason and touches no money', async () => {
    const p3 = submit(55, 100000);
    const before = (raw.prepare(`SELECT COUNT(*) n FROM journal_entries`).get() as { n: number }).n;

    const noReason = await req(`/admin/review/${p3}`, 'tok-admin', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ kind: 'reject' }).toString(),
    });
    assert.equal(noReason.status, 400, 'a receipt was rejected with no reason for the resident');

    const ok = await req(`/admin/review/${p3}`, 'tok-admin', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ kind: 'reject', reason: 'الصورة مش واضحة، مش بايِن رقم العملية' }).toString(),
    });
    assert.equal(ok.status, 200);
    assert.equal((raw.prepare(`SELECT status FROM payments WHERE id=?`).get(p3) as
      { status: string }).status, 'rejected');
    assert.equal((raw.prepare(`SELECT COUNT(*) n FROM journal_entries`).get() as { n: number }).n,
      before, 'a rejection moved the ledger');
  });
});

/* ================================================================== */
/**
 * ⭐ C13 — the village map is a navigation layer, never a data source.
 *
 * `07_VILLAGE_MAP_SPEC.md` and constraint C13 are in the v1.4 spec pack and
 * were absent from the copy this project was built from; village navigation is
 * product goal FOUR and had no code at all. These tests assert the one rule the
 * whole feature exists to protect:
 *
 *   > "Never create production `buildings` or `units` rows from image labels."
 *
 * The drawing shows labels 14–46. That is a photograph of a brochure, not a
 * register, and buildings 1–13 are not established by it at all.
 */
describe('⭐ the map cannot invent a building (C13)', () => {
  const MAP = id('MAP', 1);
  let f1 = '', f2 = '';

  before(() => {
    const x = (s: string, ...p: unknown[]) => raw.prepare(s).run(...p as never[]);
    x(`INSERT INTO map_documents (id,title_ar,source_storage_key,display_storage_key,
         source_sha256,display_sha256,version_label,coverage_note_ar,status,created_by)
       VALUES (?,?,?,?,?,?,?,?, 'draft', ?)`,
      MAP, 'الموقع العام', 'maps/s.jpg', 'maps/d.webp',
      'a'.repeat(64), 'b'.repeat(64), 'v1',
      'الخريطة دي جزء من القرية مش كلها', ADMIN);
  });

  it('a hotspot for a building that is not in the register cannot be saved', async () => {
    await assert.rejects(
      () => vmap.addFeature(admin, db, MAP as never, {
        labelAr: '46', x: 100, y: 100, w: 400, h: 400,
        buildingId: id('BLD', 999) as never,
      }),
      /FOREIGN KEY|constraint|مرفوض|العملية/,
      'a label brought a building into existence');
  });

  it('coordinates outside 0–10,000 are refused', async () => {
    await assert.rejects(() => vmap.addFeature(admin, db, MAP as never, {
      labelAr: '5', x: 20000, y: 0, w: 10, h: 10,
    }), /الإحداثي/);
  });

  it('an UNLINKED hotspot can be drafted — that is what a draft is for', async () => {
    f1 = await vmap.addFeature(admin, db, MAP as never,
      { labelAr: '5', x: 1000, y: 1000, w: 500, h: 400 });
    f2 = await vmap.addFeature(admin, db, MAP as never,
      { labelAr: '14', x: 3000, y: 3000, w: 500, h: 400, buildingId: BLD as never });
    assert.equal((await vmap.mapFeatures(admin, db, MAP as never)).length, 2);
  });

  it('⭐ publishing with an unverified hotspot is refused BY THE DATABASE', async () => {
    await assert.rejects(() => vmap.publishMap(admin, db, MAP as never, NOW),
      /مش متأكد|مربوطة/, 'an unverified hotspot reached residents');
    // and with the data layer bypassed entirely (ADR-024)
    assert.throws(() => raw.prepare(`UPDATE map_documents SET status='published',
      published_by=?, published_at=? WHERE id=?`).run(ADMIN, '2026-08-08T10:00:00Z', MAP),
      /مش متأكد|مربوطة/);
  });

  it('verifying refuses a building that does not exist, in Arabic', async () => {
    await assert.rejects(
      () => vmap.verifyFeature(admin, db, f1 as never, id('BLD', 888) as never, NOW),
      /مش موجودة في السجل/,
      'the map was allowed to point at a building nobody has');
  });

  it('a verification carries a name and a time', async () => {
    await vmap.verifyFeature(admin, db, f2 as never, BLD as never, NOW);
    const r = raw.prepare(
      `SELECT verification_status, verified_by, verified_at FROM building_map_features WHERE id=?`)
      .get(f2) as { verification_status: string; verified_by: string; verified_at: string };
    assert.equal(r.verification_status, 'board_verified');
    assert.equal(r.verified_by, ADMIN);
    assert.ok(r.verified_at, 'a verification with no timestamp is not a verification');
  });

  it('⭐ it publishes only once EVERY hotspot is verified, and then freezes', async () => {
    // f1 is still unverified: still refused.
    await assert.rejects(() => vmap.publishMap(admin, db, MAP as never, NOW), /مش متأكد|مربوطة/);

    await vmap.verifyFeature(admin, db, f1 as never, BLD2 as never, NOW);
    await vmap.publishMap(admin, db, MAP as never, NOW);

    const m = await vmap.publishedMap(reviewer, db);
    assert.ok(m, 'a published map is not visible to a member');
    assert.equal(m!.features.length, 2);

    // Frozen: moving a hotspot residents already navigate by needs a new version.
    assert.throws(() => raw.prepare(`UPDATE building_map_features SET x = 9000 WHERE id=?`)
      .run(f2), /منشورة/, 'a published hotspot was moved under the residents');
    // ...and the source image can never be swapped.
    assert.throws(() => raw.prepare(`UPDATE map_documents SET source_sha256=? WHERE id=?`)
      .run('c'.repeat(64), MAP), /الأصلية/);
  });

  it('the building list comes from the REGISTER, and says what the map misses', async () => {
    const list = await vmap.buildingList(reviewer, db);
    assert.ok(list.length >= 1);
    // BLD and BLD2 are on the map; anything else in the register is not, and
    // still has to be reachable — that is the honest rendering of partial cover.
    assert.ok(list.some(b => b.on_map === 1), 'nothing is marked as on the map');
  });

  it('⭐ the map does not become a new route to private data (spec §3.6)', async () => {
    const s = await vmap.buildingSummary(reviewer, db, BLD as never);
    assert.equal(s.collected_piastres, null,
      'per-building payment figures were published without the assembly deciding to');
    const body = JSON.stringify(s) + JSON.stringify(await vmap.buildingWork(reviewer, db, BLD as never));
    assert.ok(!/\+20/.test(body), 'a phone number reached the map');
    assert.ok(!/سعاد|ليلى/.test(body), "a resident's name reached the map");
  });

  it('a resident reaches /map and /buildings/:id; the admin screen is closed to them', async () => {
    assert.equal((await req('/map', 'tok-res')).status, 200);
    assert.equal((await req(`/buildings/${BLD}`, 'tok-res')).status, 200);
    assert.equal((await req('/admin/map', 'tok-res')).status, 403);
    assert.equal((await req('/admin/map', 'tok-admin')).status, 200);
  });
});
