# INSIGHTS — hard-won knowledge

> **Agent: append the moment you learn something, not at the end of the session.**
> A lesson not written down will be re-learned expensively.
> Format: `**[YYYY-MM-DD] [tag] Insight.** Why it matters / what to do.`
> Tags: `rtl` `arabic` `supabase` `rls` `money` `otp` `upload` `perf` `ux` `egypt` `agent`
>
> **Compaction rule:** past ~200 lines, consolidate. Delete insights the code now enforces
> structurally — a lesson encoded in a type or a database constraint no longer needs prose.
> Last consolidated: —

---

## Seeded before the build — verify each against reality, then keep or correct

**[2026-08-03] [rtl] Numbers scramble inside RTL text unless isolated.** `1,234.50 ج.م` inside an
Arabic paragraph renders with the parts reordered by the bidi algorithm. Wrap every number, phone
number, and reference code in `<bdi dir="ltr" class="tabular-nums">`. Expect this bug to appear at
least once in every new screen — add it to the review checklist rather than trusting memory.

**[2026-08-03] [rtl] Tailwind's directional classes are the second-biggest RTL trap.** `ml-4` does not
flip in RTL. Use `ms-4`/`me-4`, `ps-`/`pe-`, `start-`/`end-`, `text-start`/`text-end`. Add an ESLint
rule banning the physical variants on day one — retrofitting is far more expensive than preventing.

**[2026-08-03] [arabic] Users type Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩).** Any numeric input — amount,
phone, OTP — must normalize them before parsing. `parseFloat("١٢٣")` is `NaN`. Normalize at the input
boundary and unit-test it.

**[2026-08-03] [egypt] Egyptian phone numbers arrive in at least five shapes:** `01012345678`,
`1012345678`, `+201012345678`, `00201012345678`, and with spaces or dashes. Normalize to E.164 with a
database trigger, not only in the client — the bulk import will feed the database directly.

**[2026-08-03] [money] `SUM()` over an empty set returns `NULL`, not `0`.** Every financial aggregate
needs `COALESCE(SUM(x), 0)`. A brand-new community with no payments will otherwise show a blank
treasury balance on launch day — the worst possible first impression.

**[2026-08-03] [rls] RLS is not applied to the table owner or the `service_role` key.** A test that
runs as `service_role` proves nothing. RLS tests must authenticate as an actual user JWT. Always
verify a policy by watching it **fail** against a deliberately loosened version.

**[2026-08-03] [rls] Views do not inherit RLS from their base tables by default.** A view created by a
privileged owner bypasses the underlying policies. Use `security_invoker = true` on views that expose
row-level-restricted data, and test each view's access separately from its tables.

**[2026-08-03] [supabase] Storage policies are separate from table policies.** Locking down the
`payments` table does nothing for the receipt image. The bucket must be private, path-scoped by unit,
and served only through short-lived signed URLs. Test image access as a second, distinct RLS test.

**[2026-08-03] [otp] Store the hash of the code, never the code.** And burn the challenge on the 5th
wrong attempt rather than merely rate-limiting — a persistent attacker with a 6-digit space and
unlimited attempts wins eventually.

**[2026-08-03] [otp] WhatsApp Business API setup requires Meta business verification and takes days.**
This is the longest lead-time item in the whole project and it sits inside CP-2. Start it during CP-0.
Build everything against a console/dev channel so no work is blocked meanwhile.

**[2026-08-03] [otp] Reversing the message direction makes login free AND easier.** Meta bills
outbound authentication messages but gives 1,000 *customer-initiated* service conversations per month
free. Letting the resident tap a `wa.me` link with a pre-filled token and press send costs nothing —
and it deletes the read-the-code-then-retype-it step, which is exactly where elderly users abandon.
The cheapest option turned out to be the most usable one. Look for that pattern elsewhere.

**[2026-08-03] [free-tier] Supabase's free plan pauses a project after one week of inactivity.**
Fine for a demo, disqualifying for a seasonal summer community whose site may sit quiet through
January. Always check the *inactivity* policy of a free tier, not just its size limits — it is the
clause that actually bites.

**[2026-08-03] [free-tier] Free tiers vanish.** PlanetScale deleted its Hobby plan outright in 2024.
Never let a vendor's API leak past its adapter module, and write the migration trigger conditions
*before* you need them.

**[2026-08-03] [free-tier] Google Sheets/Drive is not a database.** No transactions, no row locking,
no per-row permissions, per-minute API quotas, no indexes, and anyone with edit access can silently
rewrite history. Every one of those is individually fatal for a money ledger. Drive *is* excellent as
a free off-site backup target owned by the board rather than the developer — use it exactly there.

**[2026-08-03] [upload] Phone photos of bank receipts are 4–12 MB.** Uploading raw over a Matrouh 3G
connection fails often and burns the resident's data. Compress client-side to ~1600px / ~500 KB with
`browser-image-compression` before upload, and keep the original's EXIF timestamp for the duplicate check.

**[2026-08-03] [upload] Approval must be idempotent.** A resident on a slow connection taps the button
twice; an admin's phone retries the request. Use a conditional update (`where status <> 'approved'`)
and post only when one row changed. Read-then-write will eventually double-count real money.

**[2026-08-03] [ux] Elderly users abandon at the OTP screen more than anywhere else.** Mitigations
that matter: large separate digit boxes, WebOTP autofill on Android, a visible countdown rather than
a silent expiry, a resend that actually works, and a "محتاج مساعدة؟" button that opens WhatsApp to a
real person.

**[2026-08-03] [ux] "لا توجد بيانات" is a dead end.** Every empty state must name the next action.
This is the cheapest usability win in the entire product and it is skipped by default.

**[2026-08-03] [agent] The context window will end before the project does.** Treat `PROGRESS.md`,
`DECISIONS.md`, and this file as the real deliverable of every session. The code is recoverable from
git; the reasoning is not.

**[2026-08-03] [agent] Write the cold-start brief for a stranger, not for yourself.** "Continue where
I left off" is meaningless to a fresh session. Name the file, the function, and the next concrete action.

---

## Added after reviewing an independent specification for the same project (2026-08-03)

**[2026-08-03] [auth] Passkeys beat every messaging-based login on all four axes at once.** Free
(no vendor, no quota), faster (one touch), safer (phishing-resistant, and a phone change alone no
longer opens an account), and — the decisive one here — they delete the read-a-code-then-retype-it
step, which is exactly where elderly users abandon. The cost optimization and the usability
optimization pointed at the same answer. That happens more often than it seems; check for it before
accepting a trade-off as real.

**[2026-08-03] [data] Never let a mutable attribute become an identity.** A phone number is a login
*identifier*, not a key. People change numbers, transfer flats, and die; two records collide on one
number. Give every person an immutable internal id and keep phone numbers in their own table with
history. This is cheap on day one and unrecoverable on day four hundred, after real money is posted.

**[2026-08-03] [money] The most dangerous financial bug is the one that looks correct.** Booking
الوديعة as income overstates the village's spendable balance by the entire deposit pool — and every
screen renders perfectly. Deposits and overpayments are **liabilities**. The accounting equation
(`assets = liabilities + funds + income − expenses`) is one test that catches this whole class of
error; write it before anything else in the ledger.

**[2026-08-03] [money] "Approved payments minus expenses" is a tally, not an accounting record.** It
cannot answer "where did the الوديعة go?", cannot reconcile to a bank statement, and cannot survive
a hostile question at a general assembly. Double-entry is more work up front and the only thing that
is defensible later.

**[2026-08-03] [free-tier] Read the *overage* clause, not just the allowance.** Cloudflare R2 gives
10 GB free with free egress — and bills at standard rates past it, rounding up. A free allowance that
can bill is not the same as a service that cannot bill. If strict zero is the requirement, either
enforce a hard cap in your own code well below the ceiling, or pick something with no billing path
at all.

**[2026-08-03] [free-tier] Check whether a limit is per-resource or per-account.** D1's free tier is
**500 MB per database**; the 5 GB figure is the account total. Easy to misread, and it changes the
five-year forecast and the "never store blobs here" rule.

**[2026-08-03] [agent] Label your epistemic state.** `confirmed requirement` / `approved decision` /
`verified external fact` / `engineering inference` / `temporary assumption` / `open question`. A
non-technical owner cannot distinguish your assumption from his own requirement unless you mark it.
This one habit prevents more downstream rework than any amount of extra documentation.

**[2026-08-03] [governance] Separation of duties is a process control, and code can only expose it.**
If the board is one active person, maker–checker is theatre. The honest move is a visible warning on
the admin dashboard, not a silent pretense that the control exists.

---

## Learned during the build
*(agent: append below)*

### CP-5, 2026-08-05 (session 24) — repairs

**[2026-08-05] [ux] ⭐ A repair must not claim more than it does.** «شيل الصورة» stops anyone opening
the invoice from now on. It does **not** un-see it for the residents who already did, and the
confirmation says so in one sentence, followed by what to actually do: *«بلّغه»* — tell the supplier.
A button that implied the exposure was undone would leave the operator relieved and the supplier
exposed. **When the only available action is partial, the screen has to be the thing that says so.**

**[2026-08-05] [security] Removing evidence is not the same capability as recording it.** The remove
action needs `expense.countersign`, not `expense.record` — otherwise "delete the invoice" is a power
held by the role that exists to have **no** financial authority. Deletion capabilities tend to get
attached to whoever creates the thing; ask separately who should be able to destroy it.

**[2026-08-05] [agent] A test encoding a superseded decision must be rewritten with the decision,
not worked around.** `listPostedExpenses` had a test asserting the invoice key is never exposed —
correct before ADR-026 and wrong after. The lazy fixes are to delete the test or to weaken it. The
right one was to work out what the *new* invariant is (expose the key only when the caller may open
it — a link that 403s tells a resident the evidence is hidden from them specifically) and assert
that. **When a decision changes, its tests are part of the change.**

### CP-5, 2026-08-05 (session 23) — evidence, and a right nobody in the room holds

**[2026-08-05] [agent] ⭐ When a new field would cost a property the screen exists for, make it a
second step.** The expense form's claim is five fields, no JavaScript, sixty seconds. An image needs
JavaScript to compress, so adding it to the form would have quietly ended the claim. Making the photo
a separate optional screen kept both — and a test now asserts the entry form has **no file input**,
so the regression is loud rather than gradual. **The cost of a feature is not its code; it is the
property it takes from the thing it is added to.**

