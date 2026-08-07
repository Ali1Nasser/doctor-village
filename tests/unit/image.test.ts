/**
 * tests/unit/image.test.ts — the photo actually loses its GPS.
 *
 * `exif_stripped` was set to 1 on every stored object by two call sites that
 * had never looked at the bytes. The stripping was real but it happened in the
 * browser, so it protected a resident using the site normally and nothing else:
 * a request that skipped the page stored a photo carrying the coordinates of a
 * resident's flat, with a column beside it saying the metadata was removed.
 *
 * These tests are byte-level on purpose. "The function returned successfully"
 * proves nothing here; what has to be true is that the GPS bytes are NOT in the
 * output, so that is what is asserted — by searching the whole buffer for them.
 */

import { it, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  stripImageMetadata, sniffImage, UnsupportedImage,
} from '../../lib/storage/image.js';

/** A recognisable payload standing in for "31.35°N 27.23°E, taken at home". */
const GPS = Buffer.from('GPSLatitude=31.3543;GPSLongitude=27.2373', 'latin1');

const contains = (hay: Uint8Array, needle: Uint8Array) =>
  Buffer.from(hay).includes(Buffer.from(needle));

/* ---------- builders: real containers, minimal but valid ---------------- */

function webp(chunks: [string, Uint8Array][], withVp8x = true): Uint8Array {
  const parts: Uint8Array[] = [];
  if (withVp8x) {
    // VP8X is 8 bytes of chunk header + a 10-byte payload: flags, 3 reserved,
    // then canvas width-1 and height-1 as 24-bit values.
    const vp8x = new Uint8Array(18);
    vp8x.set(Buffer.from('VP8X', 'latin1'), 0);
    vp8x[4] = 10;                       // payload length
    vp8x[8] = 0x2c;                     // ICC | EXIF | XMP all announced
    parts.push(vp8x);
  }
  for (const [cc, payload] of chunks) {
    const pad = payload.length % 2;
    const c = new Uint8Array(8 + payload.length + pad);
    c.set(Buffer.from(cc.padEnd(4, ' '), 'latin1'), 0);
    c[4] = payload.length & 0xff;
    c[5] = (payload.length >>> 8) & 0xff;
    c[6] = (payload.length >>> 16) & 0xff;
    c[7] = (payload.length >>> 24) & 0xff;
    c.set(payload, 8);
    parts.push(c);
  }
  const body = Buffer.concat(parts.map(p => Buffer.from(p)));
  const out = new Uint8Array(12 + body.length);
  out.set(Buffer.from('RIFF', 'latin1'), 0);
  const size = body.length + 4;
  out[4] = size & 0xff; out[5] = (size >>> 8) & 0xff;
  out[6] = (size >>> 16) & 0xff; out[7] = (size >>> 24) & 0xff;
  out.set(Buffer.from('WEBP', 'latin1'), 8);
  out.set(body, 12);
  return out;
}

function jpeg(segments: [number, Uint8Array][], pixels: Uint8Array): Uint8Array {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  for (const [marker, payload] of segments) {
    const len = payload.length + 2;
    parts.push(Buffer.from([0xff, marker, (len >>> 8) & 0xff, len & 0xff]));
    parts.push(Buffer.from(payload));
  }
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x02]));    // SOS
  parts.push(Buffer.from(pixels));
  parts.push(Buffer.from([0xff, 0xd9]));                // EOI
  return new Uint8Array(Buffer.concat(parts));
}

function png(chunks: [string, Uint8Array][]): Uint8Array {
  const parts: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  for (const [type, data] of chunks) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    parts.push(len, Buffer.from(type, 'latin1'), Buffer.from(data), Buffer.alloc(4));
  }
  return new Uint8Array(Buffer.concat(parts));
}

/* ======================================================================= */
describe('the format is read from the bytes, not from what the caller says', () => {
  it('identifies webp, jpeg and png', () => {
    assert.equal(sniffImage(webp([])), 'webp');
    assert.equal(sniffImage(jpeg([], new Uint8Array([1, 2]))), 'jpeg');
    assert.equal(sniffImage(png([['IHDR', new Uint8Array(13)]])), 'png');
  });

  it('⭐ refuses a format it does not understand rather than storing it as clean', () => {
    // A HEIC straight off an iPhone lands here. Storing it while recording
    // "metadata removed" would be a lie in the one column that exists to
    // prevent publishing a resident's coordinates.
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic', 'latin1'), GPS,
    ]);
    assert.equal(sniffImage(new Uint8Array(heic)), null);
    assert.throws(() => stripImageMetadata(new Uint8Array(heic)), UnsupportedImage);
  });
});

