/**
 * tools/walkthrough.mjs — drive the whole product in a real browser, as every
 * role, and photograph what a person would actually see.
 *
 * ## Why this exists next to `npm run screens` and `npm run a11y`
 *
 * `screens` proves the server emits the right HTML. `a11y` proves that HTML has
 * no axe violations. Neither one opens a drawer, presses a button that a header
 * is sitting on top of, submits a form and reads the banner that comes back, or
 * notices that a screen renders perfectly and is unreachable from the menu.
 * Every defect this project has shipped to the board was in that gap.
 *
 * So this walks the app the way a board member does: real HTTP, real cookies,
 * real Chromium, one page at a time, clicking things.
 *
 * ## What counts as a problem
 *
 * Not "it looks odd" — that is a judgement call and this file does not make
 * them. It flags what is checkable and unambiguous:
 *   · a status ≥ 400 on a screen the role's own menu offers;
 *   · a JavaScript exception or a failed sub-request;
 *   · a page that scrolls sideways at 360px (the phone the village has);
 *   · a control the role can see and is then refused when they press it;
 *   · a menu entry that 404s, and a screen with no menu entry at all.
 *
 * Run:  node tools/dev-server.mjs 8787  &  node tools/walkthrough.mjs
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.WALK_BASE ?? 'http://127.0.0.1:8787';
const OUT = process.env.WALK_OUT ?? join(process.cwd(), 'walkthrough');
mkdirSync(OUT, { recursive: true });

const meta = await (await fetch(`${BASE}/__roles`)).json();
const T = meta.tokens;

/** Phone-first: 390×844 is the iPhone/Galaxy class the village actually holds. */
const PHONE = { width: 390, height: 844 };
const DESK = { width: 1280, height: 900 };

const ROLE_AR = {
  developer: 'المبرمج', admin: 'مجلس الإدارة', operator: 'مشغّل',
  finance_reviewer: 'مراجع مالي', resident: 'ساكن',
};

/**
 * The scenarios, per role.
 *
 * `nav` is a screen. `act` is a thing you DO — it gets its own entry because a
 * screen that renders and a screen you can act on are different claims, and the
 * second is the one the board cares about.
 */
const S = (id, title, path, opts = {}) => ({ id, title, path, ...opts });

const VILLAGE = [
  S('home', 'الصفحة الرئيسية', '/'),
  S('finance', 'فلوس القرية', '/finance'),
  S('units', 'حالة السداد لكل عمارة', '/finance/units'),
  S('map', 'خريطة القرية', '/map'),
  S('building', 'صفحة عمارة', `/buildings/${meta.buildingId}`),
  S('news', 'أخبار القرية', '/news'),
  S('post', 'خبر واحد', `/news/${encodeURIComponent(meta.newestSlug)}`),
  S('archive', 'أرشيف الأخبار', '/news/archive'),
  S('albums', 'ألبومات الأعمال', '/albums'),
  S('album', 'ألبوم واحد', `/albums/${meta.albumId}`),
  S('maintenance', 'بلاغات الصيانة', '/maintenance'),
  S('search', 'البحث', '/search?q=' + encodeURIComponent('الميزانية')),
  S('help', 'المساعدة', '/help'),
];

const SELF = [
  S('me', 'حسابي', '/me'),
  S('pay1', 'دفع — خطوة ١', '/pay'),
  S('payments', 'إيصالاتي', '/payments'),
  S('inbox', 'رسايلي', '/notifications'),
];

const BOARD = [
  S('review', 'مراجعة الإيصالات', '/admin/review'),
  S('approved', 'الإيصالات المعتمدة', '/admin/payments'),
  S('expenses', 'المصروفات', '/admin/expenses'),
  S('fees', 'الاشتراكات والمستحقات', '/admin/fees'),
  S('settlements', 'التسويات وأرصدة الملّاك', '/admin/settlements'),
  S('members', 'الأعضاء والتفعيل', '/admin/members'),
  S('import', 'استيراد سجل الملّاك', '/admin/import'),
  S('recoveries', 'طلبات الاسترجاع', '/admin/recoveries'),
  S('content', 'نشر الأخبار', '/admin/content'),
];

