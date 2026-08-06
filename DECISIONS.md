# DECISIONS — Architecture Decision Records

**Rule:** every choice with a live alternative gets an ADR. Every ADR names the option rejected and
why. A decision recorded here is settled — do not relitigate it without a superseding ADR.

**Template**
```
## ADR-0NN — <title>
**Date:** YYYY-MM-DD · **Status:** proposed | accepted | superseded by ADR-0MM
**Context:** what forced a choice
**Decision:** what we do
**Alternatives rejected:** what we didn't do, and why
**Consequences:** what this costs us later
**Revisit if:** the condition that would reopen this
```

---

## ADR-001 — Next.js + Supabase
**Date:** 2026-08-03 · **Status:** ~~accepted~~ **superseded by ADR-008**
**Context:** One residential compound (~hundreds of units), a volunteer board, no budget, one
maintainer. Needs auth, file storage, a relational ledger, and row-level security.
**Decision:** Next.js 15 App Router on Vercel + Supabase (Postgres, Storage, Edge Functions).
**Alternatives rejected:**
- *Laravel + MySQL on shared cPanel* — familiar to many Egyptian developers and cheap, but we would
  hand-build storage handling, row-level security, and realtime; and MySQL's RLS story is weaker.
- *Firebase* — document model fits a financial ledger poorly; aggregate queries and referential
  integrity would be fought rather than expressed.
- *WordPress + plugins* — fastest to a demo, worst to maintain and secure for money.
**Consequences:** Vendor coupling to Supabase. Mitigated by it being plain Postgres — a dump restores
anywhere. Vercel/Supabase free tiers are adequate at this scale; costs appear only on growth.
**Revisit if:** the community exceeds ~2,000 units, or the board requires on-premises hosting.

## ADR-002 — Money as BIGINT piastres
**Date:** 2026-08-03 · **Status:** accepted
**Context:** JavaScript numbers cannot represent decimal currency exactly. `0.1 + 0.2 !== 0.3`.
**Decision:** Store EGP × 100 as `BIGINT`. All arithmetic in `lib/money.ts` on integers. Format only
at the display boundary.
**Alternatives rejected:** `NUMERIC(12,2)` — correct in Postgres, but the value becomes a JS float the
moment it crosses the wire; the safety is illusory. `decimal.js` — a dependency and a discipline
problem where `BIGINT` is a structural guarantee.
**Consequences:** Every read and write must convert. One module owns this; nothing else touches money math.
**Revisit if:** never, realistically.

## ADR-003 — Phone-only OTP authentication
**Date:** 2026-08-03 · **Status:** accepted — delivery mechanism superseded by ADR-009
**Context:** Owner requirement C1. Users include elderly residents who will not manage passwords.
**Decision:** 6-digit OTP over WhatsApp (primary) / SMS (fallback). No password, no email, ever.
**Alternatives rejected:** Magic links by email — many owners have no email they check. Password +
phone recovery — the password is the thing that fails for this population.
**Consequences:** Per-login message cost; account recovery becomes a **human process** (see
`03_RBAC_AND_AUTH.md` §6) and is the system's main fraud surface. 30-day sessions reduce both cost
and friction — that length is deliberate.
**Revisit if:** message costs become material, or a passkey flow becomes realistic for this population.

## ADR-004 — Admin pre-provisions accounts; self-registration is secondary
**Date:** 2026-08-03 · **Status:** accepted
**Context:** Owner requirement C2. The compound already holds the owner register.
**Decision:** Bulk import from existing records. A resident's account exists before their first login.
Self-registration exists as an admin-approved fallback, with zero financial visibility until an admin
links the account to a unit.
**Alternatives rejected:** Open self-registration — anyone with a phone could enumerate community
finances, and unit-to-person mapping would be self-asserted.
**Consequences:** Import data quality is now on the critical path. The importer must be forgiving of
messy real-world spreadsheets and must never silently guess.

## ADR-005 — Radical transparency by default
**Date:** 2026-08-03 · **Status:** accepted
**Context:** The product exists because of suspicion born of disorder. Transparency is the cure.
**Decision:** Every authenticated member sees total income, total expenses, treasury balance, the full
category breakdown, and each unit's aggregate paid/outstanding position. Private: receipt images,
phone numbers, personal notes, and (pending Q4) staff names.
**Alternatives rejected:** Financials visible to the board only — reproduces the current problem.
Fully public including receipt images — a privacy violation and an invitation to shaming.
**Consequences:** Per-unit arrears are visible to neighbours. This is socially significant and must be
confirmed by the board explicitly, in writing, before launch. Flagged in `RISKS.md`.
**Revisit if:** the general assembly objects to unit-level arrears visibility.

## ADR-006 — Append-only ledger with reversals
**Date:** 2026-08-03 · **Status:** accepted
**Context:** A corrected number that silently replaces a number residents already saw destroys trust
faster than the original error.
**Decision:** Approved payments and recorded expenses are immutable. Corrections post a reversing
entry that references the original. Monthly statements are snapshotted.
**Alternatives rejected:** Editing in place with an audit trail — technically sufficient, socially
weaker; the visible history is what earns trust.
**Consequences:** More rows, slightly more complex aggregate queries. Worth it.

## ADR-007 — Security enforced in the database, not the application
**Date:** 2026-08-03 · **Status:** ~~accepted~~ **superseded by ADR-010**
**Context:** Supabase exposes a PostgREST API. Application-layer guards can be bypassed entirely.
**Decision:** Row Level Security on every table, with an automated test suite as a CP-1 gate.
Application checks are for UX, never for security.
**Alternatives rejected:** Route-handler-only authorization — one forgotten check leaks everything.
**Consequences:** Policies are harder to write and debug. The test suite is mandatory, not optional.

