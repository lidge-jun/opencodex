import { parseResetCooldownMs } from "../codex/routing";
import { classifyError, isCyberPolicyCode } from "../lib/errors";
import { isNonReplayableUpstreamCode } from "../lib/upstream-retry";
import type { OcxComboTarget } from "../types";
import { targetKey } from "./types";
import {
  captureConfigGeneration,
  sweepExpiredOnWrite,
  type GenerationContext,
} from "../lib/state-store-sweeper";

interface TargetCooldown {
  cooldownUntil: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000;
const MAX_SERVER_DELAY_MS = 24 * 60 * 60_000;
/** Short cooldown for request-rate 429s (for example provider code 1302) that omit Retry-After. */
export const COMBO_REQUEST_RATE_COOLDOWN_MS = 5_000;

const QUOTA_LIMIT_CODES = new Set([
  "1308",
  "1310",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
  "insufficient_quota",
]);
const TRANSIENT_REQUEST_RATE_CODES = new Set(["1302", "1305"]);
const IMF_FIXDATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/i;
const RFC850_DATE_RE = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/i;
const ASCTIME_DATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/i;
const HTTP_MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Map<`${comboId}\0${provider/model}`, TargetCooldown> */
const targetCooldowns = new Map<string, TargetCooldown>();
let lastReconciledGeneration = 0;
let liveComboTargets = new Set<string>();

function cooldownMapKey(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
): string {
  return `${comboId}\0${targetKey(target)}`;
}

function parseUtcDateParts(
  year: number,
  monthName: string,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
  const month = HTTP_MONTH_INDEX[monthName.toLowerCase()];
  if (month === undefined) return undefined;
  const timestamp = Date.UTC(year, month, day, hour, minute, second);
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month
    && parsed.getUTCDate() === day
    && parsed.getUTCHours() === hour
    && parsed.getUTCMinutes() === minute
    && parsed.getUTCSeconds() === second
    ? timestamp
    : undefined;
}

function parseHttpDate(value: string, now: number): number | undefined {
  const imf = IMF_FIXDATE_RE.exec(value);
  if (imf) {
    return parseUtcDateParts(
      Number(imf[3]), imf[2]!, Number(imf[1]),
      Number(imf[4]), Number(imf[5]), Number(imf[6]),
    );
  }
  const rfc850 = RFC850_DATE_RE.exec(value);
  if (rfc850) {
    const current = new Date(now);
    const currentYear = current.getUTCFullYear();
    const month = HTTP_MONTH_INDEX[rfc850[2]!.toLowerCase()];
    if (month === undefined) return undefined;
    let year = Math.floor(currentYear / 100) * 100 + Number(rfc850[3]);
    const yearDelta = year - currentYear;
    const candidateTimeOfYear = Date.UTC(
      2000, month, Number(rfc850[1]),
      Number(rfc850[4]), Number(rfc850[5]), Number(rfc850[6]),
    );
    const currentTimeOfYear = Date.UTC(
      2000, current.getUTCMonth(), current.getUTCDate(),
      current.getUTCHours(), current.getUTCMinutes(), current.getUTCSeconds(),
      current.getUTCMilliseconds(),
    );
    if (yearDelta < -50 || (yearDelta === -50 && candidateTimeOfYear < currentTimeOfYear)) {
      year += 100;
    } else if (yearDelta > 50 || (yearDelta === 50 && candidateTimeOfYear > currentTimeOfYear)) {
      year -= 100;
    }
    return parseUtcDateParts(
      year, rfc850[2]!, Number(rfc850[1]),
      Number(rfc850[4]), Number(rfc850[5]), Number(rfc850[6]),
    );
  }
  const asctime = ASCTIME_DATE_RE.exec(value);
  if (!asctime) return undefined;
  return parseUtcDateParts(
    Number(asctime[6]), asctime[1]!, Number(asctime[2]),
    Number(asctime[3]), Number(asctime[4]), Number(asctime[5]),
  );
}

/** Parse a Retry-After delay, optionally retaining an upstream delay up to one day. */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
  options?: { preserveImmediate?: boolean; preserveServerDelay?: boolean },
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  // Keep legacy bounded parsing for other callers. Combo cooldowns preserve
  // multi-hour upstream delays, but never quarantine a target beyond one day.
  const maximum = options?.preserveServerDelay === true
    ? MAX_SERVER_DELAY_MS
    : MAX_COOLDOWN_MS;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (
      Number.isFinite(seconds)
      && (seconds > 0 || (options?.preserveImmediate && seconds === 0))
    ) {
      return Math.min(Math.max(Math.ceil(seconds * 1000), 1), maximum);
    }
  }
  const timestamp = parseHttpDate(text, now);
  if (timestamp === undefined) return undefined;
  const delay = timestamp - now;
  if (delay > 0) return Math.min(delay, maximum);
  return options?.preserveImmediate ? 1 : undefined;
}