**[2026-08-05] [egypt] 🔴 The person whose data is at risk is not in the room.** A supplier's invoice
carries the supplier's phone number and bank details, and `01_PRD` C2 publishes expenses to 204
residents. The resident wants proof; the board wants transparency; **the supplier never consented and
has no vote here.** PDPL 151/2020 has no "but transparency" exception. When a requirement exposes a
third party, name them explicitly in the ADR — otherwise every participant in the decision benefits
from it and the argument only has one side.

**[2026-08-05] [ux] The cheapest control is the person holding the camera, told beforehand.** Cover
the supplier's number with a finger and the data never enters the system — no storage rule, retention
policy or access check can match that. So the warning sits **above** the file input, not below, and a
test asserts the ordering. Controls applied after capture are all repairs; the only prevention is
upstream of the shutter.

**[2026-08-05] [agent] A redaction that misses once is worse than none.** Automatic blurring of an
Arabic invoice photo was tempting and was rejected: unreliable detection teaches everyone the problem
is handled, so nobody checks, and the one that slips through is seen by everybody. **An imperfect
automatic safeguard can be more dangerous than an honest manual one**, because it removes the
vigilance that was doing the real work.

**[2026-08-05] [agent] I wrote a rule one session ago and broke it in this one.** Session 22's
insight was "built and startable are different states". This session I computed
`v_expenses_without_evidence` and displayed it nowhere. Writing a lesson down does not install it —
the only thing that would have caught this is the check the lesson itself names, run as a step rather
than remembered as a principle.

### CP-7, 2026-08-05 (session 22) — provisioning

**[2026-08-05] [agent] ⭐ A guard you can silence by editing a row is a guard that gets silenced.**
The VAPID fingerprint row is immutable — update and delete both `RAISE(ABORT)`. The tempting design
is "record it, and let an admin update it when it legitimately changes", but there is no legitimate
change: a different key means every subscription in the village is already orphaned, and the honest
repair is to **put the original key back**. An editable guard would let whoever is in a hurry bless
the damage instead of undoing it. **When a control exists to make an irreversible mistake visible, do
not give it an off switch.**

**[2026-08-05] [ops] A fingerprint lets a non-technical person verify a secret they must never
handle.** The board needs to know the deployed push key is the right one. They cannot check the
private key and should never see it. Twelve characters of a SHA-256 of the *public* key, printed by
the generator and written in the minutes, makes that checkable by anyone — and is useless to an
attacker. **Where a human must verify a credential, give them a fingerprint, not the credential.**

**[2026-08-05] [agent] Third time: an error's `message` must carry the sentence that says what to
do.** `VapidChanged` put its Arabic in `reasonAr` only, so a log line read "vapid key changed" —
technically accurate and operationally useless. `Forbidden` needed the same fix in session 3 and
`LedgerRefused` in session 6. The rule is now unconditional: **if an error class has a human-readable
reason, it goes in `message` too**, whatever else it also goes in.

**[2026-08-05] [agent] "Built" and "startable" are different states, and only one of them ships.**
Web Push was complete, tested against the RFC vector, wired into every decision — and had no way to
generate the key it needs, so the whole feature was inert. Same shape as the reversal engine with no
screen (session 18) and the notifications nobody could read (session 20). **Three times in five
sessions.** The check that would catch it: after finishing a feature, describe the first five minutes
of someone using it for real, starting from an empty deployment.

### CP-7, 2026-08-05 (session 21) — Web Push

**[2026-08-05] [agent] ⭐ When you cannot test the thing, test against the spec's own vector.** Push
endpoints are unreachable from this sandbox, and RFC 8291 encryption **fails silently** when it is
wrong — a bad derivation yields a well-formed body, the push service returns `201 Created`, and the
browser cannot decrypt. Every message would vanish successfully. RFC 8291 §5 publishes the complete
worked example, so the test reproduces it byte for byte and pins every intermediate value. That is
a *stronger* check than a live send, which only proves "something arrived". **Before concluding a
component is untestable here, look for a published vector** — SigV4 had one too.

**[2026-08-05] [free-tier] The most durable free thing is the one that is not a product.** Web Push
costs nothing because the browser vendors' push services are part of the browser, not a business —
there is no account to create, no card, no quota page, and nothing to withdraw in 2027 the way
PlanetScale withdrew its Hobby plan. Compare WhatsApp, which was free and starts billing on
2026-10-01. **When choosing a free dependency, prefer a protocol to a plan.**

**[2026-08-05] [ux] A notification renders on a locked screen anyone nearby can read.** «التحويل رجع
من البنك يوم ١٢ مايو» is nobody else's business. The payload carries the title, the first line
truncated, and a link — the amount, the receipt reference and the full reason stay behind the
session. Treat push text as *public*, and put the private half one tap away.

**[2026-08-05] [ux] A service worker with a `fetch` handler can lie about money.** It would serve a
cached treasury balance and the resident could not tell — on a financial-transparency site that is
the software deceiving people by itself, with no bug involved. Ours registers `push` and
`notificationclick` and nothing else, and a test asserts the absence.

**[2026-08-05] [agent] A courtesy layer must never be able to break the record.** Delivery runs after
the transaction commits, and every failure is swallowed and counted. If a dead phone could make an
admin's approval fail, the village's books would depend on Google's uptime. **Whenever a side effect
is added to a critical path, ask what happens when it fails — and if the answer is "the critical
thing fails too", it is on the wrong side of the commit.**

### CP-4, 2026-08-05 (session 20) — the inbox

**[2026-08-05] [security] A notification body is as private as a receipt image.** It quotes an
admin's reason verbatim — «التحويل رجع من البنك» — against a named receipt. So the C6 predicate goes
inside the query like every other one, and there is **no admin override**: an admin who needs to know
what a resident was told reads the payment's `review_reason_ar`, the same text under a capability
that already exists. A route that reads another person's inbox would be a new power nobody asked for,
justified by a convenience nobody requested.

**[2026-08-05] [security] ⭐ Not everything belongs in the audit log, and the reflex to log
everything is how surveillance arrives by accident.** `mutate()` exists so a change to *money or
identity* cannot commit unlogged. "سعاد opened her messages" is neither — and logging it would put
one resident's reading habits in a table five board members can read. The audit log is for
accountability over **shared money**, not a record of what individuals looked at. There is now a test
asserting the audit log has no notification-read rows, because this is the kind of line that gets
crossed by someone being thorough.

**[2026-08-05] [ux] Capture the list before marking it read.** Opening the inbox marks everything
read, so there is no "mark as read" control to hunt for — on a phone held by someone who does not
enjoy phones, a button that only manages the interface is a tax. But mark-then-render highlights
nothing, which is the same as not telling them. Read first, mark second: the visit that clears the
badge is still the visit that shows what was new.

**[2026-08-05] [agent] The same ordering coupling for the third time.** A test asserted "something is
unread" after an earlier test in the same file had already opened the inbox. Twice before I fixed an
instance and wrote the lesson down; the lesson has not changed the way I write the *first* draft.
The rule that would: **a test that depends on state must create that state itself**, always, even
when the fixture appears to provide it.

### CP-4, 2026-08-05 (session 19) — telling the resident

**[2026-08-05] [ux] 🔴 The everyday cases were silent and only the rare bad one spoke.** Approved,
rejected, needs-info and duplicate all sent **nothing**; the single message this system had ever been
able to send was "we took your approval back". A resident whose receipt sits at «تحت المراجعة» with
no follow-up asks in the WhatsApp group — **the exact habit this product exists to replace**. Every
silent success pushes one family back to the thing that caused the problem. When auditing a feature,
list the events a *user* can observe, not the ones the system records.

**[2026-08-05] [ux] ⭐ A duplicate must not be announced as a rejection.** The money arrived; it was
counted once. A resident reading «اترفض» believes a real transfer was thrown away, and now there is a
phone call and a grievance over a receipt that was handled correctly. Same status class internally,
completely different message: «الإيصال الأصلي اتحسب، فما تقلقش — الفلوس مش ضايعة». **The internal
taxonomy is not the user's taxonomy**, and collapsing them is free for the developer and expensive
for the reader.

**[2026-08-05] [ux] A refusal with no next step sends the person to the board, not to the screen.**
Every decision message names what to do, and a rejection ends «الرفض ده مش نهائي». An adjusted
approval says **both** numbers and the reason — telling a family "accepted" after correcting 8,000
down to 6,000 is how they discover the difference two months later and conclude money went missing.

**[2026-08-05] [agent] Idempotent write + unconditional side effect = a duplicate the user sees.**
`reviewPayment` was carefully idempotent (a second approve changes 0 rows), and a notification in the
same batch would have been written anyway — twice, on exactly the connection quality that makes
people tap twice. The fix is a **partial unique index plus `INSERT OR IGNORE`**, not a check-then-
insert: two statements that must agree are two statements that will eventually disagree. Whenever an
operation is made idempotent, audit everything that rides along in its transaction.

**[2026-08-05] [agent] A weakness recorded honestly is a to-do that gets done.** R-063 shipped with
"`notified` matches on kind + link_path, not payment id — a weak check that reads like a strong one"
written into the risk register. One session later that sentence was the specification for the fix.
Writing down what your control does *not* cover costs one paragraph and is the only reason the gap
was still visible a session later.

### CP-4, 2026-08-05 (session 18) — the reversal screen

**[2026-08-05] [agent] 🔴 A control nobody can reach is a control that does not exist.** Payment
reversal shipped with an engine, a two-admin rule in the schema, a resident notification in the same
batch, and 17 passing tests — and the board could not correct a single receipt, because there was no
screen. The tests measured the code, not the capability. **Ask what a user can now do that they could
not before; if the answer needs a test runner, nothing shipped.**

**[2026-08-05] [ux] ⭐ Never put the caller's own name in the picker for a two-person control.**
`reversePayment` refuses self-approval, so listing yourself is "safe". It is also an invitation: the
admin selects themselves, gets refused, and learns the system is fussy rather than that the rule
exists for a reason. The dropdown excludes them. And a checkbox — "I confirm a second admin agreed" —
was rejected outright: that is a lie waiting to be told, while **naming a person puts someone on the
record who can be asked**.

**[2026-08-05] [ux] Put the warning where the decision still is.** By the time an admin reaches the
submit button they have decided; a caveat under the button is decoration. The reversal banner sits
above the fields and says three concrete things — the resident was told it was accepted, their
arrears come back, and they will read this reason word for word.

**[2026-08-05] [agent] "Newest" is not an identifier.** A test asserted on the notification by
`ORDER BY created_at DESC` and picked the wrong row: `created_at` is second-precision, and two events
in one second order arbitrarily. Matching on the receipt number is both correct and clearer about
what is being claimed. Any assertion that relies on ordering to identify a row is a race that passes
until it doesn't.

### CP-4, 2026-08-05 (session 17) — payment reversal

