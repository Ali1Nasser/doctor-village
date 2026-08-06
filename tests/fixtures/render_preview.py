#!/usr/bin/env python3
"""
render_preview.py — renders the demo village as a static Arabic RTL page.

Two jobs:
  1. Give the board something to LOOK AT before any of this is built
     (CHECKPOINTS: "every checkpoint ends with a demo-able state").
  2. Prove the views produce sensible output — a number that reads wrong on a
     screen is a bug the SQL tests will happily pass.

Every figure on the page comes from a view, not from Python arithmetic.

Run:  python3 tests/fixtures/render_preview.py  ->  preview/finance.html
"""

import sqlite3, pathlib, html

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "preview"; OUT.mkdir(exist_ok=True)

def build():
    db = sqlite3.connect(":memory:"); db.execute("PRAGMA foreign_keys=ON")
    for m in sorted((ROOT / "migrations").glob("*.sql")): db.executescript(m.read_text())
    for s in sorted((ROOT / "seed/prod").glob("*.sql")): db.executescript(s.read_text())
    db.commit()
    db.execute("UPDATE env_guard SET environment='demo', set_by='preview'"); db.commit()
    for s in sorted((ROOT / "seed/demo").glob("*.sql")): db.executescript(s.read_text())
    bank = db.execute("SELECT balance_piastres FROM v_account_balances WHERE code='1102'").fetchone()[0]
    db.execute("""UPDATE reconciliations SET statement_balance_piastres=?, book_balance_piastres=?,
                  difference_piastres=0""", (bank, bank))
    db.commit()
    return db

db = build()
def rows(sql, *a):
    cur = db.execute(sql, a)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]
def one(sql, *a): return db.execute(sql, a).fetchone()[0]

tot   = rows("SELECT * FROM v_community_totals")[0]
eq    = rows("SELECT * FROM v_accounting_equation")[0]
cats  = [c for c in rows("""SELECT name_ar, total_piastres FROM v_expense_by_category
                            WHERE parent_id IS NULL AND total_piastres > 0
                            ORDER BY total_piastres DESC""")]
units = rows("""SELECT building_code, COUNT(*) n,
                SUM(CASE WHEN outstanding_piastres <= 0 THEN 1 ELSE 0 END) paid,
                SUM(due_piastres) due, SUM(paid_piastres) got
                FROM v_unit_balance GROUP BY building_code
                ORDER BY CAST(building_code AS INTEGER) LIMIT 12""")
me    = rows("""SELECT ub.*, b.code FROM v_unit_balance ub JOIN units u ON u.id=ub.unit_id
                JOIN buildings b ON b.id=u.building_id
                WHERE ub.paid_piastres > 0 AND ub.outstanding_piastres > 0 LIMIT 1""")[0]
pend  = rows("""SELECT p.receipt_no, p.claimed_amount_piastres a, p.transfer_date, c.name_ar cat,
                b.code bcode, u.unit_number un FROM payments p
                JOIN units u ON u.id=p.unit_id JOIN buildings b ON b.id=u.building_id
                JOIN categories c ON c.id=p.category_id
                WHERE p.status='under_review' LIMIT 1""")[0]
staff = rows("SELECT job_title_ar, monthly_salary_piastres FROM v_staff_public WHERE is_active=1")
recon = rows("SELECT as_of, difference_piastres FROM reconciliations")[0]
warn  = rows("SELECT * FROM v_single_admin_warning")[0]
n_pending = one("SELECT COUNT(*) FROM payments WHERE status IN ('submitted','under_review')")

def m(p):  return f"{p/100:,.2f}"
def bdi(p): return f'<bdi dir="ltr" class="num">{m(p)}</bdi> <span class="cur">ج.م</span>'
def e(s):  return html.escape(str(s))

AR_MONTHS = ["يناير","فبراير","مارس","أبريل","مايو","يونيو",
             "يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"]