export function isComboTargetInCooldown(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  now = Date.now(),
): boolean {
  const key = cooldownMapKey(comboId, target);
  const entry = targetCooldowns.get(key);
  if (!entry) return false;
  if (entry.cooldownUntil <= now) {
    targetCooldowns.delete(key);
    return false;
  }
  return true;
}

export function isTransientRequestRateLimit(input: {
  status?: number;
  code?: string | null;
  message?: string;
}): boolean {
  if (isProviderScopedQuotaCap(input.status, input.message ?? "", input.code)) return false;
  const code = (input.code ?? "").trim().toLowerCase().replaceAll("-", "_");
  if (QUOTA_LIMIT_CODES.has(code)) return false;
  if (TRANSIENT_REQUEST_RATE_CODES.has(code)) return true;
  const text = (input.message ?? "").toLowerCase();
  if (
    text.includes("usage limit reached")
    || text.includes("insufficient_quota")
    || text.includes("quota exhausted")
  ) {
    return false;
  }
  return text.includes("rate limit reached for requests");
}

export function remainingComboCooldownMs(comboId: string, now = Date.now()): number | undefined {
  const prefix = `${comboId}\0`;
  let soonest: number | undefined;
  for (const [key, cooldown] of targetCooldowns) {
    if (!key.startsWith(prefix)) continue;
    const remaining = cooldown.cooldownUntil - now;
    if (remaining <= 0) {
      targetCooldowns.delete(key);
      continue;
    }
    if (soonest === undefined || remaining < soonest) soonest = remaining;
  }
  return soonest;
}

export function comboCooldownRetryAfterSeconds(comboId: string, now = Date.now()): string | undefined {
  const remainingMs = remainingComboCooldownMs(comboId, now);
  if (remainingMs === undefined) return undefined;
  return String(Math.max(1, Math.ceil(remainingMs / 1000)));
}

/** Record a combo target cooldown, preferring bounded upstream retry evidence. */
export function coolComboTarget(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  options?: {
    retryAfter?: string | null;
    resetAt?: unknown | unknown[];
    now?: number;
    cooldownMs?: number;
    writerGeneration?: number;
    status?: number;
    code?: string | null;
    message?: string;
  },
): boolean {
  const now = options?.now ?? Date.now();
  const writerGeneration = options?.writerGeneration ?? captureConfigGeneration();
  const ownerKey = `${comboId}::${targetKey(target)}`;
  if (writerGeneration < lastReconciledGeneration && !liveComboTargets.has(ownerKey)) return false;
  // A server-provided Retry-After is authoritative, including an immediate `0` directive.
  // A quota reset is the next-most-specific signal (#3256); configured and default cooldowns
  // are only fallbacks when upstream supplied neither usable value.
  const serverDelayMs = parseRetryAfterMs(options?.retryAfter, now, {
    preserveImmediate: true,
    preserveServerDelay: true,
  });
  const cooldownMs = serverDelayMs
    ?? parseResetCooldownMs(options?.resetAt, now)
    ?? options?.cooldownMs
    // A spent account window or an unpaid/rejected credential does not turn over in a minute,
    // so the 60s default would re-offer a target that cannot succeed. Only the duration
    // changes; the scope and hop decisions are untouched.
    ?? (isAccountWindowExhausted(options?.message ?? "", options?.code)
      || PROVIDER_SCOPED_FAILURE_CODES.has(normalizedFailureCode(options?.code))
      ? MAX_COOLDOWN_MS
      : isTransientRequestRateLimit({
        status: options?.status,
        code: options?.code,
        message: options?.message,
      }) ? COMBO_REQUEST_RATE_COOLDOWN_MS : DEFAULT_COOLDOWN_MS);
  targetCooldowns.set(cooldownMapKey(comboId, target), {
    // Local fallbacks are capped at ten minutes; explicit server delays at one day.
    cooldownUntil: now + (serverDelayMs ?? Math.min(Math.max(cooldownMs, 1), MAX_COOLDOWN_MS)),
  });
  sweepExpiredOnWrite(now);
  return true;
}

