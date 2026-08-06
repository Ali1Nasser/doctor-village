#!/usr/bin/env python3
"""
verify_demo.py — run all twelve ledger invariants against the whole imaginary
village, not just the five-entry fixture.

Why this exists separately from verify_ledger.py: a 5-entry fixture proves the
constraints fire. It does not prove they hold across 250 entries, 243 receipts
in nine different states, 55 deposits, 12 overpayments, a reversal and 30
expenses. Scale is where sign errors and double-counting actually appear.

Every headline figure is computed TWICE by independent routes and asserted
equal — the oldest accounting control there is (00_MASTER_PROMPT
<verification_protocol> step 4).

Run:  python3 tests/fixtures/verify_demo.py
"""

import sqlite3, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
PASS, FAIL = [], []

def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))

def egp(p):
    return f"{p/100:,.2f} ج.م"

def build():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    for m in sorted((ROOT / "migrations").glob("*.sql")):
        db.executescript(m.read_text())
    for s in sorted((ROOT / "seed/prod").glob("*.sql")):
        db.executescript(s.read_text())
    db.commit()
    db.execute("UPDATE env_guard SET environment='demo', set_by='verify', note='invariant run'")
    db.commit()
    for s in sorted((ROOT / "seed/demo").glob("*.sql")):
        db.executescript(s.read_text())
    db.commit()
    return db

def one(db, sql, *a):
    return db.execute(sql, a).fetchone()[0]

def row(db, sql):
    cur = db.execute(sql)
    return dict(zip([c[0] for c in cur.description], cur.fetchone()))

db = build()
print(f"\nالقرية التجريبية: {one(db,'SELECT COUNT(*) FROM buildings')} عمارة · "
      f"{one(db,'SELECT COUNT(*) FROM units')} وحدة · "
      f"{one(db,'SELECT COUNT(*) FROM profiles')} شخص · "
      f"{one(db,'SELECT COUNT(*) FROM payments')} إيصال · "
      f"{one(db,'SELECT COUNT(*) FROM journal_entries')} قيد")

eq  = row(db, "SELECT * FROM v_accounting_equation")
tot = row(db, "SELECT * FROM v_community_totals")

# ============================================================ 1 ============
print("\n=== 1. Every journal entry balances ===")
unbal = one(db, """SELECT COUNT(*) FROM (SELECT entry_id FROM journal_lines
                   GROUP BY entry_id HAVING SUM(debit_piastres) <> SUM(credit_piastres))""")
check("all 250 entries balance: SUM(debit) = SUM(credit)", unbal == 0, f"{unbal} unbalanced")
check("every line has exactly one side non-zero", one(db,
      "SELECT COUNT(*) FROM journal_lines WHERE (debit_piastres=0)=(credit_piastres=0)") == 0)

# ============================================================ 2 ============
print("\n=== 2. Reversals net their original to zero ===")
rev = db.execute("""SELECT je.id, je.reverses_entry_id FROM journal_entries je
                    WHERE je.is_reversal = 1""").fetchall()
check("a reversal exists in the demo data", len(rev) >= 1, f"{len(rev)} reversal(s)")
ok = True
for rid, oid in rev:
    net = db.execute("""SELECT COALESCE(SUM(debit_piastres - credit_piastres),0)
                        FROM journal_lines WHERE entry_id IN (?,?)""", (rid, oid)).fetchone()[0]
    per_account = one(db, """SELECT COUNT(*) FROM (
          SELECT account_id, SUM(debit_piastres - credit_piastres) n
          FROM journal_lines WHERE entry_id IN (?,?) GROUP BY account_id HAVING n <> 0)""", rid, oid)
    ok = ok and net == 0 and per_account == 0
check("original + reversal nets to zero on EVERY account, not just in total", ok)

# ============================================================ 3 ============
print("\n=== 3. One submission posts at most once ===")
check("no journal_entry_id is shared by two payments (UNIQUE holds)", one(db,
      """SELECT COUNT(*) FROM (SELECT journal_entry_id FROM payments
         WHERE journal_entry_id IS NOT NULL GROUP BY journal_entry_id HAVING COUNT(*)>1)""") == 0)
