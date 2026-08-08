# 02 — Data Model & Security Spec

PostgreSQL 15 (Supabase). Money is `BIGINT` piastres. Every table has RLS enabled — **no exceptions**.

---

## 1. Design invariants

1. `amount_piastres BIGINT NOT NULL CHECK (amount_piastres > 0)` — never float, never negative.
   Reversals are separate rows with `is_reversal = true`, not negative amounts.
2. Nothing financial is ever hard-deleted. `deleted_at` + a reversing entry.
3. Phone numbers stored E.164 (`+201012345678`), normalized on write by a trigger.
4. Every mutating action writes one `audit_log` row. The audit log is insert-only to everyone.
5. Aggregates are computed from `payments`/`expenses` — never stored as a mutable running total.
   Materialized views for speed, refreshed on write, but the ledger is the truth.
6. `payments` are only counted when `status = 'approved'`.

## 2. Enums

```sql
create type user_role       as enum ('developer','admin','operator','resident');
create type payment_status  as enum ('draft','submitted','under_review','needs_info',
                                    'approved','rejected','duplicate','cancelled','reversed');
create type payment_method  as enum ('instapay','bank_transfer','vodafone_cash','cash','other');
create type txn_direction   as enum ('income','expense');
create type post_type       as enum ('news','announcement','decision','minutes','document');
create type due_basis       as enum ('per_unit','per_sqm');
```

## 3. Core tables

### `buildings`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| code | text unique | "عمارة 5" |
| name | text | optional friendly name |
| sort_order | int | |

### `units` — الشقق
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| building_id | uuid fk → buildings | |
| unit_number | text | "12" |
| area_sqm | numeric(8,2) null | for per-sqm dues |
| notes | text null | admin-only |
| **unique** | (building_id, unit_number) | |

### `profiles` — الملاك والمستخدمون
> **⚠️ Corrected — see `00_MASTER_PROMPT.md` C1b.** `phone_e164` was originally shown here as the
> account's key. It is **not**. The phone number is a *login identifier* and a mutable attribute; it
> now lives in its own table (`phone_identifiers`) with history, so a number can be changed,
> transferred, or recovered without touching the person's units or financial history. The column
> below is retained only as a denormalized cache of the current primary number, and **nothing may
> reference it as a foreign key.**

| column | type | notes |
|---|---|---|
| id | uuid pk | the real identity — immutable, referenced everywhere |
| phone_e164 | text | **cache only** of the current primary identifier; never a FK target |
| full_name | text not null | |
| role | user_role not null default 'resident' | |
| is_active | bool default true | deactivate instead of delete |
| preferred_channel | text default 'whatsapp' | whatsapp \| sms |
| created_by | uuid fk → profiles null | who provisioned them |
| last_login_at | timestamptz null | |

### `phone_identifiers` — أرقام الموبايل وتاريخها ⭐ new
The single most important structural correction in this document.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| profile_id | uuid fk → profiles | |
| phone_e164 | text not null | normalized by trigger |
| is_primary | bool default true | one primary per profile |
| verified_at | timestamptz null | |
| status | text | `active` \| `replaced` \| `revoked` |
| replaced_by_id | uuid fk → phone_identifiers null | the chain of custody |
| changed_by | uuid fk → profiles null | which admin made the change |
| change_reason_ar | text null | required on change |
| valid_from / valid_to | timestamptz | effective dating |

**Partial unique index:** `unique (phone_e164) where status = 'active'` — one live owner per number,
while history is preserved forever.

### `passkeys` — WebAuthn credentials ⭐ new
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| profile_id | uuid fk → profiles | |
| credential_id | text unique | |
| public_key | bytea | **never a private key, never biometric data** |
| sign_count | bigint | replay/clone detection |
| device_label_ar | text | "موبايل أحمد" — so a resident can revoke the right one |
| created_at / last_used_at | timestamptz | |
| revoked_at | timestamptz null | |

### `activation_challenges` — تفعيل واسترجاع ⭐ new
Replaces `otp_challenges` as the primary table (that one stays for the disabled outbound adapter).
`(id, profile_id, token_hash, purpose, expires_at, consumed_at, issued_by, channel, attempts, ip)`
Purposes: `first_activation` · `recovery` · `new_device`. Tokens are **hashed**, single-use, and one
active challenge per person at a time.