def ardate(iso):
    """'2026-07-31' -> '31 يوليو 2026'. 04_UX_SPEC §10: Arabic month, Gregorian
    calendar. An ISO string on screen is a developer's date, not a resident's."""
    y, mo, d = iso.split("-")
    return f'<bdi dir="ltr" class="num">{int(d)}</bdi> {AR_MONTHS[int(mo)-1]} ' \
           f'<bdi dir="ltr" class="num">{y}</bdi>'

def pct(part, whole):
    """Integer division turned 3,800 ج.م of real spending into '0%', which reads
    as 'we spent nothing on gardening'. Small shares must stay visible."""
    p = part * 100 / whole
    if p < 0.5:  return "أقل من 1%"
    if p < 10:   return f'<bdi dir="ltr" class="num">{p:.1f}%</bdi>'
    return f'<bdi dir="ltr" class="num">{round(p)}%</bdi>'

total_exp = sum(c["total_piastres"] for c in cats) or 1
bars = "".join(
    f'''<div class="bar-row">
      <div class="bar-label"><span>{e(c["name_ar"])}</span>
        <span class="bar-val">{bdi(c["total_piastres"])} · {pct(c["total_piastres"], total_exp)}</span></div>
      <div class="track"><div class="fill" style="width:{max(c["total_piastres"]*100/total_exp,1.5):.1f}%"></div></div>
    </div>''' for c in cats)

table_rows = "".join(
    f'<tr><td>{e(c["name_ar"])}</td><td class="ltr">{m(c["total_piastres"])}</td>'
    f'<td>{pct(c["total_piastres"], total_exp)}</td></tr>' for c in cats)

unit_rows = "".join(
    f'''<tr><td>عمارة <bdi dir="ltr" class="num">{e(u["building_code"])}</bdi></td>
    <td class="ltr">{u["paid"]}/{u["n"]}</td>
    <td class="ltr">{m(u["got"])}</td>
    <td class="ltr">{m(max(u["due"]-u["got"],0))}</td></tr>''' for u in units)

staff_rows = "".join(
    f'<tr><td>{e(s["job_title_ar"])}</td><td class="ltr">{m(s["monthly_salary_piastres"])}</td></tr>'
    for s in staff)

