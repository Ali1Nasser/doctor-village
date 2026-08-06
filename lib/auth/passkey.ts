/**
 * lib/auth/passkey.ts — the WebAuthn ceremonies.
 *
 * ## Why a library and not hand-rolled verification (ADR-020)
 *
 * Verifying a WebAuthn response means parsing CBOR, decoding a COSE key,
 * checking an RP-ID hash, checking flags, and verifying an ECDSA or RSA
 * signature. Every one of those has a failure mode where the code still
 * "works" — you get a session, the user is happy, and the security property is
 * simply absent. Forgetting to check `origin` makes the whole thing phishable;
 * forgetting the RP-ID hash lets another site's credential in; skipping the UV
 * flag turns "الدخول ببصمة" into "الدخول بأي حاجة".
 *
 * `@simplewebauthn/server` is maintained, widely used, and runs on WebCrypto so
 * it works on Workers. It is not a vendor and costs nothing, so C11 is unaffected.
 * Hand-rolling this to avoid a dependency would be the wrong trade in a system
 * that holds money.
 *
 * What this file still owns, because a library cannot decide it for us:
 *   · the challenge is OURS, stored server-side, single-use;
 *   · user verification is REQUIRED — the fingerprint is the whole point;
 *   · the sign counter is checked for clones;
 *   · login reveals nothing about whether a phone number is registered.
 */

import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { Db } from '../db/driver.js';
import type { Clock } from '../db/index.js';
import * as adb from '../db/auth.js';

export interface RelyingParty {
  /** e.g. 'qaryat-atebaa.pages.dev'. R-022: passkeys are BOUND to this. */
  id: string;
  name: string;
  /** e.g. 'https://qaryat-atebaa.pages.dev' — checked on every ceremony. */
  origin: string;
}

export class AuthFailed extends Error {
  readonly status = 401;
  constructor(readonly reasonAr = 'مقدرناش نتأكد إنه إنت. جرّب تاني، ولو فضل كلّم الإدارة.') {
    super('auth failed');
  }
}
export class RateLimited extends Error {
  readonly status = 429;
  constructor(readonly reasonAr = 'حاول تاني بعد شوية. لو محتاج مساعدة كلّم الإدارة.') {
    super('rate limited');
  }
}

const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

/* ===================================================================== */
/* Enrollment — runs immediately after a valid activation link           */
/* ===================================================================== */

export async function beginEnrollment(
  db: Db, rp: RelyingParty, profileId: string, fullName: string, now: Clock,
) {
  const existing = await adb.listCredentialsForLogin(db, profileId);
  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userID: new TextEncoder().encode(profileId),
    userName: fullName,
    userDisplayName: fullName,
    // Discoverable credentials: the phone can offer the passkey without being
    // told which account to look for, which is what makes a one-touch login
    // possible for somebody who will never remember an identifier.
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',   // fingerprint or device lock — the product promise
    },
    // Never let a device silently enroll twice; a second passkey should be a
    // deliberate act on a DIFFERENT device (R-023).
    excludeCredentials: existing.map(c => ({
      id: c.credential_id,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
    attestationType: 'none',   // we do not need to know the device model
  });

  const key = b64url(crypto.getRandomValues(new Uint8Array(16)));
  await adb.putWebAuthnChallenge(db, key, options.challenge, profileId, now);
  return { key, options };
}

export async function finishEnrollment(
  db: Db, rp: RelyingParty, key: string, response: unknown, deviceLabelAr: string, now: Clock,
): Promise<{ profileId: string }> {
  const stored = await adb.takeWebAuthnChallenge(db, key, now);
  if (!stored?.profileId) throw new AuthFailed();

  const v = await verifyRegistrationResponse({
    response: response as never,
    expectedChallenge: stored.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    requireUserVerification: true,
  }).catch(() => null);

  if (!v?.verified || !v.registrationInfo) throw new AuthFailed();
  const { credential } = v.registrationInfo;

  await adb.saveCredential(db, stored.profileId, {
    credentialId: credential.id,
    publicKey: credential.publicKey,
    signCount: credential.counter,
    transports: (response as { response?: { transports?: string[] } })?.response?.transports ?? null,
    rpId: rp.id,
    deviceLabelAr,
  });
  return { profileId: stored.profileId };
}

/* ===================================================================== */
/* Login                                                                 */
/* ===================================================================== */

const WINDOW_SECONDS = 15 * 60;
const MAX_PER_PHONE = 5;      // 03_RBAC §4
const MAX_PER_IP = 20;

