/**
 * tests/access/settlements.test.ts — the three cycles from migration 0021.
 *
 * ## What each block is actually defending
 *
 * These are not CRUD tests. Each one pins a control that, if it failed, would
 * fail *silently* — the accounting equation would still balance and every
 * screen would still render, while the books said something untrue:
 *
 *   · a timing difference posted → the payment is counted twice when the
 *     cheque clears, and nothing ever flags it;
 *   · a credit applied twice → the village discharges a debt it owes once,
 *     twice, and the owner is the only person who would notice;
 *   · a period reopened by its own closer → "the year is final" means nothing;
 *   · a settlement reversed by the pair who posted it → two people who agreed
 *     can post and unpost without anyone else learning.
 *
 * Every refusal below is asserted against the DATABASE, with the data layer
 * bypassed where possible, because ADR-024 says a control that must hold lives
 * in the schema. A test that only exercises the TypeScript proves the message,
 * not the control.
 */

import { it, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NodeSqliteDb } from '../../lib/db/driver.js';
import * as s from '../../lib/db/settlements.js';
import type { AuthContext } from '../../types/domain.js';

const ROOT = process.cwd();
const id = (p: string, n: number) => (p + String(n).padStart(26 - p.length, '0')).slice(0, 26);

const P_MAKER = id('PRF', 1), P_CHECKER = id('PRF', 2), P_THIRD = id('PRF', 3);
const B1 = id('BLD', 1), U1 = id('UNT', 1);
const PERIOD = id('FPR', 1), FEEP = id('FEP', 1), DUE = id('DUE', 1);
const RECON = id('REC', 1), CREDIT = id('CRD', 1);
const A_BANK = 'ACC00000000000000000001102';
const CAT_IN = 'CAT0000000000000000000IN01';

const NOW = () => '2026-08-06T12:00:00Z';
let raw: DatabaseSync;
let db: NodeSqliteDb;

/** A context is a plain object here: these tests are about accounting controls,
 *  not about session resolution, which auth.test.ts already covers. */
const ctxFor = (personId: string, role: AuthContext['role']): AuthContext => ({
  personId: personId as never, role, ownedUnitIds: [], delegatedUnits: [],
  sessionId: id('SES', 1) as never, reauthAt: null,
});
const maker = () => ctxFor(P_MAKER, 'admin');
const checker = () => ctxFor(P_CHECKER, 'admin');
const third = () => ctxFor(P_THIRD, 'admin');