**[2026-08-05] [security] ⭐ Maker–checker has a mirror, and only the mirror stops the realistic
fraud.** The usual rule is "the person who made it cannot approve it". Reversal needs the other one:
**the person who approved it cannot quietly un-approve it.** Without that, one admin approves a
family's receipt, takes the credit for it in person, and reverses it a month later with nobody else
ever having looked — which is the actual shape of small-community embezzlement, not the textbook
one. Any time a system gains an "undo", ask who is excluded from pressing it.

**[2026-08-05] [ux] A correction the affected person is not told about is indistinguishable from
theft.** The notification is written in the **same `db.batch()`** as the reversal, so "we'll notify
them later" is not a representable state, and `v_reversed_payments.notified` makes an un-notified
reversal visible to anyone who looks. For a correction that takes something away from a named
person, delivery of the explanation is part of the transaction, not a follow-up task.

**[2026-08-05] [accounting] Mirror the lines that exist; do not assume the shape.** A subscription
paid with an overpayment posts three lines — cash, income, and an owner credit. Reversing a
hard-coded two-line shape would leave the credit behind: a balance the village still owes for money
it no longer holds. Reading the original entry and flipping each line is the only version that is
correct for a subscription, a deposit and an overpayment at once. **Whenever a correction is written
against a remembered shape rather than the recorded one, it is right until the first exception.**

**[2026-08-05] [agent] Third time this week a trigger refused my design, and third time the fix was
a pattern already in the codebase.** Journal-level maker–checker refused a self-approved reversing
entry. The answer was `changePhoneNumber`'s `secondAdminId` — a control written five sessions ago for
a different problem. Before inventing a mechanism to satisfy a constraint, grep for the constraint's
name: the codebase has usually already answered it once.

**[2026-08-05] [agent] A new control whose first act is to reject your own fixtures is working.**
`trg_payment_reversal_needs_actor` immediately failed `seed/demo/`, whose one reversed receipt was
written before the rule existed and recorded no actor. The temptation is to weaken the trigger; the
right move is to fix the data — the demo was modelling a state the system should never have allowed.

### CP-5, 2026-08-05 (session 16) — the screen

**[2026-08-05] [ux] The interface must not offer what the rules forbid.** The expense screen showed
an operator a «رحّل على الدفاتر» button. The server would have refused it, so no money could move —
and that is not the point. A button that fails teaches the user the *system* is broken; a button that
is absent, with the reason in its place, teaches them they lack *authority*. Same for the fund
dropdown: `trg_expense_fund_spendable_*` refuses a deposit fund, so صندوق الودائع is not listed. The
control stays in the database; the interface's job is to agree with it.

**[2026-08-05] [security] `Forbidden` and a business-rule refusal are different facts and must not
share a status code.** The routes caught both and re-rendered the page with the message, status 200.
"This expense cannot be posted yet" is a state of the **expense** and belongs in context. "You do not
hold this capability" is a state of the **caller** — and a friendly 200 lets someone probe the system
by typing URLs and reading which ones came back nicely. Refusals that describe the caller should be
terse and uniform; refusals that describe the data should be helpful.

**[2026-08-05] [agent] A test can be wrong in the direction of paranoia, and that still costs.** I
asserted an operator gets 403 on `/admin/expenses`. `04_UX_SPEC` line 82 puts 60-second expense entry
under `/ops` — recording the plumber's receipt is that role's entire purpose. Had I "fixed" the code
to match the test, I would have deleted the operator's only job to satisfy an assertion I invented.
When a test fails, check the spec before checking the code.

**[2026-08-05] [agent] Second false positive from my own linters, same right answer.** `<select
id="category">` in the expense form was flagged as SQL. The tempting fix is a file exception; the
correct one is to make the rule precise (`(?<![</])`) and then watch it still catch a real query. A
linter you have taught yourself to ignore is worse than no linter, and an allow-list is the first
step in teaching yourself.

**[2026-08-05] [ux] When a requirement is not measurable, test the preconditions and say so.**
"60-second expense entry" needs a volunteer and a stairwell. What is checkable from here: the entry
form is literally first in the HTML, it asks for exactly five fields, the date is pre-filled, and it
works with JavaScript off. Those do not prove 60 seconds — they make it possible, and the checkpoint
says which half has been verified rather than ticking the whole thing.

### CP-5, 2026-08-05 (session 15) — reversal

**[2026-08-05] [accounting] 🔴 The correction path is the one most likely to be the unguarded
path.** My first `reverseExpense` created the reversing entry and posted it in a single call, one
admin as both recorder and approver. The `expenses` maker–checker CHECK refused it. The instinct
was to special-case the reversal past the constraint; the right move was to notice that **reversing
moves money back**, so C8 applies to it exactly as it applies to the posting it undoes. Reversal is
now two steps and the reversing row is an **ordinary expense row** — so the spendable-fund trigger,
the open-period trigger, maker–checker, the balance check and the already-posted refusal all protect
it without a line of new code. Any time a correction path needs its own posting logic, ask what
guards it just walked around.

**[2026-08-05] [agent] A constraint refusing your design is information, not an obstacle.** Three
times this week the database refused something I wrote — the state machine on a payment shortcut, the
journal-level maker–checker on below-threshold posting, and now this. Each time the refusal was
right and my design was wrong, and each time the fix made the system simpler rather than more
special-cased. A schema built to encode rules will argue with you; the arguing is the value.

### CP-5, 2026-08-05 (session 14) — expenses, and three things the tests found first

**[2026-08-05] [agent] 🔴 A helper is only correct for the arguments it has been called with.**
`newId()` padded to a fixed 23 characters, which is right only for a three-letter prefix — and it had
only ever been called with `PAY`, `AUD` and `UOW`. `newId('JE')` returned **25** characters and every
`CHECK (length(id) = 26)` refused it. Thirteen sessions, 300 passing checks, a 204-unit demo village,
and none of it touched the bug, because **every id in every seed and fixture was written by hand**.
The first runtime code path to generate a journal entry hit it immediately. A fixture that supplies
its own ids never exercises the id generator — and the generator is the part that ships.

**[2026-08-05] [security] 🔴 Posting is approving.** `postExpense` was guarded by `expense.record`,
which the **operator** role holds — recording the plumber's receipt is that role's entire purpose.
But posting stamps `approved_by` on the journal entry and moves the treasury figure on every
resident's screen. An operator could move money. Found because a test written to assert an operator
is refused **watched one succeed**. Ask of every new function not "who does this?" but "what does the
system look like after it runs?" — the second question is the one that names the capability.

**[2026-08-05] [accounting] ⭐ The threshold and maker–checker answer different questions, and the
threshold is the weaker one.** `trg_entry_maker_checker` refuses any journal entry whose creator is
its approver, with **no threshold and no exemption**. Fighting that would have been the easy move.
The right reading is that the two controls are not competing:
  · the **threshold** decides whether a countersignature is *recorded* — a named second approval on
    large amounts, the thing a board minutes;
  · **maker–checker** decides whether two humans touched the money *at all*, and per C8 that has no
    threshold, including for `developer`.
So a 300 ج.م receipt still needs a second person to post it. On a two-admin board that is one tap by
whoever did not type it in — and it is the whole reason a community that already distrusts its
previous treasurer might trust this.

**[2026-08-05] [accounting] Prevention beats detection wherever prevention is possible.** R-049
answered "have we spent the residents' deposits?" with a banner. Correct, and second-best: an أمانة
is not the village's money, so the *write* should be refused. `trg_expense_fund_spendable_*` does
that. **The banner stays** — the trigger guards the path through `expenses`, and a hand-written
journal entry could still reach the same place. The rule that fell out: prevention where the shape of
the data allows it, detection everywhere else, and never delete the detector because you added the
preventer.

**[2026-08-05] [agent] The mirror image of R-043 was sitting in plain sight the whole time.** Every
audit this week asked "is the number shown wrong?" Nothing asked "**is a number missing entirely?**"
Expenses were recorded and never posted, so `/finance` showed all income and no costs — the treasury
overstated by the year's entire spending, and no figure on the page was individually incorrect.
Absence is a presentation bug too, and it is harder to see because there is nothing to check.

### CP-3, 2026-08-05 (session 13) — the label audit

**[2026-08-05] [agent] 🔴 A caption above a number is a claim, and it is the only part of the
system nothing tests.** Every assertion in this project checks that a figure is *arithmetically*
right. Not one checked that the Arabic sentence above it describes what is in it. Two of the four
tiles on `/finance` were wrong: «ودائع وأرصدة للملاك» included **money owed to contractors**, and
«رصيد أول المدة» was actually every fund account including reserves. For a resident these are
indistinguishable from wrong arithmetic, because the sentence is all they have to interpret the
number by. **Assert the caption, not just the value** — `v_community_totals` now emits one column
per caption, and a test asserts the captioned columns account for every account of that type.

**[2026-08-05] [agent] Both label bugs were invisible because the exposing account was empty.**
Supplier payables were zero (no invoice had gone unpaid in the demo) and both reserves were zero. A
fixture that only contains the *happy* shape of the data cannot expose a misclassification — the
wrong bucket and the right bucket both read zero. The fix was to make the fixture post an ordinary
unpaid contractor invoice and an ordinary transfer into a reserve. **When auditing an aggregate, put
a non-zero value in every category it claims to separate**, especially the boring ones.

**[2026-08-05] [accounting] Splitting a caption must not move the number underneath it.** It was
tempting, having separated supplier payables out of "held in trust", to also stop subtracting them
from الفلوس المتاحة للصرف. That would have been wrong: money promised to a contractor is not
available to spend either. The treasury figure is unchanged and a test asserts it — only the
attribution moved. **A relabelling that also changes a total is two changes, and the second one
needs its own argument.**

**[2026-08-05] [agent] A shared-fixture test that asserts a literal is coupled to suite order.** The
opening-balance assertion used `1_000_000` and failed at 1,500,000 — because a test in an earlier
`describe` in the same file posts to a fund account, and they share one database. Asserting against
an independently recomputed value instead of a literal made it order-independent. Literals are the
right choice for a *dedicated* fixture (`transparency.test.ts`) and the wrong one for a *shared*
database.

**[2026-08-05] [ux] Do not fix a false label by making the number smaller.** «المطلوب منك السنة دي»
covers every published fee period, not this year. The tidy fix is to filter to the current period —
which would make last year's unpaid subscription **disappear** from the screen the resident checks,
turning a wrong caption into a wrong balance. The caption changed instead, and says so explicitly
once more than one period is live. When a label and a number disagree, ask which one the reader
actually needs to be true.

### CP-3, 2026-08-05 (session 12) — the audit's second half, and a self-inflicted gap

