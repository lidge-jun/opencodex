import { parseRetryAfterFromMessage } from "./retry-delay";

export interface OcxErrorPayload {
  message: string;
  type: string;
  code: string | null;
}

export const ENCRYPTED_FUNCTION_OUTPUT_REJECTION =
  "Encrypted function output content could not be decrypted or decoded.";

/**
 * The error identity for a send this proxy declined to make (#4708).
 *
 * Declared here rather than only on the error class because the classifier is what decides
 * whether the identity survives serialization, and every dispatch path has to name the same
 * string for a client to be able to tell this apart from a provider rate limit.
 */
export const SEND_BUDGET_EXHAUSTED_CODE = "request_send_budget_exhausted";

/** Canonical human-readable message paths used by Responses upstream failures. */
export function upstreamErrorMessageFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const json = payload as {
    type?: unknown;
    message?: unknown;
    error?: { message?: unknown };
    last_error?: { message?: unknown };
    response?: {
      error?: { message?: unknown };
      incomplete_details?: { message?: unknown };
    };
  };
  const message = json.error?.message
    ?? json.last_error?.message
    ?? json.response?.error?.message
    ?? json.response?.incomplete_details?.message
    // The Responses stream error event carries a flat message (type/code/message),
    // unlike the response.failed envelope the branches above already cover.
    ?? (json.type === "error" ? json.message : undefined);
  return typeof message === "string" ? message : undefined;
}

/** OpenAI / Codex hard block for high-risk cybersecurity activity (HTTP 400 or mid-stream). */
export const CYBER_POLICY_ERROR_CODE = "cyber_policy";
export const CYBER_POLICY_FALLBACK_MESSAGE = "Request blocked by the upstream cybersecurity policy.";

export function isCyberPolicyCode(code: string | null | undefined): boolean {
  return code === CYBER_POLICY_ERROR_CODE;
}

/** Preserve a structured upstream error type; otherwise use the dedicated policy identity. */
export function cyberPolicyErrorType(type: string | null | undefined): string {
  const trimmed = typeof type === "string" ? type.trim() : "";
  return trimmed || CYBER_POLICY_ERROR_CODE;
}

/**
 * Detect OpenAI cyber-policy refusals from message text when structured `code` was stripped.
 * Matches Codex fallback copy and Cursor/API agent wording (session evidence 2026-07-24).
 * Does not treat a bare `cyber_policy` token as conclusive — model ids / routing errors can
 * include that substring without being a policy refusal.
 */
