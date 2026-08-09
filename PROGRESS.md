# PROGRESS — living state of the work

> **Agent: this file is your memory.** Read it first, update it last, every single work block.
> If it is stale, the next session starts blind and repeats work you already did.

---

## Current position

| | |
|---|---|
| **Checkpoint** | CP-5 gates met · CP-6 done · CP-7 statement+a11y+quiet-hours+EXIF done · CP-8 restore gate MET |
| **Status** | 🟢 **~726 checks green** (107 unit · 473 access · 48 ledger invariants · 34 demo · 12 restore-drill · 2 lint · typecheck · **41 screens** · **0 WCAG violations across 84 page-scans, 360px and 1100px**). ✅ **The deployed Worker is current** (redeployed 2026-08-08, version `0c661b6b`) and migration `0026` is applied to the live D1. The password and recovery-code flows were driven end-to-end on the live site. |
| **Last updated** | 2026-08-08 (session 33) |
| **Updated by** | agent |
| **Blocked?** | **Not blocked for building.** Everything still open needs a *person*, not a commit: an accountant's sign-off on the chart of accounts and the الوديعة treatment, a lawyer on the privacy notice (PDPL 151/2020), the board's real register, and an elderly resident to watch. |

### What changed in session 34 — ⭐⭐ walking the whole product in a browser

The owner asked for the obvious thing nobody had done: *«ادخل على الأبليكيشن واعمل كل السيناريوهات
المتاحة بكل الـroles وشوف هل فيه أي مشاكل».*

Two new tools, both in `package.json`: `npm run dev:demo` boots the **real** app on a real port
against the demo village with a session per role, and `npm run walk` drives it in Chromium as each
of the six audiences — every screen in every role's menu, plus the journeys that matter: submit a
receipt, approve one, reject one with a reason, record an expense, create an account, issue a
temporary password, publish an announcement, change a setting, print recovery codes, redeem one.
**192 screenshots**, and `npm run walk:report` turns them into an Arabic PDF.

**It found seven real defects, two of them blockers, and every existing suite was green.** That is
the finding worth keeping:

* **The payment wizard could not be completed.** Steps 1 and 4 had no submit button. Step 1 is a
  single input, so a desktop browser implicitly submits on Enter and the bug is invisible there —
  but a phone shows a numeric keypad with no Enter key. Step 4 has three fields, so implicit
  submission does not apply anywhere. The central journey of the product, unfinishable (R-117).
* **A resident could not send a receipt on the demo database at all.** `trg_no_real_payments_in_demo`
  refuses ids that do not start `DEMO`; the app minted `PAY…`. On the site the board is shown, the
  last button answered with a database sentence half in English. Invisible to every test, because
  every test runs with `env_guard='test'` (R-118).
* **The review queue offered اعتماد / رفض to the finance_reviewer**, whose role is to audit and never
  approve — and the POST answered 403. The same screen was missing from their menu, because the menu
  gated it on the capability its *buttons* need rather than the one the *screen* needs (R-119/R-120).
* The mandatory receipt photo was announced only by failing at the end (R-121), and the publishing
  form asked «المشكلة في إيه؟» then said nothing at all after publishing (R-122).

All seven fixed, `tests/access/journeys.test.ts` added (10 checks) so each fails on the day it
returns, and `npm run verify` is 473 access checks green. The walkthrough now reports **0 findings**.

**The lesson:** `screens` proves the server emits HTML, `a11y` proves that HTML is accessible, and
the access tests prove the right people reach the right routes — **none of them asks whether there
is a way forward from the screen**. That question needs a browser.

---

### What changed in session 33 — a second and a third way in

The owner's instruction, after the Samsung Pass finding: *«ضيف في صفحة الlogin خيار الpassword …
الأدمن بيبعتله باسورد مبدأي عشوائي زي الtoken، والشخص يقدر يغيّره بعدين ويستخدمه لما البصمة تبقى مش
شغّالة، وبرضه ضيف مكان للأكواد الاسترجاعية.»*

`AGENTS.md` lists "Email or password auth" under **Never**, and that rule was written for a good
reason. It is overridden here on the record, for a fact found in the field rather than a preference:
a phone with no platform authenticator **cannot enrol a passkey at all**, so for its owner the portal
was not harder — it was shut. Everything built is arranged to keep the password *second*:

* **No password exists until an admin issues one.** `POST /admin/members/:id/password` generates it
  (`ABCD-EFGH-JKLM`, an alphabet with no `0/O`, `1/I/L`, `5/S`, `2/Z`), shows it **once**, and stores
  only a PBKDF2-SHA256 hash at 210,000 iterations — the cost in a **column**, so it can be raised
  later without locking anyone out. The board never chooses it and can never be shown it again.
* **Guessing is bounded** — five attempts per 15 minutes per IP *and* per number, and a wrong
  password and an unknown number return byte-identical responses, so the screen cannot be used to
  enumerate which numbers have accounts.
* **`/me` replaces it.** A temporary password lands the person on `/me`, not the home page, because
  that is the one moment they are certainly looking at a secret that travelled through WhatsApp.
  Changing it requires the current one — a session is "this phone is unlocked", not "I chose this".
  They can also delete it and go back to passkey-only.
* **A password never outlives the account or the recovery.** Two triggers in `0026`: stopping an
  account deletes it, and fulfilling a recovery deletes it — otherwise "we stopped his account" is
  false in exactly the case somebody says it out loud, and a recovery hands the account back to
  whoever has the phone.
* **The third way in now has a home.** Recovery codes used to be printed at exactly one moment —
  activation — and never again, so anyone who spent them, lost the paper, or was given a password
  instead of a link had nothing, and the «ادخل بكود» box on the login screen was addressed to a
  person who could not exist. `/me` now shows how many are left and prints a fresh sheet, retiring
  the old one in the same batch.

**The bug the tests found, which no amount of reading would have:** `auth_attempts.scope` is a closed
`CHECK (scope IN (…))` written before passwords existed. Inserting `'password'` did not silently
misbehave — it aborted the whole login request, so *every* password login returned the refusal and
the rate limiter counted nothing. The schema refusing an unknown value is the control working;
migration `0026` rebuilds the table with the value added.

**The bug only a live request could find:** PBKDF2 was set to 210,000 iterations, which is
OWASP-shaped, and green in every test. Cloudflare Workers **refuses any count above 100,000** —
`NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported` — and Node's
WebCrypto has no such cap, so the first real request against the deployed Worker returned a 500.
Set to the ceiling with the reasoning written at the constant, plus a test asserting the *platform*
limit so the next bump fails the build. This is the third time this project has shipped something
that passed in Node and failed in Workers (R-115). Verified end-to-end on the live site afterwards:
board issues → resident logs in → lands on `/me` → changes it to an Arabic passphrase → old one
refused → prints six codes → redeems one with JavaScript off. Cleaned up (R-116).

**The lesson:** a mechanism that forces a test per mutation earns its keep at the moment you add
one. `MUTATING_FUNCTIONS` failed the build the instant `reissueOwnRecoveryCodes` was written without
a coverage test — before it ever ran against a resident.

---

### What changed in session 32 — ⭐ the phones that could not hold a passkey

The board narrowed it themselves, in one sentence that solved what two rounds of my theorising had
not: *"في موبيلات البصمة فيها متسجلة على Samsung Pass أو Google Pass بتشتغل، وفي موبيلات تانية لأ."*

The script checked `window.PublicKeyCredential` and nothing else. That object exists on every modern
browser; what differs between phones is whether a **platform authenticator** — Samsung Pass, Google
Password Manager, a screen lock — exists to hold the key. That question has an API of its own,
`isUserVerifyingPlatformAuthenticatorAvailable()`, and the code never asked it. So the button was
offered, pressed, and failed with `NotAllowedError`, which the catch turned into «مقدرناش نتأكد إنه
إنت. جرّب تاني» — telling a resident their fingerprint was not recognised when their phone had never
been able to try, and advising the one action that cannot possibly work.

Fixed: the capability is detected before the button is offered; when it is absent the page says what
to do and **disables** the button rather than leaving a control that swallows presses; every WebAuthn
error name now has its own sentence with the DOM error name appended for reporting; and a phone that
genuinely cannot hold a passkey is pointed at the six recovery codes already printed on that page,
each of which is a working single-use login.

Reproduced both populations in Chromium — with a virtual authenticator (enrols, reaches
`/activate/done`) and without one (names the cause, disables the button, offers the codes).

**The lesson worth carrying:** a user who tells you which machines work and which do not has already
done the bisection. Ask for that comparison first.

---

### What changed in session 31 — ⭐ the activation link that WhatsApp ate

The board's report was exact and is the whole diagnosis: *"لما بعمل لينك تفعيل وبعمل open بيشتغل،
لكن لو نسخته وبعته على الواتساب يقول تم استخدام هذا اللينك بالفعل."*

`GET /login/activate?t=…` called `consumeActivationChallenge` in its handler, which made the link
single-**fetch** rather than single-**use**. A URL is opened by far more than the person it was sent
to: paste one into WhatsApp and Meta's servers fetch it immediately to build the preview card, so
the token was spent before the resident's phone even buzzed. Browser prefetch, antivirus link
scanners and mail-security rewriters do the same, which is why the failure looked random and
depended on the channel.

**This made onboarding the village impossible in practice** — the entire CP-2 plan is "the board
sends 204 people a link on WhatsApp".

Two more things the same handler was doing: it issued a real `set-cookie` session to whatever
fetched the URL, and its page greeted the resident **by name** — so a crawler received both a live
session and a village member's name.

The GET now peeks and renders a button; the POST spends the token. The confirm page sets no cookie,
carries no personal detail, and is `noindex, nofollow, noarchive`. The regression test fetches a live
link five times over — standing in for the crawlers — before pressing it.

**The lesson is in INSIGHTS and is worth reading twice:** HTTP requires GET to be safe for exactly
this reason, and *a bug report that names the channel is naming the cause*.

---

### What changed in session 30 — accounts, and the wall down the middle of them

The board asked for one rule: **the developer and the board create and edit accounts, and every
account holder edits some of their own details — but not the ones the account was created from.**

The split is the design, so both halves are named explicitly in `migrations/0025`:

| Created from — board only | Editable by the owner |
|---|---|
| the register name · the LOGIN number · the role · the flat · active/stopped | a second contact number · preferred channel · one note to the board |

Each field on the left already had its own audited mutation; what was missing was the ability to
**create** an account at all (only the bulk importer existed) and to **correct** a name or move a
flat. Those are now `createProfile`, `renameProfile` and `setUnitOwner` on `/admin/users` —
`setUnitOwner` closes the previous ownership row with today's date rather than overwriting it,
because January's receipt still has to name whoever owned the flat in January.

**The right-hand column's security property is in the signature.** `updateOwnProfile` takes **no
target id**, so it cannot name another person — not "checks that the target is you", takes none —
and its SQL names three columns, so a resident promoting themselves is not a case it defends against
but one it cannot express. `tests/access/accounts.test.ts` posts `role=admin`, `full_name`,
`is_active=0`, a unit, a phone and two foreign profile ids into `/me` in one request and then asserts
every one of them was ignored while the contact number went through.

Two defects of my own, both found by looking rather than by a test: the per-row flat picker rendered
204 `<option>` elements into each of 205 rows — **42,842 elements, 3.3 MB** — and is now two numeric
boxes resolved server-side (123 KB); and `verify_ledger.py` broke in three places on
`INSERT INTO profiles VALUES (?,?,?,?,?,?,?,?,?)` with the count typed by hand.

---

### What changed in session 29c — the layout nobody had opened

The owner sent a screenshot of the LIVE site, and it carried two separate facts.

**One:** the deployment is several sessions behind the repository. No drawer, no avatar, no bell, the
old «أدوات المجلس» card, «عمارة — شقة —» in the greeting. Everything reported missing is fixed on the
branch and invisible in production until somebody deploys. **Do not judge this product from the live
URL right now** — use `preview/demo.html` or `npm run dev`.

**Two,** and this was new: the screenshot is the **≥900px layout**, and that branch is a second
product. It swapped the whole navigation — and what it swapped in was the FIVE resident tabs reused
as a sidebar, leaving the other twenty-four destinations behind a ☰ nobody looks for next to a
visible rail. The same media query also reset `header` to `z-index:20`, putting the bar back under
the drawer panel and re-breaking the uncloseable drawer **in that branch alone**. Neither is visible
in a phone screenshot; both were sitting in front of the owner on a tablet-width browser.

Both shells now render from one `menuBody`, the wide layout gets the full grouped rail with identity
and sign-out, and `tests/access/shell.test.ts` compares the two menus' hrefs so they cannot drift
again. `npm run a11y` now scans at 360px **and** 1100px — 84 page-scans, 0 violations.

---

### What changed in session 29b — the shell, walked instead of screenshotted

The owner reported the sidebar as incomplete: missing tabs, no logout, a dead bell, thin map detail.
Every one of those was real, and the first was the symptom of something worse.

- **The drawer could not be closed.** The open panel covered the `<summary>` that toggles it —
  `elementFromPoint` over the ☰ returned a group heading — and the dim behind it was a
  `box-shadow`, which is painted but never hit-tested, so taps on the "backdrop" fell through and
  navigated to whatever link was underneath. With no JavaScript the summary is the only control
  there is. Opening the menu was a one-way trip.
- **Nothing was missing from the menu; the fold was invisible.** 29 links, 1681px of content in an
  844px panel, no cue that it scrolled. Reported, reasonably, as "tabs missing".
- **There was no way to sign out.** «تسجيل الخروج» has sat in `messages/ar.json` since CP-4 with
  nothing rendering it and no route behind it. The only exit was «اقفل كل الجلسات», which ends every
  session on every device.
- **The bell was dead** because the demo had zero notifications, and **every building page was a
  dead end** because `albums.building_id` (added by migration 0023) was never populated and
  `maintenance_tickets.unit_id` was always NULL — so all 34 buildings showed a count, a total and
  «مفيش شغل منشور». One demo ticket named «عمارة 5», which does not exist in a village numbered
  14–47.

Fixed, and now tested rather than looked at: `tests/access/shell.test.ts` asserts the markup that
makes closing possible, that the menu is built from `can()` (an admin sees seventeen board
destinations, a resident none of them), and that signing out revokes the session ROW — a cookie an
attacker already copied is not a sign-out — while leaving the person's other device alone. The
building page's new per-flat list rides the same Q11 assembly gate as the aggregate beside it,
because per-flat is strictly more revealing and a second screen quietly publishing what the first
withholds is how a privacy setting stops meaning anything.

---

### What changed in session 29 — the four screens that had no door

The owner asked for the sandbox prototype's interface, "with enhancements". Rebuilding the shell
(sticky app bar, a no-JS `<details>` drawer, KPI queue cards, the inverted treasury card) was the
visible half. Walking the sandbox's navigation against the app's route table was the half that
mattered: **four of its destinations had no route at all**, and two of them were whole procedures
with a tested data layer and no way in.

- **`/me` — حسابي.** Passkeys are this product's entire authentication story, so an enrolled device
  the owner does not recognise is the only visible symptom of a compromised account. There was
  nowhere to look, and no way to revoke one.
- **`/admin/ledger` — دفتر القيود.** `/finance` answers *how much*; nothing answered *on what basis*.
  The journal could only be read with `sqlite3` against production. Paged 25 at a time — the demo's
  250 entries rendered as one 17,000-pixel wall before that.
- **`/admin/import` — استيراد سجل الملّاك.** `lib/import/owners.ts` and `commitImport` have parsed
  and committed owner registers since CP-2, behind three JSON endpoints. So the real path to 204
  accounts was "send the Excel file to the developer" — the exact failure this product exists to end.
- **`/admin/recoveries` — الاستعادة والتفعيل.** Two-admin assisted recovery, identity check, session
  and passkey revocation: all built, all tested, all unreachable. The one procedure for *"my phone
  was stolen and my account holds a year of payments"* could not be run by the board it was written
  for.

