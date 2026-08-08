/**
 * lib/db/map.ts — خريطة القرية. C13 / 07_VILLAGE_MAP_SPEC.md
 *
 * A navigation layer over the register, never a source of truth about it. The
 * whole module is arranged around one sentence from the spec:
 *
 *   > "Never create production `buildings` or `units` rows from image labels."
 *
 * There is no function here that writes to `buildings`. A hotspot references
 * `buildings(id)`, so a label for a building that does not exist cannot be
 * saved, let alone published — and `trg_map_publish_needs_verified_features`
 * refuses publication while any hotspot is unlinked or unverified.
 *
 * ## Why the resident query returns hotspots AND a plain list
 *
 * Spec §5: "Image tapping is optional. A keyboard- and screen-reader-friendly
 * building list is always present." The list is not a fallback for when the
 * image fails to load; it is the equal path. A 71-year-old on a 360px screen
 * hitting a polygon with a fingertip is the interaction most likely to fail,
 * and the buttons underneath are the one most likely to work.
 *
 * ## What it never returns
 *
 * No phone number, no owner name, no unit note, no receipt, no per-unit
 * balance. The map must not become a new route to private data (spec §3.6):
 * `buildingSummary` returns the code, the name, the flat COUNT, and whatever
 * public maintenance work exists. Whether it may also show aggregate collection
 * status is Q11's decision, not this file's — `settings.unit_status_public`
 * gates it, and it is OFF until the assembly says otherwise.
 */

import type { AuthContext, Id } from '../../types/domain.js';
import { require_ } from '../rbac.js';
import type { Db } from './driver.js';
import { LedgerRefused, asRefusal } from './driver.js';
import { newId, mutate, NotFound, type Clock } from './index.js';

export interface MapFeature {
  feature_id: string;
  building_id: string;
  label_ar: string;
  x: number; y: number; w: number; h: number;
  building_code: string;
  building_name_ar: string | null;
}

export interface PublishedMap {
  map_id: string;
  title_ar: string;
  display_storage_key: string;
  version_label: string;
  coverage_note_ar: string;
  published_at: string | null;
  features: MapFeature[];
}

/**
 * The map a resident sees, or `null` when the board has not published one.
 *
 * `null` is a normal state, not an error: for most of this portal's life there
 * will be a drawing the board has not finished verifying, and the screen says
 * so rather than showing an unverified plan.
 */
export async function publishedMap(ctx: AuthContext, db: Db): Promise<PublishedMap | null> {
  require_(ctx.role, 'profile.edit_own');   // any authenticated member
  const rows = await db.prepare(
    `SELECT map_id, title_ar, display_storage_key, version_label, coverage_note_ar,
            published_at, feature_id, building_id, label_ar, x, y, w, h,
            building_code, building_name_ar
       FROM v_published_map`
  ).all<MapFeature & {
    map_id: string; title_ar: string; display_storage_key: string;
    version_label: string; coverage_note_ar: string; published_at: string | null;
  }>();
  const list = rows.results ?? [];
  if (list.length === 0) return null;

  const first = list[0]!;
  return {
    map_id: first.map_id,
    title_ar: first.title_ar,
    display_storage_key: first.display_storage_key,
    version_label: first.version_label,
    coverage_note_ar: first.coverage_note_ar,
    published_at: first.published_at,
    features: list.map(r => ({
      feature_id: r.feature_id, building_id: r.building_id, label_ar: r.label_ar,
      x: r.x, y: r.y, w: r.w, h: r.h,
      building_code: r.building_code, building_name_ar: r.building_name_ar,
    })),
  };
}

/**
 * Every building in the REGISTER, whether or not the map covers it.
 *
 * This is the list the spec insists on, and it is deliberately sourced from
 * `buildings` rather than from the map: the drawing shows roughly 14–46 and the
 * village may well have more. A resident whose building is not on the picture
 * must still be able to reach it, and seeing it listed without a hotspot is the
 * honest rendering of "the map is partial".
 */
