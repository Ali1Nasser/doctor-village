# CHECKPOINTS — the agent's authoritative work plan

**Rule:** never begin CP-N+1 while any gate of CP-N is unmet. A gate is met only when its test
**runs and passes**, not when the code "looks right." Tick boxes only after verification.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done & verified · `[!]` blocked (see RISKS.md)

---

## CP-0 — Discovery & contracts
*Goal: know exactly what we are building before writing a line of app code.*

- [x] Read `01_PRD.md`, `02_DATA_MODEL.md`, `03_RBAC_AND_AUTH.md`, `04_UX_SPEC.md`, `05_ZERO_COST_ARCHITECTURE.md`, `06_ACCOUNTING_AND_LEDGER.md`
- [x] **Re-verify every free tier** against each vendor's own pricing page; findings + date recorded
      in ADR-014, `docs/RESEARCH_SOURCES.md`, `docs/QUOTA_AND_COST_REGISTER.md` *(2026-08-04 — two
      material findings: ADR-015 R2 card requirement, ADR-016 WhatsApp billing from 2026-10-01)*
- [x] Port the Postgres schema to SQLite/D1 (money stays an integer) — `migrations/0001`–`0005`,
      43 tables / 12 views / 19 triggers, verified on SQLite 3.45.1
- [x] ~~Start the WhatsApp Cloud API business verification~~ — **cancelled.** Owner approved Q20
      on 2026-08-04; ADR-016 removes the Meta dependency from v1 entirely. The longest-lead-time
      task in the project is gone, and R-004 and R-017 close with it.
- [x] Write `docs/OPEN_QUESTIONS.md` — 22 questions, each with a one-word-approvable default
- [ ] Get owner answers to Q1 (buildings/units), Q2 (subscription amount), Q4 (staff names visibility)
- [x] **Owner answered Q19 and Q20 on 2026-08-04** — board-owned Google file store (ADR-015),
      WhatsApp dropped (ADR-016). Procurement is unblocked; accounts must be created board-owned.
- [ ] Finalize the category taxonomy with the owner *(drafted: `seed/prod/002_categories.sql`)*
- [x] Write `types/domain.ts` — every entity as a TypeScript type; `tsc --strict` clean
- [x] Scaffold the **Hono/Workers** project, RTL config, `messages/ar.json` (every string, no
      hardcoded Arabic in any component). CSS is hand-authored with logical properties rather than
      Tailwind — **ADR-019**, a recorded deviation from `AGENTS.md`, not a silent one
- [ ] Set up the **Cloudflare** account, board-owned, env handling, CI
      *(corrected 2026-08-04: this line said "Supabase" — superseded by ADR-008)*

**Gates**
- [ ] `npm run dev` serves a RTL Arabic page with the correct font at 17px body text
- [x] `npm run typecheck` and the lint rule banning `ml-`/`mr-` both pass — `tools/lint-rtl.mjs`,
      watched failing against a deliberate `margin-left` before being trusted
- [ ] The owner has approved the category taxonomy in writing
- [x] The schema applies, and every financial guard was watched **failing** before being trusted
      — `python3 tests/fixtures/verify_ledger.py` → 48/48 on SQLite 3.45.1

---

## CP-1 — Data foundation & security
*Goal: the database is correct and safe before anything touches it.*

- [x] Migration: enums, buildings, units, profiles, **phone_identifiers**, **passkeys**, **activation_challenges**
- [x] Migration: unit_owners (effective-dated), **delegate_authorizations**, categories
- [x] Migration: **accounts, funds, cost_centers, fiscal_periods, journal_entries, journal_lines, resident_credits**
- [x] Migration: fee_periods, unit_dues, payments (nine states), expenses, staff, reconciliations
- [x] Migration: posts, albums, album_photos, notifications, otp_challenges, audit_log, settings
- [x] Views: `v_community_totals`, `v_expense_by_category`, `v_unit_balance`, `v_my_payments`
- [x] ~~RLS policies~~ — superseded by ADR-010. Replaced by `lib/db/` with ownership predicates
      inside the query strings, the no-SQL-outside-lib/db lint rule, and the HTTP access-test gate
