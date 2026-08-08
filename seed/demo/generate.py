#!/usr/bin/env python3
"""
seed/demo/generate.py — generates the imaginary village.

⚠️ EVERY NAME, AMOUNT, PHONE NUMBER AND DATE PRODUCED BY THIS SCRIPT IS
   INVENTED (C10). Nothing here came from the owner. It exists so the product
   can be demonstrated and the ledger exercised before the real register
   arrives. Every generated id begins with 'DEMO', and migration 0006 makes
   those ids impossible to insert into a production database.

Deterministic: fixed seed, no wall-clock. Re-running produces byte-identical
SQL, so a diff is meaningful.

Run:  python3 seed/demo/generate.py
Out:  seed/demo/001_village.sql … 006_notifications.sql
"""

import random, pathlib, hashlib

random.seed(20260804)
OUT = pathlib.Path(__file__).parent

# ---------------------------------------------------------------- ids ----
def did(prefix: str, n: int) -> str:
    """26-char id that visibly announces itself as demo data."""
    body = f"{prefix}{n:0{26 - 4 - len(prefix)}d}"
    return "DEMO" + body

def q(s):
    return "NULL" if s is None else "'" + str(s).replace("'", "''") + "'"

def fake_sha(seed_text: str) -> str:
    """A stand-in image digest, stable across runs.

    This was `abs(hash(pid))`, and Python randomises `hash()` of a string per
    process — so every regeneration rewrote all 243 receipt digests and the file
    docstring's promise that "re-running produces byte-identical SQL, so a diff
    is meaningful" was false. A diff nobody can read is a diff nobody reads.
    """
    return hashlib.sha256(seed_text.encode()).hexdigest()

# --------------------------------------------------- accounts from prod ----
A_CASH  = 'ACC00000000000000000001101'
A_BANK  = 'ACC00000000000000000001102'
A_INSTA = 'ACC00000000000000000001103'
A_VODA  = 'ACC00000000000000000001104'
A_DEPOS = 'ACC00000000000000000002101'
A_CRED  = 'ACC00000000000000000002102'
A_OPEN  = 'ACC00000000000000000003101'
A_SUBS  = 'ACC00000000000000000004101'
F_OP    = 'FND00000000000000000000001'
F_DEP   = 'FND00000000000000000000002'
C_SUBS  = 'CAT0000000000000000000IN01'
C_DEP   = 'CAT0000000000000000000IN02'

EXPENSE_ACCOUNTS = {
    'صيانة':   ('ACC00000000000000000005101', 'CAT0000000000000000000EX01'),
    'مياه':    ('ACC00000000000000000005201', 'CAT0000000000000000000EX02'),
    'مرتبات':  ('ACC00000000000000000005301', 'CAT0000000000000000000EX03'),
    'أمن':     ('ACC00000000000000000005401', 'CAT0000000000000000000EX04'),
    'نظافة':   ('ACC00000000000000000005501', 'CAT0000000000000000000EX05'),
    'زراعة':   ('ACC00000000000000000005601', 'CAT0000000000000000000EX06'),
    'سباحة':   ('ACC00000000000000000005701', 'CAT0000000000000000000EX07'),
    'كهرباء':  ('ACC00000000000000000005801', 'CAT0000000000000000000EX08'),
    'إدارية':  ('ACC00000000000000000005901', 'CAT0000000000000000000EX09'),
}

METHOD_ACCOUNT = {
    'instapay':      A_INSTA,
    'bank_transfer': A_BANK,
    'vodafone_cash': A_VODA,
    'cash':          A_CASH,
}

# ------------------------------------------------------- village shape ----
# Building numbers read off the site map the owner sent. Recorded as
# assumption A-01 — an image is not a register.
BUILDINGS = list(range(14, 48))          # 14 … 47  -> 34 buildings
UNITS_PER_BUILDING = 6                   # -> 204 units
SUBSCRIPTION_PIASTRES = 600_000          # 6,000.00 ج.م  — INVENTED (Q2)
DEPOSIT_PIASTRES      = 500_000          # 5,000.00 ج.م  — INVENTED
PERIOD = did("FPR", 1)
FEEP   = did("FEE", 1)

FIRST = ["أحمد","محمد","محمود","خالد","عمرو","طارق","هشام","شريف","ياسر","سامح","وليد","مصطفى",
         "إبراهيم","عادل","حسام","كريم","نبيل","رأفت","صلاح","مجدي","فاروق","سمير","عصام","أيمن",
         "سعاد","فاطمة","منى","هالة","نادية","أميرة","دينا","رانيا","ليلى","سلوى","نهى","إيمان"]
LAST  = ["عبد الرحمن","الشناوي","حجازي","السيد","عبد العزيز","زكي","الحلواني","مرسي","شاهين",
         "الغنيمي","بدوي","عثمان","سليمان","الفقي","رزق","الديب","قنديل","خليل","عامر","نصار"]

lines_village, lines_ledger, lines_money, lines_content = [], [], [], []
L = lines_village.append

# ------------------------------------------------------------- audit ----
# `audit_log` was the one table the demo left empty, and it is the table the
# board is being asked to trust: «سجل التغييرات» rendered its empty state, and
# the dashboard's activity strip could not appear at all. An empty audit log is
# not a neutral omission in a demo about accountability — it is the screen that
# proves nothing is happening behind anyone's back, showing nothing.
#
# So every state change the seed fabricates records who did it and when, with
# the same action slugs `lib/db/mutations.ts` writes. Rows are collected here
# and emitted last, in chronological order, into `005_audit.sql`.
audit_rows = []          # (when, actor, action, table, entity_id, role)
ROLE_OF = {}             # profile id -> role, filled as people are created

# ------------------------------------------------------- notifications ----
# `notifications` was the second table the demo left empty, and the effect was
# the same shape as the empty audit log: the bell in the app bar draws its badge
# only when there is something unread, «رسايلي» rendered its empty state, and a
# board looking at the demo concluded the notification feature did not work.
#
# Every row below is one the PRODUCT would have written — `approveAndPost` and
# `reviewPayment` insert a decision message in the same batch as the decision
# (R-065), and a published announcement notifies the village. Nothing here is a
# message the app could not have sent.
notif_rows = []          # (when, profile, kind, title, body, link, payment_id, read)

def notify(when, profile, kind, title, body, link='/payments', payment=None, read=True):
    notif_rows.append((when, profile, kind, title, body, link, payment, read))

def audit(when, actor, action, table, entity_id=None):
    """One row in the trail. `when` is a full ISO instant, not a date: the
    audit page sorts by it, and a day-granular log cannot answer "was the
    receipt approved before or after the money moved"."""
    audit_rows.append((when, actor, action, table, entity_id, ROLE_OF.get(actor)))

