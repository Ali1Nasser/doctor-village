/**
 * src/views/pages.ts — the screens.
 *
 * Server-rendered HTML. No client framework, no hydration: this app is forms and
 * tables read on a five-year-old Android over Matrouh 3G, and the fastest thing
 * to render is HTML that arrives finished. (05 §1, 04_UX_SPEC §9)
 *
 * Every screen here has its empty and error states defined alongside it rather
 * than added later — 04_UX_SPEC §5 requires all six, and the ones that get
 * skipped are always the ones nobody designed up front.
 */

import { page, t, msg, msgHtml, esc, num, money, arDate, pct, statusChip, emptyState } from './layout.js';
import { PASSKEY_LOGIN_JS, PASSKEY_ENROLL_JS, UPLOAD_JS, SUBMIT_JS, RECOVER_JS, PUSH_JS } from './island.js';

/** Strings the islands show. Kept here so `messages/ar.json` stays the only
 *  place Arabic lives — including the Arabic that JavaScript displays. */
const LOGIN_MSGS = {
  working: t.app.loading, failed: t.login.errors.failed,
  cancelled: t.login.errors.failed, submit: t.login.submit,
  needsActivation: t.login.firstTime, noPasskey: t.login.errors.noPasskey,
  enroll: t.activate.enroll, confirm: t.app.confirm,
};
const UPLOAD_MSGS = {
  compressing: t.pay.compressing, ready: t.app.confirm, tooBig: t.pay.errors.tooBig,
  failed: t.states.errorBody, working: t.app.loading,
  submit: t.pay.submit, needImage: t.pay.errors.image,
};

/* ===================================================================== */
/* Login & activation — 04_UX_SPEC §3                                    */
/* ===================================================================== */

export function loginPage(error?: string): string {
  return page({ title: t.login.title, showNav: false,
               scripts: [PASSKEY_LOGIN_JS], jsMessages: LOGIN_MSGS }, `
<div class="card">
  <h2 style="margin-block-start:0">${esc(t.login.title)}</h2>
  <p class="muted">${esc(t.login.subtitle)}</p>
  ${error ? `<div class="banner warn">${esc(error)}</div>` : ''}
  <form id="login-form" method="post" action="/login">
    <div class="field">
      <label for="phone">${esc(t.login.phoneLabel)}</label>
      <input id="phone" name="phone" type="tel" inputmode="numeric" autocomplete="tel"
             placeholder="${esc(t.login.phonePlaceholder)}" required
             aria-describedby="phone-hint">
      <p class="hint" id="phone-hint">${esc(t.login.notRegistered)}</p>
    </div>
    <button class="btn" type="submit">👆 ${esc(t.login.submit)}</button>
  </form>
  <p class="hint">${esc(t.login.explainer)}</p>
</div>
<div class="card">
  <p class="muted" style="margin-block-start:0">${esc(t.login.firstTime)}</p>
  <a class="btn btn-2" href="/help">💬 ${esc(t.login.helpBoard)}</a>
</div>`);
}

export function activatePage(name: string, recoveryCodes: string[]): string {
  return page({ title: t.activate.title, showNav: false,
               scripts: [PASSKEY_ENROLL_JS], jsMessages: LOGIN_MSGS }, `
<div class="card">
  <h2 style="margin-block-start:0">${esc(msg(t.activate.welcome, { name }))}</h2>
  <p>${esc(t.activate.explain)}</p>
  <button class="btn" type="button" id="enroll-btn">👆 ${esc(t.activate.enroll)}</button>
  <p class="hint">${esc(t.login.explainer)}</p>
</div>
<div class="card">
  <h2 style="margin-block-start:0">🔑 ${esc(t.activate.recoveryCodes)}</h2>
  <table><tbody>
    ${recoveryCodes.map(c => `<tr><td class="n">${num(c)}</td></tr>`).join('')}
  </tbody></table>
  <div class="banner warn">${esc(t.activate.recoveryWarning)}</div>
</div>
<div class="card">
  <p class="muted" style="margin-block-start:0">${esc(t.activate.secondDevice)}</p>
</div>`);
}

/* ===================================================================== */
/* Resident home — the three-second answer (04_UX_SPEC §3)               */
/* ===================================================================== */

export interface HomeData {
  name: string;
  /**
   * The caller's own flat — `null` when they own none.
   *
   * A board member who owns no unit was shown «عمارة — شقة —» above
   * «إجمالي المطلوب منك 0.00» and a «دفع جديد» button: three statements that
   * are each false about them, on the first screen they see. The dues card is
   * about a flat, so it is drawn only when there is one.
   */
  building: string | null;
  unit: string | null;
  duePiastres: number;
  paidPiastres: number;
  outstandingPiastres: number;
  /** Their الوديعة. Migration 0011 correctly stopped this counting toward dues —
   *  which made it invisible, so the resident's money appeared to vanish. */
  depositHeldPiastres: number;
  /** R-055: `due_piastres` covers EVERY published fee period, not this year. The
   *  caption said \"السنة دي\". With more than one period live, say so. */
  periodCount: number;
  spendablePiastres: number;
  heldInTrustPiastres: number;
  pinned?: { title: string; body: string } | null;
  /** Unread messages, for the nav badge. */
  unread?: number;
  demo?: boolean;
  /**
   * Work waiting for THIS caller, with counts and a direct action.
   *
   * The board's half of the home screen used to be a list of links, and a link
   * is not a signal: «مراجعة الإيصالات» reads the same whether the queue holds
   * zero receipts or eleven, so the only way to find out was to open it. On a
   * volunteer board that means nobody opens it on the day it matters.
   */
  queues?: { icon: string; label: string; count: number; href: string; cta: string }[];
  /** Total income and expense, for the treasury card's one-line breakdown. */
  incomePiastres?: number;
  expensePiastres?: number;
  /** The most recent board announcements. */
  news?: { slug: string; title: string; published: string }[];
  /** The audit feed, for the board only. */
  activity?: { who: string; what: string; when: string }[];
}