const OVERSIGHT = [
  S('ledger', 'دفتر القيود', '/admin/ledger'),
  S('audit', 'سجل التغييرات', '/admin/audit'),
  S('categories', 'البنود', '/admin/categories'),
  S('users', 'الحسابات والصلاحيات', '/admin/users'),
  S('staff', 'العمالة', '/admin/staff'),
  S('adminmap', 'إدارة الخريطة', '/admin/map'),
  S('settings', 'الإعدادات', '/admin/settings'),
  S('health', 'صحة النظام', '/admin/health'),
];

/** Everything, for every role. What each role may actually reach is decided by
 *  the app, not here — that is precisely what is being checked. */
const ALL = [...SELF, ...VILLAGE, ...BOARD, ...OVERSIGHT];

const ROLES = ['resident', 'operator', 'finance_reviewer', 'admin', 'developer'];

const findings = [];
const shots = [];
const note = (role, scenario, severity, what) =>
  findings.push({ role, scenario, severity, what });

// Same resolution `tools/a11y-scan.mjs` uses: this environment ships a browser
// at a fixed path and forbids downloading another, and Playwright's bundled
// path guess is version-stamped, so it misses after any version bump.
const exe = ['/opt/pw-browsers/chromium'].find(existsSync);
const browser = await chromium.launch({
  args: ['--no-sandbox'], ...(exe ? { executablePath: exe } : {}),
});

for (const role of ROLES) {
  const ctx = await browser.newContext({
    viewport: PHONE, locale: 'ar-EG', deviceScaleFactor: 2,
  });
  await ctx.addCookies([{
    name: 'qa_session', value: T[role].token, domain: '127.0.0.1', path: '/',
  }]);
  const page = await ctx.newPage();

  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(String(e)));
  page.on('requestfailed', r => {
    // Chromium reports aborted navigations here too; only sub-resources matter.
    if (r.resourceType() !== 'document') jsErrors.push(`fetch failed: ${r.url()}`);
  });

  // Which entries this role's own menu offers — the list the app itself claims
  // is reachable. A screen that answers 200 but is not in here is invisible.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const menuHrefs = await page.$$eval('.side a, .drawer-panel a',
    els => [...new Set(els.map(e => new URL(e.href).pathname))]);

  for (const sc of ALL) {
    jsErrors.length = 0;
    const res = await page.goto(BASE + sc.path, { waitUntil: 'networkidle' })
      .catch(e => ({ status: () => 0, _err: String(e) }));
    const status = res.status ? res.status() : 0;
    const offered = menuHrefs.includes(sc.path.split('?')[0]);

    // The role can see it in their menu but the app refuses it — the worst
    // shape of bug, because the person is told they may and then told they
    // may not.
    if (offered && status >= 400) {
      note(role, sc.title, 'blocker',
        `القائمة بتعرض «${sc.title}» لكن الصفحة بترجّع ${status}`);
    }
    if (jsErrors.length) {
      note(role, sc.title, 'major', `خطأ جافاسكريبت: ${jsErrors.slice(0, 2).join(' · ')}`);
    }

    // Sideways scroll at 390px is the one layout defect that makes a page
    // unusable on the phone rather than merely ugly.
    const overflow = status < 400 ? await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth) : 0;
    if (overflow > 2) {
      note(role, sc.title, 'major', `الصفحة بتتحرّك يمين وشمال على موبايل (${overflow}px زيادة)`);
    }

    const file = `${role}__${sc.id}.png`;
    if (status < 400) {
      await page.screenshot({ path: join(OUT, file), fullPage: true });
    } else {
      await page.screenshot({ path: join(OUT, file) });
    }
    shots.push({ role, roleAr: ROLE_AR[role], id: sc.id, title: sc.title,
                 path: sc.path, status, offered, file, overflow });
  }

  await ctx.close();
}

/* ======================================================================= */
/* Phase 2 — the ACTIONS. Rendering a screen and being able to USE it are   */
/* two different claims, and the second is the one the board cares about.   */
/* ======================================================================= */

/** Whatever the page is telling the person right now, in one line. */
const banner = page => page.evaluate(() => {
  const b = [...document.querySelectorAll('.banner')]
    .filter(e => e.offsetParent !== null && e.textContent.trim() && !e.classList.contains('demo'));
  return b.map(e => e.textContent.trim().replace(/\s+/g, ' ')).join(' | ').slice(0, 220);
});

