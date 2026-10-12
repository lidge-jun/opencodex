import { readBoundedResponseBody } from "../lib/bounded-body";

const RESET_ELIGIBLE_CODE_VALUES = [
  "usage_limit_exceeded",
  "insufficient_quota",
] as const;

export type CodexResetEligibleExhaustionCode =
  (typeof RESET_ELIGIBLE_CODE_VALUES)[number];

/**
 * Upstream codes that name an ORGANIZATION- or PROJECT-scoped exhaustion (#4546).
 *
 * These are a different animal from the reset-eligible codes above, and the difference is the
 * whole point. `usage_limit_exceeded` describes the account that was asked; another pool account
 * carries its own plan allowance, so rotating to it is a real move. Every code here describes a
 * limit the CREDENTIAL does not own -- a balance, a spend cap, or a usage cap held by the
 * organization or project the credential belongs to. Two credentials inside that organization
 * are refused by the same counter, so rotating between them pays a cold prompt prefix for zero
 * new capacity, which is the send amplification this unit exists to stop.
 *
 * openai/codex reached the same classification from the client side: #44492 maps exactly these
 * HTTP 429 codes to a terminal `QuotaExceeded` instead of a retry-limit failure, and #45602
 * extends it to the SSE path while deliberately KEEPING `rate_limit_exceeded` and `slow_down`
 * retryable. The platform documentation states the same rule for the whole class: "It does not
 * mean that quota, billing, or other errors that require user action can be resolved by
 * retrying."
 *
 * Membership here says nothing about reset credits. A reset credit reconciles a ChatGPT plan
 * window; it cannot pay an organization's bill, so these codes are deliberately absent from
 * {@link RESET_ELIGIBLE_CODE_VALUES} and never set `resetCreditEligible`.
 */
const SCOPED_EXHAUSTION_CODE_VALUES = [
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
] as const;

export type CodexScopedExhaustionCode =
  (typeof SCOPED_EXHAUSTION_CODE_VALUES)[number];

export type CodexPreStreamRejectionKind =
  | "reset-eligible-exhaustion"
  | "scoped-quota-exhaustion"
  | "generic-rate-limit"
  | "unverified-billing-or-quota"
  | "transient-server-error"
  | "authentication-error"
  | "permission-error"
  | "other";

export interface CodexPreStreamRejection {
  kind: CodexPreStreamRejectionKind;
  status: number;
  alternateRetryEligible: boolean;
  resetCreditEligible: boolean;
  semanticCode?: CodexResetEligibleExhaustionCode;
  /**
   * The organization- or project-scoped exhaustion code the upstream body named, when it named
   * one. Never accompanied by `semanticCode`: the two sets are disjoint, and only `semanticCode`
   * may authorize a reset credit.
   */
  scopedExhaustionCode?: CodexScopedExhaustionCode;
  /**
   * Structured denial evidence for a 403. Present only when the upstream body names a
   * workspace/entitlement denial, which proves the CREDENTIAL is valid and the account
   * simply lacks access here (#1789). Status alone can never set this.
   */
  denial?: "workspace" | "entitlement";
}

/**
 * Upstream codes that identify a WORKSPACE denial rather than a bad credential.
 *
 * #1789: a K12 account whose credential validates and whose WHAM usage returns 200 still
 * gets 403 `codex_workspace_access_denied` on a routed prompt. Treating that as a credential
 * failure tells the user to re-authenticate a credential that is already valid, and the loop
 * repeats forever.
 */
const WORKSPACE_DENIAL_CODES: ReadonlySet<string> = new Set([
  "codex_workspace_access_denied",
  "workspace_access_denied",
]);

const ENTITLEMENT_DENIAL_CODES: ReadonlySet<string> = new Set([
  "codex_entitlement_missing",
  "entitlement_missing",
]);

/** Read a structured denial code out of a 403 body. Fails closed to undefined. */
async function denialFromResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<"workspace" | "entitlement" | undefined> {
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal, fatalUtf8: true });
    if (!body.displaySafe || body.truncated || !body.text.trim()) return undefined;
    if (isUnsafeJsonDocument(body.text)) return undefined;
    const payload = JSON.parse(body.text) as unknown;
    const code = structuredDenialCode(payload);
    if (code === undefined) return undefined;
    if (WORKSPACE_DENIAL_CODES.has(code)) return "workspace";
    if (ENTITLEMENT_DENIAL_CODES.has(code)) return "entitlement";
    return undefined;
  } catch {
    // Same fail-closed rule as the exhaustion classifier: an unreadable body must not
    // downgrade a credential failure into a workspace one.
    return undefined;
  }
}

