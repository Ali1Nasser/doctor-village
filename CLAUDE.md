# AGENTS.md — repo conventions the agent must follow

*(Also save a copy as `CLAUDE.md` — some tools read one name, some the other.)*

## Every session starts here
1. `PROGRESS.md` → 2. `CHECKPOINTS.md` → 3. `DECISIONS.md` → 4. `INSIGHTS.md` → 5. `RISKS.md`
Then state: **"Resuming at Checkpoint N — next action: X."**

## Every session ends here
Update `PROGRESS.md` (including the cold-start brief) · tick `CHECKPOINTS.md` · append `INSIGHTS.md`
and `RISKS.md` · commit.

## Commands
```bash
npm run dev            # wrangler dev — local Workers + D1 + R2
npm run typecheck      # tsc --noEmit — must be clean
npm run lint           # RTL physical-property ban + no-SQL-outside-lib/db rule
npm run test           # vitest — unit, money, rbac
npm run test:access    # HTTP access tests as each role — CP-1 gate, blocks merge
npm run test:e2e       # playwright — the four role journeys
npm run db:migrate     # wrangler d1 migrations apply
npm run db:seed        # demo data (dev only — must be impossible in prod)
npm run deploy         # wrangler deploy
npm run backup         # manual D1 dump → R2 (the cron does this nightly)
```

## Code conventions
- TypeScript `strict`. No `any`. No non-null assertions on data from the database.
- Server Components by default; `"use client"` only where interaction requires it.
- Every Server Action validates input with a Zod schema shared with the client.
- Money **only** through `lib/money.ts`. No arithmetic on currency anywhere else.
- Permissions **only** through `lib/rbac.ts`. No inline `role === 'admin'` checks.
- SQL **only** inside `lib/db/`. Every function there takes `ctx: AuthContext` as its first argument
  — a missing identity must be a compile error. Ownership predicates live inside the query string.
- Vendors **only** behind their adapters: `lib/db/` (D1), `lib/storage/` (R2), `lib/auth/channel.ts`
  (WhatsApp/fallbacks). No vendor SDK import anywhere else.
- All user-facing strings in `messages/ar.json`. A hardcoded Arabic string in a component fails review.
- Tailwind logical properties only. `ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-` are lint errors.
- Wrap every number, phone, and reference in `<bdi dir="ltr" class="tabular-nums">`.
- File naming: `kebab-case.tsx`. Components `PascalCase`. Database `snake_case`.

## Structure
```
src/routes/{login,home,pay,payments,finance,news,albums,documents,search,me}
src/routes/admin/{review,expenses,categories,fees,users,staff,audit,settings,health}
src/routes/api/{auth/start,auth/whatsapp-webhook,auth/poll,files/[key]}
src/components/{ui,forms,finance,layout}
lib/db/          ← the ONLY place SQL exists
lib/storage/     ← R2 adapter
lib/auth/        ← channel.ts + fallback links
lib/{money,rbac,validation,format}.ts
messages/ar.json · types/domain.ts
migrations/ · seed/{demo,prod}/ · tests/{unit,access,e2e}/
docs/{OPEN_QUESTIONS,PROPOSALS,ADMIN_MANUAL_AR}.md
wrangler.toml
```

## Git
- Conventional commits with the checkpoint tag: `feat(payments): add review queue [CP-4]`
- One checkpoint per branch: `cp-4-payments`. Never commit directly to `main`.
- No secrets in the repo. `.env.local` is gitignored; `.env.example` documents every variable.

## Definition of done for any task
- [ ] It runs — you executed it, you did not merely read it
- [ ] Types pass, lint passes, tests pass
- [ ] Loading, empty, error, success, and offline states all exist
- [ ] RTL verified with real Arabic text and real numbers
- [ ] Works at 360px width and at 17px minimum body text
- [ ] Strings are in `messages/ar.json`
- [ ] Permissions enforced in the database, not only the UI
- [ ] `PROGRESS.md` updated

## Never
Email or password auth · float money · SQL outside `lib/db/` · a data-access call without an identity ·
hardcoded strings · physical directional CSS · invented resident data outside `seed/demo/` · a
checkpoint marked complete with a failing gate · a schema change on production without written
approval · **any service that requires a credit card** · a WhatsApp authentication or utility template
message (those are billed — only replies inside a user-initiated window are free) · Google Drive or
Sheets as the live database.