### `unit_owners` — many-to-many; a person can own two flats, a flat can have two owners
| column | type |
|---|---|
| id | uuid pk |
| unit_id | uuid fk → units |
| profile_id | uuid fk → profiles |
| ownership_share | numeric(5,4) default 1.0 |
| is_primary_contact | bool default true |
| valid_from / valid_to | date · `valid_to` null = current ⭐ |
| **unique** | (unit_id, profile_id) where valid_to is null |

**Effective dating matters:** when a flat is sold, the former owner's row is closed with a
`valid_to`, not deleted. Their historical payments stay attributable, their access ends, and a
dispute two years later is still answerable.

### `delegate_authorizations` — التفويض ⭐ new
An owner living in Cairo authorizes a son, a spouse, or a caretaker to act for them. Extremely
common here and completely absent from the original model.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| owner_profile_id | uuid fk → profiles | who granted it |
| delegate_profile_id | uuid fk → profiles | who received it |
| unit_id | uuid fk → units | scoped to one unit |
| can_view_financials | bool default false | granular, not all-or-nothing |
| can_submit_payments | bool default true | |
| valid_from / valid_to | date | **must expire** |
| granted_by / granted_at | uuid, timestamptz | audited |
| revoked_at / revoked_by | timestamptz, uuid | |

A delegate sees only what the grant allows, only for that unit, only while it is valid. Every
delegated action is logged as *"فلان — بالنيابة عن فلان"*, never as the owner alone.

### `categories` — فئات الإيرادات والمصروفات
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| parent_id | uuid fk → categories null | one level of nesting |
| name_ar | text not null | |
| direction | txn_direction not null | income or expense |
| icon | text null | lucide icon name |
| color | text null | |
| sort_order | int | |
| is_active | bool default true | deactivate, don't delete |

**Seed taxonomy (expense):**
الوديعة · الصيانة (لمبات وإضاءة، أعمال كهربائية: مفاتيح ومواتير، سباكة، دهانات وترميم، مصاعد) ·
المياه (عربات مياه حلوة، مياه استخدام) · مرتبات العمالة · الأمن والحراسة · النظافة ورفع المخلفات ·
المساحات الخضراء · حمام السباحة · الكهرباء (عداد عام) · مصروفات إدارية ورسوم حكومية · الطوارئ · أخرى

**Seed taxonomy (income):** اشتراك الصيانة السنوي · وديعة · مساهمات خاصة · غرامات تأخير · إيرادات أخرى

### `fee_periods` — فترات الاشتراك
| column | type |
|---|---|
| id | uuid pk |
| name_ar | text — "اشتراك 2026" |
| category_id | uuid fk → categories (income) |
| starts_on / ends_on | date |
| due_on | date |
| basis | due_basis |
| amount_piastres | bigint — flat, or per sqm |
| is_published | bool default false |

### `unit_dues` — المطلوب من كل وحدة
| column | type |
|---|---|
| id | uuid pk |
| fee_period_id | uuid fk |
| unit_id | uuid fk |
| amount_piastres | bigint (computed at generation, then frozen) |
| waived_piastres | bigint default 0 |
| waiver_reason | text null |
| **unique** | (fee_period_id, unit_id) |

### `payments` — إيصالات السداد
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| receipt_no | text unique | human-quotable, e.g. `R-2026-00417` |
| unit_id | uuid fk → units | |
| submitted_by | uuid fk → profiles | |
| category_id | uuid fk → categories (income) | |
| fee_period_id | uuid fk null | |
| claimed_amount_piastres | bigint not null check > 0 | what the resident stated |
| approved_amount_piastres | bigint null | what the admin confirmed |
| method | payment_method not null | |
| transfer_date | date not null | |
| reference_no | text null | |
| image_path | text not null | Supabase Storage key, private bucket |
| image_sha256 | text | duplicate detection |
| note | text null | |
| status | payment_status default 'draft' | **nine states** — see `06_ACCOUNTING_AND_LEDGER.md` §3 |
| journal_entry_id | uuid fk → journal_entries null | set on approval |
| fund_id / cost_center_id | uuid fk null | dimensions for reporting |
| reviewed_by | uuid fk → profiles null | |
| reviewed_at | timestamptz null | |
| review_reason | text null | mandatory on reject / amount correction |
| is_reversal | bool default false | |
| reverses_payment_id | uuid fk → payments null | |
| created_at | timestamptz default now() | |

**Constraints**
```sql
check (status <> 'approved' or approved_amount_piastres is not null)
check (status not in ('rejected','needs_info') or review_reason is not null)
check (approved_amount_piastres is null
       or approved_amount_piastres = claimed_amount_piastres
       or review_reason is not null)              -- corrections must be explained
```
**Idempotency:** approval runs inside `update payments set status='approved' … where id=$1 and status <> 'approved'`
and posts only if `rowcount = 1`. Never a read-then-write.

