# 06 — Accounting Model, Ledger Rules & Transparency Tiers

> **Why this document exists.** The original pack treated money as "approved payments minus expenses."
> That is a cash tally, not an accounting record. A general assembly that asks "where did the
> الوديعة go?" or "why does the balance say 318,000 when the bank says 291,000?" cannot be answered
> by a tally. This document upgrades the financial layer to a real double-entry ledger.
>
> **Nothing here is legal or accounting advice.** The chart of accounts and the treatment of the
> deposit must be approved by a qualified accountant and by the board before production.

---

## 1. The distinctions that must never be conflated

Most financial bugs in community systems come from collapsing these into one concept. Keep them
separate in the schema, in the UI, and in the Arabic wording.

| Concept | العربي | What it is | Affects the ledger? |
|---|---|---|---|
| **Obligation / assessment** | المطلوب من الوحدة | An amount a unit owes for a period | Yes — a receivable |
| **Payment submission** | إيصال مرفوع | The resident's *claim* plus a photo, awaiting review | **No** |
| **Approved payment** | دفعة معتمدة | A reviewer accepted the claim | Yes |
| **Posted transaction** | قيد مرحّل | The balanced journal entry | Yes — this is the truth |
| **Revenue** | إيراد | Amount recognized as income per policy | Depends on category |
| **Deposit / وديعة** | وديعة | Refundable or restricted — **often a liability, not income** | Yes, as a liability |
| **Expense request** | طلب صرف | Proposed spending | No |
| **Approved expense** | مصروف معتمد | Authorized | Commitment only |
| **Paid / posted expense** | مصروف مدفوع | Money actually left | Yes |
| **Credit / adjustment** | رصيد دائن / تسوية | Approved change to a resident's balance | Yes |
| **Reversal** | قيد عكسي | Correction linked to the original | Yes |

**The rule that follows from this table:** a receipt sitting in the review queue contributes
**zero** to every total, on every screen, always. The word "إيرادات" never includes a pending
receipt. Label the pending figure separately and explicitly: *"إيصالات مرفوعة لسه تحت المراجعة —
مش محسوبة في الإيرادات."*

### ⚠️ الوديعة is the trap
Residents call it a payment; accounting may treat it as a refundable liability or a restricted fund,
**not** ordinary income. If it is booked as revenue, the village's spendable balance is overstated by
the entire deposit pool — the single most dangerous error this system can make. Book deposits to a
liability/restricted-fund account by default, show them **separately** from spendable operating funds
on every dashboard, and get the treatment confirmed in writing (`docs/OPEN_QUESTIONS.md` Q14).

## 2. Double-entry, made small

Not a full accounting package — the minimum that makes the numbers defensible.

```
journal_entries (id, entry_no, entry_date, period_id, description_ar,
                 source_type, source_id, created_by, approved_by, posted_at,
                 is_reversal, reverses_entry_id)

journal_lines   (id, entry_id, account_id, fund_id, cost_center_id,
                 debit_piastres, credit_piastres, unit_id, memo_ar)
```

**Hard constraints, enforced in the database and by test:**
- `SUM(debit) = SUM(credit)` for every entry. An unbalanced entry cannot be saved.
- Each line has exactly one of `debit` or `credit` non-zero, and both are `INTEGER` piastres.
- A posted entry is immutable. Corrections create a linked reversal plus a replacement.
- Every entry names its source: which payment, which expense, which adjustment.
- No orphan entries — every entry traces to an approved source document.

**Minimal chart of accounts** (`accounts` table: `code, name_ar, type, is_active`):

| Type | Accounts |
|---|---|
| **Assets** | الخزنة النقدية · الحساب البنكي · محفظة إنستا باي · مستحقات على الملاك (receivables) |
| **Liabilities** | ودائع مستردة · أرصدة دائنة للملاك (overpayments) · مستحقات موردين |
| **Funds / Equity** | رصيد أول المدة · احتياطي الصيانة · احتياطي الطوارئ |
| **Income** | اشتراك الصيانة السنوي · مساهمات خاصة · غرامات تأخير · إيرادات أخرى |
| **Expenses** | the taxonomy in `02_DATA_MODEL.md` §3 — كهرباء، مياه، مرتبات، أمن، نظافة، مساحات خضراء، صيانة (لمبات، مفاتيح، مواتير، سباكة، دهانات، مصاعد)، حمام سباحة، مصروفات إدارية، طوارئ، أخرى |

Also carry **funds** (operating / deposit / reserve) and **cost centers** (a maintenance project, a
building) as dimensions on every line. "صيانة" alone answers nothing; "صيانة → كهرباء → مشروع ترميم
السور" answers the question a resident actually asks.

### Example postings

