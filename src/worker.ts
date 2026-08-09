/**
 * src/worker.ts — the production entry point.
 *
 * `wrangler.toml` has pointed `main` at this file since CP-0 and the file did
 * not exist, so the project could be verified 500 ways and never deployed. This
 * is the missing half-page that makes the difference.
 *
 * ## Why it is this short
 *
 * `lib/db/driver.ts` defines `Db` as the exact shape of Cloudflare's D1 binding
 * — `prepare().bind().first()/all()/run()` plus `batch()` — deliberately, so a
 * real D1 binding *is* a `Db` with no adapter in between. Everything else in the
 * app is already environment-free: the views are strings, the data layer takes
 * a `Db`, the clock is injected. So production wiring is: hand `createApp` the
 * bindings, and serve.
 *
 * ## Two databases, on purpose (ADR-023)
 *
 * `DB` holds the ledger. `RECEIPTS` holds image bytes. They are separate D1
 * databases so that a receipt blob cannot sit in the same file as a journal
 * line — the backup, the restore drill and the storage cap all operate on the
 * ledger without dragging megabytes of JPEG through them. Locally they are the
 * same database, which is fine, and is exactly why nothing may assume they are.
 *
 * ## Failing loudly on a missing binding
 *
 * A Worker with no `DB` binding would otherwise throw deep inside the first
 * query as "cannot read properties of undefined", on a resident's screen. The
 * check below turns that into one Arabic sentence naming what the deployer
 * forgot.
 */

import { createApp } from './app.js';
import { SERVICE_WORKER } from './sw.js';
import type { Db } from '../lib/db/driver.js';
import { D1BlobStorage } from '../lib/storage/d1blob.js';
import { setTokenHasher, recordQuotaSnapshot } from '../lib/db/index.js';

/**
 * Minimal Workers runtime types, declared here rather than depending on
 * `@cloudflare/workers-types`. The package is ~1 MB of ambient declarations for
 * the two shapes this file touches, and every dependency added to a project
 * whose whole premise is "no vendor lock-in" is one more thing to remove if D1's
 * free tier ever disappears (C11 / driver.ts).
 */
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
interface ScheduledEvent { readonly scheduledTime: number; readonly cron: string }

export interface Env {
  DB: Db;
  /** Separate D1 database for receipt bytes (ADR-023). Falls back to DB. */
  RECEIPTS?: Db;
  WEBAUTHN_RP_ID: string;
  WEBAUTHN_RP_NAME: string;
  WEBAUTHN_ORIGIN: string;
  APP_ENV?: string;
  /** Web Push identity. Absent = push is off and the button is not rendered. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

/**
 * Session tokens are hashed with WebCrypto here rather than node:crypto.
 * `setTokenHasher` exists because the same hash has to be computable in three
 * places — the Node tests, the local server and the Worker — and only the first
 * has `createHash`. Registered once per isolate at module scope.
 */
setTokenHasher(async (token: string) => {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
});

function missingBinding(name: string): Response {
  // Deployment mistakes are for the deployer, not the resident — but the
  // resident is who sees the screen, so they get a sentence that tells them
  // it is not their fault and who to tell.
  return new Response(
    `<!DOCTYPE html><html lang="ar" dir="rtl"><meta charset="utf-8">`
    + `<title>البوابة مش جاهزة</title>`
    + `<body style="font-family:system-ui;padding:32px;line-height:1.9;text-align:center">`
    + `<h1>البوابة لسه بتتظبط</h1>`
    + `<p>الربط بقاعدة البيانات (<code>${name}</code>) ناقص في النشر.</p>`
    + `<p>ده خطأ في الإعداد مش في حسابك — بلّغ مجلس الإدارة.</p></body></html>`,
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (!env.DB) return missingBinding('DB');

    const url = new URL(request.url);

    // The service worker must be served from the origin root to control the
    // whole scope; it is generated, not a static asset, so it is answered here.
    if (url.pathname === '/sw.js') {
      return new Response(SERVICE_WORKER, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-cache',
        },
      });
    }

    const db = env.DB;
    const receipts = env.RECEIPTS ?? db;
    const storage = new D1BlobStorage(receipts);

    // ⭐ No `payCategories` here, deliberately — see the note in `src/app.ts`.
    //
    // This used to build the /pay step-2 grid by calling
    // `resolveAuthContext(db, null, …)`. A null token has no context, so that
    // call correctly returned null, the `if (ctx)` never ran, and the list was
    // empty on **every request the deployed site ever served**. Step 2 is
    // nothing but that grid, and its tiles are the form's submit buttons, so
    // the payment journey was stuck at «على إيه؟» in production for everyone.
    // Locally it worked, because the local server has a real context to hand —
    // which is exactly why it survived until somebody drove the deployed site
    // in a browser.
    //
    // Categories are per-request data about the person asking. The route reads
    // them with the caller's own identity now, and nothing here pretends to
    // know the answer before the request exists.

    const app = createApp({
      db,
      now: () => new Date().toISOString(),
      storage,
      storagePut: i => storage.put(i),
      storageUsedBytes: () => storage.usedBytes(),
      // The second binding itself, so `/admin/health` can ask it whether it
      // holds its schema. It shipped empty once (R-125) and nothing noticed.
      receiptsDb: receipts,
      // C10: the demo banner is driven by the deployed environment, never by a
      // query parameter. A production database must never be able to render
      // "these figures are invented", and a demo one must never fail to.
      demo: env.APP_ENV === 'demo',
      rp: {
        id: env.WEBAUTHN_RP_ID,
        name: env.WEBAUTHN_RP_NAME,
        origin: env.WEBAUTHN_ORIGIN,
      },
      vapid: env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
        ? {
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY,
            subject: env.VAPID_SUBJECT ?? `https://${env.WEBAUTHN_RP_ID}`,
          }
        : undefined,
    });

    return app.fetch(request);
  },

  /**
   * Nightly, per `[triggers] crons` in wrangler.toml.
   *
   * It records a quota snapshot rather than taking a backup. That is not a
   * shortcut — CP-8's restore drill proved that a backup of this schema has to
   * replay in dependency order with posting last (`tools/backup.mjs`), and a
   * Worker cron has neither the CPU budget nor a place to put the file. The
   * board's backup runs from `npm run backup` against the D1 export, which is
   * the path the drill actually verifies.
   */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.DB) return;
    try {
      // The SQL lives in lib/db/ — tools/lint-no-sql.mjs refused it here, and
      // was right to: the rule's value is being absolute.
      await recordQuotaSnapshot(env.DB, () => new Date().toISOString());
    } catch (e) {
      console.error('[cron] quota snapshot failed', e);
    }
  },
};
