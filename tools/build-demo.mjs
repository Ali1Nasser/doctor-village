/**
 * tools/build-demo.mjs — one self-contained HTML file the board can click through.
 *
 * ## What this is, and what it deliberately is not
 *
 * Every screen inside it is a **real response from `createApp()`**, captured by
 * `tests/fixtures/render_screens.ts` against the demo village — same routes,
 * same views, same `lib/db/` queries a resident would hit. It is not a mockup
 * redrawn to look like the product, which is the thing that can look right
 * while the product is wrong.
 *
 * What it is not: a running server. Forms do not submit, the ledger does not
 * move, and the approve button is inert. The demo exists so a board that has
 * never seen the portal can walk through it on a phone with no login, no
 * hosting and no network — and the banner says exactly that, because a demo
 * that lets people believe it is live produces decisions made on a
 * misunderstanding.
 *
 * ## Navigation actually works
 *
 * Links between captured screens are resolved against the route table below and
 * switch the frame. A link to a screen that was not captured says so in Arabic
 * rather than doing nothing — a dead tap reads as "the site is broken", which
 * is the opposite of what a demo is for.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PREVIEW = join(ROOT, 'preview');

/** name → [route it was captured from, Arabic label, group] */
const SCREENS = [
  ['login', '/login', 'تسجيل الدخول', 'الساكن'],
  ['home', '/', 'الرئيسية', 'الساكن'],
  ['pay1', '/pay/1', 'دفع — خطوة ١', 'الساكن'],
  ['pay2', '/pay/2', 'دفع — خطوة ٢', 'الساكن'],
  ['pay3', '/pay/3', 'دفع — خطوة ٣', 'الساكن'],
  ['payments', '/payments', 'إيصالاتي', 'الساكن'],
  ['statement', '/statement', 'كشف الحساب السنوي', 'الساكن'],
  ['inbox', '/notifications', 'رسايلي', 'الساكن'],
  ['finance', '/finance', 'فلوس القرية', 'الشفافية'],
  ['units', '/finance/units', 'حالة السداد لكل وحدة', 'الشفافية'],
  ['news', '/news', 'الأخبار والقرارات', 'الأرشيف'],
  ['post', '/news/post', 'خبر كامل', 'الأرشيف'],
  ['archive', '/news/archive', 'الأرشيف بالسنة', 'الأرشيف'],
  ['month', '/news/archive/2024/08', 'أرشيف شهر', 'الأرشيف'],
  ['search', '/search', 'البحث العربي', 'الأرشيف'],
  ['albums', '/albums', 'ألبومات الأعمال', 'الأرشيف'],
  ['album', '/albums/one', 'ألبوم', 'الأرشيف'],
  ['tickets', '/maintenance', 'بلاغات الصيانة', 'الأرشيف'],
  ['review', '/admin/review', 'مراجعة الإيصالات', 'الإدارة'],
  ['approved', '/admin/payments', 'الإيصالات المعتمدة', 'الإدارة'],
  ['expenses', '/admin/expenses', 'المصروفات', 'الإدارة'],
  ['publish', '/admin/content', 'نشر خبر أو قرار', 'الإدارة'],
  ['health', '/admin/health', 'صحة النظام والحصص', 'الإدارة'],
  ['notfound', '/nope', 'صفحة مش موجودة', 'الحالات'],
];

/**
 * Route → screen, for link interception. Several real routes map onto one
 * captured screen (every `/news/<slug>` shows the captured post), which is
 * honest for a demo and keeps taps alive.
 */
const ROUTE_PATTERNS = [
  ['^/$', 'home'],
  ['^/login', 'login'],
  ['^/pay/1', 'pay1'], ['^/pay/2', 'pay2'], ['^/pay/3', 'pay3'], ['^/pay', 'pay1'],
  ['^/payments/statement', 'statement'],
  ['^/units/[^/]+/statement', 'statement'],
  ['^/payments', 'payments'],
  ['^/notifications', 'inbox'],
  ['^/finance/units', 'units'], ['^/finance', 'finance'],
  ['^/news/archive/\\d{4}/\\d{2}', 'month'],
  ['^/news/archive', 'archive'],
  ['^/news/[^/]+', 'post'],
  ['^/news', 'news'],
  ['^/search', 'search'],
  ['^/albums/[^/]+', 'album'], ['^/albums', 'albums'],
  ['^/maintenance', 'tickets'],
  ['^/admin/review', 'review'],
  ['^/admin/payments', 'approved'],
  ['^/admin/expenses', 'expenses'],
  ['^/admin/content', 'publish'],
  ['^/admin/health', 'health'],
];

/**
 * Injected into each captured screen. It makes links switch frames instead of
 * navigating the iframe to a file that is not there, and neutralises forms with
 * an explanation rather than a silent no-op.
 */