function minus(now: string, seconds: number): string {
  return new Date(Date.parse(now) - seconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
}

/**
 * Begin a login.
 *
 * ⚠️ ENUMERATION: this returns a well-formed options object **whether or not the
 * number is registered**. An unknown number gets a real challenge and an empty
 * `allowCredentials`, so the browser simply finds no passkey and the ceremony
 * ends the same way a wrong device would. Without this, anyone could type
 * numbers at the login screen and learn which ones belong to the compound —
 * a list of 200 residents' phone numbers, handed out by the front door.
 */
export async function beginLogin(
  db: Db, rp: RelyingParty, phoneE164: string, ip: string | null, now: Clock,
) {
  const since = minus(now(), WINDOW_SECONDS);
  const byPhone = await adb.countRecentAttempts(db, 'login_begin', phoneE164, since);
  if (byPhone >= MAX_PER_PHONE) throw new RateLimited();
  if (ip) {
    const byIp = await adb.countRecentAttempts(db, 'login_begin', ip, since);
    if (byIp >= MAX_PER_IP) throw new RateLimited();
  }
  await adb.recordAttempt(db, 'login_begin', phoneE164, true, now);
  if (ip) await adb.recordAttempt(db, 'login_begin', ip, true, now);

  const profile = await adb.findProfileByPhone(db, phoneE164);
  const creds = profile ? await adb.listCredentialsForLogin(db, profile.id) : [];

  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    userVerification: 'required',
    allowCredentials: creds.map(c => ({
      id: c.credential_id,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
  });

  // The challenge row is stored even for an unknown number, so the timing and
  // the response shape are identical either way.
  const key = b64url(crypto.getRandomValues(new Uint8Array(16)));
  await adb.putWebAuthnChallenge(db, key, options.challenge, profile?.id ?? null, now);

  return {
    key,
    options,
    /** True only when the number is known AND has no passkey yet — the caller
     *  shows "كلّم الإدارة يبعتولك لينك التفعيل" without confirming existence,
     *  because it says the same thing for an unknown number. */
    needsActivation: !profile || creds.length === 0,
  };
}

export async function finishLogin(
  db: Db, rp: RelyingParty, key: string, response: unknown, ip: string | null, now: Clock,
): Promise<{ profileId: string }> {
  const stored = await adb.takeWebAuthnChallenge(db, key, now);
  if (!stored) throw new AuthFailed();

  const rawId = (response as { id?: string })?.id;
  if (!rawId) throw new AuthFailed();

  const cred = await adb.getCredential(db, rawId);
  if (!cred || !cred.is_active) {
    await adb.recordAttempt(db, 'login_finish', ip ?? 'unknown', false, now);
    throw new AuthFailed();
  }

  const v = await verifyAuthenticationResponse({
    response: response as never,
    expectedChallenge: stored.challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    requireUserVerification: true,
    credential: {
      id: cred.credential_id,
      publicKey: toBytes(cred.public_key),
      counter: cred.sign_count,
      transports: cred.transports ? JSON.parse(cred.transports) : undefined,
    },
  }).catch(() => null);

  if (!v?.verified) {
    await adb.recordAttempt(db, 'login_finish', ip ?? 'unknown', false, now);
    throw new AuthFailed();
  }

  // Clone detection. A counter that fails to advance means the credential this
  // request used is not the only copy in the world.
  const counter = await adb.updateSignCount(
    db, cred.credential_id, v.authenticationInfo.newCounter, cred.sign_count, now);
  if (counter === 'cloned') {
    await adb.recordAttempt(db, 'login_finish', cred.profile_id, false, now);
    throw new AuthFailed('فيه مشكلة أمنية في الجهاز ده. كلّم الإدارة قبل ما تحاول تاني.');
  }

  await adb.recordAttempt(db, 'login_finish', cred.profile_id, true, now);
  return { profileId: cred.profile_id };
}

/** node:sqlite returns BLOBs as Buffer/Uint8Array depending on driver. */
function toBytes(v: unknown): Uint8Array<ArrayBuffer> {
  // Copy rather than view: D1 and node:sqlite hand back BLOBs in different
  // shapes, and a SharedArrayBuffer-backed view is not assignable where
  // WebCrypto expects a plain ArrayBuffer.
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (Array.isArray(v)) return new Uint8Array(v);
  if (v && typeof v === 'object' && 'buffer' in (v as ArrayBufferView)) {
    const a = v as ArrayBufferView;
    return new Uint8Array(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }
  throw new AuthFailed();
}

/* ===================================================================== */
/* Tokens                                                                */
/* ===================================================================== */

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Activation codes a human reads aloud or types: no 0/O/1/I/l confusion. */
export function humanCode(groups = 3, len = 4): string {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(groups * len));
  const out: string[] = [];
  for (let g = 0; g < groups; g++) {
    let s = '';
    for (let i = 0; i < len; i++) s += ALPHABET[bytes[g * len + i]! % ALPHABET.length];
    out.push(s);
  }
  return out.join('-');
}

export async function sha256(input: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Buffer.from(new Uint8Array(d)).toString('hex');
}

export { fromB64url, b64url };