---

## ADR-008 — Cloudflare (Workers + D1 + R2 + KV) instead of Vercel + Supabase
**Date:** 2026-08-03 · **Status:** accepted · **Supersedes ADR-001**
**Context:** New hard constraint C11 — the system must cost **0 EGP/month permanently, with no credit
card on file**. Free tiers were re-verified against vendors' own pricing pages in August 2026.
**Decision:** Cloudflare Workers/Pages (app + API), D1 (SQLite database), R2 (private object storage),
KV (sessions and rate limits), on the free plan. Framework is Hono with server-rendered HTML rather
than Next.js.
**Alternatives rejected:**
- *Supabase free* — **pauses a project after 1 week of inactivity.** Qaryat Al-Atebaa is a summer
  community in Matrouh; a quiet week in January would take the site down silently, and the first
  resident to check would find a dead link. For a product whose purpose is restoring trust, that is
  disqualifying. Also capped at 500 MB database / 1 GB storage.
- *Google Drive or Sheets as the database* — no transactions, no row locking, no per-row permissions,
  per-minute API quotas, no indexes, and no audit integrity. Every one of those is fatal for a money
  ledger. (Drive is retained for backups, which is what it is actually good at.)
- *Firebase* — phone auth requires the Blaze plan with a card on file; only 10 free SMS/day and every
  send is billed including codes nobody types.
- *Netlify / Vercel free* — workable but each caps bandwidth at 100 GB and neither includes a database
  or object storage, so we would run three vendors and three quota ceilings instead of one.
- *Neon Postgres free* — kept as the documented Plan B (real RLS, scale-to-zero, no manual unpause),
  at the cost of an extra network hop from Workers and a 0.5 GB ceiling.
**Consequences:** SQLite, not Postgres — schema types change and there is no Row Level Security
(see ADR-010). Workers has a 10 ms CPU limit per request, which is ample for form-and-table work but
rules out heavy server-side image processing — hence client-side compression. Unlimited bandwidth
means traffic spikes never produce a bill.
**Revisit if:** D1 writes exceed 60k/day, R2 passes 7 GB, the community grows past ~2,000 units, or
Cloudflare changes the free tier. Pre-decided switch conditions: `05_ZERO_COST_ARCHITECTURE.md` §6.

## ADR-009 — User-initiated WhatsApp login instead of outbound OTP
**Date:** 2026-08-03 · **Status:** accepted · **Supersedes the delivery half of ADR-003**
**Context:** Outbound login codes are the one genuinely recurring cost in the original design.
WhatsApp *authentication* messages run ≈ $0.0130 per conversation to Egypt; SMS is worse; Telegram
Gateway is $0.01 and requires the recipient to have Telegram, which most residents will not.
Meta gives every business **1,000 free service conversations per month — but only when the customer
messages first** and the business replies within 24 hours.
**Decision:** Reverse the direction. The resident taps "دخول عن طريق واتساب"; WhatsApp opens with a
pre-filled one-time token; they press send. Our webhook matches the token and opens the session. The
conversation is customer-initiated, so it is free. Sessions last 1 year.
**Alternatives rejected:** Outbound authentication templates (costs money, violates C11); SMS (worse);
email magic links (violates C1 and most owners have no email they read).
**Consequences:** Better UX, not merely cheaper — the resident never reads or retypes a code, which is
exactly the step where elderly users fail. Requires WhatsApp Cloud API setup, a dedicated number, and
Meta business verification (all free, but bureaucratic and slow). At ~214 units with 1-year sessions
we would use roughly 20 of the 1,000 free conversations per month.
**Revisit if:** Meta ends the free service tier — in which case fall back permanently to
board-issued one-time login links, which cost nothing and need no vendor at all.

## ADR-010 — Authorization in a single data-access layer instead of Postgres RLS
**Date:** 2026-08-03 · **Status:** accepted · **Supersedes ADR-007**
**Context:** ADR-007 required RLS because Supabase exposes a public data API that can be called
directly, making application checks bypassable. **D1 has no public data API** — the only route to the
database is our own Worker code. The threat model changed, so the control must change with it.
**Decision:** All SQL lives in `lib/db/`, enforced by a lint rule. Every function there takes an
`AuthContext` as a required argument, so a missing identity is a compile error. Ownership predicates
are baked into the query strings themselves, never appended by callers. R2 is private and served only
through a route that re-checks ownership per request. The CP-1 gate becomes HTTP-level access tests
executed as each role.
**Alternatives rejected:** Neon + Postgres RLS — genuinely safer (RLS fails *closed*; forgotten
application checks fail *open*), but adds a second vendor, a network hop, and a 0.5 GB ceiling.
Kept as documented Plan B.
**Consequences:** The safety now depends on discipline rather than on the database. That discipline is
purchased by three structural rules — one SQL location, a required identity argument, and predicates
inside the query strings — plus the access test suite. **If that discipline ever slips, switch to Neon.**
**Revisit if:** an access test ever fails in review, or a second developer joins the project.