export async function buildingList(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'profile.edit_own');
  const r = await db.prepare(
    `SELECT b.id, b.code, b.name_ar,
            (SELECT COUNT(*) FROM units u WHERE u.building_id = b.id AND u.is_active = 1) AS units,
            EXISTS (SELECT 1 FROM v_published_map m WHERE m.building_id = b.id) AS on_map
       FROM buildings b
      WHERE b.is_active = 1
      ORDER BY b.sort_order, CAST(b.code AS INTEGER), b.code`
  ).all<{ id: string; code: string; name_ar: string | null; units: number; on_map: number }>();
  return r.results ?? [];
}

export interface BuildingSummary {
  id: string;
  code: string;
  name_ar: string | null;
  units: number;
  on_map: number;
  /** Only when `settings.unit_status_public = 1` (Q11). Otherwise null. */
  collected_piastres: number | null;
  outstanding_piastres: number | null;
}

/**
 * The building record a hotspot opens.
 *
 * Aggregate only, and the aggregate itself is gated: publishing which buildings
 * are behind on payments is a general-assembly decision (Q11), stored as
 * `unit_status_public` and OFF by default. When it is off this returns nulls
 * rather than zeros — a zero would read as "this building owes nothing", which
 * is a false statement rather than a withheld one.
 */
export async function buildingSummary(
  ctx: AuthContext, db: Db, buildingId: Id,
): Promise<BuildingSummary> {
  require_(ctx.role, 'profile.edit_own');
  const b = await db.prepare(
    `SELECT b.id, b.code, b.name_ar,
            (SELECT COUNT(*) FROM units u WHERE u.building_id = b.id AND u.is_active = 1) AS units,
            EXISTS (SELECT 1 FROM v_published_map m WHERE m.building_id = b.id) AS on_map,
            (SELECT unit_status_public FROM settings WHERE id = 1) AS public_status
       FROM buildings b
      WHERE b.id = ? AND b.is_active = 1`
  ).bind(buildingId).first<BuildingSummary & { public_status: number }>();
  if (!b) throw new NotFound('العمارة دي مش موجودة');

  if (!b.public_status) {
    return { ...b, collected_piastres: null, outstanding_piastres: null };
  }
  const agg = await db.prepare(
    `SELECT COALESCE(SUM(ub.paid_piastres), 0)        AS collected_piastres,
            COALESCE(SUM(ub.outstanding_piastres), 0) AS outstanding_piastres
       FROM v_unit_balance ub
       JOIN units u ON u.id = ub.unit_id
      WHERE u.building_id = ?`
  ).bind(buildingId).first<{ collected_piastres: number; outstanding_piastres: number }>();
  return { ...b, ...agg! };
}

/** Public maintenance work on a building — album posts, never private notes. */
export async function buildingWork(ctx: AuthContext, db: Db, buildingId: Id) {
  require_(ctx.role, 'profile.edit_own');
  const r = await db.prepare(
    `SELECT a.id, a.title_ar, a.happened_on
       FROM albums a
      WHERE a.building_id = ? AND a.published_at IS NOT NULL
      ORDER BY a.happened_on DESC LIMIT 5`
  ).bind(buildingId).all<{ id: string; title_ar: string; happened_on: string }>();
  return r.results ?? [];
}

/* ===================================================================== */
/* Admin: drafting, verifying, publishing                                */
/* ===================================================================== */

export async function listMaps(ctx: AuthContext, db: Db) {
  require_(ctx.role, 'settings.edit');
  const r = await db.prepare(
    `SELECT d.id, d.title_ar, d.version_label, d.status, d.coverage_note_ar,
            d.created_at, d.published_at,
            (SELECT COUNT(*) FROM building_map_features f WHERE f.map_document_id = d.id) AS total,
            (SELECT COUNT(*) FROM building_map_features f
              WHERE f.map_document_id = d.id AND f.building_id IS NULL) AS unlinked,
            (SELECT COUNT(*) FROM building_map_features f
              WHERE f.map_document_id = d.id AND f.verification_status = 'unverified') AS unverified
       FROM map_documents d
      ORDER BY d.status, d.created_at DESC LIMIT 20`
  ).all<{
    id: string; title_ar: string; version_label: string; status: string;
    coverage_note_ar: string; created_at: string; published_at: string | null;
    total: number; unlinked: number; unverified: number;
  }>();
  return r.results ?? [];
}

