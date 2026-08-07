/**
 * tests/access/transparency.test.ts — the two CP-3 gates.
 *
 *   1. "Against a fixed seed fixture, every displayed figure matches a
 *      hand-computed expected value."
 *   2. "The same totals computed by raw SQL match the app's numbers exactly."
 *
 * ## Why this file parses HTML instead of calling the JSON API
 * A resident never sees the API. They see a page. Every bug that has actually
 * shipped in a finance UI lives in the gap between the two: the right number
 * divided by 100 twice, a piastre total labelled as pounds, a negative balance
 * rendered as arrears, a figure the template forgot to print at all. Asserting
 * on `getCommunityTotals()` would pass through every one of those.
 *
 * So the assertions here scrape the rendered markup and compare against
 * literals computed by hand, written out below with their arithmetic shown. If
 * a formatter changes, this file must fail.
 *
 * ## Why the fixture is tiny
 * `seed/demo/` has 204 units and its totals can only be checked by a program —
 * which is circular, because the program would be the thing under test. Twelve
 * journal lines can be added up by a human on paper, and *were*. Every expected
 * value below is a literal, never a computed expression.
 *
 * ## The three traps the fixture is built to catch
 *   · a **deposit** (2101) counted as spendable money or as income — R-020;
 *   · an **overpayment** (2102) counted as income rather than owed back;
 *   · a **pending** receipt counted anywhere at all — C5.
 * Each is present in the fixture with a distinct amount, so a wrong total names
 * its own cause: off by 500,000 is the deposit, by 200,000 the overpayment, by
 * 500,000 in the other direction the pending receipt.
 */

import { it, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NodeSqliteDb } from '../../lib/db/driver.js';
import { setTokenHasher, resolveAuthContext, getQuotaUsage } from '../../lib/db/index.js';
import { createApp } from '../../src/app.js';
import { t } from '../../src/views/layout.js';
import { D1BlobStorage } from '../../lib/storage/d1blob.js';
import type { AuthContext } from '../../types/domain.js';

const ROOT = process.cwd();
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
setTokenHasher(sha);
const id = (p: string, n: number) => (p + String(n).padStart(26 - p.length, '0')).slice(0, 26);

const ADMIN = id('PRF', 1), TREAS = id('PRF', 2), RES1 = id('PRF', 3), OPER = id('PRF', 4);
const BLD = id('BLD', 1);
const U101 = id('UNT', 101), U102 = id('UNT', 102), U103 = id('UNT', 103);
const PERIOD = id('FIS', 1), FEEP = id('FEP', 1);
const RP = { id: 'localhost', name: 'قرية الأطباء', origin: 'http://localhost' };
const NOW = () => '2026-08-04T10:00:00Z';

const A_CASH = 'ACC00000000000000000001101';
const A_BANK = 'ACC00000000000000000001102';
const L_DEPOSIT = 'ACC00000000000000000002101';
const L_CREDIT = 'ACC00000000000000000002102';
const F_OPENING = 'ACC00000000000000000003101';
const I_SUBS = 'ACC00000000000000000004101';
const E_MAINT = 'ACC00000000000000000005101';
const E_SALARY = 'ACC00000000000000000005301';

