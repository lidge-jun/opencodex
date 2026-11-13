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
/** Excerpt windows produced beyond this many (repeats included) make a credential set fail closed. */
export const MAX_CREDENTIAL_EXCERPT_WINDOWS = 65_536;

function spellings(part: string): string[] {
  const escaped = JSON.stringify(part).slice(1, -1);
  return escaped === part ? [part] : [part, escaped];
}

/**
 * The 8-character excerpt windows of a credential value: every window of each token between
 * separators (whitespace, commas, semicolons, "=", quotes, backslashes), auth scheme words left out.
 * A window never spans a separator, so scheme or field-name text cannot form one, while an opaque
 * value containing "=" still has every token of 8+ characters covered.
 * Generation stops once `max` windows are produced (repeats count), so a caller that sees more than
 * `max` back knows coverage would be unbounded and fails closed.
 */
export function credentialExcerptWindows(value: string, max = MAX_CREDENTIAL_EXCERPT_WINDOWS): string[] {
  const windows: string[] = [];
  for (const token of value.split(/[\s,;="\\]+/)) {
    if (token.length < CREDENTIAL_SUBSTRING_MIN_LENGTH || AUTH_SCHEMES.has(token.toLowerCase())) continue;
    for (let at = 0; at + CREDENTIAL_SUBSTRING_MIN_LENGTH <= token.length; at++) {
      windows.push(token.slice(at, at + CREDENTIAL_SUBSTRING_MIN_LENGTH));
      if (windows.length > max) return windows;
    }
  }
  return windows;
}

/** Whether text holds any of the excerpt windows, reading at most the guard's scan window. */
export function containsExcerptWindow(text: string, windows: ReadonlySet<string>): boolean {
  if (windows.size === 0) return false;
  const head = text.length > SENT_VALUE_GUARD_SCAN_CHARS ? text.slice(0, SENT_VALUE_GUARD_SCAN_CHARS) : text;
  for (let at = 0; at + CREDENTIAL_SUBSTRING_MIN_LENGTH <= head.length; at++) {
    if (windows.has(head.slice(at, at + CREDENTIAL_SUBSTRING_MIN_LENGTH))) return true;
  }
  return false;
}


/**
 * Whether text repeats a value these outbound headers carry, decided from this request's own
 * headers so no global eviction can open it. A credential-named component is recognized whole at
 * any length and by any excerpt of 8+ characters (its 8-character windows, capped: past the cap the
 * guard fails closed); any other non-correlation component is recognized when 8+ characters of it
 * occur whole. Only the first {@link SENT_VALUE_GUARD_SCAN_CHARS} characters are read, so work is
 * bounded; callers emit nothing beyond them.
 */
interface SentValueIndex {
  wholeCredential: Set<string>;
  credentialWindows: Set<string>;
  contained: string[];
  overflow: boolean;
}

function indexSentValues(headers: Record<string, string>, credentialOnly = false): SentValueIndex {
  const wholeCredential = new Set<string>();
  const credentialWindows = new Set<string>();
  const contained: string[] = [];
  let overflow = false;
  let produced = 0;
  for (const [name, value] of Object.entries(headers)) {
    const credentialNamed = isCredentialName(name);
    if (!credentialNamed && CORRELATION_HEADER_NAME.test(name)) continue;
    for (const part of credentialComponents(value)) {
      if (!credentialNamed) {
        if (!credentialOnly && part.length >= CREDENTIAL_SUBSTRING_MIN_LENGTH) contained.push(...spellings(part));
        continue;
      }
      for (const spelling of spellings(part)) {
        wholeCredential.add(spelling);
        if (overflow) continue;
        const windows = credentialExcerptWindows(spelling, MAX_CREDENTIAL_EXCERPT_WINDOWS - produced);
        produced += windows.length;
        if (produced > MAX_CREDENTIAL_EXCERPT_WINDOWS) overflow = true;
        else for (const window of windows) credentialWindows.add(window);
      }
    }
  }
  return { wholeCredential, credentialWindows, contained, overflow };
}

function scanHead(text: string): string {
  return text.length > SENT_VALUE_GUARD_SCAN_CHARS ? text.slice(0, SENT_VALUE_GUARD_SCAN_CHARS) : text;
}

export function createSentValueGuard(headers: Record<string, string>): (text: string) => boolean {
  const { wholeCredential, credentialWindows, contained, overflow } = indexSentValues(headers);
  const containedIndex = new SecretIndex(contained);
  return (text) => {
    if (overflow) return true;
    const head = scanHead(text);
    if (wholeCredential.has(head)) return true;
    for (let at = 0; at + CREDENTIAL_SUBSTRING_MIN_LENGTH <= head.length; at++) {
      if (credentialWindows.has(head.slice(at, at + CREDENTIAL_SUBSTRING_MIN_LENGTH))) return true;
    }
    return markSubstringSpans(head, containedIndex, undefined) !== undefined;
  };
}

/**
 * The span-masking form of {@link createSentValueGuard}: it returns the scanned head of text with
 * only the characters that repeat a sent value replaced (every matching 8-character window of a
 * credential token, every contained non-credential value), so the surrounding copy, such as refusal
 * wording a reader classifies, survives. The whole head is replaced when it equals a credential, and
 * everything is replaced past the window cap.
 */
export function createSentValueMask(
  headers: Record<string, string>,
  replacement: string,
  options: { credentialOnly?: boolean; wholeText?: boolean } = {},
): (text: string) => string {
  // `credentialOnly`: only credential-named values (whole and by excerpt), for copy where other
  // header values (a content type, a user agent) are ordinary text that must stay readable.
  // `wholeText`: read and return all of the text (linear work), for genuine Responses terminals whose
  // output must not be cut; the default reads and returns only the guard's scan window.
  const { wholeCredential, credentialWindows, contained, overflow } = indexSentValues(headers, options.credentialOnly);
  const containedIndex = new SecretIndex(contained);
  return (text) => {
    if (overflow) return replacement;
    const head = options.wholeText ? text : scanHead(text);
    if (wholeCredential.has(head)) return replacement;
    // Matching windows are marked in the same pass that finds them, so the work stays linear in the
    // text length however many distinct windows match (a rescan per window would be quadratic).
    let covered: Uint8Array | undefined;
    for (let at = 0; at + CREDENTIAL_SUBSTRING_MIN_LENGTH <= head.length; at++) {
      if (!credentialWindows.has(head.slice(at, at + CREDENTIAL_SUBSTRING_MIN_LENGTH))) continue;
      covered ??= new Uint8Array(head.length);
      covered.fill(1, at, at + CREDENTIAL_SUBSTRING_MIN_LENGTH);
    }
    covered = markSubstringSpans(head, containedIndex, covered);
    return covered === undefined ? head : renderCoveredSpans(head, covered, replacement);
  };
}

/**
 * Replace every span of text a secret covers: the whole text when it equals a whole-only value, and
 * every occurrence of each substring value. Coverage is marked on the original text before anything
 * is replaced, so overlapping values are replaced as one union and no part of either survives
 * between them. Pass a {@link SecretIndex} built once when the same secrets mask many strings: the
 * work per call is then linear in that string, independent of how many secrets there are.
 */
export function maskSecretSpans(text: string, replacement: string, substrings: Iterable<string> | SecretIndex, wholeOnly: Iterable<string> = []): string {
  for (const value of wholeOnly) if (value && text === value) return replacement;
  const covered = markSubstringSpans(text, substrings instanceof SecretIndex ? substrings : new SecretIndex(substrings), undefined);
  return covered === undefined ? text : renderCoveredSpans(text, covered, replacement);
}

/**
 * Secrets prepared for {@link maskSecretSpans}: deduplicated, 8+ character secrets grouped by their
 * first 8 characters with each group sorted by length, shorter ones grouped by length. Built once
 * per request, so masking each string of a frame does not rebuild it. Border tables are computed
 * lazily, at most once per secret, and charged to the call that needs them.
 */
export class SecretIndex {
  readonly byPrefix = new Map<string, string[]>();
  readonly shortByLength = new Map<number, Set<string>>();
  readonly bordered = new Map<string, boolean>();

  constructor(substrings: Iterable<string>) {
    for (const secret of new Set(substrings)) {
      if (!secret) continue;
      if (secret.length >= CREDENTIAL_SUBSTRING_MIN_LENGTH) {
        const prefix = secret.slice(0, CREDENTIAL_SUBSTRING_MIN_LENGTH);
        const group = this.byPrefix.get(prefix);
        if (group) group.push(secret);
        else this.byPrefix.set(prefix, [secret]);
      } else {
        const group = this.shortByLength.get(secret.length) ?? new Set<string>();
        group.add(secret);
        this.shortByLength.set(secret.length, group);
      }
    }
    for (const group of this.byPrefix.values()) group.sort((a, b) => a.length - b.length);
  }
}

function markSubstringSpans(text: string, index: SecretIndex, initial: Uint8Array | undefined): Uint8Array | undefined {
  // One pass over the text finds every secret, however many there are: secrets of 8+ characters are
  // looked up by the 8 characters at each position, shorter ones by a slice of their own length (at
  // most seven passes). A prefix group is walked shortest first and stops at the first secret that
  // cannot fit in the text left, so only candidates that fit are visited, and each is charged:
  // confirming it, building its border table, and the one scan of a confirmed self-overlapping
  // secret. The budget is proportional to the text; past it the whole text is covered (fail closed),
  // so neither the frame nor the secret set can make the work superlinear.
  const n = text.length;
  let covered = initial;
  for (const [length, group] of index.shortByLength) {
    for (let at = 0; at + length <= n; at++) {
      if (!group.has(text.slice(at, at + length))) continue;
      covered ??= new Uint8Array(n);
      covered.fill(1, at, at + length);
    }
  }
  if (index.byPrefix.size === 0) return covered;
  const budget = { steps: MATCH_WORK_PER_CHAR * n + MATCH_WORK_FLOOR };
  const scanned = new Set<string>();
  for (let at = 0; at + CREDENTIAL_SUBSTRING_MIN_LENGTH <= n; at++) {
    const group = index.byPrefix.get(text.slice(at, at + CREDENTIAL_SUBSTRING_MIN_LENGTH));
    if (group === undefined) continue;
    for (const secret of group) {
      if (secret.length > n - at) break;
      if (scanned.has(secret)) continue;
      // Charged by the characters actually compared, so a prefix shared by absent secrets costs
      // little while near-copies of a long secret at every position still exhaust the budget.
      const matched = matchedLength(text, at, secret);
      budget.steps -= matched + 1;
      if (budget.steps < 0) return (covered ?? new Uint8Array(n)).fill(1);
      if (matched < secret.length) continue;
      covered ??= new Uint8Array(n);
      let selfOverlapping = index.bordered.get(secret);
      if (selfOverlapping === undefined) {
        budget.steps -= secret.length;
        if (budget.steps < 0) return covered.fill(1);
        selfOverlapping = hasBorder(secret);
        index.bordered.set(secret, selfOverlapping);
      }
      if (selfOverlapping) {
        // A confirmed self-overlapping secret is found from here on by one Knuth-Morris-Pratt scan,
        // so a prefix shared by many secrets that are absent never starts a scan.
        scanned.add(secret);
        budget.steps -= n - at;
        if (budget.steps < 0) return covered.fill(1);
        markOverlappingOccurrences(text, secret, at, covered);
        continue;
      }
      covered.fill(1, at, at + secret.length);
    }
  }
  return covered;
}

/** Confirmation and scan work one masking call may spend per text character before it fails closed. */
const MATCH_WORK_PER_CHAR = 8;
const MATCH_WORK_FLOOR = 256;

/**
 * Whether text contains any indexed secret, in one pass over text with the same charged walk as
 * {@link maskSecretSpans}: it stops at the first confirmed occurrence, and reports true once the
 * budget runs out (fail closed), so a check of a long upstream message against many values is linear.
 */
export function containsIndexedSecret(text: string, index: SecretIndex): boolean {
  const n = text.length;
  for (const [length, group] of index.shortByLength) {
    for (let at = 0; at + length <= n; at++) if (group.has(text.slice(at, at + length))) return true;
  }
  if (index.byPrefix.size === 0) return false;
  let budget = MATCH_WORK_PER_CHAR * n + MATCH_WORK_FLOOR;
  for (let at = 0; at + CREDENTIAL_SUBSTRING_MIN_LENGTH <= n; at++) {
    const group = index.byPrefix.get(text.slice(at, at + CREDENTIAL_SUBSTRING_MIN_LENGTH));
    if (group === undefined) continue;
    for (const secret of group) {
      if (secret.length > n - at) break;
      const matched = matchedLength(text, at, secret);
      budget -= matched + 1;
      if (budget < 0) return true;
      if (matched === secret.length) return true;
    }
  }
  return false;
}

/**
 * How many leading characters of secret match text at at (the index already matched the first 8):
 * secret.length exactly when the whole secret occurs there. A candidate is charged this plus one,
 * the comparison work it actually cost.
 */
function matchedLength(text: string, at: number, secret: string): number {
  let i = CREDENTIAL_SUBSTRING_MIN_LENGTH;
  while (i < secret.length && text.charCodeAt(at + i) === secret.charCodeAt(i)) i++;
  return i;
}

/** Whether a proper prefix of the secret is also its suffix, so two occurrences can overlap. */
function hasBorder(secret: string): boolean {
  return borderTable(secret)[secret.length - 1]! > 0;
}

function borderTable(secret: string): Int32Array {
  const m = secret.length;
  const fail = new Int32Array(m);
  for (let i = 1, k = 0; i < m; i++) {
    while (k > 0 && secret.charCodeAt(i) !== secret.charCodeAt(k)) k = fail[k - 1]!;
    if (secret.charCodeAt(i) === secret.charCodeAt(k)) k++;
    fail[i] = k;
  }
  return fail;
}

/**
 * Mark every occurrence of secret at or after from, overlapping ones included, in one
 * Knuth-Morris-Pratt pass: linear in the text even when a long repetitive secret overlaps itself at
 * every position (restarting a search one character after each match would recheck it there).
 */
function markOverlappingOccurrences(text: string, secret: string, from: number, covered: Uint8Array): void {
  const m = secret.length;
  const fail = borderTable(secret);
  let markedTo = 0;
  for (let i = from, k = 0; i < text.length; i++) {
    while (k > 0 && text.charCodeAt(i) !== secret.charCodeAt(k)) k = fail[k - 1]!;
    if (text.charCodeAt(i) === secret.charCodeAt(k)) k++;
    if (k === m) {
      const end = i + 1;
      covered.fill(1, Math.max(end - m, markedTo), end);
      markedTo = end;
      k = fail[m - 1]!;
    }
  }
}

function renderCoveredSpans(text: string, covered: Uint8Array, replacement: string): string {
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
export function credentialSetMatches(
  values: Iterable<string>,
  has: (value: string) => boolean,
  value: string,
  minLength = 1,
  index?: SecretIndex,
): boolean {
  if (value.length >= minLength && has(value)) return true;
  // An index of the containment-eligible values makes the check one pass over value, however many
  // values there are; it must hold exactly the values of max(minLength, 8)+ characters.
  if (index !== undefined) return containsIndexedSecret(value, index);
  for (const secret of values) {
    if (secret.length >= Math.max(minLength, CREDENTIAL_SUBSTRING_MIN_LENGTH) && value.includes(secret)) return true;
  }
  return false;
}

/** The containment-eligible index {@link credentialSetMatches} takes for these values. */
export function credentialContainmentIndex(values: Iterable<string>, minLength = 1): SecretIndex {
  const eligible: string[] = [];
  for (const secret of values) if (secret.length >= Math.max(minLength, CREDENTIAL_SUBSTRING_MIN_LENGTH)) eligible.push(secret);
  return new SecretIndex(eligible);
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
  private index: SecretIndex | undefined;
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
    this.index = undefined;
    while (this.values.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.values.keys().next().value as string;
      this.totalBytes -= this.values.get(oldest)!;
      this.values.delete(oldest);
      this.complete = false;
    }
  }

  matches(value: string, minLength: number): boolean {
    // Each set is always matched with the same minLength; the index is rebuilt after the set changes.
    this.index ??= credentialContainmentIndex(this.values.keys(), minLength);
    return credentialSetMatches(this.values.keys(), candidate => this.values.has(candidate), value, minLength, this.index);
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
