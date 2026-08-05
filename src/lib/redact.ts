export const REDACTED_SECRET = "[REDACTED]";

const SENSITIVE_KEY_PATTERN = /^(?:authorization|proxy-authorization|cookie|set-cookie|set-cookie2|api[-_]?key|x-api-key|x-goog-api-key|x-amz-security-token|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|client[-_]?secret|password|profile[-_]?arn)$/i;

const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer)(\s+)[A-Za-z0-9._~+/=-]{8,}\b/gi, `$1$2${REDACTED_SECRET}`],
  [/\b(sk-[A-Za-z0-9][A-Za-z0-9._-]{6,})\b/g, REDACTED_SECRET],
  // GitHub tokens (classic + fine-grained + OAuth/refresh): ghp_/gho_/ghu_/ghs_/ghr_/github_pat_.
  [/\b(gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED_SECRET],
  // GitHub Copilot API tokens: semicolon-joined k=v grammar starting with tid=…
  // (e.g. "tid=abc123;exp=1699999999;sku=copilot_pro;…:sig"). Redact the whole token —
  // a Bearer-prefix rule alone leaves the suffix intact.
  [/\btid=[A-Za-z0-9-]+(?:;[A-Za-z0-9_.-]+=[^;\s"']*)+(?::[A-Za-z0-9+/=_-]+)?/g, REDACTED_SECRET],
  [/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|refreshToken|accessToken|clientSecret|apiKey)=)([^&\s"',;]+)/gi, `$1${REDACTED_SECRET}`],
  // Colon-labelled credentials. Upstream error bodies quote the offending header
  // or field back at us ("x-api-key: abc…"), and the `=` rules never fire for
  // that shape, so the credential survived into client-visible error text.
  //
  // The value class deliberately runs to end-of-line rather than stopping at a
  // quote, space, or semicolon. A first attempt tokenized on those characters
  // and leaked every delimiter-bearing variant: `x-api-key: "quoted…"` kept the
  // whole quoted secret, `Authorization: Basic dXNlcjpwYXNz` kept the payload
  // after the scheme, and `Cookie: a=1; b=2` kept everything after the first
  // `;`. A credential header's value IS the rest of the line, so that is what
  // gets masked.
  //
  // `Bearer` is the one readable exception, and it is handled by the dedicated
  // Bearer rule ABOVE rather than here: an auth scheme is diagnostically useful,
  // and its token is a single opaque word, so consuming the rest of the line
  // there would swallow trailing diagnostics that follow a quoted header in
  // prose (`… Authorization: Bearer <tok> at /path/file.json`). Every other
  // scheme (Basic, Digest, …) carries its credential as the payload, so those
  // are masked whole by this rule.
  //
  // The rules run in order, so by the time this one fires the Bearer rule has
  // already replaced `Bearer <tok>` with `Bearer [REDACTED]`. Skipping a value
  // that is already redacted keeps this rule from eating that result — and from
  // eating the trailing diagnostics after it.
  [/\b((?:x-api-key|x-goog-api-key|x-amz-security-token|api[_-]?key|apiKey|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|id[_-]?token|client[_-]?secret|clientSecret|authorization|proxy-authorization|cookie|set-cookie|password|secret|token)\s*:)(?![^\S\r\n]*(?:Bearer\b|\[REDACTED\]|\r?\n|$))([^\S\r\n]*)[^\r\n]+/gi, `$1$2${REDACTED_SECRET}`],
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
  let redacted = value;
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
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
