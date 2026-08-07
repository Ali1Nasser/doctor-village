/**
 * tests/access/expenses.test.ts — CP-5's two ⭐ gates, and the posting engine.
 *
 * The gates, verbatim:
 *   ⭐ "`v_deposit_leakage` is empty after every posting — no line sourced from
 *      a deposit-kind category ever credits an income account. This is the real
 *      R-020 gate."
 *   ⭐ "The operating/deposit fund split holds: الفلوس المتاحة للصرف excludes
 *      every liability, and a deposit posts only to a non-spendable fund.
 *      **Assert the displayed figure against a hand computation**, not against
 *      the ledger total."
 *
 * The second gate's last clause is the whole lesson of sessions 10–13 written
 * into the plan before any of them happened, and ignored until R-043 forced it.
 * The tile is read out of the rendered HTML here.
 *
 * ## The strongest claim in this file
 * Migration 0014 makes spending trust money **impossible**, not merely visible.
 * R-049 detects it with a banner; `trg_expense_fund_spendable_*` refuses the
 * write. The tests below assert the refusal happens at the database, with every
 * `lib/db/` guard bypassed — because a control that only holds when called
 * through the right function is a convention, not a control (R-046).
 */

import { it, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NodeSqliteDb } from '../../lib/db/driver.js';
import { setTokenHasher, resolveAuthContext } from '../../lib/db/index.js';
import * as mut from '../../lib/db/mutations.js';
import * as exp from '../../lib/db/expenses.js';
import { createApp } from '../../src/app.js';
import { D1BlobStorage } from '../../lib/storage/d1blob.js';
import type { AuthContext, Id } from '../../types/domain.js';

const ROOT = process.cwd();
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
setTokenHasher(sha);
const id = (p: string, n: number) => (p + String(n).padStart(26 - p.length, '0')).slice(0, 26);

const A1 = id('PRF', 1), A2 = id('PRF', 2), OP = id('PRF', 3);
const BLD = id('BLD', 1), U1 = id('UNT', 1), PERIOD = id('FIS', 1) as Id;
const A_BANK = 'ACC00000000000000000001102' as Id;
const I_SUBS = 'ACC00000000000000000004101' as Id;
const RP = { id: 'localhost', name: 'قرية الأطباء', origin: 'http://localhost' };
const NOW = () => '2026-08-05T10:00:00Z';

const asPounds = (p: number) =>
  (p / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const tile = (html: string, labelAr: string): string | null => {
  const i = html.indexOf(labelAr); if (i < 0) return null;
  const v = html.indexOf('class="v"', i); if (v < 0) return null;
  const m = /<bdi[^>]*>([^<]*)<\/bdi>/.exec(html.slice(v, v + 400));
  return m ? m[1]! : null;
};

let raw: DatabaseSync, db: NodeSqliteDb, app: ReturnType<typeof createApp>;
let admin1: AuthContext, admin2: AuthContext, operator: AuthContext;
let OP_FUND = '', DEP_FUND = '', C_MAINT = '', C_DEPOSIT = '';

before(async () => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).sort())
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  for (const f of readdirSync(join(ROOT, 'seed/prod')).sort())
    raw.exec(readFileSync(join(ROOT, 'seed/prod', f), 'utf8'));
  const x = (s: string, ...p: unknown[]) => raw.prepare(s).run(...p as never[]);

  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,'رئيس','admin')`, A1);
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,'أمين الصندوق','admin')`, A2);
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,'مشغّل','operator')`, OP);
  for (const [n, p, tok] of [[1, A1, 'tok-a1'], [2, A2, 'tok-a2'], [3, OP, 'tok-op']] as const)
    x(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`,
      id('SES', n), p, sha(tok), '2027-01-01T00:00:00Z');
  x(`INSERT INTO buildings (id,code,name_ar) VALUES (?,'1','ع1')`, BLD);
  x(`INSERT INTO units (id,building_id,unit_number) VALUES (?,?,'101')`, U1, BLD);
  x(`INSERT INTO fiscal_periods (id,name_ar,starts_on,ends_on,status)
     VALUES (?,'2026','2026-01-01','2026-12-31','open')`, PERIOD);

  OP_FUND = (raw.prepare(`SELECT id FROM funds WHERE kind='operating'`).get() as { id: string }).id;
  DEP_FUND = (raw.prepare(`SELECT id FROM funds WHERE kind='deposit'`).get() as { id: string }).id;
  C_MAINT = (raw.prepare(
    `SELECT id FROM categories WHERE direction='expense' AND parent_id IS NULL LIMIT 1`)
    .get() as { id: string }).id;
  C_DEPOSIT = (raw.prepare(`SELECT id FROM categories WHERE kind='deposit' LIMIT 1`)
    .get() as { id: string }).id;

  // Opening money, and a deposit received — so the fund split has something to
  // hold and the leakage view has something to be empty about.
  let en = 0, ln = 0;
  const post = (desc: string, date: string, src: string, srcId: string | null,
                rows: Array<[string, string, number, number]>) => {
    en += 1; const eid = id('JE', en + 500);
    x(`INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,
         source_type,source_id,created_by) VALUES (?,?,?,?,?,?,?,?)`,
      eid, `J-2026-9000${en}`, date, PERIOD, desc, src, srcId, A2);
    rows.forEach(([acct, fnd, dr, cr], i) => {
      ln += 1;
      x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,
           debit_piastres,credit_piastres) VALUES (?,?,?,?,?,?,?)`,
        id('JL', ln + 500), eid, i + 1, acct, fnd, dr, cr);
    });
    x(`UPDATE journal_entries SET approved_by=?, posted_at=? WHERE id=?`, A1, `${date}T10:00:00Z`, eid);
    return eid;
  };
  post('رصيد أول المدة', '2026-01-01', 'opening_balance', null, [
    [A_BANK, OP_FUND, 2_000_000, 0], ['ACC00000000000000000003101', OP_FUND, 0, 2_000_000]]);
  post('وديعة شقة 101', '2026-02-01', 'payment', id('PAY', 1), [
    [A_BANK, DEP_FUND, 500_000, 0], ['ACC00000000000000000002101', DEP_FUND, 0, 500_000]]);

  db = new NodeSqliteDb(raw as never);
  const storage = new D1BlobStorage(db);
  app = createApp({ db, now: NOW, storage, rp: RP,
    storagePut: i => storage.put(i), storageUsedBytes: () => storage.usedBytes() });
  admin1 = (await resolveAuthContext(db, 'tok-a1', NOW))!;
  admin2 = (await resolveAuthContext(db, 'tok-a2', NOW))!;
  operator = (await resolveAuthContext(db, 'tok-op', NOW))!;
});

const record = async (n: number, amount: number, fund: string, ctx = admin1,
                      spentOn = '2026-06-01') => {
  const eid = id('EXP', n) as Id;
  await mut.recordExpense(ctx, db, {
    id: eid, voucherNo: `E-2026-0000${n}`, categoryId: C_MAINT as Id,
    amountPiastres: amount, spentOn, descriptionAr: `مصروف ${n}`,
    vendorName: 'مورد', invoiceStorageKey: null, fundId: fund as Id,
  } as never);
  return eid;
};

/* ================================================================== */
describe('⭐ trust money cannot be spent — prevention, not detection', () => {

  it('an expense drawn on the DEPOSIT fund is refused', async () => {
    await assert.rejects(() => record(90, 100_000, DEP_FUND),
      /أمانات/, 'an expense was recorded against the deposit fund');
  });

  it('...and the database refuses it with every guard bypassed', () => {
    assert.throws(() => raw.prepare(
      `INSERT INTO expenses (id,voucher_no,category_id,amount_piastres,spent_on,
         description_ar,fund_id,recorded_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id('EXP', 91), 'E-2026-09991', C_MAINT, 100000, '2026-06-01',
           'محاولة مباشرة', DEP_FUND, A1),
      /أمانات|constraint/,
      'the trigger did not fire — the rule only exists in application code');
  });

  it('a reserve fund is equally off-limits', async () => {
    const reserve = (raw.prepare(`SELECT id FROM funds WHERE kind='reserve' LIMIT 1`)
      .get() as { id: string }).id;
    await assert.rejects(() => record(92, 10_000, reserve), /أمانات/);
  });

  it('the operating fund works normally', async () => {
    const eid = await record(1, 30_000, OP_FUND);
    const row = raw.prepare(`SELECT status FROM expenses WHERE id=?`).get(eid) as { status: string };
    assert.equal(row.status, 'recorded');
  });
});

