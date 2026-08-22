import { readBoundedResponseBody } from "../lib/bounded-body";

const RESET_ELIGIBLE_CODE_VALUES = [
  "usage_limit_exceeded",
  "insufficient_quota",
] as const;

export type CodexResetEligibleExhaustionCode =
  (typeof RESET_ELIGIBLE_CODE_VALUES)[number];

export type CodexPreStreamRejectionKind =
  | "reset-eligible-exhaustion"
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

const TRANSIENT_SERVER_STATUSES = new Set([500, 502, 503, 504, 520, 521, 522]);
const JSON_NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function rejection(
  status: number,
  kind: CodexPreStreamRejectionKind,
  options: {
    alternateRetryEligible?: boolean;
    semanticCode?: CodexResetEligibleExhaustionCode;
  } = {},
): CodexPreStreamRejection {
  return {
    kind,
    status,
    alternateRetryEligible: options.alternateRetryEligible === true,
    resetCreditEligible: options.semanticCode !== undefined,
    ...(options.semanticCode ? { semanticCode: options.semanticCode } : {}),
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

function exactResetEligibleCode(
  container: Record<string, unknown>,
): CodexResetEligibleExhaustionCode | undefined {
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
  return RESET_ELIGIBLE_CODES.has(value as CodexResetEligibleExhaustionCode)
    ? value as CodexResetEligibleExhaustionCode
    : undefined;
}

function structuredResetEligibleCode(payload: unknown): CodexResetEligibleExhaustionCode | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const root = payload as Record<string, unknown>;
  const hasRootDiscriminator = hasOwnField(root, "code") || hasOwnField(root, "type");

  if (!hasOwnField(root, "error")) return exactResetEligibleCode(root);
  if (hasRootDiscriminator) return undefined;

  const nested = root.error;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return undefined;
  return exactResetEligibleCode(nested as Record<string, unknown>);
}

async function resetEligibleCodeFromResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<CodexResetEligibleExhaustionCode | undefined> {
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal, fatalUtf8: true });
    if (!body.displaySafe || body.truncated || !body.text.trim()) return undefined;
    const payload = JSON.parse(body.text) as unknown;
    // JSON.parse silently keeps the last duplicate key, making contradictory
    // payloads order-dependent. Reject any duplicate at any object depth.
    if (isUnsafeJsonDocument(body.text)) return undefined;
    return structuredResetEligibleCode(payload);
  } catch {
    // Classification must fail closed. A malformed, oversized, consumed, or
    // cancelled body cannot authorize an irreversible reset-credit operation.
    return undefined;
  }
}

/**
 * Classify an upstream Codex rejection before any response event is exposed.
 *
 * Only an exact structured exhaustion code on HTTP 429/402 is reset-eligible.
 * Status alone and message text are intentionally insufficient. The broad
 * alternate-account retry remains eligible for 429/402 to preserve #584.
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

  const semanticCode = await resetEligibleCodeFromResponse(response, options.signal);
  if (semanticCode) {
    return rejection(status, "reset-eligible-exhaustion", {
      alternateRetryEligible: true,
      semanticCode,
    });
  }
  return rejection(
    status,
    status === 429 ? "generic-rate-limit" : "unverified-billing-or-quota",
    { alternateRetryEligible: true },
  );
}
