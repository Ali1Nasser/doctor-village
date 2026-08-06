/**
 * lib/db/driver.ts — the D1 adapter boundary.  (C11: "no vendor-specific API
 * leaks outside its adapter"; ADR-008 / 05 §6)
 *
 * `lib/db/index.ts` is written against `Db` below, which is deliberately the
 * shape of Cloudflare's D1 binding. On Workers the real D1 binding satisfies it
 * directly. In tests it is satisfied by `node:sqlite`, so the SAME queries and
 * the SAME ownership predicates are exercised — not a mock of them.
 *
 * If D1's free tier ever disappears, this file is the one that changes.
 */

export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number; last_row_id?: number } }>;
}

export interface Db {
  prepare(sql: string): PreparedStatement;
  /**
   * D1's atomic batch. Posting a journal entry MUST go through this: an entry
   * is legitimately unbalanced between its first and last line insert, and
   * `trg_entry_balanced` only fires on the final posting UPDATE. Outside a
   * batch, a crash mid-write strands a draft entry with orphan lines.
   */
  batch(statements: PreparedStatement[]): Promise<unknown[]>;
}

/* ------------------------------------------------------------------ */
/* node:sqlite implementation — tests and local dev only.             */
/* ------------------------------------------------------------------ */

type SqliteDb = {
  prepare(sql: string): {
    get(...p: unknown[]): unknown;
    all(...p: unknown[]): unknown[];
    run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
  exec(sql: string): void;
};

class NodeStatement implements PreparedStatement {
  constructor(private readonly db: SqliteDb, private readonly sql: string,
              private readonly params: unknown[] = []) {}

  bind(...values: unknown[]): PreparedStatement {
    return new NodeStatement(this.db, this.sql, values);
  }
  private norm(): unknown[] {
    // node:sqlite rejects booleans and undefined; D1 accepts both.
    return this.params.map(p =>
      typeof p === 'boolean' ? (p ? 1 : 0) : p === undefined ? null : p);
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.norm()) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.norm()) as T[] };
  }
  async run() {
    try {
      const r = this.db.prepare(this.sql).run(...this.norm());
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    } catch (e) {
      throw asRefusal(e);
    }
  }
  _exec() { return this.db.prepare(this.sql).run(...this.norm()); }
}

export class NodeSqliteDb implements Db {
  constructor(private readonly db: SqliteDb) {}
  prepare(sql: string): PreparedStatement { return new NodeStatement(this.db, sql); }
  async batch(statements: PreparedStatement[]): Promise<unknown[]> {
    this.db.exec('BEGIN');
    try {
      const out: unknown[] = [];
      for (const s of statements) out.push((s as NodeStatement)._exec());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

/** Thrown when the database refuses a write — a CHECK or a trigger fired.
 *  These are not bugs to be swallowed; they are the schema doing its job. */
export class LedgerRefused extends Error {
  readonly status = 409;
  constructor(readonly reasonAr: string, cause?: unknown) {
    super(`ledger refused: ${reasonAr}`, { cause });
  }
}

/**
 * Turn a database refusal into a `LedgerRefused` carrying its Arabic message.
 *
 * This matters more than it looks. Every `RAISE(ABORT, …)` in the migrations was
 * written with a resident-readable Arabic message on purpose — "القيد مش متوازن",
 * "محدش بيعتمد إيصال هو اللي رفعه". Letting those bubble up as unhandled errors
 * turns a **working control** into a 500 that reads like a crash: the admin sees
 * "حصل خطأ عندنا", assumes the site is broken, and retries — when in fact the
 * system correctly refused and told them exactly why.
 *
 * A refusal is an answer, not a failure. Found by the CP-1 access tests, which
 * is precisely the sort of thing an end-to-end gate catches and a unit test does
 * not.
 */
export function asRefusal(e: unknown): unknown {
  const msg = e instanceof Error ? e.message : String(e);
  const isRefusal =
    /constraint failed/i.test(msg) ||          // CHECK / UNIQUE / NOT NULL
    /FOREIGN KEY/i.test(msg) ||
    /[؀-ۿ]/.test(msg);               // any RAISE(ABORT) of ours — they are all Arabic
  if (!isRefusal) return e;
  const cleaned = msg
    .replace(/^.*?constraint failed:\s*/i, '')
    .replace(/\s*—\s*[A-Za-z].*$/, '')          // drop the English half of our bilingual messages
    .trim();
  return new LedgerRefused(cleaned || 'العملية دي مرفوضة', e);
}