/* ================================================================== */
describe('maker–checker binds the ledger, not just the button', () => {

  it('⭐ an operator can RECORD but can never POST — posting is approving', async () => {
    // The operator role exists to have no financial authority (03_RBAC §2).
    // This test is why `postExpense` requires `expense.countersign` and not
    // `expense.record`: it watched an operator succeed.
    await assert.rejects(() => exp.postExpense(
      operator, db, { expenseId: id('EXP', 1) as Id, creditAccountId: A_BANK, periodId: PERIOD as Id },
      NOW));
  });

  it('⭐ the poster is never the recorder, even below the threshold', async () => {
    // `trg_entry_maker_checker` has no threshold and no exemption (C8). The
    // expense threshold decides whether a countersignature is RECORDED; this
    // decides whether two humans touched the money at all.
    await assert.rejects(() => exp.postExpense(admin1, db,
      { expenseId: id('EXP', 1) as Id, creditAccountId: A_BANK, periodId: PERIOD as Id }, NOW),
      /إنت اللي سجّلته/, 'one admin recorded and posted the same expense alone');
  });

  it('a below-threshold expense posts when a SECOND admin does it', async () => {
    // Threshold is 5,000.00 ج.م. This is 300.00 — no countersignature needed,
    // but still two people.
    const entryId = await exp.postExpense(admin2, db,
      { expenseId: id('EXP', 1) as Id, creditAccountId: A_BANK, periodId: PERIOD as Id }, NOW);
    assert.ok(entryId);
    const e = raw.prepare(`SELECT status, journal_entry_id j FROM expenses WHERE id=?`)
      .get(id('EXP', 1)) as { status: string; j: string };
    assert.equal(e.status, 'posted');
    assert.equal(e.j, entryId);
  });

  it('⭐ an ABOVE-threshold expense cannot post unsigned', async () => {
    await record(2, 800_000, OP_FUND);        // 8,000.00 — over the 5,000 threshold
    await assert.rejects(() => exp.postExpense(admin2, db,
      { expenseId: id('EXP', 2) as Id, creditAccountId: A_BANK, periodId: PERIOD as Id }, NOW),
      /توقيع تاني/, 'a large expense reached the ledger with no countersignature');
  });

  it('the recorder cannot be the countersigner', async () => {
    await assert.rejects(() => mut.countersignExpense(admin1, db, id('EXP', 2) as Id, NOW),
      /هو اللي عملها/, 'one admin signed their own expense');
  });

  it('a DIFFERENT admin signs, and then it posts', async () => {
    await mut.countersignExpense(admin2, db, id('EXP', 2) as Id, NOW);
    const entryId = await exp.postExpense(admin2, db,
      { expenseId: id('EXP', 2) as Id, creditAccountId: A_BANK, periodId: PERIOD as Id }, NOW);
    assert.ok(entryId);
  });

  it('posting twice is refused, not silently ignored', async () => {
    await assert.rejects(() => exp.postExpense(admin2, db,
      { expenseId: id('EXP', 2) as Id, creditAccountId: A_BANK, periodId: PERIOD as Id }, NOW),
      /اترحّل قبل كده/);
  });

  it('an expense cannot be credited to an INCOME account', async () => {
    await record(3, 5_000, OP_FUND);
    await assert.rejects(() => exp.postExpense(admin2, db,
      { expenseId: id('EXP', 3) as Id, creditAccountId: I_SUBS, periodId: PERIOD as Id }, NOW),
      /حساب أصول/,
      'an expense credited income — the entry would balance while describing nothing real');
  });
});

