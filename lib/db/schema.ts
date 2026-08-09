/**
 * lib/db/schema.ts — does this database actually hold what the app needs?
 *
 * ## Why a running app has to ask
 *
 * `wrangler.toml` binds two D1 databases and names one `migrations_dir`. The
 * receipts database went live created, bound and **never migrated** — nothing
 * in it but Cloudflare's own `_cf_KV` — so every receipt upload on the deployed
 * site answered 500 with `no such table: v_blob_usage`, from the first
 * deployment onward. Nothing noticed, because no screen a board member opens
 * touches that view, and locally both bindings point at the same file (R-125).
 *
 * A deployment that is missing half its schema is not a rare exotic state: it
 * is what happens the first time somebody adds a database, or runs the
 * migrations against the wrong one, or a migration fails half way. The app can
 * see it in one query, so it should, and it should say so on a screen rather
 * than waiting for a resident to press a button.
 *
 * ## Missing triggers are the interesting part
 *
 * Tables and views announce themselves by breaking. A missing **trigger** does
 * not: the query succeeds, the row is written, and the control that was
 * supposed to refuse it is simply absent. `trg_entry_balanced`,
 * `trg_payment_no_self_approve`, `trg_no_real_payments_in_demo` — every one of
 * those is a rule this project deliberately put in the schema rather than in
 * TypeScript (ADR-024), on the grounds that a rule in the database cannot be
 * bypassed by a bug in a route. That reasoning only holds while the trigger is
 * actually there.
 */

import type { Db } from './driver.js';
import type { AuthContext } from '../../types/domain.js';
import { require_ } from '../rbac.js';
import {
  LEDGER_SCHEMA, RECEIPTS_SCHEMA, type RequiredObjects,
} from './schema-manifest.js';

export { LEDGER_SCHEMA, RECEIPTS_SCHEMA };
export type { RequiredObjects };

export type SchemaKind = 'table' | 'view' | 'trigger';

export interface SchemaReport {
  /** Which binding this is about, for the screen. */
  database: 'ledger' | 'receipts';
  /** Everything expected and absent. Empty is the only good answer. */
  missing: { kind: SchemaKind; name: string }[];
  /** How many objects were expected, so "0 missing" can be told apart from
   *  "nothing was checked" — which is what an empty manifest would look like. */
  expected: number;
  /** True when the query itself failed: no binding, no permission, no database.
   *  Distinct from "the database answered and is missing things". */
  unreachable: boolean;
}

/**
 * The objects this database actually has.
 *
 * `sqlite_master` is the one table every SQLite database has, including an
 * empty one, so this works on exactly the database that is broken. Cloudflare's
 * internal `_cf_%` rows are filtered out — they are D1's bookkeeping, not ours,
 * and a report that lists them teaches the reader to skim.
 */
async function present(db: Db): Promise<Set<string>> {
  const r = await db.prepare(
    `SELECT type, name FROM sqlite_master
      WHERE type IN ('table','view','trigger') AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`
  ).all<{ type: string; name: string }>();
  return new Set(r.results.map(x => `${x.type}:${x.name}`));
}

/**
 * Compare one database against what it is supposed to hold.
 *
 * Takes the expectation as an argument rather than reaching for a constant, so
 * the receipts database is checked against the receipts manifest and not
 * against the ledger's — the mistake that would make this whole check report a
 * disaster on a perfectly healthy blob store.
 */
export async function checkSchema(
  db: Db, want: RequiredObjects, database: SchemaReport['database'],
): Promise<SchemaReport> {
  const expected = want.tables.length + want.views.length + want.triggers.length;
  let have: Set<string>;
  try {
    have = await present(db);
  } catch {
    // A binding that is absent or unreadable is a different problem from a
    // binding that is present and empty, and the screen says so differently.
    return { database, missing: [], expected, unreachable: true };
  }

  const missing: SchemaReport['missing'] = [];
  const check = (kind: SchemaKind, names: readonly string[]) => {
    for (const name of names) if (!have.has(`${kind}:${name}`)) missing.push({ kind, name });
  };
  check('table', want.tables);
  check('view', want.views);
  check('trigger', want.triggers);
  return { database, missing, expected, unreachable: false };
}

/**
 * Both databases, for `/admin/health`.
 *
 * `receiptsDb` is optional because a single-database deployment is legitimate —
 * `src/worker.ts` falls back to `DB` when `RECEIPTS` is unbound, and locally
 * they are the same file. When they ARE the same database, checking twice would
 * report the ledger's objects as "missing from receipts" the moment somebody
 * pointed one binding at the other, so the caller passes what it has and this
 * reports what it was given.
 */
export async function checkDeployedSchema(
  ctx: AuthContext, ledgerDb: Db, receiptsDb: Db | null,
): Promise<SchemaReport[]> {
  // Same capability the rest of `/admin/health` needs: this names internal
  // objects, and a resident has no business reading the shape of the database.
  require_(ctx.role, 'system.read_quota');
  const out = [await checkSchema(ledgerDb, LEDGER_SCHEMA, 'ledger')];
  if (receiptsDb) out.push(await checkSchema(receiptsDb, RECEIPTS_SCHEMA, 'receipts'));
  return out;
}
