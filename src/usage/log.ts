import { createHash, type Hash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { enforceAppOwnedMemoryBudget } from "../lib/app-owned-memory";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { sanitizeLogMetadataString } from "../lib/redact";
import { usageDisplayTotalTokens } from "./totals";
import type { AttemptTierOutcome, OcxUsage } from "../types";
import { normalizeRouteDecisionTrace, type RouteDecisionTraceV1 } from "../routing/trace";
import { ACCOUNT_LOG_LABEL_RE, CODEX_ACCOUNT_LOG_LABEL_RE } from "../codex/account-label";

export type UsageStatus = "reported" | "unreported" | "unsupported" | "estimated";
/**
 * A persisted account label: a Codex pool account (`main`/`p<hex6>`) or a non-Codex OAuth
 * provider account (`o<hex6>`, #2699).
 *
 * The old name `CodexUsageAccountLogLabel` is kept as an alias because it is exported and used
 * across modules; the two predicates below are what callers should choose between.
 */
export type UsageAccountLogLabel = "main" | `p${string}` | `o${string}`;
export type CodexUsageAccountLogLabel = UsageAccountLogLabel;

/**
 * Accepts EITHER label family. This is the predicate the persistence writers use, so widening
 * it here is what stops six separate call sites from silently dropping an `o`-label -- including
 * two in the live request path (`request-log.ts:972` and `:1187`).
 *
 * The name is unchanged deliberately: renaming it would touch every call site for no behavior,
 * and the widened contract is what every one of those sites wanted.
 */
export function isCodexUsageAccountLogLabel(value: unknown): value is UsageAccountLogLabel {
  return value === "main" || (typeof value === "string" && ACCOUNT_LOG_LABEL_RE.test(value));
}

/** Strictly a Codex pool label. Use when the Codex-only distinction actually matters. */
export function isCodexPoolAccountLogLabel(value: unknown): value is "main" | `p${string}` {
  return value === "main" || (typeof value === "string" && CODEX_ACCOUNT_LOG_LABEL_RE.test(value));
}

/**
 * Recovery kinds recorded per attempt in the usage log; the GUI renders localized labels
 * for these wire values.
 */
export type AttemptRecoveryKind =
  | "transient-5xx"
  | "connection-reset"
  | "oauth-401"
  | "key-429"
  | "rate-limit-429"
  | "anthropic-oauth-429"
  | "oauth-account-429"
  | "image-413"
  | "opaque-blob-rejection"
  | "empty-completion";

export interface PersistedUsageAttempt {
  ordinal: number;
  provider: string;
  model: string;
  adapter: string;
  status: number;
  durationMs: number;
  /**
   * True only when the upstream stream died after its 200 head was committed,
   * so the row must not meter as a success the client never received.
   * Absent on ordinary attempts so old rows keep their exact shape.
   */
  streamAborted?: boolean;
  /** TTFT relative to THIS attempt's start (WP4); unset for non-streaming/tool-only. */
  firstOutputMs?: number;
  sendCount: number;
  recoveryKinds: AttemptRecoveryKind[];
  usageStatus: UsageStatus;
  /**
   * True when the proxy answered this turn locally and issued no upstream request. It travels on
   * the attempt itself rather than as a `finishRequestAttempt` argument because that function is
   * called from six places, and a new parameter would silently default to the wrong answer at any
   * one of them that was missed. Absent on ordinary attempts so old rows keep their exact shape.
   */
  locallyAnswered?: boolean;
  /** Stable non-PII identity for the Codex pool account that served this attempt. */
  accountLogLabel?: CodexUsageAccountLogLabel;
  inputTokenEstimate?: number;
  usage?: OcxUsage;
  totalTokens?: number;
  errorCode?: string;
  /** Installation-local exact Compatibility Lab route-subject digest for this attempt. */
  labRouteSubjectId?: string;
  /** Target-specific reasoning intent and exact adapter-normalized wire parameter. */
  requestedEffort?: string;
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number | boolean;
  /** Adapter-produced tier fact for this physical attempt; absent on pre-B0 rows. */
  tierOutcome?: AttemptTierOutcome;
}

export interface PersistedUsageEntry {
  requestedAlias?: string;
  requestId: string;
  timestamp: number;
  provider: string;
  model: string;
  surface?: "claude" | "claude-desktop" | "grok";
  /** Matched configured key id; absent for environment/loopback admissions and
   *  for every row written before attribution existed. */
  apiKeyId?: string;
  admissionKind?: "configured" | "environment" | "loopback";
  /** The inbound wire, not the client product — see `surface`. */
  inboundProtocol?: "responses" | "chat" | "messages";
  /** Stable non-PII identity for Codex Pool usage; absent for Direct/non-Codex traffic. */
  accountLogLabel?: CodexUsageAccountLogLabel;
  /** Best-effort chat/session correlation for Logs grouping (#330). */
  conversationId?: string;
  resolvedModel?: string;
  requestedModel?: string;
  /** Original bare helper model when the opt-in shadow-call route rewrote this request. */
  shadowCallRewrittenFrom?: string;
  /** Reasoning effort / service-tier metadata for GUI Logs after restart. */
  requestedEffort?: string;
  /** Adapter-normalized tier and exact upstream parameter emitted for this request. */
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number | boolean;
  /** Raw caller tier captured before routing, sanitized and bounded for durable logs. */
  callerServiceTier?: string;
  requestedServiceTier?: string;
  requestedSpeedLabel?: string;
  configuredServiceTier?: string;
  configuredSpeedLabel?: string;
  modelSupportsServiceTier?: boolean;
  responseServiceTier?: string;
  /** Summary of the final physical attempt for dashboard consumers. */
  tierOutcome?: AttemptTierOutcome;
  status: number;
  durationMs: number;
  /** TTFT relative to the request start (WP4); unset for non-streaming/tool-only. */
  firstOutputMs?: number;
  usageStatus: UsageStatus;
  usage?: OcxUsage;
  totalTokens?: number;
  attempts?: PersistedUsageAttempt[];
  // Failure diagnostics (devlog/_plan/260716_claudecode_hardening/030): persisted for
  // status>=400 or non-completed terminals so incidents survive the in-memory ring buffer.
  errorCode?: string;
  terminalStatus?: string;
  closeReason?: "terminal" | "client_cancel" | "non_stream" | "body_stall" | "body_overflow";
  /** Already redacted + capped at capture (request-log.ts redactSecretString().slice(0,500)). */
  upstreamError?: string;
  /**
   * Bounded route-decision trace (RI-01): why this provider/model/account was
   * selected. Additive field; old rows without it parse unchanged. Never
   * contains prompts, credentials, or hidden reasoning.
   */
  routeDecision?: RouteDecisionTraceV1;
}

const KNOWN_USAGE_SURFACES = new Set<NonNullable<PersistedUsageEntry["surface"]>>([
  "claude",
  "claude-desktop",
  "grok",
]);

/**
 * The serializer guard for `surface`. Two failure modes shaped this: a literal
 * whitelist ("claude" | "claude-desktop" only) silently dropped every NEW surface at
 * write time, while a plain truthy spread would persist junk values from hand-edited
 * logs. Membership in this set is the middle path: adding a surface here is one edit,
 * and unknown values are still dropped.
 */
export function isKnownUsageSurface(value: unknown): value is NonNullable<PersistedUsageEntry["surface"]> {
  return typeof value === "string" && KNOWN_USAGE_SURFACES.has(value as NonNullable<PersistedUsageEntry["surface"]>);
}

const KNOWN_ADMISSION_KINDS = new Set<NonNullable<PersistedUsageEntry["admissionKind"]>>([
  "configured", "environment", "loopback",
]);

const KNOWN_INBOUND_PROTOCOLS = new Set<NonNullable<PersistedUsageEntry["inboundProtocol"]>>([
  "responses", "chat", "messages",
]);

/** Same closed-set discipline as `isKnownUsageSurface`: an old or corrupted row
 *  carrying an unexpected value drops the field instead of poisoning the enum. */
export function isKnownAdmissionKind(value: unknown): value is NonNullable<PersistedUsageEntry["admissionKind"]> {
  return typeof value === "string" && KNOWN_ADMISSION_KINDS.has(value as NonNullable<PersistedUsageEntry["admissionKind"]>);
}

export function isKnownInboundProtocol(value: unknown): value is NonNullable<PersistedUsageEntry["inboundProtocol"]> {
  return typeof value === "string" && KNOWN_INBOUND_PROTOCOLS.has(value as NonNullable<PersistedUsageEntry["inboundProtocol"]>);
}

export function usageLogPath(configDir?: string): string {
  return join(configDir ?? getConfigDir(), "usage.jsonl");
}

export function usageTotalTokens(usage: OcxUsage | undefined): number | undefined {
  return usageDisplayTotalTokens(usage);
}

/**
 * Providers whose adapters can only estimate usage (no authoritative per-turn frame).
 * Callers should pass the route ADAPTER when available; the name-prefix match is a
 * fallback for paths that only know the configured provider name (e.g. "cursor-mykey").
 */
function isEstimatedUsageProvider(providerOrAdapter: string): boolean {
  return providerOrAdapter === "kiro" || providerOrAdapter.startsWith("kiro-")
    || providerOrAdapter === "cursor" || providerOrAdapter.startsWith("cursor-");
}

export function usageForFinalLog(
  provider: string,
  usage: OcxUsage | undefined,
  /**
   * True when the proxy answered this turn locally and issued no upstream request. Such a turn's
   * zero counts are EXACT, so the provider-wide estimated marking must not apply: Kiro and Cursor
   * are marked estimated because their adapters can only guess a real inference's usage, and a
   * turn with no inference has nothing to guess. Without this, a no-send turn is indistinguishable
   * from a real one whose usage frame never arrived.
   */
  locallyAnswered = false,
): OcxUsage | undefined {
  if (!usage) return undefined;
  if (locallyAnswered) return usage;
  if (usage.estimated || isEstimatedUsageProvider(provider)) return { ...usage, estimated: true };
  return usage;
}

export function usageStatusForFinalLog(usage: OcxUsage | undefined): UsageStatus {
  if (!usage) return "unreported";
  return usage.estimated ? "estimated" : "reported";
}

function normalizeUsageValue(usage: OcxUsage | undefined): OcxUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    // Absolute active-context checkpoint (types.ts). Stateful providers such as Kiro report
    // per-attempt usage only, so this field is the ONLY carrier of the cumulative context
    // figure once the log records raw adapter usage instead of re-parsing the bridged wire
    // (usageFromBridge, request-log.ts). Omitting it here silently dropped Kiro's context
    // growth from every persisted row. It is deliberately NOT folded into totalTokens:
    // a checkpoint is not a per-request total and must never be summed across requests.
    ...(typeof usage.contextTotalTokens === "number" ? { contextTotalTokens: usage.contextTotalTokens } : {}),
    ...(typeof usage.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
    ...(typeof usage.cachedInputTokens === "number" ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(typeof usage.cacheReadInputTokens === "number" ? { cacheReadInputTokens: usage.cacheReadInputTokens } : {}),
    ...(typeof usage.cacheCreationInputTokens === "number" ? { cacheCreationInputTokens: usage.cacheCreationInputTokens } : {}),
    ...(typeof usage.reasoningOutputTokens === "number" ? { reasoningOutputTokens: usage.reasoningOutputTokens } : {}),
    ...(usage.estimated ? { estimated: true } : {}),
  };
}

const ATTEMPT_RECOVERY_KINDS = new Set<AttemptRecoveryKind>([
  "transient-5xx",
  "connection-reset",
  "oauth-401",
  "key-429",
  "rate-limit-429",
  "anthropic-oauth-429",
  "oauth-account-429",
  "image-413",
  "opaque-blob-rejection",
  "empty-completion",
]);
const USAGE_STATUSES = new Set<UsageStatus>([
  "reported",
  "unreported",
  "unsupported",
  "estimated",
]);
const LAB_ROUTE_SUBJECT_ID_RE = /^[0-9a-f]{64}$/;
const FAST_OUTCOMES = new Set<AttemptTierOutcome["fastOutcome"]>([
  "not-requested", "applied", "downgraded", "unknown",
]);
const TIER_CONFIRMATIONS = new Set<AttemptTierOutcome["confirmation"]>([
  "confirmed", "assumed", "downgraded", "unknown",
]);
const FAST_DOWNGRADE_REASONS = new Set<NonNullable<AttemptTierOutcome["fastDowngradeReason"]>>([
  "route-unsupported", "wire-unavailable", "response-declined",
]);

export function isLabRouteSubjectId(value: unknown): value is string {
  return typeof value === "string" && LAB_ROUTE_SUBJECT_ID_RE.test(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeAttemptUsage(raw: unknown): OcxUsage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;
  if (!isNonNegativeFiniteNumber(usage.inputTokens)
    || !isNonNegativeFiniteNumber(usage.outputTokens)) return null;
  for (const key of [
    "contextTotalTokens",
    "totalTokens",
    "cachedInputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "reasoningOutputTokens",
  ] as const) {
    if (key in usage && !isNonNegativeFiniteNumber(usage[key])) return null;
  }
  if ("estimated" in usage && typeof usage.estimated !== "boolean") return null;
  return normalizeUsageValue(usage as unknown as OcxUsage) ?? null;
}

function normalizeAttemptTierOutcome(raw: unknown): AttemptTierOutcome | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const outcome = raw as Record<string, unknown>;
  if (typeof outcome.fastOutcome !== "string"
    || !FAST_OUTCOMES.has(outcome.fastOutcome as AttemptTierOutcome["fastOutcome"])
    || typeof outcome.confirmation !== "string"
    || !TIER_CONFIRMATIONS.has(outcome.confirmation as AttemptTierOutcome["confirmation"])) {
    return null;
  }
  if ("canonical" in outcome && outcome.canonical !== "priority") return null;
  if ("wireKind" in outcome
    && outcome.wireKind !== null
    && outcome.wireKind !== "service-tier"
    && outcome.wireKind !== "anthropic-speed"
    && outcome.wireKind !== "cursor-variant") return null;
  if ("wireValue" in outcome && outcome.wireValue !== null && typeof outcome.wireValue !== "string") return null;
  if ("fastDowngradeReason" in outcome
    && (typeof outcome.fastDowngradeReason !== "string"
      || !FAST_DOWNGRADE_REASONS.has(outcome.fastDowngradeReason as NonNullable<AttemptTierOutcome["fastDowngradeReason"]>))) {
    return null;
  }
  if ("callerTierDropped" in outcome && typeof outcome.callerTierDropped !== "boolean") return null;
  if ("callerFastSuppressedByConfig" in outcome
    && typeof outcome.callerFastSuppressedByConfig !== "boolean") return null;
  if ("responseServiceTier" in outcome && typeof outcome.responseServiceTier !== "string") return null;
  const wireValue = sanitizeLogMetadataString(outcome.wireValue);
  const responseServiceTier = sanitizeLogMetadataString(outcome.responseServiceTier);
  return {
    ...(outcome.canonical === "priority" ? { canonical: "priority" as const } : {}),
    ...(outcome.wireKind === null
      || outcome.wireKind === "service-tier"
      || outcome.wireKind === "anthropic-speed"
      || outcome.wireKind === "cursor-variant"
      ? { wireKind: outcome.wireKind }
      : {}),
    ...(outcome.wireValue === null
      ? { wireValue: null }
      : wireValue ? { wireValue } : {}),
    fastOutcome: outcome.fastOutcome as AttemptTierOutcome["fastOutcome"],
    ...(typeof outcome.fastDowngradeReason === "string"
      ? { fastDowngradeReason: outcome.fastDowngradeReason as NonNullable<AttemptTierOutcome["fastDowngradeReason"]> }
      : {}),
    ...(typeof outcome.callerTierDropped === "boolean" ? { callerTierDropped: outcome.callerTierDropped } : {}),
    ...(typeof outcome.callerFastSuppressedByConfig === "boolean"
      ? { callerFastSuppressedByConfig: outcome.callerFastSuppressedByConfig }
      : {}),
    confirmation: outcome.confirmation as AttemptTierOutcome["confirmation"],
    ...(responseServiceTier ? { responseServiceTier } : {}),
  };
}

function normalizeUsageAttempt(raw: unknown): PersistedUsageAttempt | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const attempt = raw as Record<string, unknown>;
  if (typeof attempt.ordinal !== "number" || !Number.isInteger(attempt.ordinal)
    || attempt.ordinal < 1
    || typeof attempt.provider !== "string" || !attempt.provider
    || typeof attempt.model !== "string" || !attempt.model
    || typeof attempt.adapter !== "string" || !attempt.adapter
    || typeof attempt.status !== "number" || !Number.isInteger(attempt.status)
    || attempt.status < 100 || attempt.status > 599
    || typeof attempt.durationMs !== "number" || !Number.isFinite(attempt.durationMs)
    || attempt.durationMs < 0
    || typeof attempt.sendCount !== "number" || !Number.isInteger(attempt.sendCount)
    || attempt.sendCount < 0
    || typeof attempt.usageStatus !== "string"
    || !USAGE_STATUSES.has(attempt.usageStatus as UsageStatus)) {
    return null;
  }
  if ("inputTokenEstimate" in attempt
    && !isNonNegativeFiniteNumber(attempt.inputTokenEstimate)) return null;
  if ("firstOutputMs" in attempt
    && !isNonNegativeFiniteNumber(attempt.firstOutputMs)) return null;
  if ("totalTokens" in attempt
    && !isNonNegativeFiniteNumber(attempt.totalTokens)) return null;
  const usage = "usage" in attempt ? normalizeAttemptUsage(attempt.usage) : undefined;
  if ("usage" in attempt && usage === null) return null;
  const tierOutcome = "tierOutcome" in attempt
    ? normalizeAttemptTierOutcome(attempt.tierOutcome)
    : undefined;
  const recoveryKinds = Array.isArray(attempt.recoveryKinds)
    ? [...new Set(attempt.recoveryKinds.filter(
      (value): value is AttemptRecoveryKind => typeof value === "string"
        && ATTEMPT_RECOVERY_KINDS.has(value as AttemptRecoveryKind),
    ))]
    : [];
  return {
    ordinal: attempt.ordinal as number,
    provider: attempt.provider,
    model: attempt.model,
    adapter: attempt.adapter,
    status: attempt.status,
    durationMs: attempt.durationMs,
    // Absent by default; only the literal `true` marker survives the round trip.
    ...(attempt.streamAborted === true ? { streamAborted: true } : {}),
    ...(isNonNegativeFiniteNumber(attempt.firstOutputMs)
      ? { firstOutputMs: attempt.firstOutputMs }
      : {}),
    sendCount: attempt.sendCount as number,
    recoveryKinds,
    usageStatus: attempt.usageStatus as UsageStatus,
    ...(isCodexUsageAccountLogLabel(attempt.accountLogLabel)
      ? { accountLogLabel: attempt.accountLogLabel }
      : {}),
    ...(isNonNegativeFiniteNumber(attempt.inputTokenEstimate)
      ? { inputTokenEstimate: attempt.inputTokenEstimate }
      : {}),
    ...(usage ? { usage } : {}),
    ...(isNonNegativeFiniteNumber(attempt.totalTokens)
      ? { totalTokens: attempt.totalTokens }
      : {}),
    ...(typeof attempt.errorCode === "string" ? { errorCode: attempt.errorCode } : {}),
    ...(isLabRouteSubjectId(attempt.labRouteSubjectId)
      ? { labRouteSubjectId: attempt.labRouteSubjectId }
      : {}),
    ...(typeof attempt.requestedEffort === "string" && attempt.requestedEffort
      ? { requestedEffort: capMetadataString(attempt.requestedEffort) }
      : {}),
    ...(typeof attempt.effectiveEffort === "string" && attempt.effectiveEffort
      ? { effectiveEffort: capMetadataString(attempt.effectiveEffort) }
      : {}),
    ...(typeof attempt.reasoningWireField === "string" && attempt.reasoningWireField
      ? { reasoningWireField: capMetadataString(attempt.reasoningWireField) }
      : {}),
    ...(isValidReasoningWireValue(attempt.reasoningWireField, attempt.reasoningWireValue)
      ? typeof attempt.reasoningWireValue === "string"
        ? { reasoningWireValue: capMetadataString(attempt.reasoningWireValue) }
        : { reasoningWireValue: attempt.reasoningWireValue }
      : {}),
    ...(tierOutcome ? { tierOutcome } : {}),
  };
}