HEADER = """-- ⚠️ IMAGINARY DATA — generated by seed/demo/generate.py, seed 20260804.
-- Every name, amount, phone number and date below is INVENTED (C10).
-- Ids begin with 'DEMO'; migration 0006 refuses them on a production database.
-- Load order: migrations -> seed/prod -> THIS FILE.
-- Before loading, mark the database as a demo database:
--     UPDATE env_guard SET environment='demo', set_by='dev', note='local demo';

"""

# =========================================================== people ========
people = []          # (id, name, role)
PEOPLE_N = 0
def person(name, role):
    global PEOPLE_N
    PEOPLE_N += 1
    pid = did("PRF", PEOPLE_N)
    people.append((pid, name, role))
    ROLE_OF[pid] = role
    return pid

DEV        = person("م. علي صلاح (المبرمج)", "developer")
CHAIR      = person("د. خالد الشناوي (رئيس المجلس)", "admin")
TREASURER  = person("د. سامح حجازي (أمين الصندوق)", "admin")
OPERATOR   = person("عم سمير عبد العزيز (مشغّل)", "operator")
REVIEWER   = person("أ. نبيل رزق (مراجع مالي)", "finance_reviewer")

residents = []
for i in range(200):
    nm = f"{'د. ' if i % 3 else ''}{FIRST[i % len(FIRST)]} {LAST[(i * 7) % len(LAST)]}"
    residents.append(person(nm, "resident"))

L(HEADER)
L("-- ------------------------------------------------------------- people ---")
for pid, nm, role in people:
    L(f"INSERT INTO profiles (id, full_name, role) VALUES ({q(pid)},{q(nm)},{q(role)});")

L("\n-- phone numbers — INVENTED, in the 0100 000 xxxx range (not allocated in Egypt)")
for n, (pid, nm, role) in enumerate(people, start=1):
    L(f"INSERT INTO phone_identifiers (id, profile_id, phone_e164, verified_at) "
      f"VALUES ({q(did('PHN', n))},{q(pid)},'+2010000{n:05d}','2026-01-15T09:00:00Z');")

# The board's own accounts were created one at a time by the founding developer,
# with the role granted as a separate act — that is two audit rows per person
# because they are two decisions, and «مين اداه صلاحية الإدارة» is the question
# an audit log exists to answer.
for k, pid in enumerate([CHAIR, TREASURER, OPERATOR, REVIEWER]):
    when = f"2026-01-05T{9 + k:02d}:20:00Z"
    audit(when, DEV, 'user.create', 'profiles', pid)
    audit(f"2026-01-05T{9 + k:02d}:22:00Z", DEV, 'user.assign_role', 'profiles', pid)
# The 200 residents did not arrive one by one. They came from the owner register
# as a staged import the chairman reviewed and then committed — the real path
# `lib/db/onboarding.ts` implements, and the reason a register of that size can
# be defended: two audit rows naming one person, not 200 silent inserts.
audit('2026-01-15T08:40:00Z', CHAIR, 'import.stage', 'import_batches', did('IMP', 1))
audit('2026-01-15T09:00:00Z', CHAIR, 'import.commit', 'import_batches', did('IMP', 1))

# ==================================================== buildings & units ====
L("\n-- --------------------------------------------------- buildings & units ---")
units = []           # (unit_id, building_no, unit_no, area_cm2)
u_n = 0
for b_i, b in enumerate(BUILDINGS, start=1):
    L(f"INSERT INTO buildings (id, code, name_ar, sort_order) "
      f"VALUES ({q(did('BLD', b_i))},{q(str(b))},{q(f'عمارة {b}')},{b});")
    for u in range(1, UNITS_PER_BUILDING + 1):
        u_n += 1
        area_m2 = random.choice([95, 110, 120, 135, 150])
        uid = did("UNT", u_n)
        units.append((uid, b, u, area_m2))
        L(f"INSERT INTO units (id, building_id, unit_number, area_cm2) "
          f"VALUES ({q(uid)},{q(did('BLD', b_i))},{q(str(u))},{area_m2 * 10_000});")

# ownership: mostly 1:1; a few people own two flats; a few flats co-owned
L("\n-- ownership — effective-dated. A few owners hold two flats; a few flats are co-owned.")
own_n = 0
for i, (uid, b, u, _) in enumerate(units):
    own_n += 1
    owner = residents[i % len(residents)]
    L(f"INSERT INTO unit_owners (id, unit_id, profile_id, share_bp, valid_from) "
      f"VALUES ({q(did('UOW', own_n))},{q(uid)},{q(owner)},10000,'2020-01-01');")
    if i % 37 == 5:                      # co-owned flat, 50/50
        own_n += 1
        L(f"UPDATE unit_owners SET share_bp=5000 WHERE id={q(did('UOW', own_n - 1))};")
        L(f"INSERT INTO unit_owners (id, unit_id, profile_id, share_bp, is_primary_contact, valid_from) "
          f"VALUES ({q(did('UOW', own_n))},{q(uid)},{q(residents[(i + 61) % len(residents)])},5000,0,'2020-01-01');")

# a delegate: an owner in Cairo authorising his son, expiring end of year
L("\n-- one delegate authorisation — scoped, granular, and it EXPIRES (R-025)")
L(f"INSERT INTO delegate_authorizations (id, owner_profile_id, delegate_profile_id, unit_id, "
  f"can_view_financials, can_submit_payments, valid_from, valid_to, granted_by, reason_ar) VALUES "
  f"({q(did('DLG', 1))},{q(residents[0])},{q(residents[1])},{q(units[0][0])},1,1,"
  f"'2026-01-01','2026-12-31',{q(CHAIR)},'المالك مقيم بالقاهرة');")

# ============================================== periods, fees, dues ========
L("\n-- ---------------------------------------------------- fiscal & fees ---")
L(f"INSERT INTO fiscal_periods (id, name_ar, starts_on, ends_on, status) "
  f"VALUES ({q(PERIOD)},'السنة المالية 2026','2026-01-01','2026-12-31','open');")
# The period is created as a DRAFT and published at the END, which is the same
# order the product itself enforces: migration 0022 refuses a due inserted
# against a published period, because a published amount is what a resident was
# told they owe. A seed that inserted a published period and then billed flats
# against it was writing a state the application can never reach — and it is a
# state the restore path has to reproduce too, which is exactly how a fixture
# quietly stops testing the real thing.
L(f"INSERT INTO fee_periods (id, name_ar, category_id, fiscal_period_id, starts_on, ends_on, "
  f"due_on, basis, amount_piastres, is_published, created_by) VALUES "
  f"({q(FEEP)},'اشتراك الصيانة السنوي 2026',{q(C_SUBS)},{q(PERIOD)},'2026-01-01','2026-12-31',"
  f"'2026-03-31','per_unit',{SUBSCRIPTION_PIASTRES},0,{q(CHAIR)});")

