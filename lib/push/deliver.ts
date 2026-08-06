/**
 * lib/push/deliver.ts — send one notification to every device a resident has.
 *
 * ## The single most important property: this can never break a decision
 *
 * The message is already in `notifications`, written in the **same
 * `db.batch()`** as the approval or reversal that caused it (R-065). By the
 * time this runs, the resident can already read it in `/notifications`.
 *
 * So every failure here is swallowed and reported, never thrown. A phone that
 * is off, a push service having a bad afternoon, a subscription the browser
 * silently rotated — none of those may cause an admin's approval to fail. **Push
 * is a courtesy on top of the inbox, never the record**, and building it the
 * other way round would mean the village's books depended on Google's uptime.
 *
 * ## Why it is called after the transaction, not inside it
 * A `fetch` inside a `db.batch()` would hold a write transaction open for the
 * duration of a network round trip to a push service that may be slow — on a
 * database whose free tier counts rows written per day. The decision commits;
 * then the phones get told.
 */

import type { Db } from '../db/driver.js';
import type { Id } from '../../types/domain.js';
import type { Clock } from '../db/index.js';
import * as store from '../db/push.js';
import { sendPush } from './webpush.js';

export interface VapidIdentity {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export interface DeliverResult {
  sent: number;
  /** Subscriptions the push service says no longer exist; marked, not deleted. */
  gone: number;
  /** Everything else — a phone or a push service having a bad day. */
  failed: number;
}

/**
 * Deliver `title`/`body` to every live device belonging to `profileId`.
 *
 * The payload deliberately carries **only what the notification tray shows**,
 * plus a link. It does not carry the amount, the reason, or the receipt number
 * beyond what is already in the title — a notification is rendered on a locked
 * screen that anyone standing near the phone can read, and «التحويل رجع من
 * البنك يوم ١٢ مايو» is nobody else's business. The details live behind the
 * link, behind the session.
 */
export async function deliverPush(
  db: Db,
  profileId: Id,
  msg: { title: string; body: string; url?: string },
  vapid: VapidIdentity,
  now: Clock,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliverResult> {
  const out: DeliverResult = { sent: 0, gone: 0, failed: 0 };
  let subs: Awaited<ReturnType<typeof store.subscriptionsFor>>;
  try {
    // R-069: refuse to send under a key the residents did not subscribe with.
    // Sending anyway would succeed at every layer and be dropped by the browser,
    // which is the silent failure this guard exists to convert into a loud one.
    await store.assertVapidIdentity(db, vapid.publicKey, now);
    subs = await store.subscriptionsFor(db, profileId);
  } catch {
    // Even this must not throw into the caller — the decision has already
    // committed and the message is already in the inbox. `/admin/health`
    // surfaces the mismatch; a failed approval would not help anybody.
    return out;
  }

  const payload = JSON.stringify({
    title: msg.title,
    // Truncated: Android collapses past ~120 characters anyway, and a lock
    // screen is a public surface. The full text is one tap away.
    body: msg.body.split('\n')[0]!.slice(0, 120),
    url: msg.url ?? '/notifications',
  });

  for (const s of subs) {
    try {
      const r = await sendPush(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload, vapid, Date.parse(now()), fetchImpl);
      if (r.ok) {
        out.sent += 1;
        await store.markDelivered(db, s.id, now);
      } else if (r.gone) {
        out.gone += 1;
        // MUST be marked: a push service will rate-limit a sender that keeps
        // posting to endpoints it has told them are dead.
        await store.markGone(db, s.id, now);
      } else {
        out.failed += 1;
      }
    } catch {
      out.failed += 1;
    }
  }
  return out;
}