/**
 * Pairing rule for reasoning diagnostics, shared with the live request-log capture path:
 * a non-empty string, a non-negative finite number, or a boolean only for
 * `reasoning.enabled`. The field name itself is validated separately at capture time;
 * persisted rows may carry legacy field names, so this checks only the value shape.
 */
export function isValidReasoningWireValue(
  wireField: unknown,
  wireValue: unknown,
): wireValue is string | number | boolean {
  return (typeof wireValue === "string" && wireValue.length > 0)
    || (typeof wireValue === "number" && Number.isFinite(wireValue) && wireValue >= 0)
    || (wireField === "reasoning.enabled" && typeof wireValue === "boolean");
}

function normalizedAttempts(raw: unknown): PersistedUsageAttempt[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeUsageAttempt)
    .filter((attempt): attempt is PersistedUsageAttempt => attempt !== null);
}

const MAX_METADATA_STRING_LEN = 64;
function capMetadataString(s: string): string {
  return s.length > MAX_METADATA_STRING_LEN ? s.slice(0, MAX_METADATA_STRING_LEN) : s;
}

/** Test seam: the normalization branch old rows take is worth asserting directly. */
export function normalizeUsageEntryForTest(entry: PersistedUsageEntry): PersistedUsageEntry {
  return normalizeUsageEntry(entry);
}

