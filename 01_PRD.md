# 01 — PRD / وثيقة المتطلبات
**Product:** بوابة قرية الأطباء — Qaryat Al-Atebaa Community Portal
**Location:** قرية الأطباء، عجيبة، مرسى مطروح، مصر
**Version:** 1.0 — draft for owner review
**Status:** awaiting owner sign-off on §9 open questions

---

## 1. Problem statement

The compound operates as a general assembly (جمعية عمومية) of owners, with a board (مجلس إدارة)
drawn from the residents themselves. Today, money and information both move through a WhatsApp group:

- A resident pays, screenshots the InstaPay receipt, and drops it in the group.
- The receipt scrolls away within hours. Nobody has a reliable record of who paid what.
- Expenses are announced verbally or in scattered messages. No itemized, categorized ledger exists.
- Announcements, board decisions, and meeting minutes are lost within days.
- Maintenance work is invisible unless someone happens to photograph it and post in time.
- Elderly owners, or owners living abroad or in Cairo, are effectively excluded from oversight.

The result is not usually dishonesty — it is **disorder**, which produces suspicion, repeated
questions, and an unfair burden on whichever board member is holding the shoebox.

## 2. Product vision

> مكان واحد منظّم، كل واحد فيه يعرف بالظبط إيه اللي دفعه، وإيه المطلوب منه، وفلوس القرية راحت فين —
> من غير ما يسأل حد.

One organized place. Total financial transparency by default. Zero friction to log in.
Permanent, searchable memory for the community.

## 3. Success criteria (measurable, 3 months post-launch)

| # | Metric | Target |
|---|---|---|
| S1 | Owners who have logged in at least once | ≥ 80% of units |
| S2 | Payments submitted through the portal rather than WhatsApp | ≥ 90% |
| S3 | Median time from receipt upload to admin decision | < 48 hours |
| S4 | Expenses recorded with a category | 100% |
| S5 | "How much do I owe?" questions in the WhatsApp group | ↓ 75% |
| S6 | Owners over 65 who logged in unassisted | ≥ 50% |
| S7 | Disputed/unreconciled payments | 0 |
| S8 | Recurring cost | **0 EGP/month** |
| S9 | Months where the book balance was reconciled against the real bank/InstaPay balance | 100% |

## 4. Personas

**P1 — سعاد، 71، مالكة، تقيم بالقرية صيفًا.**
Uses WhatsApp and little else. Large text, one clear button. Her son may help the first time, never
again. If she must remember a password, she will not use the product. She wants one thing: to know
she is not behind on payments.

**P2 — د. أحمد، 45، مالك، مقيم بالقاهرة.**
Visits twice a year, pays by InstaPay from his phone. Wants a permanent record of everything he
paid and proof it was received. Deeply interested in where the money goes — he is the person who
asks the uncomfortable question in the general assembly.

**P3 — م. خالد، رئيس مجلس الإدارة (admin).**
A resident volunteer, not an accountant, doing this after his day job. Currently drowning in
screenshots. Needs a review queue he can clear in ten minutes on his phone, and a totals page he
can put on a screen at the annual meeting without preparing anything.

**P4 — عم سمير، مشغّل (operator).**
Records daily expenses — water trucks, light bulbs, an electrician's visit — and uploads photos of
maintenance work. Should be able to record an expense in under 60 seconds, and should not be able
to approve payments or see anyone's phone number.

**P5 — المبرمج (developer).**
Founder/maintainer. Full system access, break-glass powers, sole holder of destructive operations.
Every action logged.

## 5. Scope

### In scope — v1
Phone-OTP login · admin-provisioned accounts · bulk import of owners · resident dashboard with
personal balance · receipt upload with category and method · admin review queue · expense recording ·
category taxonomy management · community transparency dashboards · news & announcements · board
decisions · maintenance photo albums · documents & meeting minutes archive · full-text search ·
audit log · Arabic RTL responsive UI.

### Out of scope — v1 (explicitly deferred)
Online payment collection inside the portal (residents keep paying by InstaPay/bank and upload proof) ·
native mobile apps · multi-compound tenancy · accounting-software integration · English UI ·
automated bank-statement reconciliation.

### Deliberately never
Passwords. Email login. Selling or sharing resident data.

## 6. User stories with acceptance criteria

### Epic A — Access

**A1.** كمالك، عايز أدخل الموقع من غير باسورد ولا كود أكتبه.
*(Updated per ADR-011 — passkeys, not OTP.)*
- **First time:** the resident enters their number, taps one button, WhatsApp opens with a pre-filled
  token, they press send — then the phone offers to save a passkey ("الدخول ببصمة أو قفل الموبايل").
- **Every time after:** they enter their number and touch the fingerprint sensor. No code, no message,
  no waiting. Session lasts 1 year on a trusted device.
- A second passkey on another trusted device is offered, and printed single-use recovery codes are
  issued at activation.
- An unprovisioned number reveals nothing at the request step (no enumeration); the help path shows
  "كلّم إدارة القرية عشان يضيفوك" with a contact button.
- No screen anywhere requests a password or an email address.

**A2.** كأدمن، عايز أرفع بيانات كل الملاك مرة واحدة.
- Upload an Excel/CSV with الاسم، رقم العمارة، رقم الشقة، رقم الموبايل.
- The importer previews, normalizes phone numbers to `+20…`, flags duplicates and malformed rows,
  and imports only after explicit confirmation.
- Every imported owner can log in immediately with no further setup.

**A3.** كمالك كبير في السن، عايز حد يساعدني.
- A permanent "محتاج مساعدة؟" button on the login screen with board contacts and one-tap WhatsApp.
- An admin can view a resident's screen state (read-only support view) to talk them through it.