/* ================================================================== */
describe('⭐ CP-5 GATE: v_deposit_leakage is empty after every posting', () => {

  it('it is empty now', () => {
    const n = raw.prepare(`SELECT COUNT(*) n FROM v_deposit_leakage`).get() as { n: number };
    assert.equal(n.n, 0);
  });

  it('a deposit category can never be an expense category', async () => {
    const eid = id('EXP', 95) as Id;
    raw.prepare(`INSERT INTO expenses (id,voucher_no,category_id,amount_piastres,spent_on,
       description_ar,fund_id,recorded_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(eid, 'E-2026-09995', C_DEPOSIT, 10000, '2026-06-01', 'تصنيف غلط', OP_FUND, A1);
    await assert.rejects(() => exp.postExpense(admin2, db,
      { expenseId: eid, creditAccountId: A_BANK, periodId: PERIOD as Id }, NOW),
      /مش تصنيف مصروفات/);
  });

  it('and the leakage view is STILL empty', () => {
    const n = raw.prepare(`SELECT COUNT(*) n FROM v_deposit_leakage`).get() as { n: number };
    assert.equal(n.n, 0, 'a deposit-kind line reached a non-liability account');
  });
});

/* ================================================================== */
describe('⭐ CP-5 GATE: the fund split holds, checked on the RENDERED page', () => {
  /**
   * The gate says: *"Assert the displayed figure against a hand computation,
   * not against the ledger total."* That sentence was in the plan from the
   * start and was ignored until R-043 made the reason unmissable.
   *
   *   bank  = 2,000,000 opening + 500,000 deposit
   *           − 30,000 (E-1) − 800,000 (E-2)            = 1,670,000
   *   liabilities = the 500,000 deposit                  =   500,000
   *   spendable   = 1,670,000 − 500,000                  = 1,170,000
   *   held in trust                                      =   500,000
   */
  it('spendable and held-in-trust match hand-computed values on screen', async () => {
    const r = await app.request('/finance', { headers: { authorization: 'Bearer tok-a1' } });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.equal(tile(body, 'الفلوس المتاحة للصرف'), asPounds(1_170_000),
      'the treasury tile disagrees with the hand computation');
    assert.equal(tile(body, 'ودائع وأرصدة للملاك'), asPounds(500_000));
  });

  it('the deposit fund still holds every piastre it owes', () => {
    const f = raw.prepare(
      `SELECT net_debit_piastres h, owed_piastres o FROM v_fund_balances WHERE kind='deposit'`)
      .get() as { h: number; o: number };
    assert.equal(f.h, 500_000, 'deposit fund cash moved');
    assert.equal(f.o, 500_000);
    assert.ok(f.h >= f.o, 'trust money has been spent');
  });

  it('expenses came out of the OPERATING fund only', () => {
    const byFund = (raw.prepare(
      `SELECT f.kind, COALESCE(SUM(pl.debit_piastres),0) d
         FROM v_posted_lines pl
         JOIN accounts a ON a.id = pl.account_id AND a.type = 'expense'
         JOIN funds f ON f.id = pl.fund_id
        GROUP BY f.kind`).all() as Array<{ kind: string; d: number }>)
      .map(r => ({ kind: r.kind, d: r.d }));
    assert.deepEqual(byFund, [{ kind: 'operating', d: 830_000 }],
      'an expense was charged to a fund that is not the operating fund');
  });

  it('the accounting equation still balances — and still proves nothing alone', () => {
    const r = raw.prepare(`SELECT residual_piastres v FROM v_accounting_equation`)
      .get() as { v: number };
    assert.equal(r.v, 0);   // ADR-018
  });
});

/* ================================================================== */
describe('a closed fiscal period takes no more entries', () => {

  /**
   * This block runs on its OWN fiscal period (2025), not the shared 2026 one.
   *
   * It used to close 2026 in place, which stopped working when migration 0021
   * added `trg_period_close_needs_clean_expenses`: by the time this block runs,
   * earlier blocks have deliberately left unposted expenses in 2026 — the
   * fixtures that "money spent but not yet in the books is visible" depends on
   * — and a period cannot close over them. Both facts are correct and they are
   * simply about different years, so the fix is to stop sharing one.
   */
  const PERIOD25 = id('FPR', 25);

  it('posting into a closed year is refused', async () => {
    raw.prepare(`INSERT INTO fiscal_periods (id,name_ar,starts_on,ends_on,status)
                 VALUES (?,'2025','2025-01-01','2025-12-31','open')`).run(PERIOD25);
    // A clean year closes without argument.
    raw.prepare(`UPDATE fiscal_periods SET status='closed', closed_by=?, closed_at=? WHERE id=?`)
      .run(A1, '2026-08-05T09:00:00Z', PERIOD25);
    // …and a late expense dated inside it can still be RECORDED. Only posting
    // is refused, which is precisely the control under test.
    await record(4, 12_000, OP_FUND, admin1, '2025-06-01');
    await assert.rejects(() => exp.postExpense(admin2, db,
      { expenseId: id('EXP', 4) as Id, creditAccountId: A_BANK, periodId: PERIOD25 as Id }, NOW),
      /مقفولة/, 'an expense posted into a closed fiscal period');
  });

  it('...and posts once it is reopened', async () => {
    raw.prepare(`UPDATE fiscal_periods SET status='reopened', reopened_by=?, reopened_at=?,
                   reopen_reason_ar=? WHERE id=?`)
      .run(A2, '2026-08-05T10:00:00Z', 'ظهر مصروف متأخر', PERIOD25);
    const entryId = await exp.postExpense(admin2, db,
      { expenseId: id('EXP', 4) as Id, creditAccountId: A_BANK, periodId: PERIOD25 as Id }, NOW);
    assert.ok(entryId);
  });
});

/* ================================================================== */
describe('money spent but not yet in the books is visible', () => {

  it('an unposted expense is counted and totalled', async () => {
    // Delta, not an absolute: earlier suites in this file leave their own
    // unposted expenses behind, and asserting `count === 1` would couple this
    // to the order the describes happen to run in. (The same coupling bit the
    // opening-balance assertion in views.test.ts — see INSIGHTS, session 13.)
    const before = await exp.unpostedExpenses(admin1, db);
    await record(5, 44_000, OP_FUND);
    const after = await exp.unpostedExpenses(admin1, db);
    assert.equal(after.count - before.count, 1, 'the unposted expense is invisible');
    assert.equal(after.totalPiastres - before.totalPiastres, 44_000);
  });

  it('⭐ it is on the SCREEN, not just in a query', async () => {
    // Understates expenses and overstates the treasury by exactly this amount,
    // and shows up nowhere else — R-043 pointing the other way.
    const u = await exp.unpostedExpenses(admin1, db);
    const r = await app.request('/finance', { headers: { authorization: 'Bearer tok-a1' } });
    const body = await r.text();
    assert.ok(body.includes(asPounds(u.totalPiastres)),
      `money the village has spent (${asPounds(u.totalPiastres)}) is missing from /finance`);
    assert.match(body, /ماترحّلش على الدفاتر/,
      'the total is on the page but nothing says why it matters');
  });

  it('a resident sees the posted expense ledger', async () => {
    /* This test used to assert the invoice key was NEVER exposed. That was right
     * before ADR-026 existed and wrong after it: evidence visible to members is
     * the entire point of attaching a photo. What matters now is that the key
     * appears only when the caller may actually open it — a link that 403s tells
     * a resident the evidence is being hidden from them specifically, which is
     * the suspicion this feature exists to remove. */
    const rows = await exp.listPostedExpenses(admin1, db) as Array<Record<string, unknown>>;
    assert.ok(rows.length >= 3, 'posted expenses are not listed');

    raw.prepare(`UPDATE settings SET expense_invoices_public = 0 WHERE id = 1`).run();
    raw.prepare(`INSERT INTO profiles (id,full_name,role) VALUES (?,'ساكن2','resident')`)
      .run(id('PRF', 41));
    raw.prepare(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`)
      .run(id('SES', 41), id('PRF', 41), sha('tok-res3'), '2027-01-01T00:00:00Z');
    const resident = (await resolveAuthContext(db, 'tok-res3', NOW))!;
    const closed = await exp.listPostedExpenses(resident, db) as Array<Record<string, unknown>>;
    for (const row of closed) {
      assert.equal(row['invoice_storage_key'], null,
        'a resident is offered an invoice link that will 403');
    }
    raw.prepare(`UPDATE settings SET expense_invoices_public = 1 WHERE id = 1`).run();
  });
});