function normalizeUsageEntry(entry: PersistedUsageEntry): PersistedUsageEntry {
  const attempts = normalizedAttempts(entry.attempts);
  const tierOutcome = entry.tierOutcome ? normalizeAttemptTierOutcome(entry.tierOutcome) : undefined;
  const callerServiceTier = sanitizeLogMetadataString(entry.callerServiceTier);
  const responseServiceTier = sanitizeLogMetadataString(entry.responseServiceTier);
  const shadowCallRewrittenFrom = sanitizeLogMetadataString(entry.shadowCallRewrittenFrom);
  const routeDecision = entry.routeDecision
    ? normalizeRouteDecisionTrace(entry.routeDecision)
    : undefined;
  return {
    requestId: entry.requestId,
    timestamp: entry.timestamp,
    provider: entry.provider,
    model: entry.model,
    ...(isKnownUsageSurface(entry.surface) ? { surface: entry.surface } : {}),
    ...(typeof entry.apiKeyId === "string" && entry.apiKeyId.trim()
      // Deliberately NOT capped. `capMetadataString` protects free-form metadata
      // from unbounded growth, but this is a lookup key: truncating it makes the
      // persisted id stop matching the configured one, and the rollup silently
      // reports zero for a key that is very much in use.
      ? { apiKeyId: entry.apiKeyId }
      : {}),
    ...(isKnownAdmissionKind(entry.admissionKind) ? { admissionKind: entry.admissionKind } : {}),
    ...(isKnownInboundProtocol(entry.inboundProtocol) ? { inboundProtocol: entry.inboundProtocol } : {}),
    ...(isCodexUsageAccountLogLabel(entry.accountLogLabel)
      ? { accountLogLabel: entry.accountLogLabel }
      : {}),
    ...(typeof entry.conversationId === "string" && entry.conversationId.trim()
      ? { conversationId: entry.conversationId.trim().slice(0, 128) }
      : {}),
    ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
    ...(entry.requestedModel ? { requestedModel: entry.requestedModel } : {}),
    ...(shadowCallRewrittenFrom ? { shadowCallRewrittenFrom } : {}),
    ...(typeof entry.requestedEffort === "string" && entry.requestedEffort
      ? { requestedEffort: capMetadataString(entry.requestedEffort) }
      : {}),
    ...(typeof entry.effectiveEffort === "string" && entry.effectiveEffort
      ? { effectiveEffort: capMetadataString(entry.effectiveEffort) }
      : {}),
    ...(typeof entry.reasoningWireField === "string" && entry.reasoningWireField
      ? { reasoningWireField: capMetadataString(entry.reasoningWireField) }
      : {}),
    ...(isValidReasoningWireValue(entry.reasoningWireField, entry.reasoningWireValue)
      ? typeof entry.reasoningWireValue === "string"
        ? { reasoningWireValue: capMetadataString(entry.reasoningWireValue) }
        : { reasoningWireValue: entry.reasoningWireValue }
      : {}),
    ...(callerServiceTier ? { callerServiceTier } : {}),
    ...(typeof entry.requestedServiceTier === "string" && entry.requestedServiceTier
      ? { requestedServiceTier: capMetadataString(entry.requestedServiceTier) }
      : {}),
    ...(typeof entry.requestedSpeedLabel === "string" && entry.requestedSpeedLabel
      ? { requestedSpeedLabel: capMetadataString(entry.requestedSpeedLabel) }
      : {}),
    ...(typeof entry.configuredServiceTier === "string" && entry.configuredServiceTier
      ? { configuredServiceTier: capMetadataString(entry.configuredServiceTier) }
      : {}),
    ...(typeof entry.configuredSpeedLabel === "string" && entry.configuredSpeedLabel
      ? { configuredSpeedLabel: capMetadataString(entry.configuredSpeedLabel) }
      : {}),
    ...(typeof entry.modelSupportsServiceTier === "boolean"
      ? { modelSupportsServiceTier: entry.modelSupportsServiceTier }
      : {}),
    ...(responseServiceTier ? { responseServiceTier } : {}),
    ...(tierOutcome ? { tierOutcome } : {}),
    status: entry.status,
    durationMs: entry.durationMs,
    ...(isNonNegativeFiniteNumber(entry.firstOutputMs)
      ? { firstOutputMs: entry.firstOutputMs }
      : {}),
    usageStatus: entry.usageStatus,
    ...(entry.usage ? { usage: normalizeUsageValue(entry.usage) } : {}),
    ...(typeof entry.totalTokens === "number" ? { totalTokens: entry.totalTokens } : {}),
    ...(Array.isArray(entry.attempts) ? { attempts } : {}),
    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    ...(entry.terminalStatus ? { terminalStatus: entry.terminalStatus } : {}),
    ...(entry.closeReason ? { closeReason: entry.closeReason } : {}),
    ...(entry.upstreamError ? { upstreamError: entry.upstreamError } : {}),
    ...(routeDecision ? { routeDecision } : {}),
  };
}

