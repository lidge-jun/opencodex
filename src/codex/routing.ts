import { randomUUID } from "node:crypto";
import { saveConfigPreservingClaudeCode } from "../config";
import { isCodexAccountGenerationLive, readCodexAccountRecord } from "./account-store";
import { codexAccountLogLabel } from "./account-label";
import { isCodexAccountPaused } from "./account-pause";
import { clearCodexAccountPin, codexAccountPriorityLookup, pinnedCodexAccountId } from "./account-priority";
import { isCodexAccountUsable, type CodexAccountUsabilityOptions } from "./account-usability";
import { clearAccountNeedsReauth, isAccountNeedsReauth, markAccountNeedsReauth } from "./account-runtime-state";
import {
  POOL_KEY_CODEX,
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  notePoolRotationFailure,
  notePoolRotationSuccess,
  peekRoundRobinAccount,
  pickRoundRobinAccount,
  seedPoolRotationAccount,
  selectPriorityTier,
} from "./pool-rotation";
import { CODEX_EXHAUSTED_USAGE_PERCENT, CODEX_UNKNOWN_USAGE_SCORE, getAccountQuota } from "./quota";
import { isThirtyDayOnlyCodexPlan } from "./plan";
import {
  MAIN_CODEX_ACCOUNT_ID,
  getMainAccountPlan,
  hasMainAccountRefreshGrant,
} from "./main-account";
import { isSelectableCodexPoolAccount } from "./account-id";
import type { OcxConfig } from "../types";
import { captureConfigGeneration, type GenerationContext } from "../lib/state-store-sweeper";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { retainedUtf8Bytes } from "../lib/admission";
import { recordUpstreamHostFailure } from "./upstream-host-health";

type ThreadAffinityEntry = {
  accountId: string;
  generation: number;
  createdAt: number;
  lastUsedAt: number;
  // Last time the bound account's quota threshold was re-evaluated for this
  // thread (interval-gated to avoid per-request flapping). See REEVAL_INTERVAL_MS.
  lastReevalAt: number;
};

export type CodexThreadResolution =
  | { status: "selected"; accountId: string }
  | { status: "none" }
  | { status: "expired"; accountId: string };

/**
 * Process-local cursor for automatic RR/fill-first (and quota-429 when not
 * sync-writing) picks. Keeps unrelated `saveConfig` from persisting transient
 * rotation as the operator's `activeCodexAccountId`. Manual selection clears it
 * so disk/`config.activeCodexAccountId` remains authoritative.
 */
let runtimeActiveCodexAccountId: string | undefined;

type CodexUpstreamHealth = {
  consecutiveFailures: number;
  /** Consecutive healthy terminals observed while recovering from escalation level 2+. */
  consecutiveSuccesses?: number;
  lastFailureStatus?: number;
  lastFailureAt?: number;
  /** Hard cooldown (quota 429). Survives a later 2xx; blocks auth + selection. */
  cooldownUntil?: number;
  /** When the current cooldown was recorded; origin of the probe interval clock. */
  cooldownSince?: number;
  /**
   * What produced the cooldown. An explicit Retry-After is a literal retry
   * directive and is never probed; a quota resetAt only announces a window
   * refresh, so it may be probed early (#433).
   */
  cooldownSource?: CodexCooldownSource;
  /**
   * Bumped on every cooldown write. A probe lease records the generation it was
   * issued for so a lease cannot clear a cooldown that a later 429 replaced.
   */
  cooldownGeneration?: number;
  /**
   * Identity of the in-flight probe. A cooled-down account sends no traffic, so
   * no organic 2xx can prove recovery; only the outcome carrying this id may
   * clear the cooldown.
   */
  probeLeaseId?: string;
  /** Cooldown generation at the moment the lease was granted. */
  probeLeaseGeneration?: number;
  /** Last probe grant or conclusion; paces the probe interval. */
  lastProbeAt?: number;
  /**
   * Soft avoid after connect_error / timeout / transient 5xx. Cleared on 2xx.
   * Blocks pool selection + thread affinity reuse so a sticky session can leave a
   * flaky account without throwing CodexAccountCooldownError (hard-only).
   */
  softAvoidUntil?: number;
  /**
   * Credential generation a 401/403 quarantine was derived from (#2892 gap 4).
   *
   * Provenance lives ON the entry rather than in a side map keyed by account id. A side map spends
   * "whatever health is current when the old credential is found dead", which deletes a later
   * unrelated entry: a G1 401, then a G2 save, then a genuine G2 503 would lose the 503. Only the
   * entry that carries this field can be spent, and any later write simply replaces it.
   */
  credentialFailureGeneration?: number;
};

const CODEX_DEFAULT_QUOTA_COOLDOWN_MS = 60_000;
const CODEX_MAX_QUOTA_COOLDOWN_MS = 24 * 60 * 60_000;
/**
 * A weekly/monthly quota `resetAt` announces when the window refreshes; it is not
 * a "come back after this" directive like Retry-After. Plan quota routinely frees
 * up long before the advertised reset, so cap reset-derived cooldowns far below
 * the Retry-After ceiling (#433).
 */
const CODEX_MAX_RESET_DERIVED_COOLDOWN_MS = 15 * 60_000;
/** Minimum gap between probe leases for one cooled-down account. */
export const CODEX_QUOTA_PROBE_INTERVAL_MS = 5 * 60_000;
export const CODEX_FAILURE_WINDOW_MS = 5 * 60_000;
/** How long a transient failure keeps the account out of pool selection. */
export const CODEX_TRANSIENT_SOFT_AVOID_MS = 30_000;
const CODEX_TRANSIENT_SOFT_AVOID_ESCALATION_MS = [
  CODEX_TRANSIENT_SOFT_AVOID_MS,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
] as const;
export const CODEX_THREAD_AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
export const CODEX_THREAD_AFFINITY_MAX_ENTRIES = 2048;
const MAX_AFFINITY_COMPONENT_BYTES = 512;
// Min interval between quota threshold re-evaluations for a single bound thread.
// Well under the 5h/weekly quota windows, but enough to stop per-request flapping.
export const CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS = 60_000;

const upstreamHealth = new Map<string, CodexUpstreamHealth>();
/**
 * Reset-derived 429s can describe a quota owned by one native model family,
 * rather than the whole ChatGPT account. Keep those advisory cooldowns apart
 * from account-wide Retry-After/default throttles and transient health.
 */
const quotaScopedHealth = new Map<string, Map<CodexQuotaScope, CodexUpstreamHealth>>();
/**
 * Spend a credential-failure health entry whose credential no longer exists (#2892 gap 4).
 *
 * A 401/403 describes one CREDENTIAL, not an account, and a replacement can land at any point after
 * the outcome is recorded — so re-reading the store inside `recordCodexUpstreamOutcome` narrows the
 * window without closing it. The reader decides instead, and it may only spend an entry that
 * actually carries credential provenance: a later transient or quota write replaces the entry and
 * with it the tag, so this can never delete evidence that belongs to a different failure.
 */
function dropSpentCredentialFailure(accountId: string): void {
  const health = upstreamHealth.get(accountId);
  const generation = health?.credentialFailureGeneration;
  if (health === undefined || generation === undefined) return;
  if (isCodexAccountGenerationLive(accountId, generation)) return;
  upstreamHealth.delete(accountId);
}
let lastReconciledGeneration = 0;
let liveHealthAccountIds = new Set<string>();

export type CodexUpstreamOutcome = number | "connect_error" | "timeout" | "connect_neutral";
export type CodexUpstreamOutcomeClass = "success" | "credential"
  | "workspace" | "quota" | "transient" | "caller" | "neutral" | "unknown";
export type CodexCooldownSource = "retry-after" | "reset-derived" | "default";
/**
 * Native Codex quota groups known to be independent upstream. Keep the mapping
 * deliberately conservative: unlisted models share the normal native group.
 * Add a new explicit group here only when its independent upstream quota is
 * confirmed, so shared limits never receive cross-model bypasses.
 */
export type CodexQuotaScope = "shared" | "spark";

export type CodexQuotaRecoveryProbeClaim = {
  accountId: string;
  scope?: CodexQuotaScope;
  leaseId: string;
  cooldownGeneration: number;
  credentialGeneration: number;
  /** Claim-time `replacedAt`; unchanged after a probe-owned refresh, stamped on external replacement. */
  credentialReplacedAt?: number;
};

export type CodexQuotaRecoveryProbeProof = {
  credentialGeneration?: number;
};

/**
 * Requests without a resolved native model retain the historic one-account-per-
 * thread behavior. Requests with a known quota scope get an independent
 * affinity so a Spark failover cannot displace the same thread's Terra/Luna
 * account (and vice versa).
 */
type BaseThreadAffinityScope = CodexQuotaScope | "legacy";
type ModelDetourAffinityScope = `model-detour:${BaseThreadAffinityScope}:${string}`;
type ThreadAffinityScope = BaseThreadAffinityScope | ModelDetourAffinityScope;
const LEGACY_THREAD_AFFINITY_SCOPE = "legacy" as const;
const threadAccountMap = new Map<string, Map<ThreadAffinityScope, ThreadAffinityEntry>>();
let threadAffinityEntryTotal = 0;

function isModelDetourAffinityScope(scope: ThreadAffinityScope): scope is ModelDetourAffinityScope {
  return scope.startsWith("model-detour:");
}

const NATIVE_MODEL_QUOTA_SCOPES: Readonly<Record<string, CodexQuotaScope>> = {
  "gpt-5.3-codex-spark": "spark",
};

export function codexQuotaScopeForModel(modelId: string | undefined): CodexQuotaScope | undefined {
  if (!modelId?.trim()) return undefined;
  return NATIVE_MODEL_QUOTA_SCOPES[modelId.trim().toLowerCase()] ?? "shared";
}

/** Independent quota groups must not mutate the shared active-account cursor. */
function isIndependentCodexQuotaScope(quotaScope?: CodexQuotaScope): boolean {
  return quotaScope !== undefined && quotaScope !== "shared";
}

function codexPoolKeyForScope(quotaScope?: CodexQuotaScope): string {
  return isIndependentCodexQuotaScope(quotaScope) ? `${POOL_KEY_CODEX}:${quotaScope}` : POOL_KEY_CODEX;
}

export type CodexUpstreamOutcomeMeta = {
  retryAfter?: string | null;
  resetAt?: unknown | unknown[];
  now?: number;
  /** (provider, host) ledger key for account-neutral reachability failures (#914). */
  hostKey?: string;
  /**
   * Upstream denial evidence for a 403. A workspace/entitlement denial means the CREDENTIAL
   * is fine and the account simply cannot reach this workspace, so it must not be quarantined
   * for reauthentication (#1789). Absent evidence keeps the historical credential handling.
   */
  denial?: "workspace" | "entitlement";
  /** Stable transport code recorded alongside a neutral host failure. */
  lastFailureCode?: string;
  /** Native model selected for this request; used only for confirmed scoped quotas. */
  modelId?: string;
  /** When set, clears affinity for this thread immediately on transient failure. */
  threadId?: string | null;
  /**
   * Suppress Pool rotation and quota/transient affinity mutations for an account-qualified
   * request. Credential failures still sweep stale affinities because reauthentication is
   * account-wide.
   */
  fixedAccount?: boolean;
  /**
   * Probe lease held by this request, when it was admitted through an active
   * quota cooldown. Only the outcome carrying the current lease may clear the
   * cooldown (#433).
  */
  probeLeaseId?: string;
  /** Scope of `probeLeaseId` when it was granted against a model-scoped cooldown. */
  probeQuotaScope?: CodexQuotaScope;
  /**
   * Already-chosen alternate for same-request 429 retry. When set, promotion
   * reuses this account instead of calling {@link pickAlternateCodexAccount}
   * again (which would advance a round-robin ring twice).
   */
  promoteAccountId?: string;
  /** Generation captured when this routed account was selected. */
  writerGeneration?: number;
  /**
   * Credential generation this request's bearer was read at. Distinct from
   * `writerGeneration`, which tracks the config store.
   *
   * A 401 that arrives after the credential was already replaced is evidence about a
   * token nobody is using any more, so it must not quarantine the replacement. Absent
   * means the caller cannot supply lineage and the historical unfenced handling stands.
   */
  credentialGeneration?: number;
};

function hasConfiguredPoolAccount(
  config: OcxConfig,
  accountId: string,
  selectionOptions?: CodexAccountUsabilityOptions,
): boolean {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    return isCodexAccountUsable(config, accountId, selectionOptions);
  }
  return (config.codexAccounts ?? [])
    .some(account => isSelectableCodexPoolAccount(account) && account.id === accountId);
}

export function listLiveCodexAccountIds(config: OcxConfig): ReadonlySet<string> {
  const ids = new Set((config.codexAccounts ?? []).map(account => account.id));
  const openai = config.providers.openai;
  if (openai && openai.disabled !== true && isCanonicalOpenAiForwardProvider(openai)) {
    ids.add(MAIN_CODEX_ACCOUNT_ID);
  }
  return ids;
}

