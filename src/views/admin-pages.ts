/**
 * src/views/admin-pages.ts — the board's configuration screens.
 *
 * Fees, categories, roles, settings, staff and the audit log. Same rules as the
 * other two view files: server-rendered strings, no hydration, every number
 * through `num()`/`money()`, every string from `messages/ar.json`.
 *
 * ## These screens are for five or six people, not two hundred
 *
 * That changes the design, and it is worth saying so rather than quietly
 * copying the resident screens. A resident meets `/pay` once a year, panicking
 * slightly, on a phone, so it asks one question per screen. A board member
 * meets `/admin/fees` when they sit down to open the year, and what they need
 * is the whole state on one page — how many flats, how much, what is still
 * missing — because the mistake to prevent here is not "tapped the wrong
 * button", it is "published a subscription that billed 180 of 204 flats and
 * looked fine".
 *
 * So: denser, tabular, and everything dangerous states its consequence next to
 * the button rather than behind a confirm dialog nobody reads.
 */

import { page, t, msg, esc, num, money, arDate } from './layout.js';
import type { FeePeriodRow, DueRow } from '../../lib/db/fees.js';
import type {
  CategoryRow, PersonRow, SettingsRow, StaffRow, AuditRow,
  MyAccount, JournalEntryRow, JournalLineRow,
} from '../../lib/db/admin.js';

/** Same shape as `layout.emptyState`, with a second explanatory line and no
 *  call to action — most of these screens are empty because nobody has done
 *  the thing yet, and the thing is on the same page. */
function empty(icon: string, text: string, hint: string): string {
  return `<div class="empty"><div class="big" aria-hidden="true">${icon}</div>`
       + `<p>${esc(text)}</p><p class="muted">${esc(hint)}</p></div>`;
}

function banner(kind: 'ok' | 'warn' | 'info', body: string): string {
  return `<div class="banner ${kind === 'ok' ? 'ok' : kind}">${esc(body)}</div>`;
}

/* ===================================================================== */
/* /admin/fees                                                           */
/* ===================================================================== */