/* ======================================================================= */
describe('WebP', () => {
  it('⭐ the GPS bytes are gone from the output', () => {
    const input = webp([
      ['VP8 ', new Uint8Array([9, 9, 9, 9])],
      ['EXIF', new Uint8Array(GPS)],
      ['XMP ', Buffer.from('<x:xmpmeta>home</x:xmpmeta>', 'latin1')],
    ]);
    assert.ok(contains(input, GPS), 'the fixture never had GPS in it');

    const out = stripImageMetadata(input);
    assert.ok(!contains(out.bytes, GPS), 'the photo still carries its coordinates');
    assert.deepEqual(out.removed.sort(), ['EXIF', 'XMP']);
    assert.equal(out.mime, 'image/webp');
  });

  it('the pixel chunk survives byte for byte — this is not a re-encode', () => {
    const pixels = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const out = stripImageMetadata(webp([['VP8 ', pixels], ['EXIF', new Uint8Array(GPS)]]));
    assert.ok(contains(out.bytes, pixels), 'the image data was altered');
  });

  it('clears the VP8X flags that announce metadata the file no longer has', () => {
    const out = stripImageMetadata(webp([['EXIF', new Uint8Array(GPS)]]));
    // VP8X is the first chunk after the 12-byte header; its flags are at +8
    assert.equal(String.fromCharCode(...out.bytes.subarray(12, 16)), 'VP8X');
    assert.equal(out.bytes[20]! & 0x2c, 0,
      'the file still announces EXIF/XMP/ICC it does not contain');
  });

  it('a clean file is returned untouched, not rebuilt', () => {
    const clean = webp([['VP8 ', new Uint8Array([4, 4, 4, 4])]], false);
    const out = stripImageMetadata(clean);
    assert.deepEqual(out.removed, []);
    assert.equal(out.bytes, clean, 'a clean file was needlessly copied');
  });

  it('⭐ a truncated file is REFUSED, not salvaged', () => {
    // The first version of this walked until the damaged chunk, found no
    // metadata before it, and returned the ORIGINAL buffer — half-written EXIF
    // chunk and all. That is the worst possible outcome, because it is
    // indistinguishable from success: the caller stores the photo and records
    // that its metadata was removed.
    const full = webp([['VP8 ', new Uint8Array([1, 1])], ['EXIF', new Uint8Array(GPS)]]);
    const cut = full.subarray(0, full.length - 10);
    assert.throws(() => stripImageMetadata(cut), UnsupportedImage,
      'a truncated upload was accepted with part of its coordinates intact');
  });

  it('a chunk claiming to be longer than the file is refused', () => {
    const b = webp([['VP8 ', new Uint8Array([1, 1, 1, 1])]], false);
    b[16] = 0xff; b[17] = 0xff;      // VP8 chunk now claims 65 535 bytes
    assert.throws(() => stripImageMetadata(b), UnsupportedImage);
  });
});

/* ======================================================================= */
describe('JPEG', () => {
  it('⭐ APP1 goes, and the pixels do not', () => {
    const pixels = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
    const input = jpeg([
      [0xe0, Buffer.from('JFIF\0', 'latin1')],            // APP0 — kept
      [0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), GPS])],
      [0xfe, Buffer.from('taken at home', 'latin1')],     // COM
      [0xdb, new Uint8Array(64)],                          // quantisation table
    ], pixels);
    assert.ok(contains(input, GPS));

    const out = stripImageMetadata(input);
    assert.ok(!contains(out.bytes, GPS), 'the receipt still carries its coordinates');
    assert.ok(out.removed.includes('APP1'));
    assert.ok(out.removed.includes('COM'));
    assert.ok(contains(out.bytes, pixels), 'the image data was altered');
    assert.ok(contains(out.bytes, Buffer.from('JFIF', 'latin1')),
      'APP0/JFIF was dropped — some decoders want it');
    assert.equal(out.mime, 'image/jpeg');
  });

  it('the output is still a JPEG — SOI first, EOI last', () => {
    const out = stripImageMetadata(jpeg(
      [[0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), GPS])]],
      new Uint8Array([7, 7, 7])));
    assert.equal(out.bytes[0], 0xff);
    assert.equal(out.bytes[1], 0xd8);
    assert.equal(out.bytes[out.bytes.length - 2], 0xff);
    assert.equal(out.bytes[out.bytes.length - 1], 0xd9);
  });

  it('entropy data that happens to look like a marker is not parsed', () => {
    // Everything after SOS is pixel data. A 0xFFE1 byte pair in there is not an
    // APP1 segment, and treating it as one would corrupt the image.
    const pixels = new Uint8Array([0xff, 0xe1, 0x00, 0x40, 1, 2, 3]);
    const out = stripImageMetadata(jpeg([[0xdb, new Uint8Array(8)]], pixels));
    assert.ok(contains(out.bytes, pixels), 'pixel data was parsed as a segment');
  });
});

/* ======================================================================= */
describe('PNG', () => {
  it('⭐ eXIf and the text chunks go', () => {
    const input = png([
      ['IHDR', new Uint8Array(13)],
      ['eXIf', new Uint8Array(GPS)],
      ['tEXt', Buffer.from('Comment\0home', 'latin1')],
      ['IDAT', new Uint8Array([5, 5, 5, 5])],
      ['IEND', new Uint8Array(0)],
    ]);
    assert.ok(contains(input, GPS));

    const out = stripImageMetadata(input);
    assert.ok(!contains(out.bytes, GPS));
    assert.deepEqual(out.removed.sort(), ['eXIf', 'tEXt']);
    assert.ok(contains(out.bytes, new Uint8Array([5, 5, 5, 5])), 'IDAT was dropped');
    assert.ok(contains(out.bytes, Buffer.from('IEND', 'latin1')), 'IEND was dropped');
  });
});
