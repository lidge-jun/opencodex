/**
 * Text encoding for the `<string>` and `<key>` values a generated launchd plist carries.
 *
 * XML 1.0 normalizes line ends in element content: a conforming parser reads a literal CR,
 * or a CR LF pair, as one LF. CoreFoundation keeps the CR, but a value must not depend on
 * which parser reads it, so CR, LF and tab are written as character references, which every
 * parser returns unchanged. Characters XML 1.0 cannot represent at all are refused: a plist
 * carrying one would be rejected or silently truncated by the parser that loads it.
 */

const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const ENCODED: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
  "\t": "&#9;",
  "\n": "&#10;",
  "\r": "&#13;",
};

/**
 * Encode one plist text value. `field` names the value in the refusal; the value itself is
 * never echoed, because proxy environment values can carry credentials.
 */
export function encodePlistString(value: string, field: string): string {
  const forbidden = XML_FORBIDDEN.exec(value);
  if (forbidden) {
    const code = forbidden[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
    throw new Error(
      `refusing to write the launchd plist: ${field} contains U+${code}, which an XML 1.0 plist cannot represent. `
      + `Remove that character from ${field} and retry.`,
    );
  }
  return value.replace(/[&<>"'\t\n\r]/g, ch => ENCODED[ch]!);
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Decode a plist text value in one pass, so `&amp;lt;` stays `&lt;`. Unknown or invalid
 * references are left as written.
 */
export function decodePlistString(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (match, ref: string) => {
    if (!ref.startsWith("#")) return NAMED[ref]!;
    const code = ref.startsWith("#x") ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
    return code <= 0x10FFFF ? String.fromCodePoint(code) : match;
  });
}

/** `<key>NAME</key><string>VALUE</string>` from a plist body, decoded, or null. */
export function plistKeyedString(body: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<string>([^<]*)</string>`).exec(body);
  return match ? decodePlistString(match[1]!) : null;
}
