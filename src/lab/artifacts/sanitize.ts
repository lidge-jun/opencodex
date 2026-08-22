/**
 * Deny-by-default sanitization before artifact hashing/writing.
 * Never persists prompts, secrets, paths, account IDs, raw URLs, or provider bodies.
 */
import type { ArtifactClass } from "../constants";
import { MAX_SANITIZED_STRING_FIELD } from "../constants";
import { jcsStringify } from "../digest";
import { redactSecretString } from "../../lib/redact";

const FORBIDDEN_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|x-api-key|token|secret|password|email|prompt|messages|content|body|url|hostname|baseUrl|path|account|alias)$/i;
const SECRETISH = /sk-[a-z0-9]{10,}|credential-canary-[a-z0-9]{10,}|Bearer\s+[A-Za-z0-9._\-]+|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}/i;
const SECRETISH_GLOBAL = new RegExp(SECRETISH.source, "gi");

export function redactForArtifact(artifactClass: ArtifactClass, payload: unknown): unknown {
  if (
    artifactClass === "fixture" ||
    artifactClass === "scenario_manifest" ||
    artifactClass === "suite_manifest" ||
    artifactClass === "claim_source_manifest"
  ) {
    // Contract artifacts are already synthetic/canonical. Mutating them would
    // invalidate content-addressed digests; reject secret-shaped material instead.
    assertNoSecretMaterial(payload, 0);
    return payload;
  }
  return scrubValue(payload, 0);
}

const FORBIDDEN_CONTRACT_KEYS = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|x-api-key|token|secret|password|email|prompt|messages|baseUrl|hostname|account|alias)$/i;

function assertNoSecretMaterial(value: unknown, depth: number): void {
  if (depth > 8) {
    throw new Error("contract artifact exceeds sanitization inspection depth");
  }
  if (typeof value === "string") {
    if (SECRETISH.test(value)) {
      throw new Error("contract artifact contains forbidden secret-shaped material");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretMaterial(item, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as object)) {
      if (FORBIDDEN_CONTRACT_KEYS.test(key)) {
        throw new Error(`contract artifact forbids key ${key}`);
      }
      assertNoSecretMaterial(child, depth + 1);
    }
  }
}

