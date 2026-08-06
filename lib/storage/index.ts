/**
 * lib/storage/ — the object-store adapter.
 *
 * **ADR-015, approved by the owner on 2026-08-04 (Q19, option أ).** Cloudflare
 * R2 is OUT: it refuses to create a bucket without a payment method on file,
 * which violates C11's "never sign up for anything requiring a payment method"
 * outright. A board-owned Google account has **no billing path at all**, so it
 * cannot charge — which is what the constraint actually asks for. The board owns
 * the files rather than the developer, which also helps R-008.
 *
 * Everything vendor-specific lives behind `StorageAdapter`. Switching is one file.
 *
 * ⚠️ NOTHING IN HERE PRODUCES A PUBLIC URL. Objects are reached only through the
 * Worker route that re-checks ownership per request (`lib/db/authorizeObjectRead`).
 * A signed or shareable link would defeat C6 entirely.
 */

export interface PutInput {
  key: string;
  body: Uint8Array;
  mime: string;
  /** Set on receipts; the file route matches it against the caller's units. */
  unitId: string | null;
}

export interface StorageAdapter {
  readonly id: string;
  /** Never returns a URL — only the key, which is meaningless without the route. */
  put(input: PutInput): Promise<{ key: string; sizeBytes: number }>;
  get(key: string): Promise<{ body: Uint8Array; mime: string } | null>;
  delete(key: string): Promise<void>;
  /** Bytes currently stored, for the hard cap. */
  usedBytes(): Promise<number>;
}

export class StorageFull extends Error {
  readonly status = 507;
  constructor(readonly reasonAr =
    'مساحة التخزين قربت تخلص. الإدارة اتبلغت — جرّب ترفع الإيصال بكرة من فضلك.') {
    super('storage cap reached');
  }
}

/**
 * The hard cap, enforced in OUR code rather than by trusting a vendor (05 §2a,
 * C11). Google Drive cannot bill, so this is now about degrading gracefully
 * rather than about money — but the degradation ORDER still matters and is not
 * improvised: block new large uploads first, never break reads of already
 * posted records.
 */
export async function assertRoomFor(
  adapter: StorageAdapter, incomingBytes: number, capBytes: number,
): Promise<void> {
  const used = await adapter.usedBytes();
  if (used + incomingBytes > capBytes) throw new StorageFull();
}

/* -------------------------------------------------------------------- */
/* In-memory adapter — tests and local dev.                              */
/* -------------------------------------------------------------------- */

export class MemoryStorage implements StorageAdapter {
  readonly id = 'memory';
  private readonly store = new Map<string, { body: Uint8Array; mime: string }>();
  async put(i: PutInput) {
    this.store.set(i.key, { body: i.body, mime: i.mime });
    return { key: i.key, sizeBytes: i.body.byteLength };
  }
  async get(key: string) { return this.store.get(key) ?? null; }
  async delete(key: string) { this.store.delete(key); }
  async usedBytes() {
    let n = 0; for (const v of this.store.values()) n += v.body.byteLength; return n;
  }
}

/* -------------------------------------------------------------------- */
/* Google Drive adapter — the approved production target.                */
/* -------------------------------------------------------------------- */

export interface DriveConfig {
  /** A folder in the BOARD's Drive, not the developer's. Non-negotiable (R-008). */
  folderId: string;
  /** Service-account credentials. Held in Worker secrets, never in the repo. */
  accessToken: () => Promise<string>;
}

/**
 * ⚠️ SKELETON — the network calls are not implemented yet and this is not wired
 * into any route. It exists so the shape is fixed and A-07 is testable before
 * CP-4 commits to it.
 *
 * A-07 (unvalidated): that a Google service account can serve as a private file
 * store with no billing path. **Prove this before CP-4**, specifically:
 *   · a service account can be created without enabling GCP billing;
 *   · Drive API quotas (per-minute writes) tolerate our ~15 uploads/day;
 *   · files created by a service account can be owned by the board's account,
 *     not stranded in a service-account-owned space nobody can access later.
 * The third is the one that quietly ruins this design if it turns out false.
 */
export class GoogleDriveStorage implements StorageAdapter {
  readonly id = 'google-drive';
  constructor(private readonly cfg: DriveConfig) {}
  async put(_i: PutInput): Promise<{ key: string; sizeBytes: number }> {
    throw new Error('TODO(cp-4): implement Drive upload — see A-07 before relying on this');
  }
  async get(_key: string): Promise<{ body: Uint8Array; mime: string } | null> {
    throw new Error('TODO(cp-4): implement Drive download');
  }
  async delete(_key: string): Promise<void> {
    throw new Error('TODO(cp-4): implement Drive delete');
  }
  async usedBytes(): Promise<number> {
    throw new Error('TODO(cp-4): read Drive quota');
  }
}

/** Receipt keys are unit-scoped so the file route's predicate is a prefix match
 *  as well as a database check — belt and braces. */
export function receiptKey(unitId: string, paymentId: string): string {
  return `receipts/${unitId}/${paymentId}.webp`;
}