audit('2026-01-20T10:00:00Z', CHAIR, 'fee_period.create', 'fee_periods', FEEP)

L("\n-- dues — one per unit, frozen at generation")
for i, (uid, b, u, _) in enumerate(units, start=1):
    L(f"INSERT INTO unit_dues (id, fee_period_id, unit_id, amount_piastres) "
      f"VALUES ({q(did('DUE', i))},{q(FEEP)},{q(uid)},{SUBSCRIPTION_PIASTRES});")
# Generation is ONE audited act over 204 flats, not 204 — that is what the
# product does, and an audit log that disagreed with it would be describing a
# different system.
audit('2026-01-20T10:04:00Z', CHAIR, 'fee_period.generate', 'fee_periods', FEEP)

# a couple of waivers — appear as waivers, never as payments (06 §4). Recorded
# BEFORE publication here only because the seed is one script; in the product a
# waiver is the one thing that may still be recorded after publication, since it
# sits beside the amount rather than changing it.
for i in (17, 88):
    L(f"UPDATE unit_dues SET waived_piastres={SUBSCRIPTION_PIASTRES}, "
      f"waiver_reason_ar='إعفاء بقرار مجلس — ظروف اجتماعية', waived_by={q(CHAIR)}, "
      f"waived_at='2026-04-02T11:00:00Z' WHERE id={q(did('DUE', i))};")
    audit('2026-04-02T11:00:00Z', CHAIR, 'due.waive', 'unit_dues', did('DUE', i))

L("\n-- ...and only now is it published, once every flat has been billed")
L(f"UPDATE fee_periods SET is_published=1 WHERE id={q(FEEP)};")
audit('2026-01-20T10:30:00Z', CHAIR, 'fee_period.publish', 'fee_periods', FEEP)

# =============================================== opening balance ==========
M = lines_ledger.append
M(HEADER)
M("-- ------------------------------------------------- opening balance ---")
entry_n = 0
line_n = 0

def post_entry(dst, desc, source_type, source_id, rows, date, creator=TREASURER,
               approver=CHAIR, defer_post=False):
    """rows: list of (account, fund, debit, credit, unit_id, memo). Emits the
    real posting order: entry (unposted) -> lines -> UPDATE posted_at, which is
    what trg_entry_balanced expects. Must run inside one d1.batch() in the app.

    `defer_post=True` stops before the posting step and returns (eid, post_sql)
    so the caller can link its source document FIRST. Migration 0024's
    orphan-entry guard checks, at the moment of posting, that the payment or
    expense this entry names actually points back at it — so "post, then
    attach" is a state the database refuses, and rightly: for one statement the
    books would carry income attributed to a receipt that does not yet claim
    it."""
    global entry_n, line_n
    entry_n += 1
    eid = did("JE", entry_n)
    dst(f"INSERT INTO journal_entries (id, entry_no, entry_date, period_id, description_ar, "
        f"source_type, source_id, created_by) VALUES ({q(eid)},{q(f'J-2026-{entry_n:06d}')},"
        f"{q(date)},{q(PERIOD)},{q(desc)},{q(source_type)},{q(source_id)},{q(creator)});")
    for i, (acct, fund, dr, cr, unit, memo) in enumerate(rows, start=1):
        line_n += 1
        dst(f"INSERT INTO journal_lines (id, entry_id, line_no, account_id, fund_id, "
            f"debit_piastres, credit_piastres, unit_id, memo_ar) VALUES "
            f"({q(did('JL', line_n))},{q(eid)},{i},{q(acct)},{q(fund)},{dr},{cr},"
            f"{q(unit)},{q(memo)});")
    post_sql = (f"UPDATE journal_entries SET approved_by={q(approver)}, "
                f"posted_at={q(date + 'T10:00:00Z')} WHERE id={q(eid)};")
    if defer_post:
        return eid, post_sql
    dst(post_sql)
    return eid

OPENING_CASH = 4_500_000      # 45,000.00 ج.م  — INVENTED
OPENING_BANK = 18_200_000     # 182,000.00 ج.م — INVENTED
post_entry(M, "رصيد أول المدة 1 يناير 2026", "opening_balance", None, [
    (A_CASH, F_OP, OPENING_CASH, 0, None, "الخزنة النقدية"),
    (A_BANK, F_OP, OPENING_BANK, 0, None, "الحساب البنكي"),
    (A_OPEN, F_OP, 0, OPENING_CASH + OPENING_BANK, None, "رصيد مُرحّل من 2025"),
], "2026-01-01", creator=CHAIR, approver=TREASURER)

# ==================================================== payments ============
P = lines_money.append
P(HEADER)
P("-- ------------------------------------------------------- payments ---")

# Which unit does what. Deterministic slices, so the totals are hand-checkable.
idx = list(range(len(units)))
random.shuffle(idx)
FULL      = idx[0:132]
PARTIAL   = idx[132:150]
OVER      = idx[150:162]
PENDING   = idx[162:176]
REJECTED  = idx[176:182]
DUPLICATE = idx[182:185]
CANCELLED = idx[185:187]
REVERSED  = idx[187:188]
# idx[188:] pay nothing at all

DEPOSIT_UNITS = idx[0:55]

pay_n = 0
receipt_n = 0
METHODS = ['instapay', 'bank_transfer', 'vodafone_cash', 'cash']

def owner_of(i):
    return residents[i % len(residents)]

