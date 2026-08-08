/**
 * tests/unit/quiet.test.ts — quiet hours actually silence the phone.
 *
 * `notify_quiet_from` / `notify_quiet_to` existed since CP-1, appeared on the
 * settings screen, and were read by nothing. The board would set them, believe
 * the portal had stopped ringing phones at midnight, and be wrong.
 *
 * The times are Cairo wall-clock, which is the whole difficulty: Egypt observes
 * DST, so a window that is correct in January is an hour out in July unless the
 * offset comes from the instant. Both are asserted.
 */

import { it, describe } from 'node:test';
import assert from 'node:assert/strict';

import { inQuietHours } from '../../lib/db/push.js';

const QUIET = ['22:00', '09:00'] as const;

describe('quiet hours are Cairo wall-clock, not UTC', () => {
  it('⭐ winter: 21:00 UTC is 23:00 in Cairo — quiet', () => {
    // Egypt is UTC+02:00 in winter.
    assert.equal(inQuietHours('2026-01-15T21:00:00Z', ...QUIET), true);
    assert.equal(inQuietHours('2026-01-15T12:00:00Z', ...QUIET), false); // 14:00 Cairo
  });

  it('⭐ summer: the SAME UTC instant is midnight in Cairo — still quiet', () => {
    // UTC+03:00 in summer. A hardcoded +02 would have gone on buzzing phones at
    // 11 pm every summer, and nobody would have connected the two facts.
    assert.equal(inQuietHours('2026-07-15T21:00:00Z', ...QUIET), true);
    // 06:30 UTC = 09:30 Cairo in summer: quiet has ENDED
    assert.equal(inQuietHours('2026-07-15T06:30:00Z', ...QUIET), false);
    // the same clock reading in winter is 08:30 Cairo: still quiet
    assert.equal(inQuietHours('2026-01-15T06:30:00Z', ...QUIET), true);
  });
});

describe('the window that wraps midnight is the normal case', () => {
  it('22:00 → 09:00 covers the night and not the day', () => {
    const q = (utc: string) => inQuietHours(utc, ...QUIET);
    assert.equal(q('2026-01-15T20:30:00Z'), true);   // 22:30 Cairo
    assert.equal(q('2026-01-16T00:30:00Z'), true);   // 02:30 Cairo
    assert.equal(q('2026-01-16T06:59:00Z'), true);   // 08:59 Cairo
    assert.equal(q('2026-01-16T07:00:00Z'), false);  // 09:00 Cairo — over
    assert.equal(q('2026-01-15T19:59:00Z'), false);  // 21:59 Cairo — not yet
  });

  it('a window inside one day works too', () => {
    assert.equal(inQuietHours('2026-01-15T11:00:00Z', '13:00', '15:00'), true);  // 13:00
    assert.equal(inQuietHours('2026-01-15T13:00:00Z', '13:00', '15:00'), false); // 15:00
  });
});

describe('a broken setting must not silence the village', () => {
  it('⭐ nonsense times mean NO quiet hours, not permanent silence', () => {
    // Failing closed here would mean an approval notification never reaching a
    // resident's phone again, invisibly. Push is a courtesy; the failure mode
    // has to be "it buzzed when it should not have", never the reverse.
    for (const [from, to] of [['', ''], ['25:00', '09:00'], ['22:00', 'nine'],
                              ['22:0', '09:00'], ['22:00', '22:00']] as const) {
      assert.equal(inQuietHours('2026-01-16T00:30:00Z', from, to), false,
        `"${from}"→"${to}" silenced every notification`);
    }
  });

  it('an unparseable clock does not silence anything either', () => {
    assert.equal(inQuietHours('not-a-date', ...QUIET), false);
  });
});