function ensureUsageLogDir(): void {
  const dir = getConfigDir();
  recordOwnedConfigPath(dir, usageLogPath());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best-effort on platforms that ignore chmod */ }
}

export function appendUsageEntry(entry: PersistedUsageEntry): void {
  ensureUsageLogDir();
  const path = usageLogPath();
  appendFileSync(path, `${JSON.stringify(normalizeUsageEntry(entry))}\n`, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort on platforms that ignore chmod */ }
}

export type UsageLogRevision = {
  path: string;
  dev: number;
  ino: number;
  birthtimeMs: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

let usageReadCacheStats = { fullReads: 0, tailReads: 0, parsedLines: 0 };
const MANAGEMENT_USAGE_MAX_READ_BYTES = 64 * 1024 * 1024;
const RECENT_USAGE_MAX_READ_BYTES = 64 * 1024 * 1024;
const MANAGEMENT_USAGE_READ_CHUNK_BYTES = 1024 * 1024;
const MANAGEMENT_USAGE_MAX_ENTRIES_DEFAULT = 500_000;
/**
 * Row cap for a management snapshot. Overridable only so tests can reach the cap without
 * building a half-million-row fixture; production always uses the default.
 */
let MANAGEMENT_USAGE_MAX_ENTRIES = MANAGEMENT_USAGE_MAX_ENTRIES_DEFAULT;

export function setManagementUsageMaxEntriesForTests(value: number | null): void {
  MANAGEMENT_USAGE_MAX_ENTRIES = value ?? MANAGEMENT_USAGE_MAX_ENTRIES_DEFAULT;
}
const MANAGEMENT_USAGE_FLIGHT_STALE_MS = 30_000;
export interface ManagementUsageSnapshot {
  entries: PersistedUsageEntry[];
  revision: UsageLogRevision;
  truncatedPrefixBytes: number;
  entriesTruncated: boolean;
  entriesDropped: number;
  /** Digest of the covered prefix, used to detect an in-place rewrite before reuse. */
  prefixDigest: string;
  /**
   * Byte offset where the RETAINED ROWS begin.
   *
   * Distinct from `truncatedPrefixBytes`, which is the API-visible "bytes skipped by the
   * byte window" signal and must stay independent of entry-count truncation. When the
   * entry cap drops rows, those bytes are not window truncation, but the retained rows do
   * start later -- this field tracks that so the byte accounting stays exact.
   */
  rowsBeginAtBytes: number;
  /**
   * Byte length of each returned row, in order, including its newline.
   *
   * Lets a later read trim rows that have fallen out of the bounded window without
   * re-reading or re-parsing them, which is what keeps the returned set equal to the
   * window the caller asked for.
   */
  entryLengths: number[];
  /** Unparseable bytes after the last returned row; the next read folds them forward. */
  trailingSkippedBytes: number;
}
let managementUsageReadInflight: {
  key: string;
  openedSize: number;
  promise: Promise<ManagementUsageSnapshot>;
  startedAt: number;
  abort: AbortController;
} | null = null;

/**
 * Append-tolerant snapshot of the last management read.
 *
 * The management reader parses a 64 MiB tail into ~53k objects, which costs roughly
 * 640 MB of transient RSS per cold call. The JS objects are collected promptly, but
 * the allocator does not return those pages, so every cold miss ratchets process RSS
 * upward and never comes back down (observed: 7.9 GiB RSS against a 130 MB JS heap).
 *
 * Reparsing an unchanged prefix is what makes that transient recur. `usage.jsonl` is
 * append-only under a stable identity, so when the file has only grown we keep the
 * previously parsed rows and parse just the appended bytes. This is retained state, so
 * it is registered with the app-owned memory budget and is evictable under pressure.
 */
interface RetainedUsageSnapshot {
  identityKey: string;
  maxReadBytes: number;
  /** Absolute end offset in the file that `entries` already covers. */
  coveredThroughBytes: number;
  /**
   * Digest of the last bytes of the covered prefix, re-verified before extending.
   *
   * Identity (path/dev/ino/birthtime) intentionally ignores size and mtime so appends
   * can share work, which also means an in-place rewrite that keeps the inode is
   * invisible to it. A hand-edit or external compaction can therefore replace history
   * under a stable identity without shrinking the file. Re-reading this trailing window
   * catches that: if the bytes behind `coveredThroughBytes` changed, the retained rows
   * no longer describe the file and must not be extended.
   */
  prefixDigest: string;
  /** Bytes of the file skipped ahead of the retained window. */
  truncatedPrefixBytes: number;
  /** Byte length of each retained row, so out-of-window rows can be trimmed exactly. */
  entryLengths: number[];
  /** Unparseable bytes after the last retained row; folded into the next row's span. */
  trailingSkippedBytes: number;
  /** Byte offset where the retained rows begin; see ManagementUsageSnapshot. */
  rowsBeginAtBytes: number;
  entries: PersistedUsageEntry[];
  entriesTruncated: boolean;
  entriesDropped: number;
  revision: UsageLogRevision;
  retainedAt: number;
  approxBytes: number;
}
let retainedUsageSnapshot: RetainedUsageSnapshot | null = null;

/** Rough per-row retained cost; exact sizing would cost another full serialization pass. */
const RETAINED_USAGE_ENTRY_BYTES = 512;

/** Chunk size used when digesting a retained region. */
const RETAINED_USAGE_DIGEST_CHUNK_BYTES = 1024 * 1024;

/**
 * Digest a byte range into `hash`; false when it cannot be read.
 *
 * Deliberately not sampled. A sampled digest covers a vanishing fraction of a large
 * prefix (32 KiB of 64 MiB is 0.05%), so an ordinary fixed-width in-place edit -- a
 * redaction script fixing one field, a compaction rewriting a middle region -- lands in
 * a gap by default and the stale rows are served.
 *
 * Hashing from byte 0 on every call is also wrong: that is O(file) per poll while the
 * read it protects is capped at maxReadBytes, so the ratio degrades as the ledger grows
 * and becomes SLOWER than a full read past roughly 1-2 GB. Only the retained REGION
 * (truncatedPrefixBytes..coveredThroughBytes) is hashed. It is never wider than the
 * window, and bytes below the retained start describe no retained row, so reading them
 * would prove nothing.
 */
function updateUsageDigest(hash: Hash, fd: number, from: number, to: number): boolean {
  if (to <= from) return true;
  const buffer = Buffer.allocUnsafe(Math.min(RETAINED_USAGE_DIGEST_CHUNK_BYTES, to - from));
  for (let position = from; position < to;) {
    const length = Math.min(buffer.byteLength, to - position);
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, position + offset);
      if (read === 0) return false;
      offset += read;
    }
    hash.update(buffer.subarray(0, length));
    position += length;
  }
  return true;
}

