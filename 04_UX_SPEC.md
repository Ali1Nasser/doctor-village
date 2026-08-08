# 04 — UX / UI Specification

Arabic-first · RTL · mobile-first · built for a 71-year-old on a weak connection.

---

## 1. Design tokens

```css
/* Palette — calm, trustworthy, high-contrast. Sand & sea: Matrouh. */
--bg:            #F7F6F3;   /* warm off-white */
--surface:       #FFFFFF;
--surface-2:     #F0EEE9;
--ink:           #1F2421;   /* body text — 14.8:1 on --bg */
--ink-muted:     #5B615C;   /* 6.1:1 — still AA for body */
--brand:         #0E5C63;   /* deep teal — primary actions */
--brand-ink:     #FFFFFF;
--brand-soft:    #E3F0F1;
--accent:        #C1873B;   /* sand gold — highlights only, never text on light */
--ok:            #1D7A4C;   /* approved */
--ok-soft:       #E4F3EA;
--warn:          #A96A00;   /* pending */
--warn-soft:     #FBEFD9;
--danger:        #B3261E;   /* rejected */
--danger-soft:   #FBE9E7;
--info:          #1F5FA8;   /* needs info */
--info-soft:     #E5EFFA;
--border:        #DFDCD5;

/* Type — IBM Plex Sans Arabic, self-hosted, subset */
--fs-body:  17px;   /* floor, never smaller */
--fs-lg:    20px;
--fs-xl:    26px;
--fs-num:   32px;   /* money figures — tabular-nums */
--lh-body:  1.75;   /* Arabic needs generous leading */

--radius:   14px;
--tap-min:  48px;
--space:    4px;    /* 4/8/12/16/24/32/48 scale */
```

**Dark mode:** ship it — many residents browse at night. Invert with the same contrast ratios; never
pure black (`#14171A` background).

## 2. RTL rules (non-negotiable)

- `<html lang="ar" dir="rtl">`.
- Tailwind **logical properties only**: `ms-*`, `me-*`, `ps-*`, `pe-*`, `text-start`, `text-end`,
  `border-s`, `rounded-s-*`. A lint rule bans `ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`.
- Icons with direction (arrows, chevrons, back) mirror. Icons without (camera, check, clock) do not.
- Numbers, phone numbers, and currency stay LTR inside RTL text — wrap in
  `<bdi dir="ltr" class="tabular-nums">`. Without this, `1,234.50 ج.م` renders scrambled. **This is
  the single most common RTL bug in this project — test it explicitly.**
- Charts: axis on the right, series read right-to-left, tooltips flip.
- Progress bars and sliders fill right-to-left.

## 3. Screen inventory

### Public
| Screen | Notes |
|---|---|
| `/login` | Phone field, then **one touch on the fingerprint sensor** — "الدخول ببصمة أو قفل الموبايل". A "محتاج مساعدة؟" link with board WhatsApp. Nothing else on the page. |
| `/login/activate` | First time only: tap → WhatsApp opens pre-filled → press send → return → **enroll passkey**. Then printed recovery codes, and an offer to add a second device. |
| `/login/recover` | Lost device: second passkey → recovery code → assisted recovery (two admins). |

### Resident
| Screen | Purpose |
|---|---|
| `/` **الرئيسية** | The three-second answer: personal balance card, big **دفع جديد** button, community treasury summary, pinned notice, latest 3 news items. |
| `/pay` | Upload flow (§4). |
| `/payments` | My payment history — filter by year/category, status chips, totals, PDF statement download. |
| `/payments/[id]` | One receipt: image, all details, status timeline, admin reason if rejected. |
| `/finance` **شفافية** | Expense-by-category chart, recent transactions, period filter, and **four figures kept visually distinct**: (1) الفلوس المتاحة للصرف, (2) الودائع والاحتياطي — أمانات مش ملك القرية, (3) إيصالات تحت المراجعة — مش محسوبة, (4) المتأخرات المطلوبة. Plus a reconciliation freshness line: "آخر مطابقة مع البنك: 31 يوليو ✅". Never one merged "balance". |
| `/finance/units` | Per-building/unit collection status table (aggregates only). |
| `/news` · `/news/[slug]` | Announcements, decisions, archived forever, searchable. |
| `/albums` · `/albums/[id]` | Maintenance & development photo albums. |
| `/documents` | Documents & meeting minutes, PDF list by date. |
| `/search` | One search across news, decisions, documents, minutes. |
| `/me` | My name, my unit(s), notification channel, "مين أكلّم؟" contacts, logout. |

### Operator (adds)
`/ops/expenses/new` — 60-second expense entry · `/ops/albums/new` · `/ops/posts/new`