/* ================================================================== */
describe('Σ per-category == total expenses (CP-5 gate, R-047)', () => {

  it('they agree after every posting', () => {
    const perCat = raw.prepare(
      `SELECT COALESCE(SUM(total_piastres),0) v FROM v_expense_by_category`)
      .get() as { v: number };
    const total = raw.prepare(
      `SELECT COALESCE(SUM(pl.debit_piastres) - SUM(pl.credit_piastres),0) v
         FROM v_posted_lines pl JOIN accounts a ON a.id = pl.account_id
        WHERE a.type = 'expense'`).get() as { v: number };
    assert.equal(perCat.v, total.v);
    assert.equal(total.v, 842_000, '30,000 + 800,000 + 12,000');
  });
});

/* ================================================================== */
describe('reversal — the only legitimate correction (ADR-006)', () => {
  /**
   * `trg_expense_frozen_after_post` refuses to edit a posted expense, and
   * ADR-006 says why that refusal is a feature: *"a corrected number that
   * silently replaces a number residents already saw destroys trust faster than
   * the original error."* In a community built on suspicion the visible history
   * IS the product. So these tests care as much about what stays on the record
   * as about what the totals do.
   */
  let target = '' as Id;

  before(async () => {
    target = await record(20, 60_000, OP_FUND);          // recorded by admin1
    await exp.postExpense(admin2, db,
      { expenseId: target, creditAccountId: A_BANK, periodId: PERIOD as Id }, NOW);
  });

  it('an operator cannot reverse anything', async () => {
    await assert.rejects(() => exp.requestExpenseReversal(
      operator, db, { expenseId: target, reasonAr: 'اتسجّل مرتين بالغلط' }, NOW));
  });

  it('"غلط" is not a reason', async () => {
    await assert.rejects(() => exp.requestExpenseReversal(
      admin1, db, { expenseId: target, reasonAr: 'غلط' }, NOW),
      /سبب واضح/, 'a one-word reason was accepted onto the permanent record');
  });

  it('an UNPOSTED expense cannot be reversed — there is nothing to offset', async () => {
    const un = await record(21, 7_000, OP_FUND);
    await assert.rejects(() => exp.requestExpenseReversal(
      admin1, db, { expenseId: un, reasonAr: 'اتسجّل بالغلط من الأساس' }, NOW),
      /لسه ماترحّلش/,
      'reversing an unposted expense would create a credit for money that never left');
  });

  it('⭐ a reversal needs a SECOND admin, exactly like the posting it undoes', async () => {
    // The first draft of `reverseExpense` created and posted in one call, with
    // one admin as both recorder and approver. The database refused it, and the
    // refusal was right: reversing moves money back, and C8 has no exemptions.
    const revId = await exp.requestExpenseReversal(
      admin1, db, { expenseId: target, reasonAr: 'الفاتورة اتدفعت مرتين بالغلط' }, NOW);
    await assert.rejects(() => exp.postExpense(admin1, db,
      { expenseId: revId, creditAccountId: A_BANK, periodId: PERIOD as Id }, NOW),
      /إنت اللي سجّلته/, 'one admin reversed an expense alone');
  });

  it('⭐ reversing nets the expense to zero without editing anything', async () => {
    const before = raw.prepare(
      `SELECT COALESCE(SUM(pl.debit_piastres) - SUM(pl.credit_piastres),0) v
         FROM v_posted_lines pl JOIN accounts a ON a.id = pl.account_id
        WHERE a.type='expense'`).get() as { v: number };

    const revId = (raw.prepare(
      `SELECT id FROM expenses WHERE reverses_expense_id = ?`).get(target) as { id: string }).id;
    await exp.postExpense(admin2, db,
      { expenseId: revId as Id, creditAccountId: A_BANK, periodId: PERIOD as Id }, NOW);

    const after = raw.prepare(
      `SELECT COALESCE(SUM(pl.debit_piastres) - SUM(pl.credit_piastres),0) v
         FROM v_posted_lines pl JOIN accounts a ON a.id = pl.account_id
        WHERE a.type='expense'`).get() as { v: number };
    assert.equal(after.v, before.v - 60_000, 'the reversal did not offset the expense');

    // ...and the ORIGINAL row is untouched apart from its status.
    const o = raw.prepare(`SELECT amount_piastres a, spent_on s, status st FROM expenses WHERE id=?`)
      .get(target) as { a: number; s: string; st: string };
    assert.equal(o.a, 60_000, 'the original amount was edited');
    assert.equal(o.s, '2026-06-01', 'the original date was edited');
    assert.equal(o.st, 'reversed');
  });

  it('⭐ both entries stay visible, with the reason attached', async () => {
    const rows = await exp.listPostedExpenses(admin1, db) as Array<Record<string, unknown>>;
    const rev = rows.find(r => String(r['description_ar']).startsWith('إلغاء'));
    assert.ok(rev, 'the reversal is not in the expense ledger — the correction is invisible');
    const stored = raw.prepare(
      `SELECT reversal_reason_ar r FROM expenses WHERE reverses_expense_id = ?`)
      .get(target) as { r: string };
    assert.match(stored.r, /اتدفعت مرتين/, 'the reason a resident would read is missing');
  });

  it('the reversal carries the same fund, so the fund split still holds', () => {
    const r = raw.prepare(
      `SELECT fund_id f FROM expenses WHERE reverses_expense_id = ?`).get(target) as { f: string };
    assert.equal(r.f, OP_FUND, 'a reversal landed in a different fund from the original');
  });

  it('reversing twice is refused', async () => {
    await assert.rejects(() => exp.requestExpenseReversal(
      admin1, db, { expenseId: target, reasonAr: 'محاولة تانية للإلغاء' }, NOW),
      /اتعكس قبل كده/,
      'an expense was reversed twice — the credit is now doubled');
  });

  it('the equation still balances and the deposit fund is untouched', () => {
    const eq = raw.prepare(`SELECT residual_piastres v FROM v_accounting_equation`)
      .get() as { v: number };
    assert.equal(eq.v, 0);
    const f = raw.prepare(
      `SELECT net_debit_piastres h, owed_piastres o FROM v_fund_balances WHERE kind='deposit'`)
      .get() as { h: number; o: number };
    assert.ok(f.h >= f.o, 'a reversal reached the deposit fund');
  });

  it('the whole thing is on the record with a name against it', () => {
    const a = raw.prepare(
      `SELECT actor_id, action FROM audit_log
        WHERE action='expense.reverse_requested' AND entity_id=?`)
      .get(target) as { actor_id: string } | undefined;
    assert.ok(a, 'a reversal happened with no audit row');
    assert.equal(a!.actor_id, A1);
  });
});