function ownStringField(container: Record<string, unknown>, field: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(container, field);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

/** Own-property `code` lookup at the top level or under `error` / `detail`. No coercion or accessors. */
function structuredDenialCode(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const direct = ownStringField(record, "code");
  if (direct !== undefined) return direct;

  for (const field of ["error", "detail"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    if (!descriptor || !("value" in descriptor)) continue;
    const nested = descriptor.value;
    if (nested === null || typeof nested !== "object" || Array.isArray(nested)) continue;
    const code = ownStringField(nested as Record<string, unknown>, "code");
    if (code !== undefined) return code;
  }
  return undefined;
}

const RESET_ELIGIBLE_CODES: ReadonlySet<string> = new Set(RESET_ELIGIBLE_CODE_VALUES);
const SCOPED_EXHAUSTION_CODES: ReadonlySet<string> = new Set(SCOPED_EXHAUSTION_CODE_VALUES);

const TRANSIENT_SERVER_STATUSES = new Set([500, 502, 503, 504, 520, 521, 522]);
const JSON_NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function rejection(
  status: number,
  kind: CodexPreStreamRejectionKind,
  options: {
    alternateRetryEligible?: boolean;
    semanticCode?: CodexResetEligibleExhaustionCode;
    scopedExhaustionCode?: CodexScopedExhaustionCode;
  } = {},
): CodexPreStreamRejection {
  return {
    kind,
    status,
    alternateRetryEligible: options.alternateRetryEligible === true,
    resetCreditEligible: options.semanticCode !== undefined,
    ...(options.semanticCode ? { semanticCode: options.semanticCode } : {}),
    ...(options.scopedExhaustionCode ? { scopedExhaustionCode: options.scopedExhaustionCode } : {}),
  };
}

function hasOwnField(container: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(container, field);
}

type JsonScanResult = {
  next: number;
  duplicate: boolean;
};

function skipJsonWhitespace(text: string, index: number): number {
  while (index < text.length && /[\t\n\r ]/.test(text[index] ?? "")) index += 1;
  return index;
}

function scanJsonStringEnd(text: string, index: number): number {
  if (text[index] !== '"') throw new SyntaxError("expected JSON string");
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === '"') return cursor + 1;
    if (char === "\\") cursor += 1;
  }
  throw new SyntaxError("unterminated JSON string");
}

function scanJsonValue(text: string, index: number): JsonScanResult {
  const start = skipJsonWhitespace(text, index);
  if (text[start] === "{") return scanJsonObject(text, start);
  if (text[start] === "[") return scanJsonArray(text, start);
  if (text[start] === '"') return { next: scanJsonStringEnd(text, start), duplicate: false };

  for (const literal of ["true", "false", "null"]) {
    if (text.startsWith(literal, start)) {
      return { next: start + literal.length, duplicate: false };
    }
  }
  JSON_NUMBER_PATTERN.lastIndex = start;
  const number = JSON_NUMBER_PATTERN.exec(text);
  if (!number) throw new SyntaxError("expected JSON value");
  return { next: start + number[0].length, duplicate: false };
}

function scanJsonObject(text: string, index: number): JsonScanResult {
  const keys = new Set<string>();
  let duplicate = false;
  let cursor = skipJsonWhitespace(text, index + 1);
  if (text[cursor] === "}") return { next: cursor + 1, duplicate: false };

  while (cursor < text.length) {
    const keyEnd = scanJsonStringEnd(text, cursor);
    const key = JSON.parse(text.slice(cursor, keyEnd)) as unknown;
    if (typeof key !== "string") throw new SyntaxError("invalid JSON object key");
    if (keys.has(key)) duplicate = true;
    keys.add(key);

    cursor = skipJsonWhitespace(text, keyEnd);
    if (text[cursor] !== ":") throw new SyntaxError("expected JSON object colon");
    const value = scanJsonValue(text, cursor + 1);
    duplicate ||= value.duplicate;
    cursor = skipJsonWhitespace(text, value.next);
    if (text[cursor] === "}") return { next: cursor + 1, duplicate };
    if (text[cursor] !== ",") throw new SyntaxError("expected JSON object separator");
    cursor = skipJsonWhitespace(text, cursor + 1);
  }
  throw new SyntaxError("unterminated JSON object");
}

function scanJsonArray(text: string, index: number): JsonScanResult {
  let duplicate = false;
  let cursor = skipJsonWhitespace(text, index + 1);
  if (text[cursor] === "]") return { next: cursor + 1, duplicate: false };

  while (cursor < text.length) {
    const value = scanJsonValue(text, cursor);
    duplicate ||= value.duplicate;
    cursor = skipJsonWhitespace(text, value.next);
    if (text[cursor] === "]") return { next: cursor + 1, duplicate };
    if (text[cursor] !== ",") throw new SyntaxError("expected JSON array separator");
    cursor = skipJsonWhitespace(text, cursor + 1);
  }
  throw new SyntaxError("unterminated JSON array");
}

function isUnsafeJsonDocument(text: string): boolean {
  try {
    const result = scanJsonValue(text, 0);
    return result.duplicate || skipJsonWhitespace(text, result.next) !== text.length;
  } catch {
    // Scanner disagreement is untrusted input, just like JSON.parse failure.
    return true;
  }
}

/**
 * Read the one exact, unambiguous code a container declares, and only if it is in `allowed`.
 *
 * Generic over the allowed set so the reset-eligible and organization-scoped classifications
 * share one parser. They must: the strictness here -- a `code`/`type` pair that disagrees is
 * rejected rather than resolved, and no trimming or case folding is applied -- is what keeps a
 * near-miss from being read as an exact upstream code, and a second hand-written copy would
 * drift away from that.
 */