export function homePage(d: HomeData): string {
  // R-050: a resident with no published dues has not "settled" — nothing was
  // ever asked of them. Telling them "خالص" is a promise the board has not made.
  const billed = d.duePiastres > 0;
  const settled = billed && d.outstandingPiastres <= 0;
  const hasUnit = !!d.building && !!d.unit;
  return page({ title: t.nav.home, active: 'home', unread: d.unread, demo: d.demo }, `
${d.pinned ? `<div class="banner info"><strong>📌 ${esc(d.pinned.title)}</strong><br>${esc(d.pinned.body)}</div>` : ''}

<div class="card">
  <div class="muted">${esc(msg(t.home.greeting, { name: d.name }))}${hasUnit
    ? ` ·\n    ${msgHtml(esc(t.home.unit), { building: num(d.building!), unit: num(d.unit!) })}` : ''}</div>
  ${!hasUnit ? `
  <p style="margin-block-end:0"><strong>${esc(t.home.noUnit)}</strong></p>
  <p class="hint">${esc(t.home.noUnitHint)}</p>` : `
  <div class="muted" style="margin-block-start:10px">${esc(t.home.dueThisYear)}</div>
  <div class="hero">${money(d.duePiastres)}</div>
  ${d.periodCount > 1
    ? `<p class="hint" style="margin-block-start:0">${esc(t.home.dueAllPeriods)}</p>` : ''}
  ${!billed
    ? `<div class="chip mute">${esc(t.home.notBilledYet)}</div>`
    : settled
      ? `<div class="chip ok"><span aria-hidden="true">✔</span>${esc(t.home.settled)}</div>`
      : `<div class="muted">${esc(t.home.paidOf)} ${money(d.paidPiastres)} ·
          ${esc(t.home.remaining)} <strong style="color:var(--danger)">${money(d.outstandingPiastres)}</strong></div>`}
  ${d.depositHeldPiastres > 0
    ? `<div class="banner info" style="margin-block-end:0">🔒 ${msgHtml(esc(t.home.depositHeld),
        { amount: money(d.depositHeldPiastres) })}</div>`
    : ''}
  <a class="btn" href="/pay">${esc(t.home.payNow)}</a>
  <a class="btn btn-2" href="/payments">${esc(t.home.seeMyReceipts)}</a>`}
</div>

<!-- 07_VILLAGE_MAP_SPEC §4: "a prominent «خريطة القرية» card on the home page.
     It does not consume a fifth bottom-navigation slot." The five tabs are the
     resident's daily routes; the map is a place you go once, when a delivery
     driver is on the phone asking which building. -->
<a class="row row-link card" href="/map" style="display:flex;margin-block-end:14px">
  <span class="ico" aria-hidden="true">🗺️</span>
  <span class="row-body">
    <b>${esc(t.map.cardTitle)}</b>
    <span class="muted">${esc(t.map.cardHint)}</span>
  </span>
  <span class="row-end" aria-hidden="true">←</span>
</a>

${(d.queues ?? []).length > 0 ? `
<h2>${esc(t.dash.needsYou)}</h2>
${(d.queues ?? []).filter(q => q.count > 0).length === 0
  ? `<div class="card"><div class="empty" style="padding:20px">
      <div class="big" aria-hidden="true">👍</div>
      <p>${esc(t.dash.nothingPending)}</p>
      <p class="muted">${esc(t.dash.nothingPendingHint)}</p></div></div>`
  : `<div class="queues">
    ${(d.queues ?? []).filter(q => q.count > 0).map(q => `
    <a class="queue" href="${esc(q.href)}">
      <span class="qico" aria-hidden="true">${esc(q.icon)}</span>
      <span class="qbody">
        <span class="qn">${num(q.count)}</span>
        <span class="qlabel">${esc(q.label)}</span>
      </span>
      <span class="qgo">${esc(q.cta)} ←</span>
    </a>`).join('')}
  </div>`}` : ''}

<h2>${esc(t.home.villageMoney)}</h2>
<!-- The treasury reads as the headline figure it is: inverted, so the eye lands
     on it before the two supporting tiles. Same pattern the board already knows
     from the sandbox they reviewed. -->
<div class="hero-card">
  <div class="lbl">${esc(t.dash.treasury)}</div>
  <div class="v">${money(d.spendablePiastres)}</div>
  ${d.incomePiastres !== undefined && d.expensePiastres !== undefined
    ? `<div class="note">${msgHtml(esc(t.dash.treasuryBreak), {
        in: money(d.incomePiastres), out: money(d.expensePiastres) })}</div>` : ''}
</div>
<div class="tiles">
  <div class="tile" style="--tc:var(--ink-muted);--tsoft:var(--surface-2)">
    <div class="lbl"><span class="ico" aria-hidden="true">🔒</span>${esc(t.finance.heldInTrust)}</div>
    <div class="v">${money(d.heldInTrustPiastres)}</div>
    <div class="note">${esc(t.finance.heldInTrustNote)}</div>
  </div>
</div>
<a class="btn btn-2" href="/finance">${esc(t.finance.title)} ←</a>

${(d.news ?? []).length > 0 ? `
<h2>${esc(t.dash.latestNews)}</h2>
<div class="card">
  ${(d.news ?? []).map(n => `
  <a class="row row-link" href="/news/${esc(n.slug)}">
    <span class="ico" aria-hidden="true">📣</span>
    <span class="row-body">
      <b>${esc(n.title)}</b>
      <span class="muted">${arDate(n.published)}</span>
    </span>
  </a>`).join('')}
  <a class="btn btn-2" href="/news">${esc(t.dash.allNews)}</a>
</div>` : ''}

${(d.activity ?? []).length > 0 ? `
<h2>${esc(t.dash.activity)}</h2>
<div class="card">
  <p class="hint" style="margin-block-start:0">${esc(t.dash.activityHint)}</p>
  <ol class="timeline">
    ${(d.activity ?? []).map(a => `
    <li>
      <b>${esc(a.what)}</b>
      <span class="muted">${esc(a.who)} · ${arDate(a.when)}</span>
    </li>`).join('')}
  </ol>
</div>` : ''}

`);
}

/* ===================================================================== */
/* Pay — one question per screen (04_UX_SPEC §4.1)                       */
/* ===================================================================== */

export interface PayStepData {
  step: 1 | 2 | 3 | 4 | 5;
  categories?: { id: string; nameAr: string; icon?: string }[];
  bankDetailsMissing?: boolean;
  bankDetails?: { instapay: string | null; bank: string | null; vodafone: string | null };
  draft?: {
    amountPiastres?: number; categoryAr?: string; method?: string;
    date?: string; referenceNo?: string;
  };
  /** Which steps are still incomplete, so review can point at the right one. */
  gaps?: { field: string; step: number }[];
  error?: string;
}

const METHOD_AR: Record<string, string> = {
  instapay: t.pay.methodInstapay, bank_transfer: t.pay.methodBank,
  vodafone_cash: t.pay.methodVodafone, cash: t.pay.methodCash,
};

export function payPage(d: PayStepData): string {
  const dots = Array.from({ length: 5 }, (_, i) =>
    `<i class="${i < d.step ? 'on' : ''}"></i>`).join('');

  const body = {
    1: `
    <div class="field">
      <label for="amount">${esc(t.pay.amountLabel)}</label>
      <input id="amount" name="amount" inputmode="decimal" autocomplete="off"
             placeholder="0.00" required aria-describedby="amount-hint"
             value="${d.draft?.amountPiastres != null ? esc((d.draft.amountPiastres / 100).toFixed(2)) : ''}">
      <p class="hint" id="amount-hint">${esc(t.pay.amountHint)}</p>
    </div>`,
    2: `
    <p class="muted">${esc(t.pay.categoryHint)}</p>
    <div class="grid-cats">
      ${(d.categories ?? []).map(c =>
        `<button class="cat" type="submit" name="category" value="${esc(c.id)}">
           <span aria-hidden="true">${esc(c.icon ?? '•')}</span>${esc(c.nameAr)}</button>`).join('')}
    </div>`,
    3: `
    <div class="grid-cats">
      ${[['instapay', t.pay.methodInstapay, '📱'], ['bank_transfer', t.pay.methodBank, '🏦'],
         ['vodafone_cash', t.pay.methodVodafone, '📲'], ['cash', t.pay.methodCash, '💵']]
        .map(([v, l, i]) => `<button class="cat" type="submit" name="method" value="${esc(v)}">
           <span aria-hidden="true">${i}</span>${esc(l)}</button>`).join('')}
    </div>
    <div class="field" style="margin-block-start:16px">
      <label for="tdate">${esc(t.pay.transferDate)}</label>
      <input id="tdate" name="transfer_date" type="date" required
             value="${esc(d.draft?.date ?? '')}">
    </div>
    <div class="card">
      <strong>${esc(t.pay.transferDetails)}</strong>
      ${d.bankDetailsMissing
        // C10: no invented bank details, ever. The empty state says so plainly
        // rather than showing a plausible-looking wrong number.
        ? `<div class="banner warn" style="margin-block-end:0">${esc(t.pay.transferDetailsMissing)}</div>`
        : `<table><tbody>
             ${d.bankDetails?.instapay ? `<tr><th>${esc(t.pay.methodInstapay)}</th><td class="n">${num(d.bankDetails.instapay)}</td></tr>` : ''}
             ${d.bankDetails?.bank ? `<tr><th>${esc(t.pay.methodBank)}</th><td class="n">${num(d.bankDetails.bank)}</td></tr>` : ''}
             ${d.bankDetails?.vodafone ? `<tr><th>${esc(t.pay.methodVodafone)}</th><td class="n">${num(d.bankDetails.vodafone)}</td></tr>` : ''}
           </tbody></table>`}
    </div>`,
    4: `
    <div class="field">
      <label for="receipt-file">${esc(t.pay.step4)}</label>
      <!-- capture= opens the camera directly. Without it an elderly user lands
           in a file browser and gives up; both paths feed the same input. -->
      <input id="receipt-file" name="receipt" type="file" accept="image/*" capture="environment">
      <p class="hint">${esc(t.pay.compressing)}</p>
    </div>
    <img id="receipt-preview" alt="" hidden
         style="inline-size:100%;border-radius:10px;margin-block-end:8px">
    <p class="hint"><span id="receipt-size" class="num">—</span></p>
    <input type="hidden" id="receipt-data" name="image_base64">
    <div class="field" style="margin-block-start:16px">
      <label for="ref">${esc(t.pay.referenceNo)}</label>
      <input id="ref" name="reference_no" inputmode="numeric">
    </div>
    <div class="field">
      <label for="note">${esc(t.pay.note)}</label>
      <textarea id="note" name="note" rows="2"></textarea>
    </div>`,
    5: `
    <table><tbody>
      <tr><th>${esc(t.pay.amountLabel)}</th><td class="n">${d.draft?.amountPiastres != null ? money(d.draft.amountPiastres) : '—'}</td></tr>
      <tr><th>${esc(t.pay.categoryHint)}</th><td>${esc(d.draft?.categoryAr ?? '—')}</td></tr>
      <tr><th>${esc(t.pay.step3)}</th><td>${esc(METHOD_AR[d.draft?.method ?? ''] ?? '—')}</td></tr>
      <tr><th>${esc(t.pay.transferDate)}</th><td>${d.draft?.date ? arDate(d.draft.date) : '—'}</td></tr>
      ${d.draft?.referenceNo ? `<tr><th>${esc(t.pay.referenceNo)}</th><td class="n">${num(d.draft.referenceNo)}</td></tr>` : ''}
    </tbody></table>
    ${(d.gaps ?? []).length > 0
      // Point at the step that is missing something, rather than failing at
      // submit with a generic error the resident cannot act on.
      ? `<div class="banner warn">${esc(t.states.errorBody)}
           <a class="btn btn-2" href="/pay/${d.gaps![0]!.step}">${esc(t.app.back)} ←</a></div>`
      : `<button class="btn" type="button" id="submit-btn">${esc(t.pay.submit)}</button>`}`,
  }[d.step];

  return page({ title: t.pay.title, active: 'myPayments',
                scripts: d.step === 4 ? [UPLOAD_JS] : d.step === 5 ? [SUBMIT_JS] : [],
                jsMessages: UPLOAD_MSGS }, `
<div class="steps" role="progressbar" aria-valuenow="${d.step}" aria-valuemin="1" aria-valuemax="5"
     aria-label="${esc(msg(t.pay.step, { n: d.step }))}">${dots}</div>
<div class="card">
  <h2 style="margin-block-start:0">${esc((t.pay as unknown as Record<string, string>)[`step${d.step}`]!)}</h2>
  ${d.error ? `<div class="banner warn">${esc(d.error)}</div>` : ''}
  <form method="post" action="/pay/${d.step}">${body}</form>
</div>
${d.step > 1 ? `<a class="btn btn-2" href="/pay/${d.step - 1}">← ${esc(t.app.back)}</a>` : ''}`);
}