/* ================================================================== */
describe('/admin/expenses — the screen, with JavaScript off', () => {
  /**
   * `04_UX_SPEC` line 82 asks for "60-second expense entry". Sixty seconds is
   * not measurable from here — it needs a volunteer, a stairwell and a plumber
   * who wants to leave (CP-7). What IS measurable are the things that make it
   * impossible if they are wrong: the number of fields, whether the form works
   * without JavaScript, and whether today's date is already filled in.
   *
   * So these tests assert the preconditions rather than the claim, and CP-5
   * stays honest about which one has been checked.
   */
  const form = (path: string, body: Record<string, string>, tok = 'tok-a1') =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded',
                 authorization: `Bearer ${tok}` },
      body: new URLSearchParams(body).toString(),
    });

  it('the entry form is FIRST on the page and needs no JavaScript', async () => {
    const r = await app.request('/admin/expenses', { headers: { authorization: 'Bearer tok-a1' } });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.ok(!body.includes('<script'), 'the expense screen ships JavaScript');
    assert.match(body, /<form method="post" action="\/admin\/expenses"/,
      'the entry form is not a plain form post');
    // "First" literally: the entry form appears before the queue heading.
    assert.ok(body.indexOf('action="/admin/expenses"') < body.indexOf('مستني ترحيل'),
      'the queue is above the entry form — the common task is not the first thing');
  });

  it('it asks for five fields and pre-fills the date', async () => {
    const r = await app.request('/admin/expenses', { headers: { authorization: 'Bearer tok-a1' } });
    const body = await r.text();
    const start = body.indexOf('action="/admin/expenses"');
    const formHtml = body.slice(start, body.indexOf('</form>', start));
    const fields = [...formHtml.matchAll(/<(input|select|textarea)[^>]*name="([^"]+)"/g)]
      .map(m => m[2]!).filter(n => n !== 'fund');
    assert.deepEqual(fields, ['amount', 'category', 'description', 'spentOn', 'vendor'],
      `the form asks for ${fields.length} fields: ${fields.join(', ')}`);
    assert.match(formHtml, /name="spentOn"[^>]*value="2026-08-05"/,
      "today's date is not pre-filled — that is one date-picker per expense");
  });

  it('⭐ only SPENDABLE funds are offered', async () => {
    // The trigger refuses a deposit fund anyway. Offering it and then rejecting
    // it teaches the admin the system is arbitrary.
    const r = await app.request('/admin/expenses', { headers: { authorization: 'Bearer tok-a1' } });
    const body = await r.text();
    assert.ok(!body.includes(DEP_FUND), 'the deposit fund is selectable on the expense form');
  });

  it('recording works end to end as a form post', async () => {
    const r = await form('/admin/expenses', {
      amount: '250.75', category: C_MAINT, description: 'تصليح مضخة حمام السباحة',
      spentOn: '2026-07-01', vendor: 'ورشة النور', fund: OP_FUND,
    });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /اتسجّل/, 'no confirmation after recording');
    assert.ok(body.includes('تصليح مضخة حمام السباحة'), 'the new expense is not in the queue');
    // 250.75 ج.م — parsed as integer piastres, never a float (C4).
    const row = raw.prepare(
      `SELECT amount_piastres a FROM expenses WHERE description_ar = ?`)
      .get('تصليح مضخة حمام السباحة') as { a: number };
    assert.equal(row.a, 25_075);
  });

  it('a malformed amount is REFUSED with a reason, not rounded', async () => {
    const r = await form('/admin/expenses', {
      amount: '١٢٣٤,٥٦٧', category: C_MAINT, description: 'مبلغ ملخبط',
      spentOn: '2026-07-01', vendor: '', fund: OP_FUND,
    });
    const body = await r.text();
    assert.ok(!body.includes('مبلغ ملخبط') || /banner warn/.test(body),
      'an ambiguous amount was accepted');
    const none = raw.prepare(`SELECT COUNT(*) n FROM expenses WHERE description_ar='مبلغ ملخبط'`)
      .get() as { n: number };
    assert.equal(none.n, 0, 'an ambiguous amount was stored anyway');
  });

  it('⭐ the screen REPLACES a button you cannot press with the reason', async () => {
    // admin1 recorded the pump repair, so admin1 must not see a post button for
    // it — and must see why, not a disabled control or a silent absence.
    const r = await app.request('/admin/expenses', { headers: { authorization: 'Bearer tok-a1' } });
    const body = await r.text();
    assert.match(body, /مينفعش ترحّل مصروف إنت سجّلته|مينفعش توقّع على حاجة إنت سجّلتها/,
      'maker-checker is enforced but never explained on the screen');
  });

  it('...and the SECOND admin does see the button, and it works', async () => {
    const list = await app.request('/admin/expenses', { headers: { authorization: 'Bearer tok-a2' } });
    const body = await list.text();
    const m = /action="\/admin\/expenses\/([A-Z0-9]+)\/post"/.exec(body);
    assert.ok(m, 'the second admin has no post button either');
    const r = await form(`/admin/expenses/${m![1]}/post`, {}, 'tok-a2');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /اترحّل/, 'posting from the screen did not confirm');
  });

  it('⭐ an operator CAN record here — and can post nothing', async () => {
    /* My first version of this test asserted 403 and failed. The test was
     * wrong: `04_UX_SPEC` line 82 puts 60-second expense entry under `/ops`,
     * and recording the plumber's receipt is the operator role's entire
     * purpose. What they must never do is move money (R-058).
     *
     * So the screen is open to them and every approval control is absent — and
     * absent from the SERVER too, not just the page. */
    const r = await app.request('/admin/expenses', { headers: { authorization: 'Bearer tok-op' } });
    assert.equal(r.status, 200, 'an operator cannot record an expense at all');
    const body = await r.text();
    assert.match(body, /action="\/admin\/expenses"/, 'the operator has no entry form');
    assert.ok(!/\/post"/.test(body), 'an operator is offered a POST-to-ledger button');
    assert.ok(!/\/countersign"/.test(body), 'an operator is offered a countersign button');
  });

  it('...and posting directly is refused even with the URL', async () => {
    const target = raw.prepare(
      `SELECT id FROM expenses WHERE status='recorded' LIMIT 1`).get() as { id: string };
    const r = await form(`/admin/expenses/${target.id}/post`, {}, 'tok-op');
    assert.equal(r.status, 403, 'an operator moved money by typing the URL');
  });

  it('the reversal screen demands a reason before it will do anything', async () => {
    const posted = raw.prepare(
      `SELECT id FROM expenses WHERE status='posted' AND is_reversal=0 LIMIT 1`)
      .get() as { id: string };
    const r = await form(`/admin/expenses/${posted.id}/reverse`, { reason: 'غلط' });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /سبب واضح/, 'a one-word reason passed through the screen');
  });
});

