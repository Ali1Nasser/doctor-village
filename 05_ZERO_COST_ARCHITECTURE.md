# 05 — Zero-Cost Architecture · معمارية بتكلفة صفر

**Hard requirement (C11):** the entire system — hosting, database, file storage, authentication,
message delivery, backups, monitoring — must run at **0 EGP/month**, permanently, with no credit
card required and no trial that expires.

All figures verified August 2026. Sources at the bottom. **Re-verify before you build** — free tiers
change, and one of them (PlanetScale) has already disappeared.

---

## 1. The recommended stack — everything on Cloudflare

| Layer | Service | Free limit | Enough for us? |
|---|---|---|---|
| Site + API | **Cloudflare Workers / Pages** | 100,000 requests/day · **unlimited bandwidth** · 500 builds/month | 214 units × ~50 req/day ≈ 11k/day → **10% of quota** |
| Database | **Cloudflare D1** (SQLite) | **500 MB per database** · 5 GB account total · 5M row-reads/day · 100k row-writes/day | ~10k transactions/year ≈ a few MB/yr → fine, but see ⚠️ below |
| Receipt & album images | **Cloudflare R2** ⚠️ | 10 GB · 1M writes/mo · 10M reads/mo · **zero egress** — **but overage is billed** | 500 KB × 5,000 receipts/yr ≈ 2.5 GB/yr → 4 years, with a hard app cap (see §2a) |
| Sessions, rate limits, OTP challenges | **Cloudflare KV** | 100k reads/day · 1k writes/day · 1 GB | comfortable |
| Domain | **`qaryat-atebaa.pages.dev`** | free forever | a real `.com` costs ~$10/yr — **optional**, not required |
| Code | **GitHub** (private repo) | free, unlimited private repos | ✔ |
| Login codes | **WhatsApp Cloud API — user-initiated flow** (§3) | 1,000 free service conversations/month | ~214 logins/month → **21% of quota** |
| Off-site backup | **GitHub private repo + Google Drive** | 15 GB Drive free | nightly SQL dump ≈ a few MB |
| Uptime monitoring | **UptimeRobot free** | 50 monitors, 5-min checks | ✔ |
| Error tracking | **Sentry free** | 5k errors/month | ✔ |

**Total: $0.00 / month at this scale — with the two caveats in §2a, which you must read.**

### ⚠️ 2a. Two corrections to the table above — verified against Cloudflare's own docs

**(1) D1's free limit is 500 MB *per database*, not 5 GB.** The 5 GB figure is the total across all
databases on the account. For a ledger of text rows this is still enormous — roughly a decade of
this village's transactions — but the number matters for the five-year forecast, and it means
**never store image bytes in D1**. Only metadata and hashes. If a single database ever approaches
400 MB, archive closed fiscal years into a second database.

**(2) R2 bills on overage — so it is not *strictly* zero-cost.** The 10 GB/month allowance is real
and free egress is real, but usage past the allowance is charged at standard rates, and Cloudflare
rounds usage up to the next billing unit. That makes R2 `FREE_TIER_WITH_BILLING_EXPOSURE`, not
`STRICT_ZERO_COST`. Two acceptable ways to handle this — pick one with the owner:

- **Recommended: keep R2, enforce a hard cap in our own code.** The upload path refuses any write
  that would take total bucket usage past **7 GB** (70% of the allowance), and `/admin/health` warns
  from 50%. At 2.5 GB/year with client-side compression, that is roughly three years before the
  archive job even matters. The billing exposure is real but bounded by our own code, not by trust.
- **Strictly zero: a village-owned Google Drive service account as the object store.** A free Google
  account has no billing path at all, so it *cannot* charge you — 15 GB, and the board owns it.
  Slower, clumsier API, and OAuth token custody becomes a real operational burden. **Note this is
  Drive as a private *file store* behind our own authorization layer — never as the database, and
  never with shareable links.**

