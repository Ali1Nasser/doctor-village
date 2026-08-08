/**
 * src/views/content-pages.ts — CP-6 screens: news, archive, albums, search,
 * maintenance tickets.
 *
 * Same rules as `pages.ts`: server-rendered, no hydration, every number through
 * `num()`, every state designed here rather than bolted on. Split into its own
 * file only because `pages.ts` was already 1,138 lines and CP-6 adds nine
 * screens — one 2,000-line view file is where render bugs go to hide.
 *
 * ## The archive screen carries the CP-6 gate
 *
 * "A 2-year-old announcement is reachable in ≤ 3 taps." The path is
 * أخبار → الأرشيف → السنة/الشهر → الخبر, which is three taps from the home
 * screen and is why the archive groups by year+month in SQL (`v_content_archive`)
 * rather than paginating a flat list. A flat list with "load more" fails this
 * gate at about eight months of content and nobody notices until year two.
 */

import { page, t, msg, esc, num, money, arDate } from './layout.js';
import type {
  PostSummary, PostDetail, AlbumSummary, SearchHit, TicketSummary, TicketStatus,
} from '../../lib/db/content.js';

/**
 * `layout.emptyState` takes an optional call-to-action link. CP-6's empty states
 * mostly have no action to offer a resident — there is no button that makes the
 * board publish an announcement — so they carry an explanatory second line
 * instead. Same visual shape, different job: tell the reader the screen is
 * working and empty, not broken.
 */
function emptyWithHint(icon: string, text: string, hint: string): string {
  return `<div class="empty"><div class="big" aria-hidden="true">${icon}</div>`
       + `<p>${esc(text)}</p><p class="muted">${esc(hint)}</p></div>`;
}

/** Ticket states are their own vocabulary and are not in `t.status`, which is
 *  the payment lifecycle. A separate chip keeps the two from drifting into
 *  each other — "resolved" means something different for money. */
function ticketChip(status: TicketStatus): string {
  const tone: Record<TicketStatus, string> = {
    open: 'chip-warn', acknowledged: 'chip-info', in_progress: 'chip-info',
    resolved: 'chip-ok', closed: 'chip-muted', rejected: 'chip-danger',
  };
  const icon: Record<TicketStatus, string> = {
    open: '🆕', acknowledged: '👀', in_progress: '🔧',
    resolved: '✅', closed: '📦', rejected: '❌',
  };
  const label = t.maintenance.statusLabels[status] ?? status;
  return `<span class="chip ${tone[status]}" role="status">`
       + `<span aria-hidden="true">${icon[status]}</span>${esc(label)}</span>`;
}

/* ===================================================================== */
/* News list                                                             */
/* ===================================================================== */

const POST_TYPE_ICON: Record<string, string> = {
  news: '📰', announcement: '📣', decision: '📋', minutes: '📄', document: '📎',
};

const TABS: ReadonlyArray<{ key: string; label: string }> = [
  { key: '', label: t.content.tabs.all },
  { key: 'announcement', label: t.content.tabs.announcement },
  { key: 'decision', label: t.content.tabs.decision },
  { key: 'minutes', label: t.content.tabs.minutes },
  { key: 'news', label: t.content.tabs.news },
];

function postRow(p: PostSummary): string {
  const icon = POST_TYPE_ICON[p.type] ?? '📰';
  return `
<a class="row row-link" href="/news/${encodeURIComponent(p.slug)}">
  <span class="ico" aria-hidden="true">${icon}</span>
  <span class="row-body">
    <b>${esc(p.title_ar)}${p.is_pinned ? ` <span class="pill">${esc(t.content.pinned)}</span>` : ''}</b>
    <span class="muted">${p.published_at ? arDate(p.published_at) : ''}${
      p.attachment_count > 0
        ? ` · ${esc(msg(t.content.attachmentCount, { n: p.attachment_count }))}` : ''
    }</span>
  </span>
  <span class="row-end" aria-hidden="true">‹</span>
</a>`;
}