before(() => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).sort())
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  for (const f of readdirSync(join(ROOT, 'seed/prod')).sort())
    raw.exec(readFileSync(join(ROOT, 'seed/prod', f), 'utf8'));
  db = new NodeSqliteDb(raw as never);

  const x = (q: string, ...p: unknown[]) => raw.prepare(q).run(...p as never[]);
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,'admin')`, P_MAKER, 'أمين الصندوق');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,'admin')`, P_CHECKER, 'رئيس المجلس');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,'admin')`, P_THIRD, 'عضو تالت');
  x(`INSERT INTO buildings (id,code,name_ar,sort_order) VALUES (?,'1','عمارة 1',1)`, B1);
  x(`INSERT INTO units (id,building_id,unit_number) VALUES (?,?,'101')`, U1, B1);
  x(`INSERT INTO fiscal_periods (id,name_ar,starts_on,ends_on,status)
     VALUES (?,'2026','2026-01-01','2026-12-31','open')`, PERIOD);
  // Migration 0022 refuses a due inserted against a PUBLISHED period: a
  // published amount is what a resident was told they owe. So the fixture
  // does what the product does — draft, bill, then publish.
  x(`INSERT INTO fee_periods (id,name_ar,category_id,fiscal_period_id,starts_on,ends_on,
       due_on,basis,amount_piastres,is_published,created_by)
     VALUES (?,'اشتراك 2026',?,?,'2026-01-01','2026-12-31','2026-03-31','per_unit',
       250000,0,?)`, FEEP, CAT_IN, PERIOD, P_MAKER);
  x(`INSERT INTO unit_dues (id,fee_period_id,unit_id,amount_piastres)
     VALUES (?,?,?,250000)`, DUE, FEEP, U1);
  x(`UPDATE fee_periods SET is_published=1 WHERE id=?`, FEEP);
  x(`INSERT INTO reconciliations (id,account_id,period_id,as_of,statement_balance_piastres,
       book_balance_piastres,difference_piastres,notes_ar,done_by)
     VALUES (?,?,?,'2026-07-31',100000,97000,3000,'فرق مش مفسّر',?)`,
    RECON, A_BANK, PERIOD, P_MAKER);
  // The village owes this unit 1,000.00 ج.م from an overpayment.
  x(`INSERT INTO resident_credits (id,unit_id,amount_piastres) VALUES (?,?,100000)`,
    CREDIT, U1);
});

/* ================================================================== */
describe('⭐ a timing difference can never post', () => {

  it('the data layer refuses it with an explanation, not a constraint name', async () => {
    const adjId = await s.requestAdjustment(maker(), db, {
      reconciliationId: RECON as never, kind: 'timing', amountPiastres: 3000,
      reasonAr: 'شيك اتكتب 30 يونيو وهيصفّى أول يوليو',
    }, NOW);
    await assert.rejects(
      () => s.approveAndPostAdjustment(checker(), db, adjId, PERIOD as never, NOW),
      /فرق التوقيت|timing/,
      'a timing difference posted — the payment will be counted twice when it clears');
  });

  it('…and the DATABASE refuses it with the whole data layer bypassed', () => {
    const a = raw.prepare(
      `SELECT id FROM reconciliation_adjustments WHERE kind='timing' LIMIT 1`
    ).get() as { id: string };
    assert.throws(
      () => raw.prepare(`UPDATE reconciliation_adjustments SET status='posted' WHERE id=?`)
        .run(a.id as never),
      /فرق التوقيت|timing/,
      'the trigger did not hold — a control that only lives in TypeScript is not a control');
  });

  it('but it CAN be examined and dismissed, so the queue clears honestly', async () => {
    const a = raw.prepare(
      `SELECT id FROM reconciliation_adjustments WHERE kind='timing' LIMIT 1`
    ).get() as { id: string };
    await s.dismissTiming(checker(), db, a.id as never, 'اتراجع — شيك في الطريق', NOW);
    assert.equal(
      (raw.prepare(`SELECT status FROM reconciliation_adjustments WHERE id=?`)
        .get(a.id) as { status: string }).status, 'rejected');
  });
});

/* ================================================================== */
describe('settlement maker–checker', () => {

  let adjId = '';

  before(async () => {
    adjId = await s.requestAdjustment(maker(), db, {
      reconciliationId: RECON as never, kind: 'bank_fee', amountPiastres: 3000,
      reasonAr: 'مصاريف إدارة حساب من البنك',
    }, NOW) as string;
  });

  it('the person who raised it cannot approve it', async () => {
    await assert.rejects(
      () => s.approveAndPostAdjustment(maker(), db, adjId as never, PERIOD as never, NOW),
      /محدش بيعتمد|maker/,
      'the maker approved their own settlement');
  });

  it('a second person can, and it posts a balanced entry', async () => {
    const { entryId } = await s.approveAndPostAdjustment(
      checker(), db, adjId as never, PERIOD as never, NOW);
    const sums = raw.prepare(
      `SELECT SUM(debit_piastres) dr, SUM(credit_piastres) cr
         FROM journal_lines WHERE entry_id = ?`
    ).get(entryId) as { dr: number; cr: number };
    assert.equal(sums.dr, sums.cr, 'the settlement entry does not balance');
    assert.equal(sums.dr, 3000);
    assert.equal(
      (raw.prepare(`SELECT posted_at FROM journal_entries WHERE id=?`)
        .get(entryId) as { posted_at: string | null }).posted_at !== null, true);
  });

  it('a bank fee lands in the expense account, not in suspense', () => {
    const line = raw.prepare(
      `SELECT account_id FROM journal_lines
        WHERE debit_piastres = 3000 AND entry_id IN
              (SELECT id FROM journal_entries WHERE source_type='adjustment')
        LIMIT 1`
    ).get() as { account_id: string };
    assert.equal(line.account_id, 'ACC00000000000000000005902');
  });

  it('⭐ reversing it needs a THIRD person — not the maker, not the checker', async () => {
    for (const who of [maker(), checker()]) {
      await assert.rejects(
        () => s.reverseAdjustment(who, db, adjId as never, PERIOD as never,
          'اتضح إنها مش مصاريف بنكية', NOW),
        /شخث تالت|شخص تالت|third person/,
        'the pair who posted it could also unpost it, with nobody else knowing');
    }
    const { entryId } = await s.reverseAdjustment(
      third(), db, adjId as never, PERIOD as never, 'اتضح إنها مش مصاريف بنكية', NOW);
    assert.ok(entryId);
    // The original stays visible — a correction that hides its target is not one.
    assert.equal(
      (raw.prepare(`SELECT status FROM reconciliation_adjustments WHERE id=?`)
        .get(adjId) as { status: string }).status, 'reversed');
  });

  it('and the whole thing nets to zero in the ledger', () => {
    const net = raw.prepare(
      `SELECT COALESCE(SUM(l.debit_piastres - l.credit_piastres),0) v
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.source_type='adjustment' AND l.account_id='ACC00000000000000000005902'`
    ).get() as { v: number };
    assert.equal(net.v, 0, 'the reversal did not cancel the original');
  });
});

/* ================================================================== */
describe('⭐ credit ceilings — the village cannot discharge what it does not owe', () => {

  it('an apply larger than the remaining credit is refused', async () => {
    await assert.rejects(
      () => s.requestCreditOperation(maker(), db, {
        creditId: CREDIT as never, operation: 'apply', amountPiastres: 150_000,
        appliedToDueId: DUE as never, reasonAr: 'خصم من المستحق',
      }, NOW),
      /المتاح|exceeds/,
      'the village discharged more credit than it owed');
  });

  it('an apply larger than the outstanding due is refused BY THE DATABASE', () => {
    // Bypassing the data layer entirely, to isolate the second trigger from the
    // first: the apply has to be UNDER the credit ceiling and OVER the due one.
    //
    // The outstanding due is lowered with a WAIVER rather than by editing the
    // billed amount, because migration 0022 refuses the edit — 2,500.00 is what
    // the resident was told they owe, and a waiver is the mechanism that exists
    // for changing what they have to pay without rewriting that. The trigger
    // nets waivers off, which is the behaviour being relied on here.
    raw.prepare(
      `UPDATE unit_dues SET waived_piastres = 200000,
         waiver_reason_ar = 'قرار مجلس — ظروف اجتماعية موثّقة',
         waived_by = ?, waived_at = '2026-05-01T10:00:00Z'
        WHERE id = ?`).run(P_MAKER as never, DUE as never);
    assert.throws(
      () => raw.prepare(
        `INSERT INTO credit_operations (id,credit_id,unit_id,operation,amount_piastres,
           applied_to_due_id,reason_ar,requested_by)
         VALUES (?,?,?,'apply',90000,?,'زيادة',?)`
      ).run(id('CRO', 9) as never, CREDIT as never, U1 as never, DUE as never, P_MAKER as never),
      /أكتر من المستحق|exceed/,
      'an application exceeded the due — it would create a new credit while claiming to clear one');
    raw.prepare(`UPDATE unit_dues SET amount_piastres = 250000 WHERE id = ?`)
      .run(DUE as never);
  });

  it('a legitimate partial apply posts, and leaves the remainder claimable', async () => {
    const opId = await s.requestCreditOperation(maker(), db, {
      creditId: CREDIT as never, operation: 'apply', amountPiastres: 40_000,
      appliedToDueId: DUE as never, reasonAr: 'خصم جزئي من اشتراك 2026',
    }, NOW);
    await s.approveAndPostCreditOperation(checker(), db, opId, PERIOD as never, NOW);

    const remaining = raw.prepare(
      `SELECT remaining_piastres v FROM v_open_resident_credits WHERE credit_id = ?`
    ).get(CREDIT) as { v: number } | undefined;
    assert.equal(remaining?.v, 60_000,
      'a partial application did not leave the remainder claimable');
  });

  it('a refund must name the channel it left by', () => {
    assert.throws(
      () => raw.prepare(
        `INSERT INTO credit_operations (id,credit_id,unit_id,operation,amount_piastres,
           reason_ar,requested_by) VALUES (?,?,?,'refund',10000,'ردّ',?)`
      ).run(id('CRO', 8) as never, CREDIT as never, U1 as never, P_MAKER as never),
      /CHECK|constraint/,
      'a refund with no payout account — untraceable by construction');
  });

  it('a posted credit operation cannot be edited', () => {
    const op = raw.prepare(
      `SELECT id FROM credit_operations WHERE status='posted' LIMIT 1`
    ).get() as { id: string };
    assert.throws(
      () => raw.prepare(`UPDATE credit_operations SET amount_piastres=1 WHERE id=?`)
        .run(op.id as never),
      /مش بتتعدّل/);
  });
});

/* ================================================================== */
describe('period close and reopen', () => {

  it('refuses to close over an expense that has not posted', async () => {
    raw.prepare(
      `INSERT INTO expenses (id,voucher_no,category_id,amount_piastres,
         spent_on,description_ar,status,recorded_by)
       SELECT ?, 'V-9', c.id, 5000, '2026-06-01', 'مصروف معلّق', 'recorded', ?
         FROM categories c WHERE c.kind='expense' LIMIT 1`
    ).run(id('EXP', 9) as never, P_MAKER as never);

    await assert.rejects(
      () => s.closePeriod(checker(), db, PERIOD as never, NOW),
      /مصروفات لسه|pending expenses/,
      'a period closed over an unposted expense — the year understates its spending');

    // Deleted rather than "rejected": `expenses.status` has no such value —
    // an expense is recorded, countersigned, posted or reversed. An unposted
    // one that turns out to be a mistake is removed before it ever hits a book.
    raw.prepare(`DELETE FROM expenses WHERE id=?`).run(id('EXP', 9) as never);
  });

  it('refuses to close over an unsettled reconciliation difference', async () => {
    const open = await s.requestAdjustment(maker(), db, {
      reconciliationId: RECON as never, kind: 'unrecorded_payment', amountPiastres: 1200,
      reasonAr: 'تحويل مش متسجّل في الدفاتر',
    }, NOW);
    await assert.rejects(
      () => s.closePeriod(checker(), db, PERIOD as never, NOW),
      /فروق مطابقة|reconciliation/,
      'a period closed with an open difference still hanging');
    await s.approveAndPostAdjustment(third(), db, open, PERIOD as never, NOW);
  });

  it('closes once everything is settled, and records who did it', async () => {
    await s.closePeriod(checker(), db, PERIOD as never, NOW);
    const p = raw.prepare(`SELECT status, closed_by FROM fiscal_periods WHERE id=?`)
      .get(PERIOD) as { status: string; closed_by: string };
    assert.equal(p.status, 'closed');
    assert.equal(p.closed_by, P_CHECKER);
    assert.equal(
      (raw.prepare(`SELECT COUNT(*) n FROM period_events WHERE period_id=? AND event='closed'`)
        .get(PERIOD) as { n: number }).n, 1);
  });

  it('⭐ the person who closed it cannot reopen it', async () => {
    await assert.rejects(
      () => s.reopenPeriod(checker(), db, PERIOD as never,
        'ظهر إيصال قديم محتاج يتسجّل', NOW),
      /مينفعش هو اللي يفتحها|cannot be the one to reopen/,
      'the closer reopened their own period — closing is decorative');
  });

  it('…and the DATABASE agrees, with the data layer bypassed', () => {
    assert.throws(
      () => raw.prepare(
        `UPDATE fiscal_periods SET status='reopened', reopened_by=?, reopen_reason_ar=?
          WHERE id=?`
      ).run(P_CHECKER as never, 'محاولة مباشرة' as never, PERIOD as never),
      /مينفعش هو اللي يفتحها|reopen/);
  });

  it('a different board member can, with a written reason, and it is logged', async () => {
    await s.reopenPeriod(third(), db, PERIOD as never, 'ظهر إيصال قديم محتاج يتسجّل', NOW);
    const hist = await s.periodHistory(third(), db, PERIOD as never) as Array<{
      event: string; actor_name: string; reason_ar: string | null;
    }>;
    assert.equal(hist.length, 2, 'the close/reopen sequence was not recorded');
    assert.equal(hist[0]!.event, 'reopened');
    assert.match(String(hist[0]!.reason_ar), /إيصال قديم/);
  });

  it('the period-event log is append-only, like every other record of who did what', () => {
    assert.throws(
      () => raw.prepare(`UPDATE period_events SET reason_ar='حاجة تانية'`).run(),
      /مش بيتعدّل/);
    assert.throws(() => raw.prepare(`DELETE FROM period_events`).run(), /مش بيتمسح/);
  });
});

/* ================================================================== */
describe('the ledger still balances after every cycle above', () => {

  it('the accounting equation residual is exactly 0', () => {
    const r = raw.prepare(`SELECT residual_piastres v FROM v_accounting_equation`)
      .get() as { v: number };
    assert.equal(r.v, 0, 'the settlement cycles broke the accounting equation');
  });

  it('suspense carries what was posted to it, and it is visible', () => {
    const sus = raw.prepare(`SELECT balance_piastres v, entries n FROM v_suspense_balance`)
      .get() as { v: number; n: number };
    // The unrecorded_payment above debited suspense by 1,200.
    assert.equal(sus.v, 1200, 'suspense does not hold the unexplained money');
    assert.ok(sus.n >= 1, 'suspense reports no entries — /admin/health would show nothing');
  });
});