function scrubValue(value: unknown, depth: number): unknown {
  if (depth > 8) return "[truncated_depth]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return scrubString(value);
  if (value instanceof Uint8Array) {
    const text = new TextDecoder().decode(value);
    return new TextEncoder().encode(scrubString(text));
  }
  if (Array.isArray(value)) {
    if (value.length > 256) return value.slice(0, 256).map((v) => scrubValue(v, depth + 1));
    return value.map((v) => scrubValue(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as object).slice(0, 64);
    for (const key of keys) {
      if (FORBIDDEN_KEY.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = scrubValue((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  return "[unsupported]";
}

/**
 * Provider-controlled text can carry network and account identifiers that the
 * Compatibility Lab privacy contract forbids persisting. The rules below run in
 * a fixed total order; the order is load-bearing and documented in
 * `devlog/_fin/260810_release_train_and_triage/040_sec02_remediation.md`:
 *
 *   email before hostname   - else the hostname rule eats `example.com` in an address
 *   MAC before IPv6         - else `01:23:45:67:89:ab` matches as a mangled address
 *   IPv6 before IPv4        - else `::ffff:192.0.2.128` degrades to `::ffff:[ip]`
 *   HTTP before other URIs  - and the URI rule refuses http(s) so it cannot
 *                             re-match this rule's own `https://[host]/path` output
 *
 * Every rule replaces a value whole or not at all. A prefix replacement is
 * worse than no rule, because the output looks redacted while the tail leaks.
 */

/** Bounded, non-nested. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,512}\b/g;
// Both patterns end with a lookahead rather than `\b`, because `\b` fires
// between a letter and `-`: `ops@…xn--p1ai` matched only up to the first
// hyphen and left `[email]--p1ai`, and `acct_abcdef-prod` left `[account]-prod`.
// A prefix replacement looks redacted while the tail leaks, which is the one
// thing this module must never do.
// The local part accepts more than an ASCII dot-atom: an internationalized or
// quoted local part is still the account-identifying half of the address, and
// matching only the domain left `用户@[host]` and `"ops"@[host]` behind.
const EMAIL_RE =
  /(?:"[^"\n]{1,64}"|[^\s@<>()[\],;:"]{1,64})@[^\s@<>()[\],;:"]{1,255}\.(?:xn--[a-z0-9-]{1,55}|\p{L}{2,24})(?![\w.-])/giu;
// The value run includes hyphens so `acct_abcdef-prod` is consumed whole. A
// `\b`-terminated form matched only `acct_abcdef` and left `-prod` dangling
// after the token, which reads as redacted while leaking the remainder.
const PREFIXED_ACCOUNT_RE = /\b(?:acct|cus|sub|org)[_-][A-Za-z0-9][A-Za-z0-9-]{5,63}(?![\w-])/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// `\b` treats `_` as a word character, so it does not fire between `_` and a
// digit: `backend_203.0.113.7_timeout` and `iface_01:23:45:67:89:ab_down` are
// ordinary machine-generated diagnostics that slipped past a `\b` form. These
// use explicit non-identifier boundaries on both sides instead.
// Colon notation is usual on POSIX, hyphen notation on Windows; separators
// must be consistent within one address.
const MAC_RE = /(?<![0-9A-Za-z:-])(?:(?:[0-9A-Fa-f]{2}:){5}|(?:[0-9A-Fa-f]{2}-){5})[0-9A-Fa-f]{2}(?![0-9A-Za-z:-])/g;
const IPV4_RE = /(?<![0-9A-Za-z.])(?:\d{1,3}\.){3}\d{1,3}(?![0-9A-Za-z.])/g;
// The final label is either an ordinary alphabetic TLD or a punycode one.
// Allowing hyphens and digits in every final label was too broad: it ate
// ordinary diagnostic tokens such as `foo.bar-baz` and `metric.p95`, which
// costs exactly the evidence quality the Lab exists to capture.
// A trailing `-` or word character after the TLD means this was never a
// hostname (`foo.bar-baz`), so the lookahead refuses the match. A trailing
// `.` is allowed and consumed: it is FQDN root notation and equally ordinary
// sentence punctuation, and forbidding it let `api.example.com.` through
// untouched.
//
// The leading `(?<![\w.-])` matters just as much: without it the engine
// backtracks to a later starting label and redacts a prefix, turning
// `provider.metric.p95` into `[host].p95` — evidence destruction dressed up
// as a redaction.
// An OPTIONAL trailing dot does not work: the engine simply skips it and takes
// a shorter match, so `provider.metric.p95` matched `provider.metric` and left
// `[host].p95`. The terminator is therefore mandatory and expressed as a
// single alternation — either the token ends cleanly, or it ends with an FQDN
// root dot that is itself followed by nothing label-shaped.
const HOSTNAME_RE = /(?<![\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,8}(?:xn--[a-z0-9-]{1,55}|[a-z]{2,24})(?:\.(?![\w-])|(?![\w.-]))/gi;
// The value is scanned to its delimiter, not to a word boundary: `\b` stops at
// the first `.` in `db_prod.internal`, which left `[host].internal` — a partial
// redaction that still names the host.
// `db.prod-1` and `api.us-east-1` are indistinguishable from ordinary dotted
// diagnostics by shape alone — a numeric or hyphenated final label is both a
// legitimate internal hostname and a legitimate metric or version namespace.
// Shape cannot decide it, so context does: these forms are redacted only when
// an unambiguous network marker introduces them. Outside such a marker they
// survive, and that is a recorded limit rather than an oversight.
//
// The marker grammar accepts the separators these messages actually use —
// whitespace, `=`, `:`, and JSON quoting — and the CANDIDATE IS VALIDATED
// before replacement. Accepting any following token turned
// `ETIMEDOUT after 30 seconds` into `ETIMEDOUT [host] 30 seconds`: a redaction
// that destroys the diagnostic and hides nothing.
// Markers differ in confidence, and treating them alike cost accuracy both
// ways. STRONG markers are resolver/socket errors and `host=`: whatever
// follows is a host by construction, so a bare `redis` or `localhost` counts.
// WEAK markers appear in ordinary prose (`upstream provider.metric.p95
// exceeded`), so they only redact a candidate that is already host-shaped.
const STRONG_HOST_CONTEXT_RE =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|dial\s+(?:tcp|udp)|connect(?:ing)?\s+to|host)["']?\s*[\s=:]\s*["']?((?:[A-Za-z0-9_.-]{1,255}[\s:]{1,3}){0,3}[A-Za-z0-9_.-]{1,255})/gi;
const WEAK_HOST_CONTEXT_RE =
  /\b(?:upstream)["']?\s*[\s=:]\s*["']?([A-Za-z0-9_.-]{1,255})/gi;

/**
 * A dotted run of plain alphabetic words with no digits or hyphens in any
 * label — `provider.metric.p95` reads as a namespace, not a host. Under a
 * WEAK marker this is left alone; under a STRONG one the marker decides.
 */
const DOTTED_NAMESPACE_RE = /^[a-z]+(?:\.[a-z]+)*\.[a-z]+[0-9]*$/i;

/**
 * Does this token look like a host rather than an English word?
 *
 * Even a strong marker does not guarantee the very next token is the
 * destination: Go emits `dial tcp: lookup db.prod-1: no such host`, and errno
 * codes are routinely followed by prose (`ETIMEDOUT request after 30s`).
 * Replacing whatever follows destroyed the helper word and left the real host
 * in place — the worst of both outcomes.
 *
 * A stopword list would repeat the delimiter-enumeration mistake, so the
 * candidate is validated instead. A token qualifies when it carries host
 * punctuation (dot, hyphen, underscore, digit) or is a reserved name; a bare
 * English word does not — EXCEPT directly after a resolver marker, where the
 * argument is a name by construction and `ENOTFOUND redis` must still redact.
 */
const RESERVED_HOST_NAMES = new Set(["localhost", "broadcasthost"]);
const PROSE_AFTER_MARKER = new Set([
  "lookup", "request", "connection", "attempt", "failed", "error", "timeout",
  "after", "to", "for", "at", "no", "such", "the", "a", "an", "while", "during",
]);
function isHostCandidate(value: string, bareWordAllowed = false): boolean {
  const lower = value.toLowerCase();
  if (RESERVED_HOST_NAMES.has(lower)) return true;
  if (/[.\-_0-9]/.test(value)) {
    return AMBIGUOUS_HOST_RE.test(value) || CONTEXTUAL_HOST_TOKEN_RE.test(value);
  }
  // A bare word: only a resolver marker makes it a host, and only when it is
  // not one of the connective words those messages actually use.
  return bareWordAllowed && !PROSE_AFTER_MARKER.has(lower);
}

/**
 * A dotted label run whose final label may be numeric or hyphenated — the
 * shape that is ambiguous between an internal hostname and a metric namespace.
 * A single-label token is NOT a host: accepting one turned
 * `upstream request failed` into `upstream [host] failed`.
 */
const AMBIGUOUS_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,8}[a-z0-9][a-z0-9-]{0,61}$/i;

/**
 * A single-label internal name (`db-primary`, `db_prod.internal`'s owner). A
 * bare word is only treated as a host inside an explicit network context, and
 * it must still look like a name rather than an English word carrying the
 * message — `request` and `after` are rejected by requiring a digit, hyphen,
 * underscore, or dot somewhere in the token.
 */
const CONTEXTUAL_HOST_TOKEN_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$|^[a-z]+[0-9][a-z0-9]*$/i;
// `userID` is at least as common as `userId` in provider payloads, so the id
// suffix is matched case-insensitively.
// Case-insensitive throughout: `UserID`, `USER_ID`, and `AccountId` are all
// realistic field spellings, and matching only the lowercase base label left
// them intact.
// The id suffix may be joined (`userID`), underscored (`user_id`) or spaced
// (`User ID:`) — all three are ordinary provider phrasing.
const ACCOUNT_LABEL_RE = /\b(?:user|account|organization|org|tenant|workspace|project|customer)([\s_-]?id)?\b/gi;
const IDENTIFIER_ONLY_RE = /^[A-Za-z0-9_-]+$/;
const UNQUOTED_TERMINATOR = /[\s,;)\]}]/;

function isPrefixedAccount(value: string): boolean {
  PREFIXED_ACCOUNT_RE.lastIndex = 0;
  const m = PREFIXED_ACCOUNT_RE.exec(value);
  PREFIXED_ACCOUNT_RE.lastIndex = 0;
  return m?.[0] === value;
}

/**
 * A retained URL path keeps an error message diagnosable, but its segments are
 * provider-controlled: `/users/<uuid>` or `/orgs/acct_…` carries an account
 * identifier past the host rewrite. Replace whole segments that are an
 * identifier shape; leave route names alone.
 */
function scrubUrlPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      // Decode first, then re-split: an encoded slash (`%2F`) means the
      // segment is itself a path, and matching only whole segments let
      // `/u/%2F<uuid>` through. Decoding repeats to a fixed point because a
      // single pass left `%252D` reversible.
      const decoded = decodeToFixedPoint(segment);
      if (isIdentifierShape(decoded)) return "[account]";
      // Do NOT enumerate delimiters. Chasing them cost four rounds of review:
      // first `/`, then `?#&=`, then `:` action suffixes and `;` matrix
      // parameters would have been next. Instead, find identifier shapes
      // wherever they appear in the decoded text; whatever separates them is
      // irrelevant.
      const replaced = redactIdentifiersInText(decoded);
      return replaced === decoded ? segment : replaced;
    })
    .join("/");
}