Either way it sits behind `lib/storage/`, so the choice is one adapter file. Record whichever the
owner picks in `DECISIONS.md`.

Adjusted stack: **Hono** (a tiny web framework built for Workers) + **HTMX or a small React island**
instead of full Next.js. Next.js on Workers is possible but heavy; the app is mostly forms and tables,
and shipping less JavaScript also serves the 3G/old-phone requirement.

---

## 2. Why not the obvious alternatives — read this before arguing

### ❌ Supabase — the pause problem kills it here
The free plan pauses a project **after 1 week of inactivity** and requires a manual click to resume.

Qaryat Al-Atebaa is a **summer** community in Matrouh. In January there could easily be a quiet week.
The site would silently go down, and the first resident to check would find a dead link. For a
product whose entire purpose is restoring trust, "the site was down" is a fatal first impression.
Add the 500 MB database and 1 GB storage caps and it is the wrong choice — despite being the nicest
developer experience of the group.

### ❌ Google Drive / Google Sheets as the database — do not do this
It is a tempting idea and it is wrong for this specific application. Honestly:

- **No transactions.** Approving a payment must update several things atomically. If the process dies
  halfway, Drive leaves you with a half-written state and no rollback. In a money system that is a
  corrupted ledger.
- **No concurrency control.** Two board members approving receipts at the same moment will overwrite
  each other's row. Sheets has no row locking.
- **No real permissions.** Access is all-or-nothing per file. You cannot express "this resident may
  read only their own receipt." You would have to funnel everything through server code anyway — at
  which point Drive is just a slow, fragile database.
- **Quotas that bite silently.** The Sheets API rate-limits reads/writes per minute; a dashboard that
  aggregates hundreds of rows will hit them and fail unpredictably.
- **No indexes.** Every query is a full scan. It gets slower every month, forever.
- **No audit integrity.** Anyone with edit access can silently rewrite history, which defeats the
  entire point of an append-only ledger.

**But Drive is excellent for one job: free off-site backup.** 15 GB, outside the hosting vendor,
and the board can hold the account themselves. Use it exactly there — see §5.

### ❌ Firebase phone auth — not free
Requires the Blaze pay-as-you-go plan with a card on file; only the first 10 SMS/day are free, and
**every send is billed including codes nobody ever types**. It violates the "no credit card" rule.

### ❌ Netlify / Vercel — fine, but strictly worse here
Both give 100 GB bandwidth on free. Cloudflare gives **unlimited** bandwidth and a database and
object storage on the same free account. Fewer vendors, fewer quotas to watch. If you strongly prefer
Netlify for familiarity, it works — but you would still need a separate database and image host.

### ⚠️ Neon — a good Postgres fallback
0.5 GB, scale-to-zero with instant resume (no manual unpause like Supabase). If you want real
Postgres with real Row Level Security, this is the free option. **Trade-off:** Workers → Neon adds a
network hop and needs connection pooling. Keep it as Plan B (§6).

---

## 3. Free login — passkeys first, inbound WhatsApp for activation

The expensive line item in the original design was OTP delivery. Every outbound path costs money:
WhatsApp *authentication* messages ≈ $0.013 each to Egypt; SMS is far worse; Telegram Gateway is
$0.01 and needs Telegram installed, which most residents will not have.

Two independent fixes, layered. Together they cost nothing and depend on nobody.

### 3.0 Passkeys carry every login after the first ⭐

**WebAuthn passkeys are the only part of this system that no vendor can ever take away.** No
message, no code, no quota, no account, no pricing page. The resident touches the fingerprint sensor
or enters their phone's own lock, and they are in.

- Explain it in plain Egyptian Arabic: **"الدخول ببصمة أو قفل الموبايل"**. Say plainly that the
  fingerprint never leaves their phone — the site only keeps a public key. People ask.
