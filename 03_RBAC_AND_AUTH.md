# 03 — Roles, Permissions & Authentication

---

## 1. The four roles

| Role | العربية | Who | Principle |
|---|---|---|---|
| `developer` | المبرمج / المؤسس | The person who built and maintains the system | Break-glass. Can do anything, but every action is logged and visible to admins. Not a day-to-day operator. |
| `admin` | الأدمن / رئيس مجلس الإدارة | Board chair, treasurer | Owns the money decisions: approves receipts, records expenses, manages users and categories. |
| `operator` | مشغّل | Volunteer or staff helping with data entry | Enters expenses and content. **Cannot approve money. Cannot see phone numbers.** |
| `resident` | ساكن / مالك | Every owner | Sees everything aggregate, manages only their own payments. |

**Separation of duties is the point of the `operator` role:** whoever records an expense should not
be the same person who approves incoming money. For amounts above a configurable threshold, an
expense recorded by an operator requires an admin countersign before it posts.

## 2. Permission matrix

`✔` allowed · `✖` denied · `◐` limited (see note)

| Capability | developer | admin | operator | resident |
|---|:--:|:--:|:--:|:--:|
| **Auth & users** |
| Log in with phone OTP | ✔ | ✔ | ✔ | ✔ |
| Create / import user accounts | ✔ | ✔ | ✖ | ✖ |
| Assign roles | ✔ | ◐¹ | ✖ | ✖ |
| Deactivate a user | ✔ | ✔ | ✖ | ✖ |
| View any phone number | ✔ | ✔ | ✖ | ◐² |
| Edit own name / notification channel | ✔ | ✔ | ✔ | ✔ |
| **Payments** |
| Submit a receipt | ✔ | ✔ | ✔ | ✔ (own unit) |
| View own payments + images | ✔ | ✔ | ✔ | ✔ |
| View **anyone's** receipt image | ✔ | ✔ | ✖ | ✖ |
| Approve / reject a receipt | ✔ | ✔ | ✖ | ✖ |
| Correct an approved amount (w/ reason) | ✔ | ✔ | ✖ | ✖ |
| Post a reversing entry | ✔ | ✔ | ✖ | ✖ |
| **Expenses** |
| Record an expense | ✔ | ✔ | ✔ | ✖ |
| Countersign an above-threshold expense | ✔ | ✔ | ✖ | ✖ |
| Reverse an expense | ✔ | ✔ | ✖ | ✖ |
| **Transparency (read)** |
| Community totals & treasury balance | ✔ | ✔ | ✔ | ✔ |
| Expense breakdown by category | ✔ | ✔ | ✔ | ✔ |
| Per-unit paid / outstanding (aggregate) | ✔ | ✔ | ✔ | ✔ |
| Staff roles + salary amounts | ✔ | ✔ | ✔ | ✔ |
| Staff **names** | ✔ | ✔ | ✔ | ✖³ |
| **Config & content** |
| Manage categories | ✔ | ✔ | ✖ | ✖ |
| Define fee periods & dues | ✔ | ✔ | ✖ | ✖ |
| Publish news / announcements / decisions | ✔ | ✔ | ✔ | ✖ |
| Upload documents & meeting minutes | ✔ | ✔ | ◐⁴ | ✖ |
| Create maintenance photo albums | ✔ | ✔ | ✔ | ✖ |
| Edit site settings & bank details | ✔ | ✔ | ✖ | ✖ |
| **Oversight** |
| Read the audit log | ✔ | ✔ | ✖ | ✖ |
| Modify the audit log | ✖ | ✖ | ✖ | ✖ |
| Export data | ✔ | ✔ | ✖ | ◐⁵ |
| Run migrations / change schema | ✔ | ✖ | ✖ | ✖ |

¹ admin may assign `operator` and `resident`; only `developer` may create another `admin`.
² a resident sees only their own number.
³ pending owner decision Q4 — default is names hidden from residents.
⁴ operator may upload; publishing minutes requires admin.
⁵ a resident may export **their own** payment history only.

**Implementation rule:** the matrix is expressed once, in `lib/rbac.ts`, as data — and mirrored by
the guards in `lib/db/`. A test asserts the two agree. Never scatter `if (role === 'admin')` checks
through components.

**Permissions are explicit per action, never inherited by rank.** `developer` sitting above `admin`
in the list does not mean `developer` silently holds every financial power. It holds infrastructure
and break-glass powers, all logged and all visible to admins. Being technically able to do something
is not authorization to do it.