export async function mapFeatures(ctx: AuthContext, db: Db, mapId: Id) {
  require_(ctx.role, 'settings.edit');
  const r = await db.prepare(
    `SELECT f.id, f.building_id, f.label_ar, f.x, f.y, f.w, f.h,
            f.verification_status, b.code AS building_code
       FROM building_map_features f
       LEFT JOIN buildings b ON b.id = f.building_id
      WHERE f.map_document_id = ?
      ORDER BY f.sort_order, f.label_ar`
  ).bind(mapId).all<{
    id: string; building_id: string | null; label_ar: string;
    x: number; y: number; w: number; h: number;
    verification_status: string; building_code: string | null;
  }>();
  return r.results ?? [];
}

/**
 * ⭐ Verify one hotspot: "I have checked, on the ground, that this shape on the
 * drawing is that building in the register."
 *
 * This is the act C13 is about, and it is why the map cannot be generated. It
 * carries a name and a time because `trg_map_feature_verify_needs_signature`
 * refuses it otherwise — and because a year from now the only defence against
 * "the map sent me to the wrong block" is being able to say who checked it.
 */
export async function verifyFeature(
  ctx: AuthContext, db: Db, featureId: Id, buildingId: Id | null, now: Clock,
): Promise<void> {
  require_(ctx.role, 'settings.edit');

  const f = await db.prepare(
    `SELECT f.id, f.building_id, f.map_document_id,
            (SELECT status FROM map_documents d WHERE d.id = f.map_document_id) AS map_status
       FROM building_map_features f WHERE f.id = ?`
  ).bind(featureId).first<{ id: string; building_id: string | null; map_status: string }>();
  if (!f) throw new NotFound('الموقع ده مش موجود');
  if (f.map_status === 'published') {
    throw new LedgerRefused('الخريطة دي منشورة — لو فيه تعديل اعمل نسخة جديدة');
  }

  const target = buildingId ?? f.building_id;
  if (!target) {
    throw new LedgerRefused('اربط الموقع بعمارة موجودة في السجل الأول');
  }
  const exists = await db.prepare(`SELECT id FROM buildings WHERE id = ? AND is_active = 1`)
    .bind(target).first();
  if (!exists) {
    // C13, said out loud: a label is not a building.
    throw new LedgerRefused('العمارة دي مش موجودة في السجل. الخريطة مش بتعمل عمارات جديدة.');
  }

  try {
    await mutate(db, ctx,
      { action: 'map.verify_feature', table: 'building_map_features', entityId: featureId,
        after: { building: target } },
      db.prepare(
        `UPDATE building_map_features
            SET building_id = ?, verification_status = 'board_verified',
                verified_by = ?, verified_at = ?
          WHERE id = ?`
      ).bind(target, ctx.personId, now(), featureId),
    );
  } catch (e) {
    throw asRefusal(e);
  }
}

export async function rejectFeature(
  ctx: AuthContext, db: Db, featureId: Id, now: Clock,
): Promise<void> {
  require_(ctx.role, 'settings.edit');
  await mutate(db, ctx,
    { action: 'map.reject_feature', table: 'building_map_features', entityId: featureId,
      after: { at: now() } },
    db.prepare(
      `UPDATE building_map_features
          SET verification_status = 'rejected', verified_by = NULL, verified_at = NULL
        WHERE id = ?`
    ).bind(featureId),
  );
}

/**
 * Publish. The triggers do the refusing; this produces the sentence.
 *
 * `ux_one_published_map` allows exactly one published map, so the previous one
 * is archived in the same batch — not deleted. A resident who screenshotted last
 * year's plan should still be able to find out which version they were looking
 * at.
 */
