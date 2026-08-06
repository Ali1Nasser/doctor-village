/**
 * lib/push/webpush.ts — Web Push, from scratch, with no vendor.
 *
 * The owner chose browser push (Q23). It is the only channel that reaches a
 * resident's phone and still satisfies C11: no account, no card, no API key, no
 * company that can start charging in October. The browser's own push service
 * (FCM for Chrome, Mozilla's for Firefox, Apple's for Safari) delivers the
 * message, and it is free because it is part of the browser, not a product.
 *
 * The cost of "no vendor" is that we implement two RFCs ourselves:
 *   · **RFC 8291** — message encryption (ECDH P-256 → HKDF → AES-128-GCM).
 *     The push service relays an opaque blob; only the resident's browser holds
 *     the key. **Neither Google nor Mozilla can read «اتقبل إيصالك».**
 *   · **RFC 8292** — VAPID, an ES256 JWT proving the sender is us.
 *
 * ## How this is verified without a browser or a network
 * Push endpoints are unreachable from the build sandbox, so an end-to-end send
 * cannot be tested here — the same wall as the D1 gate. What CAN be tested, and
 * is, is that the encryption reproduces **RFC 8291 §5's published test vector
 * byte for byte**. That is the part that is hard to get right and silent when
 * wrong: a subtly wrong key derivation produces a well-formed blob the push
 * service accepts and the browser cannot open, so every message vanishes with
 * a 201 Created. Matching the vector is what makes the crypto trustworthy;
 * delivery still has to be proven on a real phone (CP-7).
 *
 * Everything below uses WebCrypto only, so it runs unchanged on Workers.
 */

const enc = new TextEncoder();

/* ---------- base64url, the only encoding this whole area speaks ---------- */

export function b64uToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* ---------- HKDF, spelled out because RFC 8291 uses it three times ------- */

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as BufferSource));
}

/** One-block HKDF-expand. Every output here is ≤32 bytes, so one block is enough. */
async function hkdf(
  salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number,
): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

/* ---------- P-256 keys ---------------------------------------------------- */

/** An uncompressed point (0x04 ‖ X ‖ Y) → the JWK WebCrypto wants. */
function pointToJwk(pub: Uint8Array, d?: Uint8Array): JsonWebKey {
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('expected an uncompressed P-256 point (65 bytes, 0x04 prefix)');
  }
  const jwk: JsonWebKey = {
    kty: 'EC', crv: 'P-256', ext: true,
    x: bytesToB64u(pub.slice(1, 33)),
    y: bytesToB64u(pub.slice(33, 65)),
  };
  if (d) jwk.d = bytesToB64u(d);
  return jwk;
}

/**
 * Generate the server's VAPID identity. Run ONCE, ever.
 *
 * ⚠️ The public key is baked into every browser subscription. Rotating it
 * silently invalidates every resident's subscription and they must re-enable
 * notifications by hand — the same failure mode as changing the passkey RP ID
 * (R-022). Generate once, store as a Worker secret, and write it down.
 */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: bytesToB64u(pub), privateKey: jwk.d! };
}

/* ---------- RFC 8291: encrypt the message -------------------------------- */

export interface PushKeys {
  /** The browser's public key, base64url — `subscription.keys.p256dh`. */
  p256dh: string;
  /** The browser's 16-byte auth secret, base64url — `subscription.keys.auth`. */
  auth: string;
}

/**
 * Encrypt a payload for one subscription, producing an `aes128gcm` body.
 *
 * `salt` and `serverKeys` are injectable **only** so the RFC test vector can be
 * reproduced. In production both are freshly random per message, which RFC 8291
 * requires: reusing a salt across two messages to the same subscription leaks
 * the XOR of the plaintexts.
 */