function exactAllowedCode(
  container: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | undefined {
  const hasCode = hasOwnField(container, "code");
  const hasType = hasOwnField(container, "type");
  if (!hasCode && !hasType) return undefined;

  const code = hasCode ? container.code : undefined;
  const type = hasType ? container.type : undefined;
  if ((hasCode && typeof code !== "string") || (hasType && typeof type !== "string")) {
    return undefined;
  }
  if (hasCode && hasType && code !== type) return undefined;

  const value = hasCode ? code : type;
  if (typeof value !== "string") return undefined;
  return allowed.has(value) ? value : undefined;
}

function structuredAllowedCode(payload: unknown, allowed: ReadonlySet<string>): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const root = payload as Record<string, unknown>;
  const hasRootDiscriminator = hasOwnField(root, "code") || hasOwnField(root, "type");

  if (!hasOwnField(root, "error")) return exactAllowedCode(root, allowed);
  if (hasRootDiscriminator) return undefined;

  const nested = root.error;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return undefined;
  return exactAllowedCode(nested as Record<string, unknown>, allowed);
}

/**
 * Parse one bounded body and classify its structured code against both sets at once.
 *
 * One read, because the caller holds a `Response` whose body may only be consumed once per
 * clone and the two questions are asked about the same bytes.
 */
async function exhaustionCodeFromResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<{
  resetEligible?: CodexResetEligibleExhaustionCode;
  scoped?: CodexScopedExhaustionCode;
}> {
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal, fatalUtf8: true });
    if (!body.displaySafe || body.truncated || !body.text.trim()) return {};
    const payload = JSON.parse(body.text) as unknown;
    // JSON.parse silently keeps the last duplicate key, making contradictory
    // payloads order-dependent. Reject any duplicate at any object depth.
    if (isUnsafeJsonDocument(body.text)) return {};
    const resetEligible = structuredAllowedCode(payload, RESET_ELIGIBLE_CODES);
    if (resetEligible !== undefined) {
      return { resetEligible: resetEligible as CodexResetEligibleExhaustionCode };
    }
    const scoped = structuredAllowedCode(payload, SCOPED_EXHAUSTION_CODES);
    return scoped === undefined ? {} : { scoped: scoped as CodexScopedExhaustionCode };
  } catch {
    // Classification must fail closed. A malformed, oversized, consumed, or
    // cancelled body cannot authorize an irreversible reset-credit operation.
    return {};
  }
}

/**
 * The organization- or project-scoped exhaustion code this rejection names, if any.
 *
 * Exported for the account-rotation gate, which has to answer "may another pool account serve
 * this?" before it has any reason to build a full classification. Fails closed to `undefined`:
 * an unreadable, truncated, duplicate-keyed or aborted body leaves the caller's existing
 * behaviour untouched, so only positive evidence can ever withhold a rotation.
 */
export async function codexScopedExhaustionCode(
  response: Response,
  options: { signal?: AbortSignal } = {},
): Promise<CodexScopedExhaustionCode | undefined> {
  return (await exhaustionCodeFromResponse(response, options.signal)).scoped;
}

/**
 * Classify an upstream Codex rejection before any response event is exposed.
 *
 * Only an exact structured exhaustion code on HTTP 429/402 is reset-eligible.
 * Status alone and message text are intentionally insufficient. The broad
 * alternate-account retry remains eligible for 429/402 to preserve #584.
 *
 * Organization- or project-scoped exhaustion ({@link SCOPED_EXHAUSTION_CODE_VALUES}) remains
 * alternate-retry eligible here because the response does not identify the refusing scope. The
 * account-rotation path may suppress the send later when the resolved alternate carries binding
 * evidence that it shares an organization-level counter.
 */
export async function classifyCodexPreStreamRejection(
  response: Response,
  options: { signal?: AbortSignal } = {},
): Promise<CodexPreStreamRejection> {
  const status = response.status;
  if (status === 401) return rejection(status, "authentication-error");
  if (status === 403) {
    const denial = await denialFromResponse(response, options.signal);
    return { ...rejection(status, "permission-error"), ...(denial ? { denial } : {}) };
  }
  if (TRANSIENT_SERVER_STATUSES.has(status)) return rejection(status, "transient-server-error");
  if (status !== 429 && status !== 402) return rejection(status, "other");

  const { resetEligible: semanticCode, scoped } = await exhaustionCodeFromResponse(
    response,
    options.signal,
  );
  if (semanticCode) {
    return rejection(status, "reset-eligible-exhaustion", {
      alternateRetryEligible: true,
      semanticCode,
    });
  }
  if (scoped) {
    return rejection(status, "scoped-quota-exhaustion", {
      alternateRetryEligible: true,
      scopedExhaustionCode: scoped,
    });
  }
  return rejection(
    status,
    status === 429 ? "generic-rate-limit" : "unverified-billing-or-quota",
    { alternateRetryEligible: true },
  );
}