export function clearThreadAccountMap(): void {
  threadAccountMap.clear();
  threadAffinityEntryTotal = 0;
}

export function clearThreadAccountMapForAccount(accountId: string): void {
  for (const [threadId, affinities] of threadAccountMap) {
    for (const [scope, entry] of affinities) {
      if (entry.accountId === accountId && affinities.delete(scope)) {
        threadAffinityEntryTotal = Math.max(0, threadAffinityEntryTotal - 1);
      }
    }
    if (affinities.size === 0) threadAccountMap.delete(threadId);
  }
}

export function clearCodexUpstreamHealth(): void {
  upstreamHealth.clear();
  quotaScopedHealth.clear();
  runtimeActiveCodexAccountId = undefined;
}

export function clearCodexUpstreamHealthForAccount(accountId: string): void {
  upstreamHealth.delete(accountId);
  quotaScopedHealth.delete(accountId);
}

export function reconcileCodexRoutingHealth(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  let removed = 0;
  for (const accountId of upstreamHealth.keys()) {
    if (context.codexAccountIds.has(accountId)) continue;
    upstreamHealth.delete(accountId);
    removed += 1;
  }
  for (const accountId of quotaScopedHealth.keys()) {
    if (context.codexAccountIds.has(accountId)) continue;
    quotaScopedHealth.delete(accountId);
    removed += 1;
  }
  liveHealthAccountIds = new Set(context.codexAccountIds);
  lastReconciledGeneration = context.generation;
  return removed;
}

export function getCodexUpstreamHealth(
  accountId: string,
): CodexUpstreamHealth | null {
  dropSpentCredentialFailure(accountId);
  return upstreamHealth.get(accountId) ?? null;
}

function scopedHealthFor(accountId: string, scope: CodexQuotaScope): CodexUpstreamHealth | undefined {
  return quotaScopedHealth.get(accountId)?.get(scope);
}

function setScopedHealth(accountId: string, scope: CodexQuotaScope, health: CodexUpstreamHealth): void {
  let scopes = quotaScopedHealth.get(accountId);
  if (!scopes) {
    scopes = new Map();
    quotaScopedHealth.set(accountId, scopes);
  }
  scopes.set(scope, health);
}

function deleteScopedHealth(accountId: string, scope: CodexQuotaScope): void {
  const scopes = quotaScopedHealth.get(accountId);
  if (!scopes) return;
  scopes.delete(scope);
  if (scopes.size === 0) quotaScopedHealth.delete(accountId);
}

export function computeCodexUsageScore(quota: {
  weeklyPercent?: number;
  monthlyPercent?: number;
  shortPercent?: number;
  shortResetAt?: number;
} | null, plan?: unknown, now: number = Date.now()): number {
  if (!quota) return CODEX_UNKNOWN_USAGE_SCORE;
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const longWindows = isThirtyDayOnlyCodexPlan(plan)
    ? [quota.monthlyPercent]
    : [quota.weeklyPercent, quota.monthlyPercent];
  const knownLong = longWindows.filter(finite);
  // The short burst window only REFINES a known long-window position; it cannot stand in for
  // one. A snapshot carrying just `shortPercent: 0` would otherwise score a flat 0 and make an
  // account whose weekly/monthly usage is entirely unverified look like the emptiest in the
  // pool, so `pickLowestUsageAmong` would send every request to it. Unknown has to stay
  // unknown until a governing window is actually observed.
  //
  // A FULL burst window is the exception (#3029). It is not an optimistic guess about an
  // unobserved window — it is a direct observation that the account cannot serve a request
  // right now, whatever its monthly position turns out to be. Unknown-means-selectable is
  // correct for uncertainty and wrong for a measured refusal: the account stays selected,
  // `applyQuotaAutoSwitch` never fires, and the pool wedges on an exhausted credential.
  if (knownLong.length === 0) {
    return isTerminalShortWindow(quota, now) ? CODEX_EXHAUSTED_USAGE_PERCENT : CODEX_UNKNOWN_USAGE_SCORE;
  }
  const values = finite(quota.shortPercent) ? [...knownLong, quota.shortPercent] : knownLong;
  return Math.max(...values);
}

/**
 * A short-only reading that proves the account is blocked NOW.
 *
 * Freshness is not optional. `getAccountQuota` performs no expiry check, partial updates
 * carry the old short tuple forward, and disk hydration accepts a persisted reading for
 * hours — so scoring 100 from `shortPercent` alone would keep excluding an account whose
 * five-hour window has since reset. That is #3029 pointed the other way: the issue is that
 * an exhausted account stays selected, and "a recovered account stays excluded" trades one
 * unusable pool for another.
 *
 * A reading with no `shortResetAt` cannot be aged, so it stays unknown. The conservative
 * direction here is the one that keeps an account selectable: a wrongly-selected account
 * fails one request, while a wrongly-excluded one is invisible until someone reads the pool
 * by hand.
 */
function isTerminalShortWindow(
  quota: { shortPercent?: number; shortResetAt?: number },
  now: number,
): boolean {
  if (typeof quota.shortPercent !== "number" || !Number.isFinite(quota.shortPercent)) return false;
  if (quota.shortPercent < CODEX_EXHAUSTED_USAGE_PERCENT) return false;
  const resetAt = quota.shortResetAt;
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= 0) return false;
  // Both units reach storage: `normalizeResetAt` does not scale, and the GUI disambiguates
  // by magnitude at read time. A comparison written against one assumption is off by 1000x
  // against the other, and in the seconds-read-as-milliseconds direction every terminal
  // reading looks like it reset in 1970 — a fix that passes its own test and does nothing.
  const resetAtMs = resetAt < 10_000_000_000 ? resetAt * 1000 : resetAt;
  return resetAtMs > now;
}

export function classifyCodexUpstreamOutcome(
  outcome: CodexUpstreamOutcome,
  denial?: "workspace" | "entitlement",
): CodexUpstreamOutcomeClass {
  if (outcome === "connect_neutral") return "neutral";
  if (outcome === "connect_error" || outcome === "timeout") return "transient";
  if (!Number.isFinite(outcome)) return "unknown";
  if (outcome >= 200 && outcome < 300) return "success";
  // Explicit 3xx policy (#914): a redirect response is relayed as-is and is
  // never account or host health evidence — it proves the host is reachable
  // and says nothing about the credential. Relayed as the neutral class so a
  // stray 3xx cannot increment an account's transient streak.
  if (outcome >= 300 && outcome < 400) return "neutral";
  // 401 is always a credential problem. A 403 is only a credential problem when nothing
  // tells us otherwise: a workspace/entitlement denial (#1789) means the credential is valid
  // and the account simply lacks access here, so quarantining it for reauth is wrong advice.
  // Absent denial evidence the historical mapping stands, so the change fails safe.
  if (outcome === 403 && denial !== undefined) return "workspace";
  if (outcome === 401 || outcome === 403) return "credential";
  // 402 Payment Required is treated as quota exhaustion for pool cooldown/failover
  // (same-request alternate retry records this outcome for the depleted account).
  if (outcome === 429 || outcome === 402) return "quota";
  if (outcome >= 400 && outcome < 500) return "caller";
  if (outcome >= 500 && outcome < 600) return "transient";
  return "unknown";
}

function clampCooldownMs(ms: number): number {
  return Math.min(Math.max(ms, 1), CODEX_MAX_QUOTA_COOLDOWN_MS);
}

export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds > 0) return clampCooldownMs(Math.ceil(seconds * 1000));
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = timestamp - now;
  return delay > 0 ? clampCooldownMs(delay) : undefined;
}

function resetTimestampMs(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : undefined;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric <= 0) return undefined;
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

export function parseResetCooldownMs(resetAt: unknown | unknown[] | undefined, now = Date.now()): number | undefined {
  const values = Array.isArray(resetAt) ? resetAt : [resetAt];
  let best: number | undefined;
  for (const value of values) {
    const timestamp = resetTimestampMs(value);
    if (timestamp === undefined) continue;
    const delay = timestamp - now;
    if (delay <= 0) continue;
    // A far-future reset must not pin the account for the full Retry-After
    // ceiling: quota usually frees up well before the advertised window (#433).
    const clamped = Math.min(clampCooldownMs(delay), CODEX_MAX_RESET_DERIVED_COOLDOWN_MS);
    if (best === undefined || clamped < best) best = clamped;
  }
  return best;
}

export function computeQuotaCooldown(meta: CodexUpstreamOutcomeMeta = {}): {
  until: number;
  source: CodexCooldownSource;
} {
  const now = meta.now ?? Date.now();
  const retryAfterMs = parseRetryAfterMs(meta.retryAfter, now);
  if (retryAfterMs !== undefined) return { until: now + retryAfterMs, source: "retry-after" };
  const resetCooldownMs = parseResetCooldownMs(meta.resetAt, now);
  if (resetCooldownMs !== undefined) return { until: now + resetCooldownMs, source: "reset-derived" };
  return { until: now + CODEX_DEFAULT_QUOTA_COOLDOWN_MS, source: "default" };
}

export function computeQuotaCooldownUntil(meta: CodexUpstreamOutcomeMeta = {}): number {
  return computeQuotaCooldown(meta).until;
}

/**
 * Grant at most one probe lease per interval for a cooled-down account.
 *
 * A cooled-down account is short-circuited locally, so it never sends traffic and
 * no organic 2xx can prove that upstream quota recovered — the cooldown can only
 * end by expiry or a proxy restart (#433). Releasing a single probe breaks that
 * deadlock. Explicit Retry-After cooldowns are excluded: those are literal retry
 * directives, not window announcements.
 *
 * Returns the lease id, or null when no probe may go out right now.
 */
export function tryAcquireCodexQuotaProbeLease(accountId: string, now = Date.now()): string | null {
  if (!canAcquireCodexQuotaProbeLease(accountId, now)) return null;
  const health = upstreamHealth.get(accountId)!;
  const probeLeaseId = randomUUID();
  upstreamHealth.set(accountId, {
    ...health,
    probeLeaseId,
    probeLeaseGeneration: health.cooldownGeneration ?? 0,
    lastProbeAt: now,
  });
  return probeLeaseId;
}

/** Side-effect-free check mirroring {@link tryAcquireCodexQuotaProbeLease} eligibility. */
export function canAcquireCodexQuotaProbeLease(accountId: string, now = Date.now()): boolean {
  return canAcquireQuotaProbeLease(upstreamHealth.get(accountId), now);
}

function canAcquireQuotaProbeLease(health: CodexUpstreamHealth | undefined, now: number): boolean {
  if (!health) return false;
  const cooldownUntil = health.cooldownUntil;
  if (typeof cooldownUntil !== "number" || !Number.isFinite(cooldownUntil) || cooldownUntil <= now) return false;
  if (health.cooldownSource === "retry-after") return false;
  if (health.probeLeaseId !== undefined) return false;
  const origin = health.lastProbeAt ?? health.cooldownSince ?? cooldownUntil;
  return now - origin >= CODEX_QUOTA_PROBE_INTERVAL_MS;
}

/**
 * Claim due reset-derived cooldown probes without consulting account selection.
 * Pool credentials only: the main account has no quota-refresh single-flight.
 */
export function claimDueCodexQuotaRecoveryProbes(
  config: OcxConfig,
  limit: number,
  now = Date.now(),
): CodexQuotaRecoveryProbeClaim[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];
  const candidates: Array<{
    accountId: string;
    scope?: CodexQuotaScope;
    health: CodexUpstreamHealth;
    credentialGeneration: number;
    credentialReplacedAt?: number;
    order: number;
  }> = [];
  for (const [order, account] of (config.codexAccounts ?? []).entries()) {
    if (!isSelectableCodexPoolAccount(account)
      || isCodexAccountPaused(config, account.id)
      || isAccountNeedsReauth(account.id)) continue;
    const record = readCodexAccountRecord(account.id);
    if (!record?.credential || record.deletedAt != null) continue;
    const due = [
      { scope: undefined, health: upstreamHealth.get(account.id) },
      ...[...(quotaScopedHealth.get(account.id) ?? [])].map(([scope, health]) => ({ scope, health })),
    ].filter((entry): entry is { scope?: CodexQuotaScope; health: CodexUpstreamHealth } =>
      // `spark` is deliberately never claimed. `GET /backend-api/wham/usage` takes no scope
      // parameter and returns generic weekly/monthly windows, so its result can never prove a
      // spark recovery — a claim here would spend an upstream call to settle `false` every
      // time, and (with one claim per account per pass) delay the shared scope that CAN recover.
      entry.scope !== "spark"
      && entry.health?.cooldownSource === "reset-derived"
      && canAcquireQuotaProbeLease(entry.health, now))
      .sort((a, b) =>
        (a.health.lastProbeAt ?? a.health.cooldownSince ?? 0)
        - (b.health.lastProbeAt ?? b.health.cooldownSince ?? 0));
    const candidate = due[0];
    if (candidate) candidates.push({
      accountId: account.id,
      ...(candidate.scope ? { scope: candidate.scope } : {}),
      health: candidate.health,
      credentialGeneration: record.generation,
      ...(record.replacedAt !== undefined ? { credentialReplacedAt: record.replacedAt } : {}),
      order,
    });
  }
  candidates.sort((a, b) => {
    const age = (a.health.lastProbeAt ?? a.health.cooldownSince ?? 0)
      - (b.health.lastProbeAt ?? b.health.cooldownSince ?? 0);
    return age || a.order - b.order;
  });
  return candidates.slice(0, boundedLimit).map(candidate => {
    const leaseId = randomUUID();
    const next = {
      ...candidate.health,
      probeLeaseId: leaseId,
      probeLeaseGeneration: candidate.health.cooldownGeneration ?? 0,
      lastProbeAt: now,
    };
    if (candidate.scope) setScopedHealth(candidate.accountId, candidate.scope, next);
    else upstreamHealth.set(candidate.accountId, next);
    return {
      accountId: candidate.accountId,
      ...(candidate.scope ? { scope: candidate.scope } : {}),
      leaseId,
      cooldownGeneration: candidate.health.cooldownGeneration ?? 0,
      credentialGeneration: candidate.credentialGeneration,
      ...(candidate.credentialReplacedAt !== undefined
        ? { credentialReplacedAt: candidate.credentialReplacedAt }
        : {}),
    };
  });
}

