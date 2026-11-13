import { parseResetCooldownMs } from "../codex/routing";
import { CYBER_POLICY_FALLBACK_MESSAGE, TERMINAL_REFUSAL_FALLBACK_MESSAGE, classifyError, isCyberPolicyCode, isCyberPolicyMessage, isRateLimitOrQuotaFailureMessage, isSubscriptionGateMessage, isTerminalRefusalCode, safetyRefusalCodeFromMessage } from "../lib/errors";
import { isHardPolicyOrOriginRefusal } from "../lib/hard-refusal";
import { isNonReplayableUpstreamCode } from "../lib/upstream-retry";
import { isAnthropicBillingFailure } from "../providers/anthropic-billing-refusal";
import { hasConflictingReasoningEffortCode } from "../providers/reasoning-metadata";
import { isKiroAccountProfileRefusal } from "../adapters/kiro-refusal";
import type { OcxComboTarget } from "../types";
import { targetKey } from "./types";
import { PersistedCooldownMap } from "./cooldown-store";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import { isDefiniteContextOverflow } from "../lib/context-overflow-verdict";

// The verdict lives in a dependency-free leaf so the presentation classifier can share it.
export { isDefiniteContextOverflow };
import {
  captureConfigGeneration,
  sweepExpiredOnWrite,
  type GenerationContext,
} from "../lib/state-store-sweeper";

interface TargetCooldown {
  cooldownUntil: number;
  revision: number;
  status?: number;
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
// Never reset: an in-flight reservation may still refer to an entry cleared from the map.
let nextCooldownRevision = 0;
// Disk-backed (combo-cooldowns.json): a restart keeps every live, reset-aware cooldown.
const targetCooldowns = new PersistedCooldownMap<TargetCooldown>(() => ++nextCooldownRevision);
registerOptionalShutdownHook("combo-target-cooldowns", () => targetCooldowns.flushForShutdown());
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
    targetCooldowns.dropLocal(key);
    return false;
  }
  return true;
}

/** The live cooldown expiry for one target, or undefined once it is absent or elapsed. */
export function comboTargetCooldownExpiry(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  now = Date.now(),
): number | undefined {
  const key = cooldownMapKey(comboId, target);
  const entry = targetCooldowns.get(key);
  if (!entry) return undefined;
  if (entry.cooldownUntil <= now) {
    targetCooldowns.dropLocal(key);
    return undefined;
  }
  return entry.cooldownUntil;
}

/** Identity of the current live write, independent of its possibly repeated expiry. */
export function comboTargetCooldownRevision(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  now = Date.now(),
): number | undefined {
  return isComboTargetInCooldown(comboId, target, now)
    ? targetCooldowns.get(cooldownMapKey(comboId, target))?.revision : undefined;
}

/** Lift only the reserved write; a replacement with even the same expiry survives. */
export function clearComboTargetCooldownIfUnchanged(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  expectedRevision: number,
): void {
  const key = cooldownMapKey(comboId, target);
  if (targetCooldowns.get(key)?.revision === expectedRevision) targetCooldowns.dropLocal(key);
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
      targetCooldowns.dropLocal(key);
      continue;
    }
    if (soonest === undefined || remaining < soonest) soonest = remaining;
  }
  return soonest;
}

