/**
 * tests/access/payment_reversal.test.ts
 *
 * The correction a RESIDENT sees. `payment.reverse` has been in the capability
 * matrix since CP-1 with nothing implementing it, which meant a wrongly-approved
 * receipt — the wrong amount typed, a duplicate approved, a transfer that later
 * bounced — was permanent.
 *
 * ## What these tests are really protecting
 * Not the arithmetic. The arithmetic is two mirrored lines and it is hard to get
 * wrong. What is easy to get wrong, and unrecoverable when you do, is the
 * social half: a family told «اتقبل إيصالك ✅» and then, with no explanation,
 * finding the money gone from their statement. In a compound that built this
 * system *because* of suspicion, that single experience undoes the project.
 *
 * So: the reason is mandatory and shown verbatim, the notification is written in
 * the same batch as the reversal, and the admin who approved it cannot be the
 * one who quietly un-approves it.
 */

import { it, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NodeSqliteDb } from '../../lib/db/driver.js';
import { setTokenHasher, resolveAuthContext, reversePayment } from '../../lib/db/index.js';
import { createApp } from '../../src/app.js';
import { D1BlobStorage } from '../../lib/storage/d1blob.js';
import type { AuthContext, Id } from '../../types/domain.js';

const ROOT = process.cwd();
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
setTokenHasher(sha);
const id = (p: string, n: number) => (p + String(n).padStart(26 - p.length, '0')).slice(0, 26);

const A1 = id('PRF', 1), A2 = id('PRF', 2), RES = id('PRF', 3), OP = id('PRF', 4);
const BLD = id('BLD', 1), U1 = id('UNT', 1), PERIOD = id('FIS', 1), FEEP = id('FEP', 1);
const PAY = id('PAY', 1), JE = id('JE', 1);
const A_BANK = 'ACC00000000000000000001102';
const I_SUBS = 'ACC00000000000000000004101';
const L_CREDIT = 'ACC00000000000000000002102';
const RP = { id: 'localhost', name: 'قرية الأطباء', origin: 'http://localhost' };
const NOW = () => '2026-08-05T12:00:00Z';

let raw: DatabaseSync, db: NodeSqliteDb, app: ReturnType<typeof createApp>;
let admin1: AuthContext, admin2: AuthContext, operator: AuthContext;

const one = <T = Record<string, unknown>>(q: string, ...p: unknown[]) =>
  raw.prepare(q).get(...p as never[]) as T | undefined;