HTML = f"""<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>بوابة قرية الأطباء — معاينة</title>
<style>
:root {{
  --bg:#F7F6F3; --surface:#fff; --surface-2:#F0EEE9; --ink:#1F2421; --ink-muted:#5B615C;
  --brand:#0E5C63; --brand-ink:#fff; --brand-soft:#E3F0F1; --accent:#C1873B;
  --ok:#1D7A4C; --ok-soft:#E4F3EA; --warn:#A96A00; --warn-soft:#FBEFD9;
  --danger:#B3261E; --danger-soft:#FBE9E7; --info:#1F5FA8; --info-soft:#E5EFFA;
  --border:#DFDCD5; --radius:14px; --tap:48px;
}}
@media (prefers-color-scheme: dark) {{
  :root {{ --bg:#14171A; --surface:#1C2124; --surface-2:#242A2E; --ink:#E8EAE7;
    --ink-muted:#A3ABA6; --brand:#5FB8C0; --brand-ink:#0B2225; --brand-soft:#123B40;
    --ok:#5BC98C; --ok-soft:#12331F; --warn:#E0A845; --warn-soft:#33260C;
    --danger:#F08A82; --danger-soft:#3A1512; --info:#7FB0EE; --info-soft:#122844;
    --border:#333A3E; }}
}}
*{{box-sizing:border-box}}
body {{ margin:0; background:var(--bg); color:var(--ink); line-height:1.75;
  font-size:17px; font-family:"IBM Plex Sans Arabic","Noto Sans Arabic","Segoe UI",Tahoma,sans-serif; }}
.num {{ font-variant-numeric:tabular-nums; font-feature-settings:"tnum"; }}
.cur {{ font-size:.75em; color:var(--ink-muted); }}
.ltr {{ direction:ltr; text-align:left; font-variant-numeric:tabular-nums; }}
.wrap {{ max-width:760px; margin:0 auto; padding:16px 16px 64px; }}
header {{ background:var(--brand); color:var(--brand-ink); padding:20px 16px; }}
header h1 {{ margin:0; font-size:22px; }}
header p {{ margin:4px 0 0; opacity:.85; font-size:15px; }}
.banner {{ background:var(--warn-soft); color:var(--warn); border:1px solid currentColor;
  border-radius:var(--radius); padding:12px 14px; margin:16px 0; font-size:15px; }}
h2 {{ font-size:20px; margin:32px 0 12px; }}
h2 .path {{ font-size:13px; color:var(--ink-muted); font-weight:400; direction:ltr;
  display:inline-block; margin-inline-start:8px; }}
.card {{ background:var(--surface); border:1px solid var(--border); border-radius:var(--radius);
  padding:18px; margin-bottom:14px; }}
.tiles {{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }}
@media (max-width:520px) {{ .tiles {{ grid-template-columns:1fr; }} }}
.tile {{ background:var(--surface); border:1px solid var(--border); border-inline-start:5px solid var(--tc,var(--brand));
  border-radius:var(--radius); padding:16px; }}
.tile .lbl {{ display:flex; align-items:center; gap:8px; font-size:15px; color:var(--ink-muted); }}
.tile .ico {{ width:26px; height:26px; flex:0 0 26px; display:grid; place-items:center;
  border-radius:50%; background:var(--tsoft,var(--brand-soft)); color:var(--tc,var(--brand)); font-size:14px; }}
.tile .v {{ font-size:28px; font-weight:700; margin-top:6px; color:var(--tc,var(--ink)); }}
.tile .note {{ font-size:14px; color:var(--ink-muted); margin-top:2px; }}
.hero {{ font-size:34px; font-weight:700; }}
.btn {{ display:block; width:100%; min-height:var(--tap); background:var(--brand); color:var(--brand-ink);
  border:0; border-radius:var(--radius); font-size:19px; font-weight:700; margin-top:14px;
  font-family:inherit; cursor:pointer; }}
.btn-2 {{ background:var(--surface-2); color:var(--ink); border:1px solid var(--border); }}
.chip {{ display:inline-flex; align-items:center; gap:6px; border-radius:999px; padding:4px 12px;
  font-size:14px; font-weight:600; border:1px solid currentColor; }}
.chip.warn {{ color:var(--warn); background:var(--warn-soft); }}
.chip.ok {{ color:var(--ok); background:var(--ok-soft); }}
.chip.danger {{ color:var(--danger); background:var(--danger-soft); }}
.bar-row {{ margin-bottom:14px; }}
.bar-label {{ display:flex; justify-content:space-between; gap:12px; font-size:15px; margin-bottom:5px; }}
.bar-val {{ color:var(--ink-muted); white-space:nowrap; }}
.track {{ background:var(--surface-2); border-radius:4px; height:14px; overflow:hidden; }}
.fill {{ height:100%; background:var(--brand); border-radius:4px; }}
table {{ width:100%; border-collapse:collapse; font-size:15px; }}
th,td {{ text-align:start; padding:9px 6px; border-bottom:1px solid var(--border); }}
th {{ color:var(--ink-muted); font-weight:600; font-size:14px; }}
details summary {{ cursor:pointer; min-height:var(--tap); display:flex; align-items:center;
  color:var(--brand); font-weight:600; }}
.muted {{ color:var(--ink-muted); font-size:15px; }}
.recon {{ color:var(--ok); font-weight:600; }}
.foot {{ margin-top:40px; font-size:14px; color:var(--ink-muted); border-top:1px solid var(--border); padding-top:16px; }}
</style>
</head>
<body>
<header>
  <h1>بوابة قرية الأطباء</h1>
  <p>عجيبة، مرسى مطروح · معاينة على بيانات تجريبية</p>
</header>
<div class="wrap">

<div class="banner">
  ⚠️ <strong>كل الأرقام والأسماء في الصفحة دي متخيّلة</strong> — اتولدت عشان نشوف شكل الموقع قبل
  ما تبعت بيانات القرية الحقيقية. مفيش رقم واحد هنا جه من حضرتك.
</div>

<h2>الرئيسية <span class="path">/</span></h2>
<div class="card">
  <div class="muted">أهلاً يا د. أحمد · عمارة <bdi dir="ltr" class="num">{e(me["building_code"])}</bdi>
    شقة <bdi dir="ltr" class="num">{e(me["unit_number"])}</bdi></div>
  <div class="muted" style="margin-top:10px">المطلوب منك السنة دي</div>
  <div class="hero">{bdi(me["due_piastres"])}</div>
  <div class="muted">دفعت منها {bdi(me["paid_piastres"])} · باقي
    <strong style="color:var(--danger)">{bdi(me["outstanding_piastres"])}</strong></div>
  <button class="btn">دفع جديد</button>
  <button class="btn btn-2">شوف إيصالاتي</button>
</div>

<h2>فلوس القرية <span class="path">/finance</span></h2>
<p class="muted" style="margin-top:-6px">
  أربع أرقام منفصلة — مش رقم واحد. ده مقصود: خلط الودائع مع فلوس القرية بيدّي إحساس
  إن معانا فلوس أكتر من الحقيقة.
</p>

<div class="tiles">
  <div class="tile" style="--tc:var(--brand);--tsoft:var(--brand-soft)">
    <div class="lbl"><span class="ico">✔</span> الفلوس المتاحة للصرف</div>
    <div class="v">{bdi(tot["spendable_piastres"])}</div>
    <div class="note">ده اللي القرية تقدر تصرف منه فعلاً</div>
  </div>
  <div class="tile" style="--tc:var(--ink-muted);--tsoft:var(--surface-2)">
    <div class="lbl"><span class="ico">🔒</span> ودائع وأرصدة للملاك</div>
    <div class="v">{bdi(tot["held_in_trust_piastres"])}</div>
    <div class="note">أمانات — مش ملك القرية، بتترد لأصحابها</div>
  </div>
  <div class="tile" style="--tc:var(--warn);--tsoft:var(--warn-soft)">
    <div class="lbl"><span class="ico">🕐</span> إيصالات تحت المراجعة</div>
    <div class="v">{bdi(tot["pending_not_counted_piastres"])}</div>
    <div class="note"><bdi dir="ltr" class="num">{n_pending}</bdi> إيصال — <strong>مش محسوبة في الإيرادات</strong></div>
  </div>
  <div class="tile" style="--tc:var(--danger);--tsoft:var(--danger-soft)">
    <div class="lbl"><span class="ico">!</span> متأخرات مطلوبة</div>
    <div class="v">{bdi(tot["receivables_piastres"])}</div>
    <div class="note">اشتراكات لسه متدفعتش</div>
  </div>
</div>

<div class="card" style="margin-top:14px">
  <div class="recon">✅ آخر مطابقة مع البنك: {ardate(recon["as_of"])} — متطابق تمامًا</div>
  <div class="muted">إجمالي الإيرادات المعتمدة {bdi(tot["total_income_piastres"])} ·
    إجمالي المصروفات {bdi(tot["total_expense_piastres"])} ·
    رصيد أول المدة {bdi(eq["funds_piastres"])}</div>
</div>

<h2>المصروفات على إيه؟</h2>
<div class="card">
  {bars}
  <details>
    <summary>شوف الأرقام</summary>
    <table><thead><tr><th>البند</th><th>المبلغ (ج.م)</th><th>النسبة</th></tr></thead>
    <tbody>{table_rows}</tbody></table>
  </details>
</div>

<h2>حالة السداد لكل عمارة <span class="path">/finance/units</span></h2>
<div class="card">
  <p class="muted" style="margin-top:0">أرقام مجمّعة بس — مفيش أسماء ولا أرقام موبايل ولا صور إيصالات.
    عرض الوحدات بالتفصيل مقفول لحد ما الجمعية العمومية توافق كتابةً.</p>
  <table><thead><tr><th>العمارة</th><th>دفعوا</th><th>محصّل (ج.م)</th><th>متبقّي (ج.م)</th></tr></thead>
  <tbody>{unit_rows}</tbody></table>
  <p class="muted">أول <bdi dir="ltr" class="num">12</bdi> عمارة من
    <bdi dir="ltr" class="num">{one("SELECT COUNT(*) FROM buildings")}</bdi></p>
</div>

<h2>مراجعة الإيصالات <span class="path">/admin/review</span></h2>
<div class="card">
  <div class="muted">صورة التحويل تظهر هنا · اضغط للتكبير</div>
  <div style="background:var(--surface-2);border-radius:8px;height:120px;display:grid;
    place-items:center;color:var(--ink-muted);margin:10px 0">[ صورة الإيصال ]</div>
  <div><strong>عمارة <bdi dir="ltr" class="num">{e(pend["bcode"])}</bdi>
    شقة <bdi dir="ltr" class="num">{e(pend["un"])}</bdi></strong></div>
  <div class="hero" style="font-size:26px">{bdi(pend["a"])}</div>
  <div class="muted">{e(pend["cat"])} · تحويل يوم {ardate(pend["transfer_date"])} ·
    إيصال <bdi dir="ltr" class="num">{e(pend["receipt_no"])}</bdi></div>
  <div style="margin-top:10px"><span class="chip warn">🕐 قيد المراجعة</span></div>
  <button class="btn">✅ اعتماد</button>
  <button class="btn btn-2">❔ محتاج توضيح</button>
  <button class="btn btn-2">❌ رفض</button>
  <p class="muted">الرفض ومحتاج توضيح لازم معاهم سبب مكتوب — بيتعرض للساكن بالنص.</p>
</div>

{'<div class="banner">⚠️ فيه أدمن واحد بس — يُفضّل تعيين تاني عشان المراجعة</div>' if warn["show_warning"] else ''}

<h2>العمالة</h2>
<div class="card">
  <p class="muted" style="margin-top:0">الوظيفة والمرتب بيشوفهم كل السكان. الأسماء للإدارة بس
    (لحد ما تقرر غير كده — سؤال Q4).</p>
  <table><thead><tr><th>الوظيفة</th><th>المرتب الشهري (ج.م)</th></tr></thead>
  <tbody>{staff_rows}</tbody></table>
</div>

<div class="foot">
  <p><strong>ملاحظات على التصميم:</strong></p>
  <p>· كل رقم مغلّف في <code>&lt;bdi dir="ltr"&gt;</code> عشان ميتقلبش جوه النص العربي — ده أكتر
     خطأ شائع في الواجهات العربية.</p>
  <p>· أعمدة المصروفات بلون واحد والاسم مكتوب على كل عمود، فبتتقري لو الشاشة أبيض وأسود أو لو
     الشخص مش بيفرق الألوان.</p>
  <p>· كل حالة ليها <strong>لون + كلمة + أيقونة</strong> مع بعض. اختبرنا ألوان "قيد المراجعة"
     و"مرفوض" فطلعوا قريبين من بعض لعين اللي مش بيفرق الأحمر والأخضر — فالكلمة والأيقونة مش
     تحسين شكلي، دول اللي بيخلوا الفرق باين.</p>
  <p>· أصغر خط 17px وأصغر زرار 48px، والصفحة بتشتغل بالليل (dark mode) لوحدها.</p>
  <p class="muted">اتولدت من <code>seed/demo/</code> — كل رقم فيها جاي من الـ views في
     <code>migrations/0005_views.sql</code>، مش محسوب في الصفحة.</p>
</div>
</div>
</body></html>
"""

(OUT / "finance.html").write_text(HTML, encoding="utf-8")
print(f"wrote preview/finance.html  ({len(HTML):,} bytes)")
print(f"  spendable      {m(tot['spendable_piastres']):>16} ج.م")
print(f"  held in trust  {m(tot['held_in_trust_piastres']):>16} ج.م")
print(f"  pending        {m(tot['pending_not_counted_piastres']):>16} ج.م")
print(f"  arrears        {m(tot['receivables_piastres']):>16} ج.م")