export function newsPage(d: {
  posts: PostSummary[];
  activeType: string;
  canPublish: boolean;
}): string {
  const tabs = TABS.map(tab => {
    const on = tab.key === d.activeType;
    const href = tab.key ? `/news?type=${tab.key}` : '/news';
    return `<a class="tab${on ? ' on' : ''}" href="${href}"${on ? ' aria-current="page"' : ''}>${esc(tab.label)}</a>`;
  }).join('');

  return page({ title: t.content.title, active: 'news' }, `
<div class="card">
  <h2 style="margin-block-start:0">${esc(t.content.title)}</h2>
  <p class="muted">${esc(t.content.subtitle)}</p>
  <form method="get" action="/search" role="search" class="searchbar">
    <input name="q" type="search" inputmode="search"
           placeholder="${esc(t.search.placeholder)}" aria-label="${esc(t.search.title)}">
    <button class="btn btn-2" type="submit">🔎 ${esc(t.search.submit)}</button>
  </form>
</div>

<nav class="tabs" aria-label="${esc(t.content.tabs.all)}">${tabs}</nav>

<div class="card">
  ${d.posts.length === 0
    ? emptyWithHint('📭', t.content.empty, t.content.emptyHint)
    : d.posts.map(postRow).join('')}
</div>

<div class="card">
  <a class="btn btn-2" href="/news/archive">🗂️ ${esc(t.content.archive)}</a>
  ${d.canPublish ? `<a class="btn btn-2" href="/admin/content" style="margin-block-start:8px">✍️ ${esc(t.content.manage)}</a>` : ''}
</div>`);
}

/* ===================================================================== */
/* One post                                                              */
/* ===================================================================== */

/**
 * Body text is escaped and then given paragraph breaks. Deliberately not
 * Markdown: an admin pasting from WhatsApp must get exactly what they pasted,
 * and a `#` or `*` at the start of a line in Arabic prose is far more likely to
 * be punctuation than markup.
 */
