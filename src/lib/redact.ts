export const REDACTED_SECRET = "[REDACTED]";

const SENSITIVE_KEY_PATTERN = /^(?:authorization|proxy-authorization|cookie|set-cookie|set-cookie2|api[-_]?key|x-api-key|x-goog-api-key|x-amz-security-token|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|client[-_]?secret|password|profile[-_]?arn)$/i;

/**
 * Colon-labelled credential headers echoed back inside an error body
 * (`x-api-key: <value>`), which the `key=value` rules never match.
 *
 * This is one pass with an explicit decision rather than a stack of regexes
 * that have to reason about each other's output. Three earlier attempts failed
 * exactly there: exempting `Bearer` let anything the Bearer rule could not
 * parse escape both rules; trusting the public `[REDACTED]` marker let a
 * suffix ride along behind it; and splitting into two ordered patterns had the
 * second eat the first one's result.
 *
 * The rule: the value after the label is a credential and gets masked to
 * end-of-line. There is no "keep the readable part" exception, because every
 * round of review found another way to hide a credential inside whatever the
 * previous round chose to preserve — a second label, a repeated `Bearer`
 * scheme, a third token two levels deep. Preserving attacker-controlled text
 * next to a credential is the bug; the scheme word is not worth it.
 *
 * `Bearer` survives only as a fixed prefix on `authorization` /
 * `proxy-authorization`, where it says which scheme failed and carries nothing
 * from the input. `[REDACTED]` is a PUBLIC string an upstream can emit too, so
 * its presence never grants trust.
 *
 * The label boundary is matched over a NORMALIZED VIEW: colon confusables and
 * invisible format characters are folded for matching only, with offsets mapped
 * back so unrelated text keeps its original bytes. Folding the string itself
 * rewrote innocent diagnostics (`ratio∶1` became `ratio:1`).
 */
// Every letter position also accepts \u0001, the placeholder the fold emits for
// an unresolved HTML named reference: `author&ii;zation` is the label with one
// character we cannot name, and that is still the label.
const CREDENTIAL_HEADER_LABEL_RAW = "x-api-key|x-goog-api-key|x-amz-security-token|api[_-]?key|apiKey|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|id[_-]?token|client[_-]?secret|clientSecret|authorization|proxy-authorization|cookie|set-cookie|password|secret|token";

const CREDENTIAL_HEADER_LABEL = CREDENTIAL_HEADER_LABEL_RAW
  .replace(/(?<![\[\\])([A-Za-z])(?![\]\-])/g, "[$1\u0001]");

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

// `\b` is the wrong left boundary for a header name: it matches after a `-` or
// `_`, so `not-authorization:` and `internal_token:` were treated as the
// credential labels they merely end with. Requiring a non-identifier character
// (or start of input) keeps the match to whole field names.
//
// The optional quotes around the label matter: a serialized headers object
// (`{"x-api-key":"<secret>"}`) puts a closing quote between the name and the
// colon, so a bare `label:` pattern never saw it. The pre-existing JSON rules
// below only listed a few field names and did not share this label grammar,
// which is how ordinary JSON serialization — no homoglyphs, no attacker
// alphabet — walked a credential straight through.
const COLON_LABELLED_CREDENTIAL = new RegExp(
  `(?<![A-Za-z0-9_-])["']?(?:${CREDENTIAL_HEADER_LABEL})["']?[^\\S\\r\\n]*:`,
  "gi",
);

/**
 * Framings other than `label: value` that carry the same credential names.
 *
 * An upstream error body is not always a header dump. It can echo the request
 * as a form-encoded string, an XML element, or a multipart part header, and a
 * colon-only matcher sees none of those. Each entry masks the value with the
 * terminator its own grammar defines, so the surrounding structure survives.
 */
const OTHER_FRAMED_CREDENTIALS: Array<[RegExp, string]> = [
  // URL query / form-encoded: `authorization=<value>` up to `&` or `;`.
  // Unconditionally to the separator — a quoted value is NOT allowed to end it
  // early, or `authorization="decoy"<secret>&model=…` leaks the suffix.
  [
    new RegExp(`(?<![A-Za-z0-9_-])(?:${CREDENTIAL_HEADER_LABEL})=[^&;\\r\\n]*`, "gi"),
    "=",
  ],
  // XML/HTML. A tag qualifies when its NAME is a credential (optionally
  // namespace-qualified), or when a whole `name`/`key`/`id` attribute names one
  // — `data-name` does not count, or `<field data-name="authorization">` loses
  // harmless status text.
  //
  // Once a tag qualifies, the mask keeps only the tag name and runs to END OF
  // INPUT. Two stopping points were tried and both leaked: the CLOSING TAG
  // (same-name nesting ended the mask at the inner `</authorization>`, and a
  // self-closing tag had none), then END OF LINE (an opening tag may legally
  // span lines, so `<authorization\n value="…">` left the credential on the
  // next line). XML has no line discipline to borrow, so there is no boundary
  // left worth trusting.
  //
  // Whitespace is allowed around an attribute `=`, which XML permits and an
  // echo may well reproduce.
  [
    new RegExp(
      `(<[^\\S\\r\\n]*(?:[A-Za-z_][\\w.-]*:)?(?:${CREDENTIAL_HEADER_LABEL})(?=[\\s/>]))[\\s\\S]*`,
      "gi",
    ),
    "element",
  ],
  [
    new RegExp(
      `(<[^\\S\\r\\n]*(?:[A-Za-z_][\\w.-]*:)?[A-Za-z_][\\w:.-]*)(?=[^>]*?(?<![\\w:.-])(?:name|key|id)[^\\S]*=[^\\S]*["']?(?:${CREDENTIAL_HEADER_LABEL})["']?(?=[\\s/>]))[\\s\\S]*`,
      "gi",
    ),
    "element",
  ],
  // Multipart part: everything from a credential-named part header to the end
  // of the input. Part-based, not line-based — a body can span lines and the
  // blank line is often missing in a malformed echo.
  //
  // It deliberately does NOT stop at the first `--`: the boundary token is
  // attacker-controlled text, so a body line starting `--not-the-boundary`
  // ended the mask and exposed everything after it. Consuming the remainder
  // costs trailing context in one framing and closes the bypass.
  [
    new RegExp(
      `(name=["']?(?:${CREDENTIAL_HEADER_LABEL})["']?[^\\r\\n]*\\r?\\n(?:\\r?\\n)?)([\\s\\S]+)`,
      "gi",
    ),
    "multipart",
  ],
];