export function paySuccessPage(receiptNo: string): string {
  return page({ title: t.pay.success.title, active: 'myPayments' }, `
<div class="card" style="text-align:center">
  <div style="font-size:3rem" aria-hidden="true">✅</div>
  <h2>${esc(t.pay.success.title)}</h2>
  <p class="hero" style="font-size:1.3rem">${msgHtml(esc(t.pay.success.receiptNo), { no: num(receiptNo) })}</p>
  <p>${esc(t.pay.success.body)}</p>
  <p class="hint">${esc(t.pay.success.keepNumber)}</p>
  <a class="btn" href="/payments">${esc(t.home.seeMyReceipts)}</a>
  <a class="btn btn-2" href="/">${esc(t.nav.home)}</a>
</div>`);
}

/* ===================================================================== */
/* My payments                                                           */
/* ===================================================================== */

export interface PaymentListItem {
  id: string; receiptNo: string; amountPiastres: number; transferDate: string;
  categoryAr: string; status: string; reasonAr?: string | null;
}

export function paymentsPage(
  items: PaymentListItem[], totalApproved: number, unread = 0,
): string {
  const body = items.length === 0
    ? emptyState('🧾', t.payments.empty, { href: '/pay', label: t.home.payNow })
    : `
<div class="card">
  <div class="muted">${esc(t.payments.total)}</div>
  <div class="hero">${money(totalApproved)}</div>
</div>
${items.map(p => `
<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
    <strong>${money(p.amountPiastres)}</strong>${statusChip(p.status)}
  </div>
  <div class="muted">${esc(p.categoryAr)} · ${arDate(p.transferDate)} · ${num(p.receiptNo)}</div>
  ${p.reasonAr ? `<div class="banner info" style="margin-block-end:0">
      <strong>${esc(t.payments.reason)}:</strong> ${esc(p.reasonAr)}
      <a class="btn btn-2" href="/pay">${esc(t.payments.reuploadCta)}</a></div>` : ''}
</div>`).join('')}
<a class="btn btn-2" href="/payments/statement">${esc(t.payments.downloadStatement)}</a>`;

  return page({ title: t.payments.title, active: 'myPayments', unread },
    `<h2>${esc(t.payments.title)}</h2>${body}`);
}

/* ===================================================================== */
/* Finance — the four separate figures                                   */
/* ===================================================================== */

export interface FinanceData {
  spendablePiastres: number;
  heldInTrustPiastres: number;
  pendingPiastres: number;
  pendingCount: number;
  arrearsPiastres: number;
  totalIncomePiastres: number;
  totalExpensePiastres: number;
  openingPiastres: number;
  reservesPiastres: number;
  owedToSuppliersPiastres: number;
  lastReconciledOn: string | null;
  depositShortfall: number;
  /** Money spent that the books do not show yet — R-043's mirror image:
   *  expenses understated, treasury overstated, invisible everywhere else. */
  unpostedCount: number;
  unpostedPiastres: number;
  categories: { nameAr: string; totalPiastres: number }[];
  buildings?: { code: string; paid: number; n: number; billed: number;
                collected: number; deposits: number; outstanding: number }[];
  unitsLocked?: boolean;
  demo?: boolean;
}

