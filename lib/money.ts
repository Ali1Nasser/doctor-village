/**
 * lib/money.ts — the ONLY place currency arithmetic happens.  (C4, ADR-002)
 *
 * Money is an integer number of piastres (EGP × 100). There is no other
 * representation anywhere in this codebase. `Piastres` is a branded type, so a
 * plain `number` cannot be passed where money is expected without going
 * through a constructor in this file.
 *
 * Two design choices worth knowing:
 *
 * 1. `parse` REFUSES rather than guesses. It never rounds a resident's stated
 *    amount, never returns NaN, and never throws — it returns a discriminated
 *    result the caller must handle. In a financial system, silently accepting
 *    "1,50" as 150.00 when the resident meant 1.50 is a trust failure, and a
 *    thrown exception in a Worker is a 500 the resident cannot act on.
 *
 * 2. Input is normalised for the way people in Egypt actually type: Arabic-Indic
 *    (٠١٢٣٤٥٦٧٨٩) and Persian (۰۱۲۳۴۵۶۷۸۹) digits, the Arabic decimal separator
 *    (٫) and thousands separator (٬), Arabic and Latin commas, spaces, NBSPs,
 *    and a leading ج.م or EGP.
 */

export type Piastres = number & { readonly __brand: 'Piastres' };

export type ParseError =
  | 'empty'              // nothing entered
  | 'not_a_number'       // letters, symbols, or an unparseable shape
  | 'negative'           // amounts are always positive; reversals are separate rows
  | 'too_precise'        // finer than one piastre — we refuse to round for the user
  | 'too_large';         // beyond what an integer can hold safely

export type ParseResult =
  | { ok: true; value: Piastres }
  | { ok: false; error: ParseError };

/** Arabic messages for each failure, for `messages/ar.json`. Never blame the user. */
export const PARSE_MESSAGES_AR: Record<ParseError, string> = {
  empty:        'اكتب المبلغ الأول',
  not_a_number: 'المبلغ لازم يكون أرقام بس، زي 1500 أو 1500.50',
  negative:     'المبلغ لازم يكون أكبر من صفر',
  too_precise:  'أصغر وحدة هي القرش — يعني رقمين بعد العلامة العشرية بحد أقصى',
  too_large:    'المبلغ ده كبير جدًا، راجعه من فضلك',
};

/** Largest amount we will accept: 1,000,000,000.00 ج.م. Far above any real
 *  village transaction, and far below Number.MAX_SAFE_INTEGER. */
export const MAX_PIASTRES = 100_000_000_000 as Piastres;

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN      = '۰۱۲۳۴۵۶۷۸۹';

/** Fold Arabic-Indic and Persian digits to ASCII. `parseFloat("١٢٣")` is NaN. */
export function normalizeDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const ai = ARABIC_INDIC.indexOf(ch);
    if (ai >= 0) { out += String(ai); continue; }
    const fa = PERSIAN.indexOf(ch);
    if (fa >= 0) { out += String(fa); continue; }
    out += ch;
  }
  return out;
}

/**
 * Parse a human-entered amount into piastres.
 *
 * Separator rule, stated explicitly because it is the ambiguous part:
 *   · '.' and '٫' are always decimal separators.
 *   · ',' is a THOUSANDS separator, unless it is the only separator present and
 *     it is followed by exactly two digits at the end of the string — in which
 *     case it is a decimal separator ("1 234,50" -> 1234.50).
 *     "1,500" stays 1500 because a 3-digit group is valid grouping.
 *   · Grouping, when used, must be in groups of exactly 3 ("1,23,456" is refused
 *     rather than silently reinterpreted).
 */