/** Settle one background recovery claim without mutating account-wide outcome state. */
export function settleCodexQuotaRecoveryProbe(
  claim: CodexQuotaRecoveryProbeClaim,
  recovered: boolean,
  proof: CodexQuotaRecoveryProbeProof,
  now = Date.now(),
): boolean {
  const health = claim.scope
    ? scopedHealthFor(claim.accountId, claim.scope)
    : upstreamHealth.get(claim.accountId);
  if (!health || health.probeLeaseId !== claim.leaseId) return false;
  const currentRecord = readCodexAccountRecord(claim.accountId);
  const proofGeneration = proof.credentialGeneration;
  // A probe-owned token refresh (getValidCodexToken) advances the credential generation by
  // exactly one while preserving `replacedAt`; an external credential replacement bumps the
  // generation too but stamps a fresh `replacedAt`. Accept the +1 transition only when the
  // claim-time lineage is intact AND the generation the fresh quota was proven under is live.
  const generationFenced = proofGeneration !== undefined
    && (proofGeneration === claim.credentialGeneration
      ? isCodexAccountGenerationLive(claim.accountId, proofGeneration)
      : proofGeneration === claim.credentialGeneration + 1
        && currentRecord?.replacedAt === claim.credentialReplacedAt
        && isCodexAccountGenerationLive(claim.accountId, proofGeneration));
  const fenced = (health.cooldownGeneration ?? 0) === claim.cooldownGeneration
    && (health.probeLeaseGeneration ?? 0) === claim.cooldownGeneration
    && generationFenced;
  if (!recovered || !fenced) {
    const released = withProbeLeaseReleased(health, now);
    if (claim.scope) setScopedHealth(claim.accountId, claim.scope, released);
    else upstreamHealth.set(claim.accountId, released);
    return false;
  }
  if (claim.scope) {
    deleteScopedHealth(claim.accountId, claim.scope);
  } else {
    const {
      cooldownUntil: _until,
      cooldownSince: _since,
      cooldownSource: _source,
      probeLeaseId: _leaseId,
      probeLeaseGeneration: _leaseGeneration,
      ...rest
    } = health;
    upstreamHealth.set(claim.accountId, {
      ...rest,
      cooldownGeneration: claim.cooldownGeneration + 1,
      lastProbeAt: now,
    });
  }
  return true;
}

/** Acquire the recovery probe for one confirmed model-specific quota group. */
export function tryAcquireCodexQuotaScopeProbeLease(
  accountId: string,
  scope: CodexQuotaScope,
  now = Date.now(),
): string | null {
  const health = scopedHealthFor(accountId, scope);
  if (!canAcquireQuotaProbeLease(health, now)) return null;
  const probeLeaseId = randomUUID();
  setScopedHealth(accountId, scope, {
    ...health!,
    probeLeaseId,
    probeLeaseGeneration: health!.cooldownGeneration ?? 0,
    lastProbeAt: now,
  });
  return probeLeaseId;
}

/** Side-effect-free check for a confirmed model-specific quota probe. */
export function canAcquireCodexQuotaScopeProbeLease(
  accountId: string,
  scope: CodexQuotaScope,
  now = Date.now(),
): boolean {
  return canAcquireQuotaProbeLease(scopedHealthFor(accountId, scope), now);
}

/**
 * Hand a probe lease back without recording an upstream outcome. Used by paths
 * that take a lease and then fail before any request reaches upstream.
 */
export function releaseCodexQuotaProbeLease(accountId: string, leaseId: string, now = Date.now()): void {
  const health = upstreamHealth.get(accountId);
  if (!health || health.probeLeaseId !== leaseId) return;
  upstreamHealth.set(accountId, withProbeLeaseReleased(health, now));
}

/** Release a model-specific quota probe when the request never reaches upstream. */
export function releaseCodexQuotaScopeProbeLease(
  accountId: string,
  scope: CodexQuotaScope,
  leaseId: string,
  now = Date.now(),
): void {
  const health = scopedHealthFor(accountId, scope);
  if (!health || health.probeLeaseId !== leaseId) return;
  setScopedHealth(accountId, scope, withProbeLeaseReleased(health, now));
}

/**
 * True when this outcome belongs to the account's in-flight probe. The
 * undefined-id guard matters: without it an outcome carrying no lease would match
 * an account holding no lease and be mistaken for the probe owner.
 */
function ownsProbeLease(health: CodexUpstreamHealth | undefined, meta: CodexUpstreamOutcomeMeta): boolean {
  return meta.probeLeaseId !== undefined && meta.probeLeaseId === health?.probeLeaseId;
}

/**
 * True when the owning probe may still clear the cooldown. A later 429 bumps the
 * generation, so a probe that started under an older cooldown must not erase the
 * newer restriction (which may carry an explicit Retry-After).
 */
function probeMayClearCooldown(health: CodexUpstreamHealth | undefined, meta: CodexUpstreamOutcomeMeta): boolean {
  return ownsProbeLease(health, meta)
    && (health!.probeLeaseGeneration ?? 0) === (health!.cooldownGeneration ?? 0);
}

/** Strip the in-flight lease while preserving every hard-cooldown field. */
function withProbeLeaseReleased(health: CodexUpstreamHealth, now: number): CodexUpstreamHealth {
  const { probeLeaseId: _id, probeLeaseGeneration: _gen, ...rest } = health;
  return { ...rest, lastProbeAt: now };
}

/**
 * Hard-cooldown bookkeeping that ordinary success/transient transitions rebuild
 * their health object from. Dropping these would let one late unrelated response
 * erase a Retry-After source, a cooldown generation, or someone else's live probe.
 */
function preservedCooldownFields(health: CodexUpstreamHealth | undefined): Partial<CodexUpstreamHealth> {
  if (!health) return {};
  // `credentialFailureGeneration` is provenance for ONE credential failure, so it must not survive
  // into a later transient or quota entry — otherwise that entry inherits the tag and gets spent
  // when the old credential dies, deleting evidence that was never about it (#2892 gap 4 review).
  const {
    consecutiveFailures: _f, consecutiveSuccesses: _s, lastFailureStatus: _st, lastFailureAt: _at,
    softAvoidUntil: _sa, credentialFailureGeneration: _cg, ...cooldownFields
  } = health;
  return cooldownFields;
}

/** Manual selection resets transient routing evidence without bypassing a real 429 cooldown. */
export function resetCodexRoutingForManualSelection(accountId: string): void {
  clearThreadAccountMap();
  // Manual selection is the operator source of truth — drop any automatic runtime cursor.
  runtimeActiveCodexAccountId = undefined;
  // Seed the RR ring so the next unbound new session honors the manually selected account
  // under round-robin (affinity-cleared threads / null threadId). Fill-first already follows
  // config.activeCodexAccountId, which the caller persists before invoking this.
  seedPoolRotationAccount(POOL_KEY_CODEX, accountId);
  for (const scope of new Set(Object.values(NATIVE_MODEL_QUOTA_SCOPES))) {
    if (isIndependentCodexQuotaScope(scope)) {
      seedPoolRotationAccount(codexPoolKeyForScope(scope), accountId);
    }
  }
  const current = upstreamHealth.get(accountId);
  if (!current) return;
  const preserved = preservedCooldownFields(current);
  if (Object.keys(preserved).length === 0) upstreamHealth.delete(accountId);
  else upstreamHealth.set(accountId, { consecutiveFailures: 0, ...preserved });
}

export function getCodexAccountCooldownUntil(accountId: string, now = Date.now()): number | null {
  const cooldownUntil = upstreamHealth.get(accountId)?.cooldownUntil;
  return typeof cooldownUntil === "number" && Number.isFinite(cooldownUntil) && cooldownUntil > now ? cooldownUntil : null;
}

/** Read-only cooldown snapshot for shared OAuth health projection (no write side effects). */
export function getCodexAccountHealthSnapshot(accountId: string, now = Date.now()): {
  cooldownUntil?: number;
  cooldownSource?: CodexCooldownSource;
} | null {
  const cooldownUntil = getCodexAccountCooldownUntil(accountId, now);
  if (cooldownUntil === null) return null;
  const source = upstreamHealth.get(accountId)?.cooldownSource;
  return {
    cooldownUntil,
    ...(source ? { cooldownSource: source } : {}),
  };
}

/**
 * Read the cooldown relevant to a routed native model. Account-wide cooldowns
 * (Retry-After/default) always win; reset-derived scoped state applies only to
 * its confirmed quota group.
 */
export function getCodexQuotaHealthSnapshot(
  accountId: string,
  quotaScope: CodexQuotaScope | undefined,
  now = Date.now(),
): {
  cooldownUntil?: number;
  cooldownSource?: CodexCooldownSource;
  quotaScope?: CodexQuotaScope;
} | null {
  const account = getCodexAccountHealthSnapshot(accountId, now);
  if (account) return account;
  if (!quotaScope) return null;
  const scoped = scopedHealthFor(accountId, quotaScope);
  const cooldownUntil = scoped?.cooldownUntil;
  if (typeof cooldownUntil !== "number" || !Number.isFinite(cooldownUntil) || cooldownUntil <= now) return null;
  return {
    cooldownUntil,
    ...(scoped?.cooldownSource ? { cooldownSource: scoped.cooldownSource } : {}),
    quotaScope,
  };
}

export function isCodexAccountInCooldown(accountId: string, now = Date.now()): boolean {
  return getCodexAccountCooldownUntil(accountId, now) !== null;
}

/**
 * Manually lift a hard quota cooldown without touching failure history.
 *
 * Injected Codex routing makes this proxy the ONLY model path for Codex Desktop, so a
 * cooldown that outlives the real upstream limit reads to the user as "the whole app is
 * broken" with no escape but editing config.toml. This is that escape hatch.
 *
 * Deliberately narrow:
 * - Failure counters and softAvoid survive. Clearing a cooldown says "the quota window
 *   moved", not "this account is healthy"; failover must keep its knowledge.
 * - Dropping `probeLeaseId` is what stops a stale in-flight probe from later "proving"
 *   recovery against a NEWER cooldown: {@link ownsProbeLease} needs the id to match.
 *   `cooldownGeneration` is preserved and bumped as redundancy only — a fresh 429 already
 *   bumps it in {@link recordCodexUpstreamOutcome}, so the bump here is not load-bearing
 *   today and is kept so the invariant survives a future change that retains the lease.
 *
 * Returns false when the account carried no live cooldown (already expired or never set).
 */
export function clearCodexAccountCooldown(accountId: string, now = Date.now()): boolean {
  const clear = (health: CodexUpstreamHealth): CodexUpstreamHealth | null => {
    const cooldownUntil = health.cooldownUntil;
    if (typeof cooldownUntil !== "number" || !Number.isFinite(cooldownUntil) || cooldownUntil <= now) return null;
    const {
      cooldownUntil: _until,
      cooldownSince: _since,
      cooldownSource: _source,
      probeLeaseId: _leaseId,
      probeLeaseGeneration: _leaseGeneration,
      ...rest
    } = health;
    return {
      ...rest,
      cooldownGeneration: (health.cooldownGeneration ?? 0) + 1,
      lastProbeAt: now,
    };
  };

  let cleared = false;
  const accountHealth = upstreamHealth.get(accountId);
  if (accountHealth) {
    const next = clear(accountHealth);
    if (next) {
      upstreamHealth.set(accountId, next);
      cleared = true;
    }
  }
  for (const [scope, health] of quotaScopedHealth.get(accountId) ?? []) {
    const next = clear(health);
    if (next) {
      setScopedHealth(accountId, scope, next);
      cleared = true;
    }
  }
  return cleared;
}

export function getCodexAccountSoftAvoidUntil(accountId: string, now = Date.now()): number | null {
  const softAvoidUntil = upstreamHealth.get(accountId)?.softAvoidUntil;
  return typeof softAvoidUntil === "number" && Number.isFinite(softAvoidUntil) && softAvoidUntil > now
    ? softAvoidUntil
    : null;
}

