/**
 * lib/search/fold.ts — Arabic orthographic folding for search.
 *
 * ## Why this file has to exist
 *
 * `migrations/0004_content_and_system.sql` builds `posts_fts` with
 * `tokenize = "unicode61 remove_diacritics 2"`. That option strips combining
 * marks, and people assume it therefore "handles Arabic". It does not. FTS5's
 * unicode61 tokenizer knows nothing about Arabic orthography, and the failures
 * are exactly the words a resident will type:
 *
 *   · «الاجتماع» vs «الإجتماع»   — hamza written or omitted on the alef
 *   · «صيانه»    vs «صيانة»      — ta marbuta written as ha, which is how most
 *                                   people type on a phone keyboard
 *   · «مبني»     vs «مبنى»       — alef maqsura vs ya, routinely interchanged
 *   · «١٤»       vs «14»         — Arabic-Indic digits from an Arabic keyboard
 *
 * Every one of those pairs is the SAME WORD to a reader and a DIFFERENT TOKEN to
 * FTS5. Without folding, a resident searching for the announcement they were
 * told about gets "no results", concludes the portal lost it, and goes back to
 * WhatsApp — which is the single outcome CP-6 exists to prevent.
 *
 * ## The rule that makes this safe
 *
 * Folding is applied to BOTH sides — the text written into `posts.search_body`
 * and the query typed by the user — through this one function. A folding applied
 * to only one side is worse than none: it silently changes which documents are
 * reachable. `foldArabic()` is therefore the only way anything reaches
 * `posts_fts`, on write or on read.
 *
 * Display text is never folded. `posts.title_ar` and `body_ar` keep the author's
 * exact orthography; `search_body` is a derived index column nobody ever reads.
 */

/**
 * Combining marks that carry no lexical weight in a search index:
 * tashkeel (U+064B–U+0652), superscript alef (U+0670), Quranic annotation marks,
 * and the Arabic letter-extension tatweel (U+0640) which is pure typography.
 */
const MARKS = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭـ]/g;

/** Arabic-Indic (U+0660–) and Eastern Arabic-Indic (U+06F0–) digits → ASCII. */
const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g;

/**
 * Letter forms that are the same letter for search purposes.
 *
 * Note `ؤ`/`ئ` fold to their carrier letters (`و`/`ي`) rather than to hamza:
 * a resident typing «مسئول» and one typing «مسؤول» must find each other, and
 * both must find «مسءول» — folding to the carrier is what makes all three meet.
 */
/**
 * The same rules as `LETTER_FOLDINGS` below, one character at a time.
 *
 * A second form exists because a `LIKE` filter has to fold BOTH sides and only
 * one of them is in TypeScript: the stored name is folded by a `REPLACE` chain
 * inside the query (`lib/db/onboarding.ts`), which can express single-character
 * substitutions and nothing else. Deriving that chain from this list is what
 * stops the two halves from drifting apart — a fold applied to the query but
 * not to the column silently returns nothing, which reads as "that resident
 * does not exist".
 */
export const LETTER_FOLD_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['آ', 'ا'], ['أ', 'ا'], ['إ', 'ا'], ['ٱ', 'ا'], ['ٲ', 'ا'], ['ٳ', 'ا'], ['ٵ', 'ا'],
  ['ة', 'ه'], ['ى', 'ي'], ['ؤ', 'و'], ['ئ', 'ي'], ['ء', ''],
];

/**
 * Fold ONLY the letter shapes, leaving punctuation, spacing and case alone.
 *
 * `foldArabic` turns every non-letter into a space, which is right for an FTS5
 * index built of tokens and wrong for a `LIKE` over a whole name: it would make
 * «د. سامح» — typed exactly as the register spells it — match nothing, because
 * the query lost the full stop the column still has.
 */
export function foldArabicLetters(input: string): string {
  let s = String(input ?? '').normalize('NFKC');
  for (const [from, to] of LETTER_FOLD_PAIRS) s = s.split(from).join(to);
  return s;
}