/* ===================================================================== */
/* THE HAND-COMPUTED EXPECTED VALUES                                     */
/*                                                                       */
/* All figures in piastres. The arithmetic is written out so a reviewer  */
/* can check it without running anything.                                */
/*                                                                       */
/*   cash  1101 = +1,000,000 opening − 150,000 salary          =   850,000
 *   bank  1102 = +800,000 +500,000 −300,000                    = 1,000,000
 *   assets (excluding 13xx receivables)                        = 1,850,000
 *
 *   liabilities 2101 الوديعة  (unit 101's 5,000 ج.م deposit)    =   500,000
 *   liabilities 2102 owner credit (102's 2,000 overpayment)     =   200,000
 *   held in trust                                              =   700,000
 *
 *   spendable = 1,850,000 − 700,000                            = 1,150,000
 *   income    = 600,000  — the dues portion of 102's payment
 *               ONLY. Not the deposit, not the overpayment,
 *               not the pending receipt.                        =   600,000
 *   expenses  = 300,000 maintenance + 150,000 salaries         =   450,000
 *   funds     = opening balance                                = 1,000,000
 *
 *   dues      = 3 units × 600,000                              = 1,800,000
 *   101 paid its DEPOSIT and not its subscription  → owes         600,000
 *   102 paid 800,000 against a 600,000 due         → credit      −200,000
 *   103's receipt is still pending, so counts as 0 → owes         600,000
 *   arrears   = 600,000 + 0 + 600,000                          = 1,200,000
/* ===================================================================== */
const EXPECT = {
  spendable: 1_150_000,
  heldInTrust: 700_000,
  income: 600_000,
  expenses: 450_000,
  funds: 1_000_000,
  arrears: 1_200_000,
  pending: 500_000,
  deposit: 500_000,
  overpayment: 200_000,
  maintenance: 300_000,
  salaries: 150_000,
  unit101Outstanding: 600_000,
  unit102Outstanding: -200_000,
  unit103Outstanding: 600_000,
} as const;