/** Snapshot active quota cooldowns without inspecting request eligibility or changing state. */
export function snapshotComboQuotaCooldowns<T extends Pick<OcxComboTarget, "provider" | "model">>(
  comboId: string,
  targets: Iterable<T>,
  now = Date.now(),
): Array<{ target: T; cooldownUntil: number }> {
  const snapshot: Array<{ target: T; cooldownUntil: number }> = [];
  for (const target of targets) {
    const key = cooldownMapKey(comboId, target);
    const cooldown = targetCooldowns.get(key);
    if (!cooldown || cooldown.cooldownUntil <= now) continue;
    if (cooldown.status !== 429 && cooldown.status !== 402) continue;
    snapshot.push({ target, cooldownUntil: cooldown.cooldownUntil });
  }
  return snapshot;
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
    ?? (isAccountWindowExhausted(options?.message ?? "", options?.code, options?.status)
      || PROVIDER_SCOPED_FAILURE_CODES.has(normalizedFailureCode(options?.code))
      ? MAX_COOLDOWN_MS
      : isTransientRequestRateLimit({
        status: options?.status,
        code: options?.code,
        message: options?.message,
      }) ? COMBO_REQUEST_RATE_COOLDOWN_MS : DEFAULT_COOLDOWN_MS);
  targetCooldowns.set(cooldownMapKey(comboId, target), {
    revision: ++nextCooldownRevision,
    // Local fallbacks are capped at ten minutes; explicit server delays at one day.
    cooldownUntil: now + (serverDelayMs ?? Math.min(Math.max(cooldownMs, 1), MAX_COOLDOWN_MS)),
    status: options?.status,
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
    targetCooldowns.dropLocal(key);
    removed += 1;
  }
  return removed;
}

/** Clear all cooldowns, one combo, or only the supplied target keys within that combo. */
export function clearComboTargetCooldowns(comboId?: string, targetKeys?: Iterable<string>): void {
  if (comboId === undefined) {
    targetCooldowns.clearAllPersisted();
    liveComboTargets.clear();
    lastReconciledGeneration = 0;
    return;
  }
  const prefix = `${comboId}\0`;
  if (targetKeys !== undefined) {
    targetCooldowns.clearPersisted([...targetKeys].map(key => `${prefix}${key}`));
    return;
  }
  targetCooldowns.clearPrefixPersisted(prefix);
}

export type ComboFailureDecision = "hop" | "stop";
export type ComboFailureCooldownScope = "none" | "target" | "provider";

function normalizedFailureCode(code?: string | number | null): string {
  if (typeof code === "number") return Number.isFinite(code) ? String(code) : "";
  return code?.trim().toLowerCase().replaceAll("-", "_") ?? "";
}

/** Parse one bounded error body or single SSE data frame into its root record. */
function parseErrorEnvelope(message: string): Record<string, unknown> | undefined {
  if (message.length > 16_384) return undefined;
  let text = message.trim();
  const proxyPrefix = /^Provider error \d{3}: /.exec(text);
  if (proxyPrefix) text = text.slice(proxyPrefix[0].length).trim();
  if (text.startsWith("data:") && !text.includes("\n")) text = text.slice("data:".length).trim();
  try {
    const payload: unknown = JSON.parse(text);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    return payload as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * The one error record an envelope carries: its own `error`, else the root when that root states
 * the failure itself. HTTP consumption and the SSE preflight both select through here so the two
 * transports cannot disagree about which record speaks.
 *
 * A `response.error` alone is deliberately not a carrier here. Under a bare frame it is not an
 * error event at all, so reading it on HTTP only made the same envelope hop on one transport and
 * stop on the other; leaving it unread is the behavior both transports had.
 */
export function envelopeErrorRecord(root: Record<string, unknown>): Record<string, unknown> | undefined {
  const error = root.error;
  if (error !== null && typeof error === "object" && !Array.isArray(error)) {
    const record = { ...(error as Record<string, unknown>) };
    if (typeof record.detail !== "string" && typeof root.detail === "string") {
      record.detail = root.detail;
    }
    return record;
  }
  if (typeof root.message === "string" || typeof root.detail === "string") {
    return root;
  }
  return undefined;
}

/** Parse one bounded error record from an HTTP 400 body or a single SSE data frame. */
export function http400ErrorRecord(message: string): Record<string, unknown> | undefined {
  const root = parseErrorEnvelope(message);
  return root ? envelopeErrorRecord(root) : undefined;
}

/** A record's own structured code as a string; blank, absent and non-finite values state none. */
export function envelopeRecordCode(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  const code = record.code;
  if (typeof code === "number") {
    return Number.isFinite(code) ? String(code) : undefined;
  }
  return typeof code === "string" && code.trim() !== "" ? code : undefined;
}

/**
 * The envelope root's own structured code, when it states one beside a nested record.
 *
 * The nested record is what normalization selects for display and classification, so this is
 * the only place a root verdict survives. Numeric codes are stringified the way the decision
 * normalizes them. An absent, empty or whitespace-only code is no verdict at all.
 */
export function upstreamEnvelopeRootCode(message: string): string | undefined {
  return envelopeRecordCode(parseErrorEnvelope(message));
}

/** Check whether a parsed error record or raw diagnostic text represents a malformed response_format. */
export function isMalformedResponseFormatRecord(record?: Record<string, unknown>, rawText?: string): boolean {
  const fields = record
    ? [record.message, record.detail].filter((value): value is string => typeof value === "string")
    : [];
  if (rawText) fields.push(rawText);
  return fields.some(detail =>
    /\binvalid schema(?: for)? response_format\b/i.test(detail)
    || /\bresponse_format(?:\.[a-z_]+)*\s+must be (?:one of|valid|a valid)\b/i.test(detail));
}

/** Identify known malformed structured-output diagnostics that must remain terminal. */
export function isMalformedResponseFormatRequest(status: number, message: string): boolean {
  if (status !== 400) return false;
  return isMalformedResponseFormatRecord(http400ErrorRecord(message), message);
}

/** Check whether a parsed error record matches OpenRouter's uncoded numeric-400 opaque wrapper. */
export function isOpenRouterOpaque400Record(record?: Record<string, unknown>): boolean {
  if (!record) return false;
  const metadata = record.metadata;
  const errorType = record.type === "error" ? undefined : record.type;
  return record.message === "Provider returned error"
    && (record.code === 400 || record.code === "400")
    && errorType === undefined
    && metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
    && (metadata as Record<string, unknown>).raw === "ERROR";
}

/** Recognize OpenRouter's uncoded numeric-400 wrapper for an opaque provider failure. */
export function isOpenRouterOpaque400Envelope(message: string): boolean {
  const root = parseErrorEnvelope(message);
  return !!root && isOpenRouterOpaque400EnvelopeRoot(root);
}

/**
 * The same verdict for an already parsed envelope root, which is what the SSE preflight holds.
 * Both transports entering here is what keeps their answers equal.
 */
export function isOpenRouterOpaque400EnvelopeRoot(root: Record<string, unknown>): boolean {
  return isOpenRouterOpaque400Record(envelopeErrorRecord(root)) && !envelopeRootStatesVerdict(root);
}

/**
 * Root codes that state a request verdict of their own, so the record beside them does not
 * speak for the envelope.
 *
 * Membership is a correctness question, not a formatting one: an equality test against `"400"`
 * made every other root code -- including a blank one and the codes that are ordinary combo hop
 * signals -- suppress the opaque verdict, so HTTP stopped on failures SSE advanced past. Each
 * entry here is a code `comboFailureDecision` reaches its terminal arms with when read alone.
 * Content refusals are the shared {@link isTerminalRefusalCode} set; the post-send codes are the
 * ones {@link isNonReplayableUpstreamCode} owns; the rest are the generic request verdicts and the
 * origin's own refusal.
 */
const ROOT_VERDICT_CODES = new Set([
  "origin_rejected",
  "content_policy_violation",
  "context_length_exceeded",
  "invalid_request_error",
  "client_closed_request",
  "client_cancelled",
]);

/** A root code that is itself a hard stop or terminal request verdict; blank means "no verdict". */
function rootCodeStatesVerdict(code: string): boolean {
  const normalized = normalizedFailureCode(code);
  return ROOT_VERDICT_CODES.has(normalized)
    || isTerminalRefusalCode(normalized)
    || isNonReplayableUpstreamCode(normalized);
}

/**
 * Does the envelope root name its own verdict? A non-`"error"` type and any terminal root code do;
 * a blank, absent, numeric-`400` or hop-signal code does not, so the nested record keeps speaking.
 */
function envelopeRootStatesVerdict(root: Record<string, unknown>): boolean {
  const { type } = root;
  if (type !== undefined && type !== null && type !== "error") return true;
  const code = envelopeRecordCode(root);
  return code !== undefined && rootCodeStatesVerdict(code);
}

/** Check whether an uncoded numeric 400 is an opaque OpenRouter failure that may safely advance without cooling. */
function isUncodedUpstream400(
  status: number,
  message: string,
  code?: string | number | null,
  options?: {
    malformedResponseFormat?: boolean;
    openRouterOpaque400?: boolean;
  },
): boolean {
  const normalized = normalizedFailureCode(code);
  if (status !== 400 || (normalized !== "" && normalized !== "400")) return false;
  const malformed = options?.malformedResponseFormat !== undefined
    ? options.malformedResponseFormat
    : isMalformedResponseFormatRequest(status, message);
  if (malformed) return false;
  return options?.openRouterOpaque400 !== undefined
    ? options.openRouterOpaque400
    : isOpenRouterOpaque400Envelope(message);
}

/**
 * xAI can reject a model/account effort rung with this exact vendor envelope. It is target-local
 * evidence for a combo: the same model may accept a lower rung, or a later target may accept the
 * request. Keep the match exact so unrelated invalid arguments stay terminal.
 */
const EXACT_EFFORT_COMPATIBLE_CODES = new Set(["", "invalid_request_error", "invalid_argument"]);
const EXACT_EFFORT_COMPATIBLE_TYPES = new Set(["", "invalid_request_error", "upstream_error"]);

function hasIncompatibleDiagnosticCarrier(val: unknown, depth = 0): boolean {
  if (val === undefined || val === null) return false;
  if (depth > 8) return true;
  if (Array.isArray(val)) {
    if (val.length > 32) return true;
    for (const item of val) {
      if (hasIncompatibleDiagnosticCarrier(item, depth + 1)) return true;
    }
    return false;
  }
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (parsed && typeof parsed === "object") {
        return hasIncompatibleDiagnosticCarrier(parsed, depth + 1);
      }
      return true;
    } catch {
      return true;
    }
  }
  if (typeof val === "object") {
    const rec = val as Record<string, unknown>;
    if (rec.param !== undefined && rec.param !== null) {
      if (typeof rec.param !== "string") return true;
      const param = rec.param.trim().toLowerCase();
      if (param.length > 0 && param !== "reasoning_effort" && param !== "reasoning.effort") return true;
    }
    if (rec.code !== undefined && rec.code !== null) {
      if (typeof rec.code !== "string") return true;
      if (!EXACT_EFFORT_COMPATIBLE_CODES.has(normalizedFailureCode(rec.code))) return true;
    }
    if (rec.type !== undefined && rec.type !== null) {
      if (typeof rec.type !== "string") return true;
      if (!EXACT_EFFORT_COMPATIBLE_TYPES.has(normalizedFailureCode(rec.type))) return true;
    }
    if (rec.error !== undefined && rec.error !== null) {
      if (hasIncompatibleDiagnosticCarrier(rec.error, depth + 1)) return true;
    }
    if (rec.response !== undefined && rec.response !== null) {
      if (hasIncompatibleDiagnosticCarrier(rec.response, depth + 1)) return true;
    }
    if (rec.last_error !== undefined && rec.last_error !== null) {
      if (hasIncompatibleDiagnosticCarrier(rec.last_error, depth + 1)) return true;
    }
    if (rec.details !== undefined && rec.details !== null) {
      if (hasIncompatibleDiagnosticCarrier(rec.details, depth + 1)) return true;
    }
    if (rec.detail !== undefined && rec.detail !== null) {
      if (hasIncompatibleDiagnosticCarrier(rec.detail, depth + 1)) return true;
    }
    if (rec.errors !== undefined && rec.errors !== null) {
      if (hasIncompatibleDiagnosticCarrier(rec.errors, depth + 1)) return true;
    }
    if (rec.message !== undefined && rec.message !== null) {
      if (typeof rec.message !== "string" || rec.message !== "Invalid reasoning effort.") return true;
    }
    return false;
  }
  return false;
}

function isExactInvalidReasoningEffortRefusal(status: number, message: string, code?: string | null): boolean {
  if (status !== 400 || message.length > 16_384) return false;
  if (code !== undefined && code !== null && typeof code !== "string") return false;
  const outerCode = normalizedFailureCode(code);
  if (!EXACT_EFFORT_COMPATIBLE_CODES.has(outerCode)) return false;
  if (isHardPolicyOrOriginRefusal(message) || hasConflictingReasoningEffortCode(message)) return false;
  let text = message.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    if (text.startsWith("Provider error 400: ")) text = text.slice("Provider error 400: ".length).trim();
    if (text.startsWith("data:") && !text.includes("\n")) text = text.slice("data:".length).trim();
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { return false; };
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const root = payload as Record<string, unknown>;
    if (root.code !== undefined && root.code !== null && typeof root.code !== "string") return false;
    if (root.type !== undefined && root.type !== null && typeof root.type !== "string") return false;
    if (root.message !== undefined && root.message !== null && typeof root.message !== "string") return false;
    if (root.param !== undefined && root.param !== null) {
      if (typeof root.param !== "string") return false;
      const param = root.param.trim().toLowerCase();
      if (param !== "reasoning_effort" && param !== "reasoning.effort") return false;
    }
    const rootCode = normalizedFailureCode(root.code as string | undefined);
    const rootType = normalizedFailureCode(root.type as string | undefined);
    if (!EXACT_EFFORT_COMPATIBLE_CODES.has(rootCode)) return false;
    if (!EXACT_EFFORT_COMPATIBLE_TYPES.has(rootType)) return false;
    if (root.response !== undefined && root.response !== null) return false;
    if (root.last_error !== undefined && root.last_error !== null) return false;
    if (hasIncompatibleDiagnosticCarrier(root.details)) return false;
    if (hasIncompatibleDiagnosticCarrier(root.detail)) return false;
    if (hasIncompatibleDiagnosticCarrier(root.errors)) return false;
    if (rootCode === "invalid_argument"
      && root.error === "Invalid reasoning effort."
      && (root.type === undefined || root.type === "invalid_request_error")
      && (root.param === undefined || root.param === "reasoning_effort" || root.param === "reasoning.effort")) {
      if (root.message !== undefined && root.message !== null && root.message !== "Invalid reasoning effort.") return false;
      return true;
    }
    const error = root.error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return false;
    const record = error as Record<string, unknown>;
    if (record.code !== undefined && record.code !== null && typeof record.code !== "string") return false;
    if (record.type !== undefined && record.type !== null && typeof record.type !== "string") return false;
    if (record.message !== undefined && record.message !== null && typeof record.message !== "string") return false;
    if (record.error !== undefined && record.error !== null && typeof record.error !== "string") return false;
    if (record.param !== undefined && record.param !== null) {
      if (typeof record.param !== "string") return false;
      const param = record.param.trim().toLowerCase();
      if (param !== "reasoning_effort" && param !== "reasoning.effort") return false;
    }
    if (root.param !== undefined && root.param !== null && record.param !== undefined && record.param !== null) {
      if (root.param.trim().toLowerCase() !== record.param.trim().toLowerCase()) return false;
    }
    const errorCode = normalizedFailureCode(record.code as string | undefined);
    const errorType = normalizedFailureCode(record.type as string | undefined);
    if (!EXACT_EFFORT_COMPATIBLE_CODES.has(errorCode)) return false;
    if (!EXACT_EFFORT_COMPATIBLE_TYPES.has(errorType)) return false;
    if (record.response !== undefined && record.response !== null) return false;
    if (record.last_error !== undefined && record.last_error !== null) return false;
    if (hasIncompatibleDiagnosticCarrier(record.details)) return false;
    if (hasIncompatibleDiagnosticCarrier(record.detail)) return false;
    if (hasIncompatibleDiagnosticCarrier(record.errors)) return false;
    if (record.type === "upstream_error" && typeof record.message === "string"
      && record.message.startsWith("Provider error 400: ")
      && EXACT_EFFORT_COMPATIBLE_CODES.has(errorCode)) {
      text = record.message;
      continue;
    }
    if (root.type === "upstream_error" && typeof root.message === "string"
      && root.message.startsWith("Provider error 400: ")
      && EXACT_EFFORT_COMPATIBLE_CODES.has(rootCode)) {
      text = root.message;
      continue;
    }
    if (root.message !== undefined && root.message !== null && root.message !== "Invalid reasoning effort.") return false;
    if (record.error !== undefined && record.error !== null && record.error !== "Invalid reasoning effort.") return false;
    return record.type === "invalid_request_error"
      && record.message === "Invalid reasoning effort."
      && EXACT_EFFORT_COMPATIBLE_CODES.has(errorCode)
      && (record.param === undefined || record.param === "reasoning_effort" || record.param === "reasoning.effort");
  }
  return false;
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
// Token-plan windows (Alibaba's DeepSeek/Qwen plans) report "Your token-plan 1-week quota has been
// exhausted" (#5494). The match is anchored to that phrasing: a looser "quota ... exhausted" would
// also catch per-minute limits, and this arm outranks the transient rate-limit duration.
const ACCOUNT_EXHAUSTION_TEXT = /usage limit (?:has been )?reached|token-plan\s+\S+\s+quota has been exhausted|(?:account|weekly|monthly|daily)\s*(?:usage\s+)?quota (?:(?:has been |is )?exhausted|exceeded)/i;

/**
 * Determines whether an error signals that an account's quota or usage window has been exhausted.
 *
 * Explicit error codes (`usage_limit_exceeded`, `insufficient_quota`, etc.) are always authoritative.
 * For HTTP 400 (Bad Request), prose alone is not authoritative because client validation errors
 * may echo prompt contents or parameter values containing quota-related words.
 *
 * @param message The error message text.
 * @param code The normalized or raw error code.
 * @param status The HTTP status code, if known.
 * @returns True if the failure represents an account window exhaustion.
 */
function isAccountWindowExhausted(
  message: string,
  code?: string | null,
  status?: number,
): boolean {
  const normalized = normalizedFailureCode(code);
  if (ACCOUNT_EXHAUSTION_CODES.has(normalized) || normalized === "insufficient_quota") {
    return true;
  }
  // On HTTP 400 (Bad Request / parameter validation), prose alone is not authoritative evidence
  // of account quota exhaustion because validation errors may echo user prompts or parameter values
  // quoting "quota exhausted". An authoritative account exhaustion verdict on 400 requires a
  // structured exhaustion code.
  if (status === 400 || status === 422) {
    return false;
  }
  return ACCOUNT_EXHAUSTION_TEXT.test(message.toLowerCase());
}

function isProviderScopedQuotaCap(
  status: number | undefined,
  message: string,
  code?: string | null,
): boolean {
  if (status === 400 || status === 422) return false; // Validation prose may reflect the caller's input.
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

/** A structured account-window exhaustion code; prose never qualifies (a request can echo it). */
function hasAccountExhaustionCode(code?: string | null): boolean {
  const normalized = normalizedFailureCode(code);
  return ACCOUNT_EXHAUSTION_CODES.has(normalized) || normalized === "insufficient_quota";
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
  if (status !== 400 && status !== 422) return false;
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
  // A route that cannot read the request's media (image input to a text-only CLI route) is
  // healthy for every other request, so cooling it would only block unrelated turns.
  "unsupported_input_modality",
  // A request whose token cap was reached before output was produced is request-specific;
  // the candidate remains healthy for subsequent requests with larger limits.
  "zero_output_token_limit",
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
  if (isExactInvalidReasoningEffortRefusal(status, message, code)) return true;
  if (status !== 400 || message.length > 16_384) return false;
  const genericCodes = new Set(["", "invalid_request_error", "unsupported_parameter", "unsupported_value"]);
  if (!genericCodes.has(normalizedFailureCode(code))) return false;
  let text = message.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    if (text.startsWith("Provider error 400: ")) text = text.slice("Provider error 400: ".length);
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { return false; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const root = payload as Record<string, unknown>;
    if (root.code !== undefined && root.code !== null && typeof root.code !== "string") return false;
    if (root.type !== undefined && root.type !== null && typeof root.type !== "string") return false;
    if (root.param !== undefined && root.param !== null && typeof root.param !== "string") return false;
    const rootCode = normalizedFailureCode(root.code as string | undefined);
    if (!genericCodes.has(rootCode)) return false;
    if (root.type !== undefined && root.type !== null && root.type !== "invalid_request_error" && root.type !== "upstream_error") return false;
    const error = root.error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return false;
    const e = error as Record<string, unknown>;
    if (e.code !== undefined && e.code !== null && typeof e.code !== "string") return false;
    if (root.param !== undefined && root.param !== null && typeof e.param === "string") {
      if (root.param.trim().toLowerCase() !== e.param.trim().toLowerCase()) return false;
    }
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

/** The classification text the combo path bounds a body to (src/server/responses/core-errors.ts). */
const MODERATION_EVIDENCE_LIMIT = 500;

/** The structured codes that state a provider or gateway moderation verdict. */
const MODERATION_REFUSAL_CODES = new Set(["moderation_refusal", "content_filter"]);

/**
 * Every other code or type a moderation refusal body may carry. Anything outside this list, at any
 * depth, is evidence of something else and the body keeps dev's decision: the hop is granted only
 * to bodies whose structured fields all agree that this is a moderation refusal.
 */
const MODERATION_COMPATIBLE_VALUES = new Set([
  ...MODERATION_REFUSAL_CODES,
  "invalid_request_error", "error", "ai_apicallerror", "responsibleaipolicyviolation", "400", "422",
]);

/** Keys whose values are structured verdicts; folded (lowercase, underscores and hyphens removed). */
const MODERATION_VERDICT_KEYS = new Set(["code", "type", "errorcode", "errortype", "reason"]);

/** Fold a key for comparison: lowercase, underscores and hyphens removed. */
function foldKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

/** Keys that state an HTTP status; any stated status other than 400/422 is evidence of its own. */
const MODERATION_STATUS_KEYS = new Set(["status", "statuscode", "httpstatus", "httpstatuscode"]);

/** Identifier fields a refusal envelope may carry: a bare token or number, never prose. */
const MODERATION_ID_KEYS = new Set(["id", "requestid", "object", "model", "name", "sequencenumber", "createdat"]);

/**
 * Keys a gateway's routing metadata (providerMetadata) must not use: a field that names a state,
 * status, code or safety verdict is evidence of its own, so only plain routing tokens pass.
 */
const ROUTING_METADATA_EVIDENCE_KEY = /safety|violation|block|polic|account|suspend|disabl|deactivat|ban|status|state|error|code|reason|quota|billing|limit|credit|payment/i;

/**
 * Azure's per-category filter results: the moderation verdict's own detail. Only its own shape
 * passes: category objects of flags and numbers, a `severity` of safe/low/medium/high, bare
 * `id`/`url`/`license` tokens, and compatible codes. Any other text, or a key that names a
 * state, status, error or message, is evidence of its own.
 */
const MODERATION_RESULT_KEY = /^(?:contentfilterresults?|promptfilterresults)$/;
const FILTER_RESULT_EVIDENCE_KEY = /account|status|state|quota|billing|payment|credit|limit|error|message|reason|note|description|detail(?!s$)/i;

/**
 * Response-object fields of a Responses terminal event (`response.failed`) that echo the caller's
 * request or report usage. They say nothing about the failure and are not read.
 */
const RESPONSE_REQUEST_ECHO_KEYS = new Set([
  "instructions", "tools", "toolchoice", "text", "reasoning", "input", "output", "prompt", "include",
  "user", "safetyidentifier", "promptcachekey", "promptcacheretention", "previousresponseid", "conversation",
  "temperature", "topp", "toplogprobs", "maxoutputtokens", "maxtoolcalls", "paralleltoolcalls", "truncation",
  "store", "servicetier", "background", "usage",
]);

/**
 * The whole prose a moderation refusal may carry, after whitespace is collapsed: one verdict
 * sentence (the gateway's own refusal copy, OpenAI's and Azure's included), optionally followed by
 * the category list, the advice to change the prompt and retry, and Azure's documentation pointer.
 * Any other wording (an account, model, parameter or billing problem, in any phrasing) does not
 * match, so the body keeps dev's decision; only known shapes are admitted.
 */
const MODERATION_REFUSAL_PROSE = new RegExp("^(?:"
  + "(?:content )?(?:refused|flagged|blocked|rejected|filtered)(?: by (?:the )?(?:moderation|content filter))?\\.?"
  + "|(?:(?:the|your) )?(?:input|request|prompt|content|message|response|output)(?: (?:was|has been|is))?"
  + " (?:refused|flagged|blocked|rejected|filtered)(?: by (?:the )?(?:moderation|content filter)(?: system)?)?\\.?"
  + "|the response was filtered due to the prompt triggering azure openai'?s content management policy\\.?"
  + "|(?:your )?(?:input|request|prompt|content) violated (?:the )?content (?:safety|management|filtering) polic(?:y|ies)\\.?"
  + ")(?:"
  + " categor(?:y|ies): [a-z][a-z/_-]*(?:(?:,? and |, )[a-z][a-z/_-]*)*\\.?"
  + "| please (?:modify|revise|rephrase|change|adjust|edit) (?:your|the) (?:prompt|input|request|message)(?: and (?:retry|try again))?\\.?"
  + "| (?:please )?(?:retry|try again)(?: later)?\\.?"
  + "| to learn more about our content filtering policies please read our documentation: https://[^ ]+"
  + ")*$", "i");

/** Whether a prose string is a known moderation refusal copy and nothing else (bounded, linear). */
function isModerationRefusalProse(text: string): boolean {
  if (text.length > 2_000) return false;
  return MODERATION_REFUSAL_PROSE.test(text.replace(/\s+/g, " ").trim());
}

/**
 * Safety-system wording in any of its upstream phrasings ("rejected as a result of our safety
 * system", "for safety reasons", "considered high risk"). A safety refusal is the upstream's own
 * terminal verdict, broader than the exact copies safetyRefusalCodeFromMessage names.
 */
const SAFETY_SYSTEM_WORDING = /\bsafety[\s_-]+(?:systems?|reasons?)\b|\bhigh[\s_-]+risk\b/i;

/** Billing, quota and account-state wording: evidence about the provider, not about the prompt. */
const PROVIDER_STATE_WORDING =
  /\bcredit[\s_-]+balance\b|\bquota\b|\bbilling\b|\bpayment[\s_-]+required\b|\binsufficient[\s_-]+(?:quota|balance|funds|credits?)\b|\b(?:account|organi[sz]ation|api[\s_-]*key)\b[^.]{0,40}?\b(?:suspended|disabled|deactivated|banned|inactive|not[\s_-]+active)\b|\brate[\s_-]+limit/i;

/** A refusal names the prompt or input it refused; any other `param` is a validation error. */
function isAllowedModerationParam(param: string): boolean {
  const p = param.trim().toLowerCase();
  return p === "prompt" || p === "input" || p === "messages"
    || p.startsWith("input[") || p.startsWith("input.") || p.startsWith("messages[") || p.startsWith("messages.");
}

/**
 * Any hard-refusal token in any spelling. A moderation code beside one is not evidence that another
 * target may serve the request: the client must not retry these.
 */
const HARD_STOP_TOKEN =
  /(?<![a-z0-9])(?:cyber_policy|origin_rejected|bio_policy|misalignment_policy_violation|invalid_prompt|content_policy_violation|context_length_exceeded|client_closed_request|client_cancelled|upstream_no_response|upstream_closed_before_response|upstream_reset_replay_refused)(?![a-z0-9])/i;

/** JSON \uXXXX escapes decoded, so an escaped code cannot slip past {@link HARD_STOP_TOKEN}. */
function withJsonEscapesDecoded(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/**
 * Whether any hard-refusal token appears in any spelling: JSON escapes decoded (including \n, \t
 * and \r), camel humps split, and hyphens, dots, slashes and whitespace folded to underscores.
 */
function namesHardStopToken(text: string): boolean {
  return HARD_STOP_TOKEN.test(withJsonEscapesDecoded(text)
    .replace(/\\[ntr]/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-.\s/]+/g, "_"));
}

/** Whether the caller's status and structured code leave room for a moderation hop at all. */
function moderationCodeAllowsHop(status: number, normalizedCode: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return normalizedCode === "" || MODERATION_COMPATIBLE_VALUES.has(normalizedCode);
}

/**
 * The moderation hop for one decision. A caller that read the complete bounded body (the combo
 * failure reader, the stream preflight, the policy path) passes its whole-body verdict; the
 * structured code of this decision can still veto it. Without one, the message decides.
 */
function providerModerationHop(
  status: number, message: string, rawCode: string | null | undefined, wholeBody?: boolean, malformedResponseFormat?: boolean,
): boolean {
  // A malformed response_format diagnostic the reader saw in the whole body stays terminal.
  if (malformedResponseFormat === true) return false;
  if (wholeBody === undefined) return isProviderModerationRefusal(status, message, rawCode);
  return wholeBody && moderationCodeAllowsHop(status, normalizedFailureCode(rawCode));
}

/** Strip this proxy's wrapper prefixes and a single-line SSE data field; undefined unless JSON. */
function moderationEnvelope(message: string): unknown {
  let text = message.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    const prefix = ["Provider error 400: ", "Provider error 422: ", "Provider error: ", "Gateway error 400: ", "Gateway error 422: ", "Gateway error: "]
      .find(candidate => text.startsWith(candidate));
    if (prefix) text = text.slice(prefix.length).trim();
    if (text.startsWith("data:") && !text.includes("\n")) text = text.slice("data:".length).trim();
  }
  try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * Walk a refusal envelope (bounded) against the closed shape of a moderation refusal. Returns whether
 * a moderation code was seen, or null when the body carries anything else: an unknown field, prose
 * that is not refusal copy, a param outside the prompt or input, a stated status other than 400/422,
 * an incompatible code, or more nesting than a refusal envelope has. Only known shapes hop; anything
 * unrecognized keeps dev's decision.
 */
function moderationVerdictFields(payload: unknown): boolean | null {
  let seen = false;
  let nodes = 0;
  const verdict = (field: unknown, key: string, depth: number): boolean => {
    if (field === null || field === undefined) return true;
    // A Responses terminal event names itself in its root `type` (`response.failed`): that is the
    // transport's label for the carrier, not the upstream's verdict.
    if (depth === 0 && key === "type" && typeof field === "string" && /^response\.[a-z_.]+$/.test(field)) return true;
    if (typeof field !== "string" && typeof field !== "number") return false;
    const normalized = normalizedFailureCode(field);
    if (normalized === "") return typeof field === "string";
    if (!MODERATION_COMPATIBLE_VALUES.has(normalized)) return false;
    // Only a code states the provider's moderation verdict. A `type` or an incomplete `reason` of
    // content_filter may sit beside it, but alone it is a model's own output filter, which stays
    // terminal (structure/transports/responses.md).
    if (MODERATION_REFUSAL_CODES.has(normalized) && (foldKey(key) === "code" || foldKey(key) === "errorcode")) seen = true;
    return true;
  };
  const visitFilterResult = (value: unknown, depth: number): boolean => {
    if (++nodes > 512 || depth > 8) return false;
    if (value === null || typeof value === "boolean" || typeof value === "number") return true;
    if (Array.isArray(value)) return value.every(item => visitFilterResult(item, depth + 1));
    if (typeof value !== "object") return false;
    return Object.entries(value as Record<string, unknown>).every(([key, field]) => {
      const folded = foldKey(key);
      if (MODERATION_VERDICT_KEYS.has(folded)) return verdict(field, key, depth);
      if (!/^[a-z][a-z0-9_]*$/i.test(key) || FILTER_RESULT_EVIDENCE_KEY.test(key)) return false;
      if (typeof field === "string") {
        return folded === "severity" ? /^(?:safe|low|medium|high)$/i.test(field)
          : (folded === "id" || folded === "url" || folded === "license") && !/\s/.test(field);
      }
      return visitFilterResult(field, depth + 1);
    });
  };
  // A gateway's routing metadata: plain tokens, numbers and flags only, under keys that name no state.
  const visitRoutingMetadata = (value: unknown, depth: number): boolean => {
    if (++nodes > 512 || depth > 8) return false;
    if (value === null || typeof value === "number" || typeof value === "boolean") return true;
    if (typeof value === "string") return !/\s/.test(value);
    if (Array.isArray(value)) return value.every(item => visitRoutingMetadata(item, depth + 1));
    if (typeof value !== "object") return false;
    return Object.entries(value as Record<string, unknown>).every(([key, field]) =>
      !ROUTING_METADATA_EVIDENCE_KEY.test(key) && visitRoutingMetadata(field, depth + 1));
  };
  const visit = (value: unknown, depth: number, responseObject: boolean): boolean => {
    if (++nodes > 512 || depth > 8) return false;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const responseCarrier = depth === 0 && typeof record.type === "string" && /^response\.[a-z_.]+$/.test(record.type);
    for (const [key, field] of Object.entries(record)) {
      const folded = foldKey(key);
      if (responseObject && RESPONSE_REQUEST_ECHO_KEYS.has(folded)) continue;
      if (MODERATION_VERDICT_KEYS.has(folded)) {
        if (!verdict(field, key, depth)) return false;
      } else if (MODERATION_STATUS_KEYS.has(folded)) {
        if (field === null) continue;
        const stated = typeof field === "number" ? field
          : typeof field === "string" && /^\d{3}$/.test(field.trim()) ? Number(field) : undefined;
        if (stated !== undefined ? stated !== 400 && stated !== 422
          : !(typeof field === "string" && /^(?:failed|incomplete|error)$/i.test(field.trim()))) return false;
      } else if (folded === "message") {
        if (field !== null && field !== "" && !(typeof field === "string" && isModerationRefusalProse(field))) return false;
      } else if (folded === "param") {
        // A param names what the filter inspected: the prompt or input. Any other param is a
        // validation error.
        if (field !== null && typeof field === "object" && !Array.isArray(field)) {
          // An SDK error object in the param slot (an AI gateway's wrapped error) is read as a record.
          if (!visit(field, depth + 1, false)) return false;
        } else if (field !== null && field !== "" && !(typeof field === "string" && isAllowedModerationParam(field))) return false;
      } else if (MODERATION_ID_KEYS.has(folded)) {
        if (field !== null && typeof field !== "number" && !(typeof field === "string" && !/\s/.test(field))) return false;
      } else if (folded === "isretryable") {
        if (field !== null && typeof field !== "boolean") return false;
      } else if (depth === 0 && folded === "providermetadata") {
        if (!visitRoutingMetadata(field, depth + 1)) return false;
      } else if (MODERATION_RESULT_KEY.test(folded)) {
        if (!visitFilterResult(field, depth + 1)) return false;
      } else if (folded === "error") {
        if (field === null) continue;
        if (typeof field === "string" ? !isModerationRefusalProse(field) : !visit(field, depth + 1, false)) return false;
      } else if (folded === "innererror" || (responseObject && folded === "incompletedetails")) {
        if (field !== null && !visit(field, depth + 1, false)) return false;
      } else if (responseObject && folded === "metadata") {
        // The caller's own request metadata; a refusal never needs it, so only an empty one passes.
        if (field !== null && !(typeof field === "object" && !Array.isArray(field) && Object.keys(field).length === 0)) return false;
      } else if (responseCarrier && key === "response") {
        if (!visit(field, depth + 1, true)) return false;
      } else {
        return false;
      }
    }
    return true;
  };
  return visit(payload, 0, false) ? seen : null;
}

/**
 * A provider or gateway moderation refusal on HTTP 400/422 is target-local in a heterogeneous
 * combo: this provider's filter refused the prompt, and another target may serve it.
 *
 * Granted narrowly, on structured evidence only. The verdict must be a structured
 * `moderation_refusal` or `content_filter` code (the caller's or one in the body), every other
 * code or type anywhere in the body must be compatible with it, and no hard-refusal token, safety or
 * terminal copy, malformed response_format diagnostic, subscription gate, or anything the shared
 * classifier files more specifically than a generic invalid request may appear. Prose alone never
 * hops: wording can be echoed back, and a body that carries both prose and another signal is not
 * evidence that the next target may serve the request.
 */
export function isProviderModerationRefusal(
  status: number,
  message: string,
  code?: string | null,
  /** True when `message` is the complete bounded body rather than a possibly cut classification text. */
  complete = false,
): boolean {
  const normalizedCode = normalizedFailureCode(code);
  if (!moderationCodeAllowsHop(status, normalizedCode)) return false;
  const callerStatesModeration = MODERATION_REFUSAL_CODES.has(normalizedCode);
  if (!message) return callerStatesModeration;
  // Hop only on evidence seen whole: the combo path classifies at most the first
  // MODERATION_EVIDENCE_LIMIT characters of a body, and the body readers pass `complete` instead.
  if (!complete && message.length >= MODERATION_EVIDENCE_LIMIT) return false;
  // The same bound as the bounded body readers (64 KiB), so no carrier silently loses a refusal.
  if (message.length > 65_536) return false;
  const lower = message.toLowerCase();
  if (namesHardStopToken(message) || isHardPolicyOrOriginRefusal(message)
    || safetyRefusalCodeFromMessage(message) !== undefined || SAFETY_SYSTEM_WORDING.test(message)
    || isCyberPolicyMessage(message)
    || lower.includes(CYBER_POLICY_FALLBACK_MESSAGE.toLowerCase())
    || lower.includes(TERMINAL_REFUSAL_FALLBACK_MESSAGE.toLowerCase())
    || isMalformedResponseFormatRequest(status, message)
    || isSubscriptionGateMessage(lower)
    // Quota, billing and account-state wording is provider evidence with its own cooldown, even
    // where the classifier files a 400 carrying it as a generic invalid request.
    || isRateLimitOrQuotaFailureMessage(message) || isAnthropicBillingFailure(400, message, undefined)
    || PROVIDER_STATE_WORDING.test(message)
    // Classified as a 400: classifyError maps an untyped 422 to upstream_error.
    || classifyError(400, "upstream_error", message).code !== "invalid_request_error") {
    return false;
  }
  const envelope = moderationEnvelope(message);
  if (envelope === undefined) {
    // Plain text carries no structured fields; only the caller's code can state the verdict, and a
    // body that looks like JSON but does not parse (cut or malformed) never hops.
    return callerStatesModeration && !/^\s*(?:data:\s*)?[[{]/.test(message) && isModerationRefusalProse(message);
  }
  // An envelope root that states a verdict code of its own (invalid_request_error, origin,
  // context length, cancellation...) keeps it, as everywhere else in this file.
  if (envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
    const rootCode = (envelope as Record<string, unknown>).code;
    if (typeof rootCode === "string" && rootCodeStatesVerdict(rootCode)) return false;
  }
  const seen = moderationVerdictFields(envelope);
  return seen !== null && (seen || callerStatesModeration);
}

/** Return the narrowest cooldown scope supported by this target's failure evidence. */
export function comboFailureCooldownScope(
  status: number,
  message: string,
  options?: {
    code?: string | number | null;
    malformedResponseFormat?: boolean;
    openRouterOpaque400?: boolean;
    /** Whole-body moderation verdict from a reader that saw the complete bounded body. */
    providerModerationRefusal?: boolean;
  },
): ComboFailureCooldownScope {
  const rawCode = typeof options?.code === "number" ? String(options.code) : options?.code;
  const code = normalizedFailureCode(rawCode);
  if (isAnthropicBillingFailure(status, message, rawCode)) return "provider";
  // Request-shape refusals first: an oversized request must not cool a healthy target.
  // A native transport can surface a zero-output model overflow as a generic
  // upstream_server_error carrying precise context-window prose, so consult the bounded
  // message classifier too: that target is healthy, the turn was simply too large for it.
  if (
    status === 413
    || REQUEST_SHAPE_FAILURE_CODES.has(code)
    || isRequestLocalFreePromptCap(status, message, rawCode)
    || isProviderTargetContextOverflow(status, message, rawCode)
    || isDefiniteContextOverflow(status, message)
    || isRequestLocalTargetIncompatibility(status, message, rawCode)
    // A capability gap says the target is healthy and the request did not fit it, which is the
    // same reason every other entry here refuses to cool a target.
    || isResponseFormatCapabilityRefusal(status, message, rawCode)
  ) return "none";
  if (isProviderScopedQuotaCap(status, message, rawCode)) return "provider";
  // A rejected or unpaid credential is provider-wide evidence: every target that routes
  // through the same provider row carries the same key and will fail identically.
  if (status === 401 || status === 402 || status === 403) return "provider";
  if (PROVIDER_SCOPED_FAILURE_CODES.has(code)) return "provider";
  // A moderation verdict is target-local, but only after quota and credential evidence had its
  // say: a refusing key beside moderation prose still cools its provider.
  if (providerModerationHop(status, message, rawCode, options?.providerModerationRefusal, options?.malformedResponseFormat)) return "none";
  // OpenRouter's opaque numeric-code wrapper may be target-specific (for example a gateway
  // rejecting a model's translated payload). It may advance the combo, but says nothing about
  // target health and must not quarantine the target.
  if (isUncodedUpstream400(status, message, rawCode, options)) return "none";
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

const CODEX_ACCOUNT_MODEL_REFUSAL = /^The '[^']{1,256}' model is not supported when using Codex with a ChatGPT account\.$/;

export type CodexAccountModelRefusal = "other" | "refusal" | "ambiguous";

/** Inspect only the original root and its own response record, before carrier selection. */
export function hasConflictingCodexModelRefusalEnvelopes(status: number, payload: unknown): boolean {
  if (status !== 400 || !payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const response = Object.hasOwn(payload, "response") ? (payload as Record<string, unknown>).response : undefined;
  const nested = response && typeof response === "object" && !Array.isArray(response) ? response : undefined;
  return (Object.hasOwn(payload, "detail") || !!nested && Object.hasOwn(nested, "detail"))
    && (Object.hasOwn(payload, "error") || !!nested && Object.hasOwn(nested, "error"));
}

/** Inspect an already parsed, bounded error frame without copying or walking its body. */
export function codexAccountModelRefusalPayload(status: number, payload: unknown): CodexAccountModelRefusal {
  if (status !== 400 || !payload || typeof payload !== "object" || Array.isArray(payload)) return "other";
  if (Object.hasOwn(payload, "detail") && Object.hasOwn(payload, "error")) return "ambiguous";
  const { detail, error } = payload as { detail?: unknown; error?: unknown };
  const field = typeof detail === "string" ? detail
    : error && typeof error === "object" && !Array.isArray(error)
      && typeof (error as Record<string, unknown>).message === "string"
      ? (error as { message: string }).message : undefined;
  return field !== undefined && CODEX_ACCOUNT_MODEL_REFUSAL.test(field) ? "refusal" : "other";
}

/** One complete, bounded HTTP envelope; accept only a single exact status prefix. */
function parseCodexRefusalEnvelope(status: number, message: string): { text: string; payload: unknown } | undefined {
  if (status !== 400 || message.length > 16_384) return undefined;
  let text = message.trim();
  if (text.startsWith("Provider error 400: ")) text = text.slice("Provider error 400: ".length);
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { /* Bare refusal text is also a supported carrier. */ }
  return { text, payload };
}

/** Only allowlisted hard stops cross the same HTTP boundary as positive refusal evidence. */
export function codexAccountModelRefusalHardStopCode(status: number, message: string): string | undefined {
  const payload = parseCodexRefusalEnvelope(status, message)?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const root = payload as Record<string, unknown>;
  const response = Object.hasOwn(root, "response") ? root.response : undefined;
  const records = response && typeof response === "object" && !Array.isArray(response)
    ? [root, response as Record<string, unknown>] : [root];
  for (const record of records) {
    const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
      ? record.error as Record<string, unknown> : undefined;
    // Diagnostic type is never code evidence, even when a code is absent or malformed.
    for (const code of [error?.code, record.code]) {
      if (typeof code !== "string") continue;
      if (isNonReplayableUpstreamCode(code) || isCyberPolicyCode(code)) return code;
      if (normalizedFailureCode(code) === "origin_rejected") return "origin_rejected";
    }
  }
  return undefined;
}

/** A bounded fallback signal, never credential or account-entitlement evidence. */
export function codexAccountModelRefusal(
  status: number, message: string, options?: { allowNestedResponse?: boolean },
): CodexAccountModelRefusal {
  const envelope = parseCodexRefusalEnvelope(status, message);
  if (!envelope) return "other";
  if (CODEX_ACCOUNT_MODEL_REFUSAL.test(envelope.text)) return "refusal";
  const payload = envelope.payload;
  if (hasConflictingCodexModelRefusalEnvelopes(status, payload)) return "ambiguous";
  // A present root carrier stays authoritative, even when malformed or nonmatching.
  if (options?.allowNestedResponse !== false && payload && typeof payload === "object" && !Array.isArray(payload)
    && !Object.hasOwn(payload, "detail") && !Object.hasOwn(payload, "error")
    && Object.hasOwn(payload, "response")) {
    return codexAccountModelRefusalPayload(status, (payload as Record<string, unknown>).response);
  }
  return codexAccountModelRefusalPayload(status, payload);
}

/**
 * Decide whether a zero-output combo failure can move to another eligible target.
 *
 * `rootCode` is the envelope root's own structured code when the record `code` came from is a
 * nested one. Told about both, this applies the same rule for every transport: each code must
 * authorize the hop on its own, so a root hard stop is never hidden behind a retryable record
 * and a retryable pair is not stopped merely because the envelope states them twice.
 */
export function comboFailureDecision(
  status: number,
  message: string,
  options?: {
    code?: string | number | null;
    /** The envelope root's own code when it differs from `code`; absent or blank states none. */
    rootCode?: string | number | null;
    codexModelRefusal?: CodexAccountModelRefusal;
    failedAdapter?: string;
    /** The caller proved the failure is an adapter-normalized plan refusal (`isModelNotInPlanRefusal`). */
    verifiedPlanRefusal?: boolean;
    malformedResponseFormat?: boolean;
    openRouterOpaque400?: boolean;
    /** Whole-body moderation verdict from a reader that saw the complete bounded body. */
    providerModerationRefusal?: boolean;
  },
): ComboFailureDecision {
  const rootRawCode = typeof options?.rootCode === "number" ? String(options.rootCode) : options?.rootCode;
  const nestedRawCode = typeof options?.code === "number" ? String(options.code) : options?.code;
  const rootCode = normalizedFailureCode(rootRawCode);
  const nestedCode = normalizedFailureCode(nestedRawCode);
  if (rootCode !== "" && rootCode !== nestedCode) {
    if (nestedCode === "") return decideComboFailure(status, message, { ...options, code: rootRawCode });
    const rootDecision = decideComboFailure(status, message, { ...options, code: rootRawCode });
    if (rootDecision === "stop") return "stop";
    return decideComboFailure(status, message, { ...options, code: nestedRawCode }) === "hop"
      ? "hop" : "stop";
  }
  return decideComboFailure(status, message, options);
}

function decideComboFailure(
  status: number,
  message: string,
  options?: {
    code?: string | number | null;
    codexModelRefusal?: CodexAccountModelRefusal;
    failedAdapter?: string;
    verifiedPlanRefusal?: boolean;
    malformedResponseFormat?: boolean;
    openRouterOpaque400?: boolean;
    /** Whole-body moderation verdict from a reader that saw the complete bounded body. */
    providerModerationRefusal?: boolean;
  },
): ComboFailureDecision {
  if (status === 499) return "stop";
  if (message.toLowerCase().includes("origin_rejected")) return "stop";
  // Structured form of the same hard refusal. The prose test above misses it when the origin
  // reports the code out of band, and every hop rule below -- including the context-overflow
  // one -- must stay subordinate to it.
  const rawCode = typeof options?.code === "number" ? String(options.code) : options?.code;
  if (normalizedFailureCode(rawCode) === "origin_rejected") return "stop";
  // The origin may already be executing this turn (the Codex WebSocket relay sent the create
  // frame and never saw a response event). Hopping would send the same request to a second
  // target while the first may still be generating; the honest status goes to the client.
  if (isNonReplayableUpstreamCode(rawCode)) return "stop";
  // Cyber policy is a hard non-retryable refusal — honor structured code even when
  // classificationText was truncated before the JSON code field.
  if (isCyberPolicyCode(rawCode)) return "stop";
  // HTTP consumers retain hard codes before truncation; SSE metadata owns its selected carrier.
  if (options?.codexModelRefusal === undefined && codexAccountModelRefusalHardStopCode(status, message)) return "stop";
  const modelRefusal = status === 400
    ? options?.codexModelRefusal ?? codexAccountModelRefusal(status, message) : "other";
  // Competing envelopes cannot grant a hop through an earlier structured-code rule either.
  if (modelRefusal === "ambiguous") return "stop";
  // HTTP 410 is normally terminal. A model-specific lifecycle verdict is target-local,
  // however: another provider/model in the declared combo can still serve the request.
  // Require structured lifecycle code or explicit model+lifecycle prose so unrelated
  // application-level 410 responses remain fail-closed.
  if (isModelLifecycleGone(status, message, rawCode)) return "hop";
  const error = classifyError(status, "upstream_error", message);
  if (isCyberPolicyCode(error.code)) return "stop";
  // A provider can expose its own target hard cap with a non-semantic vendor code
  // (for example 5059 + invalid_request_prompt_too_long). That is evidence that this
  // target is too small, not that every later combo target is incapable of serving it.
  if (isProviderTargetContextOverflow(status, message, rawCode)) return "hop";
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
  // so checking the stop list first swallowed the signal and ended the chain. Confirmed
  // upstream context refusals already took the bounded message-classification hop above.
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
  if (rawCode === "input_admission_refused" || error.code === "input_admission_refused") {
    return "hop";
  }
  if (isProviderScopedQuotaCap(status, message, rawCode || error.code)) {
    return "hop";
  }
  // A model-scoped rejection is target-local: this provider does not serve THIS model, which
  // says nothing about the next combo target. Structured code only, plus the explicit prose
  // form upstreams emit when they carry no code, so an unrelated 400 stays terminal.
  const failureCode = normalizedFailureCode(rawCode || error.code);
  // The input-modality refusal is the same kind of verdict: this route cannot read the turn's
  // media, and a later target may. Its 400 would otherwise end the chain as invalid_request_error.
  if (["model_not_found", "model_unavailable", "unsupported_model", "unsupported_input_modality"].includes(failureCode)) {
    return "hop";
  }
  // So is a plan refusal (#7684): this account's plan excludes THIS model, and it cools only the
  // refused target because `comboFailureCooldownScope` reads a 400 as target-scoped. Unlike the
  // codes above it is honoured only with caller-supplied provenance, never from the code alone.
  if (failureCode === "model_not_in_plan" && options?.verifiedPlanRefusal === true) return "hop";
  if (modelRefusal === "refusal") return "hop";
  // `free_rate_limited` no longer routes through `isProviderScopedQuotaCap` (it is a
  // per-request cap, not provider-wide evidence), so keep its hop verdict explicit here.
  if (failureCode === "free_rate_limited") return "hop";
  if (isRequestLocalTargetIncompatibility(status, message, rawCode)) return "hop";
  // Must precede the generic `invalid_request_error` stop below, which is where this refusal
  // ended the chain: the gateway reports `type: "invalid_request_error"`, so the classifier
  // reaches that list and returns terminal before anything can ask whether the next target
  // could have served the request (#4903).
  if (isResponseFormatCapabilityRefusal(status, message, rawCode)) return "hop";
  if (providerModerationHop(status, message, rawCode, options?.providerModerationRefusal, options?.malformedResponseFormat)) return "hop";
  if (isAnthropicBillingFailure(status, message, rawCode)) return "hop";
  // Kiro's body validator rejects the request for the identity it was routed under. The account
  // layer rotates logins first; this is the no-alternate case, so the next combo target is the
  // only remaining chance to serve the turn. Only a caller that knows the failed target is a Kiro
  // adapter grants it (the words alone prove nothing for another provider); it must precede the
  // generic invalid_request_error stop.
  if (options?.failedAdapter === "kiro" && isKiroAccountProfileRefusal(status, message)) return "hop";
  // A structured account-window exhaustion code is provider-state evidence even inside a
  // 400 / invalid_request_error envelope, so it must precede that stop. Exhaustion prose alone
  // never reaches this arm: a validation error can quote quota wording back (#7625).
  if (hasAccountExhaustionCode(rawCode)) return "hop";
  // OpenRouter can wrap an opaque provider failure as a numeric 400 with `metadata.raw: "ERROR"`
  // and no type. Let a heterogeneous combo try another target in this case, while keeping
  // malformed response_format diagnostics terminal and preserving any structured code.
  if (isUncodedUpstream400(status, message, rawCode, options)) return "hop";
  if (["origin_rejected", "context_length_exceeded", "invalid_request_error"].includes(error.code ?? "")) {
    return "stop";
  }
  // Quota prose inside a request-validation status (400/422) is not authoritative without a
  // structured code: the body can quote prompt or parameter text back (#7625).
  if (error.code === "insufficient_quota" && (status === 400 || status === 422)) return "stop";
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