export function earliestComboCooldown(
  comboId: string,
  targets: Iterable<Pick<OcxComboTarget, "provider" | "model">>,
  now = Date.now(),
): { expiry: number; target: Pick<OcxComboTarget, "provider" | "model"> } | undefined {
  let earliest: { expiry: number; target: Pick<OcxComboTarget, "provider" | "model"> } | undefined;
  for (const target of targets) {
    const key = cooldownMapKey(comboId, target);
    const entry = targetCooldowns.get(key);
    if (!entry || entry.cooldownUntil <= now) continue;
    if (earliest === undefined || entry.cooldownUntil < earliest.expiry) {
      earliest = { expiry: entry.cooldownUntil, target };
    }
  }
  return earliest;
}

/** Public convenience wrapper returning only the earliest cooldown expiry. */
export function earliestComboCooldownExpiry(
  comboId: string,
  targets: Iterable<Pick<OcxComboTarget, "provider" | "model">>,
  now = Date.now(),
): number | undefined {
  return earliestComboCooldown(comboId, targets, now)?.expiry;
}

export function reconcileComboTargetCooldowns(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  liveComboTargets = new Set(context.comboTargets);
  lastReconciledGeneration = context.generation;
  return 0;
}

export function sweepExpiredComboTargetCooldowns(now = Date.now()): number {
  let removed = 0;
  for (const [key, cooldown] of targetCooldowns) {
    if (cooldown.cooldownUntil > now) continue;
    targetCooldowns.delete(key);
    removed += 1;
  }
  return removed;
}

export function clearComboTargetCooldowns(comboId?: string): void {
  if (comboId === undefined) {
    targetCooldowns.clear();
    liveComboTargets.clear();
    lastReconciledGeneration = 0;
    return;
  }
  const prefix = `${comboId}\0`;
  for (const key of targetCooldowns.keys()) {
    if (key.startsWith(prefix)) targetCooldowns.delete(key);
  }
}

export type ComboFailureDecision = "hop" | "stop";
export type ComboFailureCooldownScope = "none" | "target" | "provider";

function normalizedFailureCode(code?: string | null): string {
  return code?.trim().toLowerCase().replaceAll("-", "_") ?? "";
}

/**
 * A spent account window, by structured code or upstream prose. Status is deliberately not
 * consulted: the ChatGPT Codex backend reports a depleted plan window as HTTP 502
 * `upstream_server_error` carrying `The usage limit has been reached`, never the documented 429,
 * so any status gate misses it. Read in exactly ONE place -- the cooldown DURATION fallback. A
 * status-blind prose match is safe for choosing how long to wait; it is not safe for choosing
 * what to black out, so `isProviderScopedQuotaCap` and the scope/decision paths stay untouched
 * and a Codex 502 still resolves `target` scope and `hop` through `status >= 500`.
 */
// `1308` is the vendor code for a spent five-hour window and carries no prose of its own when the
// upstream reports it bare, so it belongs here too. The rest of QUOTA_LIMIT_CODES stays out: those
// are quota-limit codes whose window length this gateway has no evidence for, and guessing long on
// them would hold a target that may clear sooner.
const ACCOUNT_EXHAUSTION_CODES = new Set(["usage_limit_exceeded", "usage_limit_reached", "1308"]);
const ACCOUNT_EXHAUSTION_TEXT = /usage limit (?:has been )?reached/;