function isIdentifierShape(value: string): boolean {
  return UUID_RE.test(value) || isPrefixedAccount(value);
}

const UUID_ANYWHERE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

/**
 * Replace identifier shapes anywhere in a decoded path, independent of the
 * punctuation around them. Delimiter enumeration is a losing game: colon
 * action suffixes (`/ops/<uuid>:cancel`) and matrix parameters
 * (`<uuid>;retry=1`) are both ordinary provider API syntax, and the next
 * unlisted separator would leak again.
 */
function redactIdentifiersInText(value: string): string {
  return value.replace(UUID_ANYWHERE_RE, "[account]").replace(PREFIXED_ACCOUNT_RE, "[account]");
}

/** Percent-decode until the value stops changing, bounded against a decode bomb. */
function decodeToFixedPoint(value: string): string {
  let current = value;
  for (let pass = 0; pass < 6 && current.includes("%"); pass += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current; // malformed escapes: treat what we have as opaque
    }
    if (next === current) break;
    current = next;
  }
  return current;
}

/** Valid IPv4 dotted quad: every octet in range and canonically written. */
function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => p.length >= 1 && p.length <= 3 && /^\d+$/.test(p) && Number(p) <= 255);
}

/** Full IPv6 validation, including `::` compression and a trailing mapped IPv4. */
function isIpv6(value: string): boolean {
  if (!value.includes(":")) return false;
  let head = value;
  let tailGroups = 0;
  const lastColon = head.lastIndexOf(":");
  const afterLastColon = head.slice(lastColon + 1);
  if (afterLastColon.includes(".")) {
    if (!isIpv4(afterLastColon)) return false;
    head = head.slice(0, lastColon + 1);
    tailGroups = 2;
  } else if (head.includes(".")) {
    return false;
  }
  const doubleColons = head.split("::").length - 1;
  if (doubleColons > 1) return false;
  const compressed = doubleColons === 1;
  const [leftRaw = "", rightRaw = ""] = compressed ? head.split("::") : [head, ""];
  const splitGroups = (part: string): string[] | null => {
    if (part === "" || part === ":") return [];
    const trimmed = part.replace(/^:|:$/g, "");
    if (trimmed === "") return [];
    const groups = trimmed.split(":");
    return groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g)) ? groups : null;
  };
  const left = splitGroups(leftRaw);
  const right = compressed ? splitGroups(rightRaw) : [];
  if (left === null || right === null) return false;
  const total = left.length + right.length + tailGroups;
  return compressed ? total <= 7 : total === 8;
}

