/**
 * src/views/map-pages.ts — خريطة القرية.  C13 / 07_VILLAGE_MAP_SPEC.md
 *
 * ## The overlay is an inline SVG, and that is the whole design
 *
 * Spec §5 asks for hotspots on a responsive image with no external map SDK, no
 * tiles, no API key and no runtime third-party request (C13, C11). An SVG with
 * `viewBox="0 0 10000 10000"` and `preserveAspectRatio="none"`, laid over the
 * image inside a positioned container, gives exactly that: the coordinates
 * stored in the database are unitless, the browser does the scaling, and the
 * hotspots stay on their buildings at 360px and at 1400px without a line of
 * JavaScript.
 *
 * Storing pixels instead would have been simpler to author and wrong by the
 * second screen size.
 *
 * ## The list is not a fallback
 *
 * Spec §5 again: "Image tapping is optional. A keyboard- and screen-reader-
 * friendly building list is always present." So the buttons below the image are
 * the same links, in the same order, with 48px targets — and the list is drawn
 * from the REGISTER, not from the map. A building the drawing does not cover
 * still appears, marked «مش على الخريطة», because the alternative is a resident
 * concluding their block does not exist.
 *
 * Each `<a>` in the SVG carries a `<title>`, which is what a screen reader
 * announces; the shapes are not decorative and are not hidden.
 *
 * ## What is deliberately absent
 *
 * No colour-coded payment status. Spec §3.9 disables financial colours until
 * Q11 is approved in writing, and even then colour would have to come with text
 * and an icon. A map that shades a building red for arrears publishes a fact
 * about the people who live in it to everybody who opens the page.
 */

import { page, t, msg, esc, num, money, arDate } from './layout.js';
import type { PublishedMap, BuildingSummary } from '../../lib/db/map.js';

function empty(icon: string, text: string, hint: string): string {
  return `<div class="empty"><div class="big" aria-hidden="true">${icon}</div>`
       + `<p>${esc(text)}</p><p class="muted">${esc(hint)}</p></div>`;
}

export interface BuildingRow {
  id: string; code: string; name_ar: string | null; units: number; on_map: number;
}

export function mapPage(d: {
  map: PublishedMap | null;
  buildings: BuildingRow[];
  imageSrc: string;
}): string {
  const overlay = (m: PublishedMap) => `
  <div class="map-wrap">
    <img class="map-img" src="${esc(d.imageSrc)}" alt="${esc(m.title_ar)}"
         width="1400" height="1397" loading="lazy" decoding="async">
    <svg class="map-svg" viewBox="0 0 10000 10000" preserveAspectRatio="none"
         role="group" aria-label="${esc(t.map.pickTitle)}">
      ${m.features.map(f => `
      <a href="/buildings/${esc(f.building_id)}" class="hot">
        <title>${esc(msg(t.map.buildingTitle, { code: f.building_code }))}</title>
        <rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="120"></rect>
      </a>`).join('')}
    </svg>
  </div>`;

  return page({ title: t.map.title, active: 'home' }, `
<div class="card">
  <h2 style="margin-block-start:0">🗺️ ${esc(t.map.title)}</h2>
  <div class="banner info" style="margin-block-start:8px">${esc(t.map.disclaimer)}</div>
  ${d.map ? `
    <p class="muted">${esc(t.map.coverage)}: ${esc(d.map.coverage_note_ar)}</p>
    <p class="muted">${esc(t.map.version)} ${esc(d.map.version_label)}${
      d.map.published_at ? ` · ${esc(t.map.updated)} ${arDate(d.map.published_at)}` : ''}</p>
  ` : ''}
</div>

${d.map
  ? `<div class="card" style="padding:10px">${overlay(d.map)}</div>`
  : `<div class="card">${empty('🗺️', t.map.empty, t.map.emptyHint)}</div>`}

<div class="card">
  <h3 style="margin-block-start:0">🏢 ${esc(t.map.pickTitle)}</h3>
  <p class="hint">${esc(t.map.pickHint)}</p>
  <div class="bgrid">
    ${d.buildings.map(b => `
    <a class="bnum" href="/buildings/${esc(b.id)}">
      <span class="bcode">${num(b.code)}</span>
      <span class="bmeta">${esc(msg(t.map.units, { n: b.units }))}</span>
      ${b.on_map ? '' : `<span class="bmeta muted">${esc(t.map.notOnMap)}</span>`}
    </a>`).join('')}
  </div>
</div>`);
}

/** The same labels `/maintenance` uses. Two vocabularies for one status is how
 *  a resident ends up thinking «اتصلّح» and «مقفول» are different outcomes. */
const TICKET_AR: Record<string, string> = t.maintenance.statusLabels;

