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
/** RFC 9110 auth-param: token BWS "=" BWS ( token / quoted-string ); also cookie and k=v pairs. */
const AUTH_PARAM = /([!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]*=[ \t]*("(?:[^"\\]|\\.)*"|[^\s,;"]*)/g;
const BASIC_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PRINTABLE_USER_PASS = /^[\x20-\x7e]*:[\x20-\x7e]*$/;

/** True for a header (or config field) name whose value is a credential by its name. */
export function isCredentialName(name: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(name) || CREDENTIAL_HEADER_NAME.test(name);
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
  for (const [, , raw] of whole.matchAll(AUTH_PARAM)) {
    const param = raw!.startsWith('"') ? raw!.slice(1, -1).replace(/\\(.)/g, "$1") : raw!;
    if (param && !/^=+$/.test(param)) out.add(param);
  }
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

  constructor(options: OutboundCredentialRegistryOptions = {}) {
    const entries = options.maxEntries ?? 4096;
    const bytes = options.maxBytes ?? 1 << 20;
    const valueBytes = options.maxValueBytes ?? 16_384;
    this.strict = new BoundedValueSet(entries, bytes, valueBytes);
    this.observed = new BoundedValueSet(entries, bytes, valueBytes);
  }

  /** Record the components of every value in headers that are about to be sent. */
  remember(headers: HeadersInit | Headers | undefined): void {
    if (!headers) return;
    new Headers(headers).forEach((value, name) => {
      const strict = isCredentialName(name);
      if (!strict && CORRELATION_HEADER_NAME.test(name)) return;
      const tier = strict ? this.strict : this.observed;
      for (const part of credentialComponents(value)) tier.add(part);
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