**[2026-08-05] [agent] 🔴 A fix that removes a number from a screen must decide, in the same commit,
where that number goes instead.** Migration 0011 correctly stopped deposits counting toward
subscription dues. Its own comment promised the deposit would stay *"separate and visible… so a
resident who paid a deposit can see it acknowledged instead of wondering where it went."* I wrote
that sentence and then did not do it. A resident who transferred 5,000 ج.م saw **«دفعت 0.00»** —
their money appeared to vanish, on the screen they trust most. This is the exact failure the whole
audit is about, committed **by** the fix for it. Writing the intention in a comment felt like doing
the work. It is not the same thing, and nothing in the test suite noticed the difference.

**[2026-08-05] [accounting] 🔴 "Owes nothing" is not "paid", and conflating them produces a false
all-clear.** `outstanding <= 0` counted as settled. A unit whose dues were never published has
`due = 0`, `paid = 0`, `outstanding = 0` — so it counted as **paid**, and a building nobody ever
billed rendered as **«دفعوا ٣/٣»**. A forgotten building, a half-finished import, a fee period
published for 33 of 34 blocks: all of them look exactly like this. The screen whose entire purpose is
showing who has not paid was reporting the most likely administrative failure as success. **Any
"complete / settled / done" count needs a denominator that excludes what was never started.**

**[2026-08-05] [agent] Keep a regression witness that asserts the WRONG answer.** `views.test.ts`
now contains a test asserting that the *old* formula still returns 3-of-3 for the never-billed
building. It documents the defect by exhibiting it, so the gap between the two formulas stays
visible in the suite instead of living in a comment nobody re-reads. If the witness ever stops
reproducing the bug, that is worth knowing too — the test says so in its failure message.

**[2026-08-05] [sql] An off-by-one that is invisible for 9,999 rows and then total.**
`substr(receipt_no, 9)` on `R-2026-00417` drops the first of five digits — and returns 417, which is
right, because the dropped digit is a leading zero. It stays right until `R-2026-10000`, which parses
as **0**. The counter rewinds to 1, collides with the UNIQUE `receipt_no`, and receipt submission
fails for every resident, permanently, with a 500 and no clue. **Test a sequence at its rollover
points, not at a sample value** — 417 proves nothing that 10000 doesn't disprove.

**[2026-08-05] [agent] The audit question has a second form for non-aggregates: does the LABEL still
mean what the number means?** Fixing R-043 changed what `paid_piastres` measures — and «محصّل» on the
building table did not change with it, so the column silently started excluding deposits while
promising "collected". Renamed to «محصّل من الاشتراكات», with deposits given their own column.
**When a query's semantics change, grep for every place its result is labelled.**

### CP-3, 2026-08-05 (session 11) — the audit that followed the bug

**[2026-08-05] [sql] 🔴 `LEFT JOIN … AND a.type = 'asset'` is not a filter, and it fails silently.**
A LEFT JOIN's ON clause decides whether the *right-hand* row attaches — never whether the left-hand
row survives. Non-matching rows stay in the result with the joined columns as NULL, and their
`SUM(debit)` and `SUM(credit)` go on being counted. Two views here used it believing it restricted
the sum. `v_fund_balances` netted income credits against cash debits and reported a fund holding
754,050 ج.م as holding **nothing**; `v_unit_ledger_balance` did the same per unit. The mistake reads
correctly in English, produces no error, and returns a plausible number. **The restriction belongs in
`WHERE`, or the join must be INNER.** Grep for the pattern before trusting any aggregate view.

**[2026-08-05] [agent] 🔴 A control whose correctness depends on a data-entry convention is not a
control.** `v_unit_ledger_balance` is the *independent second opinion* invariant 8 compares against —
"two paths to one number is the oldest accounting control there is", per its own comment. It was
broken, and it passed for eleven sessions because `seed/demo/generate.py` happens to tag only the
income and liability lines of a payment with `unit_id`, never the cash line. Nothing enforces that.
The moment a fixture tagged every line — the obvious reading of the column — the view returned 0 for
every unit. When a check depends on data being shaped a particular way, either enforce the shape or
write the check so the shape does not matter.

**[2026-08-05] [agent] Two accidents in a row can look exactly like a design.** `v_expense_by_category`
gives every category the full total of its ledger account, and six categories share account 5101. Σ
per-category should have been six times the truth. It was not, because (a) `lib/db/` adds
`WHERE parent_id IS NULL` and (b) the seed happens to give each account exactly one roll-up category.
Neither is written down as a requirement anywhere. The fix was to make both non-accidental: the
filter moved *into* the view, and a partial unique index makes a second roll-up category on one
account impossible. **When a bug "cannot happen", find the thing preventing it and check whether that
thing is a rule or a coincidence.**

**[2026-08-05] [accounting] ⭐ The most important financial question in a compound had no answer, and
nobody noticed because the number that would answer it was broken.** *"Have we spent the residents'
deposits?"* is invisible in every other figure — the ledger balances, the equation holds, income and
expenses look ordinary, and the treasury simply reads higher than it should. Answering it needs the
deposit fund's **cash** compared against its **liability**, and `v_fund_balances` reported both as
roughly zero (R-045). Fixing one view made a whole class of question askable. **After fixing a
broken measurement, ask what you could not previously ask** — the fix is usually worth more than the
bug cost.

**[2026-08-05] [ux] Render a passing control, not just a failing one.** The deposit-fund banner on
`/finance` shows green *"صندوق الودائع كامل"* every time it passes. Showing it only on failure is
cheaper and looks tidier, and it means the board has never seen the line — so they cannot notice the
day it stops appearing, and they never learn the check exists. A silent control is indistinguishable
from a deleted one.

**[2026-08-05] [agent] Four defects, one question, twenty minutes.** R-043 was found by luck — a new
kind of test. R-045 through R-048 were found by taking that bug's *shape* and re-reading every view
asking one question: **do both sides of this comparison measure the same thing?** Finding a bug is
worth less than extracting the question that found it and running that question over everything else.
Do this deliberately after every non-trivial defect; it is the cheapest audit available.

### CP-3, 2026-08-04 (session 10) — the transparency screens, and a real financial bug

**[2026-08-04] [accounting] 🔴 A correct ledger does not imply a correct report, and the report is
what the board actually reads.** `v_unit_balance` subtracted *every approved payment* from *dues in
published fee periods*. The two sides measured different things, and the difference was الوديعة: a
flat that paid its 5,000 ج.م deposit and none of its 6,000 ج.م subscription reported **1,000 ج.م
outstanding instead of 6,000**. `v_community_totals` reads that view, so the headline متأخرات figure
was understated by the entire deposit pool — on 204 units, over a million pounds of arrears that
simply did not appear on the screen the board uses to decide who to chase.

**Every single R-020 defence passed.** The deposit was booked to a liability account, in the deposit
fund, by a category whose `kind` the trigger checked. `v_deposit_leakage` was clean. The accounting
equation balanced. All twelve of `06 §9`'s invariants held. Twelve sessions of controls, all
correctly guarding **the ledger**, and the error was in a *reporting view* sitting on top of it.
The generalisation is the important part: every control in this project so far protects how money is
**recorded**. Nothing protected how it is **presented**, and presentation is the entire product.

**[2026-08-04] [agent] The test that found it was the first one to read the screen.** Every prior
financial test compared one query against another query. This one parsed the number out of the
rendered HTML and compared it to a literal a human had added up on paper. That single change of
vantage point — assert on what the resident *sees*, not on what the function *returns* — found in
one run a bug that four test suites and 246 passing checks had sat on top of for five sessions.
Write at least one test per surface that starts from the rendered output.

**[2026-08-04] [agent] 🔴 A comment explaining why two numbers "must" be equal is a claim, and it
needs its own proof.** `verify_demo.py` carried: *"from_ledger includes deposits (a liability),
from_payments includes them too… They must agree."* That sentence **was the bug**, written down in
the test that was supposed to catch it, and it passed for five sessions — because it was true of the
implementation and false of the world. A test that encodes a wrong assumption is worse than no test:
it converts the assumption into evidence. When reviewing, read the *comments* in the test suite as
unverified assertions, not as documentation.

**[2026-08-04] [agent] "The wrong number must not appear anywhere on the page" is a weak assertion
that looks strong.** The first draft asserted `!shows(page, wrongTotal)`. On a page with a dozen
figures, some correct number eventually collides with some wrong one — 700,000 + 500,000 happens to
equal the real 1,200,000 arrears — and the test fails for a reason unrelated to the bug it names.
Scope the assertion to the element (`tile(html, label) === expected`), then state exactly what must
be there. Negative global assertions are cheap to write and expensive to trust.

**[2026-08-04] [ux] An unmeasurable quota must render as "—", never as 0%.** Workers request counts
and KV writes cannot be read from inside a Worker. Drawing them as an empty green bar would be a lie
that *reassures*, on the one page whose entire job is early warning. `/admin/health` marks each row
`measured` or `declared` and leaves declared rows blank. The honesty rule: a dashboard may say "I
don't know"; it may never say "zero" when it means "I don't know".

