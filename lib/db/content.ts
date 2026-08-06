/**
 * lib/db/content.ts — CP-6. The archive that replaces WhatsApp.
 *
 * ## What this checkpoint is actually for
 *
 * Every other part of this portal is about money. This part is about memory. The
 * problem it solves is not "the board would like a news page" — it is that the
 * village's entire institutional record currently lives in a WhatsApp group,
 * where it is unsearchable, unordered, invisible to anyone who joined later, and
 * gone the day someone leaves the group. A decision taken in 2024 is, in
 * practice, lost.
 *
 * So the two gates in CHECKPOINTS.md are the right ones, and they are strict:
 *   · searching an Arabic word that appears inside an attached PDF returns the
 *     post that PDF is attached to;
 *   · a two-year-old announcement is reachable in three taps.
 *
 * ## Publishing is a two-capability act, on purpose
 *
 * `post.publish` and `minutes.publish` are separate capabilities and an operator
 * holds only the first (03_RBAC §2). An operator can write and publish news; the
 * minutes of a board meeting need an admin. The distinction is not bureaucratic:
 * minutes are the record of what the board decided, and a person with no
 * financial authority must not be able to enter a decision into that record.
 *
 * ## Albums carry a safety gate that has nothing to do with permissions
 *
 * A maintenance album is photographs of the village — which means photographs of
 * people's homes, cars, licence plates, and sometimes people. `albums` refuses
 * to publish without a named editor's safety check (0004's CHECK plus 0020's
 * trigger), and `album_photos` refuses a row whose EXIF was not stripped. Both
 * live in the schema rather than here, per ADR-024: this file produces the
 * Arabic message, the database produces the refusal.
 */

import type { AuthContext, Id } from '../../types/domain.js';
import { require_, can, Forbidden } from '../rbac.js';
import { foldArabic, buildMatchQuery, buildSearchBody } from '../search/fold.js';
import type { Db } from './driver.js';
import { newId, NotFound, writeAudit, type Clock } from './index.js';

/* ===================================================================== */
/* Posts — news, announcements, decisions, minutes, documents            */
/* ===================================================================== */

export type PostType = 'news' | 'announcement' | 'decision' | 'minutes' | 'document';

export interface PostSummary {
  id: Id;
  type: PostType;
  slug: string;
  title_ar: string;
  excerpt_ar: string;
  published_at: string | null;
  is_pinned: number;
  attachment_count: number;
}

export interface PostDetail extends PostSummary {
  body_ar: string;
  author_name: string;
  attachments: Array<{
    id: Id; name_ar: string; size_bytes: number; mime: string; storage_key: string;
  }>;
}

/**
 * Minutes and decisions are the board's record; publishing into it needs
 * `minutes.publish`, which an operator does not hold. Everything else needs
 * `post.publish`.
 */
function capabilityForPostType(type: PostType): 'post.publish' | 'minutes.publish' {
  return type === 'minutes' || type === 'decision' ? 'minutes.publish' : 'post.publish';
}

/**
 * A URL-safe slug from an Arabic title.
 *
 * Arabic letters are kept as-is — modern browsers and Cloudflare handle
 * percent-encoded UTF-8 paths correctly, and a transliterated slug would be both
 * lossy and unreadable to the people using it. Only characters that break a path
 * are replaced. The ULID suffix guarantees uniqueness without a retry loop,
 * which matters because two decisions in one meeting routinely share a title.
 */
export function slugify(titleAr: string, id: Id): string {
  const base = String(titleAr)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'post'}-${id.slice(-6).toLowerCase()}`;
}

export interface CreatePostInput {
  type: PostType;
  titleAr: string;
  bodyAr: string;
  isPinned?: boolean;
  /** Publish immediately, or leave as a draft the author can finish later. */
  publish?: boolean;
}

export async function createPost(
  ctx: AuthContext, db: Db, input: CreatePostInput, clock: Clock,
): Promise<{ id: Id; slug: string }> {
  require_(ctx.role, capabilityForPostType(input.type));

  const title = String(input.titleAr ?? '').trim();
  if (!title) throw new Forbidden('post.publish', 'العنوان مطلوب');

  const id = newId('PST') as Id;
  const slug = slugify(title, id);
  const body = String(input.bodyAr ?? '');
  const now = clock();
  const publishedAt = input.publish === false ? null : now;

  await db.prepare(
    `INSERT INTO posts (id, type, slug, title_ar, body_ar, search_body,
                        published_at, is_pinned, author_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, input.type, slug, title, body, buildSearchBody(title, body),
    publishedAt, input.isPinned ? 1 : 0, ctx.personId, now,
  ).run();

  await reindexPost(db, id);
  await writeAudit(db, ctx, 'post.create', 'posts', id, null,
    { type: input.type, title_ar: title, published: publishedAt !== null });
  return { id, slug };
}