export async function publishMap(
  ctx: AuthContext, db: Db, mapId: Id, now: Clock,
): Promise<void> {
  require_(ctx.role, 'settings.edit');

  const blockers = await db.prepare(
    `SELECT total, unlinked, unverified, rejected FROM v_map_publication_blockers WHERE map_id = ?`
  ).bind(mapId).first<{ total: number; unlinked: number; unverified: number; rejected: number }>();
  if (!blockers) throw new NotFound('الخريطة دي مش موجودة أو منشورة خلاص');
  if (blockers.total === 0) {
    throw new LedgerRefused('الخريطة دي مفيهاش أي عمارة متحددة — مينفعش تتنشر');
  }
  if (blockers.unlinked > 0 || blockers.unverified > 0) {
    throw new LedgerRefused(
      'فيه مواقع لسه مش متأكد منها أو مش مربوطة بعمارة. أكّدها كلها الأول.');
  }

  const ts = now();
  try {
    await mutate(db, ctx,
      { action: 'map.publish', table: 'map_documents', entityId: mapId,
        after: { features: blockers.total, at: ts } },
      db.prepare(`UPDATE map_documents SET status = 'archived' WHERE status = 'published'`),
      db.prepare(
        `UPDATE map_documents SET status = 'published', published_by = ?, published_at = ?
          WHERE id = ? AND status = 'draft'`
      ).bind(ctx.personId, ts, mapId),
    );
  } catch (e) {
    throw asRefusal(e);
  }
}

export interface NewMapDraft {
  titleAr: string;
  versionLabel: string;
  coverageNoteAr: string;
  sourceStorageKey: string;
  displayStorageKey: string;
  sourceSha256: string;
  displaySha256: string;
}

export async function createMapDraft(
  ctx: AuthContext, db: Db, m: NewMapDraft,
): Promise<string> {
  require_(ctx.role, 'settings.edit');
  if (!m.coverageNoteAr?.trim()) {
    // The honest sentence — «الخريطة دي جزء من القرية مش كلها» — is the one a
    // board omits by accident, so it is required rather than encouraged.
    throw new LedgerRefused('اكتب تغطية الخريطة: هي بتغطي القرية كلها ولا جزء منها؟');
  }
  const id = newId('MAP');
  try {
    await mutate(db, ctx,
      { action: 'map.create_draft', table: 'map_documents', entityId: id,
        after: { version: m.versionLabel } },
      db.prepare(
        `INSERT INTO map_documents (id, title_ar, source_storage_key, display_storage_key,
           source_sha256, display_sha256, version_label, coverage_note_ar, status, created_by)
         VALUES (?,?,?,?,?,?,?,?, 'draft', ?)`
      ).bind(id, m.titleAr.trim(), m.sourceStorageKey, m.displayStorageKey,
             m.sourceSha256, m.displaySha256, m.versionLabel.trim(),
             m.coverageNoteAr.trim(), ctx.personId),
    );
  } catch (e) {
    throw asRefusal(e);
  }
  return id;
}

export async function addFeature(
  ctx: AuthContext, db: Db, mapId: Id,
  f: { labelAr: string; x: number; y: number; w: number; h: number; buildingId?: Id | null },
): Promise<string> {
  require_(ctx.role, 'settings.edit');
  for (const [name, v] of [['x', f.x], ['y', f.y], ['w', f.w], ['h', f.h]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 10000) {
      throw new LedgerRefused(`الإحداثي ${name} لازم يكون رقم بين 0 و 10000`);
    }
  }
  const id = newId('MPF');
  try {
    await mutate(db, ctx,
      { action: 'map.add_feature', table: 'building_map_features', entityId: id,
        after: { map: mapId, label: f.labelAr } },
      db.prepare(
        `INSERT INTO building_map_features (id, map_document_id, building_id, label_ar,
           x, y, w, h, sort_order)
         VALUES (?,?,?,?,?,?,?,?, (SELECT COALESCE(MAX(sort_order),0)+10
                                     FROM building_map_features WHERE map_document_id = ?))`
      ).bind(id, mapId, f.buildingId ?? null, f.labelAr.trim(), f.x, f.y, f.w, f.h, mapId),
    );
  } catch (e) {
    throw asRefusal(e);
  }
  return id;
}

/** The display image key for one map version, for the admin preview. */
export async function displayKey(ctx: AuthContext, db: Db, mapId: Id): Promise<string> {
  require_(ctx.role, 'settings.edit');
  const r = await db.prepare(`SELECT display_storage_key k FROM map_documents WHERE id = ?`)
    .bind(mapId).first<{ k: string }>();
  return r?.k ?? '';
}