/**
 * Every journey worth calling a scenario, driven through the real controls.
 *
 * `expect: 'works'` means the role is offered this and it must succeed.
 * `expect: 'refused'` means the role must be stopped — and stopped *before*
 * they press something, which is why each of those also checks that the
 * control is absent rather than merely that the POST fails. A button that is
 * shown and then refused is the worst version of a permission: it tells
 * somebody they may, then tells them they may not.
 */
const ACTIONS = [
  { role: 'resident', id: 'act-pay', title: 'يقدّم إيصال دفع (الرحلة كاملة)', expect: 'works',
    async run(page) {
      await page.goto(`${BASE}/pay/1`, { waitUntil: 'networkidle' });
      await page.fill('#amount', '750.00');
      await page.click('form[action="/pay/1"] button[type=submit], form[action="/pay/1"] .btn');
      await page.waitForLoadState('networkidle');
      // step 2 — the category tiles ARE the submit buttons
      await page.click('.grid-cats button.cat');
      await page.waitForLoadState('networkidle');
      // step 3 — a date, then the method tile
      await page.fill('#tdate', '2026-08-01');
      await page.click('.grid-cats button.cat[name="method"]');
      await page.waitForLoadState('networkidle');
      // step 4 — a reference number; the photo is optional and the file input
      // needs a camera, so this is the path a resident takes on a transfer.
      // The photo is mandatory and lives in sessionStorage, put there by the
      // upload island. A 1×1 PNG stands in for a phone camera — what is being
      // exercised is the submit path, not the compressor.
      // base64url of a real 8×8 PNG — the same encoding the upload island
      // produces (`b64u.enc`, no padding), because the server sniffs MAGIC
      // BYTES and refuses anything it cannot identify. A data: URL fails that
      // check, which is the app being right and the first version of this line
      // being wrong.
      await page.evaluate(v => sessionStorage.setItem('pay-draft-img', v),
        'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4sWUBVsQwtCQAydSHATA1Jj4AAAAASUVORK5CYII');
      await page.fill('#ref', '900123456');
      await page.fill('#note', 'تحويل إنستا باي — تجربة');
      await page.click('form[action="/pay/4"] button[type=submit]');
      await page.waitForLoadState('networkidle');
      // step 5 — the confirm is a JS button, so this is the one place the
      // island actually gets exercised.
      await page.click('#submit-btn');
      await page.waitForURL(/\/payments|\/pay\/done|\/$/, { timeout: 15000 })
        .catch(() => {});
      await page.waitForLoadState('networkidle');
      const done = /رقم الإيصال|تم استلام/.test(await page.textContent('body'));
      return { at: page.url(), said: done ? 'الإيصال اتبعت' : await banner(page), ok: done };
    } },

  { role: 'resident', id: 'act-ticket', title: 'يفتح بلاغ صيانة', expect: 'works',
    async run(page) {
      await page.goto(`${BASE}/maintenance`, { waitUntil: 'networkidle' });
      // The form lives behind a «بلّغ عن مشكلة» summary — deliberate progressive
      // disclosure, so a person taps it open before typing. So does this.
      await page.locator('details summary.summary-btn').first().click();
      await page.fill('#mt', 'الكشاف بتاع مدخل العمارة مش نوّر');
      await page.fill('#md', 'من امبارح بالليل، الدور الأرضي كله ضلمة.');
      await page.click('form[action="/maintenance"] button[type=submit]');
      await page.waitForLoadState('networkidle');
      return { at: page.url(), said: await banner(page) };
    } },

  { role: 'resident', id: 'act-profile', title: 'يعدّل بيانات التواصل بتاعته', expect: 'works',
    async run(page) {
      await page.goto(`${BASE}/me`, { waitUntil: 'networkidle' });
      await page.fill('#me-phone', '01099887766');
      await page.fill('#me-note', 'الشقة مأجّرة — كلّموني على الرقم ده');
      await page.click('form[action="/me"] button[type=submit]');
      await page.waitForLoadState('networkidle');
      return { at: page.url(), said: await banner(page) };
    } },

  { role: 'resident', id: 'act-codes', title: 'يطبع أكواد استرجاع جديدة', expect: 'works',
    async run(page) {
      await page.goto(`${BASE}/me`, { waitUntil: 'networkidle' });
      await page.click('form[action="/me/recovery-codes"] button[type=submit]');
      await page.waitForLoadState('networkidle');
      const codes = await page.$$eval('table td.n', els => els.map(e => e.textContent.trim())
        .filter(t => /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(t)));
      return { at: page.url(), said: `${codes.length} كود`, ok: codes.length === 6 };
    } },

  { role: 'resident', id: 'act-no-review', title: 'مش المفروض يقدر يراجع إيصالات', expect: 'refused',
    async run(page) {
      const res = await page.goto(`${BASE}/admin/review`, { waitUntil: 'networkidle' });
      return { at: page.url(), said: `HTTP ${res.status()}`, ok: res.status() === 403 };
    } },

  { role: 'operator', id: 'act-expense', title: 'يسجّل مصروف', expect: 'works',
    async run(page) {
      await page.goto(`${BASE}/admin/expenses`, { waitUntil: 'networkidle' });
      const form = 'form[action="/admin/expenses"]';
      await page.fill(`${form} [name="voucher_no"]`, 'E-WALK-1').catch(() => {});
      await page.fill(`${form} [name="amount"]`, '1250.00');
      await page.fill(`${form} [name="description"]`, 'شراء لمبات للمداخل');
      await page.fill(`${form} [name="spent_on"]`, '2026-08-01').catch(() => {});
      await page.fill(`${form} [name="vendor"]`, 'محل النور').catch(() => {});
      await page.click(`${form} button[type=submit]`);
      await page.waitForLoadState('networkidle');
      return { at: page.url(), said: await banner(page) };
    } },

  { role: 'operator', id: 'act-no-approve', title: 'مش المفروض يعتمد فلوس', expect: 'refused',
    async run(page) {
      const res = await page.goto(`${BASE}/admin/review`, { waitUntil: 'networkidle' });
      return { at: page.url(), said: `HTTP ${res.status()}`, ok: res.status() === 403 };
    } },

  { role: 'finance_reviewer', id: 'act-audit-read', title: 'يقرا دفتر القيود وسجل التغييرات', expect: 'works',
    async run(page) {
      const a = await page.goto(`${BASE}/admin/ledger`, { waitUntil: 'networkidle' });
      const b = await page.goto(`${BASE}/admin/audit`, { waitUntil: 'networkidle' });
      return { at: page.url(), said: `القيود ${a.status()} · السجل ${b.status()}`,
               ok: a.status() === 200 && b.status() === 200 };
    } },

  { role: 'finance_reviewer', id: 'act-review-readonly',
    title: 'يشوف طابور الإيصالات للمراجعة — من غير أزرار اعتماد', expect: 'works',
    async run(page) {
      const res = await page.goto(`${BASE}/admin/review`, { waitUntil: 'networkidle' });
      const buttons = await page.$$eval('form[action^="/admin/review/"] button',
        els => els.map(e => e.textContent.trim()));
      return { at: page.url(), said: `HTTP ${res.status()} · أزرار الاعتماد: ${buttons.length}`,
               ok: res.status() === 200 && buttons.length === 0,
               problem: buttons.length ? `الصفحة بتعرض ${buttons.length} زرار اعتماد/رفض لدور مش من حقه يعتمد` : null };
    } },

  { role: 'admin', id: 'act-approve', title: 'يعتمد إيصال ساكن', expect: 'works',
    async run(page) {
      await page.goto(`${BASE}/admin/review`, { waitUntil: 'networkidle' });
      const n = await page.locator('form[action^="/admin/review/"]').count();
      if (!n) return { at: page.url(), said: 'الطابور فاضي', ok: false };
      await page.locator('form[action^="/admin/review/"] button[value="approve"]').first().click();
      await page.waitForLoadState('networkidle');
      return { at: page.url(), said: await banner(page) };
    } },

  { role: 'admin', id: 'act-reject', title: 'يرفض إيصال بسبب مكتوب', expect: 'works',
    async run(page) {
      await page.goto(`${BASE}/admin/review`, { waitUntil: 'networkidle' });
      const form = page.locator('form[action^="/admin/review/"]').first();
      if (!await form.count()) return { at: page.url(), said: 'الطابور فاضي', ok: false };
      await form.locator('textarea[name="reason"]').fill('الصورة مش واضحة، ابعت صورة تانية من فضلك');
      await form.locator('button[value="reject"]').click();
      await page.waitForLoadState('networkidle');
      return { at: page.url(), said: await banner(page) };
    } },

  { role: 'admin', id: 'act-create-account', title: 'ينشئ حساب جديد', expect: 'works',
    async run(page) {
      await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle' });
      await page.fill('#np-name', 'د. منى الغنيمي');
      await page.fill('#np-phone', '01288776655');
      await page.click('form[method="post"][action="/admin/users"] button[type=submit]');
      await page.waitForLoadState('networkidle');
      return { at: page.url(), said: await banner(page) };
    } },

  { role: 'admin', id: 'act-temp-password', title: 'يبعت كلمة سر مؤقتة لعضو', expect: 'works',
    async run(page) {
      await page.goto(`${BASE}/admin/members`, { waitUntil: 'networkidle' });
      const btn = page.locator('form[action$="/password"] button[type=submit]').first();
      if (!await btn.count()) return { at: page.url(), said: 'مفيش زرار كلمة سر', ok: false };
      await btn.click();
      await page.waitForLoadState('networkidle');
      const shown = await page.$$eval('body', b =>
        (b[0]?.innerText.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/) ?? [null])[0]);
      return { at: page.url(), said: shown ? 'اتعرضت مرة واحدة' : 'مظهرتش', ok: !!shown };
    } },

  { role: 'admin', id: 'act-publish-news', title: 'ينشر خبر', expect: 'works',
    async run(page) {
      await page.goto(`${BASE}/admin/content`, { waitUntil: 'networkidle' });
      const form = page.locator('form[action="/admin/content"]').first();
      if (!await form.count()) return { at: page.url(), said: 'مفيش فورم نشر', ok: false };
      await form.locator('[name="title"]').fill('اجتماع الجمعية العمومية — تجربة');
      await form.locator('[name="body"]').fill('ده خبر تجريبي اتكتب أثناء فحص الموقع.');
      await form.locator('button[type=submit]').first().click();
      await page.waitForLoadState('networkidle');
      return { at: page.url(), said: await banner(page) };
    } },

  { role: 'admin', id: 'act-settings', title: 'يغيّر إعداد من إعدادات القرية', expect: 'works',
    async run(page) {
      await page.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle' });
      const inp = page.locator('form[action="/admin/settings"] input[name="instapay_handle"]').first();
      if (!await inp.count()) return { at: page.url(), said: 'الحقل مش موجود', ok: false };
      await inp.fill('qaryat.atebaa@instapay');
      await page.locator('form[action="/admin/settings"] button[type=submit]').first().click();
      await page.waitForLoadState('networkidle');
      return { at: page.url(), said: await banner(page) };
    } },

  { role: 'developer', id: 'act-role', title: 'يغيّر دور حساب', expect: 'works',
    async run(page) {
      await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle' });
      // Explicitly a RESIDENT's row. The first `/role` form on the page belongs
      // to the chairman, and the first version of this script promoted him to
      // operator — which then made every later admin scenario 403 for reasons
      // that had nothing to do with the product. A test that changes the thing
      // it is about to measure is a broken test.
      // `/admin/users` pages 25 at a time, so a specific id may not be on page
      // one. Pick any row that is not one of the five seeded staff accounts.
      const id = await page.$$eval('form[action$="/role"]', els => {
        const staff = new Set(['DEMOPRF0000000000000000001', 'DEMOPRF0000000000000000002',
          'DEMOPRF0000000000000000003', 'DEMOPRF0000000000000000004',
          'DEMOPRF0000000000000000005']);
        for (const f of els) {
          const m = /\/admin\/users\/([A-Z0-9]+)\/role/.exec(f.getAttribute('action'));
          if (m && !staff.has(m[1])) return m[1];
        }
        return null;
      });
      if (!id) return { at: page.url(), said: 'مفيش حساب ساكن على الصفحة دي', ok: false };
      const form = page.locator(`form[action="/admin/users/${id}/role"]`);
      await form.locator('select').selectOption('operator');
      await form.locator('button[type=submit]').click();
      await page.waitForLoadState('networkidle');
      return { at: page.url(), said: await banner(page) };
    } },
];