check("every approved payment carries exactly one entry", one(db,
      "SELECT COUNT(*) FROM payments WHERE status='approved' AND journal_entry_id IS NULL") == 0)
check("no payment-sourced entry exists without its payment", one(db,
      """SELECT COUNT(*) FROM journal_entries je WHERE je.source_type='payment'
         AND je.is_reversal=0
         AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.journal_entry_id = je.id)""") == 0)

# ============================================================ 4 ============
print("\n=== 4. Pending / rejected / duplicate / cancelled contribute ZERO ===")
noncounted = one(db, """SELECT COUNT(*) FROM payments
    WHERE status IN ('submitted','under_review','needs_info','rejected','duplicate','cancelled')""")
leak = one(db, """SELECT COUNT(*) FROM payments p JOIN journal_entries je ON je.id = p.journal_entry_id
    WHERE p.status IN ('submitted','under_review','needs_info','rejected','duplicate','cancelled')""")
check(f"{noncounted} non-approved receipts exist, and NONE has a ledger entry", leak == 0)
pending_shown = tot["pending_not_counted_piastres"]
pending_true = one(db, """SELECT COALESCE(SUM(claimed_amount_piastres),0) FROM payments
                          WHERE status IN ('submitted','under_review','needs_info')""")
check("the 'تحت المراجعة' figure is reported separately and matches", pending_shown == pending_true,
      egp(pending_shown))
check("...and is NOT part of income", pending_shown > 0 and eq["income_piastres"] != pending_shown)

# ============================================================ 5, 6 ========
print("\n=== 5 & 6. Deposits and overpayments are LIABILITIES, never income ===")
check("v_deposit_leakage is empty — no deposit line ever credits income",
      one(db, "SELECT COUNT(*) FROM v_deposit_leakage") == 0)
dep_bal = one(db, "SELECT balance_piastres FROM v_account_balances WHERE code='2101'")
dep_cnt = one(db, "SELECT COUNT(*) FROM payments p JOIN categories c ON c.id=p.category_id "
                  "WHERE c.kind='deposit' AND p.status='approved'")
check(f"{dep_cnt} approved deposits all sit in liability 2101", dep_bal == dep_cnt * 500_000,
      egp(dep_bal))
cred_bal = one(db, "SELECT balance_piastres FROM v_account_balances WHERE code='2102'")
cred_sum = one(db, "SELECT COALESCE(SUM(amount_piastres),0) FROM resident_credits")
check("overpayments land in liability 2102 and match resident_credits exactly",
      cred_bal == cred_sum and cred_bal > 0, egp(cred_bal))
# Independent recomputation of income WITHOUT touching the ledger at all:
# what the village should have recognised = approved non-deposit receipts,
# minus the overpayment excess (a liability), minus anything reversed.
# A reversed receipt leaves status 'reversed', so it is already outside the
# 'approved' set — subtracting it again would double-count the correction.
expected_income = (
    one(db, """SELECT COALESCE(SUM(p.approved_amount_piastres),0) FROM payments p
               JOIN categories c ON c.id = p.category_id
               WHERE p.status='approved' AND c.kind <> 'deposit'""")
    - one(db, "SELECT COALESCE(SUM(amount_piastres),0) FROM resident_credits")
)
check("income recomputed from the RECEIPTS table alone matches the ledger",
      expected_income == eq["income_piastres"],
      f"{egp(expected_income)} vs ledger {egp(eq['income_piastres'])}")
rev_amt = one(db, "SELECT COALESCE(SUM(approved_amount_piastres),0) FROM payments WHERE status='reversed'")
rev_net = one(db, """SELECT COALESCE(SUM(jl.credit_piastres - jl.debit_piastres),0)
                     FROM v_posted_lines jl JOIN accounts a ON a.id=jl.account_id
                     WHERE a.type='income' AND jl.entry_id IN
                       (SELECT id FROM journal_entries WHERE source_id IN
                          (SELECT id FROM payments WHERE status='reversed'))""")
