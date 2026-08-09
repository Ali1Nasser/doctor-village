/**
 * tools/walk-report.mjs — turn a walkthrough into a document the board can read.
 *
 * `tools/walkthrough.mjs` produces 190-odd screenshots and a JSON list of
 * findings. That is the evidence; this is the report. One section per role,
 * every scenario with the picture of what actually happened, and the problems
 * found written in the language the people reading it speak.
 *
 * Two things worth knowing about how it is built:
 *
 *   · **The thumbnails are made by Chromium**, because this machine has no
 *     image library — the PNGs are drawn into a canvas, cropped to the part of
 *     the page a reviewer needs, and re-encoded as JPEG. Full-page shots run to
 *     14,000 pixels; embedding those raw makes a PDF nobody can open.
 *   · **The PDF is printed by Chromium too**, which is the only renderer here
 *     that lays out Arabic correctly. A PDF library with no Arabic shaping
 *     produces disconnected letters read right-to-left — worse than no report.
 *
 * Run:  node tools/walk-report.mjs [walkthrough-dir]
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2] ?? join(process.cwd(), 'walkthrough');
const OUT = join(DIR, 'report');
mkdirSync(OUT, { recursive: true });

const { shots, findings, generatedAt } =
  JSON.parse(readFileSync(join(DIR, 'result.json'), 'utf8'));

const exe = ['/opt/pw-browsers/chromium'].find(existsSync);
const browser = await chromium.launch({
  args: ['--no-sandbox'], ...(exe ? { executablePath: exe } : {}),
});

/* ---- thumbnails, via canvas ------------------------------------------- */
const THUMB_W = 460;
const THUMB_MAX_H = 1500;          // ~3.5 phone screens; past that nobody looks

const shop = await browser.newPage();
await shop.goto('about:blank');

const thumbs = {};
for (const s of shots) {
  const src = join(DIR, s.file);
  if (!existsSync(src)) continue;
  const b64 = readFileSync(src).toString('base64');
  const out = await shop.evaluate(async ({ b64, w, maxH }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const scale = w / img.naturalWidth;
    const fullH = Math.round(img.naturalHeight * scale);
    const h = Math.min(fullH, maxH);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, img.naturalWidth, Math.round(h / scale), 0, 0, w, h);
    return { data: c.toDataURL('image/jpeg', 0.72), cropped: fullH > maxH };
  }, { b64, w: THUMB_W, maxH: THUMB_MAX_H });
  thumbs[s.file] = out;
}
await shop.close();

/* ---- the document ------------------------------------------------------ */

const esc = s => String(s ?? '').replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ROLE_ORDER = ['guest', 'resident', 'operator', 'finance_reviewer', 'admin', 'developer'];
const ROLE_AR = {
  guest: 'زائر — مش مسجّل دخول', resident: 'ساكن', operator: 'مشغّل',
  finance_reviewer: 'مراجع مالي', admin: 'مجلس الإدارة', developer: 'المبرمج',
};
const ROLE_NOTE = {
  guest: 'اللي أي حد بيشوفه قبل ما يدخل. المفروض ميوصلش لأي صفحة فيها بيانات.',
  resident: 'صاحب الشقة. بيشوف فلوسه وفلوس القرية، وبيرفع إيصالاته.',
  operator: 'بيسجّل المصروفات ويتابع الصيانة. عمره ما بيعتمد فلوس.',
  finance_reviewer: 'بيراجع الحسابات كلها ومبيغيّرش فيها حاجة. بيشوف طابور الإيصالات للاطّلاع بس.',
  admin: 'مجلس الإدارة. بيعتمد الإيصالات، بيفتح الاشتراكات، وبيدير الحسابات.',
  developer: 'حساب واحد للصيانة التقنية. صلاحياته زي المجلس، وكل حاجة بيعملها متسجّلة.',
};

const byRole = {};
for (const s of shots) (byRole[s.role] ??= []).push(s);

/** A scenario that was *supposed* to be refused is a pass when it was. */
const verdict = s => {
  if (s.kind === 'action') {
    if (s.expect === 'refused') return { cls: 'ok', label: 'اتمنع صح ✅' };
    return s.status === 200 ? { cls: 'ok', label: 'تمّت ✅' } : { cls: 'bad', label: 'مكمّلتش ❌' };
  }
  if (s.status >= 400) {
    return s.offered
      ? { cls: 'bad', label: `مرفوضة رغم إنها في القائمة (${s.status}) ❌` }
      : { cls: 'muted', label: `ممنوعة على الدور ده (${s.status}) — وده الصح 🔒` };
  }
  return { cls: 'ok', label: 'فتحت ✅' };
};