Also: **the demo's `audit_log` was empty**, so «سجل التغييرات» — the screen the board is being asked
to trust — rendered its empty state, and the dashboard's activity strip could not appear. The seed
now records every state change it fabricates (592 rows) with the same action slugs `mutations.ts`
writes. And a board member who owns no flat was greeted with «عمارة — شقة —» above «إجمالي المطلوب
منك 0.00» and a «دفع جديد» button: three statements, each false about them, on the first screen they
see.

`tests/access/onboarding_ui.test.ts` (9 tests) drives both new procedures as real HTTP forms and
then asserts against the **database** — a 200 from a confirm button that created nothing is exactly
the failure that would otherwise have shipped. It proves one admin cannot complete a recovery alone,
and that the stolen phone's cookie stops working.

---

### What changed in session 28 — the specification was not the specification

The owner uploaded a zip of every earlier build and asked for a deep comparison. The comparison
found something larger than a feature gap: **`07_VILLAGE_MAP_SPEC.md`, constraint C13 and product
goal FOUR — village navigation — are in the v1.4 spec pack and absent from the copy this project
was built from.** Twenty-seven sessions against a truncated specification. All seven spec files have
now been diffed heading-by-heading; the map is the only divergence, and every paragraph of it is
restored.

Following the comparison rather than the code then turned up **the largest defect in the project**:
`/admin/review` renders an «✅ اعتماد» button posting to `/admin/review/:id`, and that route did not
exist. Worse, `reviewPayment` links a `journalEntryId` its caller supplies and **nothing anywhere
created one** — so no code path could post a payment at all. The portal could display a year of
accounts it had been handed and could not record one receipt. 377 access tests passed throughout,
because every one of them either called the data layer directly or wrote the ledger by hand in a
fixture.

Built this session: the approval path (`lib/db/approve.ts` + the route), the orphan-entry guard
(0024) which immediately exposed the same shortcut in six fixtures, the demo seed and
`verify_ledger.py`, `/help` (a 404 behind the floating button on all 34 screens), and the village
map — `/map`, `/buildings/:id`, `/admin/map`, with C13 enforced structurally.

**The lesson to carry forward** is in INSIGHTS: a test that constructs the state it asserts about
cannot discover that the product cannot reach that state. The check that finds this class of bug is
to name the sequence of taps from the login screen and then drive exactly that. Two of the three
biggest defects here were found by asking it.

---

### What changed in session 27

The board can now **operate** the village from the product. Six configuration screens went in —
fees, categories, roles, settings, staff, audit — plus settlements and a members screen. Before
this session every one of those tables existed in the schema and could only be changed by a
programmer running SQL, which is the exact dependency this project exists to remove.

Three things were not merely missing but *wrong*, and are worth carrying forward:

1. **`exif_stripped` was a claim, not a control.** Both upload paths passed `exifStripped: true`
   on bytes nothing had parsed; the stripping happened in the browser. A request that skipped the
   page stored a photo with the GPS coordinates of a flat and a column saying otherwise. Now
   `lib/storage/image.ts` parses the container server-side.
2. **`deactivateCategory` had its rule backwards** — it blocked on settled history (making
   retirement impossible) and the reassignment it demanded would have rewritten last year's chart.
3. **Quiet hours were stored, displayed, and read by nothing.** A switch the board turns on that
   changes no behaviour is worse than no switch.

The pattern in all three: the control existed at the layer that is easy to write and not at the
layer that decides. That is the same lesson as CP-8's restore drill, and 0022 repeated it in
miniature — freezing published dues immediately broke the demo seed, three test fixtures and the
backup, all of which had been writing a state the application can never reach.

---

## Checkpoint status board

| CP | Name | Status | Gates met | Notes |
|---|---|---|---|---|
| 0 | Discovery & contracts | 🟢 done | 3/4 | Q19/Q20 answered 2026-08-04. Outstanding: written board sign-off on the category taxonomy |
| 1 | Data foundation & security | 🟢 nearly done | 6/8 | **Access-test gate MET (20/20 over HTTP).** Outstanding: real D1 verification, CI |
| 2 | Authentication | 🟢 nearly done | 6/8 | Passkeys, activation, printed-code recovery, **two-admin assisted recovery**, **bulk import** — and as of session 29 all three have SCREENS (`/me`, `/admin/import`, `/admin/recoveries`), so the procedures are reachable by the board rather than by a developer with `curl`. `/me` lists enrolled devices and revokes one. The 2 open gates need a **real phone against a real origin** — neither can be closed from this sandbox |
| 3 | Read-only transparency | 🟢 **gates met** | 2/2 | `/finance`, `/finance/units`, `/admin/health` built. Rendered figures verified against hand-computed literals **and** against raw SQL. **Found and fixed a real arrears bug (R-043).** Outstanding: a period filter, before year two |
| 4 | Payments | 🟢 nearly done | 3/6 | Wizard, upload, duplicate warning, review queue, idempotent posting, **reversal**, decision notifications. The 3 open gates need a **real phone on a real network** — nothing else. *(Ticked 2026-08-05 after finding the boxes had drifted from the code for several sessions.)* |
| 5 | Expenses & fees | 🟢 **gates met** | 8/8 | Record → countersign → post → reverse from a phone with no JS · invoice photo · **fee periods & dues generation** (`/admin/fees`, draft→distribute→publish, amounts frozen at publication by 0022) · **reconciliation, credits and period close** (`/admin/settlements`) · categories, roles, settings, staff, audit. Outstanding: monthly statement snapshots |
| 6 | Content & memory | 🟢 **gates met** | 2/2 | News, albums, minutes, maintenance tickets, Arabic search with orthographic folding (`lib/search/fold.ts` — unicode61 does NOT handle Arabic, R-033). Both gates asserted over HTTP |
| 7 | Notifications & polish | 🟡 partly | 1/6 | Web Push + inbox + annual statement + theme/font-size with no JS + **quiet hours actually honoured** + **server-side EXIF stripping**. The remaining gates are observation gates — an elderly resident, Lighthouse, a WCAG audit — and none can be met from a sandbox |
| 8 | Hardening & handover | 🟡 partly | 2/7 | **Restore drill MET** (proves `.dump` fails first, then restores and compares 14 figures) and the deploy workflow. Outstanding: the Arabic admin manual, monitoring, the accountant and the lawyer. This is the checkpoint that decides whether the board can run this without me |

---

## Work log
*Newest first. One entry per work block.*

### [2026-08-08] — session 29b · the shell nobody had walked
**Owner:** *"why the side bar not complete with all tabs, not logout tab, not bell icon and the map
details, many things missing, re check correctly and do not miss anything."*

Every item was real. The report of "missing tabs" turned out to be the mildest of them: the menu was
complete and simply scrolled without saying so, while the drawer it lived in **could not be closed**
— the panel covered its own toggle, and the dim behind it was a `box-shadow`, which paints a
backdrop and hit-tests as nothing, so tapping "outside" navigated to whatever link was underneath.

Built: a scrim that is an element, a panel positioned against the header so the bar stays above it at
every text size, a ☰→✕ glyph, an identity block inside the panel (the open panel covers the app bar,
so the name and role have to be repeated where you can see them), `POST /logout`, notifications in
the demo seed, and a building page with the flats, the tickets and the album on it.

**Four things worth carrying forward:**

1. **When a component's only control is one element, assert that element is topmost at its own
   coordinates.** One line of `elementFromPoint` found both halves of the drawer bug. Neither is
   visible in a screenshot — the menu looks perfect open.
2. **A layout constant that tracks something the browser already knows will fall out of step.** The
   first fix used `--bar:58px`, counted by hand. Measured: 68px, across three text sizes that each
   would have needed their own number. `inset-block-start:100%` against the header is exact and has
   nothing to maintain.
3. **A single CTA string across differently-shaped rows is a lie waiting for data.** Every inbox
   message said «شوف الإيصال»; correct while the only messages were payment decisions, wrong on two
   thirds of them the moment the demo had announcements in it.
4. **A privacy gate has to cover every screen that reveals the fact, not the screen it was written
   for.** The building page's new per-flat list is strictly more revealing than the per-building
   aggregate beside it, so it rides the same `unit_status_public` setting — with a test that fails if
   it ever stops doing so, and a second one asserting no owner NAME reaches the page body at any
   setting.

### [2026-08-08] — session 29 · the sandbox interface, and the four screens behind it
**Owner:** *"get all the features, GUI, UIUX from the HTML pages zip and integrated in the app, and
make the GUI and UIUX similar to `qaryat_atebaa_full_sandbox_v3-1.html` with enhancements."*

**Built:** the app shell (sticky bar with avatar/name/role, a `<details>` drawer with four grouped
sections and `aria-current`, KPI queue cards driven by real counts, the inverted treasury card with
its income/expense line, latest announcements, an activity timeline) · **`/me`** · **`/admin/ledger`**
(paged) · **`/admin/import`** · **`/admin/recoveries`** · `lib/db/onboarding.ts`'s
`recoveryCandidates` and `issueRecoveryActivation` · a 592-row audit trail in the demo seed
(`005_audit.sql`) · `tests/access/onboarding_ui.test.ts`.

**Four things worth carrying forward:**

1. **A screen with no route is indistinguishable from a missing feature — and the tests cannot tell
   you which.** `requestRecovery`/`approveRecovery`/`fulfilRecovery` were fully tested and entirely
   unreachable. This is the same lesson as session 28's `/admin/review/:id`, arriving a second time
   from a different direction: *the check that finds it is to name the sequence of taps from the
   login screen and drive exactly that.* Walking a prototype's navigation against the route table
   found four instances in an afternoon.
2. **An empty audit log in a demo about accountability is not a neutral omission.** It is the screen
   that proves nothing happens behind anyone's back, showing nothing. The seed now writes the trail
   its own fabricated history implies — including that the 200 residents arrived as ONE reviewed
   import (two rows naming one person) rather than 200 silent inserts, because that is what the
   product actually does.
3. **`issueRecoveryActivation` is deliberately not `issueFirstActivation` renamed.** The latter
   exists to *refuse* anyone holding a passkey — that refusal is the boundary stopping an admin from
   minting a credential onto a live account. Reusing it after a fulfilment would work only because
   the passkeys were just revoked, and the next person to relax the guard would silently reopen the
   hole. The new function demands the opposite proof: a two-admin recovery that was fulfilled.
4. **Every scrollable region needs `tabindex="0"`.** The audit table grew past the viewport once the
   demo had rows in it, and axe failed the build on `scrollable-region-focusable` — a region that
   scrolls but cannot be focused is unreachable to anyone without a pointer.

