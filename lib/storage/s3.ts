/**
 * lib/storage/s3.ts — S3-compatible object storage, with request signing.
 *
 * ## Why this file is written even though ADR-015 chose Google Drive
 *
 * One adapter covers **three** of the four options that have been on the table:
 *   · Cloudflare R2       (Q19 option ب — needs a card, see the warning below)
 *   · Backblaze B2        (the documented Plan B, `05 §6`)
 *   · any other S3 API    (a future migration target)
 *
 * So the work is not wasted whichever way Q19 finally lands. It sits behind
 * `StorageAdapter` exactly like `MemoryStorage` and `GoogleDriveStorage`, and
 * nothing in the upload path knows which one is behind the interface.
 *
 * ## ⚠️ Read this before pointing it at R2
 *
 * ADR-015 removed R2 **because Cloudflare will not create a bucket without a
 * payment method on file**, and C11 says: *"Never sign up for anything requiring
 * a payment method, even where you won't be charged."* The owner approved that
 * (Q19 option أ) on 2026-08-04.
 *
 * If R2 credentials now exist, then either a card was added — which supersedes
 * ADR-015 and needs the owner's **written** acceptance of the billing exposure —
 * or Cloudflare changed its policy, which needs re-verifying against their own
 * page. Neither is a thing to assume. Until it is settled, `STORAGE_DRIVER` must
 * not be set to `r2` in production.
 *
 * The hard cap in `assertRoomFor()` still applies and is the only thing standing
 * between an overage and a bill.
 *
 * ## Signing
 *
 * AWS Signature V4 over WebCrypto, so it runs unchanged on Workers. No AWS SDK:
 * it is large, Node-oriented, and this needs four operations.
 */

import type { StorageAdapter, PutInput } from './index.js';

export interface S3Config {
  /** e.g. 'https://<account>.r2.cloudflarestorage.com' or B2's S3 endpoint. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 ignores the region but the signature does not. 'auto' for R2. */
  region?: string;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer));
}

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    'raw', key as unknown as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg) as unknown as ArrayBuffer);
}

/** Percent-encode a key for a path segment, leaving `/` intact. */
function encodeKey(key: string): string {
  return key.split('/').map(s => encodeURIComponent(s)).join('/');
}

export class S3CompatibleStorage implements StorageAdapter {
  readonly id: string;
  private readonly region: string;

  constructor(private readonly cfg: S3Config, label = 's3') {
    this.id = label;
    this.region = cfg.region ?? 'auto';
  }

  private async sign(
    method: string, key: string, body: Uint8Array | null, extraHeaders: Record<string, string> = {},
    nowIso?: string,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const host = new URL(this.cfg.endpoint).host;
    const path = `/${this.cfg.bucket}/${encodeKey(key)}`;
    // `new Date()` is unavailable in some sandboxes; the caller may inject.
    const amzDate = (nowIso ?? new Date().toISOString()).replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = body ? await sha256Hex(body) : await sha256Hex('');

    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders,
    };
    const signedHeaders = Object.keys(headers).map(h => h.toLowerCase()).sort();
    const canonicalHeaders = signedHeaders
      .map(h => `${h}:${String(headers[Object.keys(headers).find(k => k.toLowerCase() === h)!]).trim()}\n`)
      .join('');

    const canonicalRequest = [
      method, path, '', canonicalHeaders, signedHeaders.join(';'), payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest),
    ].join('\n');

    let k: ArrayBuffer | Uint8Array = enc.encode(`AWS4${this.cfg.secretAccessKey}`);
    for (const part of [dateStamp, this.region, 's3', 'aws4_request']) k = await hmac(k, part);
    const signature = hex(await hmac(k, stringToSign));

    headers['authorization'] =
      `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;

    return { url: `${this.cfg.endpoint}${path}`, headers };
  }

  async put(i: PutInput): Promise<{ key: string; sizeBytes: number }> {
    const { url, headers } = await this.sign('PUT', i.key, i.body, {
      'content-type': i.mime,
    });
    const res = await fetch(url, {
      method: 'PUT', headers, body: i.body as unknown as BodyInit,
    });
    if (!res.ok) throw new Error(`storage put failed: ${res.status} ${await res.text()}`);
    return { key: i.key, sizeBytes: i.body.byteLength };
  }

  async get(key: string): Promise<{ body: Uint8Array; mime: string } | null> {
    const { url, headers } = await this.sign('GET', key, null);
    const res = await fetch(url, { method: 'GET', headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`storage get failed: ${res.status}`);
    return {
      body: new Uint8Array(await res.arrayBuffer()),
      mime: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  async delete(key: string): Promise<void> {
    const { url, headers } = await this.sign('DELETE', key, null);
    const res = await fetch(url, { method: 'DELETE', headers });
    if (!res.ok && res.status !== 404) throw new Error(`storage delete failed: ${res.status}`);
  }

  /**
   * ⚠️ Approximate, and deliberately so. A LIST over every object costs a Class A
   * operation per 1,000 keys and gets slower every month. The authoritative
   * usage figure is `SUM(size_bytes)` from `storage_objects` in our own database
   * — we recorded every byte we wrote, so we do not need to ask the vendor.
   * This exists only to reconcile against that number occasionally.
   */
  async usedBytes(): Promise<number> {
    throw new Error(
      'usedBytes: use SUM(size_bytes) from storage_objects instead — see v_storage_usage. ' +
      'Listing the bucket costs Class A operations and drifts from our own record.');
  }
}

/**
 * Build the storage adapter from environment. Defaults to memory, so a
 * misconfigured deployment fails loudly in tests rather than quietly writing
 * receipts to a vendor nobody approved.
 */
export type StorageDriver = 'memory' | 'r2' | 'b2' | 'drive';

export function describeDriver(d: StorageDriver): { ok: boolean; noteAr: string } {
  switch (d) {
    case 'drive':
      return { ok: true, noteAr: 'جوجل درايف باسم الجمعية — مستحيل يحاسب (القرار المعتمد)' };
    case 'memory':
      return { ok: true, noteAr: 'تخزين مؤقت في الذاكرة — للتجارب بس' };
    case 'b2':
      return { ok: true, noteAr: 'Backblaze B2 — الخطة البديلة، بتحاسب لو زاد الحد' };
    case 'r2':
      return {
        ok: false,
        noteAr: 'Cloudflare R2 — بيطلب بطاقة ائتمان، وده مخالف للشرط الأساسي. ' +
                'محتاج موافقة مكتوبة من المالك (ADR-015 / Q19) قبل التشغيل.',
      };
  }
}