def emit_payment(i, amount, status, category, ledger_account, date,
                 reason=None, over_split=None, deposit=False):
    """Walks the real nine-state machine: draft -> submitted -> under_review -> …"""
    global pay_n, receipt_n
    pay_n += 1; receipt_n += 1
    pid = did("PAY", pay_n)
    uid = units[i][0]
    submitter = owner_of(i)
    method = METHODS[i % 4]
    asset = METHOD_ACCOUNT[method]
    rno = f"R-2026-{receipt_n:05d}"

    P(f"INSERT INTO payments (id, receipt_no, unit_id, submitted_by, category_id, fee_period_id, "
      f"claimed_amount_piastres, method, transfer_date, storage_key, image_sha256, status) VALUES "
      f"({q(pid)},{q(rno)},{q(uid)},{q(submitter)},{q(category)},"
      f"{q(None if deposit else FEEP)},{amount},{q(method)},{q(date)},"
      f"{q(f'receipts/{uid}/{pid}.webp')},{q(fake_sha(pid))},'draft');")
    P(f"UPDATE payments SET status='submitted', submitted_at={q(date + 'T08:30:00Z')} WHERE id={q(pid)};")
    audit(date + 'T08:30:00Z', submitter, 'payment.submit', 'payments', pid)
    if status == 'cancelled':
        P(f"UPDATE payments SET status='cancelled' WHERE id={q(pid)};")
        return
    P(f"UPDATE payments SET status='under_review' WHERE id={q(pid)};")

    if status in ('submitted', 'under_review'):
        return                                   # stays pending: contributes ZERO
    if status in ('rejected', 'duplicate', 'needs_info'):
        P(f"UPDATE payments SET status={q(status)}, review_reason_ar={q(reason)}, "
          f"reviewed_by={q(CHAIR)}, reviewed_at={q(date + 'T19:00:00Z')} WHERE id={q(pid)};")
        audit(date + 'T19:00:00Z', CHAIR, 'payment.review', 'payments', pid)
        kinds = {'rejected': 'payment_rejected', 'duplicate': 'payment_rejected',
                 'needs_info': 'payment_needs_info'}
        titles = {'rejected': 'إيصالك محتاج مراجعة', 'duplicate': 'إيصالك محتاج مراجعة',
                  'needs_info': 'محتاجين منك توضيح'}
        notify(date + 'T19:00:00Z', submitter, kinds[status], titles[status],
               f"إيصال {rno}: {reason}", payment=pid)
        return

    # approved -> post the ledger entry first, then attach it
    if over_split:                                # overpayment: excess -> liability
        due, excess = over_split
        rows = [(asset, F_OP, amount, 0, uid, "تحصيل"),
                (A_SUBS, F_OP, 0, due, uid, "اشتراك 2026"),
                (A_CRED, F_OP, 0, excess, uid, "رصيد دائن للمالك — مش إيراد")]
    elif deposit:
        rows = [(asset, F_DEP, amount, 0, uid, "وديعة"),
                (A_DEPOS, F_DEP, 0, amount, uid, "أمانة مستردة — التزام مش إيراد")]
    else:
        rows = [(asset, F_OP, amount, 0, uid, "تحصيل"),
                (A_SUBS, F_OP, 0, amount, uid, "اشتراك 2026")]

    eid, post_sql = post_entry(P, f"إيصال {rno} — عمارة {units[i][1]} شقة {units[i][2]}",
                               "payment", pid, rows, date,
                               creator=TREASURER, approver=CHAIR, defer_post=True)
    # Attach the receipt to the entry, and only then post it. See `defer_post`.
    P(f"UPDATE payments SET status='approved', approved_amount_piastres={amount}, "
      f"journal_entry_id={q(eid)}, reviewed_by={q(CHAIR)}, reviewed_at={q(date + 'T19:00:00Z')}, "
      f"fund_id={q(F_DEP if deposit else F_OP)} WHERE id={q(pid)};")
    P(post_sql)
    audit(date + 'T19:00:00Z', CHAIR, 'payment.review', 'payments', pid)
    notify(date + 'T19:00:00Z', submitter, 'payment_approved', 'إيصالك اتقبل ✅',
           f"إيصال {rno} اتعتمد بمبلغ {amount / 100:.2f} ج.م", payment=pid)
    if over_split:
        P(f"INSERT INTO resident_credits (id, unit_id, profile_id, amount_piastres, "
          f"source_payment_id, journal_entry_id) VALUES ({q(did('RCR', pay_n))},{q(uid)},"
          f"{q(owner_of(i))},{over_split[1]},{q(pid)},{q(eid)});")
    return pid, eid

def day(n):
    m = 1 + (n % 7)
    d = 1 + (n * 3 % 27)
    return f"2026-{m:02d}-{d:02d}"

P("\n-- 132 units paid the subscription in full")
for k, i in enumerate(FULL):
    emit_payment(i, SUBSCRIPTION_PIASTRES, 'approved', C_SUBS, A_SUBS, day(k))

P("\n-- 18 units paid part of it")
for k, i in enumerate(PARTIAL):
    emit_payment(i, [200_000, 300_000, 250_000, 400_000][k % 4], 'approved', C_SUBS, A_SUBS, day(k + 40))

P("\n-- 12 units overpaid — the excess becomes a LIABILITY, never income (06 §4)")
for k, i in enumerate(OVER):
    extra = [50_000, 100_000, 40_000][k % 3]
    emit_payment(i, SUBSCRIPTION_PIASTRES + extra, 'approved', C_SUBS, A_SUBS, day(k + 70),
                 over_split=(SUBSCRIPTION_PIASTRES, extra))

P("\n-- 14 receipts still under review — these must contribute ZERO to every total")
for k, i in enumerate(PENDING):
    emit_payment(i, SUBSCRIPTION_PIASTRES, 'under_review', C_SUBS, A_SUBS, day(k + 100))

P("\n-- 6 rejected, 3 possible duplicates, 2 cancelled — all contribute ZERO")
for k, i in enumerate(REJECTED):
    emit_payment(i, SUBSCRIPTION_PIASTRES, 'rejected', C_SUBS, A_SUBS, day(k + 120),
                 reason="الصورة مش واضحة، مش بايِن فيها رقم العملية. ممكن ترفع صورة تانية؟")
for k, i in enumerate(DUPLICATE):
    emit_payment(i, SUBSCRIPTION_PIASTRES, 'duplicate', C_SUBS, A_SUBS, day(k + 130),
                 reason="يحتمل إنه مكرر — نفس المبلغ ونفس التاريخ اترفعوا قبل كده. محتاج مراجعة.")
for k, i in enumerate(CANCELLED):
    emit_payment(i, SUBSCRIPTION_PIASTRES, 'cancelled', C_SUBS, A_SUBS, day(k + 140))

P("\n-- 55 units paid the 5,000 ج.م وديعة — a LIABILITY, in the non-spendable deposit fund")
for k, i in enumerate(DEPOSIT_UNITS):
    emit_payment(i, DEPOSIT_PIASTRES, 'approved', C_DEP, A_DEPOS, day(k + 5), deposit=True)

