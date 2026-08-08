/**
 * lib/db/push.ts — browser push subscriptions.
 *
 * A subscription row is a URL that makes one named person's phone buzz. Leaked,
 * it is a harassment tool aimed at one family. So the C6 rule applies exactly as
 * it does to a receipt image: `profile_id` is in every predicate, and there is
 * no route that lists another person's devices.
 */

import type { AuthContext, Id } from '../../types/domain.js';
import { require_ } from '../rbac.js';
import type { Db } from './driver.js';
import { newId, type Clock } from './index.js';

export interface NewSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceLabelAr?: string | null;
}

/**
 * Store (or replace) the caller's subscription.
 *
 * `INSERT OR REPLACE` on the unique endpoint: a browser rotates its endpoint
 * whenever it likes and re-subscribes with the same one after a permission
 * re-grant. Accumulating rows would mean sending the same message three times
 * to one phone, which teaches the resident to turn notifications off.
 */
export async function saveSubscription(
  ctx: AuthContext, db: Db, s: NewSubscription, now: Clock,
): Promise<void> {
  // Validated here rather than trusted: these strings are fed straight into
  // key derivation, and a malformed one fails at encryption time with a stack
  // trace instead of at the boundary with a reason.
  if (!/^https:\/\//.test(s.endpoint)) throw new Error('push endpoint must be https');
  if (!s.p256dh || !s.auth) throw new Error('subscription is missing its keys');

  await db.prepare(
    `INSERT OR REPLACE INTO push_subscriptions
       (id, profile_id, endpoint, p256dh, auth, device_label_ar, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(newId('PSH'), ctx.personId, s.endpoint, s.p256dh, s.auth,
         s.deviceLabelAr ?? null, now()).run();
}

/** Forget this device. A resident turning notifications off must actually stop them. */
export async function deleteSubscription(
  ctx: AuthContext, db: Db, endpoint: string,
): Promise<void> {
  await db.prepare(
    `DELETE FROM push_subscriptions WHERE profile_id = ? AND endpoint = ?`
  ).bind(ctx.personId, endpoint).run();
}

/** Where to send one person's message. Live subscriptions only. */
export async function subscriptionsFor(db: Db, profileId: Id) {
  const r = await db.prepare(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions
      WHERE profile_id = ? AND gone_at IS NULL`
  ).bind(profileId).all();
  return r.results as Array<{ id: string; endpoint: string; p256dh: string; auth: string }>;
}

/**
 * Mark a subscription the push service reported as 404/410.
 *
 * Kept rather than deleted, so "my notifications stopped" has an answer on the
 * record instead of a row that silently never existed.
 */
export async function markGone(db: Db, id: string, now: Clock): Promise<void> {
  await db.prepare(`UPDATE push_subscriptions SET gone_at = ? WHERE id = ?`)
    .bind(now(), id).run();
}

export async function markDelivered(db: Db, id: string, now: Clock): Promise<void> {
  await db.prepare(`UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?`)
    .bind(now(), id).run();
}

/** Does the caller have any live device? Drives the enable/disable button. */
export async function hasSubscription(ctx: AuthContext, db: Db): Promise<boolean> {
  const r = await db.prepare(
    `SELECT COUNT(*) n FROM push_subscriptions WHERE profile_id = ? AND gone_at IS NULL`
  ).bind(ctx.personId).first<{ n: number }>();
  return Number(r?.n ?? 0) > 0;
}

/**
 * How many residents this channel actually reaches.
 *
 * Q23's honest weakness is that browser push needs permission, and on iOS the
 * site must be added to the home screen first. Some residents will never do it.
 * **That has to be a number the board can see** — otherwise they will believe
 * everyone was told, which is worse than knowing nobody was.
 */
export async function pushReach(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'system.read_quota');
  const r = await db.prepare(
    `SELECT residents, reachable, dead FROM v_push_reach`
  ).first<{ residents: number; reachable: number; dead: number }>();
  return {
    residents: Number(r?.residents ?? 0),
    reachable: Number(r?.reachable ?? 0),
    dead: Number(r?.dead ?? 0),
  };
}

/* ===================================================================== */
/* The VAPID identity guard — R-069                                      */
/* ===================================================================== */

export class VapidChanged extends Error {
  readonly status = 409;
  // The Arabic reason goes in `message` as well as `reasonAr` — the same fix
  // `Forbidden` needed in session 3. A log line or a test failure that says only
  // "vapid key changed" costs the reader the one sentence that explains what to
  // do about it.
  constructor(readonly reasonAr: string) { super(reasonAr); }
}

/**
 * Record the VAPID key on first use, and refuse to send under a different one.
 *
 * ## Why this is worth a table
 * Deploying a new VAPID key does not "rotate" anything — it **orphans every
 * existing subscription**. Nothing errors: the push service accepts the request
 * and the browser silently drops a message from a sender it does not recognise.
 * Residents stop getting notifications one at a time, and the only signal is
 * someone eventually mentioning it months later.
 *
 * So the first key ever used is recorded and every send checks against it. The
 * honest repair for a mismatch is to **put the original key back**, not to
 * update this row — which is why `trg_vapid_identity_immutable` refuses the
 * update. A guard you can silence by editing a row is a guard that will be
 * silenced by whoever is in a hurry.
 */