### Admin (adds)
| Screen | Purpose |
|---|---|
| `/admin` | Ops dashboard: pending receipts count, this month's income/expense, overdue units. |
| `/admin/review` | **The queue.** Oldest first, one card per receipt, three big buttons. |
| `/admin/expenses` | Full expense ledger + entry + countersign. |
| `/admin/categories` | Manage taxonomy. |
| `/admin/fees` | Fee periods, generate dues, waivers. |
| `/admin/users` | List, bulk import, roles, deactivate, change phone (elevated). |
| `/admin/staff` | Staff & salaries. |
| `/admin/audit` | Audit log, filterable. |
| `/admin/settings` | Community info, bank/InstaPay details, notification hours. |

## 4. The two critical flows — designed in detail

### 4.1 Resident pays (the most important flow in the product)

```
[الرئيسية] → «دفع جديد»
  ↓
Step 1 — كام؟          large numeric keypad input, EGP suffix, live-formatted
Step 2 — على إيه؟      category grid with icons, big tiles, most-used first
Step 3 — دفعت إزاي؟    InstaPay / تحويل بنكي / فودافون كاش / كاش  + transfer date (defaults today)
Step 4 — صورة التحويل  [📷 صوّر دلوقتي]  [🖼 من الصور]
                       → client-side compress → preview → progress bar
Step 5 — مراجعة        everything on one screen, one «تأكيد الإرسال» button
  ↓
✅ نجاح — «تم استلام إيصالك رقم R-2026-00417»
   «هيتراجع خلال 48 ساعة وهنبعتلك رسالة أول ما يتصدّق عليه.»
   [شوف إيصالاتي]  [ارجع للرئيسية]
```

Rules:
- One question per screen. A back button that never loses entered data.
- Progress is saved as a local draft — if the connection dies at step 4, nothing is retyped.
- The compound's InstaPay/bank details are shown **on step 3**, with a copy button, because that is
  the moment the resident needs them.
- Duplicate warning: if amount + date + image hash matches an existing receipt, warn before submitting
  — "شكل الإيصال ده اترفع قبل كده يوم …، متأكد؟"
- Upload retries automatically 3× with backoff before showing an error, and the error offers
  "احفظ وحاول بعدين" rather than losing the work.

### 4.2 Admin reviews (must be clearable on a phone in 10 minutes)

One full-width card per pending receipt:

```
┌────────────────────────────────────────┐
│  [ receipt image — tap to zoom ]       │
│                                        │
│  د. أحمد محمود · عمارة 5 شقة 12        │
│  1,500.00 ج.م · اشتراك الصيانة السنوي  │
│  إنستا باي · تحويل يوم 12/07/2026      │
│  رقم مرجعي: 88213                       │
│  «دفعت عن سنة 2026»                     │
├────────────────────────────────────────┤
│  [ ✅ اعتماد ] [ ❔ محتاج توضيح ] [ ❌ رفض ] │
│  تعديل المبلغ ▾                          │
└────────────────────────────────────────┘
```
- Swipe or tap; after a decision the card animates away and the next appears. Undo available for 10 s.
- Reject and needs-info **require** a reason from a preset list + free text; the reason is shown to
  the resident verbatim.
- Amount correction requires a reason and shows both figures in the audit log.
- Batch approve is deliberately **not** offered. Approving money should cost one deliberate tap each.

## 5. Component states — every one is designed

For each screen, define all six. Never ship a screen missing one.

| State | Rule |
|---|---|
| **Loading** | Skeletons that match the final layout. Never a spinner alone on a data screen. |
| **Empty** | Explains *and* offers the next action. Not "لا توجد بيانات" — instead "لسه مرفعتش أي إيصال. اضغط «دفع جديد» وارفع صورة التحويل." |
| **Error** | Plain Arabic, what happened, what to do, a retry button, and a support contact. Never a code or a stack trace. |
| **Success** | Explicit confirmation with the artifact (receipt number) the user can quote later. |
| **Offline** | Banner "مفيش نت دلوقتي — بنعرضلك آخر بيانات محفوظة"; cached totals stay readable; writes queue. |
| **Partial/degraded** | If images fail to load, the data still renders. Never a blank page. |

## 6. Status chips

| Status | Text | Color | Icon |
|---|---|---|---|
| draft | مسودة | `--ink-muted` on `--surface-2` | edit |
| submitted | تم الإرسال | `--warn` on `--warn-soft` | send |
| under_review | قيد المراجعة | `--warn` on `--warn-soft` | clock |
| needs_info | محتاج توضيح | `--info` on `--info-soft` | help-circle |
| approved | تم الاعتماد | `--ok` on `--ok-soft` | check-circle |
| rejected | مرفوض | `--danger` on `--danger-soft` | x-circle |
| duplicate | يحتمل إنه مكرر | `--danger` on `--danger-soft` | copy |
| cancelled | ملغي | `--ink-muted` on `--surface-2` | slash |
| reversed | تم عكسه محاسبيًا | `--ink-muted` on `--surface-2` | rotate-ccw |

Wording for `duplicate` is deliberately neutral — *"يحتمل إنه مكرر — محتاج مراجعة"* — never an
accusation of a resident.

Always all three signals — color **and** text **and** icon.