export function isCodexAccountSoftAvoided(accountId: string, now = Date.now()): boolean {
  return getCodexAccountSoftAvoidUntil(accountId, now) !== null;
}

function isCodexAccountSelectable(
  config: OcxConfig,
  accountId: string,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): boolean {
  return !isCodexAccountPaused(config, accountId)
    && getCodexQuotaHealthSnapshot(accountId, quotaScope, now) === null
    && !isCodexAccountSoftAvoided(accountId, now)
    && isCodexAccountUsable(config, accountId, selectionOptions);
}

function threadAffinityScope(quotaScope?: CodexQuotaScope): BaseThreadAffinityScope {
  return quotaScope ?? LEGACY_THREAD_AFFINITY_SCOPE;
}

function admissibleAffinityComponent(value: string): boolean {
  return retainedUtf8Bytes(value) <= MAX_AFFINITY_COMPONENT_BYTES;
}

function modelDetourAffinityScope(
  modelId: string | undefined,
  quotaScope?: CodexQuotaScope,
): ModelDetourAffinityScope | undefined {
  const canonicalModelId = modelId?.trim().toLowerCase();
  if (!canonicalModelId || !admissibleAffinityComponent(canonicalModelId)) return undefined;
  return `model-detour:${threadAffinityScope(quotaScope)}:${canonicalModelId}`;
}

function getThreadAffinityForScope(
  threadId: string,
  scope: ThreadAffinityScope,
): ThreadAffinityEntry | undefined {
  if (!admissibleAffinityComponent(threadId)) return undefined;
  return threadAccountMap.get(threadId)?.get(scope);
}

function getThreadAffinity(threadId: string, quotaScope?: CodexQuotaScope): ThreadAffinityEntry | undefined {
  return getThreadAffinityForScope(threadId, threadAffinityScope(quotaScope));
}

function getModelDetourAffinity(
  threadId: string,
  modelId: string | undefined,
  quotaScope?: CodexQuotaScope,
): ThreadAffinityEntry | undefined {
  const scope = modelDetourAffinityScope(modelId, quotaScope);
  return scope ? getThreadAffinityForScope(threadId, scope) : undefined;
}

function deleteThreadAffinityForScope(threadId: string, scope: ThreadAffinityScope): void {
  if (!admissibleAffinityComponent(threadId)) return;
  const affinities = threadAccountMap.get(threadId);
  if (!affinities) return;
  if (affinities.delete(scope)) {
    threadAffinityEntryTotal = Math.max(0, threadAffinityEntryTotal - 1);
  }
  if (affinities.size === 0) threadAccountMap.delete(threadId);
}

function deleteThreadAffinity(threadId: string, quotaScope?: CodexQuotaScope): void {
  deleteThreadAffinityForScope(threadId, threadAffinityScope(quotaScope));
}

function deleteModelDetourAffinity(
  threadId: string,
  modelId: string | undefined,
  quotaScope?: CodexQuotaScope,
): void {
  const scope = modelDetourAffinityScope(modelId, quotaScope);
  if (scope) deleteThreadAffinityForScope(threadId, scope);
}

/** Remove only the matching failed account's affinities for one thread. */
function deleteThreadAffinitiesForAccount(threadId: string, accountId: string): void {
  if (!admissibleAffinityComponent(threadId) || !admissibleAffinityComponent(accountId)) return;
  const affinities = threadAccountMap.get(threadId);
  if (!affinities) return;
  for (const [scope, entry] of affinities) {
    if (entry.accountId === accountId && affinities.delete(scope)) {
      threadAffinityEntryTotal = Math.max(0, threadAffinityEntryTotal - 1);
    }
  }
  if (affinities.size === 0) threadAccountMap.delete(threadId);
}

function threadAffinityEntryCount(): number {
  return threadAffinityEntryTotal;
}

function isThreadAffinityExpired(entry: ThreadAffinityEntry, now: number): boolean {
  return now - entry.lastUsedAt > CODEX_THREAD_AFFINITY_IDLE_TTL_MS;
}

function isThreadAffinityGenerationLive(entry: ThreadAffinityEntry): boolean {
  if (entry.accountId === MAIN_CODEX_ACCOUNT_ID) return entry.generation === 0;
  return isCodexAccountGenerationLive(entry.accountId, entry.generation);
}

/** Generations this account's affinity entries are bound at. Test observability only. */
export function debugCodexAffinityGenerations(accountId: string): number[] {
  const generations: number[] = [];
  for (const affinities of threadAccountMap.values()) {
    for (const entry of affinities.values()) {
      if (entry.accountId === accountId) generations.push(entry.generation);
    }
  }
  return generations;
}

/**
 * Advance this account's affinity entries from the generation a rejected credential
 * was bound under to the generation its own refresh produced.
 *
 * A 401 refresh-and-replay keeps the request on the same account, but the CAS write
 * moves the credential from G to G+1, and {@link isThreadAffinityGenerationLive}
 * demands exact equality — so without this the entry the replay just preserved is
 * dead on the next request. Not quarantining an account is not the same as keeping
 * its affinity.
 *
 * Lineage is proven by the CALLER, which must pass only a generation its own refresh
 * produced. Re-deriving it here from `replacedAt` cannot work: the caller reads that
 * field after the refresh and this function would re-read the same record, so the
 * comparison is tautological and an external replacement passes it. An external
 * replacement must retire the affinity, because that credential may belong to a
 * different upstream identity.
 */
export function handOffThreadAffinityGeneration(
  accountId: string,
  fromGeneration: number,
  toGeneration: number,
): boolean {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return false;
  if (toGeneration !== fromGeneration + 1) return false;
  const record = readCodexAccountRecord(accountId);
  if (!record?.credential || record.deletedAt != null) return false;
  if (record.generation !== toGeneration) return false;
  let handedOff = false;
  for (const affinities of threadAccountMap.values()) {
    for (const entry of affinities.values()) {
      if (entry.accountId !== accountId || entry.generation !== fromGeneration) continue;
      entry.generation = toGeneration;
      handedOff = true;
    }
  }
  return handedOff;
}

function pruneExpiredThreadAffinities(now: number): void {
  for (const [threadId, affinities] of threadAccountMap) {
    for (const [scope, entry] of affinities) {
      if (isThreadAffinityExpired(entry, now) && affinities.delete(scope)) {
        threadAffinityEntryTotal = Math.max(0, threadAffinityEntryTotal - 1);
      }
    }
    if (affinities.size === 0) threadAccountMap.delete(threadId);
  }
}

function pruneLruThreadAffinities(): void {
  if (threadAffinityEntryCount() <= CODEX_THREAD_AFFINITY_MAX_ENTRIES) return;
  while (threadAffinityEntryCount() > CODEX_THREAD_AFFINITY_MAX_ENTRIES) {
    let oldestThreadId: string | null = null;
    let oldestScope: ThreadAffinityScope | null = null;
    let oldestLastUsedAt = Number.POSITIVE_INFINITY;
    let oldestIsDetour = false;
    for (const [threadId, affinities] of threadAccountMap) {
      for (const [scope, entry] of affinities) {
        const candidateIsDetour = isModelDetourAffinityScope(scope);
        if (
          (candidateIsDetour && !oldestIsDetour)
          || (candidateIsDetour === oldestIsDetour && entry.lastUsedAt < oldestLastUsedAt)
        ) {
          oldestThreadId = threadId;
          oldestScope = scope;
          oldestLastUsedAt = entry.lastUsedAt;
          oldestIsDetour = candidateIsDetour;
        }
      }
    }
    if (!oldestThreadId || !oldestScope) return;
    deleteThreadAffinityForScope(oldestThreadId, oldestScope);
  }
}

function bindThreadAffinityForScope(
  threadId: string,
  accountId: string,
  now: number,
  scope: ThreadAffinityScope,
): void {
  if (!admissibleAffinityComponent(threadId) || !admissibleAffinityComponent(accountId)) return;
  const record = accountId === MAIN_CODEX_ACCOUNT_ID ? undefined : readCodexAccountRecord(accountId);
  if (accountId !== MAIN_CODEX_ACCOUNT_ID && (!record?.credential || record.deletedAt != null)) return;
  pruneExpiredThreadAffinities(now);
  const affinities = threadAccountMap.get(threadId) ?? new Map<ThreadAffinityScope, ThreadAffinityEntry>();
  const previous = affinities.get(scope);
  affinities.set(scope, {
    accountId,
    generation: accountId === MAIN_CODEX_ACCOUNT_ID ? 0 : record!.generation,
    createdAt: previous?.createdAt ?? now,
    lastUsedAt: now,
    lastReevalAt: now,
  });
  if (!previous) threadAffinityEntryTotal += 1;
  threadAccountMap.set(threadId, affinities);
  pruneLruThreadAffinities();
}

function bindThreadAffinity(
  threadId: string,
  accountId: string,
  now: number,
  quotaScope?: CodexQuotaScope,
): void {
  bindThreadAffinityForScope(threadId, accountId, now, threadAffinityScope(quotaScope));
}

function bindModelDetourAffinity(
  threadId: string,
  accountId: string,
  now: number,
  modelId: string | undefined,
  quotaScope?: CodexQuotaScope,
): void {
  const scope = modelDetourAffinityScope(modelId, quotaScope);
  if (scope) bindThreadAffinityForScope(threadId, accountId, now, scope);
}

function getEligiblePoolAccounts(
  config: OcxConfig,
  excludeId?: string,
  now = Date.now(),
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  skipFailoverReadyCandidates = false,
): readonly string[] {
  const ids = (config.codexAccounts ?? [])
    .filter(account => isSelectableCodexPoolAccount(account)
      && account.id !== excludeId
      && !isCodexAccountPaused(config, account.id)
      && !isAccountNeedsReauth(account.id)
      && (!skipFailoverReadyCandidates || !shouldFailover(config, account.id, now)))
    .filter(account => getCodexQuotaHealthSnapshot(account.id, quotaScope, now) === null)
    .filter(account => !isCodexAccountSoftAvoided(account.id, now))
    .filter(account => isCodexAccountUsable(config, account.id, selectionOptions))
    .map(account => account.id);
  // The main Codex account is not stored in config.codexAccounts; include it as a
  // first-class rotation candidate when its read-only token is usable (Option A).
  if (
    excludeId !== MAIN_CODEX_ACCOUNT_ID
    && !isCodexAccountPaused(config, MAIN_CODEX_ACCOUNT_ID)
    && (!isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID) || hasMainAccountRefreshGrant())
    && getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, quotaScope, now) === null
    && !isCodexAccountSoftAvoided(MAIN_CODEX_ACCOUNT_ID, now)
    && (!skipFailoverReadyCandidates || !shouldFailover(config, MAIN_CODEX_ACCOUNT_ID, now))
    && isCodexAccountUsable(config, MAIN_CODEX_ACCOUNT_ID, selectionOptions)
  ) {
    ids.unshift(MAIN_CODEX_ACCOUNT_ID);
  }
  // Single choke point for selection order: every strategy, failover, and preview
  // reaches the pool through here, so tiering applies once rather than per picker.
  // Eligibility above is unchanged — this only narrows an already-eligible list.
  return selectPriorityTier(
    ids,
    codexAccountPriorityLookup(config),
    id => hasCodexQuotaHeadroom(config, id, selectionOptions, now),
    pinnedCodexAccountId(config),
  );
}

function listEligibleCodexAccountIds(
  config: OcxConfig,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): readonly string[] {
  return getEligiblePoolAccounts(config, undefined, now, quotaScope, selectionOptions);
}

function stickyLimitForConfig(config: OcxConfig): number {
  return normalizeAccountPoolStickyLimit(config.accountPoolStickyLimit);
}

/**
 * Whether an account still has quota to give under the auto-switch threshold.
 *
 * Fill-first and the priority tier filter share this predicate, and share both of
 * its escape hatches. A disabled threshold means only health, pause, and reauth
 * may drain an account; unknown usage is a guess, so it must neither force
 * fill-first off the active account nor drain a tier that was simply never
 * primed. A genuinely exhausted account 429s into cooldown and leaves
 * eligibility on its own.
 */
function hasCodexQuotaHeadroom(
  config: OcxConfig,
  accountId: string,
  selectionOptions?: CodexAccountUsabilityOptions,
  now: number = Date.now(),
): boolean {
  const threshold = config.autoSwitchThreshold ?? 80;
  if (threshold <= 0) return true;
  const usage = computeCodexUsageScore(
    getAccountQuota(accountId),
    getPoolAccountPlanForSelection(config, accountId, selectionOptions),
    now,
  );
  if (isUnknownUsage(usage)) return true;
  return usage < threshold;
}

/**
 * Fill-first: keep selectable active under threshold; otherwise advance to the next
 * eligible id in stable sorted order after the current active (wrapping).
 */