/**
 * Digest of `from`..`to`; null when it cannot be read.
 *
 * The range is bound into the digest so a region cannot be confused with an equal-length
 * region at a different offset.
 */
function usageRegionDigest(fd: number, from: number, to: number): string | null {
  if (to <= from) return `${from}:${to}:empty`;
  const hash = createHash("sha256");
  if (!updateUsageDigest(hash, fd, from, to)) return null;
  return `${from}:${to}:${hash.digest("hex")}`;
}

function retainedUsageSnapshotBytes(entries: PersistedUsageEntry[]): number {
  return entries.length * RETAINED_USAGE_ENTRY_BYTES;
}

export function discardRetainedUsageSnapshot(): number {
  const released = retainedUsageSnapshot?.approxBytes ?? 0;
  retainedUsageSnapshot = null;
  return released;
}

export function retainedUsageSnapshotStats(): {
  count: number;
  bytes: number;
  oldestAt: number | null;
} {
  if (!retainedUsageSnapshot) return { count: 0, bytes: 0, oldestAt: null };
  return {
    count: 1,
    bytes: retainedUsageSnapshot.approxBytes,
    oldestAt: retainedUsageSnapshot.retainedAt,
  };
}

/** Test-only observability for proving that unchanged prefixes are not reparsed. */
export function usageReadCacheStatsForTests(): Readonly<typeof usageReadCacheStats> {
  return { ...usageReadCacheStats };
}

export function resetUsageReadCacheForTests(): void {
  usageReadCacheStats = { fullReads: 0, tailReads: 0, parsedLines: 0 };
  managementUsageReadInflight?.abort.abort();
  managementUsageReadInflight = null;
  retainedUsageSnapshot = null;
}

function readExactly(fd: number, length: number, position: number): Buffer | null {
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(fd, output, offset, length - offset, position + offset);
    if (read === 0) return null;
    offset += read;
  }
  return output;
}

function usageLogRevision(path: string, stat: ReturnType<typeof fstatSync>): UsageLogRevision {
  if (!stat.isFile()) throw new Error("usage log is not a regular file");
  return {
    path,
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    birthtimeMs: Number(stat.birthtimeMs),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
  };
}