/**
 * Only one post is pinned at a time. Pinning a second one silently leaving the
 * first pinned is how a village ends up with a two-year-old "important" banner
 * at the top of the home screen, which trains everyone to ignore the banner.
 */
export async function setPinned(
  ctx: AuthContext, db: Db, postId: Id, pinned: boolean, clock: Clock,
): Promise<void> {
  require_(ctx.role, 'post.publish');
  if (pinned) {
    await db.prepare(`UPDATE posts SET is_pinned = 0 WHERE is_pinned = 1`).run();
  }
  await db.prepare(`UPDATE posts SET is_pinned = ?, updated_at = ? WHERE id = ?`)
    .bind(pinned ? 1 : 0, clock(), postId).run();
  await writeAudit(db, ctx, pinned ? 'post.pin' : 'post.unpin', 'posts', postId, null, null);
}

export async function updatePost(
  ctx: AuthContext, db: Db, postId: Id,
  patch: { titleAr?: string; bodyAr?: string }, clock: Clock,
): Promise<void> {
  const row = await db.prepare(`SELECT type, title_ar, body_ar FROM posts WHERE id = ?`)
    .bind(postId).first<{ type: PostType; title_ar: string; body_ar: string }>();
  if (!row) throw new NotFound('post');
  require_(ctx.role, capabilityForPostType(row.type));

  const title = patch.titleAr?.trim() || row.title_ar;
  const body = patch.bodyAr ?? row.body_ar;

  await db.prepare(
    `UPDATE posts SET title_ar = ?, body_ar = ?, search_body = ?, updated_at = ? WHERE id = ?`
  ).bind(title, body, buildSearchBody(title, body), clock(), postId).run();

  await reindexPost(db, postId);
  await writeAudit(db, ctx, 'post.update', 'posts', postId,
    { title_ar: row.title_ar }, { title_ar: title });
}

/**
 * Retraction is a soft delete and the row stays. A board that can make a
 * decision disappear without trace is a board nobody can audit — and the audit
 * row recording the retraction is itself append-only.
 */
export async function retractPost(
  ctx: AuthContext, db: Db, postId: Id, reasonAr: string, clock: Clock,
): Promise<void> {
  const row = await db.prepare(`SELECT type, title_ar FROM posts WHERE id = ?`)
    .bind(postId).first<{ type: PostType; title_ar: string }>();
  if (!row) throw new NotFound('post');
  require_(ctx.role, capabilityForPostType(row.type));
  if (!String(reasonAr ?? '').trim()) {
    throw new Forbidden('post.publish', 'لازم تكتب سبب السحب');
  }

  await db.prepare(`UPDATE posts SET deleted_at = ? WHERE id = ?`)
    .bind(clock(), postId).run();
  // Out of the index immediately: a retracted announcement that is still
  // findable is the failure with a legal edge to it.
  await db.prepare(`DELETE FROM posts_fts WHERE post_id = ?`).bind(postId).run();
  await writeAudit(db, ctx, 'post.retract', 'posts', postId,
    { title_ar: row.title_ar }, { reason_ar: reasonAr });
}

