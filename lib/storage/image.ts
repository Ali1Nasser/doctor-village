/**
 * lib/storage/image.ts — remove the metadata from an uploaded photo, on the
 * server, before it is stored.
 *
 * ## The hole this closes
 *
 * `storage_objects.exif_stripped` existed, the schema refused a photo that
 * claimed otherwise, and both upload paths passed `exifStripped: true` on bytes
 * nothing had ever looked at. The actual stripping happened in the browser, as
 * a side effect of re-encoding through a canvas (`src/views/island.ts`).
 *
 * That is a real guarantee for a resident using the site normally and no
 * guarantee at all against a request that skips the page — curl, a script, a
 * browser with JavaScript off, a modified client. The column would say the
 * photo was clean and the photo would carry the GPS coordinates of the
 * resident's flat, which is the single most sensitive thing a village portal
 * can accidentally publish. A control that a client can decline is a claim,
 * not a control.
 *
 * So the bytes are parsed here, the metadata containers are removed here, and
 * `exif_stripped` is set from what this function actually did.
 *
 * ## What it removes
 *
 *   WebP  EXIF, XMP and ICCP chunks; the VP8X flag bits that announce them.
 *   JPEG  APP1…APP15 (EXIF, XMP, Photoshop IRB) and COM. APP0/JFIF is kept —
 *         it is dimensions and density, and some decoders want it.
 *   PNG   eXIf, tEXt, iTXt, zTXt, tIME.
 *
 * Pixel data is never touched. This is a container edit, not a re-encode: it
 * cannot change how the receipt looks, which matters because the receipt is
 * evidence in a dispute about money.
 *
 * ## What it refuses
 *
 * Anything else, including a HEIC straight off an iPhone. Refusing is the
 * honest answer: storing a format whose metadata layout is not understood,
 * while recording that its metadata was removed, is worse than a clear error
 * telling the resident to try again.
 */

export type ImageKind = 'webp' | 'jpeg' | 'png';

export class UnsupportedImage extends Error {
  readonly status = 415;
  constructor(readonly reasonAr: string) { super('unsupported image'); }
}

export interface StripResult {
  /** The photo with its metadata containers removed. */
  bytes: Uint8Array;
  /** The format actually found — NOT what the caller assumed it was. */
  mime: `image/${ImageKind}`;
  /** Chunk/segment names removed, for the audit trail and the tests. */
  removed: string[];
}

const ascii = (b: Uint8Array, at: number, n: number) =>
  String.fromCharCode(...b.subarray(at, at + n));

/**
 * A file whose structure stops making sense partway through.
 *
 * This throws rather than salvaging, and the reason is a bug this code had:
 * the walk stopped at the damaged chunk, found nothing it recognised as
 * metadata BEFORE that point, and returned the original buffer — with the
 * half-written EXIF chunk still in it. Stopping early and returning the input
 * is the one outcome that must never happen here, because it looks exactly
 * like success. A truncated photo is unusable as evidence anyway; the resident
 * gets told to send it again.
 */
function truncated(): never {
  throw new UnsupportedImage(
    'الصورة وصلت ناقصة — يمكن النت قطع في النص. جرّب ترفعها تاني.');
}

/** Identify by magic bytes. The declared content-type is the uploader's
 *  opinion; this is the file. */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png';
  return null;
}

const u32le = (b: Uint8Array, at: number) =>
  b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! * 0x1000000);
const u32be = (b: Uint8Array, at: number) =>
  b[at]! * 0x1000000 + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!);

function writeU32le(b: Uint8Array, at: number, v: number) {
  b[at] = v & 0xff; b[at + 1] = (v >>> 8) & 0xff;
  b[at + 2] = (v >>> 16) & 0xff; b[at + 3] = (v >>> 24) & 0xff;
}

/**
 * WebP is a RIFF container: 'RIFF' + size + 'WEBP', then chunks of
 * FourCC + u32 length + payload, each padded to an even length.
 *
 * The VP8X chunk's first byte carries feature flags; bit 3 is ICC, bit 1 is
 * EXIF and bit 2 is XMP. Dropping the chunks without clearing the flags leaves
 * a file that announces metadata it does not contain, which strict decoders
 * reject — so both are done.
 */
