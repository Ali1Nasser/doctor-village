/**
 * lib/auth/password.ts — the SECOND way into an account.
 *
 * Passkeys remain the design (04_UX_SPEC §3): one touch, nothing to remember,
 * nothing to phish. This exists because that design has a hardware
 * prerequisite the village does not uniformly meet — a phone with no platform
 * authenticator cannot enrol a passkey at all, and a portal its owner cannot
 * open is not a portal.
 *
 * Everything here is deliberately boring. There is no clever scheme, no pepper
 * in an environment variable somebody will forget to set on the next
 * deployment, and no dependency: WebCrypto is what a Worker has, PBKDF2 is
 * what WebCrypto offers, and PBKDF2 correctly used is enough for a credential
 * that is rate limited, second to a passkey, and audited on every use.
 */

/**
 * ⛔ **100,000 is a CEILING imposed by the runtime, not a number we chose.**
 *
 * The Workers implementation of WebCrypto refuses anything higher, by name:
 *
 *     NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 *     supported (requested 210000).
 *
 * This was written at 210,000 first, passed every test in Node — whose
 * `crypto.subtle` has no such cap — and returned a 500 on the first real
 * request against the deployed Worker. **Do not raise it back.** A test below
 * asserts the ceiling so the next person to reach for a bigger number finds out
 * from a red build instead of from a board member who cannot log in.
 *
 * OWASP's 2023 guidance for PBKDF2-HMAC-SHA256 is 600,000, so this is six times
 * short of it and that is worth stating plainly rather than burying. What makes
 * it acceptable *here*, and would not make it acceptable for a primary
 * credential:
 *
 *   · the password is the SECOND way in, behind a passkey, and does not exist
 *     at all until an admin issues one;
 *   · the one the board hands out is generated, not chosen — ~57 bits from a
 *     27-character alphabet, which no offline attack reaches regardless of the
 *     iteration count;
 *   · online guessing is capped at five attempts per fifteen minutes, per IP
 *     **and** per number;
 *   · every issue, change and clear is on the audit trail.
 *
 * The residual risk is an offline attack on a stolen database against a
 * password the RESIDENT chose, which is the case `checkPasswordStrength`
 * exists to keep out of the "eight characters, all lowercase" range. Recorded
 * as R-115.
 *
 * Stored per row rather than read from here at verify time, so if the platform
 * ever lifts the cap, raising this re-costs new passwords without invalidating
 * hashes written at the old number.
 */
export const PBKDF2_ITERATIONS = 100_000;

/** What the Workers runtime refuses to exceed. See the note above. */
export const PBKDF2_RUNTIME_MAX = 100_000;

const enc = new TextEncoder();

const b64 = (b: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(b)));

const unb64 = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function derive(
  password: string, salt: Uint8Array, iterations: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
    key, 256,
  );
  return b64(bits);
}

export interface PasswordHash {
  salt: string;
  hash: string;
  iterations: number;
}

/**
 * `normalize('NFKC')` before hashing, in both directions.
 *
 * Arabic text and Arabic-Indic digits have more than one valid encoding, and a
 * phone keyboard does not promise which one it sends. Without normalisation a
 * password typed identically on two keyboards can hash differently — which
 * presents to the resident as "it worked yesterday".
 */
export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    salt: b64(salt.buffer as ArrayBuffer),
    hash: await derive(password, salt, PBKDF2_ITERATIONS),
    iterations: PBKDF2_ITERATIONS,
  };
}

/**
 * Constant-time comparison.
 *
 * `a === b` on the derived key leaks, through timing, how many leading bytes a
 * guess got right — which turns 2^256 into a few thousand requests. The
 * comparison below always walks the whole string.
 */
export async function verifyPassword(
  password: string, stored: PasswordHash,
): Promise<boolean> {
  let candidate: string;
  try {
    candidate = await derive(password, unb64(stored.salt), stored.iterations);
  } catch {
    return false;                                  // a corrupt row is not a match
  }
  if (candidate.length !== stored.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) {
    diff |= candidate.charCodeAt(i) ^ stored.hash.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * The password the BOARD hands out — generated here, never chosen by them.
 *
 * Shaped like the printed recovery codes (`ABCD-EFGH-JKLM`) because it travels
 * the same way: read aloud on the phone, or typed off a WhatsApp message by
 * somebody who is 71. The alphabet has no `0/O`, `1/I/L`, `5/S` or `2/Z`, so
 * "is that a one or an el" never happens.
 *
 * Three groups of four from a 28-character alphabet is ~57 bits — far past
 * anything guessable against a rate limiter, and still readable.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRTUVWXY346789';

export function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = Array.from(bytes, b => ALPHABET[b % ALPHABET.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)]
    .map(g => g.join('')).join('-');
}

export type PasswordProblem = 'tooShort' | 'sameAsPhone' | 'tooSimple';

/**
 * What a resident may set for themselves.
 *
 * Deliberately not a policy of symbols and capitals: those produce `Aa1!aa1!`
 * on a sticky note, and this credential is already the second factor rather
 * than the wall. Length is the property that matters, plus a refusal of the
 * two things people here actually type — their own phone number, and one
 * repeated character.
 */
export function checkPasswordStrength(
  password: string, phoneE164: string | null,
): PasswordProblem | null {
  const p = (password ?? '').trim();
  if (p.length < 8) return 'tooShort';
  const digits = p.replace(/\D/g, '');
  if (digits.length >= 8 && phoneE164 && phoneE164.includes(digits)) return 'sameAsPhone';
  if (new Set(p).size <= 2) return 'tooSimple';
  return null;
}