const num_ = (q: string, ...p: unknown[]) => Number((one<{ v: number }>(q, ...p))?.v ?? 0);

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
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,'د. سعاد','resident')`, RES);
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,'مشغّل','operator')`, OP);
  for (const [n, p, tok] of [[1, A1, 'tok-a1'], [2, A2, 'tok-a2'],
                             [3, RES, 'tok-res'], [4, OP, 'tok-op']] as const)
    x(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`,
      id('SES', n), p, sha(tok), '2027-01-01T00:00:00Z');
  x(`INSERT INTO buildings (id,code,name_ar) VALUES (?,'1','ع1')`, BLD);
  x(`INSERT INTO units (id,building_id,unit_number) VALUES (?,?,'101')`, U1, BLD);
  x(`INSERT INTO unit_owners (id,unit_id,profile_id,share_bp,is_primary_contact,valid_from)
     VALUES (?,?,?,10000,1,'2020-01-01')`, id('UOW', 1), U1, RES);
  x(`INSERT INTO fiscal_periods (id,name_ar,starts_on,ends_on,status)
     VALUES (?,'2026','2026-01-01','2026-12-31','open')`, PERIOD);
  const cSubs = (raw.prepare(`SELECT id FROM categories WHERE kind='operating_income' LIMIT 1`)
    .get() as { id: string }).id;
  // Migration 0022 refuses a due inserted against a PUBLISHED period: a
  // published amount is what a resident was told they owe. So the fixture
  // does what the product does — draft, bill, then publish.
  x(`INSERT INTO fee_periods (id,name_ar,category_id,fiscal_period_id,starts_on,ends_on,
       due_on,basis,amount_piastres,is_published,created_by)
     VALUES (?,'اشتراك 2026',?,?, '2026-01-01','2026-12-31','2026-03-31','per_unit',600000,0,?)`,
    FEEP, cSubs, PERIOD, A1);
  x(`INSERT INTO unit_dues (id,fee_period_id,unit_id,amount_piastres) VALUES (?,?,?,600000)`,
    id('DUE', 1), FEEP, U1);
  x(`UPDATE fee_periods SET is_published=1 WHERE id=?`, FEEP);

  const OPF = (raw.prepare(`SELECT id FROM funds WHERE kind='operating'`).get() as { id: string }).id;

  /* A subscription paid with an OVERPAYMENT — three lines, not two. The
   * reversing entry has to mirror whatever is actually there, or the 2,000 ج.م
   * owner credit is left behind as a balance the village still owes for money
   * it no longer has. */
  x(`INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,
       source_type,source_id,created_by) VALUES (?,'J-2026-000001','2026-04-06',?,'اشتراك 101',
       'payment',?,?)`, JE, PERIOD, PAY, A2);
  x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,
       credit_piastres,unit_id) VALUES (?,?,1,?,?,800000,0,?)`, id('JL', 1), JE, A_BANK, OPF, U1);
  x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,
       credit_piastres,unit_id) VALUES (?,?,2,?,?,0,600000,?)`, id('JL', 2), JE, I_SUBS, OPF, U1);
  x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,
       credit_piastres,unit_id) VALUES (?,?,3,?,?,0,200000,?)`, id('JL', 3), JE, L_CREDIT, OPF, U1);
  x(`UPDATE journal_entries SET approved_by=?, posted_at='2026-04-06T10:00:00Z' WHERE id=?`, A1, JE);

  x(`INSERT INTO payments (id,receipt_no,unit_id,submitted_by,category_id,fee_period_id,
       claimed_amount_piastres,method,transfer_date,storage_key,image_sha256,status)
     VALUES (?,'R-2026-00001',?,?,?,?,800000,'bank_transfer','2026-04-05',?,?, 'draft')`,
    PAY, U1, RES, cSubs, FEEP, `receipts/${U1}/${PAY}.webp`, 'a'.repeat(64));
  x(`UPDATE payments SET status='submitted', submitted_at='2026-04-05T08:00:00Z' WHERE id=?`, PAY);
  x(`UPDATE payments SET status='under_review', reviewed_by=? WHERE id=?`, A2, PAY);
  // ⭐ approved by admin2. So admin2 must not be able to reverse it.
  x(`UPDATE payments SET status='approved', approved_amount_piastres=800000,
       journal_entry_id=?, reviewed_by=?, reviewed_at='2026-04-06T09:00:00Z' WHERE id=?`,
    JE, A2, PAY);

  db = new NodeSqliteDb(raw as never);
  const storage = new D1BlobStorage(db);
  app = createApp({ db, now: NOW, storage, rp: RP,
    storagePut: i => storage.put(i), storageUsedBytes: () => storage.usedBytes() });
  admin1 = (await resolveAuthContext(db, 'tok-a1', NOW))!;
  admin2 = (await resolveAuthContext(db, 'tok-a2', NOW))!;
  operator = (await resolveAuthContext(db, 'tok-op', NOW))!;
});

/* ================================================================== */
describe('who may reverse a receipt', () => {

  it('an operator cannot', async () => {
    await assert.rejects(() => reversePayment(
      operator, db, PAY as Id, 'التحويل رجع من البنك', A1 as Id, NOW));
  });

  it('⭐ the admin who APPROVED it cannot un-approve it', async () => {
    /* The mirror of maker–checker, and the one that matters here. Without it
     * one admin can approve a receipt, take the credit for it with the family,
     * and reverse it later with nobody else having looked — the shape of every
     * small-community embezzlement this project exists to prevent. */
    await assert.rejects(() => reversePayment(
      admin2, db, PAY as Id, 'التحويل رجع من البنك بعد يومين', A1 as Id, NOW),
      /مينفعش يلغيه بنفسه/, 'the approver reversed their own approval');
  });

  it('...and the database refuses it with every guard bypassed', () => {
    assert.throws(() => raw.prepare(
      `UPDATE payments SET status='reversed', review_reason_ar='محاولة مباشرة',
         reversed_by=?, reversed_at='2026-08-05T12:00:00Z' WHERE id=?`).run(A2, PAY),
      /مينفعش يلغيه بنفسه|constraint/,
      'the rule only exists in application code');
  });

  it('a reversal with no actor recorded is refused', () => {
    assert.throws(() => raw.prepare(
      `UPDATE payments SET status='reversed', review_reason_ar='من غير اسم' WHERE id=?`).run(PAY),
      /باسم اللي عمله|constraint/);
  });

  it('"غلط" is not a reason', async () => {
    await assert.rejects(() => reversePayment(admin1, db, PAY as Id, 'غلط', A2 as Id, NOW),
      /سبب واضح/);
  });

  it('an unapproved receipt has nothing to reverse', async () => {
    const p2 = id('PAY', 2);
    raw.prepare(`INSERT INTO payments (id,receipt_no,unit_id,submitted_by,category_id,
        claimed_amount_piastres,method,transfer_date,storage_key,image_sha256,status)
      VALUES (?,'R-2026-00002',?,?,(SELECT id FROM categories WHERE kind='operating_income' LIMIT 1),
        50000,'cash','2026-05-01','k',?, 'draft')`).run(p2, U1, RES, 'b'.repeat(64));
    raw.prepare(`UPDATE payments SET status='submitted' WHERE id=?`).run(p2);
    await assert.rejects(() => reversePayment(
      admin1, db, p2 as Id, 'الإيصال ده مكرر مع إيصال تاني', A2 as Id, NOW),
      /مش معتمد/, 'a pending receipt was reversed — it contributed nothing to begin with');
  });
});