export function financePage(d: FinanceData): string {
  const totalExp = d.categories.reduce((a, c) => a + c.totalPiastres, 0);
  const hasData = d.totalIncomePiastres > 0 || totalExp > 0;

  /* The deposit-fund banner. It is ALWAYS rendered, not only on failure.
   * "No news is good news" is how a control stops being read: a board that has
   * never seen the line has no idea it is being checked, and cannot notice the
   * day it disappears. Green when intact, red and specific when not. */
  const trust = d.depositShortfall > 0
    ? `<div class="banner warn">${msgHtml(esc(t.finance.depositShort), { amount: money(d.depositShortfall) })}</div>`
    : `<div class="banner ok">🔒 ${esc(t.finance.depositIntact)}</div>`;

  const recon = d.lastReconciledOn
    ? `<div class="banner ok">✅ ${msgHtml(esc(t.finance.reconciled), { date: arDate(d.lastReconciledOn) })}</div>`
    : `<div class="banner warn">${esc(t.finance.neverReconciled)}</div>`;

  const bars = d.categories.map(c => `
    <div class="bar-row">
      <div class="bar-label"><span>${esc(c.nameAr)}</span>
        <span class="bar-val">${money(c.totalPiastres)} · ${pct(c.totalPiastres, totalExp)}</span></div>
      <div class="track"><div class="fill" style="inline-size:${Math.max(c.totalPiastres * 100 / (totalExp || 1), 1.5).toFixed(1)}%"></div></div>
    </div>`).join('');

  return page({ title: t.finance.title, active: 'finance', demo: d.demo }, `
<h2>${esc(t.finance.title)}</h2>
<p class="muted">${esc(t.finance.intro)}</p>

<div class="tiles">
  <div class="tile" style="--tc:var(--brand);--tsoft:var(--brand-soft)">
    <div class="lbl"><span class="ico" aria-hidden="true">✔</span>${esc(t.finance.spendable)}</div>
    <div class="v">${money(d.spendablePiastres)}</div>
    <div class="note">${esc(t.finance.spendableNote)}</div>
  </div>
  <div class="tile" style="--tc:var(--ink-muted);--tsoft:var(--surface-2)">
    <div class="lbl"><span class="ico" aria-hidden="true">🔒</span>${esc(t.finance.heldInTrust)}</div>
    <div class="v">${money(d.heldInTrustPiastres)}</div>
    <div class="note">${esc(t.finance.heldInTrustNote)}</div>
  </div>
  <div class="tile" style="--tc:var(--warn);--tsoft:var(--warn-soft)">
    <div class="lbl"><span class="ico" aria-hidden="true">🕐</span>${esc(t.finance.pending)}</div>
    <div class="v">${money(d.pendingPiastres)}</div>
    <div class="note">${msgHtml(esc(t.finance.pendingNote), { n: num(d.pendingCount) })}</div>
  </div>
  <div class="tile" style="--tc:var(--danger);--tsoft:var(--danger-soft)">
    <div class="lbl"><span class="ico" aria-hidden="true">!</span>${esc(t.finance.arrears)}</div>
    <div class="v">${money(d.arrearsPiastres)}</div>
    <div class="note">${esc(t.finance.arrearsNote)}</div>
  </div>
</div>

<div class="card">
  ${d.unpostedCount > 0
    ? `<div class="banner warn">${msgHtml(esc(t.finance.unposted), {
        n: num(d.unpostedCount), amount: money(d.unpostedPiastres) })}</div>`
    : ''}
  ${trust}
  ${recon}
  <div class="muted">${esc(t.finance.totalIncome)} ${money(d.totalIncomePiastres)} ·
    ${esc(t.finance.totalExpense)} ${money(d.totalExpensePiastres)} ·
    ${esc(t.finance.openingBalance)} ${money(d.openingPiastres)}${
      d.reservesPiastres > 0
        ? ` · ${esc(t.finance.reserves)} ${money(d.reservesPiastres)}` : ''}</div>
  ${d.owedToSuppliersPiastres > 0
    ? `<div class="muted">${esc(t.finance.owedToSuppliers)} ${money(d.owedToSuppliersPiastres)} —
       <span class="q-un">${esc(t.finance.owedToSuppliersNote)}</span></div>` : ''}
</div>

<h2>${esc(t.finance.expensesTitle)}</h2>
<div class="card">
${hasData ? `${bars}
  <details>
    <summary>${esc(t.finance.showNumbers)}</summary>
    <table>
      <thead><tr><th>${esc(t.finance.item)}</th><th>${esc(t.finance.amount)}</th><th>${esc(t.finance.share)}</th></tr></thead>
      <tbody>${d.categories.map(c =>
        `<tr><td>${esc(c.nameAr)}</td><td class="n">${money(c.totalPiastres)}</td><td>${pct(c.totalPiastres, totalExp)}</td></tr>`).join('')}
      </tbody>
    </table>
  </details>` : emptyState('📊', t.finance.empty)}
</div>

<h2>${esc(t.finance.unitsTitle)}</h2>
<div class="card">
  <p class="muted" style="margin-block-start:0">${esc(t.finance.unitsNote)}</p>
  ${d.unitsLocked
    ? `<div class="banner info" style="margin-block-end:0">${esc(t.finance.unitsLocked)}</div>`
    : `<table>
        <thead><tr><th>${esc(t.finance.building)}</th><th>${esc(t.finance.paidCount)}</th>
          <th>${esc(t.finance.collected)}</th><th>${esc(t.finance.deposits)}</th>
          <th>${esc(t.finance.outstanding)}</th></tr></thead>
        <tbody>${(d.buildings ?? []).map(b =>
          `<tr><td>${esc(t.finance.building)} ${num(b.code)}</td>
             <td class="n">${b.billed === 0
                ? `<span class="chip mute">${esc(t.finance.notBilled)}</span>`
                : num(`${b.paid}/${b.billed}`)}</td>
             <td class="n">${money(b.collected)}</td>
             <td class="n">${money(b.deposits)}</td>
             <td class="n">${money(b.outstanding)}</td></tr>`).join('')}
        </tbody></table>
        ${(d.buildings ?? []).some(b => b.billed === 0)
          ? `<div class="banner warn">${esc(t.finance.notBilledNote)}</div>` : ''}
        <p style="margin-block-end:0"><a href="/finance/units">${esc(t.finance.unitsLink)} ←</a></p>`}
</div>`);
}

/* ===================================================================== */
/* Admin review queue — clearable on a phone in ten minutes (§4.2)       */
/* ===================================================================== */

export interface ReviewItem {
  id: string; receiptNo: string; amountPiastres: number; transferDate: string;
  categoryAr: string; buildingCode: string; unitNumber: string;
  referenceNo?: string | null; noteAr?: string | null;
}

export function reviewPage(
  items: ReviewItem[], singleAdmin: boolean, demo?: boolean,
  flash?: string, error?: string,
): string {
  return page({ title: t.admin.queueTitle, showNav: false, demo }, `
${singleAdmin ? `<div class="banner warn">${esc(t.admin.singleAdminWarning)}</div>` : ''}
${error ? `<div class="banner warn">${esc(error)}</div>` : ''}
${flash ? `<div class="banner ok">${esc(flash)}</div>` : ''}
<h2>${esc(t.admin.queueTitle)}</h2>
${items.length === 0
  ? emptyState('✅', t.admin.queueEmpty)
  : `<p class="muted">${msgHtml(esc(t.admin.pendingCount), { n: num(items.length) })}</p>
${items.map(p => `
<div class="card">
  <div class="receipt-img" role="img" aria-label="${esc(t.admin.tapToZoom)}">🧾</div>
  <div><strong>${esc(t.finance.building)} ${num(p.buildingCode)} · شقة ${num(p.unitNumber)}</strong></div>
  <div class="hero" style="font-size:1.5rem">${money(p.amountPiastres)}</div>
  <div class="muted">${esc(p.categoryAr)} · ${arDate(p.transferDate)} · ${num(p.receiptNo)}
    ${p.referenceNo ? `· ${esc(t.pay.referenceNo)} ${num(p.referenceNo)}` : ''}</div>
  ${p.noteAr ? `<p class="muted">«${esc(p.noteAr)}»</p>` : ''}
  <form method="post" action="/admin/review/${esc(p.id)}">
    <button class="btn" name="kind" value="approve">${esc(t.admin.approve)}</button>
    <div class="field" style="margin-block-start:12px">
      <label for="a-${esc(p.id)}">${esc(t.admin.amountLabel)}</label>
      <input id="a-${esc(p.id)}" name="amount" inputmode="decimal" autocomplete="off"
             placeholder="${esc((p.amountPiastres / 100).toFixed(2))}"
             aria-describedby="ah-${esc(p.id)}">
      <p class="hint" id="ah-${esc(p.id)}">${esc(t.admin.amountHint)}</p>
    </div>
    <div class="field">
      <label for="r-${esc(p.id)}">${esc(t.admin.reasonRequired)}</label>
      <textarea id="r-${esc(p.id)}" name="reason" rows="2"
        placeholder="${esc(t.admin.reasonPlaceholder)}"></textarea>
    </div>
    <button class="btn btn-2" name="kind" value="need_info">${esc(t.admin.needInfo)}</button>
    <button class="btn btn-danger" name="kind" value="reject">${esc(t.admin.reject)}</button>
  </form>
  <p class="hint">${esc(t.admin.undoWindow)}</p>
</div>`).join('')}`}`);
}

/** 403 / 404 / 500 all get a real page, never a stack trace. 04_UX_SPEC §5. */
export function messagePage(title: string, bodyAr: string): string {
  return page({ title, showNav: false }, `
<div class="card" style="text-align:center">
  <div style="font-size:2.4rem" aria-hidden="true">🤔</div>
  <h2>${esc(title)}</h2>
  <p class="muted">${esc(bodyAr)}</p>
  <a class="btn" href="/">${esc(t.nav.home)}</a>
  <a class="btn btn-2" href="/help">${esc(t.app.help)}</a>
</div>`);
}