/**
 * Two-stage IPv6 replacement: scan the address alphabet, validate the base,
 * then extend the replaced span across an optional `%zone`. A single-alphabet
 * scan would leave `fe80::1%en0` as `[ip]%en0`.
 */
function redactIpv6(value: string): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    const ch = value[i]!;
    if (!/[0-9A-Fa-f:.]/.test(ch)) {
      out += ch;
      i += 1;
      continue;
    }
    let end = i;
    while (end < value.length && /[0-9A-Fa-f:.]/.test(value[end]!) && end - i < 45) end += 1;
    // The candidate alphabet includes `.` for IPv4-mapped forms, so a trailing
    // sentence period is swallowed too and `2001:db8::1.` failed validation as
    // a whole. Retry on progressively shorter prefixes so ordinary punctuation
    // after an address cannot defeat the rule.
    let matched = 0;
    for (let stop = end; stop > i; stop -= 1) {
      // A candidate may not end on `.` — that is sentence punctuation after an
      // address. It MAY end on `:`, because `2001:db8::` and `fe80::` are valid
      // compressed forms; rejecting every trailing colon skipped them entirely.
      // `isIpv6` is the arbiter, so a stray single trailing colon simply fails
      // validation and the loop backs off one more character.
      if (value[stop - 1] === ".") continue;
      if (isIpv6(value.slice(i, stop))) {
        matched = stop;
        break;
      }
    }
    if (matched > i) {
      let zoneEnd = matched;
      if (value[zoneEnd] === "%") {
        let z = zoneEnd + 1;
        while (z < value.length && /[A-Za-z0-9_.-]/.test(value[z]!) && z - zoneEnd <= 64) z += 1;
        if (z > zoneEnd + 1) zoneEnd = z;
      }
      out += "[ip]";
      i = zoneEnd;
      continue;
    }
    out += value.slice(i, end);
    i = end;
  }
  return out;
}

