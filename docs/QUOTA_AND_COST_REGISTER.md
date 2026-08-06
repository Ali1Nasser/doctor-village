# QUOTA & COST REGISTER — إثبات التكلفة الصفرية

> **Rule (C11):** "Free" must be proved, not assumed. A marketing label is not evidence.
> Every row records the official source, the date checked, the reset period, our expected usage,
> the warning threshold, the hard threshold, **what happens at the limit**, and **whether the
> service can bill us at all**.

**All rows re-verified: 2026-08-04.** Next mandatory re-verification: **2026-11-04** (quarterly),
and again immediately before launch.

**Profiles (C11):**
`STRICT_ZERO_COST` — cannot bill under any circumstance, no card ·
`FREE_TIER_WITH_BILLING_EXPOSURE` — needs written owner acceptance + a hard app-level cap ·
`FUTURE_PAID` — adapter interface only, never activated.

---

## 1. Services in the chosen stack

| Service | Limit (free) | Reset | Our expected usage | Warn / Hard | At the limit | Can it bill? | Profile | Source (checked 2026-08-04) |
|---|---|---|---|---|---|---|---|---|
| **Cloudflare Workers** | 100,000 requests/day · 10 ms CPU per invocation · 128 MB memory · 3 MB script · 50 subrequests/request · 100 Workers/account | daily | ~214 units × ~50 req/day ≈ **11k/day (11%)** | 60k / 85k | **Requests fail with an error. No charge.** | **No** | `STRICT_ZERO_COST` | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| **Cloudflare Pages** | 500 builds/month · 20,000 files/site · 25 MiB max asset · 100 custom domains · bandwidth not metered | monthly | ~30 builds/month | 300 / 450 | Builds refused | **No** | `STRICT_ZERO_COST` | [Pages limits](https://developers.cloudflare.com/pages/platform/limits/) |
| **Cloudflare D1** | **500 MB per database** · 5 GB account total · **10 databases on free** · 5M rows read/day · 100k rows written/day | daily / storage | ~10k txn/yr ≈ a few MB/yr; writes ≈ 2–4k/day | 60k writes / 85k writes · 350 MB / 450 MB | **Queries fail with "daily limits exceeded". Blocked, never billed.** Storage full → no inserts until data is cleaned. | **No** | `STRICT_ZERO_COST` | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) · [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| **Cloudflare KV** | 100,000 reads/day · **1,000 writes/day** · 1 GB storage · 25 MiB value · 512 B key | daily | read-mostly cache only — see ⚠️ below | 500 writes / 800 writes | Operations fail with an error | **No** | `STRICT_ZERO_COST` | [KV limits](https://developers.cloudflare.com/kv/platform/limits/) |
| **Cloudflare R2** | 10 GB-month · 1M Class A ops/mo · 10M Class B ops/mo · **egress free** | monthly | 2.5 GB/yr at ~500 KB/receipt | 5 GB / **7 GB app-enforced** | **Billed at $0.015/GB-month, $4.50/M Class A, $0.36/M Class B** | **YES — and a payment method is REQUIRED to activate it at all** | ⛔ **`FREE_TIER_WITH_BILLING_EXPOSURE`** | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) · [card requirement](https://community.cloudflare.com/t/why-using-r2-free-tier-involves-giving-card-info/945179) |
| **`*.pages.dev` domain** | free forever | — | 1 subdomain | — | — | **No** | `STRICT_ZERO_COST` | Cloudflare Pages |
| **GitHub (private repo)** | unlimited private repos · 2,000 Actions min/month on Free | monthly | ~60 min/month (weekly backup job) | 800 / 1,500 | Actions refused | **No** (Free plan has no overage) | `STRICT_ZERO_COST` | GitHub Free plan |
| **Google Drive (board-owned)** | 15 GB | — | backups, a few MB/month | 8 GB / 12 GB | Uploads refused | **No** — a consumer Google account has no billing path | `STRICT_ZERO_COST` | Google One free tier |
| **UptimeRobot** | 50 monitors · 5-min interval · **"No credit card required!"** | — | 3 monitors | — | — | **No** | `STRICT_ZERO_COST` | [UptimeRobot pricing](https://uptimerobot.com/pricing/) |
| **Sentry (Developer)** | 5k errors/mo · 5M spans · 50 replays · 30-day retention · 1 user | monthly | well under | 3k / 4.5k | Events dropped | Card requirement not stated on the pricing page — **treat as unverified** | `STRICT_ZERO_COST` *(pending)* | [Sentry pricing](https://sentry.io/pricing/) |
| **WhatsApp Cloud API** | service (non-template) messages free **until 2026-10-01** | monthly | — | — | see ⛔ §2 | **YES from 2026-10-01** | ⛔ **`FUTURE_PAID`** | [Meta pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing) |

### ⚠️ KV's 1,000 writes/day is the tightest quota in the entire stack
It is ~1% of D1's write allowance. Anything an **unauthenticated** caller can trigger a write to
must never touch KV, or a single bored attacker exhausts the day's budget and the login path stops
working. Sessions, rate-limit counters, and activation challenges therefore live in **D1**
(`migrations/0001_foundation.sql`). KV holds read-mostly cached lookups only.

---

## 2. ⛔ Two findings that break the plan as written

### 2.1 R2 requires a payment method on file — this violates C11 outright
C11 says: *"Never sign up for anything requiring a payment method, even where 'you won't be
charged.'"* Cloudflare will not create an R2 bucket without one, because R2 usage is uncapped and
billed past the free allowance. This is not the same as the (already-known) overage exposure noted
in `05_ZERO_COST_ARCHITECTURE.md` §2a — it is a hard blocker on activation.

Every other Cloudflare product we use **blocks** rather than bills, and needs no card. R2 is the
single exception. Decision required from the owner: **Q19-revised** in `docs/OPEN_QUESTIONS.md`.

### 2.2 WhatsApp service messages become billable on 2026-10-01
`05_ZERO_COST_ARCHITECTURE.md` §3.1 and ADR-009 rest on *"1,000 free service conversations per
month, customer-initiated"*. That figure is **two revisions out of date**:

- Conversation-based pricing ended **2025-07-01**; billing is now per delivered message.
- Non-template (service) messages have been **free with no monthly cap** since **2024-11-01** —
  briefly better than the pack assumed.
- **From 2026-10-01 Meta begins charging for service messages**, per message, at the same rate as
  utility/authentication templates in that country (Egypt ≈ $0.0073–$0.0130), with **no free
  allowance and no volume discount**. Only the 72-hour "free entry point" window stays free, and
  that requires a Click-to-WhatsApp ad, which we will not have.

That is **8 weeks away**. Inbound messages *from* a resident remain free — Meta bills the business
for messages it *sends*. So the flow could survive by never replying on WhatsApp at all. The
recommendation in ADR-016 goes further and drops the integration from v1; see
`docs/OPEN_QUESTIONS.md` **Q20**.

---

## 3. Account ownership — C11 requires the board, not the developer

| Service | Account owner must be | Payment method attached | Documented export path |
|---|---|---|---|
| Cloudflare | ⬜ board (جمعية) | must be **none** | `wrangler d1 export` → SQL |
| GitHub | ⬜ board org | none | `git clone` |
| Google Drive | ⬜ board | none | direct download |
| UptimeRobot | ⬜ board | none | n/a |
| Sentry | ⬜ board | none | n/a |

**None of these accounts exists yet.** Creating them in the developer's name and "moving them
later" is how R-008 (bus factor of one) becomes permanent. Create them board-owned from day one.

---

## 4. Degradation order — never improvise this under pressure (05 §7)

1. Block new **large uploads** — clear Arabic message, "حاول بكرة".
2. Then block new writes generally.
3. **Always preserve read access to already-posted financial records.**

**Absolute rule:** quota exhaustion must never corrupt or half-post a financial transaction. The
quota check is advisory *before* a transaction and can never substitute for atomicity *during* one.
A limit hit mid-posting rolls the whole operation back. The `payments` table enforces this
structurally: `CHECK (status <> 'approved' OR journal_entry_id IS NOT NULL)` — an approved receipt
without its ledger entry cannot exist.
