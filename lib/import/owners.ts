/**
 * lib/import/owners.ts — parsing the owner register.
 *
 * `01_PRD.md` A2: an admin uploads a spreadsheet of الاسم، رقم العمارة، رقم
 * الشقة، رقم الموبايل. The importer *"previews, normalizes phone numbers to
 * +20…, flags duplicates and malformed rows, and imports only after explicit
 * confirmation."*
 *
 * ## The one rule this file exists to enforce: NEVER GUESS.
 *
 * R-009 lists what real registers contain — duplicate numbers, missing units,
 * two owners for one flat, a flat with no number at all. Every one of those has
 * a tempting automatic fix, and every automatic fix is a way to silently attach
 * one family's money to another family's name. A flagged row a human resolves in
 * ten seconds is always better than a guess nobody sees.
 *
 * Parsing is pure and has no database access, so it is testable against nasty
 * input without touching anything.
 */

import { normalize as normalizePhone } from '../phone.js';
import { normalizeDigits } from '../money.js';

export type RowStatus = 'ok' | 'duplicate' | 'malformed';

export interface ParsedRow {
  rowNo: number;
  raw: Record<string, string>;
  fullName: string | null;
  buildingCode: string | null;
  unitNumber: string | null;
  phoneE164: string | null;
  status: RowStatus;
  /** Shown to the admin verbatim. Must say what to DO, not just what is wrong. */
  problemAr: string | null;
}

export interface ParseResult {
  rows: ParsedRow[];
  okCount: number;
  problemCount: number;
  /** Header names we could not place, so a differently-labelled file is
   *  reported rather than silently half-imported. */
  unmappedHeaders: string[];
}

/**
 * Header synonyms. Real spreadsheets from a volunteer board will not use one
 * spelling, and asking the owner to rename columns before sending is how a
 * three-minute task becomes a week of email.
 */
const HEADERS: Record<keyof typeof FIELD, string[]> = {
  name:     ['الاسم', 'اسم المالك', 'المالك', 'اسم', 'name', 'owner'],
  building: ['رقم العمارة', 'العمارة', 'عمارة', 'مبنى', 'building', 'block'],
  unit:     ['رقم الشقة', 'الشقة', 'شقة', 'الوحدة', 'وحدة', 'unit', 'flat', 'apartment'],
  phone:    ['رقم الموبايل', 'الموبايل', 'موبايل', 'التليفون', 'تليفون', 'رقم', 'phone', 'mobile'],
};
const FIELD = { name: 1, building: 1, unit: 1, phone: 1 };

const strip = (s: string) =>
  s.replace(/[‎‏‪-‮]/g, '')   // bidi marks Excel loves to add
   .replace(/\s+/g, ' ')
   .trim();

function mapHeaders(header: string[]): {
  map: Partial<Record<keyof typeof FIELD, number>>; unmapped: string[];
} {
  const map: Partial<Record<keyof typeof FIELD, number>> = {};
  const unmapped: string[] = [];
  header.forEach((h, i) => {
    const clean = strip(h).toLowerCase();
    const hit = (Object.keys(HEADERS) as (keyof typeof FIELD)[])
      .find(k => HEADERS[k].some(syn => clean === syn.toLowerCase()));
    if (hit && map[hit] === undefined) map[hit] = i;
    else if (clean) unmapped.push(h);
  });
  return { map, unmapped };
}

/** Split a CSV/TSV line, honouring quotes. Excel exports both. */
function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ;
    } else if (ch === sep && !inQ) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseOwners(text: string): ParseResult {
  const clean = text.replace(/^﻿/, '');                    // Excel's BOM
  const lines = clean.split(/\r\n|\r|\n/).filter(l => l.trim() !== '');
  if (lines.length === 0) {
    return { rows: [], okCount: 0, problemCount: 0, unmappedHeaders: [] };
  }
  // Tab or comma, whichever appears more in the header — Excel produces both
  // depending on locale, and Arabic locales often default to semicolon too.
  const head = lines[0]!;
  const sep = [';', '\t', ','].sort(
    (a, b) => (head.split(b).length - head.split(a).length))[0]!;

  const { map, unmapped } = mapHeaders(splitLine(head, sep));
  const rows: ParsedRow[] = [];
  const seenPhone = new Map<string, number>();
  const seenUnit = new Map<string, number>();

  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]!, sep).map(strip);
    const pick = (k: keyof typeof FIELD) => {
      const idx = map[k];
      return idx === undefined ? '' : (cells[idx] ?? '');
    };
    const raw: Record<string, string> = {
      name: pick('name'), building: pick('building'),
      unit: pick('unit'), phone: pick('phone'),
    };

    const fullName = raw.name || null;
    // Arabic-Indic digits are normal in these files; a building written ١٤ is 14.
    const buildingCode = raw.building ? normalizeDigits(raw.building).replace(/\D/g, '') || null : null;
    const unitNumber = raw.unit ? normalizeDigits(raw.unit).replace(/\D/g, '') || null : null;
    const phoneRes = raw.phone ? normalizePhone(raw.phone) : null;
    const phoneE164 = phoneRes?.ok ? phoneRes.value : null;

    const problems: string[] = [];
    if (!fullName) problems.push('الاسم ناقص');
    if (!buildingCode) problems.push('رقم العمارة ناقص أو مش مفهوم');
    if (!unitNumber) problems.push('رقم الشقة ناقص أو مش مفهوم');
    if (!raw.phone) problems.push('رقم الموبايل ناقص');
    else if (!phoneE164) problems.push('رقم الموبايل مش صحيح');

    let status: RowStatus = problems.length ? 'malformed' : 'ok';

    // Duplicates are FLAGGED, never merged and never dropped. Two rows with one
    // number might be a typo, a shared family line, or two genuinely different
    // people — and only the board knows which.
    if (status === 'ok' && phoneE164) {
      const prev = seenPhone.get(phoneE164);
      if (prev !== undefined) {
        status = 'duplicate';
        problems.push(`نفس رقم الموبايل موجود في صف ${prev}`);
      } else seenPhone.set(phoneE164, i);
    }
    if (buildingCode && unitNumber) {
      const key = `${buildingCode}/${unitNumber}`;
      const prev = seenUnit.get(key);
      if (prev !== undefined && status === 'ok') {
        // NOT an error: unit_owners is many-to-many by design (02 §3). Surfaced
        // so the admin confirms it is co-ownership rather than a duplicated row.
        status = 'duplicate';
        problems.push(`نفس الشقة موجودة في صف ${prev} — ملّاك مشتركين؟ أكّد بنفسك`);
      } else if (prev === undefined) seenUnit.set(key, i);
    }

    rows.push({
      rowNo: i, raw, fullName, buildingCode, unitNumber, phoneE164,
      status,
      problemAr: problems.length ? problems.join(' · ') : null,
    });
  }

  return {
    rows,
    okCount: rows.filter(r => r.status === 'ok').length,
    problemCount: rows.filter(r => r.status !== 'ok').length,
    unmappedHeaders: unmapped,
  };
}

/** A one-line Arabic summary for the confirm screen. */
export function summaryAr(r: ParseResult): string {
  const parts = [`${r.rows.length} صف`, `${r.okCount} تمام`];
  if (r.problemCount) parts.push(`${r.problemCount} محتاج مراجعة`);
  if (r.unmappedHeaders.length) parts.push(`أعمدة مش مفهومة: ${r.unmappedHeaders.join('، ')}`);
  return parts.join(' · ');
}
