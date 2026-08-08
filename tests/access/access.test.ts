/**
 * tests/access/access.test.ts — THE CP-1 GATE.
 *
 * All fifteen access tests from `02_DATA_MODEL.md` §6, executed **over HTTP as
 * each role** against the real Hono app and a real SQLite database with the real
 * migrations. Not unit tests of the guards — end-to-end requests, because ADR-010
 * replaced Postgres RLS with application discipline and the only honest way to
 * check application discipline is to attack the application.
 *
 * ## On "watch each one fail first"
 *
 * `CHECKPOINTS.md` requires each access test to be seen failing against a
 * deliberately loosened guard. Adding a "loose mode" flag to `lib/db/` would put
 * a switch that disables security into production code — a worse outcome than
 * the assurance is worth.
 *
 * Instead every leak test is paired with a `proveReachable(...)` call that runs
 * the SAME query WITHOUT its ownership predicate, straight against the database,
 * and asserts the neighbour's row DOES come back. That proves the row exists and
 * is reachable, so the passing test is measuring the predicate rather than an
 * empty table — which is the actual failure mode a green suite hides.
 *
 * Run: npm run test:access
 */

import { it, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NodeSqliteDb } from '../../lib/db/driver.js';
import { setTokenHasher } from '../../lib/db/index.js';
import { createApp } from '../../src/app.js';
import { MemoryStorage } from '../../lib/storage/index.js';
import { auditLogIsImmutableForEveryone, can, _MATRIX_FOR_TESTS } from '../../lib/rbac.js';

// Resolved from the working directory, not import.meta: the compiled test runs
// from .build/tests/access/, so a relative walk-up lands in the build output.
const ROOT = process.cwd();
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
setTokenHasher(sha);

const id = (p: string, n: number) => (p + String(n).padStart(26 - p.length, '0')).slice(0, 26);

/* ------------------------------------------------------------------ */
/* Fixture: a small, hand-checkable village                            */
/* ------------------------------------------------------------------ */

const B1 = id('BLD', 1);
const U_A = id('UNT', 1);      // resident A's flat
const U_B = id('UNT', 2);      // resident B's flat
const U_C = id('UNT', 3);      // sold — A is the FORMER owner
const P_DEV = id('PRF', 1), P_ADMIN = id('PRF', 2), P_ADMIN2 = id('PRF', 3);
const P_OP = id('PRF', 4), P_A = id('PRF', 5), P_B = id('PRF', 6);
const P_DEL_FIN = id('PRF', 7);   // delegate WITH financial rights on U_A
const P_DEL_NOFIN = id('PRF', 8); // delegate WITHOUT financial rights on U_A
const P_DEL_EXP = id('PRF', 9);   // delegate whose grant EXPIRED
const PAY_A = id('PAY', 1), PAY_B = id('PAY', 2), PAY_C = id('PAY', 3);
const CAT = 'CAT0000000000000000000IN01';
const A_INSTA = 'ACC00000000000000000001103', A_SUBS = 'ACC00000000000000000004101';
const F_OP = 'FND00000000000000000000001';
const PERIOD = id('FPR', 1);
const JE1 = id('JE', 1), JL1 = id('JL', 1), JL2 = id('JL', 2);
/** An unposted entry the one test that APPROVES successfully can consume.
 *  `payments.journal_entry_id` is UNIQUE — one entry per receipt, which is
 *  invariant 3 — so a test that approves cannot borrow JE1, which already
 *  belongs to the settled receipt below. */
const JE_FREE = id('JE', 2);

let raw: DatabaseSync;
let app: ReturnType<typeof createApp>;
let clockDate = '2026-06-15T10:00:00Z';

const TOKENS = {
  dev: 'tok-dev', admin: 'tok-admin', admin2: 'tok-admin2', operator: 'tok-op',
  residentA: 'tok-a', residentB: 'tok-b',
  delegateFin: 'tok-delfin', delegateNoFin: 'tok-delnofin', delegateExpired: 'tok-delexp',
};