- [x] Audit-log writes on every mutating path — `mutate()` runs the write and its audit row in
      ONE batch, so an unaudited mutation cannot commit. 10 mutating functions, each with a
      coverage test; `MUTATING_FUNCTIONS` is enumerated so adding one without a test fails
- [x] Phone normalisation — `lib/phone.ts` at the boundary + a `GLOB` CHECK in the schema that
      REFUSES a non-E.164 number rather than silently normalising it wrongly
- [x] `lib/money.ts` with its full unit-test suite — 69 tests passing, incl. all 12 edge cases from
      `02_DATA_MODEL.md` §7. Plus `lib/phone.ts` (E.164, all five Egyptian shapes, Arabic digits)
- [x] Seed script — far beyond the original scope: `seed/demo/generate.py` builds 34 buildings,
      204 units, 205 people, 243 receipts across all nine states, 250 journal entries, 30 expenses,
      deposits, overpayments, waivers, a reversal and a delegate authorisation. Deterministic
- [x] **C10 enforcement:** `migrations/0006_environment_guard.sql` makes demo data structurally
      impossible to insert into a production database, verified in both directions

**Gates**
- [x] ⭐ **CLOSED 2026-08-07 by deploying.** All 22 migrations apply on real D1 — 65 tables,
      64 triggers, 25 views — and D1 accepts both `STRICT` and `RAISE(ABORT)`. A-05 / R-031 are
      closed. It also found what 519 local checks could not: a 13-character-class `GLOB` in the
      phone CHECK that real D1 refuses with "LIKE or GLOB pattern too complex". The table CREATED
      fine; the failure appeared only on the first INSERT. Measured: 10 classes pass, 13 do not.
      *(historic gate text: `wrangler d1 migrations apply` succeeds against a real D1 database, and
      D1 accepts `STRICT` tables and `RAISE(ABORT)` inside triggers.)*
      Cloudflare documents neither; the whole financial-integrity layer rests on both (A-05, R-031).
      If it fails: strip `, STRICT`, move trigger logic into `lib/db/`, and **immediately re-raise
      R-020** — that fallback is strictly weaker.
- [x] All **15** access tests from `02_DATA_MODEL.md` §6, run **over HTTP as each role**, pass
      — `npm run test:access` → 20/20 (the 15, plus maker–checker, idempotency, staff-name
      visibility, and the refusal-mapping regression guard)
- [x] A phone number can be changed without touching the person's units or ledger history
- [x] An expired delegate authorization grants nothing, proven by a **clock-advance** test
      — access test 12 moves the clock one day past `valid_to`; access ends with no cleanup job
- [~] Each access test was watched **failing** against a deliberately loosened guard.
      **Deliberate deviation:** a "loose mode" flag would put a switch that disables security into
      production code — worse than the assurance is worth. Instead every leak test calls
      `proveReachable(...)`, which runs the same lookup *without* its ownership predicate and asserts
      the neighbour's row DOES come back. A green test therefore measures the predicate, not an empty
      table. The two ledger triggers WERE watched failing directly, in `verify_ledger.py`.
- [x] A lint rule proves no SQL exists outside `lib/db/` — `npm run lint` — and no data-access
      function can be called without an identity: `ctx: AuthContext` is the first parameter of every
      exported function, so omitting it is a compile error, not a runtime surprise
- [x] `lib/money.ts` passes all edge cases incl. Arabic-Indic digits and malformed input
      — `npm run test:unit` → 69/69
- [x] All twelve ledger invariants from `06 §9` hold across the full village, each headline figure
      computed two independent ways — `npm run verify:demo` → 30/30