export function isCyberPolicyMessage(text: string): boolean {
  const lower = text.toLowerCase();
  // Serialized error-code signatures only (not bare model-id collisions).
  if (/"code"\s*:\s*"cyber_policy"/.test(lower)) return true;
  if (/\bcode\s*[:=]\s*["']?cyber_policy\b/.test(lower)) return true;
  if (lower.includes("high-risk cybersecurity")) return true;
  if (lower.includes("high-risk cyber activity") || lower.includes("high-risk cyber ")) return true;
  if (lower.includes("possible cybersecurity risk")) return true;
  if (lower.includes("flagged") && lower.includes("cybersecurity")) return true;
  if (lower.includes("flagged") && lower.includes("cyber activity")) return true;
  return false;
}

/**
 * Refusal codes Codex ends a turn on.
 *
 * Its Responses parser classifies a `response.failed` terminal by `error.code`
 * alone (codex-rs/codex-api/src/sse/responses.rs:423-462). These four become a
 * fatal `ApiError` the client reports instead of reconnecting. A code outside
 * this set is never read as a refusal: `server_is_overloaded` and `slow_down`
 * take the overload arm, `rate_limit_exceeded` takes the rate-limit arm, and
 * everything else falls through to `ApiError::Retryable` and is reconnected up
 * to `stream_max_retries`.
 *
 * Deliberately scoped to content refusals. `insufficient_quota` and
 * `context_length_exceeded` are terminal for Codex too, but they are separate
 * failure families this proxy already classifies through its own quota and
 * context paths, and pulling them in here would change their retry behavior
 * with no evidence asking for it.
 */
const TERMINAL_REFUSAL_CODES = new Set<string>([
  CYBER_POLICY_ERROR_CODE,
  "misalignment_policy_violation",
  "invalid_prompt",
  "bio_policy",
]);

/** True when an upstream error code is a refusal the client must not retry. */
export function isTerminalRefusalCode(code: string | null | undefined): boolean {
  return typeof code === "string" && TERMINAL_REFUSAL_CODES.has(code);
}

/** Stand-in copy for a refusal the upstream sent without a message of its own. */
export const TERMINAL_REFUSAL_FALLBACK_MESSAGE = "The upstream refused this request.";

/** Readable copy for a refusal code, used when the upstream carried no message. */
export function terminalRefusalFallbackMessage(code: string): string {
  return code === CYBER_POLICY_ERROR_CODE
    ? CYBER_POLICY_FALLBACK_MESSAGE
    : TERMINAL_REFUSAL_FALLBACK_MESSAGE;
}

/**
 * Name the refusal code behind upstream safety copy when the structured code
 * was not carried on the wire.
 *
 * Same discipline as {@link isCyberPolicyMessage}: whole distinctive phrases
 * only. A loose match here is the mirror-image defect — it would end a turn
 * that a genuine transient failure would have retried successfully — so a
 * message that merely mentions safety or blocking does not qualify. Callers
 * must consult this only when the upstream carried no structured code at all,
 * so that a transport failure quoting a refusal in its diagnostic text cannot
 * be promoted past the verdict the upstream actually gave.
 *
 * Copy provenance: "limited access to this content for safety reasons" is the
 * prefix Codex itself matches (tui/src/chatwidget/turn_runtime.rs:8-15) and
 * pairs with `invalid_prompt` in its parser fixture (sse/responses.rs:1358-1366),
 * which also pairs "flagged for possible biological risk" with `bio_policy`.
 * "blocked by our safety systems" is the copy reported in #5176; pairing it
 * with `invalid_prompt` is an inference from the two verified pairings above,
 * not something the upstream source states.
 */
export function safetyRefusalCodeFromMessage(text: string): string | undefined {
  const lower = String(text ?? "").toLowerCase();
  if (lower.includes("flagged for possible biological risk")) return "bio_policy";
  if (
    lower.includes("blocked by our safety systems")
    || lower.includes("limited access to this content for safety reasons")
  ) return "invalid_prompt";
  return undefined;
}

function isSubscriptionGateMessage(text: string): boolean {
  return (
    text.includes("requires a subscription") ||
    text.includes("requires subscription") ||
    text.includes("subscription required") ||
    text.includes("upgrade for access") ||
    text.includes("upgrade to pro") ||
    text.includes("pro subscription") ||
    text.includes("ollama.com/upgrade") ||
    (text.includes("upgrade") && text.includes("subscription"))
  );
}

/**
 * xAI (and similar Chat Completions gateways) sometimes refuse a turn with HTTP 403
 * and a model-refusal sentence instead of 200 + finish_reason=content_filter.
 * Codex treats that 403 as a transport failure, so the user message is never
 * recorded as a completed turn and retries loop. Keep this allowlist narrow:
 * entitlement / plan / model-access 403s must stay errors.
 */
const POLICY_REFUSAL_PHRASES = [
  "i can't help with that request",
  "i cannot help with that request",
  "i'm unable to help with that request",
  "i am unable to help with that request",
] as const;

function hasModelAccessCue(text: string): boolean {
  return (
    text.includes("not allowed to use this model")
    || text.includes("not allowed to use this operation")
  );
}

/**
 * xAI plan and credit 403 wording. Checked only by the refusal matcher below: adding these to
 * the global subscription classifier would also change status and error-code inference for
 * every message-only error that happens to mention credits.
 */
function hasEntitlementCue(text: string): boolean {
  return (
    isSubscriptionGateMessage(text)
    || text.includes("need a grok subscription")
    || text.includes("run out of credits")
  );
}

/** Lowercase, collapse whitespace, and strip trailing .!? so an exact phrase match is stable. */
function normalizePolicyRefusalSentence(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
}

/**
 * True only when the extracted error sentence is exactly a known model-refusal
 * phrase. JSON / "Provider error 403:" wrappers are unwrapped first. Extra
 * plan, credit, entitlement, or model-access wording keeps the error path.
 */
export function isUpstreamPolicyRefusalMessage(text: string): boolean {
  const extracted = extractPolicyRefusalText(text);
  const originalLower = text.toLowerCase();
  const extractedLower = extracted.toLowerCase();
  if (hasEntitlementCue(originalLower) || hasEntitlementCue(extractedLower)) return false;
  if (hasModelAccessCue(originalLower) || hasModelAccessCue(extractedLower)) return false;
  const normalized = normalizePolicyRefusalSentence(extracted);
  return (POLICY_REFUSAL_PHRASES as readonly string[]).includes(normalized);
}

/** HTTP 403 plus {@link isUpstreamPolicyRefusalMessage}; other statuses never rewrite. */
export function isUpstreamPolicyRefusal(status: number, text: string): boolean {
  return status === 403 && isUpstreamPolicyRefusalMessage(text);
}

/** Pull the human-readable refusal sentence out of a JSON or prefixed error body. */
export function extractPolicyRefusalText(raw: string): string {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    const nested = parsed.error;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
    if (nested && typeof nested === "object") {
      const msg = (nested as { message?: unknown; error?: unknown }).message
        ?? (nested as { error?: unknown }).error;
      if (typeof msg === "string" && msg.trim()) return msg.trim();
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
  } catch {
    /* not JSON */
  }
  // The proxy's own error text wraps the upstream JSON (`Provider error 403: {"error": ...}`),
  // so the remainder after the prefix gets the same unwrapping.
  const prefixed = trimmed.match(/^Provider error 403:\s*([\s\S]+)$/i);
  if (prefixed?.[1]?.trim()) return extractPolicyRefusalText(prefixed[1]);
  return trimmed;
}

function isLocalAclHardeningMessage(text: string): boolean {
  const secretPathHardening = text.includes("secret path") && (
    text.includes("acl") ||
    text.includes("harden") ||
    text.includes("permission") ||
    text.includes("access denied") ||
    text.includes("inheritance")
  );
  return (
    text.includes("icacls") ||
    text.includes("acl hardening") ||
    text.includes("ntfs") ||
    secretPathHardening ||
    text.includes("inheritance:r") ||
    /\bwindows\b.*\bacl\b/.test(text) ||
    text.includes("/grant:r")
  );
}

function isAuthenticationMessage(text: string): boolean {
  const accessDeniedWithCredentialCue = (
    text.includes("access denied") ||
    text.includes("accessdeniedexception")
  ) && (
    text.includes("authentication") ||
    text.includes("credential") ||
    text.includes("api key") ||
    text.includes("token") ||
    text.includes("signature")
  );
  return (
    text.includes("authentication failed") ||
    text.includes("authentication") ||
    text.includes("invalid_api_key") ||
    text.includes("invalid api key") ||
    text.includes("invalid token") ||
    text.includes("unauthorizedexception") ||
    text.includes("unrecognizedclientexception") ||
    text.includes("unrecognizedclient") ||
    text.includes("expired token") ||
    text.includes("expiredtoken") ||
    text.includes("unauthenticated") ||
    text.includes("unauthorized") ||
    accessDeniedWithCredentialCue
  );
}

function isPermissionMessage(text: string): boolean {
  return (
    text.includes("permission_denied") ||
    text.includes("permission denied") ||
    text.includes("forbidden") ||
    text.includes("access denied") ||
    text.includes("accessdeniedexception") ||
    text.includes("not allowed to use") ||
    text.includes("model access")
  );
}

/**
 * Geographic / network-location denials. Google's Cloud Code Assist API returns these as
 * HTTP 400 `FAILED_PRECONDITION: User location is not supported for the API use.` — the
 * request is well-formed, the caller's location is refused. Treated as a permission-class
 * rejection, never as an invalid request (#3467).
 */
const LOCATION_UNSUPPORTED_PATTERNS = [
  "location is not supported",
  "location not supported",
  "unsupported location",
  "region is not supported",
  "unsupported region",
  "country is not supported",
  "not supported in your country",
  "not supported in your region",
] as const;

export function isLocationUnsupportedMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return LOCATION_UNSUPPORTED_PATTERNS.some(needle => lower.includes(needle));
}

/**
 * Client cancelled / closed the turn. Matches ONLY abort phrases this codebase
 * produces — "client closed request during web-search" (src/web-search/loop.ts),
 * "Client cancelled request" (src/server/responses.ts) — plus the explicit
 * "request cancel(l)ed by client" forms. Deliberately narrow: bare "client closed"
 * would also swallow legitimate upstream failures like "upstream HTTP client
 * closed idle connection" and turn a real 502 into a 499.
 */
export function isClientClosedMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("client closed request") ||
    lower.includes("client cancelled request") ||
    lower.includes("client canceled request") ||
    lower.includes("request canceled by client") ||
    lower.includes("request cancelled by client")
  );
}

