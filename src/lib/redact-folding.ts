/**
 * Characters that render as a colon separator. Folded to `:` in the matching
 * view so a look-alike cannot hide a header from the label pattern.
 */
const COLON_CONFUSABLES = new Set([
  "\uFF1A", "\uFE55", "\uFE13", "\uA789", "\u02D0", "\u2236",
  "\u205A", "\u0589", "\u1361", "\u16EC", "\u1803", "\u2982", "\u2AF6", "\uFE30",
]);

/**
 * Characters dropped from the matching view: anything with no visible width
 * that could split a label into pieces the pattern no longer recognizes.
 * `\p{Default_Ignorable_Code_Point}` is the systematic answer — it covers the
 * zero-width set, the bidi isolates and marks, the Mongolian vowel separator,
 * and the variation selectors in one property instead of a list that review
 * keeps finding another member of. `\p{Cf}` and combining marks are folded too.
 */
const INVISIBLE_FORMAT = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Mn}\p{Me}]/u;

/**
 * HTML named character references.
 *
 * A hand-picked list is a coverage promise nobody can keep — review found
 * `&ii;`, `&ee;`, and `&DifferentialD;` decoding to compatibility letters that
 * NFKD already maps onto `i`, `e`, and `d`, and the WHATWG table holds roughly
 * 2200 entries. Neither Bun nor Node exposes that table, and pulling in a
 * dependency to spell a header name is the wrong trade for this path.
 *
 * So names are not resolved at all. A named reference sitting inside a
 * credential label is folded to a single placeholder character of unknown
 * identity, and the label alternation accepts that placeholder wherever a
 * letter may appear. Every named entity is covered, present and future,
 * without claiming to know what any of them mean.
 */
const NAMED_ENTITY_PLACEHOLDER = "\u0001";

/**
 * The handful of named references that spell a SEPARATOR rather than a letter.
 * These have to resolve exactly, because the placeholder stands in for a letter
 * position and a separator is structure, not a character of the name.
 */
const SEPARATOR_ENTITIES = new Map<string, string>([
  ["colon", ":"], ["semi", ";"], ["equals", "="], ["quot", '"'], ["apos", "'"],
  ["lt", "<"], ["gt", ">"], ["amp", "&"], ["sol", "/"], ["lowbar", "_"],
  ["hyphen", "-"], ["dash", "-"], ["ndash", "-"], ["mdash", "-"], ["minus", "-"],
  ["period", "."], ["comma", ","], ["num", "#"], ["nbsp", " "],
]);

/**
 * Latin look-alikes for the ASCII letters that appear in credential labels.
 * Cyrillic `а`/`е`, Greek `ο`, fullwidth forms and the mathematical alphabets
 * all render as the label to a human, so the matching view folds them back.
 * NFKD handles the width/font variants; this table covers the cross-script
 * homoglyphs NFKD deliberately leaves alone.
 */
const LETTER_CONFUSABLES = new Map<string, string>([
  // Cyrillic
  ["\u0430", "a"], ["\u0435", "e"], ["\u043E", "o"], ["\u0440", "p"], ["\u0441", "c"],
  ["\u0445", "x"], ["\u0443", "y"], ["\u04BB", "h"], ["\u0455", "s"], ["\u0456", "i"],
  ["\u0458", "j"], ["\u043A", "k"], ["\u0442", "t"], ["\u0432", "b"], ["\u043C", "m"],
  ["\u043D", "h"], ["\u0501", "d"], ["\u0503", "g"], ["\u051B", "q"], ["\u051D", "w"],
  ["\u04CF", "l"], ["\u0261", "g"], ["\u04AB", "c"], ["\u04BD", "e"], ["\u0459", "k"],
  // Greek
  ["\u03B1", "a"], ["\u03BF", "o"], ["\u03C1", "p"], ["\u03BD", "v"], ["\u03BA", "k"],
  ["\u03B5", "e"], ["\u03C4", "t"], ["\u03B9", "i"], ["\u03C5", "u"], ["\u03C7", "x"],
  ["\u03B7", "n"], ["\u03BC", "u"], ["\u03C3", "o"], ["\u03B2", "b"], ["\u03B3", "y"],
  // Latin extended / other
  ["\u0131", "i"], ["\u0269", "i"], ["\u1D0F", "o"], ["\u0280", "r"], ["\u01BF", "p"],
  ["\u0578", "n"], ["\u057D", "u"], ["\u0585", "o"], ["\u0581", "g"], ["\u2044", "/"],
]);

/**
 * Build a folded copy plus an index map back to the original string, so the
 * match runs on normalized text while the output keeps every byte the match did
 * not cover.
 */
