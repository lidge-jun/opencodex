export const REDACTED_SECRET = "[REDACTED]";

/**
 * Credential-bearing header/field names. Exported for transports that must refuse to send
 * credentials over an unsafe channel (e.g. plaintext non-loopback HTTP) rather than
 * re-deriving a narrower local list.
 */
export const SENSITIVE_KEY_PATTERN = /^(?:authorization|proxy-authorization|cookie|set-cookie|set-cookie2|api[-_]?key|x-api-key|x-goog-api-key|x-amz-security-token|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|client[-_]?secret|password|profile[-_]?arn|exa[-_]?api[-_]?key)$/i;

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
const CREDENTIAL_HEADER_LABEL_RAW = "x-api-key|x-goog-api-key|x-amz-security-token|api[_-]?key|apiKey|exa[_-]?api[_-]?key|exaApiKey|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|id[_-]?token|client[_-]?secret|clientSecret|authorization|proxy-authorization|cookie|set-cookie|password|secret|token";

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
    const quote = "";
    // `Bearer` is a fixed prefix, reproduced from a literal — never copied from
    // the input — and only where an auth scheme is meaningful.
    const label = match[0].replace(/[^\S\r\n]*:$/, "").trim();
    const isAuthHeader = /^(?:proxy-)?authorization$/i.test(label);
    const prefix = isAuthHeader && new RegExp(`^[^\\S\\r\\n]*${quote}?Bearer[^\\S\\r\\n]`, "i").test(rawValue)
      ? "Bearer "
      : "";
    out += value.slice(cursor, afterLabel) + gap + quote + prefix + REDACTED_SECRET + quote;
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

/** Shared bounded representation for caller-controlled scalar metadata stored in logs. */
export function sanitizeLogMetadataString(value: unknown, maxLength = 64): string | undefined {
  if (typeof value !== "string" || !Number.isInteger(maxLength) || maxLength < 1) return undefined;
  // Remove every control/line-separator code point that common terminals and log viewers
  // can render as a record boundary before the value reaches a single-line log field.
  const filtered = value.trim().replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "");
  if (!filtered) return undefined;
  const redacted = redactSecretString(filtered).trim();
  return redacted ? redacted.slice(0, maxLength) : undefined;
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