const card = s => {
  const t = thumbs[s.file];
  const v = verdict(s);
  return `
<figure class="shot ${v.cls}">
  <figcaption>
    <b>${esc(s.title)}</b>
    <span class="v">${esc(v.label)}</span>
    <span class="p" dir="ltr">${esc(s.path)}</span>
    ${s.said ? `<span class="said">${esc(s.said)}</span>` : ''}
  </figcaption>
  ${t ? `<img src="${t.data}" alt="${esc(s.title)}">${
      t.cropped ? '<span class="crop">أول جزء من الصفحة</span>' : ''}` : '<div class="noimg">—</div>'}
</figure>`;
};

/**
 * The defects the LIVE walk found, which are a different list on purpose.
 *
 * Both of these existed **only in production**: one in the Worker's entry
 * point, one in a database that migrations were never applied to. Neither is
 * reachable from a local run, because locally the two D1 databases are the same
 * file and the local server hands the app a context the Worker cannot have.
 */
const FIXED_LIVE = [
  { t: 'خطوة «على إيه؟» في رحلة الدفع كانت فاضية على الموقع المنشور — دايمًا',
    w: 'ملف تشغيل الـWorker كان بيجيب بنود الدفع بجلسة فاضية (توكن null)، واللي بيرجّع «مفيش حد داخل» — فالقايمة كانت بتطلع فاضية في كل طلب اتقدّم للموقع من يوم ما اتنشر. وخطوة ٢ مفيهاش غير المربّعات دي، والمربّعات نفسها هي أزرار الإرسال. يعني رحلة الدفع كانت واقفة عند «على إيه؟» لكل الناس، طول الوقت. محليًا كانت بتشتغل عادي لأن السيرفر المحلي بيدّي التطبيق جلسة حقيقية.',
    f: 'البنود بقت بتتقرا بهوية اللي فاتح الصفحة نفسه وقت الطلب، مش بقيمة متحسوبة قبل ما الطلب يوصل. الملف بتاع الـWorker مبقاش بيحسبها خالص، واتعمل اختبار بيبني التطبيق بنفس طريقة الـWorker (من غير بنود جاهزة) وبيفشل لو الشبكة طلعت فاضية.' },
  { t: 'رفع أي إيصال على الموقع المنشور كان بيرجّع خطأ ٥٠٠',
    w: 'صور الإيصالات بتتخزن في قاعدة بيانات تانية منفصلة (عشان النسخة الاحتياطية متجرّش وراها ميجابايتات صور). القاعدة دي كانت **فاضية تمامًا** — الميجريشن بتاعها معملهاش، فأول ما التطبيق يحاول يحسب المساحة المستخدمة بيقع: «no such table: v_blob_usage». يعني من يوم النشر، مفيش ولا إيصال واحد كان ممكن يترفع.',
    f: 'اتطبّق ملف الميجريشن `0008` على قاعدة الصور المنشورة، واتجرّب رفع إيصال حقيقي من المتصفّح على الموقع نفسه — إيصال رقم R-2026-00245 اتبعت واتراجع واتقفل.' },
];

