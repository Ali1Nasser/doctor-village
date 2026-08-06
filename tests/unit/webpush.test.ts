/**
 * tests/unit/webpush.test.ts — the Web Push crypto, against the RFC's own vector.
 *
 * ## Why a published test vector is the whole point
 * Push endpoints are unreachable from this sandbox, so an end-to-end send cannot
 * be tested here. That would normally leave the riskiest code in the project
 * unverified — and this code fails **silently**: a subtly wrong key derivation
 * produces a well-formed blob that the push service happily accepts with
 * `201 Created` and the browser cannot decrypt. Every message would vanish with
 * a success response, and nothing on our side would look wrong.
 *
 * RFC 8291 §5 publishes the complete worked example — both keypairs, the auth
 * secret, the salt, the plaintext, and the exact expected body. Reproducing it
 * byte for byte is a stronger check than any live send, because it pins every
 * intermediate value rather than "it seemed to arrive".
 *
 * Vector: https://www.rfc-editor.org/rfc/rfc8291#section-5
 */

import { it, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  encryptPayload, b64uToBytes, bytesToB64u, vapidHeader, generateVapidKeys, sendPush,
} from '../../lib/push/webpush.js';

/* ---------- RFC 8291 §5, verbatim ---------------------------------------- */
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  expectedBody:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLoc' +
    'InmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLV' +
    'WGNWQexSgSxsj_Qulcy4a-fN',
};

/* ================================================================== */
describe('⭐ RFC 8291 §5 — the published vector, byte for byte', () => {

  it('reproduces the exact encrypted body', async () => {
    const body = await encryptPayload(
      V.plaintext,
      { p256dh: V.uaPublic, auth: V.authSecret },
      {
        salt: b64uToBytes(V.salt),
        serverPublic: b64uToBytes(V.asPublic),
        serverPrivate: b64uToBytes(V.asPrivate),
      },
    );
    assert.equal(bytesToB64u(body), V.expectedBody,
      'the encryption does not match RFC 8291 — every push would be undecryptable ' +
      'while the push service returns 201 and nothing looks wrong');
  });

  it('the header framing is right (RFC 8188 §2.1)', async () => {
    const body = await encryptPayload(
      V.plaintext, { p256dh: V.uaPublic, auth: V.authSecret },
      { salt: b64uToBytes(V.salt), serverPublic: b64uToBytes(V.asPublic),
        serverPrivate: b64uToBytes(V.asPrivate) });
    assert.equal(bytesToB64u(body.slice(0, 16)), V.salt, 'salt is not first');
    assert.equal(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0), 4096,
      'record size is not 4096');
    assert.equal(body[20], 65, 'key id length byte is not 65');
    assert.equal(bytesToB64u(body.slice(21, 86)), V.asPublic,
      'the server public key is not in the header — the browser cannot derive the key');
  });
});

/* ================================================================== */
describe('every message is encrypted differently', () => {

  it('⭐ two sends of the same text produce different bodies', async () => {
    // RFC 8291 requires a fresh salt and keypair per message. Reusing a salt
    // across two messages to one subscription leaks the XOR of the plaintexts —
    // and both of ours start «اتقبل إيصالك», so the leak would be most of the
    // message.
    const keys = { p256dh: V.uaPublic, auth: V.authSecret };
    const a = await encryptPayload('اتقبل إيصالك', keys);
    const b = await encryptPayload('اتقبل إيصالك', keys);
    assert.notEqual(bytesToB64u(a), bytesToB64u(b),
      'the same message encrypts identically twice — salt or keypair is being reused');
    assert.notEqual(bytesToB64u(a.slice(0, 16)), bytesToB64u(b.slice(0, 16)), 'salt reused');
    assert.notEqual(bytesToB64u(a.slice(21, 86)), bytesToB64u(b.slice(21, 86)), 'keypair reused');
  });

  it('Arabic survives the round trip into ciphertext length', async () => {
    // A sanity check that the payload is UTF-8 encoded, not truncated to Latin-1:
    // «اتقبل إيصالك» is 12 characters and 22 UTF-8 bytes.
    const msg = 'اتقبل إيصالك';
    const utf8 = new TextEncoder().encode(msg).length;   // 23, not 12
    assert.ok(utf8 > msg.length, 'the fixture is not actually multi-byte');
    const body = await encryptPayload(msg, { p256dh: V.uaPublic, auth: V.authSecret });
    // header 86 + plaintext + delimiter 1 + GCM tag 16.
    // Computed, not hard-coded: my first attempt wrote 22 by counting characters
    // instead of bytes, which is the same mistake the assertion exists to catch.
    assert.equal(body.length, 86 + utf8 + 1 + 16,
      'the Arabic payload was mangled before encryption');
  });

  it('a malformed subscription key is refused, not silently mis-encrypted', async () => {
    await assert.rejects(
      () => encryptPayload('x', { p256dh: bytesToB64u(new Uint8Array(64)), auth: V.authSecret }),
      /uncompressed P-256 point/);
  });
});