function pickFillFirstCodexAccount(
  config: OcxConfig,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  const eligible = listEligibleCodexAccountIds(config, now, quotaScope, selectionOptions);
  if (eligible.length === 0) return null;

  const active = getEffectiveActiveCodexAccountId(config);
  if (active && eligible.includes(active) && hasCodexQuotaHeadroom(config, active, selectionOptions, now)) {
    return active;
  }

  return pickNextFillFirstCodexAccount(config, active ?? null, eligible, now, selectionOptions);
}

/** Next eligible account in stable order after `afterId` (wrapping). */
function pickNextFillFirstCodexAccount(
  config: OcxConfig,
  afterId: string | null,
  eligible: readonly string[] = listEligibleCodexAccountIds(config, Date.now()),
  now = Date.now(),
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  if (eligible.length === 0) return null;
  const ordered = [...eligible].sort((a, b) => a.localeCompare(b));
  if (!afterId) {
    // Prefer an under-threshold account when starting with no active cursor.
    for (const id of ordered) {
      if (hasCodexQuotaHeadroom(config, id, selectionOptions, now)) return id;
    }
    return ordered[0] ?? null;
  }

  const allConfigured = [
    ...(isCodexAccountUsable(config, MAIN_CODEX_ACCOUNT_ID, selectionOptions) || afterId === MAIN_CODEX_ACCOUNT_ID
      ? [MAIN_CODEX_ACCOUNT_ID]
      : []),
    ...(config.codexAccounts ?? []).filter(account => !account.isMain).map(account => account.id),
  ];
  const stableAll = [...new Set(allConfigured)].sort((a, b) => a.localeCompare(b));
  const startIdx = stableAll.indexOf(afterId);
  if (startIdx < 0) {
    for (const id of ordered) {
      if (hasCodexQuotaHeadroom(config, id, selectionOptions, now)) return id;
    }
    return ordered[0] ?? null;
  }

  // Skip successors that are also at/above threshold (known drained usage).
  let fallback: string | null = null;
  for (let step = 1; step <= stableAll.length; step++) {
    const candidate = stableAll[(startIdx + step) % stableAll.length]!;
    if (!eligible.includes(candidate)) continue;
    if (!fallback) fallback = candidate;
    if (hasCodexQuotaHeadroom(config, candidate, selectionOptions, now)) return candidate;
  }
  return fallback ?? ordered[0] ?? null;
}

/**
 * Unbound new-session pick for round-robin / fill-first. Returns null to fall through
 * to the legacy quota path (or when the strategy is quota).
 *
 * When `commit` is true (resolve path), advances RR state. `commitSharedActive`
 * and `commitAffinity` independently control the two cross-request side effects:
 * model-scoped entitlement selection can bind a new task without replacing an
 * existing task binding or global active choice. Preview remains a dry-run peek.
 *
 * Automatic strategy picks never sync-write config; only manual selection persists active.
 *
 * Known limitation (follow-up): when a subagent preview peeks an RR account and the request
 * then falls back to a non-Codex provider, the ring is not reserved/committed. Prefer seeding
 * the peeked account if that path becomes load-bearing.
 */
function pickUnboundStrategyAccount(
  config: OcxConfig,
  threadId: string | null,
  now: number,
  commit: boolean,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  commitSharedActive = commit,
  commitAffinity = commit,
): string | null {
  const strategy = normalizeAccountPoolStrategy(config.accountPoolStrategy);
  if (strategy === "quota") return null;
  const poolKey = codexPoolKeyForScope(quotaScope);

  let picked: string | null = null;
  if (strategy === "round-robin") {
    const eligible = listEligibleCodexAccountIds(config, now, quotaScope, selectionOptions);
    const limit = stickyLimitForConfig(config);
    if (!commit) {
      return peekRoundRobinAccount(poolKey, eligible, limit);
    }
    picked = pickRoundRobinAccount(poolKey, eligible, limit);
    if (!picked) return null;
    if (commitSharedActive) {
      if (!isIndependentCodexQuotaScope(quotaScope)) rememberActiveCodexAccount(config, picked);
    }
    if (commitAffinity && threadId) bindThreadAffinity(threadId, picked, now, quotaScope);
    notePoolRotationSuccess(poolKey, picked, limit);
    return picked;
  }

  if (strategy === "fill-first") {
    picked = pickFillFirstCodexAccount(config, now, quotaScope, selectionOptions);
    if (!picked) return null;
    if (commitSharedActive) {
      if (!isIndependentCodexQuotaScope(quotaScope)) rememberActiveCodexAccount(config, picked);
    }
    if (commitAffinity && threadId) bindThreadAffinity(threadId, picked, now, quotaScope);
    return picked;
  }

  return null;
}

export function getPoolAccountPlan(config: OcxConfig, accountId: string): string | undefined {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return getMainAccountPlan();
  return (config.codexAccounts ?? [])
    .find(account => isSelectableCodexPoolAccount(account) && account.id === accountId)?.plan;
}

/** Selection-only main routing must not lazily read the fenced native credential for its plan. */
function getPoolAccountPlanForSelection(
  config: OcxConfig,
  accountId: string,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | undefined {
  if (accountId === MAIN_CODEX_ACCOUNT_ID && selectionOptions?.nativeMainSelectionOnly === true) {
    return undefined;
  }
  return getPoolAccountPlan(config, accountId);
}

/** Shared routing state must ignore a request-scoped entitlement roster. */
function sharedStateSelectionOptions(
  selectionOptions?: CodexAccountUsabilityOptions,
): Pick<
  CodexAccountUsabilityOptions,
  "nativeMainSelectionOnly" | "isMainAccountTokenLive"
> | undefined {
  if (!selectionOptions) return undefined;
  return {
    ...(selectionOptions.nativeMainSelectionOnly !== undefined
      ? { nativeMainSelectionOnly: selectionOptions.nativeMainSelectionOnly }
      : {}),
    ...(selectionOptions.isMainAccountTokenLive
      ? { isMainAccountTokenLive: selectionOptions.isMainAccountTokenLive }
      : {}),
  };
}

function pickLowerUsageAccount(
  config: OcxConfig,
  active: string,
  activeUsage: number,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  skipFailoverReadyCandidates = false,
): string {
  let best = active;
  let bestUsage = activeUsage;
  for (const id of getEligiblePoolAccounts(
    config,
    active,
    now,
    quotaScope,
    selectionOptions,
    skipFailoverReadyCandidates,
  )) {
    const usage = computeCodexUsageScore(
      getAccountQuota(id),
      getPoolAccountPlanForSelection(config, id, selectionOptions),
      now,
    );
    if (usage < bestUsage) {
      best = id;
      bestUsage = usage;
    }
  }
  return best;
}

/** Coolest account in an already-selected candidate list; first index wins ties. */
function pickLowestUsageAmong(
  config: OcxConfig,
  ids: readonly string[],
  selectionOptions?: CodexAccountUsabilityOptions,
  now: number = Date.now(),
): string | null {
  let best: string | null = null;
  let bestUsage = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const usage = computeCodexUsageScore(
      getAccountQuota(id),
      getPoolAccountPlanForSelection(config, id, selectionOptions),
      now,
    );
    if (usage < bestUsage) {
      best = id;
      bestUsage = usage;
    }
  }
  return best;
}

export function pickLowestUsageCodexAccount(
  config: OcxConfig,
  excludeId?: string,
  now = Date.now(),
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  return pickLowestUsageAmong(
    config,
    getEligiblePoolAccounts(config, excludeId, now, quotaScope, selectionOptions),
    selectionOptions,
    now,
  );
}

/**
 * Strategy-aware alternate after a cooled/excluded account (same-request 429 retry
 * and active promotion). Quota keeps lowest-usage; fill-first advances stable order;
 * round-robin takes the next ring pick (caller should have noted the failure).
 */
export function pickAlternateCodexAccount(
  config: OcxConfig,
  excludeId: string,
  now = Date.now(),
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  const strategy = normalizeAccountPoolStrategy(config.accountPoolStrategy);
  // The exclusion is passed into eligibility rather than post-filtered off its
  // result: when the excluded account is the only healthy member of the top
  // tier, the tier walk must be free to descend instead of selecting that tier
  // and then handing back an empty list.
  if (strategy === "round-robin") {
    const eligible = getEligiblePoolAccounts(config, excludeId, now, quotaScope, selectionOptions);
    return pickRoundRobinAccount(codexPoolKeyForScope(quotaScope), eligible, stickyLimitForConfig(config));
  }
  if (strategy === "fill-first") {
    const eligible = getEligiblePoolAccounts(config, excludeId, now, quotaScope, selectionOptions);
    return pickNextFillFirstCodexAccount(config, excludeId, eligible, now, selectionOptions);
  }
  return pickLowestUsageCodexAccount(config, excludeId, now, quotaScope, selectionOptions);
}

/** Effective active: automatic runtime cursor, else operator/persisted selection. */
export function getEffectiveActiveCodexAccountId(config: OcxConfig): string | undefined {
  return runtimeActiveCodexAccountId ?? config.activeCodexAccountId;
}

/**
 * Whether the account routing is currently on is there because an operator asked
 * for it, rather than because a strategy landed on it. Surfaces read this instead
 * of comparing the stored pin themselves, which would report a pin that a later
 * automatic pick has already moved past.
 */
export function isEffectiveCodexAccountPinned(config: OcxConfig): boolean {
  const pinned = pinnedCodexAccountId(config);
  return pinned !== undefined && pinned === getEffectiveActiveCodexAccountId(config);
}

/**
 * Automatic strategy / failover cursor only — never mutates `config.activeCodexAccountId`
 * so an unrelated `saveConfig` cannot persist transient rotation as operator selection.
 */
function rememberActiveCodexAccount(_config: OcxConfig, accountId: string): void {
  runtimeActiveCodexAccountId = accountId;
}

/**
 * End the manual pin when routing moves to a different account. Returns whether
 * the pin changed so the caller can fold it into a write it was already making.
 */
function releaseCodexAccountPinFor(config: OcxConfig, accountId: string): boolean {
  const pinned = pinnedCodexAccountId(config);
  if (pinned === undefined || pinned === accountId) return false;
  clearCodexAccountPin(config);
  return true;
}

/** Persist operator (or quota-strategy) active selection to config + disk. */
function setActiveCodexAccount(config: OcxConfig, accountId: string): void {
  runtimeActiveCodexAccountId = undefined;
  const releasedPin = releaseCodexAccountPinFor(config, accountId);
  if (config.activeCodexAccountId === accountId && !releasedPin) return;
  config.activeCodexAccountId = accountId;
  saveConfigPreservingClaudeCode(config);
}

/** Quota strategy persists; RR/fill-first keep a process-local cursor only. */
function promoteActiveCodexAccount(config: OcxConfig, accountId: string): void {
  if (normalizeAccountPoolStrategy(config.accountPoolStrategy) === "quota") {
    setActiveCodexAccount(config, accountId);
    return;
  }
  // Runtime-only, like the cursor itself: a caller that persists (pause, delete)
  // saves this release with its own write; a transient failover does not, so the
  // pin survives a restart that also clears the failure history behind it.
  releaseCodexAccountPinFor(config, accountId);
  rememberActiveCodexAccount(config, accountId);
}

/**
 * Reconcile the effective active account after an administrative exclusion such as pause.
 * The operator's persisted selection is cleared when it names the excluded account; quota
 * keeps its historical persisted promotion, while rotating strategies retain the replacement
 * only in the process-local cursor.
 */
export function reconcileCodexActiveAfterExclusion(
  config: OcxConfig,
  excludedAccountId: string,
  now = Date.now(),
): string | null {
  const wasEffective = (getEffectiveActiveCodexAccountId(config) ?? MAIN_CODEX_ACCOUNT_ID) === excludedAccountId;
  if (config.activeCodexAccountId === excludedAccountId) {
    config.activeCodexAccountId = undefined;
  }
  // Excluding an account revokes any manual pin on it even when it was not the
  // effective active — otherwise a paused account keeps acting as a tier ceiling,
  // suppressing every higher-ordered account while being unusable itself.
  clearCodexAccountPin(config, excludedAccountId);
  if (!wasEffective) return getEffectiveActiveCodexAccountId(config) ?? null;

  runtimeActiveCodexAccountId = undefined;
  const fallback = pickAlternateCodexAccount(config, excludedAccountId, now);
  if (fallback) promoteActiveCodexAccount(config, fallback);
  return fallback;
}

function isUnknownUsage(usage: number): boolean {
  return usage >= CODEX_UNKNOWN_USAGE_SCORE;
}

/**
 * Move an unbound request back up when a higher tier regains headroom — the
 * weekly-reset case. Returns null when nothing should change.
 *
 * Downward moves are deliberately left to {@link applyQuotaAutoSwitch}: this only
 * fires when the tier filter has already excluded `active`, and only toward a
 * tier that strictly outranks it. Threads bound by affinity never reach here.
 */