/**
 * Recovery by printed code — the path a resident reaches after losing their
 * phone. It has to be findable from the login screen and calm to read: somebody
 * arrives here already worried they have lost access to their money records.
 */
export function recoverPage(): string {
  return page({ title: t.activate.title, showNav: false,
                scripts: [RECOVER_JS], jsMessages: LOGIN_MSGS }, `
<div class="card">
  <h2 style="margin-block-start:0">${esc(t.login.errors.noPasskey)}</h2>
  <p class="muted">${esc(t.activate.recoveryCodes)}</p>
  <form id="recover-form" method="post" action="/login/recover">
    <div class="field">
      <label for="code">${esc(t.activate.recoveryCodes)}</label>
      <input id="code" name="code" inputmode="text" autocomplete="one-time-code"
             placeholder="XXXX-XXXX-XXXX" required
             style="text-transform:uppercase;letter-spacing:.08em">
      <p class="hint">${esc(t.activate.recoveryWarning)}</p>
    </div>
    <button class="btn" type="submit">${esc(t.app.confirm)}</button>
  </form>
</div>
<div class="card">
  <p class="muted" style="margin-block-start:0">${esc(t.login.firstTime)}</p>
  <a class="btn btn-2" href="/help">💬 ${esc(t.login.helpBoard)}</a>
</div>`);
}

/* ===================================================================== */
/* /finance/units — per-unit collection status (CP-3, Q11, R-002)        */
/* ===================================================================== */

export interface UnitRow {
  building_code: string; unit_number: string;
  due_piastres: number; paid_piastres: number; outstanding_piastres: number;
}

/**
 * Every flat's payment status, in one scrollable table.
 *
 * ## This screen is a privacy decision before it is a UI
 * `01_PRD` A5 asks for it; `R-002` says publishing who has not paid is public
 * shaming in a community where everyone knows everyone, and Q11's answer was
 * *"yes, with the general assembly's written approval."* So the gate is a
 * setting (`unit_status_public`), the data function refuses without it, and
 * this page renders the refusal as an **explained state, not an error** — a
 * resident who arrives here should learn why it is closed, not think it broke.
 *
 * ## What is deliberately absent
 * No names. No phone numbers. No receipt thumbnails. Not hidden by CSS —
 * *never selected*, so no template change can leak them. A flat is identified
 * by building and number, which is what a neighbour already knows by walking
 * past it.
 *
 * `outstanding < 0` means the owner paid ahead. It is shown as "رصيد دائن"
 * rather than a negative arrears figure, because a minus sign in the متأخرات
 * column reads as debt to everyone who is not an accountant.
 */
export function unitsPage(d: {
  allowed: boolean; reasonAr?: string; rows: UnitRow[]; demo?: boolean;
}): string {
  if (!d.allowed) {
    return page({ title: t.finance.unitsPageTitle, active: 'finance', demo: d.demo }, `
<h2>${esc(t.finance.unitsPageTitle)}</h2>
<div class="card">
  <div class="banner info" style="margin-block-end:0">🔒 ${esc(d.reasonAr ?? t.finance.unitsLocked)}</div>
</div>
<p><a href="/finance">${esc(t.finance.backToFinance)}</a></p>`);
  }

  // R-050 again, per unit: a flat with no published dues is NOT settled. It was
  // never billed. Counting it as paid is a false all-clear on the exact screen
  // that exists to show who has not paid.
  const billed = d.rows.filter(r => r.due_piastres > 0);
  const settled = billed.filter(r => r.outstanding_piastres <= 0).length;
  const owing = billed.length - settled;
  const unbilled = d.rows.length - billed.length;

  const body = d.rows.length === 0 ? emptyState('🏢', t.finance.unitsEmpty) : `
<table>
  <thead><tr>
    <th>${esc(t.finance.building)}</th><th>${esc(t.finance.unit)}</th>
    <th>${esc(t.finance.due)}</th><th>${esc(t.finance.paid)}</th>
    <th>${esc(t.finance.outstanding)}</th>
  </tr></thead>
  <tbody>${d.rows.map(r => {
    const out = r.outstanding_piastres;
    // Chip carries an icon AND a word AND a colour — never colour alone (R-035).
    const chip = r.due_piastres === 0
      ? `<span class="chip mute">— ${esc(t.finance.notBilled)}</span>`
      : out > 0
        ? `<span class="chip danger">! ${esc(t.finance.owing)}</span>`
        : out < 0
          ? `<span class="chip info">↩ ${esc(t.finance.credit)}</span>`
          : `<span class="chip ok">✔ ${esc(t.finance.settled)}</span>`;
    return `<tr>
      <td class="n">${num(r.building_code)}</td>
      <td class="n">${num(r.unit_number)}</td>
      <td class="n">${money(r.due_piastres)}</td>
      <td class="n">${money(r.paid_piastres)}</td>
      <td class="n">${out === 0 ? chip : `${money(Math.abs(out))} ${chip}`}</td>
    </tr>`;
  }).join('')}</tbody>
</table>`;

  return page({ title: t.finance.unitsPageTitle, active: 'finance', demo: d.demo }, `
<h2>${esc(t.finance.unitsPageTitle)}</h2>
<p class="muted">${msgHtml(esc(t.finance.unitsSummary), {
    n: num(d.rows.length), settled: num(settled), owing: num(owing),
  })}</p>
${unbilled > 0
  ? `<div class="banner warn">${msgHtml(esc(t.finance.unitsUnbilled), { n: num(unbilled) })}</div>`
  : ''}
<div class="banner info">${esc(t.finance.unitsPrivacy)}</div>
<div class="card">${body}</div>
<p><a href="/finance">${esc(t.finance.backToFinance)}</a></p>`);
}

/* ===================================================================== */
/* /admin/health — the free-tier dashboard (CP-3, C11, 05 §2a)           */
/* ===================================================================== */

export interface HealthRow {
  service: string; metricAr: string; used: number | null; limitValue: number;
  unit: 'bytes' | 'count'; measured: boolean; atLimitAr: string; canBill: boolean;
}

const KB = 1024, MB = KB * 1024;
/** Sizes are read by a volunteer treasurer, not an SRE: MB with one decimal. */
function size(b: number): string {
  return b >= MB ? `${(b / MB).toFixed(1)} MB`
    : b >= KB ? `${(b / KB).toFixed(0)} KB` : `${b} B`;
}

/**
 * The page that keeps "zero cost, forever" honest after launch.
 *
 * ## Why an unmeasured row shows "—" and not "0%"
 * Workers request counts and KV writes are not visible from inside a Worker.
 * Rendering them as an empty green bar would be a *lie that reassures* — the
 * worst kind on a page whose entire job is early warning. They are listed,
 * marked as declared-not-measured, and left blank. A board member who wants
 * those numbers is told, in Arabic, to look at the Cloudflare dashboard.
 *
 * Thresholds: 70% warn, 90% danger, per `05 §2a`. Early enough that the fix is
 * "delete old receipts", not "the site stopped working."
 */
