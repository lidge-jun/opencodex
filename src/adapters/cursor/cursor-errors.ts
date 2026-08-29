import { redactSecretString } from "../../lib/redact";

const ABSOLUTE_PATH_PATTERN = /(?:\/Users\/[^ "';,]+|\/home\/[^ "';,]+|[A-Za-z]:\\Users\\[^ "';,]+)/g;
// Cursor error messages can contain raw credential key=value pairs beyond what the shared
// redactSecretString covers. We handle the additional transport-specific patterns locally.
const CURSOR_CREDENTIAL_PATTERN = /\b(authorization|auth[_-]?token|cursor[_-]?token)=([^&\s"',;]+)/gi;

function sanitize(value: string): string {
  return redactSecretString(value)
    .replace(CURSOR_CREDENTIAL_PATTERN, "$1=[REDACTED]")
    .replace(ABSOLUTE_PATH_PATTERN, "[REDACTED_PATH]");
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return String(value ?? "");
}

function errorCode(value: unknown): string {
  if (typeof value !== "object" || !value || !("code" in value)) return "";
  const code = (value as { code?: unknown }).code;
  return code === undefined || code === null ? "" : String(code);
}

/**
 * True when Cursor intentionally cancelled the HTTP/2 stream after a client-tool suspend.
 * These are expected between multi-turn Responses bridge cycles, not upstream failures.
 */
/**
 * A Cursor stream that ended cleanly at the HTTP/2 layer while a client tool call was still
 * open — no `turnEnded`, no error trailer, just EOF. The call's buffered arguments are lost,
 * so the turn is truncated: reporting it as success would hand Codex a turn whose tool call
 * silently never happened. Not retryable — the request is committed once the session connects.
 */
export class CursorStreamTruncatedError extends Error {
  constructor(
    public readonly openCallIds: readonly string[],
    public readonly framesReceived: number,
  ) {
    super(
      `Cursor stream ended without terminating the turn; ${openCallIds.length} tool call(s) left incomplete `
      + `(${openCallIds.join(", ")}) after ${framesReceived} frame(s). Arguments may be truncated; the call was not committed.`,
    );
    this.name = "CursorStreamTruncatedError";
  }
}

/**
 * A cancel-shaped stream failure that WE did not request. `cancelCursorRun` is the only place
 * that cancels our own stream, and it sets `expectedClose` first, so a cancel arriving without it
 * came from Cursor or the network and is a real transport failure.
 *
 * It carries its own message on purpose. Left as a raw `NGHTTP2_CANCEL` error, the text is
 * re-matched downstream (`classifyCursorError`) and labelled "Cursor stream suspended" — a turn
 * that failed unexpectedly would report an intentional suspension and misdirect diagnosis.
 */
export class CursorUnexpectedCancelError extends Error {
  /**
   * The originating error's transport code (typically `NGHTTP2_CANCEL`), re-exposed so the
   * per-turn `turn-failed` diagnostic still records how the stream actually died. Wrapping
   * without this made the summary for exactly this failure the one with no code.
   */
  public readonly code?: string;

  constructor(public readonly cause?: unknown) {
    super("Cursor connection was cancelled by the server before the turn completed");
    this.name = "CursorUnexpectedCancelError";
    const causeCode = errorCode(cause);
    if (causeCode) this.code = causeCode;
  }
}

/**
 * The assembled root-blob envelope exceeded what Cursor's external workers accept.
 *
 * Raised locally, BEFORE the request is sent. Cursor rejects an oversized replay set with a late
 * `invalid_argument` only after hydrating every blob, so the upstream failure arrives with no
 * usable measurement — that is why this carries the counts it measured. Never retryable: replaying
 * the same over-envelope request reproduces it exactly.
 *
 * The measurement is taken on the FINAL root set, after checkpoint and suffix assembly. Bounding
 * an intermediate set is what let 192 checkpoint roots plus a two-root suffix emit 194 (#1527).
 */
export class CursorRootEnvelopeLimitError extends Error {
  public readonly code = "cursor_root_envelope_limit";
  public readonly status = 400;

  constructor(
    public readonly rootCount: number,
    public readonly rootBytes: number,
    public readonly maxRootCount: number,
    public readonly maxRootBytes: number,
  ) {
    super(
      // No "Cursor invalid request:" prefix here: `safeCursorErrorMessage` adds it for
      // invalid-argument classes, and carrying it in the message produced it twice.
      "the assembled conversation exceeds the replay envelope "
      + `(${rootCount} root blobs / ${rootBytes} bytes against a limit of ${maxRootCount} / ${maxRootBytes}). `
      + "Start a new conversation or reduce the pending tool output.",
    );
    this.name = "CursorRootEnvelopeLimitError";
  }
}

/**
 * The envelope failure is local and deterministic; a retry cannot change the outcome.
 *
 * A companion `CursorRootMeasurementError` was drafted for the case where a root blob's size
 * cannot be read, then deleted: an unmeasurable root is legitimate (a resumed conversation
 * references ids Cursor minted and this process never stored), so the guard counts it instead of
 * failing. There is no reachable second case, and an unreachable error class cannot be tested.
 */
export function isCursorRootEnvelopeError(value: unknown): boolean {
  return value instanceof CursorRootEnvelopeLimitError;
}

export function isCursorBenignCancelError(value: unknown): boolean {
  // An unexpected cancel is never benign, however it is spelled. This class is raised only when
  // the transport knows WE did not request the cancel, so its provenance outranks the code match
  // below — otherwise the adapter would re-decide the same question from the error code alone
  // and swallow a real transport failure (cursor.ts:181).
  if (value instanceof CursorUnexpectedCancelError) return false;
  const message = errorMessage(value).toLowerCase();
  const code = errorCode(value).toUpperCase();
  if (code === "NGHTTP2_CANCEL") return true;
  if (message.includes("nghttp2_cancel")) return true;
  if (message.includes("cursor stream suspended")) return true;
  return false;
}

/**
 * True when the turn was torn down by an `AbortSignal` rather than by a transport fault.
 *
 * This is deliberately NOT part of `isCursorBenignCancelError`: an abort mid-turn is a real
 * failure and must still surface. It is only meaningful in combination with a terminal frame
 * having already been emitted, where it means "the answer landed and then the connection went
 * away" (#1527).
 */
export function isCursorAbortError(value: unknown): boolean {
  const message = errorMessage(value).toLowerCase();
  if (message.includes("cursor request was aborted")) return true;
  const name = (value as { name?: unknown })?.name;
  return typeof name === "string" && name === "AbortError";
}

/**
 * True when Cursor Connect rejected the turn with invalid_argument.
 * Seen after stepCompleted on brittle external-model continuations.
 */
export function isCursorInvalidArgumentError(value: unknown): boolean {
  const code = errorCode(value).toLowerCase();
  if (code === "invalid_argument") return true;
  const message = errorMessage(value).toLowerCase();
  return message.includes("invalid_argument");
}

const QUOTA_RATE_CUES = ["too many requests", "quota", "rate limit", "rate-limit", "throttl"];
/**
 * A bare `resource_exhausted` end-stream with no detail beyond a generic error wrapper
 * ("Error" or empty tail) and zero tokens billed is the shape Cursor's backend emits when
 * the request payload exceeded its context window — not when quota ran out (senpi #1009,
 * #1036: same wording, two causes). Quota rejections always carry an explicit rate cue
 * ("too many requests", "quota exhausted"), so the ABSENCE of those cues plus the
 * absence of a size phrase means payload overflow. Classifying it as 429 makes Codex
 * back off instead of compacting, which burns retries on an unfixable-by-retry failure.
 */
const BARE_RE_TAILS = new Set(["error", "", "resource_exhausted", "resource exhausted"]);

/**
 * Size prior for bare resource_exhausted classification (devlog 260, live probe 210):
 * a plan-gated model returns the SAME bare RE shape on a ~20-token prompt that a real
 * payload overflow produces, so the message alone cannot separate "compact and retry"
 * from "this account cannot use this model". When the caller can supply how large the
 * request actually was relative to the model's window, a small request keeps the
 * 429-class mapping; only a plausibly-large one classifies as overflow. Unknown
 * sizes keep today's overflow mapping so the prior only ever REMOVES false overflows
 * it can prove.
 */
export interface CursorSizeContext {
  estimatedInputTokens?: number;
  contextWindow?: number;
}

const OVERFLOW_MIN_FRACTION = 0.5;

function bareReLooksLikeOverflow(context?: CursorSizeContext): boolean {
  if (!context) return true;
  const { estimatedInputTokens, contextWindow } = context;
  if (estimatedInputTokens === undefined || contextWindow === undefined || contextWindow <= 0) return true;
  return estimatedInputTokens >= OVERFLOW_MIN_FRACTION * contextWindow;
}

export function isCursorZeroTokenResourceExhausted(lowerMessage: string): boolean {
  if (!lowerMessage.includes("resource_exhausted") && !lowerMessage.includes("resource exhausted")) return false;
  // Any explicit quota/rate cue wins: this is a real 429.
  if (QUOTA_RATE_CUES.some(cue => lowerMessage.includes(cue))) return false;
  // An explicit size phrase also wins (already handled by the existing classifier).
  if (isCursorRequestTooLargeDetail(lowerMessage)) return false;
  // Extract the tail after the resource_exhausted marker. If it names a specific
  // non-quota, non-size cause, this is NOT bare overflow.
  const idx = Math.max(
    lowerMessage.indexOf("resource_exhausted"),
    lowerMessage.indexOf("resource exhausted"),
  );
  const tail = lowerMessage.slice(idx + "resource_exhausted".length).trim().replace(/^[:\s]+/, "").trim();
  if (!BARE_RE_TAILS.has(tail)) return false;
  return true;
}

const REQUEST_TOO_LARGE_PATTERNS: (string | RegExp)[] = [
  "tool catalog too large",
  "tool registration too large",
  "too many tools",
  "message too large",
  "payload too large",
  "request too large",
  // Size cue required somewhere: a bare "request exceeds ... limit" (concurrency/quota
  // shape) must NOT match, but "request body/size exceeds ... limit" and
  // "request exceeds maximum allowed size" are deterministic overflow (WP3 r1/r2).
  /request exceeds .*size/,
  /request (?:body|size) exceeds .*(?:size|limit)/,
  "maximum allowed size",
];

/**
 * True when a resource_exhausted detail names a request-size overflow rather than quota.
 * Quota/rate cues are rejected FIRST: "resource_exhausted while loading tool catalog: quota
 * exhausted" is rate limiting, not a too-large request, even though it mentions the catalog.
 */
export function isCursorRequestTooLargeDetail(lowerMessage: string): boolean {
  if (QUOTA_RATE_CUES.some(cue => lowerMessage.includes(cue))) return false;
  return REQUEST_TOO_LARGE_PATTERNS.some(pattern =>
    typeof pattern === "string" ? lowerMessage.includes(pattern) : pattern.test(lowerMessage),
  );
}

/**
 * Classify a Cursor transport/Connect/gRPC error message into an actionable category.
 * The returned prefix string is recognized by `src/lib/errors.ts` `classifyError` keywords,
 * so bridge-level error mapping produces the right Codex error type (rate_limit, auth, etc.).
 */
export function classifyCursorError(message: string, sizeContext?: CursorSizeContext): string {
  const lower = message.toLowerCase();

  if (isCursorBenignCancelError(message)) return "Cursor stream suspended";

  if (
    lower.includes("resource_exhausted") ||
    lower.includes("resource exhausted")
  ) {
    // gRPC RESOURCE_EXHAUSTED is quota/rate exhaustion unless the detail names a
    // request-size overflow (tool catalog/registration). Only the latter is a
    // client-fixable 400; everything else surfaces as a 429 so Codex backs off
    // instead of hammering retries (live evidence: 6x 400 retry storm, devlog
    // 260723_cursor_context_continuity/000_plan.md).
    if (isCursorRequestTooLargeDetail(lower)) return "Cursor resource limit exceeded";
    // A bare resource_exhausted with no quota cue and no size phrase is payload
    // overflow, not rate limiting. Classifying it as 429 makes Codex back off on a
    // failure that only compaction can fix (senpi #1009 / #1036; research unit T01).
    // Refinement (devlog 260): plan-gated models emit the same bare shape on tiny
    // requests — when the caller proves the request was small, keep the 429 class.
    if (isCursorZeroTokenResourceExhausted(lower)) {
      return bareReLooksLikeOverflow(sizeContext) ? "Cursor context limit exceeded" : "Cursor rate limit exceeded";
    }
    return "Cursor rate limit exceeded";
  }

  if (
    lower.includes("rate limit") ||
    lower.includes("rate-limit") ||
    lower.includes("too many requests") ||
    lower.includes("throttling")
  ) return "Cursor rate limit exceeded";

  if (
    lower.includes("unauthenticated") ||
    lower.includes("unauthorized") ||
    lower.includes("permission_denied") ||
    lower.includes("permission denied") ||
    lower.includes("forbidden") ||
    lower.includes("invalid token") ||
    lower.includes("expired token") ||
    lower.includes("authentication") ||
    lower.includes("access denied")
  ) return "Cursor authentication failed";

  // gRPC FAILED_PRECONDITION is deterministic and non-retryable (unlike UNAVAILABLE):
  // the backend rejected the call because the account/plan state does not allow it —
  // seen live when a plan-gated model (e.g. claude-fable-5) runs on a plan without it.
  // Leaving it as "Cursor upstream error" (502) made clients retry it as overload.
  //
  // This MUST precede the overload keywords. The explicit gRPC status code is a
  // structured signal from the backend; the keywords are inference over free text. A
  // plan-gated rejection routinely reads "failed_precondition: model unavailable for
  // this plan", which matched "unavailable" first and came back as a retryable
  // overload — the exact misclassification this branch was added to stop. Checking the
  // code first lets the deterministic signal win over the words around it.
  if (lower.includes("failed_precondition") || lower.includes("failed precondition")) {
    return "Cursor invalid request";
  }

  if (
    lower.includes("unavailable") ||
    lower.includes("overloaded") ||
    lower.includes("temporarily") ||
    lower.includes("server is busy")
  ) return "Cursor server overloaded";

  if (
    lower.includes("invalid") ||
    lower.includes("not found") ||
    lower.includes("unsupported") ||
    lower.includes("malformed") ||
    lower.includes("unimplemented")
  ) return "Cursor invalid request";

  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("deadline")
  ) return "Cursor request timed out";

  if (
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("goaway") ||
    lower.includes("nghttp2") ||
    lower.includes("socket hang up") ||
    lower.includes("connection reset")
  ) return "Cursor connection failed";

  return "Cursor upstream error";
}

/**
 * Produce a user-facing, secret-safe Cursor error message with an actionable category prefix.
 * Mirrors `safeKiroErrorMessage` / `safeKiroHttpErrorMessage` in kiro-errors.ts.
 */
export function safeCursorErrorMessage(rawMessage: string, sizeContext?: CursorSizeContext): string {
  const prefix = classifyCursorError(rawMessage, sizeContext);
  const detail = sanitize(rawMessage)
    .replace(/resource[_ ]exhausted/gi, "resource limit exceeded")
    .slice(0, 500);
  return detail ? `${prefix}: ${detail}` : prefix;
}