export function foldForMatching(value: string, decodeEscapes = true): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  // Serialization escapes are ALIASES for the label, not decoration: a JSON
  // `\u0069`, a percent-encoded `%69`, and an XML `&#105;` all spell the same
  // field name to whatever parses the body, while spelling something else to a
  // literal matcher. Decode them into the matching view (one folded character
  // per escape, with the whole escape mapped back to its start) so
  // `author\u0069zation`, `author%69zation`, and `author&#105;zation` are the
  // label they claim to be.
  const decodeEscape = (at: number): { ch: string; width: number } | null => {
    // JSON `\uXXXX`, INCLUDING a surrogate pair. Decoding the halves
    // independently left `\uD835\uDD69` as two lone surrogates, so the
    // mathematical letter they spell was never normalized as one code point.
    const json = /^\\u([0-9a-fA-F]{4})/.exec(value.slice(at, at + 6));
    if (json) {
      const high = parseInt(json[1]!, 16);
      if (high >= 0xd800 && high <= 0xdbff) {
        const low = /^\\u([0-9a-fA-F]{4})/.exec(value.slice(at + 6, at + 12));
        const lowCode = low ? parseInt(low[1]!, 16) : NaN;
        if (lowCode >= 0xdc00 && lowCode <= 0xdfff) {
          return { ch: String.fromCharCode(high, lowCode), width: 12 };
        }
      }
      return { ch: String.fromCharCode(high), width: 6 };
    }
    // Percent encoding is UTF-8: consecutive `%XX` bytes form ONE character.
    // Decoding each byte on its own turned `%D0%B5` into two unrelated
    // Latin-1 characters instead of the Cyrillic `е` the fold would have
    // recognized.
    const pct = /^(?:%[0-9a-fA-F]{2})+/.exec(value.slice(at, at + 24));
    if (pct) {
      try {
        const decoded = decodeURIComponent(pct[0]);
        if (decoded.length >= 1) {
          // Consume only the bytes that produced the FIRST character, so the
          // rest of the sequence is decoded on the next iteration.
          const first = String.fromCodePoint(decoded.codePointAt(0)!);
          const bytes = new TextEncoder().encode(first).length;
          return { ch: first, width: bytes * 3 };
        }
      } catch {
        const single = parseInt(pct[0].slice(1, 3), 16);
        return { ch: String.fromCharCode(single), width: 3 };
      }
    }
    const xml = /^&#(x[0-9a-fA-F]{1,6}|[0-9]{1,7});/.exec(value.slice(at, at + 11));
    if (xml) {
      const raw = xml[1]!;
      const code = raw[0] === "x" || raw[0] === "X"
        ? parseInt(raw.slice(1), 16)
        : parseInt(raw, 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        return { ch: String.fromCodePoint(code), width: xml[0].length };
      }
    }
    // HTML named references. `&colon;` and the other separator names are
    // resolved exactly; anything else folds to the opaque placeholder so the
    // label still matches without pretending to know the character.
    const named = /^&([A-Za-z][A-Za-z0-9]{1,31});/.exec(value.slice(at, at + 34));
    if (named) {
      const separator = SEPARATOR_ENTITIES.get(named[1]!.toLowerCase());
      return { ch: separator ?? NAMED_ENTITY_PLACEHOLDER, width: named[0].length };
    }
    return null;
  };
  // Iterate by CODE POINT, not UTF-16 code unit: a supplementary character
  // (mathematical letters, variation selectors above the BMP) is two units, so
  // a per-unit loop hands each half to the property tests separately and
  // neither half matches anything. `𝕩-api-key` and a U+E0100 inside a label
  // both walked straight past the fold that way.
  let i = 0;
  while (i < value.length) {
    const escaped = decodeEscapes ? decodeEscape(i) : null;
    const ch = escaped ? escaped.ch : String.fromCodePoint(value.codePointAt(i)!);
    const width = escaped ? escaped.width : ch.length;
    if (INVISIBLE_FORMAT.test(ch)) {
      i += width;
      continue;
    }
    const mapped = COLON_CONFUSABLES.has(ch)
      ? ":"
      : LETTER_CONFUSABLES.get(ch.toLowerCase())
        // NFKD collapses fullwidth, circled, and mathematical letter variants
        // onto their ASCII base.
        ?? (ch.normalize("NFKD").length === 1 ? ch.normalize("NFKD") : ch);
    // One folded unit per source code point keeps the offset map aligned; a
    // multi-unit fold would desynchronize it, so those keep the original.
    folded += mapped.length === 1 ? mapped : ch;
    // One map entry per EMITTED UTF-16 unit. An escaped supplementary
    // character emits two units, and giving it one entry desynchronized every
    // later offset — the mask then landed mid-token and left part of the
    // credential behind.
    const emittedText = mapped.length === 1 ? mapped : ch;
    for (let k = 0; k < emittedText.length; k += 1) map.push(i);
    i += width;
  }
  map.push(value.length);
  return { folded, map };
}