### `expenses` — المصروفات
| column | type |
|---|---|
| id | uuid pk |
| voucher_no | text unique — `E-2026-00133` |
| category_id | uuid fk → categories (expense) |
| amount_piastres | bigint not null check > 0 |
| spent_on | date not null |
| description_ar | text not null |
| vendor_name | text null |
| invoice_image_path | text null |
| recorded_by | uuid fk → profiles |
| approved_by | uuid fk → profiles null — admin countersign for amounts over a threshold |
| linked_album_id | uuid fk → albums null |
| linked_ticket_id | uuid fk → maintenance_tickets null |
| is_reversal / reverses_expense_id | bool / uuid |
| created_at | timestamptz |

### `staff` — العمالة
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| full_name | text | **admin/operator visible only** |
| job_title_ar | text | visible to all |
| monthly_salary_piastres | bigint | visible to all |
| started_on / ended_on | date | |
| is_active | bool | |

### `posts` — أخبار، إعلانات، قرارات، محاضر، مستندات
| column | type |
|---|---|
| id | uuid pk |
| type | post_type |
| title_ar | text |
| body_ar | text (markdown) |
| published_at | timestamptz |
| is_pinned | bool default false |
| author_id | uuid fk → profiles |
| attachments | jsonb — [{path, name, size, mime}] |
| search_tsv | tsvector generated — Arabic FTS |

### `albums` / `album_photos` — أعمال الصيانة والتطوير
`albums(id, title_ar, description_ar, happened_on, cover_photo_id, created_by)`
`album_photos(id, album_id, storage_path, caption_ar, sort_order, taken_at)`

### `maintenance_tickets` — بلاغات الصيانة (proposed value-add)
`(id, ticket_no, reported_by, unit_id, category_id, title_ar, description_ar, photo_paths[], voice_note_path, status, assigned_to, resolved_at, linked_expense_id)`

### `notifications`
`(id, profile_id, kind, title_ar, body_ar, link_path, channel, sent_at, read_at)`

### `otp_challenges`
`(id, phone_e164, code_hash, expires_at, attempts, consumed_at, ip, user_agent, created_at)`
Code is **hashed** (never stored plain). 6 digits, 5-minute TTL, max 5 attempts, then the challenge burns.

### `audit_log`
`(id, actor_id, actor_role, action, entity_table, entity_id, before jsonb, after jsonb, ip, created_at)`
Insert-only. No update or delete policy exists for anyone, including `developer`.

### `settings`
Single-row config: community name, logo, contact numbers, bank/InstaPay details shown on the payment
screen, currency label, fiscal year start, notification hours.

## 4. Views

```sql
-- عام للجميع: إجماليات القرية
create view v_community_totals as
select
  (select coalesce(sum(approved_amount_piastres),0) from payments
     where status='approved' and not is_reversal
     and id not in (select reverses_payment_id from payments where reverses_payment_id is not null)
  ) as total_income_piastres,
  (select coalesce(sum(amount_piastres),0) from expenses
     where not is_reversal
     and id not in (select reverses_expense_id from expenses where reverses_expense_id is not null)
  ) as total_expense_piastres;
-- treasury_balance = total_income - total_expense  (computed in the view)

create view v_expense_by_category as ...   -- category, total, share %
create view v_unit_balance as ...          -- unit, due, paid, outstanding  (aggregates only)
create view v_my_payments as ...           -- RLS-filtered to the caller
```

`v_unit_balance` is **readable by every authenticated member** — this is the transparency requirement.
It exposes unit, building, total due, total paid, outstanding. It exposes **no** phone numbers,
**no** receipt images, **no** notes.

## 5. Row Level Security — policy sketch

Helper functions (`security definer`, `stable`):
```sql
create function auth_role() returns user_role ...          -- reads profiles for auth.uid()
create function is_staff() returns boolean                  -- role in (developer, admin, operator)
create function is_admin() returns boolean                  -- role in (developer, admin)
create function owns_unit(u uuid) returns boolean           -- caller is in unit_owners for u
```

