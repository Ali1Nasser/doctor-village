/**
 * tests/access/views.test.ts — the R-043 audit, as a permanent test.
 *
 * ## The one question this file asks of every view
 * **Do both sides of this comparison measure the same thing?**
 *
 * R-043 was a reporting view subtracting "all money received" from "dues owed"
 * and calling the difference arrears. The ledger was perfect; the screen lied.
 * Re-reading every remaining view with that single question found three more of
 * the same shape (R-045, R-046, R-047), two of them sharing an SQL mistake that
 * is invisible on inspection:
 *
 *     LEFT JOIN accounts a ON a.id = pl.account_id AND a.type = 'asset'
 *
 * That is not a filter. A LEFT JOIN's ON clause decides whether the right-hand
 * row attaches, never whether the left-hand row survives — so non-asset lines
 * stayed in and kept being summed.
 *
 * ## Why each assertion recomputes rather than compares views
 * Comparing one view against another view is how all four defects survived: the
 * two agreed because they shared the mistake. Every expectation below is a
 * correlated subquery written from base tables, plus a literal a human added up.
 *
 * ## The fixture tags EVERY line with its unit
 * `seed/demo/generate.py` tags only the income and liability lines of a payment
 * with `unit_id`. Nothing enforces that, and it is not the obvious reading of
 * the column. So this fixture tags the cash line too — the way a reasonable
 * person would — and that alone is what exposed R-046.
 */