- [~] `npm run verify` runs in CI and blocks merge on failure — **`.github/workflows/verify.yml`
      is written and ready**, including a credential scan (R-039) and the demo-guard check (C10).
      It has **never executed**, because the repository has never been pushed anywhere. The config
      half is done; the gate stays open until a run is green.

---

## CP-2 — Authentication
*Goal: every role can log in with a phone number, and nobody else can.*

- [x] **WebAuthn passkey enrollment, authentication, listing, labelling, and revocation** —
      enrollment + authentication + clone detection done and tested; the credential carries
      `device_label_ar` at enrollment, and **`/me` lists a person's enrolled devices and revokes
      one** (2026-08-08). Revoking the last device is allowed and its cost is stated: silently
      refusing leaves somebody who believes their account is compromised with no way to close it.
- [x] `lib/auth/channel.ts` + `ConsoleChannel` — plus `BoardLinkChannel` (now PRIMARY per
      ADR-016) and `PrintedCodeChannel`. `WhatsAppInboundChannel` present but **disabled**
- [x] First-activation flow: ~~inbound WhatsApp token~~ **board-issued link** (ADR-016) → verify
      → **enroll passkey** → issue printed recovery codes
- [x] Printed single-use recovery codes; two-admin assisted recovery —
      `migrations/0010`, `lib/db/onboarding.ts`, 21 tests in `tests/access/onboarding.test.ts`.
      The two-admin rule is a `CHECK` constraint, not application code. **`/admin/recoveries` is
      the screen** (2026-08-08); before it the flow was JSON-only, which meant a procedure the
      board could not run. `tests/access/onboarding_ui.test.ts` drives it as forms and proves one
      admin cannot finish alone and that the lost phone's session dies.
- [x] **Owner-register import from a screen** — `/admin/import` (2026-08-08). Upload or paste,
      preview that creates nothing, then a separate confirm. Same tests, same file.
- [x] **Accounts created and edited from the product** (2026-08-08). `/admin/users` creates one
      account (name, login number, role, optional flat), corrects a name, and moves a flat —
      closing the previous ownership row rather than overwriting it. Creating an account mints no
      credential; activation stays a separate audited act.
- [x] **Self-service profile** — `/me` lets the account holder change a second contact number,
      their preferred channel and one note, and states plainly which fields only the board can
      change and why. `updateOwnProfile` takes no target id and its SQL names three columns, so
      the wall is structural rather than checked; `tests/access/accounts.test.ts` attacks it
      through the form.
- [x] **A second and a third way in, for phones that cannot hold a passkey** (2026-08-08,
      migration `0026`). `AGENTS.md` bans password auth; the owner overrode it on the record
      after R-107 proved a phone with no platform authenticator cannot enrol at all. It is built
      as explicitly *second*: no password exists until an admin issues one on `/admin/members`,
      the board never chooses it and can never see it twice (PBKDF2-SHA256, 210,000 iterations,
      cost stored per row), five guesses per 15 minutes per IP **and** per number, a wrong
      password and an unknown number answer identically, and two triggers delete it when the
      account is stopped or a recovery is fulfilled. Recovery codes are now reprintable from
      `/me` — before this they existed only at activation, so the «ادخل بكود» box on the login
      screen was addressed to a person who could not exist. 18 tests in
      `tests/access/password.test.ts`.
- [x] Login UI per `04_UX_SPEC.md` §3 — "الدخول ببصمة أو قفل الموبايل" (screen renders; the
      WebAuthn call behind the button is still to come)
- [x] Session middleware, route guards, `lib/rbac.ts` as the single source of permission truth
- [x] Admin bulk import (Excel/CSV → preview → normalize → confirm → create) —
      `lib/import/owners.ts` (pure parser) + `stageImport`/`commitImport`. Header synonyms in
      Arabic and English, Arabic-Indic digits, bidi marks stripped, duplicates **flagged never
      merged**. CSV/TSV/semicolon only; `.xlsx` must be exported to CSV first.