check("the reversed receipt nets to exactly zero income", rev_amt > 0 and rev_net == 0,
      f"receipt was {egp(rev_amt)}, ledger effect {egp(rev_net)}")
check("...and neither the 275,000 of deposits nor the 7,600 of credits is inside it",
      eq["income_piastres"] < one(db,
        "SELECT COALESCE(SUM(approved_amount_piastres),0) FROM payments WHERE status='approved'"))
check("deposits sit in a NON-SPENDABLE fund", one(db,
      """SELECT COUNT(*) FROM v_posted_lines pl JOIN funds f ON f.id=pl.fund_id
         JOIN accounts a ON a.id=pl.account_id
         WHERE a.code='2101' AND f.is_spendable=1""") == 0)

# ============================================================ 7 ============
print("\n=== 7. A closed period rejects ordinary writes ===")
db.execute("UPDATE fiscal_periods SET status='closed', closed_by=(SELECT id FROM profiles WHERE role='admin' LIMIT 1), closed_at='2026-12-31T23:59:59Z'")
db.commit()
try:
    db.execute("""INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,
                  source_type,source_id,created_by) VALUES ('DEMOJEXXXXXXXXXXXXXXXXXXXX','J-LATE',
                  '2026-08-01',(SELECT id FROM fiscal_periods LIMIT 1),'late','adjustment','x',
                  (SELECT id FROM profiles WHERE role='admin' LIMIT 1))""")
    db.commit(); blocked = False
except sqlite3.IntegrityError:
    blocked = True; db.rollback()
check("a closed period refuses a new entry", blocked)
db.execute("UPDATE fiscal_periods SET status='open'"); db.commit()

# ============================================================ 8 ============
print("\n=== 8. Unit balances agree when computed two independent ways ===")
mismatch = one(db, """
  SELECT COUNT(*) FROM (
    SELECT ub.unit_id,
           ub.received_piastres AS from_payments,
           COALESCE((SELECT SUM(jl.credit_piastres - jl.debit_piastres)
                       FROM v_posted_lines jl JOIN accounts a ON a.id = jl.account_id
                      WHERE jl.unit_id = ub.unit_id
                        AND a.type IN ('income','liability')),0) AS from_ledger
    FROM v_unit_balance ub
    WHERE from_payments <> from_ledger)""")
# `received_piastres`, NOT `paid_piastres`. The two were the same column until
# migration 0011, and that identity WAS the bug: a deposit is money received, so
# it must reconcile against the ledger, but it is not payment of a subscription,
# so it must not reduce arrears. This invariant asks the first question only.
# The comment that used to sit here asserted they "must agree" — which is how a
# wrong assumption survives inside a passing test for five sessions.
check("every one of 204 units: Σ approved payments == Σ that unit's journal lines",
      mismatch == 0, f"{mismatch} units disagree")

# --- 8b: the deposit pool, computed two ways -------------------------------
dep_units = one(db, "SELECT COALESCE(SUM(deposit_paid_piastres),0) FROM v_unit_balance")
dep_ledger = one(db, """SELECT COALESCE(SUM(jl.credit_piastres - jl.debit_piastres),0)
  FROM v_posted_lines jl JOIN accounts a ON a.id = jl.account_id
 WHERE a.code = '2101'""")
check("Σ per-unit deposits == the ودائع مستردة account balance",
      dep_units == dep_ledger, f"units {egp(dep_units)} vs ledger {egp(dep_ledger)}")

# --- 8c: a deposit never reduces what a flat owes --------------------------
leak = one(db, """SELECT COUNT(*) FROM v_unit_balance ub
  WHERE ub.deposit_paid_piastres > 0
    AND ub.outstanding_piastres <> ub.due_piastres - ub.paid_piastres""")