/**
 * These run over the FOLDED view too, then map back to the original string.
 *
 * Matching the raw text meant a percent-encoded form key (`author%69zation=`)
 * and an XML character reference (`name="author&#105;zation"`) were invisible,
 * even though both spell the credential name to anything that parses the body.
 * The fold already decodes those, so the grammars are applied there and the
 * mask is written back at the corresponding original offsets.
 */
function maskOtherFramings(value: string): string {
  // Same union rule as the header pass: decoding may add coverage, never
  // remove it.
  return maskOtherFramingsOnce(maskOtherFramingsOnce(value, true), false);
}

function maskOtherFramingsOnce(value: string, decodeEscapes: boolean): string {
  let current = value;
  for (const [pattern, kind] of OTHER_FRAMED_CREDENTIALS) {
    const { folded, map } = foldForMatching(current, decodeEscapes);
    pattern.lastIndex = 0;
    let out = "";
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(folded)) !== null) {
      const start = map[match.index] ?? current.length;
      const end = map[match.index + match[0].length] ?? current.length;
      if (start < cursor) continue;
      const head = (() => {
        if (kind === "=") {
          const eq = match[0].indexOf("=");
          const headEnd = map[match.index + eq + 1] ?? end;
          return current.slice(start, headEnd);
        }
        const captured = match[1] ?? "";
        const headEnd = map[match.index + captured.length] ?? end;
        return current.slice(start, headEnd);
      })();
      const body = current.slice(start + head.length, end);
      if (kind === "multipart" && !body.trim()) continue;
      out += current.slice(cursor, start) + head + REDACTED_SECRET;
      cursor = end;
      if (pattern.lastIndex === match.index) pattern.lastIndex += 1;
    }
    current = out + current.slice(cursor);
  }
  return current;
}

/**
 * Build a folded copy plus an index map back to the original string, so the
 * match runs on normalized text while the output keeps every byte the match did
 * not cover.
 */
function foldForMatching(value: string, decodeEscapes = true): { folded: string; map: number[] } {
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

/**
 * Run the header rule over BOTH matching views and take the union.
 *
 * Decoding may only ADD coverage. Applying it unconditionally removed some:
 * `&#x1d569;x-api-key: <secret>` decoded to `𝕩x-api-key:`, which folds to
 * `xx-api-key:` and no longer matches the label boundary — so a decode-only
 * view masked LESS than the plain view did. Running both and masking whatever
 * either one finds makes the direction of the change one-way.
 */
function maskCredentialHeaders(value: string): string {
  const decoded = maskCredentialHeadersOnce(value, true);
  return maskCredentialHeadersOnce(decoded, false);
}

function maskCredentialHeadersOnce(value: string, decodeEscapes: boolean): string {
  const { folded, map } = foldForMatching(value, decodeEscapes);
  COLON_LABELLED_CREDENTIAL.lastIndex = 0;
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = COLON_LABELLED_CREDENTIAL.exec(folded)) !== null) {
    const start = map[match.index] ?? value.length;
    const afterLabel = map[match.index + match[0].length] ?? value.length;
    if (start < cursor) continue;
    const lineEnd = (() => {
      const nl = value.slice(afterLabel).search(/[\r\n]/);
      return nl === -1 ? value.length : afterLabel + nl;
    })();
    // THE VALUE ALWAYS RUNS TO END-OF-LINE. There is no early termination and
    // no attempt to preserve sibling fields.
    //
    // Three attempts tried to be smarter, and each one leaked: stop at the
    // first closing quote; stop at a closing quote followed by punctuation;
    // stop only when the LABEL was quoted. The third still leaked on an
    // unmatched opening quote (`"x-api-key: "decoy",<secret>`) and on a
    // correctly quoted key whose value quote was a decoy
    // (`{"x-api-key":"decoy"<secret>}`).
    //
    // The pattern is the lesson: any rule that stops early is reading
    // attacker-controlled text to decide where a secret ends, and the attacker
    // gets to write that text. Losing the siblings in a serialized object
    // makes a diagnostic less pretty; stopping early makes it leak. Monotonic
    // and blunt wins.
    const valueEnd = lineEnd;
    const rawValue = value.slice(afterLabel, valueEnd);
    if (!rawValue.trim()) continue;
    // Keep the original separator spacing so a diagnostic still reads as
    // `header: [REDACTED]` rather than `header:[REDACTED]`.
    const gap = /^[^\S\r\n]*/.exec(rawValue)?.[0] ?? "";
    // `Bearer` is a fixed prefix, reproduced from a literal — never copied from
    // the input — and only where an auth scheme is meaningful.
    const label = match[0].replace(/[^\S\r\n]*:$/, "").trim();
    const isAuthHeader = /^(?:proxy-)?authorization$/i.test(label);
    const prefix = isAuthHeader && /^[^\S\r\n]*Bearer[^\S\r\n]/i.test(rawValue)
      ? "Bearer "
      : "";
    out += value.slice(cursor, afterLabel) + gap + prefix + REDACTED_SECRET;
    cursor = valueEnd;
  }
  return out + value.slice(cursor);
}