P("\n-- 1 approved receipt later reversed (wrong unit) — the original stays visible")
rev_i = REVERSED[0]
res = emit_payment(rev_i, SUBSCRIPTION_PIASTRES, 'approved', C_SUBS, A_SUBS, "2026-05-04")
if res:
    rev_pid, rev_eid = res
    asset = METHOD_ACCOUNT[METHODS[rev_i % 4]]
    ruid = units[rev_i][0]
    P("-- the reversing entry: same amounts, opposite sides, linked to the original")
    global_e = entry_n + 1
    P(f"INSERT INTO journal_entries (id, entry_no, entry_date, period_id, description_ar, "
      f"source_type, source_id, created_by, is_reversal, reverses_entry_id, reversal_reason_ar) VALUES "
      f"({q(did('JE', global_e))},{q(f'J-2026-{global_e:06d}')},'2026-05-11',{q(PERIOD)},"
      f"'عكس إيصال — اتسجّل على وحدة غلط','payment',{q(rev_pid)},{q(TREASURER)},1,{q(rev_eid)},"
      f"'الإيصال اتسجّل على شقة غلط، اتصحّح بقيد عكسي');")
    P(f"INSERT INTO journal_lines (id, entry_id, line_no, account_id, fund_id, debit_piastres, "
      f"credit_piastres, unit_id, memo_ar) VALUES "
      f"({q(did('JL', line_n + 1))},{q(did('JE', global_e))},1,{q(A_SUBS)},{q(F_OP)},"
      f"{SUBSCRIPTION_PIASTRES},0,{q(ruid)},'عكس اشتراك');")
    P(f"INSERT INTO journal_lines (id, entry_id, line_no, account_id, fund_id, debit_piastres, "
      f"credit_piastres, unit_id, memo_ar) VALUES "
      f"({q(did('JL', line_n + 2))},{q(did('JE', global_e))},2,{q(asset)},{q(F_OP)},0,"
      f"{SUBSCRIPTION_PIASTRES},{q(ruid)},'عكس تحصيل');")
    P(f"UPDATE journal_entries SET approved_by={q(CHAIR)}, posted_at='2026-05-11T10:00:00Z' "
      f"WHERE id={q(did('JE', global_e))};")
    # migration 0015: a reversal must name who did it and when, and the person
    # who APPROVED the receipt may not be the one who reverses it. The demo's
    # reversal was written before that rule existed and the trigger refused it —
    # correctly. CHAIR approved these receipts, so TREASURER reverses.
    P(f"UPDATE payments SET status='reversed', reversed_by={q(TREASURER)}, "
      f"reversed_at='2026-06-15T11:00:00Z', "
      f"review_reason_ar='اتسجّل على شقة غلط — اتعكس محاسبيًا' "
      f"WHERE id={q(rev_pid)};")
    entry_n = global_e
    line_n += 2

# ==================================================== expenses ============
P("\n-- ------------------------------------------------------- expenses ---")
EXPENSES = [                                  # (month, kind, piastres, description, vendor)
    (1, 'مرتبات', 2_800_000, 'مرتبات العمالة — يناير', None),
    (1, 'كهرباء',   940_000, 'فاتورة الكهرباء (عداد عام) — يناير', 'شركة شمال الدلتا'),
    (1, 'أمن',    1_200_000, 'مرتبات الأمن — يناير', 'شركة حراسة الساحل'),
    (2, 'مرتبات', 2_800_000, 'مرتبات العمالة — فبراير', None),
    (2, 'مياه',     640_000, 'عربات مياه حلوة — 8 عربات', 'أبو زيد للمياه'),
    (2, 'أمن',    1_200_000, 'مرتبات الأمن — فبراير', 'شركة حراسة الساحل'),
    (3, 'مرتبات', 2_800_000, 'مرتبات العمالة — مارس', None),
    (3, 'صيانة',    475_000, 'تغيير لمبات الإنارة في 6 عمارات', 'ورشة النور'),
    (3, 'كهرباء',   880_000, 'فاتورة الكهرباء — مارس', 'شركة شمال الدلتا'),
    (3, 'أمن',    1_200_000, 'مرتبات الأمن — مارس', 'شركة حراسة الساحل'),
    (4, 'مرتبات', 2_800_000, 'مرتبات العمالة — أبريل', None),
    (4, 'زراعة',    380_000, 'تقليم وتنسيق المساحات الخضراء', 'مشتل مطروح'),
    (4, 'صيانة',  1_250_000, 'إصلاح موتور المياه الرئيسي', 'م. عادل للكهروميكانيك'),
    (4, 'أمن',    1_200_000, 'مرتبات الأمن — أبريل', 'شركة حراسة الساحل'),
    (5, 'مرتبات', 2_800_000, 'مرتبات العمالة — مايو', None),
    (5, 'سباحة',    920_000, 'تجهيز حمام السباحة للموسم — كلور ومضخات', 'بلو ووتر'),
    (5, 'مياه',     800_000, 'عربات مياه حلوة — 10 عربات', 'أبو زيد للمياه'),
    (5, 'نظافة',    650_000, 'رفع مخلفات — مايو', 'مقاول النظافة'),
    (5, 'أمن',    1_200_000, 'مرتبات الأمن — مايو', 'شركة حراسة الساحل'),
    (6, 'مرتبات', 2_800_000, 'مرتبات العمالة — يونيو', None),
    (6, 'صيانة',    690_000, 'دهانات وترميم سور القرية — المرحلة الأولى', 'مقاولات الساحل'),
    (6, 'كهرباء',  1_120_000, 'فاتورة الكهرباء — يونيو (موسم)', 'شركة شمال الدلتا'),
    (6, 'نظافة',    650_000, 'رفع مخلفات — يونيو', 'مقاول النظافة'),
    (6, 'أمن',    1_200_000, 'مرتبات الأمن — يونيو', 'شركة حراسة الساحل'),
    (7, 'مرتبات', 2_800_000, 'مرتبات العمالة — يوليو', None),
    (7, 'مياه',     960_000, 'عربات مياه حلوة — 12 عربة (ذروة الموسم)', 'أبو زيد للمياه'),
    (7, 'سباحة',    340_000, 'صيانة دورية لحمام السباحة', 'بلو ووتر'),
    (7, 'نظافة',    650_000, 'رفع مخلفات — يوليو', 'مقاول النظافة'),
    (7, 'إدارية',   210_000, 'رسوم حكومية وتصاريح', None),
    (7, 'أمن',    1_200_000, 'مرتبات الأمن — يوليو', 'شركة حراسة الساحل'),
]