/** '1,750,000 piastres' → the string the page must contain: "17,500.00". */
const asPounds = (piastres: number) =>
  (piastres / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Every `<bdi …>17,500.00</bdi>` on the page, as plain strings. */
const numbersIn = (html: string): string[] =>
  [...html.matchAll(/<bdi[^>]*>([^<]*)<\/bdi>/g)].map(m => m[1]!);

const shows = (html: string, piastres: number) => numbersIn(html).includes(asPounds(piastres));

/**
 * The value printed inside the tile whose label contains `labelAr`.
 *
 * An early draft of this file asserted `!shows(page, wrongTotal)` — "the wrong
 * number must not appear anywhere." That looked rigorous and was not: on a page
 * with a dozen figures, some *correct* number eventually equals some *wrong*
 * one, and the test fails for a reason that has nothing to do with the bug it
 * names. (It did: 700,000 + 500,000 collides with the real 1,200,000 arrears.)
 * Scope the assertion to the tile, then say exactly what the tile must contain.
 */
function tile(html: string, labelAr: string): string | null {
  const i = html.indexOf(labelAr);
  if (i < 0) return null;
  const v = html.indexOf('class="v"', i);
  if (v < 0) return null;
  const m = /<bdi[^>]*>([^<]*)<\/bdi>/.exec(html.slice(v, v + 400));
  return m ? m[1]! : null;
}

let raw: DatabaseSync, db: NodeSqliteDb, app: ReturnType<typeof createApp>;
let adminCtx: AuthContext;
let financeHtml = '', unitsHtml = '', healthHtml = '';

before(async () => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).sort())
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  for (const f of readdirSync(join(ROOT, 'seed/prod')).sort())
    raw.exec(readFileSync(join(ROOT, 'seed/prod', f), 'utf8'));
  const x = (s: string, ...p: unknown[]) => raw.prepare(s).run(...p as never[]);

  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, ADMIN, 'رئيس المجلس', 'admin');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, TREAS, 'أمين الصندوق', 'admin');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, RES1, 'د. سعاد', 'resident');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, OPER, 'مشغّل', 'operator');
  for (const [n, p, tok] of [[1, ADMIN, 'tok-admin'], [2, RES1, 'tok-res'], [3, OPER, 'tok-op']] as const)
    x(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`,
      id('SES', n), p, sha(tok), '2027-01-01T00:00:00Z');

  x(`INSERT INTO buildings (id,code,name_ar) VALUES (?,?,?)`, BLD, '1', 'عمارة 1');
  for (const [u, n] of [[U101, '101'], [U102, '102'], [U103, '103']] as const)
    x(`INSERT INTO units (id,building_id,unit_number) VALUES (?,?,?)`, u, BLD, n);
  x(`INSERT INTO unit_owners (id,unit_id,profile_id,share_bp,is_primary_contact,valid_from)
     VALUES (?,?,?,10000,1,'2020-01-01')`, id('UOW', 1), U101, RES1);

  x(`INSERT INTO fiscal_periods (id,name_ar,starts_on,ends_on,status)
     VALUES (?,?,?,?,'open')`, PERIOD, 'السنة المالية 2026', '2026-01-01', '2026-12-31');
  const cSubs = raw.prepare(`SELECT id FROM categories WHERE kind='operating_income' LIMIT 1`)
    .get() as { id: string };
  // Migration 0022 refuses a due inserted against a PUBLISHED period: a
  // published amount is what a resident was told they owe. So the fixture
  // does what the product does — draft, bill, then publish.
  x(`INSERT INTO fee_periods (id,name_ar,category_id,fiscal_period_id,starts_on,ends_on,
       due_on,basis,amount_piastres,is_published,created_by)
     VALUES (?,?,?,?,'2026-01-01','2026-12-31','2026-03-31','per_unit',600000,0,?)`,
    FEEP, 'اشتراك 2026', cSubs.id, PERIOD, ADMIN);
  for (const [i, u] of [U101, U102, U103].entries())
    x(`INSERT INTO unit_dues (id,fee_period_id,unit_id,amount_piastres) VALUES (?,?,?,600000)`,
      id('DUE', i + 1), FEEP, u);
  x(`UPDATE fee_periods SET is_published=1 WHERE id=?`, FEEP);

  /* Payments.
   *
   * The important one is P_DEP: unit 101 paid its **deposit** and has not paid
   * its subscription. That is an ordinary situation — a new owner pays the
   * الوديعة on handover — and it is the case that breaks a naive arrears
   * calculation, because the money arrived but it was never dues.
   */
  const cDeposit = raw.prepare(`SELECT id FROM categories WHERE kind='deposit' LIMIT 1`)
    .get() as { id: string };
  const pay = (n: number, unit: string, claimed: number, cat: string, feep: string | null) => {
    const pid = id('PAY', n);
    x(`INSERT INTO payments (id,receipt_no,unit_id,submitted_by,category_id,fee_period_id,
         claimed_amount_piastres,method,transfer_date,storage_key,image_sha256,status)
       VALUES (?,?,?,?,?,?,?, 'bank_transfer','2026-04-0${n}',?,?, 'draft')`,
      pid, `R-2026-0000${n}`, unit, RES1, cat, feep, claimed,
      `receipts/${unit}/${pid}.webp`, sha(pid).padEnd(64, '0').slice(0, 64));
    x(`UPDATE payments SET status='submitted', submitted_at='2026-04-05T08:30:00Z' WHERE id=?`, pid);
    return pid;
  };
  const P_SUB = pay(1, U102, 800_000, cSubs.id, FEEP);          // overpays by 200,000
  pay(2, U103, 500_000, cSubs.id, FEEP);                        // ← PENDING. counts nowhere.
  const P_DEP = pay(3, U101, 500_000, cDeposit.id, null);       // ← deposit, not dues

  // The ledger. Posting order matches the app: entry → lines → post.
  const fund = raw.prepare(`SELECT id FROM funds WHERE kind='operating'`).get() as { id: string };
  const dep = raw.prepare(`SELECT id FROM funds WHERE kind='deposit'`).get() as { id: string } | undefined;
  let en = 0, ln = 0;
  const post = (desc: string, date: string, src: string, srcId: string | null,
                rows: Array<[string, string, number, number]>) => {
    en += 1; const eid = id('JE', en);
    x(`INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,
         source_type,source_id,created_by) VALUES (?,?,?,?,?,?,?,?)`,
      eid, `J-2026-${String(en).padStart(6, '0')}`, date, PERIOD, desc, src, srcId, TREAS);
    rows.forEach(([acct, fnd, dr, cr], i) => {
      ln += 1;
      x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,
           debit_piastres,credit_piastres,unit_id) VALUES (?,?,?,?,?,?,?,?)`,
        id('JL', ln), eid, i + 1, acct, fnd, dr, cr,
        src === 'payment' ? (srcId === P_SUB ? U102 : U101) : null);
    });
    x(`UPDATE journal_entries SET approved_by=?, posted_at=? WHERE id=?`,
      ADMIN, `${date}T10:00:00Z`, eid);
    return eid;
  };
  const OP = fund.id, DP = dep?.id ?? fund.id;

  post('رصيد أول المدة', '2026-01-01', 'opening_balance', null, [
    [A_CASH, OP, 1_000_000, 0], [F_OPENING, OP, 0, 1_000_000]]);
  // ⭐ The overpayment splits: only the dues portion is income. The rest is a
  // liability — money the village owes back. R-020's sibling.
  const E_SUB = post('اشتراك شقة 102 مع زيادة', '2026-04-06', 'payment', P_SUB, [
    [A_BANK, OP, 800_000, 0], [I_SUBS, OP, 0, 600_000], [L_CREDIT, OP, 0, 200_000]]);
  // ⭐ الوديعة — a LIABILITY, in the deposit fund. If it ever lands in income,
  // `spendable` is overstated by exactly 500,000 and a test below says so.
  const E_DEP = post('وديعة شقة 101', '2026-05-01', 'payment', P_DEP, [
    [A_BANK, DP, 500_000, 0], [L_DEPOSIT, DP, 0, 500_000]]);
  post('صيانة المصعد', '2026-06-01', 'expense', id('EXP', 1), [
    [E_MAINT, OP, 300_000, 0], [A_BANK, OP, 0, 300_000]]);
  post('مرتبات يونيو', '2026-06-30', 'expense', id('EXP', 2), [
    [E_SALARY, OP, 150_000, 0], [A_CASH, OP, 0, 150_000]]);

  /* Approval comes LAST, and carries the journal entry with it.
   *
   * The fixture originally approved a payment and posted the ledger separately,
   * and `CHECK (status <> 'approved' OR journal_entry_id IS NOT NULL)` refused
   * it. That constraint is why "approved money that never reached the ledger"
   * is not a state this system can be in — the exact discrepancy an annual
   * audit exists to find. The state machine likewise refuses
   * submitted → approved directly, so the fixture goes through `under_review`
   * exactly as a real reviewer must. */
  const approve = (pid: string, amount: number, eid: string) => {
    x(`UPDATE payments SET status='under_review', reviewed_by=? WHERE id=?`, ADMIN, pid);
    x(`UPDATE payments SET status='approved', approved_amount_piastres=?, journal_entry_id=?,
         reviewed_by=?, reviewed_at='2026-04-06T09:00:00Z' WHERE id=?`, amount, eid, ADMIN, pid);
  };
  approve(P_SUB, 800_000, E_SUB);
  approve(P_DEP, 500_000, E_DEP);

  x(`UPDATE settings SET unit_status_public = 1 WHERE id = 1`);

  db = new NodeSqliteDb(raw as never);
  const storage = new D1BlobStorage(db);
  app = createApp({ db, now: NOW, storage, rp: RP,
    storagePut: i => storage.put(i), storageUsedBytes: () => storage.usedBytes() });
  adminCtx = (await resolveAuthContext(db, 'tok-admin', NOW))!;

  const get = async (p: string) => {
    const r = await app.request(p, { headers: { authorization: 'Bearer tok-admin' } });
    assert.equal(r.status, 200, `${p} returned ${r.status}`);
    return r.text();
  };
  financeHtml = await get('/finance');
  unitsHtml = await get('/finance/units');
  healthHtml = await get('/admin/health');
});