export function healthPage(d: {
  rows: HealthRow[]; overThreshold: number; capOnFile: boolean;
  verifiedOn: string;
  /** R-072: how much posted spending has no photo. Not every expense needs one,
   *  but the board should know the number before the general assembly asks. */
  evidence?: { count: number; totalPiastres: number };
  /** Q23 / R-070: push reach is a NUMBER the board must see, not an assumption.
   *  A board that believes «كله اتبلّغ» stops following up by hand. */
  push?: {
    configured: boolean; residents: number; reachable: number; dead: number;
    fingerprint: string | null; recorded: string | null; mismatch: boolean;
  };
  demo?: boolean;
}): string {
  const rows = d.rows.map(r => {
    const p = r.used === null || r.limitValue <= 0
      ? null : Math.min(100, (r.used * 100) / r.limitValue);
    const lvl = p === null ? '' : p >= 90 ? 'danger' : p >= 70 ? 'warn' : '';
    const label = p === null ? '' : p >= 90 ? t.health.danger : p >= 70 ? t.health.warn : t.health.ok;
    const fmt = (v: number) => r.unit === 'bytes' ? size(v) : num(v);
    return `
<div class="q-row">
  <div class="q-head">
    <span class="q-svc">${esc(r.service)} — ${esc(r.metricAr)}</span>
    <span class="q-un">${r.used === null
      ? `— <span class="chip mute">${esc(t.health.declared)}</span>`
      : `<bdi dir="ltr" class="num">${esc(fmt(r.used))} / ${esc(fmt(r.limitValue))}</bdi>
         <span class="chip ${lvl || 'ok'}">${esc(label)} ${p!.toFixed(p! < 1 ? 2 : 0)}%</span>`}
    </span>
  </div>
  ${p === null ? '' :
    `<div class="track"><div class="fill ${lvl}" style="inline-size:${Math.max(p, 0.5).toFixed(2)}%"></div></div>`}
  <div class="q-un" style="margin-block-start:6px">${esc(r.atLimitAr)}</div>
</div>`;
  }).join('');

  const banner = d.overThreshold === 0
    ? `<div class="banner ok">✅ ${esc(t.health.okNote)}</div>`
    : `<div class="banner warn">⚠️ ${msgHtml(esc(t.health.warnNote), { n: num(d.overThreshold) })}</div>`;

  return page({ title: t.health.title, demo: d.demo }, `
<h2>${esc(t.health.title)}</h2>
<p class="muted">${esc(t.health.intro)}</p>
${banner}
${d.capOnFile ? '' : `<div class="banner ok">${esc(t.health.noCard)}</div>`}
<div class="card">${rows}</div>
${d.evidence ? `<h2>${esc(t.health.evidenceTitle)}</h2>
<div class="card">
  ${d.evidence.count === 0
    ? `<div class="banner ok" style="margin-block-end:0">${esc(t.health.evidenceNone)}</div>`
    : `<div class="banner warn" style="margin-block-end:0">${msgHtml(esc(t.expenses.noEvidence), {
        n: num(d.evidence.count), amount: money(d.evidence.totalPiastres) })}</div>`}
</div>` : ''}
${d.push ? `<h2>${esc(t.health.pushTitle)}</h2>
<div class="card">
  ${!d.push.configured
    ? `<div class="banner warn" style="margin-block-end:0">${esc(t.health.pushOff)}</div>`
    : `${d.push.mismatch
        ? `<div class="banner warn">${msgHtml(esc(t.health.pushMismatch),
            { recorded: esc(d.push.recorded ?? '—') })}</div>` : ''}
       <div class="q-head"><span class="q-svc">${msgHtml(esc(t.health.pushReach), {
         reachable: num(d.push.reachable), residents: num(d.push.residents) })}</span></div>
       <div class="track"><div class="fill ${
         d.push.residents > 0 && d.push.reachable * 2 < d.push.residents ? 'warn' : ''}"
         style="inline-size:${d.push.residents > 0
           ? Math.max(d.push.reachable * 100 / d.push.residents, 0.5).toFixed(1) : '0.5'}%"></div></div>
       <p class="q-un" style="margin-block-start:6px">${esc(t.health.pushReachNote)}</p>
       ${d.push.dead > 0
         ? `<p class="q-un">${msgHtml(esc(t.health.pushDead), { n: num(d.push.dead) })}</p>` : ''}
       <p class="q-un">${msgHtml(esc(t.health.pushFp), { fp: num(d.push.fingerprint ?? '—') })}</p>`}
</div>` : ''}
<div class="card">
  <p class="muted" style="margin-block-start:0">${msgHtml(esc(t.health.measuredNote), { date: arDate(d.verifiedOn) })}</p>
  <p class="muted" style="margin-block-end:0">${msgHtml(esc(t.health.reverify), { date: arDate('2026-11-04') })}</p>
</div>`);
}

/* ===================================================================== */
/* /admin/expenses — record, countersign, post, reverse (CP-5, 04 §82)   */
/* ===================================================================== */

export interface ExpenseQueueItem {
  id: string; voucherNo: string; amountPiastres: number; spentOn: string;
  descriptionAr: string; vendorName: string | null; categoryAr: string;
  status: string; needsCountersign: boolean; recordedByMe: boolean;
  approved: boolean; isReversal: boolean;
}
export interface PostedExpenseItem {
  id: string;
  voucherNo: string; amountPiastres: number; spentOn: string;
  descriptionAr: string; vendorName: string | null; categoryAr: string;
  reversed: boolean; isReversal: boolean;
  /** The evidence link, if there is one. Absent is not an error — a standing
   *  order has no paper — but it is visible, which is the point. */
  invoiceKey: string | null;
}

/**
 * The ops screen for money going out.
 *
 * ## The 60-second requirement is a design constraint, not a target
 * `04_UX_SPEC` line 82 asks for "60-second expense entry". The person using this
 * is a volunteer board member standing next to a plumber who wants to leave.
 * So: the entry form is the FIRST thing on the page, above the queue, with five
 * fields and today's date pre-filled. It is a plain `<form method="post">` —
 * **no JavaScript at all** — because the one screen that must work is the one
 * being used on a stairwell with one bar of signal.
 *
 * ## Why every action is a separate form
 * Countersign, post and reverse are each their own POST with their own button.
 * No dropdown of actions, no "apply to selected". A mis-tap should do one small
 * wrong thing that is visible, not one large wrong thing that is not.
 *
 * ## What the screen refuses to offer
 * A button the caller cannot legitimately press is **not rendered disabled — it
 * is replaced by the reason**. `recordedByMe` becomes «مينفعش توقّع على حاجة
 * إنت سجّلتها», so maker–checker is taught by the interface rather than
 * discovered as an error after tapping. The server enforces it regardless; this
 * is the explanation, not the control.
 */