for n, (month, kind, amount, desc, vendor) in enumerate(EXPENSES, start=1):
    acct, cat = EXPENSE_ACCOUNTS[kind]
    eid_x = did("EXP", n)
    date = f"2026-{month:02d}-{(n % 26) + 1:02d}"
    payer = A_BANK if amount >= 1_000_000 else A_CASH
    # above the 5,000 ج.م threshold, a second admin countersigns (06 §6)
    needs_second = amount > 500_000
    P(f"INSERT INTO expenses (id, voucher_no, category_id, amount_piastres, spent_on, "
      f"description_ar, vendor_name, fund_id, status, recorded_by{', approved_by, approved_at' if needs_second else ''}) VALUES "
      f"({q(eid_x)},{q(f'E-2026-{n:05d}')},{q(cat)},{amount},{q(date)},{q(desc)},{q(vendor)},"
      f"{q(F_OP)},'recorded',{q(OPERATOR)}"
      f"{f', {q(CHAIR)}, {q(date + chr(84) + chr(48) + chr(57) + chr(58) + chr(48) + chr(48) + chr(58) + chr(48) + chr(48) + chr(90))}' if needs_second else ''});")
    ex_eid, ex_post = post_entry(P, desc, "expense", eid_x, [
        (acct,  F_OP, amount, 0, None, desc),
        (payer, F_OP, 0, amount, None, "صرف"),
    ], date, creator=OPERATOR, approver=TREASURER, defer_post=True)
    # Attach first, post second — same rule as the receipts above.
    P(f"UPDATE expenses SET status='posted', journal_entry_id={q(ex_eid)} WHERE id={q(eid_x)};")
    P(ex_post)
    # Maker–checker, visible: the operator records, a second admin countersigns
    # above the threshold, and the treasurer posts. Three rows because they are
    # three people — collapsing them would hide the control they exist to prove.
    audit(date + 'T09:00:00Z', OPERATOR, 'expense.record', 'expenses', eid_x)
    if needs_second:
        audit(date + 'T09:00:00Z', CHAIR, 'expense.countersign', 'expenses', eid_x)
    audit(date + 'T10:00:00Z', TREASURER, 'expense.post', 'expenses', eid_x)

# ======================================================= village map ======
# C13 / 07_VILLAGE_MAP_SPEC.md. The drawing is the owner's own photographed
# brochure plan; `assets/maps/village-map-manifest.json` records its checksums
# and states plainly that it is cropped and partial.
#
# ⚠️ The hotspot coordinates below were read off the image by eye, in the
# normalised 0–10,000 space. That is exactly the status the spec assigns them:
# a visual reference awaiting board verification on the ground. They are marked
# `board_verified` HERE ONLY because this is the demo database — the whole
# point of the demo is to show the workflow after the board has done its part,
# and `trg_no_demo_*` (0006) makes these rows impossible to load into a
# production database.
#
# Buildings the drawing does not clearly show are simply absent. They still
# appear in the register list on /map, marked «مش على الخريطة», which is the
# honest rendering of partial coverage — and the reason C13 forbids inventing
# a building from a label nobody could read.
MAP_ID = did("MAP", 1)
MAP_SOURCE_SHA = "5300a7c1c04f1bc5c0c5f438fdc18a3331c7a18c70cb9100e0e4ab818601742e"
MAP_DISPLAY_SHA = "7794b99dd3638418f38141ec600e37362795e73f3a09903e697ff50f832ceb21"
MAP_DISPLAY_KEY = "maps/village-map-2026-08-display.webp"

# (building code, centre x, centre y) in the 0–10,000 space
MAP_POINTS = [
    (14, 9625, 7453), (15, 7833, 7478), (16, 8233, 7169), (17, 8642, 6826),
    (18, 8858, 6458), (19, 6833, 7520), (21, 6358, 6809), (22, 5942, 6500),
    (23, 5417, 6918), (24, 5233, 6517), (25, 4750, 7662), (26, 4417, 7336),
    (27, 4058, 7018), (28, 3642, 6785), (29, 3300, 6433), (30, 2875, 7420),
    (31, 2583, 7043), (32, 2083, 7420), (33, 1900, 7102), (34, 1358, 6784),
    (35, 1900, 6534), (36, 1192, 6534), (40,  400, 6558), (41,  400, 7035),
    (43,  400, 7420), (45,  600, 7620),
]
BOX_W, BOX_H = 500, 420

K = lines_content.append   # the map rides with the content file
K("\n-- ------------------------------------------------ village map (C13) ---")
K(f"INSERT INTO map_documents (id, title_ar, source_storage_key, display_storage_key, "
  f"source_sha256, display_sha256, version_label, coverage_note_ar, status, created_by, "
  f"published_by, published_at) VALUES ({q(MAP_ID)},'الموقع العام — قرية الأطباء',"
  f"'maps/village-map-2026-08-source.jpg',{q(MAP_DISPLAY_KEY)},"
  f"{q(MAP_SOURCE_SHA)},{q(MAP_DISPLAY_SHA)},'2026-08',"
  f"'الخريطة دي جزء من القرية مش كلها — العمارات الظاهرة فيها من 14 لـ 46 تقريبًا، "
  f"وباقي العمارات موجودة في القايمة تحت.','published',{q(DEV)},{q(CHAIR)},"
  f"'2026-08-08T09:00:00Z');")

for n, (code, cx, cy) in enumerate(MAP_POINTS, start=1):
    b_index = code - 13          # BUILDINGS starts at 14 -> did('BLD', 1)
    K(f"INSERT INTO building_map_features (id, map_document_id, building_id, label_ar, "
      f"x, y, w, h, verification_status, verified_by, verified_at, sort_order) VALUES "
      f"({q(did('MPF', n))},{q(MAP_ID)},{q(did('BLD', b_index))},{q(str(code))},"
      f"{cx - BOX_W // 2},{cy - BOX_H // 2},{BOX_W},{BOX_H},"
      f"'board_verified',{q(CHAIR)},'2026-08-08T08:00:00Z',{n * 10});")

# ==================================================== staff & content =====
K = lines_content.append
K(HEADER)
K("-- ---------------------------------------------------------- staff ---")
STAFF = [("عم رجب عبد الله", "حارس أمن", 400_000), ("عم سيد محروس", "حارس أمن", 400_000),
         ("عم فتحي إبراهيم", "عامل نظافة", 350_000), ("عم صابر علي", "عامل نظافة", 350_000),
         ("عم حسن الديب", "جنايني", 380_000), ("م. أشرف زكي", "فني كهرباء", 550_000),
         ("عم ممدوح سالم", "سباك", 450_000)]
for n, (nm, title, sal) in enumerate(STAFF, start=1):
    K(f"INSERT INTO staff (id, full_name, job_title_ar, monthly_salary_piastres, started_on) "
      f"VALUES ({q(did('STF', n))},{q(nm)},{q(title)},{sal},'2024-06-01');")
    audit(f"2026-01-06T{9 + (n % 6):02d}:{10 + n:02d}:00Z", CHAIR, 'staff.add', 'staff', did('STF', n))

