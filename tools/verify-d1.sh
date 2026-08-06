#!/usr/bin/env bash
# =============================================================================
# tools/verify-d1.sh — THE CP-1 GATE THAT HAS BLOCKED SINCE DAY ONE.
#
# The entire financial-integrity layer rests on two SQLite features that
# Cloudflare does not document either way (A-05, R-031):
#
#   1. STRICT tables        — make "money is never a float" a storage-layer
#                             guarantee instead of a code convention (C4);
#   2. RAISE(ABORT) in a    — enforce balanced entries, the nine-state payment
#      trigger                machine, append-only journal lines, and the
#                             immutable audit log.
#
# If D1 rejects either, the fallback is strictly weaker and R-020 goes back to
# critical. So this must be proven on REAL D1 before any resident's money is
# posted — not inferred from SQLite behaving locally.
#
# Everything it creates is temporary and deleted at the end.
#
# USAGE:
#   export CLOUDFLARE_API_TOKEN=...        # a token with D1:Edit on the account
#   bash tools/verify-d1.sh
#
# The token needs D1 Edit and nothing else. Do not use a Global API Key.
# =============================================================================
set -uo pipefail

DB="qaryat-verify-$RANDOM"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-1ca337dfa2c4b572409e393e577c3bc5}"
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"
PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN is not set. Create a token with D1:Edit and export it."
  exit 2
fi

echo "→ creating a temporary database: $DB"
npx --yes wrangler@latest d1 create "$DB" >/tmp/d1-create.txt 2>&1 || {
  echo "could not create a database. wrangler said:"; cat /tmp/d1-create.txt; exit 1; }

d1() { npx --yes wrangler@latest d1 execute "$DB" --remote --command "$1" 2>&1; }
d1file() { npx --yes wrangler@latest d1 execute "$DB" --remote --file "$1" 2>&1; }

cleanup() {
  echo "→ deleting $DB"
  npx --yes wrangler@latest d1 delete "$DB" --skip-confirmation >/dev/null 2>&1
}
trap cleanup EXIT

echo
echo "=== 1. do all seven migrations apply? ==="
for f in migrations/*.sql; do
  out=$(d1file "$f")
  if echo "$out" | grep -qiE "error|failed"; then
    bad "$(basename "$f") — $(echo "$out" | grep -iE 'error' | head -1)"
  else
    ok "$(basename "$f")"
  fi
done

echo
echo "=== 2. does D1 honour STRICT tables? (C4 — money can never be a float) ==="
out=$(d1 "INSERT INTO journal_lines (id,entry_id,line_no,account_id,debit_piastres,credit_piastres) VALUES ('X','Y',1,'Z',1500.75,0)")
if echo "$out" | grep -qi "cannot store REAL"; then
  ok "STRICT is enforced — a float in a piastres column is refused"
elif echo "$out" | grep -qiE "FOREIGN KEY|constraint"; then
  bad "INCONCLUSIVE — another constraint fired first. Re-run against a seeded db."
else
  bad "STRICT NOT ENFORCED. Strip ', STRICT' from every CREATE TABLE and RE-RAISE R-020."
fi

echo
echo "=== 3. does D1 honour RAISE(ABORT) inside a trigger? ==="
d1 "INSERT INTO audit_log (id,action,entity_table) VALUES ('AUD0000000000000000000001','probe','payments')" >/dev/null
out=$(d1 "UPDATE audit_log SET action='tampered' WHERE id='AUD0000000000000000000001'")
if echo "$out" | grep -q "سجل المراجعة"; then
  ok "RAISE(ABORT) fires — the audit log refused an UPDATE, in Arabic"
else
  bad "TRIGGERS DO NOT FIRE. The append-only ledger is unprotected. STOP and re-plan."
fi

echo
echo "=== 4. is a partial unique index honoured? (one active phone per number) ==="
out=$(d1 "SELECT COUNT(*) FROM pragma_index_list('phone_identifiers') WHERE partial=1")
echo "$out" | grep -qE "[1-9]" && ok "partial indexes present" || bad "partial indexes missing"

echo
echo "=== 5. FTS5 (Arabic search, CP-6) ==="
out=$(d1 "INSERT INTO posts_fts (rowid,title_ar,search_body,attachment_text) VALUES (1,'محضر','محضر اجتماع','')")
echo "$out" | grep -qiE "error" && bad "FTS5 unavailable" || ok "FTS5 virtual table accepts writes"

echo
echo "==================================================================="
echo "  $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo
  echo "  ⚠️  Do NOT proceed to production. Update A-05 and R-031 in the repo,"
  echo "      and re-read CHECKPOINTS.md CP-1 gate 1 for the fallback."
  exit 1
fi
echo "  ✅ CP-1 gate 1 MET — tick it in CHECKPOINTS.md and close R-031."
echo "==================================================================="