function stripWebp(b: Uint8Array): StripResult {
  const DROP = new Set(['EXIF', 'XMP ', 'ICCP']);
  const removed: string[] = [];
  const keep: Uint8Array[] = [];
  let at = 12;

  while (at < b.length) {
    if (at + 8 > b.length) truncated();
    const cc = ascii(b, at, 4);
    const size = u32le(b, at + 4);
    const padded = size + (size % 2);
    const end = at + 8 + padded;
    if (size < 0 || end > b.length) truncated();

    if (DROP.has(cc)) {
      removed.push(cc.trim());
    } else {
      const chunk = b.slice(at, Math.min(end, b.length));
      if (cc === 'VP8X' && chunk.length >= 9) {
        // clear ICC (0x20), EXIF (0x08) and XMP (0x04) — bits 5, 3 and 2
        chunk[8] = chunk[8]! & ~0x2c;
      }
      keep.push(chunk);
    }
    at = end;
  }

  if (removed.length === 0) return { bytes: b, mime: 'image/webp', removed };

  const bodyLen = keep.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(12 + bodyLen);
  out.set(b.subarray(0, 12), 0);
  writeU32le(out, 4, bodyLen + 4);          // RIFF size counts 'WEBP' + chunks
  let w = 12;
  for (const c of keep) { out.set(c, w); w += c.length; }
  return { bytes: out, mime: 'image/webp', removed };
}

/**
 * JPEG is SOI followed by marker segments. Everything from SOS onwards is
 * entropy-coded pixel data and is copied verbatim — parsing it is neither
 * needed nor safe.
 */
function stripJpeg(b: Uint8Array): StripResult {
  const removed: string[] = [];
  const keep: Uint8Array[] = [b.subarray(0, 2)];   // SOI
  let at = 2;

  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) truncated();                // desynchronised: refuse
    const marker = b[at + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { at += 2; continue; }
    const len = (b[at + 2]! << 8) | b[at + 3]!;
    const end = at + 2 + len;
    if (len < 2 || end > b.length) truncated();

    // APP1..APP15 hold EXIF (incl. GPS), XMP and Photoshop resources. APP0 is
    // JFIF: dimensions and density, no identity, and some decoders want it.
    const isAppN = marker >= 0xe1 && marker <= 0xef;
    const isComment = marker === 0xfe;
    if (isAppN || isComment) {
      removed.push(isComment ? 'COM' : `APP${marker - 0xe0}`);
    } else {
      keep.push(b.subarray(at, end));
    }

    at = end;
    if (marker === 0xda) { keep.push(b.subarray(at)); at = b.length; break; }  // SOS → rest
  }
  if (at < b.length) keep.push(b.subarray(at));

  if (removed.length === 0) return { bytes: b, mime: 'image/jpeg', removed };
  const out = new Uint8Array(keep.reduce((n, c) => n + c.length, 0));
  let w = 0;
  for (const c of keep) { out.set(c, w); w += c.length; }
  return { bytes: out, mime: 'image/jpeg', removed };
}

/** PNG: 8-byte signature then chunks of u32 length + type + data + CRC. The
 *  CRC covers the type and data, so dropping whole chunks needs no recompute. */
function stripPng(b: Uint8Array): StripResult {
  const DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);
  const removed: string[] = [];
  const keep: Uint8Array[] = [b.subarray(0, 8)];
  let at = 8;

  while (at + 12 <= b.length) {
    const len = u32be(b, at);
    const type = ascii(b, at + 4, 4);
    const end = at + 12 + len;
    if (len < 0 || end > b.length) truncated();
    if (DROP.has(type)) removed.push(type);
    else keep.push(b.subarray(at, end));
    at = end;
    if (type === 'IEND') break;
  }

  if (removed.length === 0) return { bytes: b, mime: 'image/png', removed };
  const out = new Uint8Array(keep.reduce((n, c) => n + c.length, 0));
  let w = 0;
  for (const c of keep) { out.set(c, w); w += c.length; }
  return { bytes: out, mime: 'image/png', removed };
}

/**
 * The one entry point. Throws `UnsupportedImage` — with an Arabic sentence a
 * resident can act on — rather than storing something it does not understand.
 */
export function stripImageMetadata(bytes: Uint8Array): StripResult {
  const kind = sniffImage(bytes);
  if (!kind) {
    throw new UnsupportedImage(
      'الصورة دي بصيغة مش مدعومة. صوّر من الموبايل عادي أو ابعتها JPG أو PNG.');
  }
  if (kind === 'webp') return stripWebp(bytes);
  if (kind === 'jpeg') return stripJpeg(bytes);
  return stripPng(bytes);
}