export async function encryptPayload(
  plaintext: string,
  keys: PushKeys,
  fixed?: { salt: Uint8Array; serverPublic: Uint8Array; serverPrivate: Uint8Array },
): Promise<Uint8Array> {
  const uaPublic = b64uToBytes(keys.p256dh);
  const authSecret = b64uToBytes(keys.auth);

  let salt: Uint8Array, asPublic: Uint8Array, asPrivateKey: CryptoKey;
  if (fixed) {
    salt = fixed.salt;
    asPublic = fixed.serverPublic;
    asPrivateKey = await crypto.subtle.importKey(
      'jwk', pointToJwk(fixed.serverPublic, fixed.serverPrivate),
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(16));
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    asPrivateKey = kp.privateKey;
  }

  const uaKey = await crypto.subtle.importKey(
    'jwk', pointToJwk(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, asPrivateKey, 256));

  // RFC 8291 §3.4. The key_info binds BOTH public keys into the derivation, so
  // a message encrypted for one subscription cannot be replayed at another.
  const keyInfo = concat(enc.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt']);
  // 0x02 is the final-record delimiter (RFC 8188 §2). We always send one record.
  const padded = concat(enc.encode(plaintext), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource }, aes, padded as BufferSource));

  // Header: salt(16) ‖ record size(4, BE) ‖ key id length(1) ‖ key id (RFC 8188 §2.1)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

/* ---------- RFC 8292: prove the sender is us ----------------------------- */

/**
 * A VAPID `Authorization` header.
 *
 * `aud` is the push service's ORIGIN, not the full endpoint — a JWT scoped to
 * the whole endpoint would leak which subscription it belongs to into a header
 * the push service logs.
 */
export async function vapidHeader(
  endpoint: string, subject: string, publicKey: string, privateKeyD: string, nowMs: number,
): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  // 12 hours. RFC 8292 caps `exp` at 24h; half of that leaves room for a phone
  // with a badly-set clock without making a stolen header useful for a day.
  const claims = bytesToB64u(enc.encode(JSON.stringify({
    aud, exp: Math.floor(nowMs / 1000) + 12 * 60 * 60, sub: subject,
  })));
  const signingInput = `${header}.${claims}`;

  const pub = b64uToBytes(publicKey);
  const key = await crypto.subtle.importKey(
    'jwk', { ...pointToJwk(pub, b64uToBytes(privateKeyD)) },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput) as BufferSource));

  return `vapid t=${signingInput}.${bytesToB64u(sig)}, k=${publicKey}`;
}

/* ---------- sending ------------------------------------------------------ */

export interface PushSubscription {
  endpoint: string;
  keys: PushKeys;
}

export type PushResult =
  | { ok: true }
  /** The subscription is dead — the resident uninstalled, cleared data, or the
   *  browser rotated it. The caller MUST delete it; a push service will
   *  eventually rate-limit a sender that keeps posting to gone endpoints. */
  | { ok: false; gone: true; status: number }
  | { ok: false; gone: false; status: number; body: string };

/**
 * Deliver one message.
 *
 * Returns rather than throws, because the only sane reaction to most failures
 * is "record it and carry on": a resident whose phone rejected a push must not
 * cause the decision that triggered it to fail. **Push is a courtesy on top of
 * the inbox, never the record.** The message is already in `notifications`
 * before this is called, and the resident can read it there whatever happens.
 */
export async function sendPush(
  sub: PushSubscription, payload: string, vapid: { subject: string; publicKey: string; privateKey: string },
  nowMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PushResult> {
  const body = await encryptPayload(payload, sub.keys);
  const auth = await vapidHeader(sub.endpoint, vapid.subject, vapid.publicKey, vapid.privateKey, nowMs);
  const res = await fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: {
      'authorization': auth,
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      // 4 hours. If the phone has been off longer than that, the inbox is the
      // right place for the news anyway.
      'ttl': '14400',
      'urgency': 'normal',
    },
    body: body as BodyInit,
  });
  if (res.status === 404 || res.status === 410) {
    return { ok: false, gone: true, status: res.status };
  }
  if (!res.ok) return { ok: false, gone: false, status: res.status, body: await res.text() };
  return { ok: true };
}