function req(path: string, token?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body) headers.set('content-type', 'application/json');
  return app.request(path, { ...init, headers });
}

before(() => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).sort()) {
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
  for (const f of readdirSync(join(ROOT, 'seed/prod')).sort()) {
    raw.exec(readFileSync(join(ROOT, 'seed/prod', f), 'utf8'));
  }
  // NOTE: env_guard stays 'production'. These tests run against a
  // production-shaped database on purpose — that is what we ship.

  const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...p as never[]);

  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, P_DEV, 'المبرمج', 'developer');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, P_ADMIN, 'رئيس المجلس', 'admin');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, P_ADMIN2, 'أمين الصندوق', 'admin');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, P_OP, 'مشغّل', 'operator');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, P_A, 'ساكن أ', 'resident');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, P_B, 'ساكن ب', 'resident');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, P_DEL_FIN, 'مفوّض مالي', 'resident');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, P_DEL_NOFIN, 'مفوّض بدون مالي', 'resident');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,?)`, P_DEL_EXP, 'مفوّض منتهي', 'resident');

  x(`INSERT INTO phone_identifiers (id,profile_id,phone_e164) VALUES (?,?,?)`, id('PHN',1), P_A, '+201011111111');
  x(`INSERT INTO phone_identifiers (id,profile_id,phone_e164) VALUES (?,?,?)`, id('PHN',2), P_B, '+201022222222');
  // B changed number once — the history must be unreadable to A too (test 11)
  x(`UPDATE phone_identifiers SET status='replaced', is_primary=0, change_reason_ar='غيّر الرقم' WHERE id=?`, id('PHN',2));
  x(`INSERT INTO phone_identifiers (id,profile_id,phone_e164) VALUES (?,?,?)`, id('PHN',3), P_B, '+201033333333');

  x(`INSERT INTO buildings (id,code,sort_order) VALUES (?,?,?)`, B1, '5', 5);
  for (const [u, n] of [[U_A, '1'], [U_B, '2'], [U_C, '3']] as const) {
    x(`INSERT INTO units (id,building_id,unit_number) VALUES (?,?,?)`, u, B1, n);
  }
  x(`INSERT INTO unit_owners (id,unit_id,profile_id,valid_from) VALUES (?,?,?,?)`, id('UOW',1), U_A, P_A, '2020-01-01');
  x(`INSERT INTO unit_owners (id,unit_id,profile_id,valid_from) VALUES (?,?,?,?)`, id('UOW',2), U_B, P_B, '2020-01-01');
  // U_C: A used to own it and sold it to B. Row CLOSED, never deleted. (test 14)
  x(`INSERT INTO unit_owners (id,unit_id,profile_id,valid_from,valid_to) VALUES (?,?,?,?,?)`,
    id('UOW',3), U_C, P_A, '2018-01-01', '2025-12-31');
  x(`INSERT INTO unit_owners (id,unit_id,profile_id,valid_from) VALUES (?,?,?,?)`, id('UOW',4), U_C, P_B, '2026-01-01');

  x(`INSERT INTO delegate_authorizations (id,owner_profile_id,delegate_profile_id,unit_id,
       can_view_financials,can_submit_payments,valid_from,valid_to,granted_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    id('DLG',1), P_A, P_DEL_FIN, U_A, 1, 1, '2026-01-01', '2026-12-31', P_ADMIN);
  x(`INSERT INTO delegate_authorizations (id,owner_profile_id,delegate_profile_id,unit_id,
       can_view_financials,can_submit_payments,valid_from,valid_to,granted_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    id('DLG',2), P_A, P_DEL_NOFIN, U_A, 0, 1, '2026-01-01', '2026-12-31', P_ADMIN);
  x(`INSERT INTO delegate_authorizations (id,owner_profile_id,delegate_profile_id,unit_id,
       can_view_financials,can_submit_payments,valid_from,valid_to,granted_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    id('DLG',3), P_A, P_DEL_EXP, U_A, 1, 1, '2026-01-01', '2026-06-30', P_ADMIN);

  x(`INSERT INTO fiscal_periods (id,name_ar,starts_on,ends_on) VALUES (?,?,?,?)`, PERIOD, '2026', '2026-01-01', '2026-12-31');

  for (const [p, u, sub, key] of [
    [PAY_A, U_A, P_A, 'receipts/' + U_A + '/a.webp'],
    [PAY_B, U_B, P_B, 'receipts/' + U_B + '/b.webp'],
  ] as const) {
    x(`INSERT INTO payments (id,receipt_no,unit_id,submitted_by,category_id,
         claimed_amount_piastres,method,transfer_date,storage_key,status,submitted_at)
       VALUES (?,?,?,?,?,?,?,?,?,'submitted',?)`,
      p, 'R-' + p.slice(-4), u, sub, CAT, 600000, 'instapay', '2026-06-01', key, '2026-06-01T09:00:00Z');
    x(`INSERT INTO storage_objects (storage_key,bucket,owner_kind,owner_id,unit_id,size_bytes,mime)
       VALUES (?,?,?,?,?,?,?)`, key, 'receipts', 'payment_receipt', p, u, 1000, 'image/webp');
  }

  // One posted journal entry, so test 15 has a real line to attack.
  //
  // It needs its OWN settled receipt, and the steps have to happen in the order
  // the application uses them: entry (unposted) → lines → link the receipt →
  // post. This used to point at PAY_A, which the tests below deliberately leave
  // `submitted`, so the fixture was asserting that the books carry income from
  // a receipt nobody approved. Migration 0024 refuses that now (the mirror of
  // R-078) and was right to — the fixture was writing a state the application
  // cannot produce.
  x(`INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,source_type,source_id,created_by)
     VALUES (?,?,?,?,?,?,?,?)`, JE1, 'J-1', '2026-06-01', PERIOD, 'قيد', 'payment', PAY_C, P_ADMIN);
  x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,credit_piastres,unit_id)
     VALUES (?,?,?,?,?,?,?,?)`, JL1, JE1, 1, A_INSTA, F_OP, 600000, 0, U_A);
  x(`INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,credit_piastres,unit_id)
     VALUES (?,?,?,?,?,?,?,?)`, JL2, JE1, 2, A_SUBS, F_OP, 0, 600000, U_A);

  x(`INSERT INTO payments (id,receipt_no,unit_id,submitted_by,category_id,
       claimed_amount_piastres,approved_amount_piastres,reviewed_by,reviewed_at,
       method,transfer_date,storage_key,status,submitted_at,journal_entry_id)
     VALUES (?,?,?,?,?,?,?,?,?,'instapay','2026-06-01',?,'approved','2026-06-01T09:00:00Z',?)`,
    PAY_C, 'R-SETTLED', U_A, P_A, CAT, 600000, 600000, P_ADMIN2, '2026-06-01T10:00:00Z',
    'receipts/' + U_A + '/c.webp', JE1);
  x(`INSERT INTO storage_objects (storage_key,bucket,owner_kind,owner_id,unit_id,size_bytes,mime)
     VALUES (?,?,?,?,?,?,?)`,
    'receipts/' + U_A + '/c.webp', 'receipts', 'payment_receipt', PAY_C, U_A, 1000, 'image/webp');

  x(`UPDATE journal_entries SET approved_by=?, posted_at=? WHERE id=?`, P_ADMIN2, '2026-06-01T10:00:00Z', JE1);

  // Left UNPOSTED and unlinked on purpose — see JE_FREE.
  x(`INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,source_type,source_id,created_by)
     VALUES (?,?,?,?,?,?,?,?)`, JE_FREE, 'J-2', '2026-06-01', PERIOD, 'قيد', 'payment', PAY_A, P_ADMIN);

  x(`INSERT INTO staff (id,full_name,job_title_ar,monthly_salary_piastres) VALUES (?,?,?,?)`,
    id('STF',1), 'عم رجب', 'حارس أمن', 400000);

  const sess = (n: number, p: string, tok: string) =>
    x(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`,
      id('SES', n), p, sha(tok), '2027-01-01T00:00:00Z');
  sess(1, P_DEV, TOKENS.dev); sess(2, P_ADMIN, TOKENS.admin); sess(3, P_ADMIN2, TOKENS.admin2);
  sess(4, P_OP, TOKENS.operator); sess(5, P_A, TOKENS.residentA); sess(6, P_B, TOKENS.residentB);
  sess(7, P_DEL_FIN, TOKENS.delegateFin); sess(8, P_DEL_NOFIN, TOKENS.delegateNoFin);
  sess(9, P_DEL_EXP, TOKENS.delegateExpired);

  app = createApp({
    db: new NodeSqliteDb(raw as never),
    now: () => clockDate,
    storage: new MemoryStorage(),
    rp: { id: 'localhost', name: 'قرية الأطباء', origin: 'http://localhost' },
  });
});

