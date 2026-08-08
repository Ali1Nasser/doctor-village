/**
 * src/app.ts — the HTTP surface.
 *
 * Deliberately thin. Every route does exactly three things: resolve the caller's
 * identity, hand it to a `lib/db/` function, and map errors to status codes.
 * There is no SQL here and no permission logic here — a route that decided
 * anything for itself would be a second place authorization lives, and the whole
 * point of ADR-010 is that there is only one.
 *
 * This is what the CP-1 access tests execute against, as each role, over HTTP.
 */

import { Hono } from 'hono';
import type { Db } from '../lib/db/driver.js';
import { LedgerRefused } from '../lib/db/driver.js';
import { Forbidden, can } from '../lib/rbac.js';
import { normalize } from '../lib/phone.js';
import { parse as parseMoneyRaw, PARSE_MESSAGES_AR } from '../lib/money.js';
import * as data from '../lib/db/index.js';
import { NotFound } from '../lib/db/index.js';
import type { AuthContext } from '../types/domain.js';
import * as v from './views/pages.js';
import * as passkey from '../lib/auth/passkey.js';
import { getChannel } from '../lib/auth/channel.js';
import * as adb from '../lib/db/auth.js';
import * as drafts from '../lib/db/drafts.js';
import * as onboard from '../lib/db/onboarding.js';
import * as fees from '../lib/db/fees.js';
import * as settle from '../lib/db/settlements.js';
import * as adm from '../lib/db/admin.js';
import * as av from './views/admin-pages.js';
import * as mutations from '../lib/db/mutations.js';
import * as expenses from '../lib/db/expenses.js';
import * as push from '../lib/db/push.js';
import { deliverPush } from '../lib/push/deliver.js';
import { SERVICE_WORKER } from './sw.js';
import * as content from '../lib/db/content.js';
import * as statement from '../lib/db/statement.js';
import * as cv from './views/content-pages.js';
import { parseOwners, summaryAr } from '../lib/import/owners.js';
import { StorageFull, assertRoomFor } from '../lib/storage/index.js';
import { stripImageMetadata, UnsupportedImage } from '../lib/storage/image.js';
import { t as _t } from './views/layout.js';
import * as _layout from './views/layout.js';

/** Display preferences travel in two small cookies, not in the session: they
 *  are a property of the DEVICE (this phone is hard to read in sunlight), not
 *  of the person, and they must work before login. */
function readPrefs(cookie: string): { theme: string; fs: string } {
  const get = (k: string) => new RegExp(`(?:^|;\\s*)${k}=([^;]*)`).exec(cookie)?.[1] ?? '';
  const theme = get('qa_theme'), fs = get('qa_fs');
  return {
    theme: ['light', 'dark'].includes(theme) ? theme : '',
    fs: ['lg', 'xl'].includes(fs) ? fs : '',
  };
}

export interface AppDeps {
  db: Db;
  /** Injectable so the delegate-expiry test can advance the clock. */
  now: () => string;
  storage: { get(key: string): Promise<{ body: Uint8Array; mime: string } | null> };
  /** Renders the "every figure here is invented" banner. Demo databases only. */
  demo?: boolean;
  /** Payment categories for the /pay step-2 grid. */
  payCategories?: { id: string; nameAr: string; icon?: string }[];
  /** WebAuthn relying party. R-022: passkeys are BOUND to `id`; changing it
   *  later invalidates every enrolled credential in the village. */
  rp: passkey.RelyingParty;
  /** Full storage adapter — `get` alone is enough for reads, but uploads need put. */
  storagePut?: (i: { key: string; body: Uint8Array; mime: string; unitId: string | null })
    => Promise<{ key: string; sizeBytes: number }>;
  storageUsedBytes?: () => Promise<number>;
  /** Web Push identity (Q23). Absent = push is off on this deployment, and the
   *  enable button is not rendered at all — a button that cannot work teaches
   *  the resident the site is broken rather than that a feature is off. */
  vapid?: { subject: string; publicKey: string; privateKey: string };
  /** Injectable so tests can observe a send without a network. */
  fetchImpl?: typeof fetch;
}

type Env = { Variables: { ctx: AuthContext | null } };

