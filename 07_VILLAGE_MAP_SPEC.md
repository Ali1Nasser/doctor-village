# 07 — Village Map & Building-Link Specification

**Product:** بوابة قرية الأطباء — خريطة القرية  
**Version:** 1.0 — draft for board verification  
**Status:** the interaction is approved for the pack; the drawing and building coverage are **not yet authoritative**

---

## 1. Evidence and epistemic status

The pack contains two versions of the user-supplied reference image:

| Asset | Purpose | SHA-256 |
|---|---|---|
| `assets/maps/village-map-source.jpg` | Untouched source screenshot | `5300a7c1c04f1bc5c0c5f438fdc18a3331c7a18c70cb9100e0e4ab818601742e` |
| `assets/maps/village-map-display.jpg` | Deterministically rotated for readable display; metadata stripped | `9f3358fe279609b42d0a40067a1f9f15ef2320c871fd5c86e45467b64da5746b` |

**Visually confirmed from the supplied image:** it is a photographed/cropped plan, not a GIS or
survey file. Labels in the visible portion appear within the range **14–46**. The image does not
prove the village's total building count, the completeness of every number in that range, the
existence or location of buildings 1–13, any unit count, or any exact legal boundary.

**Therefore:** the source is a useful visual reference and nothing more until the board signs off a
mapping version. `assets/maps/village-map-manifest.json` records that state in machine-readable form.

## 2. Product goal

Give an authenticated resident one simple, responsive page where they can:

1. See the village layout and recognize where a building is.
2. Search or choose a building number without having to hit a tiny area on the image.
3. Open the authoritative building record already stored in the portal.
4. See only board-approved aggregate building information; never resident contact details or
   another resident's receipt image.

The map is a navigation layer over the database. It is **never** the source of truth for buildings,
units, owners, dues, or balances.

## 3. Non-negotiable rules

1. **Never create production `buildings` or `units` rows from image labels.** The approved owner
   register/import file is authoritative.
2. A published hotspot must link to an existing `buildings.id`; a label alone is insufficient.
3. Draft and published map versions are distinct. Residents see only the latest published version.
4. The original source image is immutable. Display derivatives are reproducible and checksummed.
5. No Google Maps, Mapbox, paid tiles, geocoding API, external script, API key, or runtime request is
   needed. The asset and overlay ship with the site at zero recurring cost.
6. The map reveals no phone number, owner name, unit note, receipt image, or private balance.
7. The map is labelled **«خريطة إرشادية — ليست مخططًا مساحيًا»**.
8. Image tapping is optional. A keyboard- and screen-reader-friendly building list is always present.
9. Financial colours are disabled until Q11's transparency policy is approved in writing. When
   enabled, colour must be accompanied by text and an icon and must derive only from posted ledger
   data, never submitted/pending receipts.

## 4. Routes and journeys

### `/map` — خريطة القرية

- Entry point: a prominent **«خريطة القرية»** card on the home page. It does not consume a fifth
  bottom-navigation slot.
- Header: title, short disclaimer, and last board-approved update date.
- Main view: responsive plan image with optional pan/zoom and verified SVG/DOM hotspots.
- Fallback selector: search field plus large building-number buttons, sorted numerically.
- Selection panel: building number/name, verification badge, aggregate collection status if allowed,
  latest public maintenance item, and **«افتح سجل العمارة»**.
- If a feature is not yet verified, the action is disabled and the page says who can correct it.

### `/buildings/:buildingId` — سجل العمارة

- Public-to-members facts only: official code/name, public notices, public maintenance work, and
  aggregate collection values permitted by the approved transparency tier.
- A resident's own unit is identified only to that resident/delegate. Neighbours do not gain a new
  route to private data through the map.

### `/admin/map` — إدارة الخريطة

- Upload a new draft reference; preserve every prior source and checksum.
- Add/edit a hotspot in normalized coordinates, then link it to an existing building record.
- Preview as resident, run validation, and publish with a reason.
- Publishing and unpublishing are admin/developer actions and always write `audit_log` entries.

## 5. Responsive and accessible interaction

### Mobile (360 px and up)

- The map fills the content width; no horizontal page overflow.
- Pan/zoom is an enhancement, not the only way to select a building.
- Building buttons are at least 48×48 px with 8 px spacing.
- After selection, the details card appears directly below the map and receives focus.
- A low-resolution preview appears first; the full image loads on demand.

### Desktop