K("\n-- --------------------------------------------------------- content ---")
# Spread across three years on purpose. The CP-6 gate is "a 2-year-old
# announcement is reachable in <=3 taps", and a demo whose archive holds only
# the current year cannot demonstrate — or fail — that gate.
POSTS = [
    ("2024-03-12", "decision", "decision-2024-founding", "قرار تأسيس مجلس الإدارة الأول",
     "تم انتخاب أول مجلس إدارة للقرية واعتماد اللائحة الداخلية ونظام الاشتراك السنوي."),
    ("2024-08-04", "minutes", "minutes-2024-08", "محضر الجمعية العمومية — أغسطس 2024",
     "مناقشة الميزانية التقديرية، واعتماد بند صيانة مواتير المياه، والموافقة على فتح حساب بنكي باسم القرية."),
    ("2025-05-20", "news", "news-pool-2025", "تجديد حمام السباحة",
     "تم تغيير طبقة العزل وإصلاح فلاتر حمام السباحة استعدادًا لموسم 2025."),
    ("2025-11-02", "decision", "decision-2025-07", "قرار رقم 7 لسنة 2025 — التعاقد مع شركة نظافة",
     "الموافقة على التعاقد مع شركة نظافة جديدة بعد مقارنة ثلاثة عروض، وإنهاء التعاقد السابق."),
    ("2026-01-10", "announcement", "moment-2026-summer", "تجهيزات الموسم الصيفي 2026",
     "تم تجهيز حمام السباحة وصيانة موتور المياه الرئيسي قبل بداية الموسم. أي ملاحظة كلّم الإدارة."),
    ("2026-02-10", "decision", "decision-2026-01", "قرار مجلس الإدارة رقم 1 لسنة 2026",
     "الموافقة على اشتراك الصيانة السنوي وتحديد تاريخ الاستحقاق 31 مارس 2026."),
    ("2026-03-10", "minutes", "minutes-2026-03", "محضر اجتماع الجمعية العمومية — مارس 2026",
     "تمت مناقشة الميزانية واعتماد بند ترميم السور، والموافقة على نشر البيان المالي شهريًا."),
    ("2026-04-10", "news", "news-wall-repair", "بدء أعمال ترميم السور",
     "بدأت المرحلة الأولى من دهانات وترميم سور القرية. الصور في ألبوم الصيانة."),
    ("2026-07-18", "announcement", "moment-2026-assembly", "اجتماع الجمعية العمومية — 21 أغسطس",
     "جدول الأعمال: البيان المالي لسنة 2026، اشتراك 2027، وانتخاب عضوين جدد بالمجلس."),
]
def fold(s):
    for a, b in [("أ","ا"),("إ","ا"),("آ","ا"),("ٱ","ا"),("ة","ه"),("ى","ي"),("ؤ","و"),("ئ","ي")]:
        s = s.replace(a, b)
    return s
# Only the newest announcement is pinned. Two pinned banners is the same as
# none: the home screen can only carry one "read this now".
PINNED_SLUG = "moment-2026-assembly"
for n, (when, typ, slug, title, body) in enumerate(POSTS, start=1):
    K(f"INSERT INTO posts (id, type, slug, title_ar, body_ar, search_body, author_id, published_at, is_pinned) "
      f"VALUES ({q(did('PST', n))},{q(typ)},{q(slug)},{q(title)},{q(body)},"
      f"{q(fold(title + ' ' + body))},{q(CHAIR)},{q(when + 'T12:00:00Z')},"
      f"{1 if slug == PINNED_SLUG else 0});")
    K(f"INSERT INTO posts_fts (post_id, title_ar, search_body, attachment_text) "
      f"VALUES ({q(did('PST', n))},{q(fold(title))},{q(fold(title + ' ' + body))},'');")
    audit(when + 'T12:00:00Z', CHAIR, 'post.publish', 'posts', did('PST', n))

# Only the two most recent announcements notify the village, and only they are
# left UNREAD. The product notifies on every publication, but a demo whose bell
# reads «9» after nobody has done anything says the portal nags — and the number
# the board should see is the one a resident would actually be carrying.
for n, (when, typ, slug, title, body) in list(enumerate(POSTS, start=1))[-2:]:
    for r in residents:
        notify(when + 'T12:05:00Z', r, 'new_announcement', title,
               body[:120], link=f"/news/{slug}", read=False)

# An attached PDF whose TEXT is indexed but whose words appear nowhere in the
# post itself. This is the CP-6 gate made concrete: searching «الميزانيه
# التقديريه» must return the minutes post, and it can only do so through
# attachment_text. If the gate ever regresses, this row is what fails.
K(f"INSERT INTO post_attachments (id, post_id, storage_key, name_ar, size_bytes, mime, extracted_text) "
  f"VALUES ({q(did('ATT', 1))},{q(did('PST', 2))},'docs/minutes-2024-08.pdf',"
  f"'محضر الجمعية العمومية أغسطس 2024.pdf',184320,'application/pdf',"
  f"{q(fold('الميزانية التقديرية لسنة 2025 بند صيانة مواتير المياه اعتماد المصروفات الرأسمالية نصاب الحضور'))});")
K(f"UPDATE posts_fts SET attachment_text = "
  f"{q(fold('محضر الجمعيه العموميه اغسطس 2024.pdf الميزانية التقديرية لسنة 2025 بند صيانة مواتير المياه اعتماد المصروفات الرأسمالية نصاب الحضور'))} "
  f"WHERE post_id = {q(did('PST', 2))};")

# `building_id` is what makes «شغل منشور على العمارة دي» work on /buildings/:id.
# Migration 0023 added the column for exactly that and nothing ever set it, so
# every building page in the demo showed «مفيش شغل منشور» — the map led to a
# dead end thirty-four times.
ALBUM_BUILDING = did('BLD', 9)             # عمارة 22
K(f"\nINSERT INTO albums (id, title_ar, description_ar, happened_on, linked_expense_id, "
  f"building_id, created_by, safety_checked_by, safety_checked_at, published_at) VALUES "
  f"({q(did('ALB', 1))},'ترميم سور القرية — المرحلة الأولى','صور قبل وبعد أعمال الدهانات',"
  f"'2026-06-15',{q(did('EXP', 21))},{q(ALBUM_BUILDING)},{q(OPERATOR)},{q(CHAIR)},"
  f"'2026-06-20T10:00:00Z','2026-06-20T10:00:00Z');")