function pickPriorityPreemption(
  config: OcxConfig,
  active: string,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  const eligible = getEligiblePoolAccounts(config, undefined, now, quotaScope, selectionOptions);
  if (eligible.length === 0 || eligible.includes(active)) return null;
  const pinned = pinnedCodexAccountId(config);
  // A live pin already lowered the tier ceiling; never preempt past an explicit
  // operator choice. Same liveness test the tier filter applies, so preview and
  // resolve agree even before the pin is garbage-collected.
  if (
    pinned !== undefined
    && eligible.includes(pinned)
    && hasCodexQuotaHeadroom(config, pinned, selectionOptions, now)
  ) return null;
  const priorityOf = codexAccountPriorityLookup(config);
  if (priorityOf(eligible[0]!) <= priorityOf(active)) return null;
  // Members without headroom are in the tier only because a sibling has some;
  // picking one would hand the request straight back to a drained account.
  return pickLowestUsageAmong(
    config,
    eligible.filter(id => hasCodexQuotaHeadroom(config, id, selectionOptions, now)),
    selectionOptions,
    now,
  );
}

/**
 * Release a pin whose account is durably drained. "Use this account now" ends
 * when the account crosses the auto-switch threshold or stops being selectable
 * at all — never on a transient cooldown or soft-avoid, which it recovers from
 * on its own. Clearing the pin also removes the condition, so this writes at
 * most once per pin.
 */
function releaseDrainedCodexAccountPin(
  config: OcxConfig,
  selectionOptions?: Pick<
    CodexAccountUsabilityOptions,
    "nativeMainSelectionOnly" | "isMainAccountTokenLive"
  >,
  now: number = Date.now(),
): void {
  const pinned = pinnedCodexAccountId(config);
  if (pinned === undefined) return;
  const knownUnavailable = isAccountNeedsReauth(pinned) || isCodexAccountPaused(config, pinned);
  if (knownUnavailable) {
    clearCodexAccountPin(config);
    saveConfigPreservingClaudeCode(config);
    return;
  }
  // Temporary drain deliberately forbids every native-main read. A pin on main
  // cannot be classified by credential liveness or quota until the fenced profile
  // is readable. Cached reauth and configured pause state were handled above.
  if (pinned === MAIN_CODEX_ACCOUNT_ID && selectionOptions?.nativeMainSelectionOnly === true) return;
  const drained = !isCodexAccountUsable(config, pinned, selectionOptions)
    || !hasCodexQuotaHeadroom(config, pinned, selectionOptions, now);
  if (!drained) return;
  clearCodexAccountPin(config);
  saveConfigPreservingClaudeCode(config);
}

function applyQuotaAutoSwitch(
  config: OcxConfig,
  active: string,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  commitSharedSelection = true,
): string {
  const threshold = config.autoSwitchThreshold ?? 80;
  if (threshold <= 0) return active;
  const quota = getAccountQuota(active);
  const activeUsage = computeCodexUsageScore(
    quota,
    getPoolAccountPlanForSelection(config, active, selectionOptions),
    now,
  );
  // Unknown usage is not evidence that a user's explicit selection crossed the
  // threshold. Wait for quota priming instead of rotating among guesses.
  if (isUnknownUsage(activeUsage)) return active;
  if (activeUsage < threshold) return active;
  const best = pickLowerUsageAccount(config, active, activeUsage, now, quotaScope, selectionOptions);
  if (best !== active) {
    if (commitSharedSelection && !isIndependentCodexQuotaScope(quotaScope)) {
      setActiveCodexAccount(config, best);
    }
    return best;
  }

  return active;
}

function shouldFailover(config: OcxConfig, accountId: string, now: number): boolean {
  const threshold = config.upstreamFailoverThreshold ?? 3;
  if (threshold <= 0) return false;
  dropSpentCredentialFailure(accountId);
  const health = upstreamHealth.get(accountId);
  if (health?.lastFailureAt && now - health.lastFailureAt > CODEX_FAILURE_WINDOW_MS) return false;
  return !!health && health.consecutiveFailures >= threshold;
}

function isHealthySharedCodexSelection(
  config: OcxConfig,
  accountId: string,
  now: number,
  quotaScope: CodexQuotaScope | undefined,
  selectionOptions: CodexAccountUsabilityOptions | undefined,
): boolean {
  return isCodexAccountSelectable(config, accountId, now, quotaScope, selectionOptions)
    && hasCodexQuotaHeadroom(config, accountId, selectionOptions, now)
    && !shouldFailover(config, accountId, now);
}

function strategySelectionOptionsForModelDetour(
  config: OcxConfig,
  now: number,
  quotaScope: CodexQuotaScope | undefined,
  selectionOptions: CodexAccountUsabilityOptions | undefined,
): CodexAccountUsabilityOptions | undefined {
  if (selectionOptions?.modelEligibleAccountIds === undefined) return selectionOptions;
  const sharedSelectionOptions = sharedStateSelectionOptions(selectionOptions) ?? {};
  return {
    ...selectionOptions,
    modelEligibleAccountIds: new Set(
      [...selectionOptions.modelEligibleAccountIds].filter(accountId =>
        isHealthySharedCodexSelection(
          config,
          accountId,
          now,
          quotaScope,
          sharedSelectionOptions,
        )
      ),
    ),
  };
}

function applyFailureFailover(
  config: OcxConfig,
  active: string,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  commitSharedSelection = true,
): string {
  if (!shouldFailover(config, active, now)) return active;
  const best = pickAlternateCodexAccount(config, active, now, quotaScope, selectionOptions);
  if (best) {
    // The scope still routes away from the failing account — that is this request's
    // own decision — but an independent one must not persist a new shared active
    // account. recordCodexUpstreamOutcome only suppresses the promotion it makes at
    // the moment of the failure; the streak outlives the soft avoid, so a later
    // scoped resolve reaches here with the streak still tripped and would otherwise
    // move the shared cursor after all.
    if (commitSharedSelection && !isIndependentCodexQuotaScope(quotaScope)) {
      promoteActiveCodexAccount(config, best);
    }
    return best;
  }
  return active;
}

export function resolveCodexAccountForThread(
  threadId: string | null,
  config: OcxConfig,
  now = Date.now(),
  quotaScope?: CodexQuotaScope,
): string | null {
  const resolution = resolveCodexAccountForThreadDetailed(threadId, config, now, quotaScope);
  return resolution.status === "selected" ? resolution.accountId : null;
}

function previewReusableAffinityAccount(
  entry: ThreadAffinityEntry | undefined,
  config: OcxConfig,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  if (
    !entry
    || isThreadAffinityExpired(entry, now)
    || !isThreadAffinityGenerationLive(entry)
    || !isCodexAccountSelectable(config, entry.accountId, now, quotaScope, selectionOptions)
    || shouldFailover(config, entry.accountId, now)
  ) {
    return null;
  }
  // Quota strategy only: non-quota strategies keep affinity for ongoing threads
  // (new-session-only rotation — docs / affinity policy A).
  if (normalizeAccountPoolStrategy(config.accountPoolStrategy) === "quota") {
    const threshold = config.autoSwitchThreshold ?? 80;
    if (threshold > 0) {
      const usage = computeCodexUsageScore(
        getAccountQuota(entry.accountId),
        getPoolAccountPlanForSelection(config, entry.accountId, selectionOptions),
      now,
      );
      if (!isUnknownUsage(usage) && usage >= threshold) {
        const best = pickLowerUsageAccount(
          config,
          entry.accountId,
          usage,
          now,
          quotaScope,
          selectionOptions,
          true,
        );
        if (best !== entry.accountId) return best;
      }
    }
  }
  return entry.accountId;
}

/**
 * Re-evaluate an affined account under the quota strategy. Returns a strictly
 * cooler replacement, or null when the current binding should remain.
 */
function reevaluateAffinityQuota(
  entry: ThreadAffinityEntry,
  config: OcxConfig,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): string | null {
  if (normalizeAccountPoolStrategy(config.accountPoolStrategy) !== "quota") return null;
  const threshold = config.autoSwitchThreshold ?? 80;
  const usage = threshold > 0
    ? computeCodexUsageScore(
        getAccountQuota(entry.accountId),
        getPoolAccountPlanForSelection(config, entry.accountId, selectionOptions),
      now,
      )
    : 0;
  const overThreshold = threshold > 0 && !isUnknownUsage(usage) && usage >= threshold;
  if (
    !overThreshold
    && now - entry.lastReevalAt < CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS
  ) {
    return null;
  }
  entry.lastReevalAt = now;
  if (!overThreshold) return null;
  const best = pickLowerUsageAccount(
    config,
    entry.accountId,
    usage,
    now,
    quotaScope,
    selectionOptions,
    true,
  );
  return best === entry.accountId ? null : best;
}

/**
 * Side-effect-free preview of the Codex pool account native routing would prefer.
 * Used for subagent fallback quota decisions before final auth.
 *
 * Does not mutate activeCodexAccountId, thread affinity, config on disk, or probe leases.
 * Mirrors {@link resolveCodexAccountForThreadDetailed} account choice, including returning a
 * configured cooled account so callers can evaluate probe/quota availability.
 */
export function previewCodexAccountForRequest(
  threadId: string | null,
  config: OcxConfig,
  now = Date.now(),
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  modelId?: string,
): string | null {
  // A request-scoped model detour keeps its own serving-account affinity. Preview
  // reads it before the ordinary lane, but never repairs or deletes it. Roster
  // expansion therefore preserves the already-serving account, and preview mirrors
  // final resolution even when the ordinary lane was independently retired.
  if (threadId && selectionOptions?.modelEligibleAccountIds !== undefined) {
    const detourPreview = previewReusableAffinityAccount(
      getModelDetourAffinity(threadId, modelId, quotaScope),
      config,
      now,
      quotaScope,
      selectionOptions,
    );
    if (detourPreview) return detourPreview;
  }
  const entry = threadId ? getThreadAffinity(threadId, quotaScope) : undefined;
  const ordinaryPreview = previewReusableAffinityAccount(
    entry,
    config,
    now,
    quotaScope,
    selectionOptions,
  );
  if (ordinaryPreview) return ordinaryPreview;

  const strategyPick = pickUnboundStrategyAccount(
    config,
    threadId,
    now,
    false,
    quotaScope,
    strategySelectionOptionsForModelDetour(config, now, quotaScope, selectionOptions),
  );
  if (strategyPick) return strategyPick;

  let active = getEffectiveActiveCodexAccountId(config) ?? null;
  if (!active) {
    return pickLowestUsageCodexAccount(config, undefined, now, quotaScope, selectionOptions);
  }
  if (!isCodexAccountSelectable(config, active, now, quotaScope, selectionOptions)) {
    const fallback = pickLowestUsageCodexAccount(config, active, now, quotaScope, selectionOptions);
    if (fallback) active = fallback;
    else if (
      hasConfiguredPoolAccount(config, active, selectionOptions)
      && !isCodexAccountPaused(config, active)
    ) return active;
    else return null;
  }
  active = pickPriorityPreemption(config, active, now, quotaScope, selectionOptions) ?? active;

  const threshold = config.autoSwitchThreshold ?? 80;
  if (threshold > 0) {
    const usage = computeCodexUsageScore(
      getAccountQuota(active),
      getPoolAccountPlanForSelection(config, active, selectionOptions),
      now,
    );
    if (!isUnknownUsage(usage) && usage >= threshold) {
      active = pickLowerUsageAccount(config, active, usage, now, quotaScope, selectionOptions);
    }
  }
  if (shouldFailover(config, active, now)) {
    const best = pickLowestUsageCodexAccount(config, active, now, quotaScope, selectionOptions);
    if (best) active = best;
  }
  if (!isCodexAccountUsable(config, active, selectionOptions)) {
    return hasConfiguredPoolAccount(config, active, selectionOptions) ? active : null;
  }
  if (isCodexAccountPaused(config, active)) return null;
  if (getCodexQuotaHealthSnapshot(active, quotaScope, now)) {
    return hasConfiguredPoolAccount(config, active, selectionOptions) ? active : null;
  }
  return active;
}