const LETTER_FOLDINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[آأإٱٲٳٵ]/g, 'ا'], // آ أ إ ٱ ٲ ٳ ٵ → ا
  [/ة/g, 'ه'],                                        // ة → ه
  [/ى/g, 'ي'],                                        // ى → ي
  [/ؤ/g, 'و'],                                        // ؤ → و
  [/ئ/g, 'ي'],                                        // ئ → ي
  [/ء/g, ''],                                              // ء standalone → dropped
];

/**
 * Fold one string into its search form.
 *
 * Idempotent — `fold(fold(x)) === fold(x)` — which matters because a post edited
 * twice must not drift into a different index token on the second save.
 */
export function foldArabic(input: string): string {
  let s = String(input ?? '').normalize('NFKC');
  s = s.replace(MARKS, '');
  for (const [pattern, replacement] of LETTER_FOLDINGS) s = s.replace(pattern, replacement);
  s = s.replace(ARABIC_INDIC_DIGITS, d => {
    const code = d.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
  // Punctuation (Arabic and Latin) becomes space so «قرار-14» and «قرار 14»
  // tokenize identically. Letters, digits and marks survive.
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Build the FTS5 MATCH expression for a user's query.
 *
 * Two things this must do that a naive `db.bind(userInput)` does not:
 *
 * 1. **Neutralise FTS5 syntax.** `"`, `*`, `NEAR`, `OR`, `-` and `(` are all
 *    operators. A resident typing a quote mark would get a syntax error rather
 *    than results, and `-` at the start of a word silently means NOT. Folding
 *    already stripped punctuation; each token is then re-quoted, which makes it
 *    a literal and neutralises bare keywords like OR.
 * 2. **Prefix-match the final token.** Someone typing «اجتم» is mid-word, and a
 *    search that only matches whole words feels broken while you type.
 *
 * Returns `null` for an empty query so the caller can show the browse view
 * rather than running a match that would throw.
 */
export function buildMatchQuery(rawQuery: string): string | null {
  const folded = foldArabic(rawQuery);
  if (!folded) return null;
  const tokens = folded.split(' ').filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens
    .map((token, i) => {
      const quoted = `"${token.replace(/"/g, '')}"`;
      return i === tokens.length - 1 ? `${quoted}*` : quoted;
    })
    .join(' AND ');
}

/**
 * The text that goes into `posts.search_body`: title and body folded together,
 * so a word in either is findable through one column.
 */
export function buildSearchBody(titleAr: string, bodyAr: string): string {
  return foldArabic(`${titleAr} ${bodyAr}`);
}

/**
 * Highlight the matched terms in a plain-text snippet for display.
 *
 * The comparison happens on folded text but the OUTPUT is the original string,
 * so a resident who searched «صيانه» sees «صيانة» highlighted as it was written.
 * Escaping is the caller's job — this returns marker positions, not HTML — so
 * a post title can never inject markup through the search box.
 */
export function matchRanges(original: string, rawQuery: string): Array<[number, number]> {
  const tokens = foldArabic(rawQuery).split(' ').filter(Boolean);
  if (tokens.length === 0) return [];

  // Fold character-by-character so folded offsets map back to original offsets.
  // A fold can delete a character (a mark) but never adds one, so the map is
  // monotonic and every folded index has a well-defined original index.
  const map: number[] = [];
  let foldedText = '';
  for (let i = 0; i < original.length; i++) {
    const piece = foldArabic(original[i]!);
    for (let j = 0; j < piece.length; j++) map.push(i);
    foldedText += piece;
  }

  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    let from = 0;
    for (;;) {
      const at = foldedText.indexOf(token, from);
      if (at === -1) break;
      const start = map[at];
      const end = map[Math.min(at + token.length - 1, map.length - 1)];
      if (start !== undefined && end !== undefined) ranges.push([start, end + 1]);
      from = at + token.length;
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}
