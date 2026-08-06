/**
 * tests/access/content.test.ts — CP-6's two gates, plus the refusals that make
 * the archive safe to publish.
 *
 * ## The gates, verbatim from CHECKPOINTS.md
 *   · "Searching an Arabic word from inside a PDF-attached post returns that post"
 *   · "A 2-year-old announcement is reachable in ≤ 3 taps"
 *
 * Both are asserted over HTTP as a real role, not against the data layer. A
 * search that works in `lib/db/content.ts` and 500s on `/search` has not met the
 * gate, and the only way to know is to ask the app the way a resident does.
 *
 * ## Why the folding tests are here and not in a unit file
 * `foldArabic` is pure and could be unit-tested alone, but the failure this
 * project actually risks is the two SIDES disagreeing — index folded one way,
 * query folded another. That is only observable end-to-end, so the orthography
 * cases run through the HTTP search route against a seeded index.
 */

import { it, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { NodeSqliteDb } from '../../lib/db/driver.js';
import { MemoryStorage } from '../../lib/storage/index.js';
import { setTokenHasher, resolveAuthContext } from '../../lib/db/index.js';
import { foldArabic, buildMatchQuery } from '../../lib/search/fold.js';
import { attachToPost, retractPost } from '../../lib/db/content.js';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
setTokenHasher(sha);

const ROOT = process.cwd();
const id = (p: string, n: number) => (p + String(n).padStart(26 - p.length, '0')).slice(0, 26);

const P_ADMIN = id('PRF', 1), P_OP = id('PRF', 2), P_RES = id('PRF', 3);
const B1 = id('BLD', 1), U_A = id('UNT', 1);
const TOK = { admin: 'tok-admin', op: 'tok-op', res: 'tok-res' };

let raw: DatabaseSync;
let app: ReturnType<typeof createApp>;
const NOW = '2026-08-06T10:00:00Z';

function req(path: string, token?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return app.request(path, { ...init, headers });
}

/** Post a urlencoded form the way the actual screens do. */
function form(path: string, token: string, fields: Record<string, string>) {
  return req(path, token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

before(() => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(ROOT, 'migrations')).sort())
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  for (const f of readdirSync(join(ROOT, 'seed/prod')).sort())
    raw.exec(readFileSync(join(ROOT, 'seed/prod', f), 'utf8'));

  const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...p as never[]);

  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,'admin')`, P_ADMIN, 'رئيس المجلس');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,'operator')`, P_OP, 'مشغّل');
  x(`INSERT INTO profiles (id,full_name,role) VALUES (?,?,'resident')`, P_RES, 'ساكن');
  x(`INSERT INTO buildings (id,code,name_ar,sort_order) VALUES (?,'5','عمارة 5',5)`, B1);
  x(`INSERT INTO units (id,building_id,unit_number) VALUES (?,?,'12')`, U_A, B1);
  x(`INSERT INTO unit_owners (id,unit_id,profile_id,valid_from) VALUES (?,?,?,'2020-01-01')`,
    id('UOW', 1), U_A, P_RES);

  for (const [tok, pid] of [
    [TOK.admin, P_ADMIN], [TOK.op, P_OP], [TOK.res, P_RES],
  ] as const) {
    x(`INSERT INTO sessions (id,profile_id,token_hash,expires_at) VALUES (?,?,?,?)`,
      id('SES', pid.charCodeAt(25) * 7 + tok.length), pid, sha(tok), '2027-01-01T00:00:00Z');
  }

  app = createApp({
    db: new NodeSqliteDb(raw as never),
    now: () => NOW,
    storage: new MemoryStorage(),
    rp: { id: 'localhost', name: 'قرية الأطباء', origin: 'http://localhost' },
  });
});