/* ================================================================== */
describe('GATE: every displayed figure matches a hand-computed value', () => {

  it('the four headline tiles are all correct', () => {
    assert.equal(tile(financeHtml, t.finance.spendable), asPounds(EXPECT.spendable),
      'الفلوس المتاحة للصرف');
    assert.equal(tile(financeHtml, t.finance.heldInTrust), asPounds(EXPECT.heldInTrust),
      'ودائع وأرصدة للملاك');
    assert.equal(tile(financeHtml, t.finance.pending), asPounds(EXPECT.pending),
      'إيصالات تحت المراجعة');
    assert.equal(tile(financeHtml, t.finance.arrears), asPounds(EXPECT.arrears),
      'متأخرات مطلوبة');
  });

  it('⭐ the deposit is held in trust, NOT spendable (R-020)', () => {
    // Booked to income instead, spendable would read 1,650,000 and
    // held-in-trust 200,000. Both tiles are checked, so either mistake shows.
    assert.equal(tile(financeHtml, t.finance.spendable), asPounds(EXPECT.spendable),
      'spendable is overstated — الوديعة has been treated as the village\'s money');
    assert.equal(tile(financeHtml, t.finance.heldInTrust),
      asPounds(EXPECT.deposit + EXPECT.overpayment),
      'held-in-trust does not contain the deposit AND the owner credit');
  });

  it('⭐ the overpayment is owed back, not earned', () => {
    // 102 transferred 800,000 against a 600,000 due. Income must be 600,000
    // exactly; the extra 200,000 belongs in liabilities.
    assert.ok(financeHtml.includes(asPounds(EXPECT.income)), 'income is not 6,000.00');
    assert.ok(!financeHtml.includes(`${t.finance.totalIncome} <bdi dir="ltr" class="num">${asPounds(EXPECT.income + EXPECT.overpayment)}`),
      'the 200,000 overpayment was counted as income');
  });

  it('⭐ the pending receipt contributes ZERO to every total (C5)', () => {
    // It is shown, labelled, and excluded — all three.
    assert.equal(tile(financeHtml, t.finance.pending), asPounds(EXPECT.pending),
      'the pending receipt is not shown at all');
    assert.match(financeHtml, /مش محسوبة في الإيرادات/,
      'pending is shown without saying it is excluded');
    assert.equal(tile(financeHtml, t.finance.spendable), asPounds(EXPECT.spendable),
      'spendable moved when a receipt was merely submitted');
    // 103 submitted 500,000 against a 600,000 due and it must still owe all of it.
    assert.ok(shows(unitsHtml, EXPECT.unit103Outstanding),
      'a pending receipt reduced a unit\'s arrears');
  });

  it('⭐ a deposit does not pay a subscription — the bug 0011 fixed', () => {
    // Unit 101 paid its 5,000 deposit and NOTHING toward its 6,000 subscription.
    // Before migration 0011 this flat reported 1,000.00 outstanding.
    assert.ok(!shows(unitsHtml, 100_000),
      'unit 101 shows 1,000.00 outstanding — its deposit was counted as subscription');
    assert.ok(shows(unitsHtml, EXPECT.unit101Outstanding),
      'unit 101 does not show the full 6,000.00 it still owes');
    assert.equal(tile(financeHtml, t.finance.arrears), asPounds(EXPECT.arrears),
      'the headline arrears figure is understated by the deposit pool');
  });

  it('income, expenses and opening balance are correct', () => {
    assert.ok(shows(financeHtml, EXPECT.income), 'total income wrong');
    assert.ok(shows(financeHtml, EXPECT.expenses), 'total expense wrong');
    assert.ok(shows(financeHtml, EXPECT.funds), 'opening balance wrong');
  });

  it('the expense breakdown adds up to the expense total', () => {
    assert.ok(shows(financeHtml, EXPECT.maintenance), 'maintenance category wrong');
    assert.ok(shows(financeHtml, EXPECT.salaries), 'salaries category wrong');
    assert.equal(EXPECT.maintenance + EXPECT.salaries, EXPECT.expenses);
    // Invariant 4 rendered: the shares must be printed, and must be the real ones.
    assert.match(financeHtml, /67%/, 'maintenance share not shown as 67%');
    assert.match(financeHtml, /33%/, 'salaries share not shown as 33%');
  });

  it('"شوف الأرقام" gives the same numbers as the chart, with no JavaScript', () => {
    assert.match(financeHtml, /<details>[\s\S]*?شوف الأرقام/,
      'the numbers table is not a <details> element — it would need JS to open');
    const table = financeHtml.slice(financeHtml.indexOf('<details>'));
    assert.ok(table.includes(asPounds(EXPECT.maintenance)), 'table disagrees with the bar');
    assert.ok(table.includes(asPounds(EXPECT.salaries)), 'table disagrees with the bar');
  });

  it('per-unit outstanding is right, and a credit is not shown as debt', () => {
    assert.ok(shows(unitsHtml, EXPECT.unit103Outstanding), '103 arrears wrong');
    // 102 overpaid. The page must show 2,000.00 with a CREDIT chip, never "−2,000".
    assert.ok(shows(unitsHtml, Math.abs(EXPECT.unit102Outstanding)), '102 credit amount missing');
    assert.ok(!unitsHtml.includes(`-${asPounds(Math.abs(EXPECT.unit102Outstanding))}`),
      'an owner credit is rendered as a negative arrears figure');
    assert.match(unitsHtml, /رصيد دائن/, 'the credit is not labelled');
    assert.match(unitsHtml, /خالص/, 'the settled unit is not labelled');
  });

  it('the unit table leaks no name, phone or receipt', () => {
    for (const secret of ['د. سعاد', '+2010', 'receipts/', 'PAY0'])
      assert.ok(!unitsHtml.includes(secret), `/finance/units leaked ${secret}`);
  });
});

