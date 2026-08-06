# ASSUMPTIONS — كل افتراض مؤقت، ومين يأكده وإمتى

> `<grounding>`: a **`temporary assumption`** is something needed to proceed that is *unvalidated*.
> It is not a requirement and not a verified fact. Every row has an owner and a validation date.
> An assumption that survives past its date without validation becomes a risk.

| # | Assumption | Why it was needed | Owner | Validate by | Status |
|---|---|---|---|---|---|
| A-01 | The village has roughly **34 buildings numbered 14–47**, read off the site map the owner sent | to size the import and the per-building views | owner (Q1) | before CP-1 | ⬜ unvalidated — **read from an image, never treat as fact** |
| A-02 | ~214 units total, carried forward from `05_ZERO_COST_ARCHITECTURE.md` | every quota forecast in the register | owner (Q1) | before CP-1 | ⬜ unvalidated |
| A-03 | ~5,000 receipt images per year at ~500 KB compressed | the storage cap and the 3-year archive plan | measure at pilot | end of CP-4 | ⬜ unvalidated |
| A-04 | Residents' devices support WebAuthn passkeys at a workable rate | ADR-011 makes passkeys the primary login | measure at pilot | CP-2 | ⬜ unvalidated — ADR-011 says revisit if support proves too low |
| A-05 | D1 accepts `STRICT` tables and `RAISE(ABORT)` inside triggers | the whole schema depends on both | agent | **first `wrangler d1 migrations apply`** | ⬜ verified on SQLite 3.45.1 locally; **not** on D1 |
| A-06 | Egypt WhatsApp per-message rates ≈ $0.0073 utility / $0.0130 authentication | the cost estimate in Q20 | agent | only if Q20 is answered "keep WhatsApp" | ⬜ carried from the pack, not re-verified 2026-08-04 |
| A-07 | ~~A Google service account can drive Drive as a private file store with no billing path~~ | Q19 option (أ) | agent | — | ❌ **FALSIFIED 2026-08-04.** Service accounts have no Drive quota; uploads fail `403 storageQuotaExceeded`. See ADR-022 and RESEARCH_SOURCES #20. Replaced by A-20 |
| A-08 | Sentry's free Developer plan needs no card | monitoring stack | agent | before CP-8 | ⬜ pricing page does not say |
| A-09 | Backblaze B2 signup needs no card | Plan B storage | agent | only if Plan B is triggered | ⬜ pricing page does not say |
| A-10 | ~2–4k D1 row writes/day at full adoption | the 60k/day switch condition | agent | measure in CP-3 | ⬜ estimate only |
| A-11 | A modified-cash accounting basis is acceptable to the board and the assembly | `report_snapshots.basis_ar` default | accountant (Q15) | CP-8 | ⬜ unvalidated |
| A-20 | Drive via **OAuth as a real board member's account** works, is cardless, and uses that person's 15 GB | ADR-022, the corrected storage plan | agent | before CP-4 | ⬜ unvalidated — this is now the load-bearing assumption |
| A-21 | Backblaze B2 **private** bucket signup needs no card (public buckets demonstrably do) | ADR-022 alternative | agent | before choosing B2 | ⬜ unvalidated |
| A-12 | Bank/InstaPay reconciliation will be done monthly by a named admin | `reconciliations` design and the "آخر مطابقة" line | owner | CP-5 | ⬜ unvalidated |

---

## Invented for the demo dataset (2026-08-04) — replace, do not "correct"

> The owner asked to proceed with imaginary data until the real register arrives. Everything below
> was **chosen by the agent**. None of it came from Qaryat Al-Atebaa. When the real file arrives,
> regenerate — never edit these values into real ones, because a half-edited demo is indistinguishable
> from real data.

| # | Invented value | Where it lives | Replaced by |
|---|---|---|---|
| A-13 | Annual subscription **6,000.00 ج.م**, flat per unit, due 31 March 2026 | `seed/demo/001_village.sql` | Q2 |
| A-14 | Deposit (وديعة) **5,000.00 ج.م**, paid by 55 of 204 units | `seed/demo/003_money.sql` | owner |
| A-15 | Opening balance **227,000.00 ج.م** (45,000 cash + 182,000 bank) at 1 Jan 2026 | `seed/demo/002_opening.sql` | owner's 2025 closing |
| A-16 | 30 expenses Jan–Jul 2026 totalling **395,550.00 ج.م**, and 7 staff salaries | `seed/demo/003_money.sql`, `004_content.sql` | owner's records |
| A-17 | **6 units per building**, 204 units across buildings 14–47 | `seed/demo/generate.py` | Q1 |
| A-18 | Names of 205 residents, board members and staff | `seed/demo/001_village.sql` | Q1 |
| A-19 | Phone numbers in the unallocated `+2010000xxxxx` range | `seed/demo/001_village.sql` | Q1 |

**Not invented, deliberately:** bank / InstaPay / Vodafone Cash details remain NULL even in the demo
(Q13). Inventing a payment destination is the one fabrication that could cause a resident to send
real money to a wrong place, so the demo shows the empty state instead.

---

## Retired assumptions

| # | Was | Outcome |
|---|---|---|
| — | "Meta gives 1,000 free service conversations/month" (`05` §1, ADR-009) | ❌ **falsified 2026-08-04.** Conversation pricing ended 2025-07-01; service messages become billable 2026-10-01. See ADR-016 |
| — | "R2 is free to 10 GB with only overage exposure" (`05` §2a) | ⚠️ **incomplete.** Also requires a payment method to activate at all. See ADR-015 |
| — | "Neon free scales to zero with instant resume" (`05` §2) | ⚠️ **wrong.** Neon's Free plan is always-on; scale-to-zero is a paid-plan setting. It still cannot bill, which is what actually matters for C11 |
| — | "D1 free tier is 5 GB" (`05` §1 table) | ✅ already corrected in §2a and re-confirmed: **500 MB per database**, 5 GB account, **10 databases max on free** |