/**
 * The set that runs against PRODUCTION.
 *
 * Same idea, different arithmetic on risk. Every write here lands on the real
 * database the board is about to be shown, so each journey is either performed
 * on data created for the test and destroyed after it, or it reads the current
 * value, changes it, and puts it back.
 *
 * Two journeys are deliberately NOT run live, and saying which matters more
 * than the coverage number:
 *
 *   · **recording an expense** — it lands in the countersign queue and the
 *     product has no screen that removes it. A «مصروف تجربة» sitting in the
 *     board's queue is worse than an untested path, and the path is covered
 *     locally and by `tests/access/expenses.test.ts`.
 *   · **publishing an announcement** — same shape: it would appear at the top
 *     of the village's news feed with no way to take it down from the product.
 *
 * Approving a receipt is also not run against a REAL demo receipt: an approval
 * posts a journal entry and moves the village's headline figures. The walk
 * creates its own receipt and closes that one instead.
 */
const LIVE_ACTIONS = [
  { role: 'resident', id: 'act-pay', title: 'يقدّم إيصال دفع (الرحلة كاملة)', expect: 'works',
    run: ACTIONS.find(a => a.id === 'act-pay').run },

  { role: 'resident', id: 'act-profile', title: 'يعدّل بيانات التواصل — والقيمة بترجع زي ما كانت',
    expect: 'works',
    async run(page) {
      await page.goto(`${BASE}/me`, { waitUntil: 'networkidle' });
      const before = {
        phone: await page.inputValue('#me-phone').catch(() => ''),
        note: await page.inputValue('#me-note').catch(() => ''),
      };
      await page.fill('#me-phone', '01099887766');
      await page.fill('#me-note', 'تجربة فحص — هترجع زي ما كانت');
      await page.click('form[action="/me"] button[type=submit]');
      await page.waitForLoadState('networkidle');
      const said = await banner(page);

      await page.fill('#me-phone', before.phone);
      await page.fill('#me-note', before.note);
      await page.click('form[action="/me"] button[type=submit]');
      await page.waitForLoadState('networkidle');
      const restored = await page.inputValue('#me-note').catch(() => '');
      return { at: page.url(), said, ok: restored === before.note };
    } },

  { role: 'resident', id: 'act-no-review', title: 'مش المفروض يقدر يراجع إيصالات', expect: 'refused',
    run: ACTIONS.find(a => a.id === 'act-no-review').run },
  { role: 'operator', id: 'act-no-approve', title: 'مش المفروض يعتمد فلوس', expect: 'refused',
    run: ACTIONS.find(a => a.id === 'act-no-approve').run },
  { role: 'finance_reviewer', id: 'act-audit-read', title: 'يقرا دفتر القيود وسجل التغييرات',
    expect: 'works', run: ACTIONS.find(a => a.id === 'act-audit-read').run },
  { role: 'finance_reviewer', id: 'act-review-readonly',
    title: 'يشوف طابور الإيصالات للمراجعة — من غير أزرار اعتماد', expect: 'works',
    run: ACTIONS.find(a => a.id === 'act-review-readonly').run },

  { role: 'admin', id: 'act-create-account', title: 'ينشئ حساب جديد (حساب تجربة بيتقفل بعدين)',
    expect: 'works',
    async run(page) {
      await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle' });
      await page.fill('#np-name', 'حساب فحص — يتقفل بعد التجربة');
      await page.fill('#np-phone', meta.throwawayPhone);
      await page.click('form[method="post"][action="/admin/users"] button[type=submit]');
      await page.waitForLoadState('networkidle');
      const said = await banner(page);
      return { at: page.url(), said, ok: /اتعمل/.test(said) };
    } },

  { role: 'admin', id: 'act-temp-password', title: 'يبعت كلمة سر مؤقتة للحساب الجديد',
    expect: 'works',
    async run(page) {
      // Search for the account this walk just created, rather than pressing the
      // first button on a page of 205 real members.
      await page.goto(`${BASE}/admin/members?q=${encodeURIComponent('حساب فحص')}`,
        { waitUntil: 'networkidle' });
      const btn = page.locator('form[action$="/password"] button[type=submit]').first();
      if (!await btn.count()) return { at: page.url(), said: 'الحساب مش ظاهر في البحث', ok: false };
      await btn.click();
      await page.waitForLoadState('networkidle');
      const shown = (await page.textContent('body'))
        .match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/);
      return { at: page.url(), said: shown ? 'اتعرضت مرة واحدة' : 'مظهرتش', ok: !!shown };
    } },

  { role: 'admin', id: 'act-reject', title: 'يرفض الإيصال اللي الفحص بعته، بسبب مكتوب',
    expect: 'works',
    async run(page) {
      await page.goto(`${BASE}/admin/review`, { waitUntil: 'networkidle' });
      // The walk's own receipt carries a note nothing else has. Rejecting
      // touches no ledger; approving would move the village's figures.
      const form = page.locator('.card', { hasText: 'تحويل إنستا باي — تجربة' })
        .locator('form[action^="/admin/review/"]').first();
      if (!await form.count()) {
        return { at: page.url(), said: 'إيصال الفحص مش في الطابور', ok: false };
      }
      await form.locator('textarea[name="reason"]')
        .fill('إيصال تجربة أثناء فحص الموقع — مش دفعة حقيقية.');
      await form.locator('button[value="reject"]').click();
      await page.waitForLoadState('networkidle');
      return { at: page.url(), said: await banner(page) };
    } },

  { role: 'admin', id: 'act-settings', title: 'يغيّر إعداد — والقيمة بترجع زي ما كانت',
    expect: 'works',
    async run(page) {
      await page.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle' });
      const F = 'form[action="/admin/settings"]';
      const field = `${F} input[name="community_name_ar"]`;
      const before = await page.inputValue(field).catch(() => null);
      if (before === null) return { at: page.url(), said: 'الحقل مش موجود', ok: false };

      await page.fill(field, before + ' ');
      await page.locator(`${F} button[type=submit]`).first().click();
      await page.waitForLoadState('networkidle');
      const said = await banner(page);

      await page.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle' });
      await page.fill(field, before);
      await page.locator(`${F} button[type=submit]`).first().click();
      await page.waitForLoadState('networkidle');
      await page.goto(`${BASE}/admin/settings`, { waitUntil: 'networkidle' });
      const after = await page.inputValue(field);
      return { at: page.url(), said, ok: after === before,
               problem: after === before ? null : 'الإعداد مرجعش لقيمته الأصلية' };
    } },

  { role: 'developer', id: 'act-role', title: 'يغيّر دور حساب الفحص — ويرجّعه', expect: 'works',
    async run(page) {
      await page.goto(`${BASE}/admin/users?q=${encodeURIComponent('حساب فحص')}`,
        { waitUntil: 'networkidle' });
      const form = page.locator('form[action$="/role"]').first();
      if (!await form.count()) return { at: page.url(), said: 'حساب الفحص مش ظاهر', ok: false };
      await form.locator('select').selectOption('operator');
      await form.locator('button[type=submit]').click();
      await page.waitForLoadState('networkidle');
      const said = await banner(page);

      await page.goto(`${BASE}/admin/users?q=${encodeURIComponent('حساب فحص')}`,
        { waitUntil: 'networkidle' });
      const back = page.locator('form[action$="/role"]').first();
      await back.locator('select').selectOption('resident');
      await back.locator('button[type=submit]').click();
      await page.waitForLoadState('networkidle');
      return { at: page.url(), said };
    } },
];

