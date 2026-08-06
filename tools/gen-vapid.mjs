#!/usr/bin/env node
/**
 * tools/gen-vapid.mjs — generate the village's Web Push identity. Run ONCE.
 *
 *     node tools/gen-vapid.mjs
 *
 * ## Read this before running it a second time
 * The public key is baked into every browser subscription at the moment the
 * resident taps «شغّل التنبيهات». Generating a new pair does not "rotate" it —
 * it **silently orphans every subscription in the village**. Nothing errors;
 * notifications simply stop, one resident at a time, and the only fix is every
 * one of them re-enabling by hand on their own phone. (R-069.)
 *
 * Migration 0018 stores a fingerprint of the key the first time it is used and
 * refuses to send under a different one, so the failure is loud instead of
 * silent. That guard is a backstop, not permission to re-run this.
 *
 * The private key is a **secret**. It is not a password to anything of the
 * village's — it only proves to a push service that we are the same sender as
 * last time — but leaked, someone else can make every subscribed phone in the
 * compound buzz with whatever text they like, in the portal's name. Treat it
 * accordingly: `wrangler secret put`, never the repository, never a chat
 * message. (R-038 exists because that lesson was learned the expensive way.)
 */

const kp = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const publicKey = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
const privateKey = (await crypto.subtle.exportKey('jwk', kp.privateKey)).d;

// A short fingerprint, so the board can check the deployed key matches the one
// they wrote down without ever handling the private half.
const fp = b64u(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(publicKey))).slice(0, 12);

console.log(`
================================================================
  مفاتيح إشعارات الموقع — بوابة قرية الأطباء
  VAPID keys — generate ONCE, then never again.
================================================================

PUBLIC  (goes in wrangler.toml — safe to publish, it is in every subscription):

  ${publicKey}

PRIVATE (a SECRET — never in the repo, never in a chat message):

  ${privateKey}

FINGERPRINT (write this in the board's minutes — it lets anyone check the
deployed key is the right one without ever touching the private half):

  ${fp}

----------------------------------------------------------------
Next steps, in order:

  1.  Put the public key in wrangler.toml:
        [vars]
        VAPID_PUBLIC_KEY = "${publicKey}"

  2.  Store the private key as a secret (it will prompt for the value):
        npx wrangler secret put VAPID_PRIVATE_KEY

  3.  Set the contact address a push service can reach you at (RFC 8292 §2.1
      requires it; they use it if we ever send something abusive):
        [vars]
        VAPID_SUBJECT = "mailto:board@your-domain"

  4.  Write the fingerprint above into the board's records, next to the
      Cloudflare account details.

⚠️  ما تشغّلش الأمر ده تاني. لو المفتاح اتغيّر، كل ساكن مشغّل التنبيهات هيقف
    يستقبلها، ومحدش هيلاحظ — ولازم كل واحد يشغّلها تاني بإيده من موبايله.
================================================================
`);
