# RESEARCH SOURCES — كل حقيقة خارجية ومصدرها

> `<grounding>`: a claim labelled **`verified external fact`** must appear here with its primary
> source URL and the date it was checked. Anything not in this file is not a verified fact.

**Verification pass: 2026-08-04** (CP-0, `<first_actions>` step 3). Next: **2026-11-04**.

---

## Checked 2026-08-04

| # | Fact established | Source (primary) | Result vs. what the pack assumed |
|---|---|---|---|
| 1 | Workers Free: 100,000 req/day · 10 ms CPU/invocation · 128 MB memory · 3 MB script · 50 subrequests/req · 100 Workers/account · bandwidth not metered | https://developers.cloudflare.com/workers/platform/limits/ | ✅ matches |
| 2 | Exceeding a Workers/KV free limit makes **operations fail with an error** — "you must upgrade to continue"; no automatic charge | https://developers.cloudflare.com/workers/platform/pricing/ | ✅ better than assumed — confirms strict-zero |
| 3 | Pages Free: 500 builds/month · 20,000 files/site · 25 MiB max asset · 100 custom domains | https://developers.cloudflare.com/pages/platform/limits/ | ✅ matches |
| 4 | D1 Free: **500 MB per database**, 5 GB account total, **10 databases**, 5M rows read/day, 100k rows written/day | https://developers.cloudflare.com/d1/platform/limits/ · https://developers.cloudflare.com/d1/platform/pricing/ | ✅ confirms the §2a correction. **New:** the 10-database cap on free constrains the "archive closed years into a second database" plan to 9 archives |
| 5 | D1 over-limit behaviour: "you will not be able to run queries… D1 API will return errors"; storage full → cannot insert until data is deleted. **Blocked, never billed.** | https://developers.cloudflare.com/d1/platform/pricing/ | ✅ strict-zero confirmed |
| 6 | KV Free: 100,000 reads/day · **1,000 writes/day** · 1 GB storage · 25 MiB value · 512 B key · 1,000 namespaces | https://developers.cloudflare.com/kv/platform/limits/ | ✅ matches — but see INSIGHTS: this is the stack's tightest quota |
| 7 | R2 Free: 10 GB-month · 1M Class A ops/mo · 10M Class B ops/mo · egress free. **Overage billed** at $0.015/GB-month, $4.50/M Class A, $0.36/M Class B. Free tier is Standard storage only. | https://developers.cloudflare.com/r2/pricing/ | ✅ confirms §2a |
| 8 | ⛔ **Activating R2 requires a payment method on file**, even to stay inside the free 10 GB. The billing dialog cannot be bypassed. Cloudflare's stated reason: R2 usage is uncapped. | https://community.cloudflare.com/t/why-using-r2-free-tier-involves-giving-card-info/945179 · policy context: https://developers.cloudflare.com/billing/understand/billing-policy/ | ⛔ **NEW — violates C11.** Not mentioned anywhere in the pack. See ADR-015 |
| 9 | WhatsApp: conversation-based pricing ended **2025-07-01**, replaced by per-delivered-message pricing | https://developers.facebook.com/docs/whatsapp/pricing/ | ⛔ the pack's "1,000 free service conversations/month" model no longer exists |
| 10 | WhatsApp: non-template (service) messages have been **free with no monthly cap** since **2024-11-01** | https://developers.facebook.com/docs/whatsapp/pricing/ | ⚠️ briefly *better* than assumed |
| 11 | ⛔ **"Pricing updates for Meta Business Agent, service, and utility messages will launch on August 1, 2026 and October 1, 2026."** From 2026-10-01 service messages are billed per message at the utility/authentication rate for the country, **no free allowance, no volume discount**; only the 72-hour free-entry-point window stays free | https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing (Meta's own page) · corroborated: https://chakrahq.com/article/whatsapp-api-pricing-update-service-messages-october-2026/ | ⛔ **NEW — breaks ADR-009 in ~8 weeks.** See ADR-016 |
| 12 | Egypt WhatsApp rates: authentication ≈ $0.0130, utility ≈ $0.0073 per message | carried forward from `05_ZERO_COST_ARCHITECTURE.md` sources — **not re-verified against Meta's rate card this pass** | ⚠️ `temporary assumption` |
| 13 | UptimeRobot Free: 50 monitors, 5-min interval, **"No credit card required!"** verbatim | https://uptimerobot.com/pricing/ | ✅ matches |
| 14 | Sentry Developer: 5k errors/mo · 5M spans · 50 replays · 30-day retention · 1 user | https://sentry.io/pricing/ | ✅ matches. Card requirement **not stated** — unverified |
| 15 | Neon Free (Plan B): 0.5 GB storage/project · 100 CU-hours/project/month · 5 GB egress · 100 projects · **no credit card required** · **not a trial** | https://neon.com/pricing | ⚠️ **the pack is wrong on one point:** the Free plan is **always-on**, NOT scale-to-zero (that is configurable only on paid). Over-limit → compute suspends until next month; **it cannot bill** |
| 16 | Backblaze B2 (Plan B storage): "First 10GB storage is always free"; Class A/B/C API calls free for pay-as-you-go | https://www.backblaze.com/cloud-storage/pricing | ⚠️ card requirement at signup **not stated on the pricing page** — unverified, must be checked before adopting |
| 17 | D1 supports views, generated columns, foreign keys, CHECK constraints, FTS5, partial indexes, PRAGMA; `PRAGMA table_list` exposes a `strict` column | https://developers.cloudflare.com/d1/sql-api/sql-statements/ | ✅ enough for the port. **STRICT tables and trigger `RAISE(ABORT)` are not explicitly documented** → `engineering inference`, verified locally on SQLite 3.45.1, must be re-verified on the first real `wrangler d1 migrations apply` (CP-1 gate) |

### Second pass, 2026-08-04 — storage, after the owner asked "is Cloudflare free or not?"

| # | Fact established | Source (primary) | Consequence |
|---|---|---|---|
| 18 | **R2 requires completing a checkout flow.** *"You need a Cloudflare account with an R2 subscription… Complete the checkout flow to add an R2 subscription to your account."* Stated as a prerequisite even though *"R2 is free to get started with included free monthly usage."* | https://developers.cloudflare.com/r2/get-started/ — **Cloudflare's own documentation**, replacing the community-thread evidence of pass 1 | ⛔ R2 fails C11 definitively |
| 19 | **Adding a payment method triggers a $5 temporary authorization hold.** Cloudflare staff: *"When a payment method is added, Cloudflare performs a temporary $5 authorization check to verify the card."* Released by the bank, not a charge — but a real hold on a real card | https://community.cloudflare.com/t/question-regarding-5-usd-charge-for-r2-storage-activation/900480 | reinforces #18 |
| 20 | ⚠️ **A Google SERVICE ACCOUNT has no Drive storage quota.** Uploads fail with `403 storageQuotaExceeded` even when the service account's Drive is completely empty. Documented workarounds — a Workspace shared drive, or domain-wide delegation impersonating a real user — both require **paid** Google Workspace | https://developers.google.com/workspace/drive/api/guides/handle-errors · https://support.google.com/drive/thread/164666886 · https://github.com/n8n-io/n8n/issues/26050 | ⛔ **A-07 FALSIFIED.** ADR-015's approved option does not work. See ADR-022 |
| 21 | Backblaze B2 requires payment details for **public** buckets (*"a payment history on file, or use the credit card form to pay a small fee"*). Private-bucket signup requirements are **not stated** | https://www.backblaze.com/docs/cloud-storage-create-and-manage-buckets | ⚠️ A-09 still unverified — check before adopting |
| 22 | AWS SigV4 signing implemented from the spec and verified against the published empty-payload hash and shape constants | `tests/unit/s3sign.test.ts`, 7/7 | the S3 adapter works for B2 or R2 without change |

---

## Verified locally, not from a vendor page (2026-08-04)

Run: `python3 tests/fixtures/verify_ledger.py` → **48 checks, 48 passed**, SQLite 3.45.1.

| Fact | How it was established |
|---|---|
| All 5 migrations apply cleanly: 43 tables, 12 views, 19 triggers | executed against a real SQLite engine |
| STRICT tables reject a float in an INTEGER piastres column — *"cannot store REAL value in INTEGER column journal_lines.debit_piastres"* | executed |
| A deposit category cannot be mapped to an income account; **and with the trigger dropped, the same insert succeeds** | executed — the guard was watched failing first |
| An entry 1.00 ج.م out of balance cannot post; **and with the trigger dropped, it posts** | executed — watched failing first |
| The hand-computed fixture from `06 §2` reconciles exactly, and the view agrees with an independent raw-SQL aggregate | executed |
| ⚠️ **The accounting equation (invariant 12) is a tautology under balanced double-entry.** A ledger with الوديعة deliberately booked to income still shows `residual = 0`, while spendable is overstated by exactly the deposit | executed — see `05 §8` of the fixture and the honesty note in `migrations/0005_views.sql` |
| ⚠️ **FTS5's `unicode61` tokenizer does not fold Arabic orthographic variants.** Indexed `حديقه` is not matched by the query `حديقة`; indexed `انشاء` is not matched by `إنشاء` | executed — hence the `search_body` column |

---

## Not yet verified — do not cite these as facts

- Egyptian PDPL 151/2020 obligations — **requires a qualified Egyptian lawyer** (CP-8 gate). Nothing
  in this repository is legal advice.
- The chart of accounts and the الوديعة treatment — **requires a qualified accountant** (Q15, CP-8
  gate). Nothing in this repository is accounting advice.
- Whether Backblaze B2 or Sentry require a card at signup.
- Passkey (WebAuthn) support rates on residents' actual devices — measure at pilot (ADR-011).
- Meta's Egypt per-message rate card as it will stand on 2026-10-01.