export function buildingPage(d: {
  b: BuildingSummary;
  work: { id: string; title_ar: string; happened_on: string }[];
  /** The flats. A building page that gives a COUNT and stops is a dead end —
   *  the map exists to get somebody from "which building is that" to something
   *  they can act on. Balances are null when Q11's setting is off. */
  units: Array<{ id: string; unit_number: string;
                 paid_piastres: number | null; outstanding_piastres: number | null }>;
  tickets: Array<{ id: string; ticket_no: string; title_ar: string;
                   status: string; created_at: string }>;
}): string {
  return page({ title: msg(t.map.buildingTitle, { code: d.b.code }), active: 'home' }, `
<a class="backlink" href="/map">← ${esc(t.map.back)}</a>

<div class="card">
  <h2 style="margin-block-start:0">🏢 ${esc(msg(t.map.buildingTitle, { code: d.b.code }))}</h2>
  ${d.b.name_ar ? `<p class="muted">${esc(d.b.name_ar)}</p>` : ''}
  <div class="tiles">
    <div class="tile" style="--tc:var(--brand);--tsoft:var(--brand-soft)">
      <div class="lbl">${esc(t.map.unitsCount)}</div>
      <div class="v">${num(d.b.units)}</div>
    </div>
    ${d.b.collected_piastres !== null ? `
    <div class="tile" style="--tc:var(--ok);--tsoft:var(--ok-soft)">
      <div class="lbl">${esc(t.map.collected)}</div>
      <div class="v">${money(d.b.collected_piastres)}</div>
    </div>` : ''}
  </div>
  ${d.b.outstanding_piastres !== null
    ? `<p class="muted">${esc(t.map.outstanding)}: ${money(d.b.outstanding_piastres)}</p>`
    // Q11: withheld, and SAID to be withheld. Rendering zeros would read as
    // "this building owes nothing", which is a false statement rather than an
    // absent one.
    : `<p class="hint">${esc(t.map.statusHidden)}</p>`}
</div>

<div class="card">
  <h3 style="margin-block-start:0">🏠 ${esc(t.map.unitsTitle)}</h3>
  <p class="hint">${esc(d.units.some(u => u.outstanding_piastres !== null)
    ? t.map.unitsHint : t.map.unitsHidden)}</p>
  ${d.units.map(u => {
    // `outstanding` null means the general assembly has not published per-unit
    // status. Printing 0.00 instead would be a claim, not a blank.
    const known = u.outstanding_piastres !== null;
    const settled = known && (u.outstanding_piastres ?? 0) <= 0;
    return `
  <a class="row row-link" href="/units/${esc(u.id)}/statement">
    <span class="ico" aria-hidden="true">🚪</span>
    <span class="row-body">
      <b>${esc(msg(t.map.unitNo, { n: '' }))}${num(u.unit_number)}</b>
      ${known ? `<span class="muted">${esc(t.map.unitPaid)} ${money(u.paid_piastres ?? 0)}</span>` : ''}
    </span>
    <span class="row-end">${known
      ? settled
        ? `<span class="chip ok">✔ ${esc(t.map.unitSettled)}</span>`
        : `<span class="chip warn">${esc(t.map.unitDue)} ${money(u.outstanding_piastres ?? 0)}</span>`
      : '<span aria-hidden="true">←</span>'}</span>
  </a>`;
  }).join('')}
</div>

<div class="card">
  <h3 style="margin-block-start:0">🛠️ ${esc(t.map.ticketsTitle)}</h3>
  ${d.tickets.length === 0
    ? empty('🧰', t.map.noTickets, t.map.noTicketsHint)
    : d.tickets.map(k => `
    <div class="row">
      <span class="ico" aria-hidden="true">${
        k.status === 'open' ? '🔴' : k.status === 'in_progress' ? '🟡' : '✅'}</span>
      <span class="row-body">
        <b>${esc(k.title_ar)}</b>
        <span class="muted">${num(k.ticket_no)} · ${arDate(k.created_at)}</span>
      </span>
      <span class="row-end"><span class="chip ${
        k.status === 'open' ? 'warn' : k.status === 'in_progress' ? 'info' : 'ok'}">${
        esc(TICKET_AR[k.status] ?? k.status)}</span></span>
    </div>`).join('')}
  <a class="btn btn-2" href="/maintenance">${esc(t.map.allTickets)}</a>
</div>

<div class="card">
  <h3 style="margin-block-start:0">🔧 ${esc(t.map.workTitle)}</h3>
  ${d.work.length === 0
    ? empty('🧰', t.map.noWork, t.content.emptyHint)
    : d.work.map(w => `
    <a class="row row-link" href="/albums/${esc(w.id)}">
      <span class="ico" aria-hidden="true">📸</span>
      <span class="row-body">
        <b>${esc(w.title_ar)}</b>
        <span class="muted">${arDate(w.happened_on)}</span>
      </span>
    </a>`).join('')}
</div>`);
}

/* ===================================================================== */
/* /admin/map                                                            */
/* ===================================================================== */