/** Rebuild one post's search row from the posts + attachments tables. */
async function reindexPost(db: Db, postId: Id): Promise<void> {
  const post = await db.prepare(
    `SELECT title_ar, search_body, published_at, deleted_at FROM posts WHERE id = ?`
  ).bind(postId).first<{
    title_ar: string; search_body: string; published_at: string | null; deleted_at: string | null;
  }>();

  await db.prepare(`DELETE FROM posts_fts WHERE post_id = ?`).bind(postId).run();
  // A draft or a retracted post is deliberately absent from the index rather
  // than present-and-filtered: a filter that is forgotten at one call site leaks
  // an unpublished announcement, and there is no such thing as a partly
  // published board decision.
  if (!post || post.published_at === null || post.deleted_at !== null) return;

  const attachments = await db.prepare(
    `SELECT extracted_text, name_ar FROM post_attachments WHERE post_id = ?`
  ).bind(postId).all<{ extracted_text: string; name_ar: string }>();

  const attachmentText = foldArabic(
    (attachments.results ?? []).map(a => `${a.name_ar} ${a.extracted_text}`).join(' ')
  );

  await db.prepare(
    `INSERT INTO posts_fts (post_id, title_ar, search_body, attachment_text) VALUES (?,?,?,?)`
  ).bind(postId, foldArabic(post.title_ar), post.search_body, attachmentText).run();
}

/**
 * Attach a document. `extractedText` is the PDF's text layer, supplied by the
 * caller — extraction itself is not a database concern, and doing it here would
 * put a PDF parser inside the data layer.
 *
 * This is the CP-6 gate: after this call, a word that appears only inside the
 * PDF finds the post.
 */