| table | resident SELECT | resident INSERT/UPDATE | staff |
|---|---|---|---|
| `profiles` | own row only | own row: name, preferred_channel | admin: all; operator: name+unit only, no phone |
| `units`, `buildings` | all (no `notes`) | none | admin: all |
| `categories` | all active | none | admin: all |
| `fee_periods`, `unit_dues` | all published | none | admin: all |
| `payments` | `owns_unit(unit_id)` only | INSERT for own unit, status forced `pending`; UPDATE only while `pending` | admin: all + review; operator: read all, no review |
| `expenses` | all (read) | none | operator: insert; admin: all |
| `staff` | all **except `full_name`** (column-level via a view) | none | admin/operator: all |
| `posts`, `albums` | published only | none | admin/operator: write |
| `audit_log` | none | none | admin: read; nobody: update/delete |
| `otp_challenges` | none | none | service role only |

**Critical policy examples**
```sql
alter table payments enable row level security;

create policy payments_select_own on payments for select to authenticated
  using ( owns_unit(unit_id) or is_staff() );

create policy payments_insert_own on payments for insert to authenticated
  with check ( owns_unit(unit_id)
               and status = 'pending'
               and approved_amount_piastres is null
               and reviewed_by is null );

create policy payments_update_pending_own on payments for update to authenticated
  using ( owns_unit(unit_id) and status = 'pending' )
  with check ( status = 'pending' );          -- a resident can never self-approve

create policy payments_review_admin on payments for update to authenticated
  using ( is_admin() );
```

**Storage:** `receipts` is a private bucket. A resident may read only objects whose path prefix is
their own unit id; staff may read all. Access is via short-lived signed URLs (60 s), never public URLs.

## 6. Required RLS test suite (CP-1 gate)

Each of these must be an automated, checked-in test that **fails** against a deliberately loosened policy:

1. Resident A cannot `SELECT` resident B's `payments` row.
2. Resident A cannot `SELECT` a signed URL for resident B's receipt image.
3. Resident A cannot `UPDATE` their own payment's `status` to `approved`.
4. Resident A cannot `INSERT` a payment for a unit they do not own.
5. Resident A cannot `SELECT` any `profiles.phone_e164` except their own.
6. An `operator` cannot approve a payment.
7. An `operator` cannot read `profiles.phone_e164`.
8. Nobody — including `developer` — can `UPDATE` or `DELETE` an `audit_log` row.
9. A resident **can** read `v_community_totals`, `v_expense_by_category`, and `v_unit_balance`.
10. An unauthenticated caller can read nothing at all.

**Added after review — these five are equally mandatory:**

11. Resident A cannot read any row of `phone_identifiers` belonging to resident B, including history.
12. An expired or revoked `delegate_authorization` grants nothing — the delegate's access ends the
    moment `valid_to` passes, verified by a clock-advance test.
13. A delegate with `can_view_financials = false` cannot read the owner's statement by any route.
14. A former owner (`unit_owners.valid_to` in the past) cannot read the unit's current data, while
    their historical payments remain attributable to them in the ledger.
15. No role — including `developer` — can update or delete a `journal_line`.

## 7. Money handling module (`lib/money.ts`)

```ts
export type Piastres = number & { readonly __brand: 'Piastres' };
export const fromEGP  = (egp: string | number): Piastres => …  // parse via string, never parseFloat on user input
export const toEGP    = (p: Piastres): string => …             // "1,234.50"
export const formatAr = (p: Piastres): string => …             // "1,234.50 ج.م"
export const sum      = (xs: Piastres[]): Piastres => …
```
No arithmetic on money happens anywhere except in this module. Unit-test it against:
`0`, `1` piastre, `0.005` rounding, `999,999,999.99`, `"1,234.50"`, `"١٢٣٤"` (Arabic-Indic digits),
`"1 234,50"`, `null`, `""`, `"abc"`, and a negative input.


---

## ⚠️ Village map — restored 2026-08-08 from the v1.1 spec revision

The pack's specification files are **v1.1 — village-map revision**; the copies this project was
built from are v1.0 and omit every map paragraph, along with constraint **C13**, product goal 4 and
`07_VILLAGE_MAP_SPEC.md`. Found by diffing the uploaded packs against this repo, twenty-seven
sessions in (INSIGHTS 2026-08-08, R-084).

**Rule 7 (restored):** *A map label is never inventory. Buildings and units come only from a
board-approved register.*

**As implemented (2026-08-08):** `migrations/0023_village_map.sql`.
`building_map_features.building_id` REFERENCES `buildings(id)`, so a hotspot for a building that is
not in the register cannot be stored; `trg_map_publish_needs_verified_features` refuses publication
while any hotspot is unlinked or unverified; `map_documents.status` is `draft | published |
archived` with a partial unique index allowing exactly one published version. Coordinates are
normalised integers 0–10,000, never pixels.
