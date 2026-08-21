export interface SafeWebSearchSource {
  url: string;
  title?: string;
}

export const MAX_WEB_SEARCH_SOURCES = 20;
export const MAX_WEB_SEARCH_URL_BYTES = 2_048;
export const MAX_WEB_SEARCH_TITLE_BYTES = 256;
export const MAX_WEB_SEARCH_SOURCE_BYTES = 16_384;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function serializedSourceBytes(source: SafeWebSearchSource): number {
  return byteLength(JSON.stringify(source));
}

function safeTitle(value: unknown): string | undefined {
  if (typeof value !== "string"
    || value.trim().length === 0
    || CONTROL_CHARACTERS.test(value)
    || byteLength(value) > MAX_WEB_SEARCH_TITLE_BYTES) return undefined;
  return value;
}

/** Add one client-safe citation while enforcing per-message count and byte budgets. */
export function appendSafeWebSearchSource(target: SafeWebSearchSource[], source: unknown): boolean {
  if (target.length >= MAX_WEB_SEARCH_SOURCES || !source || typeof source !== "object") return false;
  const candidate = source as { url?: unknown; title?: unknown };
  if (typeof candidate.url !== "string"
    || candidate.url.length === 0
    || candidate.url.trim() !== candidate.url
    || CONTROL_CHARACTERS.test(candidate.url)
    || byteLength(candidate.url) > MAX_WEB_SEARCH_URL_BYTES
    || target.some(existing => existing.url === candidate.url)) return false;

  let parsed: URL;
  try { parsed = new URL(candidate.url); } catch { return false; }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username.length > 0
    || parsed.password.length > 0) return false;

  const title = safeTitle(candidate.title);
  const next = title === undefined ? { url: candidate.url } : { url: candidate.url, title };
  const usedBytes = target.reduce((sum, item) => sum + serializedSourceBytes(item), 0);
  if (usedBytes + serializedSourceBytes(next) > MAX_WEB_SEARCH_SOURCE_BYTES) return false;
  target.push(next);
  return true;
}

export function safeWebSearchSources(sources: unknown): SafeWebSearchSource[] {
  if (!Array.isArray(sources)) return [];
  const safe: SafeWebSearchSource[] = [];
  for (const source of sources) appendSafeWebSearchSource(safe, source);
  return safe;
}