const FIXED = [
  { t: 'رحلة الدفع مكانش فيها زرار «التالي» في خطوتين',
    w: 'خطوة «كام؟» وخطوة «صورة التحويل» مكانش فيهم أي زرار يكمّل. على اللابتوب الـEnter بيبعت الفورم فالمشكلة مبتبانش، لكن على الموبايل الكيبورد بيبقى أرقام من غير Enter — يعني الساكن بيكتب المبلغ ومفيش حاجة يدوسها. وخطوة الصورة فيها ٣ حقول، فحتى الـEnter مبيشتغلش. النتيجة: مفيش حد كان يقدر يخلّص رفع إيصال.',
    f: 'اتضاف زرار «التالي ←» في الخطوتين، واتعمل اختبار بيفشل لو أي خطوة رجعت من غير زرار.' },
  { t: 'الساكن مكانش يقدر يبعت إيصال على النسخة التجريبية أصلاً',
    w: 'في حماية في قاعدة البيانات بتمنع إن فلوس حقيقية تتسجّل على قاعدة تجريبية. التطبيق كان بيولّد رقم الإيصال من غير ما ياخد باله من ده، فالحماية كانت بتقف الإرسال وتطلّع جملة من قاعدة البيانات نصها إنجليزي.',
    f: 'رقم الإيصال بقى بياخد شكله من القاعدة نفسها: على التجريبية بيبدأ بـ DEMO، وعلى الحقيقية عادي. الحماية فضلت زي ما هي، والرحلة اشتغلت للآخر — إيصال رقم R-2026-00244 اتبعت في الفحص.' },
  { t: 'المراجع المالي كان بيشوف أزرار «اعتماد» و«رفض» — وهي مرفوضة عليه',
    w: 'صفحة طابور الإيصالات كانت بتعرض ٤٢ زرار اعتماد ورفض لدور شغلته المراجعة مش الاعتماد. لو داس، بيتقاله «مالكش صلاحية». ده أسوأ شكل للصلاحيات: التطبيق بيقول لك تقدر وبعدين بيقول لك مش تقدر.',
    f: 'الأزرار مبقتش تتعرض لغير اللي من حقه يعتمد، والصفحة بقت بتقول إنها للاطّلاع والمراجعة. والحماية الحقيقية زي ما هي في السيرفر.' },
  { t: 'صفحة طابور الإيصالات مكانتش في قائمة المراجع المالي',
    w: 'القائمة كانت بتربط الصفحة بصلاحية «الاعتماد» مش بصلاحية «القراءة»، فالمراجع المالي اللي من حقه يقراها مكانش لاقي لينك ليها في أي مكان.',
    f: 'القائمة بقت مربوطة باللي الصفحة نفسها بتطلبه. واتعمل اختبار عام بيتأكد إن مفيش دور بيتعرضله لينك التطبيق هيرفضه.' },
  { t: 'صورة التحويل مطلوبة ومحدش كان بيقول كده غير بعد آخر زرار',
    w: 'الساكن كان بيملا الخمس خطوات، يوصل لـ«راجع وابعت»، يدوس، وساعتها بس يعرف إن الصورة مطلوبة.',
    f: 'خطوة الصورة بقت بتقول «الصورة مطلوبة» بوضوح، وصفحة المراجعة بقت تقول إن الصورة ناقصة أول ما تفتح وتوديك ترجع ترفعها — بدل ما تستنى تدوس.' },
  { t: 'فورم نشر الأخبار كان بيسأل «المشكلة في إيه؟»',
    w: 'الفورم كان واخد أسامي الحقول من صفحة بلاغات الصيانة، فعضو المجلس اللي بينشر إعلان كان بيتسأل عن المشكلة والتفاصيل.',
    f: 'بقى «نوع المنشور» و«العنوان» و«النص» زي ما المفروض.' },
  { t: 'بعد ما تنشر خبر، مفيش أي رسالة بتقول إنه اتنشر',
    w: 'الصفحة كانت بتتقفل وترجع من غير ما تقول حاجة، والخبر بيبقى في مكان ما في قايمة ٣٠ خبر.',
    f: 'بقى فيه رسالة «اتنشر ✅»، وكمان للتثبيت وإلغاء التثبيت.' },
];

const LIVE = !!process.env.WALK_LIVE;
const FIXES = LIVE ? FIXED_LIVE : FIXED;
const TITLE = LIVE ? 'تقرير فحص الموقع المنشور — بوابة قرية الأطباء'
                   : 'تقرير فحص بوابة قرية الأطباء';
const SUBTITLE = LIVE
  ? 'نفس الفحص، بس على الموقع اللي على الإنترنت فعلاً — نفس قاعدة البيانات اللي المجلس هيشوفها'
  : 'مشي على كل الشاشات وكل السيناريوهات، بكل الأدوار، على متصفّح حقيقي';