function isAccountWindowExhausted(message: string, code?: string | null): boolean {
  return ACCOUNT_EXHAUSTION_CODES.has(normalizedFailureCode(code))
    || ACCOUNT_EXHAUSTION_TEXT.test(message.toLowerCase());
}

function isProviderScopedQuotaCap(
  status: number | undefined,
  message: string,
  code?: string | null,
): boolean {
  const normalizedCode = normalizedFailureCode(code);
  const text = message.toLowerCase();
  if (
    status === 429
    && (normalizedCode === "gousagelimiterror" || text.includes("monthly usage limit reached"))
  ) {
    return true;
  }
  return text.includes("err_free_prompt_cap")
    || (text.includes("free tier") && text.includes("single request"));
}

/**
 * A free-tier cap the upstream evaluates PER REQUEST rather than per account window. These
 * needles used to reach only `isProviderScopedQuotaCap`, so a single oversized free-tier prompt
 * cooled the whole provider for every other combo — including the shorter requests that same
 * provider would still have served. `free_rate_limited` also left the provider-scoped predicate
 * for the same reason; it stays a hop signal, but stops recording provider-wide evidence.
 */
function isRequestLocalFreePromptCap(
  status: number | undefined,
  message: string,
  code?: string | null,
): boolean {
  if (status !== 400) return false;
  const text = message.toLowerCase();
  if (normalizedFailureCode(code) === "free_rate_limited") return true;
  if (text.includes("err_free_prompt_cap")) return true;
  return text.includes("free tier") && (text.includes("single request") || text.includes("prompt"));
}

/**
 * Failures that describe the SHAPE of this request rather than the health of the target.
 * Cooling anything for these is wrong twice over: the target is fine, and the next request
 * (shorter prompt, smaller tool catalog) would have succeeded against it.
 */
const REQUEST_SHAPE_FAILURE_CODES = new Set([
  "input_admission_refused",
  "context_length_exceeded",
  "tool_catalog_too_large",
  "cursor_root_envelope_limit",
  "target_incompatible",
]);

/** Credential/billing failures that every target sharing the provider inherits. */
const PROVIDER_SCOPED_FAILURE_CODES = new Set([
  "invalid_api_key",
  "insufficient_quota",
  "subscription_required",
  "payment_required",
  "billing_error",
  "insufficient_balance",
]);

/**
 * Precise target-local request incompatibilities are request-local, not terminal for a combo.
 * Require a bounded, intact provider envelope; never infer compatibility from echoed prompt text.
 * Only OpenCodex's exact error wrapper may be unwrapped, with a fixed depth budget. Unknown or
 * conflicting codes fail closed. No fields are removed here and no same-target replay is added.
 * Image rejection requires `param: input` and an exact model-scoped prefix.
 */
function isRequestLocalTargetIncompatibility(status: number, message: string, code?: string | null): boolean {
  if (status !== 400 || message.length > 16_384) return false;
  const genericCodes = new Set(["", "invalid_request_error", "unsupported_parameter", "unsupported_value"]);
  if (!genericCodes.has(normalizedFailureCode(code))) return false;
  let text = message.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    if (text.startsWith("Provider error 400: ")) text = text.slice("Provider error 400: ".length);
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { return false; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const error = (payload as Record<string, unknown>).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return false;
    const e = error as Record<string, unknown>;
    if (e.code !== undefined && e.code !== null && typeof e.code !== "string") return false;
    const errorCode = normalizedFailureCode(typeof e.code === "string" ? e.code : undefined);
    if (!genericCodes.has(errorCode) || typeof e.message !== "string") return false;
    if (e.type !== "invalid_request_error" && e.type !== "upstream_error") return false;
    if (e.message.startsWith("Provider error 400: ") && e.param === undefined
      && (errorCode === "" || errorCode === "invalid_request_error")) {
      text = e.message;
      continue;
    }
    if (e.type !== "invalid_request_error") return false;
    if (e.message === "Unsupported parameter: user") {
      return (e.param === undefined || e.param === "user") && errorCode !== "unsupported_value";
    }
    if (errorCode === "unsupported_value"
      && (e.param === "reasoning.effort" || e.param === "reasoning_effort")
      && e.message.startsWith("Unsupported value:") && e.message.includes("not supported")) return true;
    if (e.code === null
      && e.param === "reasoning_effort"
      && /^Function tools with reasoning_effort are not supported for gpt-6-astra(?:-\d{4}-\d{2}-\d{2})? in \/v1\/chat\/completions\. To use function tools, use \/v1\/responses or set reasoning_effort to 'none'\.$/.test(e.message)) return true;
    return e.param === "input"
      && (errorCode === "" || errorCode === "invalid_request_error")
      && /^Model '[^']{1,256}' does not support image inputs\./.test(e.message);
  }
  return false;
}