export async function attachToPost(
  ctx: AuthContext, db: Db, postId: Id,
  file: { storageKey: string; nameAr: string; sizeBytes: number; mime: string; extractedText?: string },
): Promise<Id> {
  const row = await db.prepare(`SELECT type FROM posts WHERE id = ?`)
    .bind(postId).first<{ type: PostType }>();
  if (!row) throw new NotFound('post');
  require_(ctx.role, capabilityForPostType(row.type));

  const id = newId('ATT') as Id;
  await db.prepare(
    `INSERT INTO post_attachments (id, post_id, storage_key, name_ar, size_bytes, mime, extracted_text)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(
    id, postId, file.storageKey, file.nameAr, file.sizeBytes, file.mime,
    foldArabic(file.extractedText ?? ''),
  ).run();

  await reindexPost(db, postId);
  await writeAudit(db, ctx, 'post.attach', 'post_attachments', id, null,
    { post_id: postId, name_ar: file.nameAr });
  return id;
}

/* ===================================================================== */
/* Reading                                                               */
/* ===================================================================== */

/**
 * Published posts, pinned first. No capability check: the archive is readable by
 * every authenticated member, which is the entire point of it. Drafts and
 * retracted posts are excluded by the predicate, not by the caller.
 */
export async function listPosts(
  ctx: AuthContext, db: Db,
  opts: { type?: PostType; limit?: number; offset?: number } = {},
): Promise<PostSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await db.prepare(
    `SELECT p.id, p.type, p.slug, p.title_ar,
            substr(p.body_ar, 1, 180) AS excerpt_ar,
            p.published_at, p.is_pinned,
            (SELECT COUNT(*) FROM post_attachments a WHERE a.post_id = p.id) AS attachment_count
       FROM posts p
      WHERE p.published_at IS NOT NULL AND p.deleted_at IS NULL
        AND (? IS NULL OR p.type = ?)
      ORDER BY p.is_pinned DESC, p.published_at DESC
      LIMIT ? OFFSET ?`
  ).bind(opts.type ?? null, opts.type ?? null, limit, offset).all<PostSummary>();
  return rows.results ?? [];
}

export async function getPostBySlug(
  ctx: AuthContext, db: Db, slug: string,
): Promise<PostDetail | null> {
  const post = await db.prepare(
    `SELECT p.id, p.type, p.slug, p.title_ar, p.body_ar,
            substr(p.body_ar, 1, 180) AS excerpt_ar,
            p.published_at, p.is_pinned,
            pr.full_name AS author_name,
            (SELECT COUNT(*) FROM post_attachments a WHERE a.post_id = p.id) AS attachment_count
       FROM posts p JOIN profiles pr ON pr.id = p.author_id
      WHERE p.slug = ? AND p.published_at IS NOT NULL AND p.deleted_at IS NULL`
  ).bind(slug).first<PostDetail>();
  if (!post) return null;

  const att = await db.prepare(
    `SELECT id, name_ar, size_bytes, mime, storage_key FROM post_attachments
      WHERE post_id = ? ORDER BY sort_order, name_ar`
  ).bind(post.id).all<PostDetail['attachments'][number]>();

  return { ...post, attachments: att.results ?? [] };
}

/**
 * The archive index: every published item grouped by year and month, so the
 * "two-year-old announcement in three taps" gate is year → month → item.
 */
export async function archiveIndex(
  ctx: AuthContext, db: Db,
): Promise<Array<{ year: string; month: string; items: number }>> {
  const rows = await db.prepare(
    `SELECT year, month, COUNT(*) AS items FROM v_content_archive
      GROUP BY year, month ORDER BY year DESC, month DESC`
  ).all<{ year: string; month: string; items: number }>();
  return rows.results ?? [];
}

export async function archiveMonth(
  ctx: AuthContext, db: Db, year: string, month: string,
): Promise<Array<{
  content_id: Id; content_kind: string; content_type: string;
  slug: string; title_ar: string; published_at: string;
}>> {
  const rows = await db.prepare(
    `SELECT content_id, content_kind, content_type, slug, title_ar, published_at
       FROM v_content_archive WHERE year = ? AND month = ?
      ORDER BY published_at DESC`
  ).bind(String(year), String(month).padStart(2, '0')).all<{
    content_id: Id; content_kind: string; content_type: string;
    slug: string; title_ar: string; published_at: string;
  }>();
  return rows.results ?? [];
}

/* ===================================================================== */
/* Search — the CP-6 gate                                                */
/* ===================================================================== */

export interface SearchHit {
  kind: 'post' | 'album';
  id: Id;
  slug: string;
  title_ar: string;
  snippet_ar: string;
  published_at: string | null;
  /** True when the term was found only inside an attached document. */
  matched_in_attachment: boolean;
}

/**
 * One search box across announcements, decisions, minutes, attached PDFs and
 * album captions.
 *
 * The query is folded through the same function that folded the index, so
 * «صيانه» and «صيانة» are the same search. `buildMatchQuery` re-quotes every
 * token, which is what stops a resident's apostrophe or a bare `OR` from
 * reaching FTS5 as syntax.
 */
export async function search(
  ctx: AuthContext, db: Db, rawQuery: string, limit = 30,
): Promise<SearchHit[]> {
  const match = buildMatchQuery(rawQuery);
  if (!match) return [];
  const capped = Math.min(Math.max(limit, 1), 100);

  const posts = await db.prepare(
    `SELECT f.post_id AS id, p.slug, p.title_ar, p.published_at,
            substr(p.body_ar, 1, 200) AS snippet_ar
       FROM posts_fts f JOIN posts p ON p.id = f.post_id
      WHERE posts_fts MATCH ?
        AND p.published_at IS NOT NULL AND p.deleted_at IS NULL
      ORDER BY p.is_pinned DESC, rank
      LIMIT ?`
  ).bind(match, capped).all<{
    id: Id; slug: string; title_ar: string; published_at: string | null;
    snippet_ar: string;
  }>();

  // "Where did you find it?" needs a SECOND query, not a CASE on the first.
  //
  // The obvious `CASE WHEN f.attachment_text MATCH ? THEN 1 ELSE 0 END` is
  // rejected by SQLite at runtime — "unable to use function MATCH in the
  // requested context". FTS5's MATCH is a table-level constraint, not a scalar
  // predicate, so it is legal only in a WHERE against the FTS table itself.
  // The supported way to ask about one column is the `column : term` filter
  // syntax inside the match expression.
  //
  // Worth the extra round trip: telling a resident the words were inside an
  // attached PDF is the difference between them opening the attachment and
  // concluding the search returned the wrong post.
  const inAttachment = new Set<string>(
    ((await db.prepare(
      `SELECT post_id FROM posts_fts WHERE posts_fts MATCH ? LIMIT ?`
    ).bind(`attachment_text : (${match})`, capped)
      .all<{ post_id: string }>()).results ?? []).map(r => r.post_id)
  );

  const albums = await db.prepare(
    `SELECT f.album_id AS id, a.title_ar, a.published_at,
            substr(a.description_ar, 1, 200) AS snippet_ar
       FROM albums_fts f JOIN albums a ON a.id = f.album_id
      WHERE albums_fts MATCH ? AND a.published_at IS NOT NULL
      ORDER BY rank LIMIT ?`
  ).bind(match, capped).all<{
    id: Id; title_ar: string; published_at: string | null; snippet_ar: string;
  }>();

  const hits: SearchHit[] = [
    ...(posts.results ?? []).map(r => ({
      kind: 'post' as const, id: r.id, slug: r.slug, title_ar: r.title_ar,
      snippet_ar: r.snippet_ar ?? '', published_at: r.published_at,
      matched_in_attachment: inAttachment.has(r.id),
    })),
    ...(albums.results ?? []).map(r => ({
      kind: 'album' as const, id: r.id, slug: r.id, title_ar: r.title_ar,
      snippet_ar: r.snippet_ar ?? '', published_at: r.published_at,
      matched_in_attachment: false,
    })),
  ];

  return hits
    .sort((a, b) => String(b.published_at ?? '').localeCompare(String(a.published_at ?? '')))
    .slice(0, capped);
}

/* ===================================================================== */
/* Albums                                                                */
/* ===================================================================== */

export interface AlbumSummary {
  id: Id; title_ar: string; description_ar: string;
  happened_on: string | null; published_at: string | null;
  photo_count: number; linked_expense_id: Id | null;
  expense_amount: number | null; expense_description: string | null;
}

export async function createAlbum(
  ctx: AuthContext, db: Db,
  input: { titleAr: string; descriptionAr?: string; happenedOn?: string; linkedExpenseId?: Id },
  clock: Clock,
): Promise<Id> {
  require_(ctx.role, 'album.create');
  const title = String(input.titleAr ?? '').trim();
  if (!title) throw new Forbidden('album.create', 'عنوان الألبوم مطلوب');

  const id = newId('ALB') as Id;
  await db.prepare(
    `INSERT INTO albums (id, title_ar, description_ar, happened_on, linked_expense_id,
                         created_by, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(
    id, title, input.descriptionAr ?? '', input.happenedOn ?? null,
    input.linkedExpenseId ?? null, ctx.personId, clock(),
  ).run();

  await writeAudit(db, ctx, 'album.create', 'albums', id, null, { title_ar: title });
  return id;
}

/**
 * The photo-safety check. Ticking it is a named act by a named person, recorded
 * with a timestamp, because it is the only thing standing between a maintenance
 * album and a resident's licence plate being published to 214 neighbours.
 */
export async function markAlbumSafetyChecked(
  ctx: AuthContext, db: Db, albumId: Id, clock: Clock,
): Promise<void> {
  require_(ctx.role, 'album.create');
  await db.prepare(
    `UPDATE albums SET safety_checked_by = ?, safety_checked_at = ? WHERE id = ?`
  ).bind(ctx.personId, clock(), albumId).run();
  await writeAudit(db, ctx, 'album.safety_check', 'albums', albumId, null,
    { checked_by: ctx.personId });
}

/**
 * Publishing is refused by `trg_album_publish_needs_safety` when the checklist
 * was never ticked. The check below exists to turn that refusal into Arabic —
 * it is the message, not the control.
 */
export async function publishAlbum(
  ctx: AuthContext, db: Db, albumId: Id, clock: Clock,
): Promise<void> {
  require_(ctx.role, 'album.create');
  const row = await db.prepare(
    `SELECT title_ar, description_ar, safety_checked_by,
            (SELECT COUNT(*) FROM album_photos WHERE album_id = ?) AS photos
       FROM albums WHERE id = ?`
  ).bind(albumId, albumId).first<{
    title_ar: string; description_ar: string; safety_checked_by: string | null; photos: number;
  }>();
  if (!row) throw new NotFound('album');
  if (!row.safety_checked_by) {
    throw new Forbidden('album.create', 'راجع الصور الأول: مفيش وشوش ولا أرقام عربيات ولا عناوين');
  }
  if (row.photos === 0) {
    throw new Forbidden('album.create', 'الألبوم لسه فاضي');
  }

  await db.prepare(`UPDATE albums SET published_at = ? WHERE id = ?`)
    .bind(clock(), albumId).run();

  await db.prepare(`DELETE FROM albums_fts WHERE album_id = ?`).bind(albumId).run();
  await db.prepare(
    `INSERT INTO albums_fts (album_id, title_ar, search_body) VALUES (?,?,?)`
  ).bind(albumId, foldArabic(row.title_ar),
    buildSearchBody(row.title_ar, row.description_ar)).run();

  await writeAudit(db, ctx, 'album.publish', 'albums', albumId, null, null);
}

/**
 * `exifStripped` is passed explicitly rather than defaulted, so the upload
 * pipeline has to state that it did the work. `trg_photo_requires_exif_strip`
 * refuses the row if it claims otherwise.
 */
export async function addAlbumPhoto(
  ctx: AuthContext, db: Db, albumId: Id,
  photo: { storageKey: string; captionAr?: string; takenAt?: string; exifStripped: boolean },
): Promise<Id> {
  require_(ctx.role, 'album.create');
  if (!photo.exifStripped) {
    throw new Forbidden('album.create', 'الصورة لازم تتشال منها بيانات المكان الأول');
  }
  const id = newId('PHO') as Id;
  await db.prepare(
    `INSERT INTO album_photos (id, album_id, storage_key, caption_ar, taken_at, exif_stripped)
     VALUES (?,?,?,?,?,1)`
  ).bind(id, albumId, photo.storageKey, photo.captionAr ?? null, photo.takenAt ?? null).run();
  return id;
}

/**
 * Published albums with their linked expense.
 *
 * The join to `expenses` is the reason albums are worth building at all: an
 * album showing the repaired wall next to the 42,000 ج.م the village paid for it
 * is the single most persuasive artefact this portal can produce. Only POSTED
 * expenses are joined — an amount that has not cleared maker–checker is not a
 * number to publish beside a photograph.
 */
export async function listAlbums(
  ctx: AuthContext, db: Db, limit = 24,
): Promise<AlbumSummary[]> {
  const rows = await db.prepare(
    `SELECT a.id, a.title_ar, a.description_ar, a.happened_on, a.published_at,
            a.linked_expense_id,
            (SELECT COUNT(*) FROM album_photos p WHERE p.album_id = a.id) AS photo_count,
            e.amount_piastres AS expense_amount,
            e.description_ar  AS expense_description
       FROM albums a
       LEFT JOIN expenses e
              ON e.id = a.linked_expense_id AND e.status = 'posted'
      WHERE a.published_at IS NOT NULL
      ORDER BY COALESCE(a.happened_on, a.published_at) DESC
      LIMIT ?`
  ).bind(Math.min(Math.max(limit, 1), 100)).all<AlbumSummary>();
  return rows.results ?? [];
}

export async function getAlbum(
  ctx: AuthContext, db: Db, albumId: Id,
): Promise<(AlbumSummary & {
  photos: Array<{ id: Id; storage_key: string; caption_ar: string | null; taken_at: string | null }>;
}) | null> {
  const album = await db.prepare(
    `SELECT a.id, a.title_ar, a.description_ar, a.happened_on, a.published_at,
            a.linked_expense_id,
            (SELECT COUNT(*) FROM album_photos p WHERE p.album_id = a.id) AS photo_count,
            e.amount_piastres AS expense_amount,
            e.description_ar  AS expense_description
       FROM albums a
       LEFT JOIN expenses e ON e.id = a.linked_expense_id AND e.status = 'posted'
      WHERE a.id = ? AND (a.published_at IS NOT NULL OR ? = 1)`
  ).bind(albumId, can(ctx.role, 'album.create') ? 1 : 0).first<AlbumSummary>();
  if (!album) return null;

  const photos = await db.prepare(
    `SELECT id, storage_key, caption_ar, taken_at FROM album_photos
      WHERE album_id = ? AND exif_stripped = 1 ORDER BY sort_order, taken_at`
  ).bind(albumId).all<{
    id: Id; storage_key: string; caption_ar: string | null; taken_at: string | null;
  }>();

  return { ...album, photos: photos.results ?? [] };
}

/* ===================================================================== */
/* Maintenance tickets — بلاغات الصيانة                                  */
/* ===================================================================== */

export type TicketStatus =
  'open' | 'acknowledged' | 'in_progress' | 'resolved' | 'closed' | 'rejected';

export interface TicketSummary {
  id: Id; ticket_no: string; title_ar: string; description_ar: string;
  status: TicketStatus; created_at: string; resolved_at: string | null;
  resolution_ar: string; unit_label: string | null; reporter_name: string | null;
}

/**
 * A resident reports a fault. This is deliberately the lowest-friction write in
 * the whole portal — no category required, no unit required, no photo required.
 * A resident who has to classify their own broken lift before reporting it will
 * use WhatsApp instead, and then the ticket does not exist.
 */
export async function createTicket(
  ctx: AuthContext, db: Db,
  input: { titleAr: string; descriptionAr?: string; unitId?: Id; categoryId?: Id },
  clock: Clock,
): Promise<{ id: Id; ticketNo: string }> {
  const title = String(input.titleAr ?? '').trim();
  if (!title) throw new Forbidden('maintenance.report', 'اكتب المشكلة');

  // A resident may file against their own unit or against a shared area
  // (unitId omitted). Filing against SOMEBODY ELSE's unit is not a thing.
  if (input.unitId
      && !ctx.ownedUnitIds.includes(input.unitId)
      && !ctx.delegatedUnits.some(d => d.unitId === input.unitId)
      && !can(ctx.role, 'expense.record')) {
    throw new Forbidden('maintenance.report', 'الوحدة دي مش بتاعتك');
  }

  const id = newId('TKT') as Id;
  const year = clock().slice(0, 4);
  const seq = await db.prepare(
    `SELECT COUNT(*) n FROM maintenance_tickets WHERE ticket_no LIKE ?`
  ).bind(`M-${year}-%`).first<{ n: number }>();
  const ticketNo = `M-${year}-${String((seq?.n ?? 0) + 1).padStart(5, '0')}`;
  const body = String(input.descriptionAr ?? '');

  await db.prepare(
    `INSERT INTO maintenance_tickets
       (id, ticket_no, reported_by, unit_id, category_id, title_ar, description_ar,
        search_body, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,'open',?)`
  ).bind(
    id, ticketNo, ctx.personId, input.unitId ?? null, input.categoryId ?? null,
    title, body, buildSearchBody(title, body), clock(),
  ).run();

  await writeAudit(db, ctx, 'ticket.create', 'maintenance_tickets', id, null,
    { ticket_no: ticketNo, title_ar: title });
  return { id, ticketNo };
}

const TICKET_FLOW: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ['acknowledged', 'rejected'],
  acknowledged: ['in_progress', 'rejected'],
  in_progress: ['resolved'],
  resolved: ['closed', 'in_progress'],
  closed: [],
  rejected: [],
};

/**
 * Moving a ticket needs `expense.record` — the operator capability. That is the
 * right gate: the people who fix things are the people who record what fixing
 * them cost, and a resident must not be able to mark their own complaint
 * resolved.
 *
 * Rejecting or resolving requires words. "مرفوض" with no reason is how a
 * maintenance system loses the trust it was built to earn.
 */
export async function updateTicketStatus(
  ctx: AuthContext, db: Db, ticketId: Id, next: TicketStatus,
  resolutionAr: string, clock: Clock,
): Promise<void> {
  require_(ctx.role, 'expense.record');
  const row = await db.prepare(
    `SELECT status, ticket_no FROM maintenance_tickets WHERE id = ?`
  ).bind(ticketId).first<{ status: TicketStatus; ticket_no: string }>();
  if (!row) throw new NotFound('ticket');

  if (!TICKET_FLOW[row.status].includes(next)) {
    throw new Forbidden('maintenance.update',
      `مينفعش تنقل البلاغ من «${row.status}» لـ «${next}»`);
  }
  if ((next === 'rejected' || next === 'resolved') && !String(resolutionAr ?? '').trim()) {
    throw new Forbidden('maintenance.update', 'لازم تكتب اللي حصل');
  }

  const now = clock();
  await db.prepare(
    `UPDATE maintenance_tickets
        SET status = ?, resolution_ar = ?,
            acknowledged_at = CASE WHEN ? = 'acknowledged' THEN ? ELSE acknowledged_at END,
            resolved_at     = CASE WHEN ? IN ('resolved','closed') THEN ? ELSE resolved_at END
      WHERE id = ?`
  ).bind(next, resolutionAr ?? '', next, now, next, now, ticketId).run();

  await writeAudit(db, ctx, 'ticket.status', 'maintenance_tickets', ticketId,
    { status: row.status }, { status: next, resolution_ar: resolutionAr });
}

/**
 * Residents see their own tickets plus every ticket filed against a shared area,
 * because a neighbour reporting the broken gate is exactly the duplicate this
 * list exists to prevent. Staff see everything.
 */
export async function listTickets(
  ctx: AuthContext, db: Db, opts: { status?: TicketStatus; limit?: number } = {},
): Promise<TicketSummary[]> {
  const staff = can(ctx.role, 'expense.record');
  const units = ctx.ownedUnitIds.length > 0 ? ctx.ownedUnitIds : [''];
  const placeholders = units.map(() => '?').join(',');

  const rows = await db.prepare(
    `SELECT t.id, t.ticket_no, t.title_ar, t.description_ar, t.status,
            t.created_at, t.resolved_at, t.resolution_ar,
            CASE WHEN t.unit_id IS NULL THEN NULL
                 ELSE b.name_ar || ' — ' || u.unit_number END AS unit_label,
            CASE WHEN ? = 1 THEN pr.full_name ELSE NULL END AS reporter_name
       FROM maintenance_tickets t
       LEFT JOIN units u ON u.id = t.unit_id
       LEFT JOIN buildings b ON b.id = u.building_id
       LEFT JOIN profiles pr ON pr.id = t.reported_by
      WHERE (? = 1
             OR t.reported_by = ?
             OR t.unit_id IS NULL
             OR t.unit_id IN (${placeholders}))
        AND (? IS NULL OR t.status = ?)
      ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1
                             WHEN 'acknowledged' THEN 2 ELSE 3 END,
               t.created_at DESC
      LIMIT ?`
  ).bind(
    staff ? 1 : 0, staff ? 1 : 0, ctx.personId, ...units,
    opts.status ?? null, opts.status ?? null,
    Math.min(Math.max(opts.limit ?? 50, 1), 200),
  ).all<TicketSummary>();
  return rows.results ?? [];
}

/**
 * The caller's own units, for the "where is the problem?" picker.
 *
 * Deliberately NOT `getUnitBalances()`: that function is gated behind
 * `settings.unit_status_public`, which is OFF until the general assembly votes
 * (Q11). Reusing it here would mean a resident cannot file a ticket against
 * their own flat because the village has not yet agreed to publish arrears —
 * two unrelated questions, one switch. This asks the only question that matters
 * for a ticket: which units are yours?
 */
export async function listMyUnits(
  ctx: AuthContext, db: Db,
): Promise<Array<{ id: Id; label: string }>> {
  const ids = [...ctx.ownedUnitIds, ...ctx.delegatedUnits.map(d => d.unitId)];
  if (ids.length === 0) return [];
  const rows = await db.prepare(
    `SELECT u.id, b.name_ar || ' — ' || u.unit_number AS label
       FROM units u JOIN buildings b ON b.id = u.building_id
      WHERE u.id IN (${ids.map(() => '?').join(',')})
      ORDER BY b.name_ar, u.unit_number`
  ).bind(...ids).all<{ id: Id; label: string }>();
  return rows.results ?? [];
}

/** Counts for the admin dashboard badge. */
export async function ticketCounts(
  ctx: AuthContext, db: Db,
): Promise<{ open: number; in_progress: number }> {
  require_(ctx.role, 'expense.record');
  const r = await db.prepare(
    `SELECT SUM(status = 'open') AS open, SUM(status = 'in_progress') AS in_progress
       FROM maintenance_tickets`
  ).first<{ open: number | null; in_progress: number | null }>();
  return { open: r?.open ?? 0, in_progress: r?.in_progress ?? 0 };
}