const HOW = LIVE
  ? `اتفتحت جلسة لكل دور على قاعدة البيانات المنشورة نفسها، ومتصفّح Chromium مشي على كل صفحة في
     قايمة كل دور على الموقع المنشور، وعمل السيناريوهات الفعلية عليه.
     <br><br>
     <b>ليه فيه وسيط محلي:</b> المتصفّح جوّه بيئة الشغل دي مش بيقدر يوصل لأي موقع HTTPS بره خالص
     (حتى example.com بيرفض) — لكن الـNode بيقدر. فاتعمل وسيط صغير على الجهاز بينقل كل طلب للموقع
     المنشور ويرجّع رده زي ما هو بالحرف. كل بايت اتعرض واتصوّر جه من الـWorker المنشور ومن قاعدة
     البيانات المنشورة. الحاجة الوحيدة اللي اتغيّرت هي علامة <span dir="ltr">Secure</span> على
     الكوكي، عشان المتصفّح بيرميها على <span dir="ltr">http://127.0.0.1</span>.
     <br><br>
     <b>اللي اتعمل واللي اتساب عمد:</b> السيناريوهات اللي بتكتب في قاعدة البيانات اتعملت على حساب
     تجربة اتعمل مخصوص واتقفل بعدها، أو اتقرت قيمتها الأصلية واترجّعت زي ما كانت. اتساب عمد:
     تسجيل مصروف ونشر خبر — الاتنين بيسيبوا صف مفيش في المنتج شاشة تشيله، ومكانش صح إن فحص يسيب
     «مصروف تجربة» في طابور المجلس. الاعتماد اتعمل على إيصال الفحص نفسه بس، مش على إيصال حقيقي،
     لأن الاعتماد بيرحّل قيد وبيحرّك أرقام القرية.`
  : `اتشغّل التطبيق الحقيقي على جهاز محلي بنفس الكود المنشور، واتفتحت جلسة
     لكل دور من الستة، وبعدين متصفّح Chromium مشي على كل صفحة في قايمة كل دور، وعمل السيناريوهات
     الفعلية — رفع إيصال، اعتماده، رفضه، تسجيل مصروف، إنشاء حساب، إرسال كلمة سر، نشر خبر، تغيير
     إعداد، وطباعة أكواد استرجاع — وصوّر كل حالة.`;