/**
 * Codes a gateway uses when it declines a request field it cannot serve.
 *
 * Wider than the set {@link isRequestLocalTargetIncompatibility} accepts, by exactly one member:
 * Alibaba's gateway reports `invalid_parameter_error`. It is kept in its own set rather than
 * added to the shared one, because that set also governs the `user` parameter and image-input
 * branches and widening it there would admit shapes those branches were reasoned about without.
 */
const RESPONSE_FORMAT_REFUSAL_CODES = new Set([
  "",
  "invalid_request_error",
  "invalid_parameter_error",
  "unsupported_parameter",
  "unsupported_value",
]);

/**
 * Does this message say the target cannot PROVIDE `response_format`, rather than that the
 * request's `response_format` was malformed?
 *
 * That distinction is the whole point of #4903 and it is why neither obvious option was taken.
 * Hopping on every 400 would replay a genuinely malformed request against every remaining
 * target. Dropping `response_format` would silently change the output contract the caller
 * asked for, on a path whose entire purpose is a structured result.
 *
 * So both halves are required: the message must name the field, AND it must say the field is
 * unavailable or unsupported. "Invalid schema for response_format" names the field and claims
 * nothing about capability, so it stays terminal.
 *
 * `param` may be absent or explicitly null -- the reported gateway sends `param: null` -- but a
 * param naming a DIFFERENT field contradicts the message and fails closed.
 */