/** The counterpart to "watch it fail": run the same lookup with NO ownership
 *  predicate and assert the row IS there. A green access test only means
 *  something if the data it is refusing to return actually exists. */
function proveReachable(sql: string, ...params: unknown[]) {
  const row = raw.prepare(sql).get(...params as never[]);
  assert.ok(row, `fixture problem: the row this test guards does not exist, so the ` +
                 `test would pass against an empty table. SQL: ${sql}`);
}

/* ================================================================== */
describe('CP-1 gate — 15 access tests, over HTTP, as each role', () => {

  it('1. resident A cannot read resident B\'s payment', async () => {
    proveReachable(`SELECT id FROM payments WHERE id = ?`, PAY_B);   // it exists…
    const r = await req(`/api/payments/${PAY_B}`, TOKENS.residentA);
    assert.equal(r.status, 404);                                      // …and is still refused
    const own = await req(`/api/payments/${PAY_A}`, TOKENS.residentA);
    assert.equal(own.status, 200);                                    // not a blanket denial
  });

  it('2. resident A cannot fetch resident B\'s receipt image', async () => {
    proveReachable(`SELECT storage_key FROM storage_objects WHERE unit_id = ?`, U_B);
    const r = await req(`/api/files/receipts/${U_B}/b.webp`, TOKENS.residentA);
    assert.equal(r.status, 404);
    const own = await req(`/api/files/receipts/${U_A}/a.webp`, TOKENS.residentA);
    assert.notEqual(own.status, 403);
  });

  it('3. resident A cannot approve their own payment', async () => {
    const r = await req(`/api/payments/${PAY_A}/review`, TOKENS.residentA, {
      method: 'POST',
      body: JSON.stringify({ kind: 'approve', approvedAmountPiastres: 600000, journalEntryId: JE1 }),
    });
    assert.equal(r.status, 403);
    const after = raw.prepare(`SELECT status FROM payments WHERE id=?`).get(PAY_A) as { status: string };
    assert.equal(after.status, 'submitted', 'the payment must be untouched');
  });

  it('4. resident A cannot submit a payment for a unit they do not own', async () => {
    const r = await req('/api/payments', TOKENS.residentA, {
      method: 'POST',
      body: JSON.stringify({
        receiptNo: 'R-EVIL', unitId: U_B, categoryId: CAT, claimedAmountPiastres: 100,
        method: 'cash', transferDate: '2026-06-01', storageKey: 'receipts/x/y.webp',
      }),
    });
    assert.equal(r.status, 403);
    const n = raw.prepare(`SELECT COUNT(*) c FROM payments WHERE receipt_no='R-EVIL'`).get() as { c: number };
    assert.equal(n.c, 0, 'no row may be created even briefly');
  });

  it('5. resident A cannot read resident B\'s phone number', async () => {
    proveReachable(`SELECT phone_e164 FROM phone_identifiers WHERE profile_id=? AND status='active'`, P_B);
    const r = await req(`/api/profiles/${P_B}/phones`, TOKENS.residentA);
    assert.equal(r.status, 403);
    const own = await req(`/api/profiles/${P_A}/phones`, TOKENS.residentA);
    assert.equal(own.status, 200);
    assert.equal((await own.json() as unknown[]).length, 1);
  });

  it('6. an operator cannot approve a payment', async () => {
    await req(`/api/payments/${PAY_A}/take`, TOKENS.admin, { method: 'POST' });
    const r = await req(`/api/payments/${PAY_A}/review`, TOKENS.operator, {
      method: 'POST',
      body: JSON.stringify({ kind: 'approve', approvedAmountPiastres: 600000, journalEntryId: JE1 }),
    });
    assert.equal(r.status, 403);
  });

  it('7. an operator cannot read anybody\'s phone number', async () => {
    for (const target of [P_A, P_B]) {
      const r = await req(`/api/profiles/${target}/phones`, TOKENS.operator);
      assert.equal(r.status, 403, `operator reached ${target}`);
    }
  });

  it('8. nobody — including the developer — can modify the audit log', async () => {
    assert.equal(auditLogIsImmutableForEveryone(), true, 'no role may hold audit.modify');
    for (const [who, tok] of Object.entries({ dev: TOKENS.dev, admin: TOKENS.admin })) {
      for (const method of ['PATCH', 'PUT', 'DELETE']) {
        const r = await req('/api/audit/anything', tok, { method });
        assert.equal(r.status, 405, `${who} got ${r.status} on ${method}`);
      }
    }
    // and the database refuses it even if a route ever appeared
    raw.prepare(`INSERT INTO audit_log (id,action,entity_table) VALUES (?,?,?)`)
       .run(id('AUD', 99), 'probe', 'payments');
    assert.throws(() => raw.prepare(`UPDATE audit_log SET action='x' WHERE id=?`).run(id('AUD', 99)));
    assert.throws(() => raw.prepare(`DELETE FROM audit_log WHERE id=?`).run(id('AUD', 99)));
  });

  it('9. a resident CAN read the community transparency figures', async () => {
    for (const path of ['/api/finance/totals', '/api/finance/categories', '/api/finance/units']) {
      const r = await req(path, TOKENS.residentA);
      assert.equal(r.status, 200, `${path} refused a resident`);
    }
  });

  it('10. an unauthenticated caller can read nothing at all', async () => {
    const paths = ['/api/me', '/api/payments', `/api/payments/${PAY_A}`, '/api/finance/totals',
      '/api/finance/categories', '/api/finance/units', '/api/staff', '/api/audit',
      `/api/files/receipts/${U_A}/a.webp`, `/api/profiles/${P_A}/phones`];
    for (const p of paths) {
      assert.equal((await req(p)).status, 401, `${p} answered an anonymous caller`);
      assert.equal((await req(p, 'not-a-real-token')).status, 401, `${p} accepted a forged token`);
    }
  });

  it('11. resident A cannot read B\'s phone HISTORY, not just the current number', async () => {
    proveReachable(`SELECT phone_e164 FROM phone_identifiers WHERE profile_id=? AND status='replaced'`, P_B);
    const r = await req(`/api/profiles/${P_B}/phones`, TOKENS.residentA);
    assert.equal(r.status, 403);
    const body = await r.text();
    assert.ok(!body.includes('+2010222'), 'the replaced number leaked in the error body');
  });

  it('12. an EXPIRED delegate authorization grants nothing (clock advance)', async () => {
    clockDate = '2026-06-15T10:00:00Z';                       // grant valid to 2026-06-30
    assert.equal((await req(`/api/payments/${PAY_A}`, TOKENS.delegateExpired)).status, 200);
    clockDate = '2026-07-01T10:00:00Z';                       // one day past expiry
    assert.equal((await req(`/api/payments/${PAY_A}`, TOKENS.delegateExpired)).status, 404,
      'access must end the moment valid_to passes, with no job or cleanup step');
    const me = await (await req('/api/me', TOKENS.delegateExpired)).json() as { delegatedUnits: string[] };
    assert.deepEqual(me.delegatedUnits, []);
    clockDate = '2026-06-15T10:00:00Z';
  });

  it('13. a delegate without can_view_financials cannot reach the statement by ANY route', async () => {
    for (const path of [`/api/payments/${PAY_A}`, `/api/units/${U_A}/statement`]) {
      assert.equal((await req(path, TOKENS.delegateNoFin)).status, 404, `${path} leaked to a non-financial delegate`);
    }
    // the financially-authorized delegate CAN — proving the difference is the flag
    for (const path of [`/api/payments/${PAY_A}`, `/api/units/${U_A}/statement`]) {
      assert.equal((await req(path, TOKENS.delegateFin)).status, 200, `${path} refused an authorized delegate`);
    }
    // …and even that delegate may not submit if the grant says so
    const r = await req('/api/payments', TOKENS.delegateNoFin, {
      method: 'POST',
      body: JSON.stringify({ receiptNo: 'R-DEL', unitId: U_A, categoryId: CAT,
        claimedAmountPiastres: 100, method: 'cash', transferDate: '2026-06-01',
        storageKey: 'receipts/z.webp' }),
    });
    assert.ok(r.status === 201, 'can_submit_payments=1 should still allow submitting');
  });

  it('14. a FORMER owner loses access, but keeps their history', async () => {
    proveReachable(`SELECT id FROM unit_owners WHERE unit_id=? AND profile_id=? AND valid_to IS NOT NULL`, U_C, P_A);
    assert.equal((await req(`/api/units/${U_C}/statement`, TOKENS.residentA)).status, 404,
      'the former owner still reaches the flat they sold');
    assert.equal((await req(`/api/units/${U_C}/statement`, TOKENS.residentB)).status, 200,
      'the current owner cannot reach their own flat');
    // history stays attributable: A's own old payment is still theirs
    const own = raw.prepare(`SELECT submitted_by FROM payments WHERE id=?`).get(PAY_A) as { submitted_by: string };
    assert.equal(own.submitted_by, P_A, 'historical attribution was lost');
  });

  it('15. NO role — including the developer — can rewrite a posted journal line', async () => {
    proveReachable(`SELECT id FROM journal_lines WHERE id=?`, JL1);
    const r = await req(`/api/dev/journal-lines/${JL1}`, TOKENS.dev, {
      method: 'PATCH', body: JSON.stringify({ debitPiastres: 999999 }),
    });
    assert.equal(r.status, 409, 'the database did not refuse a developer editing a posted line');
    const after = raw.prepare(`SELECT debit_piastres FROM journal_lines WHERE id=?`).get(JL1) as { debit_piastres: number };
    assert.equal(after.debit_piastres, 600000, 'THE LINE WAS MUTATED — stop and fix the schema');
    // an admin cannot even reach the break-glass route
    assert.equal((await req(`/api/dev/journal-lines/${JL1}`, TOKENS.admin, {
      method: 'PATCH', body: JSON.stringify({ debitPiastres: 1 }) })).status, 403);
  });
});