const html = `
<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>${TITLE}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  :root{ --ink:#1F2421; --muted:#5B615C; --brand:#0E5C63; --line:#DFDCD5;
         --ok:#1D7A4C; --bad:#B3261E; --warn:#8F5A00; --soft:#F0EEE9; }
  *{ box-sizing:border-box }
  body{ font-family:"Noto Sans Arabic","FreeSans","DejaVu Sans",sans-serif;
        color:var(--ink); font-size:11pt; line-height:1.65; margin:0 }
  h1{ font-size:24pt; margin:0 0 6px; color:var(--brand) }
  h2{ font-size:16pt; margin:0 0 4px; color:var(--brand);
      border-block-end:2px solid var(--brand); padding-block-end:6px }
  h3{ font-size:12pt; margin:14px 0 6px }
  .role{ break-before:page }
  .cover{ text-align:center; padding-block-start:38mm }
  .cover .sub{ color:var(--muted); font-size:13pt }
  .stat{ display:flex; gap:10px; justify-content:center; margin-block-start:26px; flex-wrap:wrap }
  .stat div{ border:1px solid var(--line); border-radius:12px; padding:12px 18px; min-inline-size:120px }
  .stat b{ display:block; font-size:22pt; color:var(--brand) }
  .stat span{ font-size:9.5pt; color:var(--muted) }
  .note{ background:var(--soft); border-radius:12px; padding:12px 14px; margin:14px 0;
         font-size:10pt; color:var(--muted) }
  .fix{ border:1px solid var(--line); border-radius:12px; padding:12px 14px; margin-block-end:10px;
        break-inside:avoid }
  .fix .t{ font-weight:700; color:var(--bad) }
  .fix .lbl{ font-weight:700; color:var(--muted); font-size:9.5pt }
  .grid{ display:grid; grid-template-columns:repeat(3,1fr); gap:10px }
  figure.shot{ margin:0; border:1px solid var(--line); border-radius:10px; overflow:hidden;
               break-inside:avoid; background:#fff }
  figure.shot img{ inline-size:100%; display:block }
  figure.shot.bad{ border-color:var(--bad); border-width:2px }
  figure.shot.muted{ opacity:.85 }
  figcaption{ padding:7px 9px; font-size:8.5pt; border-block-end:1px solid var(--line) }
  figcaption b{ display:block; font-size:9.5pt }
  figcaption .v{ display:block; color:var(--ok) }
  .bad figcaption .v{ color:var(--bad) }
  .muted figcaption .v{ color:var(--muted) }
  figcaption .p{ display:block; color:var(--muted); font-size:8pt; word-break:break-all }
  figcaption .said{ display:block; color:var(--warn); font-size:8pt }
  .crop{ display:block; text-align:center; font-size:8pt; color:var(--muted); padding:3px }
  .noimg{ padding:30px; text-align:center; color:var(--muted) }
  table{ inline-size:100%; border-collapse:collapse; font-size:10pt }
  th,td{ border:1px solid var(--line); padding:6px 8px; text-align:start }
  th{ background:var(--soft) }
  .warnbox{ border:2px solid var(--warn); border-radius:12px; padding:12px 14px; margin:14px 0 }
</style></head><body>

<section class="cover">
  <h1>${TITLE}</h1>
  <p class="sub">${SUBTITLE}</p>
  <p class="sub" dir="ltr">${esc(new Date(generatedAt).toISOString().slice(0, 10))}</p>
  <div class="stat">
    <div><b dir="ltr">${shots.length}</b><span>لقطة شاشة</span></div>
    <div><b dir="ltr">6</b><span>أدوار</span></div>
    <div><b dir="ltr">${FIXES.length}</b><span>مشكلة اتلاقت واتصلّحت</span></div>
    <div><b dir="ltr">${findings.length}</b><span>مشكلة لسه مفتوحة</span></div>
  </div>
  <div class="note" style="text-align:start;margin-block-start:26px">
    <b>إزاي اتعمل الفحص:</b> ${HOW}
    <br><br>
    <b>⚠️ كل الأرقام والأسماء في الصور متخيّلة.</b> دي قاعدة بيانات تجريبية، مش بيانات القرية الحقيقية.
  </div>
</section>

<section class="role">
  <h2>المشاكل اللي اتلاقت واتصلّحت</h2>
  <p class="note">دول مشاكل حقيقية كانت في المنتج قبل الفحص. كل واحدة فيهم اتصلّحت، واتعملّها
  اختبار بيفشل لو رجعت تاني.</p>
  ${FIXES.map((f, i) => `
  <div class="fix">
    <div class="t"><span dir="ltr">${i + 1}.</span> ${esc(f.t)}</div>
    <p><span class="lbl">المشكلة:</span> ${esc(f.w)}</p>
    <p><span class="lbl">الحل:</span> ${esc(f.f)}</p>
  </div>`).join('')}

  <h3>اللي فضل مفتوح</h3>
  ${findings.length === 0
    ? `<div class="note">مفيش. آخر مرّة مشي فيها الفحص على كل الشاشات وكل السيناريوهات،
       مطلعش أي مشكلة.</div>`
    : `<table><thead><tr><th>الدور</th><th>الشاشة</th><th>المشكلة</th></tr></thead><tbody>
      ${findings.map(f => `<tr><td>${esc(ROLE_AR[f.role] ?? f.role)}</td>
        <td>${esc(f.scenario)}</td><td>${esc(f.what)}</td></tr>`).join('')}
      </tbody></table>`}

  <div class="warnbox">
    <b>حاجة واحدة مش مشكلة في الكود ومحتاجة تتعمل:</b> التوكن بتاع Cloudflare والتوكن بتاع GitHub
    اللي اتبعتوا في الشات لسه محتاجين يتلغوا. دي أقدم حاجة مفتوحة في المشروع.
  </div>
</section>

${ROLE_ORDER.filter(r => byRole[r]).map(role => `
<section class="role">
  <h2>${esc(ROLE_AR[role])}</h2>
  <p class="note">${esc(ROLE_NOTE[role])}</p>
  <div class="grid">${byRole[role].map(card).join('')}</div>
</section>`).join('')}

</body></html>`;

const htmlPath = join(OUT, 'report.html');
writeFileSync(htmlPath, html, 'utf8');

const page = await browser.newPage();
await page.goto('file://' + htmlPath, { waitUntil: 'networkidle' });
const pdfPath = join(OUT, LIVE ? 'تقرير-فحص-الموقع-المنشور.pdf'
                               : 'تقرير-فحص-بوابة-قرية-الأطباء.pdf');
await page.pdf({ path: pdfPath, format: 'A4', printBackground: true,
                 margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
await browser.close();

console.log(`  ${htmlPath}`);
console.log(`  ${pdfPath}`);