export function parse(input: string | number | null | undefined): ParseResult {
  if (input === null || input === undefined) return { ok: false, error: 'empty' };

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, error: 'not_a_number' };
    if (input < 0) return { ok: false, error: 'negative' };
    const scaled = input * 100;
    // a float that is not a whole number of piastres is refused, not rounded
    if (Math.abs(scaled - Math.round(scaled)) > 1e-9) return { ok: false, error: 'too_precise' };
    const p = Math.round(scaled);
    if (p > MAX_PIASTRES) return { ok: false, error: 'too_large' };
    return { ok: true, value: p as Piastres };
  }

  let s = normalizeDigits(String(input)).trim();
  if (s === '') return { ok: false, error: 'empty' };

  // strip currency labels and every kind of space
  s = s.replace(/ج\.?\s?م\.?/g, '').replace(/EGP/gi, '').replace(/جنيه/g, '');
  s = s.replace(/[\s   ]/g, '');
  s = s.replace(/٬/g, ',').replace(/٫/g, '.').replace(/،/g, ',');
  if (s === '') return { ok: false, error: 'empty' };

  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('-')) return { ok: false, error: 'negative' };

  const hasDot = s.includes('.');
  const commas = (s.match(/,/g) ?? []).length;

  if (commas > 0) {
    const treatCommaAsDecimal = !hasDot && commas === 1 && /,\d{2}$/.test(s);
    if (treatCommaAsDecimal) {
      s = s.replace(',', '.');
    } else {
      // validate grouping: first group 1-3 digits, every later group exactly 3
      const intPart = hasDot ? s.slice(0, s.indexOf('.')) : s;
      const groups = intPart.split(',');
      if (groups.length > 1) {
        const validFirst = /^\d{1,3}$/.test(groups[0]!);
        const validRest = groups.slice(1).every(g => /^\d{3}$/.test(g));
        if (!validFirst || !validRest) return { ok: false, error: 'not_a_number' };
      }
      s = s.replace(/,/g, '');
    }
  }

  if (!/^\d+(\.\d*)?$/.test(s)) return { ok: false, error: 'not_a_number' };

  const [whole, frac = ''] = s.split('.') as [string, string?];
  if (frac.length > 2) {
    // "0.005" — finer than a piastre. We refuse rather than round for the user.
    return { ok: false, error: 'too_precise' };
  }
  const cents = (frac + '00').slice(0, 2);

  // string arithmetic all the way — no float ever touches the value
  const digits = whole + cents;
  if (digits.length > 15) return { ok: false, error: 'too_large' };
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) return { ok: false, error: 'too_large' };
  if (value > MAX_PIASTRES) return { ok: false, error: 'too_large' };
  return { ok: true, value: value as Piastres };
}

/** Construct piastres from a trusted integer (a database column, a constant). */
export function fromPiastres(n: number): Piastres {
  if (!Number.isSafeInteger(n)) {
    throw new TypeError(`money: ${n} is not a safe integer number of piastres`);
  }
  return n as Piastres;
}

/** "1,234.50" — Western digits, because that is what bank apps and InstaPay show. */
export function toEGP(p: Piastres): string {
  const neg = p < 0;
  const abs = Math.abs(p);
  const whole = Math.trunc(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}.${cents}`;
}

/** "1,234.50 ج.م" — every number in the UI carries its unit (04_UX_SPEC §10). */
export function formatAr(p: Piastres): string {
  return `${toEGP(p)} ج.م`;
}

/**
 * Wrap for RTL. Without bidi isolation, "1,234.50 ج.م" inside an Arabic
 * paragraph renders with its parts reordered. This is the single most common
 * RTL bug in this project (INSIGHTS 2026-08-03).
 */
export function bdi(p: Piastres): string {
  return `<bdi dir="ltr" class="tabular-nums">${formatAr(p)}</bdi>`;
}

export function sum(xs: readonly Piastres[]): Piastres {
  let total = 0;
  for (const x of xs) total += x;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError('money: sum exceeded safe integer range');
  }
  return total as Piastres;
}

export function add(a: Piastres, b: Piastres): Piastres { return fromPiastres(a + b); }
export function sub(a: Piastres, b: Piastres): Piastres { return fromPiastres(a - b); }

/**
 * Split an amount across shares given in basis points, with the remainder
 * distributed largest-first. Used for co-owned flats.
 *
 * The invariant that matters: the parts ALWAYS sum back to the original. A
 * naive per-share round loses or invents piastres, and over a few hundred
 * units that becomes a real discrepancy nobody can explain.
 */
export function splitByBasisPoints(total: Piastres, sharesBp: readonly number[]): Piastres[] {
  const totalBp = sharesBp.reduce((a, b) => a + b, 0);
  if (totalBp !== 10_000) throw new RangeError('money: shares must sum to 10000 basis points');
  const parts = sharesBp.map(bp => Math.floor((total * bp) / 10_000));
  let remainder = total - parts.reduce((a, b) => a + b, 0);
  const order = sharesBp.map((bp, i) => ({ bp, i })).sort((x, y) => y.bp - x.bp);
  let k = 0;
  while (remainder > 0) { parts[order[k % order.length]!.i]! += 1; remainder -= 1; k += 1; }
  return parts as Piastres[];
}

/**
 * Allocate a payment across outstanding obligations, oldest first (06 §4).
 * Whatever is left over is the resident's CREDIT — a liability, never income.
 */
export function allocateOldestFirst(
  payment: Piastres,
  dues: readonly { id: string; outstanding: Piastres }[],
): { allocations: { id: string; amount: Piastres }[]; creditRemainder: Piastres } {
  let left: number = payment;
  const allocations: { id: string; amount: Piastres }[] = [];
  for (const due of dues) {
    if (left <= 0) break;
    const take = Math.min(left, due.outstanding);
    if (take > 0) { allocations.push({ id: due.id, amount: take as Piastres }); left -= take; }
  }
  return { allocations, creditRemainder: left as Piastres };
}
