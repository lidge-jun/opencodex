/**
 * Decode bounded text emitted by Windows system tools.
 *
 * [Decision Log]
 * - Purpose: preserve non-ASCII paths when a Windows tool writes the active
 *   legacy code page instead of UTF-8.
 * - Existing constraint: generated service assets may be UTF-16, while
 *   redirected `schtasks` output follows the Windows locale on affected hosts.
 * - Alternatives considered: replacement-character heuristics and a new
 *   iconv dependency. The former can reinterpret valid text; the latter widens
 *   the install/security surface for two small, already-supported codecs.
 * - Choice: recognize UTF-16 first, accept only strict UTF-8 next, then use the
 *   locale-appropriate WHATWG decoder (CP949 through `euc-kr`, or Windows-1252
 *   only for locales that actually use that family). Unknown/unsupported
 *   locales fail back to the old replacement-preserving UTF-8 result instead
 *   of guessing another code page or throwing in diagnostics.
 * - Impact: decoding stays dependency-free and bounded, but this deliberately
 *   does not guess arbitrary OEM code pages that the runtime cannot identify.
 */

function trimWindowsText(value: string): string {
  return value.replace(/^\uFEFF/, "").trim();
}

function currentWindowsLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "en-US";
  }
}

function decodeStrict(buffer: Uint8Array, encoding: string): string | null {
  try {
    return trimWindowsText(new TextDecoder(encoding, { fatal: true }).decode(buffer));
  } catch {
    return null;
  }
}

function decodeUtf16Be(buffer: Uint8Array): string {
  const payloadLength = buffer.length - 2;
  const swapped = Buffer.alloc(payloadLength - (payloadLength % 2));
  for (let i = 2; i + 1 < buffer.length; i += 2) {
    swapped[i - 2] = buffer[i + 1]!;
    swapped[i - 1] = buffer[i]!;
  }
  return trimWindowsText(swapped.toString("utf16le"));
}

/**
 * CP949 is exposed by the Encoding Standard under the `euc-kr` label. Keep the
 * Western fallback deliberately narrow: treating CP932, CP1250, or CP1251
 * bytes as Windows-1252 can fabricate a different valid-looking filesystem
 * path, which is worse than the previous replacement-character refusal.
 */
function legacyEncodingForLocale(locale: string): "euc-kr" | "windows-1252" | null {
  const language = locale.trim().split(/[-_]/, 1)[0]?.toLowerCase();
  if (language === "ko") return "euc-kr";
  if (language && WINDOWS_1252_LANGUAGES.has(language)) return "windows-1252";
  return null;
}

const WINDOWS_1252_LANGUAGES = new Set([
  "af", "br", "ca", "co", "cy", "da", "de", "en", "es", "eu", "fi", "fo", "fr",
  "ga", "gd", "gl", "id", "is", "it", "lb", "ms", "nl", "no", "oc", "pt", "sq",
  "sv", "sw",
]);

export interface WindowsTextDecodeOptions {
  /** Test seam and explicit locale override; production uses the active Intl locale. */
  readonly locale?: string;
}

export function decodeWindowsTextBytes(
  buffer: Uint8Array,
  options: WindowsTextDecodeOptions = {},
): string {
  if (buffer.length === 0) return "";

  const bomUtf16Le = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  const bomUtf16Be = buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff;
  const looksUtf16Le = buffer.length >= 4
    && buffer[1] === 0x00
    && buffer[3] === 0x00
    && buffer[0] !== 0x00;

  if (bomUtf16Le || looksUtf16Le) {
    return trimWindowsText(Buffer.from(buffer).toString("utf16le"));
  }
  if (bomUtf16Be) return decodeUtf16Be(buffer);

  const utf8 = decodeStrict(buffer, "utf-8");
  if (utf8 !== null) return utf8;

  const locale = options.locale ?? currentWindowsLocale();
  const legacyEncoding = legacyEncodingForLocale(locale);
  if (legacyEncoding !== null) {
    const legacy = decodeStrict(buffer, legacyEncoding);
    if (legacy !== null) return legacy;
  }

  // Preserve the previous fail-soft behavior when the runtime lacks a codec or
  // the bytes are malformed even for the selected Windows code page.
  return trimWindowsText(new TextDecoder("utf-8").decode(buffer));
}