export function resolveCodexAccountForThreadDetailed(
  threadId: string | null,
  config: OcxConfig,
  now = Date.now(),
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  modelId?: string,
): CodexThreadResolution {
  // An entitlement roster constrains only this model request. It must not rewrite
  // the operator's shared active/pin choice or the task's ordinary-model affinity.
  const modelScopedSelection = selectionOptions?.modelEligibleAccountIds !== undefined;
  let preserveExistingModelScopedAffinity = false;
  const sharedSelectionOptions: CodexAccountUsabilityOptions | undefined = modelScopedSelection
    ? sharedStateSelectionOptions(selectionOptions) ?? {}
    : selectionOptions;
  // Retiring a spent manual pin is independent of affinity: an existing thread
  // keeps its account below, but the operator's tier ceiling must not silently
  // revive after quota resets. Independent model scopes must never persist a
  // change to shared routing state.
  if (!isIndependentCodexQuotaScope(quotaScope)) {
    releaseDrainedCodexAccountPin(config, sharedStateSelectionOptions(selectionOptions), now);
  }
  const sharedActiveBeforeSelection = getEffectiveActiveCodexAccountId(config);
  const preserveSharedSelectionForModelDetour = modelScopedSelection && (
    sharedActiveBeforeSelection === undefined
    || isHealthySharedCodexSelection(
      config,
      sharedActiveBeforeSelection,
      now,
      quotaScope,
      sharedSelectionOptions,
    )
  );

  if (threadId && modelScopedSelection) {
    const detourEntry = getModelDetourAffinity(threadId, modelId, quotaScope);
    if (detourEntry) {
      const detourReusable = !isThreadAffinityExpired(detourEntry, now)
        && isThreadAffinityGenerationLive(detourEntry)
        && isCodexAccountSelectable(config, detourEntry.accountId, now, quotaScope, selectionOptions)
        && !shouldFailover(config, detourEntry.accountId, now);
      if (detourReusable) {
        detourEntry.lastUsedAt = now;
        // Model detours follow the same affinity policy as ordinary bindings:
        // RR/fill-first stay sticky, while quota strategy may re-evaluate an
        // over-threshold account without changing the ordinary lane.
        const cooler = reevaluateAffinityQuota(
          detourEntry,
          config,
          now,
          quotaScope,
          selectionOptions,
        );
        if (cooler) {
          bindModelDetourAffinity(threadId, cooler, now, modelId, quotaScope);
          return { status: "selected", accountId: cooler };
        }
        return { status: "selected", accountId: detourEntry.accountId };
      }
      // Detour expiry or invalidation must not expire the ordinary task. Drop only
      // this model lane and select from ordinary/shared state below.
      deleteModelDetourAffinity(threadId, modelId, quotaScope);
    }
  }

  const entry = threadId ? getThreadAffinity(threadId, quotaScope) : undefined;
  if (threadId && entry) {
    if (isThreadAffinityExpired(entry, now)) {
      deleteThreadAffinity(threadId, quotaScope);
      return { status: "expired", accountId: entry.accountId };
    }
    const generationLive = isThreadAffinityGenerationLive(entry);
    const selectableForSharedState = generationLive
      && isCodexAccountSelectable(config, entry.accountId, now, quotaScope, sharedSelectionOptions);
    const selectableForRequest = selectableForSharedState
      && isCodexAccountSelectable(config, entry.accountId, now, quotaScope, selectionOptions);
    const failoverReady = shouldFailover(config, entry.accountId, now);
    const healthyForSharedAffinity = selectableForSharedState
      && hasCodexQuotaHeadroom(config, entry.accountId, sharedSelectionOptions, now)
      && !failoverReady;
    if (
      selectableForRequest
      // Affined threads must leave a failing account once the streak trips failover
      // (soft-avoid covers the first-hit case; this catches post-avoid residual streaks).
      && !failoverReady
    ) {
      entry.lastUsedAt = now;
      // Periodic quota re-eval: a long-lived bound thread must still switch when
      // it crosses autoSwitchThreshold and a strictly-cooler account exists.
      // Without this the reuse branch returns before applyQuotaAutoSwitch and the
      // thread stays pinned for the full idle TTL (the WSL "never switches" report).
      // Over-threshold pins re-eval immediately so a depleted primary does not keep
      // serving for up to 60s after a secondary with quota is available (#584).
      // Non-quota strategies (RR / fill-first) keep affinity for ongoing threads —
      // rotation is new-session-only (affinity policy A).
      const cooler = reevaluateAffinityQuota(entry, config, now, quotaScope, selectionOptions);
      if (cooler) {
        if (!isIndependentCodexQuotaScope(quotaScope)) {
          setActiveCodexAccount(config, cooler);
        }
        bindThreadAffinity(threadId, cooler, now, quotaScope); // rebinds + resets clocks
        return { status: "selected", accountId: cooler };
      }
      return { status: "selected", accountId: entry.accountId };
    }
    // A model-only exclusion does not invalidate the shared task binding. Health,
    // generation, pause, cooldown, and failure evidence still retire it normally.
    if (!modelScopedSelection || !healthyForSharedAffinity) {
      deleteThreadAffinity(threadId, quotaScope);
    } else {
      preserveExistingModelScopedAffinity = true;
    }
  }

  // A request-scoped roster may still contain unhealthy candidates. Non-quota strategies return
  // before the quota/failover helpers below, so prefer only shared-healthy roster members here;
  // otherwise RR/fill-first can immediately re-pick a known failing account even when another
  // entitled account is healthy. If no healthy member exists, the normal fallback path below
  // still decides whether the sole eligible candidate must be used.
  const strategySelectionOptions = strategySelectionOptionsForModelDetour(
    config,
    now,
    quotaScope,
    selectionOptions,
  );
  const strategyPick = pickUnboundStrategyAccount(
    config,
    threadId,
    now,
    true,
    quotaScope,
    strategySelectionOptions,
    !modelScopedSelection,
    !preserveExistingModelScopedAffinity,
  );
  if (strategyPick) {
    if (threadId && preserveExistingModelScopedAffinity) {
      bindModelDetourAffinity(threadId, strategyPick, now, modelId, quotaScope);
    }
    if (
      modelScopedSelection
      && !preserveSharedSelectionForModelDetour
      && !isIndependentCodexQuotaScope(quotaScope)
    ) {
      promoteActiveCodexAccount(config, strategyPick);
    }
    return { status: "selected", accountId: strategyPick };
  }

  let active = getEffectiveActiveCodexAccountId(config);
  if (!active) {
    const selected = pickLowestUsageCodexAccount(config, undefined, now, quotaScope, selectionOptions);
    if (!selected) {
      if (
        selectionOptions?.nativeMainSelectionOnly === true
        && selectionOptions.modelEligibleAccountIds !== undefined
      ) {
        return { status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID };
      }
      return { status: "none" };
    }
    if (!isIndependentCodexQuotaScope(quotaScope) && !modelScopedSelection) {
      setActiveCodexAccount(config, selected);
    }
    active = selected;
  }
  const activeSelectableForSharedState = isCodexAccountSelectable(
    config,
    active,
    now,
    quotaScope,
    sharedSelectionOptions,
  );
  const activeHealthyForSharedSelection = activeSelectableForSharedState
    && hasCodexQuotaHeadroom(config, active, sharedSelectionOptions, now)
    && !shouldFailover(config, active, now);
  if (!isCodexAccountSelectable(config, active, now, quotaScope, selectionOptions)) {
    const fallback = pickLowestUsageCodexAccount(config, active, now, quotaScope, selectionOptions);
    if (fallback) {
      const modelOnlyMove = modelScopedSelection
        && preserveSharedSelectionForModelDetour
        && activeHealthyForSharedSelection;
      if (!isIndependentCodexQuotaScope(quotaScope) && !modelOnlyMove) {
        setActiveCodexAccount(config, fallback);
      }
      active = fallback;
    } else if (
      selectionOptions?.nativeMainSelectionOnly === true
      && selectionOptions.modelEligibleAccountIds !== undefined
    ) {
      // Entitlement discovery intentionally excludes main while a temporary drain
      // fences its credential. Once every eligible non-main candidate is unavailable,
      // return main only as a non-mutating sentinel so the caller's atomic claim can
      // classify maintenance. Do not fall through to the configured-but-ineligible
      // active account or persist/bind this synthetic selection.
      return { status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID };
    } else if (
      hasConfiguredPoolAccount(config, active, selectionOptions)
      && !isCodexAccountPaused(config, active)
    ) {
      return { status: "selected", accountId: active };
    } else {
      return { status: "none" };
    }
  }
  // Before applyQuotaAutoSwitch: its sync disk write would otherwise persist a
  // move inside the drained tier that preemption immediately overrides.
  const preempted = pickPriorityPreemption(config, active, now, quotaScope, selectionOptions);
  if (preempted) {
    // Runtime-only, like every other automatic pick: config.activeCodexAccountId
    // stays the operator's selection and getEffectiveActiveCodexAccountId is what
    // surfaces this to the API and dashboard. An independent quota group must not
    // move the shared cursor at all — its ordering decision is its own.
    if (
      !preserveSharedSelectionForModelDetour
      && !isIndependentCodexQuotaScope(quotaScope)
    ) {
      rememberActiveCodexAccount(config, preempted);
    }
    active = preempted;
  }
  active = applyQuotaAutoSwitch(
    config,
    active,
    now,
    quotaScope,
    selectionOptions,
    !preserveSharedSelectionForModelDetour,
  );
  active = applyFailureFailover(
    config,
    active,
    now,
    quotaScope,
    selectionOptions,
    !preserveSharedSelectionForModelDetour,
  );
  if (!isCodexAccountUsable(config, active, selectionOptions)) {
    return hasConfiguredPoolAccount(config, active, selectionOptions)
      ? { status: "selected", accountId: active }
      : { status: "none" };
  }
  if (isCodexAccountPaused(config, active)) return { status: "none" };
  if (getCodexQuotaHealthSnapshot(active, quotaScope, now)) {
    return hasConfiguredPoolAccount(config, active, selectionOptions)
      ? { status: "selected", accountId: active }
      : { status: "none" };
  }
  if (threadId) {
    if (preserveExistingModelScopedAffinity) {
      bindModelDetourAffinity(threadId, active, now, modelId, quotaScope);
    } else {
      bindThreadAffinity(threadId, active, now, quotaScope);
    }
  }
  return { status: "selected", accountId: active };
}