- Map and selected-building panel use a two-column layout.
- Wheel/pinch zoom must not trap page scrolling; explicit `+`, `−`, and **«إعادة الضبط»** buttons exist.

### Accessibility

- The image has a concise Arabic description, not a filename.
- Hotspots are real `<button>` elements with labels such as **«عمارة 24»** and visible focus rings.
- The ordered building list exposes the same actions as the visual overlay.
- Current selection uses text + icon + outline, never colour alone.
- Screen-reader announcement after selection: **«تم اختيار عمارة 24. حالة الربط: معتمدة.»**
- A text-only layout description is available when the image cannot be seen or loaded.

## 6. Data contract

### `map_documents`

| column | type | rule |
|---|---|---|
| `id` | uuid/text pk | immutable |
| `title_ar` | text | user-facing title |
| `source_asset_key` | text | private/admin source |
| `display_asset_key` | text | published derivative |
| `source_sha256` | text | required, unique per byte-identical source |
| `version_label` | text | human-readable, e.g. `2026-08-04-draft-1` |
| `coverage_note_ar` | text | required; must state partial/full |
| `status` | text | `draft` \| `published` \| `archived` |
| `created_by`, `created_at` | identity/time | audited |
| `published_by`, `published_at` | identity/time nullable | required when published |

### `building_map_features`

| column | type | rule |
|---|---|---|
| `id` | uuid/text pk | immutable |
| `map_document_id` | fk → `map_documents` | required |
| `building_id` | fk → `buildings` nullable in draft | **required before publish** |
| `label_ar` | text | copied for display; not identity |
| `geometry_json` | text/json | normalized polygon/point, not raw pixels |
| `verification_status` | text | `unverified` \| `board_verified` \| `rejected` |
| `verified_by`, `verified_at` | identity/time nullable | required for `board_verified` |
| `sort_order` | integer | numeric building order |

Geometry coordinates use integer units from `0` to `10,000` in each axis. This keeps overlays stable
when the displayed image is resized. Do not store CSS pixels.

### Publication invariants

- Exactly one published `map_documents` row at a time.
- Every feature in a published version is `board_verified` and has a valid `building_id`.
- A building appears at most once per map version.
- The asset checksum must match the manifest before publication.
- Publication fails if any feature is orphaned, outside bounds, duplicated, or unverified.

## 7. Permission and privacy matrix

| Action | developer | admin | operator | resident |
|---|:--:|:--:|:--:|:--:|
| View published map | ✔ | ✔ | ✔ | ✔ |
| Open permitted building summary | ✔ | ✔ | ✔ | ✔ |
| View draft/source map | ✔ | ✔ | ✖ | ✖ |
| Edit/link features | ✔ | ✔ | ✖ | ✖ |
| Publish/archive a map version | ✔ | ✔ | ✖ | ✖ |

All map reads still pass through `lib/db/` with `AuthContext`. The public display asset may be a
versioned static file because it contains no personal data; original/admin drafts remain protected.

## 8. Cost, performance, and offline behaviour

- The display image is a versioned static asset in Pages/GitHub. Runtime cost: zero; no map vendor.
- Target display asset: ≤ 500 KB and ≤ 2,000 px on the long edge. Current derivative is ~298 KB.
- Cache with a content hash and `immutable`; invalidate by filename/version, not short cache headers.
- The last published map and building index are available in the read-only offline cache.
- If the image fails, the building list and records still work.

## 9. Acceptance criteria

- [ ] At 360 px, the page has no horizontal overflow and all building buttons are ≥ 48×48 px.
- [ ] Keyboard-only and screen-reader users can select every published building without the image.
- [ ] Selecting a verified building opens the same authoritative record from both hotspot and list.
- [ ] A draft/unverified feature can never appear to residents.
- [ ] A map label can never create or rename a production building record.
- [ ] A resident cannot obtain another resident's phone, receipt, note, or private unit data through
      any map/building endpoint.
- [ ] With the image blocked, the text/list fallback remains fully usable.
- [ ] Network panel shows no third-party map request and no API key.
- [ ] The board verifies coverage, labels, and links in writing before first publication.

## 10. Owner/board input still required

1. The official total number of buildings and the approved building/unit register (existing Q1).
2. Whether the supplied picture is intentionally only the 14–46 section and whether a complete,
   straight-on copy exists.
3. A board-approved mapping between every visual label and the corresponding `buildings.id`.
4. Whether residents may see aggregate collection status by building; default is **no colour/status
   until Q11 is approved**.