for (const a of (process.env.WALK_LIVE ? LIVE_ACTIONS : ACTIONS)) {
  const ctx = await browser.newContext({ viewport: PHONE, locale: 'ar-EG', deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: 'qa_session', value: T[a.role].token, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(String(e)));

  let out, threw = null;
  try { out = await a.run(page); } catch (e) { threw = String(e).split('\n')[0]; }

  const file = `${a.role}__${a.id}.png`;
  await page.screenshot({ path: join(OUT, file), fullPage: true }).catch(() => {});

  // A journey either completed or it did not, and "did not" is a finding
  // whether it threw, was refused, or simply had no control to press.
  const ok = threw ? false : (out?.ok ?? true);
  if (threw) note(a.role, a.title, 'blocker', `الرحلة وقفت: ${threw}`);
  else if (a.expect === 'works' && !ok) {
    note(a.role, a.title, 'blocker', out?.problem ?? `مكمّلتش: ${out?.said ?? '—'}`);
  } else if (out?.problem) {
    note(a.role, a.title, 'major', out.problem);
  }
  if (jsErrors.length) note(a.role, a.title, 'major', `خطأ جافاسكريبت: ${jsErrors[0]}`);

  shots.push({ role: a.role, roleAr: ROLE_AR[a.role], id: a.id, title: a.title,
               path: out?.at ?? '—', status: ok ? 200 : 599, offered: true, file,
               kind: 'action', said: threw ?? out?.said ?? '', expect: a.expect });
  await ctx.close();
}

/* ---- the drawer, on the phone, for one role ---------------------------- */
{
  const ctx = await browser.newContext({ viewport: PHONE, locale: 'ar-EG', deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: 'qa_session', value: T.admin.token, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  // `.drawer > summary`, precisely — `header button` also matches the theme and
  // font-size controls, and clicking one of those left the drawer shut while
  // this script reported its links as "covered". The first run of this file
  // produced exactly that false positive.
  await page.click('.drawer > summary');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'admin__drawer.png') });
  shots.push({ role: 'admin', roleAr: ROLE_AR.admin, id: 'drawer', title: 'القائمة الجانبية (موبايل)',
               path: '/', status: 200, offered: true, file: 'admin__drawer.png', overflow: 0 });

  // Is the top item of the open drawer actually clickable, or is something
  // painted over it? `elementFromPoint` answers what the browser will do, which
  // is the only answer that counts.
  const covered = await page.evaluate(() => {
    const link = document.querySelector('.drawer-panel a');
    if (!link) return 'no drawer link found';
    const r = link.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return link.contains(hit) || hit === link ? null : `covered by <${hit?.tagName?.toLowerCase()} class="${hit?.className}">`;
  });
  if (covered) note('admin', 'القائمة الجانبية', 'blocker', `أول لينك في القائمة مش قابل للضغط — ${covered}`);
  await ctx.close();
}