**Resident pays 1,500 subscription (approved):**
```
Dr  محفظة إنستا باي            1,500.00
    Cr  اشتراك الصيانة السنوي            1,500.00
```
**Resident pays 5,000 وديعة:**
```
Dr  الحساب البنكي              5,000.00
    Cr  ودائع مستردة (التزام)            5,000.00   ← liability, NOT income
```
**Resident pays 2,000 against a 1,500 obligation (overpayment):**
```
Dr  محفظة إنستا باي            2,000.00
    Cr  اشتراك الصيانة السنوي            1,500.00
    Cr  أرصدة دائنة للملاك                 500.00   ← credit, NOT income
```
**Water truck, 3,200, paid cash:**
```
Dr  مصروفات — المياه           3,200.00
    Cr  الخزنة النقدية                  3,200.00
```

## 3. Payment state machine — nine states, not four

```
DRAFT ──► SUBMITTED ──► UNDER_REVIEW ──┬──► APPROVED ──► (posted)
                             │          ├──► NEEDS_INFORMATION ──► SUBMITTED
                             │          ├──► REJECTED
                             │          └──► DUPLICATE
                             └──► CANCELLED  (by the resident, while pending only)
APPROVED ──► REVERSED  (admin only, with a linked reversing entry and a reason)
```

| State | العربي | Ledger effect |
|---|---|---|
| `DRAFT` | مسودة | none |
| `SUBMITTED` | تم الإرسال | none |
| `UNDER_REVIEW` | قيد المراجعة | none |
| `NEEDS_INFORMATION` | محتاج توضيح | none |
| `APPROVED` | تم الاعتماد | **posts** |
| `REJECTED` | مرفوض | none |
| `DUPLICATE` | مكرر | none |
| `CANCELLED` | ملغي | none |
| `REVERSED` | تم عكسه محاسبيًا | posts a reversal |

Transitions are a table, not scattered `if` statements. Every non-trivial transition records actor,
timestamp, and reason. `REJECTED`, `NEEDS_INFORMATION`, and `DUPLICATE` require a reason shown to the
resident verbatim. Use neutral language for duplicates — *"يحتمل إنه مكرر — محتاج مراجعة"* — never an
accusation.

## 4. Allocation rules — write these down before coding

| Case | Rule |
|---|---|
| **Partial payment** | Allocate to the oldest unpaid obligation first, then forward. Remainder stays outstanding. |
| **Overpayment** | Excess becomes a resident credit (a **liability**), never income. Auto-applies to the next obligation. |
| **Advance payment** | Same as overpayment — a credit until an obligation exists to absorb it. |
| **Multiple obligations** | Resident may choose; default is oldest-first. Show what it was applied to. |
| **Waiver / إعفاء** | Reduces the obligation, requires an admin reason, is audited, and appears on the statement as a waiver — never as a payment. |
| **Late penalty / غرامة** | A separate obligation with its own category. Never silently folded into the subscription. |
| **Refund** | A posted transaction reducing cash and the resident's credit. Requires two approvals. |
| **Transfer between categories** | A reclassification entry with a reason. Original entry stays visible. |

## 5. Fiscal periods and closing

- `fiscal_periods (id, name_ar, starts_on, ends_on, status)` — `OPEN` → `CLOSED` → (`REOPENED`).
- A closed period rejects ordinary writes. Late transactions post to the current open period.
- Reopening requires: admin role, re-authentication, a written reason, notification to all admins,
  and an audit entry. It is deliberately uncomfortable.
- On close, snapshot an **immutable monthly/annual statement**. A correction posted later must never
  silently rewrite a figure residents have already seen — the snapshot stands and the correction
  appears as a dated revision with a visible trail.

## 6. Maker–checker (separation of duties)

| Action | Who may create | Who must approve |
|---|---|---|
| Payment approval | — | `admin` (never the submitter) |
| Expense ≤ threshold | `operator`, `admin` | the creator, if `admin` |
| Expense > threshold | `operator`, `admin` | a **different** admin |
| Refund | `admin` | a different `admin` |
| Reversal | `admin` | a different `admin` |
| Period reopen | `admin` | a different `admin` + re-auth |
| Phone number change | `admin` | a different `admin` for staff accounts |
| Waiver | `admin` | reason required; reported monthly |

**Nobody finally approves their own financial item.** If the board is genuinely one active person, the
system must say so on the dashboard — *"⚠️ فيه أدمن واحد بس. يُفضّل تعيين تاني للمراجعة"* — rather than
pretending a control exists. Threshold default: **5,000 ج.م**, board-configurable.

## 7. Transparency tiers — replaces the earlier all-or-nothing model

| Tier | Audience | Content | Default |
|---|---|---|---|
| `AGGREGATE` | every authenticated member | opening balance, collections, expenses, current balance, category and fund totals, budget vs actual, last reconciliation date | **ON** |
| `SANITIZED_TRANSACTION` | every authenticated member | date, category, amount, project/vendor label, sanitized description, reference — **no attachments** | **ON** |
| `UNIT_STATUS` | every authenticated member | dues and payment status **by unit code only** — no names, no phones, no receipts | **needs board approval** (Q11) |
| `IDENTIFIED_MEMBER` | — | any identifiable cross-resident financial data | **OFF** — requires a general-assembly decision and privacy review |
| `PRIVATE_OWNER` | the owner, their delegates, finance staff | full personal statement, submissions, reasons, attachments | **ON** |
| `AUDIT` | reviewer / auditor role | full evidence and audit history | **ON** for that role |