**Maker–checker overrides the matrix.** No actor — including `developer` — gives final approval to a
financial item they created. See `06_ACCOUNTING_AND_LEDGER.md` §6 for which actions need a second,
different admin. If only one active admin exists, `/admin` must display
*"⚠️ فيه أدمن واحد بس — يُفضّل تعيين تاني عشان المراجعة"* rather than pretending the control exists.

**A fifth role to consider (`FINANCE_REVIEWER`):** read-and-review authority without edit rights, for
a board member or volunteer accountant who audits but never posts. Cheap to add, and it is what makes
maker–checker workable when the active board is small. Propose it to the owner.

### Delegates
An owner in Cairo authorizes a son or a caretaker (`delegate_authorizations`). A delegate's access is
scoped to one unit, granular (`can_view_financials`, `can_submit_payments`), **time-limited**, and
revocable. Every delegated action is logged as *"فلان — بالنيابة عن فلان"*, never as the owner alone.

## 3. Authentication flow

> **⚠️ Superseded by ADR-009 and ADR-011.** The flow is now layered:
> **passkey (WebAuthn) for every login** → **inbound WhatsApp for first activation and recovery** →
> **board-issued one-time link** as the vendor-free fallback. Passkeys cost nothing, depend on
> nobody, and delete the read-and-retype-a-code step entirely.
> **See `05_ZERO_COST_ARCHITECTURE.md` §3 and §3.0 for the authoritative flow.**
>
> **Also superseded: the phone number is a login identifier, not a key.** It lives in
> `phone_identifiers` with full history (`02_DATA_MODEL.md`), so a number can change without
> touching units or ledger history.
>
> The outbound-OTP flow below is retained because everything around it still applies — normalization,
> hashing, single-use tokens, rate limits, sessions, recovery — and because it is the design to use if
> the free WhatsApp path is ever unavailable. Sessions are now **1 year**, not 30 days (ADR-009).

### 3.1 Legacy outbound-OTP flow (fallback reference)

```
┌─ Login screen ─────────────────────────────────┐
│  رقم الموبايل  [ 010 xxxx xxxx ]               │
│  [        إرسال كود الدخول        ]            │
│  محتاج مساعدة؟ → board contacts                │
└────────────────────────────────────────────────┘
        │  POST /api/otp/request  { phone }
        ▼
  normalize → +20…            (accept 01…, 201…, +201…, with spaces/dashes)
  lookup profiles.phone_e164
    ├─ not found or inactive → generic success response (see §5), no OTP sent
    └─ found → generate 6-digit code
               store bcrypt(code), expires_at = now()+5min, attempts=0
               send via WhatsApp Cloud API template → on failure, SMS fallback
        │
        ▼
┌─ Code screen ──────────────────────────────────┐
│  بعتنالك كود على واتساب رقم …78                 │
│  [ _ ] [ _ ] [ _ ] [ _ ] [ _ ] [ _ ]           │
│  إعادة الإرسال بعد 00:45                        │
│  جرّب SMS بدل واتساب                            │
└────────────────────────────────────────────────┘
        │  POST /api/otp/verify  { phone, code }
        ▼
  compare hash · check expiry · check attempts < 5 · mark consumed (single-use)
  → issue Supabase session (JWT), 30-day sliding refresh
  → update profiles.last_login_at, write audit_log
  → redirect to /  (or the deep link they arrived from)
```

**Autofill:** the WhatsApp/SMS message text uses the WebOTP-compatible format so Android autofills
the code. Message body (Arabic):
> كود دخولك لبوابة قرية الأطباء: **123456**
> الكود صالح 5 دقايق. متديهوش لحد.
> @qaryat-atebaa.com #123456

## 4. Rate limiting & abuse protection

| Limit | Value | On breach |
|---|---|---|
| OTP requests per phone | 3 / 15 min, 10 / day | "حاول تاني بعد شوية" + a support contact |
| OTP requests per IP | 20 / hour | soft block |
| Verify attempts per challenge | 5 | challenge burns; must request a new code |
| Failed verifies per phone | 10 / hour | 1-hour lockout, admin notified |
| Concurrent active challenges per phone | 1 | requesting a new code invalidates the old |
| Receipt uploads per resident | 20 / day | throttle with a friendly message |
| Upload size | 10 MB pre-compression | client-side compress to ≤ 1600px / ~500 KB |

Resend cooldown starts at 45 s and backs off (45 s → 90 s → 180 s).

## 5. Security decisions (and their reasoning)

- **Enumeration:** `/api/otp/request` returns the same response whether or not the number exists,
  and the "الرقم مش مسجّل" message is shown only on the *verify* step. This prevents an outsider
  from harvesting which numbers belong to the compound. *(Trade-off: slightly more confusing for a
  genuinely unregistered user — mitigated by prominent help contacts.)*