/* ================================================================== */
describe('what reversing actually does', () => {
  let before_: { income: number; credit: number; bank: number; arrears: number };

  const totals = () => ({
    income: num_(`SELECT COALESCE(SUM(balance_piastres),0) v FROM v_account_balances
                   WHERE type='income'`),
    credit: num_(`SELECT COALESCE(SUM(balance_piastres),0) v FROM v_account_balances
                   WHERE code='2102'`),
    bank: num_(`SELECT COALESCE(balance_piastres,0) v FROM v_account_balances WHERE code='1102'`),
    arrears: num_(`SELECT receivables_piastres v FROM v_community_totals`),
  });

  before(() => { before_ = totals(); });

  it('the fixture starts where a real village would', () => {
    assert.equal(before_.income, 600_000, 'the dues portion is income');
    assert.equal(before_.credit, 200_000, 'the overpayment is owed back');
    assert.equal(before_.bank, 800_000);
    assert.equal(before_.arrears, 0, 'the flat has paid its 6,000');
  });

  it('⭐ a DIFFERENT admin can reverse it, and every line is mirrored', async () => {
    const entryId = await reversePayment(
      admin1, db, PAY as Id, 'التحويل رجع من البنك بعد يومين', A2 as Id, NOW);
    assert.ok(entryId);

    const after = totals();
    assert.equal(after.income, 0, 'income was not withdrawn');
    // ⭐ The 2,000 owner credit went with it. Mirroring the ORIGINAL lines
    // rather than assuming a two-line shape is what makes this right: leaving
    // the credit behind would owe the family money the village no longer has.
    assert.equal(after.credit, 0, 'the owner credit was left behind after reversal');
    assert.equal(after.bank, 0, 'the cash was not taken back out');
  });

  it('⭐ the arrears come back on their own', () => {
    // Nothing recomputes this. `v_unit_balance` counts approved payments and
    // this is no longer one, so the 6,000 reappears by construction.
    assert.equal(totals().arrears, 600_000,
      "the flat's dues did not reappear after its payment was reversed");
  });

  it('the receipt keeps its amount and its history', () => {
    const p = one(`SELECT status, claimed_amount_piastres c, approved_amount_piastres a,
                          review_reason_ar r, reversed_by rb FROM payments WHERE id=?`, PAY) as
      { status: string; c: number; a: number; r: string; rb: string };
    assert.equal(p.status, 'reversed');
    assert.equal(p.c, 800_000, 'the claimed amount was edited');
    assert.equal(p.a, 800_000, 'the approved amount was erased — the history is gone');
    assert.match(p.r, /رجع من البنك/);
    assert.equal(p.rb, A1);
  });

  it('⭐ the resident is TOLD, in the same batch', () => {
    // A reversal the resident never hears about is indistinguishable from money
    // going missing. "Notify later" is not a state this can be in.
    const n = one(`SELECT kind, title_ar t, body_ar b FROM notifications
                    WHERE profile_id=? AND kind='payment_reversed'`, RES) as
      { kind: string; t: string; b: string } | undefined;
    assert.ok(n, 'the receipt was reversed and the resident was never told');
    assert.match(n!.t, /R-2026-00001/, 'the notification does not name the receipt');
    assert.match(n!.b, /رجع من البنك/, "the reason the resident reads is not the admin's reason");
    assert.match(n!.b, /كلّم الإدارة/, 'the resident is not told what to do about it');
  });

  it('nothing was left un-notified', () => {
    // `v_payment_notifications` (0016) replaced `v_reversed_payments`, whose
    // `notified` matched on kind + link_path rather than the payment id — a
    // weak check that read like a strong one (R-063). This joins on the id and
    // covers every terminal decision, not only reversal: a rejected receipt
    // nobody was told about is the same failure in different clothes.
    assert.equal(num_(`SELECT COUNT(*) v FROM v_payment_notifications WHERE messages = 0`), 0,
      'a decided payment has no notification');
  });

  it('the ledger still balances, and the deposit fund is untouched', () => {
    assert.equal(num_(`SELECT residual_piastres v FROM v_accounting_equation`), 0);
    const f = one(`SELECT net_debit_piastres h, owed_piastres o FROM v_fund_balances
                    WHERE kind='deposit'`) as { h: number; o: number };
    assert.ok(f.h >= f.o, 'a payment reversal reached the deposit fund');
  });

  it('reversing twice is refused', async () => {
    await assert.rejects(() => reversePayment(
      admin1, db, PAY as Id, 'محاولة إلغاء تانية للإيصال', A2 as Id, NOW),
      /مش معتمد/, 'a receipt was reversed twice — the ledger is now double-credited');
  });

  it('the whole thing is on the record with a name against it', () => {
    const a = one(`SELECT actor_id, before_json b, after_json af FROM audit_log
                    WHERE action='payment.reverse' AND entity_id=?`, PAY) as
      { actor_id: string; b: string; af: string } | undefined;
    assert.ok(a, 'a payment was reversed with no audit row');
    assert.equal(a!.actor_id, A1);
    assert.match(a!.b, /approved/);
    assert.match(a!.af, /reversed/);
  });
});