/* ================================================================== */
describe('GATE: raw SQL agrees with the app, exactly', () => {
  /**
   * Computed from BASE TABLES — journal_lines joined to accounts — not from
   * the views the app reads. Two independent paths to one number is the oldest
   * control in accounting, and the only reason this second one is worth writing
   * is that it shares no code with the first.
   */
  const bal = (type: string, excludeReceivables = false) => (raw.prepare(
    `SELECT COALESCE(SUM(CASE WHEN a.normal_balance='debit'
                THEN l.debit_piastres - l.credit_piastres
                ELSE l.credit_piastres - l.debit_piastres END), 0) AS v
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id AND e.posted_at IS NOT NULL
       JOIN accounts a ON a.id = l.account_id
      WHERE a.type = ?${excludeReceivables ? " AND a.code NOT LIKE '13%'" : ''}`)
    .get(type) as { v: number }).v;

  it('assets, liabilities, income, expenses and funds match the literals', () => {
    assert.equal(bal('asset', true), 1_850_000, 'raw asset total');
    assert.equal(bal('liability'), EXPECT.heldInTrust, 'raw liability total');
    assert.equal(bal('income'), EXPECT.income, 'raw income total');
    assert.equal(bal('expense'), EXPECT.expenses, 'raw expense total');
    assert.equal(bal('fund'), EXPECT.funds, 'raw fund total');
  });

  it('raw spendable == the figure on the page', () => {
    const spendable = bal('asset', true) - bal('liability');
    assert.equal(spendable, EXPECT.spendable);
    assert.ok(shows(financeHtml, spendable), 'the page disagrees with raw SQL');
  });

  it('raw arrears == the figure on the page', () => {
    const rows = raw.prepare(
      `SELECT u.id,
              COALESCE((SELECT SUM(d.amount_piastres - d.waived_piastres) FROM unit_dues d
                          JOIN fee_periods f ON f.id = d.fee_period_id AND f.is_published = 1
                         WHERE d.unit_id = u.id), 0)
            - COALESCE((SELECT SUM(p.approved_amount_piastres) FROM payments p
                          JOIN fee_periods f2 ON f2.id = p.fee_period_id AND f2.is_published = 1
                         WHERE p.unit_id = u.id AND p.status = 'approved'), 0) AS out
         FROM units u WHERE u.is_active = 1`).all() as Array<{ out: number }>;
    const arrears = rows.reduce((a, r) => a + Math.max(0, r.out), 0);
    assert.equal(arrears, EXPECT.arrears);
    assert.ok(shows(financeHtml, arrears), 'the arrears tile disagrees with raw SQL');
  });

  it('the ledger balances, and that is still not proof of correctness', () => {
    const residual = bal('asset') - (bal('liability') + bal('fund') + bal('income') - bal('expense'));
    assert.equal(residual, 0);
    // ADR-018: this passing means the entries were balanced, nothing more. The
    // three ⭐ tests above are what actually catch a misbooking.
  });

  it('every posted entry is balanced on its own', () => {
    const bad = raw.prepare(
      `SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
        WHERE e.posted_at IS NOT NULL
        GROUP BY e.id HAVING SUM(l.debit_piastres) <> SUM(l.credit_piastres)`).all();
    assert.equal(bad.length, 0, 'an unbalanced entry is posted');
  });
});