/* ================================================================== */
describe('the invoice photo — evidence for money going out (01_PRD C1)', () => {
  /**
   * The column existed since CP-1 and nothing ever wrote it, so a 12,000 ج.م
   * maintenance line had **no evidence attached** — the first thing a resident
   * asks about, and the exact suspicion this product exists to answer.
   *
   * The tension these tests pin down: `01_PRD` C2 makes expenses visible to all
   * members, and a supplier's invoice usually carries the supplier's phone
   * number and bank details. That is a third party's personal data under PDPL
   * 151/2020, and the transparency requirement does not dissolve it.
   */
  const WEBP = Buffer.from('UklGRhwCAABXRUJQVlA4WAoAAAAgAAAAAAAAAAAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggLgAAAJABAJ0BKgEAAQABQCYloAJ0ugADmAD+8U2v4tpHQpkP/vGf/3Gf/3Gf/IgAAAA=', 'base64');
  const b64 = WEBP.toString('base64url');
  let target = '' as Id;

  const form = (path: string, body: Record<string, string>, tok = 'tok-a1') =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded',
                 authorization: `Bearer ${tok}` },
      body: new URLSearchParams(body).toString(),
    });

  before(async () => { target = await record(30, 1_200_000, OP_FUND); });

  it('⭐ the entry form still has NO file input — the 60-second claim survives', async () => {
    const body = await (await app.request('/admin/expenses',
      { headers: { authorization: 'Bearer tok-a1' } })).text();
    const start = body.indexOf('action="/admin/expenses"');
    const formHtml = body.slice(start, body.indexOf('</form>', start));
    assert.ok(!formHtml.includes('type="file"'),
      'an image input was added to the entry form — it now needs JavaScript');
  });

  it('⭐ the upload screen warns about the supplier BEFORE the camera opens', async () => {
    const body = await (await app.request(`/admin/expenses/${target}/invoice`,
      { headers: { authorization: 'Bearer tok-a1' } })).text();
    assert.match(body, /هيشوفها كل السكان/,
      'the operator is not told the photo becomes visible to every resident');
    assert.match(body, /غطّيها بصباعك/,
      'the operator is not told what to DO about the supplier\'s phone number');
    assert.ok(body.indexOf('هيشوفها كل السكان') < body.indexOf('type="file"'),
      'the warning is below the camera button — after the photo is already taken');
    assert.match(body, /من غير صورة/, 'there is no way to skip — the step is not optional');
  });

  it('attaching works, and is on the record', async () => {
    const r = await form(`/admin/expenses/${target}/invoice`, { imageBase64: b64 });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /الصورة اتحفظت/);
    const e = raw.prepare(`SELECT invoice_storage_key k FROM expenses WHERE id=?`)
      .get(target) as { k: string };
    assert.match(e.k, new RegExp(`^invoices/${target}/`), 'the key is not namespaced to its expense');
    const a = raw.prepare(
      `SELECT COUNT(*) n FROM audit_log WHERE action='expense.attach_invoice' AND entity_id=?`)
      .get(target) as { n: number };
    assert.equal(a.n, 1, 'attaching evidence was not audited');
  });

  it('⭐ a key that does not belong to its expense is refused by the DATABASE', () => {
    // `authorizeInvoiceRead` resolves a key back to an expense by LOOKUP, never
    // by parsing the path — which is only trustworthy because a mismatched key
    // cannot be written in the first place.
    assert.throws(() => raw.prepare(
      `UPDATE expenses SET invoice_storage_key='invoices/SOMEONE-ELSE/x.webp' WHERE id=?`)
      .run(target),
      /تحت المصروف بتاعها|constraint/,
      'an invoice key can point at a different expense');
  });

  it('a resident can see the evidence — that is the whole point', async () => {
    const key = (raw.prepare(`SELECT invoice_storage_key k FROM expenses WHERE id=?`)
      .get(target) as { k: string }).k;
    raw.prepare(`INSERT INTO profiles (id,full_name,role) VALUES (?,'ساكن','resident')`)
      .run(id('PRF', 40));
    raw.prepare(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`)
      .run(id('SES', 40), id('PRF', 40), sha('tok-res2'), '2027-01-01T00:00:00Z');
    const r = await app.request(`/api/invoices/${key}`,
      { headers: { authorization: 'Bearer tok-res2' } });
    assert.equal(r.status, 200, 'a resident cannot see what the village spent its money on');
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
  });

  it('⭐ ...and the board can close it without a deploy if a supplier objects', async () => {
    raw.prepare(`UPDATE settings SET expense_invoices_public = 0 WHERE id = 1`).run();
    const key = (raw.prepare(`SELECT invoice_storage_key k FROM expenses WHERE id=?`)
      .get(target) as { k: string }).k;
    const res = await app.request(`/api/invoices/${key}`,
      { headers: { authorization: 'Bearer tok-res2' } });
    assert.equal(res.status, 403, 'the setting does not actually restrict anything');
    // An admin must still see it — they countersign against this evidence.
    const adm = await app.request(`/api/invoices/${key}`,
      { headers: { authorization: 'Bearer tok-a1' } });
    assert.equal(adm.status, 200, 'an admin cannot check the evidence they are approving');
    raw.prepare(`UPDATE settings SET expense_invoices_public = 1 WHERE id = 1`).run();
  });

  it('an anonymous caller sees nothing', async () => {
    const key = (raw.prepare(`SELECT invoice_storage_key k FROM expenses WHERE id=?`)
      .get(target) as { k: string }).k;
    assert.equal((await app.request(`/api/invoices/${key}`)).status, 401);
  });

  it('⭐ how much spending has NO evidence is a number the board can see', async () => {
    // Not every expense needs a photo — a bank standing order has none. But
    // "how much of what we spent has no proof?" is a question a suspicious
    // resident asks at the general assembly, and the board should know first.
    const before = await exp.expensesWithoutEvidence(admin1, db);
    assert.ok(before.count > 0, 'the fixture has posted expenses with no invoice');
    assert.ok(before.totalPiastres > 0);
  });
});

/* ================================================================== */
describe('removing an invoice photo — the only repair there is', () => {
  /**
   * ADR-026's warning is advisory: an operator in a hurry taps through it and a
   * supplier's bank details reach 204 residents. Until now there was **no
   * repair at all**. This is it — and it stops further exposure without
   * pretending to undo the exposure, because nothing can un-see an image a
   * resident already opened.
   */
  let withPhoto = '' as Id;

  const form = (path: string, body: Record<string, string>, tok = 'tok-a2') =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded',
                 authorization: `Bearer ${tok}` },
      body: new URLSearchParams(body).toString(),
    });

  before(async () => {
    withPhoto = await record(31, 300_000, OP_FUND);
    const key = `invoices/${withPhoto}/${id('INV', 31)}.webp`;
    raw.prepare(`UPDATE expenses SET invoice_storage_key=? WHERE id=?`).run(key, withPhoto);
    raw.prepare(
      `INSERT INTO storage_objects (storage_key,bucket,owner_kind,owner_id,size_bytes,sha256,mime)
       VALUES (?,'invoices','expense_invoice',?,100,?,'image/webp')`)
      .run(key, withPhoto, 'd'.repeat(64));
  });

  it('⭐ an OPERATOR cannot remove evidence', async () => {
    // Removing evidence is the opposite of recording it. If the role with no
    // financial authority could do it, "delete the invoice" would be a power
    // they hold — so it needs `expense.countersign`, not `expense.record`.
    await assert.rejects(() => exp.removeInvoice(
      operator, db, withPhoto, 'الصورة فيها بيانات المورّد', NOW));
  });

  it('a reason is required and recorded', async () => {
    await assert.rejects(() => exp.removeInvoice(admin2, db, withPhoto, 'لا', NOW),
      /اكتب سبب/, 'evidence was removed with no explanation on the record');
  });

  it('the confirmation screen warns that removal is not undo', async () => {
    const body = await (await app.request(`/admin/expenses/${withPhoto}/invoice/remove`,
      { headers: { authorization: 'Bearer tok-a2' } })).text();
    assert.match(body, /مش بيرجّع اللي شافها قبل كده/,
      'the screen implies removal undoes the exposure');
    assert.match(body, /بلّغه/, 'the operator is not told to tell the supplier');
  });

  it('⭐ removing clears the evidence and NOT the money', async () => {
    const before = raw.prepare(`SELECT amount_piastres a, status s FROM expenses WHERE id=?`)
      .get(withPhoto) as { a: number; s: string };
    const r = await form(`/admin/expenses/${withPhoto}/invoice/remove`,
      { reason: 'الصورة فيها رقم حساب المورّد بالغلط' });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /الصورة اتشالت/);

    const after = raw.prepare(
      `SELECT amount_piastres a, status s, invoice_storage_key k FROM expenses WHERE id=?`)
      .get(withPhoto) as { a: number; s: string; k: string | null };
    assert.equal(after.k, null, 'the photo is still attached');
    // A mis-photographed invoice is not a wrong expense. Reversing the money to
    // fix a photo would be a far larger lie than the photo was.
    assert.equal(after.a, before.a, 'the amount changed');
    assert.equal(after.s, before.s, 'the expense status changed');
  });

  it('the image stops being served immediately', async () => {
    const key = `invoices/${withPhoto}/${id('INV', 31)}.webp`;
    const r = await app.request(`/api/invoices/${key}`,
      { headers: { authorization: 'Bearer tok-a1' } });
    assert.equal(r.status, 404, 'a removed invoice is still downloadable');
  });

  it('the storage object is soft-deleted, not dropped', () => {
    // So the audit trail still shows something was there, and the bytes get
    // purged deliberately rather than by a cascade nobody watched.
    const o = raw.prepare(
      `SELECT deleted_at d FROM storage_objects WHERE owner_id=?`).get(withPhoto) as
      { d: string | null };
    assert.ok(o.d, 'the storage row vanished — there is no trace anything was attached');
  });

  it('removing twice is refused', async () => {
    await assert.rejects(() => exp.removeInvoice(
      admin2, db, withPhoto, 'محاولة تانية للشيل', NOW), /مفيش صورة مرفقة/);
  });

  it('it is on the record with a name and a reason', () => {
    const a = raw.prepare(
      `SELECT actor_id, after_json af FROM audit_log
        WHERE action='expense.remove_invoice' AND entity_id=?`).get(withPhoto) as
      { actor_id: string; af: string };
    assert.equal(a.actor_id, A2);
    assert.match(a.af, /رقم حساب المورّد/);
  });

  it('⭐ the evidence gap is on /admin/health, not just in a query', async () => {
    // Session 22's lesson, applied to the number session 23 computed and then
    // displayed nowhere.
    const body = await (await app.request('/admin/health',
      { headers: { authorization: 'Bearer tok-a1' } })).text();
    assert.match(body, /مصروفات من غير إثبات/, 'the evidence gap is invisible to the board');
    const gap = await exp.expensesWithoutEvidence(admin1, db);
    if (gap.count > 0) {
      assert.match(body, /هيسأل عنه في الجمعية العمومية/,
        'the number is shown with no explanation of why it matters');
    }
  });
});