- **Codes are hashed at rest.** A database leak must not yield live codes.
- **Single-use, single-active challenge.** No code reuse, no parallel-challenge race.
- **Sessions:** 30-day sliding, revocable by an admin ("سجّل خروج من كل الأجهزة"). Rotating refresh
  tokens; reuse detection kills the family.
- **Elevated actions re-verify.** Approving a payment above a threshold, changing bank details, or
  changing a role prompts for a fresh OTP. Cheap insurance on a stolen unlocked phone.
- **Phone number change** is an admin-only operation, always logged, and notifies the old number.
  This is the single most abuse-prone path in a phone-only system — treat it as account recovery.
- **Impersonation/support view** by an admin is read-only, banner-flagged on screen, and audit-logged.
- **Signed URLs, 60 seconds.** Receipt images are never publicly addressable.
- **No secrets in the client.** WhatsApp/SMS credentials live only in Edge Function env vars.

## 6. Account recovery — the hard case

A phone-only system's weak point is a lost or changed number.

1. The resident contacts a board member **in person or by a known channel**.
2. The admin verifies identity against unit ownership records (offline step — document it).
3. The admin changes `phone_e164` from the admin panel. This: writes an audit entry, notifies the
   old number if still reachable, notifies all admins, and invalidates all existing sessions.
4. A second admin's confirmation is required if the account holds `admin` or `developer` role.

Write this procedure into the Arabic admin manual. It is a **process** control, not a code control,
and it is where real-world fraud would occur.

**With passkeys this gets structurally safer.** Changing a phone number no longer hands over the
account, because the account is opened by a passkey, not by a number. To fully take over, an attacker
would need a phone change *and* a passkey re-enrollment — two audited events requiring two different
admins. That is the main security argument for passkeys, beyond the cost saving.

**Losing a device** is now the common case, not losing a SIM. Handle it with: the second passkey on
another device → the printed recovery codes issued at activation → assisted recovery requiring two
admins. A single operator must never be able to re-enroll a passkey alone.

## 7. OTP provider notes (Egypt, 2026)

- **WhatsApp Business Cloud API** — highest delivery reliability in Egypt; effectively universal
  installed base; authentication-category template messages are priced per message and must be
  pre-approved by Meta. Requires a verified business and a dedicated number. **Register the template
  early — approval takes days, and it will block CP-2 if left late.**
- **SMS** — needs a registered sender ID with the Egyptian regulator via a local aggregator; slower
  to set up, higher per-message cost, but works on phones without WhatsApp. Keep as fallback only.
- Abstract both behind `lib/otp/provider.ts`:
  ```ts
  interface OtpProvider { send(phone: string, code: string): Promise<{ id: string }> }
  ```
  with `WhatsAppProvider`, `SmsProvider`, and `ConsoleProvider` (dev — prints to the terminal).
  All of CP-0 through CP-4 must be fully developable and testable on `ConsoleProvider` with zero spend.
- Budget the message cost per login and show the owner a monthly estimate: *units × logins/month ×
  price per authentication message*. Reducing login frequency (30-day sessions) is a direct cost lever
  — note this to the owner as a reason the long session is deliberate, not lazy.


---

## ⚠️ Village map — restored 2026-08-08 from the v1.1 spec revision

The pack's specification files are **v1.1 — village-map revision**; the copies this project was
built from are v1.0 and omit every map paragraph, along with constraint **C13**, product goal 4 and
`07_VILLAGE_MAP_SPEC.md`. Found by diffing the uploaded packs against this repo, twenty-seven
sessions in (INSIGHTS 2026-08-08, R-084).

**Map privacy:** `/map` is navigation, never a permission shortcut. A building click calls the same
authorized API as every other screen. Draft imagery, names, phones, files, notes and private balances
must never appear through map endpoints. See `07_VILLAGE_MAP_SPEC.md`.

| Capability | developer | admin | operator | finance_reviewer | resident |
|---|---|---|---|---|---|
| Published map and approved aggregate building summary | ✔ | ✔ | ✔ | ✔ | ✔ |
| View draft/source map; edit/link/publish features | ✔ | ✔ | ✖ | ✖ | ✖ |

**As implemented (2026-08-08):** `/map` and `/buildings/:id` require any authenticated member
(`profile.edit_own`); `/admin/map` and every mutation require `settings.edit`. `buildingSummary`
returns aggregates only, gated on `settings.unit_status_public`, and returns NULL rather than zero
when that is off — a zero would read as "this building owes nothing", which is a false statement
rather than a withheld one. Asserted in `tests/access/board_config.test.ts`: no phone number and no
resident name can reach a map endpoint.