- Enroll a second passkey on another trusted device where possible (many residents have a phone and
  a tablet, or a spouse's phone).
- Issue single-use printed recovery codes at activation, and keep the assisted recovery path in §3.
- Sessions last a year on a trusted device, so most residents will rarely see even this.
- **Known trade-off — write it into the exit plan now:** WebAuthn credentials are bound to the
  domain. Moving from `qaryat-atebaa.pages.dev` to a custom domain later requires re-enrolling every
  passkey **while the old domain still works**. Decide the domain before enrolling resident #1.
- No passkey support on an old device? Fall back to §3.1 below. **Never** a shared or guessable PIN.

This is strictly better than any messaging-based login: cheaper (nothing), faster (one touch), more
secure (phishing-resistant), and — the part that matters here — it removes reading and retyping a
code, which is exactly where elderly users abandon.

### 3.1 Inbound WhatsApp for first activation and recovery

Passkeys still need one trusted moment to be created. That is what this is for — and it beats the
usual answer (a board member physically delivering a printed code to 214 flats).

**The trick: reverse the direction of the message.**

Meta gives every business **1,000 free service conversations per month** — but only when the
*customer messages first* and the business replies within 24 hours. So we never send an
authentication message. We let the resident open the conversation.

```
┌─ Login screen ──────────────────────────────┐
│  رقم الموبايل  [ 010 xxxx xxxx ]            │
│  [  🟢 دخول عن طريق واتساب  ]               │
└─────────────────────────────────────────────┘
      │  server creates a one-time token, e.g. K7F2QX
      ▼
  opens WhatsApp with a pre-filled message:
      wa.me/20XXXXXXXXX?text=دخول%20K7F2QX
      │
      │  the resident just presses ▶ send  (one tap)
      ▼
  Meta webhook → our Worker → token matched → session marked verified   ← FREE
      │                                                (user-initiated)
      ▼
  the bot replies "أهلاً يا دكتور أحمد، تم تسجيل دخولك ✅"  ← FREE (same window)
      │
      ▼
  the web page is polling → detects verification → opens the account
```

**Why this is better, not just cheaper:**
- The resident does not have to *read* a code and *retype* it — the step where elderly users
  overwhelmingly fail. They press send. That's it.
- No code to mistype, no expiry panic, no "الكود مجاش".
- Cost: **0 EGP** up to 1,000 logins/month. At ~214 units with 1-year sessions we would use ~20/month.

**Session length: 1 year for residents** (was 30 days). Fewer logins = further under quota, and less
friction for people who visit the site four times a year. Sessions are revocable by an admin, and any
sensitive action (approving money, changing a phone number) re-verifies with the passkey regardless.

**Because passkeys handle the daily load, WhatsApp is used roughly once per resident per device —
so we consume something like 250 of the 1,000 free conversations in the whole first year, not per
month.** The Meta dependency shrinks from "every login" to "once, ever."

### Fallbacks, in order — all free
1. **Board-issued personal link.** The admin panel generates a one-time login link per resident. A
   board member pastes it into their *own normal WhatsApp* and sends it. Zero infrastructure, zero
   API, works today, and is how the first 20 residents should be onboarded anyway. Link expires in
   24 h and can only be used once.
2. **Telegram Bot API** — genuinely free and unlimited, for the handful of residents who use Telegram.
3. **Printed code at the gate.** For a resident with no smartphone at all, the security desk or a
   board member can hand them a paper code. Unglamorous, free, and it means nobody is excluded.

### If Meta's free service tier ever disappears
**Existing residents are unaffected — they log in with passkeys and never touch WhatsApp.** Only new
activations and recoveries need a channel, and those fall back to (1) above permanently. It costs
nothing but a board member's minute. `lib/auth/channel.ts` makes it a config change, not a rewrite.
**Write this fallback before you need it, and test it with WhatsApp switched off entirely.**

---

## 4. Security without Postgres RLS — the honest version

The original spec (C6) demanded Row Level Security *in the database*, because Supabase exposes a
public data API that can be called directly, so application-layer checks are bypassable.

**Cloudflare D1 has no public data API.** The only route to the database is through your own Worker
code. The threat model is different, so the control changes — but it must not weaken.

**Revised C6:** the database is reachable *only* through a single server-side data-access layer, and
every query in that layer takes the caller's identity as a required argument.

Concretely:
- One module, `lib/db/`. **No SQL is written anywhere else in the codebase** — a lint rule enforces it.
- Every function signature is `getPayments(ctx: AuthContext, …)`. There is no way to call it without
  an identity. A missing `ctx` is a type error, not a runtime surprise.
- Every query that touches resident-scoped data has the ownership predicate baked into the SQL string
  itself, not appended by a caller: `WHERE unit_id IN (SELECT unit_id FROM unit_owners WHERE profile_id = ?)`.
- The permission matrix from `03_RBAC_AND_AUTH.md` lives in `lib/rbac.ts` as data and is asserted at
  the top of every data-access function.
- The R2 bucket is **private**. Images are served only through a Worker route that re-checks
  ownership on every request. There are no public object URLs, ever.
- The CP-1 gate becomes: **the same 10 access tests from `02_DATA_MODEL.md` §6, executed against the
  HTTP API as each role**, proving a resident cannot reach another resident's data through any
  endpoint. Watch each one fail against a deliberately broken guard before trusting it.

This is a real trade-off and you should know it: RLS fails *closed* by default, application checks
fail *open* if you forget one. The single-data-access-layer rule plus the required `ctx` argument is
what buys the safety back. **If you are not confident you can hold that discipline, use Neon +
Postgres RLS instead (§6) and accept the extra network hop.**

---

## 5. Backups — free, and actually tested

Free hosting means nobody is contractually obliged to keep your data. Backups are therefore not
optional; they are the price of the free tier.

- **Nightly:** a Cloudflare Cron Trigger (free) dumps D1 to SQL, gzips it, and writes it to R2.
- **Weekly:** a GitHub Action (free minutes on a private repo) pulls that dump and commits it to a
  private `qaryat-backups` repository. Now the data exists at a second vendor.
- **Monthly:** the same Action uploads a copy to a **Google Drive folder owned by the board**, not by
  the developer. This is the single most important line in this document — it is what protects the
  community if the developer disappears, and it is the correct use of Google Drive here.
- **Receipt images:** monthly, zip the previous month's images from R2 to the same Drive folder.
- **Quarterly restore drill:** restore into a fresh empty D1 database and check that the treasury
  total matches. **A backup you have never restored is not a backup.** This is a CP-8 gate.

## 6. Plan B — the switch conditions, decided in advance

Write these thresholds down now, while nobody is panicking.

| If this happens | Do this |
|---|---|
| D1 writes exceed 60k/day (60% of quota) | Batch the audit log; if still high, move to Neon Postgres free |
| R2 storage passes 7 GB | Archive receipts older than 3 years into a Drive zip and delete from R2 |
| Workers requests pass 60k/day | Add Cache API headers on the read-only transparency pages |
| Meta ends the free service-conversation tier | Switch permanently to board-issued login links (§3, fallback 1) |
| Cloudflare changes the free tier | The whole app is standard SQL + S3-compatible storage — Neon + Backblaze B2 (10 GB free) is a weekend migration |
| The community grows past ~2,000 units | You have outgrown free. Budget ~$5–25/month and stop optimizing for zero. |

**Design rule that makes all of the above cheap:** no vendor-specific API leaks outside its adapter.
D1 sits behind `lib/db/`, R2 behind `lib/storage/`, WhatsApp behind `lib/auth/channel.ts`. Three
files to change, not three hundred.

## 7. Quota dashboard and safe degradation — build this in CP-3

A page at `/admin/health`, visible to admins, showing usage against every free limit as a percentage
bar. Residents should never learn about a quota by the site breaking. Cloudflare's analytics API is
free; read it nightly and store the snapshot.

**Warning thresholds: 50% (notice) · 70% (banner) · 85% (email the board) · 95% (degrade).**

**Degradation order — never improvise this under pressure:**
1. Block new **large uploads** first, with a clear Arabic message and a "حاول بكرة" option.
2. Then block new writes generally.
3. **Always preserve read access to already posted financial records.** A resident must still be
   able to see what they paid, even when the system cannot accept anything new.

**The absolute rule:** quota exhaustion must never corrupt or half-post a financial transaction. A
quota check is advisory *before* a transaction; it can never substitute for atomicity *during* one.
If a limit is hit mid-posting, the whole operation rolls back. Never leave an approved receipt
without its ledger entry, or a ledger entry without its approval record.

**No handler, script, or provider setting may enable paid overage.** Ever, under any load.

## 7a. Proving zero cost — the register

Maintain `docs/QUOTA_AND_COST_REGISTER.md` with one row per service:

| Service | Limit | Official URL | Date checked | Reset period | Our usage | Warn at | Hard stop at | Behavior at limit | Billing possible? |
|---|---|---|---|---|---|---|---|---|---|

Re-verify **before launch and quarterly thereafter**. Free tiers change; one already vanished.
Also record, per service: who owns the account (must be the board, not the developer), whether a
payment method is attached, and the documented export path.

---

## 8. What this changes in the rest of the pack

| Document | Change |
|---|---|
| `00_MASTER_PROMPT.md` | C11 added (zero cost); tech stack replaced; C6 restated per §4 |
| `DECISIONS.md` | ADR-008/009/010 supersede ADR-001, ADR-003, ADR-007 |
| `02_DATA_MODEL.md` | Postgres types → SQLite: `BIGINT`→`INTEGER`, `uuid`→`TEXT` ids, enums → `TEXT` + `CHECK`, `tsvector` → FTS5 virtual table, views stay as views. **Money stays an integer — that rule never changes.** |
| `03_RBAC_AND_AUTH.md` | §3 login flow replaced by the user-initiated WhatsApp flow; matrix unchanged |
| `CHECKPOINTS.md` | CP-1 gate becomes API-level access tests; CP-8 adds the restore drill and quota dashboard |
| `RISKS.md` | R-016…R-019 added |

---

## Sources
- [Supabase Pricing](https://supabase.com/pricing) — free plan: 500 MB database, 1 GB storage, 5 GB egress, **paused after 1 week of inactivity**
- [Cloudflare free full-stack limits 2026](https://www.buildmvpfast.com/blog/cloudflare-workers-hono-d1-r2-free-fullstack-2026) — Workers 100k req/day, D1 5 GB / 5M reads / 100k writes per day, R2 10 GB with zero egress
- [Database free tier comparison 2026](https://agentdeals.dev/database-free-tier-comparison-2026) — which providers pause on inactivity; PlanetScale's free tier removal
- [Vercel vs Netlify vs Cloudflare Pages 2026](https://coderfile.io/blog/vercel-vs-netlify-vs-cloudflare-2026) — Cloudflare Pages unlimited bandwidth vs 100 GB elsewhere
- [Meta WhatsApp pricing 2026](https://www.go4whatsup.com/guides/meta-whatsapp-pricing/) — **first 1,000 service conversations per month free**, customer-initiated only; no free tier for authentication/utility/marketing
- [Egypt WhatsApp API rates](https://ominiflow.com/whatsapp-api-pricing/egypt) — authentication ≈ $0.0130, utility ≈ $0.0073 per conversation
- [Telegram Gateway](https://core.telegram.org/gateway) — $0.01 per code; free only to your own number; requires the recipient to have Telegram
- [Firebase Authentication pricing 2026](https://blog.logto.io/firebase-authentication-pricing) — Blaze plan required, only 10 free SMS/day, every send billed