function paragraphs(bodyAr: string): string {
  return String(bodyAr)
    .split(/\n{2,}/)
    .map(block => `<p>${esc(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function postPage(d: { post: PostDetail; canPublish: boolean }): string {
  const p = d.post;
  const icon = POST_TYPE_ICON[p.type] ?? '📰';
  return page({ title: p.title_ar, active: 'news' }, `
<a class="backlink" href="/news">→ ${esc(t.content.backToNews)}</a>
<article class="card">
  <p class="muted" style="margin-block-start:0">
    <span aria-hidden="true">${icon}</span> ${esc(t.content.tabs[p.type as keyof typeof t.content.tabs] ?? '')}
    ${p.is_pinned ? `<span class="pill">${esc(t.content.pinned)}</span>` : ''}
  </p>
  <h2 style="margin-block-start:0">${esc(p.title_ar)}</h2>
  <p class="muted">
    ${p.published_at ? arDate(p.published_at) : ''} ·
    ${esc(msg(t.content.publishedBy, { name: p.author_name }))}
  </p>
  <div class="prose">${paragraphs(p.body_ar)}</div>
</article>

${p.attachments.length === 0 ? '' : `
<div class="card">
  <h3>${esc(t.content.attachments)}</h3>
  ${p.attachments.map(a => `
  <a class="row row-link" href="/api/attachments/${esc(a.id)}">
    <span class="ico" aria-hidden="true">📎</span>
    <span class="row-body">
      <b>${esc(a.name_ar)}</b>
      <span class="muted">${num((a.size_bytes / 1024).toFixed(0))} KB</span>
    </span>
    <span class="row-end">${esc(t.content.download)}</span>
  </a>`).join('')}
</div>`}`);
}

/* ===================================================================== */
/* Archive — the ≤3-taps gate                                            */
/* ===================================================================== */

const MONTH_AR = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

export function archivePage(d: {
  months: Array<{ year: string; month: string; items: number }>;
}): string {
  const byYear = new Map<string, Array<{ month: string; items: number }>>();
  for (const m of d.months) {
    if (!byYear.has(m.year)) byYear.set(m.year, []);
    byYear.get(m.year)!.push({ month: m.month, items: m.items });
  }

  return page({ title: t.content.archive, active: 'news' }, `
<a class="backlink" href="/news">→ ${esc(t.content.backToNews)}</a>
<div class="card">
  <h2 style="margin-block-start:0">${esc(t.content.archive)}</h2>
  <p class="muted">${esc(t.content.archiveHint)}</p>
</div>
${byYear.size === 0
  ? `<div class="card">${emptyWithHint('🗂️', t.content.archiveEmpty, t.content.emptyHint)}</div>`
  : [...byYear.entries()].map(([year, months]) => `
<div class="card">
  <h3 style="margin-block-start:0">${num(year)}</h3>
  <div class="chipgrid">
    ${months.map(m => `
    <a class="chiplink" href="/news/archive/${num(year).replace(/<[^>]+>/g, '')}/${m.month}">
      ${esc(MONTH_AR[Number(m.month) - 1] ?? m.month)}
      <span class="count">${num(m.items)}</span>
    </a>`).join('')}
  </div>
</div>`).join('')}`);
}

export function archiveMonthPage(d: {
  year: string; month: string;
  items: Array<{ content_kind: string; slug: string; title_ar: string; published_at: string }>;
}): string {
  const label = `${MONTH_AR[Number(d.month) - 1] ?? d.month} ${d.year}`;
  return page({ title: label, active: 'news' }, `
<a class="backlink" href="/news/archive">→ ${esc(t.content.archive)}</a>
<div class="card">
  <h2 style="margin-block-start:0">${esc(label)}</h2>
  ${d.items.length === 0
    ? emptyWithHint('🗂️', t.content.archiveEmpty, t.content.emptyHint)
    : d.items.map(i => `
  <a class="row row-link" href="${i.content_kind === 'album'
      ? `/albums/${esc(i.slug)}` : `/news/${encodeURIComponent(i.slug)}`}">
    <span class="ico" aria-hidden="true">${i.content_kind === 'album' ? '📸' : '📰'}</span>
    <span class="row-body">
      <b>${esc(i.title_ar)}</b>
      <span class="muted">${arDate(i.published_at)}</span>
    </span>
    <span class="row-end" aria-hidden="true">‹</span>
  </a>`).join('')}
</div>`);
}

/* ===================================================================== */
/* Search                                                                */
/* ===================================================================== */

export function searchPage(d: { query: string; hits: SearchHit[] }): string {
  const hasQuery = d.query.trim().length > 0;
  return page({ title: t.search.title, active: 'news' }, `
<div class="card">
  <h2 style="margin-block-start:0">${esc(t.search.title)}</h2>
  <form method="get" action="/search" role="search" class="searchbar">
    <input name="q" type="search" inputmode="search" value="${esc(d.query)}"
           placeholder="${esc(t.search.placeholder)}" autofocus
           aria-label="${esc(t.search.title)}">
    <button class="btn" type="submit">🔎 ${esc(t.search.submit)}</button>
  </form>
  <p class="hint">${esc(t.search.hint)}</p>
</div>

<div class="card">
  ${!hasQuery
    ? emptyWithHint('🔎', t.search.emptyQuery, t.search.hint)
    : d.hits.length === 0
      ? emptyWithHint('🔎', msg(t.search.noResults, { q: d.query }), t.search.noResultsHint)
      : `<p class="muted">${esc(msg(t.search.resultCount, { n: d.hits.length }))}</p>` +
        d.hits.map(h => `
  <a class="row row-link" href="${h.kind === 'album'
      ? `/albums/${esc(h.id)}` : `/news/${encodeURIComponent(h.slug)}`}">
    <span class="ico" aria-hidden="true">${h.kind === 'album' ? '📸' : '📰'}</span>
    <span class="row-body">
      <b>${esc(h.title_ar)}</b>
      <span class="muted">${h.published_at ? arDate(h.published_at) : ''}</span>
      ${h.matched_in_attachment
        ? `<span class="pill pill-info">📎 ${esc(t.search.inAttachment)}</span>` : ''}
      <span class="muted snippet">${esc(h.snippet_ar)}</span>
    </span>
  </a>`).join('')}
</div>`);
}

/* ===================================================================== */
/* Albums                                                                */
/* ===================================================================== */

export function albumsPage(d: { albums: AlbumSummary[]; canCreate: boolean }): string {
  return page({ title: t.albums.title, active: 'news' }, `
<div class="card">
  <h2 style="margin-block-start:0">${esc(t.albums.title)}</h2>
  <p class="muted">${esc(t.albums.subtitle)}</p>
</div>
${d.albums.length === 0
  ? `<div class="card">${emptyWithHint('📸', t.albums.empty, t.albums.emptyHint)}</div>`
  : `<div class="card">${d.albums.map(a => `
  <a class="row row-link" href="/albums/${esc(a.id)}">
    <span class="ico" aria-hidden="true">📸</span>
    <span class="row-body">
      <b>${esc(a.title_ar)}</b>
      <span class="muted">
        ${a.happened_on ? arDate(a.happened_on) : ''} ·
        ${esc(msg(t.albums.photoCount, { n: a.photo_count }))}
      </span>
      ${a.expense_amount !== null
        ? `<span class="muted">${esc(t.albums.linkedExpense)}: <b>${money(Number(a.expense_amount))}</b></span>`
        : ''}
    </span>
    <span class="row-end" aria-hidden="true">‹</span>
  </a>`).join('')}</div>`}`);
}

export function albumPage(d: {
  album: AlbumSummary & {
    photos: Array<{ id: string; storage_key: string; caption_ar: string | null; taken_at: string | null }>;
  };
}): string {
  const a = d.album;
  return page({ title: a.title_ar, active: 'news' }, `
<a class="backlink" href="/albums">→ ${esc(t.albums.title)}</a>
<div class="card">
  <h2 style="margin-block-start:0">${esc(a.title_ar)}</h2>
  <p class="muted">
    ${a.happened_on ? arDate(a.happened_on) : ''} ·
    ${esc(msg(t.albums.photoCount, { n: a.photo_count }))}
  </p>
  ${a.description_ar ? `<p>${esc(a.description_ar)}</p>` : ''}
  ${a.expense_amount !== null ? `
  <div class="callout">
    <b>${esc(t.albums.linkedExpense)}</b>
    <p class="muted" style="margin:0">
      ${esc(a.expense_description ?? '')} — <b>${money(Number(a.expense_amount))}</b>
    </p>
  </div>` : ''}
</div>
<div class="card">
  <div class="photogrid">
    ${a.photos.map(p => `
    <figure class="photo">
      <img src="/api/files/${esc(p.storage_key)}" alt="${esc(p.caption_ar ?? a.title_ar)}"
           loading="lazy" decoding="async" width="400" height="300">
      ${p.caption_ar ? `<figcaption>${esc(p.caption_ar)}</figcaption>` : ''}
    </figure>`).join('')}
  </div>
</div>`);
}

/* ===================================================================== */
/* Maintenance tickets                                                   */
/* ===================================================================== */

export function maintenancePage(d: {
  tickets: TicketSummary[];
  isStaff: boolean;
  units: Array<{ id: string; label: string }>;
  error?: string;
}): string {
  return page({ title: t.maintenance.title, active: 'news' }, `
<div class="card">
  <h2 style="margin-block-start:0">${esc(t.maintenance.title)}</h2>
  <p class="muted">${esc(t.maintenance.subtitle)}</p>
</div>

<details class="card" ${d.error ? 'open' : ''}>
  <summary class="summary-btn">🛠️ ${esc(t.maintenance.report)}</summary>
  ${d.error ? `<div class="banner warn">${esc(d.error)}</div>` : ''}
  <form method="post" action="/maintenance">
    <div class="field">
      <label for="mt">${esc(t.maintenance.titleLabel)}</label>
      <input id="mt" name="title" required maxlength="120"
             placeholder="${esc(t.maintenance.titlePlaceholder)}">
    </div>
    <div class="field">
      <label for="md">${esc(t.maintenance.detailsLabel)}</label>
      <textarea id="md" name="details" rows="3" maxlength="1000"></textarea>
    </div>
    <div class="field">
      <label for="mu">${esc(t.maintenance.unitLabel)}</label>
      <select id="mu" name="unitId">
        <option value="">${esc(t.maintenance.sharedArea)}</option>
        ${d.units.map(u => `<option value="${esc(u.id)}">${esc(u.label)}</option>`).join('')}
      </select>
    </div>
    <button class="btn" type="submit">${esc(t.maintenance.submit)}</button>
  </form>
</details>

<div class="card">
  <h3 style="margin-block-start:0">${esc(d.isStaff ? t.maintenance.allTickets : t.maintenance.myTickets)}</h3>
  ${d.tickets.length === 0
    ? emptyWithHint('🛠️', t.maintenance.empty, t.maintenance.emptyHint)
    : d.tickets.map(k => `
  <div class="row">
    <span class="ico" aria-hidden="true">🛠️</span>
    <span class="row-body">
      <b>${esc(k.title_ar)}</b>
      <span class="muted">
        ${num(k.ticket_no)} · ${arDate(k.created_at)}
        ${k.unit_label ? ` · ${esc(k.unit_label)}` : ` · ${esc(t.maintenance.sharedArea)}`}
        ${k.reporter_name ? ` · ${esc(k.reporter_name)}` : ''}
      </span>
      ${k.resolution_ar
        ? `<span class="muted">${esc(t.maintenance.resolution)}: ${esc(k.resolution_ar)}</span>` : ''}
    </span>
    <span class="row-end">
      ${ticketChip(k.status)}
    </span>
  </div>
  ${d.isStaff && k.status !== 'closed' && k.status !== 'rejected' ? `
  <form method="post" action="/maintenance/${esc(k.id)}/status" class="inline-form">
    <select name="next" aria-label="${esc(t.maintenance.advance)}">
      ${(['acknowledged', 'in_progress', 'resolved', 'closed', 'rejected'] as TicketStatus[])
        .map(s => `<option value="${s}">${esc(t.maintenance.statusLabels[s])}</option>`).join('')}
    </select>
    <input name="resolution" placeholder="${esc(t.maintenance.resolution)}" maxlength="300">
    <button class="btn btn-2" type="submit">${esc(t.maintenance.advance)}</button>
  </form>` : ''}`).join('')}
</div>`);
}

/* ===================================================================== */
/* Admin: publish                                                        */
/* ===================================================================== */

export function adminContentPage(d: {
  drafts: PostSummary[];
  published: PostSummary[];
  albums: AlbumSummary[];
  canPublishMinutes: boolean;
  error?: string;
}): string {
  return page({ title: t.content.manage, active: 'news' }, `
<div class="card">
  <h2 style="margin-block-start:0">✍️ ${esc(t.content.title)}</h2>
  ${d.error ? `<div class="banner warn">${esc(d.error)}</div>` : ''}
  <form method="post" action="/admin/content">
    <div class="field">
      <label for="pt">${esc(t.content.tabs.all)}</label>
      <select id="pt" name="type" required>
        <option value="announcement">${esc(t.content.tabs.announcement)}</option>
        <option value="news">${esc(t.content.tabs.news)}</option>
        ${d.canPublishMinutes ? `
        <option value="decision">${esc(t.content.tabs.decision)}</option>
        <option value="minutes">${esc(t.content.tabs.minutes)}</option>` : ''}
      </select>
    </div>
    <div class="field">
      <label for="ptitle">${esc(t.maintenance.titleLabel)}</label>
      <input id="ptitle" name="title" required maxlength="160">
    </div>
    <div class="field">
      <label for="pbody">${esc(t.maintenance.detailsLabel)}</label>
      <textarea id="pbody" name="body" rows="6" maxlength="8000"></textarea>
    </div>
    <label class="check">
      <input type="checkbox" name="pin" value="1"> ${esc(t.content.pinned)}
    </label>
    <button class="btn" type="submit">📣 ${esc(t.content.publishCta)}</button>
  </form>
</div>

<div class="card">
  <h3 style="margin-block-start:0">${esc(t.content.tabs.all)}</h3>
  ${d.published.length === 0
    ? emptyWithHint('📭', t.content.empty, t.content.emptyHint)
    : d.published.map(p => `
  <div class="row">
    <span class="ico" aria-hidden="true">${POST_TYPE_ICON[p.type] ?? '📰'}</span>
    <span class="row-body">
      <b>${esc(p.title_ar)}</b>
      <span class="muted">${p.published_at ? arDate(p.published_at) : ''}</span>
    </span>
    <span class="row-end">
      <form method="post" action="/admin/content/${esc(p.id)}/pin" class="inline-form">
        <input type="hidden" name="pinned" value="${p.is_pinned ? '0' : '1'}">
        <button class="btn btn-2 btn-sm" type="submit">
          ${p.is_pinned ? '📌✕' : '📌'}
        </button>
      </form>
    </span>
  </div>`).join('')}
</div>`);
}

/* ===================================================================== */
/* Annual statement — CP-7                                               */
/* ===================================================================== */

/**
 * The print stylesheet is the feature here, not decoration. This page exists to
 * become a piece of paper (or a PDF via the browser's own print dialog), so at
 * print time the nav, the buttons and the demo banner have to disappear and the
 * table has to survive a page break with its header intact.
 */
const STATEMENT_PRINT_CSS = `
<style>
.stmt-head{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;
  align-items:flex-start;margin-block-end:16px}
.stmt-tot{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;
  margin-block:16px}
.stmt-tot div{background:var(--surface-2);border-radius:10px;padding:10px 12px}
.stmt-tot b{display:block;font-size:1.15rem;margin-block-start:2px}
.stmt-tot .lbl{font-size:.8rem;color:var(--ink-muted)}
.stmt-tot .due b{color:var(--danger)}
table.stmt{inline-size:100%;border-collapse:collapse;font-size:.9rem}
table.stmt th,table.stmt td{padding:8px 6px;border-block-end:1px solid var(--border);
  text-align:start;vertical-align:top}
table.stmt thead th{color:var(--ink-muted);font-size:.8rem}
table.stmt tfoot td{font-weight:700;border-block-start:2px solid var(--border)}
tr.k-waiver td,tr.k-pending td{color:var(--ink-muted)}
@media print{
  nav.bottom,.fab,.backlink,.no-print,.banner.demo{display:none!important}
  body{background:#fff;font-size:11pt;padding-block-end:0}
  .card{box-shadow:none;border:0;padding:0;margin-block-end:12px;break-inside:auto}
  table.stmt thead{display:table-header-group}
  tr{break-inside:avoid}
  @page{margin:14mm}
}
</style>`;

export function statementPage(d: {
  s: {
    unit_label: string; owner_names: string; year: string; generated_at: string;
    lines: Array<{ kind: string; date: string; reference: string;
                   description_ar: string; charge_piastres: number; paid_piastres: number }>;
    total_charged_piastres: number; total_paid_piastres: number;
    outstanding_piastres: number; pending_piastres: number; credit_balance_piastres: number;
  };
  years: string[];
  unitId: string;
}): string {
  const s = d.s;
  return page({ title: `كشف حساب ${s.year}`, active: 'myPayments' }, `
${STATEMENT_PRINT_CSS}
<a class="backlink" href="/payments">→ ${esc(t.nav.myPayments)}</a>
<div class="card">
  <div class="stmt-head">
    <div>
      <h2 style="margin:0">كشف حساب سنة ${num(s.year)}</h2>
      <p class="muted" style="margin:4px 0 0">
        ${esc(s.unit_label)}${s.owner_names ? ` · ${esc(s.owner_names)}` : ''}
      </p>
      <p class="muted" style="margin:2px 0 0;font-size:.8rem">
        اتطبع في ${arDate(s.generated_at)} — بوابة قرية الأطباء
      </p>
    </div>
    <div class="no-print btn-row">
      <button class="btn btn-2" onclick="window.print()">🖨️ اطبع أو احفظ PDF</button>
    </div>
  </div>

  <div class="no-print" style="margin-block-end:12px">
    ${d.years.map(y => `<a class="tab${y === s.year ? ' on' : ''}"
      href="/units/${esc(d.unitId)}/statement?year=${esc(y)}"
      style="display:inline-flex;margin-inline-end:6px">${num(y)}</a>`).join('')}
  </div>

  <div class="stmt-tot">
    <div><span class="lbl">المطلوب</span><b>${money(s.total_charged_piastres)}</b></div>
    <div><span class="lbl">المدفوع والمعتمد</span><b>${money(s.total_paid_piastres)}</b></div>
    <div class="due"><span class="lbl">المتبقي عليك</span><b>${money(s.outstanding_piastres)}</b></div>
    ${s.pending_piastres > 0
      ? `<div><span class="lbl">تحت المراجعة (مش محسوب)</span><b>${money(s.pending_piastres)}</b></div>`
      : ''}
    ${s.credit_balance_piastres > 0
      ? `<div><span class="lbl">رصيد دائن ليك</span><b>${money(s.credit_balance_piastres)}</b></div>`
      : ''}
  </div>

  ${s.lines.length === 0
    ? emptyWithHint('🧾', 'مفيش حركات في السنة دي', 'أول ما يتسجّل عليك اشتراك أو تبعت إيصال هيظهر هنا.')
    : `<table class="stmt">
    <thead><tr>
      <th>التاريخ</th><th>البيان</th><th>المرجع</th>
      <th style="text-align:end">مطلوب</th><th style="text-align:end">مدفوع</th>
    </tr></thead>
    <tbody>
      ${s.lines.map(l => `<tr class="k-${l.kind}">
        <td>${num(l.date)}</td>
        <td>${esc(l.description_ar)}</td>
        <td>${l.reference === '—' ? '—' : num(l.reference)}</td>
        <td style="text-align:end">${l.charge_piastres ? money(l.charge_piastres) : '—'}</td>
        <td style="text-align:end">${l.paid_piastres ? money(l.paid_piastres) : '—'}</td>
      </tr>`).join('')}
    </tbody>
    <tfoot><tr>
      <td colspan="3">الإجمالي</td>
      <td style="text-align:end">${money(s.total_charged_piastres)}</td>
      <td style="text-align:end">${money(s.total_paid_piastres)}</td>
    </tr></tfoot>
  </table>`}

  <p class="muted" style="margin-block-start:14px;font-size:.8rem">
    الإيصالات اللي لسه تحت المراجعة بتظهر في الكشف بس مش بتتحسب في المدفوع،
    عشان الرقم اللي قدامك يبقى هو اللي القرية استلمته فعلًا.
  </p>
</div>`);
}

/** An owner of more than one flat picks which statement they meant. */
export function pickUnitPage(d: { units: Array<{ id: string; label: string }> }): string {
  return page({ title: 'كشف الحساب', active: 'myPayments' }, `
<a class="backlink" href="/payments">→ ${esc(t.nav.myPayments)}</a>
<div class="card">
  <h2 style="margin-block-start:0">كشف حساب أي وحدة؟</h2>
  <p class="muted">إنت مالك أكتر من وحدة — اختار الوحدة اللي عايز كشفها.</p>
  ${d.units.map(u => `
  <a class="row row-link" href="/units/${esc(u.id)}/statement">
    <span class="ico" aria-hidden="true">🏢</span>
    <span class="row-body"><b>${esc(u.label)}</b></span>
    <span class="row-end" aria-hidden="true">‹</span>
  </a>`).join('')}
</div>`);
}

/* ===================================================================== */
/* Admin: members & first activation                                     */
/* ===================================================================== */

/**
 * The screen that makes onboarding a village possible from the product.
 *
 * People who have never logged in are listed FIRST — that ordering is the
 * whole job of this page. A board secretary working through 204 residents
 * needs "who is still outside?" at the top, not an alphabetical list they have
 * to scan for the ones without a tick.
 *
 * A freshly issued link is shown once, in full, with a warning that says so.
 * Only its hash is stored, so "show it to me again" is not a feature that was
 * left out — it is a thing the system genuinely cannot do.
 */
export function membersPage(d: {
  members: Array<{
    id: string; full_name: string; role: string; unit_label: string | null;
    passkeys: number; last_login_at: string | null; link_pending: number;
  }>;
  issued?: { name: string; url: string; expiresAt: string };
  /** A temporary password, shown once for the same reason the link is. */
  issuedPassword?: { name: string; password: string };
  error?: string;
  /** The name filter currently applied, echoed back into the box. */
  q?: string;
}): string {
  const waiting = d.members.filter(m => m.passkeys === 0);
  const active = d.members.filter(m => m.passkeys > 0);

  // `profiles.role` is an English slug because it is a database column and a
  // capability key; it is not a label. Printing it raw put "finance_reviewer"
  // in front of a resident on an all-Arabic screen. Unknown values fall back to
  // the slug rather than to an empty cell — a role nobody named is still worth
  // seeing, and it will be obvious it needs a translation.
  const roleAr = (r: string) =>
    (t.members.roles as Record<string, string>)[r] ?? r;

  const row = (m: typeof d.members[number]) => `
  <div class="row">
    <span class="ico" aria-hidden="true">${m.passkeys > 0 ? '✅' : m.link_pending > 0 ? '📨' : '👤'}</span>
    <span class="row-body">
      <b>${esc(m.full_name)}</b>
      <span class="muted">
        ${esc(m.unit_label ?? t.members.noUnit)} · ${esc(roleAr(m.role))}
        ${m.last_login_at
          ? ` · ${esc(t.members.lastLogin)} ${arDate(m.last_login_at)}`
          : ` · ${esc(t.members.never)}`}
      </span>
      ${m.passkeys === 0 && m.link_pending > 0
        ? `<span class="chip chip-info">📨 ${esc(t.members.linkPending)}</span>` : ''}
    </span>
    <span class="row-end">
      ${m.passkeys > 0
        ? `<span class="chip chip-ok">✔ ${esc(t.members.hasPasskey)}</span>`
        : `<form method="post" action="/admin/members/${esc(m.id)}/activate" class="inline-form">
             <button class="btn btn-2 btn-sm" type="submit">🔗 ${
               esc(m.link_pending > 0 ? t.members.reissue : t.members.issue)}</button>
           </form>`}
      <!-- Offered for EVERYBODY, not only those without a passkey: the case it
           exists for is «بصمته كانت شغّالة وبقت مش شغّالة», which is a person
           who already has one. -->
      <form method="post" action="/admin/members/${esc(m.id)}/password" class="inline-form">
        <button class="btn btn-2 btn-sm" type="submit">${esc(t.members.issuePassword)}</button>
      </form>
    </span>
  </div>`;

  return page({ title: t.members.title, active: 'home' }, `
<div class="card">
  <h2 style="margin-block-start:0">${esc(t.members.title)}</h2>
  <p class="muted">${esc(t.members.subtitle)}</p>
  ${d.error ? `<div class="banner warn">${esc(d.error)}</div>` : ''}

  <!-- GET, so a filtered list is a URL the board can bookmark or send to each
       other, and the back button behaves. No script: typing a name and pressing
       enter is the whole interaction. -->
  <form method="get" action="/admin/members" role="search">
    <div class="field">
      <label for="mq">${esc(t.members.find)}</label>
      <input id="mq" name="q" type="search" autocomplete="off"
             value="${esc(d.q ?? '')}" placeholder="${esc(t.members.find)}">
    </div>
    <button class="btn btn-2" type="submit">🔍 ${esc(t.members.findGo)}</button>
    ${d.q ? `<a class="btn btn-2" href="/admin/members">${esc(t.members.findClear)}</a>` : ''}
  </form>
</div>

${d.issuedPassword ? `
<div class="card" style="border-inline-start:5px solid var(--accent)">
  <h3 style="margin-block-start:0">🔑 ${esc(msg(t.members.passwordReady, {
    name: d.issuedPassword.name }))}</h3>
  <div class="banner warn">${esc(t.members.passwordOnce)}</div>
  <p style="word-break:break-all;background:var(--surface-2);padding:12px;border-radius:10px;
            font-size:1.15rem;letter-spacing:.08em;direction:ltr;text-align:center">${
    num(d.issuedPassword.password)}</p>
  <p class="hint">${esc(t.members.passwordWhy)}</p>
</div>` : ''}

${d.issued ? `
<div class="card" style="border-inline-start:5px solid var(--ok)">
  <h3 style="margin-block-start:0">🔗 ${esc(msg(t.members.linkReady, { name: d.issued.name }))}</h3>
  <div class="banner warn">${esc(t.members.linkOnce)}</div>
  <p style="word-break:break-all;background:var(--surface-2);padding:12px;border-radius:10px;
            font-size:.9rem;direction:ltr;text-align:start">${esc(d.issued.url)}</p>
  <p class="muted">${esc(msg(t.members.linkExpires, { when: '' }))} ${
    d.issued.expiresAt ? arDate(d.issued.expiresAt) : ''}</p>
  <p class="hint">${esc(t.members.copyHint)}</p>
</div>` : ''}

<div class="card">
  <h3 style="margin-block-start:0">⏳ ${esc(t.members.waiting)} — ${
    esc(msg(t.members.countWaiting, { n: waiting.length }))}</h3>
  ${waiting.length === 0
    ? d.q
      ? emptyWithHint('🔍', t.members.findNone, t.members.findNoneHint)
      : emptyWithHint('🎉', 'كل الأعضاء دخلوا البوابة', 'مفيش حد مستني تفعيل.')
    : waiting.map(row).join('')}
</div>

<div class="card">
  <h3 style="margin-block-start:0">✅ ${esc(t.members.active)} (${num(active.length)})</h3>
  ${active.length === 0
    ? emptyWithHint('👥', 'لسه محدش فعّل حسابه', 'ابعت لينك تفعيل لأي حد من فوق.')
    : active.map(row).join('')}
</div>`);
}