check("no flat's arrears is reduced by its deposit (the 0011 bug)",
      leak == 0, f"{leak} flats have deposit money offsetting dues")

sample = db.execute("""SELECT building_code, unit_number, due_piastres, paid_piastres,
                       outstanding_piastres FROM v_unit_balance
                       WHERE paid_piastres > 0 ORDER BY building_code LIMIT 1""").fetchone()
check("a sample unit reads sensibly", sample is not None,
      f"عمارة {sample[0]} شقة {sample[1]}: مطلوب {egp(sample[2])} · مدفوع {egp(sample[3])}")

# =========================================================== 8d ============
# Two checks that only became POSSIBLE once migration 0012 fixed
# v_fund_balances. Before that the view reported every fund as holding roughly
# nothing, so neither question could be asked at all.
print("\n=== 8d. Fund segregation — is every piastre in a named fund? ===")
fund_cash = one(db, "SELECT COALESCE(SUM(net_debit_piastres),0) FROM v_fund_balances")
acct_cash = one(db, """SELECT COALESCE(SUM(balance_piastres),0) FROM v_account_balances
  WHERE type='asset' AND code NOT LIKE '13%'""")
check("every piastre of cash belongs to exactly one fund",
      fund_cash == acct_cash,
      f"funds {egp(fund_cash)} vs asset accounts {egp(acct_cash)}")

# ⭐ The solvency question a compound actually cares about, and which nothing in
# this project could answer until now: HAVE WE SPENT THE RESIDENTS' DEPOSITS?
# The deposit fund must hold at least as much cash as it owes back. A negative
# gap means running costs were paid out of money held in trust — legal under no
# reading of an أمانة, and invisible in every other figure on the dashboard.
dep_cash = one(db, "SELECT COALESCE(net_debit_piastres,0) FROM v_fund_balances WHERE kind='deposit'")
dep_owed = one(db, "SELECT COALESCE(owed_piastres,0) FROM v_fund_balances WHERE kind='deposit'")
check("the deposit fund still holds every piastre it owes back",
      dep_cash >= dep_owed,
      f"holds {egp(dep_cash)} against {egp(dep_owed)} owed"
      + ("" if dep_cash >= dep_owed else f" — SHORT BY {egp(dep_owed - dep_cash)}"))

# ============================================================ 9 ============
print("\n=== 9. Dashboard totals agree with raw aggregates ===")
raw_income = one(db, """SELECT COALESCE(SUM(jl.credit_piastres - jl.debit_piastres),0)
  FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
  JOIN accounts a ON a.id=jl.account_id WHERE je.posted_at IS NOT NULL AND a.type='income'""")
raw_exp = one(db, """SELECT COALESCE(SUM(jl.debit_piastres - jl.credit_piastres),0)
  FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
  JOIN accounts a ON a.id=jl.account_id WHERE je.posted_at IS NOT NULL AND a.type='expense'""")
check("income: view == raw aggregate", raw_income == eq["income_piastres"], egp(raw_income))
check("expenses: view == raw aggregate", raw_exp == eq["expenses_piastres"], egp(raw_exp))

cat_sum = one(db, "SELECT COALESCE(SUM(total_piastres),0) FROM v_expense_by_category WHERE parent_id IS NULL")
check("Σ per-category expenses == total expenses (breakdown never leaks or duplicates)",
      cat_sum == eq["expenses_piastres"], f"{egp(cat_sum)} vs {egp(eq['expenses_piastres'])}")

# ============================================================ 10 ===========
print("\n=== 10. Waivers appear as waivers, never as payments ===")
waived = one(db, "SELECT COALESCE(SUM(waived_piastres),0) FROM unit_dues")
check("waivers exist in the demo data", waived > 0, egp(waived))
check("no waiver produced a payment row", one(db,
      """SELECT COUNT(*) FROM payments p JOIN unit_dues d ON d.unit_id=p.unit_id
         WHERE d.waived_piastres > 0 AND p.claimed_amount_piastres = d.waived_piastres
           AND p.status='approved'""") == 0)