/* ================================================================== */
describe('the resident sees it on their own screen', () => {

  it('the reversed receipt is still listed, not hidden', async () => {
    const r = await app.request('/payments', { headers: { authorization: 'Bearer tok-res' } });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.ok(body.includes('R-2026-00001'),
      'the reversed receipt vanished from the resident\'s list — that reads as money going missing');
  });

  it('a neighbour still cannot see any of it', async () => {
    const other = id('PRF', 9);
    raw.prepare(`INSERT INTO profiles (id,full_name,role) VALUES (?,'جار','resident')`).run(other);
    raw.prepare(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`)
      .run(id('SES', 9), other, sha('tok-other'), '2027-01-01T00:00:00Z');
    const r = await app.request('/payments', { headers: { authorization: 'Bearer tok-other' } });
    const body = await r.text();
    assert.ok(!body.includes('R-2026-00001'), 'a neighbour can see a reversed receipt');
    assert.ok(!body.includes('رجع من البنك'), "a neighbour can read another family's reversal reason");
  });
});

/* ================================================================== */
describe('the reversal screen — a control nobody can reach does not exist', () => {
  /**
   * The engine, the two-admin control and the notification all shipped a
   * session before this screen did, reachable only from a test. That meant the
   * board could not correct a wrongly-approved receipt at all — so in practice
   * the feature was not built, however many tests passed.
   */
  const P2 = id('PAY', 5), JE2 = id('JE', 5);

  before(() => {
    const x = (q: string, ...p: unknown[]) => raw.prepare(q).run(...p as never[]);
    const OPF = (raw.prepare(`SELECT id FROM funds WHERE kind='operating'`).get() as
      { id: string }).id;
    const cSubs = (raw.prepare(`SELECT id FROM categories WHERE kind='operating_income' LIMIT 1`)
      .get() as { id: string }).id;
    x(`INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,
         source_type,source_id,created_by) VALUES (?,'J-2026-000900','2026-05-06',?,'اشتراك',
         'payment',?,?)`, JE2, PERIOD, P2, A1);
    x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,
         credit_piastres,unit_id) VALUES (?,?,1,?,?,600000,0,?)`, id('JL', 20), JE2, A_BANK, OPF, U1);
    x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,
         credit_piastres,unit_id) VALUES (?,?,2,?,?,0,600000,?)`, id('JL', 21), JE2, I_SUBS, OPF, U1);
    x(`UPDATE journal_entries SET approved_by=?, posted_at='2026-05-06T10:00:00Z' WHERE id=?`, A2, JE2);
    x(`INSERT INTO payments (id,receipt_no,unit_id,submitted_by,category_id,fee_period_id,
         claimed_amount_piastres,method,transfer_date,storage_key,image_sha256,status)
       VALUES (?,'R-2026-00005',?,?,?,?,600000,'instapay','2026-05-05',?,?, 'draft')`,
      P2, U1, RES, cSubs, FEEP, `receipts/${U1}/${P2}.webp`, 'c'.repeat(64));
    x(`UPDATE payments SET status='submitted' WHERE id=?`, P2);
    x(`UPDATE payments SET status='under_review', reviewed_by=? WHERE id=?`, A1, P2);
    // ⭐ approved by admin1 this time, so admin1 must be excluded and admin2 not.
    x(`UPDATE payments SET status='approved', approved_amount_piastres=600000,
         journal_entry_id=?, reviewed_by=?, reviewed_at='2026-05-06T09:00:00Z' WHERE id=?`,
      JE2, A1, P2);
  });

  const get = (path: string, tok: string) =>
    app.request(path, { headers: { authorization: `Bearer ${tok}` } });
  const post = (path: string, body: Record<string, string>, tok: string) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded',
                 authorization: `Bearer ${tok}` },
      body: new URLSearchParams(body).toString(),
    });

  it('⭐ the approver sees the reason, not a button', async () => {
    const body = await (await get('/admin/payments', 'tok-a1')).text();
    assert.match(body, /إنت اللي اعتمدت الإيصال ده/,
      'the approving admin is excluded but never told why');
    assert.ok(!body.includes(`/admin/payments/${P2}/reverse`),
      'the admin who approved this receipt is offered a reverse button');
  });

  it('...and the OTHER admin does see the button', async () => {
    const body = await (await get('/admin/payments', 'tok-a2')).text();
    assert.ok(body.includes(`/admin/payments/${P2}/reverse`),
      'no admin can reverse this receipt — the correction is unreachable');
  });

  it('a resident cannot reach the list at all', async () => {
    assert.equal((await get('/admin/payments', 'tok-res')).status, 403);
  });

  it('the form warns about the resident BEFORE the fields', async () => {
    const body = await (await get(`/admin/payments/${P2}/reverse`, 'tok-a2')).text();
    assert.match(body, /الساكن اتقاله إن الإيصال ده اتقبل/,
      'the form does not say the resident was already told it was accepted');
    assert.ok(body.indexOf('اتقاله إن الإيصال ده اتقبل') < body.indexOf('name="reason"'),
      'the warning is below the fields, after the decision is already made');
    assert.ok(!body.includes('<script'), 'the reversal form ships JavaScript');
  });

  it('⭐ the second-admin dropdown never contains your own name', async () => {
    const body = await (await get(`/admin/payments/${P2}/reverse`, 'tok-a2')).text();
    assert.ok(!body.includes(`value="${A2}"`),
      'the caller can select themselves as the second admin — the control invites its own bypass');
    assert.ok(body.includes(`value="${A1}"`), 'the other admin is not selectable');
  });

  it('a weak reason is refused and re-rendered on the same form', async () => {
    const r = await post(`/admin/payments/${P2}/reverse`, { reason: 'غلط', second: A1 }, 'tok-a2');
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /سبب واضح/, 'a one-word reason passed through the screen');
    assert.match(body, /name="reason"/, 'the form was not re-rendered, so the admin lost their work');
  });

  it('⭐ it works end to end, and the resident is told', async () => {
    const r = await post(`/admin/payments/${P2}/reverse`,
      { reason: 'الإيصال اتسجّل على الشقة الغلط', second: A1 }, 'tok-a2');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /اتلغى الاعتماد، والساكن اتبلّغ/);

    const p = one<{ status: string; rb: string }>(
      `SELECT status, reversed_by rb FROM payments WHERE id=?`, P2);
    assert.equal(p!.status, 'reversed');
    assert.equal(p!.rb, A2);
    // Matched on the receipt number, not "the newest": `created_at` is only
    // second-precision, so two reversals in the same second order arbitrarily.
    const n = one<{ b: string }>(
      `SELECT body_ar b FROM notifications
        WHERE profile_id=? AND kind='payment_reversed' AND title_ar LIKE ?`,
      RES, '%R-2026-00005%');
    assert.match(n!.b, /الشقة الغلط/, 'the resident was not told, or not told the reason');
  });

  it('the reversed receipt stays on the list, marked', async () => {
    const body = await (await get('/admin/payments', 'tok-a2')).text();
    assert.ok(body.includes('R-2026-00005'), 'a reversed receipt vanished from the admin list');
    assert.match(body, /اتلغى/, 'the reversal is not marked');
    assert.ok(!body.includes(`/admin/payments/${P2}/reverse`),
      'a reversed receipt still offers a reverse button');
  });
});