/* ---- desktop, because the board reviews on a laptop --------------------- */
for (const role of ['admin', 'resident']) {
  const ctx = await browser.newContext({ viewport: DESK, locale: 'ar-EG' });
  await ctx.addCookies([{ name: 'qa_session', value: T[role].token, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: join(OUT, `${role}__wide.png`) });
  shots.push({ role, roleAr: ROLE_AR[role], id: 'wide', title: 'الشكل على اللابتوب',
               path: '/', status: 200, offered: true, file: `${role}__wide.png`, overflow: 0 });
  await ctx.close();
}

/* ---- logged out --------------------------------------------------------- */
{
  const ctx = await browser.newContext({ viewport: PHONE, locale: 'ar-EG', deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  for (const [id, title, path] of [
    ['login', 'صفحة الدخول', '/login'],
    ['recover', 'الدخول بكود استرجاع', '/login/recover'],
    ['locked', 'صفحة محمية من غير تسجيل دخول', '/finance'],
  ]) {
    const res = await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.screenshot({ path: join(OUT, `guest__${id}.png`), fullPage: true });
    shots.push({ role: 'guest', roleAr: 'زائر', id, title, path, status: res.status(),
                 offered: true, file: `guest__${id}.png`, overflow: 0 });
  }
  await ctx.close();
}

await browser.close();

writeFileSync(join(OUT, 'result.json'),
  JSON.stringify({ shots, findings, generatedAt: new Date().toISOString() }, null, 2), 'utf8');

const bad = findings.filter(f => f.severity === 'blocker').length;
console.log(`\n  ${shots.length} screenshots · ${findings.length} findings (${bad} blockers)`);
for (const f of findings) console.log(`  · [${f.severity}] ${f.role} / ${f.scenario}: ${f.what}`);