## ADR-011 — Passkeys (WebAuthn) as the primary login; messaging only for activation
**Date:** 2026-08-03 · **Status:** accepted · **Supersedes the login half of ADR-009**
**Context:** ADR-009 made login free by reversing the message direction. Free, but still dependent on
Meta continuing a free tier, on business verification, and on the resident having WhatsApp. A review
of an independently written specification for this same project proposed WebAuthn passkeys instead.
It is right, and for a better reason than cost.
**Decision:** Passkeys are the primary authentication for **all** roles after first activation —
"الدخول ببصمة أو قفل الموبايل". The inbound-WhatsApp flow from ADR-009 is retained for **first
activation and recovery only**. Board-issued one-time links remain the vendor-free fallback.
**Alternatives rejected:** Inbound WhatsApp on every login (ADR-009 alone) — free today, but a
permanent third-party dependency for something as fundamental as opening the front door. Offline
printed activation codes as the *only* activation path (the reviewed spec's default) — secure, but it
means physically delivering paper to 214 flats; the free inbound-WhatsApp channel does the same job
remotely at zero cost.
**Consequences:** Zero marginal cost, zero vendor, zero quota, and phishing resistance — passkeys are
the one component no pricing change can take away. Meta usage drops from ~214/month to ~250 in the
first year total. Account takeover gets structurally harder (a phone change alone no longer opens the
account). **Cost:** WebAuthn is bound to the relying-party domain, so moving off `*.pages.dev` later
requires re-enrolling every passkey while the old domain still resolves — decide the domain before
enrolling resident #1. Older devices need the WhatsApp fallback. Recovery becomes device-loss rather
than SIM-loss, needing a second passkey, printed recovery codes, and two-admin assisted recovery.
**Revisit if:** measured passkey support among residents' actual devices proves too low at pilot.

## ADR-012 — Phone number is a login identifier, never a key
**Date:** 2026-08-03 · **Status:** accepted · **Corrects the original data model**
**Context:** The pack described the phone number as "the account's primary key from the user's point
of view" and put a `UNIQUE` phone column on `profiles`. Even with a separate UUID, that shape invites
foreign keys and lookups against a **mutable** attribute. Owners change numbers, lose SIMs, transfer
ownership, and die; two records can collide on one number.
**Decision:** Each person has an immutable internal `id`. Phone numbers live in `phone_identifiers`
with status, verification, effective dates, a `replaced_by` chain, and the admin who changed them. A
partial unique index enforces one *active* owner per number while preserving history forever. Nothing
may foreign-key to a phone number.
**Alternatives rejected:** Keeping `phone_e164 UNIQUE` on `profiles` — simpler until the first number
change, then unrecoverable once money is posted against it.
**Consequences:** One extra join on login. In exchange, phone changes, ownership transfers, and
disputes become ordinary operations with a full audit trail instead of data surgery.
**Revisit if:** never.

## ADR-013 — Double-entry ledger instead of a cash tally
**Date:** 2026-08-03 · **Status:** accepted · **Extends ADR-006**
**Context:** The pack computed `treasury = Σ approved payments − Σ expenses`. That cannot answer
"where did the الوديعة go?" or reconcile against a bank statement, and — most dangerously — it books
deposits and overpayments as income, overstating the village's spendable balance by the entire
deposit pool.
**Decision:** A minimal double-entry ledger: `journal_entries` + `journal_lines`, a small chart of
accounts, funds and cost centers as dimensions, fiscal periods that close, and the nine-state payment
machine. الوديعة posts to a **liability**; an overpayment posts to a **resident credit liability**.
Full spec in `06_ACCOUNTING_AND_LEDGER.md`.
**Alternatives rejected:** Staying with the cash tally — simpler to build, indefensible at a general
assembly, and it silently misstates the balance. A full accounting package — far beyond what a
volunteer board can operate.
**Consequences:** More schema and more work in CP-5. In return, every number is traceable, the
accounting equation gives one test that catches most financial bugs, and the board can answer the
assembly's hardest question. **Requires a qualified accountant to approve the chart of accounts and
the deposit treatment before production** — that is now a launch blocker, not a nicety.
**Revisit if:** an accountant proposes a different but equally traceable treatment.

---

## ADR-014 — Free-tier re-verification, 2026-08-04
**Date:** 2026-08-04 · **Status:** accepted
**Context:** `<first_actions>` step 3 requires every free tier named in `05_ZERO_COST_ARCHITECTURE.md`
§1 to be re-verified against the vendor's own current page before anything is built. Free tiers
change and one (PlanetScale) already vanished.
**Decision:** All ten services re-checked against primary sources on 2026-08-04. Findings recorded in
`docs/RESEARCH_SOURCES.md` and `docs/QUOTA_AND_COST_REGISTER.md`. Two are material and get their own
ADRs (015, 016). Smaller corrections absorbed here:
- **Workers, Pages, D1 and KV all BLOCK rather than bill** when a free limit is hit, and need no card.
  A stronger guarantee than the pack claimed, and what makes them `STRICT_ZERO_COST`.
- **D1 free allows only 10 databases.** The "archive closed fiscal years into a second database" plan
  in §2a therefore has a ceiling of 9 archives. Fine for decades; worth knowing.
- **KV allows 1,000 writes/day** — 1% of D1's allowance and the tightest quota in the stack.
  Consequence recorded in ADR-017: sessions, rate limits and activation challenges live in D1.
- **Neon's free plan is always-on, not scale-to-zero** (the pack says otherwise). It still cannot
  bill — over-limit suspends compute until the next month — so Plan B remains valid.
**Alternatives rejected:** Trusting the figures in the pack. They were four days old and two were
already wrong; that is exactly why this step exists.
**Consequences:** The stack survives largely intact. Object storage and WhatsApp do not.
**Revisit if:** quarterly — next **2026-11-04** — and immediately before launch.

## ADR-015 — Object storage: R2 cannot satisfy C11 as written
**Date:** 2026-08-04 · **Status:** ~~accepted~~ **partly superseded by ADR-022** — the R2 half stands and is now confirmed by Cloudflare's own docs; the Google Drive half was built on a false assumption
**Context:** C11 states, without qualification: *"Never sign up for anything requiring a payment
method, even where 'you won't be charged.'"* Cloudflare **will not create an R2 bucket without a
payment method on file**, because R2 usage is uncapped and billed past the free allowance. This is a
separate and harder problem than the overage exposure already noted in `05` §2a: it blocks
*activation*, not just overage. Every other Cloudflare product in the stack blocks rather than bills
and needs no card — R2 is the sole exception.
**Decision (APPROVED by the owner, 2026-08-04):** Replace R2 with a **board-owned Google account used as
a private file store** behind `lib/storage/`. A consumer Google account has no billing path at all,
so it *cannot* charge — which is what C11 actually asks for. 15 GB, and the board owns the files
rather than the developer, which also helps R-008.
**Alternatives rejected:**
- *R2 with the board's card + a hard 7 GB app cap* — simpler and faster, and the cap is real, but it
  requires the owner to knowingly waive an absolute constraint. Offered as option (ب) in Q19; if
  chosen it becomes `FREE_TIER_WITH_BILLING_EXPOSURE` and needs written acceptance.
- *Backblaze B2* — 10 GB free and S3-compatible, so the adapter would be nearly identical to R2's.
  But it also bills on overage, and whether signup needs a card is **unverified** (A-09).
- *Image bytes in D1* — explicitly banned by `05` §2a, and 500 MB/database makes it impossible
  anyway at ~2.5 GB/year.
- *Telegram as a file store* — free and cardless, but files are retrievable by anyone holding the bot
  token and file id. Unacceptable for private financial receipts.
**Consequences:** Slower uploads, and OAuth/service-account key custody becomes a real operational
burden. Mitigated by everything sitting behind `lib/storage/` — the choice is one adapter file.
**⚠️ Unvalidated:** A-07 — that a Google service account can serve this role with no billing path
must be proven before CP-4, not assumed.
**Revisit if:** Cloudflare removes the card requirement, or the board accepts option (ب) in writing.

## ADR-016 — WhatsApp Cloud API drops out of v1
**Date:** 2026-08-04 · **Status:** **accepted** — owner approved Q20 on 2026-08-04 ·
**Supersedes the delivery mechanism in ADR-009**
**Context:** ADR-009 and `05` §3.1 rest on *"1,000 free service conversations per month,
customer-initiated."* Verified against Meta's own pricing documentation on 2026-08-04, that model is
**two revisions out of date**: conversation pricing ended 2025-07-01; non-template messages have been
free with **no** monthly cap since 2024-11-01; and Meta's page states **"Pricing updates for Meta
Business Agent, service, and utility messages will launch on August 1, 2026 and October 1, 2026."**
From **2026-10-01** service messages are billed per message at the country's utility/authentication
rate, with no free allowance. That is eight weeks away.
**Decision (APPROVED by the owner, 2026-08-04):** Remove the WhatsApp Cloud API integration from v1.
**Board-issued one-time activation links become the primary activation path** — already specified as
fallback (1) in `05` §3 and already the intended onboarding route for the first 20 residents. The
WhatsApp adapter stays behind `lib/auth/channel.ts`, disabled.
**Alternatives rejected:**
- *Keep the inbound flow but never reply on WhatsApp.* Technically sound — Meta bills the business
  for messages it **sends**, and inbound messages from a resident stay free, so a webhook that
  verifies silently while the browser page (already polling) shows the confirmation would still cost
  nothing. Rejected as the **default** because it keeps Meta business verification on the critical
  path for a benefit ADR-011 already reduced to one use per resident, ever. Kept documented as the
  design to use if the owner wants WhatsApp back.
- *Absorb the cost.* ~214 activations × ~$0.0073 ≈ $1.56 once. Trivial in money and fatal to C11 as a
  principle: the moment a bill exists, someone must own a payment method forever.
**Consequences:** One fewer vendor, one fewer quota, and **R-004 (Meta verification delays CP-2) and
R-017 (Meta ends the free tier) both close**. The cost is a board member's minute per resident during
onboarding — which the pack already assumed for the pilot group.
**Revisit if:** Meta reinstates a free service allowance, or activation volume grows past what a
board member can send by hand.

## ADR-017 — SQLite/D1 port decisions
**Date:** 2026-08-04 · **Status:** accepted
**Context:** `<first_actions>` step 4. Porting `02_DATA_MODEL.md` from Postgres to D1 forced five
choices the mechanical type mapping does not cover.
**Decision:**
1. **Every table is `STRICT`.** SQLite's default type affinity would silently accept `12.5` into an
   INTEGER piastres column. STRICT makes it an error, turning C4 from a code convention into a
   storage-layer guarantee. Verified locally: *"cannot store REAL value in INTEGER column."*
2. **`numeric` columns become scaled INTEGERs, not REAL.** `unit_owners.ownership_share
   numeric(5,4)` → `share_bp` (basis points); `units.area_sqm numeric(8,2)` → `area_cm2`. A naive
   port makes both REAL, and since both multiply into money, C4 would be violated *indirectly* —
   through an ownership split or a per-sqm due. This is the kind of C4 violation that does not look
   like money.
3. **`profiles.phone_e164` is dropped entirely.** `02_DATA_MODEL.md` retained it "as a denormalized
   cache of the current primary number." A cache of a security-relevant identifier is a second source
   of truth that will drift, and drift here means a login resolving to the wrong person. The current
   number is a one-row indexed lookup. C1b is better served by the column not existing.
4. **Sessions, rate limits and activation challenges live in D1, not KV.** KV allows 1,000 writes/day
   (ADR-014); D1 allows 100,000. Anything an unauthenticated caller can trigger a write to must never
   touch KV, or one attacker exhausts the day's budget and login stops working.
5. **Every category maps to exactly one ledger account, constrained by kind.** A category of
   `kind='deposit'` cannot reference an account of `type='income'` — a trigger refuses the insert
   *and* the update. This makes R-020 structurally impossible rather than merely tested.
**Alternatives rejected:** Mechanical type mapping with the invariants left to application code and
tests. A test tells you an error happened; a constraint stops it happening. The financial layer is
where that difference is worth the extra schema.
**Consequences:** If D1 rejects `STRICT` or trigger `RAISE(ABORT)` (A-05, undocumented either way),
the fallback is to strip `, STRICT` from each CREATE TABLE — nothing else depends on it — and move
the trigger logic into `lib/db/`, which is strictly weaker. **Verify on the first real
`wrangler d1 migrations apply`; it is a CP-1 gate.**

## ADR-018 — The accounting equation is kept, but demoted
**Date:** 2026-08-04 · **Status:** accepted · **Corrects `06_ACCOUNTING_AND_LEDGER.md` §9**
**Context:** `06` §9 calls invariant 12 — `assets = liabilities + funds + (income − expenses)` —
"one test that catches more bugs than the other eleven combined", and `00_MASTER_PROMPT`
`<verification_protocol>` repeats it. Building the fixture showed that is not true, and believing it
is dangerous.
**Decision:** Keep the invariant and its test, but stop treating it as the primary defence against
R-020. Under balanced double-entry the identity is a **tautology**: because every posted entry
satisfies `SUM(debit) = SUM(credit)`, the residual is necessarily zero *regardless of whether
الوديعة was booked to a liability or to income.* Demonstrated in `tests/fixtures/verify_ledger.py`
§8 — a ledger with the deposit deliberately misbooked still shows `residual = 0`, while the spendable
balance is overstated by exactly the 5,000 ج.م deposit (14,800.00 shown vs 9,800.00 true).
What actually catches R-020 is (a) the category→account kind constraint, (b) the `v_deposit_leakage`
view, and (c) the operating/deposit **fund split** that keeps "الفلوس المتاحة للصرف" honest.
**Alternatives rejected:** Silently keeping the claim. A non-technical owner reading "one test
catches most financial bugs" would reasonably conclude the deposit problem is covered. It is not.
**Consequences:** The honesty note lives in `migrations/0005_views.sql` beside the view, where the
next engineer will actually read it, and the CP-5 gate gains the deposit-leakage and fund-split
assertions alongside the equation.

---

## ADR-019 — Hand-authored CSS with logical properties instead of Tailwind
**Date:** 2026-08-04 · **Status:** accepted · **Deviates from `AGENTS.md`**
**Context:** `AGENTS.md` specifies "Tailwind logical properties only" with a lint rule banning the
physical variants. The *intent* of that line is RTL correctness enforced mechanically, and it is a
good rule. But this app is ~15 screens of forms and tables, server-rendered, with a hard performance
budget (≤120 KB on the home route, LCP ≤2.5 s on 3G, a five-year-old Android on a Matrouh
connection). A Tailwind build step buys utility-class consistency at the cost of a toolchain, and
buys nothing at this size that the budget does not have to pay for.
**Decision:** One hand-authored stylesheet in `src/views/layout.ts` (~4 KB), using **only** logical
properties, with `tools/lint-rtl.mjs` failing the build on any physical one. The lint rule also
matches Tailwind's physical class variants (`ml-`, `pr-`, `left-`), so it keeps working unchanged if
the project adopts Tailwind later.
**Alternatives rejected:**
- *Tailwind as written in AGENTS.md* — correct at larger scale; here it adds a build step, a config
  file and a purge step to save nothing measurable.
- *Silently deviating* — `<conflict_order>` says surface the collision rather than pick a winner.
  Hence this ADR rather than a quiet choice.
**Consequences:** No utility-class discipline enforcing spacing consistency, so the design tokens in
`:root` have to carry it. If the UI grows past ~30 screens, or a second developer joins, revisit —
that is exactly where hand-authored CSS starts to drift.
**Revisit if:** the screen count roughly doubles, or a second front-end developer joins.

---

## ADR-020 — Use `@simplewebauthn/server` rather than hand-rolling WebAuthn
**Date:** 2026-08-04 · **Status:** accepted
**Context:** Verifying a WebAuthn response means parsing CBOR, decoding a COSE key, hashing and
comparing the RP-ID, checking the UP/UV flag bits, and verifying an ECDSA or RSA signature. Every one
of those has a failure mode where the code still "works": the user touches the sensor, a session
opens, everybody is happy, and the security property is simply absent. Omit the `origin` check and
the whole thing is phishable. Omit the RP-ID hash and another site's credential is accepted. Omit the
UV flag and *"الدخول ببصمة"* becomes *"الدخول بأي حاجة"*. None of those produce a visible bug.
**Decision:** Use `@simplewebauthn/server` for the two verification ceremonies. It is maintained,
widely deployed, and built on WebCrypto so it runs on Workers. A library is not a vendor and costs
nothing, so C11 is untouched.
**Alternatives rejected:** Hand-rolling it to avoid a dependency. In a system that holds a village's
money, "we wrote our own crypto verification to keep the dependency count down" is the wrong trade,
and `<anti_patterns>`'s warning about familiar-looking wrong answers applies directly.
**Consequences:** One production dependency, and an upgrade to watch. What the library does NOT
decide stays ours and is tested in `tests/access/auth.test.ts`: the challenge is ours and single-use,
`userVerification: 'required'`, the sign counter is checked for clones, and login reveals nothing
about whether a phone number is registered.
**Revisit if:** the library is abandoned, or Workers gains a native WebAuthn primitive.

## ADR-021 — Object storage stays behind an interface until A-07 is proven
**Date:** 2026-08-04 · **Status:** accepted
**Context:** ADR-015 chose a board-owned Google account as the object store. Three things about that
are still unproven (A-07), and the third would quietly ruin the design: whether a service account can
be created without enabling GCP billing; whether Drive's per-minute write quotas tolerate our load;
and **whether files a service account creates can be owned by the board's account rather than
stranded in a service-account space nobody can reach later.**
**Decision:** The upload path is complete and tested against `StorageAdapter`, with `MemoryStorage`
as the implementation. `GoogleDriveStorage` exists with the correct shape and throws on every method.
Nothing about receipts depends on which adapter is behind the interface.
**Alternatives rejected:** Implementing Drive now on the assumption it works. If the ownership
question turns out badly, every receipt uploaded in the meantime would live somewhere the board
cannot reach — discovered at exactly the wrong moment.
**Consequences:** Receipts cannot be stored in production until A-07 is answered. That is a smaller
problem than storing them somewhere unrecoverable.
**Revisit if:** A-07 is validated, or the board accepts R2 with a card (Q19 option ب).

---

## ADR-022 — Object storage, corrected: Drive via a REAL account, not a service account
**Date:** 2026-08-04 · **Status:** proposed — **needs one decision from the owner**
**Supersedes the Google-Drive half of ADR-015**

**Context.** The owner's instruction was *"شوف هتعرف تستخدم Cloudflare بشكل مجاني، لو لا استخدم
الدرايف"*. Answering it properly falsified **both** halves of the previous plan.

**1. Cloudflare R2 requires a payment method — now confirmed by Cloudflare, not by a forum post.**
Their own R2 documentation states you need *"a Cloudflare account with an R2 subscription"* and must
*"complete the checkout flow to add an R2 subscription to your account"* — a prerequisite even for the
free tier. Cloudflare staff separately confirm that adding a payment method triggers a **$5 temporary
authorization hold** on the card. Against C11 — *"never sign up for anything requiring a payment
method, even where you won't be charged"* — that is disqualifying, and the evidence is now
first-party rather than anecdotal. Every OTHER Cloudflare service we use (Workers, Pages, D1, KV)
needs no card and **blocks** rather than bills. **Cloudflare stays. R2 does not.**

**2. ⚠️ A-07 IS FALSIFIED. A Google service account cannot store files in Drive at all.**
Service accounts have **no Drive storage quota of their own** and return
`403 storageQuotaExceeded` on upload — even into a shared folder, even when the account is completely
empty. The documented workarounds (a Workspace shared drive, or domain-wide delegation impersonating
a real user) both require a **paid** Google Workspace subscription. So the option approved in Q19
would not have worked, and the failure would have surfaced at the first real receipt upload.

**This is exactly what ADR-021 was written to prevent.** The Drive adapter deliberately threw on
every method instead of being implemented on the assumption it worked, so nothing was built on top
of it and no receipt was ever written somewhere unrecoverable.

**Decision (recommended, pending the owner's answer):** Use Google Drive through **OAuth as a real
board member's Google account**, not a service account. Files are then owned by an actual person's
account and draw on its ordinary 15 GB. No card, no billing path, no Workspace subscription, and the
board genuinely owns the files because it is genuinely their account.
**Alternatives, with what each costs:**
- *Backblaze B2, private bucket* — 10 GB free, S3-compatible, and `lib/storage/s3.ts` already speaks
  to it with a signature verified against AWS's published test vector. Backblaze's docs require
  payment details for **public** buckets; ours must be private anyway (C6), so this may well be
  cardless — **but that is unverified (A-09) and must be checked before adopting.** B2 does bill on
  overage, so it would need the same hard cap.
- *R2 with the board's card + the 7 GB app cap* — simplest technically, and the credentials already
  exist. Needs the owner's **written** acceptance that C11 is being waived.
- *Receipts in D1* — still impossible: 500 MB per database against ~2.5 GB/year.
**Consequences of the recommendation:** OAuth refresh-token custody becomes a real operational
burden — the token must be stored as a Worker secret, and if the board member revokes access or
deletes the account, uploads stop. That is an operational risk, not a financial one, and it is the
lesser problem.
**Revisit if:** B2's private-bucket signup proves cardless (then prefer it — the adapter is written
and tested), or the board accepts the card.

---

## ADR-023 — Receipt images live in D1, measured rather than assumed
**Date:** 2026-08-04 · **Status:** accepted · **Supersedes ADR-015 and ADR-022 on storage** ·
**Reverses `05_ZERO_COST_ARCHITECTURE.md` §2a's "never store image bytes in D1"**

**Context.** The owner's instruction: *"استخدم الـ Cloudflare database، لو مش متاح ده ملف درايف."*
The spec pack forbids exactly this — *"never store image bytes in D1. Only metadata and hashes."*
That rule was correct **given its stated input**: 500 KB per receipt × 5,000/year = 2.5 GB/year
against a 500 MB database. Hopeless.

**But the 500 KB was never measured.** It is the pack's *pre-upload* target for a raw phone photo,
not the size after client-side compression. Measured on 2026-08-04, WebP, against the two real
inputs — and deliberately including the WORST case, a resident photographing a printed paper slip
rather than screenshotting a bank app:

| setting | bank screenshot | **photographed paper** | per year @5,000 | years per 500 MB db |
|---|---|---|---|---|
| 1600px q82 *(what we shipped)* | 8 KB | **41 KB** | 199 MB | 2.5 |
| **1200px q60** *(now)* | 5 KB | **6 KB** | **27 MB** | **18** |

The constraint that made the rule true does not hold. It was off by 12–60×.

**Decision:** Store receipt bytes in D1, in a `receipt_blobs` table, in a **separate database** from
the ledger. The client compresses to 1200px/q60 before upload; anything over 256 KB is refused by
both the adapter and a CHECK constraint.

**Why this beats every alternative on the constraint that actually binds (C11):**
| option | card? | works? | vendors |
|---|---|---|---|
| **D1 blobs** | **no** | **yes, measured** | **none new** |
| Cloudflare R2 | **yes** + $5 hold | yes | none new |
| Drive via service account | no | **no** — `403 storageQuotaExceeded` (A-07 falsified) | 1 |
| Drive via a real account's OAuth | no | yes | 1, plus refresh-token custody |
| Backblaze B2 | unverified | yes | 1 |

D1 needs no card, no new vendor, no new quota to watch, no OAuth tokens to keep alive — and receipts
land inside the existing nightly backup automatically, so "the images were not in the backup" stops
being a way to lose them.

**Alternatives rejected:** the four rows above. The board-owned Drive folder the owner offered is
kept as the **backup** target, which is what Drive is genuinely good at (`05` §5) — see R-042 before
putting anything private in it.

**Consequences:**
- A real ceiling: 500 MB per database, ~18 years at measured rates, 10 databases on the free plan.
  `v_blob_usage` and `/admin/health` watch it; the switch condition is 70%.
- **Blobs MUST be bound as a separate D1 database in production.** If they share the ledger's
  database, the nightly dump carries every image and the CP-8 restore drill becomes slow enough that
  people stop running it — which is how a backup quietly stops being one.
- Deleting an archived image never touches financial history: the payment, its journal entry and its
  audit trail are in the other database and are append-only.
**Revisit if:** measured sizes at pilot exceed ~50 KB, or a database passes 350 MB.

---

## ADR-024 — Two-person rules live in the schema, never in application code

**Date:** 2026-08-04 · **Status:** accepted · **Grounding:** *engineering inference* from a
*confirmed requirement* (`03_RBAC_AND_AUTH.md` §6, C8)

**Context.** Assisted recovery — for the resident who lost the phone *and* the printed codes — hands
someone an account with no cryptographic proof of anything. `03_RBAC §6` requires **two different
admins**, with identity established offline first. It is the most abuse-prone path in the system and
the most likely real-world lockout, so it is both necessary and dangerous.

The obvious implementation is `if (approvedBy === requestedBy) throw new Forbidden(...)` inside
`approveRecovery`.

**Decision.** The two-person rule is a **database `CHECK` constraint**:

```sql
CHECK (approved_by IS NULL OR approved_by <> requested_by),   -- the second admin is never the first
CHECK (target_profile_id <> requested_by),                    -- nobody recovers their own account
CHECK (approved_by IS NULL OR target_profile_id <> approved_by),
CHECK (fulfilled_at IS NULL OR approved_by IS NOT NULL)       -- unapproved is unfulfillable
```

plus `trg_recovery_immutable`, which refuses any update to a request that is already fulfilled or
cancelled. The application-layer checks stay, because they produce a decent Arabic error instead of a
constraint violation — but they are the *message*, not the *control*.

**Why.** A TypeScript guard protects exactly the code path it sits in. It is one refactor, one
missing `await`, one new admin route, or one direct-console fix at 2 a.m. away from being gone — and
its absence is silent, because the happy path looks identical either way. A `CHECK` is enforced by
the storage engine for every writer that will ever exist, including ones nobody has written yet.

This is not a new principle here, it is the *same* one already carrying maker–checker
(`trg_entry_maker_checker`), the append-only ledger (`trg_line_no_update` / `trg_line_no_delete`) and
the deposit→liability mapping (`trg_category_account_kind_ins`). ADR-024 states it as a rule so it is
applied deliberately rather than rediscovered: **if a control must hold, it belongs in the schema.**

**How it is proven.** `tests/access/onboarding.test.ts` asserts the constraint by calling the
database **directly**, with every `lib/db/` guard bypassed. Testing that the code checks is not the
same as testing that the rule holds; only the second one survives a refactor.

**Consequences.**
- A recovery cannot be completed by one person even if `lib/db/onboarding.ts` is deleted entirely.
- Errors surface as `LedgerRefused` → HTTP 409 with the Arabic reason, via `asRefusal()`.
- **Depends on A-05:** if D1 turns out not to honour `CHECK`/`RAISE(ABORT)`, this control and several
  financial ones degrade to application code at once. That is why `tools/verify-d1.sh` is the
  project's oldest open item.
- Cost: the rule is expressed twice, and a change must be made in both places. Accepted — the
  duplication is visible and the constraint is authoritative.

**Revisit if:** D1 rejects table-level `CHECK` constraints (A-05), or the board asks for a
single-admin recovery path — which should be refused, and this ADR is the reason why.

---

## ADR-025 — Reporting views are a separate correctness surface from the ledger

**Date:** 2026-08-04 · **Status:** accepted · **Grounding:** *engineering inference* forced by a
real defect (R-043)

**Context.** `v_unit_balance` subtracted every approved payment from dues in published fee periods.
A flat that paid its 5,000 ج.م الوديعة and nothing toward its 6,000 ج.م subscription reported
**1,000 ج.م outstanding instead of 6,000**, and `v_community_totals.receivables_piastres` — the
متأخرات figure on `/finance` — inherited it, understating arrears by the whole deposit pool.

Every existing defence passed. The deposit was booked to a liability account, in the deposit fund,
through a category whose `kind` `trg_category_account_kind_ins` verified. `v_deposit_leakage` was
empty. The accounting equation balanced (ADR-018 said it would). All twelve `06 §9` invariants held.
**The ledger was right. The report was wrong.**

**Decision.** Treat reporting views as a correctness surface in their own right, with three rules:

1. **Both sides of a subtraction must measure the same thing, and the column names must say so.**
   `due_piastres` counts dues from published fee periods, so `paid_piastres` now counts only
   payments allocated to a published fee period. Everything received — deposits included — is a
   separate column, `received_piastres`.
2. **A quantity used for two different questions gets two different columns.** "Did every approved
   payment reach the ledger?" (reconciliation → `received_piastres`) and "did this flat pay its
   subscription?" (arrears → `paid_piastres`) were one column, and that identity *was* the bug.
3. **Every headline figure needs one test that reads the rendered page** and compares it against a
   literal computed by hand — not against another query. This defect survived four test suites and
   246 passing checks because every financial test compared one query to another query.

**Consequences.**
- `migrations/0011_arrears_fix.sql` recreates the view, adds `trg_deposit_has_no_fee_period_*` so
  the class is unrepresentable rather than merely fixed, and adds `v_unallocated_payments` to catch
  the mirror-image error — a subscription approved with no fee period, which would mark a resident
  who *paid* as owing.
- `tests/access/transparency.test.ts` is the pattern for CP-3 onward: parse the HTML, assert against
  hand-computed literals, scope each assertion to its element.
- `verify_demo.py` gained two invariants: Σ per-unit deposits == the 2101 account balance, and no
  flat's arrears is reduced by its deposit.
- **Cost:** `v_unit_balance` is wider and the two "paid" columns can be confused by a future reader.
  Mitigated by comments in the migration that name the bug rather than describe the code.

**Revisit if:** the accountant (Q15) moves the project from modified-cash to full accrual, at which
point arrears comes from account 13xx and `unit_dues` stops being the source of truth. The
same-units-on-both-sides rule survives that change; the specific columns do not.

---

## ADR-026 — Expense invoices are visible to members, with a switch the board owns

**Date:** 2026-08-05 · **Status:** accepted · **Grounding:** *confirmed requirement*
(`01_PRD` C1, C2) in tension with a *verified external fact* (PDPL 151/2020)

**Context.** `01_PRD` C1 asks for an invoice photo on an expense and C2 makes expenses "visible to
all members". Evidence is the entire reason to attach a photo: a 12,000 ج.م maintenance line without
one is exactly the suspicion this project exists to answer.

But a supplier's invoice usually carries the **supplier's phone number and bank details**. Publishing
that to 204 residents is the personal data of a third party who never consented, and PDPL 151/2020
does not have a "but transparency" exception. The requirement and the law point in opposite
directions, and neither can simply win.

**Decision.** Three layers, in order of how much they actually help:

1. **Tell the person holding the camera, before they take the photo.** The upload screen says the
   image will be seen by every resident and to cover the supplier's number with a finger. This is
   the cheapest and by far the most effective control — the data never enters the system.
2. **Visible to members by default** (`expense_invoices_public = 1`). A default that hid evidence
   would quietly undo the feature, and the board would not notice.
3. **A setting, not a constant.** If a supplier objects, or the board decides otherwise, they close
   it without a deploy. Admins always retain access, because they countersign against this evidence.

**Alternatives rejected.**
- *Admin-only by default* — safest for the supplier, and it makes the photo pointless. The resident
  who doubts the 12,000 ج.م is the reader this feature has.
- *Automatic redaction* — no. Reliable text detection on a photographed Arabic invoice is not
  something this project can do, and a redaction that misses once is worse than none, because
  everyone stops looking.
- *Never store invoices at all* — leaves C1 unbuilt and the suspicion unanswered.

**Consequences.**
- A supplier's details may reach 204 residents if an operator forgets. Recorded as a risk, mitigated
  by the warning, and reversible per-invoice only by deleting and re-uploading.
- The board must be told this exists before launch — it belongs in the CP-8 Arabic manual, and it is
  not there yet.
- `v_expenses_without_evidence` reports how much posted spending has no photo, so the board learns
  the number before a resident asks it at the general assembly.

**Revisit if:** a supplier objects in writing (flip the setting and record why), or the board's
lawyer reads PDPL differently — in which case the default moves and the ADR is superseded, not
edited.

---

## ADR-0NN — <next decision>
*(agent: append here — never edit an accepted ADR; supersede it instead)*
