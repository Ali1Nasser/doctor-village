/**
 * tests/unit/money.test.ts — the edge cases named in 02_DATA_MODEL.md §7,
 * plus the ones the demo data exposed.
 *
 * Run: npm run test:unit
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parse, toEGP, formatAr, sum, fromPiastres, splitByBasisPoints,
  allocateOldestFirst, normalizeDigits, type Piastres,
} from '../../lib/money.js';
import { normalize, formatLocal, maskTail, sameNumber } from '../../lib/phone.js';

const P = (n: number) => fromPiastres(n);
const ok = (input: string | number | null | undefined, expected: number) =>
  test(`parse(${JSON.stringify(input)}) === ${expected}p`, () => {
    const r = parse(input);
    assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
    if (r.ok) assert.equal(r.value, expected);
  });
const bad = (input: string | number | null | undefined, error: string) =>
  test(`parse(${JSON.stringify(input)}) rejects as ${error}`, () => {
    const r = parse(input);
    assert.equal(r.ok, false, `expected rejection, got ${JSON.stringify(r)}`);
    if (!r.ok) assert.equal(r.error, error);
  });

// ---------------------------------------------- the 12 cases from 02 §7 ----
ok('0', 0);
ok('0.01', 1);                       // one piastre
bad('0.005', 'too_precise');         // finer than a piastre — refuse, never round
ok('999999999.99', 99_999_999_999);
ok('1,234.50', 123_450);
ok('١٢٣٤', 123_400);                 // Arabic-Indic digits
ok('1 234,50', 123_450);             // European shape with a space group
bad(null, 'empty');
bad(undefined, 'empty');
bad('', 'empty');
bad('abc', 'not_a_number');
bad('-5', 'negative');

// ---------------------------------------------------- how people type ----
ok('1500', 150_000);
ok('1500.5', 150_050);
ok('1,500', 150_000);                // 3-digit group -> thousands
ok('1,50', 150);                     // 2-digit group at the end -> decimal
ok('١٥٠٠٫٥٠', 150_050);              // Arabic digits + Arabic decimal separator
ok('١٬٥٠٠', 150_000);                // Arabic thousands separator
ok('1500 ج.م', 150_000);
ok('ج.م 1500', 150_000);
ok('1500 EGP', 150_000);
ok(' 1500 ', 150_000);
ok('+1500', 150_000);
ok('۱۵۰۰', 150_000);                 // Persian digits
bad('1,23,456', 'not_a_number');     // invalid grouping — refuse, don't reinterpret
bad('1.2.3', 'not_a_number');
bad('12abc', 'not_a_number');
bad('1500.555', 'too_precise');
bad('1e9', 'not_a_number');          // scientific notation is never a resident's input
bad(1e15, 'too_large');
bad(NaN, 'not_a_number');
bad(Infinity, 'not_a_number');
bad(-0.5, 'negative');
ok(1500, 150_000);
ok(1500.5, 150_050);
bad(1500.555, 'too_precise');

// ------------------------------------------------------------ format ----
test('toEGP groups and always shows two decimals', () => {
  assert.equal(toEGP(P(0)), '0.00');
  assert.equal(toEGP(P(1)), '0.01');
  assert.equal(toEGP(P(100)), '1.00');
  assert.equal(toEGP(P(123_450)), '1,234.50');
  assert.equal(toEGP(P(99_999_999_999)), '999,999,999.99');
  assert.equal(toEGP(P(600_000)), '6,000.00');
});

test('formatAr always carries the unit', () => {
  assert.equal(formatAr(P(123_450)), '1,234.50 ج.م');
  assert.equal(formatAr(P(0)), '0.00 ج.م');
});

test('parse and toEGP round-trip for every value the demo produces', () => {
  for (const p of [0, 1, 99, 100, 150, 123_450, 600_000, 500_000, 99_999_999_999]) {
    const r = parse(toEGP(P(p)));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, p, `round trip failed for ${p}`);
  }
});

// --------------------------------------------------------------- sum ----
test('sum of an empty list is zero, not NaN or undefined', () => {
  assert.equal(sum([]), 0);
});
test('sum stays exact where floats would not', () => {
  // 0.1 + 0.2 !== 0.3 in binary floating point; in piastres it is exact
  assert.equal(sum([P(10), P(20)]), 30);
  assert.equal(sum([P(1)]. concat(Array(999).fill(P(1)))), 1000);
});

// ------------------------------------------------------------- split ----
test('splitByBasisPoints never loses or invents a piastre', () => {
  // a co-owned flat, 50/50, on an odd amount
  assert.deepEqual(splitByBasisPoints(P(600_001), [5000, 5000]), [300_001, 300_000]);
  // three-way split of an amount that does not divide
  const three = splitByBasisPoints(P(100), [3333, 3333, 3334]);
  assert.equal(three.reduce((a, b) => a + b, 0), 100);
  // the pathological case: 1 piastre across 3 owners
  const one = splitByBasisPoints(P(1), [3333, 3333, 3334]);
  assert.equal(one.reduce((a, b) => a + b, 0), 1);
});
test('splitByBasisPoints refuses shares that do not sum to 100%', () => {
  assert.throws(() => splitByBasisPoints(P(100), [5000, 4000]));
});

// ---------------------------------------------------------- allocate ----
test('a partial payment goes to the oldest obligation first', () => {
  const r = allocateOldestFirst(P(250_000), [
    { id: 'due-2025', outstanding: P(600_000) },
    { id: 'due-2026', outstanding: P(600_000) },
  ]);
  assert.deepEqual(r.allocations, [{ id: 'due-2025', amount: 250_000 }]);
  assert.equal(r.creditRemainder, 0);
});
test('an overpayment leaves a CREDIT, never extra income (06 §4)', () => {
  const r = allocateOldestFirst(P(650_000), [{ id: 'due-2026', outstanding: P(600_000) }]);
  assert.deepEqual(r.allocations, [{ id: 'due-2026', amount: 600_000 }]);
  assert.equal(r.creditRemainder, 50_000);
});
test('a payment with no obligation at all becomes entirely a credit', () => {
  const r = allocateOldestFirst(P(600_000), []);
  assert.equal(r.allocations.length, 0);
  assert.equal(r.creditRemainder, 600_000);
});

// ------------------------------------------------------------ digits ----
test('normalizeDigits handles Arabic-Indic and Persian', () => {
  assert.equal(normalizeDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
  assert.equal(normalizeDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789');
  assert.equal(normalizeDigits('abc'), 'abc');
});

// ------------------------------------------------------------- phone ----
const pok = (input: string, expected: string) =>
  test(`phone ${JSON.stringify(input)} -> ${expected}`, () => {
    const r = normalize(input);
    assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
    if (r.ok) assert.equal(r.value, expected);
  });
const pbad = (input: string | null, error: string) =>
  test(`phone ${JSON.stringify(input)} rejects as ${error}`, () => {
    const r = normalize(input);
    assert.equal(r.ok, false, `expected rejection, got ${JSON.stringify(r)}`);
    if (!r.ok) assert.equal(r.error, error);
  });

// the five shapes named in INSIGHTS 2026-08-03
pok('01012345678',    '+201012345678');
pok('1012345678',     '+201012345678');
pok('+201012345678',  '+201012345678');
pok('00201012345678', '+201012345678');
pok('010 1234 5678',  '+201012345678');
pok('010-1234-5678',  '+201012345678');
pok('(010) 1234 5678','+201012345678');
pok('٠١٠١٢٣٤٥٦٧٨',    '+201012345678');   // Arabic-Indic
pok('01112345678',    '+201112345678');   // Etisalat
pok('01212345678',    '+201212345678');   // Orange
pok('01512345678',    '+201512345678');   // WE

pbad(null, 'empty');
pbad('', 'empty');
pbad('0123456', 'wrong_length');          // far too short — a typo
// A landline must say "that is not a mobile", not "count your digits again".
// سعاد, 71, typing her home number is a realistic first attempt.
pbad('0463123456', 'not_egyptian_mobile');   // 046 — Marsa Matrouh landline
pbad('0451234567', 'not_egyptian_mobile');   // 045 — Damanhour landline
pbad('0223456789', 'not_egyptian_mobile');   // 02 — Cairo landline
pbad('01312345678', 'unknown_operator');     // 013 is not an allocated prefix
pbad('+441012345678', 'not_egyptian_mobile');

test('formatLocal reads back the way a resident says it', () => {
  const r = normalize('01012345678');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(formatLocal(r.value), '0101 234 5678');
});
test('maskTail shows only the last four digits', () => {
  const r = normalize('01012345678');
  if (r.ok) assert.equal(maskTail(r.value), '…5678');
});
test('sameNumber sees through formatting — the importer depends on this', () => {
  assert.equal(sameNumber('01012345678', '+20 101 234 5678'), true);
  assert.equal(sameNumber('٠١٠١٢٣٤٥٦٧٨', '00201012345678'), true);
  assert.equal(sameNumber('01012345678', '01012345679'), false);
  assert.equal(sameNumber('abc', 'abc'), false);
});