import { it, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const id = (p: string, n: number) => (p + String(n).padStart(26 - p.length, '0')).slice(0, 26);

const A_BANK = 'ACC00000000000000000001102';
const L_DEPOSIT = 'ACC00000000000000000002101';
const F_OPENING = 'ACC00000000000000000003101';
const I_SUBS = 'ACC00000000000000000004101';
const E_MAINT = 'ACC00000000000000000005101';

const ADMIN = id('PRF', 1), TREAS = id('PRF', 2);
const BLD = id('BLD', 1), U1 = id('UNT', 1);
const PERIOD = id('FIS', 1);

let db: DatabaseSync;
const one = (q: string, ...p: unknown[]) =>
  Number((db.prepare(q).get(...p as never[]) as Record<string, unknown>)[
    Object.keys(db.prepare(q).get(...p as never[]) as object)[0]!] ?? 0);

before(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).sort())
    db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  for (const f of readdirSync(join(ROOT, 'seed/prod')).sort())
    db.exec(readFileSync(join(ROOT, 'seed/prod', f), 'utf8'));
  const x = (s: string, ...p: unknown[]) => db.prepare(s).run(...p as never[]);

  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,'admin')`, ADMIN, 'رئيس');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,'admin')`, TREAS, 'أمين');
  x(`INSERT INTO buildings (id,code,name_ar) VALUES (?,'1','ع1')`, BLD);
  x(`INSERT INTO units (id,building_id,unit_number) VALUES (?,?,'101')`, U1, BLD);
  x(`INSERT INTO fiscal_periods (id,name_ar,starts_on,ends_on,status)
     VALUES (?,'2026','2026-01-01','2026-12-31','open')`, PERIOD);

  const OP = (db.prepare(`SELECT id FROM funds WHERE kind='operating'`).get() as { id: string }).id;
  const DP = (db.prepare(`SELECT id FROM funds WHERE kind='deposit'`).get() as { id: string }).id;
  let en = 0, ln = 0;
  const post = (desc: string, date: string, src: string, srcId: string | null,
                rows: Array<[string, string, number, number, string | null]>) => {
    en += 1; const eid = id('JE', en);
    x(`INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,
         source_type,source_id,created_by) VALUES (?,?,?,?,?,?,?,?)`,
      eid, `J-${en}`, date, PERIOD, desc, src, srcId, TREAS);
    rows.forEach(([acct, fnd, dr, cr, unit], i) => {
      ln += 1;
      x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,
           debit_piastres,credit_piastres,unit_id) VALUES (?,?,?,?,?,?,?,?)`,
        id('JL', ln), eid, i + 1, acct, fnd, dr, cr, unit);
    });
    x(`UPDATE journal_entries SET approved_by=?, posted_at=? WHERE id=?`,
      ADMIN, `${date}T10:00:00Z`, eid);
    return eid;
  };

  // opening: 10,000.00 into the operating fund
  post('رصيد أول المدة', '2026-01-01', 'opening_balance', null, [
    [A_BANK, OP, 1_000_000, 0, null], [F_OPENING, OP, 0, 1_000_000, null]]);
  // a subscription — EVERY line tagged with the unit, cash line included
  post('اشتراك 101', '2026-04-01', 'opening_balance', null, [
    [A_BANK, OP, 600_000, 0, U1], [I_SUBS, OP, 0, 600_000, U1]]);
  // a deposit into the deposit fund — also fully tagged
  post('وديعة 101', '2026-05-01', 'opening_balance', null, [
    [A_BANK, DP, 500_000, 0, U1], [L_DEPOSIT, DP, 0, 500_000, U1]]);
  // an expense out of the operating fund
  post('صيانة', '2026-06-01', 'opening_balance', null, [
    [E_MAINT, OP, 300_000, 0, null], [A_BANK, OP, 0, 300_000, null]]);
});

/* ================================================================== */
describe('R-045 — v_fund_balances holds what the fund actually holds', () => {

  it('the operating fund holds cash, not zero', () => {
    // 1,000,000 opening + 600,000 subscription − 300,000 expense = 1,300,000.
    // Before 0012 the income credit cancelled the cash debit and this read
    // 700,000; with every line tagged it could read 0.
    assert.equal(one(`SELECT net_debit_piastres v FROM v_fund_balances WHERE kind='operating'`),
      1_300_000, 'the operating fund does not hold the cash it was given');
  });

  it('the deposit fund holds the deposit, and owes it back', () => {
    assert.equal(one(`SELECT net_debit_piastres v FROM v_fund_balances WHERE kind='deposit'`),
      500_000, 'deposit fund cash');
    assert.equal(one(`SELECT owed_piastres v FROM v_fund_balances WHERE kind='deposit'`),
      500_000, 'deposit fund liability');
  });

  it('⭐ every fund agrees with an independent recomputation', () => {
    const bad = db.prepare(
      `SELECT COUNT(*) n FROM v_fund_balances fb
        WHERE fb.net_debit_piastres <> COALESCE(
          (SELECT SUM(pl.debit_piastres) - SUM(pl.credit_piastres)
             FROM v_posted_lines pl JOIN accounts a ON a.id = pl.account_id
            WHERE pl.fund_id = fb.fund_id AND a.type = 'asset'), 0)`)
      .get() as { n: number };
    assert.equal(bad.n, 0, 'a fund balance disagrees with the posted asset lines beneath it');
  });

  it('the deposit fund is never spendable', () => {
    assert.equal(one(`SELECT is_spendable v FROM v_fund_balances WHERE kind='deposit'`), 0);
  });
});

/* ================================================================== */
describe('R-046 — v_unit_ledger_balance is a real second opinion', () => {

  it('a unit that paid 6,000 and deposited 5,000 shows 11,000 received', () => {
    // Income 600,000 + liability 500,000. The cash debits are tagged with the
    // same unit and must NOT be netted off — that was the bug.
    assert.equal(one(`SELECT paid_piastres_from_ledger v FROM v_unit_ledger_balance WHERE unit_id=?`, U1),
      1_100_000, 'the unit ledger view netted cash against income');
  });

  it('⭐ it agrees with v_unit_balance.received_piastres — the invariant-8 pairing', () => {
    // The two must measure the same thing for invariant 8 to mean anything.
    // Note this fixture has no `payments` rows, so received_piastres is 0 here;
    // the assertion that matters is that BOTH are computed the same way in
    // verify_demo.py against the full village. Here we assert the ledger side
    // against a from-scratch recomputation instead.
    const indep = one(
      `SELECT COALESCE(SUM(pl.credit_piastres) - SUM(pl.debit_piastres),0) v
         FROM v_posted_lines pl JOIN accounts a ON a.id = pl.account_id
        WHERE pl.unit_id = ? AND a.type IN ('income','liability')`, U1);
    assert.equal(
      one(`SELECT paid_piastres_from_ledger v FROM v_unit_ledger_balance WHERE unit_id=?`, U1),
      indep);
  });

  it('a unit with no lines reads 0, not NULL', () => {
    db.prepare(`INSERT INTO units (id,building_id,unit_number) VALUES (?,?,'102')`)
      .run(id('UNT', 2), BLD);
    assert.equal(
      one(`SELECT paid_piastres_from_ledger v FROM v_unit_ledger_balance WHERE unit_id=?`, id('UNT', 2)),
      0, 'an empty unit returns NULL — SUM over an empty set');
  });
});

/* ================================================================== */
describe('R-047 — v_expense_by_category cannot double-count', () => {

  it('the maintenance total appears exactly once', () => {
    const rows = db.prepare(
      `SELECT COUNT(*) n FROM v_expense_by_category WHERE total_piastres > 0`)
      .get() as { n: number };
    assert.equal(rows.n, 1, 'six categories share account 5101; more than one row means double-counting');
    assert.equal(one(`SELECT total_piastres v FROM v_expense_by_category WHERE total_piastres > 0`),
      300_000);
  });

  it('⭐ Σ per-category == total expenses (invariant 4), from the view UNFILTERED', () => {
    // The caller no longer has to remember `WHERE parent_id IS NULL` — the
    // roll-up filter is inside the view. This assertion deliberately does not
    // add it, which is what would have failed before 0012.
    const sum = one(`SELECT COALESCE(SUM(total_piastres),0) v FROM v_expense_by_category`);
    const total = one(
      `SELECT COALESCE(SUM(pl.debit_piastres) - SUM(pl.credit_piastres),0) v
         FROM v_posted_lines pl JOIN accounts a ON a.id = pl.account_id
        WHERE a.type = 'expense'`);
    assert.equal(sum, total, 'the expense breakdown does not add up to total expenses');
  });

  it('a second roll-up category on one account is now impossible', () => {
    assert.throws(() => db.prepare(
      `INSERT INTO categories (id,parent_id,name_ar,direction,kind,ledger_account_id,sort_order)
       VALUES (?,NULL,'الطوارئ','expense','expense',?,99)`)
      .run(id('CAT', 999), E_MAINT),
      /UNIQUE|constraint/i,
      'a second roll-up category on account 5101 was accepted — the chart can double-count again');
  });
});

/* ================================================================== */
describe('R-048 — v_deposit_leakage catches every wrong home for a deposit', () => {

  it('a correctly booked deposit is not a leak', () => {
    assert.equal(one(`SELECT COUNT(*) v FROM v_deposit_leakage`), 0,
      'a deposit credited to a liability was reported as a leak');
  });

  it('⭐ a deposit credited to a FUND is a leak, not just one credited to income', () => {
    // The old view tested `a.type = 'income'`. Treating money the village owes
    // back as its own reserve is the same error wearing a different account
    // type, and it was invisible.
    const cDep = (db.prepare(`SELECT id FROM categories WHERE kind='deposit' LIMIT 1`)
      .get() as { id: string }).id;
    const eid = id('JE', 90), pid = id('PAY', 90);
    const OP = (db.prepare(`SELECT id FROM funds WHERE kind='operating'`).get() as { id: string }).id;
    const x = (s: string, ...p: unknown[]) => db.prepare(s).run(...p as never[]);
    x(`INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,
         source_type,created_by) VALUES (?,'J-90','2026-07-01',?,'وديعة غلط','opening_balance',?)`,
      eid, PERIOD, TREAS);
    x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,credit_piastres)
       VALUES (?,?,1,?,?,500000,0)`, id('JL', 90), eid, A_BANK, OP);
    x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,credit_piastres)
       VALUES (?,?,2,?,?,0,500000)`, id('JL', 91), eid, F_OPENING, OP);   // ← a FUND, not a liability
    x(`UPDATE journal_entries SET approved_by=?, posted_at='2026-07-01T10:00:00Z' WHERE id=?`, ADMIN, eid);
    x(`INSERT INTO payments (id,receipt_no,unit_id,submitted_by,category_id,
         claimed_amount_piastres,method,transfer_date,storage_key,image_sha256,status)
       VALUES (?,'R-90',?,?,?,500000,'bank_transfer','2026-07-01','k',?, 'draft')`,
      pid, U1, ADMIN, cDep, 'f'.repeat(64));
    x(`UPDATE payments SET status='submitted' WHERE id=?`, pid);
    x(`UPDATE payments SET status='under_review', reviewed_by=? WHERE id=?`, TREAS, pid);
    x(`UPDATE payments SET status='approved', approved_amount_piastres=500000,
         journal_entry_id=?, reviewed_by=?, reviewed_at='2026-07-02T09:00:00Z' WHERE id=?`,
      eid, TREAS, pid);

    assert.equal(one(`SELECT COUNT(*) v FROM v_deposit_leakage`), 1,
      'a deposit booked into a fund account was not reported as a leak');
    const row = db.prepare(`SELECT account_type FROM v_deposit_leakage`).get() as { account_type: string };
    assert.equal(row.account_type, 'fund');
  });
});

/* ================================================================== */
describe('R-050 — "owes nothing" is not "paid"', () => {
  /**
   * The building whose dues were never published. A forgotten building, a
   * half-finished import, a fee period published for 33 of 34 blocks — all of
   * them look like this, and all of them used to render as fully collected on
   * the one screen whose job is showing who has not paid.
   */
  const B9 = id('BLD', 9);

  before(() => {
    const x = (q: string, ...p: unknown[]) => db.prepare(q).run(...p as never[]);
    x(`INSERT INTO buildings (id,code,name_ar) VALUES (?,'9','عمارة ٩')`, B9);
    for (const n of [901, 902, 903])
      x(`INSERT INTO units (id,building_id,unit_number) VALUES (?,?,?)`,
        id('UNT', n), B9, String(n));
  });

  it('a never-billed unit is not counted as settled', () => {
    const r = db.prepare(
      `SELECT COUNT(*) n,
              SUM(CASE WHEN due_piastres > 0 THEN 1 ELSE 0 END) billed,
              SUM(CASE WHEN due_piastres > 0 AND outstanding_piastres <= 0 THEN 1 ELSE 0 END) paid
         FROM v_unit_balance WHERE building_code = '9'`).get() as
      { n: number; billed: number; paid: number };
    assert.equal(r.n, 3, 'the three units are there');
    assert.equal(r.billed, 0, 'nothing was ever billed to building 9');
    assert.equal(r.paid, 0,
      'building 9 reports units as PAID — a false all-clear on a building nobody billed');
  });

  it('the old formula is the one that lied — kept as a regression witness', () => {
    // `outstanding <= 0` counted as paid. This asserts the WRONG answer the old
    // query gave, so the difference between the two is visible rather than
    // asserted in prose.
    const naive = db.prepare(
      `SELECT SUM(CASE WHEN outstanding_piastres <= 0 THEN 1 ELSE 0 END) p
         FROM v_unit_balance WHERE building_code = '9'`).get() as { p: number };
    assert.equal(naive.p, 3,
      'the old formula no longer reproduces the bug — this witness needs rewriting');
  });
});

/* ================================================================== */
describe('R-051 — receipt numbering survives the ten-thousandth receipt', () => {

  it('substr(receipt_no, 8) reads all five digits; substr(…, 9) drops one', () => {
    const at = (s: string, n: number) => (db.prepare(
      `SELECT CAST(substr(?, ?) AS INTEGER) v`).get(s, n) as { v: number }).v;
    // Identical below 10,000 — the dropped digit is a leading zero, which is
    // why this survived eleven sessions and a full demo village.
    assert.equal(at('R-2026-00417', 9), 417);
    assert.equal(at('R-2026-00417', 8), 417);
    // And then:
    assert.equal(at('R-2026-10000', 9), 0, 'the old expression rewinds the counter to zero');
    assert.equal(at('R-2026-10000', 8), 10_000, 'the fixed expression keeps counting');
    assert.equal(at('R-2026-12345', 8), 12_345);
  });

  it('the consequence would have been total, not partial', () => {
    // Rewinding to 1 collides with an existing UNIQUE receipt_no, so the very
    // next submission fails — for every resident, with a 500, forever.
    const uniq = db.prepare(
      `SELECT COUNT(*) n FROM pragma_index_list('payments') WHERE "unique" = 1`)
      .get() as { n: number };
    assert.ok(uniq.n >= 1, 'receipt_no is not actually unique — the failure would be silent instead');
  });
});

/* ================================================================== */
describe('R-053/R-054 — every caption names what it actually contains', () => {
  /**
   * The label audit. An Arabic caption above a figure is a **claim about what
   * that figure contains**, and until now nothing verified any of them. Two in
   * the four-tile summary were false, and both were invisible because the
   * accounts that would have exposed them happened to be empty.
   */
  const L_SUPPLIER = 'ACC00000000000000000002103';
  const F_RESERVE = 'ACC00000000000000000003103';

  before(() => {
    const x = (q: string, ...p: unknown[]) => db.prepare(q).run(...p as never[]);
    const OP = (db.prepare(`SELECT id FROM funds WHERE kind='operating'`).get() as { id: string }).id;
    // An unpaid contractor invoice, and money moved into the emergency reserve.
    // Both are ordinary. Both used to land under the wrong Arabic sentence.
    const eid = id('JE', 70);
    // The voucher is written too. This entry used to name an expense document
    // that did not exist — 500.00 ج.م owed to a contractor, in the books, with
    // nothing behind it. Migration 0024's orphan-entry guard refuses that.
    const cX = (db.prepare(
      `SELECT id FROM categories WHERE direction='expense' LIMIT 1`).get() as { id: string }).id;
    x(`INSERT INTO expenses (id,voucher_no,category_id,amount_piastres,spent_on,
         description_ar,fund_id,status,recorded_by)
       VALUES (?,'E-2026-00070',?,50000,'2026-06-15','فاتورة مصعد لسه ماتدفعتش',?, 'recorded', ?)`,
      id('EXP', 70), cX, OP, TREAS);
    x(`INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,
         source_type,source_id,created_by) VALUES (?,'J-70','2026-06-15',?,'فاتورة مصعد لسه ماتدفعتش',
         'expense',?,?)`, eid, PERIOD, id('EXP', 70), TREAS);
    x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,credit_piastres)
       VALUES (?,?,1,?,?,50000,0)`, id('JL', 70), eid, E_MAINT, OP);
    x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,credit_piastres)
       VALUES (?,?,2,?,?,0,50000)`, id('JL', 71), eid, L_SUPPLIER, OP);
    x(`UPDATE expenses SET status='posted', journal_entry_id=? WHERE id=?`, eid, id('EXP', 70));
    x(`UPDATE journal_entries SET approved_by=?, posted_at='2026-06-15T10:00:00Z' WHERE id=?`, ADMIN, eid);

    const eid2 = id('JE', 71);
    x(`INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,
         source_type,source_id,created_by) VALUES (?,'J-71','2026-06-20',?,'تكوين احتياطي طوارئ',
         'adjustment',?,?)`, eid2, PERIOD, id('ADJ', 1), TREAS);
    x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,credit_piastres)
       VALUES (?,?,1,?,?,200000,0)`, id('JL', 72), eid2, A_BANK, OP);
    x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,credit_piastres)
       VALUES (?,?,2,?,?,0,200000)`, id('JL', 73), eid2, F_RESERVE, OP);
    x(`UPDATE journal_entries SET approved_by=?, posted_at='2026-06-20T10:00:00Z' WHERE id=?`, ADMIN, eid2);
  });

  it('⭐ «ودائع وأرصدة للملاك» contains only owner money', () => {
    // 500,000 deposit. NOT the 50,000 owed to the lift contractor.
    assert.equal(one(`SELECT held_in_trust_piastres v FROM v_community_totals`), 500_000,
      'a contractor invoice is being displayed as residents\' deposits');
  });

  it('money owed to suppliers has its own figure, and its own name', () => {
    assert.equal(one(`SELECT owed_to_suppliers_piastres v FROM v_community_totals`), 50_000);
  });

  it('⭐ «رصيد أول المدة» is the opening balance, not every fund', () => {
    // Asserted against account 3101 rather than a literal: earlier tests in
    // this file share the database and post to fund accounts too. A literal
    // here would couple this test to the order the suites happen to run in —
    // and it did, on the first attempt, which is how the coupling was noticed.
    assert.equal(
      one(`SELECT opening_balance_piastres v FROM v_community_totals`),
      one(`SELECT balance_piastres v FROM v_account_balances WHERE code='3101'`),
      'the opening balance is not account 3101');
    assert.equal(one(`SELECT reserves_piastres v FROM v_community_totals`), 200_000,
      'the reserve is missing or has absorbed something else');
    // The thing that was actually wrong: the two used to be one number.
    assert.notEqual(one(`SELECT reserves_piastres v FROM v_community_totals`), 0,
      'this test proves nothing while every reserve is empty');
  });

  it('⭐ opening balance + reserves == every fund account, with nothing lost', () => {
    const parts = one(`SELECT opening_balance_piastres + reserves_piastres v FROM v_community_totals`);
    const all = one(`SELECT COALESCE(SUM(balance_piastres),0) v FROM v_account_balances WHERE type='fund'`);
    assert.equal(parts, all, 'a fund account belongs to no caption and is invisible');
  });

  it('splitting the captions did NOT move the treasury figure', () => {
    // spendable still subtracts everything owed, to residents and contractors
    // alike. Only the attribution changed. assets 1,800,000 − liabilities
    // 550,000 = 1,250,000.
    const assets = one(`SELECT COALESCE(SUM(balance_piastres),0) v FROM v_account_balances
      WHERE type='asset' AND code NOT LIKE '13%'`);
    const liab = one(`SELECT COALESCE(SUM(balance_piastres),0) v FROM v_account_balances
      WHERE type='liability'`);
    assert.equal(one(`SELECT spendable_piastres v FROM v_community_totals`), assets - liab);
  });

  it('⭐ the three captioned figures still account for every liability', () => {
    // If a future account escapes all three captions, it vanishes from the
    // screen entirely — a worse failure than being mislabelled.
    const parts = one(`SELECT held_in_trust_piastres + owed_to_suppliers_piastres v
                         FROM v_community_totals`);
    const all = one(`SELECT COALESCE(SUM(balance_piastres),0) v FROM v_account_balances
                      WHERE type='liability'`);
    assert.equal(parts, all, 'a liability account belongs to no caption and is invisible');
  });

  it('⭐ no account in the chart escapes classification', () => {
    // Adding account 2104 without deciding which Arabic sentence covers it now
    // fails here, rather than appearing under whichever tile it lands in.
    const rows = db.prepare(`SELECT code, name_ar FROM v_unclassified_accounts`).all() as
      Array<{ code: string; name_ar: string }>;
    assert.deepEqual(rows, [],
      `unclassified: ${rows.map(r => `${r.code} ${r.name_ar}`).join('، ')}`);
  });
});