for n in range(1, 5):
    K(f"INSERT INTO album_photos (id, album_id, storage_key, caption_ar, sort_order, exif_stripped) "
      f"VALUES ({q(did('APH', n))},{q(did('ALB', 1))},{q(f'albums/wall/{n}.webp')},"
      f"{q(f'صورة {n} من أعمال الترميم')},{n},1);")

K(f"INSERT INTO albums_fts (album_id, title_ar, search_body) VALUES "
  f"({q(did('ALB', 1))},{q(fold('ترميم سور القرية — المرحلة الأولى'))},"
  f"{q(fold('ترميم سور القرية — المرحلة الأولى صور قبل وبعد أعمال الدهانات'))});")

K("\n-- ------------------------------------------------ maintenance ---")
# One ticket in each interesting state, including a resolved one linked to the
# expense that paid for the fix — the shape the board will actually look at.
# `unit_id` was NULL on all three, so no ticket ever appeared on a building
# page — and the first one named «عمارة 5», which does not exist: this village
# is numbered 14 to 47. Invented data still has to be internally consistent, or
# a board member checks one detail and stops trusting the rest.
UNIT_OF = {code: uid for uid, code, u_no, _ in units if u_no == 1}
TICKETS = [
    (1, residents[0], UNIT_OF[22], "نور السلم في عمارة 22 مش شغال",
     "الطابق التالت والرابع ضلمة من يومين.", "open", "", "2026-08-02T18:20:00Z"),
    (2, residents[1], UNIT_OF[31], "حنفية الحديقة الجنوبية بتنقّط",
     "المياه بتتهدر طول اليوم.", "in_progress", "", "2026-07-28T09:10:00Z"),
    (3, residents[0], UNIT_OF[22], "باب البوابة الرئيسية بيصدر صوت عالي",
     "محتاج تزييت.", "resolved", "تم تزييت المفصلات وتغيير الماسورة السفلية.", "2026-07-05T11:00:00Z"),
]
for n, who, unit, title, body, status, resolution, when in TICKETS:
    resolved = q(when) if status in ("resolved", "closed") else "NULL"
    K(f"INSERT INTO maintenance_tickets (id, ticket_no, reported_by, unit_id, title_ar, "
      f"description_ar, search_body, status, resolution_ar, resolved_at, created_at) VALUES "
      f"({q(did('TKT', n))},{q(f'M-2026-{n:05d}')},{q(who)},{'NULL' if unit is None else q(unit)},"
      f"{q(title)},{q(body)},{q(fold(title + ' ' + body))},{q(status)},{q(resolution)},"
      f"{resolved},{q(when)});")

K("\n-- monthly reconciliation against the real bank balance (06 §8)")
K(f"INSERT INTO reconciliations (id, account_id, period_id, as_of, statement_balance_piastres, "
  f"book_balance_piastres, difference_piastres, notes_ar, done_by) VALUES "
  f"({q(did('REC', 1))},{q(A_BANK)},{q(PERIOD)},'2026-07-31',0,0,0,NULL,{q(TREASURER)});")
K("-- ⚠️ the two balances above are placeholders; verify_demo.py rewrites them from")
K("--    the actual book balance so the demo shows a TRUE 'متطابق مع البنك ✅'.")

K("\n-- settings the board would fill in — bank details deliberately left NULL (Q13, C10)")
K(f"UPDATE settings SET countersign_threshold_piastres=500000, updated_by={q(CHAIR)}, "
  f"updated_at='2026-01-05T09:00:00Z' WHERE id=1;")
audit('2026-01-05T09:00:00Z', CHAIR, 'settings.update', 'settings', '1')

# ==================================================== notifications =======
# One reminder per unpaid flat, a fortnight before the due date — the shape of
# the `due_reminder` the board would send, and the reason a resident who owes
# money has something in «رسايلي» besides receipt decisions.
for i in idx[188:]:
    notify('2026-03-17T09:00:00Z', owner_of(i), 'due_reminder',
           'فاضل أسبوعين على آخر ميعاد للاشتراك',
           'اشتراك الصيانة السنوي 2026 آخر ميعاد له 31 مارس. تقدر تدفع من «دفع جديد».',
           link='/pay', read=False)

lines_notif = []
N = lines_notif.append
N(HEADER)
N("-- ---------------------------------------------------- notifications ---")
N("-- Each row is one the product itself would have written: a decision message")
N("-- in the same batch as the decision (R-065), an announcement, or a reminder.")
notif_rows.sort(key=lambda r: r[0])
for n, (when, profile, kind, title, body, link, payment, read) in enumerate(notif_rows, start=1):
    N(f"INSERT INTO notifications (id, profile_id, kind, title_ar, body_ar, link_path, "
      f"payment_id, read_at, created_at) VALUES ({q(did('NTF', n))},{q(profile)},{q(kind)},"
      f"{q(title)},{q(body)},{q(link)},{q(payment)},"
      f"{q(when) if read else 'NULL'},{q(when)});")

# ==================================================== the audit trail =====
# Emitted last, sorted, so the file reads as the history it is. It is written
# into its own numbered file because every loader in the repo globs the
# directory in name order — `tests/fixtures/render_screens.ts`,
# `verify_demo.py`, `render_preview.py` and `tools/restore-drill.mjs` all pick
# it up with no change, and the restore drill therefore proves the trail
# survives a restore too.
lines_audit = []
A = lines_audit.append
A(HEADER)
A("-- ----------------------------------------------------- audit trail ---")
A("-- Who did what, and when. Insert-only: trg_audit_no_update and")
A("-- trg_audit_no_delete (migration 0004) refuse any change to a row below.")
audit_rows.sort(key=lambda r: (r[0], r[2]))
for n, (when, actor, action, table, entity, role) in enumerate(audit_rows, start=1):
    A(f"INSERT INTO audit_log (id, actor_id, actor_role, action, entity_table, entity_id, "
      f"created_at) VALUES ({q(did('AUD', n))},{q(actor)},{q(role)},{q(action)},{q(table)},"
      f"{q(entity)},{q(when)});")

# ---------------------------------------------------------------- write ----
for name, buf in [("001_village.sql", lines_village), ("002_opening.sql", lines_ledger),
                  ("003_money.sql", lines_money), ("004_content.sql", lines_content),
                  ("005_audit.sql", lines_audit), ("006_notifications.sql", lines_notif)]:
    (OUT / name).write_text("\n".join(buf) + "\n", encoding="utf-8")
    print(f"  {name:22s} {len(buf):5d} statements")

print(f"\n  {len(BUILDINGS)} buildings · {len(units)} units · {len(people)} people · "
      f"{pay_n} receipts · {len(EXPENSES)} expenses · {entry_n} journal entries")