**[2026-08-04] [security] Three separate constraints refused the test fixture before it could
lie.** Building the CP-3 fixture, the database rejected: `submitted → approved` (the state machine
as data — no skipping review), an approved payment with no `journal_entry_id` (so "approved money
that never reached the ledger" is not a representable state), and a journal entry with a
`source_type` outside the allowed list. None of these was being tested; they fired because a
*fixture* took a shortcut a real reviewer cannot take. Schema-level controls defend against your own
test scaffolding too, which is where convenient fictions usually enter a codebase.

### CP-2, 2026-08-04 (session 9) — two-admin recovery and the owner register

**[2026-08-04] [security] A two-person rule that lives in application code is a one-person rule
waiting for a bug.** The requirement is "two *different* admins approve a recovery" (03_RBAC §6).
Written as `if (approvedBy === requestedBy) throw`, it is one refactor, one missing `await`, or one
new route away from being gone — and its absence is silent, because the happy path looks identical.
Written as `CHECK (approved_by IS NULL OR approved_by <> requested_by)` it is enforced by the storage
engine for every writer that will ever exist, including the psql-equivalent console at 2 a.m. and any
future admin tool nobody has thought of yet. **The test that proves this is worth more than the
constraint:** `onboarding.test.ts` calls the database *directly*, bypassing every guard in
`lib/db/`, and asserts the write still fails. That is the difference between testing that the code
checks and testing that the rule holds. Apply the same reading to every control in this project:
maker–checker, append-only lines, the deposit→liability mapping — all of them are already triggers or
constraints, and none of them should ever be "simplified" up into TypeScript.

**[2026-08-04] [egypt] The importer's hardest problem was not parsing, it was refusing to be
helpful.** Every defect R-009 predicts in a real Egyptian owner register — the same number on two
rows, one flat with two names, a blank unit — has an obvious automatic fix, and every automatic fix
silently attaches one family's money to another family's name. Merging two rows with the same phone
is *probably* right and catastrophically wrong the one time it is a father and son sharing a line.
So the parser flags and stops. Concretely: `47 created, 3 flagged, nothing created for a flagged
row`. The design rule that fell out of it — **a flagged row a human clears in ten seconds always
beats a guess nobody ever sees** — is the same rule as `parseMoney` refusing an ambiguous amount
instead of rounding it, and I did not notice they were the same rule until both were written.

**[2026-08-04] [egypt] Two owners for one flat is not an error, and saying so out loud matters.**
`unit_owners` is many-to-many by design (02 §3) — inheritance splits flats between siblings
constantly here. An importer that rejects the second row teaches the admin that the file is wrong
when the file is right. It is flagged with a question — *"نفس الشقة موجودة في صف N — ملّاك مشتركين؟
أكّد بنفسك"* — because the board knows and the software cannot. Every flag message in the importer
says what to **do**, never just what is wrong; "الاسم ناقص" is useless next to a row you must scroll
to find, so the row number travels with it.

**[2026-08-04] [agent] A number in a gate can go stale even when the gate is still right.** CP-2 said
*"the 4th activation request in 15 min is refused."* That number came from `03_RBAC §4`, where a
resident requested an OTP. ADR-016 deleted that flow — a board member issues the link now, so the
counter it names has **no caller at all**. The tempting move is to tick the gate because rate
limiting obviously exists. The honest move is to write down that the specific number is now
meaningless, name the three limits that *do* exist, and leave it unticked for the reason that
actually blocks it (never run against a real `cf-connecting-ip`). **When a decision invalidates a
gate, the gate needs rewriting, not reinterpreting** — and the rewrite belongs in the checkpoint file
where the next reader will hit it, not in a work-log entry they will never scroll to.

### CP-0, 2026-08-04 — free-tier re-verification and the schema port

**[2026-08-04] [free-tier] "Free tier" and "no credit card" are two different questions, and the
second one is the one that bites.** Cloudflare R2 gives 10 GB free — and refuses to create a bucket
at all without a payment method on file. Every other Cloudflare product in the same account blocks
at the limit and needs no card. Ask both questions separately for every service, and record the
answer to the card question in its own column. `05_ZERO_COST_ARCHITECTURE.md` §2a asked only about
overage and therefore missed this entirely.

**[2026-08-04] [free-tier] "Blocks at the limit" is a feature worth choosing a vendor for.** Workers,
Pages, D1 and KV all return errors when a free limit is hit rather than silently billing. That single
property is what makes a strict-zero promise keepable, and it is rarely on the pricing page's front
matter — it lives in the limits doc.

**[2026-08-04] [free-tier] A vendor's free tier can change *between* the day a spec is written and
the day it is built.** This pack was four days old. In that window, two of its ten load-bearing
external facts were already stale — one of them announced by Meta with an effective date **eight
weeks out**. Re-verification is not paranoia; at this cadence it is arithmetic.

**[2026-08-04] [free-tier] Check *when* a price change takes effect, not just what the price is
today.** Meta's page said service messages are free, and in the same paragraph said pricing updates
"will launch on August 1, 2026 and October 1, 2026." Reading only the first sentence would have
produced a design that was correct for eight more weeks.

**[2026-08-04] [free-tier] Find the tightest quota in the stack and design around it first.** KV
allows **1,000 writes/day** — 1% of D1's allowance. Everything else has 10–100× headroom. Anything an
*unauthenticated* caller can trigger a write to must never touch KV, or one bored attacker exhausts
the day's budget and the login path stops working for everyone. Sessions and rate limits therefore
live in D1. The tightest quota is where the architecture actually gets decided.

**[2026-08-04] [money] A `numeric` column that is not money can still violate the money rule.** The
Postgres model had `ownership_share numeric(5,4)` and `area_sqm numeric(8,2)`. Neither is currency,
so neither trips the "money is never a float" check on a read-through — but both **multiply into
money** (a split obligation, a per-sqm due). Ported naively they become REAL and C4 is violated
indirectly. Look for the columns that *touch* money, not just the ones denominated in it.

**[2026-08-04] [money] Make the storage layer refuse, not just the code.** SQLite `STRICT` tables
turn "we always store piastres as integers" from a convention into an error message: *"cannot store
REAL value in INTEGER column journal_lines.debit_piastres."* Constraints that fire in the database
survive refactors, new contributors, and restores from backup. Code conventions do not.

**[2026-08-04] [money] ⭐ The accounting equation is a tautology, and the pack overclaims it.**
`06 §9` calls `assets = liabilities + funds + (income − expenses)` "one test that catches more bugs
than the other eleven combined." It does not. Under balanced double-entry the residual is
*necessarily* zero, so a ledger with الوديعة booked to income passes it perfectly while overstating
the spendable balance by the whole deposit pool. Proven in
`tests/fixtures/verify_ledger.py` §8: 14,800.00 ج.م shown against 9,800.00 true, residual 0.
What catches R-020 is the category→account **kind** constraint, the `v_deposit_leakage` view, and the
operating/deposit **fund split**. Beware any invariant described as catching "most" bugs — check
whether it can fail at all.

**[2026-08-04] [money] Encode the dangerous distinction as a *type*, not a rule.** Giving categories
a `kind` column with `'deposit'` as its own value, and constraining deposit→liability in a trigger,
means the most dangerous error in the system is one nobody can write. That is cheaper than any amount
of vigilance, and it survives the author leaving.

**[2026-08-04] [arabic] FTS5's `unicode61` tokenizer does not fold Arabic orthographic variants.**
Verified: indexed `حديقه` is **not** matched by a search for `حديقة`; indexed `انشاء` is **not**
matched by `إنشاء`. `remove_diacritics 2` handles tashkeel and nothing else. Residents type both
forms interchangeably, so folding (أ إ آ ٱ→ا · ة→ه · ى→ي · strip tashkeel) must happen in application
code before indexing **and** on the query. Hence the `posts.search_body` column. Without this, "one
search across everything" — the actual fix for information lost in WhatsApp — quietly fails half the
time.

**[2026-08-04] [agent] Write the test that proves the guard is real, then delete the guard and watch
it pass.** Two guards here were verified by dropping the trigger and confirming the bad write then
succeeds. It cost about ten lines each and it is the only thing separating a real constraint from a
comment. It also caught two bugs **in my own assertions** on the first run — a `PRAGMA table_list`
column index, and an FTS test that matched the wrong column.

**[2026-08-04] [agent] A cached copy of a security-relevant identifier is a second source of truth.**
The pack kept `profiles.phone_e164` "as a cache only, never a FK target." Even so: caches drift, and
drift here means a login resolving to the wrong person. Deleting the column is cheaper than
defending it. When a spec says "cache only, don't rely on it", ask what it costs to not have it.

### CP-2/CP-4, 2026-08-04 (session 8) — the wizard and recovery

**[2026-08-04] [security] ⭐ Recovery codes must REPLACE, not accumulate.** The first version
appended six codes at every activation, new device and recovery, leaving all previous sets live.
Three such events and a resident has eighteen valid passkey bypasses — on paper, in photos, in
WhatsApp messages — and neither they nor the board knows how many exist. The resident's mental model
is *"here are my codes"*, singular and replacing; the system has to match it. A test caught this only
because it asserted an exact count rather than "greater than zero".

**[2026-08-04] [agent] Assert exact counts, not "more than none".** `remaining === 5` found the bug
above. `remaining > 0` would have passed forever.

**[2026-08-04] [agent] When you make the same mistake twice, build the guard instead of remembering.**
I read a `Response` body twice, wrote the lesson into this file, and then did it again two sessions
later. The fix that actually works is a `send()` helper that reads once and returns
`{status, text, json}` — the mistake is now unavailable rather than discouraged. Same principle as
`mutate()` for audit rows and `ctx` as a required argument: make the wrong thing hard to type.

**[2026-08-04] [agent] Assert that an event is PRESENT, not that it is last.** Checking the most
recent audit row for `account.recover` failed, because opening the session logged after it. Both were
correct; the assertion was too narrow, and the narrower version would have passed on the *weaker* of
the two events.

**[2026-08-04] [ux] A server-side draft is what makes "nothing is retyped" true.** sessionStorage
dies when the tab closes, when a five-year-old Android reclaims memory, and when the resident
switches to their bank app to check the amount — which they will do, at step 1, every time. Keeping
the five text fields in D1 also lets steps 1–3 and 5 work as plain form posts with no JavaScript at
all. Only the image needs a script, and losing it costs one photo rather than six fields.

**[2026-08-04] [security] Recovery has to revoke the lost device, not just admit the resident.**
Redeeming a code that leaves the old passkey enrolled has not recovered anything — whoever has the
phone still has access. Recovery revokes every session and every credential, then leads straight into
enrolling a new passkey, because a recovered account with no passkey is one the resident still cannot
open tomorrow.

### CP-4, 2026-08-04 (session 6/7) — storage, decided by measurement

**[2026-08-04] [agent] ⭐ A rule is only as true as the number behind it — check the number.**
`05 §2a` said "never store image bytes in D1", and it was right *given its input*: 500 KB × 5,000/yr
= 2.5 GB against a 500 MB database. But the 500 KB was never measured — it was the pack's
*pre-upload* target for a raw phone photo. Measured after WebP compression: **6 KB** for the worst
realistic case. The rule was off by 12–60×, and correcting it removed an entire vendor from the
system. **When a rule blocks the simplest answer, find the number it rests on before accepting it.**

**[2026-08-04] [agent] Measure the WORST realistic input, not the convenient one.** My first
synthetic receipt was flat rectangles and compressed to 4 KB — meaningless, because WebP eats flat
colour. A photographed *paper* slip has sensor noise, uneven lighting and blur, and is what plenty of
residents will actually upload. At the settings we had shipped it was **41 KB, not 8 KB** — a 5×
difference that would have made the years-per-database forecast wrong. Build the pessimistic fixture.

**[2026-08-04] [agent] ⭐ When your own rule refuses your own convenience, comply.**
`lint-no-sql` rejected the new blob adapter. The easy fix was one allow-list entry, with a good
argument attached: the queries touch a byte store with no resident scoping. That reasoning is exactly
how the rule dies — one documented exception makes the second easier, and eventually a query that
DOES need an ownership predicate lands in a file nobody checks. Moving five queries into `lib/db/`
cost ten minutes. **The value of an absolute rule is that it is absolute.**

**[2026-08-04] [security] A `?usp=sharing` link is a publication decision.** The folder offered for
receipt storage is a Drive share link. If it is set to "anyone with the link", every resident's bank
receipt — names, amounts, references — is readable by anyone who is ever forwarded that URL. Under
C6 that is disqualifying and under PDPL it is a breach. Storage that is convenient to *share* is the
wrong shape for storage that must never be shared.

**[2026-08-04] [free-tier] The best vendor is sometimes no vendor.** Every storage option considered
added something to watch: a card (R2), an OAuth refresh token (Drive), an unverified signup (B2).
D1 blobs add nothing — no card, no vendor, no new quota, and receipts fall inside the existing backup
automatically, which closes "the images weren't in the backup" as a way to lose them.

### CP-2, 2026-08-04 (session 5) — passkeys and upload

**[2026-08-04] [agent] ⭐ Mixing framework side effects with hand-built responses silently drops
them.** `c.header('set-cookie', …)` sets a header on Hono's *context*; my `html()` helper returned
`new Response(...)`, which ignores it. The activation page therefore rendered perfectly, greeted the
resident by name, and set **no session** — a login flow that looks like it works and does not. The
JSON routes were fine because `c.json()` merges context headers, so only one path was broken and
only one test caught it. Either use the framework's response builders everywhere, or pass headers
explicitly everywhere. Never half of each.

**[2026-08-04] [security] Do not hand-roll WebAuthn verification.** Every check in the ceremony —
origin, RP-ID hash, UV flag, signature — fails *silently* when omitted: the user touches the sensor,
a session opens, and the security property is just gone. This is the exact shape of the most
dangerous bug class on this project (the one that renders correctly). ADR-020.

**[2026-08-04] [security] A login form is a resident directory unless you design against it.**
WebAuthn's `allowCredentials` naturally leaks whether an account exists. Returning a real challenge
and an EMPTY allow-list for unknown numbers costs nothing and turns the front door back into a door.
Test it by asserting the two responses have the same *shape*, not just the same status.

**[2026-08-04] [ux] Re-encoding an image through a canvas strips EXIF as a side effect.** The
compression step that makes a 12 MB photo crossable on 3G also drops geolocation — so R-026's
requirement and the performance requirement are satisfied by the same three lines. Worth noticing
which of your constraints are secretly the same constraint.

**[2026-08-04] [ux] Warn about a duplicate; never block it.** Two transfers of the same amount on the
same day are entirely possible. Refusing the second one tells a resident who did nothing wrong that
the site is broken, and they go back to WhatsApp — which is the failure mode the whole product
exists to prevent. Detect, warn, let them proceed.

**[2026-08-04] [agent] Reading a Response body twice is a test bug that looks like an app bug.**
`assert.equal(r.status, 201, await r.text())` consumes the stream, and the follow-up `r.json()` then
throws "Body is unusable". Read once into a variable.

**[2026-08-04] [security] A credential pasted into a chat is compromised, full stop.** It lives in
the transcript, in backups, and in logs. Rotate it, and prefer `wrangler login` on the owner's own
machine over any token that has to travel. Treat "it was never used" as luck, not as a control.

### CP-1/CP-2, 2026-08-04 (session 4) — audit trail and the Arabic UI

**[2026-08-04] [agent] ⭐ Make the safe path the ONLY convenient path.** "Call `writeAudit()` on
every mutation" is a discipline, and disciplines fail quietly. `mutate()` runs the write and its
audit row in one `db.batch()`, so they commit together or not at all — and writing an unaudited
mutation now means deliberately not using the only helper that exists. Same shape as ADR-010's
required `ctx` argument: don't ask people to remember, make forgetting inconvenient.

**[2026-08-04] [security] Order of statements is a correctness property, not a style choice.** The
phone-change batch had to be: close the old row → insert the new one → link them. Any other order
trips a FK (`replaced_by_id` points at a row that does not exist yet) or a partial unique index
(two active primaries for one person). All three constraints fired on the first run. That is the
schema doing exactly what it was built for, and it is why those indexes exist rather than a comment.

**[2026-08-04] [agent] Keep the user-facing reason in `Error.message`, not only on a property.**
`Forbidden` carried the Arabic reason on `.reasonAr` and put `forbidden: phone.change` in
`.message`. The HTTP layer read the right one — but logs, Sentry, stack traces and
`assert.rejects(/regex/)` all read `.message`, so everyone debugging saw a capability name and never
what the admin was actually told. Carry it in both.

**[2026-08-04] [rtl] ⭐ A floating button at `inset-inline-end` sits where Arabic text BEGINS.** The
help FAB was placed bottom-right out of LTR habit, which in RTL is the start of every line — it
covered the first words of whatever card was beneath it. At `inset-inline-start` it sits at the end
of lines, where whitespace usually is. Logical properties fix the *mirroring*; they do not fix a
placement decision that was reasoned about in the wrong direction to begin with.

**[2026-08-04] [rtl] The "append the value after the sentence" bug is systematic, not incidental.**
`msg(template, {n: ''})` followed by `${num(count)}` renders "إيصال — مش محسوبة في الإيرادات 14" —
the number stranded at the end of the sentence. It happened at FOUR separate call sites, and I fixed
one and left three, because the first one *looked* right. Interpolate through a helper that takes
pre-rendered HTML (`msgHtml`), and grep for the pattern rather than fixing instances.

**[2026-08-04] [agent] A preview that is not the product is a preview of nothing.** The first
version rendered the demo numbers with its own standalone markup — it could have looked perfect
while the app looked broken. `render_screens.ts` boots the real `createApp()` and saves what the
real routes actually serve. Same discipline as testing over HTTP instead of calling the data layer.

**[2026-08-04] [agent] Lint your linter against a real violation.** `tools/lint-rtl.mjs` passed
cleanly on first run — because its `left:` rule was also matching `let left: number = payment` in
TypeScript, and its noise was drowning in warnings from a mockup file that is not source. Adding a
deliberate `margin-left` and watching it fail is what proved it works.

### CP-1, 2026-08-04 (session 3) — the security layer

**[2026-08-04] [agent] ⭐ A refusal is an answer, not a failure — map it like one.** Every
`RAISE(ABORT, …)` in the migrations carries a resident-readable Arabic message on purpose. But the
driver let them bubble up unhandled, so a **working control** returned HTTP 500 and the admin read
*"حصل خطأ عندنا"* — indistinguishable from a crash, so they retry, and the system looks broken at the
exact moment it is behaving perfectly. Database refusals now become a 409 carrying the Arabic reason.
The general lesson: when you push validation into the schema, you owe the schema an error path that
reaches the user, or you have traded a silent bug for a fake outage.

**[2026-08-04] [agent] The API verb and the stored state are not the same word, and the compiler
cannot tell you.** The route takes `kind: 'reject'`; the nine-state machine stores `'rejected'`.
Passing the verb straight through produced an illegal-transition abort. Both strings are valid
members of *some* union, so `strict` TypeScript was perfectly happy. **Map between an external
vocabulary and an internal one explicitly, in a lookup object, even when the words nearly match.**

**[2026-08-04] [agent] End-to-end tests find what unit tests structurally cannot.** Both bugs above
sat between layers — driver↔handler, and route-vocabulary↔schema-vocabulary. Every unit was correct.
This is the argument for the CP-1 gate being *HTTP requests as each role* rather than direct calls to
`lib/db/`, and it paid for itself the first time it ran.

**[2026-08-04] [agent] Don't build a "disable security" switch to satisfy a testing requirement.**
`CHECKPOINTS` asks that each access test be watched failing against a loosened guard. The obvious
implementation — a `LOOSE=1` flag in `lib/db/` — puts a kill switch for authorization into production
code, which is a worse risk than the assurance is worth. `proveReachable()` gets the same guarantee
from the other side: run the query *without* the ownership predicate and assert the neighbour's row
DOES come back, proving the green test measures the predicate rather than an empty table. **When a
process requirement would make the system less safe, satisfy its intent by another route and write
down why** — do not follow it literally and do not silently skip it.

**[2026-08-04] [security] Redundant guards are worth it exactly where money moves.** `reviewPayment`
is protected four independent ways: the capability check, the maker–checker check, `AND submitted_by
<> ?` inside the SQL, and two database triggers. Any one of the first three could be deleted and the
control would still hold. That is deliberate and it is not paranoia — ADR-010 gave up RLS's
fail-closed property, so the one function where an error moves real money is where the redundancy is
bought back.

**[2026-08-04] [security] Idempotency falls out of a conditional UPDATE for free.** `WHERE
id=? AND status='under_review'` means a replayed approval changes zero rows and posts nothing. No
lock, no idempotency key, no read-then-write. The second click gets a clean 409 rather than a second
ledger entry.

### CP-0/CP-1, 2026-08-04 (session 2) — the imaginary village

**[2026-08-04] [agent] "Impossible" has to mean impossible, not "we have a convention."** C10 says
fabricated data must be *impossible* to load into production. A `seed/demo/` folder and a careful
habit is not impossible — it is a habit that fails the one night somebody is tired. Putting the
refusal in the production database itself (every demo id starts with `DEMO`; triggers on every
money-bearing table reject them unless the database has explicitly opted in) costs one migration and
cannot be forgotten. **Then the guard was too strict and blocked its own workflow** — a fresh
database defaults to `production` and could never be marked demo. The fix is the interesting part:
the rule is not "never relabel", it is *"never relabel a database that already holds money."*
Guards need the same care as features; an unusable guard gets disabled.

**[2026-08-04] [money] A five-row fixture proves the constraints fire; it does not prove they hold.**
Scaling to 204 units, 243 receipts across nine states, 55 deposits, 12 overpayments, a reversal and
30 expenses is where sign errors and double-counting actually appear. Two of my own verification
queries were wrong at scale and right at five rows.

**[2026-08-04] [money] A reversed receipt must be subtracted exactly once, and it is easy to do it
twice.** The recomputation subtracted reversed payments from a set that already excluded them
(`status='reversed'` is not `status='approved'`), giving 909,000 against a true 915,000 — a 6,000 ج.م
phantom. The tell was that the error equalled exactly one receipt. **When a financial discrepancy
equals exactly one transaction, look for double-counting of that transaction before anything else.**

**[2026-08-04] [ux] Integer division turned 3,800 ج.م of real spending into "0%".** Four of nine
expense categories rendered as `0%`, which reads as *"we spent nothing on the gardens"* — a false
statement about money, produced by a formatting choice. Small shares need a decimal or an
"أقل من 1%". Found only by rendering the page and looking at it, never by a SQL test.

**[2026-08-04] [ux] An ISO date on screen is a developer's date.** `2026-07-31` shipped into the
reconciliation line where `31 يوليو 2026` belongs (04_UX_SPEC §10). Both are "correct"; only one is
readable by سعاد. Format at the display boundary, the same discipline as money.

**[2026-08-04] [ux] The status-colour rule is load-bearing, and now there is a number for it.**
Running the palette validator on this project's own tokens: `--danger #B3261E` and `--warn #A96A00`
are **ΔE 14.0 apart in normal vision and 7.6 under deuteranopia** — below the 15 floor. "مرفوض" and
"قيد المراجعة" chips sit next to each other in the payment list. 04_UX_SPEC §6 already demands
colour **and** text **and** icon; this measurement is why that rule can never be relaxed to save
space. Compute palette safety, never eyeball it.

**[2026-08-04] [ux] For a magnitude breakdown, one hue beats a categorical palette.** Nine expense
categories tempt you toward nine colours, which then have to survive colourblindness and greyscale.
But identity here comes from the label printed on each bar, and magnitude from bar length — so a
single teal is *more* readable and greyscale-safe by construction. The colour problem was avoidable
rather than solvable.

**[2026-08-04] [egypt] An older resident's first login attempt may be their landline.** The
normalizer answered "رقم الموبايل المصري 11 رقم" to a Matrouh `046…` number — sending سعاد off to
recount digits on a number that can never work. Detect landline lengths and say "that is not a
mobile" instead. The test caught it because the expectation was written from the persona, not from
the implementation.

**[2026-08-04] [agent] Two independent findings pointed the same direction again.** Dropping WhatsApp
removes both a cost risk *and* the longest-lead-time task in the project (Meta business
verification), closing R-004 and R-017 together. `INSIGHTS` already recorded this pattern once — the
cheapest option turning out to be the most usable. Check for it deliberately before accepting any
trade-off as real; on this project it has now held three times.

**[2026-08-08] [security] A control the client can decline is a claim, not a control.**
`storage_objects.exif_stripped` was set to `1` by two call sites that had never looked at the bytes;
the stripping was real but happened in the browser. So the column was true for every resident using
the site and false for every request that skipped the page — and it was *most* likely to be false
exactly when it mattered, because a request that skips the page is not the innocent case. The
general form: when a column asserts a fact about data, the assertion has to be produced by the code
that stores the data, not accepted from the code that sent it. Look for this shape wherever a
boolean is passed *in* to a persistence function rather than derived inside it.

**[2026-08-08] [agent] The bug was in the recovery path, not the happy path — twice.**
The EXIF stripper's first version returned the ORIGINAL buffer when a file was truncated: it walked
until the damaged chunk, found no metadata *before* that point, and fell through to "nothing to
remove". Every happy-path test passed. The failure was indistinguishable from success, which is the
worst property a security control can have. Same shape as the earlier activation-link bug, where the
reject path was tested and the accept path was not. **Write the malformed-input test before the
well-formed one** — on this project the error branch has now been wrong twice and the main branch
zero times.

**[2026-08-08] [design] Immutability and restorability are the same decision, and you only get told
once.** Migration 0022 froze published dues — the right control, since a published amount is what a
resident was *told* they owe. It immediately broke the demo seed, three test fixtures and
`tools/backup.mjs`, all of which had been writing a state the application can never reach (a
published period with dues inserted afterwards). CP-8 already taught this for posted journal
entries; 0022 taught it again for fee periods. The rule to apply *before* writing the trigger: every
control that makes a state immutable also makes it un-restorable unless the backup replays the
transition that created it. The fixtures are the early warning — if a fixture cannot produce a state
through the product's own path, the backup will not be able to either.

**[2026-08-08] [product] "Built" and "reachable" are different, and the gap is invisible from the
code.** Settlements had a schema, a data layer, 22 passing tests and zero routes. Every `/admin/*`
screen existed and none was linked from anywhere, because the five nav tabs are the resident's. The
project's own CHECKPOINTS file could not see this: it ticks capabilities, and a capability with no
door is still a capability. **The check that catches it is "name the sequence of taps from the login
screen"** — for onboarding 204 residents, for opening next year's subscription, for closing a month.
If any step in that sentence is "type a URL", it is not built.

**[2026-08-08] [agent] ⭐ The spec I was building from was not the spec.**
Diffing the uploaded packs against this repo turned up `07_VILLAGE_MAP_SPEC.md`, constraint C13 and
product goal FOUR — village navigation — none of which exist in `00_MASTER_PROMPT.md` here. Twenty-
seven sessions against a truncated copy. Nothing in the process caught it: every checkpoint was met,
every gate passed, and the missing goal left no hole to notice because a requirement that was never
written down produces no failing test. The only thing that found it was comparing two copies of the
source documents. **Diff the specification, not just the code, whenever a second copy exists** — and
treat "the constraints are numbered C1…C12" as a fact to verify rather than a fact.

**[2026-08-08] [agent] ⭐ The most important route in the product was a 404, and nothing noticed.**
`/admin/review` rendered an «✅ اعتماد» button posting to `/admin/review/:id`, which did not exist.
A board member could not accept a receipt from the deployed site. Underneath it was worse:
`reviewPayment` links a `journalEntryId` its caller supplies and **nothing anywhere created one**, so
no code path could post a payment at all. 377 access tests passed throughout, because every one of
them called the data layer directly or posted the ledger by hand in a fixture.
**A test that constructs the state it is asserting about cannot discover that the product cannot
reach that state.** The check that finds this class of bug is: name the sequence of taps from the
login screen to the outcome, then drive exactly that. Two of the three biggest defects in this
project were found by asking it.

**[2026-08-08] [design] A guard that is true finds its own violations, everywhere, at once.**
Adding the orphan-entry trigger (0024) — "a posted entry that names a receipt must have that receipt
pointing back at it" — immediately broke six test fixtures, the demo seed, `verify_ledger.py` and two
real code paths. Every one of them was writing a state the application cannot reach: expenses posted
before being attached, entries naming receipts that were never approved, an accounting equation
proved over vouchers that did not exist. None of it was reachable through the product, so none of it
was a live bug — but all of it was a fixture asserting something slightly untrue, which is how a
suite stops testing the thing it names. **When a new constraint breaks a lot of fixtures, read them
before relaxing it.**

**[2026-08-08] [ops] The upload path is where storage assumptions actually get tested.**
The map image went into D1 like every other image, and D1 refused: 109 KB is 218 KB as a hex literal
and the statement exceeds its limit (`SQLITE_TOOBIG`). Chunked appends are not a workaround, because
SQLite's `||` coerces blobs to text. R2 was already refused for wanting a card. The answer was to
ship the plan in the Worker bundle — one file for the whole village, versioned with the release that
drew hotspots on it. Same shape as the D1 `GLOB` limit found on 2026-08-07: **the platform's real
limits appear on the first write of real data, never in review.**

**[2026-08-08] [agent] Walk a prototype's navigation against the route table — every destination,
in order.** The owner's sandbox HTML had six board destinations. Four of them (`حسابي`,
`دفتر القيود`, `استيراد الملاك`, `الاستعادة والتفعيل`) had no route in the app, and two of those were
whole procedures whose data layer was written, tested and unreachable — `requestRecovery` /
`approveRecovery` / `fulfilRecovery` had passing tests and no door. This is session 28's lesson
arriving from a different direction: a test that calls the data layer directly cannot tell you the
product has no path to it. The cheap version of the check is a text diff of "every href a mockup
mentions" against "every path `app.get` registers" — it took an afternoon and found four.