export function usageLogRevisionKey(revision: UsageLogRevision | null): string {
  if (!revision) return "missing";
  return [
    revision.path,
    revision.dev,
    revision.ino,
    revision.birthtimeMs,
    revision.size,
    revision.mtimeMs,
    revision.ctimeMs,
  ].join("\0");
}

/** Identity of the usage ledger file, excluding size/mtime/ctime so appends can share work. */
export function usageLogIdentityKey(revision: UsageLogRevision | null): string {
  if (!revision) return "missing";
  return [revision.path, revision.dev, revision.ino, revision.birthtimeMs].join("\0");
}

export function currentUsageLogRevision(): UsageLogRevision | null {
  const path = usageLogPath();
  if (!existsSync(path)) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    return usageLogRevision(path, fstatSync(fd));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function parseUsageTextCooperatively(text: string, signal: AbortSignal): Promise<{
  entries: PersistedUsageEntry[];
  entriesDropped: number;
  entryLengths: number[];
  /** Bytes of unparseable lines after the final accepted row. */
  trailingSkippedBytes: number;
  /** Bytes of rows removed by the entry cap, which move into the skipped prefix. */
  cappedPrefixBytes: number;
}> {
  // Split on "\n" only, so a CRLF line keeps its "\r" and its byte length stays exact.
  // Splitting on /\r?\n/ consumes two bytes but leaves no way to tell that it did, which
  // made the recorded lengths short by one byte per line on a CRLF ledger and failed the
  // accounting self-check. JSON.parse tolerates the trailing "\r".
  const lines = text.split("\n");
  usageReadCacheStats.parsedLines += lines.filter(line => line.trim()).length;
  const entries: PersistedUsageEntry[] = [];
  // Byte length of each accepted row including its newline, so a later read can trim
  // rows that fall out of the bounded window without re-reading the file.
  const entryLengths: number[] = [];
  const batchSize = 1_000;
  // Bytes of lines that did not yield an entry (malformed JSON, missing requestId, a
  // torn final write). They still occupy space in the file, so they are folded into the
  // next accepted row's recorded length. Dropping them would make the recorded lengths
  // sum to less than the real byte span, and the window trim -- which walks forward by
  // summing those lengths -- would consume extra rows to reach the window start,
  // silently hiding history and desynchronizing truncatedPrefixBytes.
  let pendingSkippedBytes = 0;
  for (let offset = 0; offset < lines.length; offset += batchSize) {
    if (signal.aborted) throw signal.reason;
    const batch = lines.slice(offset, offset + batchSize);
    for (let index = 0; index < batch.length; index++) {
      const line = batch[index]!;
      // The split leaves a trailing "" after the final newline; it occupies no bytes.
      const isLastLine = offset + index === lines.length - 1;
      const lineBytes = Buffer.byteLength(line, "utf-8") + (isLastLine && line === "" ? 0 : 1);
      const parsed = parseUsageLines([line]);
      if (parsed.length === 0) {
        pendingSkippedBytes += lineBytes;
        continue;
      }
      entries.push(parsed[0]!);
      entryLengths.push(lineBytes + pendingSkippedBytes);
      pendingSkippedBytes = 0;
    }
    if (offset + batchSize < lines.length) {
      // JSON parsing dominates large-log startup. Yield between bounded batches so
      // Bun can continue serving health and settings requests on the same thread.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  // Skipped bytes AFTER the last accepted row belong to no entry length, so report them
  // separately; the trim arithmetic adds them back to keep lengths summing to the span.
  const trailingSkippedBytes = pendingSkippedBytes;
  if (entries.length <= MANAGEMENT_USAGE_MAX_ENTRIES) {
    return { entries, entriesDropped: 0, entryLengths, trailingSkippedBytes, cappedPrefixBytes: 0 };
  }
  const entriesDropped = entries.length - MANAGEMENT_USAGE_MAX_ENTRIES;
  return {
    entries: entries.slice(-MANAGEMENT_USAGE_MAX_ENTRIES),
    entriesDropped,
    entryLengths: entryLengths.slice(-MANAGEMENT_USAGE_MAX_ENTRIES),
    trailingSkippedBytes,
    // Bytes of the rows the cap removed. The caller adds them to its skipped prefix so
    // the recorded lengths keep summing to the byte span they describe.
    cappedPrefixBytes: entryLengths
      .slice(0, entryLengths.length - MANAGEMENT_USAGE_MAX_ENTRIES)
      .reduce((total, length) => total + length, 0),
  };
}

async function readUsageEntriesFullCooperatively(
  path: string,
  signal: AbortSignal,
  maxReadBytes: number,
): Promise<ManagementUsageSnapshot> {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    const size = Number(stat.size);
    const start = Math.max(0, size - maxReadBytes);
    const chunks: Buffer[] = [];
    for (let position = start; position < size;) {
      if (signal.aborted) throw signal.reason;
      const length = Math.min(MANAGEMENT_USAGE_READ_CHUNK_BYTES, size - position);
      const chunk = readExactly(fd, length, position);
      if (chunk === null) throw new Error("usage log changed while it was being read");
      chunks.push(chunk);
      position += length;
    }
    let bytes = Buffer.concat(chunks);
    let truncatedPrefixBytes = start;
    if (start > 0) {
      const preceding = readExactly(fd, 1, start - 1);
      if (preceding === null) throw new Error("usage log changed while it was being read");
      if (preceding[0] !== 0x0a) {
        const newline = bytes.indexOf(0x0a);
        if (newline < 0) {
          truncatedPrefixBytes += bytes.byteLength;
          bytes = Buffer.alloc(0);
        } else {
          truncatedPrefixBytes += newline + 1;
          bytes = bytes.subarray(newline + 1);
        }
      }
    }
    const parsed = await parseUsageTextCooperatively(bytes.toString("utf-8"), signal);
    usageReadCacheStats.fullReads += 1;
    // Rows removed by the entry cap start the retained rows later in the file. That is
    // NOT byte-window truncation, so it must not move truncatedPrefixBytes -- the two
    // signals are independent in the API. It is tracked separately for the byte
    // accounting the incremental reader relies on.
    const rowsBeginAtBytes = truncatedPrefixBytes + parsed.cappedPrefixBytes;
    // Digest the exact prefix these rows describe, so a later incremental read can
    // prove the file was appended to rather than rewritten under the same inode.
    const prefixDigest = usageRegionDigest(fd, rowsBeginAtBytes, Number(stat.size));
    if (prefixDigest === null) throw new Error("usage log changed while it was being read");
    return {
      entries: parsed.entries,
      revision: usageLogRevision(path, stat),
      truncatedPrefixBytes,
      entriesTruncated: parsed.entriesDropped > 0,
      entriesDropped: parsed.entriesDropped,
      prefixDigest,
      entryLengths: parsed.entryLengths,
      trailingSkippedBytes: parsed.trailingSkippedBytes,
      rowsBeginAtBytes,
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Parse only the bytes appended since the retained snapshot's covered offset.
 *
 * Returns null when the retained snapshot cannot be extended safely — a different
 * identity or read window, a file that shrank (replacement/truncation), or a covered
 * offset that no longer sits on a record boundary. Callers then fall back to a full
 * bounded read.
 */
async function readUsageEntriesIncrementally(
  path: string,
  signal: AbortSignal,
  maxReadBytes: number,
  retained: RetainedUsageSnapshot,
): Promise<ManagementUsageSnapshot | null> {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    const revision = usageLogRevision(path, stat);
    if (usageLogIdentityKey(revision) !== retained.identityKey) return null;
    const size = Number(stat.size);
    // A shrink means truncation or replacement-in-place; the retained rows may no
    // longer correspond to file contents, so refuse to extend them.
    if (size < retained.coveredThroughBytes) return null;
    // Retained-state reuse is only an optimization. A burst larger than the configured
    // window must re-anchor through the bounded full-tail reader instead of reading and
    // parsing every byte appended since the previous poll.
    if (size - retained.coveredThroughBytes > maxReadBytes) return null;
    // Verify the retained REGION is unchanged before anything is reused. Identity keeps
    // dev/ino/birthtime, and an append and an in-place rewrite both move mtime/ctime
    // forward, so only the bytes themselves settle it.
    //
    // Only `truncatedPrefixBytes..coveredThroughBytes` is hashed: that is exactly the
    // span the retained rows were parsed from, and after trimming it is never wider than
    // maxReadBytes. Hashing from byte 0 instead would make every poll O(file) -- cheaper
    // than a reparse on a 245 MB ledger but MORE expensive past roughly 1-2 GB, turning
    // this optimization into a pessimization on exactly the growth curve an append-only
    // ledger follows. Bytes before the retained start are not described by any retained
    // row, so re-reading them proves nothing.
    const covered = usageRegionDigest(fd, retained.rowsBeginAtBytes, retained.coveredThroughBytes);
    if (covered === null || covered !== retained.prefixDigest) return null;
    // Read and parse ONLY the appended bytes.
    let appendedEntries: PersistedUsageEntry[] = [];
    let appendedLengths: number[] = [];
    let appendedDropped = 0;
    let appendedTrailingSkipped = retained.trailingSkippedBytes;
    if (size > retained.coveredThroughBytes) {
      // The covered offset must land immediately after a newline, or the retained rows
      // and the appended text do not join on a record boundary.
      if (retained.coveredThroughBytes > 0) {
        const preceding = readExactly(fd, 1, retained.coveredThroughBytes - 1);
        if (preceding === null || preceding[0] !== 0x0a) return null;
      }
      const chunks: Buffer[] = [];
      for (let position = retained.coveredThroughBytes; position < size;) {
        if (signal.aborted) throw signal.reason;
        const length = Math.min(MANAGEMENT_USAGE_READ_CHUNK_BYTES, size - position);
        const chunk = readExactly(fd, length, position);
        if (chunk === null) throw new Error("usage log changed while it was being read");
        chunks.push(chunk);
        position += length;
      }
      const appended = await parseUsageTextCooperatively(Buffer.concat(chunks).toString("utf-8"), signal);
      appendedEntries = appended.entries;
      appendedLengths = appended.entryLengths;
      appendedDropped = appended.entriesDropped;
      // A capped appended chunk is not joinable: its dropped rows sit between the
      // retained rows and the kept ones, so the lengths no longer describe a contiguous
      // span. Fall back to a full read.
      if (appended.cappedPrefixBytes > 0) return null;
      // If the appended chunk produced rows, its own trailing skipped bytes become the
      // new trailing remainder; otherwise the earlier remainder still stands and the new
      // skipped bytes add to it.
      appendedTrailingSkipped = appended.entries.length > 0
        ? appended.trailingSkippedBytes
        : retained.trailingSkippedBytes + appended.trailingSkippedBytes;
    }
    // Re-anchor the window in place. Rows that have fallen outside `size - maxReadBytes`
    // are dropped using their recorded byte lengths, so the result is exactly the rows a
    // fresh bounded read would load -- no superset, and truncatedPrefixBytes and
    // snapshotWindow keep describing the read honestly. Refusing here instead would make
    // this path dead code on any ledger past the window, which is precisely the case it
    // exists for.
    const windowStart = Math.max(0, size - maxReadBytes);
    let entries = retained.entries.concat(appendedEntries);
    // Skipped bytes trailing the retained rows sit BETWEEN them and the appended rows, so
    // they belong to the first appended row's span. Folding them in keeps the recorded
    // lengths summing to the true byte distance, which is what the trim walk relies on.
    const joinedLengths = appendedLengths.slice();
    if (retained.trailingSkippedBytes > 0 && joinedLengths.length > 0) {
      joinedLengths[0] = joinedLengths[0]! + retained.trailingSkippedBytes;
    }
    let lengths = retained.entryLengths.concat(joinedLengths);
    let rowsBeginAtBytes = retained.rowsBeginAtBytes;
    // Byte-window truncation advances ONLY here, so it stays exactly what a cold read of
    // this window reports. The entry cap below is entry-count truncation and must not
    // move it -- the two are independent signals in the API.
    let windowTruncatedBytes = retained.truncatedPrefixBytes;
    let dropIndex = 0;
    while (dropIndex < lengths.length && rowsBeginAtBytes < windowStart) {
      rowsBeginAtBytes += lengths[dropIndex]!;
      windowTruncatedBytes += lengths[dropIndex]!;
      dropIndex += 1;
    }
    // If every row is gone and a trailing unparseable remainder still sits before the
    // window start, nothing is left to advance the offset with: the retained span would
    // keep growing past maxReadBytes on each malformed-only append while the accounting
    // still balanced. Re-anchor with a full read instead.
    if (rowsBeginAtBytes < windowStart) return null;
    if (dropIndex > 0) {
      entries = entries.slice(dropIndex);
      lengths = lengths.slice(dropIndex);
    }
    let entriesDropped = retained.entriesDropped + appendedDropped;
    if (entries.length > MANAGEMENT_USAGE_MAX_ENTRIES) {
      // A cold read applies the entry cap to the whole window and reports byte
      // truncation for the window boundary alone. An incremental read arrives at the cap
      // by a different route and cannot reconstruct that ordering from retained state, so
      // continuing here would report a truncatedPrefixBytes that disagrees with a fresh
      // read of the same window. Re-anchor instead.
      //
      // This is reachable in production, not a theoretical branch: rows average ~118
      // bytes on a real ledger, so 500,000 of them occupy ~56 MiB and fit inside the
      // 64 MiB window. Both truncations can therefore apply at once.
      return null;
    }
    // The recorded lengths plus the trailing remainder must account for every byte from
    // the retained rows' start to EOF; if they do not, the lengths and the file have
    // diverged and the retained rows cannot be trusted.
    let accounted = appendedTrailingSkipped;
    for (const length of lengths) accounted += length;
    if (rowsBeginAtBytes + accounted !== size) return null;
    usageReadCacheStats.tailReads += 1;
    // Byte-window truncation is what the API reports, and it stays independent of
    // entry-count truncation. A cold read reports the record boundary it actually landed
    // on, which is where the rows begin MINUS whatever the entry cap removed -- the cap
    // is not window truncation. When nothing was skipped by the window at all, a cold
    // read reports 0.
    const truncatedPrefixBytes = windowTruncatedBytes;
    return {
      entries,
      revision,
      truncatedPrefixBytes,
      // ENTRY-count truncation only. Byte-window truncation is reported by
      // truncatedPrefixBytes, and the route ORs the two itself; folding bytes in here
      // would make a byte-truncated read claim rows were dropped when none were.
      entriesTruncated: entriesDropped > 0,
      entriesDropped,
      // The digest must describe exactly the region the returned rows came from, which
      // is the post-trim window, not the pre-trim one.
      prefixDigest: usageRegionDigest(fd, rowsBeginAtBytes, size) ?? "",
      entryLengths: lengths,
      trailingSkippedBytes: appendedTrailingSkipped,
      rowsBeginAtBytes,
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Management API reader: full parses yield between bounded batches and concurrent
 * callers share work when they observe the same ledger identity and byte window.
 * Appends keep that identity; replacements (inode/birthtime change) start a new flight.
 * The parsed tail is retained under the app-owned memory budget so an append reparses
 * only the appended bytes; the retained rows are evictable and are copied per caller.
 */
export async function readUsageSnapshotForManagement(maxReadBytes = MANAGEMENT_USAGE_MAX_READ_BYTES): Promise<{
  entries: PersistedUsageEntry[];
  revision: UsageLogRevision | null;
  truncatedPrefixBytes: number;
  entriesTruncated: boolean;
  entriesDropped: number;
}> {
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0) throw new RangeError("management usage max read bytes must be positive");
  const path = usageLogPath();
  if (!existsSync(path)) return { entries: [], revision: null, truncatedPrefixBytes: 0, entriesTruncated: false, entriesDropped: 0 };
  const observed = currentUsageLogRevision();
  const key = `${usageLogIdentityKey(observed)}\0${maxReadBytes}`;
  const observedSize = observed?.size ?? 0;
  const existing = managementUsageReadInflight;
  const replacement = Boolean(existing && observedSize < existing.openedSize);
  if (!replacement && existing?.key === key && Date.now() - existing.startedAt <= MANAGEMENT_USAGE_FLIGHT_STALE_MS) {
    const shared = await existing.promise;
    return { ...shared, entries: shared.entries.slice() };
  }
  if (existing && (existing.key !== key || replacement || Date.now() - existing.startedAt > MANAGEMENT_USAGE_FLIGHT_STALE_MS)) {
    existing.abort.abort(new Error("management usage read superseded"));
  } else if (existing) {
    const shared = await existing.promise;
    return { ...shared, entries: shared.entries.slice() };
  }
  const abort = new AbortController();
  const retained = retainedUsageSnapshot;
  const reusable = retained
    && retained.identityKey === usageLogIdentityKey(observed)
    && retained.maxReadBytes === maxReadBytes
      ? retained
      : null;
  const promise = (async (): Promise<ManagementUsageSnapshot> => {
    if (reusable) {
      const incremental = await readUsageEntriesIncrementally(path, abort.signal, maxReadBytes, reusable);
      if (incremental) return incremental;
      // The retained rows could not be extended safely; drop them before the full read
      // so a stale window is never combined with freshly parsed bytes.
      discardRetainedUsageSnapshot();
    }
    return readUsageEntriesFullCooperatively(path, abort.signal, maxReadBytes);
  })();
  managementUsageReadInflight = { key, openedSize: observedSize, promise, startedAt: Date.now(), abort };
  try {
    const snapshot = await promise;
    retainedUsageSnapshot = {
      identityKey: usageLogIdentityKey(snapshot.revision),
      maxReadBytes,
      coveredThroughBytes: snapshot.revision.size,
      prefixDigest: snapshot.prefixDigest,
      truncatedPrefixBytes: snapshot.truncatedPrefixBytes,
      entryLengths: snapshot.entryLengths,
      trailingSkippedBytes: snapshot.trailingSkippedBytes,
      rowsBeginAtBytes: snapshot.rowsBeginAtBytes,
      entries: snapshot.entries,
      entriesTruncated: snapshot.entriesTruncated,
      entriesDropped: snapshot.entriesDropped,
      revision: snapshot.revision,
      retainedAt: Date.now(),
      approxBytes: retainedUsageSnapshotBytes(snapshot.entries),
    };
    enforceAppOwnedMemoryBudget();
    return { ...snapshot, entries: snapshot.entries.slice() };
  } finally {
    if (managementUsageReadInflight?.promise === promise) managementUsageReadInflight = null;
  }
}

export async function readUsageEntriesForManagement(): Promise<PersistedUsageEntry[]> {
  return (await readUsageSnapshotForManagement()).entries;
}

/** Keep legacy optional fields permissive, but reject rows that cannot be safely attributed. */
export function normalizePersistedUsageRow(value: unknown): PersistedUsageEntry | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.requestId !== "string" || typeof row.provider !== "string") return undefined;
  return normalizeUsageEntry(row as unknown as PersistedUsageEntry);
}

export function readUsageEntries(): PersistedUsageEntry[] {
  const path = usageLogPath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  const entries: PersistedUsageEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = normalizePersistedUsageRow(JSON.parse(line));
      if (parsed) entries.push(parsed);
    } catch {
      /* keep reading after a partially written or hand-edited line */
    }
  }
  return entries;
}

function parseUsageLines(lines: string[]): PersistedUsageEntry[] {
  const entries: PersistedUsageEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = normalizePersistedUsageRow(JSON.parse(line));
      if (parsed) entries.push(parsed);
    } catch {
      /* skip partial / hand-edited lines */
    }
  }
  return entries;
}