### Epic B — Payments

**B1.** كساكن، عايز أرفع صورة التحويل وأحدد الفئة.
- Camera or gallery; images compressed client-side; upload progress visible.
- Required: amount, category, payment method, transfer date. Optional: reference number, note.
- On success: a receipt number, a "قيد المراجعة" status, and an entry in the resident's history.

**B2.** كساكن، عايز أعرف اتصدّق على الدفع ولا لسه.
- Status is visible on the home screen and in the payment list, worded and colored.
- On approval: a WhatsApp/in-app notification, and the amount reflects in the personal balance and
  the community totals immediately.
- On rejection: the admin's reason is shown, with a one-tap "ارفع صورة تانية."

**B3.** كساكن، عايز أشوف كل اللي دفعته من قبل.
- A chronological list, filterable by year and category, with totals per period.
- Each entry opens the original image and full details.
- One-tap download of an annual statement PDF.

**B4.** كأدمن، عايز أراجع الإيصالات بسرعة.
- A queue sorted oldest-first with the image, resident, unit, amount, and category on one card.
- Approve / reject / request-info in one tap; correcting the amount requires a reason.
- Approving twice posts once (idempotent). All actions audit-logged with actor and timestamp.

### Epic C — Expenses & transparency

**C1.** كأدمن أو مشغّل، عايز أسجّل مصروف.
- Amount, category, date, description, optional vendor and invoice photo.
- Recorded expenses appear in community totals immediately and are visible to all members.

**C2.** كأي عضو، عايز أشوف فلوس القرية راحت فين.
- Public-to-members dashboard: total income, total expenses, current treasury balance, breakdown
  by category with chart, recent transactions timeline, and per-building collection status.
- Filterable by period. Every number traceable to its underlying entries.

**C3.** كأدمن، عايز أدير فئات المصروفات.
- Add, rename, deactivate, reorder, nest one level. Deleting requires reassigning existing entries.

**C4.** كأي عضو، عايز أشوف حالة السداد لكل الوحدات.
- A table by building/unit showing due, paid, and outstanding — aggregate figures only, no receipt
  images and no phone numbers.

### Epic D — Information

**D1.** أخبار وإعلانات وقرارات — منشورة بتاريخ، مؤرشفة للأبد، قابلة للبحث, ومثبّتة عند الأهمية.
**D2.** ألبومات صور الصيانة والترميم والتطوير — بتاريخ ووصف، ومرتبطة بالمصروف المقابل حيثما أمكن.
**D3.** مستندات ومحاضر اجتماعات — PDF قابل للتحميل والبحث، مرتب بالتاريخ.
**D4.** بحث واحد يغطي كل ما سبق.

## 7. Non-functional requirements

- **Performance:** first contentful paint < 2.5s on 3G; dashboard interactive < 4s.
- **Availability:** 99% monthly. A read-only degraded mode is acceptable during incidents.
- **Security:** RLS on every table; signed, short-lived URLs for receipt images; OTP rate-limited;
  full audit log; encrypted at rest.
- **Privacy:** phone numbers visible only to admin/developer; receipt images only to the owner and
  reviewers; a plain-Arabic privacy notice on first login.
- **Backup:** automated daily database backup with a *tested* restore procedure, plus a monthly
  off-platform export the board holds independently of the developer.
- **Capacity:** designed for ~500 units and ~10,000 transactions/year — small. Optimize for clarity
  over scale.
- **Accessibility:** **WCAG 2.2 AA** — 2.2 specifically adds *Target Size* and *Accessible
  Authentication*, the two criteria this product lives or dies by. 17px minimum body text, 48px tap
  targets, full keyboard operability, screen-reader labels in Arabic. Test the **whole** login and
  payment journeys, not isolated components.
- **Legal:** Egyptian Personal Data Protection Law No. 151 of 2020 applies. The board must be named
  data controller in writing, and a qualified Egyptian lawyer must review the privacy notice before
  production. Engineering review is not legal advice.

## 8. Rollout plan

1. **Pilot (2 weeks):** board members + 10 friendly owners. Fix what confuses them.
2. **Building-by-building onboarding:** a WhatsApp message per building with a 60-second Arabic
   video showing exactly the login flow.
3. **Parallel run (1 month):** WhatsApp receipts still accepted, but every one is entered into the
   portal by an operator, so the portal is complete from day one.
4. **Cutover:** portal becomes the only accepted channel; the WhatsApp group becomes announcements-only.
5. **Assembly demo:** present the transparency dashboard at the general assembly. This is the moment
   the product earns trust.

## 9. Open questions for the owner
> Each has a recommended default so approval can be a single word.

| # | Question | Recommended default |
|---|---|---|
| Q1 | Number of buildings and units? | — required before import |
| Q2 | Annual subscription amount, and is it flat per unit or by area? | flat per unit |
| Q3 | Which fiscal year does the community use? | 1 Jan – 31 Dec |
| Q4 | Should staff salaries show named individuals to all residents? | show role + amount to all; names to admins only |
| Q5 | Is a public (no-login) transparency page acceptable? | no — members only, for v1 |
| Q6 | Who holds the `admin` role besides the board chair? | chair + treasurer |
| Q7 | Preferred OTP channel and budget? | WhatsApp primary, SMS fallback |
| Q8 | Domain name? | e.g. `qaryat-atebaa.com` — owner to register |
| Q9 | Is there historical payment data to import from before launch? | import current-year only |
| Q10 | Who is legally responsible for the data (data controller)? | the board, in writing |
