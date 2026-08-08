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
    : `<div class="table-wrap"><table>
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
  </div>`;
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
  ${d.people.length === 0
    ? empty('🔍', t.users.empty, t.members.findNoneHint)
    : d.people.map(row).join('')}
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
const ACTION_AR: Record<string, string> = {
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
    : `<div class="table-wrap"><table>
    <thead><tr>
      <th>${esc(t.auditView.when)}</th><th>${esc(t.auditView.who)}</th>
      <th>${esc(t.auditView.what)}</th><th>${esc(t.auditView.onWhat)}</th>
    </tr></thead>
    <tbody>${d.rows.map(r => `
      <tr>
        <td>${arDate(r.created_at)}</td>
        <td>${esc(r.actor_name ?? '—')}<br><span class="muted">${esc(ROLE_AR[r.actor_role] ?? r.actor_role)}</span></td>
        <td>${esc(ACTION_AR[r.action] ?? r.action)}</td>
        <td><span class="muted">${esc(r.entity_table)}</span></td>
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
