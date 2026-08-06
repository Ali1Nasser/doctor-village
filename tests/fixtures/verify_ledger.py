#!/usr/bin/env python3
"""
verify_ledger.py — CP-0 verification of the ported schema.

This is NOT the CP-1 test suite. It exists to answer one question honestly:
does the SQLite/D1 port actually enforce what 06_ACCOUNTING_AND_LEDGER.md says
it enforces, on a real SQLite engine, right now?

Per 00_MASTER_PROMPT <verification_protocol>:
  - every guard is watched FAILING against a deliberately broken version first,
    because a test you never saw fail is not a test;
  - every total is computed a second, independent way and asserted equal.

Run:  python3 tests/fixtures/verify_ledger.py
"""

import sqlite3, sys, pathlib, json

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = sorted((ROOT / "migrations").glob("*.sql"))

PASS, FAIL = [], []

def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{detail}]" if detail else ""))

def uid(prefix, n):
    """26-char ULID-shaped id, deterministic so the fixture is reproducible."""
    s = f"{prefix}{n}"
    return (s + "0" * 26)[:26].upper()

def raises(db, sql, params=(), want=None):
    try:
        db.execute(sql, params)
        db.commit()
        return None
    except sqlite3.IntegrityError as e:
        return str(e)
    except sqlite3.OperationalError as e:
        return str(e)

def build():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    for m in MIGRATIONS:
        db.executescript(m.read_text())
    db.commit()
    return db