export function createApp(deps: AppDeps) {
  const app = new Hono<Env>();

  // ---- identity, once, for every request ---------------------------------
  app.use('*', async (c, next) => {
    // Two carriers, one resolution path. The browser uses an HttpOnly cookie;
    // the access tests use a Bearer header. Anything that reads identity reads
    // it here, so a route cannot accidentally trust a different source.
    const auth = c.req.header('authorization');
    const cookie = c.req.header('cookie') ?? '';
    const m = /(?:^|;\s*)qa_session=([^;]+)/.exec(cookie);
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : (m?.[1] ?? null);
    c.set('ctx', await data.resolveAuthContext(deps.db, token, deps.now));
    await next();
  });

  // ---- display preferences, applied to every HTML response ---------------
  // One place. A view that forgot to thread the cookie through would render an
  // unthemed page, and there are 30+ of them.
  app.use('*', async (c, next) => {
    await next();
    const type = c.res.headers.get('content-type') ?? '';
    if (!type.includes('text/html')) return;
    const { theme, fs } = readPrefs(c.req.header('cookie') ?? '');
    if (!theme && !fs && c.req.path === '/') return;
    const body = await c.res.text();
    c.res = new Response(
      _layout.applyPrefs(body, theme, fs, c.req.path),
      { status: c.res.status, headers: c.res.headers },
    );
  });

  /** Access test 10: an unauthenticated caller can read nothing at all. One
   *  helper, used by every protected route, so it cannot be forgotten on one. */
  const need = (c: { get(k: 'ctx'): AuthContext | null }): AuthContext => {
    const ctx = c.get('ctx');
    if (!ctx) throw new Unauthorized();
    return ctx;
  };

  // ---- errors ------------------------------------------------------------
  app.onError((err, c) => {
    if (err instanceof passkey.RateLimited) return c.json({ error: err.reasonAr }, 429);
    if (err instanceof passkey.AuthFailed) return c.json({ error: err.reasonAr }, 401);
    if (err instanceof StorageFull) return c.json({ error: err.reasonAr }, 507);
    // 415: the photo is a format whose metadata layout is not understood, or it
    // arrived damaged. Refusing beats storing it and claiming it was cleaned.
    if (err instanceof UnsupportedImage) return c.json({ error: err.reasonAr }, 415);
    if (err instanceof Unauthorized) return c.json({ error: 'لازم تسجّل دخول الأول' }, 401);
    if (err instanceof Forbidden) return c.json({ error: err.reasonAr }, 403);
    if (err instanceof NotFound) return c.json({ error: err.reasonAr }, 404);
    if (err instanceof LedgerRefused) return c.json({ error: err.reasonAr }, 409);
    // Never leak a stack trace or a SQL string to a resident. 04_UX_SPEC §5.
    console.error('[unhandled]', err);
    return c.json({ error: 'حصل خطأ عندنا. جرّب تاني، ولو فضل كلّم الإدارة.' }, 500);
  });

  // ---- me ----------------------------------------------------------------
  app.get('/api/me', c => {
    const ctx = need(c);
    return c.json({
      id: ctx.personId, role: ctx.role,
      units: ctx.ownedUnitIds,
      delegatedUnits: ctx.delegatedUnits.map(d => d.unitId),
    });
  });

  app.get('/api/profiles/:id/phones', async c => {
    const ctx = need(c);
    return c.json(await data.getPhoneNumbers(ctx, deps.db, c.req.param('id') as never));
  });

  // ---- payments ----------------------------------------------------------
  app.get('/api/payments', async c =>
    c.json(await data.listMyPayments(need(c), deps.db, deps.now)));

  app.get('/api/payments/:id', async c =>
    c.json(await data.getPayment(need(c), deps.db, c.req.param('id') as never, deps.now)));

  app.post('/api/payments', async c => {
    const ctx = need(c);
    const b = await c.req.json();
    const id = data.newId('PAY') as never;
    await data.createPayment(ctx, deps.db, {
      id,
      receiptNo: b.receiptNo,
      unitId: b.unitId,
      categoryId: b.categoryId,
      feePeriodId: b.feePeriodId ?? null,
      claimedAmountPiastres: b.claimedAmountPiastres,
      method: b.method,
      transferDate: b.transferDate,
      referenceNo: b.referenceNo ?? null,
      storageKey: b.storageKey,
      imageSha256: b.imageSha256 ?? null,
      noteAr: b.noteAr ?? null,
    }, deps.now);
    return c.json({ id }, 201);
  });

  app.post('/api/payments/:id/review', async c => {
    const ctx = need(c);
    const b = await c.req.json();
    await data.reviewPayment(ctx, deps.db, c.req.param('id') as never, b, deps.now);
    const p = await data.getPayment(ctx, deps.db, c.req.param('id') as never, deps.now);
    await pushLatest(p.submitted_by);
    return c.json({ ok: true });
  });

  app.post('/api/payments/:id/take', async c => {
    await data.takeForReview(need(c), deps.db, c.req.param('id') as never);
    return c.json({ ok: true });
  });

  // ---- receipt images ----------------------------------------------------
  // The ONLY route that serves a byte of a receipt. Ownership is re-checked on
  // every request, not once at upload. There are no public object URLs. (C6)
  app.get('/api/files/*', async c => {
    const ctx = need(c);
    const key = c.req.path.replace('/api/files/', '');
    const meta = await data.authorizeObjectRead(ctx, deps.db, key, deps.now);
    const obj = await deps.storage.get(meta.storageKey);
    if (!obj) throw new NotFound('الملف مش موجود');
    return c.body(obj.body as unknown as ArrayBuffer, 200, {
      'content-type': obj.mime,
      'cache-control': 'private, no-store',
    });
  });

  // ---- transparency ------------------------------------------------------
  app.get('/api/finance/totals', async c =>
    c.json(await data.getCommunityTotals(need(c), deps.db)));

  app.get('/api/finance/categories', async c =>
    c.json(await data.getExpenseByCategory(need(c), deps.db)));

  app.get('/api/finance/units', async c =>
    c.json(await data.getUnitBalances(need(c), deps.db)));

  app.get('/api/units/:id/statement', async c =>
    c.json(await data.getUnitStatement(need(c), deps.db, c.req.param('id') as never, deps.now)));

  app.get('/api/staff', async c => c.json(await data.getStaff(need(c), deps.db)));

  // ---- oversight ---------------------------------------------------------
  app.get('/api/audit', async c => c.json(await data.readAuditLog(need(c), deps.db)));

  // There is deliberately NO route that writes to the audit log, for any role.
  // These exist only to answer with 405 rather than 404, so the access test is
  // asserting a designed refusal instead of a missing feature.
  app.on(['PATCH', 'PUT', 'DELETE'], '/api/audit/:id', c =>
    c.json({ error: 'سجل المراجعة مش بيتعدّل ولا بيتمسح — ولا حتى من المبرمج' }, 405));

  /**
   * Break-glass, present so the CP-1 gate can prove access test 15 over HTTP:
   * the most privileged path in the system still cannot rewrite a posted
   * journal line, because the database refuses it.
   */
  app.patch('/api/dev/journal-lines/:id', async c => {
    const ctx = need(c);
    const b = await c.req.json();
    await data.developerAttemptJournalLineEdit(ctx, deps.db, c.req.param('id') as never, b.debitPiastres);
    return c.json({ ok: true });   // unreachable if the schema is intact
  });

  app.get('/api/health', c => c.json({ ok: true, authenticated: !!c.get('ctx') }));

  /* =================================================================== */
  /* HTML — server-rendered, no client framework.                        */
  /* Routes fetch through lib/db/ exactly like the JSON API; the view     */
  /* layer receives plain data and never queries anything itself.         */
  /* =================================================================== */

  // ⚠️ This builds a FRESH Response, so anything set via `c.header(...)` earlier
  // in the handler is DISCARDED. That silently dropped the session cookie on the
  // activation page: `c.header('set-cookie', …)` looked right and did nothing.
  // Headers a response needs must be passed in here, explicitly.
  const html = (s: string, status = 200, headers: Record<string, string> = {}) =>
    new Response(s, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    });

  /**
   * The board's own navigation, computed per caller.
   *
   * Every `/admin/*` screen was reachable only by typing its URL: the five nav
   * tabs are the resident's, and an admin landed on the same home page as
   * everybody else. So the admin half of the portal existed and could not be
   * found — including, until now, the only way to onboard the village.
   *
   * Each entry is gated on the capability its route enforces, so a
   * `finance_reviewer` sees oversight and no approve buttons, and an operator
   * sees content but never the receipt queue. The routes check again; this is
   * only what gets drawn.
   */
  const boardLinks = (ctx: AuthContext) => {
    const out: { href: string; icon: string; label: string }[] = [];
    const add = (cap: Parameters<typeof can>[1], href: string, icon: string, label: string) => {
      if (can(ctx.role, cap)) out.push({ href, icon, label });
    };
    add('user.create', '/admin/members', '👥', _t.members.title);
    add('payment.review', '/admin/review', '🧾', _t.admin.queueTitle);
    add('payment.read_any', '/admin/payments', '✅', _t.admin.approvedTitle);
    add('expense.record', '/admin/expenses', '💸', _t.expenses.title);
    add('fee.manage', '/admin/fees', '📅', _t.fees.title);
    add('payment.read_any', '/admin/settlements', '🏦', _t.settle.title);
    add('post.publish', '/admin/content', '✍️', _t.content.manage);
    add('category.manage', '/admin/categories', '🏷️', _t.categories.title);
    add('user.assign_role', '/admin/users', '🛡️', _t.users.title);
    add('staff.read_names', '/admin/staff', '👷', _t.staffAdmin.title);
    add('audit.read', '/admin/audit', '📜', _t.auditView.title);
    add('settings.edit', '/admin/settings', '⚙️', _t.settings.title);
    add('system.read_quota', '/admin/health', '📊', _t.health.title);
    return out;
  };

  app.get('/login', () => html(v.loginPage()));

  /* ---- passkey ceremonies -------------------------------------------- */

  /** Opens a session and RETURNS the cookie, rather than setting it as a side
   *  effect on the context — see the note on `html()` above. */
  const openSessionCookie = async (
    profileId: string, ip: string | null, ua: string | null,
  ): Promise<string> => {
    const token = passkey.randomToken();
    await adb.openSession(deps.db, profileId, await passkey.sha256(token), deps.now,
      { ip: ip ?? undefined, userAgent: ua ?? undefined });
    // HttpOnly so no script can read it; SameSite=Lax so a cross-site form post
    // cannot ride it; Secure because this is only ever served over HTTPS.
    return `qa_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${365 * 24 * 3600}`;
  };

  app.post('/api/auth/login/begin', async c => {
    const { phone } = await c.req.json<{ phone: string }>();
    const norm = normalizePhone(phone);
    // A malformed number gets the SAME shape of answer as a valid unknown one.
    if (!norm) return c.json({ needsActivation: true, key: null, options: null });
    const r = await passkey.beginLogin(deps.db, deps.rp, norm,
      c.req.header('cf-connecting-ip') ?? null, deps.now);
    return c.json(r);
  });

  app.post('/api/auth/login/finish', async c => {
    const { key, response } = await c.req.json<{ key: string; response: unknown }>();
    const { profileId } = await passkey.finishLogin(deps.db, deps.rp, key, response,
      c.req.header('cf-connecting-ip') ?? null, deps.now);
    const cookie = await openSessionCookie(profileId, c.req.header('cf-connecting-ip') ?? null,
      c.req.header('user-agent') ?? null);
    c.header('set-cookie', cookie);
    return c.json({ ok: true });
  });

  /** The board-issued activation link. Burns the token and opens a short
   *  enrollment session — the ONE moment a passkey can be created. */
  app.get('/login/activate', async c => {
    const token = c.req.query('t');
    if (!token) return html(v.messagePage(_t.activate.title, _t.activate.expired), 400);
    const used = await adb.consumeActivationChallenge(
      deps.db, await passkey.sha256(token), deps.now);
    if (!used) return html(v.messagePage(_t.activate.title, _t.activate.used), 410);
    const cookie = await openSessionCookie(used.profileId, null,
      c.req.header('user-agent') ?? null);
    const codes = Array.from({ length: 6 }, () => passkey.humanCode());
    await adb.issueRecoveryCodes(deps.db, used.profileId,
      await Promise.all(codes.map(x => passkey.sha256(x))), deps.now);
    return html(v.activatePage(used.fullName, codes), 200, { 'set-cookie': cookie });
  });

  app.post('/api/auth/enroll/begin', async c => {
    const ctx = need(c);
    const name = await data.getDisplayName(ctx, deps.db);
    return c.json(await passkey.beginEnrollment(deps.db, deps.rp, ctx.personId, name, deps.now));
  });

  app.post('/api/auth/enroll/finish', async c => {
    need(c);
    const { key, response, label } = await c.req.json<{ key: string; response: unknown; label?: string }>();
    await passkey.finishEnrollment(deps.db, deps.rp, key, response, label || 'جهاز', deps.now);
    return c.json({ ok: true });
  });

  /* ---- recovery: the printed code (R-023) ------------------------------ */
  // The passkey bypass, so it is rate-limited harder than login itself: a
  // printed code is short enough to guess if you are allowed enough tries.

  app.get('/login/recover', () => html(v.recoverPage()));

  app.post('/api/auth/recover', async c => {
    const { code } = await c.req.json<{ code: string }>();
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const since = new Date(Date.parse(deps.now()) - 15 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
    if (await adb.countRecentAttempts(deps.db, 'recover', ip, since) >= 3) {
      throw new passkey.RateLimited();
    }
    await adb.recordAttempt(deps.db, 'recover', ip, false, deps.now);

    const norm = String(code ?? '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
    const used = await adb.redeemRecoveryCode(deps.db, await passkey.sha256(norm), deps.now);
    if (!used) throw new passkey.AuthFailed('الكود ده مش صحيح أو اتستخدم قبل كده.');

    const cookie = await openSessionCookie(used.profileId, c.req.header('cf-connecting-ip') ?? null,
      c.req.header('user-agent') ?? null);
    c.header('set-cookie', cookie);
    // Straight into enrollment: a recovered account with no passkey is an
    // account the resident still cannot get into tomorrow.
    return c.json({ ok: true, name: used.fullName, remaining: used.remaining, next: '/activate' });
  });

  app.get('/activate', async c => {
    const ctx = need(c);
    const name = await data.getDisplayName(ctx, deps.db);
    return html(v.activatePage(name, []));
  });

  app.get('/activate/done', c => {
    need(c);
    return html(v.messagePage(_t.activate.done, _t.activate.secondDevice));
  });

  app.get('/', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);

    const totals = await data.getCommunityTotals(ctx, deps.db) as Record<string, number> | null;
    const unitId = ctx.ownedUnitIds[0] ?? ctx.delegatedUnits[0]?.unitId;
    const stmt = unitId
      ? await data.getUnitStatement(ctx, deps.db, unitId, deps.now).catch(() => null) as Record<string, string | number> | null
      : null;
    const pinned = await data.getPinnedPost(ctx, deps.db);

    return html(v.homePage({
      name: c.req.query('name') ?? (await data.getDisplayName(ctx, deps.db)),
      building: String(stmt?.['building_code'] ?? '—'),
      unit: String(stmt?.['unit_number'] ?? '—'),
      duePiastres: Number(stmt?.['due_piastres'] ?? 0),
      paidPiastres: Number(stmt?.['paid_piastres'] ?? 0),
      outstandingPiastres: Number(stmt?.['outstanding_piastres'] ?? 0),
      depositHeldPiastres: Number(stmt?.['deposit_paid_piastres'] ?? 0),
      periodCount: await data.countPublishedPeriods(ctx, deps.db),
      spendablePiastres: Number(totals?.['spendable_piastres'] ?? 0),
      heldInTrustPiastres: Number(totals?.['held_in_trust_piastres'] ?? 0),
      pinned: pinned ? { title: pinned.title_ar, body: pinned.body_ar } : null,
      unread: await data.unreadCount(ctx, deps.db),
      demo: deps.demo,
      adminLinks: boardLinks(ctx),
    }));
  });

  app.get('/finance', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);
    const totals = await data.getCommunityTotals(ctx, deps.db) as Record<string, number | string> | null;
    const cats = await data.getExpenseByCategory(ctx, deps.db) as Array<Record<string, string | number>>;
    const units = await data.getUnitBalances(ctx, deps.db);
    const buildings = units.allowed
      ? await data.getBuildingTotals(ctx, deps.db) as Array<Record<string, number | string>>
      : [];
    const pendingCount = await data.countPending(ctx, deps.db);
    const fh = await data.getFundHealth(ctx, deps.db);
    const unposted = await expenses.unpostedExpenses(ctx, deps.db);

    return html(v.financePage({
      spendablePiastres: Number(totals?.['spendable_piastres'] ?? 0),
      heldInTrustPiastres: Number(totals?.['held_in_trust_piastres'] ?? 0),
      pendingPiastres: Number(totals?.['pending_not_counted_piastres'] ?? 0),
      pendingCount,
      arrearsPiastres: Number(totals?.['receivables_piastres'] ?? 0),
      totalIncomePiastres: Number(totals?.['total_income_piastres'] ?? 0),
      totalExpensePiastres: Number(totals?.['total_expense_piastres'] ?? 0),
      // R-054: this was bound to `total_reserves_piastres` — every fund account,
      // reserves included — while the caption said "رصيد أول المدة".
      openingPiastres: Number(totals?.['opening_balance_piastres'] ?? 0),
      reservesPiastres: Number(totals?.['reserves_piastres'] ?? 0),
      owedToSuppliersPiastres: Number(totals?.['owed_to_suppliers_piastres'] ?? 0),
      lastReconciledOn: (totals?.['last_reconciled_on'] as string) ?? null,
      depositShortfall: fh.depositShortfall,
      unpostedCount: unposted.count,
      unpostedPiastres: unposted.totalPiastres,
      categories: cats.map(x => ({ nameAr: String(x['name_ar']), totalPiastres: Number(x['total_piastres']) })),
      buildings: buildings.map(b => ({
        code: String(b['code']), paid: Number(b['paid']), n: Number(b['n']),
        billed: Number(b['billed']), collected: Number(b['collected']),
        deposits: Number(b['deposits']), outstanding: Number(b['outstanding']),
      })),
      unitsLocked: !units.allowed,
      demo: deps.demo,
    }));
  });

  /* Per-unit collection status. Gated on the general assembly's written
   * approval (Q11 / R-002) inside `getUnitBalances` — the route does not test
   * the setting itself, because a rule that lives in two places is a rule that
   * will eventually disagree with itself. */
  app.get('/finance/units', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);
    const units = await data.getUnitBalances(ctx, deps.db);
    return html(v.unitsPage({
      allowed: units.allowed,
      reasonAr: units.allowed ? undefined : units.reasonAr,
      rows: units.rows as unknown as v.UnitRow[],
      demo: deps.demo,
    }));
  });

  /* ---- /admin/expenses — money out, from a phone (CP-5, 04_UX_SPEC §82) ---
   *
   * Every action is a plain form POST. No JavaScript anywhere on this screen,
   * because the volunteer using it is standing next to a plumber who wants to
   * leave, on a stairwell with one bar of signal.
   *
   * Each route does the same three things as every other route here: resolve
   * identity, hand it to `lib/db/`, map the refusal to a message. Maker–checker,
   * the spendable-fund rule and the threshold are all enforced underneath; a
   * failure surfaces as the Arabic reason the database or `lib/db/` produced,
   * re-rendered on the same page rather than as a bare error. */
  const expenseScreen = async (
    c: { get(k: 'ctx'): AuthContext | null }, flash?: string, error?: string,
  ) => {
    const ctx = need(c);
    const [queue, posted, cats, funds] = await Promise.all([
      expenses.listExpenseQueue(ctx, deps.db) as Promise<Array<Record<string, unknown>>>,
      expenses.listPostedExpenses(ctx, deps.db, 50) as Promise<Array<Record<string, unknown>>>,
      data.getCategoryNames(ctx, deps.db),
      expenses.spendableFunds(ctx, deps.db) as Promise<Array<Record<string, unknown>>>,
    ]);
    const expenseCats = await expenses.expenseCategories(ctx, deps.db) as
      Array<Record<string, unknown>>;
    void cats;
    return html(v.expensesPage({
      categories: expenseCats.map(x => ({ id: String(x['id']), nameAr: String(x['name_ar']) })),
      funds: funds.map(f => ({ id: String(f['id']), nameAr: String(f['name_ar']) })),
      canApprove: can(ctx.role, 'expense.countersign'),
      today: deps.now().slice(0, 10),
      queue: queue.map(e => ({
        id: String(e['id']), voucherNo: String(e['voucher_no']),
        amountPiastres: Number(e['amount_piastres']), spentOn: String(e['spent_on']),
        descriptionAr: String(e['description_ar']),
        vendorName: (e['vendor_name'] as string) ?? null,
        categoryAr: String(e['category_ar']), status: String(e['status']),
        needsCountersign: Number(e['needs_countersign']) === 1,
        recordedByMe: String(e['recorded_by']) === ctx.personId,
        approved: e['approved_by'] != null,
        isReversal: Number(e['is_reversal'] ?? 0) === 1,
      })),
      posted: posted.map(e => ({
        id: String(e['id']),
        voucherNo: String(e['voucher_no']), amountPiastres: Number(e['amount_piastres']),
        spentOn: String(e['spent_on']), descriptionAr: String(e['description_ar']),
        vendorName: (e['vendor_name'] as string) ?? null,
        categoryAr: String(e['category_ar']),
        reversed: String(e['status']) === 'reversed',
        isReversal: Number(e['is_reversal'] ?? 0) === 1,
        invoiceKey: (e['invoice_storage_key'] as string) ?? null,
      })),
      flash, error, demo: deps.demo,
    }));
  };

  app.get('/admin/expenses', async c => {
    if (!c.get('ctx')) return c.redirect('/login', 302);
    return expenseScreen(c);
  });

  app.post('/admin/expenses', async c => {
    const ctx = need(c);
    const form = await c.req.parseBody();
    const s_ = (k: string) => {
      const v2 = form[k];
      return typeof v2 === 'string' && v2.trim() !== '' ? v2.trim() : null;
    };
    // `parseMoney` REFUSES an ambiguous amount rather than guessing (C4). The
    // refusal is re-rendered on the form, with the money still typed in.
    const amount = parseMoneyRaw(s_('amount') ?? '');
    if (!amount.ok) {
      return expenseScreen(c, undefined, PARSE_MESSAGES_AR[amount.error]);
    }
    const period = await expenses.openPeriod(ctx, deps.db);
    try {
      await mutations.recordExpense(ctx, deps.db, {
        id: data.newId('EXP'),
        voucherNo: await expenses.nextExpenseVoucher(ctx, deps.db, period),
        categoryId: s_('category'), amountPiastres: amount.value,
        spentOn: s_('spentOn') ?? deps.now().slice(0, 10),
        descriptionAr: s_('description'), vendorName: s_('vendor'),
        invoiceStorageKey: null, fundId: s_('fund'),
      } as never);
    } catch (err) {
      /* Only `LedgerRefused` is re-rendered in context. `Forbidden` is
       * deliberately allowed to propagate to the 403 handler: "this expense
       * cannot be posted yet" is a business rule the admin should read on the
       * page they are on, but "you do not hold this capability" is not a state
       * of the expense — it is a state of the caller, and answering it with a
       * friendly 200 would let an operator probe the ledger by typing URLs and
       * reading which ones came back nicely. */
      if (err instanceof LedgerRefused) return expenseScreen(c, undefined, err.reasonAr);
      throw err;
    }
    return expenseScreen(c, _t.expenses.savedOk);
  });

  /* The invoice photo — a SECOND, optional step. Kept off the entry form so the
   * form stays five fields with no JavaScript; an image needs JS to compress. */
  app.get('/admin/expenses/:id/invoice', async c => {
    const ctx = need(c);
    const e = await expenses.getExpense(ctx, deps.db, c.req.param('id') as never) as
      Record<string, unknown>;
    return html(v.expenseInvoicePage({
      expenseId: String(e['id']), voucherNo: String(e['voucher_no']),
      amountPiastres: Number(e['amount_piastres']),
      descriptionAr: String(e['description_ar']), demo: deps.demo,
    }));
  });

  app.post('/admin/expenses/:id/invoice', async c => {
    const ctx = need(c);
    const expenseId = c.req.param('id');
    const form = await c.req.parseBody();
    const b64 = String(form['imageBase64'] ?? '');
    if (!b64) return expenseScreen(c, undefined, _t.pay.errors.image);
    if (!deps.storagePut) throw new StorageFull('رفع الصور مش مفعّل على السيرفر ده');

    const bytes = new Uint8Array(Buffer.from(b64, 'base64url'));
    if (bytes.byteLength === 0) return expenseScreen(c, undefined, _t.pay.errors.image);
    if (bytes.byteLength > 2 * 1024 * 1024) return expenseScreen(c, undefined, _t.pay.errors.tooBig);
    const cap = await data.getStorageCap(ctx, deps.db);
    if (deps.storageUsedBytes) {
      await assertRoomFor({ usedBytes: deps.storageUsedBytes } as never, bytes.byteLength, cap);
    }

    // The key is namespaced under the expense id, and `trg_expense_invoice_key_shape`
    // refuses a key that does not match its row — so `authorizeInvoiceRead` can
    // resolve by lookup instead of parsing a path.
    // Same server-side strip as the receipt path. A supplier invoice photo
    // carries the location it was taken in just as readily as a receipt does.
    let clean;
    try {
      clean = stripImageMetadata(bytes);
    } catch (err) {
      if (err instanceof UnsupportedImage) return expenseScreen(c, undefined, err.reasonAr);
      throw err;
    }
    const key = `invoices/${expenseId}/${data.newId('INV')}.${clean.mime.slice(6)}`;
    await deps.storagePut({ key, body: clean.bytes, mime: clean.mime, unitId: null });
    await data.registerStorageObject(ctx, deps.db, {
      storageKey: key, bucket: 'invoices', ownerKind: 'expense_invoice',
      ownerId: expenseId, unitId: null, sizeBytes: clean.bytes.byteLength,
      sha256: await sha256Bytes(clean.bytes), mime: clean.mime, exifStripped: true,
    });
    try {
      await expenses.attachInvoice(ctx, deps.db, expenseId as never, key, deps.now);
    } catch (err) {
      if (err instanceof LedgerRefused) return expenseScreen(c, undefined, err.reasonAr);
      throw err;
    }
    return expenseScreen(c, _t.expenses.invoiceDone);
  });

  app.get('/admin/expenses/:id/invoice/remove', async c => {
    const ctx = need(c);
    const e = await expenses.getExpense(ctx, deps.db, c.req.param('id') as never) as
      Record<string, unknown>;
    return html(v.removeInvoicePage({
      expenseId: String(e['id']), voucherNo: String(e['voucher_no']),
      descriptionAr: String(e['description_ar']), demo: deps.demo,
    }));
  });

  app.post('/admin/expenses/:id/invoice/remove', async c => {
    const ctx = need(c);
    const form = await c.req.parseBody();
    try {
      await expenses.removeInvoice(ctx, deps.db, c.req.param('id') as never,
        String(form['reason'] ?? ''), deps.now);
    } catch (err) {
      if (err instanceof LedgerRefused) {
        const e = await expenses.getExpense(ctx, deps.db, c.req.param('id') as never) as
          Record<string, unknown>;
        return html(v.removeInvoicePage({
          expenseId: String(e['id']), voucherNo: String(e['voucher_no']),
          descriptionAr: String(e['description_ar']), error: err.reasonAr, demo: deps.demo,
        }));
      }
      throw err;
    }
    return expenseScreen(c, _t.expenses.removeInvoiceOk);
  });

  /* The ONLY route that serves an invoice image. Visibility is decided in
   * `lib/db/`, per the setting the board controls (ADR-026). */
  app.get('/api/invoices/*', async c => {
    const ctx = need(c);
    const key = c.req.path.replace('/api/invoices/', '');
    const meta = await expenses.authorizeInvoiceRead(ctx, deps.db, key);
    const obj = await deps.storage.get(meta.storageKey);
    if (!obj) throw new NotFound('الصورة مش موجودة');
    return c.body(obj.body as unknown as ArrayBuffer, 200, {
      'content-type': obj.mime, 'cache-control': 'private, no-store',
    });
  });

  app.post('/admin/expenses/:id/countersign', async c => {
    const ctx = need(c);
    try {
      await mutations.countersignExpense(ctx, deps.db, c.req.param('id') as never, deps.now);
    } catch (err) {
      /* Only `LedgerRefused` is re-rendered in context. `Forbidden` is
       * deliberately allowed to propagate to the 403 handler: "this expense
       * cannot be posted yet" is a business rule the admin should read on the
       * page they are on, but "you do not hold this capability" is not a state
       * of the expense — it is a state of the caller, and answering it with a
       * friendly 200 would let an operator probe the ledger by typing URLs and
       * reading which ones came back nicely. */
      if (err instanceof LedgerRefused) return expenseScreen(c, undefined, err.reasonAr);
      throw err;
    }
    return expenseScreen(c, _t.expenses.postedOk);
  });

  app.post('/admin/expenses/:id/post', async c => {
    const ctx = need(c);
    const period = await expenses.openPeriod(ctx, deps.db);
    try {
      await expenses.postExpense(ctx, deps.db, {
        expenseId: c.req.param('id') as never,
        creditAccountId: await expenses.defaultCashAccount(ctx, deps.db),
        periodId: period,
      }, deps.now);
    } catch (err) {
      /* Only `LedgerRefused` is re-rendered in context. `Forbidden` is
       * deliberately allowed to propagate to the 403 handler: "this expense
       * cannot be posted yet" is a business rule the admin should read on the
       * page they are on, but "you do not hold this capability" is not a state
       * of the expense — it is a state of the caller, and answering it with a
       * friendly 200 would let an operator probe the ledger by typing URLs and
       * reading which ones came back nicely. */
      if (err instanceof LedgerRefused) return expenseScreen(c, undefined, err.reasonAr);
      throw err;
    }
    return expenseScreen(c, _t.expenses.postedOk);
  });

  app.get('/admin/expenses/:id/reverse', async c => {
    const ctx = need(c);
    const e = await expenses.getExpense(ctx, deps.db, c.req.param('id') as never) as
      Record<string, unknown>;
    return html(v.reverseExpensePage({
      expenseId: String(e['id']), voucherNo: String(e['voucher_no']),
      amountPiastres: Number(e['amount_piastres']),
      descriptionAr: String(e['description_ar']), demo: deps.demo,
    }));
  });

  app.post('/admin/expenses/:id/reverse', async c => {
    const ctx = need(c);
    const form = await c.req.parseBody();
    try {
      await expenses.requestExpenseReversal(ctx, deps.db, {
        expenseId: c.req.param('id') as never,
        reasonAr: String(form['reason'] ?? ''),
      }, deps.now);
    } catch (err) {
      if (err instanceof LedgerRefused) {
        const e = await expenses.getExpense(ctx, deps.db, c.req.param('id') as never) as
          Record<string, unknown>;
        return html(v.reverseExpensePage({
          expenseId: String(e['id']), voucherNo: String(e['voucher_no']),
          amountPiastres: Number(e['amount_piastres']),
          descriptionAr: String(e['description_ar']),
          error: err.reasonAr, demo: deps.demo,
        }));
      }
      throw err;
    }
    return expenseScreen(c, _t.expenses.reversedOk);
  });

  /* ---- payment reversal, behind a screen (R-061…R-063) -------------------
   *
   * The engine, the two-admin control and the resident notification all existed
   * a session before this screen did, reachable only from a test — which meant
   * the board could not correct a wrongly-approved receipt at all. A control
   * nobody can reach is a control that does not exist. */
  const approvedList = async (c: { get(k: 'ctx'): AuthContext | null }, flash?: string) => {
    const ctx = need(c);
    const items = await data.listApprovedPayments(ctx, deps.db) as
      Array<Record<string, unknown>>;
    return html(v.approvedPaymentsPage({
      items: items.map(p => ({
        id: String(p['id']), receiptNo: String(p['receipt_no']),
        amountPiastres: Number(p['approved_amount_piastres'] ?? 0),
        transferDate: String(p['transfer_date']),
        categoryAr: String(p['category_ar']),
        buildingCode: String(p['building_code']), unitNumber: String(p['unit_number']),
        reversed: String(p['status']) === 'reversed',
        reasonAr: (p['review_reason_ar'] as string) ?? null,
        approvedByMe: String(p['reviewed_by']) === ctx.personId,
      })),
      flash, demo: deps.demo,
    }));
  };

  app.get('/admin/payments', async c => {
    if (!c.get('ctx')) return c.redirect('/login', 302);
    return approvedList(c);
  });

  const reverseForm = async (
    c: { get(k: 'ctx'): AuthContext | null; req: { param(k: string): string } },
    error?: string,
  ) => {
    const ctx = need(c as never);
    const p = await data.getPayment(ctx, deps.db, c.req.param('id') as never, deps.now) as
      unknown as Record<string, unknown>;
    const admins = await data.reversalApprovers(ctx, deps.db) as Array<Record<string, unknown>>;
    return html(v.reversePaymentPage({
      paymentId: String(p['id']), receiptNo: String(p['receipt_no']),
      amountPiastres: Number(p['approved_amount_piastres'] ?? p['claimed_amount_piastres'] ?? 0),
      buildingCode: String(p['building_code'] ?? '—'),
      unitNumber: String(p['unit_number'] ?? '—'),
      admins: admins.map(a => ({ id: String(a['id']), nameAr: String(a['full_name']) })),
      error, demo: deps.demo,
    }));
  };

  app.get('/admin/payments/:id/reverse', async c => {
    if (!c.get('ctx')) return c.redirect('/login', 302);
    return reverseForm(c as never);
  });

  app.post('/admin/payments/:id/reverse', async c => {
    const ctx = need(c);
    const form = await c.req.parseBody();
    try {
      await data.reversePayment(ctx, deps.db, c.req.param('id') as never,
        String(form['reason'] ?? ''), String(form['second'] ?? '') as never, deps.now);
      const p = await data.getPayment(ctx, deps.db, c.req.param('id') as never, deps.now);
      await pushLatest(p.submitted_by);
    } catch (err) {
      // Same split as the expense routes: a business-rule refusal is re-rendered
      // in context; `Forbidden` describes the caller and goes to the 403 handler.
      if (err instanceof LedgerRefused) return reverseForm(c as never, err.reasonAr);
      throw err;
    }
    return approvedList(c, _t.admin.reversedOk);
  });

  /* ---- /notifications — the resident's inbox -----------------------------
   *
   * Opening the page marks everything read. There is deliberately no "mark as
   * read" control: on a five-year-old Android held by someone who does not
   * enjoy phones, a button that exists only to manage the interface is a tax.
   *
   * The read-marking happens BEFORE the list is fetched in wall-clock terms but
   * the list is captured first, so the resident still sees which messages were
   * new on this visit — mark-then-render would show them nothing highlighted,
   * which is the same as not telling them. */
  app.get('/notifications', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);
    const items = await data.listMyNotifications(ctx, deps.db) as
      Array<Record<string, unknown>>;
    await data.markNotificationsRead(ctx, deps.db, deps.now);
    return html(v.inboxPage({
      items: items.map(n => ({
        kind: String(n['kind']), titleAr: String(n['title_ar']),
        bodyAr: String(n['body_ar']),
        linkPath: (n['link_path'] as string) ?? null,
        unread: n['read_at'] == null,
        createdAt: String(n['created_at']),
      })),
      vapidPublicKey: deps.vapid?.publicKey ?? null,
      pushOn: await push.hasSubscription(ctx, deps.db),
      demo: deps.demo,
    }));
  });

  /* ---- push, after the fact and never before -----------------------------
   *
   * The message is already in `notifications`, written in the same batch as the
   * decision (R-065). This only makes the phone buzz. It is called AFTER the
   * transaction commits and its result is ignored: a phone that is off, or a
   * push service having a bad afternoon, must never make an admin's approval
   * fail. **Push is a courtesy on top of the inbox, never the record.** */
  const pushLatest = async (profileId: string) => {
    if (!deps.vapid) return;
    try {
      // Quiet hours suppress the BUZZ and nothing else. The notification row is
      // already written and already readable at /notifications; this only
      // decides whether an 80-year-old's phone lights up at one in the morning.
      // The setting has existed since CP-1, appeared on the settings screen,
      // and was read by nothing — a switch the board turns on that changes no
      // behaviour is worse than no switch, because they believe it worked.
      const q = await push.quietWindow(deps.db);
      if (push.inQuietHours(deps.now(), q.from, q.to)) return;

      const [msg] = await data.latestNotificationFor(deps.db, profileId as never) as
        Array<Record<string, unknown>>;
      if (!msg) return;
      await deliverPush(deps.db, profileId as never,
        { title: String(msg['title_ar']), body: String(msg['body_ar']),
          url: (msg['link_path'] as string) ?? '/notifications' },
        deps.vapid, deps.now, deps.fetchImpl ?? fetch);
    } catch { /* see above: delivery never breaks the decision */ }
  };

  /* ---- push subscribe / unsubscribe (Q23) -------------------------------- */
  app.post('/api/push/subscribe', async c => {
    const ctx = need(c);
    const b = await c.req.json<{ endpoint: string; p256dh: string; auth: string; label?: string }>();
    await push.saveSubscription(ctx, deps.db, {
      endpoint: b.endpoint, p256dh: b.p256dh, auth: b.auth,
      deviceLabelAr: b.label ?? null,
    }, deps.now);
    return c.json({ ok: true });
  });

  app.post('/api/push/unsubscribe', async c => {
    const ctx = need(c);
    const b = await c.req.json<{ endpoint: string }>();
    await push.deleteSubscription(ctx, deps.db, b.endpoint);
    return c.json({ ok: true });
  });

  /* The service worker. Served from the ROOT path deliberately: a worker's
   * scope is its own directory, so `/static/sw.js` could only receive pushes
   * for `/static/*`. This is the one file that must live at `/`. */
  app.get('/sw.js', () => new Response(SERVICE_WORKER, {
    headers: { 'content-type': 'application/javascript; charset=utf-8',
               'cache-control': 'no-cache' },
  }));

  /* The free-tier dashboard. `system.read_quota` is checked in `lib/db/`. */
  app.get('/admin/health', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);
    const q = await data.getQuotaUsage(ctx, deps.db);
    const [reach, vapid] = await Promise.all([
      push.pushReach(ctx, deps.db),
      push.vapidStatus(ctx, deps.db, deps.vapid?.publicKey),
    ]);
    return html(v.healthPage({
      ...q,
      evidence: await expenses.expensesWithoutEvidence(ctx, deps.db),
      push: {
        configured: vapid.configured, residents: reach.residents,
        reachable: reach.reachable, dead: reach.dead,
        fingerprint: vapid.current, recorded: vapid.recorded, mismatch: vapid.mismatch,
      },
      demo: deps.demo,
    }));
  });

  app.get('/api/health/quota', async c =>
    c.json(await data.getQuotaUsage(need(c), deps.db)));

  app.get('/payments', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);
    const rows = await data.listMyPayments(ctx, deps.db, deps.now);
    const cats = new Map((await data.getCategoryNames(ctx, deps.db)).map(x => [x.id, x.name_ar]));
    const total = rows.filter(r => r.status === 'approved')
      .reduce((a, r) => a + (r.approved_amount_piastres ?? 0), 0);
    return html(v.paymentsPage(rows.map(r => ({
      id: r.id, receiptNo: r.receipt_no,
      amountPiastres: r.approved_amount_piastres ?? r.claimed_amount_piastres,
      transferDate: r.transfer_date, categoryAr: cats.get(r.category_id) ?? '',
      status: r.status, reasonAr: r.review_reason_ar,
    })), total, await data.unreadCount(ctx, deps.db)));
  });

  /* ---- the five-step payment wizard ------------------------------------ */
  // Steps 1-3 and 5 are plain form posts and work with NO JavaScript. Only the
  // image at step 4 needs a script. The draft lives server-side, so switching to
  // the bank app to check an amount and coming back loses nothing.

  const catName = async (ctx: AuthContext, id: string | null) => {
    if (!id) return null;
    const all = await data.getCategoryNames(ctx, deps.db);
    return all.find(c => c.id === id)?.name_ar ?? null;
  };

  app.get('/pay/:step?', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);
    const d = await drafts.getDraft(ctx, deps.db);
    // Returning to /pay with no step resumes where they stopped, rather than
    // restarting a form they already half-filled.
    const asked = c.req.param('step');
    const step = Math.min(Math.max(Number(asked ?? d?.step ?? 1), 1), 5) as 1 | 2 | 3 | 4 | 5;
    const settings = await data.getPaymentDetails(ctx, deps.db);
    return html(v.payPage({
      step,
      categories: deps.payCategories ?? [],
      bankDetailsMissing: !settings.instapay && !settings.bank && !settings.vodafone,
      bankDetails: settings,
      draft: {
        amountPiastres: d?.amount_piastres ?? undefined,
        categoryAr: (await catName(ctx, d?.category_id ?? null)) ?? undefined,
        method: d?.method ?? undefined,
        date: d?.transfer_date ?? undefined,
        referenceNo: d?.reference_no ?? undefined,
      },
      gaps: drafts.draftGaps(d ?? null),
    }));
  });

  app.post('/pay/:step', async c => {
    const ctx = need(c);
    const step = Math.min(Math.max(Number(c.req.param('step')), 1), 5);
    const form = await c.req.parseBody();
    const s = (k: string) => {
      const v2 = form[k];
      return typeof v2 === 'string' && v2.trim() !== '' ? v2.trim() : null;
    };

    if (step === 1) {
      const parsed = parseMoney(s('amount') ?? '');
      if (!parsed.ok) {
        return html(v.payPage({ step: 1, error: parsed.messageAr,
          categories: deps.payCategories ?? [] }), 400);
      }
      await drafts.saveDraft(ctx, deps.db, {
        amount_piastres: parsed.value,
        unit_id: drafts.unitForDraft(ctx),
      }, 2, deps.now);
      return c.redirect('/pay/2', 303);
    }
    if (step === 2) {
      await drafts.saveDraft(ctx, deps.db, { category_id: s('category') }, 3, deps.now);
      return c.redirect('/pay/3', 303);
    }
    if (step === 3) {
      await drafts.saveDraft(ctx, deps.db,
        { method: s('method'), transfer_date: s('transfer_date') }, 4, deps.now);
      return c.redirect('/pay/4', 303);
    }
    if (step === 4) {
      await drafts.saveDraft(ctx, deps.db,
        { reference_no: s('reference_no'), note_ar: s('note') }, 5, deps.now);
      return c.redirect('/pay/5', 303);
    }
    // step 5 — the actual submission, handled by the JSON API so the same code
    // path serves both the wizard and any future client.
    return c.redirect('/pay/5', 303);
  });

  /** Submits the accumulated draft plus the image. The wizard posts here. */
  app.post('/api/payments/submit-draft', async c => {
    const ctx = need(c);
    const d = await drafts.getDraft(ctx, deps.db);
    const gaps = drafts.draftGaps(d ?? null);
    if (gaps.length > 0 || !d) {
      throw new LedgerRefused(`ناقص حاجة في خطوة ${gaps[0]?.step ?? 1} — ارجع وكمّلها`);
    }
    const { imageBase64 } = await c.req.json<{ imageBase64: string }>();
    const res = await submitReceipt(ctx, {
      unitId: d.unit_id ?? drafts.unitForDraft(ctx) ?? '',
      categoryId: d.category_id!,
      amountPiastres: d.amount_piastres!,
      method: d.method!,
      transferDate: d.transfer_date!,
      referenceNo: d.reference_no,
      noteAr: d.note_ar,
      imageBase64,
    });
    await drafts.clearDraft(ctx, deps.db);
    return c.json(res, 201);
  });

  app.get('/pay/done/:receiptNo', c => {
    need(c);
    return html(v.paySuccessPage(c.req.param('receiptNo')));
  });

  app.get('/admin/review', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);
    const rows = await data.listReviewQueue(ctx, deps.db) as Array<Record<string, string | number>>;
    const warn = await data.singleAdminWarning(ctx, deps.db);
    return html(v.reviewPage(rows.map(r => ({
      id: String(r['id']), receiptNo: String(r['receipt_no']),
      amountPiastres: Number(r['claimed_amount_piastres']),
      transferDate: String(r['transfer_date']), categoryAr: String(r['category_ar']),
      buildingCode: String(r['building_code']), unitNumber: String(r['unit_number']),
      referenceNo: r['reference_no'] as string | null, noteAr: r['note_ar'] as string | null,
    })), warn, deps.demo));
  });

  /* ---- receipt upload -------------------------------------------------- */

  app.post('/api/payments/upload', async c => {
    const ctx = need(c);
    const b = await c.req.json<Parameters<typeof submitReceipt>[1]>();
    return c.json(await submitReceipt(ctx, b), 201);
  });

  /** One implementation, shared by the JSON API and the wizard — so a fix to the
   *  duplicate check or the storage cap cannot land on only one of them. */
  async function submitReceipt(ctx: AuthContext, b: {
    unitId: string; categoryId: string; amountPiastres: number; method: string;
    transferDate: string; referenceNo?: string | null; noteAr?: string | null;
    imageBase64: string;
  }) {
    if (!deps.storagePut) throw new StorageFull('رفع الصور مش مفعّل على السيرفر ده');
    const bytes = new Uint8Array(Buffer.from(b.imageBase64, 'base64url'));
    if (bytes.byteLength === 0) throw new LedgerRefused(_t.pay.errors.image);
    if (bytes.byteLength > 2 * 1024 * 1024) throw new LedgerRefused(_t.pay.errors.tooBig);

    const cap = await data.getStorageCap(ctx, deps.db);
    if (deps.storageUsedBytes) {
      await assertRoomFor({ usedBytes: deps.storageUsedBytes } as never, bytes.byteLength, cap);
    }

    // ⭐ The metadata is removed HERE, on the server, and `exifStripped` is set
    // from what actually happened. It used to be hardcoded `true` beside a
    // hardcoded `image/webp`, on bytes nothing had looked at: the browser did
    // strip EXIF as a side effect of re-encoding through a canvas, which
    // protects a resident using the site and nothing else. A request that
    // skips the page — curl, JS off, a modified client — stored a photo
    // carrying the GPS coordinates of a flat, with a column beside it saying
    // otherwise. A control a client can decline is a claim.
    //
    // The hash is taken AFTER stripping, so duplicate detection compares the
    // bytes that are actually stored. Hashing before would let the same
    // receipt, re-uploaded from a different phone with different EXIF, count
    // as a new payment.
    const clean = stripImageMetadata(bytes);
    const sha = await sha256Bytes(clean.bytes);
    const dup = await data.findDuplicateReceipt(ctx, deps.db, sha, b.amountPiastres, b.transferDate);

    const id = data.newId('PAY');
    const ext = clean.mime.slice('image/'.length);
    const key = `receipts/${b.unitId}/${id}.${ext}`;
    await deps.storagePut({ key, body: clean.bytes, mime: clean.mime, unitId: b.unitId });
    await data.registerStorageObject(ctx, deps.db, {
      storageKey: key, bucket: 'receipts', ownerKind: 'payment_receipt', ownerId: id,
      unitId: b.unitId, sizeBytes: clean.bytes.byteLength, sha256: sha, mime: clean.mime,
      exifStripped: true,
    });
    await data.createPayment(ctx, deps.db, {
      id: id as never, receiptNo: await data.nextReceiptNo(ctx, deps.db),
      unitId: b.unitId as never, categoryId: b.categoryId as never, feePeriodId: null,
      claimedAmountPiastres: b.amountPiastres, method: b.method,
      transferDate: b.transferDate, referenceNo: b.referenceNo ?? null,
      storageKey: key, imageSha256: sha, noteAr: b.noteAr ?? null,
    }, deps.now);
    const saved = await data.getPayment(ctx, deps.db, id as never, deps.now);
    return { id, receiptNo: saved.receipt_no, duplicateOf: dup?.receipt_no ?? null };
  }

  /* ---- assisted recovery: two admins, never one (R-003/R-023) ---------- */

  app.get('/api/admin/recoveries', async c =>
    c.json(await onboard.listOpenRecoveries(need(c), deps.db)));

  app.post('/api/admin/recoveries', async c => {
    const ctx = need(c);
    const b = await c.req.json<{ targetProfileId: string; identityCheckAr: string }>();
    const id = await onboard.requestRecovery(ctx, deps.db, b.targetProfileId as never, b.identityCheckAr);
    return c.json({ id, nextAr: 'محتاج أدمن تاني يوافق' }, 201);
  });

  app.post('/api/admin/recoveries/:id/approve', async c => {
    await onboard.approveRecovery(need(c), deps.db, c.req.param('id') as never, deps.now);
    return c.json({ ok: true, nextAr: 'اتوافق — تقدر تولّد لينك التفعيل دلوقتي' });
  });

  /** Completes the recovery and returns the activation link for a board member
   *  to send. The link is shown ONCE and never stored in plaintext. */
  app.post('/api/admin/recoveries/:id/fulfil', async c => {
    const ctx = need(c);
    const { targetProfileId, fullName } =
      await onboard.fulfilRecovery(ctx, deps.db, c.req.param('id') as never, deps.now);
    const token = passkey.randomToken();
    await adb.createActivationChallenge(ctx, deps.db, targetProfileId,
      await passkey.sha256(token), 'recovery', deps.now);
    const channel = getChannel('board_link');
    const share = await channel.prepare({
      fullName, token, baseUrl: deps.rp.origin,
    });
    return c.json({ ok: true, ...share });
  });

  /* ---- owner-register import (R-009) ------------------------------------ */

  app.post('/api/admin/import/preview', async c => {
    const ctx = need(c);
    const { filename, text } = await c.req.json<{ filename?: string; text: string }>();
    const parsed = parseOwners(text ?? '');
    const batchId = await onboard.stageImport(ctx, deps.db, filename ?? null, parsed);
    // Nothing is created yet. The admin sees exactly what would happen first.
    return c.json({
      batchId, summaryAr: summaryAr(parsed),
      okCount: parsed.okCount, problemCount: parsed.problemCount,
      unmappedHeaders: parsed.unmappedHeaders,
      rows: parsed.rows,
    });
  });

  app.post('/api/admin/import/:batchId/confirm', async c => {
    const ctx = need(c);
    const out = await onboard.commitImport(ctx, deps.db, c.req.param('batchId') as never, deps.now);
    return c.json(out);
  });

  app.get('/api/admin/import/:batchId', async c =>
    c.json(await onboard.getImportPreview(need(c), deps.db, c.req.param('batchId') as never)));

  /* ===================================================================== */
  /* CP-6 — content & memory                                               */
  /*                                                                        */
  /* Reading the archive needs a session and nothing more: the archive is    */
  /* the village's shared memory and gating it by role would recreate the    */
  /* problem it exists to solve. Writing into it is capability-checked in    */
  /* lib/db/content.ts, not here — one guard, at the data layer, per ADR-010.*/
  /* ===================================================================== */

  app.get('/news', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);
    const type = c.req.query('type') as content.PostType | undefined;
    const posts = await content.listPosts(ctx, deps.db, { type: type || undefined, limit: 40 });
    return html(cv.newsPage({
      posts, activeType: type ?? '', canPublish: can(ctx.role, 'post.publish'),
    }));
  });

  app.get('/news/archive', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);
    return html(cv.archivePage({ months: await content.archiveIndex(ctx, deps.db) }));
  });

  app.get('/news/archive/:year/:month', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);
    const year = c.req.param('year');
    const month = c.req.param('month');
    const items = await content.archiveMonth(ctx, deps.db, year, month);
    return html(cv.archiveMonthPage({ year, month, items }));
  });

  app.get('/news/:slug', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);
    const post = await content.getPostBySlug(ctx, deps.db, c.req.param('slug'));
    if (!post) return html(v.messagePage(_t.states.notFound, _t.content.retracted), 404);
    return html(cv.postPage({ post, canPublish: can(ctx.role, 'post.publish') }));
  });

  app.get('/search', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);
    const q = c.req.query('q') ?? '';
    return html(cv.searchPage({ query: q, hits: await content.search(ctx, deps.db, q) }));
  });

  app.get('/albums', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);
    return html(cv.albumsPage({
      albums: await content.listAlbums(ctx, deps.db),
      canCreate: can(ctx.role, 'album.create'),
    }));
  });

  app.get('/albums/:id', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);
    const album = await content.getAlbum(ctx, deps.db, c.req.param('id') as never);
    if (!album) return html(v.messagePage(_t.states.notFound, _t.states.errorBody), 404);
    return html(cv.albumPage({ album }));
  });

  /* ---- maintenance tickets ---------------------------------------------- */

  async function ticketScreen(ctx: AuthContext, error?: string) {
    return cv.maintenancePage({
      tickets: await content.listTickets(ctx, deps.db, {}),
      isStaff: can(ctx.role, 'expense.record'),
      units: await content.listMyUnits(ctx, deps.db),
      error,
    });
  }

  app.get('/maintenance', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);
    return html(await ticketScreen(ctx));
  });

  app.post('/maintenance', async c => {
    const ctx = need(c);
    const f = await c.req.parseBody();
    try {
      await content.createTicket(ctx, deps.db, {
        titleAr: String(f['title'] ?? ''),
        descriptionAr: String(f['details'] ?? ''),
        unitId: (String(f['unitId'] ?? '') || undefined) as never,
      }, deps.now);
    } catch (e) {
      if (e instanceof Forbidden) return html(await ticketScreen(ctx, e.reasonAr), 400);
      throw e;
    }
    return c.redirect('/maintenance', 303);
  });

  app.post('/maintenance/:id/status', async c => {
    const ctx = need(c);
    const f = await c.req.parseBody();
    try {
      await content.updateTicketStatus(
        ctx, deps.db, c.req.param('id') as never,
        String(f['next'] ?? '') as content.TicketStatus,
        String(f['resolution'] ?? ''), deps.now,
      );
    } catch (e) {
      if (e instanceof Forbidden) return html(await ticketScreen(ctx, e.reasonAr), 403);
      throw e;
    }
    return c.redirect('/maintenance', 303);
  });

  /* ---- admin: publishing ------------------------------------------------- */

  async function adminContentScreen(ctx: AuthContext, error?: string) {
    return cv.adminContentPage({
      drafts: [],
      published: await content.listPosts(ctx, deps.db, { limit: 30 }),
      albums: await content.listAlbums(ctx, deps.db),
      canPublishMinutes: can(ctx.role, 'minutes.publish'),
      error,
    });
  }

  app.get('/admin/content', async c => {
    const ctx = need(c);
    if (!can(ctx.role, 'post.publish')) throw new Forbidden('post.publish');
    return html(await adminContentScreen(ctx));
  });

  app.post('/admin/content', async c => {
    const ctx = need(c);
    const f = await c.req.parseBody();
    try {
      await content.createPost(ctx, deps.db, {
        type: String(f['type'] ?? 'announcement') as content.PostType,
        titleAr: String(f['title'] ?? ''),
        bodyAr: String(f['body'] ?? ''),
        isPinned: f['pin'] === '1',
      }, deps.now);
    } catch (e) {
      if (e instanceof Forbidden) return html(await adminContentScreen(ctx, e.reasonAr), 403);
      throw e;
    }
    return c.redirect('/admin/content', 303);
  });

  app.post('/admin/content/:id/pin', async c => {
    const ctx = need(c);
    const f = await c.req.parseBody();
    await content.setPinned(
      ctx, deps.db, c.req.param('id') as never, String(f['pinned']) === '1', deps.now,
    );
    return c.redirect('/admin/content', 303);
  });

  /* ---- members & first activation --------------------------------------- */

  /**
   * The door the board walks through to onboard the village.
   *
   * Before this screen the only way to hand somebody an activation link was
   * `/api/admin/recoveries/*` — three JSON calls, two admins and an identity
   * check, with no user interface at all. That is the correct weight for "my
   * phone was stolen and my account has a year of payments in it"; it is the
   * wrong weight, by a wide margin, for the first day, when 204 people have
   * never logged in and hold nothing worth stealing. Because it was the only
   * path, onboarding was in practice impossible from the product itself.
   *
   * The two acts are now separate doors, and `issueFirstActivation` keeps them
   * separate at the data layer: the moment a person owns a passkey it refuses,
   * and says to use recovery. So an admin who wants to mint a credential onto
   * a resident's live account still needs the second signature — this screen
   * cannot be used to skip it.
   *
   * The link is rendered exactly once. Only its SHA-256 is stored, so there is
   * no second read to offer, and re-issuing simply mints a new challenge.
   */
  const membersScreen = async (
    ctx: AuthContext,
    q: string,
    issued?: { name: string; url: string; expiresAt: string },
    error?: string,
  ) => cv.membersPage({
    members: await onboard.listMembers(ctx, deps.db, q),
    q,
    issued,
    error,
  });

  app.get('/admin/members', async c => {
    const ctx = need(c);
    if (!can(ctx.role, 'user.create')) throw new Forbidden('user.create');
    return html(await membersScreen(ctx, c.req.query('q') ?? ''));
  });

  app.post('/admin/members/:id/activate', async c => {
    const ctx = need(c);
    if (!can(ctx.role, 'user.create')) throw new Forbidden('user.create');
    try {
      const { token, fullName, expiresAt } = await onboard.issueFirstActivation(
        ctx, deps.db, c.req.param('id') as never,
        passkey.sha256, passkey.randomToken, deps.now,
      );
      // `t`, not `token` — /login/activate reads `c.req.query('t')`, and a link
      // built with the wrong parameter name looks valid and silently expires.
      return html(await membersScreen(ctx, '', {
        name: fullName,
        url: `${deps.rp.origin}/login/activate?t=${token}`,
        expiresAt,
      }));
    } catch (e) {
      if (e instanceof Forbidden) return html(await membersScreen(ctx, '', undefined, e.reasonAr), 403);
      throw e;
    }
  });

  /* ---- fees: opening the year (CP-5) ------------------------------------ */

  /**
   * The subscription the whole product bills against.
   *
   * `fee_periods` and `unit_dues` drive «المطلوب منك» on the home screen, the
   * arrears figure, the statement and `v_unit_balance` — and until now they
   * could only be populated by the demo seed. The portal could display a year
   * it had been handed and could not begin one, so it could be demonstrated and
   * not operated.
   *
   * Three steps, deliberately not one button: draft → distribute → publish.
   * The middle step's output is what the board has to look at, because the
   * failure this flow is arranged around is publishing a subscription that
   * billed 180 of 204 flats and looked like a success. `missing_units` is on
   * the screen for exactly that reason, and stays there until it is zero or
   * explained.
   */
  const feesScreen = async (ctx: AuthContext, flash?: string, error?: string) => {
    const opts = await fees.feeFormOptions(ctx, deps.db);
    return av.feesPage({
      periods: await fees.listFeePeriods(ctx, deps.db),
      categories: opts.categories, years: opts.years, flash, error,
    });
  };

  app.get('/admin/fees', async c => {
    const ctx = need(c);
    if (!can(ctx.role, 'fee.manage')) throw new Forbidden('fee.manage');
    return html(await feesScreen(ctx));
  });

  app.post('/admin/fees', async c => {
    const ctx = need(c);
    if (!can(ctx.role, 'fee.manage')) throw new Forbidden('fee.manage');
    const f = await c.req.parseBody();
    const amount = parseMoney(String(f['amount'] ?? ''));
    if (!amount.ok) return html(await feesScreen(ctx, undefined, amount.messageAr), 400);
    try {
      await fees.createFeePeriod(ctx, deps.db, {
        nameAr: String(f['name'] ?? ''),
        categoryId: String(f['category'] ?? '') as never,
        fiscalPeriodId: String(f['year'] ?? '') as never,
        startsOn: String(f['starts_on'] ?? ''),
        endsOn: String(f['ends_on'] ?? ''),
        dueOn: String(f['due_on'] ?? ''),
        basis: String(f['basis'] ?? 'per_unit') === 'per_sqm' ? 'per_sqm' : 'per_unit',
        amountPiastres: amount.value,
      }, deps.now);
    } catch (e) {
      if (e instanceof LedgerRefused) return html(await feesScreen(ctx, undefined, e.reasonAr), 409);
      throw e;
    }
    return c.redirect('/admin/fees', 303);
  });

  app.post('/admin/fees/:id/generate', async c => {
    const ctx = need(c);
    if (!can(ctx.role, 'fee.manage')) throw new Forbidden('fee.manage');
    try {
      const out = await fees.generateDues(ctx, deps.db, c.req.param('id') as never, deps.now);
      return html(await feesScreen(ctx, _layout.msg(_t.fees.generated, {
        n: out.billed, total: _layout.money(out.totalPiastres),
      })));
    } catch (e) {
      if (e instanceof LedgerRefused) return html(await feesScreen(ctx, undefined, e.reasonAr), 409);
      throw e;
    }
  });

  app.post('/admin/fees/:id/publish', async c => {
    const ctx = need(c);
    if (!can(ctx.role, 'fee.manage')) throw new Forbidden('fee.manage');
    try {
      await fees.publishFeePeriod(ctx, deps.db, c.req.param('id') as never, deps.now);
      return html(await feesScreen(ctx, _t.fees.publishedOk));
    } catch (e) {
      if (e instanceof LedgerRefused) return html(await feesScreen(ctx, undefined, e.reasonAr), 409);
      throw e;
    }
  });

  const duesScreen = async (ctx: AuthContext, id: string, flash?: string, error?: string) => {
    const periods = await fees.listFeePeriods(ctx, deps.db);
    const period = periods.find(p => p.id === id);
    if (!period) throw new data.NotFound('الاشتراك ده مش موجود');
    return av.feeDuesPage({
      period, dues: await fees.listDues(ctx, deps.db, id as never), flash, error,
    });
  };

  app.get('/admin/fees/:id', async c => {
    const ctx = need(c);
    if (!can(ctx.role, 'fee.manage')) throw new Forbidden('fee.manage');
    return html(await duesScreen(ctx, c.req.param('id')));
  });

  app.post('/admin/fees/:id/dues/:dueId/waive', async c => {
    const ctx = need(c);
    if (!can(ctx.role, 'fee.manage')) throw new Forbidden('fee.manage');
    const id = c.req.param('id');
    const f = await c.req.parseBody();
    const amount = parseMoney(String(f['amount'] ?? ''));
    if (!amount.ok) return html(await duesScreen(ctx, id, undefined, amount.messageAr), 400);
    try {
      await fees.waiveDue(ctx, deps.db, c.req.param('dueId') as never,
        amount.value, String(f['reason'] ?? ''), deps.now);
    } catch (e) {
      if (e instanceof LedgerRefused) return html(await duesScreen(ctx, id, undefined, e.reasonAr), 409);
      throw e;
    }
    return c.redirect(`/admin/fees/${id}`, 303);
  });

  /* ---- categories -------------------------------------------------------- */

  const categoriesScreen = async (ctx: AuthContext, flash?: string, error?: string) =>
    av.categoriesPage({
      categories: await adm.listCategories(ctx, deps.db),
      accounts: await adm.accountChoices(ctx, deps.db),
      flash, error,
    });

  app.get('/admin/categories', async c => {
    const ctx = need(c);
    if (!can(ctx.role, 'category.manage')) throw new Forbidden('category.manage');
    return html(await categoriesScreen(ctx));
  });

  app.post('/admin/categories', async c => {
    const ctx = need(c);
    if (!can(ctx.role, 'category.manage')) throw new Forbidden('category.manage');
    const f = await c.req.parseBody();
    const kind = String(f['kind'] ?? 'operating_income');
    try {
      await mutations.createCategory(ctx, deps.db, {
        nameAr: String(f['name'] ?? ''),
        // The pairing is derived, not asked: `direction` and `kind` are two
        // views of one fact, and `CHECK ((direction='expense') = (kind='expense'))`
        // refuses any other combination. Asking twice invites disagreement.
        direction: kind === 'expense' ? 'expense' : 'income',
        kind,
        ledgerAccountId: String(f['account'] ?? '') as never,
        icon: String(f['icon'] ?? '') || null,
      });
    } catch (e) {
      if (e instanceof LedgerRefused) return html(await categoriesScreen(ctx, undefined, e.reasonAr), 409);
      throw e;
    }
    return c.redirect('/admin/categories', 303);
  });

  app.post('/admin/categories/:id/active', async c => {
    const ctx = need(c);
    if (!can(ctx.role, 'category.manage')) throw new Forbidden('category.manage');
    const f = await c.req.parseBody();
    const on = String(f['active']) === '1';
    try {
      if (on) await mutations.activateCategory(ctx, deps.db, c.req.param('id') as never);
      else await mutations.deactivateCategory(ctx, deps.db, c.req.param('id') as never);
    } catch (e) {
      if (e instanceof LedgerRefused) return html(await categoriesScreen(ctx, undefined, e.reasonAr), 409);
      throw e;
    }
    return c.redirect('/admin/categories', 303);
  });

  /* ---- roles ------------------------------------------------------------- */

  const usersScreen = async (ctx: AuthContext, q: string, flash?: string, error?: string) =>
    av.usersPage({
      people: await adm.listPeople(ctx, deps.db, q),
      me: ctx.personId,
      canAssignAdmin: can(ctx.role, 'user.assign_admin_role'),
      q, flash, error,
    });

  app.get('/admin/users', async c => {
    const ctx = need(c);
    if (!can(ctx.role, 'user.assign_role')) throw new Forbidden('user.assign_role');
    return html(await usersScreen(ctx, c.req.query('q') ?? ''));
  });

  app.post('/admin/users/:id/role', async c => {
    const ctx = need(c);
    const f = await c.req.parseBody();
    try {
      await mutations.assignRole(ctx, deps.db, c.req.param('id') as never,
        String(f['role'] ?? 'resident') as never);
    } catch (e) {
      if (e instanceof Forbidden) return html(await usersScreen(ctx, '', undefined, e.reasonAr), 403);
      if (e instanceof LedgerRefused) return html(await usersScreen(ctx, '', undefined, e.reasonAr), 409);
      throw e;
    }
    return c.redirect('/admin/users', 303);
  });

  app.post('/admin/users/:id/active', async c => {
    const ctx = need(c);
    const f = await c.req.parseBody();
    try {
      await mutations.setPersonActive(ctx, deps.db, c.req.param('id') as never,
        String(f['active']) === '1', deps.now);
    } catch (e) {
      if (e instanceof Forbidden) return html(await usersScreen(ctx, '', undefined, e.reasonAr), 403);
      if (e instanceof LedgerRefused) return html(await usersScreen(ctx, '', undefined, e.reasonAr), 409);
      throw e;
    }
    return c.redirect('/admin/users', 303);
  });

  /* ---- settings ---------------------------------------------------------- */

  const settingsScreen = async (ctx: AuthContext, flash?: string, error?: string) =>
    av.settingsPage({ s: await adm.getSettings(ctx, deps.db), flash, error });

  app.get('/admin/settings', async c => {
    const ctx = need(c);
    if (!can(ctx.role, 'settings.edit')) throw new Forbidden('settings.edit');
    return html(await settingsScreen(ctx));
  });

  app.post('/admin/settings', async c => {
    const ctx = need(c);
    if (!can(ctx.role, 'settings.edit')) throw new Forbidden('settings.edit');
    const f = await c.req.parseBody();
    const threshold = parseMoney(String(f['threshold'] ?? ''));
    if (!threshold.ok) return html(await settingsScreen(ctx, undefined, threshold.messageAr), 400);
    try {
      await mutations.updateSettings(ctx, deps.db, {
        community_name_ar: String(f['community_name_ar'] ?? '').trim(),
        instapay_handle: String(f['instapay_handle'] ?? '').trim(),
        bank_name_ar: String(f['bank_name_ar'] ?? '').trim(),
        bank_account_no: String(f['bank_account_no'] ?? '').trim(),
        vodafone_cash_no: String(f['vodafone_cash_no'] ?? '').trim(),
        countersign_threshold_piastres: threshold.value,
        notify_quiet_from: String(f['quiet_from'] ?? '22:00'),
        notify_quiet_to: String(f['quiet_to'] ?? '09:00'),
        // An unchecked checkbox sends NOTHING. Reading it as "absent means
        // leave alone" would make the two publication switches impossible to
        // turn off from the form that turns them on.
        unit_status_public: f['unit_status_public'] === '1' ? 1 : 0,
        staff_names_public: f['staff_names_public'] === '1' ? 1 : 0,
      }, deps.now);
    } catch (e) {
      if (e instanceof LedgerRefused) return html(await settingsScreen(ctx, undefined, e.reasonAr), 409);
      throw e;
    }
    return html(await settingsScreen(ctx, _t.settings.saved));
  });

  /* ---- staff ------------------------------------------------------------- */

  const staffScreen = async (ctx: AuthContext, flash?: string, error?: string) =>
    av.staffPage({
      staff: await adm.listStaffFull(ctx, deps.db),
      canEdit: can(ctx.role, 'settings.edit'),
      flash, error,
    });

  app.get('/admin/staff', async c => {
    const ctx = need(c);
    // `staff.read_salaries` is held by RESIDENTS — the payroll total is
    // published on purpose (transparency). This screen shows the NAMES and the
    // edit controls, so it is gated on `staff.read_names`, which residents do
    // not hold and the board and the finance reviewer do.
    if (!can(ctx.role, 'staff.read_names')) throw new Forbidden('staff.read_names');
    return html(await staffScreen(ctx));
  });

  app.post('/admin/staff', async c => {
    const ctx = need(c);
    const f = await c.req.parseBody();
    const salary = parseMoney(String(f['salary'] ?? ''));
    if (!salary.ok) return html(await staffScreen(ctx, undefined, salary.messageAr), 400);
    try {
      await mutations.addStaff(ctx, deps.db, {
        fullName: String(f['name'] ?? ''),
        jobTitleAr: String(f['job'] ?? ''),
        monthlySalaryPiastres: salary.value,
        startedOn: String(f['started_on'] ?? '') || null,
      });
    } catch (e) {
      if (e instanceof LedgerRefused) return html(await staffScreen(ctx, undefined, e.reasonAr), 409);
      throw e;
    }
    return c.redirect('/admin/staff', 303);
  });

  app.post('/admin/staff/:id/end', async c => {
    const ctx = need(c);
    const f = await c.req.parseBody();
    try {
      await mutations.endStaff(ctx, deps.db, c.req.param('id') as never, String(f['ended_on'] ?? ''));
    } catch (e) {
      if (e instanceof LedgerRefused) return html(await staffScreen(ctx, undefined, e.reasonAr), 409);
      throw e;
    }
    return c.redirect('/admin/staff', 303);
  });

  /* ---- audit ------------------------------------------------------------- */

  app.get('/admin/audit', async c => {
    const ctx = need(c);
    if (!can(ctx.role, 'audit.read')) throw new Forbidden('audit.read');
    return html(av.auditPage({ rows: await adm.auditFeed(ctx, deps.db) }));
  });

  /* ---- settlements, credits and period close (CP-5) --------------------- */

  /**
   * Three accounting cycles that had a schema, a data layer and 22 passing
   * tests, and no way in. A difference the bank showed could be recorded and
   * never resolved; a credit could exist and never be given back. Both are the
   * shapes that quietly become "the board is keeping my money".
   *
   * They share one screen because they are one job. A year cannot close while
   * a difference is open — `trg_period_close_needs_reconciliation` says so —
   * and finding that out on a different page after pressing "close" is how a
   * treasurer decides the software is broken.
   *
   * Maker–checker is enforced in the data layer and in the schema; the screen
   * simply does not draw an approve button for the person who raised the
   * difference, so nobody is invited to press something that will refuse.
   */
  const settlementsScreen = async (ctx: AuthContext, flash?: string, error?: string) =>
    av.settlementsPage({
      suspense: await settle.suspenseBalance(ctx, deps.db),
      settlements: await settle.listOpenSettlements(ctx, deps.db) as never,
      credits: await settle.listOpenCredits(ctx, deps.db) as never,
      periods: await settle.listPeriods(ctx, deps.db) as never,
      me: ctx.personId,
      canApprove: can(ctx.role, 'expense.countersign'),
      canClose: can(ctx.role, 'period.close'),
      flash, error,
    });

  app.get('/admin/settlements', async c => {
    const ctx = need(c);
    // NOT `finance.read_totals`: residents hold that, and this screen names
    // which flats the village owes money to. `payment.read_any` is the board
    // and the finance reviewer.
    if (!can(ctx.role, 'payment.read_any')) throw new Forbidden('payment.read_any');
    return html(await settlementsScreen(ctx));
  });

  /** All four actions land back on the same screen, with the refusal shown in
   *  place rather than as a bare 409 — the treasurer needs to see WHICH guard
   *  refused while looking at the thing that refused. */
  const settleAction = async (
    c: { get(k: 'ctx'): AuthContext | null }, run: (ctx: AuthContext) => Promise<void>,
  ) => {
    const ctx = need(c);
    try {
      await run(ctx);
    } catch (e) {
      if (e instanceof LedgerRefused) return html(await settlementsScreen(ctx, undefined, e.reasonAr), 409);
      if (e instanceof Forbidden) return html(await settlementsScreen(ctx, undefined, e.reasonAr), 403);
      throw e;
    }
    return html(await settlementsScreen(ctx, _t.settle.done));
  };

  app.post('/admin/settlements/:id/approve', async c => {
    const f = await c.req.parseBody();
    return settleAction(c, async ctx => {
      await settle.approveAndPostAdjustment(ctx, deps.db, c.req.param('id') as never,
        String(f['period'] ?? '') as never, deps.now);
    });
  });

  app.post('/admin/settlements/:id/dismiss', async c => {
    const f = await c.req.parseBody();
    return settleAction(c, async ctx => {
      await settle.dismissTiming(ctx, deps.db, c.req.param('id') as never,
        String(f['note'] ?? ''), deps.now);
    });
  });

  app.post('/admin/periods/:id/close', async c =>
    settleAction(c, async ctx => {
      await settle.closePeriod(ctx, deps.db, c.req.param('id') as never, deps.now);
    }));

  app.post('/admin/periods/:id/reopen', async c => {
    const f = await c.req.parseBody();
    return settleAction(c, async ctx => {
      await settle.reopenPeriod(ctx, deps.db, c.req.param('id') as never,
        String(f['reason'] ?? ''), deps.now);
    });
  });

  /* ---- annual statement (CP-7) ------------------------------------------ */

  /**
   * `/payments` linked to `/payments/statement.pdf`, which was never
   * implemented — a 404 behind a button labelled "download your statement".
   * This resolves the caller's own unit so the button means something. An owner
   * of several flats gets a picker rather than an arbitrary one: guessing which
   * flat somebody meant is how a statement ends up shown for the wrong unit.
   */
  app.get('/payments/statement', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);
    const units = await content.listMyUnits(ctx, deps.db);
    if (units.length === 1) return c.redirect(`/units/${units[0]!.id}/statement`, 302);
    if (units.length === 0) {
      return html(v.messagePage(_t.payments.title,
        'حسابك مش مربوط بوحدة لسه — كلّم الإدارة وهيربطوها.'), 404);
    }
    return html(cv.pickUnitPage({ units }));
  });

  app.get('/units/:id/statement', async c => {
    const ctx = c.get('ctx');
    if (!ctx) return c.redirect('/login', 302);
    const unitId = c.req.param('id') as never;
    const year = (c.req.query('year') ?? deps.now().slice(0, 4)).replace(/\D/g, '').slice(0, 4);
    const s = await statement.getAnnualStatement(ctx, deps.db, unitId, year, deps.now);
    // Offer only years the village actually has periods for. A year picker with
    // empty years teaches the resident the statement is broken.
    const years = await statement.statementYears(ctx, deps.db);
    return html(cv.statementPage({ s, years, unitId: String(unitId) }));
  });

  /**
   * Display preferences — theme and text size — with no JavaScript.
   *
   * A POST rather than a GET link because it changes stored state, and a
   * same-origin redirect back to `next` so the resident lands exactly where
   * they were. `next` is validated as a site-relative path: accepting it raw
   * would make this an open redirect, and "change your text size" is a
   * plausible enough link to click that it is worth closing properly.
   */
  app.post('/prefs', async c => {
    const f = await c.req.parseBody();
    const which = String(f['cycle'] ?? '');
    const raw = String(f['next'] ?? '/');
    // Site-relative only. Accepting `next` raw would make this an open
    // redirect, and "change your text size" is a link people click.
    const next = /^\/(?!\/)[^\s]*$/.test(raw) ? raw : '/';
    const { theme, fs } = readPrefs(c.req.header('cookie') ?? '');

    const set = (name: string, value: string) =>
      c.header('set-cookie',
        value
          ? `${name}=${value}; Path=/; Max-Age=31536000; SameSite=Lax`
          : `${name}=; Path=/; Max-Age=0; SameSite=Lax`,
        { append: true });

    if (which === 'theme') set('qa_theme', _layout.nextTheme(theme));
    else if (which === 'fs') set('qa_fs', _layout.nextFs(fs));
    return c.redirect(next, 303);
  });

  app.notFound(() => html(v.messagePage(_t.states.notFound, _t.states.errorBody), 404));

  return app;
}

export class Unauthorized extends Error { readonly status = 401; }

/** Normalisation lives in lib/phone.ts; this is the thin call site. */
function normalizePhone(input: string): string | null {
  const r = normalize(input);
  return r.ok ? r.value : null;
}

/** Money never gets parsed anywhere except lib/money.ts. This is the call site. */
function parseMoney(input: string): { ok: true; value: number } | { ok: false; messageAr: string } {
  const r = parseMoneyRaw(input);
  return r.ok ? { ok: true, value: r.value } : { ok: false, messageAr: PARSE_MESSAGES_AR[r.error] };
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Buffer.from(new Uint8Array(d)).toString('hex');
}