export async function assertVapidIdentity(
  db: Db, publicKey: string, now: Clock,
): Promise<void> {
  const fp = await fingerprint(publicKey);
  const row = await db.prepare(`SELECT fingerprint FROM vapid_identity WHERE id = 1`)
    .first<{ fingerprint: string }>();
  if (!row) {
    await db.prepare(
      `INSERT INTO vapid_identity (id, fingerprint, first_seen_at) VALUES (1,?,?)`
    ).bind(fp, now()).run();
    return;
  }
  if (row.fingerprint !== fp) {
    throw new VapidChanged(
      'مفتاح الإشعارات اتغيّر عن اللي السكان مشتركين بيه. ' +
      'كل التنبيهات هتقف من غير ما حد يلاحظ. ' +
      `رجّع المفتاح الأصلي (بصمته ${row.fingerprint}) أو بلّغ الإدارة.`);
  }
}

/** The same short fingerprint `tools/gen-vapid.mjs` prints, so the board can compare. */
export async function fingerprint(publicKey: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(publicKey));
  let s = '';
  for (const b of new Uint8Array(d)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 12);
}

/** What `/admin/health` shows about push. */
export async function vapidStatus(ctx: AuthContext, db: Db, publicKey?: string) {
  require_(ctx.role, 'system.read_quota');
  const row = await db.prepare(`SELECT fingerprint, first_seen_at FROM vapid_identity WHERE id = 1`)
    .first<{ fingerprint: string; first_seen_at: string }>();
  const current = publicKey ? await fingerprint(publicKey) : null;
  return {
    configured: !!publicKey,
    recorded: row?.fingerprint ?? null,
    current,
    firstSeenAt: row?.first_seen_at ?? null,
    /** True means every resident's notifications have silently stopped. */
    mismatch: !!(row && current && row.fingerprint !== current),
  };
}

/* ===================================================================== */
/* Quiet hours                                                           */
/* ===================================================================== */

/**
 * Is `now` inside the village's quiet hours?
 *
 * `settings.notify_quiet_from` / `notify_quiet_to` have existed since CP-1,
 * appear on the settings screen, and were read by nothing. A setting a board
 * turns on that changes no behaviour is worse than no setting: they believe
 * the portal is not ringing an 80-year-old's phone at midnight, and it is.
 *
 * ## What "quiet" suppresses, and what it must never suppress
 *
 * Only the PUSH. The notification row is written in the same batch as the
 * decision that caused it (R-065) and is already readable in `/notifications`
 * before this is ever consulted. Quiet hours make the phone not buzz; they do
 * not delay, drop or hide the message. Anything stronger would make the
 * village's record depend on the time of day.
 *
 * ## Times are compared in Cairo local time
 *
 * The whole system stores UTC, and «من 10 مساءً» means ten in the evening in
 * Marsa Matrouh, not in Greenwich. Egypt observes DST, so the offset is +02:00
 * in winter and +03:00 in summer — computed here from the instant rather than
 * hardcoded, because a hardcoded +02 would start buzzing phones at 11 pm every
 * summer and nobody would connect the two.
 *
 * A window that wraps midnight (22:00 → 09:00, the default) is the normal
 * case, not the edge case, so it is handled first.
 */
export function inQuietHours(nowIso: string, fromHHMM: string, toHHMM: string): boolean {
  const mins = (hhmm: string): number | null => {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm ?? '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const from = mins(fromHHMM), to = mins(toHHMM);
  if (from === null || to === null || from === to) return false;

  // Cairo local time, DST included, without pulling in a timezone library:
  // ask Intl for the wall-clock hour and minute at that instant.
  let hh: number, mm: number;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(nowIso));
    hh = Number(parts.find(p => p.type === 'hour')?.value ?? NaN);
    mm = Number(parts.find(p => p.type === 'minute')?.value ?? NaN);
  } catch {
    return false;   // an unparseable clock must not silence every notification
  }
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return false;
  const at = (hh % 24) * 60 + mm;

  // 22:00 → 09:00 wraps midnight and is the default, so it comes first.
  return from > to ? (at >= from || at < to) : (at >= from && at < to);
}

/** The configured window. Read per send rather than cached: an isolate can
 *  live for hours, and a board that just widened quiet hours means now. */
export async function quietWindow(db: Db): Promise<{ from: string; to: string }> {
  const r = await db.prepare(
    `SELECT notify_quiet_from AS "from", notify_quiet_to AS "to" FROM settings WHERE id = 1`
  ).first<{ from: string; to: string }>();
  return r ?? { from: '22:00', to: '09:00' };
}
