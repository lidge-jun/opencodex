/**
 * Process-local record of credential values this process has handed to an upstream.
 *
 * Upstream diagnostics (error codes, request ids) are provider-controlled. A gateway can echo a
 * credential it received back into those fields, and a credential with no recognizable format slips
 * past pattern redaction. Configured credentials are read directly at capture time (see
 * server/configured-credentials); this registry adds the values that only exist at send time, such
 * as a client-forwarded bearer or a plugin-added header.
 *
 * Two tiers keep ordinary traffic from disabling diagnostics. Values of credential-named headers are
 * strict: they match at any length, and once one is evicted coverage is incomplete for the rest of
 * the process, so callers fail closed. Every other header value is best effort: it matches only at
 * eight characters or more and its eviction never disables diagnostics, so per-turn metadata cannot
 * exhaust anything that matters. Correlation ids (request ids, trace context) are left out of the
 * best-effort tier because a gateway legitimately echoes them as its request id; a configured header
 * of that name is still covered by the configured set. Values are held in memory only: nothing here
 * is serialized, persisted or exposed.
 */
import { SENSITIVE_KEY_PATTERN } from "./redact";

/** Containment only for credentials long enough that a diagnostic cannot contain one by chance. */
export const CREDENTIAL_SUBSTRING_MIN_LENGTH = 8;
const CREDENTIAL_HEADER_NAME = /api[-_]?key|secret|passw|credential|auth|(?:^|[-_])token$/i;
const CORRELATION_HEADER_NAME = /^(?:x-(?:client-)?request-id|request-id|traceparent|tracestate)$/i;
const AUTH_SCHEMES = new Set(["bearer", "basic", "token", "digest", "apikey", "api-key", "key", "sso-key", "negotiate", "dpop"]);
const TOKEN_CHAR = /[!#$%&'*+.^_`|~0-9A-Za-z-]/;
const BASIC_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PRINTABLE_USER_PASS = /^[\x20-\x7e]*:[\x20-\x7e]*$/;

/** True for a header (or config field) name whose value is a credential by its name. */
export function isCredentialName(name: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(name) || CREDENTIAL_HEADER_NAME.test(name);
}

/** True for a request-correlation header: an identifier, not a credential, and never recorded. */
export function isCorrelationHeaderName(name: string): boolean {
  return CORRELATION_HEADER_NAME.test(name);
}

/** Characters of a text a sent-value guard reads: a caller emits no copy beyond them. */
export const SENT_VALUE_GUARD_SCAN_CHARS = 8_192;
const MAX_SENT_CREDENTIAL_WINDOWS = 65_536;

function spellings(part: string): string[] {
  const escaped = JSON.stringify(part).slice(1, -1);
  return escaped === part ? [part] : [part, escaped];
}

/**
 * Whether text repeats a value these outbound headers carry, decided from this request's own
 * headers so no global eviction can open it. A credential-named component is recognized whole at
 * any length and by any excerpt of 8+ characters (its 8-character windows, capped: past the cap the
 * guard fails closed); any other non-correlation component is recognized when 8+ characters of it
 * occur whole. Only the first {@link SENT_VALUE_GUARD_SCAN_CHARS} characters are read, so work is
 * bounded; callers emit nothing beyond them.
 */
export function createSentValueGuard(headers: Record<string, string>): (text: string) => boolean {
  const wholeCredential = new Set<string>();
  const credentialWindows = new Set<string>();
  const contained: string[] = [];
  let overflow = false;
  for (const [name, value] of Object.entries(headers)) {
    const credentialNamed = isCredentialName(name);
    if (!credentialNamed && CORRELATION_HEADER_NAME.test(name)) continue;
    for (const part of credentialComponents(value)) {
      if (!credentialNamed) {
        if (part.length >= CREDENTIAL_SUBSTRING_MIN_LENGTH) contained.push(...spellings(part));
        continue;
      }
      // Excerpt windows come from bare tokens only: a composite (an auth scheme and its token, a
      // name=value pair) would yield windows of scheme or field-name text holding fewer than eight
      // characters of secret. Its secret parts are components of their own.
      const bareToken = !/[\s,;]/.test(part) && !/^[^=]+=[^=]/.test(part);
      for (const spelling of spellings(part)) {
        wholeCredential.add(spelling);
        for (let at = 0; bareToken && at + CREDENTIAL_SUBSTRING_MIN_LENGTH <= spelling.length && !overflow; at++) {
          credentialWindows.add(spelling.slice(at, at + CREDENTIAL_SUBSTRING_MIN_LENGTH));
          if (credentialWindows.size > MAX_SENT_CREDENTIAL_WINDOWS) overflow = true;
        }
      }
    }
  }
  return (text) => {
    if (overflow) return true;
    const head = text.length > SENT_VALUE_GUARD_SCAN_CHARS ? text.slice(0, SENT_VALUE_GUARD_SCAN_CHARS) : text;
    if (wholeCredential.has(head)) return true;
    for (let at = 0; at + CREDENTIAL_SUBSTRING_MIN_LENGTH <= head.length; at++) {
      if (credentialWindows.has(head.slice(at, at + CREDENTIAL_SUBSTRING_MIN_LENGTH))) return true;
    }
    return contained.some(part => head.includes(part));
  };
}

/**
 * Replace every span of text a secret covers: the whole text when it equals a whole-only value, and
 * every occurrence of each substring value. Coverage is marked on the original text before anything
 * is replaced, so overlapping values are replaced as one union and no part of either survives
 * between them. Each secret marks only characters past its previous occurrence, so the work and the
 * one coverage array stay linear in the text length however often a secret repeats.
 */
export function maskSecretSpans(text: string, replacement: string, substrings: Iterable<string>, wholeOnly: Iterable<string> = []): string {
  for (const value of wholeOnly) if (value && text === value) return replacement;
  let covered: Uint8Array | undefined;
  for (const secret of substrings) {
    if (!secret) continue;
    let markedTo = 0;
    for (let at = text.indexOf(secret); at >= 0; at = text.indexOf(secret, at + 1)) {
      covered ??= new Uint8Array(text.length);
      const end = at + secret.length;
      covered.fill(1, Math.max(at, markedTo), end);
      markedTo = end;
    }
  }
  if (covered === undefined) return text;
  let out = "";
  let at = 0;
  while (at < text.length) {
    const run = covered[at];
    let next = at + 1;
    while (next < text.length && covered[next] === run) next++;
    out += run ? replacement : text.slice(at, next);
    at = next;
  }
  return out;
}

/**
 * Values of RFC 9110 auth-params (token BWS "=" BWS ( token / quoted-string )), cookie pairs and
 * other name=value pairs, in one linear pass: every character is visited a bounded number of times,
 * so a long header value cannot stall the event loop.
 */
function parameterValues(value: string): string[] {
  const out: string[] = [];
  const n = value.length;
  let unclosedFrom = n; // no closing quote exists for any opening quote at or after this index
  let i = 0;
  while (i < n) {
    if (!TOKEN_CHAR.test(value[i]!)) { i++; continue; }
    while (i < n && TOKEN_CHAR.test(value[i]!)) i++;
    let j = i;
    while (j < n && (value[j] === " " || value[j] === "\t")) j++;
    if (value[j] !== "=") { i = j; continue; }
    j++;
    while (j < n && (value[j] === " " || value[j] === "\t")) j++;
    if (value[j] === "\"") {
      let k = j + 1;
      let text = "";
      let closed = false;
      if (j < unclosedFrom) {
        while (k < n) {
          const char = value[k]!;
          if (char === "\\" && k + 1 < n) { text += value[k + 1]; k += 2; continue; }
          if (char === "\"") { closed = true; break; }
          text += char;
          k++;
        }
      }
      if (closed) {
        if (text) out.push(text);
        i = k + 1;
      } else {
        unclosedFrom = Math.min(unclosedFrom, j);
        i = j + 1;
      }
      continue;
    }
    const start = j;
    while (j < n && !/[\s,;"]/.test(value[j]!)) j++;
    const raw = value.slice(start, j);
    if (raw && !/^=+$/.test(raw)) out.push(raw);
    i = j;
  }
  return out;
}

/**
 * The whole value plus every part a server could authenticate with on its own: tokens split on
 * whitespace, commas and semicolons with auth scheme words dropped, the value of each name=value
 * parameter (cookies, digest; whitespace around "=" and quoted strings with escapes are parsed
 * first, before any splitting), and both halves of a standard Basic credential.
 */
export function credentialComponents(value: string): string[] {
  const whole = value.trim();
  if (!whole) return [];
  const out = new Set([whole]);
  for (const param of parameterValues(whole)) out.add(param);
  let previous: string | undefined;
  for (const part of whole.split(/[\s,;]+/)) {
    if (!part) continue;
    const lower = part.toLowerCase();
    if (AUTH_SCHEMES.has(lower)) { previous = lower; continue; }
    out.add(part);
    if (previous === "basic" && BASIC_BASE64.test(part)) {
      const decoded = Buffer.from(part, "base64").toString("utf8");
      if (PRINTABLE_USER_PASS.test(decoded) && Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/, "") === part.replace(/=+$/, "")) {
        const colon = decoded.indexOf(":");
        out.add(decoded.slice(0, colon));
        out.add(decoded.slice(colon + 1));
      }
    }
    previous = undefined;
  }
  out.delete("");
  return [...out];
}

/** Exact equality at any length at or above minLength; containment for values of 8+ characters. */
export function credentialSetMatches(values: Iterable<string>, has: (value: string) => boolean, value: string, minLength = 1): boolean {
  if (value.length >= minLength && has(value)) return true;
  for (const secret of values) {
    if (secret.length >= Math.max(minLength, CREDENTIAL_SUBSTRING_MIN_LENGTH) && value.includes(secret)) return true;
  }
  return false;
}

export interface OutboundCredentialRegistryOptions {
  maxEntries?: number;
  maxBytes?: number;
  maxValueBytes?: number;
}

/** Bounded LRU of values; eviction marks it incomplete. */
class BoundedValueSet {
  readonly values = new Map<string, number>();
  private totalBytes = 0;
  complete = true;
  constructor(private readonly maxEntries: number, private readonly maxBytes: number, private readonly maxValueBytes: number) {}

  add(value: string): void {
    if (!value) return;
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > this.maxValueBytes) {
      this.complete = false;
      return;
    }
    if (this.values.has(value)) {
      this.values.delete(value);
      this.values.set(value, bytes);
      return;
    }
    this.values.set(value, bytes);
    this.totalBytes += bytes;
    while (this.values.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.values.keys().next().value as string;
      this.totalBytes -= this.values.get(oldest)!;
      this.values.delete(oldest);
      this.complete = false;
    }
  }

  matches(value: string, minLength: number): boolean {
    return credentialSetMatches(this.values.keys(), candidate => this.values.has(candidate), value, minLength);
  }
}

export class OutboundCredentialRegistry {
  private readonly strict: BoundedValueSet;
  private readonly observed: BoundedValueSet;
  private readonly maxValueBytes: number;

  constructor(options: OutboundCredentialRegistryOptions = {}) {
    const entries = options.maxEntries ?? 4096;
    const bytes = options.maxBytes ?? 1 << 20;
    const valueBytes = options.maxValueBytes ?? 16_384;
    this.maxValueBytes = valueBytes;
    this.strict = new BoundedValueSet(entries, bytes, valueBytes);
    this.observed = new BoundedValueSet(entries, bytes, valueBytes);
  }

  /**
   * Record the components of every value in headers that are about to be sent. A component too
   * large to keep, credential-named or not, marks the registry incomplete: no bounded record can
   * recognize every excerpt of it, so every caller fails closed instead.
   */
  remember(headers: HeadersInit | Headers | undefined): void {
    if (!headers) return;
    new Headers(headers).forEach((value, name) => {
      const strict = isCredentialName(name);
      if (!strict && CORRELATION_HEADER_NAME.test(name)) return;
      const tier = strict ? this.strict : this.observed;
      for (const part of credentialComponents(value)) {
        tier.add(part);
        if (Buffer.byteLength(part, "utf8") > this.maxValueBytes) this.strict.complete = false;
      }
    });
  }

  /** True when value repeats a recorded credential (strict at any length, best effort at 8+). */
  matches(value: string): boolean {
    return this.strict.matches(value, 1) || this.observed.matches(value, CREDENTIAL_SUBSTRING_MIN_LENGTH);
  }

  /** False once a credential-named value was dropped; callers must then fail closed. */
  complete(): boolean {
    return this.strict.complete;
  }
}

let active = new OutboundCredentialRegistry();

/** The registry fed by the HTTP executor boundary and the Codex WebSocket dial. */
export function outboundCredentials(): OutboundCredentialRegistry {
  return active;
}

/** Swap the active registry for sequential in-file tests; returns the restore function. */
export function setOutboundCredentialRegistryForTests(registry: OutboundCredentialRegistry): () => void {
  const previous = active;
  active = registry;
  return () => { active = previous; };
}