**[2026-08-08] [ux] An empty demo table is a claim about the product, not an absence of data.**
`audit_log` was the one table `seed/demo/` never wrote, so «سجل التغييرات» — the screen whose entire
purpose is to show that nothing happens behind anyone's back — rendered its empty state at a board
presentation about accountability, and the dashboard's activity strip could not appear at all.
Seeding it also forced a design question worth having: the 200 residents get **two** audit rows
(`import.stage`, `import.commit`) naming one chairman, not 200 silent inserts, because that is what
the product actually does. **A seed that disagrees with the product is describing a different
system.**

**[2026-08-08] [a11y] `overflow-x:auto` without `tabindex="0"` fails WCAG the moment there is data
in it.** The audit table passed axe for weeks because the demo had zero audit rows; one seed change
later, `scrollable-region-focusable` failed the build. A region that scrolls but cannot receive
focus is unreachable to anyone not using a pointer. Every `.table-wrap` in this codebase now carries
`tabindex="0"` and a visible focus ring. **Accessibility scans are only as good as the fixture's
data volume** — the same is true of every screenshot review.

**[2026-08-08] [design] Do not reuse a function whose REFUSAL is the security boundary.**
After a fulfilled recovery every passkey is revoked, so `issueFirstActivation` — which exists to
refuse anyone holding a passkey — would have worked, and worked for the wrong reason. Its guard is
what stops an admin minting a credential onto a live account; the next person to relax it would
silently reopen the hole. `issueRecoveryActivation` demands the opposite proof instead (a two-admin
request that was actually fulfilled) and records `purpose='recovery'`, so «إزاي ده اتفعّل» has one
answer per account and both answers are on the record.