/* ================================================================== */
describe('/admin/health — the cost control, C11', () => {

  it('an operator cannot see it', async () => {
    const r = await app.request('/admin/health', { headers: { authorization: 'Bearer tok-op' } });
    assert.equal(r.status, 403);
  });

  it('a resident cannot see it either', async () => {
    const r = await app.request('/admin/health', { headers: { authorization: 'Bearer tok-res' } });
    assert.equal(r.status, 403);
  });

  it('an unmeasurable quota renders as "—", never as 0%', () => {
    // Workers requests and KV writes cannot be read from inside a Worker.
    // Showing them as an empty green bar would be a lie that reassures.
    assert.match(healthHtml, /Cloudflare Workers/);
    assert.match(healthHtml, /—/, 'no unmeasured row is marked as unknown');
    const zeroBars = [...healthHtml.matchAll(/inline-size:0\.00%/g)];
    assert.equal(zeroBars.length, 0, 'an unmeasured quota was drawn as a 0% bar');
  });

  it('it states that no service can bill us', () => {
    assert.match(healthHtml, /مفيش أي كارت بنكي/, 'the zero-cost claim is not stated');
  });

  it('the measured rows really are measured', async () => {
    const q = await getQuotaUsage(adminCtx, db);
    const measured = q.rows.filter(r => r.measured);
    assert.ok(measured.length >= 3, 'almost nothing is actually measured');
    for (const r of measured) assert.notEqual(r.used, null, `${r.metricAr} claims measured but is null`);
    for (const r of q.rows.filter(r => !r.measured))
      assert.equal(r.used, null, `${r.metricAr} is declared but reports a number`);
  });

  it('nothing in the stack can bill us — asserted, not assumed', async () => {
    const q = await getQuotaUsage(adminCtx, db);
    assert.equal(q.capOnFile, false);
    const billable = q.rows.filter(r => r.canBill);
    assert.deepEqual(billable, [], `a billable service is in the stack: ${billable.map(r => r.service)}`);
  });

  it('an empty database is 0% used, not an error', async () => {
    const q = await getQuotaUsage(adminCtx, db);
    assert.equal(q.overThreshold, 0, 'a fresh database is already over a quota threshold');
  });
});