export function expensesPage(d: {
  categories: { id: string; nameAr: string }[];
  funds: { id: string; nameAr: string }[];
  /** Does the CALLER hold `expense.countersign`? An operator records and never
   *  approves (R-058), so they must not be offered a button the server will
   *  refuse — that teaches them the system is broken rather than that they lack
   *  authority. The server checks regardless; this keeps the two in agreement. */
  canApprove: boolean;
  today: string;
  queue: ExpenseQueueItem[];
  posted: PostedExpenseItem[];
  flash?: string;
  error?: string;
  demo?: boolean;
}): string {
  const queue = d.queue.length === 0
    ? emptyState('✅', t.expenses.queueEmpty)
    : d.queue.map(e => {
      const canSign = d.canApprove && e.needsCountersign && !e.approved && !e.recordedByMe;
      const canPost = d.canApprove && (!e.needsCountersign || e.approved) && !e.recordedByMe;
      return `
<div class="card">
  <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
    <strong>${esc(e.descriptionAr)}</strong>
    <span class="n">${money(e.amountPiastres)}</span>
  </div>
  <div class="muted">${esc(e.categoryAr)} · ${arDate(e.spentOn)} · ${num(e.voucherNo)}${
    e.vendorName ? ` · ${esc(e.vendorName)}` : ''}</div>
  ${e.isReversal ? `<div><span class="chip info">↩ ${esc(t.expenses.reversalChip)}</span></div>` : ''}
  ${e.needsCountersign && !e.approved
    ? `<div><span class="chip warn">✍️ ${esc(t.expenses.needsSign)}</span></div>` : ''}
  ${canSign ? `<form method="post" action="/admin/expenses/${esc(e.id)}/countersign">
      <button class="btn btn-2" type="submit">${esc(t.expenses.countersign)}</button></form>` : ''}
  ${canPost ? `<form method="post" action="/admin/expenses/${esc(e.id)}/post">
      <button class="btn" type="submit">${esc(t.expenses.post)}</button></form>` : ''}
  ${d.canApprove && e.recordedByMe
    ? `<p class="hint">${esc(e.needsCountersign && !e.approved
        ? t.expenses.cannotSignOwn : t.expenses.cannotPostOwn)}</p>` : ''}
</div>`;
    }).join('');

  const posted = d.posted.length === 0
    ? emptyState('📘', t.expenses.postedEmpty)
    : `<table>
    <thead><tr><th>${esc(t.expenses.description)}</th><th>${esc(t.expenses.amount)}</th>
      <th>${esc(t.expenses.spentOn)}</th></tr></thead>
    <tbody>${d.posted.map(e => `<tr>
      <td>${esc(e.descriptionAr)}
        ${e.reversed ? `<span class="chip mute">✕ ${esc(t.expenses.reversedChip)}</span>` : ''}
        ${e.isReversal ? `<span class="chip info">↩ ${esc(t.expenses.reversalChip)}</span>` : ''}
        <br><span class="muted">${esc(e.categoryAr)} · ${num(e.voucherNo)}</span>
        <br>${e.invoiceKey
          ? `<a href="/api/invoices/${esc(e.invoiceKey)}">${esc(t.expenses.invoiceView)}</a>
             · <a href="/admin/expenses/${esc(e.id)}/invoice/remove">${
               esc(t.expenses.removeInvoice)}</a>`
          : `<a href="/admin/expenses/${esc(e.id)}/invoice">${esc(t.expenses.invoiceTake)}</a>`}</td>
      <td class="n">${money(e.amountPiastres)}</td>
      <td class="n">${arDate(e.spentOn)}</td>
    </tr>`).join('')}</tbody></table>`;

  return page({ title: t.expenses.title, demo: d.demo }, `
${d.flash ? `<div class="banner ok">${esc(d.flash)}</div>` : ''}
${d.error ? `<div class="banner warn">${esc(d.error)}</div>` : ''}

<h2>${esc(t.expenses.newTitle)}</h2>
<div class="card">
  <form method="post" action="/admin/expenses">
    <div class="field">
      <label for="amount">${esc(t.expenses.amount)}</label>
      <input id="amount" name="amount" inputmode="decimal" autocomplete="off" required
             placeholder="0.00" aria-describedby="amount-hint">
      <p class="hint" id="amount-hint">${esc(t.expenses.amountHint)}</p>
    </div>
    <div class="field">
      <label for="category">${esc(t.expenses.category)}</label>
      <select id="category" name="category" required>
        ${d.categories.map(c => `<option value="${esc(c.id)}">${esc(c.nameAr)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="description">${esc(t.expenses.description)}</label>
      <input id="description" name="description" required aria-describedby="desc-hint">
      <p class="hint" id="desc-hint">${esc(t.expenses.descHint)}</p>
    </div>
    <div class="field">
      <label for="spentOn">${esc(t.expenses.spentOn)}</label>
      <input id="spentOn" name="spentOn" type="date" value="${esc(d.today)}" required>
    </div>
    <div class="field">
      <label for="vendor">${esc(t.expenses.vendor)}</label>
      <input id="vendor" name="vendor" autocomplete="off">
    </div>
    ${d.funds.length > 1 ? `<div class="field">
      <label for="fund">${esc(t.expenses.fund)}</label>
      <select id="fund" name="fund">
        ${d.funds.map(f => `<option value="${esc(f.id)}">${esc(f.nameAr)}</option>`).join('')}
      </select>
    </div>` : `<input type="hidden" name="fund" value="${esc(d.funds[0]?.id ?? '')}">`}
    <button class="btn" type="submit">${esc(t.expenses.save)}</button>
  </form>
</div>

<h2>${esc(t.expenses.queueTitle)}</h2>
${queue}

<h2>${esc(t.expenses.postedTitle)}</h2>
<div class="card">${posted}</div>`);
}

/** The reversal form. Separate screen because the reason is the whole point. */
export function reverseExpensePage(d: {
  expenseId: string; voucherNo: string; amountPiastres: number;
  descriptionAr: string; error?: string; demo?: boolean;
}): string {
  return page({ title: t.expenses.reverse, demo: d.demo }, `
<h2>${esc(t.expenses.reverse)}</h2>
<div class="card">
  <div><strong>${esc(d.descriptionAr)}</strong></div>
  <div class="muted">${num(d.voucherNo)} · ${money(d.amountPiastres)}</div>
</div>
${d.error ? `<div class="banner warn">${esc(d.error)}</div>` : ''}
<div class="card">
  <form method="post" action="/admin/expenses/${esc(d.expenseId)}/reverse">
    <div class="field">
      <label for="reason">${esc(t.expenses.reverseReason)}</label>
      <textarea id="reason" name="reason" rows="3" required
                aria-describedby="reason-hint"></textarea>
      <p class="hint" id="reason-hint">${esc(t.expenses.reverseHint)}</p>
    </div>
    <button class="btn btn-danger" type="submit">${esc(t.expenses.reverseSubmit)}</button>
    <a class="btn btn-2" href="/admin/expenses">${esc(t.app.cancel ?? 'رجوع')}</a>
  </form>
</div>`);
}

/* ===================================================================== */
/* Payment reversal — the correction a RESIDENT feels (R-061…R-063)      */
/* ===================================================================== */

export interface ApprovedPaymentItem {
  id: string; receiptNo: string; amountPiastres: number; transferDate: string;
  categoryAr: string; buildingCode: string; unitNumber: string;
  reversed: boolean; reasonAr: string | null; approvedByMe: boolean;
}

/** The approved-receipts list, with reversal offered only where it is allowed. */
export function approvedPaymentsPage(d: {
  items: ApprovedPaymentItem[]; flash?: string; demo?: boolean;
}): string {
  const rows = d.items.length === 0
    ? emptyState('🧾', t.admin.approvedEmpty)
    : d.items.map(p => `
<div class="card">
  <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
    <strong>${esc(t.finance.building)} ${num(p.buildingCode)} ·
      ${esc(t.finance.unit)} ${num(p.unitNumber)}</strong>
    <span class="n">${money(p.amountPiastres)}</span>
  </div>
  <div class="muted">${esc(p.categoryAr)} · ${arDate(p.transferDate)} · ${num(p.receiptNo)}</div>
  ${p.reversed
    ? `<div><span class="chip mute">✕ ${esc(t.admin.reversedChip)}</span></div>
       ${p.reasonAr ? `<div class="muted">${esc(p.reasonAr)}</div>` : ''}`
    : p.approvedByMe
      // R-062: not a disabled button — the reason in its place. The admin who
      // approved this must learn they are excluded, not discover it by tapping.
      ? `<p class="hint">${esc(t.admin.cannotReverseOwn)}</p>`
      : `<a class="btn btn-2" href="/admin/payments/${esc(p.id)}/reverse">${
          esc(t.admin.reverseCta)}</a>`}
</div>`).join('');

  return page({ title: t.admin.approvedTitle, demo: d.demo }, `
${d.flash ? `<div class="banner ok">${esc(d.flash)}</div>` : ''}
<h2>${esc(t.admin.approvedTitle)}</h2>
${rows}`);
}

/**
 * The reversal form.
 *
 * ## Why the warning is above the fields and not below the button
 * By the time an admin reaches the submit button they have decided. The banner
 * says three concrete things — the resident was told it was accepted, their
 * arrears come back, and they will read this reason verbatim — while there is
 * still a decision to change. «اكتبه كأنك بتكلّمه وشّ لوشّ» is the whole
 * instruction: the person writing has met the person reading.
 *
 * ## Why the second admin is a dropdown and not a checkbox
 * "I confirm a second admin agreed" is a lie waiting to be told. Naming them
 * puts a specific person on the record who can be asked, and the caller's own
 * name is absent from the list — `reversePayment` refuses it anyway, but a
 * dropdown containing your own name on a two-person control invites the mistake
 * and then blames you for it.
 */
export function reversePaymentPage(d: {
  paymentId: string; receiptNo: string; amountPiastres: number;
  buildingCode: string; unitNumber: string;
  admins: { id: string; nameAr: string }[];
  error?: string; demo?: boolean;
}): string {
  return page({ title: t.admin.reverseTitle, demo: d.demo }, `
<h2>${esc(t.admin.reverseTitle)}</h2>
<div class="card">
  <div><strong>${esc(t.finance.building)} ${num(d.buildingCode)} ·
    ${esc(t.finance.unit)} ${num(d.unitNumber)}</strong></div>
  <div class="muted">${num(d.receiptNo)} · ${money(d.amountPiastres)}</div>
</div>
<div class="banner warn">${esc(t.admin.reverseWarn)}</div>
${d.error ? `<div class="banner warn">${esc(d.error)}</div>` : ''}
${d.admins.length === 0
  ? `<div class="card"><div class="banner warn" style="margin-block-end:0">${
      esc(t.admin.noSecondAdmin)}</div></div>`
  : `<div class="card">
  <form method="post" action="/admin/payments/${esc(d.paymentId)}/reverse">
    <div class="field">
      <label for="reason">${esc(t.admin.reverseReason)}</label>
      <textarea id="reason" name="reason" rows="3" required
                aria-describedby="reason-hint"></textarea>
      <p class="hint" id="reason-hint">${esc(t.admin.reverseHint)}</p>
    </div>
    <div class="field">
      <label for="second">${esc(t.admin.secondAdmin)}</label>
      <select id="second" name="second" required aria-describedby="second-hint">
        ${d.admins.map(a => `<option value="${esc(a.id)}">${esc(a.nameAr)}</option>`).join('')}
      </select>
      <p class="hint" id="second-hint">${esc(t.admin.secondAdminHint)}</p>
    </div>
    <button class="btn btn-danger" type="submit">${esc(t.admin.reverseSubmit)}</button>
    <a class="btn btn-2" href="/admin/payments">${esc(t.admin.undo)}</a>
  </form>
</div>`}`);
}

/* ===================================================================== */
/* /notifications — the resident's inbox (R-065…R-067)                   */
/* ===================================================================== */

export interface InboxItem {
  kind: string; titleAr: string; bodyAr: string;
  linkPath: string | null; unread: boolean; createdAt: string;
}

/**
 * A resident's messages.
 *
 * ## Why this page exists at all
 * The messages were written, addressed to the right person, deduplicated and
 * transactional — and completely unreadable, because nothing listed them. Same
 * failure as the reversal engine one session earlier: built, tested, unreachable.
 *
 * ## Two small decisions
 * · The body is rendered with line breaks preserved. Every decision message has
 *   the shape *reason, blank line, what to do next*, and collapsing that into one
 *   paragraph buries the instruction — which is the half that keeps a resident
 *   off the phone to the board.
 * · Opening the page marks everything read, so there is no "mark as read" button
 *   to find. On a five-year-old Android held by someone who does not enjoy
 *   phones, every control that exists only to manage the interface is a tax.
 */
export function inboxPage(d: {
  items: InboxItem[];
  /** VAPID public key. Absent = push is not configured on this deployment, and
   *  the card is not rendered at all rather than offering a button that fails. */
  vapidPublicKey?: string | null;
  pushOn?: boolean;
  demo?: boolean;
}): string {
  const rows = d.items.length === 0
    ? emptyState('📬', t.inbox.empty)
    : d.items.map(n => `
<div class="card">
  <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
    <strong>${esc(n.titleAr)}</strong>
    ${n.unread ? `<span class="chip info">${esc(t.inbox.unread)}</span>` : ''}
  </div>
  <div class="muted" style="white-space:pre-line">${esc(n.bodyAr)}</div>
  <div class="muted">${arDate(n.createdAt)}</div>
  ${n.linkPath ? `<a class="btn btn-2" href="${esc(n.linkPath)}">${esc(t.inbox.viewLink)}</a>` : ''}
</div>`).join('');

  /* The push card. Rendered only when the deployment actually has a VAPID key —
   * a button that cannot work is worse than no button, because the resident
   * concludes the site is broken rather than that a feature is off.
   *
   * The iOS line is unconditional. Safari requires the site to be added to the
   * home screen BEFORE it will even offer the permission prompt, and a resident
   * who taps and gets nothing has no way to discover why. */
  const push = !d.vapidPublicKey ? '' : d.pushOn
    ? `<div class="card"><div class="banner ok" style="margin-block-end:0">${
        esc(t.inbox.pushOn)}</div></div>`
    : `<div class="card">
  <h2 style="margin-block-start:0">${esc(t.inbox.pushTitle)}</h2>
  <p class="muted">${esc(t.inbox.pushExplain)}</p>
  <button class="btn" type="button" id="push-btn"
          data-key="${esc(d.vapidPublicKey)}">${esc(t.inbox.pushEnable)}</button>
  <p class="hint" id="push-msg" hidden></p>
  <p class="hint">${esc(t.inbox.pushIos)}</p>
</div>`;

  return page({
    title: t.inbox.title, active: 'inbox', demo: d.demo,
    scripts: d.vapidPublicKey && !d.pushOn ? [PUSH_JS] : [],
    jsMessages: {
      working: t.inbox.pushWorking, blocked: t.inbox.pushBlocked,
      unsupported: t.inbox.pushNo, failed: t.inbox.pushFailed, enabled: t.inbox.pushOn,
    },
  }, `
<h2>${esc(t.inbox.title)}</h2>
${push}
${rows}`);
}

/**
 * The invoice-photo step — shown after an expense is saved.
 *
 * Deliberately a SEPARATE screen. The expense form's design claim is five
 * fields, no JavaScript, sixty seconds, and an image needs JavaScript to
 * compress before upload. Putting it on the form would have cost the property
 * the form exists for. Here the volunteer can skip and come back.
 *
 * The warning is the real control. A supplier's invoice usually carries their
 * phone number and bank details, and publishing that to 204 residents is
 * somebody else's personal data. The cheapest and most effective protection is
 * the person holding the camera, told **before** they take the photo.
 */
export function expenseInvoicePage(d: {
  expenseId: string; voucherNo: string; amountPiastres: number;
  descriptionAr: string; demo?: boolean;
}): string {
  return page({
    title: t.expenses.invoiceTitle, demo: d.demo,
    scripts: [UPLOAD_JS],
    jsMessages: { ...UPLOAD_MSGS, submit: t.expenses.invoiceTake },
  }, `
<h2>${esc(t.expenses.invoiceTitle)}</h2>
<div class="card">
  <div><strong>${esc(d.descriptionAr)}</strong></div>
  <div class="muted">${num(d.voucherNo)} · ${money(d.amountPiastres)}</div>
</div>
<div class="card">
  <p class="muted" style="margin-block-start:0">${esc(t.expenses.invoiceWhy)}</p>
  <div class="banner warn">${esc(t.expenses.invoiceWarn)}</div>
  <form id="upload-form" method="post" action="/admin/expenses/${esc(d.expenseId)}/invoice">
    <input id="file" type="file" accept="image/*" capture="environment">
    <input type="hidden" name="imageBase64" id="imageBase64">
    <button class="btn" type="submit" id="submit-btn">${esc(t.expenses.invoiceTake)}</button>
  </form>
  <a class="btn btn-2" href="/admin/expenses">${esc(t.expenses.invoiceSkip)}</a>
</div>`);
}

/** Confirming removal of an invoice photo. Separate screen because the reason is
 *  recorded, and because the warning has to be read before the tap. */
export function removeInvoicePage(d: {
  expenseId: string; voucherNo: string; descriptionAr: string;
  error?: string; demo?: boolean;
}): string {
  return page({ title: t.expenses.removeInvoiceTitle, demo: d.demo }, `
<h2>${esc(t.expenses.removeInvoiceTitle)}</h2>
<div class="card">
  <div><strong>${esc(d.descriptionAr)}</strong></div>
  <div class="muted">${num(d.voucherNo)}</div>
</div>
<div class="banner warn">${esc(t.expenses.removeInvoiceWarn)}</div>
${d.error ? `<div class="banner warn">${esc(d.error)}</div>` : ''}
<div class="card">
  <form method="post" action="/admin/expenses/${esc(d.expenseId)}/invoice/remove">
    <div class="field">
      <label for="reason">${esc(t.expenses.removeInvoiceWhy)}</label>
      <textarea id="reason" name="reason" rows="2" required></textarea>
    </div>
    <button class="btn btn-danger" type="submit">${esc(t.expenses.removeInvoiceGo)}</button>
    <a class="btn btn-2" href="/admin/expenses">${esc(t.app.back)}</a>
  </form>
</div>`);
}