## 6a. Photo safety — before any album is published

Village photos routinely capture things nobody meant to publish.

- **Strip EXIF on upload**, geolocation above all. A maintenance photo can otherwise broadcast a
  resident's exact flat.
- A publishing checklist the editor must tick: no identifiable children · no flat interiors ·
  no documents or papers legible in frame · no license plates · no one photographed without consent.
- Faces of workers and board members are fine in a work context; residents' families are not, absent
  a board consent policy.
- Receipt images are **never** part of an album, at any tier.

## 7. Accessibility for elderly users

- Body text floor 17px; a site-wide "تكبير الخط" toggle (17 / 19 / 22px) persisted per user.
- Tap targets ≥ 48×48px with ≥ 8px between them. Nothing important within 16px of a screen edge.
- No hover-only affordances, no long-press-only actions, no swipe-only navigation — every gesture
  has a visible button equivalent.
- No time-limited UI except the OTP, and its countdown is large with an easy resend.
- Confirmation before anything irreversible, phrased as a question with the consequence spelled out.
- Bottom navigation with 4 items max: الرئيسية · إيصالاتي · فلوس القرية · أخبار.
- A permanent floating "محتاج مساعدة؟" button that opens WhatsApp to a board member.
- Test on a real 5-year-old Android device, and ask one actual elderly resident to complete a payment
  unassisted before launch. **This test is a CP-7 gate, not a nice-to-have.**

## 8. Data visualization rules

- Expense breakdown: horizontal bars sorted descending, not a pie chart — pies are unreadable at
  phone width with 12 categories. Show the amount and the percentage as text on every bar.
- Income vs. expense over time: a simple two-series column chart, monthly.
- Treasury balance: a single large number with a one-line plain-Arabic caption
  ("ده اللي متبقّي في خزنة القرية النهارده").
- Every chart has a "شوف الأرقام" toggle that reveals the underlying table — charts are a convenience,
  the table is the truth.
- Follow the `dataviz` skill's palette and accessibility guidance; colors must survive grayscale.

## 9. Performance budget

| Metric | Budget |
|---|---|
| JS shipped to the home route | ≤ 120 KB gzipped |
| LCP on 3G | ≤ 2.5 s |
| Image upload after compression | ≤ 500 KB |
| Fonts | Arabic subset only, `font-display: swap`, self-hosted |
| Dashboard queries | ≤ 3 round trips, served from views |

## 10. Copy guidelines (Egyptian Arabic)

- Speak the way a helpful neighbour speaks. "ارفع صورة التحويل" not "يرجى إرفاق مستند إثبات السداد".
- Address the user directly (إنت), warmly, never bureaucratically.
- Errors never blame the user: "الصورة كبيرة شوية، ممكن تجرّب صورة تانية؟" not "خطأ: حجم الملف غير صالح".
- Every number in the UI carries its unit: `ج.م` always visible.
- Dates in Arabic with the Gregorian calendar: "12 يوليو 2026".
- All strings live in `messages/ar.json`. Reading a hardcoded string in a component is a review failure.


---

## ⚠️ Village map — restored 2026-08-08 from the v1.1 spec revision

The pack's specification files are **v1.1 — village-map revision**; the copies this project was
built from are v1.0 and omit every map paragraph, along with constraint **C13**, product goal 4 and
`07_VILLAGE_MAP_SPEC.md`. Found by diffing the uploaded packs against this repo, twenty-seven
sessions in (INSIGHTS 2026-08-08, R-084).

Restored below rather than by replacing the file, because these copies carry local amendments the
pack does not have. `07_VILLAGE_MAP_SPEC.md` remains authoritative for the map.

### 4.3 Resident uses the village map

```
[الرئيسية] → «خريطة القرية»
  ↓
[خريطة إرشادية + تنبيه إنها مش مخطط مساحي]
  ↓                         ↘
[اضغط منطقة موثقة]          [أو اختار رقم العمارة من قائمة كبيرة]
  ↓
[بطاقة العمارة: حالة الربط + المعلومات العامة المسموحة]
  ↓
«افتح سجل العمارة»
```

- The current supplied image is shown as **partial and unverified**, with the visually apparent
  `14–46` range presented only as a preliminary selector until the board confirms it.
- A resident never has to accurately tap a small building. Search/list selection is equally capable.
- Hotspots are real 48×48 px minimum buttons with keyboard focus, Arabic labels, and a matching
  text-only list.
- On mobile, details appear below the map and receive focus. On desktop, map and details sit side by side.
- The map has explicit zoom in/out/reset controls; pinch/wheel is enhancement only and never traps scrolling.
- If the image is offline or blocked, the numbered list and authoritative building records still work.
- No financial colour appears until the board approves Q11/Q22. If enabled later, every colour has
  accompanying text and icon and uses approved ledger values only.
- `07_VILLAGE_MAP_SPEC.md` is authoritative for data provenance, publication, privacy, and acceptance.

## 5. Component states — every one is designed