/* ================================================================== */
describe('the units page respects the assembly gate — Q11 / R-002', () => {

  it('a resident sees the table only while the setting is on', async () => {
    const on = await app.request('/finance/units', { headers: { authorization: 'Bearer tok-res' } });
    assert.equal(on.status, 200);
    assert.match(await on.text(), /الشقة/);

    raw.prepare(`UPDATE settings SET unit_status_public = 0 WHERE id = 1`).run();
    const off = await app.request('/finance/units', { headers: { authorization: 'Bearer tok-res' } });
    // A refusal, not a 403: the resident is told WHY, in Arabic, on a real page.
    assert.equal(off.status, 200);
    const body = await off.text();
    assert.match(body, /الجمعية العمومية/, 'the lock is not explained');
    assert.ok(!body.includes(asPounds(EXPECT.unit103Outstanding)),
      'the table was hidden but the numbers still shipped in the HTML');
    raw.prepare(`UPDATE settings SET unit_status_public = 1 WHERE id = 1`).run();
  });

  it('an admin still sees it while it is locked to residents', async () => {
    raw.prepare(`UPDATE settings SET unit_status_public = 0 WHERE id = 1`).run();
    const r = await app.request('/finance/units', { headers: { authorization: 'Bearer tok-admin' } });
    const body = await r.text();
    assert.ok(body.includes(asPounds(EXPECT.unit103Outstanding)),
      'the board cannot see collection status even for themselves');
    raw.prepare(`UPDATE settings SET unit_status_public = 1 WHERE id = 1`).run();
  });
});