const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  // A Bearer token outside a labelled header (prose, JSON fragments, logs).
  // Horizontal whitespace only: `\s+` crossed line boundaries and masked the
  // first word of the NEXT line when a header was quoted with a trailing break.
  [/\b(Bearer)([^\S\r\n]+)[A-Za-z0-9._~+/=-]{8,}\b/gi, `$1$2${REDACTED_SECRET}`],
  [/\b(sk-[A-Za-z0-9][A-Za-z0-9._-]{6,})\b/g, REDACTED_SECRET],
  // GitHub tokens (classic + fine-grained + OAuth/refresh): ghp_/gho_/ghu_/ghs_/ghr_/github_pat_.
  [/\b(gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED_SECRET],
  // GitHub Copilot API tokens: semicolon-joined k=v grammar starting with tid=…
  // (e.g. "tid=abc123;exp=1699999999;sku=copilot_pro;…:sig"). Redact the whole token —
  // a Bearer-prefix rule alone leaves the suffix intact.
  [/\btid=[A-Za-z0-9-]+(?:;[A-Za-z0-9_.-]+=[^;\s"']*)+(?::[A-Za-z0-9+/=_-]+)?/g, REDACTED_SECRET],
  [/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|refreshToken|accessToken|clientSecret|apiKey)=)([^&\s"',;]+)/gi, `$1${REDACTED_SECRET}`],
  [/((?:"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|refreshToken|accessToken|clientSecret|apiKey)"\s*:\s*"))([^"]+)(")/gi, `$1${REDACTED_SECRET}$3`],
  // Raw JSON "token" field values (Copilot token exchange bodies echo the credential here).
  [/(("token"\s*:\s*"))([^"]+)(")/gi, `$1${REDACTED_SECRET}$4`],
  [/\b(arn:aws:[A-Za-z0-9_-]+:[A-Za-z0-9-]*:\d{12}:[A-Za-z0-9_/:+=,.@-]+)\b/g, REDACTED_SECRET],
];

type HeaderRecord = Record<string, string | string[] | undefined>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function redactSecretString(value: string): string {
  let redacted = maskOtherFramings(maskCredentialHeaders(value));
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function hexNibble(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

function percentByteAt(value: string, index: number): number | undefined {
  if (value.charCodeAt(index) !== 0x25 || index + 2 >= value.length) return undefined;
  const high = hexNibble(value.charCodeAt(index + 1));
  const low = hexNibble(value.charCodeAt(index + 2));
  return high < 0 || low < 0 ? undefined : (high << 4) | low;
}

function percentDecodedCodePointAt(
  value: string,
  index: number,
): { codePoint: string; end: number } | undefined {
  const first = percentByteAt(value, index);
  if (first === undefined) return undefined;
  if (first <= 0x7f) {
    return { codePoint: String.fromCodePoint(first), end: index + 3 };
  }

  const width = first >= 0xc2 && first <= 0xdf
    ? 2
    : first >= 0xe0 && first <= 0xef
      ? 3
      : first >= 0xf0 && first <= 0xf4
        ? 4
        : 0;
  if (width === 0) return undefined;

  const bytes = [first];
  for (let offset = 1; offset < width; offset += 1) {
    const byte = percentByteAt(value, index + offset * 3);
    if (byte === undefined || byte < 0x80 || byte > 0xbf) return undefined;
    bytes.push(byte);
  }
  const second = bytes[1]!;
  if ((first === 0xe0 && second < 0xa0)
    || (first === 0xed && second > 0x9f)
    || (first === 0xf0 && second < 0x90)
    || (first === 0xf4 && second > 0x8f)) {
    return undefined;
  }

  let decoded = first & (0x7f >> width);
  for (let offset = 1; offset < width; offset += 1) {
    decoded = (decoded << 6) | (bytes[offset]! & 0x3f);
  }
  return {
    codePoint: String.fromCodePoint(decoded),
    end: index + width * 3,
  };
}

const EXACT_JSON_WORD_CODE_POINT = /[\p{L}\p{N}_$]/u;

function exactWireCodePointAt(
  value: string,
  index: number,
): { codePoint: string; end: number } | undefined {
  if (index >= value.length) return undefined;
  const escaped = percentDecodedCodePointAt(value, index);
  if (escaped) return escaped;
  const codePoint = String.fromCodePoint(value.codePointAt(index)!);
  return { codePoint, end: index + codePoint.length };
}

function encodedQuoteHasEvenBackslashPrefix(value: string, quoteStart: number): boolean {
  let cursor = quoteStart;
  let backslashes = 0;
  while (cursor > 0) {
    if (cursor >= 3 && percentByteAt(value, cursor - 3) === 0x5c) {
      backslashes += 1;
      cursor -= 3;
      continue;
    }
    if (value[cursor - 1] === "\\") {
      backslashes += 1;
      cursor -= 1;
      continue;
    }
    break;
  }
  return backslashes % 2 === 0;
}

interface ExactWireMapSegment {
  decodedStart: number;
  decodedEnd: number;
  rawStart: number;
  rawEnd: number;
  readonly decodedUnitWidth: number;
  readonly rawUnitWidth: number;
}

interface ExactWireDecodedView {
  readonly decoded: string;
  readonly segments: readonly ExactWireMapSegment[];
}

const EXACT_WIRE_VIEW_EXHAUSTED = Symbol("exact-wire-view-exhausted");
// These bound two independent attacker-controlled dimensions. Segment count
// limits map fragmentation; decoded escape units limit homogeneous runs that
// otherwise coalesce into one segment while still doing unbounded decode work
// and incremental string allocation. Exhausting either budget fails closed.
const MAX_EXACT_WIRE_MAP_SEGMENTS = 16 * 1024;
const MAX_EXACT_WIRE_DECODED_ESCAPE_UNITS = 64 * 1024;
const EXACT_WIRE_BUILDER_CHUNK_LENGTH = 64 * 1024;
// JSON.parse may materialize several copies of a string token. Large tokens
// that require composed JSON/URL interpretation are safer to replace whole.
const MAX_EXACT_COMPOSED_JSON_TOKEN_LENGTH = 1024 * 1024;
// Raw tokens may expose many plausible encoded closing quotes. Bound the sum
// of growing-prefix candidates so rebuilding their source maps cannot become
// quadratic; exhaustion replaces the whole value instead of trusting a suffix.
const MAX_EXACT_RAW_JSON_CANDIDATE_WORK = 1024 * 1024;

/**
 * Build one decoded matching view while recording only escape runs. This stays
 * separate from `foldForMatching`: exact-value redaction must not inherit its
 * NFKD, homoglyph, entity, or invisible-character normalization.
 */
function buildExactWireDecodedView(
  value: string,
): ExactWireDecodedView | typeof EXACT_WIRE_VIEW_EXHAUSTED | undefined {
  let firstPercent = value.indexOf("%");
  if (firstPercent === -1) return undefined;

  const parts: string[] = [];
  let pending = "";
  const appendDecoded = (text: string): void => {
    if (!text) return;
    if (pending.length + text.length <= EXACT_WIRE_BUILDER_CHUNK_LENGTH) {
      pending += text;
      return;
    }
    if (pending) {
      parts.push(pending);
      pending = "";
    }
    if (text.length >= EXACT_WIRE_BUILDER_CHUNK_LENGTH) parts.push(text);
    else pending = text;
  };

  const segments: ExactWireMapSegment[] = [];
  let rawCursor = 0;
  let searchFrom = firstPercent;
  let decodedLength = 0;
  let decodedEscapeUnits = 0;
  let sawValidEscape = false;

  while (searchFrom < value.length) {
    firstPercent = value.indexOf("%", searchFrom);
    if (firstPercent === -1) break;
    const firstEscaped = percentDecodedCodePointAt(value, firstPercent);
    if (!firstEscaped) {
      searchFrom = firstPercent + 1;
      continue;
    }

    const rawPrefix = value.slice(rawCursor, firstPercent);
    appendDecoded(rawPrefix);
    decodedLength += rawPrefix.length;

    let encodedCursor = firstPercent;
    while (encodedCursor < value.length) {
      const escaped = percentDecodedCodePointAt(value, encodedCursor);
      if (!escaped) break;
      sawValidEscape = true;

      const decodedUnitWidth = escaped.codePoint.length;
      decodedEscapeUnits += decodedUnitWidth;
      if (decodedEscapeUnits > MAX_EXACT_WIRE_DECODED_ESCAPE_UNITS) {
        return EXACT_WIRE_VIEW_EXHAUSTED;
      }
      appendDecoded(escaped.codePoint);

      const rawUnitWidth = escaped.end - encodedCursor;
      const previous = segments.at(-1);
      if (previous
        && previous.decodedEnd === decodedLength
        && previous.rawEnd === encodedCursor
        && previous.decodedUnitWidth === decodedUnitWidth
        && previous.rawUnitWidth === rawUnitWidth) {
        previous.decodedEnd += decodedUnitWidth;
        previous.rawEnd = escaped.end;
      } else {
        if (segments.length >= MAX_EXACT_WIRE_MAP_SEGMENTS) {
          return EXACT_WIRE_VIEW_EXHAUSTED;
        }
        segments.push({
          decodedStart: decodedLength,
          decodedEnd: decodedLength + decodedUnitWidth,
          rawStart: encodedCursor,
          rawEnd: escaped.end,
          decodedUnitWidth,
          rawUnitWidth,
        });
      }
      decodedLength += decodedUnitWidth;
      encodedCursor = escaped.end;
    }

    rawCursor = encodedCursor;
    searchFrom = encodedCursor;
  }

  if (!sawValidEscape) return undefined;
  appendDecoded(value.slice(rawCursor));
  if (pending) parts.push(pending);
  return { decoded: parts.join(""), segments };
}

function exactWireSegmentAtOrBefore(
  segments: readonly ExactWireMapSegment[],
  decodedIndex: number,
): ExactWireMapSegment | undefined {
  let low = 0;
  let high = segments.length - 1;
  let found: ExactWireMapSegment | undefined;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const segment = segments[middle]!;
    if (segment.decodedStart <= decodedIndex) {
      found = segment;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

function exactWireRawStart(view: ExactWireDecodedView, decodedIndex: number): number {
  const segment = exactWireSegmentAtOrBefore(view.segments, decodedIndex);
  if (!segment) return decodedIndex;
  if (decodedIndex < segment.decodedEnd) {
    const units = Math.floor((decodedIndex - segment.decodedStart) / segment.decodedUnitWidth);
    return segment.rawStart + units * segment.rawUnitWidth;
  }
  return decodedIndex + (segment.rawEnd - segment.decodedEnd);
}

function exactWireRawEnd(view: ExactWireDecodedView, decodedEnd: number): number {
  const decodedIndex = decodedEnd - 1;
  const segment = exactWireSegmentAtOrBefore(view.segments, decodedIndex);
  if (!segment) return decodedEnd;
  if (decodedIndex < segment.decodedEnd) {
    const units = Math.ceil((decodedEnd - segment.decodedStart) / segment.decodedUnitWidth);
    return segment.rawStart + units * segment.rawUnitWidth;
  }
  return decodedEnd + (segment.rawEnd - segment.decodedEnd);
}

function replaceFromExactWireDecodedView(
  value: string,
  view: ExactWireDecodedView,
  exactValue: string,
): string {
  let searchFrom = 0;
  let copiedThrough = 0;
  let output = "";
  let changed = false;
  while (searchFrom < view.decoded.length) {
    const found = view.decoded.indexOf(exactValue, searchFrom);
    if (found === -1) break;
    const matchStart = exactWireRawStart(view, found);
    const matchEnd = exactWireRawEnd(view, found + exactValue.length);
    if (matchStart >= copiedThrough) {
      output += value.slice(copiedThrough, matchStart) + REDACTED_SECRET;
      copiedThrough = matchEnd;
      changed = true;
      searchFrom = found + exactValue.length;
    } else {
      searchFrom = found + 1;
    }
  }
  return changed ? output + value.slice(copiedThrough) : value;
}

interface ExactWireReplacement {
  readonly redacted: string;
  readonly wholeValueMatch: boolean;
  readonly exhausted: boolean;
}

function replaceWireExactOccurrencesDetailed(
  value: string,
  exactValue: string,
): ExactWireReplacement {
  const decodedView = buildExactWireDecodedView(value);
  // Do not relay an attacker-shaped body after the bounded source map is exhausted.
  if (decodedView === EXACT_WIRE_VIEW_EXHAUSTED) {
    return { redacted: REDACTED_SECRET, wholeValueMatch: false, exhausted: true };
  }
  let redacted = value;
  if (decodedView) {
    redacted = replaceFromExactWireDecodedView(redacted, decodedView, exactValue);
  }
  return {
    redacted: redacted.replaceAll(exactValue, REDACTED_SECRET),
    wholeValueMatch: value === exactValue || decodedView?.decoded === exactValue,
    exhausted: false,
  };
}

function replaceWireExactOccurrences(value: string, exactValue: string): string {
  return replaceWireExactOccurrencesDetailed(value, exactValue).redacted;
}

function replacePercentEncodedJsonExactOccurrences(
  value: string,
  exactValue: string,
  boundaryMode: "encoded-or-mixed" | "raw",
): string {
  const hasEncodedJsonEscape = /%5c/i.test(value);
  if (!hasEncodedJsonEscape && !(value.includes("\\") && value.includes("%"))) {
    return value;
  }
  const view = buildExactWireDecodedView(value);
  if (!view) return value;
  if (view === EXACT_WIRE_VIEW_EXHAUSTED) {
    // A URL-encoded JSON escape cannot be mapped safely after the bounded
    // source-map/work budget is exhausted. Fail closed for that composed shape.
    return /%5c/i.test(value) || value.includes("\\") ? REDACTED_SECRET : value;
  }
  if (!view.decoded.includes("\\")) return value;

  let copiedThrough = 0;
  let output = "";
  let changed = false;
  for (let index = 0; index < view.decoded.length; index += 1) {
    if (view.decoded[index] !== '"') continue;
    const tokenStart = index;
    const rawTokenStart = exactWireRawStart(view, tokenStart);
    const rawContentStart = exactWireRawEnd(view, tokenStart + 1);
    const rawOpeningQuote = value.slice(rawTokenStart, rawContentStart);
    const openingIsEncoded = /^%22$/i.test(rawOpeningQuote);
    if (!openingIsEncoded && rawOpeningQuote !== '"') continue;
    let beforeToken = tokenStart - 1;
    while (beforeToken >= 0 && /\s/.test(view.decoded[beforeToken]!)) beforeToken -= 1;
    const openingContext = view.decoded[beforeToken];
    let hasJsonEscape = false;
    index += 1;
    while (index < view.decoded.length) {
      const char = view.decoded[index];
      if (char === "\\") {
        hasJsonEscape = true;
        index += 2;
        continue;
      }
      if (char !== '"') {
        index += 1;
        continue;
      }

      const rawContentEnd = exactWireRawStart(view, index);
      const rawTokenEnd = exactWireRawEnd(view, index + 1);
      const rawClosingQuote = value.slice(rawContentEnd, rawTokenEnd);
      const closingIsEncoded = /^%22$/i.test(rawClosingQuote);
      if (!closingIsEncoded && rawClosingQuote !== '"') {
        index += 1;
        continue;
      }
      const isRawBoundaryPair = !openingIsEncoded && !closingIsEncoded;
      if ((boundaryMode === "raw") !== isRawBoundaryPair) break;
      const nextCodePoint = index + 1 < view.decoded.length
        ? String.fromCodePoint(view.decoded.codePointAt(index + 1)!)
        : undefined;
      const tokenLength = index + 1 - tokenStart;
      let replacement: ExactWireReplacement | undefined;
      let decodedToken: string | undefined;
      if (tokenLength <= MAX_EXACT_COMPOSED_JSON_TOKEN_LENGTH) {
        try {
          const decoded = JSON.parse(view.decoded.slice(tokenStart, index + 1)) as unknown;
          if (typeof decoded === "string") {
            decodedToken = decoded;
            if (hasJsonEscape) {
              replacement = replaceWireExactOccurrencesDetailed(decoded, exactValue);
            }
          }
        } catch {
          // Not a valid standalone JSON string token.
        }
      }
      // A string followed by `:` is a JSON key only when its opening follows
      // an object/member boundary. This prevents a value token with an encoded
      // backslash from spanning forward into the next key.
      if (nextCodePoint === ":"
        && openingContext !== undefined
        && openingContext !== "="
        && openingContext !== "{"
        && openingContext !== ",") {
        if (!replacement || replacement.redacted === decodedToken) break;
      }
      // Diagnostics use many separators and can place text immediately after a
      // serialized token. A parsed whole-value match is authoritative even in
      // that adjacent form; otherwise reject a word-adjacent quote so a false
      // candidate cannot span across raw fields.
      const hasClosingContext = nextCodePoint === undefined
        || !EXACT_JSON_WORD_CODE_POINT.test(nextCodePoint);
      if (!hasClosingContext && (!replacement || replacement.redacted === decodedToken)) {
        // A successfully parsed non-matching token has a known close; move
        // past it. Revisit only an unparsed quote that may actually open the
        // next token, otherwise it can swallow that token's real opener.
        if (decodedToken === undefined) index -= 1;
        break;
      }
      if (!hasJsonEscape) break;

      if (tokenLength > MAX_EXACT_COMPOSED_JSON_TOKEN_LENGTH) {
        if (rawContentStart >= copiedThrough) {
          output += value.slice(copiedThrough, rawContentStart)
            + encodeURIComponent(REDACTED_SECRET);
          copiedThrough = rawContentEnd;
          changed = true;
        }
        break;
      }

      if (replacement && decodedToken !== undefined) {
        if (replacement.redacted !== decodedToken && rawContentStart >= copiedThrough) {
          const safeJsonContent = JSON.stringify(replacement.redacted).slice(1, -1);
          output += value.slice(copiedThrough, rawContentStart)
            + encodeURIComponent(safeJsonContent);
          copiedThrough = rawContentEnd;
          changed = true;
        }
      }
      break;
    }
  }
  return changed ? output + value.slice(copiedThrough) : value;
}

/**
 * Redact one exact value from a raw JSON string token under either composition:
 * JSON then URL decoding, or URL decoding then JSON. The token boundaries come
 * from the raw input, so a `%22` inside its contents cannot become structure.
 */
function redactRawJsonStringToken(token: string, exactValue: string): string | undefined {
  let jsonThenWire: ExactWireReplacement | undefined;
  let jsonThenWireDecoded: string | undefined;
  try {
    const decoded = JSON.parse(token) as unknown;
    if (typeof decoded === "string") {
      jsonThenWireDecoded = decoded;
      jsonThenWire = replaceWireExactOccurrencesDetailed(decoded, exactValue);
    }
  } catch {
    // It may become a valid JSON token only after the outer URL layer is decoded.
  }

  // Direct percent aliases are already covered by the first path and the
  // final wire pass. A second JSON interpretation is useful only when the URL
  // layer reveals a JSON escape introducer.
  let wireThenJson: string | undefined;
  if (/%5c/i.test(token) || (token.includes("\\") && token.includes("%"))) {
    const wireView = buildExactWireDecodedView(token);
    if (wireView === EXACT_WIRE_VIEW_EXHAUSTED) return JSON.stringify(REDACTED_SECRET);
    if (wireView) {
      try {
        const decoded = JSON.parse(wireView.decoded) as unknown;
        if (typeof decoded === "string") wireThenJson = decoded;
      } catch {
        // The raw-JSON-first projection may still be valid.
      }
    }
  }

  // A whole-token match is stronger than a prefix match in the competing
  // composition. Choosing it first prevents a JSON-significant suffix from
  // surviving after the other projection masks only the visible prefix.
  if (jsonThenWire?.wholeValueMatch || wireThenJson === exactValue) {
    return JSON.stringify(REDACTED_SECRET);
  }
  if (jsonThenWire?.exhausted) return JSON.stringify(REDACTED_SECRET);
  if (jsonThenWire && jsonThenWire.redacted !== jsonThenWireDecoded) {
    return JSON.stringify(jsonThenWire.redacted);
  }
  if (wireThenJson !== undefined) {
    const safe = wireThenJson.replaceAll(exactValue, REDACTED_SECRET);
    if (safe !== wireThenJson) return JSON.stringify(safe);
  }
  return undefined;
}

function replaceRawJsonExactOccurrences(value: string, exactValue: string): string {
  if (!value.includes('"') || (!value.includes("\\") && !/%5c/i.test(value))) return value;
  let output = "";
  let copiedThrough = 0;
  let mixedCandidateWork = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '"') continue;
    const start = index;
    let hasCompositionEscape = false;
    index += 1;
    while (index < value.length) {
      const char = value[index];
      if (char === "\\") {
        hasCompositionEscape = true;
        index += 2;
        continue;
      }
      if (char === "%" && percentByteAt(value, index) === 0x5c) {
        hasCompositionEscape = true;
      }
      if (char === "%" && percentByteAt(value, index) === 0x22
        && encodedQuoteHasEvenBackslashPrefix(value, index)) {
        const encodedQuote = percentDecodedCodePointAt(value, index)!;
        const afterQuote = exactWireCodePointAt(value, encodedQuote.end)?.codePoint;
        if (afterQuote === undefined || !EXACT_JSON_WORD_CODE_POINT.test(afterQuote)) {
          // A mixed raw/%22 token can end here, but `%22` can also be content
          // inside a valid raw token. Commit early only for the stronger whole-
          // token semantic match; otherwise retain the raw candidate so the
          // JSON-then-URL projection can evaluate its actual closing quote.
          if (encodedQuote.end - start <= MAX_EXACT_COMPOSED_JSON_TOKEN_LENGTH) {
            mixedCandidateWork += encodedQuote.end - start;
            if (mixedCandidateWork > MAX_EXACT_RAW_JSON_CANDIDATE_WORK) {
              return JSON.stringify(REDACTED_SECRET);
            }
            const candidate = value.slice(start, encodedQuote.end);
            const candidateView = buildExactWireDecodedView(candidate);
            if (candidateView && candidateView !== EXACT_WIRE_VIEW_EXHAUSTED) {
              try {
                if (JSON.parse(candidateView.decoded) === exactValue) {
                  output += value.slice(copiedThrough, start + 1)
                    + encodeURIComponent(REDACTED_SECRET);
                  copiedThrough = index;
                  index = encodedQuote.end - 1;
                  break;
                }
              } catch {
                // The complete raw token may still be the valid projection.
              }
            }
          }
        }
        index = encodedQuote.end;
        continue;
      }
      if (char !== '"') {
        index += 1;
        continue;
      }

      const tokenLength = index + 1 - start;
      const safeToken = !hasCompositionEscape
        ? undefined
        : tokenLength > MAX_EXACT_COMPOSED_JSON_TOKEN_LENGTH
          ? JSON.stringify(REDACTED_SECRET)
          : redactRawJsonStringToken(value.slice(start, index + 1), exactValue);
      if (safeToken !== undefined) {
        output += value.slice(copiedThrough, start) + safeToken;
        copiedThrough = index + 1;
      }
      break;
    }
  }
  return copiedThrough === 0 ? value : output + value.slice(copiedThrough);
}

function isRawJsonValue(value: string): boolean {
  const first = value.trimStart()[0];
  if (first !== '"' && first !== "{" && first !== "[") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function isWireDecodedJsonValue(value: string): boolean {
  const view = buildExactWireDecodedView(value);
  if (!view || view === EXACT_WIRE_VIEW_EXHAUSTED) return false;
  try {
    JSON.parse(view.decoded);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace only explicitly supplied private values and their one-layer JSON or
 * URL-percent-encoded spellings, including one layer of each in either order.
 * Unlike `redactSecretString`, this preserves JSON structure and unrelated
 * account identifiers.
 */
export function redactExactSecretOccurrences(
  value: string,
  exactValues: readonly (string | null | undefined)[] = [],
): string {
  const exact = new Set<string>();
  for (const exactValue of exactValues) {
    if (!exactValue) continue;
    exact.add(exactValue);
  }
  const privateValues = [...exact].sort((a, b) => b.length - a.length);
  if (privateValues.length === 0) return value;
  const hasComposedEncoding = /%5c/i.test(value)
    || (value.includes("\\") && value.includes("%"));
  const rawJsonIsValid = hasComposedEncoding && isRawJsonValue(value);
  const canChangeJsonStructure = /%(?:22|2c|3a|5b|5c|5d|7b|7d)/i.test(value);
  // A body can be valid JSON both before and after URL decoding while exposing
  // different string-token boundaries. Evaluate both projections when that is
  // possible. For oversized structural polyglots, preserve safety and bounded
  // work by returning one valid JSON marker instead of materializing both trees.
  if (rawJsonIsValid && canChangeJsonStructure
    && value.length > MAX_EXACT_COMPOSED_JSON_TOKEN_LENGTH) {
    return JSON.stringify(REDACTED_SECRET);
  }
  const wireJsonIsAlsoValid = rawJsonIsValid
    && canChangeJsonStructure
    && isWireDecodedJsonValue(value);
  const rawJsonExclusivelyOwnsTokens = rawJsonIsValid && !wireJsonIsAlsoValid;

  // Apply every supported projection for one value before advancing to the
  // next-shorter value. Value-first ordering prevents a visible short prefix
  // from consuming a longer secret whose suffix appears only after another decoder.
  let redacted = value;
  for (const exactValue of privateValues) {
    // Remove URL-outer and mixed-boundary matches before a raw quote can pair
    // with a later field under the competing JSON-first interpretation.
    if (!rawJsonExclusivelyOwnsTokens) {
      redacted = replacePercentEncodedJsonExactOccurrences(
        redacted,
        exactValue,
        "encoded-or-mixed",
      );
    }
    redacted = replaceRawJsonExactOccurrences(redacted, exactValue);
    // Raw/raw tokens that only become valid after URL decoding are not owned by
    // the raw lexer; handle those after valid raw tokens have had first choice.
    if (!rawJsonExclusivelyOwnsTokens) {
      redacted = replacePercentEncodedJsonExactOccurrences(redacted, exactValue, "raw");
    }
    const jsonEscaped = JSON.stringify(exactValue).slice(1, -1);
    if (jsonEscaped !== exactValue) {
      redacted = redacted.replaceAll(jsonEscaped, REDACTED_SECRET);
    }
    redacted = replaceWireExactOccurrences(redacted, exactValue);
  }
  return redacted;
}

/**
 * Sanitize a client-facing diagnostic while retaining exact knowledge of the
 * credentials that were injected into the upstream request.
 *
 * Exact replacement must run first: opaque access tokens and account ids do
 * not necessarily match a generic credential grammar. Generic redaction then
 * catches labelled or token-shaped material unrelated to the supplied values.
 * Callers must apply any display-length cap only after this function returns so
 * slicing cannot turn a recognizable credential into an unrecognized prefix.
 */
export function redactClientDiagnostic(
  value: string,
  exactValues: readonly (string | null | undefined)[] = [],
): string {
  return redactSecretString(redactExactSecretOccurrences(value, exactValues));
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactSecretString(value);
  if (Array.isArray(value)) return value.map(item => redactSecrets(item));
  if (value instanceof Date) return value;
  if (!isPlainObject(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED_SECRET : redactSecrets(entryValue);
  }
  return result;
}

export function redactHeaders(headers: Headers | HeaderRecord): Record<string, string> {
  const result: Record<string, string> = {};
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);

  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.toLowerCase();
    if (rawValue === undefined) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue);
    result[key] = isSensitiveKey(key) ? REDACTED_SECRET : redactSecretString(value);
  }

  return result;
}

export function redactUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return redactSecretString(url.split("?")[0] ?? url);
  }
}

const USER_HOME_PATH_PATTERNS: Array<[RegExp, string]> = [
  // Windows: C:\Users\<name>\...  ->  C:\Users\[USER]\...
  [/([A-Za-z]:\\Users\\)[^\\/]+/gi, "$1[USER]"],
  // POSIX: /Users/<name>/... (macOS) and /home/<name>/... (Linux)
  [/(\/(?:Users|home)\/)[^/]+/gi, "$1[USER]"],
];

// Path segments whose name alone looks sensitive. Masked so a configured path
// cannot surface a secret-flavored substring in diagnostics or logs.
const SENSITIVE_SEGMENT_PATTERN = /(^|[\\/])([^\\/]*(?:secret|password|passwd|token|api[-_]?key|apikey|credential|email)[^\\/]*)(?=[\\/]|$)/gi;

/**
 * Mask the username segment of an absolute home path so diagnostics can print
 * paths without leaking the OS account name, and mask any path segment whose
 * name looks sensitive (token/secret/password/credential/email/...). Path-focused
 * and secret-safe: also runs {@link redactSecretString} for token-shaped values.
 */
export function redactUserPath(path: string): string {
  let masked = path;
  for (const [pattern, replacement] of USER_HOME_PATH_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }
  masked = masked.replace(SENSITIVE_SEGMENT_PATTERN, (_m, sep: string) => `${sep}[REDACTED]`);
  return redactSecretString(masked);
}