/** Scan a delimited span (UNC path, non-HTTP URI) and replace it whole. */
function redactScannedSpans(value: string, start: RegExp, token: string, accept?: (span: string) => boolean): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    start.lastIndex = i;
    const m = start.exec(value);
    if (!m) {
      out += value.slice(i);
      break;
    }
    let end = m.index + m[0].length;
    while (end < value.length && !/[\s"']/.test(value[end]!)) end += 1;
    const span = value.slice(m.index, end);
    out += value.slice(i, m.index);
    out += accept && !accept(span) ? span : token;
    i = end;
  }
  return out;
}

/**
 * Account identifiers under a label. The value span is resolved from its
 * syntax (quote pair, or run to a terminator) BEFORE it is validated, so an
 * out-of-grammar character or a missing closing quote leaves the text
 * untouched instead of producing a partially redacted prefix.
 *
 * ID-bearing labels (`user_id`, `accountId`, ...) redact any value of six or
 * more characters. Bare labels (`user`, `account`, ...) redact only an
 * unambiguous account shape, because `org: engineering` is ordinary prose.
 */
function redactContextualAccounts(value: string): string {
  let out = "";
  let cursor = 0;
  ACCOUNT_LABEL_RE.lastIndex = 0;
  let label: RegExpExecArray | null;
  while ((label = ACCOUNT_LABEL_RE.exec(value)) !== null) {
    if (label.index < cursor) continue;
    const idBearing = Boolean(label[1]);
    let p = label.index + label[0].length;
    // A JSON field name is quoted: `"userId": "v"`. Step over the label's own
    // closing quote before looking for the separator.
    if (value[p] === '"' || value[p] === "'") p += 1;
    while (p < value.length && /\s/.test(value[p]!)) p += 1;
    if (value[p] !== "=" && value[p] !== ":") continue;
    p += 1;
    while (p < value.length && /\s/.test(value[p]!)) p += 1;
    const quote = value[p] === '"' || value[p] === "'" ? value[p]! : "";
    let spanStart = quote ? p + 1 : p;
    let spanEnd: number;
    if (quote) {
      const close = value.indexOf(quote, spanStart);
      if (close === -1) continue;
      spanEnd = close;
    } else {
      spanEnd = spanStart;
      while (spanEnd < value.length && !UNQUOTED_TERMINATOR.test(value[spanEnd]!)) spanEnd += 1;
    }
    const span = value.slice(spanStart, spanEnd);
    if (!span || !IDENTIFIER_ONLY_RE.test(span)) continue;
    const redact = idBearing ? span.length >= 6 : isPrefixedAccount(span) || UUID_RE.test(span);
    if (!redact) continue;
    out += value.slice(cursor, spanStart) + "[account]";
    cursor = spanEnd;
    ACCOUNT_LABEL_RE.lastIndex = spanEnd;
  }
  out += value.slice(cursor);
  return out;
}