export function recordCodexUpstreamOutcome(
  config: OcxConfig,
  accountId: string | null,
  outcome: CodexUpstreamOutcome,
  meta: CodexUpstreamOutcomeMeta = {},
): void {
  // Host-level evidence is account-independent (#914): a pre-connection
  // reachability failure is recorded in the (provider, host) ledger even when
  // there is no account to attribute, or the account's writer generation is
  // stale — the early returns below must not gate it.
  if (outcome === "connect_neutral" && meta.hostKey) {
    recordUpstreamHostFailure(meta.hostKey, { code: meta.lastFailureCode, now: meta.now ?? Date.now() });
  }
  if (!accountId) return;
  const writerGeneration = meta.writerGeneration ?? captureConfigGeneration();
  if (writerGeneration < lastReconciledGeneration && !liveHealthAccountIds.has(accountId)) return;
  const now = meta.now ?? Date.now();
  const outcomeClass = classifyCodexUpstreamOutcome(outcome, meta.denial);
  const quotaScope = codexQuotaScopeForModel(meta.modelId);
  /*
   * Spend a stale credential failure BEFORE any branch reads health (#2892 gap 4 review).
   *
   * Reader-side spending alone is not enough: the transient and workspace branches derive their new
   * entry from the current one, so a spent G1 401 would donate its `consecutiveFailures` to G2's
   * first genuine 503 and drop the tag while doing it. The account then reaches the failover
   * threshold one failure early, and no later read can tell. Clearing it here means every branch
   * starts from evidence that still describes a live credential.
   */
  dropSpentCredentialFailure(accountId);
  if (outcomeClass === "success") {
    const scopedProbe = meta.probeQuotaScope
      ? scopedHealthFor(accountId, meta.probeQuotaScope)
      : undefined;
    if (scopedProbe && meta.probeQuotaScope) {
      if (scopedProbe.cooldownUntil && probeMayClearCooldown(scopedProbe, meta)) {
        deleteScopedHealth(accountId, meta.probeQuotaScope);
      } else if (ownsProbeLease(scopedProbe, meta)) {
        setScopedHealth(accountId, meta.probeQuotaScope, withProbeLeaseReleased(scopedProbe, now));
      }
    }
    const current = upstreamHealth.get(accountId);
    const cooldownUntil = getCodexAccountCooldownUntil(accountId, now);
    // A leased probe that is still on its own cooldown generation proves the
    // account recovered: clear the hard cooldown outright (#433).
    if (cooldownUntil && probeMayClearCooldown(current, meta)) {
      upstreamHealth.delete(accountId);
      return;
    }
    // Owning probe on a stale generation: the lease is done, but a newer 429
    // replaced the cooldown in the meantime, so only give the lease back.
    // Non-owners keep every hard-cooldown field, including someone else's live lease.
    const base = ownsProbeLease(current, meta) ? withProbeLeaseReleased(current!, now) : current;
    const preserved = preservedCooldownFields(base);
    const failoverEnabled = (config.upstreamFailoverThreshold ?? 3) > 0;
    if (failoverEnabled && current && current.consecutiveFailures >= 2) {
      const consecutiveSuccesses = (current.consecutiveSuccesses ?? 0) + 1;
      if (consecutiveSuccesses < 2) {
        upstreamHealth.set(accountId, {
          ...base!,
          ...preserved,
          consecutiveSuccesses,
        });
        return;
      }
    }
    // Level 1 clears immediately; escalated accounts need two consecutive healthy terminals.
    // Hard quota cooldown intentionally survives either recovery path.
    if (cooldownUntil) upstreamHealth.set(accountId, { consecutiveFailures: 0, ...preserved });
    else upstreamHealth.delete(accountId);
    return;
  }
  if (outcomeClass === "caller") {
    // A 4xx does not change account health, but it does conclude an in-flight
    // probe — otherwise the lease would never be handed back.
    const current = upstreamHealth.get(accountId);
    const scopedProbe = meta.probeQuotaScope
      ? scopedHealthFor(accountId, meta.probeQuotaScope)
      : undefined;
    if (scopedProbe && meta.probeQuotaScope && ownsProbeLease(scopedProbe, meta)) {
      setScopedHealth(accountId, meta.probeQuotaScope, withProbeLeaseReleased(scopedProbe, now));
    }
    if (ownsProbeLease(current, meta)) {
      upstreamHealth.set(accountId, withProbeLeaseReleased(current!, now));
    }
    return;
  }

  if (outcomeClass === "neutral") {
    // A proven pre-connection reachability failure (DNS / TCP refusal) or a
    // relayed 3xx is host-level, not account evidence: rotation cannot repair
    // it and must not happen (#914). Conclude any owned probe lease, record the
    // failure under the (provider, host) ledger when one is named, and leave
    // account health, thread affinity, and the active account untouched.
    const current = upstreamHealth.get(accountId);
    const scopedProbe = meta.probeQuotaScope
      ? scopedHealthFor(accountId, meta.probeQuotaScope)
      : undefined;
    if (scopedProbe && meta.probeQuotaScope && ownsProbeLease(scopedProbe, meta)) {
      setScopedHealth(accountId, meta.probeQuotaScope, withProbeLeaseReleased(scopedProbe, now));
    }
    if (ownsProbeLease(current, meta)) {
      upstreamHealth.set(accountId, withProbeLeaseReleased(current!, now));
    }
    return;
  }

  const lastFailureStatus = typeof outcome === "number" ? outcome : 0;
  if (outcomeClass === "workspace") {
    // The credential is valid; this account just cannot reach this workspace (#1789).
    // Record the failure so routing stops preferring it, but do not mark it for
    // reauthentication and do not sweep its thread affinities: telling the user to
    // re-login is wrong advice that cannot fix a workspace grant.
    upstreamHealth.set(accountId, {
      consecutiveFailures: (upstreamHealth.get(accountId)?.consecutiveFailures ?? 0) + 1,
      lastFailureStatus,
      lastFailureAt: now,
    });
    return;
  }
  if (outcomeClass === "credential") {
    // 401/403 quarantines the account for reauth. That supersedes quota state
    // entirely: a cooldown (and any probe lease) on an unusable account is moot.
    // Unless the rejected credential is already gone: a stale 401 racing a
    // replacement would otherwise take the fresh credential out of rotation and
    // sweep affinities that belong to it (#2887).
    if (
      meta.credentialGeneration !== undefined
      && !isCodexAccountGenerationLive(accountId, meta.credentialGeneration)
    ) {
      return;
    }
    /*
     * The pre-check above closes the same-process race, but not a cross-process one (#2892 gap 4).
     * `isCodexAccountGenerationLive` is an unlocked read while credential writers coordinate under
     * the mutation lock, and OS preemption needs no `await` — so another process can replace the
     * credential after this check, or at any point after this whole function returns. No re-read here
     * can close that: a replacement is always free to land one instruction later.
     *
     * Taking the credential lock is not an option either: it runs with `busy_timeout=0`, so acquiring
     * it per outcome would turn ordinary contention into thrown request-path errors.
     *
     * So the evidence is TAGGED with the credential it describes and judged when it is READ. The
     * health entry carries `credentialFailureGeneration` and the reauth map carries the same
     * generation; `dropSpentCredentialFailure` and `isAccountNeedsReauth` discard an entry whose
     * credential is gone. A later transient or quota write replaces the entry along with its tag, and
     * `preservedCooldownFields` drops the tag explicitly, so this provenance can never be spent
     * against a failure it did not describe.
     *
     * Affinity sweeping needs no tag: an affinity entry already carries a credential generation and
     * self-invalidates on the next check, and re-adding swept entries would be a worse bug.
     */
    upstreamHealth.set(accountId, {
      consecutiveFailures: 1,
      lastFailureStatus,
      lastFailureAt: now,
      // Provenance rides on the entry: only this failure can be spent when its credential dies.
      ...(meta.credentialGeneration !== undefined
        ? { credentialFailureGeneration: meta.credentialGeneration }
        : {}),
    });
    quotaScopedHealth.delete(accountId);
    // The reauth flag carries the same provenance, so a replacement landing after this call cannot
    // inherit a quarantine that was never about it.
    markAccountNeedsReauth(accountId, writerGeneration, meta.credentialGeneration);
    clearThreadAccountMapForAccount(accountId);
    return;
  }

  if (outcomeClass === "quota") {
    const { until, source } = computeQuotaCooldown(meta);
    // A reset timestamp is an advisory quota-window announcement. When the
    // selected native model belongs to a confirmed independent group, preserve
    // it there so a different group (Spark versus the shared native quota) can
    // still reach upstream. Explicit Retry-After/default 429s remain account-wide.
    if (source === "reset-derived" && quotaScope) {
      const prior = scopedHealthFor(accountId, quotaScope);
      const cooldownGeneration = (prior?.cooldownGeneration ?? 0) + 1;
      const ownsLease = meta.probeQuotaScope === quotaScope && ownsProbeLease(prior, meta);
      setScopedHealth(accountId, quotaScope, {
        consecutiveFailures: 0,
        lastFailureStatus,
        lastFailureAt: now,
        cooldownUntil: until,
        cooldownSince: now,
        cooldownSource: source,
        cooldownGeneration,
        ...(ownsLease
          ? { lastProbeAt: now }
          : {
            ...(prior?.probeLeaseId !== undefined ? { probeLeaseId: prior.probeLeaseId } : {}),
            ...(prior?.probeLeaseGeneration !== undefined ? { probeLeaseGeneration: prior.probeLeaseGeneration } : {}),
            ...(prior?.lastProbeAt !== undefined ? { lastProbeAt: prior.lastProbeAt } : {}),
        }),
      });
      // The shared native scope is the existing account-wide native behavior:
      // threads must leave it and new requests should prefer an eligible account.
      // Spark remains isolated so a same-account Terra/Luna combo fallback can run.
      if (quotaScope === "shared" && !meta.fixedAccount) {
        clearThreadAccountMapForAccount(accountId);
        notePoolRotationFailure(POOL_KEY_CODEX, accountId);
        if (getEffectiveActiveCodexAccountId(config) === accountId) {
          // Same-request 429 retry already picked via excludeAccountId — reuse it so
          // round-robin does not advance the ring a second time.
          const reused = meta.promoteAccountId && meta.promoteAccountId !== accountId
            ? meta.promoteAccountId
            : null;
          const fallback = reused ?? pickAlternateCodexAccount(config, accountId, now, quotaScope);
          if (fallback) promoteActiveCodexAccount(config, fallback);
        }
      }
      return;
    }

    // A scoped probe that received an account-wide throttle is no longer live.
    const scopedProbe = meta.probeQuotaScope
      ? scopedHealthFor(accountId, meta.probeQuotaScope)
      : undefined;
    if (scopedProbe && meta.probeQuotaScope && ownsProbeLease(scopedProbe, meta)) {
      setScopedHealth(accountId, meta.probeQuotaScope, withProbeLeaseReleased(scopedProbe, now));
    }
    const prior = upstreamHealth.get(accountId);
    // Every cooldown write bumps the generation so a probe issued against the
    // previous cooldown can no longer clear this one (#433).
    const cooldownGeneration = (prior?.cooldownGeneration ?? 0) + 1;
    // A failed probe concludes its lease; an unrelated 429 leaves the live probe alone.
    const ownsLease = ownsProbeLease(prior, meta);
    upstreamHealth.set(accountId, {
      consecutiveFailures: 0,
      lastFailureStatus,
      lastFailureAt: now,
      cooldownUntil: until,
      cooldownSince: now,
      cooldownSource: source,
      cooldownGeneration,
      ...(ownsLease
        ? { lastProbeAt: now }
        : {
          ...(prior?.probeLeaseId !== undefined ? { probeLeaseId: prior.probeLeaseId } : {}),
          ...(prior?.probeLeaseGeneration !== undefined ? { probeLeaseGeneration: prior.probeLeaseGeneration } : {}),
          ...(prior?.lastProbeAt !== undefined ? { lastProbeAt: prior.lastProbeAt } : {}),
        }),
    });
    if (!meta.fixedAccount) {
      clearThreadAccountMapForAccount(accountId);
      // An independent native quota request may discover an account-wide throttle,
      // but it still must not advance the shared RR ring or active cursor. The next
      // shared request observes the cooldown and chooses its own fallback.
      if (!isIndependentCodexQuotaScope(quotaScope)) {
        notePoolRotationFailure(POOL_KEY_CODEX, accountId);
        const effectiveActive = getEffectiveActiveCodexAccountId(config);
        if (effectiveActive === accountId) {
          // Same-request 429 retry already picked via excludeAccountId — reuse it so
          // round-robin does not advance the ring a second time.
          const reused = meta.promoteAccountId && meta.promoteAccountId !== accountId
            ? meta.promoteAccountId
            : null;
          const fallback = reused ?? pickAlternateCodexAccount(config, accountId, now, quotaScope);
          if (fallback) promoteActiveCodexAccount(config, fallback);
        }
      }
    }
    return;
  }

  // transient (connect_error / timeout / 5xx)
  const current = upstreamHealth.get(accountId);
  const scopedProbe = meta.probeQuotaScope
    ? scopedHealthFor(accountId, meta.probeQuotaScope)
    : undefined;
  if (scopedProbe && meta.probeQuotaScope && ownsProbeLease(scopedProbe, meta)) {
    setScopedHealth(accountId, meta.probeQuotaScope, withProbeLeaseReleased(scopedProbe, now));
  }
  // A transient failure concludes an owning probe; an unrelated 5xx must not
  // consume someone else's live lease or drop hard-cooldown bookkeeping (#433).
  const transientBase = ownsProbeLease(current, meta) ? withProbeLeaseReleased(current!, now) : current;
  const stale = current?.lastFailureAt ? now - current.lastFailureAt > CODEX_FAILURE_WINDOW_MS : false;
  const hardCooldownUntil = getCodexAccountCooldownUntil(accountId, now) ?? undefined;
  // Soft avoid + affinity clears are part of failover. When threshold is 0, leave
  // sticky sessions alone (same as shouldFailover / applyFailureFailover no-ops).
  const failoverThreshold = config.upstreamFailoverThreshold ?? 3;
  const consecutiveFailures = stale ? 1 : (current?.consecutiveFailures ?? 0) + 1;
  const failoverReady = failoverThreshold > 0 && consecutiveFailures >= failoverThreshold;
  const escalationMs = CODEX_TRANSIENT_SOFT_AVOID_ESCALATION_MS[
    Math.min(Math.max(consecutiveFailures - failoverThreshold, 0), CODEX_TRANSIENT_SOFT_AVOID_ESCALATION_MS.length - 1)
  ]!;
  const softAvoidUntil = failoverReady
    ? Math.max(
      getCodexAccountSoftAvoidUntil(accountId, now) ?? 0,
      now + escalationMs,
    )
    : undefined;
  upstreamHealth.set(accountId, {
    ...preservedCooldownFields(transientBase),
    consecutiveFailures,
    lastFailureStatus,
    lastFailureAt: now,
    ...(hardCooldownUntil ? { cooldownUntil: hardCooldownUntil } : {}),
    ...(softAvoidUntil !== undefined ? { softAvoidUntil } : {}),
  });
  // Drop this thread's pin immediately so the next continue can rebind without
  // waiting for the soft-avoid selectable check. Guard: only delete when the
  // thread is still pinned to the FAILING account — a late failure from account A
  // must not delete a newer healthy binding to account B (race: T→A, A fails,
  // T→B, late A failure must not delete B's mapping).
  if (!meta.fixedAccount && failoverReady && meta.threadId) {
    deleteThreadAffinitiesForAccount(meta.threadId, accountId);
  }
  // Once the account is past the failover streak, clear every thread still pinned
  // to it — matching 429 affinity behavior so "continue" cannot stay on a bad peer.
  if (!meta.fixedAccount && shouldFailover(config, accountId, now)) {
    clearThreadAccountMapForAccount(accountId);
  }
  if (
    !meta.fixedAccount
    && !isIndependentCodexQuotaScope(quotaScope)
    && getEffectiveActiveCodexAccountId(config) === accountId
  ) {
    applyFailureFailover(config, accountId, now, quotaScope);
  }
}

export function formatCodexProviderForLog(providerName: string, accountId: string | null, config: OcxConfig): string {
  if (!accountId) return providerName;
  // The main Codex login participates in rotation as "main-pool" (MAIN_CODEX_ACCOUNT_ID) but is the
  // same physical account as the "main" passthrough (null accountId). Log both under the base provider
  // name so usage/tokens aggregate into a single row instead of splitting into `chatgpt` + `chatgpt-main`.
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return providerName;
  const account = (config.codexAccounts ?? [])
    .find(candidate => isSelectableCodexPoolAccount(candidate) && candidate.id === accountId);
  return account ? `${providerName}-${codexAccountLogLabel(account)}` : providerName;
}