# =============================================================================
print("\n=== 1. Schema loads on a real SQLite engine ===")
# =============================================================================
try:
    db = build()
    tables = [r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    views = [r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='view' ORDER BY name")]
    trigs = [r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")]
    check(f"all {len(MIGRATIONS)} migrations apply cleanly", True,
          f"{len(tables)} tables, {len(views)} views, {len(trigs)} triggers")
except Exception as e:
    check("migrations apply", False, str(e))
    sys.exit(1)

# PRAGMA table_list columns: schema, name, type, ncol, wr, strict  -> index 5
n_strict = sum(1 for r in db.execute("PRAGMA table_list") if r[5] == 1)
check("STRICT tables are supported by this SQLite build", n_strict > 20,
      f"{n_strict} STRICT tables, sqlite {sqlite3.sqlite_version}")

# =============================================================================
print("\n=== 2. C4 — money can never become a float ===")
# =============================================================================
db.execute("INSERT INTO accounts VALUES (?,?,?,?,?,1,0)",
           (uid("ACC", 1), "1101", "محفظة إنستا باي", "asset", "debit"))
db.execute("INSERT INTO accounts VALUES (?,?,?,?,?,1,0)",
           (uid("ACC", 2), "1102", "الحساب البنكي", "asset", "debit"))
db.execute("INSERT INTO accounts VALUES (?,?,?,?,?,1,0)",
           (uid("ACC", 3), "1103", "الخزنة النقدية", "asset", "debit"))
db.execute("INSERT INTO accounts VALUES (?,?,?,?,?,1,0)",
           (uid("ACC", 4), "1301", "مستحقات على الملاك", "asset", "debit"))
db.execute("INSERT INTO accounts VALUES (?,?,?,?,?,1,0)",
           (uid("ACC", 5), "2101", "ودائع مستردة", "liability", "credit"))
db.execute("INSERT INTO accounts VALUES (?,?,?,?,?,1,0)",
           (uid("ACC", 6), "2102", "أرصدة دائنة للملاك", "liability", "credit"))
db.execute("INSERT INTO accounts VALUES (?,?,?,?,?,1,0)",
           (uid("ACC", 7), "3101", "رصيد أول المدة", "fund", "credit"))
db.execute("INSERT INTO accounts VALUES (?,?,?,?,?,1,0)",
           (uid("ACC", 8), "4101", "اشتراك الصيانة السنوي", "income", "credit"))
db.execute("INSERT INTO accounts VALUES (?,?,?,?,?,1,0)",
           (uid("ACC", 9), "5201", "مصروفات — المياه", "expense", "debit"))
db.commit()

db.execute("INSERT INTO profiles (id, full_name, role) VALUES (?,?,?)", (uid("PRF", 1), "المبرمج", "developer"))
db.execute("INSERT INTO profiles (id, full_name, role) VALUES (?,?,?)", (uid("PRF", 2), "رئيس المجلس", "admin"))
db.execute("INSERT INTO profiles (id, full_name, role) VALUES (?,?,?)", (uid("PRF", 3), "أمين الصندوق", "admin"))
db.execute("INSERT INTO profiles (id, full_name, role) VALUES (?,?,?)", (uid("PRF", 4), "ساكن ١", "resident"))
db.execute("INSERT INTO buildings VALUES (?,?,?,?,1)", (uid("BLD", 1), "5", "عمارة 5", 5))
db.execute("INSERT INTO units (id, building_id, unit_number) VALUES (?,?,?)", (uid("UNT", 1), uid("BLD", 1), "12"))
db.execute("INSERT INTO fiscal_periods (id, name_ar, starts_on, ends_on) VALUES (?,?,?,?)",
           (uid("FPR", 1), "سنة 2026", "2026-01-01", "2026-12-31"))
db.execute("INSERT INTO funds VALUES (?,?,?,?,1)", (uid("FND", 1), "الصندوق التشغيلي", "operating", 1))
db.execute("INSERT INTO funds VALUES (?,?,?,?,1)", (uid("FND", 2), "صندوق الودائع", "deposit", 0))
db.commit()

e = raises(db, "INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,source_type,source_id,created_by) "
               "VALUES (?,?,?,?,?,?,?,?)", (uid("JEX", 9), "J-X", "2026-01-01", uid("FPR", 1), "t", "adjustment", "x", uid("PRF", 1)))
db.execute("DELETE FROM journal_entries WHERE entry_no='J-X'")
db.commit()

# a float into an INTEGER piastres column must be rejected outright
db.execute("INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,source_type,source_id,created_by) "
           "VALUES (?,?,?,?,?,?,?,?)",
           (uid("JEF", 1), "J-FLOAT", "2026-01-01", uid("FPR", 1), "float probe", "adjustment", "probe", uid("PRF", 1)))
db.commit()
err = raises(db, "INSERT INTO journal_lines (id,entry_id,line_no,account_id,debit_piastres,credit_piastres) VALUES (?,?,?,?,?,?)",
             (uid("JLF", 1), uid("JEF", 1), 1, uid("ACC", 1), 1500.50, 0))
check("STRICT rejects a float written into an INTEGER piastres column", err is not None, (err or "")[:60])

err = raises(db, "INSERT INTO journal_lines (id,entry_id,line_no,account_id,debit_piastres,credit_piastres) VALUES (?,?,?,?,?,?)",
             (uid("JLF", 2), uid("JEF", 1), 2, uid("ACC", 1), 100, 100))
check("a line cannot carry BOTH a debit and a credit", err is not None)

err = raises(db, "INSERT INTO journal_lines (id,entry_id,line_no,account_id,debit_piastres,credit_piastres) VALUES (?,?,?,?,?,?)",
             (uid("JLF", 3), uid("JEF", 1), 3, uid("ACC", 1), -100, 0))
check("a negative amount is rejected", err is not None)

# =============================================================================
print("\n=== 3. R-020 — الوديعة structurally cannot be booked as income ===")
# =============================================================================
db.execute("INSERT INTO categories (id,name_ar,direction,kind,ledger_account_id,default_fund_id) VALUES (?,?,?,?,?,?)",
           (uid("CAT", 1), "اشتراك الصيانة السنوي", "income", "operating_income", uid("ACC", 8), uid("FND", 1)))
db.execute("INSERT INTO categories (id,name_ar,direction,kind,ledger_account_id,default_fund_id) VALUES (?,?,?,?,?,?)",
           (uid("CAT", 2), "وديعة", "income", "deposit", uid("ACC", 5), uid("FND", 2)))
db.execute("INSERT INTO categories (id,name_ar,direction,kind,ledger_account_id,default_fund_id) VALUES (?,?,?,?,?,?)",
           (uid("CAT", 3), "المياه", "expense", "expense", uid("ACC", 9), uid("FND", 1)))
db.commit()
check("a deposit category mapped to a LIABILITY account is accepted", True)

err = raises(db, "INSERT INTO categories (id,name_ar,direction,kind,ledger_account_id) VALUES (?,?,?,?,?)",
             (uid("CATX", 1), "وديعة غلط", "income", "deposit", uid("ACC", 8)))   # -> income account
check("a deposit category mapped to an INCOME account is REJECTED", err is not None, (err or "")[:70])

err = raises(db, "UPDATE categories SET ledger_account_id = ? WHERE id = ?", (uid("ACC", 8), uid("CAT", 2)))
check("re-pointing an existing deposit category at income is REJECTED", err is not None)

# --- watch it fail first ------------------------------------------------------
db2 = build()
db2.executescript("DROP TRIGGER trg_category_account_kind_ins;")
for r in db.execute("SELECT * FROM accounts"):
    db2.execute("INSERT INTO accounts VALUES (?,?,?,?,?,?,?)", r)
db2.commit()
err2 = raises(db2, "INSERT INTO categories (id,name_ar,direction,kind,ledger_account_id) VALUES (?,?,?,?,?)",
              (uid("CATX", 1), "وديعة غلط", "income", "deposit", uid("ACC", 8)))
check("...and WITHOUT the trigger the same insert succeeds (the guard is real)", err2 is None)
db2.close()

# =============================================================================
print("\n=== 4. Balanced-entry enforcement ===")
# =============================================================================
def entry(d, eid, no, desc, src, srcid, lines, period=None, post=True, creator=1, approver=2):
    d.execute("INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,source_type,source_id,created_by) "
              "VALUES (?,?,?,?,?,?,?,?)",
              (eid, no, "2026-06-01", period or uid("FPR", 1), desc, src, srcid, uid("PRF", creator)))
    for i, (acct, dr, cr, fund, unit) in enumerate(lines, start=1):
        d.execute("INSERT INTO journal_lines (id,entry_id,line_no,account_id,fund_id,debit_piastres,credit_piastres,unit_id) "
                  "VALUES (?,?,?,?,?,?,?,?)", (uid(no.replace("-", ""), i), eid, i, acct, fund, dr, cr, unit))
    if post:
        d.execute("UPDATE journal_entries SET approved_by=?, posted_at=? WHERE id=?",
                  (uid("PRF", approver), "2026-06-01T10:00:00Z", eid))
    d.commit()

db.execute("INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,source_type,source_id,created_by) "
           "VALUES (?,?,?,?,?,?,?,?)",
           (uid("JEU", 1), "J-UNBAL", "2026-06-01", uid("FPR", 1), "unbalanced", "adjustment", "x", uid("PRF", 1)))
db.execute("INSERT INTO journal_lines (id,entry_id,line_no,account_id,debit_piastres,credit_piastres) VALUES (?,?,?,?,?,?)",
           (uid("JLU", 1), uid("JEU", 1), 1, uid("ACC", 1), 150000, 0))
db.execute("INSERT INTO journal_lines (id,entry_id,line_no,account_id,debit_piastres,credit_piastres) VALUES (?,?,?,?,?,?)",
           (uid("JLU", 2), uid("JEU", 1), 2, uid("ACC", 8), 0, 149900))     # 1.00 ج.م short
db.commit()
err = raises(db, "UPDATE journal_entries SET posted_at=? WHERE id=?", ("2026-06-01T10:00:00Z", uid("JEU", 1)))
check("an entry that is 1.00 ج.م out of balance CANNOT post", err is not None, (err or "")[:60])

err = raises(db, "UPDATE journal_entries SET approved_by=? WHERE id=?", (uid("PRF", 1), uid("JEU", 1)))
check("maker-checker: the creator cannot approve their own entry", err is not None)

# --- watch it fail first ------------------------------------------------------
db3 = build()
db3.executescript("DROP TRIGGER trg_entry_balanced;")
for r in db.execute("SELECT * FROM accounts"): db3.execute("INSERT INTO accounts VALUES (?,?,?,?,?,?,?)", r)
for r in db.execute("SELECT * FROM profiles"): db3.execute("INSERT INTO profiles VALUES (?,?,?,?,?,?,?,?,?)", r)
db3.execute("INSERT INTO fiscal_periods (id,name_ar,starts_on,ends_on) VALUES (?,?,?,?)",
            (uid("FPR", 1), "سنة 2026", "2026-01-01", "2026-12-31"))
db3.commit()
db3.execute("INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,source_type,source_id,created_by) "
            "VALUES (?,?,?,?,?,?,?,?)", (uid("JEU", 1), "J-UNBAL", "2026-06-01", uid("FPR", 1), "u", "adjustment", "x", uid("PRF", 1)))
db3.execute("INSERT INTO journal_lines (id,entry_id,line_no,account_id,debit_piastres,credit_piastres) VALUES (?,?,?,?,?,?)",
            (uid("JLU", 1), uid("JEU", 1), 1, uid("ACC", 1), 150000, 0))
db3.execute("INSERT INTO journal_lines (id,entry_id,line_no,account_id,debit_piastres,credit_piastres) VALUES (?,?,?,?,?,?)",
            (uid("JLU", 2), uid("JEU", 1), 2, uid("ACC", 8), 0, 149900))
db3.commit()
err3 = raises(db3, "UPDATE journal_entries SET posted_at=? WHERE id=?", ("2026-06-01T10:00:00Z", uid("JEU", 1)))
check("...and WITHOUT the trigger the unbalanced entry posts (the guard is real)", err3 is None)
db3.close()

db.execute("DELETE FROM journal_lines WHERE entry_id=?", (uid("JEU", 1),))
db.execute("DELETE FROM journal_entries WHERE id=?", (uid("JEU", 1),))
db.execute("DELETE FROM journal_lines WHERE entry_id=?", (uid("JEF", 1),))
db.execute("DELETE FROM journal_entries WHERE id=?", (uid("JEF", 1),))
db.commit()

# =============================================================================
print("\n=== 5. Hand-computed fixture (06 §2 example postings) ===")
# =============================================================================
A_INSTA, A_BANK, A_CASH, A_RECV = uid("ACC",1), uid("ACC",2), uid("ACC",3), uid("ACC",4)
A_DEPOS, A_CRED, A_OPEN, A_SUBS, A_WATER = uid("ACC",5), uid("ACC",6), uid("ACC",7), uid("ACC",8), uid("ACC",9)
F_OP, F_DEP, U1 = uid("FND",1), uid("FND",2), uid("UNT",1)

entry(db, uid("JE",1), "J-2026-000001", "رصيد أول المدة", "opening_balance", None,
      [(A_CASH, 1000000, 0, F_OP, None), (A_OPEN, 0, 1000000, F_OP, None)])
entry(db, uid("JE",2), "J-2026-000002", "اشتراك صيانة 1,500", "payment", uid("PAY",1),
      [(A_INSTA, 150000, 0, F_OP, U1), (A_SUBS, 0, 150000, F_OP, U1)])
entry(db, uid("JE",3), "J-2026-000003", "وديعة 5,000", "payment", uid("PAY",2),
      [(A_BANK, 500000, 0, F_DEP, U1), (A_DEPOS, 0, 500000, F_DEP, U1)])
entry(db, uid("JE",4), "J-2026-000004", "دفع 2,000 مقابل 1,500", "payment", uid("PAY",3),
      [(A_INSTA, 200000, 0, F_OP, U1), (A_SUBS, 0, 150000, F_OP, U1), (A_CRED, 0, 50000, F_OP, U1)])
entry(db, uid("JE",5), "J-2026-000005", "عربية مياه حلوة", "expense", uid("EXP",1),
      [(A_WATER, 320000, 0, F_OP, None), (A_CASH, 0, 320000, F_OP, None)])

EXPECTED = {
    "assets_piastres":      1530000,   # 350,000 instapay + 500,000 bank + 680,000 cash
    "liabilities_piastres":  550000,   # 500,000 deposit + 50,000 owner credit
    "funds_piastres":       1000000,   # opening balance
    "income_piastres":       300000,   # 1,500 + 1,500 subscription  (NOT the 5,000 وديعة)
    "expenses_piastres":     320000,   # water truck
    "residual_piastres":          0,
}
row = dict(zip([c[0] for c in db.execute("SELECT * FROM v_accounting_equation").description],
               db.execute("SELECT * FROM v_accounting_equation").fetchone()))
for k, want in EXPECTED.items():
    check(f"{k} == {want}", row[k] == want, f"got {row[k]}")

# second, independent computation — raw SQL, not the view
raw = db.execute("""
  SELECT COALESCE(SUM(CASE WHEN a.type='income'  THEN jl.credit_piastres - jl.debit_piastres END),0),
         COALESCE(SUM(CASE WHEN a.type='expense' THEN jl.debit_piastres - jl.credit_piastres END),0)
  FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
  JOIN accounts a ON a.id=jl.account_id WHERE je.posted_at IS NOT NULL""").fetchone()
check("income agrees between the view and a raw SQL aggregate", raw[0] == row["income_piastres"])
check("expenses agrees between the view and a raw SQL aggregate", raw[1] == row["expenses_piastres"])

tot = dict(zip([c[0] for c in db.execute("SELECT * FROM v_community_totals").description],
               db.execute("SELECT * FROM v_community_totals").fetchone()))
check("spendable == 9,800.00 ج.م (assets − held-in-trust)", tot["spendable_piastres"] == 980000, f"got {tot['spendable_piastres']}")
check("held_in_trust == 5,500.00 ج.م and is shown SEPARATELY", tot["held_in_trust_piastres"] == 550000)
check("every entry balances", db.execute(
      "SELECT COUNT(*) FROM (SELECT entry_id FROM journal_lines GROUP BY entry_id "
      "HAVING SUM(debit_piastres) <> SUM(credit_piastres))").fetchone()[0] == 0)

# =============================================================================
print("\n=== 6. A pending receipt contributes ZERO (06 §1) ===")
# =============================================================================
db.execute("""INSERT INTO payments (id,receipt_no,unit_id,submitted_by,category_id,
              claimed_amount_piastres,method,transfer_date,storage_key,status,submitted_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
           (uid("PAY",9), "R-2026-00009", U1, uid("PRF",4), uid("CAT",1),
            80000, "instapay", "2026-06-20", "receipts/x.webp", "submitted", "2026-06-20T09:00:00Z"))
db.commit()
after = dict(zip([c[0] for c in db.execute("SELECT * FROM v_accounting_equation").description],
                 db.execute("SELECT * FROM v_accounting_equation").fetchone()))
check("a submitted receipt changes NO total", after == row)
tot2 = dict(zip([c[0] for c in db.execute("SELECT * FROM v_community_totals").description],
                db.execute("SELECT * FROM v_community_totals").fetchone()))
check("...but appears in pending_not_counted == 800.00 ج.م", tot2["pending_not_counted_piastres"] == 80000)

err = raises(db, "UPDATE payments SET status='approved' WHERE id=?", (uid("PAY",9),))
check("submitted -> approved directly is an ILLEGAL transition", err is not None, (err or "")[:55])
err = raises(db, "UPDATE payments SET status='rejected' WHERE id=?", (uid("PAY",9),))
check("rejecting without a written reason is refused", err is not None)

# =============================================================================
print("\n=== 7. Append-only / immutability ===")
# =============================================================================
err = raises(db, "UPDATE journal_lines SET debit_piastres=1 WHERE entry_id=?", (uid("JE",2),))
check("NO role can UPDATE a journal_line (access test 15)", err is not None)
err = raises(db, "DELETE FROM journal_lines WHERE entry_id=?", (uid("JE",2),))
check("NO role can DELETE a posted journal_line", err is not None)
err = raises(db, "DELETE FROM journal_entries WHERE id=?", (uid("JE",2),))
check("a posted entry cannot be deleted", err is not None)
err = raises(db, "UPDATE journal_entries SET posted_at=NULL WHERE id=?", (uid("JE",2),))
check("a posted entry cannot be un-posted", err is not None)

db.execute("INSERT INTO audit_log (id,action,entity_table,entity_id) VALUES (?,?,?,?)",
           (uid("AUD",1), "approve", "payments", uid("PAY",1))); db.commit()
err = raises(db, "UPDATE audit_log SET action='x' WHERE id=?", (uid("AUD",1),))
check("NOBODY can UPDATE the audit log (access test 8)", err is not None)
err = raises(db, "DELETE FROM audit_log WHERE id=?", (uid("AUD",1),))
check("NOBODY can DELETE from the audit log", err is not None)

db.execute("UPDATE fiscal_periods SET status='closed', closed_by=?, closed_at=? WHERE id=?",
           (uid("PRF",2), "2026-12-31T23:59:00Z", uid("FPR",1))); db.commit()
err = raises(db, "INSERT INTO journal_entries (id,entry_no,entry_date,period_id,description_ar,source_type,source_id,created_by) "
                 "VALUES (?,?,?,?,?,?,?,?)",
             (uid("JEC",1), "J-CLOSED", "2026-06-01", uid("FPR",1), "late", "adjustment", "x", uid("PRF",1)))
check("a CLOSED fiscal period rejects new entries (invariant 7)", err is not None)
db.execute("UPDATE fiscal_periods SET status='open' WHERE id=?", (uid("FPR",1),)); db.commit()

# =============================================================================
print("\n=== 8. ⚠️ The accounting equation is a TAUTOLOGY — proving it ===")
# =============================================================================
# 06 §9 calls invariant 12 "one test that catches more bugs than the other
# eleven combined". Build the SAME ledger with الوديعة deliberately booked to
# income and see whether that claim survives.
bad = build()
for r in db.execute("SELECT * FROM accounts"):        bad.execute("INSERT INTO accounts VALUES (?,?,?,?,?,?,?)", r)
for r in db.execute("SELECT * FROM profiles"):        bad.execute("INSERT INTO profiles VALUES (?,?,?,?,?,?,?,?,?)", r)
for r in db.execute("SELECT * FROM buildings"):       bad.execute("INSERT INTO buildings VALUES (?,?,?,?,?)", r)
for r in db.execute("SELECT * FROM units"):           bad.execute("INSERT INTO units VALUES (?,?,?,?,?,?)", r)
for r in db.execute("SELECT * FROM funds"):           bad.execute("INSERT INTO funds VALUES (?,?,?,?,?)", r)
bad.execute("INSERT INTO fiscal_periods (id,name_ar,starts_on,ends_on) VALUES (?,?,?,?)",
            (uid("FPR",1), "سنة 2026", "2026-01-01", "2026-12-31"))
bad.commit()
entry(bad, uid("JE",1), "J-2026-000001", "رصيد أول المدة", "opening_balance", None,
      [(A_CASH, 1000000, 0, F_OP, None), (A_OPEN, 0, 1000000, F_OP, None)])
entry(bad, uid("JE",2), "J-2026-000002", "اشتراك صيانة", "payment", uid("PAY",1),
      [(A_INSTA, 150000, 0, F_OP, U1), (A_SUBS, 0, 150000, F_OP, U1)])
entry(bad, uid("JE",3), "J-2026-000003", "وديعة 5,000 — MISBOOKED AS INCOME", "payment", uid("PAY",2),
      [(A_BANK, 500000, 0, F_OP, U1), (A_SUBS, 0, 500000, F_OP, U1)])     # <-- the bug
entry(bad, uid("JE",4), "J-2026-000004", "دفع 2,000 مقابل 1,500", "payment", uid("PAY",3),
      [(A_INSTA, 200000, 0, F_OP, U1), (A_SUBS, 0, 150000, F_OP, U1), (A_CRED, 0, 50000, F_OP, U1)])
entry(bad, uid("JE",5), "J-2026-000005", "عربية مياه", "expense", uid("EXP",1),
      [(A_WATER, 320000, 0, F_OP, None), (A_CASH, 0, 320000, F_OP, None)])

badrow = dict(zip([c[0] for c in bad.execute("SELECT * FROM v_accounting_equation").description],
                  bad.execute("SELECT * FROM v_accounting_equation").fetchone()))
badtot = dict(zip([c[0] for c in bad.execute("SELECT * FROM v_community_totals").description],
                  bad.execute("SELECT * FROM v_community_totals").fetchone()))
check("the corrupted ledger STILL PASSES the accounting equation", badrow["residual_piastres"] == 0,
      "residual 0 — invariant 12 did NOT catch the most dangerous error in the system")
check("...while spendable is overstated by exactly the 5,000 وديعة",
      badtot["spendable_piastres"] - 980000 == 500000,
      f"{badtot['spendable_piastres']/100:,.2f} shown vs 9,800.00 true")
check("...and the fund split IS what catches it (deposit fund vs operating)",
      bad.execute("SELECT COUNT(*) FROM v_posted_lines WHERE fund_id=?", (F_DEP,)).fetchone()[0] == 0)
bad.close()

# =============================================================================
print("\n=== 9. Identity / privacy structure ===")
# =============================================================================
db.execute("INSERT INTO phone_identifiers (id,profile_id,phone_e164) VALUES (?,?,?)",
           (uid("PHN",1), uid("PRF",4), "+201012345678")); db.commit()
err = raises(db, "INSERT INTO phone_identifiers (id,profile_id,phone_e164) VALUES (?,?,?)",
             (uid("PHN",2), uid("PRF",2), "+201012345678"))
check("two people cannot hold the same ACTIVE number", err is not None)
err = raises(db, "INSERT INTO phone_identifiers (id,profile_id,phone_e164) VALUES (?,?,?)",
             (uid("PHN",3), uid("PRF",2), "01012345679"))
check("a non-E.164 number is rejected at the boundary", err is not None)

db.execute("UPDATE phone_identifiers SET status='replaced', change_reason_ar='غيّر الرقم', is_primary=0 WHERE id=?",
           (uid("PHN",1),))
db.execute("INSERT INTO phone_identifiers (id,profile_id,phone_e164,changed_by) VALUES (?,?,?,?)",
           (uid("PHN",4), uid("PRF",4), "+201099999999", uid("PRF",2))); db.commit()
check("a phone number can change WITHOUT touching units or ledger history",
      db.execute("SELECT COUNT(*) FROM v_posted_lines WHERE unit_id=?", (U1,)).fetchone()[0] == 7
      and db.execute("SELECT COUNT(*) FROM unit_owners WHERE unit_id=?", (U1,)).fetchone()[0] == 0)
check("the replaced number is still in history (chain of custody preserved)",
      db.execute("SELECT COUNT(*) FROM phone_identifiers WHERE profile_id=?", (uid("PRF",4),)).fetchone()[0] == 2)

err = raises(db, "INSERT INTO delegate_authorizations (id,owner_profile_id,delegate_profile_id,unit_id,valid_from,valid_to,granted_by) "
                 "VALUES (?,?,?,?,?,?,?)",
             (uid("DLG",1), uid("PRF",4), uid("PRF",4), U1, "2026-01-01", "2026-12-31", uid("PRF",2)))
check("a person cannot delegate to themselves", err is not None)

check("v_staff_public does not expose full_name",
      "full_name" not in [c[1] for c in db.execute("PRAGMA table_info(v_staff_public)")])
check("single-admin warning shows when fewer than 2 active admins exist",
      db.execute("SELECT show_warning FROM v_single_admin_warning").fetchone()[0] == 0)  # we seeded 3

# =============================================================================
print("\n=== 10. Arabic full-text search (CP-6 gate rehearsal) ===")
# =============================================================================
db.execute("INSERT INTO posts (id,type,slug,title_ar,body_ar,search_body,author_id,published_at) VALUES (?,?,?,?,?,?,?,?)",
           (uid("PST",1), "minutes", "m-2026-03", "محضر اجتماع الجمعية العمومية",
            "تمت الموافقة على ميزانية الصيانة", "محضر اجتماع الجمعيه العموميه تمت الموافقه على ميزانيه الصيانه",
            uid("PRF",2), "2026-03-01T12:00:00Z"))
db.execute("INSERT INTO posts_fts (rowid,title_ar,search_body,attachment_text) VALUES (?,?,?,?)",
           (1, "محضر اجتماع الجمعية العمومية", "محضر اجتماع الجمعيه العموميه تمت الموافقه على ميزانيه الصيانه", ""))
db.commit()
n = db.execute("SELECT COUNT(*) FROM posts_fts WHERE posts_fts MATCH ?", ("الصيانه",)).fetchone()[0]
check("FTS5 finds an Arabic word", n == 1)

# Isolate the tokenizer: index ONLY folded text, then search the unfolded form
# a resident would actually type. If FTS5 folded ة/ه and أ/ا itself, this
# would match and search_body would be unnecessary.
db.execute("INSERT INTO posts_fts (rowid,title_ar,search_body,attachment_text) VALUES (?,?,?,?)",
           (2, "", "قرار انشاء حديقه", ""))
db.commit()
n2 = db.execute("SELECT COUNT(*) FROM posts_fts WHERE posts_fts MATCH ?", ("حديقة",)).fetchone()[0]
n3 = db.execute("SELECT COUNT(*) FROM posts_fts WHERE posts_fts MATCH ?", ("إنشاء",)).fetchone()[0]
check("⚠️ FTS5 does NOT fold ة/ه — 'حديقة' misses indexed 'حديقه'", n2 == 0,
      "confirms search_body (application-side folding) is REQUIRED, not optional")
check("⚠️ FTS5 does NOT fold أ/إ/آ -> ا — 'إنشاء' misses indexed 'انشاء'", n3 == 0)
n4 = db.execute("SELECT COUNT(*) FROM posts_fts WHERE posts_fts MATCH ?", ("حديقه",)).fetchone()[0]
check("...and the folded form DOES match, so the fix works", n4 == 1)

# =============================================================================
print(f"\n{'='*66}\n  {len(PASS)} passed, {len(FAIL)} failed\n{'='*66}")
if FAIL:
    print("FAILED:")
    for f in FAIL: print("  - " + f)
sys.exit(1 if FAIL else 0)