/* ================================================================== */
describe('the deposit fund is watched, and says so out loud', () => {

  it('an intact deposit fund is stated on the page, not left silent', () => {
    // Rendered ALWAYS, not only on failure. A control the board has never seen
    // is one they cannot notice the disappearance of — and R-043's whole lesson
    // is that a check living only in a test file protects nobody.
    assert.match(financeHtml, /صندوق الودائع كامل/,
      'the deposit fund is checked but the page never says so');
    assert.ok(!financeHtml.includes('صندوق الودائع ناقص'),
      'a healthy deposit fund was reported as short');
  });

  it('⭐ spending trust money raises a specific, quantified alarm', async () => {
    // Move 100,000 out of the deposit fund into an operating expense — exactly
    // what "we used the deposits to pay the guards this month" looks like in a
    // ledger that otherwise balances perfectly.
    const x = (q: string, ...p: unknown[]) => raw.prepare(q).run(...p as never[]);
    const DP = (raw.prepare(`SELECT id FROM funds WHERE kind='deposit'`).get() as { id: string }).id;
    const eid = id('JE', 80);
    x(`INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,
         source_type,source_id,created_by) VALUES (?,'J-80','2026-07-01',?,'مرتبات من فلوس الودائع',
         'expense',?,?)`, eid, PERIOD, id('EXP', 9), TREAS);
    x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,credit_piastres)
       VALUES (?,?,1,?,?,100000,0)`, id('JL', 80), eid, E_SALARY, DP);
    x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,credit_piastres)
       VALUES (?,?,2,?,?,0,100000)`, id('JL', 81), eid, A_BANK, DP);
    x(`UPDATE journal_entries SET approved_by=?, posted_at='2026-07-01T10:00:00Z' WHERE id=?`, ADMIN, eid);

    const r = await app.request('/finance', { headers: { authorization: 'Bearer tok-admin' } });
    const body = await r.text();
    assert.match(body, /صندوق الودائع ناقص/, 'trust money was spent and the page said nothing');
    assert.ok(body.includes(asPounds(100_000)),
      'the alarm does not name the amount — "something is wrong" is not actionable');

    // And the equation still balances, which is precisely why this needed its
    // own check: nothing else on the page moved. (ADR-018)
    const residual = raw.prepare(`SELECT residual_piastres r FROM v_accounting_equation`)
      .get() as { r: number };
    assert.equal(residual.r, 0, 'the ledger is unbalanced — wrong bug');
  });
});

/* ================================================================== */
describe('R-052 — the resident can still see their own deposit', () => {
  /**
   * A gap this project CREATED. Migration 0011 correctly stopped deposits
   * counting toward subscription dues. The migration's own comment promised the
   * deposit would stay "separate and visible… so a resident who paid a deposit
   * can see it acknowledged instead of wondering where it went." It was never
   * surfaced. Unit 101 paid 5,000 ج.م and their home screen said they had paid
   * nothing — the same failure this whole audit is about, committed by the fix.
   */
  it('unit 101 paid only a deposit — the home screen must acknowledge it', async () => {
    const r = await app.request('/', { headers: { authorization: 'Bearer tok-res' } });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /وديعتك المحفوظة/, "the resident's deposit is invisible on their own screen");
    assert.ok(body.includes(asPounds(EXPECT.deposit)),
      'the deposit is mentioned without its amount');
    assert.match(body, /أمانة بتترد لك/,
      'the deposit is shown without saying it is refundable and not part of the subscription');
  });

  it('...and it is still NOT counted as paying the subscription', async () => {
    const r = await app.request('/', { headers: { authorization: 'Bearer tok-res' } });
    const body = await r.text();
    // The 6,000 due is still fully outstanding. Showing the deposit must not
    // quietly undo the fix that made it not count.
    assert.ok(body.includes(asPounds(EXPECT.unit101Outstanding)),
      'surfacing the deposit reintroduced R-043 on the home screen');
    assert.ok(!/خالص/.test(body), 'a unit that paid only a deposit is shown as settled');
  });
});