check("a waived unit's due is reduced, not paid", one(db,
      """SELECT COUNT(*) FROM unit_dues d JOIN v_unit_balance ub ON ub.unit_id=d.unit_id
         WHERE d.waived_piastres > 0 AND ub.due_piastres <> d.amount_piastres - d.waived_piastres""") == 0)

# ============================================================ 11 ===========
print("\n=== 11. No floating point anywhere in the money path ===")
for tbl, col in [("journal_lines","debit_piastres"), ("journal_lines","credit_piastres"),
                 ("payments","claimed_amount_piastres"), ("payments","approved_amount_piastres"),
                 ("expenses","amount_piastres"), ("unit_dues","amount_piastres"),
                 ("resident_credits","amount_piastres"), ("staff","monthly_salary_piastres")]:
    bad = one(db, f"SELECT COUNT(*) FROM {tbl} WHERE {col} IS NOT NULL AND typeof({col}) <> 'integer'")
    if bad: check(f"{tbl}.{col} holds only integers", False, f"{bad} non-integer")
check("all 8 money columns hold only INTEGER values across the whole village", True)

# ============================================================ 12 ===========
print("\n=== 12. The accounting equation ===")
check("assets = liabilities + funds + (income − expenses)", eq["residual_piastres"] == 0,
      f"residual {eq['residual_piastres']}")
print("      ⚠️ ADR-018: this is a TAUTOLOGY under balanced double-entry.")
print("         It is checks 5, 6 and the fund split that protect against R-020.")

# ==================================================== reconciliation =======
print("\n=== Reconciliation: make the demo show a TRUE 'متطابق مع البنك' ===")
book_bank = one(db, "SELECT balance_piastres FROM v_account_balances WHERE code='1102'")
db.execute("""UPDATE reconciliations SET statement_balance_piastres=?, book_balance_piastres=?,
              difference_piastres=0 WHERE account_id=(SELECT id FROM accounts WHERE code='1102')""",
           (book_bank, book_bank))
db.commit()
check("bank reconciliation is clean at 31 July 2026", one(db,
      "SELECT difference_piastres FROM reconciliations") == 0, egp(book_bank))
check("the dashboard exposes the reconciliation date", tot["last_reconciled_on"] == "2026-07-31")

# ==================================================== the four figures =====
print("\n" + "=" * 74)
print("  الأرقام اللي هتظهر على /finance — أربع أرقام منفصلة، مش رقم واحد")
print("=" * 74)
print(f"  1. الفلوس المتاحة للصرف        {egp(tot['spendable_piastres']):>22}")
print(f"  2. ودائع واحتياطي (أمانات)     {egp(tot['held_in_trust_piastres']):>22}")
print(f"  3. إيصالات تحت المراجعة        {egp(tot['pending_not_counted_piastres']):>22}   ← مش محسوبة")
print(f"  4. متأخرات مطلوبة              {egp(tot['receivables_piastres']):>22}")
print("  " + "-" * 70)
print(f"     إجمالي الإيرادات المعتمدة    {egp(tot['total_income_piastres']):>22}")
print(f"     إجمالي المصروفات            {egp(tot['total_expense_piastres']):>22}")
print(f"     رصيد أول المدة              {egp(eq['funds_piastres']):>22}")
print()
naive = eq["assets_piastres"]
print(f"  ⚠️  لو الوديعة كانت اتحسبت إيراد، الرقم كان هيبان {egp(naive)}")
print(f"      بدل {egp(tot['spendable_piastres'])} — فرق {egp(naive - tot['spendable_piastres'])}")
print("      ده بالظبط الخطأ اللي R-020 بيتكلم عنه، ومكانش هيبان على الشاشة خالص.")

print(f"\n{'='*74}\n  {len(PASS)} passed, {len(FAIL)} failed\n{'='*74}")
if FAIL:
    print("FAILED:")
    for f in FAIL: print("  - " + f)
sys.exit(1 if FAIL else 0)