**Two visible defects the screenshots found, not the tests:** a board member owning no flat was told
they owe 0.00 ج.م on a flat named «عمارة — شقة —», and the last control on the longest screen sat one
pixel under the floating help bubble (`main`'s bottom padding cleared the tab bar but not the FAB).

### [2026-08-05] — session 24 · closing the two gaps I made last session
**Owner:** *"Continue"* — both were named in session 23's self-critique.

**⭐ «شيل الصورة» — the only repair there is.** ADR-026's warning is advisory: an operator in a
hurry taps through it and a supplier's bank details reach 204 residents, and until now there was
**no repair at all**. Now there is one, and it is careful about what it claims: *«ده بيمنع أي حد
يشوف الصورة من دلوقتي ورايح — بس مش بيرجّع اللي شافها قبل كده. بلّغه.»* **Nothing can un-see an
image a resident already opened**, and a button that implied otherwise would be worse than none.

Three details worth keeping:
- It needs **`expense.countersign`, not `expense.record`.** Removing evidence is the opposite of
  recording it; if the role with no financial authority could do it, "delete the invoice" would be a
  power an operator holds. An operator who uploaded a bad photo has to tell an admin.
- **The money is untouched** — same amount, same status, same ledger entry. A mis-photographed
  invoice is not a wrong expense, and reversing money to fix a photo would be a far larger lie than
  the photo was.
- The storage row is **soft-deleted**, so the audit trail still shows something was there.

**And the evidence gap is now on `/admin/health`** — the number I computed last session and
displayed nowhere, which was me breaking my own rule from the session before. It reports how much
posted spending has no photo, with the sentence explaining why it matters: *«ده الرقم اللي حد هيسأل
عنه في الجمعية العمومية»*.

**A test I had to correct rather than satisfy.** `listPostedExpenses` had a test asserting the
invoice key is **never** exposed — written before ADR-026 existed, and wrong after it: evidence
visible to members is the entire point of attaching a photo. But the fix is not "always expose": when
the board closes `expense_invoices_public`, handing a resident a link that 403s tells them the
evidence is being hidden **from them specifically**, which is exactly the suspicion this feature
exists to remove. So the key is selected conditionally in SQL, and the test now asserts *that*.
**A test that encodes a superseded decision has to be rewritten with the decision, not worked
around.**

**Verified:** **436 checks, 0 failures** (89 unit + 263 access + 48 schema + 34 invariants + 2 lint +
typecheck + 14 screens).

**Self-critique:**
- *Adversarial:* Removal soft-deletes the storage row but **the bytes are still in `receipt_blobs`**.
  Anyone with database access can still recover the supplier's details. For a privacy repair that is
  a real gap — "removed from the site" is not "deleted" — and there is no purge job.
- *Fragility:* The invoice link now appears on the expense list for admins and residents alike, and
  its visibility is decided in two places: the SQL in `listPostedExpenses` and the check in
  `authorizeInvoiceRead`. They agree today. R-043 was born from exactly this shape.
- *Comprehension:* I still do not know whether an Egyptian supplier would object at all. Three
  sessions of careful design rest on a guess about a person nobody has asked.
- *Honesty:* Unchanged: **CI config exists but has never run**; the D1 gate has never run (A-05,
  R-031); the five credentials are still live (R-038, R-040); demo figures invented.

**Next action:** a purge for soft-deleted blobs — without it "شيل الصورة" is a privacy promise the
storage layer does not keep. Then CP-6, which is the last checkpoint with nothing started.

### [2026-08-05] — session 23 · evidence for money going out
**Owner:** *"Continue"* — the oldest unaddressed self-critique in this file.

`expenses.invoice_storage_key` existed since CP-1 and **nothing ever wrote it**. A 12,000 ج.م
maintenance line had no proof attached — the first thing a resident asks about, and precisely the
suspicion this project exists to answer.

**⭐ The photo is a SECOND, optional step — not a field on the form.** The expense form's whole
design claim is five fields, no JavaScript, sixty seconds, and an image needs JavaScript to compress
before upload. Putting it on the form would have cost the property the form exists for. So after
saving, the screen asks «تحب ترفق صورة الفاتورة؟» with a clear «من غير صورة» — and a volunteer
standing next to a plumber can skip it and come back. A test asserts the entry form still has no
file input, so this cannot quietly regress.

**⚠️ And a tension I did not paper over — ADR-026.** `01_PRD` C2 makes expenses visible to all
members, and a supplier's invoice usually carries the **supplier's phone number and bank details**.
That is a third party's personal data, from someone who never consented, under PDPL 151/2020. The
transparency requirement does not dissolve it, and neither side simply wins.

Three layers, in order of how much each actually helps:
1. **Tell the person holding the camera, before the camera opens.** «الصورة دي هيشوفها كل السكان —
   لو فيها رقم موبايل المورّد أو بيانات حسابه البنكي، غطّيها بصباعك وإنت بتصوّر.» The data never
   enters the system, which beats every later control. A test asserts the warning appears *above*
   the file input, not below it.
2. **Visible to members by default.** A hidden-by-default photo silently undoes the feature and
   nobody notices.
3. **`expense_invoices_public` — a setting, not a constant.** If a supplier objects, the board closes
   it without a deploy. Admins keep access, because they countersign against this evidence.

Automatic redaction was rejected outright: reliable text detection on a photographed Arabic invoice
is beyond this project, and **a redaction that misses once is worse than none, because everyone
stops looking.**

**Also:** `v_expenses_without_evidence` reports how much posted spending has no photo. Not every
expense needs one — a bank standing order has none — but *"how much of what we spent has no proof?"*
is a question a suspicious resident asks at the general assembly, and the board should know the
answer before they are asked it.

**And one structural detail worth keeping:** the invoice key is namespaced under its expense id, and
`trg_expense_invoice_key_shape` refuses a key that does not match its row. That is what lets
`authorizeInvoiceRead` resolve a key by **lookup** rather than by parsing a path — a path check is
one `../` away from being wrong; a lookup either finds the row or does not.

**Verified:** **427 checks, 0 failures** (89 unit + 254 access + 48 schema + 34 invariants + 2 lint +
typecheck + 14 screens).

**Self-critique:**
- *Adversarial:* The warning is the main control and it is **advisory**. An operator in a hurry taps
  through it, and a supplier's bank details reach 204 residents with no way to un-see them. Deleting
  and re-uploading is the only repair and nothing offers it — there is no "remove this photo" action
  at all.
- *Fragility:* `v_expenses_without_evidence` is computed and nothing displays it. I built the number
  and did not put it on `/admin/health` — the same "built but unreachable" pattern I wrote a rule
  about one session ago, in the same session I wrote the rule down.
- *Comprehension:* I do not know whether an Egyptian supplier would object to their invoice being
  visible to a compound's residents. It may be completely unremarkable, or it may be the thing that
  makes a contractor refuse to work with the village. The board knows; I guessed.
- *Honesty:* Unchanged: **CI config exists but has never run**; the D1 gate has never run (A-05,
  R-031); the five credentials are still live (R-038, R-040); demo figures invented.

**Next action:** put `v_expenses_without_evidence` on `/admin/health` and add a "remove this photo"
action — both are gaps this session created, and both are small.

### [2026-08-05] — session 22 · VAPID provisioning, and making R-069 loud
**Owner:** *"Continue"* — Web Push was complete and **unstartable**: nothing generated or stored the
key pair for a real deployment.

**`npm run gen:vapid`** — a one-shot generator that prints the public key, the private key, a short
**fingerprint**, and the four next steps in order. The fingerprint is the useful part: it lets the
board check the deployed key is the right one **without ever handling the private half**, and it goes
in the minutes next to the Cloudflare account details.

**⭐ And R-069 stopped being a warning in a comment.** Deploying a different VAPID key does not
"rotate" anything — it **orphans every subscription in the village**. Nothing errors: the push
service accepts the request and the browser silently drops a message from a sender it does not
recognise. Residents stop being notified one at a time, and the only signal is somebody mentioning it
months later.

So `migrations/0018` records the first key ever used and every send checks against it:
- a different key **refuses to send** and says which fingerprint to restore;
- `/admin/health` shows the mismatch in red, naming the recorded key;
- and the recorded row is **immutable** — `trg_vapid_identity_immutable` refuses an update and a
  delete. The honest repair for a mismatch is to put the **original key back**; letting someone
  "fix" it by editing the row would bless the orphaning. **A guard you can silence by editing a row
  is a guard that gets silenced by whoever is in a hurry.**
- ...and a mismatch **still** does not break a decision. A test rejects a receipt under a wrong key
  with a `fetch` that throws if called, and asserts the rejection lands and the inbox message exists.

**`/admin/health` now also shows push reach** — «{n} من {m} ساكن مشغّل التنبيهات» with a bar, the
dead-subscription count, the key fingerprint, and the sentence that matters: **«متفتكرش إن الكل
اتبلّغ»**. Q23's honest weakness is that some residents will never grant permission, and a board that
believes everyone was told stops following up by hand.

**A small consistency fix:** `VapidChanged` carried its Arabic reason only in `reasonAr`, so a log
line said just "vapid key changed". Same fix `Forbidden` needed in session 3 — the reason now lives
in `message` too. Third time this pattern has appeared; the rule is that **an error's `message` must
carry the sentence that says what to do**.

**Verified:** **419 checks, 0 failures** (89 unit + 246 access + 48 schema + 34 invariants + 2 lint +
typecheck + 14 screens).

**Self-critique:**
- *Adversarial:* The guard fires on the **first send after** a bad deploy. If a wrong key is deployed
  during a quiet week, nobody notices until a decision happens — `/admin/health` shows it, but
  nothing checks at boot and nothing alerts. The window is real and I have not closed it.
- *Fragility:* `gen-vapid.mjs` prints the private key to **stdout**, which lands in a terminal
  scrollback and possibly a shell history file. Every safer option needs tooling the board does not
  have. Written into the script's own header rather than pretended away.
- *Comprehension:* The board has to carry a fingerprint from a terminal into their minutes. I think
  that is the right shape — it is checkable and harmless — but nobody has tried it.
- *Honesty:* Unchanged: **CI config exists but has never run**; the D1 gate has never run (A-05,
  R-031); the five credentials are still live (R-038, R-040); demo figures invented; no invoice photo
  on the expense form.

**Next action:** the invoice photo on the expense form — the oldest unaddressed self-critique in this
file, and the first thing a resident will ask about when they see a 12,000 ج.م maintenance line.

### [2026-08-05] — session 21 · Web Push (owner answered Q23: browser notifications)
**Owner:** *"جرّب إشعارات المتصفح كمان"* — the only channel that reaches a resident's phone and
still satisfies C11.

**Built from scratch, no vendor:** no account, no card, no API key, and no company that can start
charging in October. The browser's own push service delivers it, and because RFC 8291 encryption is
done here, **neither Google nor Mozilla can read «اتقبل إيصالك»** — they relay an opaque blob.

The cost of "no vendor" is implementing two RFCs: **8291** (ECDH P-256 → HKDF → AES-128-GCM) and
**8292** (an ES256 VAPID JWT). WebCrypto only, so it runs unchanged on Workers.

**⭐ How it is verified without a browser or a network.** Push endpoints are unreachable from this
sandbox — the same wall as the D1 gate. And this code fails **silently**: a subtly wrong key
derivation produces a well-formed body the push service accepts with `201 Created` and the browser
cannot decrypt, so every message vanishes with a success response and nothing on our side looks
wrong. So the test reproduces **RFC 8291 §5's published vector byte for byte** — both keypairs, the
auth secret, the salt, the exact expected body. That pins every intermediate value, which is a
stronger check than "it seemed to arrive". Delivery to a real phone remains unproven (CP-7).

**Four decisions worth naming:**
- **⭐ Push can never break a decision.** The message is already in `notifications`, written in the
  same batch as the approval (R-065). Delivery runs *after* the transaction and every failure is
  swallowed and counted — a dead phone, a push-service outage, a rotated subscription. Two tests
  approve and reject a receipt with the push service returning 410 and 500 and assert the decision
  still lands. **Push is a courtesy on top of the inbox, never the record**; the other way round
  would make the village's books depend on Google's uptime.
- **⭐ The payload carries almost nothing.** A notification renders on a locked screen anyone
  standing near can read. It sends the title, the **first line** truncated to 120 characters, and a
  link. The amount, the receipt reference and the full reason stay behind the session.
- **⭐ The service worker has no `fetch` handler.** A worker that intercepts fetch can serve a stale
  treasury balance from cache and the resident cannot tell — on a financial-transparency site that
  is a lie the software tells by itself. A test asserts the handler is absent.
- **How many residents this reaches is a number, not an assumption** (`v_push_reach`). Push needs
  permission, and on iOS the site must be added to the home screen before Safari will even offer the
  prompt. Some residents will never do it — and a board that believes «كله اتبلّغ» stops following
  up by hand, which is worse than knowing nobody was told.

**Verified:** **409 checks, 0 failures** (89 unit incl. 13 push-crypto + 239 access + 48 schema +
34 invariants + 2 lint + typecheck + 14 screens).

**Also:** `public/sw.js` is a real, readable, lintable file; `tools/build-sw.mjs` inlines it into a
module at build time because Workers has no filesystem. The generator **refuses** rather than escapes
if the worker ever contains a backtick — which it did on the first run, from a word in my own comment.

**Self-critique:**
- *Adversarial:* Nothing generates or stores the **VAPID key pair** for a real deployment. There is a
  `generateVapidKeys()` and a warning that rotating it silently kills every subscription (R-069), and
  no tooling, no wrangler secret name, and no check that the deployed key matches the stored one.
- *Fragility:* `deliverPush` loops subscriptions serially and awaits each. One slow push service
  delays the HTTP response the admin is waiting on. It belongs in `waitUntil()`, which this code does
  not use because the test harness is not a Worker — a real gap disguised as a test-shaped one.
- *Comprehension:* I do not know whether a resident here will grant notification permission at all,
  and the iOS path (share → add to home screen → then enable) is three steps I have described in one
  sentence. CP-7 is the only thing that can tell me.
- *Honesty:* Unchanged: **CI config exists but has never run**; the D1 gate has never run (A-05,
  R-031); the five credentials are still live (R-038, R-040); demo figures invented; no invoice
  photo on the expense form.

**Next action:** VAPID key provisioning — a `wrangler secret` name, a one-shot generator command, and
the key recorded where the board can find it. Without it the feature is complete and unstartable.

### [2026-08-05] — session 20 · the inbox, and a question for the owner
**Owner:** *"Continue"* — the messages were written, addressed and unreadable.

**`/notifications`** — a resident's own messages, in the bottom nav with an unread badge.
The C6 predicate (`profile_id = ?`) is inside the query, because a notification body quotes an
admin's reason verbatim against a named receipt: **it is exactly as private as the receipt image**.
There is deliberately no admin override — an admin who needs to know what a resident was told reads
the payment's `review_reason_ar`, which is the same text under a capability that already exists.
A route that reads another person's inbox would be a new power nobody asked for.

**Three small decisions:**
- **The body keeps its line breaks.** Every decision message is *reason · blank line · what to do
  next*, and collapsing that to one paragraph buries the instruction — the half that keeps a
  resident off the phone to the board.
- **Opening the page marks everything read**, so there is no "mark as read" button to find. On a
  five-year-old Android held by someone who does not enjoy phones, a control that exists only to
  manage the interface is a tax.
- **...but the list is captured before the marking**, so the resident still sees which messages were
  new *on this visit*. Mark-then-render would highlight nothing, which is the same as not telling
  them.
- **Reading is NOT audited.** `mutate()` exists so a change to money or identity cannot commit
  unlogged. "سعاد opened her messages" is neither, and logging it would put one resident's reading
  habits in a table five people can read. **The audit log is for accountability over shared money,
  not surveillance of individuals** — written down because the reflex to "log everything" is exactly
  how the second thing happens by accident. A test asserts the audit log stays clean.

**🔴 And a question I could not answer myself — `Q23` in `docs/OPEN_QUESTIONS.md`.**
The messages exist and are correct, and **nothing notifies the resident's phone**. They will see it
only if they open the site — and the people who open the site unprompted are the ones who least need
telling. The حاج who uploaded a receipt and is waiting is precisely the one who will not.

Q20 (rightly) removed WhatsApp, and SMS costs money, so there is no free push channel. The question
lays out four options with honest costs and recommends **in-app + a board member sending a normal
WhatsApp message by hand** for v1 — which is realistic at 204 units and keeps the personal
relationship the village already runs on. Web Push is free and vendor-free if we want it later.

**Verified:** **392 checks, 0 failures** (76 unit + 228 access + 48 schema + 34 invariants + 2 lint +
typecheck + 14 screens).

**Self-critique:**
- *Adversarial:* The unread badge is threaded into **home and «إيصالاتي» only**. On `/finance` and
  `/news` the nav shows «رسايلي» with no count, so a resident sitting on the finance page has no
  idea a message arrived. Half-wired, and I am recording it rather than pretending it is done.
- *Fragility:* `listMyNotifications` caps at 50 with no pagination. Fine for years at this volume,
  and it fails silently rather than visibly when it stops being fine — the same shape as
  `/admin/payments`'s 50-row cap noted two sessions ago and still unfixed.
- *Comprehension:* Third session running I am guessing at tone with no reader. The inbox is where
  every one of those guesses lands at once.
- *Honesty:* Unchanged: **CI config exists but has never run**; the D1 gate has never run (A-05,
  R-031); the five credentials are still live (R-038, R-040); demo figures invented; no invoice
  photo on the expense form.

**Next action:** answer nothing new until Q23 comes back — it changes what the notification layer is
for. Meanwhile the invoice photo on the expense form, which is the oldest unaddressed self-critique
in this file.

### [2026-08-05] — session 19 · telling the resident
**Owner:** *"Continue"* — the ordinary decisions were silent. Only a reversal ever spoke.

**Approved, rejected, needs-info and duplicate now all reach the resident**, and the message is
written in the **same `db.batch()`** as the status change — so "decided but silent" is not a
representable state, rather than a queue somebody has to remember to drain.

**Why silence was the bug, specifically here:** a resident uploads a receipt, the screen says «تحت
المراجعة», and then nothing. So they ask in the WhatsApp group — **the exact habit this product
exists to replace**. Every silent success pushed one family back to the thing that caused the
problem. `01_PRD` A4 asks for the approval notification by name.

**Three wording decisions that are not cosmetic:**

- **⭐ A duplicate is not announced as a rejection.** The money arrived; it was counted once. A
  resident reading «اترفض» believes a real transfer was thrown away — now there is a phone call and
  a grievance over a receipt handled correctly. Same internal status class, completely different
  message: «الإيصال الأصلي اتحسب، فما تقلقش — الفلوس مش ضايعة». **The internal taxonomy is not the
  user's taxonomy.**
- **An adjusted approval says BOTH numbers and the reason.** Telling a family "accepted" after
  correcting 8,000 down to 6,000 is how they find the difference two months later and conclude money
  went missing.
- **A rejection is never the last word** — it ends «الرفض ده مش نهائي». A refusal with no next step
  sends the person to the board angry instead of to the screen.

**⭐ And a duplicate-message bug caught before it shipped.** `reviewPayment` is carefully idempotent
— a double-tapped approve changes 0 rows — but a notification riding in the same batch would be
written anyway, twice, on exactly the connection quality that makes people tap twice. Fixed with a
partial unique index (`ux_notif_payment_kind`) plus `INSERT OR IGNORE`: suppression at the
**database**, not check-then-insert in application code. **Whenever an operation is made idempotent,
audit everything that rides along in its transaction.**

**R-063's recorded weakness is closed.** It shipped with "`notified` matches on kind + link_path, not
payment id — a weak check that reads like a strong one" written into the risk register. One session
later that sentence was the specification for the fix: `notifications.payment_id`, and
`v_payment_notifications` covering **every** terminal decision rather than only reversal.

**Verified:** **386 checks, 0 failures** (76 unit + 222 access + 48 schema + 34 invariants + 2 lint +
typecheck + 13 screens).

**Self-critique:**
- *Adversarial:* Notifications are **in-app only**. Nothing pushes them, so a resident learns their
  receipt was approved only if they open the site — which is the population least likely to. The
  `channel` column allows `whatsapp`/`sms` and both are out of the stack (ADR-016), so this may be
  as far as it goes without a vendor. That deserves to be an owner question, and I have not written
  it as one.
- *Fragility:* There is **no screen** that lists a resident's notifications. They are written,
  addressed and unreadable — the same "built but unreachable" failure as session 18's reversal, one
  layer down, and I did it again in the same week.
- *Comprehension:* Every one of these strings is my guess at tone. «اتقبل إيصالك ✅» might read as
  warm or as curt; I cannot tell, and the CP-7 observed test is the only thing that can.
- *Honesty:* Unchanged: **CI config exists but has never run**; the D1 gate has never run (A-05,
  R-031); the five credentials are still live (R-038, R-040); demo figures invented; no invoice
  photo on the expense form.

**Next action:** the notifications screen — they are written and addressed and nobody can read them.
Then raise the delivery-channel question with the owner, since in-app-only may not reach the people
who most need it.

### [2026-08-05] — session 18 · the reversal screen
**Owner:** *"Continue"* — put payment reversal behind a screen. **A control nobody can reach is a
control that does not exist**, however many tests pass on it.

**`/admin/payments`** — approved receipts, with reversal offered only where it is allowed, and
`/admin/payments/:id/reverse` for the act itself. Plain form posts, no JavaScript.

**Three design decisions worth naming:**

- **⭐ The admin who approved a receipt is shown the reason, not a disabled button.** R-062 excludes
  them; the screen renders «إنت اللي اعتمدت الإيصال ده — مسؤول تاني هو اللي يلغيه» in the button's
  place. Same rule as the expense screen: an absent control with an explanation teaches *"I lack
  authority"*; a control that fails teaches *"this system is broken"*.
- **⭐ The second admin is a dropdown that never contains your own name.** `reversePayment` refuses
  self-approval anyway — but a two-person control whose picker offers you yourself invites the
  mistake and then blames you for it. A checkbox saying "I confirm a second admin agreed" was
  rejected outright: that is a lie waiting to be told, and naming a person puts someone on the
  record who can be asked.
- **The warning sits ABOVE the fields.** By the time an admin reaches the submit button they have
  decided. The banner says three concrete things — the resident was told it was accepted, their
  arrears come back, and they will read this reason verbatim — while the decision is still open. The
  instruction is «اكتبه كأنك بتكلّمه وشّ لوشّ»: the person writing has met the person reading.

**Verified:** **377 checks, 0 failures** (76 unit + 213 access + 48 schema + 34 invariants, 13
screens).

**A test bug worth recording:** the notification assertion ordered by `created_at DESC` and picked
the wrong row — `created_at` is second-precision, and two reversals in one second order arbitrarily.
Matching on the receipt number instead is both correct and clearer about what it is asserting.
"Newest" is not an identifier.

**Self-critique:**
- *Adversarial:* Approval, rejection and needs-info still send **no** notification. Reversal is the
  only decision a resident hears about — which is backwards: the everyday cases are silent and only
  the rare bad one speaks.
- *Fragility:* `/admin/payments` lists the 50 most recent approved receipts with no filter and no
  search. At 204 units and two receipts a year that is a month of history; correcting an eight-month
  -old receipt means it is not on the page at all, with nothing saying so.
- *Comprehension:* The reversal notification's wording is still my guess. It is the single most
  consequential string in the product and no resident has read it.
- *Honesty:* Unchanged: **CI config exists but has never run**; the D1 gate has never run (A-05,
  R-031); the five credentials are still live (R-038, R-040); demo figures invented; no invoice
  photo on the expense form.

**Next action:** notifications on the ordinary decisions — approved, rejected, needs-info. Reversal
being the only event a resident hears about is the wrong way round, and `01_PRD` A4 asks for the
approval one explicitly.

### [2026-08-05] — session 17 · payment reversal
**Owner:** *"Continue"* — `payment.reverse` had been in the capability matrix since CP-1 with
nothing implementing it. A wrongly-approved receipt was permanent, and it is the side residents
actually see.

**This is the most socially delicate thing the system does.** The resident was told «اتقبل إيصالك
✅». Reversing says that did not count. In a compound that built this because of suspicion, one
family experiencing that with no explanation undoes the project. So three things are enforced rather
than requested:

1. **A written reason**, ≥10 characters, shown to the resident verbatim.
2. **⭐ The admin who APPROVED it cannot un-approve it** — the mirror of maker–checker, in the
   schema (`trg_payment_reversal_needs_second_admin`). Without it one admin can approve a receipt,
   take the credit for it with the family, and reverse it later with nobody else having looked. That
   is the shape of every small-community embezzlement this project exists to prevent.
3. **⭐ The resident is told in the same `db.batch()` as the reversal.** A reversal nobody was told
   about is indistinguishable from money going missing, so "notify later" is not a state this can be
   in. `v_reversed_payments` exposes `notified`, and a test asserts it is never 0.

**The ledger side mirrors the ORIGINAL lines rather than assuming a shape.** The fixture pays 8,000
against a 6,000 due, so the entry has three lines — cash, income, and a 2,000 owner credit. A
two-line assumption would leave the credit behind as a balance the village still owes for money it
no longer has. Mirroring what is actually there is the only version right for both a subscription
and a deposit.

**The arrears come back on their own.** Nothing recomputes them: `v_unit_balance` counts approved
payments and this is no longer one.

**The trigger refused my first design again — third time this week.** I set the reversing entry's
creator and approver to the same person. The fix reuses a pattern already in this codebase:
`changePhoneNumber` takes a `secondAdminId` for staff changes (03_RBAC §6 step 4), so
`reversePayment` does too. **Both names go on the record**, and "the treasurer said it was fine" is
now a row rather than a memory. The original approver *may* be that second admin — agreeing your own
approval was wrong is exactly the case this should support. What is refused is one person alone.

**And the new trigger immediately caught the demo data.** `seed/demo/` has one reversed receipt,
written before the rule existed and with no actor recorded. The seed generator now names the
treasurer as the reverser (the chair approved it), and 34/34 demo invariants pass again. A control
whose first act is to reject your own fixtures is a control that was worth adding.

**⚠️ One destructive migration, deliberately.** `notifications.kind` is a CHECK list with no
`payment_reversed`, and SQLite cannot ALTER a CHECK — so `0015` recreates the table. **Safe only
because this project has never been deployed.** Written into the migration in bold: if that stops
being true before launch, it must be rewritten to copy rows. The alternative — reusing
`account_changed` — was rejected because a kind that lies is worse than a migration that is honest
about being destructive.

**Verified:** **365 checks, 0 failures** (76 unit + 205 access + 48 schema + 34 invariants +
2 lint + typecheck + 12 screens).

**Self-critique:**
- *Adversarial:* There is **no admin screen** for payment reversal. The engine, the controls and the
  notification all exist and are reachable only from a test — so in practice a wrongly-approved
  receipt is still uncorrectable by the actual board.
- *Fragility:* `v_reversed_payments.notified` matches on `kind` and `link_path`, not on the payment
  id, because `notifications` has no FK to a payment. Two reversals for the same resident therefore
  count as notified even if only one message was written. It is a weak check that reads like a
  strong one.
- *Comprehension:* I do not know what a resident feels reading «اتلغى اعتماد إيصال R-2026-00417».
  The reason follows it, and «كلّم الإدارة» follows that — but the ordering, the tone, and whether
  it reads as an accusation are all guesses. This is the single most important string in the
  product and it has never been read by a resident.
- *Honesty:* Unchanged: **CI config exists but has never run**; the D1 gate has never run (A-05,
  R-031); the five credentials are still live (R-038, R-040); demo figures invented; no invoice
  photo on the expense form.

**Next action:** the review-queue reversal control — put payment reversal behind a screen, since the
board cannot currently use any of it. Then the invoice photo on the expense form.

### [2026-08-05] — session 16 · the admin expense screen
**Owner:** *"Continue"* — make CP-5 reachable by a human instead of only by a test.

**`/admin/expenses`** — record, countersign, post, reverse. **No JavaScript anywhere on the page**,
because the person using it is a volunteer standing next to a plumber who wants to leave, on a
stairwell with one bar of signal.

**On the 60-second requirement.** `04_UX_SPEC` line 82 asks for "60-second expense entry". Sixty
seconds is not measurable from here — it needs a volunteer and a stairwell (CP-7). So the tests
assert the things that make it *impossible* if they are wrong: the entry form is literally first on
the page (asserted by string position, above the queue), it asks for exactly **five** fields, today's
date is pre-filled, and it is a plain form post. CP-5 stays honest about which half has been checked.

**Two things the screen changed about the code:**

- **⭐ The screen was offering an operator a button the server refuses.** `canPost` checked only
  "did I record this?", not "may I approve at all". An operator — whose entire role is recording and
  never approving (R-058) — saw a **رحّل على الدفاتر** button. The server would have refused it, so
  no money could move, but that is not the point: *the interface should not offer what the rules
  forbid*, or it teaches the user the system is arbitrary rather than that they lack authority. The
  button is now gated on the caller's capability, and the two agree.
- **`Forbidden` no longer renders as a friendly 200.** The routes caught `Forbidden` and
  `LedgerRefused` together. They are different facts: "this expense cannot be posted yet" is a state
  of the **expense** and belongs on the page; "you do not hold this capability" is a state of the
  **caller**, and answering it with a 200 would let an operator probe the ledger by typing URLs and
  reading which ones came back nicely. `Forbidden` now reaches the 403 handler.

Also: only **spendable** funds appear in the dropdown. The trigger refuses a deposit fund anyway —
listing it and then rejecting it is the same lesson as the button above.

**And my own linter produced a false positive** — `<select id="category">` in the expense form was
flagged as SQL. Fixed the **rule** (`(?<![</])`), not by adding a file exception, and watched it
still catch a real query afterwards. That is the second false positive from these linters; both
times the temptation was an allow-list, and an allow-list is how you teach yourself to ignore a
linter.

**A test I wrote was wrong, and the code was right.** I asserted an operator gets 403 on
`/admin/expenses`. `04_UX_SPEC` line 82 puts 60-second expense entry under `/ops` — recording the
plumber's receipt IS the operator's purpose. The test now asserts what actually matters: the screen
opens, the entry form is there, and **every approval control is absent from the page and refused by
the server**.

**Verified:** **348 checks, 0 failures** (76 unit + 188 access + 48 schema + 34 invariants, 12
screens rendered).

**Self-critique:**
- *Adversarial:* `defaultCashAccount` hardcodes the bank account because the board has never said
  where spending comes from. A cash payment recorded against the bank will not match the statement,
  and CP-5's monthly reconciliation — unbuilt — is the only thing that would catch it. Marked
  `TODO(owner-input)` in the code, but it is a silent wrong answer until then.
- *Fragility:* No invoice photo on the expense form. The schema has `invoice_storage_key`, the
  upload path exists for receipts, and I did not wire it — so an expense currently has no evidence
  attached, which is precisely what residents will ask for first.
- *Comprehension:* Five fields and a pre-filled date is my guess at 60 seconds. A treasurer might
  find the category dropdown of eleven items slower than typing. Unmeasured.
- *Honesty:* Unchanged: **CI config exists but has never run**; the D1 gate has never run (A-05,
  R-031); the five credentials are still live (R-038, R-040); demo figures invented; **payment
  reversal still does not exist**.

**Next action:** payment reversal — `payment.reverse` is in the matrix, nothing implements it, and a
wrongly-approved payment is the side residents actually see.

### [2026-08-05] — session 15 · expense reversal
**Owner:** *"Continue"* — ADR-006's correction path, the operation the whole append-only design
exists to enable and the one I had not built.

**The design changed because the database refused the first version.**

My first draft created the reversing expense **and posted it** in one call, with the same admin as
recorder and approver. `CHECK (approved_by IS NULL OR approved_by <> recorded_by)` refused it — and
the refusal was right. **Reversing moves money back**, and C8 admits no exemption. A one-call
reversal would have made the correction path the only unguarded path in the system, which is exactly
where a correction path goes wrong.

So reversal is two steps, and reuses everything:
1. `requestExpenseReversal` creates an **ordinary expense row** with `is_reversal = 1`, a required
   written reason (≥10 characters — «غلط» is refused), and status `recorded`.
2. A **different** admin posts it through the same `postExpense`, which flips the entry direction
   (Dr asset / Cr expense) and marks the original `reversed` in the same batch.

Because the reversal is an ordinary expense row, every guard protects it for free: the fund must be
spendable, the period must be open, maker–checker applies, the entry must balance, and it cannot be
posted twice. **Making the correction path a special case is how correction paths end up unguarded.**

**What stays visible:** the original row is untouched — same amount, same date, same category, only
its status changes. Both entries appear in the expense ledger, with the reason attached, forever.
ADR-006's argument is that in a community built on suspicion the *visible history* is the product,
and a number that silently changes destroys more trust than the error did. Tests assert the
original's amount and date are unedited, not merely that the totals net to zero.

**Verified:** **336 checks, 0 failures** (76 unit + 178 access + 48 schema + 34 invariants).

**Self-critique:**
- *Adversarial:* Reversal covers **expenses**. `payment.reverse` is in the capability matrix and
  nothing implements it — a wrongly-approved payment is still uncorrectable, and that is the side
  residents actually see.
- *Fragility:* `postExpense` now branches on `is_reversal` to flip the entry direction. That branch
  is two lines and one wrong test away from posting a correction in the same direction as the error,
  doubling it. The test asserts the sign; nothing structural does.
- *Comprehension:* Still no admin screen. Everything in CP-5 is reachable only from a test, so
  "expense entry in ≤60 seconds" remains a claim about code nobody can tap.
- *Honesty:* Unchanged: **CI config exists but has never run**; the D1 gate has never run (A-05,
  R-031); the five credentials are still live (R-038, R-040); demo figures invented.

**Next action:** the admin expense screen — record, countersign, post, reverse — so CP-5's ≤60-second
requirement can be measured instead of asserted.

### [2026-08-05] — session 14 · CP-5 expenses, and three bugs the tests found first
**Owner:** *"Continue"* — stop auditing, close something. Money going out.

**Built:** the expense posting engine (`lib/db/expenses.ts` + `migrations/0014`), and
`.github/workflows/verify.yml` — the CI gate has been open since CP-1 not because it is hard but
because the repo has never been pushed. The config is ready; it runs the full suite, a
credential scan (R-039) and the demo guard (C10), on GitHub Free with no card and no overage.

**Three bugs, each found by a test written to assert the opposite:**

- **🔴 R-057 — `newId()` returned 25-character ids for two-letter prefixes.** It padded to a fixed
  23, right only for `PAY`/`AUD`/`UOW` — the only prefixes it had ever been called with. Every
  `CHECK (length(id) = 26)` refused `newId('JE')`. Thirteen sessions and 300 passing checks never
  touched it, because **every id in every seed and fixture was written by hand**. The first runtime
  path to create a journal entry hit it on the first call. *A fixture that supplies its own ids never
  exercises the id generator — and the generator is what ships.*
- **🔴 R-058 — an operator could post an expense to the ledger.** `postExpense` was guarded by
  `expense.record`, which the operator role holds; recording the plumber's receipt is that role's
  purpose. But **posting is approving** — it stamps `approved_by` and moves the treasury figure on
  every resident's screen. Found because a test written to assert an operator is refused *watched one
  succeed*.
- **🔴 R-059 — nothing posted expenses at all.** `/finance` showed every piastre received and none of
  what was spent, with no figure individually wrong. R-043's mirror image: every audit this week
  asked "is this number wrong?" and none asked "**is a number missing?**"

**⭐ What the ledger taught me about maker–checker.** `trg_entry_maker_checker` refuses any entry
whose creator is its approver, with no threshold. My first instinct was to work around it. The right
reading: the **threshold** decides whether a countersignature is *recorded* (the thing a board
minutes); **maker–checker** decides whether two humans touched the money at all, and per C8 that has
no threshold and no exemption. So a 300 ج.م receipt still needs a second person to post it.

**⭐ And trust money can no longer be spent — prevented, not detected.** R-049 answered "have we
spent the residents' deposits?" with a banner. `trg_expense_fund_spendable_*` now refuses the write,
asserted with every `lib/db/` guard bypassed. **The banner stays**: the trigger guards the path
through `expenses`, a hand-written journal entry could still get there. Prevention where possible,
detection everywhere else, and never delete the detector because you added the preventer.

**CP-5 gates: both ⭐ gates met**, plus Σ-per-category. The fund-split gate's own wording —
*"assert the **displayed** figure against a hand computation"* — is honoured literally: the tile is
parsed out of the rendered HTML.

**Verified:** **326 checks, 0 failures** (76 unit + 168 access + 48 schema + 34 invariants).

**Self-critique:**
- *Adversarial:* No **reversal**. An expense posted in error is currently permanent, and ADR-006
  makes reversal the only legitimate correction — so the one operation the append-only design exists
  to enable is the one I did not build.
- *Fragility:* R-057 says my fixtures systematically avoid production code paths by supplying their
  own ids. `newId` was the instance; the pattern is not. Nothing checks that a generated value is
  ever generated by the generator.
- *Comprehension:* "Expense entry in ≤60 seconds" is a CP-5 requirement and there is **no admin
  screen** — the engine is tested, the interaction does not exist, and 60 seconds is unmeasured.
- *Honesty:* **CI config exists but has never run.** The D1 gate has never run (A-05, R-031). The
  five credentials are still live (R-038, R-040). Demo figures still invented.

**Next action:** expense reversal — the correction path ADR-006 promises and CP-5 requires — then
the admin screen that makes recording an expense a real 60-second task rather than a claim.

### [2026-08-05] — session 13 · the label audit
**Owner:** *"Continue"* — my own next action: every Arabic caption that names a number is a claim
about what that number contains, and nothing had ever verified one.

**Four more. Two of the four tiles on `/finance` were describing the wrong money.**

- **R-053 — «ودائع وأرصدة للملاك» included money owed to CONTRACTORS.** `held_in_trust` summed
  *every* liability, and the chart has three: deposits, owner credits, and **مستحقات موردين**. An
  unpaid invoice to the lift company rendered under the caption *"أمانات — مش ملك القرية، بتترد
  لأصحابها"*. A resident reading that tile would conclude the village is holding residents' money it
  is not holding. Split in `migrations/0013`, each with its own caption. **`spendable` is
  deliberately unchanged** — money promised to a contractor is not available to spend either, so
  only the attribution moved, and a test asserts the treasury figure did not budge.
- **R-054 — «رصيد أول المدة» was every fund account, reserves included.** Equal today only because
  both reserves are zero. The first time the board funds احتياطي الطوارئ — which `06 §5` expects —
  the opening balance on screen grows by that amount, **with no code change and no deploy**.
- **R-055 — «المطلوب منك السنة دي» is not this year.** `due_piastres` covers every published fee
  period. That is *right* for arrears — last year's unpaid subscription does not stop being owed on
  1 January — and false as a caption. Fixed by changing the caption, **not** by scoping the number:
  filtering to the current period would make old debt vanish from the screen a resident checks,
  turning a wrong label into a wrong balance.
- **R-056 — nothing forced a new account into a caption.** Both label bugs were possible because
  "which accounts does this Arabic sentence cover?" lived only inside the sentence.
  `v_unclassified_accounts` now lists any liability or fund account no caption names, and a test
  asserts it is empty — so adding account 2104 without deciding where it belongs fails a test
  instead of appearing under the wrong sentence, or vanishing entirely.

**Why all of this was invisible:** the exposing accounts were **empty**. No supplier invoice had
ever gone unpaid in the demo and no reserve had ever been funded, so the wrong bucket and the right
bucket both read zero. The fix was to make the fixture post an ordinary unpaid invoice and an
ordinary transfer into a reserve. **A fixture containing only the happy shape of the data cannot
expose a misclassification.**

**Verified:** **301 checks, 0 failures** — 76 unit + 143 access + 48 schema + 34 invariants, both
lint rules, typecheck, 11 screens.

**Running total: twelve defects across sessions 10–13** (R-043, R-045…R-048, R-050…R-056), every
single one in how money is **named or presented**, and **zero** in how it is recorded.

**Self-critique:**
- *Adversarial:* `v_unclassified_accounts` covers liability and fund accounts only. Asset, income and
  expense captions aggregate by `type` rather than by code, so a new asset account is still swept in
  silently. That is the same hole, one layer up, and I left it.
- *Fragility:* R-053 and R-054 were caught because I put non-zero values in accounts that had always
  been empty. There is no rule saying a fixture must exercise every category an aggregate claims to
  separate — I did it by hand this time, and the next aggregate will not get that treatment unless
  someone remembers.
- *Comprehension:* Twelve presentation bugs and zero ledger bugs is now past the point of being a
  pattern. **The controls on this project are pointed at the wrong layer**, and every remaining
  checkpoint should budget a render-level test before an integrity-level one. I have written that
  three sessions running without changing how I start a checkpoint.
- *Honesty:* Unchanged: **no CI**; **the D1 gate has never run** (A-05, R-031); **the five
  credentials are still live** (R-038, R-040); no passkey listing/revocation; demo figures invented.

**Next action:** stop auditing and close a blocking gate. Everything findable from this sandbox by
re-reading has now been found three times over; the two things that would actually de-risk this
project — the D1 verification and CI — both need the owner. Failing that, CP-4's expenses.

### [2026-08-05] — session 12 · the audit's second half
**Owner:** *"Continue"* — my own next action: run the R-043 question over `lib/db/`, not just views.

**Three more, and one of them was mine.**

- **R-050 — a false all-clear on the screen whose whole job is showing who has not paid.**
  `outstanding <= 0` counted as settled. A unit whose dues were never published has `due = 0`,
  `paid = 0`, `outstanding = 0` — so it counted as **paid**, and a building nobody ever billed
  rendered as **«دفعوا ٣/٣»**. A forgotten building, a half-finished owner import, a fee period
  published for 33 of 34 blocks all look exactly like that. `billed` is now counted separately at
  every level: the building table says «لسه ماتحسبتش» with a warning banner, a flat gets a muted
  chip, and the resident's home says «لسه ماطلعش عليك اشتراك السنة دي» instead of a green tick.
- **R-051 — receipt numbering rewinds at the 10,000th receipt and then nothing works.**
  `substr(receipt_no, 9)` drops the **first** of five sequence digits. Invisible below 10,000
  because the dropped digit is a leading zero — `R-2026-00417` → 417 is correct. `R-2026-10000` → 0.
  The counter restarts at 1, collides with the UNIQUE `receipt_no`, and **every** resident gets a
  500 on submit, permanently. ~25 years here; immediately for a bigger compound.
- **🔴 R-052 — a gap I created while fixing R-043.** Migration 0011 correctly stopped deposits
  counting toward dues, and its own comment promised the deposit would stay *"separate and visible…
  so a resident who paid a deposit can see it acknowledged instead of wondering where it went."*
  **I wrote that sentence and did not do it.** A resident who transferred 5,000 ج.م saw «دفعت 0.00»
  — their money appeared to vanish. The home screen now says «وديعتك المحفوظة عند القرية: … دي
  أمانة بتترد لك، مش محسوبة من اشتراكك», and a second test proves showing it did not quietly undo
  the fix by making the flat look settled.

**Also:** the label audit. Fixing R-043 changed what `paid_piastres` measures; «محصّل» on the
building table did not change with it, so a column promising "collected" silently stopped including
deposits. Renamed «محصّل من الاشتراكات», with deposits given their own column. And the four
superseded view definitions in `0005` now carry ⚠️ headers naming the defect and pointing at `0011`
/ `0012`, because a stranger reading migration history will otherwise copy the broken pattern.

**The pattern grep came back clean:** `LEFT JOIN … AND <filter>` appears nowhere outside the two
already-superseded definitions and the two files documenting them.

**Verified:** **294 checks, 0 failures** — 76 unit + 136 access + 48 schema + 34 invariants, both
lint rules, typecheck, 11 screens.

**Running total for the audit that started with one lucky test:** eight defects across sessions
10–12 (R-043, R-045…R-048, R-050…R-052), every one of them in how money is **presented** while the
ledger underneath stayed correct throughout.

**Self-critique:**
- *Adversarial:* I have now audited views and the aggregate queries. I have **not** audited the
  views' *labels* systematically — I fixed «محصّل» because I happened to look at it. Every other
  Arabic label naming a number is an unverified claim about what that number contains, and
  `messages/ar.json` has roughly forty of them.
- *Fragility:* R-052 existed because a promise lived in a comment instead of a test. There is no
  mechanism preventing the next one; I am relying on having noticed this once.
- *Comprehension:* Eight presentation bugs and zero ledger bugs is a strong enough signal to act on:
  **this project's controls are all pointed at the wrong layer.** Every remaining checkpoint should
  budget for a render-level test before an integrity-level one.
- *Honesty:* Unchanged: **no CI**; **the D1 gate has never run** (A-05, R-031); **the five
  credentials are still live** (R-038, R-040); no passkey listing/revocation; demo figures invented.

**Next action:** audit `messages/ar.json` — every label that names a number is a claim about what
that number contains, and R-043 proved one of them was already false.

### [2026-08-05] — session 11 · the audit that followed the bug
**Owner:** *"Continue"* — my own stated next action: re-read every view with the R-043 question.

**The method:** R-043 was found by luck — a new *kind* of test. So rather than move on, I took that
bug's **shape** and re-read all fifteen views asking one question: *do both sides of this comparison
measure the same thing?* That found **four more defects in about twenty minutes**, three of them
sharing a single SQL mistake.

**🔴 The mistake, worth naming because it is invisible:**
```sql
LEFT JOIN accounts a ON a.id = pl.account_id AND a.type = 'asset'
```
That is **not a filter**. A LEFT JOIN's ON clause decides whether the *right-hand* row attaches,
never whether the left-hand row survives — so non-asset lines stayed in and their debits and credits
kept being summed. It reads correctly in English, raises no error, and returns a plausible number.

- **R-045 — `v_fund_balances` reported every fund as holding nothing.** Income credits netted against
  cash debits. The view is documented as *"what makes الفلوس المتاحة للصرف honest"*. `/finance` was
  spared only because `spendable` is computed elsewhere. A view nothing reads is not harmless — it is
  a wrong answer waiting for its first caller.
- **R-046 — the *independent second opinion* had the same bug.** `v_unit_ledger_balance` exists
  solely to be the second path invariant 8 compares against. The control itself was wrong, and it
  passed for eleven sessions because the demo generator happens to tag only income and liability
  lines with `unit_id`. My own CP-3 fixture tagged every line — the obvious reading — and the view
  would have returned 0 for every unit. **A control whose correctness depends on an unwritten
  data-entry habit is not a control.**
- **R-047 — the expense chart could multiply everything by six.** Six categories map to account 5101.
  Σ per-category was saved only by a filter in `lib/db/` *and* a coincidence in the seed. Fixed by
  moving the filter into the view and adding a partial unique index so a second roll-up category on
  one account is impossible.
- **R-048 — `v_deposit_leakage` was narrower than its name** and contained a join clause that can
  never match. It caught a deposit credited to *income* only; credited to a **fund** — the village
  treating money it owes back as its own reserve — it was invisible. The rule is stated positively
  now: a deposit must credit a **liability**.

**⭐ And the thing worth more than the fixes.** Repairing R-045 made a question askable that this
project could not previously ask at all: **"have we spent the residents' deposits?"** It is the most
damaging thing that can quietly happen to a compound, and it is invisible in every other figure —
the ledger balances, the equation holds, income and expenses look ordinary, and the treasury simply
reads higher than it should. `/finance` now carries a permanent banner: green *"صندوق الودائع كامل"*
when intact, red and **quantified** when short. Rendered **always**, not only on failure, because a
control the board has never seen is one whose disappearance they cannot notice.

A test spends 1,000 ج.م of trust money on salaries and proves the alarm names the amount — while the
accounting equation still reads exactly zero (ADR-018, again).

**Verified:** **288 checks, 0 failures** — 76 unit + 130 access/audit/auth/onboarding/transparency/
views + 48 schema + 34 ledger invariants, plus both lint rules, typecheck and 11 screens.
Two new demo invariants: every piastre of cash belongs to exactly one fund (1,029,050.00 ج.م both
ways), and the deposit fund holds every piastre it owes.

**Self-critique:**
- *Adversarial:* I audited **views**. The same question applies to the ~30 queries in `lib/db/` and I
  have not run it over them — `getBuildingTotals` and `getUnitStatement` both aggregate, and neither
  was re-read this session. Nor have I grepped for the LEFT-JOIN-as-filter pattern outside migrations.
- *Fragility:* `ux_expense_rollup_per_account` is a partial unique index. If A-05 comes back saying
  D1 rejects partial indexes, R-047's structural half is gone and only the view filter remains. That
  is one more thing riding on a verification that has never run.
- *Comprehension:* The deposit-fund banner is the first thing on this project I have written that a
  board member might act on the same day. I do not know whether *"صندوق الودائع ناقص 1,000.00 ج.م"*
  reads as "an accounting problem" or "someone stole money" — the difference matters enormously and
  only a real reader can tell me.
- *Honesty:* Unchanged: **no CI**; **the D1 gate has never run** (A-05, R-031); **the five
  credentials are still live** (R-038, R-040); no passkey listing/revocation. Every figure in the
  demo is still invented.

**Next action:** run the R-043 question over `lib/db/`'s aggregate queries — the audit I did on views
and did not do on the functions that call them.

### [2026-08-04] — session 10 · CP-3, and the bug it was built to find
**Owner:** *"كمل"* — the read-only transparency screens, which need nothing external.

**Done:**
- **`/finance/units`** — every flat's collection status. Gated on the general assembly's written
  approval (Q11 / R-002) *inside* `getUnitBalances`, not in the route, because a rule that lives in
  two places eventually disagrees with itself. Names, phone numbers and receipts are **not in the
  SELECT list at all**, so no template change can leak them. An overpayment shows as **رصيد دائن**,
  never as a negative arrears figure — a minus sign in the متأخرات column reads as debt to everyone
  who is not an accountant.
- **`/admin/health`** — usage against every free-tier limit, amber at 70%, red at 90%. Each row is
  marked **measured** (counted from this database now) or **declared** (a vendor limit transcribed on
  a date by a human). A quota that cannot be read from inside a Worker renders as **"—", never 0%**.
- **"شوف الأرقام"** is a `<details>` element, so the numbers table opens with JavaScript off, and a
  test asserts it agrees with the chart.

**🔴 A real financial bug, found on the new test's first run — R-043 / ADR-025.**
`v_unit_balance` subtracted **every approved payment** from **dues in published fee periods**. The
two sides measured different things and the difference was الوديعة. A flat that paid its 5,000 ج.م
deposit and none of its 6,000 ج.م subscription reported **1,000 ج.م outstanding instead of 6,000** —
and `v_community_totals` reads that view, so the headline متأخرات on `/finance` was understated by
the entire deposit pool. On 204 units that is over a million pounds of arrears that never appeared
on the screen the board uses to decide who to chase.

**Every R-020 defence passed.** The deposit was booked to a liability, in the deposit fund, through a
category whose `kind` the trigger verified. `v_deposit_leakage` was clean. The equation balanced. All
twelve ledger invariants held. **The ledger was right; the report was wrong** — and twelve sessions
of controls all guard how money is *recorded*, not how it is *presented*.

Fixed by `migrations/0011_arrears_fix.sql`: `paid_piastres` counts only fee-period-allocated money,
`received_piastres` is everything, and the two can never be one column again.
`trg_deposit_has_no_fee_period_*` makes the class unrepresentable. `v_unallocated_payments` catches
the mirror image — a subscription approved with no fee period, which would mark a resident who *paid*
as owing.

**Why it survived 246 passing checks:** every previous financial test compared one query against
another query. `tests/access/transparency.test.ts` is the first to parse the number out of the
**rendered HTML** and compare it to a literal added up by hand. The fixture is twelve journal lines
precisely so a human can check the arithmetic without running anything.

**And a second failure worth recording:** `verify_demo.py` carried the comment *"from_ledger includes
deposits… from_payments includes them too… They must agree."* That sentence **was the bug**, written
down inside the test meant to catch it, and it passed for five sessions. A test that encodes a wrong
assumption converts that assumption into evidence (R-044).

**Verified:** **272 checks, 0 failures** — 76 unit + 116 access/audit/auth/onboarding/transparency +
48 schema + 32 ledger invariants, plus both lint rules, typecheck and 11 screens rendered.

**Gates closed (CP-3):** both of them — *"every displayed figure matches a hand-computed expected
value"* and *"the same totals computed by raw SQL match the app's numbers exactly."*

**Self-critique:**
- *Adversarial:* The bug I found is a **class**, and I fixed one instance. Every other reporting view
  compares quantities that may not be the same kind of thing — `getBuildingTotals` inherits the fix,
  but `v_unit_ledger_balance`, `v_account_balances` and the home dashboard have not been re-read with
  this specific question in mind. That audit is the next honest piece of work, and I did not do it.
- *Fragility:* `/finance` has no period filter. There is one fiscal period, so it would have one
  option — but the first day of 2027 turns every "total" on that page into a lie by omission, and
  nothing currently warns about that date.
- *Comprehension:* I still cannot tell whether a resident reads "الفلوس المتاحة للصرف" and
  "ودائع وأرصدة للملاك" as two different things or as one balance split in two. The four-tile design
  is the single biggest bet in this product and it has never been in front of a resident.
- *Honesty:* Unchanged and still true: **no CI**; **the D1 `STRICT`/`RAISE(ABORT)` gate has never
  run** (A-05, R-031); **the five credentials pasted into this chat are still live** (R-038, R-040);
  no passkey listing or revocation screen. And the demo figures are still invented.

**Next action:** re-read every remaining view with the R-043 question — *do both sides of this
comparison measure the same thing?* — because I found that class of bug once and have no reason to
believe it occurred only once.

### [2026-08-04] — session 9 · the last two CP-2 gates
**Owner:** *"كمل"* — finishing what session 8 named: assisted recovery, then the owner register.

**Done:**
- **Two-admin assisted recovery** — `migrations/0010` + `lib/db/onboarding.ts`. Three steps:
  `requestRecovery` (an admin writes down, in their own words, how they established this is really
  the person — required, ≥10 characters, on the record forever), `approveRecovery` by a **different**
  admin, then `fulfilRecovery` which issues a single activation link. **The two-person rule is a
  `CHECK` constraint, not application code**: the requester cannot approve, an admin cannot recover
  their own account, an unapproved request cannot be fulfilled, and a fulfilled request can never be
  replayed. A test calls the database directly, with every `lib/db/` guard bypassed, and the write
  still fails.
- **The owner-register bulk import** — `lib/import/owners.ts` is a pure parser, so it can be tested
  against nasty input without touching anything. Header synonyms in Arabic *and* English (real
  volunteer spreadsheets do not agree on one spelling), Excel's BOM and bidi marks stripped,
  comma/tab/semicolon detected, Arabic-Indic digits read as digits (`١٤` is building 14). Duplicates
  are **flagged, never merged and never dropped**; a flat appearing twice is flagged as a question —
  *"ملّاك مشتركين؟ أكّد بنفسك"* — not as an error, because `unit_owners` is many-to-many by design
  and inheritance splits flats between siblings constantly here.
- Preview creates **nothing**; the preview the admin actually saw is stored on the batch, so what
  they consented to is on the record and not just what was created. Re-confirming a batch is refused.
  An import never reassigns a phone number that already belongs to somebody.

**Verified:** **246 checks, 0 failures** (76 unit + 92 access/audit/auth/onboarding + 48 schema +
30 invariant + both lint rules + 9 screens rendered). `tests/access/onboarding.test.ts` is 21 tests
and passed on the first run — which I am recording as a fact rather than a triumph, because the two
previous suites that did that both had a bug found later by a *sharper* assertion, not by a new test.

**Gates closed (CHECKPOINTS.md CP-2):** *"Bulk import of 50 rows with 3 deliberately malformed rows
behaves correctly"* — the gate verbatim, 47 created, 3 flagged with an Arabic instruction each,
nothing created for a flagged row. And *"losing one device does not let a single operator take over
the account."* Also ticked: *"an unprovisioned number cannot obtain a session."*

**A gate I did NOT tick, and why it matters:** CP-2 says *"the 4th activation request in 15 min is
refused."* ADR-016 deleted the flow that number described — a resident never requests activation now,
a board member issues the link. The counter it names has no caller. Rate limiting does exist (login
5/phone/15 min, recovery 3/IP/15 min, links single-use) and ticking it would have looked fine. It is
rewritten in place and left unticked for the reason that actually blocks it: those limits have only
ever run against the in-process SQLite driver, never a real deployment with a real
`cf-connecting-ip`. Same treatment for the WebAuthn replay gate — the challenge half is proven, the
signature/origin half has never seen a real assertion and cannot be proven here.

**Self-critique:**
- *Adversarial:* The importer has never seen a real spreadsheet. Everything it handles, it handles
  because I imagined the defect — and the defects I did not imagine are exactly the ones that will
  arrive. It also does not read `.xlsx`; the admin must export to CSV first, which is one more step
  where a volunteer gives up. The single strongest test of this whole session is a file from the
  board, and it does not exist yet (Q1).
- *Fragility:* `commitImport` creates profiles and unit links in one batch, which is right, but a
  200-row register is a 200-row batch and D1 has statement limits I have not measured. It has been
  tested at 50. Chunk it before the real file lands.
- *Comprehension:* Assisted recovery is a **social** procedure with a database behind it, and only the
  database half exists. There is no admin screen for it and no written procedure for the board — the
  identity check happens offline, and I have not told anyone how to do it. That belongs in the CP-8
  Arabic admin manual and it is the part most likely to be done badly.
- *Honesty:* Unchanged and still true: **no CI**, **the D1 `STRICT`/`RAISE(ABORT)` gate has never
  run** (A-05, R-031 — blocked since day one by the sandbox's blocked network, not by difficulty),
  **the five credentials pasted into this chat are still live** (R-038, R-040), and there is still no
  passkey **listing or revocation** screen, so a resident who sells a phone cannot retire its
  credential.

**Next action:** `bash tools/verify-d1.sh` from the owner's machine — it is the oldest open item in
the project and every financial-integrity control rests on its two answers. Then CP-3, the read-only
transparency screens, which need no external dependency at all.

### [2026-08-04] — session 8 · the wizard joined up, and recovery
**Owner:** *"كمل"* — closing the two gaps I had flagged as the honest holes.

**Done:**
- **The five-step payment wizard works end to end.** `migrations/0009` + `lib/db/drafts.ts`: the
  draft lives server-side, keyed to the SESSION, so switching to the bank app to check an amount and
  coming back loses nothing. **Steps 1–3 and 5 are plain form posts and need no JavaScript at all** —
  only the image at step 4 does. Going back re-shows what was typed; `/pay` with no step resumes
  rather than restarting; an incomplete draft names the step to return to instead of failing at
  submit.
- **Recovery by printed code.** Redeeming one revokes every session AND every passkey — leaving the
  lost phone's credential enrolled would not be recovery — then leads straight into enrolling a new
  one. Rate-limited to 3 attempts per 15 minutes, harder than login, because it is the bypass.
- One implementation of receipt submission now serves both the JSON API and the wizard, so a fix to
  the duplicate check or the storage cap cannot land on only one of them.

**Verified:** **225 checks, 0 failures** (76 unit + 71 access/audit/auth + 48 schema + 30 invariant).

**🔴 A real security bug, found by a test asserting an exact count:**
`issueRecoveryCodes` **appended**. Every activation, new device and recovery issued six MORE codes
and left every previous set valid. Three such events and a resident has eighteen live passkey
bypasses — on paper, in photos, in forwarded messages — with nobody tracking how many exist. Now
issuing a set retires the previous one in the same batch. `remaining > 0` would have passed forever;
`remaining === 5` caught it.

**And a process failure worth recording:** I read a `Response` body twice again — the same mistake I
wrote into `INSIGHTS.md` two sessions ago. Remembering did not work. There is now a `send()` helper
that reads once, so the mistake is unavailable rather than discouraged.

**Self-critique:**
- *Adversarial:* Recovery is closed for the resident who still has their paper codes. **Two-admin
  assisted recovery — for the resident who lost the codes too — still does not exist**, and that is
  now the most likely real-world lockout. It is also the path where a careless admin hands an account
  to the wrong person (R-003), so it needs the two-admin control before it needs anything else.
- *Fragility:* The draft has no expiry. An abandoned draft sits in D1 until the session dies a year
  later. Harmless at this scale, untidy, and worth a nightly sweep.
- *Comprehension:* The wizard is the first thing here a resident actually *does*, and it has never
  been in front of one. The CP-7 observed test is where this gets its real verdict.
- *Honesty:* Still no CI, still no D1 verification run, still no bulk import, and no admin screens
  beyond the review queue. The five credentials from earlier messages are still live.

**Next action:** two-admin assisted recovery, then the admin bulk import — which is what CP-2's
remaining gate needs and what the real resident register will land on.

### [2026-08-04] — session 7 · receipts get a real home
**Owner:** *"استخدم الـ Cloudflare database، لو مش متاح ده ملف درايف"* + a Drive folder link.

**Answer: the Cloudflare database IS available — the spec's objection rested on a number that was
never measured.** `05 §2a` forbade image bytes in D1 on the basis of 500 KB/receipt → 2.5 GB/year
against a 500 MB database. That 500 KB is the pack's *pre-upload* target for a raw phone photo.
Measured with WebP, including the worst realistic input (a resident photographing a printed paper
slip, not a bank-app screenshot):

| setting | screenshot | **paper photo** | per year | years/db |
|---|---|---|---|---|
| 1600px q82 *(what we had shipped)* | 8 KB | 41 KB | 199 MB | 2.5 |
| **1200px q60** *(now)* | 5 KB | **6 KB** | **27 MB** | **18** |

**Done:**
- `migrations/0008` + `lib/storage/d1blob.ts` + `lib/db/blobs.ts` — receipts in D1, in a **separate
  database** from the ledger so the restore drill stays fast enough that people keep running it.
- Client compression tightened 1600/q82 → 1200/q60: ~7× smaller, digits still legible.
- 256 KB ceiling enforced twice — adapter and CHECK — so a client that skipped compression is
  refused rather than quietly eating the budget.
- ADR-023, superseding ADR-015/022 on storage and reversing `05 §2a` **on evidence**.

**Verified:** 211 checks, 0 failures. New: a byte-for-byte roundtrip through the real file route, and
a re-check that a neighbour still cannot read a receipt now that the bytes live in D1.

**My own lint rule caught my new file, and I complied rather than adding an exception.** The five
blob queries moved into `lib/db/blobs.ts`. The value of an absolute rule is that it is absolute.

**🔴 About the Drive folder:** it is a `?usp=sharing` link. If that folder is set to "anyone with the
link", every receipt in it would be readable by anyone ever forwarded the URL — a direct C6 violation
and a PDPL breach. Receipts are NOT going there. **If it is to hold backups, set it to Restricted
first** — a database dump is at least as sensitive as an image. R-042.

**Self-critique:**
- *Adversarial:* Storage is settled but the credentials from the last two messages are still live.
- *Fragility:* D1 has a hard 500 MB ceiling. 18 years at measured rates, but a wrong pilot assumption
  (say residents upload multi-page PDFs) would change that fast. `v_blob_usage` watches it; the
  switch condition is 70%.
- *Honesty:* The pay wizard still does not carry state between its five steps — the upload API works
  and is tested, the screens render, but they are not joined up. Passkey recovery still does not
  exist. The D1 gate is still not run.

**Next action:** join the pay wizard to the upload API, then passkey recovery.

### [2026-08-04] — session 6 · "is Cloudflare free or not?"
**Owner:** *"شوف هتعرف تستخدم Cloudflare بشكل مجاني، لو لا استخدم الدرايف"* — plus a second batch of
credentials (a new API token, an R2 access key and secret, the R2 endpoint).

**🔴 REVOKE ALL FOUR CREDENTIALS.** R-040. Neither batch was ever usable from here — outbound access
to `api.cloudflare.com` **and** `*.r2.cloudflarestorage.com` is blocked in this sandbox — so nothing
was done with them. Twice now, luck has stood in for a control.

**The question answered, and it falsified BOTH halves of the approved plan:**
1. **Cloudflare is free — R2 is not.** Cloudflare's *own* R2 documentation requires
   *"complete the checkout flow to add an R2 subscription"* as a prerequisite even for the free tier,
   and their staff confirm adding a card triggers a **$5 authorization hold**. First-party evidence
   now, replacing the community thread. Workers, Pages, D1 and KV all stay: no card, and they block
   rather than bill. **Cloudflare stays. R2 goes.**
2. ⚠️ **A-07 IS FALSIFIED — the Drive option would not have worked either.** A Google **service
   account** has no Drive storage quota at all; uploads fail `403 storageQuotaExceeded` even into a
   shared folder, even when empty. Every documented workaround needs paid Google Workspace.

**ADR-021 is why this cost nothing.** The Drive adapter was deliberately left throwing on every
method rather than implemented on an unproven assumption, so nothing was built on top of it and not
one receipt was written somewhere unrecoverable. Writing "this is unvalidated" into the file instead
of writing the code is what bought that.

**Done:**
- `lib/storage/s3.ts` — S3-compatible storage with AWS SigV4 signing over WebCrypto. Works unchanged
  for Backblaze B2 **or** R2, so the work survives whichever way the decision lands.
- `tests/unit/s3sign.test.ts` — 7 checks including the published empty-payload hash constant, so the
  signer is verified against an external answer rather than against itself.
- ADR-022 with the corrected plan and its three costed alternatives; RESEARCH_SOURCES #18–#22.

**Verified:** `npm run verify` → **209 checks, 0 failures** (76 unit + 55 access/audit/auth + 48
schema + 30 invariant) + 9 screens.

**Self-critique:**
- *Adversarial:* Two credential sets are loose in a chat log. Everything else on this list is smaller
  than that.
- *Fragility:* Storage now has **three** adapters and no chosen one. That is honest, but it means
  CP-4 cannot finish until A-20 is proven.
- *Honesty:* I answered a research question this session and wrote one adapter. **No receipt can yet
  be stored anywhere durable**, the D1 gate is still not run, and passkey recovery still does not
  exist. Progress on knowledge, not on shipping.

**Next action:** the owner picks a storage route (ADR-022). Meanwhile: passkey recovery, which needs
no vendor at all.

### [2026-08-04] — session 5 · passkeys and receipt upload
**Checkpoint:** CP-2 / CP-4 · **Owner:** *"كمّل في البصمة ورفع الإيصالات"* + a Cloudflare account URL
and an API token.

**⚠️ FIRST, AND UNRESOLVED — the API token must be revoked.** It was pasted in plaintext into the
chat, so it now lives in the transcript, in backups, and in any log that captured it. It was never
usable from this sandbox — outbound access to `api.cloudflare.com` is blocked here — so nothing was
done with it, **but that is luck, not a control**. R-038. Rotate it, then run
`bash tools/verify-d1.sh` from the owner's own machine.

**Done (things that actually run):**
- **Passkeys, end to end.** `lib/auth/passkey.ts` + `lib/db/auth.ts` + `migrations/0007`:
  registration and authentication ceremonies via `@simplewebauthn/server` (ADR-020), server-issued
  single-use challenges, `userVerification: 'required'`, sign-counter clone detection, rate limits,
  HttpOnly/Secure/SameSite session cookies, board-issued activation links that burn on first use,
  and printed recovery codes.
- **Login does not leak the resident register.** An unknown number gets a real challenge and an empty
  `allowCredentials`, so the response is indistinguishable from a registered one — asserted by
  comparing response *shape*, not status.
- **Receipt upload, end to end.** Client-side canvas compression to ~500 KB (which strips EXIF and
  geolocation as a side effect — R-026), the storage hard cap, `storage_objects` rows, SHA-256
  duplicate detection that **warns and lets the resident proceed**, and a quotable `R-2026-00001`.
- `wrangler.toml` with the account id, no R2 block, and every secret named but empty.
- `tools/verify-d1.sh` — the one command that closes CP-1 gate 1.

**Verified how:** `npm run verify` → lint ×2 + typecheck + **69 unit + 55 access/audit/auth +
48 schema + 30 invariant = 202 checks, 0 failures** + 9 screens.

**Two real bugs, both mine:**
1. **The activation page set no session cookie.** `c.header('set-cookie', …)` sets a header on Hono's
   *context*, but my `html()` helper returned a hand-built `Response` that discards it. The page
   rendered perfectly and greeted the resident by name while logging nobody in. The JSON routes were
   unaffected because `c.json()` merges context headers — so exactly one path was broken.
2. A test read a `Response` body twice (`assert(..., await r.text())` then `r.json()`), which looks
   like an app failure and is not.

**Decisions:** ADR-020 (use a WebAuthn library, do not hand-roll), ADR-021 (storage stays behind the
interface until A-07 is proven). **Risks:** R-038 (token exposure) 🔴, R-039 (secrets in repo).

**Self-critique:**
- *Adversarial:* Passkey **recovery** is the weak point now, not login. Recovery codes are issued and
  hashed, but there is no route that redeems one, and no two-admin assisted recovery (R-023). A
  resident who breaks their phone today is locked out with no path back — and the pressure that
  creates is exactly how a careless admin ends up handing an account to the wrong person (R-003).
- *Fragility:* `openSession` writes three statements without a batch, so a crash mid-write could
  leave a session with no audit row. It should go through `mutate()`. Also `nextReceiptNo` uses
  MAX+1, which is safe at village scale and a race at any other.
- *Comprehension:* Untested with a real person on a real phone. Everything about the passkey flow —
  whether "الدخول ببصمة أو قفل الموبايل" means anything to a 71-year-old, whether the sensor prompt
  appears where they expect — is unknown until CP-7's observed test.
- *Honesty:*
  1. **The D1 gate is STILL not run.** Network to Cloudflare is blocked from here. This is the
     longest-standing open item in the project and it is not closed.
  2. **Receipts have nowhere real to live.** `MemoryStorage` works; `GoogleDriveStorage` throws on
     every method, pending A-07 (ADR-021).
  3. The pay flow's five steps do not yet carry state between them — each renders, none submits the
     accumulated draft. The upload API works; the wizard wiring does not.
  4. No recovery route, no bulk import, no admin screens beyond the review queue.
  5. Still no CI.

**Next action:** passkey recovery (redeem a code + two-admin assisted path), then wire the pay wizard
to the upload API it already has.

### [2026-08-04] — session 4 · audit trail + the Arabic UI
**Checkpoint:** CP-1 close-out + CP-2 shell · **Owner:** *"كمّل في سجل المراجعة والواجهة، وأنا هجيب الحساب"*

**Done (things that actually run):**
- **The audit gap is closed, structurally.** `mutate()` runs a write and its audit row in one
  `db.batch()` — they commit together or not at all, so an unaudited mutation cannot exist. Ten
  mutating functions routed through it, payments included.
- **`changePhoneNumber` hardened** (R-003, the most abuse-prone path): admin-only, mandatory written
  reason, **two different admins** for staff accounts, old identifier closed with its history and a
  `replaced_by_id` chain, **every session revoked**, old number returned so it can be notified.
- `messages/ar.json` — every user-facing string, Egyptian Arabic. No hardcoded Arabic in any view.
- `src/views/` — the design tokens from `04_UX_SPEC` §1 as ~4 KB of hand-authored CSS using **only**
  logical properties (ADR-019, a recorded deviation from AGENTS.md's Tailwind line, not a silent one).
- **Nine screens rendering**: login, home, pay steps 1–3, my payments, finance, admin review, 404.
- `tools/lint-rtl.mjs` — bans physical directional CSS; watched failing against a deliberate
  `margin-left` before being trusted.

**Verified how:**
- `npm run verify` → lint (2 rules) + typecheck + **69 unit + 34 access/audit + 48 schema + 30
  invariant = 181 checks, 0 failures** + 9 screens rendered.
- `render_screens.ts` boots the **real** `createApp()` against the demo village and saves what the
  real routes serve — the preview IS the product, not a redrawing of it.
- Measured in a real 390×844 viewport: body text 17px, **zero** tap targets under 48px, bottom nav
  clears content.
- **Unverified, unchanged:** still nothing has run against real D1 (A-05, R-031). The owner is
  creating the board-owned Cloudflare account.

**Four real bugs found by looking at the rendered screens:**
1. The help button floated at `inset-inline-end` — in RTL that is where Arabic text *begins*, so it
   covered the first words of whatever card was under it. Moved to `inset-inline-start`.
2. `msg(template, {n:''})` followed by the value appended after it stranded numbers at the END of
   sentences: *"إيصال — مش محسوبة في الإيرادات 14"*. Four call sites. I fixed one, shipped, and found
   the other three only on the next render.
3. `Forbidden.message` carried the capability name but not the Arabic reason, so every log and stack
   trace showed `forbidden: phone.change` instead of what the admin was actually told.
4. The phone-change batch ordered its statements so the old row pointed at a row that did not exist
   yet — three separate constraints caught it.

**Insights captured:** 7 new under "CP-1/CP-2, session 4". **New ADR:** ADR-019.

**Self-critique:**
- *Adversarial:* The audit trail is now complete for writes, but **reads are not logged at all**. An
  admin browsing every resident's receipt images leaves no trace. `03_RBAC` §5 requires the support
  view to be banner-flagged and audit-logged; neither exists yet. That is the next real gap.
- *Fragility:* The UI is entirely server-rendered with no client JS, which is right for 3G — but it
  means the pay flow currently has **no local draft**, and `04_UX_SPEC` §4.1 requires that killing
  the connection at step 4 loses nothing. That needs the one interactive island the stack budgets for.
- *Comprehension:* Rendering it found all four bugs above; none was visible to a passing test suite.
  The number-at-the-end-of-the-sentence bug in particular reads as broken Arabic to a resident and
  as perfectly valid string interpolation to a reviewer.
- *Honesty:*
  1. **The login button does not log anybody in.** WebAuthn enrollment and assertion are not built.
     The screen is real; the mechanism behind it is not.
  2. **The pay flow does not submit.** Steps 1–5 render; there is no upload, no client-side
     compression, no draft persistence, no duplicate detection.
  3. The Drive adapter still throws on every method.
  4. Loading/offline states exist as components but are wired to almost nothing.
  5. Still no CI, and still no D1.

**Next action:** WebAuthn (enroll + assert), then the upload path — in that order, because a login
screen that cannot log in blocks the pilot and everything else waits behind it.

### [2026-08-04] — session 3 · the CP-1 security layer
**Checkpoint:** CP-1 · **Owner decisions:** Q19 **تمام** (board-owned Google file store) and
Q20 **تمام** (WhatsApp out of v1). ADR-015 and ADR-016 move from *proposed* to **accepted**.
R-004, R-017, R-028 and R-029 all **close**.

**Done (things that actually run):**
- `lib/rbac.ts` — the 03_RBAC §2 matrix as data, all five roles incl. `finance_reviewer` (Q21).
  `audit.modify` is held by **nobody**, asserted by a test. Maker–checker is separate from
  capability on purpose: holding "may approve" says nothing about "may approve *this*".
- `lib/db/` — the single data-access layer. Every exported function takes `ctx: AuthContext` first;
  ownership predicates are inside the query strings; `lib/db/driver.ts` is D1-shaped so the same
  SQL runs on D1 and on `node:sqlite` in tests.
- `lib/auth/channel.ts` — `BoardLinkChannel` is now the PRIMARY activation path, with printed codes
  for residents without a smartphone. `WhatsAppInboundChannel` exists and is **disabled**.
- `lib/storage/` — adapter interface, in-memory implementation, and a Google Drive skeleton whose
  three unproven assumptions are written into the file (A-07).
- `src/app.ts` — the Hono HTTP surface. No SQL, no permission logic; routes resolve identity, call
  `lib/db/`, map errors.
- `tools/lint-no-sql.mjs` — fails the build if SQL appears outside `lib/db/`.
- `npm run verify` now runs everything: **lint + typecheck + 69 unit + 20 access + 48 schema +
  30 invariant = 167 checks, 0 failures.**

**Verified how:**
- **CP-1 GATE MET:** all 15 access tests from `02_DATA_MODEL.md` §6 pass **over HTTP as each role**
  against the real app and real migrations — including the clock-advance delegate-expiry test and
  the former-owner test.
- Each leak test is paired with `proveReachable()`, which asserts the row it guards actually exists,
  so a green test cannot be an empty table.
- **Unverified, unchanged:** still nothing has run against real D1 (A-05, R-031).

**Two real bugs found by the gate, both fixed:**
1. A database refusal surfaced as **HTTP 500**. Every `RAISE(ABORT)` carries an Arabic message
   written for residents; letting it bubble up unhandled turned a *working control* into what reads
   like a crash. Refusals now map to 409 with the Arabic reason and no SQL detail.
2. The route verb `'reject'` was written straight into a column whose value is `'rejected'`. Both
   are valid strings, so `strict` TypeScript was happy; the state machine rejected the transition at
   runtime. Now an explicit lookup.

**Insights captured:** 6 new under "CP-1, session 3". **New risks:** none — R-004, R-017, R-028,
R-029 closed.

**Self-critique:**
- *Adversarial:* The remaining soft spot is the audit trail, not the access controls. `writeAudit()`
  is called on payment submit and review but **not yet on expenses, category changes, or phone
  changes** — and a phone change is the single most abuse-prone operation in a phone-identified
  system (R-003). An attacker's best move today is a path that is authorized but unlogged.
- *Fragility:* `resolveAuthContext` runs three queries per request and there is no caching. Fine at
  204 units; worth measuring against the D1 5M-reads/day budget before CP-3 ships dashboards.
  Second: `newId()` uses a process-local counter, which is fine in one Worker isolate and **not**
  guaranteed unique across isolates — it must become a real ULID before any concurrent writes.
- *Comprehension:* A resident who submits for a flat they do not own now sees "الوحدة دي مش بتاعتك"
  rather than a 500. A reviewer who tries an illegal transition sees why, in Arabic. That is the
  bug above, and it is the difference between a system that seems broken and one that seems careful.
- *Honesty:*
  1. **CP-1's first gate is still unmet** — nothing has touched real D1. The whole
     financial-integrity layer rests on `STRICT` and trigger `RAISE(ABORT)`, and Cloudflare
     documents neither. This is the top of the list and no amount of local green changes that.
  2. There is **no UI**. `src/app.ts` is a JSON API. No login screen, no upload flow, no Arabic
     strings file, no Tailwind, no passkeys. CP-2's real work has not started.
  3. The Google Drive adapter **throws on every method**. Storage is chosen, not built.
  4. `writeAudit` coverage is partial (above).
  5. No CI. `npm run verify` is green on my machine, which is exactly the phrase that should worry
     a reader.

**Next action:** wire the audit-log writes onto every mutating path, then CP-2 — passkey enrollment
and the activation flow — while a board-owned Cloudflare account gets created so the D1 gate can
finally run.

### [2026-08-04] — session 2 · the imaginary village
**Checkpoint:** CP-0 close-out + CP-1 groundwork
**Owner instruction:** *"Continue with imaginary data then I will provide the real data when I got it."*
Taken as authorising fabricated data **within C10's escape hatch only** — `seed/demo/`, impossible to
load into production. Not taken as answering Q1/Q2/Q4, which stay open.

**Done (things that actually run):**
- `migrations/0006_environment_guard.sql` — makes C10's "impossible" literal. Every demo id starts
  with `DEMO`; triggers on 8 money-bearing tables refuse them on a production database; a database
  holding money can never be relabelled; a demo database can never be promoted.
- `seed/demo/generate.py` — deterministic (seed 20260804), regenerates byte-identically. Produces
  **34 buildings (14–47) · 204 units · 205 people · 243 receipts · 250 journal entries · 30 expenses**,
  covering all nine payment states, 55 deposits, 12 overpayments, 2 waivers, 1 reversal, a delegate
  authorisation, staff, posts, an album and a bank reconciliation.
- `lib/money.ts` — branded `Piastres`, a parser that **refuses rather than guesses**, Arabic-Indic and
  Persian digits, Arabic separators, `splitByBasisPoints` (never loses a piastre), `allocateOldestFirst`.
- `lib/phone.ts` — E.164 normalisation for all five Egyptian shapes plus Arabic digits.
- `preview/finance.html` — the demo village rendered as an Arabic RTL page: resident home, the four
  separate `/finance` figures, expense breakdown, per-building status, admin review card, dark mode.

**Verified how:**
- `verify_demo.py` → **30 checks, 30 passed.** All twelve invariants from `06 §9` at full scale, each
  headline figure computed twice by independent routes.
- `money.test.ts` → **69 tests, 69 passed** under `node --test`, including all twelve edge cases from
  `02 §7`.
- `verify_ledger.py` → 48/48 still passing after the schema change.
- The guard was tested **in both directions**: demo data refused on production, and a demo database
  refused promotion to production.
- The preview was **rendered and looked at** (light + dark, 390px) — which is the only reason two
  bugs were found; see honesty below.
- **Unverified:** still nothing has run against real D1 (A-05, R-031). Unchanged and still first in CP-1.

**Decisions made:** no new ADRs. **Insights captured:** 8 new entries under "CP-0/CP-1, session 2".
**New risks:** R-035 (warn/danger tokens measurably too close), R-036 (demo data reaching production —
mitigated), R-037 (invented figures mistaken for real). **New assumptions:** A-13 … A-19.

**Self-critique:**
- *Adversarial:* The most dangerous artefact this session is `preview/finance.html`, not any code. It
  shows a confident **746,450.00 ج.م** treasury balance that is entirely fictional. Screenshotted and
  forwarded without its banner, it becomes a claim about the community's money. It carries a
  permanent Arabic warning at the top, every generated SQL file carries an `⚠️ IMAGINARY DATA`
  header, and R-037 tracks it — but the honest statement is that a document cannot fully defend
  itself once it leaves the repository.
- *Fragility:* `generate.py` emits SQL in the real posting order (entry → lines → post) precisely
  because a dump would not reload — inserting a posted entry before its lines trips
  `trg_line_no_insert_posted`. That is the schema working correctly, and it means **`sqlite3 .dump`
  is not a valid backup restore path for this database.** The CP-8 restore drill must use the
  migrations plus data-only inserts in dependency order, and this needs proving before launch.
- *Comprehension:* Rendering it exposed two things no test would have. Four categories displayed
  `0%` for real spending — a false statement about money produced by integer division. And the
  reconciliation date read `2026-07-31` where `31 يوليو 2026` belongs. Both are fixed. Both were
  invisible to a passing SQL suite.
- *Honesty:*
  1. Two of my own verification queries were **wrong** on first run and passed only after correction
     — one double-subtracted the reversed receipt (a 6,000 ج.م phantom), one summed gross credits and
     ignored the reversal. Neither was a schema bug. The demo data caught them; the 5-row fixture
     had not.
  2. There is still **no application code** — no Hono app, no routes, no `lib/db/`, no `lib/rbac.ts`.
     The CP-1 gate is *HTTP-level access tests as each role*, and that gate cannot even be attempted
     yet. CP-1 is groundwork only.
  3. `preview/finance.html` is a **static render**, not the product. It proves the views produce
     readable numbers. It proves nothing about interaction, upload, auth, or performance.
  4. The demo has no `needs_info` receipts and no partial-then-topped-up unit, so those paths are
     modelled in the state table but unexercised.

**Next action:** unchanged — Q19 and Q20. Everything buildable without a cloud account is now built.

### [2026-08-04] — CP-0 session 1
**Checkpoint:** CP-0

**Done (things that actually run):**
- Read the full spec pack (`01`–`06`, `CHECKPOINTS`, `DECISIONS`, `INSIGHTS`, `RISKS`, `AGENTS`).
- **Re-verified all ten free tiers** against each vendor's own current page. 17 facts recorded with
  URLs and dates in `docs/RESEARCH_SOURCES.md`; full register in
  `docs/QUOTA_AND_COST_REGISTER.md`. **Two findings break the plan as written** — see below.
- **Ported the Postgres schema to SQLite/D1**: `migrations/0001`–`0005`, 43 tables, 12 views,
  19 triggers. Applies cleanly on a real SQLite engine.
- Wrote `types/domain.ts` — every domain entity, branded `Piastres`/`BasisPoints`/`PhoneE164`,
  and `AuthContext` as a required argument type. **`tsc --strict` passes clean.**
- Wrote the category taxonomy and chart of accounts as `seed/prod/001`–`002`, with **no invented
  amounts anywhere** (C10). Both load and every category maps to a correctly-typed account.
- Rewrote `docs/OPEN_QUESTIONS.md` in Egyptian Arabic — 22 questions, each with a one-word-approvable
  default, ordered by urgency.
- New: `docs/ASSUMPTIONS.md` (12 tracked assumptions with owners and validation dates).

**Verified how:**
- `python3 tests/fixtures/verify_ledger.py` → **48 checks, 48 passed**, SQLite 3.45.1. Covers:
  STRICT rejecting a float in a piastres column · a 1.00 ج.م imbalance refusing to post · a deposit
  category refusing to map to income · journal lines and the audit log refusing UPDATE and DELETE
  for every role · a closed period refusing writes · illegal payment state transitions refused ·
  the E.164 boundary check · a phone number changing without touching ledger history.
- **Two guards were watched failing first**, by dropping the trigger and confirming the bad write
  then succeeds: the deposit→income constraint, and the balance check.
- The hand-computed fixture from `06 §2` reconciles exactly (assets 15,300.00 = liabilities 5,500.00
  + funds 10,000.00 + income 3,000.00 − expenses 3,200.00), and the view agrees with an independent
  raw-SQL aggregate.
- `npx tsc --noEmit --strict types/domain.ts` → clean.
- **Unverified / needs manual check:** whether **D1** accepts `STRICT` tables and trigger
  `RAISE(ABORT)` (A-05, R-031). Verified on SQLite 3.45.1 locally; Cloudflare documents neither.
  This must be the first thing checked in CP-1, before any application code.

**Decisions made:** ADR-014 (free-tier re-verification) · ADR-015 (R2 cannot satisfy C11) ·
ADR-016 (WhatsApp drops out of v1) · ADR-017 (five SQLite port decisions) · ADR-018 (the accounting
equation is a tautology and is demoted).
**Insights captured:** 13 new entries in `INSIGHTS.md` under "CP-0, 2026-08-04".
**New risks:** R-028 … R-034. R-004 and R-017 close if Q20 is approved.

**Self-critique (mandatory at checkpoint close):**
- *Adversarial:* The schema now refuses self-approval, illegal transitions, edits to posted entries
  and edits to the audit log — for **every** role including `developer`, because triggers do not
  check who you are. What it does **not** yet stop is reading: nothing here prevents a resident from
  fetching a neighbour's receipt, because that is `lib/db/` and the CP-1 access tests. The most
  likely real attack is now **the file-serving route**, not the database. It must re-check ownership
  per request against `storage_objects.unit_id`, and it must be tested as each role over HTTP.
- *Fragility:* An entry is legitimately unbalanced between its first and last line insert, so posting
  **must** be the final statement of a single `d1.batch()`. If a future contributor posts outside a
  batch, a crash mid-write leaves a draft entry with orphan lines — invisible on every screen,
  because `v_posted_lines` filters on `posted_at`. That is the right failure mode, but it needs a
  reconciliation sweep in `/admin/health` to surface stranded drafts rather than let them accumulate.
  Second fragility: `settings.storage_hard_cap_bytes` is advisory until the upload path actually
  reads it — the column existing is not the control.
- *Comprehension (would a 70-year-old understand this?):* Nothing user-facing was built, so this is
  untested. The one thing decided here that they will feel is the **four separate figures** on
  `/finance` rather than one "balance". A resident who sees "9,800 ج.م متاح للصرف" next to
  "5,500 ج.م ودائع — أمانات مش ملك القرية" learns something true. A resident who sees "15,300 ج.م
  رصيد القرية" learns something false. That is the whole reason for the fund split.
- *Honesty (what did I mark done that is only mostly done?):*
  1. **CP-0 is not complete.** Three of its ten items are done and one gate of three is met. The
     project scaffold, Tailwind RTL config, Arabic font and `messages/ar.json` were **not** started —
     `<first_actions>` says stop for approval before application code, and `CHECKPOINTS.md` CP-0
     still describes a Next.js + Supabase scaffold that ADR-008 superseded four days ago.
  2. The schema is verified on **SQLite, not D1**. Those are not the same claim.
  3. `v_deposit_leakage` joins `payments` to entries in two ways to survive both linking directions;
     it is correct on the fixture but has not been exercised against a reversal chain.
  4. The category taxonomy is transcribed from the pack, not confirmed by the board — the CP-0 gate
     requires written approval and does not have it.

**Next action:** wait for Q19 and Q20. They are procurement decisions and everything downstream
(storage adapter, auth channel, which accounts to create) depends on them.

---

## Owner decisions still needed
| # | Question | Recommended default | Asked on | Answered |
|---|---|---|---|---|
| **Q20** 🔴 | **نشيل واتساب من النسخة الأولى؟** (بيبقى بفلوس من 1 أكتوبر) | آه — لينك شخصي من المجلس | 2026-08-04 | ⬜ |
| **Q19** 🔴 | **صور الإيصالات تتخزن فين؟** (R2 بيطلب بطاقة ائتمان) | جوجل درايف باسم الجمعية | 2026-08-04 | ⬜ |
| **Q8** 🔴 | **اسم الموقع — لازم يتقرر قبل أول ساكن** (البصمة مربوطة بالدومين) | `qaryat-atebaa.pages.dev` | 2026-08-04 | ⬜ |
| Q1 🔴 | عدد العمارات والوحدات + ملف الملاك | ابعت الملف زي ما هو | 2026-08-04 | ⬜ |
| Q2 🔴 | قيمة الاشتراك السنوي، ثابت ولا بالمتر | ثابت لكل وحدة | 2026-08-04 | ⬜ |
| Q4 🔴 | أسماء العمالة تظهر لمين | الوظيفة والمرتب للكل، الاسم للإدارة | 2026-08-04 | ⬜ |
| Q3 | السنة المالية | 1 يناير – 31 ديسمبر | 2026-08-04 | ⬜ |
| Q5 | صفحة شفافية عامة | لأ في النسخة الأولى | 2026-08-04 | ⬜ |
| Q6 | مين كمان يبقى admin | الرئيس + أمين الصندوق | 2026-08-04 | ⬜ |
| Q9 | مدفوعات قديمة تترفع | السنة الحالية بس | 2026-08-04 | ⬜ |
| Q10 | المسؤول قانونًا عن البيانات | مجلس الإدارة، كتابةً | 2026-08-04 | ⬜ |
| Q11 | حالة السداد لكل شقة ظاهرة للكل | آه بموافقة الجمعية مكتوبة | 2026-08-04 | ⬜ |
| Q12 | حد التوقيع التاني للمصروف | 5,000 ج.م | 2026-08-04 | ⬜ |
| Q13 | بيانات التحويل (إنستا باي/بنك/فودافون) | — مطلوبة | 2026-08-04 | ⬜ |
| Q14 ⭐ | الوديعة: التزام ولا إيراد | التزام (أمانة) | 2026-08-04 | ⬜ |
| Q15 | مين المحاسب اللي هيعتمد | من سكان القرية | 2026-08-04 | ⬜ |
| Q16 | الزيادة في الدفع | رصيد دائن للمالك | 2026-08-04 | ⬜ |
| Q17 | التفويض | آه، بمدة محددة | 2026-08-04 | ⬜ |
| Q18 | الدخول بالبصمة | آه | 2026-08-04 | ⬜ |
| Q21 | دور خامس: مراجع مالي | آه | 2026-08-04 | ⬜ |
| Q22 | تسمية العمارات | أرقام زي الخريطة | 2026-08-04 | ⬜ |

---


## COLD-START BRIEF
> **The most important section in this file.** Rewritten at the end of every work block.
> Written for a stranger with zero memory of this project who must continue tomorrow.

**Read these first, in order:** `00_MASTER_PROMPT.md` → `CHECKPOINTS.md` → this file →
`DECISIONS.md` (ADR-014 onward is where the plan actually changed) → `INSIGHTS.md`
("Learned during the build") → `RISKS.md` (R-028 onward).

**One command tells you if it still works:** `npm run verify` →
**~726 checks, 0 failures.** That is 2 lint rules + typecheck + 107 unit + 407 HTTP
access/audit/auth/onboarding/transparency/views + 48 ledger invariants + 34 demo checks + 12
restore-drill checks + **41 screens rendered** + an axe-core WCAG 2.2 AA pass over all of them.
If it is green, the security and money layers are intact. **It has never run in CI — there is
none.** (`npm run a11y` needs `npm i -D playwright axe-core`; without them it SKIPS rather than
fails, so a green verify with no axe line is not an accessibility pass.)

**What exists and runs:**
`migrations/0001`–`0026` (every table `STRICT`) ·
`types/domain.ts` · `lib/money.ts` (integer piastres, branded) · `lib/phone.ts` ·
`lib/rbac.ts` (the permission matrix as data) · `lib/db/` (**the ONLY place SQL exists**, enforced by
`tools/lint-no-sql.mjs`) · `lib/auth/passkey.ts` + `lib/auth/channel.ts` ·
`lib/import/owners.ts` · `lib/storage/` (D1 blobs, ADR-023) · `src/app.ts` (Hono: JSON API + HTML) ·
`src/views/` (hand-authored RTL CSS, ADR-019) · `messages/ar.json` · `seed/prod/` ·
`seed/demo/` (204 units, **invented**) · `tests/` · `preview/`.

**There are three ways into an account, in this order:** a **passkey** (the design — one touch,
nothing to remember, nothing to phish); a **password** the board issues and the owner replaces
(`0026`, added because a phone with no Samsung Pass / Google Password Manager cannot enrol a passkey
at all — see session 33); and a **printed recovery code** (six single-use codes, reprintable from
`/me`). The password is deliberately second: it does not exist until an admin issues one, it is rate
limited to five guesses per 15 minutes, and it is destroyed by a deactivation or a recovery.

**A resident can, today:** log in with a passkey → see their balance → walk a five-step payment
wizard that survives switching to the bank app → upload a receipt → have it reviewed by someone who
is not themselves → open `/me` and see which devices can open their account, revoke one, change or delete their
password, and print a fresh sheet of recovery codes.
**An admin can:** review and POST payments, record expenses (countersigned by a second person),
open and publish a subscription year, close a period, publish news, run the village map, read the
journal entry by entry at `/admin/ledger`, **import the owner register from a screen**
(`/admin/import` — paste or upload, preview, then confirm), and — with a *second* admin —
**recover a locked-out resident from a screen** (`/admin/recoveries`), which revokes every device
and hands over one fresh activation link.

**⚠️ Three things a stranger must not misread:**
1. **Every figure in `seed/demo/` and `preview/` is invented** (A-13…A-19, R-037). The 746,450.00
   ج.م treasury balance is fiction. The owner has supplied **no** real numbers yet. When the real
   register arrives, **regenerate** — never edit demo values into real ones, because a half-edited
   demo is indistinguishable from real data. `migrations/0006` makes loading demo ids into a
   production database impossible in both directions.
2. **`sqlite3 .dump` is not a valid restore path.** The immutability triggers refuse a line inserted
   into an already-posted entry, so a dump replays in the wrong order and fails. Restore must replay
   migrations, then insert in dependency order with entries posted **last**. The CP-8 restore drill
   must prove this. **It is unproven.**
3. **A correct ledger does not imply a correct report** (R-043, R-045…R-048, R-050…R-052 /
   ADR-025). **Twelve** presentation-layer defects were found this way — and **zero** ledger defects.
   Every control on this project guards how money is *recorded*; almost nothing guards how it is
   *shown*, and the screen is the entire product. Budget a render-level test before an
   integrity-level one. Three shared one
   silent SQL mistake — `LEFT JOIN accounts a ON … AND a.type='asset'` is **not a filter**; the ON
   clause decides whether the right row attaches, never whether the left row survives. Before
   trusting any aggregate view, ask: **do both sides of this comparison measure the same thing?**
   Original instance: `v_unit_balance`
   compared dues against *every* approved payment, so a flat's الوديعة cancelled its subscription
   arrears and the headline متأخرات was understated by the whole deposit pool. Every R-020 defence
   passed — the error was in a **reporting view**, not the ledger. Migration `0011` fixed it. Before
   trusting any view, ask: **do both sides of this comparison measure the same thing?**
4. **The accounting equation is a TAUTOLOGY.** `06 §9` and the master prompt both call it the test
   that catches most financial bugs. It does not catch the one that matters: a ledger with الوديعة
   booked to income shows `residual = 0` while overstating spendable money by the entire deposit
   pool — proved in `tests/fixtures/verify_ledger.py` §8, recorded as ADR-018. The real defences are
   the category→account `kind` trigger, `v_deposit_leakage`, and the operating/deposit fund split.
   **Do not let anyone "simplify" those away because the equation passes.**

**Why there are no vendors left to bill us:** R2 needs a credit card to create a bucket *at all*
(ADR-015) · WhatsApp service messages become billable 2026-10-01, so WhatsApp is out of v1 entirely
(ADR-016, owner-approved) · Google service accounts have **no Drive quota** and fail
`403 storageQuotaExceeded`, which falsified A-07 (R-041) · receipts measured at **5–6 KB**, not the
spec's 500 KB, which is why they live in D1 and the last storage vendor disappeared (ADR-023).
**There is now no credit card anywhere in the stack.**

**The single next action, in order:**
1. **`bash tools/verify-d1.sh`** from the owner's own machine, after `wrangler login`. It answers the
   two questions the entire financial-integrity layer rests on: does D1 accept **`STRICT` tables**,
   and does it honour **`RAISE(ABORT)` inside triggers**? Cloudflare documents neither (A-05, R-031).
   **This has been open since day one** — not because it is hard, but because outbound network access
   to `api.cloudflare.com` is blocked from the build sandbox. If it fails: strip `, STRICT`, move
   trigger logic into `lib/db/`, and **immediately re-raise R-020**.
2. **Revoke the five credentials** pasted into the chat on 2026-08-04 (R-038, R-040). None was ever
   usable from the sandbox — that is luck, not a control.
3. **A purge for soft-deleted blobs.** «شيل الصورة» hides an invoice from the site and leaves the
   bytes in `receipt_blobs` — so a privacy repair is currently a promise the storage layer does not
   keep. Then **CP-6**, the last checkpoint with nothing started.
4. Replace `newId()`'s process-local counter with a real ULID before any concurrent writes.
5. Chunk `commitImport` — it writes a whole batch in one `db.batch()`, tested at 50 rows, and D1 has
   statement limits nobody has measured.

**Watch out for:** posting a journal entry outside a single `db.batch()` (an entry is legitimately
unbalanced mid-insert) · adding a KV write to any unauthenticated path (1,000 writes/day is the
tightest quota in the stack, R-032) · searching Arabic without folding ة/ه and أ/إ/آ (FTS5's
unicode61 does not, R-033) · creating any cloud account in the developer's name rather than the
board's (R-034) · reading a `Response` body twice (use `send()` — I made this mistake twice).

**Do not:** add email/password auth · store money as float · **foreign-key to a phone number** ·
**book الوديعة or an overpayment as income** · write SQL outside `lib/db/` · sign up for anything
requiring a card, even where "you won't be charged" · invent a fee amount, a bank detail, or a
resident name outside `seed/demo/` · let anyone approve their own financial item, **including
`developer`** · tick a checkpoint gate whose number a later ADR made meaningless — rewrite the gate.