/* ================================================================== */
describe('Arabic folding — both sides of the search agree', () => {

  it('folds the four orthographic pairs that actually break Arabic search', () => {
    // Each pair is the SAME WORD to a reader. If any of these diverge, a
    // resident's search silently returns nothing and they go back to WhatsApp.
    assert.equal(foldArabic('الإجتماع'), foldArabic('الاجتماع'), 'hamza on alef');
    assert.equal(foldArabic('صيانه'), foldArabic('صيانة'), 'ta marbuta vs ha');
    assert.equal(foldArabic('مبني'), foldArabic('مبنى'), 'ya vs alef maqsura');
    assert.equal(foldArabic('١٤'), foldArabic('14'), 'Arabic-Indic digits');
  });

  it('strips tashkeel and tatweel, which change bytes but not the word', () => {
    assert.equal(foldArabic('الصِّيَانَة'), foldArabic('الصيانة'));
    assert.equal(foldArabic('صيــــانة'), foldArabic('صيانة'));
  });

  it('is idempotent — editing a post twice cannot drift its index token', () => {
    const once = foldArabic('قرار الجمعيَّة العموميّة رقم ١٤');
    assert.equal(foldArabic(once), once);
  });

  it('neutralises FTS5 syntax rather than passing it through', () => {
    // A resident typing a quote or a bare OR must get results, not a syntax
    // error. Every token comes back quoted, and the last one prefix-matched.
    const q = buildMatchQuery('قرار" OR ٭');
    assert.ok(q && !q.includes('OR '), `bare OR survived: ${q}`);
    assert.match(String(q), /"$|\*$/);
    assert.equal(buildMatchQuery('   '), null, 'an empty query must not build a MATCH');
  });
});

/* ================================================================== */
describe('CP-6 gate 1 — a word inside an attached PDF finds the post', () => {

  let slug = '';

  before(async () => {
    const r = await form('/admin/content', TOK.admin, {
      type: 'minutes',
      title: 'محضر اجتماع الجمعية العمومية — أغسطس 2024',
      body: 'تمت مناقشة البنود المعتادة.',
    });
    assert.equal(r.status, 303);

    const row = raw.prepare(`SELECT id, slug FROM posts ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string; slug: string };
    slug = row.slug;

    // The PDF's text layer. Note: "الميزانية التقديرية" appears ONLY here —
    // nowhere in the post's own title or body. That is the whole point.
    const db = new NodeSqliteDb(raw as never);
    const ctx = await resolveAuthContext(db, TOK.admin, () => NOW);
    await attachToPost(ctx!, db, row.id as never, {
      storageKey: 'docs/minutes.pdf',
      nameAr: 'محضر أغسطس 2024.pdf',
      sizeBytes: 184320,
      mime: 'application/pdf',
      extractedText: 'الميزانية التقديرية لسنة 2025 وبند صيانة مواتير المياه',
    });
  });

  it('finds the post by a phrase that exists only inside the PDF', async () => {
    const r = await req('/search?q=' + encodeURIComponent('الميزانية التقديرية'), TOK.res);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /محضر اجتماع الجمعية العمومية/,
      'the CP-6 gate failed: PDF text is not reaching the index');
  });

  it('says WHERE it found it, so the resident knows to open the attachment', async () => {
    const html = await (await req('/search?q=' + encodeURIComponent('مواتير المياه'), TOK.res)).text();
    assert.match(html, /لقيناها جوه مستند مرفق/);
  });

  it('finds it through the folded spelling too', async () => {
    // «الميزانيه» with ha, as typed on a phone keyboard.
    const html = await (await req('/search?q=' + encodeURIComponent('الميزانيه'), TOK.res)).text();
    assert.match(html, /محضر اجتماع/, 'folding is not applied to both sides');
  });

  it('a retracted post leaves the index immediately', async () => {
    const post = raw.prepare(`SELECT id FROM posts WHERE slug = ?`).get(slug) as { id: string };
    const db = new NodeSqliteDb(raw as never);
    const ctx = await resolveAuthContext(db, TOK.admin, () => NOW);
    await retractPost(ctx!, db, post.id as never, 'اتنشر بالغلط', () => NOW);

    const html = await (await req('/search?q=' + encodeURIComponent('الميزانية التقديرية'), TOK.res)).text();
    assert.doesNotMatch(html, /محضر اجتماع الجمعية العمومية/,
      'a retracted announcement is still findable — this is the failure with a legal edge');
    // …and the row itself survives, because a board that can erase a decision
    // without trace is a board nobody can audit.
    assert.equal(
      Number((raw.prepare(`SELECT COUNT(*) n FROM posts WHERE id = ?`).get(post.id) as { n: number }).n),
      1, 'retraction deleted the row instead of soft-deleting it');
  });
});

/* ================================================================== */
describe('CP-6 gate 2 — a 2-year-old announcement in ≤ 3 taps', () => {

  const TITLE = 'قرار تأسيس مجلس الإدارة الأول';
  let archivedSlug = '';

  before(async () => {
    // Published in 2024. "Two years old" relative to the app's 2026 clock.
    await form('/admin/content', TOK.admin, {
      type: 'decision', title: TITLE, body: 'اللائحة الداخلية.',
    });
    // Selected by TITLE, not by `ORDER BY created_at DESC LIMIT 1`: the whole
    // suite runs on one frozen clock, so every post shares a created_at and
    // that ordering picks an arbitrary row — which is how this fixture first
    // back-dated the retracted post from the previous describe block instead.
    const row = raw.prepare(`SELECT id, slug FROM posts WHERE title_ar = ?`)
      .get(TITLE) as { id: string; slug: string };
    archivedSlug = row.slug;
    raw.prepare(`UPDATE posts SET published_at = '2024-03-12T12:00:00Z' WHERE id = ?`)
      .run(row.id as never);
  });

  it('tap 1 → /news/archive lists the year', async () => {
    const r = await req('/news/archive', TOK.res);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /2024/, 'the archive does not offer the year');
  });

  it('tap 2 → the month page lists the announcement', async () => {
    const r = await req('/news/archive/2024/03', TOK.res);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /قرار تأسيس مجلس الإدارة/,
      'the month page does not reach the announcement');
  });

  it('tap 3 → the post itself opens', async () => {
    const r = await req('/news/' + encodeURIComponent(archivedSlug), TOK.res);
    assert.equal(r.status, 200, 'the archived post does not open');
    assert.match(await r.text(), /اللائحة الداخلية/);
  });
});

/* ================================================================== */
describe('publishing is capability-gated, not role-gated by hand', () => {

  it('an operator may publish news', async () => {
    const r = await form('/admin/content', TOK.op, {
      type: 'news', title: 'تم تركيب كشافات جديدة', body: 'في المدخل الرئيسي.',
    });
    assert.equal(r.status, 303, 'an operator holds post.publish and was refused');
  });

  it('an operator may NOT publish board minutes', async () => {
    const r = await form('/admin/content', TOK.op, {
      type: 'minutes', title: 'محضر ملفّق', body: 'قرار لم يحدث.',
    });
    assert.equal(r.status, 403,
      'an operator entered a decision into the board record — minutes.publish leaked');
  });

  it('a resident cannot reach the publishing screen at all', async () => {
    assert.equal((await req('/admin/content', TOK.res)).status, 403);
  });

  it('an unauthenticated caller gets nothing from the archive', async () => {
    assert.equal((await req('/news')).status, 302, 'the archive leaked to a guest');
    assert.equal((await req('/search?q=قرار')).status, 302);
  });

  it('only one post stays pinned', async () => {
    const ids = (raw.prepare(`SELECT id FROM posts WHERE deleted_at IS NULL LIMIT 2`)
      .all() as Array<{ id: string }>).map(r => r.id);
    for (const pid of ids) await form(`/admin/content/${pid}/pin`, TOK.admin, { pinned: '1' });
    assert.equal(
      Number((raw.prepare(`SELECT COUNT(*) n FROM posts WHERE is_pinned = 1`).get() as { n: number }).n),
      1, 'two banners are the same as none');
  });
});

/* ================================================================== */
describe('albums refuse to publish what would expose a resident', () => {

  const ALB = id('ALB', 90);

  before(() => {
    raw.prepare(
      `INSERT INTO albums (id,title_ar,description_ar,created_by,created_at)
       VALUES (?,?,?,?,?)`
    ).run(ALB as never, 'ترميم السور' as never, 'صور الشغل' as never,
          P_ADMIN as never, NOW as never);
  });

  it('a photo whose EXIF was not stripped is refused BY THE DATABASE', () => {
    // Not by the upload code — by 0020's trigger. A future upload path that
    // forgets the step must fail at write time, loudly.
    assert.throws(
      () => raw.prepare(
        `INSERT INTO album_photos (id,album_id,storage_key,exif_stripped) VALUES (?,?,?,0)`
      ).run(id('PHO', 1) as never, ALB as never, 'a.webp' as never),
      /بيانات المكان|EXIF/,
      'a photo carrying home coordinates was accepted');
  });

  it('publishing without the safety check is refused BY THE DATABASE', () => {
    raw.prepare(`INSERT INTO album_photos (id,album_id,storage_key,exif_stripped)
                 VALUES (?,?,?,1)`)
      .run(id('PHO', 2) as never, ALB as never, 'ok.webp' as never);
    assert.throws(
      () => raw.prepare(`UPDATE albums SET published_at=? WHERE id=?`)
        .run(NOW as never, ALB as never),
      /مراجعة صور|safety/,
      'an unreviewed album published — R-026');
  });

  it('and succeeds once a named editor has ticked it', () => {
    raw.prepare(`UPDATE albums SET safety_checked_by=?, safety_checked_at=? WHERE id=?`)
      .run(P_ADMIN as never, NOW as never, ALB as never);
    raw.prepare(`UPDATE albums SET published_at=? WHERE id=?`).run(NOW as never, ALB as never);
    assert.equal(
      Number((raw.prepare(`SELECT COUNT(*) n FROM albums WHERE id=? AND published_at IS NOT NULL`)
        .get(ALB) as { n: number }).n), 1);
  });
});

/* ================================================================== */
describe('maintenance tickets', () => {

  it('a resident can report a fault in a shared area', async () => {
    const r = await form('/maintenance', TOK.res, {
      title: 'نور السلم مش شغال', details: 'الدور التالت.', unitId: '',
    });
    assert.equal(r.status, 303);
    const html = await (await req('/maintenance', TOK.res)).text();
    assert.match(html, /نور السلم مش شغال/);
  });

  it('a resident cannot mark their own complaint resolved', async () => {
    const tid = (raw.prepare(`SELECT id FROM maintenance_tickets LIMIT 1`)
      .get() as { id: string }).id;
    const r = await form(`/maintenance/${tid}/status`, TOK.res, {
      next: 'resolved', resolution: 'اتصلح خلاص',
    });
    assert.equal(r.status, 403, 'a resident closed their own ticket');
  });

  it('an operator must write what happened before resolving', async () => {
    const tid = (raw.prepare(`SELECT id FROM maintenance_tickets LIMIT 1`)
      .get() as { id: string }).id;
    await form(`/maintenance/${tid}/status`, TOK.op, { next: 'acknowledged', resolution: '' });
    await form(`/maintenance/${tid}/status`, TOK.op, { next: 'in_progress', resolution: '' });
    const bad = await form(`/maintenance/${tid}/status`, TOK.op, { next: 'resolved', resolution: '' });
    assert.equal(bad.status, 403, 'a ticket was resolved with no explanation');

    const ok = await form(`/maintenance/${tid}/status`, TOK.op,
      { next: 'resolved', resolution: 'تم تغيير اللمبة والكونتاكت.' });
    assert.equal(ok.status, 303);
  });

  it('refuses a status jump that skips the flow', async () => {
    const tid = (raw.prepare(
      `SELECT id FROM maintenance_tickets WHERE status='resolved' LIMIT 1`
    ).get() as { id: string } | undefined)?.id;
    if (!tid) return;
    // resolved -> acknowledged is not a legal move; only closed or in_progress.
    const r = await form(`/maintenance/${tid}/status`, TOK.op,
      { next: 'acknowledged', resolution: 'رجوع' });
    assert.equal(r.status, 403);
  });
});

/* ================================================================== */
describe('display preferences work with JavaScript disabled', () => {
  /**
   * The first version of this used localStorage and an inline script, and two
   * existing tests refused it — the expense and reversal screens assert they
   * ship no `<script>` at all, because an operator on a cheap phone or a board
   * member on a locked-down laptop still has to be able to work. These tests
   * keep the replacement honest.
   */

  it('the toggles are forms, and no screen gained a script', async () => {
    const html = await (await req('/news', TOK.res)).text();
    assert.match(html, /action="\/prefs"/, 'the preference controls are missing');
    assert.doesNotMatch(html, /<script/, 'a preference script came back');
  });

  it('cycles auto → light → dark → auto, so "follow my phone" stays reachable', async () => {
    const step = async (cookie: string) => {
      const r = await app.request('/prefs', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
        },
        body: new URLSearchParams({ cycle: 'theme', next: '/news' }).toString(),
      });
      return r.headers.get('set-cookie') ?? '';
    };
    assert.match(await step(''), /qa_theme=light/);
    assert.match(await step('qa_theme=light'), /qa_theme=dark/);
    // Back to auto: cleared, not set to a third theme.
    assert.match(await step('qa_theme=dark'), /qa_theme=;|Max-Age=0/);
  });

  it('the chosen theme is already in the HTML — it cannot flash the wrong one', async () => {
    const r = await req('/news', TOK.res, { headers: { cookie: 'qa_theme=dark; qa_fs=xl' } });
    const html = await r.text();
    assert.match(html, /<html lang="ar" dir="rtl" data-theme="dark" data-fs="xl">/,
      'the preference is not applied server-side');
  });

  it('refuses an off-site redirect', async () => {
    for (const bad of ['https://evil.example/x', '//evil.example/x', 'javascript:alert(1)']) {
      const r = await app.request('/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ cycle: 'theme', next: bad }).toString(),
      });
      assert.equal(r.headers.get('location'), '/', `open redirect via ${bad}`);
    }
  });

  it('ignores a junk cookie instead of reflecting it into the page', async () => {
    const r = await req('/news', TOK.res, {
      headers: { cookie: 'qa_theme="><script>alert(1)</script>; qa_fs=999' },
    });
    const html = await r.text();
    assert.doesNotMatch(html, /<script>alert/, 'a cookie value reached the page as markup');
    assert.doesNotMatch(html, /data-fs="999"/);
  });
});