/**
 * Read only the newest `limit` usage.jsonl rows without loading the whole append-only
 * file into memory. Used by request-log hydration on `ocx start`.
 */
export function readRecentUsageEntries(limit: number, configDir?: string): PersistedUsageEntry[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const path = usageLogPath(configDir);
  if (!existsSync(path)) return [];
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size <= 0) return [];
    // Trace-sized rows need a larger per-row budget than the pre-trace ledger,
    // but startup hydration must never grow into an unbounded whole-file read.
    const maxWindowBytes = Math.min(size, RECENT_USAGE_MAX_READ_BYTES);
    let windowBytes = Math.min(maxWindowBytes, Math.max(64 * 1024, Math.ceil(limit) * 20 * 1024));
    while (true) {
      const start = Math.max(0, size - windowBytes);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString("utf-8");
      if (start > 0) {
        const nl = text.indexOf("\n");
        if (nl < 0) {
          if (start === 0 || windowBytes >= maxWindowBytes) break;
          windowBytes = Math.min(maxWindowBytes, windowBytes * 4);
          continue;
        }
        text = text.slice(nl + 1);
      }
      const lines = text.split(/\r?\n/).filter(line => line.trim());
      // Parse ALL lines first, then take the last N valid entries. This way corrupt
      // or partial lines are filtered out during parsing and we always return the
      // most recent N valid rows (not N physical lines minus corrupt ones).
      const entries = parseUsageLines(lines);
      if (entries.length >= limit || start === 0 || windowBytes >= maxWindowBytes) return entries.slice(-limit);
      windowBytes = Math.min(maxWindowBytes, windowBytes * 4);
    }
    return [];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}