**Never, at any tier:** another resident's mobile number · another resident's raw receipt image ·
full bank account numbers · national ID · OTP or recovery evidence · private staff notes ·
infrastructure data.

**Staff salaries:** show job title, period, and amount to all members; show **names** only to
admins/operators unless the board decides otherwise in writing (Q4).

**Every published report carries:** scope, period, accounting basis, generation timestamp, report ID,
last reconciliation date, and whether the figures are posted or provisional. A revised report links
to the version it replaces.

## 8. Reconciliation

The book balance and the bank/wallet balance will diverge. Plan for it rather than discovering it at
the assembly.

- Monthly: an admin enters the actual closing balance of each cash/bank/InstaPay account.
- The system lists differences: approved-but-not-yet-cleared payments, recorded-but-not-yet-paid
  expenses, unrecorded bank charges.
- The dashboard shows **"آخر مطابقة: 31 يوليو 2026 ✅"** or a warning when it is stale.
- A resident seeing "متطابق مع البنك" trusts the number. That single line is worth more than any chart.

## 9. Additional invariants — each needs a permanent test

Extending `00_MASTER_PROMPT.md` `<verification_protocol>`:

1. Every journal entry balances: `SUM(debit) = SUM(credit)`.
2. Posted entries are immutable; a reversal nets its original to zero.
3. One submission posts **at most once** — verified against double-click, retry, and concurrent approval.
4. Pending, rejected, duplicate, and cancelled submissions contribute zero to every total.
5. Overpayment lands in the resident-credit liability account, never in income.
6. Deposits land in the deposit liability account, never in income.
7. Closed periods reject ordinary writes.
8. Resident statement total = sum of that resident's journal lines. Two independent computations agree.
9. Dashboard totals = sum of journal lines by account. Two independent computations agree.
10. Waivers appear as waivers, never as payments.
11. Money rounding is deterministic; no binary floating point anywhere.
12. `assets = liabilities + funds + (income − expenses)` — the accounting equation holds after every
    posting. This one test catches more bugs than the other eleven combined.

## 10. Schema additions to `02_DATA_MODEL.md`

```
accounts             (id, code, name_ar, type, is_active)
funds                (id, name_ar, kind)                    -- operating | deposit | reserve
cost_centers         (id, name_ar, project_id, is_active)
fiscal_periods       (id, name_ar, starts_on, ends_on, status, closed_by, closed_at)
journal_entries      (… see §2)
journal_lines        (… see §2)
resident_credits     (id, unit_id, amount_piastres, source_payment_id, applied_to, created_at)
reconciliations      (id, account_id, period_id, statement_balance_piastres,
                      book_balance_piastres, difference_piastres, notes_ar, done_by, done_at)
approval_events      (id, entity_type, entity_id, actor_id, action, reason_ar, created_at)
report_snapshots     (id, period_id, kind, payload_json, generated_at, supersedes_id)
```

`payments` and `expenses` keep their existing shape and gain `journal_entry_id`.

## 11. What this changes elsewhere

| Document | Change |
|---|---|
| `00_MASTER_PROMPT.md` | `<financial_domain_rules>` extended; the 12 invariants above added to `<verification_protocol>` |
| `02_DATA_MODEL.md` | tables in §10 added; `payments.status` becomes the nine-state enum |
| `04_UX_SPEC.md` | `/finance` separates spendable funds from deposits/reserves; adds reconciliation freshness, pending-not-counted figure, and budget-vs-actual |
| `CHECKPOINTS.md` | CP-5 gate becomes the accounting equation, not just the treasury subtraction |
| `docs/OPEN_QUESTIONS.md` | Q14 (deposit treatment) and Q15 (accountant sign-off) added |


---

## ⚠️ Village map — restored 2026-08-08 from the v1.1 spec revision

The pack's specification files are **v1.1 — village-map revision**; the copies this project was
built from are v1.0 and omit every map paragraph, along with constraint **C13**, product goal 4 and
`07_VILLAGE_MAP_SPEC.md`. Found by diffing the uploaded packs against this repo, twenty-seven
sessions in (INSIGHTS 2026-08-08, R-084).

**Village map:** building-level financial colour/status is another presentation of `UNIT_STATUS`,
not a separate permission. It remains off until Q11/Q22 are approved. When enabled, it is computed
only from posted journal data, never pending submissions, and shows text + icon with colour. The map
never exposes names, phones, receipt images, notes, or private owner balances.

**As implemented (2026-08-08):** no financial colour on the map at all. Q11 is undecided, so the
building card shows either aggregate figures (when `unit_status_public` is on) or a sentence saying
they are not published. The figures come from `v_unit_balance`, which reads posted journal lines
only — a pending receipt contributes zero, which is the same rule `/finance` follows.