export function feesPage(d: {
  periods: FeePeriodRow[];
  categories: { id: string; name_ar: string; kind: string }[];
  years: { id: string; name_ar: string; starts_on: string; ends_on: string }[];
  flash?: string;
  error?: string;
}): string {
  const row = (f: FeePeriodRow) => `
  <div class="card" style="border-inline-start:5px solid ${
    f.is_published ? 'var(--ok)' : 'var(--warn)'}">
    <div class="row-head">
      <h3 style="margin-block-start:0">${esc(f.name_ar)}</h3>
      <span class="chip ${f.is_published ? 'ok' : 'warn'}">${
        esc(f.is_published ? t.fees.published : t.fees.draft)}</span>
    </div>
    <p class="muted">${esc(f.category_ar)} · ${arDate(f.starts_on)} → ${arDate(f.ends_on)}
      · ${esc(t.fees.dueOn)} ${arDate(f.due_on)}</p>

    <div class="tiles">
      <div class="tile" style="--tc:var(--brand);--tsoft:var(--brand-soft)">
        <div class="lbl">${esc(t.fees.units)}</div>
        <div class="v">${num(f.unit_count)}</div>
      </div>
      <div class="tile" style="--tc:var(--ok);--tsoft:var(--ok-soft)">
        <div class="lbl">${esc(t.fees.total)}</div>
        <div class="v">${money(f.total_piastres)}</div>
      </div>
    </div>
    ${f.waived_piastres > 0
      ? `<p class="muted">${esc(t.fees.waived)}: ${money(f.waived_piastres)}</p>` : ''}

    ${f.missing_units > 0 ? `
    <div class="banner warn">
      ⚠️ ${num(f.missing_units)} ${esc(t.fees.missing)} — ${esc(t.fees.missingHint)}
    </div>` : ''}

    <div class="btn-row">
      <a class="btn btn-2" href="/admin/fees/${esc(f.id)}">${esc(t.fees.review)}</a>
      ${f.is_published ? '' : `
      <form method="post" action="/admin/fees/${esc(f.id)}/generate" class="inline-form">
        <button class="btn btn-2" type="submit">🧮 ${
          esc(f.unit_count > 0 ? t.fees.regenerate : t.fees.generate)}</button>
      </form>
      ${f.unit_count > 0 ? `
      <form method="post" action="/admin/fees/${esc(f.id)}/publish" class="inline-form">
        <button class="btn" type="submit">📣 ${esc(t.fees.publish)}</button>
      </form>` : ''}`}
    </div>
    ${f.is_published ? '' : `<p class="hint">${esc(t.fees.publishWarn)}</p>`}
  </div>`;

  return page({ title: t.fees.title, active: 'home' }, `
<div class="card">
  <h2 style="margin-block-start:0">${esc(t.fees.title)}</h2>
  <p class="muted">${esc(t.fees.subtitle)}</p>
  ${d.error ? banner('warn', d.error) : ''}
  ${d.flash ? banner('ok', d.flash) : ''}
</div>

<div class="card">
  <h3 style="margin-block-start:0">➕ ${esc(t.fees.newTitle)}</h3>
  <form method="post" action="/admin/fees">
    <div class="field">
      <label for="fname">${esc(t.fees.name)}</label>
      <input id="fname" name="name" required placeholder="${esc(t.fees.nameHint)}">
    </div>
    <div class="field">
      <label for="fcat">${esc(t.fees.category)}</label>
      <select id="fcat" name="category" required>
        ${d.categories.map(c =>
          `<option value="${esc(c.id)}">${esc(c.name_ar)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="fyear">${esc(t.fees.year)}</label>
      <select id="fyear" name="year" required>
        ${d.years.map(y =>
          `<option value="${esc(y.id)}">${esc(y.name_ar)}</option>`).join('')}
      </select>
    </div>
    <div class="field-row">
      <div class="field">
        <label for="fstart">${esc(t.fees.startsOn)}</label>
        <input id="fstart" name="starts_on" type="date" required>
      </div>
      <div class="field">
        <label for="fend">${esc(t.fees.endsOn)}</label>
        <input id="fend" name="ends_on" type="date" required>
      </div>
    </div>
    <div class="field">
      <label for="fdue">${esc(t.fees.dueOn)}</label>
      <input id="fdue" name="due_on" type="date" required>
    </div>
    <div class="field">
      <label for="fbasis">${esc(t.fees.basis)}</label>
      <select id="fbasis" name="basis">
        <option value="per_unit">${esc(t.fees.basisPerUnit)}</option>
        <option value="per_sqm">${esc(t.fees.basisPerSqm)}</option>
      </select>
    </div>
    <div class="field">
      <label for="famount">${esc(t.fees.amount)}</label>
      <input id="famount" name="amount" inputmode="decimal" required placeholder="0.00"
             aria-describedby="famount-hint">
      <p class="hint" id="famount-hint">${esc(t.fees.amountHintUnit)}</p>
    </div>
    <button class="btn" type="submit">${esc(t.fees.create)}</button>
  </form>
</div>

${d.periods.length === 0
  ? `<div class="card">${empty('🧾', t.fees.empty, t.fees.emptyHint)}</div>`
  : d.periods.map(row).join('')}`);
}

export function feeDuesPage(d: {
  period: FeePeriodRow;
  dues: DueRow[];
  error?: string;
  flash?: string;
}): string {
  const row = (x: DueRow) => `
  <tr>
    <td>${esc(x.unit_label)}</td>
    <td>${esc(x.owner_name ?? '—')}</td>
    <td>${money(x.amount_piastres)}</td>
    <td>${x.waived_piastres > 0
      ? `<span class="chip warn">${money(x.waived_piastres)}</span>` : '—'}</td>
    <td>${money(x.paid_piastres)}</td>
    <td>
      <details>
        <summary class="btn btn-2 btn-sm">${esc(t.fees.waive)}</summary>
        <form method="post" action="/admin/fees/${esc(d.period.id)}/dues/${esc(x.id)}/waive">
          <div class="field">
            <label for="w-${esc(x.id)}">${esc(t.fees.waiveAmount)}</label>
            <input id="w-${esc(x.id)}" name="amount" inputmode="decimal" required
                   placeholder="${esc((x.amount_piastres / 100).toFixed(2))}">
          </div>
          <div class="field">
            <label for="r-${esc(x.id)}">${esc(t.fees.waiveReason)}</label>
            <textarea id="r-${esc(x.id)}" name="reason" rows="2" required></textarea>
          </div>
          <button class="btn btn-2" type="submit">${esc(t.fees.waiveSave)}</button>
        </form>
      </details>
    </td>
  </tr>`;

  return page({ title: t.fees.title, active: 'home' }, `
<div class="card">
  <h2 style="margin-block-start:0">${esc(msg(t.fees.duesTitle, { name: d.period.name_ar }))}</h2>
  <p class="muted">${esc(d.period.is_published ? t.fees.published : t.fees.draft)}
     · ${num(d.period.unit_count)} ${esc(t.fees.units)} · ${money(d.period.total_piastres)}</p>
  ${d.error ? banner('warn', d.error) : ''}
  ${d.flash ? banner('ok', d.flash) : ''}
  <p class="hint">${esc(t.fees.waiveHint)}</p>
  <a class="btn btn-2" href="/admin/fees">← ${esc(t.fees.back)}</a>
</div>

<div class="card">
  ${d.dues.length === 0
    ? empty('🏠', t.fees.empty, t.fees.emptyHint)
    : `<div class="table-wrap" tabindex="0"><table>
    <thead><tr>
      <th>${esc(t.fees.unit)}</th><th>${esc(t.fees.owner)}</th><th>${esc(t.fees.due)}</th>
      <th>${esc(t.fees.waived)}</th><th>${esc(t.fees.paid)}</th><th></th>
    </tr></thead>
    <tbody>${d.dues.map(row).join('')}</tbody>
  </table></div>`}
</div>`);
}

/* ===================================================================== */
/* /admin/categories                                                     */
/* ===================================================================== */

export function categoriesPage(d: {
  categories: CategoryRow[];
  accounts: { id: string; code: string; name_ar: string; type: string }[];
  funds: { id: string; name_ar: string; kind: string; is_spendable: number }[];
  flash?: string;
  error?: string;
}): string {
  const row = (c: CategoryRow) => `
  <div class="row">
    <span class="ico" aria-hidden="true">${esc(c.icon ?? (c.direction === 'income' ? '💰' : '💸'))}</span>
    <span class="row-body">
      <b>${esc(c.name_ar)}</b>
      <span class="muted">${esc(c.direction === 'income' ? t.categories.income : t.categories.expense)}
        · ${esc(c.account_code)} ${esc(c.account_name)}
        · ${esc(msg(t.categories.usage, { n: c.usage_count }))}</span>
      ${c.is_active ? '' : `<span class="chip mute">${esc(t.categories.retired)}</span>`}
    </span>
    <span class="row-end">
      <form method="post" action="/admin/categories/${esc(c.id)}/active" class="inline-form">
        <input type="hidden" name="active" value="${c.is_active ? '0' : '1'}">
        <button class="btn btn-2 btn-sm" type="submit">${
          esc(c.is_active ? t.categories.retire : t.categories.restore)}</button>
      </form>
    </span>
  </div>`;

  return page({ title: t.categories.title, active: 'home' }, `
<div class="card">
  <h2 style="margin-block-start:0">${esc(t.categories.title)}</h2>
  <p class="muted">${esc(t.categories.subtitle)}</p>
  ${d.error ? banner('warn', d.error) : ''}
  ${d.flash ? banner('ok', d.flash) : ''}
  <p class="hint">${esc(t.categories.retireHint)}</p>
</div>

<div class="card">
  <h3 style="margin-block-start:0">➕ ${esc(t.categories.newTitle)}</h3>
  <form method="post" action="/admin/categories">
    <div class="field">
      <label for="cname">${esc(t.categories.name)}</label>
      <input id="cname" name="name" required>
    </div>
    <div class="field">
      <label for="ckind">${esc(t.categories.kind)}</label>
      <select id="ckind" name="kind" required>
        <option value="operating_income">${esc(t.categories.kindOperating)}</option>
        <option value="deposit">${esc(t.categories.kindDeposit)}</option>
        <option value="contribution">${esc(t.categories.kindContribution)}</option>
        <option value="penalty">${esc(t.categories.kindPenalty)}</option>
        <option value="expense">${esc(t.categories.kindExpense)}</option>
      </select>
    </div>
    <div class="field">
      <label for="cacc">${esc(t.categories.account)}</label>
      <select id="cacc" name="account" required aria-describedby="cacc-hint">
        ${d.accounts.map(a =>
          `<option value="${esc(a.id)}">${esc(a.code)} — ${esc(a.name_ar)}</option>`).join('')}
      </select>
      <p class="hint" id="cacc-hint">${esc(t.categories.accountHint)}</p>
    </div>
    <div class="field">
      <label for="cfund">${esc(t.categories.fund)}</label>
      <select id="cfund" name="fund" aria-describedby="cfund-hint">
        ${d.funds.map(f =>
          `<option value="${esc(f.id)}">${esc(f.name_ar)}${
            f.is_spendable ? '' : ' — ' + esc(t.categories.notSpendable)}</option>`).join('')}
      </select>
      <p class="hint" id="cfund-hint">${esc(t.categories.fundHint)}</p>
    </div>
    <div class="field">
      <label for="cicon">${esc(t.categories.icon)}</label>
      <input id="cicon" name="icon" maxlength="4" placeholder="🔧">
    </div>
    <button class="btn" type="submit">${esc(t.categories.create)}</button>
  </form>
</div>

<div class="card">
  ${d.categories.length === 0
    ? empty('🏷️', t.categories.empty, t.categories.emptyHint)
    : d.categories.map(row).join('')}
</div>`);
}

/* ===================================================================== */
/* /admin/users                                                          */
/* ===================================================================== */

const ROLE_AR: Record<string, string> = {
  developer: 'المبرمج المؤسس', admin: 'مجلس الإدارة', operator: 'مشغّل',
  finance_reviewer: 'مراجع مالي', resident: 'ساكن',
};

export function usersPage(d: {
  people: PersonRow[];
  me: string;
  canAssignAdmin: boolean;
  /** Flats the CREATE form can attach. One instance on the page, not one per
   *  row — see the note on the row's unit editor. */
  units: Array<{ id: string; label: string }>;
  total: number;
  offset: number;
  limit: number;
  q?: string;
  flash?: string;
  error?: string;
}): string {
  const roleOptions = (current: string) =>
    (['resident', 'operator', 'finance_reviewer', 'admin'] as const)
      .filter(r => r !== 'admin' || d.canAssignAdmin)
      .map(r => `<option value="${r}" ${r === current ? 'selected' : ''}>${
        esc(ROLE_AR[r] ?? r)}</option>`).join('');

  const row = (p: PersonRow) => {
    const locked = p.role === 'developer' || p.id === d.me;
    return `
  <div class="row">
    <span class="ico" aria-hidden="true">${p.is_active ? '👤' : '🚫'}</span>
    <span class="row-body">
      <b>${esc(p.full_name)}</b>
      <span class="muted">${esc(ROLE_AR[p.role] ?? p.role)}
        · ${esc(p.unit_label ?? '—')}
        ${p.last_login_at ? ` · ${arDate(p.last_login_at)}` : ''}</span>
      ${p.is_active ? '' : `<span class="chip mute">${esc(t.users.inactive)}</span>`}
      ${p.id === d.me ? `<span class="chip">${esc(t.users.self)}</span>` : ''}
      ${p.role === 'developer' ? `<span class="chip">${esc(t.users.protected)}</span>` : ''}
    </span>
    <span class="row-end">
      ${locked ? '' : `
      <form method="post" action="/admin/users/${esc(p.id)}/role" class="inline-form">
        <select name="role" aria-label="${esc(t.users.role)}">${roleOptions(p.role)}</select>
        <button class="btn btn-2 btn-sm" type="submit">${esc(t.users.change)}</button>
      </form>
      <form method="post" action="/admin/users/${esc(p.id)}/active" class="inline-form">
        <input type="hidden" name="active" value="${p.is_active ? '0' : '1'}">
        <button class="btn btn-2 btn-sm" type="submit">${
          esc(p.is_active ? t.users.deactivate : t.users.activate)}</button>
      </form>`}
    </span>
  </div>
  <!-- Name and flat behind a <details> rather than inline: they are the rarer
       edits and this row already carries two controls. Still no JavaScript —
       the disclosure is the element, not a script. -->
  <details style="margin-block-end:10px">
    <summary class="btn btn-2 btn-sm">${esc(t.users.editTitle)} — ${esc(p.full_name)}</summary>
    <form method="post" action="/admin/users/${esc(p.id)}/rename" class="inline-form">
      <input name="name" value="${esc(p.full_name)}" aria-label="${esc(t.users.name)}"
             minlength="3" required>
      <button class="btn btn-2 btn-sm" type="submit">${esc(t.users.rename)}</button>
    </form>
    <!-- Two number boxes, not a picker. A <select> of every flat rendered 204
         options into each of 205 rows — 42,842 elements and a 3.3 MB page, on a
         screen whose design target is a five-year-old Android. This is also how
         the board says it out loud: «عمارة 22 شقة 4». -->
    <form method="post" action="/admin/users/${esc(p.id)}/unit" class="inline-form">
      <input name="building" inputmode="numeric" style="max-inline-size:7rem"
             aria-label="${esc(t.users.buildingNo)}" placeholder="${esc(t.users.buildingNo)}">
      <input name="flat" inputmode="numeric" style="max-inline-size:7rem"
             aria-label="${esc(t.users.flatNo)}" placeholder="${esc(t.users.flatNo)}">
      <button class="btn btn-2 btn-sm" type="submit">${esc(t.users.setUnit)}</button>
    </form>
    <form method="post" action="/admin/users/${esc(p.id)}/unit" class="inline-form">
      <button class="btn btn-2 btn-sm" type="submit">${esc(t.users.unitClear)}</button>
    </form>
    ${p.id === d.me ? `<p class="hint">${esc(t.users.cannotSelf)}</p>` : ''}
  </details>`;
  };

  return page({ title: t.users.title, active: 'home' }, `
<div class="card">
  <h2 style="margin-block-start:0">${esc(t.users.title)}</h2>
  <p class="muted">${esc(t.users.subtitle)}</p>
  ${d.error ? banner('warn', d.error) : ''}
  ${d.flash ? banner('ok', d.flash) : ''}
  <p class="hint">${esc(t.users.deactivateHint)}</p>
  <form method="get" action="/admin/users" role="search">
    <div class="field">
      <label for="uq">${esc(t.users.find)}</label>
      <input id="uq" name="q" type="search" value="${esc(d.q ?? '')}">
    </div>
    <button class="btn btn-2" type="submit">🔍 ${esc(t.users.findGo)}</button>
  </form>
</div>

<div class="card">
  <h3 style="margin-block-start:0">➕ ${esc(t.users.newTitle)}</h3>
  <p class="hint">${esc(t.users.newHint)}</p>
  <form method="post" action="/admin/users">
    <div class="field">
      <label for="np-name">${esc(t.users.name)}</label>
      <input id="np-name" name="name" minlength="3" required aria-describedby="np-name-h">
      <p class="hint" id="np-name-h">${esc(t.users.nameHint)}</p>
    </div>
    <div class="field">
      <label for="np-phone">${esc(t.users.phone)}</label>
      <input id="np-phone" name="phone" type="tel" inputmode="numeric" required
             placeholder="01012345678" aria-describedby="np-phone-h">
      <p class="hint" id="np-phone-h">${esc(t.users.phoneHint)}</p>
    </div>
    <div class="field">
      <label for="np-role">${esc(t.users.role)}</label>
      <select id="np-role" name="role">${roleOptions('resident')}</select>
    </div>
    <div class="field">
      <label for="np-unit">${esc(t.users.unit)}</label>
      <select id="np-unit" name="unit" aria-describedby="np-unit-h">
        <option value="">${esc(t.users.unitNone)}</option>
        ${d.units.map(u => `<option value="${esc(u.id)}">${esc(u.label)}</option>`).join('')}
      </select>
      <p class="hint" id="np-unit-h">${esc(t.users.unitHint)}</p>
    </div>
    <!-- Says what it does NOT do. Creating an account mints no credential, and
         an admin who expects the new person to be able to log in immediately
         reads the silence as a bug. -->
    <p class="hint">${esc(t.users.createdNoLink)}</p>
    <button class="btn" type="submit">${esc(t.users.create)}</button>
  </form>
</div>

<div class="card">
  <p class="muted">${msg(t.users.showing, {
    n: String(d.people.length), total: String(d.total) })}</p>
  ${d.total > d.people.length ? `<p class="hint">${esc(t.users.showingHint)}</p>` : ''}
  ${d.people.length === 0
    ? empty('🔍', t.users.empty, t.members.findNoneHint)
    : d.people.map(row).join('')}
  <div class="btn-row">
    ${d.offset > 0 ? `<a class="btn btn-2" href="/admin/users?${
      new URLSearchParams({ q: d.q ?? '', offset: String(Math.max(d.offset - d.limit, 0)) })
      }">${esc(t.users.back)}</a>` : ''}
    ${d.offset + d.people.length < d.total ? `<a class="btn btn-2" href="/admin/users?${
      new URLSearchParams({ q: d.q ?? '', offset: String(d.offset + d.limit) })
      }">${esc(t.users.more)}</a>` : ''}
  </div>
</div>`);
}

/* ===================================================================== */
/* /admin/settings                                                       */
/* ===================================================================== */

export function settingsPage(d: {
  s: SettingsRow; flash?: string; error?: string;
}): string {
  const field = (id: string, label: string, name: string, value: string | null, hint?: string) => `
    <div class="field">
      <label for="${id}">${esc(label)}</label>
      <input id="${id}" name="${name}" value="${esc(value ?? '')}"
             ${hint ? `aria-describedby="${id}-h"` : ''}>
      ${hint ? `<p class="hint" id="${id}-h">${esc(hint)}</p>` : ''}
    </div>`;

  return page({ title: t.settings.title, active: 'home' }, `
<div class="card">
  <h2 style="margin-block-start:0">${esc(t.settings.title)}</h2>
  <p class="muted">${esc(t.settings.subtitle)}</p>
  ${d.error ? banner('warn', d.error) : ''}
  ${d.flash ? banner('ok', d.flash) : ''}
  ${d.s.updated_at
    ? `<p class="muted">${esc(t.settings.lastUpdate)}: ${arDate(d.s.updated_at)}${
        d.s.updated_by_name ? ` — ${esc(d.s.updated_by_name)}` : ''}</p>`
    : ''}
</div>

<form method="post" action="/admin/settings">
  <div class="card">
    ${field('sname', t.settings.communityName, 'community_name_ar', d.s.community_name_ar)}
  </div>

  <div class="card">
    <h3 style="margin-block-start:0">🏦 ${esc(t.settings.payTitle)}</h3>
    <p class="muted">${esc(t.settings.payHint)}</p>
    ${field('sip', t.settings.instapay, 'instapay_handle', d.s.instapay_handle)}
    ${field('sbn', t.settings.bankName, 'bank_name_ar', d.s.bank_name_ar)}
    ${field('sba', t.settings.bankAccount, 'bank_account_no', d.s.bank_account_no)}
    ${field('svf', t.settings.vodafone, 'vodafone_cash_no', d.s.vodafone_cash_no)}
  </div>

  <div class="card">
    <h3 style="margin-block-start:0">⚖️ ${esc(t.settings.controlsTitle)}</h3>
    <div class="field">
      <label for="sth">${esc(t.settings.threshold)}</label>
      <input id="sth" name="threshold" inputmode="decimal" aria-describedby="sth-h"
             value="${esc((d.s.countersign_threshold_piastres / 100).toFixed(2))}">
      <p class="hint" id="sth-h">${esc(t.settings.thresholdHint)}</p>
    </div>
    <h3>🌙 ${esc(t.settings.quietTitle)}</h3>
    <div class="field-row">
      <div class="field">
        <label for="sqf">${esc(t.settings.quietFrom)}</label>
        <input id="sqf" name="quiet_from" type="time" value="${esc(d.s.notify_quiet_from)}">
      </div>
      <div class="field">
        <label for="sqt">${esc(t.settings.quietTo)}</label>
        <input id="sqt" name="quiet_to" type="time" value="${esc(d.s.notify_quiet_to)}">
      </div>
    </div>
    <p class="hint">${esc(t.settings.quietHint)}</p>
  </div>

  <div class="card" style="border-inline-start:5px solid var(--warn)">
    <h3 style="margin-block-start:0">📢 ${esc(t.settings.publishTitle)}</h3>
    <div class="field check">
      <label for="sus">
        <input id="sus" name="unit_status_public" type="checkbox" value="1"
               ${d.s.unit_status_public ? 'checked' : ''}>
        ${esc(t.settings.unitStatusPublic)}
      </label>
      <p class="hint">${esc(t.settings.unitStatusHint)}</p>
    </div>
    <div class="field check">
      <label for="ssn">
        <input id="ssn" name="staff_names_public" type="checkbox" value="1"
               ${d.s.staff_names_public ? 'checked' : ''}>
        ${esc(t.settings.staffNamesPublic)}
      </label>
      <p class="hint">${esc(t.settings.staffNamesHint)}</p>
    </div>
  </div>

  <div class="card">
    <button class="btn" type="submit">${esc(t.settings.save)}</button>
  </div>
</form>`);
}

/* ===================================================================== */
/* /admin/staff                                                          */
/* ===================================================================== */

export function staffPage(d: {
  staff: StaffRow[]; canEdit: boolean; flash?: string; error?: string;
}): string {
  const monthly = d.staff.filter(s => s.is_active)
    .reduce((n, s) => n + s.monthly_salary_piastres, 0);

  const row = (s: StaffRow) => `
  <div class="row">
    <span class="ico" aria-hidden="true">${s.is_active ? '👷' : '📴'}</span>
    <span class="row-body">
      <b>${esc(s.full_name ?? t.staffAdmin.hiddenName)}</b>
      <span class="muted">${esc(s.job_title_ar)}
        · ${money(s.monthly_salary_piastres)}
        ${s.started_on ? ` · ${arDate(s.started_on)}` : ''}</span>
      ${s.is_active ? '' : `<span class="chip mute">${esc(t.staffAdmin.ended)}${
        s.ended_on ? ` — ${arDate(s.ended_on)}` : ''}</span>`}
    </span>
    <span class="row-end">
      ${s.is_active && d.canEdit ? `
      <details>
        <summary class="btn btn-2 btn-sm">${esc(t.staffAdmin.end)}</summary>
        <form method="post" action="/admin/staff/${esc(s.id)}/end">
          <div class="field">
            <label for="e-${esc(s.id)}">${esc(t.staffAdmin.endedOn)}</label>
            <input id="e-${esc(s.id)}" name="ended_on" type="date" required>
          </div>
          <button class="btn btn-2" type="submit">${esc(t.staffAdmin.end)}</button>
        </form>
      </details>` : ''}
    </span>
  </div>`;

  return page({ title: t.staffAdmin.title, active: 'home' }, `
<div class="card">
  <h2 style="margin-block-start:0">${esc(t.staffAdmin.title)}</h2>
  <p class="muted">${esc(t.staffAdmin.subtitle)}</p>
  ${d.error ? banner('warn', d.error) : ''}
  ${d.flash ? banner('ok', d.flash) : ''}
  <div class="tile" style="--tc:var(--brand);--tsoft:var(--brand-soft)">
    <div class="lbl">${esc(t.staffAdmin.monthlyTotal)}</div>
    <div class="v">${money(monthly)}</div>
  </div>
</div>

${d.canEdit ? `
<div class="card">
  <h3 style="margin-block-start:0">➕ ${esc(t.staffAdmin.newTitle)}</h3>
  <form method="post" action="/admin/staff">
    <div class="field">
      <label for="stn">${esc(t.staffAdmin.name)}</label>
      <input id="stn" name="name" required>
    </div>
    <div class="field">
      <label for="stj">${esc(t.staffAdmin.job)}</label>
      <input id="stj" name="job" required>
    </div>
    <div class="field">
      <label for="sts">${esc(t.staffAdmin.salary)}</label>
      <input id="sts" name="salary" inputmode="decimal" required placeholder="0.00">
    </div>
    <div class="field">
      <label for="std">${esc(t.staffAdmin.startedOn)}</label>
      <input id="std" name="started_on" type="date">
    </div>
    <button class="btn" type="submit">${esc(t.staffAdmin.add)}</button>
  </form>
</div>` : ''}

<div class="card">
  ${d.staff.length === 0
    ? empty('👷', t.staffAdmin.empty, t.staffAdmin.emptyHint)
    : d.staff.map(row).join('')}
</div>`);
}

/* ===================================================================== */
/* /admin/audit                                                          */
/* ===================================================================== */

/**
 * Action names are `entity.verb` slugs — they are keys, and a board member
 * should not have to read `fee_period.publish`. Unknown actions fall back to
 * the slug: an action nobody translated is still worth showing, and showing it
 * raw makes the gap obvious rather than hiding the row.
 */
export const ACTION_AR: Record<string, string> = {
  'payment.review': 'راجع إيصال',
  'payment.reverse': 'ألغى إيصال',
  'payment.submit': 'قدّم إيصال',
  'expense.record': 'سجّل مصروف',
  'expense.countersign': 'وقّع على مصروف',
  'expense.post': 'رحّل مصروف',
  'expense.reverse': 'ألغى مصروف',
  'category.create': 'ضاف بند',
  'category.rename': 'غيّر اسم بند',
  'category.deactivate': 'قفل بند',
  'category.activate': 'رجّع بند',
  'fee_period.create': 'عمل اشتراك',
  'fee_period.generate': 'وزّع اشتراك على الوحدات',
  'fee_period.publish': 'نشر اشتراك',
  'due.waive': 'سجّل إعفاء',
  'user.assign_role': 'غيّر دور',
  'user.activate': 'رجّع حساب',
  'user.deactivate': 'أوقف حساب',
  'user.create': 'عمل حساب',
  'staff.add': 'ضاف موظف',
  'staff.end': 'أنهى خدمة موظف',
  'settings.update': 'غيّر الإعدادات',
  'session.revoke_all': 'قفل كل الجلسات',
  'phone.change': 'غيّر رقم موبايل',
  'recovery.request': 'طلب استرجاع حساب',
  'recovery.approve': 'وافق على استرجاع',
  'recovery.fulfil': 'نفّذ استرجاع',
  'delegate.grant': 'فوّض شخص',
  'delegate.revoke': 'سحب تفويض',
  'import.stage': 'حضّر استيراد ملّاك',
  'import.commit': 'نفّذ استيراد ملّاك',
  'post.publish': 'نشر خبر',
  'post.retract': 'سحب خبر',
  // Everything below was writing itself into «سجل التغييرات» in English —
  // `session.open`, `passkey.enroll`, `map.verify_feature` — on the one screen
  // whose entire job is to be readable by a board of doctors. Twenty-four of
  // the fifty-one actions `lib/db/` writes had no Arabic at all; the test in
  // tests/access/audit.test.ts now fails if a new one is added without it.
  'post.create': 'كتب خبر',
  'post.update': 'عدّل خبر',
  'post.unpin': 'شال تثبيت خبر',
  'post.attach': 'ضاف مرفق لخبر',
  'payment.approve': 'اعتمد إيصال',
  'session.open': 'دخل البوابة',
  'session.close': 'خرج من البوابة',
  'passkey.enroll': 'سجّل جهاز جديد',
  'passkey.revoke': 'سحب جهاز',
  'activation.issue': 'طلع لينك تفعيل',
  'expense.attach_invoice': 'رفع فاتورة لمصروف',
  'expense.remove_invoice': 'شال فاتورة مصروف',
  'expense.reverse_requested': 'طلب إلغاء مصروف',
  'period.close': 'قفل فترة مالية',
  'period.reopen': 'فتح فترة مالية تاني',
  'album.create': 'عمل ألبوم',
  'album.publish': 'نشر ألبوم',
  'album.safety_check': 'راجع صور الألبوم',
  'ticket.create': 'فتح بلاغ صيانة',
  'ticket.status': 'غيّر حالة بلاغ',
  'map.create_draft': 'عمل مسودة خريطة',
  'map.add_feature': 'ضاف عمارة على الخريطة',
  'map.verify_feature': 'أكّد موقع عمارة',
  'map.reject_feature': 'رفض موقع عمارة',
  'map.publish': 'نشر الخريطة',
  'credit.request': 'طلب رد رصيد لمالك',
  'credit.approve': 'وافق على رد رصيد',
  'credit.post': 'رحّل رد رصيد',
  'account.recover': 'استرجع حساب',
  'settlement.post': 'رحّل تسوية',
  'settlement.reverse': 'ألغى تسوية',
  'user.rename': 'صحّح اسم',
  'user.set_unit': 'ربط حساب بوحدة',
  'profile.update_own': 'عدّل بيانات تواصله',
  'password.issue': 'بعت كلمة سر مؤقتة',
  'password.change': 'غيّر كلمة سره',
  'password.clear': 'شال كلمة السر من حسابه',
  'recovery_code.reissue': 'جدّد أكواد الاسترجاع',
};

/** An action slug rendered in Arabic. Exported because the dashboard's activity
 *  feed shows the same events and must not invent a second vocabulary. */
export function auditActionAr(action: string): string {
  return ACTION_AR[action] ?? action;
}

/**
 * The table a row acted on, in Arabic.
 *
 * The column printed `payments`, `expenses`, `import_batches` — table names, to
 * a board of doctors reading an accountability screen. A log nobody can read is
 * not a log; the English name is kept only where no Arabic word exists, which
 * is a bug report, not a design.
 */
const ENTITY_AR: Record<string, string> = {
  payments: 'إيصال', expenses: 'مصروف', journal_entries: 'قيد', profiles: 'حساب',
  fee_periods: 'اشتراك', unit_dues: 'مستحق وحدة', categories: 'بند',
  staff: 'موظف', posts: 'خبر', settings: 'إعدادات', sessions: 'جلسات',
  passkeys: 'جهاز', import_batches: 'استيراد ملّاك', recovery_requests: 'طلب استرجاع',
  delegates: 'تفويض', phone_identifiers: 'رقم موبايل', albums: 'ألبوم',
  maintenance_tickets: 'بلاغ صيانة', reconciliations: 'مطابقة بنكية',
  map_features: 'الخريطة', resident_credits: 'رصيد مالك',
};

export function auditPage(d: { rows: AuditRow[] }): string {
  return page({ title: t.auditView.title, active: 'home' }, `
<div class="card">
  <h2 style="margin-block-start:0">${esc(t.auditView.title)}</h2>
  <p class="muted">${esc(t.auditView.subtitle)}</p>
</div>

<div class="card">
  ${d.rows.length === 0
    ? empty('📜', t.auditView.empty, t.auditView.emptyHint)
    : `<div class="table-wrap" tabindex="0"><table>
    <thead><tr>
      <th>${esc(t.auditView.when)}</th><th>${esc(t.auditView.who)}</th>
      <th>${esc(t.auditView.what)}</th><th>${esc(t.auditView.onWhat)}</th>
    </tr></thead>
    <tbody>${d.rows.map(r => `
      <tr>
        <td>${arDate(r.created_at)}</td>
        <td>${esc(r.actor_name ?? '—')}<br><span class="muted">${esc(ROLE_AR[r.actor_role] ?? r.actor_role)}</span></td>
        <td>${esc(ACTION_AR[r.action] ?? r.action)}</td>
        <td><span class="muted">${esc(ENTITY_AR[r.entity_table] ?? r.entity_table)}</span></td>
      </tr>`).join('')}</tbody>
  </table></div>`}
</div>`);
}

/* ===================================================================== */
/* /admin/settlements                                                    */
/* ===================================================================== */

/**
 * The three accounting cycles that had a data layer, a schema and 22 passing
 * tests, and no way in.
 *
 * Everything a treasurer needs to close a month is on one page: what the bank
 * says that the books do not, what the village owes owners, and whether the
 * year can be closed. They are on one page because they are one job — a period
 * cannot close while a difference is open, and discovering that on a different
 * screen after clicking "close" is how a treasurer concludes the software is
 * broken.
 */
const SETTLE_KIND_AR: Record<string, string> = {
  bank_fee: t.settle.kindBankFee,
  bank_interest: t.settle.kindBankInterest,
  timing: t.settle.kindTiming,
  unrecorded_in: t.settle.kindUnrecordedIn,
  unrecorded_out: t.settle.kindUnrecordedOut,
};

export interface SettlementRow {
  id: string; kind: string; amount_piastres: number; reason_ar: string;
  status: string; requested_by: string; requested_by_name: string;
  requested_at: string; period_id: string; as_of: string;
}
export interface CreditRow {
  credit_id: string; unit_id: string; remaining_piastres: number; unit_label: string;
}
export interface PeriodRow {
  id: string; name_ar: string; starts_on: string; ends_on: string;
  status: string; closed_by_name: string | null; reopen_reason_ar: string | null;
}

export function settlementsPage(d: {
  suspense: { balance_piastres: number; entries: number };
  settlements: SettlementRow[];
  credits: CreditRow[];
  periods: PeriodRow[];
  /** The caller, so a maker is never offered the button that approves their own. */
  me: string;
  canApprove: boolean;
  canClose: boolean;
  flash?: string;
  error?: string;
}): string {
  const settlement = (s: SettlementRow) => {
    const mine = s.requested_by === d.me;
    return `
  <div class="row">
    <span class="ico" aria-hidden="true">${s.kind === 'timing' ? '⏳' : '🏦'}</span>
    <span class="row-body">
      <b>${esc(SETTLE_KIND_AR[s.kind] ?? s.kind)} — ${money(s.amount_piastres)}</b>
      <span class="muted">${esc(s.reason_ar)}</span>
      <span class="muted">${esc(t.settle.requestedBy)} ${esc(s.requested_by_name)}
        · ${arDate(s.requested_at)}</span>
      ${mine ? `<span class="chip warn">${esc(t.settle.makerChecker)}</span>` : ''}
    </span>
    <span class="row-end">
      ${!d.canApprove || mine ? '' : s.kind === 'timing'
        ? `<details>
             <summary class="btn btn-2 btn-sm">${esc(t.settle.dismiss)}</summary>
             <p class="hint">${esc(t.settle.timingHint)}</p>
             <form method="post" action="/admin/settlements/${esc(s.id)}/dismiss">
               <div class="field">
                 <label for="n-${esc(s.id)}">${esc(t.settle.dismissNote)}</label>
                 <textarea id="n-${esc(s.id)}" name="note" rows="2" required></textarea>
               </div>
               <button class="btn btn-2" type="submit">${esc(t.settle.done)}</button>
             </form>
           </details>`
        : `<form method="post" action="/admin/settlements/${esc(s.id)}/approve" class="inline-form">
             <input type="hidden" name="period" value="${esc(s.period_id)}">
             <button class="btn btn-2 btn-sm" type="submit">${esc(t.settle.approve)}</button>
           </form>`}
    </span>
  </div>`;
  };

  const period = (p: PeriodRow) => `
  <div class="row">
    <span class="ico" aria-hidden="true">${
      p.status === 'closed' ? '🔒' : p.status === 'reopened' ? '🔓' : '📂'}</span>
    <span class="row-body">
      <b>${esc(p.name_ar)}</b>
      <span class="muted">${arDate(p.starts_on)} → ${arDate(p.ends_on)}</span>
      <span class="chip ${p.status === 'closed' ? 'ok' : p.status === 'reopened' ? 'warn' : 'mute'}">${
        esc(p.status === 'closed' ? t.settle.statusClosed
          : p.status === 'reopened' ? t.settle.statusReopened : t.settle.statusOpen)}</span>
      ${p.reopen_reason_ar ? `<span class="muted">${esc(p.reopen_reason_ar)}</span>` : ''}
    </span>
    <span class="row-end">
      ${!d.canClose ? '' : p.status === 'closed'
        ? `<details>
             <summary class="btn btn-2 btn-sm">${esc(t.settle.reopen)}</summary>
             <form method="post" action="/admin/periods/${esc(p.id)}/reopen">
               <div class="field">
                 <label for="rr-${esc(p.id)}">${esc(t.settle.reopenReason)}</label>
                 <textarea id="rr-${esc(p.id)}" name="reason" rows="2" required></textarea>
               </div>
               <button class="btn btn-2" type="submit">${esc(t.settle.reopen)}</button>
             </form>
           </details>`
        : `<form method="post" action="/admin/periods/${esc(p.id)}/close" class="inline-form">
             <button class="btn btn-2 btn-sm" type="submit">${esc(t.settle.close)}</button>
           </form>`}
    </span>
  </div>`;

  return page({ title: t.settle.title, active: 'finance' }, `
<div class="card">
  <h2 style="margin-block-start:0">${esc(t.settle.title)}</h2>
  <p class="muted">${esc(t.settle.subtitle)}</p>
  ${d.error ? banner('warn', d.error) : ''}
  ${d.flash ? banner('ok', d.flash) : ''}
</div>

<div class="card">
  <div class="tile" style="--tc:${d.suspense.balance_piastres === 0 ? 'var(--ok)' : 'var(--warn)'};
       --tsoft:${d.suspense.balance_piastres === 0 ? 'var(--ok-soft)' : 'var(--warn-soft)'}">
    <div class="lbl"><span class="ico" aria-hidden="true">❔</span>${esc(t.settle.suspense)}</div>
    <div class="v">${money(d.suspense.balance_piastres)}</div>
    <div class="note">${esc(t.settle.suspenseHint)}</div>
  </div>
</div>

<div class="card">
  <h3 style="margin-block-start:0">🏦 ${esc(t.settle.openTitle)}</h3>
  ${d.settlements.length === 0
    ? empty('✅', t.settle.openEmpty, t.settle.openEmptyHint)
    : d.settlements.map(settlement).join('')}
</div>

<div class="card">
  <h3 style="margin-block-start:0">💳 ${esc(t.settle.creditsTitle)}</h3>
  <p class="muted">${esc(t.settle.creditsHint)}</p>
  ${d.credits.length === 0
    ? empty('👍', t.settle.creditsEmpty, t.settle.creditsEmptyHint)
    : d.credits.map(c => `
    <div class="row">
      <span class="ico" aria-hidden="true">💳</span>
      <span class="row-body">
        <b>${esc(c.unit_label)}</b>
        <span class="muted">${esc(t.settle.remaining)} ${money(c.remaining_piastres)}</span>
      </span>
    </div>`).join('')}
</div>

<div class="card">
  <h3 style="margin-block-start:0">📅 ${esc(t.settle.periodsTitle)}</h3>
  <p class="hint">${esc(t.settle.periodsHint)}</p>
  ${d.periods.map(period).join('')}
</div>`);
}

/* ===================================================================== */
/* /help — the destination of the button on every screen                 */
/* ===================================================================== */

/**
 * Every screen renders a floating «محتاج مساعدة؟» button pointing at `/help`,
 * and the route did not exist: the most visible control in the product, on all
 * 33 screens, returned 404. A resident who was already stuck pressed the help
 * button and got an error page.
 *
 * ## Why the phone number is a setting and not a lookup
 *
 * The obvious implementation reads the chairman's number out of
 * `phone_identifiers` and prints it. That is a C6 breach with extra steps: a
 * board member's number is in that table because it is how he LOGS IN, and
 * storing a login identifier is not consent to broadcast it to 204 flats. So
 * `office_phone` is separate, deliberate, and NULL until somebody publishes it
 * — the screen simply says no number has been set rather than inventing one.
 *
 * ## The five questions
 *
 * Not invented: they are the failure modes this codebase spent 28 sessions on.
 * Lost phone (the recovery path and why it is deliberately slow), a receipt
 * still pending, a figure that looks wrong, what الوديعة is, and who can see
 * what. The last line is an anti-phishing sentence, because a portal that
 * never asks for a password should say so out loud.
 */
export function helpPage(d: {
  contact: { label_ar: string | null; phone: string | null;
             whatsapp: string | null; hours_ar: string | null };
  canEditSettings: boolean;
}): string {
  const c = d.contact;
  const hasContact = Boolean(c.phone || c.whatsapp);
  const faq = ([['q1', 'a1'], ['q2', 'a2'], ['q3', 'a3'], ['q4', 'a4'], ['q5', 'a5']] as const)
    .map(([q, a]) => `
    <details>
      <summary>${esc(t.help[q])}</summary>
      <p class="prose">${esc(t.help[a])}</p>
    </details>`).join('');

  return page({ title: t.help.title, active: 'home' }, `
<div class="card">
  <h2 style="margin-block-start:0">💬 ${esc(t.help.title)}</h2>
  <p class="muted">${esc(t.help.subtitle)}</p>
</div>

<div class="card">
  <h3 style="margin-block-start:0">☎️ ${esc(t.help.contactTitle)}</h3>
  ${hasContact ? `
    ${c.label_ar ? `<p><b>${esc(c.label_ar)}</b></p>` : ''}
    <div class="btn-row">
      ${c.phone ? `<a class="btn" href="tel:${esc(c.phone)}">📞 ${esc(t.help.call)}
        <bdi dir="ltr" class="num">${esc(c.phone)}</bdi></a>` : ''}
      ${c.whatsapp ? `<a class="btn btn-2" href="https://wa.me/${esc(c.whatsapp.replace(/\D/g, ''))}">
        💬 ${esc(t.help.whatsapp)}</a>` : ''}
    </div>
    ${c.hours_ar ? `<p class="muted">${esc(t.help.hours)}: ${esc(c.hours_ar)}</p>` : ''}
  ` : `${empty('☎️', t.help.noContact,
        d.canEditSettings ? t.help.noContactHint : t.help.noContact)}
    ${d.canEditSettings
      ? `<a class="btn btn-2" href="/admin/settings">${esc(t.settings.title)}</a>` : ''}`}
</div>

<div class="card">
  <h3 style="margin-block-start:0">❓ ${esc(t.help.faqTitle)}</h3>
  ${faq}
</div>

<div class="card">
  <div class="banner info" style="margin-block:0">🔒 ${esc(t.help.safety)}</div>
</div>`);
}

/* ===================================================================== */
/* /me                                                                   */
/* ===================================================================== */

/**
 * The one screen that answers "which devices can open my account?".
 *
 * Passkeys are the entire authentication story here, so an enrolled device the
 * owner does not recognise is the only visible symptom of a compromised
 * account — and until now there was nowhere to look. That is the reason this
 * page exists; the name and unit are context, not the point.
 *
 * Revoking the LAST device is allowed and warned about in the same breath,
 * because the alternative — silently refusing — leaves somebody who believes
 * their account is compromised with no way to close it. The warning names the
 * consequence: they will need a fresh activation link from the board.
 */
export function mePage(d: {
  me: MyAccount;
  roleAr: string;
  /** null = no password on this account, which is the design's normal state. */
  password?: { isTemporary: boolean } | null;
  /** How many printed codes are still unused. A count, never the codes. */
  codesLeft?: number;
  /** Set ONLY on the response that generated them — the one and only render
   *  where the plaintext exists. Never read back from the database. */
  freshCodes?: string[];
  flash?: string;
  error?: string;
}): string {
  const only = d.me.devices.length === 1;
  return page({ title: t.me.title, active: 'home' }, `
<div class="card">
  <h2 style="margin-block-start:0">👤 ${esc(d.me.full_name)}</h2>
  <p class="muted">${esc(t.me.subtitle)}</p>
  ${d.error ? banner('warn', d.error) : ''}
  ${d.flash ? banner('ok', d.flash) : ''}
  <!-- Role, flat and login number used to be listed here too. They now live
       once, in the «بتتغيّر بالإدارة بس» card below, where the answer to
       «إزاي أغيّرها» is next to them. Twice on one screen taught nothing and
       made the page a third longer. -->
</div>

<div class="card">
  <h3 style="margin-block-start:0">🔑 ${esc(t.me.devices)}</h3>
  <p class="hint">${esc(t.me.devicesHint)}</p>
  ${d.me.devices.length === 0
    ? empty('🔑', t.me.noDevices, t.me.noDevicesHint)
    : d.me.devices.map(k => `
    <div class="row">
      <span class="ico" aria-hidden="true">📱</span>
      <span class="row-body">
        <b>${esc(k.device_label_ar)}</b>
        <span class="muted">${esc(t.me.added)} ${arDate(k.created_at)}${
          k.last_used_at ? ` · ${esc(t.me.lastUsed)} ${arDate(k.last_used_at)}` : ''}</span>
      </span>
      <span class="row-end">
        <details>
          <summary class="btn btn-2 btn-sm">${esc(t.me.revoke)}</summary>
          <p class="hint">${esc(only ? t.me.lastDevice : t.me.revokeHint)}</p>
          <form method="post" action="/me/devices/${esc(k.id)}/revoke">
            <button class="btn btn-danger" type="submit">${esc(t.me.revoke)}</button>
          </form>
        </details>
      </span>
    </div>`).join('')}
</div>

<!-- The two halves of the board's rule, side by side and named as such: what
     the owner may change, and what the account was CREATED from. Showing the
     second as a plain read-only list is the point — «إزاي أغيّر اسمي» has an
     answer on the screen instead of being a support conversation. -->
<div class="card">
  <h3 style="margin-block-start:0">✏️ ${esc(t.me.editTitle)}</h3>
  <p class="hint">${esc(t.me.editHint)}</p>
  <form method="post" action="/me">
    <div class="field">
      <label for="me-phone">${esc(t.me.contactPhone)}</label>
      <input id="me-phone" name="contact_phone" type="tel" inputmode="numeric"
             autocomplete="tel" value="${esc(d.me.contact_phone_e164 ?? '')}"
             placeholder="01012345678" aria-describedby="me-phone-hint">
      <p class="hint" id="me-phone-hint">${esc(t.me.contactPhoneHint)}</p>
    </div>
    <div class="field">
      <label for="me-channel">${esc(t.me.channel)}</label>
      <select id="me-channel" name="channel">
        ${(['whatsapp', 'sms', 'none'] as const).map(c => `<option value="${c}"${
          d.me.preferred_channel === c ? ' selected' : ''}>${esc(
          c === 'whatsapp' ? t.me.channelWhatsapp
          : c === 'sms' ? t.me.channelSms : t.me.channelNone)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="me-note">${esc(t.me.note)}</label>
      <input id="me-note" name="note" maxlength="200" dir="auto"
             value="${esc(d.me.contact_note_ar ?? '')}" aria-describedby="me-note-hint">
      <p class="hint" id="me-note-hint">${esc(t.me.noteHint)}</p>
    </div>
    <button class="btn" type="submit">${esc(t.me.savePrefs)}</button>
  </form>
</div>

<div class="card">
  <h3 style="margin-block-start:0">🔒 ${esc(t.me.lockedTitle)}</h3>
  <p class="hint">${esc(t.me.lockedHint)}</p>
  <div class="row">
    <span class="ico" aria-hidden="true">📛</span>
    <span class="row-body"><b>${esc(t.me.lockedName)}</b>
      <span class="muted">${esc(d.me.full_name)}</span></span>
  </div>
  <div class="row">
    <span class="ico" aria-hidden="true">🔑</span>
    <span class="row-body"><b>${esc(t.me.lockedPhone)}</b>
      <span class="muted">${d.me.phone_masked ? num(d.me.phone_masked) : '—'}</span></span>
  </div>
  <div class="row">
    <span class="ico" aria-hidden="true">🛡️</span>
    <span class="row-body"><b>${esc(t.me.lockedRole)}</b>
      <span class="muted">${esc(d.roleAr)}</span></span>
  </div>
  <div class="row">
    <span class="ico" aria-hidden="true">🏢</span>
    <span class="row-body"><b>${esc(t.me.lockedUnit)}</b>
      <span class="muted">${esc(d.me.unit_label ?? '—')}</span></span>
  </div>
</div>

<div class="card">
  <h3 style="margin-block-start:0">💰 ${esc(t.me.myMoney)}</h3>
  <div class="btn-row">
    <a class="btn btn-2" href="/payments">${esc(t.nav.myPayments)}</a>
    <a class="btn btn-2" href="/payments/statement">${esc(t.payments.downloadStatement)}</a>
  </div>
</div>

<div class="card">
  <h3 style="margin-block-start:0">🎛️ ${esc(t.me.prefs)}</h3>
  <p class="hint">${esc(t.me.prefsHint)}</p>
</div>

<!-- Two different sign-outs, and the difference is the whole point of showing
     both. The ordinary one ends THIS device; the second ends every device the
     person has, which is what you want when the phone is in somebody else's
     hand. Until now only the second existed, so "log out of my son's tablet"
     meant logging out of your own phone too. -->
<!-- The second way in. Passkeys are the design and this is the fallback for a
     phone that cannot hold one — so the card says which state the account is
     in, and a still-temporary password is called out in warning colours: it
     travelled through WhatsApp, and whoever sent it read it. -->
<div class="card">
  <h3 style="margin-block-start:0">🔑 ${esc(t.me.passwordTitle)}</h3>
  ${d.password == null
    ? `<p class="muted">${esc(t.me.passwordNone)}</p>`
    : `${d.password.isTemporary
        ? banner('warn', t.me.passwordTemp)
        : `<p class="muted">${esc(t.me.passwordMine)}</p>`}
    <form method="post" action="/me/password">
      <div class="field">
        <label for="pw-cur">${esc(t.me.currentPassword)}</label>
        <input id="pw-cur" name="current" type="password" autocomplete="current-password" required>
      </div>
      <div class="field">
        <label for="pw-new">${esc(t.me.newPassword)}</label>
        <input id="pw-new" name="next" type="password" autocomplete="new-password"
               minlength="8" required aria-describedby="pw-new-h">
        <p class="hint" id="pw-new-h">${esc(t.me.newPasswordHint)}</p>
      </div>
      <button class="btn" type="submit">${esc(t.me.changePassword)}</button>
    </form>
    <form method="post" action="/me/password/drop" style="margin-block-start:14px">
      <p class="hint">${esc(t.me.dropPasswordHint)}</p>
      <button class="btn btn-2" type="submit">${esc(t.me.dropPassword)}</button>
    </form>`}
</div>

<!-- The third way in, and the only one that survives losing the phone entirely.
     Codes used to be printed once, at activation, and never again: somebody who
     spent them, or lost the paper, or was given a password instead of an
     activation link had nothing — and the «ادخل بكود» box on the login screen
     was addressed to a person who could not exist. This is that place. -->
<div class="card">
  <h3 style="margin-block-start:0">🖨️ ${esc(t.me.codesTitle)}</h3>
  <p class="hint">${esc(t.me.codesHint)}</p>
  ${d.freshCodes && d.freshCodes.length > 0 ? `
  ${banner('ok', t.me.codesIssued)}
  <table><tbody>
    ${d.freshCodes.map(c => `<tr><td class="n">${num(c)}</td></tr>`).join('')}
  </tbody></table>
  <button class="btn btn-2" type="button" onclick="window.print()">${esc(t.me.codesPrint)}</button>
  ` : (d.codesLeft ?? 0) > 0
    ? `<div class="row">
    <span class="ico" aria-hidden="true">🎟️</span>
    <span class="row-body"><b>${esc(t.me.codesLeft)}</b>
      <span class="muted">${num(String(d.codesLeft ?? 0))}</span></span>
  </div>`
    : `<p class="muted">${esc(t.me.codesNone)}</p>`}
  <form method="post" action="/me/recovery-codes" style="margin-block-start:14px">
    <p class="hint">${esc(t.me.codesNewHint)}</p>
    <button class="btn${d.freshCodes ? ' btn-2' : ''}" type="submit">${esc(t.me.codesNew)}</button>
  </form>
</div>

<div class="card">
  <h3 style="margin-block-start:0">↪ ${esc(t.shell.signOut)}</h3>
  <form method="post" action="/logout">
    <p class="hint">${esc(t.me.signOutHint)}</p>
    <button class="btn btn-2" type="submit">${esc(t.shell.signOut)}</button>
  </form>
  <form method="post" action="/me/sessions/revoke" style="margin-block-start:14px">
    <p class="hint">${esc(t.me.signOutAllHint)}</p>
    <button class="btn btn-danger" type="submit">${esc(t.me.signOutAll)}</button>
  </form>
</div>`);
}

/* ===================================================================== */
/* /admin/ledger — دفتر القيود                                            */
/* ===================================================================== */

const SOURCE_AR: Record<string, string> = {
  payment: t.ledger.sourcePayment, expense: t.ledger.sourceExpense,
  adjustment: t.ledger.sourceAdjustment, opening_balance: t.ledger.sourceOpening,
  refund: t.ledger.sourceRefund, waiver: t.ledger.sourceWaiver,
  reclassification: t.ledger.sourceReclass,
};

/**
 * The journal, with each entry's lines one tap away.
 *
 * `/finance` answers "how much"; this answers "on what basis". A board asked to
 * approve last year's accounts needs to open the actual entries, and a
 * treasurer defending a figure needs to point at one — neither was possible
 * from the product, so the ledger existed and could only be read with
 * `sqlite3`.
 *
 * The lines live in a `<details>` per entry rather than on a second screen:
 * the question is almost always "what were the two sides of THIS one", and a
 * round trip per entry turns a five-minute review into an afternoon.
 */
export function ledgerPage(d: {
  entries: JournalEntryRow[];
  lines: Record<string, JournalLineRow[]>;
  /** Paging, because a year of a 204-flat village is ~250 entries and a screen
   *  that renders all of them is a seventeen-thousand-pixel wall nobody scrolls
   *  to the bottom of. `<a>` links, not script: the page number is in the URL,
   *  so a treasurer can send «الصفحة اللي فيها القيد ده» to another board
   *  member. */
  total: number;
  offset: number;
  limit: number;
}): string {
  const entry = (e: JournalEntryRow) => {
    const ls = d.lines[e.id] ?? [];
    const dr = ls.reduce((n, l) => n + l.debit_piastres, 0);
    const cr = ls.reduce((n, l) => n + l.credit_piastres, 0);
    return `
  <details class="card" style="border-inline-start:5px solid ${
    e.posted_at ? 'var(--ok)' : 'var(--warn)'}">
    <summary class="summary-btn">
      <span class="row-body">
        <b>${num(e.entry_no)} — ${esc(e.description_ar)}</b>
        <span class="muted">${arDate(e.entry_date)} · ${
          esc(SOURCE_AR[e.source_type] ?? e.source_type)} · ${money(e.amount_piastres)}</span>
      </span>
      <span class="row-end">
        ${e.is_reversal ? `<span class="chip warn">↩️ ${esc(t.ledger.reversal)}</span>` : ''}
        <span class="chip ${e.posted_at ? 'ok' : 'warn'}">${
          esc(e.posted_at ? t.ledger.posted : t.ledger.unposted)}</span>
      </span>
    </summary>
    <div class="table-wrap" tabindex="0"><table>
      <thead><tr>
        <th>${esc(t.ledger.account)}</th><th>${esc(t.ledger.debit)}</th>
        <th>${esc(t.ledger.credit)}</th><th>${esc(t.ledger.against)}</th>
      </tr></thead>
      <tbody>
        ${ls.map(l => `
        <tr>
          <td>${num(l.account_code)} ${esc(l.account_name)}
            ${l.memo_ar ? `<br><span class="muted">${esc(l.memo_ar)}</span>` : ''}</td>
          <td>${l.debit_piastres ? money(l.debit_piastres) : '—'}</td>
          <td>${l.credit_piastres ? money(l.credit_piastres) : '—'}</td>
          <td class="muted">${esc(l.unit_label ?? l.fund_name ?? '—')}</td>
        </tr>`).join('')}
        <tr>
          <td><b>${esc(t.ledger.balanced)}</b></td>
          <td><b>${money(dr)}</b></td>
          <td><b>${money(cr)}</b></td>
          <td>${dr === cr ? '✅' : '⚠️'}</td>
        </tr>
      </tbody>
    </table></div>
  </details>`;
  };

  const from = d.total === 0 ? 0 : d.offset + 1;
  const to = Math.min(d.offset + d.limit, d.total);
  const pager = `
<div class="card btn-row">
  ${d.offset > 0
    ? `<a class="btn btn-2" href="/admin/ledger?offset=${Math.max(d.offset - d.limit, 0)}">${
        esc(t.ledger.newer)}</a>` : ''}
  ${to < d.total
    ? `<a class="btn btn-2" href="/admin/ledger?offset=${d.offset + d.limit}">${
        esc(t.ledger.older)}</a>` : ''}
</div>`;

  return page({ title: t.ledger.title, active: 'finance' }, `
<div class="card">
  <h2 style="margin-block-start:0">📚 ${esc(t.ledger.title)}</h2>
  <p class="muted">${esc(t.ledger.subtitle)}</p>
  <p class="muted">${msg(t.ledger.showing, {
    from: String(from), to: String(to), total: String(d.total) })}</p>
  <div class="banner info">${esc(t.ledger.immutable)}</div>
</div>

${d.entries.length === 0
  ? `<div class="card">${empty('📚', t.ledger.empty, t.ledger.emptyHint)}</div>`
  : d.entries.map(entry).join('') + pager}`);
}

/* ===================================================================== */
/* /admin/import — استيراد سجل الملّاك                                     */
/* ===================================================================== */

/**
 * The owner register, imported from the product instead of from a terminal.
 *
 * `lib/import/owners.ts` and `lib/db/onboarding.ts` have parsed, staged and
 * committed owner registers since CP-2 — behind three JSON endpoints. A board
 * secretary holding the village's only copy of the register in an Excel file
 * could not use any of it, so the real path to 204 accounts was "send the file
 * to the developer", which is the failure mode the whole product exists to end.
 *
 * Two steps, never one: parse-and-show, then confirm. The screen states in the
 * banner that nothing has happened yet, because the thing an admin fears at
 * this moment is having already done something irreversible to 204 records.
 * Rows the parser could not read are listed separately with what to fix — they
 * are skipped, never guessed at (R-009).
 *
 * File input AND a paste box: «حفظ باسم CSV» is a step some people will not
 * find, and copying the rows straight out of Excel is the fallback that always
 * works. Both post to the same place.
 */
export function importPage(d: {
  batch?: {
    id: string;
    okCount: number;
    problemCount: number;
    unmappedHeaders: string[];
    rows: Array<{
      rowNo: number; fullName: string | null; buildingCode: string | null;
      unitNumber: string | null; phoneE164: string | null;
      status: string; problemAr: string | null;
    }>;
  };
  outcome?: { created: number; skipped: number; buildings: number; units: number };
  error?: string;
}): string {
  const ok = d.batch?.rows.filter(r => r.status === 'ok') ?? [];
  const bad = d.batch?.rows.filter(r => r.status !== 'ok') ?? [];

  return page({ title: t.importPage.title, active: 'home' }, `
<div class="card">
  <h2 style="margin-block-start:0">📥 ${esc(t.importPage.title)}</h2>
  <p class="muted">${esc(t.importPage.subtitle)}</p>
  ${d.error ? banner('warn', d.error) : ''}
  <p class="hint">${esc(t.importPage.how)}</p>

  <!-- multipart because a file is the common case; the textarea is the same
       field by another route, and the server takes whichever arrived. -->
  <form method="post" action="/admin/import" enctype="multipart/form-data">
    <div class="field">
      <label for="imp-file">${esc(t.importPage.fileLabel)}</label>
      <input id="imp-file" name="file" type="file" accept=".csv,.tsv,.txt,text/csv,text/plain">
      <p class="hint">${esc(t.importPage.fileHint)}</p>
    </div>
    <div class="field">
      <label for="imp-text">${esc(t.importPage.pasteLabel)}</label>
      <textarea id="imp-text" name="text" rows="6" dir="auto"
        placeholder="الاسم,رقم العمارة,رقم الشقة,رقم الموبايل"></textarea>
      <p class="hint">${esc(t.importPage.pasteHint)}</p>
    </div>
    <button class="btn" type="submit">${esc(t.importPage.preview)}</button>
  </form>
</div>

${d.outcome ? `
<div class="card" style="border-inline-start:5px solid var(--ok)">
  <h3 style="margin-block-start:0">✅ ${esc(t.importPage.done)}</h3>
  <div class="tiles">
    <div class="tile"><div class="lbl">${esc(t.importPage.created)}</div>
      <div class="v">${num(d.outcome.created)}</div></div>
    <div class="tile" style="--tc:var(--ink-muted);--tsoft:var(--surface-2)">
      <div class="lbl">${esc(t.importPage.skipped)}</div>
      <div class="v">${num(d.outcome.skipped)}</div></div>
    <div class="tile" style="--tc:var(--ink-muted);--tsoft:var(--surface-2)">
      <div class="lbl">${esc(t.importPage.newBuildings)}</div>
      <div class="v">${num(d.outcome.buildings)}</div></div>
    <div class="tile" style="--tc:var(--ink-muted);--tsoft:var(--surface-2)">
      <div class="lbl">${esc(t.importPage.newUnits)}</div>
      <div class="v">${num(d.outcome.units)}</div></div>
  </div>
  <p class="hint">${esc(t.importPage.nextStep)}</p>
  <a class="btn btn-2" href="/admin/members">${esc(t.importPage.toMembers)}</a>
</div>` : ''}

${!d.batch ? `
<div class="card">${empty('📄', t.importPage.empty, t.importPage.emptyHint)}</div>`
: d.batch.rows.length === 0 ? `
<div class="card">${empty('📄', t.importPage.noRows, t.importPage.emptyHint)}</div>` : `
<div class="card">
  <h3 style="margin-block-start:0">🔎 ${esc(t.importPage.previewTitle)}</h3>
  <div class="banner info">${esc(t.importPage.previewHint)}</div>
  <p class="muted">
    <span class="chip ok">${esc(t.importPage.ok)} ${num(d.batch.okCount)}</span>
    ${d.batch.problemCount > 0
      ? `<span class="chip warn">${esc(t.importPage.problem)} ${num(d.batch.problemCount)}</span>` : ''}
  </p>
  ${d.batch.unmappedHeaders.length > 0
    ? banner('warn', `${t.importPage.unmapped}: ${d.batch.unmappedHeaders.join('، ')}`) : ''}

  ${ok.length > 0 ? `<div class="table-wrap" tabindex="0"><table>
    <thead><tr>
      <th>${esc(t.importPage.rowNo)}</th><th>${esc(t.importPage.name)}</th>
      <th>${esc(t.importPage.building)}</th><th>${esc(t.importPage.unit)}</th>
      <th>${esc(t.importPage.phone)}</th>
    </tr></thead>
    <tbody>${ok.map(r => `
      <tr>
        <td>${num(r.rowNo)}</td><td>${esc(r.fullName ?? '—')}</td>
        <td>${num(r.buildingCode ?? '—')}</td><td>${num(r.unitNumber ?? '—')}</td>
        <td>${num(r.phoneE164 ?? '—')}</td>
      </tr>`).join('')}</tbody>
  </table></div>` : ''}

  ${d.outcome ? '' : `
  <form method="post" action="/admin/import/${esc(d.batch.id)}/confirm">
    <p class="hint">${esc(t.importPage.confirmHint)}</p>
    <button class="btn" type="submit"${ok.length === 0 ? ' disabled' : ''}>${
      esc(t.importPage.confirm)}</button>
  </form>`}
</div>

${bad.length > 0 ? `
<div class="card" style="border-inline-start:5px solid var(--warn)">
  <h3 style="margin-block-start:0">⚠️ ${esc(t.importPage.problemsTitle)}</h3>
  <p class="hint">${esc(t.importPage.problemsHint)}</p>
  <div class="table-wrap" tabindex="0"><table>
    <thead><tr>
      <th>${esc(t.importPage.rowNo)}</th><th>${esc(t.importPage.name)}</th>
      <th>${esc(t.importPage.state)}</th>
    </tr></thead>
    <tbody>${bad.map(r => `
      <tr>
        <td>${num(r.rowNo)}</td>
        <td>${esc(r.fullName ?? '—')}</td>
        <td>${esc(r.problemAr ?? r.status)}</td>
      </tr>`).join('')}</tbody>
  </table></div>
</div>` : ''}`}`);
}

/* ===================================================================== */
/* /admin/recoveries — الاستعادة والتفعيل                                  */
/* ===================================================================== */

/**
 * Assisted recovery, with both signatures visible.
 *
 * The flow existed and had no door: `requestRecovery`, `approveRecovery` and
 * `fulfilRecovery` were reachable only as JSON, which meant the one procedure
 * for "my phone was stolen and my account holds a year of payments" could not
 * be run by the board it was written for.
 *
 * The three steps stay three steps on the screen because they are three
 * decisions by two different people, and the database enforces the difference
 * (`CHECK (approved_by <> requested_by)`). The identity check is a required
 * free-text field rather than a checkbox for the same reason: a checkbox
 * records that somebody clicked, and what the record needs to hold is what
 * they actually did to be sure.
 *
 * Fulfilment revokes every session and passkey the person has, and the button
 * says so before it is pressed — that is the entire point of the procedure,
 * not a side effect, and an admin who does not expect it will read the result
 * as the portal breaking.
 */
export function recoveriesPage(d: {
  open: Array<{
    id: string; identity_check_ar: string; requested_at: string;
    requested_by: string; approved_by: string | null;
    target_name: string; target_unit: string | null;
    requested_by_name: string | null; approved_by_name: string | null;
  }>;
  /** Candidates for a new request — the people who already hold a device. */
  people: Array<{ id: string; full_name: string; unit_label: string | null }>;
  meId: string;
  flash?: string;
  error?: string;
}): string {
  const card = (r: typeof d.open[number]) => {
    const mine = r.requested_by === d.meId;
    return `
  <div class="card" style="border-inline-start:5px solid ${
    r.approved_by ? 'var(--ok)' : 'var(--warn)'}">
    <div class="row-head">
      <h3 style="margin-block-start:0">${esc(r.target_name)}</h3>
      <span class="chip ${r.approved_by ? 'ok' : 'warn'}">${
        esc(r.approved_by ? t.recoveries.approvedBy : t.recoveries.waitingSecond)}</span>
    </div>
    <p class="muted">${esc(r.target_unit ?? '—')}</p>
    <div class="row">
      <span class="ico" aria-hidden="true">📝</span>
      <span class="row-body"><b>${esc(t.recoveries.check)}</b>
        <span class="muted">${esc(r.identity_check_ar)}</span></span>
    </div>
    <div class="row">
      <span class="ico" aria-hidden="true">✍️</span>
      <span class="row-body"><b>${esc(t.recoveries.requestedBy)}</b>
        <span class="muted">${esc(r.requested_by_name ?? '—')} · ${arDate(r.requested_at)}</span></span>
    </div>
    ${r.approved_by ? `
    <div class="row">
      <span class="ico" aria-hidden="true">✅</span>
      <span class="row-body"><b>${esc(t.recoveries.approvedBy)}</b>
        <span class="muted">${esc(r.approved_by_name ?? '—')}</span></span>
    </div>
    <form method="post" action="/admin/recoveries/${esc(r.id)}/fulfil">
      <p class="hint">${esc(t.recoveries.fulfilHint)}</p>
      <button class="btn btn-danger" type="submit">${esc(t.recoveries.fulfil)}</button>
    </form>`
    : mine
      ? `<p class="hint">${esc(t.recoveries.approveHint)}</p>`
      : `<form method="post" action="/admin/recoveries/${esc(r.id)}/approve">
           <button class="btn" type="submit">${esc(t.recoveries.approve)}</button>
         </form>`}
  </div>`;
  };

  return page({ title: t.recoveries.title, active: 'home' }, `
<div class="card">
  <h2 style="margin-block-start:0">🆘 ${esc(t.recoveries.title)}</h2>
  <p class="muted">${esc(t.recoveries.subtitle)}</p>
  ${d.error ? banner('warn', d.error) : ''}
  ${d.flash ? banner('ok', d.flash) : ''}
  <div class="banner info">${esc(t.recoveries.why)}</div>
</div>

<div class="card">
  <h3 style="margin-block-start:0">➕ ${esc(t.recoveries.newTitle)}</h3>
  ${d.people.length === 0
    // An empty picker above a live submit button is a dead end that reads as a
    // broken screen. On the first day of a village nobody has enrolled a device
    // yet, so this is the NORMAL state here — and the right answer is the other
    // door, named and linked.
    ? `${empty('👤', t.recoveries.noCandidates, t.recoveries.noCandidatesHint)}
       <a class="btn btn-2" href="/admin/members">${esc(t.importPage.toMembers)}</a>`
    : `<form method="post" action="/admin/recoveries">
    <div class="field">
      <label for="rc-who">${esc(t.recoveries.who)}</label>
      <select id="rc-who" name="target" required>
        ${d.people.map(p => `<option value="${esc(p.id)}">${esc(p.full_name)}${
          p.unit_label ? ` — ${esc(p.unit_label)}` : ''}</option>`).join('')}
      </select>
      <p class="hint">${esc(t.recoveries.whoHint)}</p>
    </div>
    <div class="field">
      <label for="rc-check">${esc(t.recoveries.check)}</label>
      <textarea id="rc-check" name="check" rows="3" minlength="10" required></textarea>
      <p class="hint">${esc(t.recoveries.checkHint)}</p>
    </div>
    <button class="btn" type="submit">${esc(t.recoveries.open)}</button>
  </form>`}
</div>

<h2>${esc(t.recoveries.openTitle)}</h2>
${d.open.length === 0
  ? `<div class="card">${empty('🆘', t.recoveries.empty, t.recoveries.emptyHint)}</div>`
  : d.open.map(card).join('')}`);
}