function scrubString(value: string): string {
  // 1. Existing secret redaction.
  let s = redactSecretString(value);
  s = s.replace(SECRETISH_GLOBAL, "[REDACTED]");
  // 2. Filesystem paths, including UNC shares.
  s = s.replace(/(?:[A-Za-z]:\\|\/(?:home|Users|tmp|var|etc|root|mnt)\/)[^\s"']+/g, "[path]");
  s = redactScannedSpans(s, /\\\\[^\\\s"']{1,255}\\/g, "[path]");
  // 3. HTTP(S) URLs. The retained pathname keeps the diagnostic useful, so its
  //    segments are scrubbed of identifier shapes rather than trusted: a
  //    provider error citing `/users/<uuid>` would otherwise persist an
  //    account id that the host rewrite alone does not touch.
  s = s.replace(/https?:\/\/[^\s"']+/gi, (url) => {
    try {
      const u = new URL(url);
      if (u.username || u.password) return "[redacted-url]";
      const path = scrubUrlPath(u.pathname);
      if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(u.hostname)) {
        return `${u.protocol}//[private-host]${path}`;
      }
      return `${u.protocol}//[host]${path}`;
    } catch {
      return "[redacted-url]";
    }
  });
  // 4. Other-scheme URIs, which may carry credentials. Refuses http(s) so it
  //    cannot re-match the output of rule 3.
  s = redactScannedSpans(s, /\b[a-z][a-z0-9+.-]{1,15}:\/\//gi, "[uri]", (span) => !/^https?:\/\//i.test(span));
  // 5-8. Bounded token shapes.
  s = s.replace(JWT_RE, "[jwt]");
  s = s.replace(EMAIL_RE, "[email]");
  s = s.replace(PREFIXED_ACCOUNT_RE, "[account]");
  s = redactContextualAccounts(s);
  s = s.replace(MAC_RE, "[mac]");
  // 9-10. Addresses: IPv6 first so mapped forms are replaced whole.
  s = redactIpv6(s);
  s = s.replace(IPV4_RE, (m) => (isIpv4(m) ? "[ip]" : m));
  // 11. Multi-label hostnames, plus single-label names in a host-bearing context.
  s = s.replace(HOSTNAME_RE, "[host]");
  s = s.replace(STRONG_HOST_CONTEXT_RE, (m, tail: string) => {
    // Scan the few tokens after the marker for the first host-shaped one:
    // Go writes `dial tcp: lookup <host>: no such host`, so the destination
    // is not always adjacent to the marker. A resolver marker also licenses a
    // bare name (`ENOTFOUND redis`), which a socket-state marker does not.
    // A name paired with a port is a destination whatever else is true:
    // `dial tcp redis:6379` needs no other evidence. Both notations count —
    // adjacent `host:443` and spelled-out `gateway on port 443` — because the
    // port is the evidence, not the punctuation.
    const ported =
      tail.match(/(?<![\w.-])([A-Za-z0-9_.-]{1,255}):\d{1,5}(?![\w.])/) ??
      tail.match(/(?<![\w.-])([A-Za-z0-9_.-]{1,255})\s+(?:on\s+)?port\s+\d{1,5}\b/i);
    if (ported?.[1] && !PROSE_AFTER_MARKER.has(ported[1].toLowerCase())) {
      return m.replace(ported[1], "[host]");
    }
    // Otherwise only a resolver marker licenses a bare name. Natural-language
    // `connect to` does not: `Unable to connect to your account` is prose.
    const resolver = /ENOTFOUND|EAI_AGAIN|lookup|host/i.test(m);
    for (const token of tail.split(/[\s:]+/)) {
      if (token && isHostCandidate(token, resolver)) return m.replace(token, "[host]");
    }
    return m;
  });
  s = s.replace(WEAK_HOST_CONTEXT_RE, (m, name: string) =>
    CONTEXTUAL_HOST_TOKEN_RE.test(name) && !DOTTED_NAMESPACE_RE.test(name) ? m.replace(name, "[host]") : m,
  );
  const bytes = new TextEncoder().encode(s);
  if (bytes.byteLength > MAX_SANITIZED_STRING_FIELD) {
    return new TextDecoder().decode(bytes.slice(0, MAX_SANITIZED_STRING_FIELD));
  }
  return s;
}

const TRUNCATION_MARKERS = [
  "[REDACTED]",
  "[redacted-url]",
  "[private-host]",
  "[account]",
  "[email]",
  "[host]",
  "[path]",
  "[uri]",
  "[jwt]",
  "[mac]",
  "[ip]",
];

/**
 * Byte-bounded truncation for persisted summaries.
 *
 * `String.prototype.slice` counts UTF-16 code units, so it can split a
 * surrogate pair or leave a partial `[em` fragment that a reader could mistake
 * for literal content. Bytes are the right unit because
 * `enforceEventStructureLimits` also measures encoded byte length.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let cut = 0;
  let used = 0;
  for (const char of value) {
    const size = encoder.encode(char).byteLength;
    if (used + size > maxBytes) break;
    used += size;
    cut += char.length;
  }
  // If the cut lands strictly inside a marker, drop the whole marker: a
  // fragment such as `[accoun` reads as literal content. Sanitization has
  // already replaced the raw value, so the marker's opening bracket is a safe
  // cut point and everything before it is intact.
  const open = value.lastIndexOf("[", cut - 1);
  if (open !== -1) {
    const tail = value.slice(open, cut);
    for (const marker of TRUNCATION_MARKERS) {
      if (tail.length < marker.length && marker.startsWith(tail)) return value.slice(0, open);
    }
  }
  return value.slice(0, cut);
}

/** Stable privacy boundary for diagnostic text that may be persisted. */
export function sanitizeDiagnostic(value: unknown): string {
  return scrubString(value instanceof Error ? value.message : String(value));
}

export function sanitizedJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(jcsStringify(scrubValue(value, 0)));
}