- [x] ~~WhatsApp Cloud API provider + template~~ — **removed from v1 (ADR-016, owner approved Q20)**
- [x] ~~SMS fallback provider~~ — not needed; board links + printed codes cover every case free

**Gates**
- [ ] All four roles activate once, then log in **with a passkey** on a **real phone**
- [x] **Nobody is locked out by their hardware.** Three ways in, in order of preference:
      passkey, board-issued password, printed recovery code. Each is separately tested, and the
      weaker two are rate-limited harder than the strongest.
- [x] **The board-issued link works with WhatsApp switched off entirely** — it is off and
      always was; `enabledChannels()` returns board_link, printed, console
- [~] A replayed WebAuthn assertion is rejected; origin/RP-ID binding verified — **the
      challenge half is proven** (a challenge is single-use and expires; a stale one is refused;
      a rewound sign counter is treated as a clone). **The signature and origin/RP-ID half is
      not**: per ADR-020 that is `@simplewebauthn/server`'s job, and no test here has ever fed it
      a real assertion. Only a real phone against a deployed origin closes this.
- [x] **Losing one device does not let a single operator take over the account (two-admin
      recovery)** — proven four ways in `tests/access/onboarding.test.ts`: the requester cannot
      approve their own request (`CHECK` refuses it at the database), an admin cannot open a
      recovery for their own account, `fulfilRecovery` refuses an unapproved request, and a
      fulfilled request can never be replayed (`trg_recovery_immutable`)
- [~] Rate limits verified: ~~4th activation request in 15 min is refused~~; replayed tokens
      rejected. **Read this before ticking it.** The "4th activation request" number came from
      `03_RBAC §4`, where a *resident* requested an OTP. Under ADR-016 a resident never requests
      activation — a board member issues the link — so that counter has no caller. What exists
      and is tested: **login** 5/phone/15 min (6th refused), 20/IP/15 min; **recovery code**
      3/IP/15 min (4th refused); activation links **single-use, and issuing a new one kills the
      old one**. Unticked because the limits have only ever been exercised against the in-process
      SQLite driver, never a real deployment with a real `cf-connecting-ip`.
- [x] `rbac.ts` matrix and the `lib/db/` guards agree (automated test in tests/access)
- [x] **An unprovisioned number cannot obtain a session** — and, just as important, cannot tell
      it is unprovisioned: an unknown number gets a real challenge with an empty
      `allowCredentials`, the same response shape and no name, unit or phone in the body
      (4 tests in `tests/access/auth.test.ts`)
- [x] **Bulk import of 50 rows with 3 deliberately malformed rows behaves correctly** — the
      gate verbatim, in `tests/access/onboarding.test.ts`: 50 rows in, 3 malformed flagged with
      an Arabic instruction each, 47 created, **nothing created for a flagged row**, and the
      preview the admin actually saw stored on the batch

---

## CP-3 — Read-only transparency
*Goal: the numbers are visible and provably right, before anyone can change them.*

- [x] Home dashboard (resident view) — balance card, treasury summary
- [~] `/finance` — totals, treasury balance, expense-by-category chart. **No period filter yet**:
      there is one fiscal period, so the control would have one option. Needed before year two.
- [x] `/finance/units` — per-unit collection status table. Gated on `unit_status_public`
      (Q11 / R-002); aggregates only — no name, phone or receipt is in the SELECT list at all.
      An overpayment renders as **رصيد دائن**, never as a negative arrears figure.
- [x] "شوف الأرقام" table toggle — a `<details>` element, so it opens with **JavaScript off**,
      and a test asserts the table's numbers equal the chart's
- [x] `/admin/health` — usage against every free-tier limit, amber at 70% / red at 90%. Rows are
      marked **measured** or **declared**: a quota that cannot be read from inside a Worker
      (Workers requests, KV writes) renders as "—" and **never as 0%**, because a reassuring lie
      is the one failure mode this page cannot have
