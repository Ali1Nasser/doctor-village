/**
 * lib/phone.ts — Egyptian mobile numbers, normalised to E.164.
 *
 * The database CHECK on `phone_identifiers.phone_e164` refuses anything that is
 * not `+20` followed by 10 digits, so this module is the single place a
 * real-world number is turned into one. It REFUSES rather than guesses: a
 * number normalised wrongly during bulk import silently attaches a resident's
 * money to the wrong person (R-009, R-021).
 *
 * INSIGHTS 2026-08-03: numbers arrive in at least five shapes —
 *   01012345678 · 1012345678 · +201012345678 · 00201012345678 · with
 *   spaces/dashes/parens — and in Arabic-Indic digits.
 */

import { normalizeDigits } from './money.js';

export type PhoneE164 = string & { readonly __brand: 'PhoneE164' };

export type PhoneError =
  | 'empty'
  | 'not_egyptian_mobile'   // wrong country code, or a landline
  | 'wrong_length'
  | 'unknown_operator';     // not 010/011/012/015

export type PhoneResult =
  | { ok: true; value: PhoneE164 }
  | { ok: false; error: PhoneError };

export const PHONE_MESSAGES_AR: Record<PhoneError, string> = {
  empty:               'اكتب رقم الموبايل',
  not_egyptian_mobile: 'الرقم لازم يكون موبايل مصري، زي 01012345678',
  wrong_length:        'رقم الموبايل المصري 11 رقم، زي 01012345678',
  unknown_operator:    'الرقم لازم يبدأ بـ 010 أو 011 أو 012 أو 015',
};

/** Egyptian mobile prefixes after the country code: 10 Vodafone, 11 Etisalat,
 *  12 Orange, 15 WE. A landline (02, 03, 046…) is deliberately refused — this
 *  system logs people in by mobile. */
const OPERATORS = ['10', '11', '12', '15'];

export function normalize(input: string | null | undefined): PhoneResult {
  if (input === null || input === undefined) return { ok: false, error: 'empty' };

  // strip everything that is not a digit or a leading plus
  let s = normalizeDigits(String(input)).trim();
  const hadPlus = s.startsWith('+');
  s = s.replace(/\D/g, '');
  if (s === '') return { ok: false, error: 'empty' };

  // peel the country code, in the several ways people write it
  if (s.startsWith('0020')) s = s.slice(4);
  else if (s.startsWith('00201')) s = s.slice(4);
  else if (hadPlus && s.startsWith('20')) s = s.slice(2);
  else if (s.startsWith('20') && s.length >= 12) s = s.slice(2);
  else if (s.startsWith('0')) s = s.slice(1);

  // What remains should be 10 digits: OP(2) + subscriber(8).
  //
  // Egyptian LANDLINES are 8 or 9 digits after the leading zero (e.g. Matrouh
  // 046 + 7). An older resident typing their home number is a realistic input,
  // and "رقم الموبايل المصري 11 رقم" would leave them re-counting digits on a
  // number that can never work. Tell them it is not a mobile instead.
  if (s.length === 8 || s.length === 9) return { ok: false, error: 'not_egyptian_mobile' };
  if (s.length < 8)  return { ok: false, error: 'wrong_length' };
  if (s.length > 10) return { ok: false, error: 'not_egyptian_mobile' };

  const op = s.slice(0, 2);
  if (!OPERATORS.includes(op)) return { ok: false, error: 'unknown_operator' };

  return { ok: true, value: `+20${s}` as PhoneE164 };
}

/** "0101 234 5678" — how a resident reads their own number back. */
export function formatLocal(p: PhoneE164): string {
  const d = p.slice(3);                       // drop +20
  return `0${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

/**
 * "…5678" — the ONLY form ever shown about somebody else, and only to staff.
 * A resident never sees another resident's number in any form (C6).
 */
export function maskTail(p: PhoneE164): string {
  return `…${p.slice(-4)}`;
}

/** Two inputs refer to the same line. Used by the bulk importer to spot
 *  duplicates BEFORE writing anything (R-009). */
export function sameNumber(a: string, b: string): boolean {
  const na = normalize(a), nb = normalize(b);
  return na.ok && nb.ok && na.value === nb.value;
}