/**
 * Ambiguous-reset refusal wording owned by this proxy (src/lib/upstream-retry.ts):
 * the upstream exchange did not complete reliably, so the request may already have
 * been processed and automatic replay was stopped. Matched narrowly so a
 * provider-sent message is never relabeled by it.
 */
export function isUpstreamResetReplayRefusedMessage(text: string): boolean {
  return text.toLowerCase().includes(
    "the upstream exchange did not complete reliably. the request may already have been processed",
  );
}

export function classifyError(status: number, type: string, message: string): OcxErrorPayload {
  const text = message.toLowerCase();
  if (type === "previous_response_not_found") {
    return { message, type: "invalid_request_error", code: "previous_response_not_found" };
  }
  // Preserve explicit cancel types used by compact/combo JSON errors; unify message-inferred
  // client closes (web-search abort text) onto client_closed_request for /api/logs.
  if (type === "client_cancelled") {
    return { message, type: "client_cancelled", code: "client_cancelled" };
  }
  if (
    status === 499 ||
    type === "client_closed_request" ||
    isClientClosedMessage(text)
  ) {
    return { message, type: "invalid_request_error", code: "client_closed_request" };
  }
  // Codex only shows the dedicated cyber UI when error.code === "cyber_policy".
  // The public wire does not establish invalid_request_error as the canonical type, so
  // message-only classification keeps the dedicated identity instead of inventing one.
  // Structured callers re-apply their real upstream type with cyberPolicyErrorType().
  if (type === CYBER_POLICY_ERROR_CODE || isCyberPolicyMessage(text)) {
    return { message, type: CYBER_POLICY_ERROR_CODE, code: CYBER_POLICY_ERROR_CODE };
  }
  // A LOCAL preflight refusal keeps its own code (#1524). The message necessarily says
  // "context window" -- that is what it is refusing on -- so the generic remap below would
  // rewrite it to `context_length_exceeded` and make it indistinguishable from an UPSTREAM
  // verdict. The two need opposite fallback handling: ours means "this candidate does not
  // fit", theirs means "the request is impossible", so collapsing them ended the chain at
  // the first candidate that was merely too small.
  if (type === "input_admission_refused") {
    return { message, type: "invalid_request_error", code: "input_admission_refused" };
  }
  // A LOCAL inbound admission refusal (#3573) keeps its own code for the same reason as the
  // preflight refusal above. #4112 gave the UPSTREAM 413 on this surface
  // `context_length_exceeded`; without a distinct code here a client cannot tell a body the
  // proxy never read from a turn the provider itself rejected, and only one of the two is
  // fixed by raising `maxInboundBodyBytes`.
  if (type === "inbound_body_too_large") {
    return { message, type: "invalid_request_error", code: "inbound_body_too_large" };
  }
  if (
    text.includes("context_length_exceeded") ||
    text.includes("context window") ||
    text.includes("context length") ||
    text.includes("maximum context") ||
    text.includes("too many tokens")
  ) {
    return { message, type: "invalid_request_error", code: "context_length_exceeded" };
  }
  // "Cursor resource limit exceeded" is emitted only for explicit request-size overflow
  // details (isCursorRequestTooLargeDetail in cursor-errors.ts); "Cursor context limit
  // exceeded" is the bare payload-overflow shape (isCursorZeroTokenResourceExhausted);
  // quota-style resource exhaustion arrives as "Cursor rate limit exceeded" and falls
  // through to 429 below.
  if (text.includes("cursor resource limit exceeded")) {
    return { message, type: "invalid_request_error", code: "tool_catalog_too_large" };
  }
  if (text.includes("cursor context limit exceeded")) {
    return { message, type: "invalid_request_error", code: "context_length_exceeded" };
  }
  // The Cursor adapter's classified rate-limit prefix is authoritative: its DETAIL may echo
  // quota wording ("... quota exhausted") that would otherwise hit the insufficient_quota
  // branch below and break the planned retry-with-backoff contract (WP3 review blocker 1).
  if (text.includes("cursor rate limit exceeded")) {
    return { message, type: "rate_limit_error", code: "rate_limit_exceeded" };
  }
  if (
    text.includes("insufficient_quota") ||
    text.includes("exceeded your current quota") ||
    text.includes("quota exhausted") ||
    text.includes("account quota exceeded") ||
    text.includes("monthly quota exceeded") ||
    text.includes("daily quota exceeded")
  ) {
    return { message, type: "insufficient_quota", code: "insufficient_quota" };
  }
  // A refusal this proxy made itself, kept apart from the provider rate limits below. The HTTP
  // semantics are identical -- 429, do not send this again now -- but the code is the only thing
  // that tells an operator reading a log whether the provider throttled the request or whether
  // this process declined to send it. Folding it into the generic rate-limit code sent them to
  // the provider's dashboard to explain a decision that was never made there.
  if (type === SEND_BUDGET_EXHAUSTED_CODE) {
    return { message, type: "rate_limit_error", code: SEND_BUDGET_EXHAUSTED_CODE };
  }
  if (
    status === 429 ||
    text.includes("rate limit") ||
    text.includes("rate limited") ||
    text.includes("too many requests") ||
    text.includes("resource_exhausted") ||
    text.includes("resource exhausted") ||
    text.includes("throttlingexception") ||
    text.includes("throttling")
  ) {
    return { message, type: "rate_limit_error", code: "rate_limit_exceeded" };
  }
  if (type === "origin_rejected") {
    return { message, type: "invalid_request_error", code: "origin_rejected" };
  }
  // Local ACL setup failures can contain provider-like auth wording (for example
  // "access denied" or "authentication") but represent unavailable infrastructure.
  if (status === 503 && isLocalAclHardeningMessage(text)) {
    return { message, type: "server_error", code: "upstream_server_error" };
  }
  // HTTP 401 and explicit auth failures are authoritative even when provider text
  // also advertises an upgrade or subscription.
  if (
    status === 401 ||
    type === "authentication_error" ||
    isAuthenticationMessage(text)
  ) {
    return { message, type: "authentication_error", code: "invalid_api_key" };
  }
  // An explicit permission enum must not acquire a more specific inferred reason.
  if (type === "PERMISSION_DENIED" || text.includes("permission_denied")) {
    return { message, type: "permission_error", code: "permission_denied" };
  }
  // Location denials outrank generic permission / subscription wording, but never an
  // authoritative 5xx. Message-only adapter terminals arrive here with inferred 403.
  if (status < 500 && (type === "location_not_supported" || isLocationUnsupportedMessage(text))) {
    return { message, type: "permission_error", code: "location_not_supported" };
  }
  // Subscription labels are valid only in a known permission context.
  if (
    (status === 403 || type === "permission_error") &&
    isSubscriptionGateMessage(text)
  ) {
    return { message, type: "permission_error", code: "subscription_required" };
  }
  if (
    status === 403 ||
    type === "permission_error" ||
    isPermissionMessage(text)
  ) {
    return { message, type: "permission_error", code: "permission_denied" };
  }
  if (
    status === 503 ||
    text.includes("overloaded") ||
    text.includes("server is busy") ||
    text.includes("temporarily unavailable")
  ) {
    // Codex recognizes "server_is_overloaded" and applies retry-after backoff
    // (responses.rs is_server_overloaded_error); generic "upstream_server_error" is not recognized.
    return { message, type: "server_error", code: "server_is_overloaded" };
  }
  if (
    text.includes("validationexception") ||
    text.includes("invalid request") ||
    text.includes("model unavailable") ||
    text.includes("model not found") ||
    text.includes("unsupported model") ||
    text.includes("profile arn") ||
    text.includes("wrong region") ||
    text.includes("invalid region")
  ) {
    return { message, type: "invalid_request_error", code: "invalid_request_error" };
  }
  if (status >= 500) {
    return { message, type: "server_error", code: "upstream_server_error" };
  }
  if (status === 400 || type === "invalid_request_error") {
    return { message, type: "invalid_request_error", code: "invalid_request_error" };
  }
  return { message, type, code: type || null };
}