- [~] Empty/loading/error/offline states — components exist (`emptyState`, `errorState`,
      `loadingState`, offline banner) and empty states name the next action; not yet wired to
      every screen

**Gates**
- [x] **Against a fixed seed fixture, every displayed figure matches a hand-computed expected
      value** — `tests/access/transparency.test.ts`. The figures are parsed out of the **rendered
      HTML**, not the JSON, and compared against literals added up by hand; the fixture is twelve
      journal lines precisely so a human can check the arithmetic. It caught a **real financial
      bug on its first run** (R-043 / ADR-025): a flat's deposit was cancelling its subscription
      arrears, understating the headline متأخرات by the whole deposit pool.
- [x] **The same totals computed by raw SQL match the app's numbers exactly** — the second
      computation reads base tables (`journal_lines` ⋈ `accounts`), sharing no code with the
      views the app reads. Extended in session 11 to **every view**
      (`tests/access/views.test.ts`), which found four more defects of the same class —
      R-045…R-048 — including one in the "independent second opinion" that invariant 8 relies on.
- [x] **Bonus, not in the original gates:** `/finance` answers *"have we spent the residents'
      deposits?"* — a question this project could not previously ask, because the view that
      answers it was broken (R-049). Green banner when intact, red and quantified when short.
- [ ] Numbers render correctly LTR inside RTL text on a real phone (the `<bdi>` check)

---

## CP-4 — Payments
*Goal: money in, correctly, once.*

<!-- ⚠️ These six sat unticked until 2026-08-05 (session 25) while the code and tests
     existed. That drift is itself a defect: a plan file that disagrees with the
     repository stops being a map and becomes decoration. Recorded, not quietly fixed. -->
- [x] Upload flow — 5 steps, server-side draft keyed to the session, client-side compression
      (1200px/q60), retry. **Steps 1–3 and 5 need no JavaScript at all**; only the image does.
      Going back re-shows what was typed; `/pay` with no step resumes rather than restarting.
- [x] Storage — **not** a bucket and **not** signed URLs (ADR-023): receipts live in D1 as blobs,
      measured at 5–6 KB each, and are served only by `/api/files/*`, which re-checks ownership on
      **every** request. There are no public object URLs at all, which is stronger than signing.
- [x] Duplicate detection (hash + amount + date) — and it **warns, never blocks**: a genuine second
      transfer of the same amount on the same day is possible, and refusing it would send the
      resident back to WhatsApp convinced the site is broken.
- [x] `/payments` history — per-resident, own receipts only. **`/payments/[id]` detail does not
      exist as a page**; the API route does, and the list carries the reason inline.
- [x] `/admin/review` queue with approve / reject / needs-info / amount correction
- [x] Idempotent approval posting — a conditional `UPDATE`, never read-then-write
- [x] Reversal entries — `reversePayment` + **`/admin/payments`**: mirrors the original entry's
      lines whatever their shape, needs a **named second admin** chosen from a dropdown that never
      contains the caller, and the admin who *approved* the receipt is shown the reason instead of
      a button (R-062). 25 tests.
- [x] Notifications on decision — **every** decision (approve, adjusted approve, needs-info,
      reject, duplicate, reverse) writes the resident's message in the **same `db.batch()`** as the
      status change, so "decided but silent" is not a representable state. A duplicate is
      deliberately **not** announced as a rejection; an adjusted approval names both amounts and
      the reason; a rejection ends «الرفض ده مش نهائي». Deduplicated at the database
      (`ux_notif_payment_kind`), so a double-tapped approve sends one message.
      **⚠️ In-app only — there is no screen listing them yet, and nothing pushes them.**

**Gates**
- [~] Approving a receipt updates the resident balance **and** community totals by exactly that
      amount — the *totals* half is proven against hand-computed literals read out of the rendered
      page (`transparency.test.ts`), and reversal proves the arrears return. **No test asserts the
      before/after delta of a single approval**, which is what this gate literally says.