/* ================================================================== */
describe('VAPID (RFC 8292)', () => {
  const SUB = 'mailto:board@qaryat-atebaa.example';

  it('the audience is the push service ORIGIN, not the endpoint', async () => {
    const kp = await generateVapidKeys();
    const h = await vapidHeader(
      'https://fcm.googleapis.com/fcm/send/abc123-secret-subscription-id',
      SUB, kp.publicKey, kp.privateKey, 1_754_000_000_000);
    const jwt = /t=([^,]+)/.exec(h)![1]!;
    const claims = JSON.parse(new TextDecoder().decode(b64uToBytes(jwt.split('.')[1]!)));
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    assert.ok(!h.includes('abc123-secret-subscription-id'),
      'the subscription id is inside a header the push service logs');
  });

  it('it expires, and not in a day', async () => {
    const kp = await generateVapidKeys();
    const now = 1_754_000_000_000;
    const h = await vapidHeader('https://push.example/x', SUB, kp.publicKey, kp.privateKey, now);
    const claims = JSON.parse(new TextDecoder().decode(
      b64uToBytes(/t=([^,]+)/.exec(h)![1]!.split('.')[1]!)));
    const life = claims.exp - Math.floor(now / 1000);
    assert.ok(life > 0, 'the token is already expired');
    assert.ok(life <= 24 * 3600, 'RFC 8292 caps exp at 24 hours');
    assert.equal(life, 12 * 3600);
  });

  it('the signature verifies against the advertised public key', async () => {
    // The `k=` parameter is what the push service checks the signature with. If
    // they disagree, every send is rejected with 401 and the cause is invisible.
    const kp = await generateVapidKeys();
    const h = await vapidHeader('https://push.example/x', SUB, kp.publicKey, kp.privateKey, 1_754_000_000_000);
    const jwt = /t=([^,]+)/.exec(h)![1]!;
    const k = /k=(.+)$/.exec(h)![1]!;
    assert.equal(k, kp.publicKey, 'the header advertises a different key than it signed with');

    const [h64, c64, s64] = jwt.split('.');
    const pub = b64uToBytes(k);
    const key = await crypto.subtle.importKey('raw', pub as BufferSource,
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const okSig = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, key, b64uToBytes(s64!) as BufferSource,
      new TextEncoder().encode(`${h64}.${c64}`) as BufferSource);
    assert.ok(okSig, 'the VAPID signature does not verify — every send would 401');
  });

  it('a generated key pair is a real P-256 point', async () => {
    const kp = await generateVapidKeys();
    const pub = b64uToBytes(kp.publicKey);
    assert.equal(pub.length, 65);
    assert.equal(pub[0], 0x04, 'the public key is not an uncompressed point');
    assert.equal(b64uToBytes(kp.privateKey).length, 32);
  });
});

/* ================================================================== */
describe('sending — failures must never break the decision that caused them', () => {
  const SUB = { endpoint: 'https://push.example/s/1', keys: { p256dh: V.uaPublic, auth: V.authSecret } };
  const VAPID = { subject: 'mailto:b@x.example', publicKey: '', privateKey: '' };

  const stub = (status: number, body = '') =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;

  it('a 410 reports the subscription as gone, so the caller can delete it', async () => {
    const kp = await generateVapidKeys();
    const r = await sendPush(SUB, 'x', { ...VAPID, ...kp }, Date.now(), stub(410));
    assert.deepEqual(r, { ok: false, gone: true, status: 410 });
  });

  it('a 404 counts as gone too', async () => {
    const kp = await generateVapidKeys();
    const r = await sendPush(SUB, 'x', { ...VAPID, ...kp }, Date.now(), stub(404));
    assert.equal(r.ok, false);
    assert.equal((r as { gone: boolean }).gone, true);
  });

  it('⭐ a 500 from the push service RETURNS, it does not throw', async () => {
    // Push is a courtesy on top of the inbox, never the record. A resident whose
    // phone rejected a message must not cause the approval that triggered it to
    // fail — the message is already in `notifications` before this runs.
    const kp = await generateVapidKeys();
    const r = await sendPush(SUB, 'x', { ...VAPID, ...kp }, Date.now(), stub(500, 'boom'));
    assert.equal(r.ok, false);
    assert.equal((r as { gone: boolean }).gone, false);
  });

  it('the request carries the headers the push service requires', async () => {
    const kp = await generateVapidKeys();
    let seen: RequestInit | undefined;
    const spy = (async (_u: string, init: RequestInit) => {
      seen = init; return new Response('', { status: 201 });
    }) as unknown as typeof fetch;
    await sendPush(SUB, 'x', { ...VAPID, ...kp }, Date.now(), spy);
    const h = seen!.headers as Record<string, string>;
    assert.equal(h['content-encoding'], 'aes128gcm');
    assert.match(h['authorization']!, /^vapid t=.+, k=.+$/);
    assert.ok(Number(h['ttl']) > 0, 'no TTL — some push services reject the request');
  });
});