const BRIDGE = `
<script>
(function(){
  function send(path){ parent.postMessage({qaNav:path}, '*'); }
  document.addEventListener('click', function(e){
    var a = e.target.closest && e.target.closest('a[href]');
    if(!a) return;
    var href = a.getAttribute('href') || '';
    if(href.charAt(0) === '#') return;
    e.preventDefault();
    send(href);
  }, true);
  document.addEventListener('submit', function(e){
    e.preventDefault();
    parent.postMessage({qaForm:true}, '*');
  }, true);
})();
</script>`;
// NOTE: a literal `</script>` above, not `<\/script>`. This is a plain JS
// template literal in a .mjs file — no HTML parser sees it here. The escaping
// that matters happens once, when the screens are JSON-stringified into the
// page's data block, where every `</` becomes `<\/`. Escaping it twice produced
// a script tag that never closed, so link interception silently did not run and
// every in-frame link navigated the iframe to a file that does not exist.

function loadScreens() {
  const out = [];
  for (const [name, route, label, group] of SCREENS) {
    const p = join(PREVIEW, `${name}.html`);
    if (!existsSync(p)) { console.warn(`  ⚠ missing preview/${name}.html — skipped`); continue; }
    let html = readFileSync(p, 'utf8');
    html = html.replace('</body>', `${BRIDGE}</body>`);
    out.push({ name, route, label, group, html });
  }
  return out;
}

const screens = loadScreens();
const groups = [...new Set(screens.map(s => s.group))];

// JSON inside a <script> needs `</` neutralised or the parser ends the block on
// any markup in the captured HTML. This is the whole escaping surface.
const payload = JSON.stringify(
  Object.fromEntries(screens.map(s => [s.name, s.html]))
).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');

const nav = groups.map(g => `
  <div class="grp">${g}</div>
  ${screens.filter(s => s.group === g).map(s =>
    `<button class="nv" data-s="${s.name}">${s.label}</button>`).join('')}`).join('');