/**
 * True when a provider failure should participate in rate-limit / quota health blocking.
 * Reuses {@link classifyError} so generic 429 wording and quota phrases stay aligned.
 */
export function isRateLimitOrQuotaFailureMessage(message: string): boolean {
  const normalized = String(message ?? "").trim();
  if (!normalized) return false;
  const numericStatus = Number(normalized);
  if (numericStatus === 429 || numericStatus === 402) return true;
  const statusHint = Number.isInteger(numericStatus) && numericStatus > 0 ? numericStatus : 0;
  const classified = classifyError(statusHint, "", normalized);
  if (
    classified.type === "rate_limit_error"
    || classified.code === "rate_limit_exceeded"
    || classified.type === "insufficient_quota"
    || classified.code === "insufficient_quota"
  ) {
    return true;
  }
  // Retained quota cue used by subagent health before classifyError covered it.
  return normalized.toLowerCase().includes("usage limit");
}

export { parseRetryAfterFromMessage };

/** Infer HTTP status from adapter terminal error text (provider-agnostic keyword matching). */
export function inferHttpStatusFromAdapterMessage(message: string): number {
  const lower = message.toLowerCase();
  // Client aborts (e.g. mid web-search loop) must not look like upstream 502s in /api/logs.
  if (isClientClosedMessage(lower)) return 499;
  // Codex Transport maps cyber_policy only on HTTP 400 (SSE is code-based).
  if (isCyberPolicyMessage(lower)) return 400;
  // See classifyError: this prefix now only means explicit request-size overflow (400);
  // quota-style Cursor resource exhaustion carries the rate-limit prefix and maps to 429.
  if (lower.includes("cursor resource limit exceeded")) return 400;
  if (lower.includes("cursor context limit exceeded")) return 400;
  if (
    lower.includes("resource_exhausted") ||
    lower.includes("resource exhausted") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("throttling")
  ) return 429;
  // Local Windows filesystem hardening is infrastructure, not provider authentication.
  // Keep this ahead of auth/permission and timeout keyword inference.
  if (isLocalAclHardeningMessage(lower)) return 503;
  // Strong authentication signals win when a message contains mixed auth and
  // subscription/permission wording.
  if (isAuthenticationMessage(lower)) return 401;
  // A location denial is a permission-class rejection; keep it aligned with the
  // `permission_error` envelope status so message-only and classified paths agree.
  if (isLocationUnsupportedMessage(lower)) return 403;
  if (isSubscriptionGateMessage(lower) || isPermissionMessage(lower)) return 403;
  // Same precedence rule as classifyCursorError: an explicit gRPC FAILED_PRECONDITION is a
  // structured, deterministic rejection, so it outranks the overload keywords that routinely
  // appear beside it ("failed_precondition: model unavailable for this plan"). Without this,
  // the message matched "unavailable" and returned a retryable 503, so clients kept retrying
  // a rejection that can never succeed.
  if (lower.includes("failed_precondition") || lower.includes("failed precondition")) return 400;
  // Bytes the upstream itself produced and then mangled are a provider protocol failure, not a
  // malformed client request. This must sit ahead of the generic "malformed" -> 400 branch so a
  // combo can fail over instead of returning a terminal 4xx the caller cannot act on. Scoped to
  // the "malformed upstream" phrase our adapters emit; plain "malformed" keeps its 400 verdict.
  if (lower.includes("malformed upstream")) return 502;
  if (
    lower.includes("unavailable") ||
    lower.includes("overloaded") ||
    lower.includes("temporarily") ||
    lower.includes("server is busy")
  ) return 503;
  if (
    lower.includes("invalid") ||
    lower.includes("not found") ||
    lower.includes("unsupported") ||
    lower.includes("malformed") ||
    lower.includes("unimplemented")
  ) return 400;
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("deadline")
  ) return 504;
  return 502;
}