function namesResponseFormatIncapability(message: string, param: unknown): boolean {
  if (param !== undefined && param !== null && param !== "response_format") return false;
  const text = message.toLowerCase();
  if (!text.includes("response_format")) return false;
  return /(unavailable|not available|unsupported|not supported|does not support|doesn't support|cannot be used|is not enabled)/u
    .test(text);
}

/**
 * A `response_format` capability gap is target-local: this model cannot produce the requested
 * output shape, which says nothing about the next target in the combo.
 *
 * Reported against a shadow title-generation call, where a combo's first target rejects
 * `response_format` and the chain stops instead of trying the target behind it (#4903).
 *
 * The next target receives the SAME request, `response_format` included, so a target that can
 * honour the contract honours it and one that cannot is skipped in turn. Traversal stays finite
 * because combo excludes each attempted target and policy tries each candidate once.
 *
 * The envelope is bounded exactly like {@link isRequestLocalTargetIncompatibility}: an intact
 * provider JSON object, a depth budget, `type: "invalid_request_error"`, and a code from a
 * closed set. Nothing is inferred from echoed prompt text and no field is removed.
 */
function isResponseFormatCapabilityRefusal(
  status: number,
  message: string,
  code?: string | null,
): boolean {
  if (status !== 400 || message.length > 16_384) return false;
  if (!RESPONSE_FORMAT_REFUSAL_CODES.has(normalizedFailureCode(code))) return false;
  let text = message.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    if (text.startsWith("Provider error 400: ")) {
      text = text.slice("Provider error 400: ".length).trim();
    }
    // A chat gateway can report the refusal inside a single SSE frame, and the combo consumer
    // keeps the raw text when that frame stops the error object from being extracted -- which is
    // why the reported classification text reads `data: {"error":...}` and why the structured
    // code arrives undefined. Exactly one `data:` prefix is removed, and only when the body is
    // one line: this unwraps a single frame rather than parsing a stream, so a multi-event body
    // is left alone and still fails closed.
    if (text.startsWith("data:") && !text.includes("\n")) {
      text = text.slice("data:".length).trim();
    }
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { return false; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const error = (payload as Record<string, unknown>).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return false;
    const e = error as Record<string, unknown>;
    if (e.code !== undefined && e.code !== null && typeof e.code !== "string") return false;
    if (typeof e.message !== "string") return false;
    // Our own wrapper, re-wrapped by a downstream hop. Peel it and look again, within budget.
    if (e.message.startsWith("Provider error 400: ") && e.param === undefined) {
      text = e.message;
      continue;
    }
    if (e.type !== "invalid_request_error") return false;
    const errorCode = normalizedFailureCode(typeof e.code === "string" ? e.code : undefined);
    if (!RESPONSE_FORMAT_REFUSAL_CODES.has(errorCode)) return false;
    return namesResponseFormatIncapability(e.message, e.param);
  }
  return false;
}

export function comboFailureCooldownScope(
  status: number,
  message: string,
  options?: { code?: string | null },
): ComboFailureCooldownScope {
  const code = normalizedFailureCode(options?.code);
  // Request-shape refusals first: an oversized request must not cool a healthy target.
  // A native transport can surface a zero-output model overflow as a generic
  // upstream_server_error carrying precise context-window prose, so consult the bounded
  // message classifier too: that target is healthy, the turn was simply too large for it.
  if (
    status === 413
    || REQUEST_SHAPE_FAILURE_CODES.has(code)
    || isRequestLocalFreePromptCap(status, message, options?.code)
    || isProviderTargetContextOverflow(status, message, options?.code)
    || isDefiniteContextOverflow(status, message)
    || isRequestLocalTargetIncompatibility(status, message, options?.code)
    // A capability gap says the target is healthy and the request did not fit it, which is the
    // same reason every other entry here refuses to cool a target.
    || isResponseFormatCapabilityRefusal(status, message, options?.code)
  ) return "none";
  if (isProviderScopedQuotaCap(status, message, options?.code)) return "provider";
  // A rejected or unpaid credential is provider-wide evidence: every target that routes
  // through the same provider row carries the same key and will fail identically.
  if (status === 401 || status === 402 || status === 403) return "provider";
  if (PROVIDER_SCOPED_FAILURE_CODES.has(code)) return "provider";
  return "target";
}

function isModelLifecycleGone(
  status: number,
  message: string,
  code?: string | null,
): boolean {
  if (status !== 410) return false;
  const normalizedCode = code?.trim().toLowerCase().replaceAll("-", "_");
  if ([
    "model_deprecated",
    "model_end_of_life",
    "model_eol",
    "model_not_found",
    "model_retired",
  ].includes(normalizedCode ?? "")) return true;
  const text = message.toLowerCase();
  return /\bmodel\b/.test(text) && (
    /\bend[ -]of[ -]life\b/.test(text)
    || /\bno longer available\b/.test(text)
    || /\b(?:deprecated|retired|retirement|sunset|decommissioned)\b/.test(text)
  );
}

function isProviderTargetContextOverflow(
  status: number,
  message: string,
  code?: string | null,
): boolean {
  if (status !== 400) return false;
  const normalizedCode = normalizedFailureCode(code);
  const text = message.toLowerCase();
  if (text.includes("invalid_request_prompt_too_long")) return true;
  return normalizedCode === "5059"
    && /\bprompt\s+\d+\s*>\s*\d+\s+maximum context length\b/i.test(message);
}

/** A status can carry a verdict about the REQUEST; 401/403/429 speak about the credential. */
const CONTEXT_VERDICT_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

/**
 * Phrases a provider emits when the INPUT does not fit this model's context window. Matched
 * against the innermost provider message only, so an unrelated refusal that merely quotes one
 * of these tokens in a code field cannot authorize a replay.
 */
const DEFINITE_CONTEXT_OVERFLOW_PHRASES = [
  "exceeds the context window",
  "exceed the context window",
  "context window exceeded",
  "context length exceeded",
  "maximum context length",
  "maximum context window",
  "too many tokens",
];

/** Wrapper envelopes unwrapped before the leaf message is read. */
const MAX_CONTEXT_OVERFLOW_ENVELOPES = 4;

function isDefiniteContextOverflowMessage(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized === "context_length_exceeded"
    || DEFINITE_CONTEXT_OVERFLOW_PHRASES.some(phrase => normalized.includes(phrase));
}

/**
 * Confirm a context overflow from the provider MESSAGE rather than from a code token that
 * merely appears somewhere in the envelope. An upstream controls both fields and can emit a
 * contradictory pair -- `context_length_exceeded` beside `Unsupported parameter: user` -- and
 * that is not evidence the turn is too large for this model. `classifyError` reads the whole
 * blob, which is exactly the looseness this must not inherit.
 *
 * A JSON-shaped body that fails to parse is truncated or corrupt, not prose: `classificationText`
 * is capped at 500 characters by `normalizeUpstreamErrorText` before it reaches this function, so
 * a long envelope arrives here as a JSON prefix. Reading that prefix as plain text would let an
 * arbitrary field that happens to sit in the first 500 bytes authorize a hop, so it fails closed.
 *
 * Only the exact proxy wrapper is unwrapped, within a fixed envelope budget and 16,384 characters.
 */
function isDefiniteContextOverflow(status: number, message: string): boolean {
  if (!CONTEXT_VERDICT_STATUSES.has(status) && status < 500) return false;
  if (message.length > 16_384) return false;
  let text = message.trim();
  // One pass per unwrapped envelope, plus one for the leaf the last envelope yields.
  for (let unwrapped = 0; unwrapped <= MAX_CONTEXT_OVERFLOW_ENVELOPES; unwrapped += 1) {
    const providerPrefix = /^Provider error \d{3}:\s*/.exec(text);
    if (providerPrefix) text = text.slice(providerPrefix[0].length).trim();
    if (!text.startsWith("{")) return isDefiniteContextOverflowMessage(text);
    if (unwrapped === MAX_CONTEXT_OVERFLOW_ENVELOPES) return false;
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { return false; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const record = payload as Record<string, unknown>;
    const response = record.response && typeof record.response === "object" && !Array.isArray(record.response)
      ? record.response as Record<string, unknown>
      : undefined;
    const source = [record.error, response?.error, response?.last_error, record.last_error, record]
      .find((candidate): candidate is Record<string, unknown> =>
        !!candidate && typeof candidate === "object" && !Array.isArray(candidate)
        && typeof (candidate as Record<string, unknown>).message === "string");
    if (!source) return false;
    text = (source.message as string).trim();
  }
  return false;
}

export function comboFailureDecision(
  status: number,
  message: string,
  options?: { code?: string | null },
): ComboFailureDecision {
  if (status === 499) return "stop";
  if (message.toLowerCase().includes("origin_rejected")) return "stop";
  // Structured form of the same hard refusal. The prose test above misses it when the origin
  // reports the code out of band, and every hop rule below -- including the context-overflow
  // one -- must stay subordinate to it.
  if (normalizedFailureCode(options?.code) === "origin_rejected") return "stop";
  // The origin may already be executing this turn (the Codex WebSocket relay sent the create
  // frame and never saw a response event). Hopping would send the same request to a second
  // target while the first may still be generating; the honest status goes to the client.
  if (isNonReplayableUpstreamCode(options?.code)) return "stop";
  // Cyber policy is a hard non-retryable refusal — honor structured code even when
  // classificationText was truncated before the JSON code field.
  if (isCyberPolicyCode(options?.code)) return "stop";
  // HTTP 410 is normally terminal. A model-specific lifecycle verdict is target-local,
  // however: another provider/model in the declared combo can still serve the request.
  // Require structured lifecycle code or explicit model+lifecycle prose so unrelated
  // application-level 410 responses remain fail-closed.
  if (isModelLifecycleGone(status, message, options?.code)) return "hop";
  const error = classifyError(status, "upstream_error", message);
  if (isCyberPolicyCode(error.code)) return "stop";
  // A provider can expose its own target hard cap with a non-semantic vendor code
  // (for example 5059 + invalid_request_prompt_too_long). That is evidence that this
  // target is too small, not that every later combo target is incapable of serving it.
  if (isProviderTargetContextOverflow(status, message, options?.code)) return "hop";
  // A definite context-window refusal is target-local inside a heterogeneous combo: this model
  // cannot hold the turn, but a later target may have a larger window. Two boundaries keep this
  // safe. It is reached only after cancellation, structured origin/cyber refusals and
  // non-replayable post-send codes have already stopped. And it only ever classifies a failure
  // the combo stream preflight already proved emitted no output: `comboStreamPayloadCommitsOutput`
  // commits the child on any text, tool call or unknown event, and only a zero-output terminal
  // becomes a failure response at all, so a turn whose text the client already saw is never
  // reclassified here.
  if (isDefiniteContextOverflow(status, message)) return "hop";
  // A local input-admission refusal (#1524) says "this candidate cannot fit the request",
  // not "the request is impossible": the next candidate may have a larger context window.
  //
  // This MUST be tested before the generic stop list below. Our own refusal message says
  // "context window" -- that is what it refuses on -- and the classifier remaps that phrase,
  // so checking the stop list first swallowed the signal and ended the chain. An UPSTREAM
  // `context_length_exceeded` carries no admission code and still falls through to stop.
  //
  // Matched on the STRUCTURED code only, which classifyError now preserves for our own
  // refusal. A raw substring test would additionally let any upstream override a terminal
  // verdict by echoing the token in prose we do not control.
  //
  // Precise about what this is NOT: an upstream can still SET this code deliberately, since
  // both extractors read the upstream error object. That is bounded rather than dangerous --
  // an upstream already controls other hop signals (429, 5xx), and traversal is finite: policy
  // tries each candidate once via `tried`, and combo excludes each attempted target. So this is
  // structured-code-only, not provably local.
  if (options?.code === "input_admission_refused" || error.code === "input_admission_refused") {
    return "hop";
  }
  if (isProviderScopedQuotaCap(status, message, options?.code || error.code)) {
    return "hop";
  }
  // A model-scoped rejection is target-local: this provider does not serve THIS model, which
  // says nothing about the next combo target. Structured code only, plus the explicit prose
  // form upstreams emit when they carry no code, so an unrelated 400 stays terminal.
  const failureCode = normalizedFailureCode(options?.code || error.code);
  if (["model_not_found", "model_unavailable", "unsupported_model"].includes(failureCode)) {
    return "hop";
  }
  // `free_rate_limited` no longer routes through `isProviderScopedQuotaCap` (it is a
  // per-request cap, not provider-wide evidence), so keep its hop verdict explicit here.
  if (failureCode === "free_rate_limited") return "hop";
  if (isRequestLocalTargetIncompatibility(status, message, options?.code)) return "hop";
  // Must precede the generic `invalid_request_error` stop below, which is where this refusal
  // ended the chain: the gateway reports `type: "invalid_request_error"`, so the classifier
  // reaches that list and returns terminal before anything can ask whether the next target
  // could have served the request (#4903).
  if (isResponseFormatCapabilityRefusal(status, message, options?.code)) return "hop";
  if (["origin_rejected", "context_length_exceeded", "invalid_request_error"].includes(error.code ?? "")) {
    return "stop";
  }
  // 402 (payment required) and 425 (too early) are provider-state signals, not verdicts about
  // the request: another combo target can still serve it.
  if ([401, 402, 403, 404, 408, 425, 429].includes(status) || status >= 500) return "hop";
  if ([
    "permission_denied",
    "subscription_required",
    "invalid_api_key",
    "insufficient_quota",
    "payment_required",
    "billing_error",
    "insufficient_balance",
    "rate_limit_exceeded",
    "server_is_overloaded",
    "upstream_server_error",
  ].includes(error.code ?? "")) {
    return "hop";
  }
  return "stop";
}