const page = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>بوابة قرية الأطباء — نسخة تجريبية</title>
<style>
:root{--bg:#eceae5;--panel:#fff;--ink:#1F2421;--muted:#5B615C;--brand:#0E5C63;
  --border:#d8d4cc;--warn-bg:#FBEFD9;--warn:#8a5600}
@media (prefers-color-scheme:dark){
  :root{--bg:#101315;--panel:#1a1f22;--ink:#E8EAE7;--muted:#9aa39e;--brand:#5FB8C0;
    --border:#2c3338;--warn-bg:#33260C;--warn:#E0A845}
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.7 "IBM Plex Sans Arabic","Noto Sans Arabic","Segoe UI",Tahoma,sans-serif}
.bar{background:var(--warn-bg);color:var(--warn);padding:10px 16px;text-align:center;
  font-size:.85rem;font-weight:700;border-block-end:1px solid var(--border)}
header{background:var(--brand);color:#fff;padding:16px;display:flex;gap:12px;
  align-items:center;flex-wrap:wrap}
header h1{margin:0;font-size:1.05rem}
header p{margin:0;opacity:.85;font-size:.8rem;inline-size:100%}
.modes{margin-inline-start:auto;display:flex;gap:6px}
.modes button{min-block-size:40px;padding:0 14px;border:0;border-radius:10px;cursor:pointer;
  background:rgba(255,255,255,.18);color:#fff;font:inherit;font-size:.85rem;font-weight:700}
.modes button[aria-pressed="true"]{background:#fff;color:var(--brand)}
.wrap{display:grid;grid-template-columns:250px 1fr;gap:18px;padding:18px;align-items:start}
.side{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:10px;
  position:sticky;inset-block-start:12px;max-block-size:calc(100vh - 24px);overflow:auto}
/* On a phone the screen list must not push the device below the fold — the
   board will open this on a phone, and a first screen full of navigation reads
   as "this is a menu", not "this is the portal". So the device comes first and
   the list becomes a horizontal rail under it.

   Deliberately NOT a <details> disclosure: a closed <details> hides its
   children through UA behaviour that a display:block on the child does not
   reliably override, so the desktop sidebar came back empty. A plain rail has
   no such quirk. */
@media (max-width:820px){
  .wrap{display:flex;flex-direction:column;padding:12px;gap:10px}
  .stage{order:-1}
  .side{position:static;max-block-size:none;padding:8px;display:flex;gap:8px;
    overflow-x:auto;scrollbar-width:none;align-items:center}
  .side::-webkit-scrollbar{display:none}
  .grp{margin:0 4px;flex:none;font-size:.68rem;opacity:.75}
  .nv{inline-size:auto;flex:none;white-space:nowrap;border-radius:999px;
    background:var(--bg);padding:8px 14px;min-block-size:40px}
}
.grp{font-size:.72rem;color:var(--muted);font-weight:700;margin:12px 8px 4px}
.nv{display:block;inline-size:100%;text-align:start;min-block-size:42px;padding:8px 12px;
  border:0;border-radius:9px;background:transparent;color:var(--ink);font:inherit;
  font-size:.9rem;cursor:pointer}
.nv:hover{background:var(--bg)}
.nv[aria-current="true"]{background:var(--brand);color:#fff;font-weight:700}
.stage{display:flex;justify-content:center;padding-block-end:24px}
.device{background:var(--panel);border:1px solid var(--border);border-radius:26px;padding:10px;
  box-shadow:0 10px 34px rgba(0,0,0,.13);transition:inline-size .18s}
.device iframe{display:block;border:0;border-radius:18px;background:#fff;
  inline-size:100%;block-size:74vh;min-block-size:520px}
.device.phone{inline-size:min(420px,100%)}
.device.desk{inline-size:min(1180px,100%)}
.hint{text-align:center;color:var(--muted);font-size:.82rem;padding:0 18px 24px}
.toast{position:fixed;inset-block-end:18px;inset-inline:18px;margin:auto;max-inline-size:520px;
  background:#17211f;color:#fff;padding:12px 16px;border-radius:12px;text-align:center;
  font-size:.88rem;opacity:0;transition:opacity .2s;pointer-events:none;z-index:50}
.toast.on{opacity:1}
</style>
</head>
<body>
<div class="bar">⚠️ نسخة تجريبية — كل الأسماء والأرقام والمبالغ متخيّلة بالكامل. مفيش أي بيانات حقيقية هنا.</div>
<header>
  <div>
    <h1>بوابة قرية الأطباء</h1>
  </div>
  <div class="modes">
    <button id="m-phone" aria-pressed="true">📱 موبايل</button>
    <button id="m-desk" aria-pressed="false">💻 كمبيوتر</button>
  </div>
  <p>عجيبة — مرسى مطروح · الشاشات دي مخرجات التطبيق الحقيقي، مش رسم منفصل</p>
</header>

<div class="wrap">
  <nav class="side" aria-label="الشاشات">${nav}</nav>
  <div>
    <div class="stage"><div class="device phone" id="dev">
      <iframe id="fr" title="شاشة البوابة"></iframe>
    </div></div>
    <p class="hint">اضغط على أي لينك جوه الشاشة والتنقّل هيشتغل. الفورمات متوقفة —
      دي معاينة، مش سيرفر شغّال.</p>
  </div>
</div>
<div class="toast" id="toast"></div>

<script id="data" type="application/json">${payload}</script>
<script>
const SCREENS = JSON.parse(document.getElementById('data').textContent);
const ROUTES = ${JSON.stringify(ROUTE_PATTERNS)}.map(([re, s]) => [new RegExp(re), s]);
const fr = document.getElementById('fr');
const dev = document.getElementById('dev');
const toastEl = document.getElementById('toast');
let toastTimer;

function toast(msg){
  toastEl.textContent = msg; toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 2600);
}

function show(name){
  if(!SCREENS[name]) return;
  fr.srcdoc = SCREENS[name];
  for(const b of document.querySelectorAll('.nv'))
    b.setAttribute('aria-current', String(b.dataset.s === name));
  location.hash = name;
}

function resolve(path){
  const clean = String(path).split('?')[0].split('#')[0];
  for(const [re, s] of ROUTES) if(re.test(clean)) return s;
  return null;
}

for(const b of document.querySelectorAll('.nv'))
  b.addEventListener('click', () => show(b.dataset.s));

addEventListener('message', e => {
  const d = e.data || {};
  if(d.qaForm){ toast('دي معاينة — الفورمات مش بتتبعت. في النسخة الشغّالة الزرار ده بيبعت فعلاً.'); return; }
  if(typeof d.qaNav === 'string'){
    const s = resolve(d.qaNav);
    if(s) show(s);
    else toast('الشاشة دي مش متصوّرة في المعاينة: ' + d.qaNav);
  }
});

document.getElementById('m-phone').addEventListener('click', () => {
  dev.className = 'device phone';
  document.getElementById('m-phone').setAttribute('aria-pressed','true');
  document.getElementById('m-desk').setAttribute('aria-pressed','false');
});
document.getElementById('m-desk').addEventListener('click', () => {
  dev.className = 'device desk';
  document.getElementById('m-desk').setAttribute('aria-pressed','true');
  document.getElementById('m-phone').setAttribute('aria-pressed','false');
});

show(location.hash.slice(1) in SCREENS ? location.hash.slice(1) : 'home');
</script>
</body>
</html>`;

const out = process.argv[2] ?? join(ROOT, 'preview', 'demo.html');
writeFileSync(out, page, 'utf8');
const kb = (Buffer.byteLength(page, 'utf8') / 1024).toFixed(0);
console.log(`✓ demo written: ${out}`);
console.log(`  ${screens.length} screens · ${kb} KB · self-contained, no network`);