/** Map an adapter terminal error message to HTTP status + classified Codex error payload. */
export function adapterFailureFromMessage(message: string): { httpStatus: number; error: OcxErrorPayload } {
  const httpStatus = inferHttpStatusFromAdapterMessage(message);
  let finalMessage = message;
  const retryAfterSeconds = parseRetryAfterFromMessage(message);
  if (retryAfterSeconds && !/please try again in /i.test(message)) {
    finalMessage = `${message} Please try again in ${retryAfterSeconds}s.`;
  }
  const errorType = httpStatus === 499
    ? "client_closed_request"
    : httpStatus === 429
      ? "rate_limit_error"
      : httpStatus === 401
        ? "authentication_error"
        : httpStatus === 403
          ? "permission_error"
          : httpStatus === 503 || httpStatus === 504
            ? "server_error"
            : httpStatus === 400
              ? "invalid_request_error"
              : "upstream_error";
  return {
    httpStatus,
    error: classifyError(httpStatus, errorType, finalMessage),
  };
}

/** Map a terminal Responses error object to the HTTP status we record in /api/logs. */
export function httpStatusFromTerminalError(error: {
  type?: string;
  code?: string | null;
  message?: string;
} | undefined): number {
  if (!error) return 502;
  if (error.code === "client_closed_request" || error.code === "client_cancelled") return 499;
  if (isCyberPolicyCode(error.code) || (error.message ? isCyberPolicyMessage(error.message) : false)) {
    return 400;
  }
  if (error.type === "rate_limit_error" || error.code === "rate_limit_exceeded") return 429;
  if (error.type === "authentication_error" || error.code === "invalid_api_key") return 401;
  if (
    error.type === "permission_error" ||
    error.code === "permission_denied" ||
    error.code === "subscription_required"
  ) return 403;
  if (error.type === "insufficient_quota" || error.code === "insufficient_quota") return 429;
  if (error.type === "server_error" && error.code === "server_is_overloaded") return 503;
  // Client-closed messages often arrive as invalid_request_error after classifyError; check message
  // before treating every invalid_request_error as HTTP 400.
  const message = error.message ?? "";
  if (message && isClientClosedMessage(message)) return 499;
  if (error.type === "invalid_request_error") return 400;
  if (error.type === "proxy_error") return 500;
  // A structured server class must not be downgraded to a CLIENT error by message wording.
  // classifyError assigns `server_error` + `upstream_server_error` to every 5xx it sees, so
  // the class is authoritative about blame: the upstream failed, the caller did not send a
  // bad request. What it is NOT authoritative about is which server status fits — a stall is
  // genuinely 504 and an overload genuinely 503, and flattening those to 502 discards
  // information both the log surface and the retry policy read. So message inference still
  // chooses the specific status, and only a client-error verdict is overridden.
  //
  // The override is deliberately narrowed to 400 alone. 429, 499, 401 and 403 are all
  // actionable signals the caller routes on — retry-after, client cancellation, re-auth,
  // entitlement — and overriding them would trade one kind of misreport for another. 400 is
  // the single verdict that both blames the caller and stops the retry, which is the failure
  // being fixed: an upstream 500 whose text happens to contain "malformed" or "invalid
  // request" used to return 400, so Claude Code stopped retrying a retryable failure.
  const structuredServerClass = error.type === "server_error" || error.code === "upstream_server_error";
  if (message) {
    const inferred = inferHttpStatusFromAdapterMessage(message);
    return structuredServerClass && inferred === 400 ? 502 : inferred;
  }
  return 502;
}