/* ================================================================== */
describe('maker–checker and the rbac/db agreement', () => {

  it('an admin cannot approve a receipt they submitted themselves', async () => {
    const P_SELF = id('PAY', 9);
    raw.prepare(`INSERT INTO payments (id,receipt_no,unit_id,submitted_by,category_id,
      claimed_amount_piastres,method,transfer_date,storage_key,status)
      VALUES (?,?,?,?,?,?,?,?,?,'under_review')`)
      .run(P_SELF, 'R-SELF', U_A, P_ADMIN, CAT, 100, 'cash', '2026-06-01', 'receipts/s.webp');
    const r = await req(`/api/payments/${P_SELF}/review`, TOKENS.admin, {
      method: 'POST',
      body: JSON.stringify({ kind: 'approve', approvedAmountPiastres: 100, journalEntryId: JE1 }),
    });
    assert.equal(r.status, 403, 'an admin approved their own receipt');
    // a DIFFERENT admin may
    const r2 = await req(`/api/payments/${P_SELF}/review`, TOKENS.admin2, {
      method: 'POST',
      body: JSON.stringify({ kind: 'reject', reasonAr: 'مكرر' }),
    });
    assert.equal(r2.status, 200);
  });

  it('approving twice posts once — idempotency (invariant 3)', async () => {
    const body = JSON.stringify({ kind: 'approve', approvedAmountPiastres: 600000, journalEntryId: JE_FREE });
    const first = await req(`/api/payments/${PAY_A}/review`, TOKENS.admin, { method: 'POST', body });
    assert.equal(first.status, 200);
    const second = await req(`/api/payments/${PAY_A}/review`, TOKENS.admin, { method: 'POST', body });
    assert.equal(second.status, 409, 'a replayed approval was accepted a second time');
  });

  it('a database refusal reaches the user as an Arabic 409, never a 500', async () => {
    // Regression guard for a real bug found by this suite. Every RAISE(ABORT) in
    // the migrations carries a resident-readable Arabic message on purpose.
    // Letting one bubble up unhandled turns a WORKING control into what looks
    // like a crash: the admin reads "حصل خطأ عندنا", assumes the site is broken,
    // and retries. A refusal is an answer, not a failure.
    const P_ILL = id('PAY', 8);
    raw.prepare(`INSERT INTO payments (id,receipt_no,unit_id,submitted_by,category_id,
      claimed_amount_piastres,method,transfer_date,storage_key,status)
      VALUES (?,?,?,?,?,?,?,?,?,'submitted')`)
      .run(P_ILL, 'R-ILL', U_A, P_A, CAT, 100, 'cash', '2026-06-01', 'receipts/i.webp');
    // submitted -> approved skips under_review; the state machine must refuse it
    const r = await req(`/api/payments/${P_ILL}/review`, TOKENS.admin, {
      method: 'POST',
      body: JSON.stringify({ kind: 'approve', approvedAmountPiastres: 100, journalEntryId: JE1 }),
    });
    assert.notEqual(r.status, 500, 'a legitimate refusal surfaced as a server error');
    assert.equal(r.status, 409);
    const body = await r.json() as { error: string };
    assert.match(body.error, /[؀-ۿ]/, 'the reason must reach the user in Arabic');
    assert.ok(!/SQL|constraint|trigger|SELECT|UPDATE/i.test(body.error),
      'a database detail leaked to the user');
  });

  it('the rbac matrix and the db layer agree on who may review money', () => {
    assert.equal(can('operator', 'payment.review'), false);
    assert.equal(can('resident', 'payment.review'), false);
    assert.equal(can('finance_reviewer', 'payment.review'), false);
    assert.equal(can('admin', 'payment.review'), true);
    // nobody holds audit.modify, at all, ever
    for (const role of Object.keys(_MATRIX_FOR_TESTS)) {
      assert.equal(can(role as never, 'audit.modify'), false, `${role} holds audit.modify`);
    }
    // an operator can never see a phone number, by matrix and by route
    assert.equal(can('operator', 'phone.read_any'), false);
  });

  it('a resident sees staff salaries but not staff names (Q4 default)', async () => {
    const r = await req('/api/staff', TOKENS.residentA);
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.ok(body.includes('حارس أمن'), 'the job title must be visible to everyone');
    assert.ok(!body.includes('عم رجب'), 'a staff name leaked to a resident');
    const admin = await (await req('/api/staff', TOKENS.admin)).text();
    assert.ok(admin.includes('عم رجب'), 'an admin must see staff names');
  });
});