export function adminMapPage(d: {
  maps: Array<{ id: string; title_ar: string; version_label: string; status: string;
                coverage_note_ar: string; published_at: string | null;
                total: number; unlinked: number; unverified: number }>;
  selected?: {
    id: string;
    features: Array<{ id: string; building_id: string | null; label_ar: string;
                      verification_status: string; building_code: string | null }>;
  };
  buildings: BuildingRow[];
  imageSrc: string;
  flash?: string;
  error?: string;
}): string {
  const statusAr: Record<string, string> = {
    draft: t.map.draft, published: t.map.published, archived: t.map.archived,
  };

  const feature = (f: NonNullable<typeof d.selected>['features'][number]) => `
  <div class="row">
    <span class="ico" aria-hidden="true">${
      f.verification_status === 'board_verified' ? '✅'
      : f.verification_status === 'rejected' ? '🚫' : '❔'}</span>
    <span class="row-body">
      <b>${esc(f.label_ar)}</b>
      <span class="muted">${f.building_code
        ? esc(msg(t.map.buildingTitle, { code: f.building_code }))
        : esc(t.map.unlinked)}</span>
      <span class="chip ${f.verification_status === 'board_verified' ? 'ok'
        : f.verification_status === 'rejected' ? 'danger' : 'warn'}">${
        esc(f.verification_status === 'board_verified' ? t.map.verified
          : f.verification_status === 'rejected' ? t.map.rejected : t.map.unverified)}</span>
    </span>
    <span class="row-end">
      <form method="post" action="/admin/map/features/${esc(f.id)}/verify" class="inline-form">
        <select name="building" aria-label="${esc(t.map.linkTo)}">
          <option value="">${esc(t.map.linkTo)}</option>
          ${d.buildings.map(b => `<option value="${esc(b.id)}" ${
            b.id === f.building_id ? 'selected' : ''}>${esc(b.code)}</option>`).join('')}
        </select>
        <button class="btn btn-2 btn-sm" type="submit">✅ ${esc(t.map.verify)}</button>
      </form>
      <form method="post" action="/admin/map/features/${esc(f.id)}/reject" class="inline-form">
        <button class="btn btn-2 btn-sm" type="submit">${esc(t.map.reject)}</button>
      </form>
    </span>
  </div>`;

  return page({ title: t.map.adminTitle, active: 'home' }, `
<div class="card">
  <h2 style="margin-block-start:0">🗺️ ${esc(t.map.adminTitle)}</h2>
  <p class="muted">${esc(t.map.adminSubtitle)}</p>
  ${d.error ? `<div class="banner warn">${esc(d.error)}</div>` : ''}
  ${d.flash ? `<div class="banner ok">${esc(d.flash)}</div>` : ''}
  <div class="banner warn">${esc(t.map.rule)}</div>
</div>

${d.maps.length === 0
  ? `<div class="card">${empty('🗺️', t.map.noMaps, t.map.noMapsHint)}</div>`
  : d.maps.map(m => `
<div class="card" style="border-inline-start:5px solid ${
    m.status === 'published' ? 'var(--ok)' : 'var(--warn)'}">
  <div class="row-head">
    <h3 style="margin-block-start:0">${esc(m.title_ar)}</h3>
    <span class="chip ${m.status === 'published' ? 'ok' : 'warn'}">${
      esc(statusAr[m.status] ?? m.status)}</span>
  </div>
  <p class="muted">${esc(t.map.version)} ${esc(m.version_label)} · ${esc(m.coverage_note_ar)}</p>
  <p class="muted">${esc(t.map.features)}: ${num(m.total)}
    ${m.unlinked > 0 ? ` · ${num(m.unlinked)} ${esc(t.map.unlinked)}` : ''}
    ${m.unverified > 0 ? ` · ${num(m.unverified)} ${esc(t.map.unverified)}` : ''}</p>
  <div class="btn-row">
    <a class="btn btn-2" href="/admin/map?id=${esc(m.id)}">${esc(t.map.features)}</a>
    ${m.status === 'draft' ? `
    <form method="post" action="/admin/map/${esc(m.id)}/publish" class="inline-form">
      <button class="btn" type="submit" ${
        m.unlinked > 0 || m.unverified > 0 || m.total === 0 ? 'disabled' : ''}>📣 ${
        esc(t.map.publish)}</button>
    </form>
    ${m.unlinked > 0 || m.unverified > 0
      ? `<span class="hint">${esc(t.map.publishBlocked)}</span>` : ''}` : ''}
  </div>
</div>`).join('')}

${d.selected ? `
<div class="card" style="padding:10px">
  <div class="map-wrap">
    <img class="map-img" src="${esc(d.imageSrc)}" alt="${esc(t.map.title)}"
         width="1400" height="1397" loading="lazy">
  </div>
</div>
<div class="card">
  <h3 style="margin-block-start:0">${esc(t.map.features)}</h3>
  ${d.selected.features.length === 0
    ? empty('📍', t.map.noMaps, t.map.noMapsHint)
    : d.selected.features.map(feature).join('')}
</div>` : ''}`);
}