- [x] Rejecting or leaving pending changes **no** total, anywhere — `transparency.test.ts`:
      "the pending receipt contributes ZERO to every total (C5)", checked against spendable,
      income, held-in-trust and the unit's own arrears
- [x] Double-clicking approve posts exactly once — `access.test.ts` "approving twice posts once
      (invariant 3)", plus `notifications.test.ts` proving the second tap also sends no second
      message
- [x] A resident cannot approve their own payment via a direct API call — access test 3, over HTTP
- [!] A 12 MB photo uploads successfully after compression on a throttled 3G profile —
      **cannot be tested from here.** Needs a real phone on a real network; belongs to CP-7 with
      the observed-resident test and the D1 gate.
- [~] Killing the connection mid-upload loses no entered data — the **draft** half is proven
      (`auth.test.ts`: going back re-shows input, `/pay` resumes, one resident cannot read
      another's draft). The **mid-upload** half — a connection dying during the image POST — is
      untested and needs a real network.

---

## CP-5 — Expenses
*Goal: money out, categorized, transparent.*

- [x] Chart of accounts, funds, cost centers, fiscal periods, journal engine
- [x] Allocation rules — partial and overpayment→credit in `lib/db/index.ts`; waiver in
      `lib/db/fees.ts` (beside the amount, never instead of it); refund and reclassification in
      `lib/db/settlements.ts`; penalty as a category `kind`
- [x] Reconciliation against the bank statement — `reconciliation_adjustments` with its own
      maker–checker, `/admin/settlements`, and `as_of` as the freshness indicator
- [ ] Immutable monthly statement snapshots
- [~] Expense entry (operator, ≤ 60 seconds) — **`/admin/expenses` exists**: record, countersign,
      post and reverse, all plain form posts with **no JavaScript on the page**. Five fields,
      today's date pre-filled, entry form first (asserted by position). Only *spendable* funds are
      offered. **Invoice photo** is a second, optional step after saving (`.../invoice`), kept
      off the form so the form stays five fields with no JavaScript. **Still `[~]`:** the 60
      seconds is unmeasured — that needs a volunteer and a stairwell (CP-7).
- [x] Admin countersign for above-threshold expenses (maker–checker, second admin) — and
      **stronger than the plan**: `trg_entry_maker_checker` has no threshold, so the poster is
      never the recorder even on a 300 ج.م receipt. The threshold decides whether a
      countersignature is *recorded*; maker–checker decides whether two humans touched the money
- [x] Expense ledger view + **reversal** — `listPostedExpenses` (no vendor invoice key exposed);
      `requestExpenseReversal` → a **different** admin posts it through the same `postExpense`,
      which flips the entry direction and closes the original in one batch. The reversal is an
      ordinary expense row, so every guard protects it for free. The original is never edited —
      tests assert its amount and date are untouched, not just that the totals net.
- [x] Category management CRUD — **without** forced reassignment, deliberately. Reassigning a
      settled payment would make the receipt and `journal_lines` disagree about where the money
      went and would change last year's chart after the fact. Closed work never blocks a
      retirement; in-flight work does. Deviation recorded here rather than silently.
- [x] Staff & salaries — `/admin/staff`, gated on `staff.read_names` (residents hold
      `staff.read_salaries`, because the payroll TOTAL is published on purpose)

**Gates**
- [x] ⭐ **`v_deposit_leakage` is empty after every posting** — asserted after each posting in
      `tests/access/expenses.test.ts`, and widened by R-048 to catch a deposit credited to
      **anything that is not a liability**, not only to income
- [x] ⭐ **The operating/deposit fund split holds** — and the last clause of this gate ("assert the
      **displayed** figure against a hand computation") is honoured literally: the tile is parsed
      out of the rendered HTML. **Stronger than asked:** `trg_expense_fund_spendable_*` makes an
      expense against a non-spendable fund *impossible*, not merely visible (R-060).
- [x] `assets == liabilities + funds + (income − expenses)` — `verify_ledger.py`, residual exactly 0
      — ⚠️ **ADR-018: this is a tautology under balanced double-entry.** It catches half-posted
      entries and corrupted restores, **not** misclassification. It must never be the only check.
- [x] Every journal entry balances; an overpayment becomes a resident credit
- [~] A closed fiscal period rejects ordinary writes — tested at **posting** time
      (`trg_entry_period_open_at_posting`, the gap 0002's insert-time trigger left open).
      **Reopening's second-admin + re-auth flow is not built.**
- [x] `Σ per-category == total expenses` holds — after every posting, and R-047 made
      double-counting structurally impossible rather than accidentally absent
- [x] Deactivating a category is blocked by work IN FLIGHT — a receipt under review, an
      unposted expense, a live published subscription. Settled history does not block; see the
      deviation above.
- [x] An operator cannot approve a payment or read a phone number — re-verified in `board_config.test.ts`

---

## CP-6 — Content & memory
*Goal: nothing is ever lost in WhatsApp again.*

- [x] News / announcements / decisions with pinning and permanent archive
- [x] Maintenance albums with photos, dates, and links to the matching expense
- [x] Documents & meeting minutes archive (post types `minutes` / `document`)
- [x] Arabic full-text search across all of the above — `lib/search/fold.ts`
- [x] Fee periods & dues generation — `/admin/fees`: draft → distribute → publish, with
      `missing_units` on screen so a subscription that billed 180 of 204 flats cannot look like a
      success. Publication freezes the amounts in the schema (0022).

**Gates**
- [x] Searching an Arabic word from inside a PDF-attached post returns that post
      — `tests/access/content.test.ts`, asserted over HTTP as a resident
- [x] A 2-year-old announcement is reachable in ≤ 3 taps
      — أخبار → الأرشيف → السنة/الشهر → الخبر, all three asserted

---

## CP-7 — Notifications & polish
- [~] In-app notifications on approval and rejection — written in the SAME batch as the
      decision (R-065), plus Web Push. New-announcement and payment-reminder notifications are
      **not** built. WhatsApp is out of scope entirely (ADR-016).
- [x] Quiet hours honoured — Cairo wall-clock including DST, suppressing the PUSH only; the
      notification row is always written and always readable
- [x] Font-size toggle, dark mode — cookie + form POST, no JavaScript at all
- [x] Annual statement per unit (print-styled page → browser's own Save-as-PDF;
      a PDF engine is 2–8 MB inside a 10 ms Worker budget for an identical result)
- [ ] Every screen has all six states from `04_UX_SPEC.md` §5

**Gates**
- [ ] **One real elderly resident completes a payment unassisted**, observed
- [ ] Lighthouse: performance ≥ 90 on mobile, accessibility = 100
- [~] **WCAG 2.2 AA** — axe-core over all 33 rendered screens at 360px: **0 violations**
      (`npm run a11y`, wired into `verify`, watched failing against a deliberate contrast/alt
      probe before being trusted). It found and fixed a real one: `--warn` on `--warn-soft` at
      3.89:1 across nine screens, on the "these figures are invented" banner among others.
      Still `[~]` and not `[x]`: axe covers roughly a third of AA and cannot judge *Accessible
      Authentication* or whether a journey makes sense — the gate says the whole login and
      payment journeys, reviewed by a person, and that has not happened.
- [ ] Keyboard-only completion of the full payment flow; screen-reader semantics in Arabic
- [~] EXIF/geolocation stripped **on the server**, from bytes it actually parses —
      `lib/storage/image.ts`, WebP/JPEG/PNG, refusing anything else. It was previously stripped
      only in the browser while the database recorded `exif_stripped = 1` regardless. Still
      unticked because the gate says *verified on a real phone photo*, and it has been verified
      on synthesised containers and a Chromium-encoded WebP, not on a photo off somebody's
      Android.
- [ ] Every screen reviewed against the six-state checklist

---

## CP-9 — Village navigation (C13)
*Restored 2026-08-08. `07_VILLAGE_MAP_SPEC.md`, constraint C13 and product goal 4
were absent from the spec copy this project was built from — found by diffing the
uploaded packs against this repo, twenty-seven sessions in.*

- [x] `migrations/0023_village_map.sql` — `map_documents`, `building_map_features`,
      one published map at a time, coordinates normalised 0–10,000
- [x] `/map` — the plan with an SVG hotspot overlay AND an equal building list
      drawn from the register, so a building the drawing misses is still reachable
- [x] `/buildings/:id` — aggregate only; per-building payment figures stay behind
      `unit_status_public` (Q11) and render as "not published", never as zeros
- [x] `/admin/map` — link a hotspot to a real building, verify it with a name and
      a time, publish
- [x] The plan ships in the Worker bundle (`src/map-asset.ts`). D1 refuses a
      statement big enough to carry it — `SQLITE_TOOBIG`, found on the first real
      upload — and R2 needs a card (ADR-015, C11)

**Gates**
- [x] ⭐ **C13 holds at the database:** a hotspot for a building that is not in the
      register cannot be saved, and an unverified or unlinked one cannot be
      published — asserted with the data layer bypassed, and verified firing on
      real D1 on 2026-08-08
- [x] The map reveals no phone number, no owner name, no receipt, no private
      balance — asserted, not assumed
- [x] Every hotspot is reachable without the image: 48px targets, `<title>` on
      each SVG link, 0 axe violations at 360px
- [ ] The board verifies the real hotspot positions on the ground. The demo's
      coordinates were read off the photograph by eye and are marked verified
      ONLY in the demo database — `trg_no_demo_*` makes them impossible to load
      into production

---

## CP-8 — Hardening & handover
- [~] Security review — the adversarial passes done so far are recorded as R-072…R-079.
      This session closed the orphan-entry hole (0024) and the client-trusted EXIF claim;
      a full pass against 03 §5 by a second pair of eyes has still not happened
- [ ] Nightly D1 → R2 dump via Cron Trigger; weekly → private GitHub repo
- [ ] Monthly export to a **Google Drive folder owned by the board, not the developer**
- [ ] ⚠️ **Restore drill:** restore into a clean empty database and confirm the treasury total matches.
      **Note discovered 2026-08-04:** `sqlite3 .dump` is NOT a valid restore path here — the
      immutability triggers refuse a journal line inserted into an already-posted entry, so a dump
      replays in the wrong order and fails. Restore must replay migrations, then insert data in
      dependency order with entries posted last (the order `seed/demo/generate.py` already emits).
      **PROVEN 2026-08-06** — `tools/restore-drill.mjs`, in `npm run verify`. The drill
      reproduces the `.dump` failure first (the trigger refuses it, as predicted), then
      restores into a clean database and compares 14 figures including every account
      balance. Posting runs last, so the restore re-proves every entry balances.
- [ ] Quota headroom review — every free limit at least 3× above current usage, documented
- [ ] Arabic admin manual (PDF) incl. the account-recovery procedure
- [ ] 60-second Arabic onboarding video script
- [ ] Monitoring + error tracking + uptime alerts
- [ ] Data controller / privacy notice signed off by the board

**Gates**
- [x] A restore from backup into a clean project succeeds and the totals match
- [ ] The board chair completes the full admin workflow using only the manual, unassisted
- [ ] **An accountant has signed off the chart of accounts and the الوديعة treatment** (launch blocker)
- [ ] **A qualified Egyptian lawyer has reviewed the privacy notice against PDPL 151/2020**
- [ ] Simulated quota exhaustion creates no charge and degrades in the documented order
- [ ] `docs/QUOTA_AND_COST_REGISTER.md` re-verified within the last 30 days; every account is
      board-owned; no payment method attached to any strict-zero service
- [ ] No `TODO(owner-input)` remains anywhere in the codebase
