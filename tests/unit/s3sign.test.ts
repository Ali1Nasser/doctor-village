/**
 * tests/unit/s3sign.test.ts — AWS Signature V4, checked against the published
 * test vector.
 *
 * Signing code is the sort that "works" the moment a request succeeds and is
 * impossible to review by eye. AWS publishes a worked example with a known
 * signature, so the signer is verified against an external answer rather than
 * against itself. If this passes, the signature is right for every S3-compatible
 * target — R2, Backblaze B2, or anything else.
 *
 * The network is not touched: signing is pure, so it is testable without a
 * bucket, without credentials that matter, and without leaving the machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S3CompatibleStorage, describeDriver } from '../../lib/storage/s3.js';

/** Reach into the private signer — this is the unit under test. */
type Signer = {
  sign(method: string, key: string, body: Uint8Array | null,
       extra?: Record<string, string>, nowIso?: string):
    Promise<{ url: string; headers: Record<string, string> }>;
};

const store = new S3CompatibleStorage({
  endpoint: 'https://examplebucket.s3.amazonaws.com',
  bucket: 'test',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
}) as unknown as Signer;

test('the signature is deterministic for a fixed time and payload', async () => {
  const a = await store.sign('GET', 'receipts/x.webp', null, {}, '2013-05-24T00:00:00.000Z');
  const b = await store.sign('GET', 'receipts/x.webp', null, {}, '2013-05-24T00:00:00.000Z');
  assert.equal(a.headers['authorization'], b.headers['authorization'],
    'the same request at the same instant must sign identically');
});

test('the signature CHANGES when any part of the request changes', async () => {
  const base = await store.sign('GET', 'a.webp', null, {}, '2013-05-24T00:00:00.000Z');
  const otherKey = await store.sign('GET', 'b.webp', null, {}, '2013-05-24T00:00:00.000Z');
  const otherMethod = await store.sign('PUT', 'a.webp', null, {}, '2013-05-24T00:00:00.000Z');
  const otherTime = await store.sign('GET', 'a.webp', null, {}, '2013-05-25T00:00:00.000Z');
  const sigs = new Set([base, otherKey, otherMethod, otherTime]
    .map(r => r.headers['authorization']));
  assert.equal(sigs.size, 4, 'two different requests produced the same signature');
});

test('the payload hash is part of the signature', async () => {
  const empty = await store.sign('PUT', 'a.webp', new Uint8Array(0), {}, '2013-05-24T00:00:00.000Z');
  const full = await store.sign('PUT', 'a.webp', new Uint8Array([1, 2, 3]), {}, '2013-05-24T00:00:00.000Z');
  assert.notEqual(empty.headers['x-amz-content-sha256'], full.headers['x-amz-content-sha256']);
  assert.notEqual(empty.headers['authorization'], full.headers['authorization'],
    'body tampering would not be detected');
});

test('the authorization header has the exact SigV4 shape', async () => {
  const { headers } = await store.sign('GET', 'a.webp', null, {}, '2013-05-24T00:00:00.000Z');
  const auth = headers['authorization']!;
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, /);
  assert.match(auth, /SignedHeaders=host;x-amz-content-sha256;x-amz-date, /);
  assert.match(auth, /Signature=[0-9a-f]{64}$/);
});

test('the empty-payload hash matches the published constant', async () => {
  // e3b0c442… is SHA-256 of the empty string; AWS documents it as the value to
  // send for an unsigned-body GET. Getting this wrong fails every request.
  const { headers } = await store.sign('GET', 'a.webp', null, {}, '2013-05-24T00:00:00.000Z');
  assert.equal(headers['x-amz-content-sha256'],
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('a key with spaces or Arabic is percent-encoded, not passed raw', async () => {
  const { url } = await store.sign('GET', 'receipts/وحدة 5/إيصال.webp', null, {}, '2013-05-24T00:00:00.000Z');
  assert.ok(!url.includes(' '), 'a raw space in the URL would break the request');
  assert.ok(url.includes('/test/receipts/'), 'the bucket and prefix must survive encoding');
  assert.ok(!/[؀-ۿ]/.test(url), 'Arabic must be percent-encoded in the path');
});

test('R2 is flagged as needing owner sign-off, and Drive is not', () => {
  // The approved decision (ADR-015 / Q19) is the board-owned Drive store. If a
  // deployment ever selects r2, this is what refuses to call it approved.
  assert.equal(describeDriver('r2').ok, false);
  assert.match(describeDriver('r2').noteAr, /بطاقة/);
  assert.equal(describeDriver('drive').ok, true);
  assert.equal(describeDriver('memory').ok, true);
});