**[2026-08-08] [agent] `hash()` on a `str` is randomised per Python process.** `seed/demo/generate.py`
promised in its own docstring that "re-running produces byte-identical SQL, so a diff is meaningful",
and used `abs(hash(pid))` for the receipt digests — so every regeneration rewrote all 243 of them and
the diff was 486 lines of noise. Nobody reads a diff like that, which means nobody would have seen a
real change hiding in it. Any generator that claims determinism must use `hashlib`, never `hash()`,
and the claim is worth testing: generate twice, `diff -q`.

**[2026-08-08] [ux] A `box-shadow` scrim is painted, never hit-tested.** The drawer dimmed the page
with `box-shadow:0 0 0 100vmax rgba(0,0,0,.45)` — which looks exactly like a modal backdrop and
behaves nothing like one. `document.elementFromPoint` in the dark area returned the card underneath,
so every "tap outside to dismiss" navigated somewhere at random instead of closing the menu. A
backdrop has to be an element. Related and worse: the panel covered the `<summary>` that toggles it,
so with no JavaScript there was **no way to close the drawer at all** — and `elementFromPoint` over
the ☰ returning an `<h2>` is how you find that out in one line. **When a component's only control is
one element, assert that element is the topmost thing at its own coordinates.**

**[2026-08-08] [ux] A menu that scrolls without saying so reads as a menu that is missing items.**
The drawer held 29 links, 1681px of content in an 844px panel, and the owner's report was "the
sidebar is not complete with all tabs". Nothing was missing; the fold was invisible. Two things fix
it and both are worth having anyway: the panel now starts below the app bar rather than under it (so
the bar's presence tells you the panel is a scrolling region, not the whole screen), and the last
item is a visually distinct sign-out that ends the list — a menu with a recognisable BOTTOM is a
menu you know you have seen all of.

**[2026-08-08] [agent] Positioning against a magic number means keeping the number in step.**
First attempt put the drawer at `inset-block-start:var(--bar)` with `--bar:58px` counted by hand from
the padding and control heights. Measured: 68px, so the top ten pixels of the menu slid under the
bar — and the token would have needed re-deriving for each of the three text sizes the product
offers. `position:absolute; inset-block-start:100%; block-size:calc(100dvh - 100%)` against the
header is exact at every size and has nothing to maintain. **If a layout constant has to track
something the browser already knows, let the browser tell you.**

**[2026-08-08] [ux] One CTA string across differently-shaped records is a lie waiting for data.**
Every message in «رسايلي» rendered «شوف الإيصال», which was fine while the only messages were payment
decisions. The moment the demo had announcements and due reminders in it, two thirds of the buttons
promised a receipt and went somewhere else. The label now comes from the row's `kind`. **A string
that is correct because of what the table happens to contain is not correct.**

**[2026-08-08] [ux] A responsive breakpoint is a second product, and it collects its own bugs.**
At ≥900px this shell swaps its entire navigation: the bottom tab bar becomes a rail and the ☰ drawer
is redundant. What it actually did was reuse the FIVE resident tabs as that rail, leaving the other
twenty-four destinations behind a hamburger nobody looks for beside a visible sidebar — and it reset
`header`'s z-index to 20, which put the bar back under the drawer panel and un-fixed the
uncloseable-drawer bug in that branch alone. Neither is visible in any phone screenshot, and the
owner found both by opening the site on a tablet-width browser. **Both shells are now generated from
one `menuBody`, with a test comparing their hrefs — a second copy that merely exists is how they
drifted the first time. The axe scan runs at 360px AND 1100px for the same reason.**

**[2026-08-08] [rtl] Check which physical side a logical property lands on; do not reason it out.**
The help bubble's comment asserted "inline-start in RTL is the LEFT". It is the RIGHT. The placement
happened to be correct and the stated reason was backwards, which is worse than no comment — the next
person moves it based on the explanation. It also meant nobody noticed the bubble was sitting on the
inline-start EDGE where the wide layout's navigation rail lives, covering the last items of the menu.
`getBoundingClientRect` on both elements answers this in one line.

**[2026-08-08] [agent] A lookup table is only as complete as the data you have exercised.**
`ACTION_AR` translates audit actions into Arabic, and it covered exactly the eighteen actions the
demo seed fabricates. The other twenty-seven — `session.open`, `passkey.enroll`, `activation.issue`,
every `map.*` and `settlement.*` — had no Arabic and printed as English slugs on «سجل التغييرات», the
one screen whose entire purpose is being readable by a board of doctors. It surfaced on the deployed
site, from real use, because production writes actions a seed never will. The durable fix is not the
twenty-seven strings: it is `tests/access/audit.test.ts` scanning `lib/db/` SOURCE for every action
written and failing on any without a translation — which immediately found three more my own greps
had missed (`account.recover`, `settlement.post`, `settlement.reverse`). **When a map must cover a
set the code defines, derive the set from the code, in a test.**

**[2026-08-08] [ops] Deploy from the real environment before believing a screen is fixed.**
Three defects only appeared against the live database: the untranslated audit actions, the fact that
`albums.building_id` and `maintenance_tickets.unit_id` were unset in the DEPLOYED copy as well as in
the seed, and `npm run deploy` being documented in `AGENTS.md` and absent from `package.json` — so
the documented command had never once been run. A demo database that only ever holds seeded rows
cannot show you what production data does to a screen.

**[2026-08-08] [design] Put a security boundary in a function's SIGNATURE where you can.**
`updateOwnProfile` takes no target id. Not "checks that the target is you" — takes none, so
`ctx.personId` is the only identity it can reach and no route bug, crafted form field or future
refactor can point it at somebody else. Its SQL then names three columns, so "a resident promotes
themselves to admin" is not a case it defends against, it is a case it *cannot express*. Compare
`renameProfile` a few lines up, which does take a target and therefore needs `user.create` guarding
it, plus a test. **A property the type system or the SQL shape enforces needs no vigilance; a
property enforced by an `if` needs it forever.**

**[2026-08-08] [perf] A `<select>` inside a repeated row multiplies.** The per-person unit picker
looked obviously right — 204 flats, choose one — until it was rendered once per person: 205 rows ×
204 `<option>` = **42,842 elements and a 3.3 MB page**, on a screen whose stated design target is a
five-year-old Android. Two `inputmode="numeric"` boxes for building and flat are 0 options, resolve
unambiguously server-side, and match how the board says it out loud («عمارة 22 شقة 4»). 3.3 MB →
123 KB. **Before putting a control in a row, multiply its DOM cost by the row count.**

**[2026-08-08] [agent] `SELECT *` into a positional INSERT is a fixture that breaks on any migration.**
Adding two columns to `profiles` broke `verify_ledger.py` in three places, each an
`INSERT INTO profiles VALUES (?,?,?,?,?,?,?,?,?)` with the count typed by hand. None of them had
anything to do with what the file tests, and a fixture that fails for an unrelated reason is one
people learn to edit past rather than read. Count the placeholders from the row.

**[2026-08-08] [ops] Deleting the credential file in the same command that uses it hides the failure.**
The live cleanup was written as `wrangler … | grep '"changes"'` followed by `rm cf.env`. The wrangler
call failed, `grep` swallowed the error, `rm` ran anyway, and the shell reported success — the probe
rows were still live and I only noticed because I queried the database afterwards instead of
trusting the exit. **Verify the state, not the command**, and never pipe the only evidence of a
failure into a filter that drops it.

**[2026-08-08] [ops] ⭐ A single-use token spent on a GET is single-FETCH, not single-use.**
`/login/activate?t=…` burned the token in its GET handler. It worked perfectly for the admin who
clicked it — and died the moment they pasted it into WhatsApp, because Meta's servers open every
posted URL to build the preview card. The resident's tap then met «تم استخدام هذا اللينك». Browser
prefetch, antivirus link scanners and mail-security rewriters all do the same thing, so the failure
was intermittent-looking and channel-dependent, which is the hardest kind to report. **This is
precisely why HTTP requires GET to be safe.** The fix is structural: the GET peeks and renders a
button, the POST spends. Anything with a side effect belongs behind a press.

Two smaller things fell out of it, both worth keeping: the GET was also issuing a real
`set-cookie` session to whatever fetched it, and its page greeted the resident **by name** — so a
crawler was handed both a live session and a village member's name. The confirm page now carries no
personal detail and sets no cookie, and is marked `noindex, nofollow, noarchive`.

**[2026-08-08] [agent] A bug report that names the CHANNEL is naming the cause.** "It works when I
click open, but not when I send it on WhatsApp" is not a vague report — it is the whole diagnosis,
because the only difference between those two paths is who else fetched the URL in between. When a
user distinguishes two routes to the same feature, believe the distinction and look at what is
different about the transport, not at the feature.

**[2026-08-08] [ops] An HttpOnly cookie cannot report its own absence.** Activation kept failing on
the board's phone with «لازم تسجّل دخول الأول» — accurate (the enrol call got a 401) and useless to
somebody who had activated their account one second earlier. Server side everything was correct:
nineteen sessions created for that profile, none revoked, a well-formed single `Set-Cookie`, and the
whole flow completing in a real Chromium against the same code. The only remaining explanation was
the browser dropping the cookie, which an in-app WebView does — and the page could not tell, because
the session cookie is HttpOnly by design. **A second, readable, worthless cookie set beside it turns
"you are not logged in" into "this browser is not keeping cookies, open the link in Chrome".**

**[2026-08-08] [agent] An object literal cannot set two cookies.** `{ 'set-cookie': a, 'set-cookie': b }`
is not expressible, and joining them into one string ships a header browsers discard. `Headers.append`
is the only way; `html()` now takes `string | string[]` per field. Worth knowing before you need it,
because the failure is silent — one cookie simply never arrives.

**[2026-08-08] [agent] "It predates the fix" is a hypothesis, not an answer.** I told the board their
screenshot was from before the deploy. Their next screenshot had the new card in it AND the same
error, which falsified that in one image. The cost was a round trip; the lesson is to check a claim
about WHICH VERSION produced a screenshot against something version-specific in the screenshot
itself, which was available both times.

**[2026-08-08] [ops] ⭐ `new Response(body, { headers })` keeps ONE value per field — including
`set-cookie`.** The probe cookie passed its test in Node (undici's `Headers` preserves duplicates)
and silently vanished in the Workers runtime, where the preferences middleware rebuilds every HTML
response. One cookie arrived; the other did not; nothing errored. Found only by dumping the live
response headers after deploying. Carrying them across needs `getSetCookie()` and `append()`
explicitly. **Two runtimes, two behaviours, one passing test — a header-level assertion belongs
against the real deployment, not only the test harness.**

**[2026-08-08] [ops] ⭐ `window.PublicKeyCredential` existing does not mean the phone can MAKE a
passkey.** The board narrowed it precisely: enrolment works on phones with Samsung Pass or Google
Password Manager set up, and fails on phones without one. The API object is present in both — what
differs is whether a *platform authenticator* exists to hold the key, which is what
`PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` answers and what the code never
asked. So the button was offered, pressed, and failed with `NotAllowedError`, which the catch mapped
to «مقدرناش نتأكد إنه إنت. جرّب تاني» — telling somebody their fingerprint was not recognised when
their phone had never been able to try, and advising them to repeat the one thing that cannot work.
**Feature-detect the capability, not the API.**

**[2026-08-08] [ux] One apology for every failure hides the failures that need different actions.**
The same catch answered: cancelled, timed out, already-enrolled, wrong RP id, and no-authenticator.
Only the first two are worth retrying. Each now names its cause and appends the DOM error name, so
the next unexplained report arrives with the one word that identifies it instead of another round of
guessing.

**[2026-08-08] [agent] Ask what distinguishes the machines that work from the ones that don't.**
Two rounds went into cookies and WhatsApp crawlers because the report was "it fails on his phone".
The sentence that solved it in one line was the board's own: *"في موبيلات البصمة فيها متسجلة على
Samsung Pass أو Google Pass بتشتغل، وفي موبيلات تانية لأ."* A user comparing two populations has
already done the bisection; the job is to ask for that comparison early, not to theorise from one
failing case.
