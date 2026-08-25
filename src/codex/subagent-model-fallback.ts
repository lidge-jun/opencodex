/**
 * Quota-aware subagent model fallback (issue #374).
 *
 * codex-rs spawns children with the agent-role TOML `model` pinned; when that model's
 * provider quota is exhausted the child fails immediately. This module rewrites thread_spawn
 * requests at the proxy choke point to the next healthy model in a configured fallback chain.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasOwnProvider } from "../config";
import { isRateLimitOrQuotaFailureMessage } from "../lib/errors";
import type { OcxParsedRequest, OcxConfig } from "../types";
import { slugsEquivalent } from "../providers/slug-codec";
import { CODEX_HOME, getCodexHome } from "./paths";
import { CODEX_UNKNOWN_USAGE_SCORE, getAccountQuota } from "./quota";
import {
  canAcquireCodexQuotaProbeLease,
  canAcquireCodexQuotaScopeProbeLease,
  codexQuotaScopeForModel,
  computeCodexUsageScore,
  getCodexQuotaHealthSnapshot,
  getEffectiveActiveCodexAccountId,
  getPoolAccountPlan,
} from "./routing";
import {
  isCodexAccountUsable,
  type CodexAccountUsabilityOptions,
} from "./account-usability";
import { isCodexAccountPaused } from "./account-pause";
import { slugEquals } from "../providers/slug-codec";
import { isThreadSpawnRequest } from "../server/effort-policy";
import { PROVIDER_REGISTRY } from "../providers/registry";
import {
  CODEX_FORWARD_BASE_URL,
  OPENAI_CODEX_PROVIDER_ID,
  isCanonicalOpenAiForwardProvider,
} from "../providers/openai-tiers";
import { routeModel, type RouteResult } from "../router";
import { sweepExpiredOnWrite } from "../lib/state-store-sweeper";
import { codexAccountNamespaceForModel } from "./account-namespace-match";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "./catalog/native-models";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";
import {
  getUpstreamHostHealth,
  normalizeUpstreamHostCircuitThreshold,
  upstreamHostHealthKey,
} from "./upstream-host-health";
export const DEFAULT_SUBAGENT_MODEL_FALLBACK_POLL_MS = 60_000;

const CODEX_FORWARD_ORIGIN = new URL(CODEX_FORWARD_BASE_URL).origin.toLowerCase();

type SubagentQuotaPrimeFn = (config: OcxConfig, reason: string) => Promise<void>;
/** Side-effect-free Pool account preview for one resolved fallback candidate. */
export type SubagentPoolAccountPreview = (
  modelId: string | undefined,
  now: number,
  modelEligibleAccountIds?: ReadonlySet<string>,
) => string | null;
export type SubagentModelEligibleAccountIds = (
  modelId: string | undefined,
) => ReadonlySet<string> | undefined;
let subagentQuotaPrimeForTests: SubagentQuotaPrimeFn | null = null;
let quotaPrimeInFlight: Promise<void> | null = null;

type ModelHealth = {
  unavailableUntil: number;
  reason: string;
};

const modelHealth = new Map<string, ModelHealth>();
const quotaPrimedAt = new Map<string, number>();
const knownProviderIdSet = new Set(PROVIDER_REGISTRY.map(entry => entry.id.toLowerCase()));

function tryRouteFallbackModel(config: OcxConfig, model: string): RouteResult | null {
  try {
    return routeModel(config, model);
  } catch {
    return null;
  }
}

function isPoolCodexRoute(route: RouteResult): boolean {
  return route.codexAccountMode === "pool";
}

function healthKey(model: string, accountId: string | null, poolScoped: boolean): string {
  const scopedAccountId = poolScoped ? accountId : null;
  return `${scopedAccountId ?? "none"}::${model.toLowerCase()}`;
}

function isDisabledFallbackModel(model: string, config: OcxConfig): boolean {
  const disabled = config.disabledModels ?? [];
  if (disabled.length === 0) return false;
  if (!model.includes("/")) {
    return disabled.some(stored => stored === model || slugEquals(stored, "openai", model));
  }
  const slash = model.indexOf("/");
  const provider = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  if (codexAccountNamespaceForModel(config.codexAccountNamespaces, model)) {
    return disabled.some(stored =>
      stored === model
      || stored === modelId
      || slugEquals(stored, "openai", modelId)
    );
  }
  return disabled.some(stored => stored === model || slugEquals(stored, provider, modelId));
}

function pollIntervalMs(config: OcxConfig): number {
  const configured = config.subagentModelFallbackPollMs;
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured < 1_000) {
    return DEFAULT_SUBAGENT_MODEL_FALLBACK_POLL_MS;
  }
  return configured;
}

function fallbackChainKey(model: string, namespaces: unknown): string {
  const selector = codexAccountNamespaceForModel(namespaces, model);
  if (!selector) return JSON.stringify(["model", model.toLowerCase()]);
  const slash = model.indexOf("/");
  // Selector keys are exact-case account boundaries. Keep that segment distinct while
  // retaining legacy case-insensitive de-duplication for the native model suffix.
  return JSON.stringify(["account", selector, model.slice(slash + 1).toLowerCase()]);
}

function normalizedChain(
  primary: string,
  config: OcxConfig,
  extra: readonly string[] = [],
  trailing: readonly string[] = [],
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  const push = (model: string | undefined) => {
    if (!model || model.trim() === "") return;
    const trimmed = model.trim();
    const key = fallbackChainKey(trimmed, config.codexAccountNamespaces);
    if (seen.has(key)) return;
    seen.add(key);
    chain.push(trimmed);
  };
  push(primary);
  for (const model of extra) push(model);
  for (const model of config.subagentModelFallback ?? []) push(model);
  for (const model of trailing) push(model);
  return chain;
}

export function buildSubagentModelChain(
  primary: string,
  config: OcxConfig,
  extraFallback: readonly string[] = [],
): string[] {
  return normalizedChain(primary, config, extraFallback);
}

function quotaThreshold(config: OcxConfig): number {
  const threshold = config.autoSwitchThreshold ?? 80;
  return threshold > 0 ? threshold : Number.POSITIVE_INFINITY;
}

/**
 * The account routing would actually use, not just the persisted operator
 * selection: round-robin, fill-first, failover, and priority preemption all
 * move the cursor in memory only, so reading the raw field would check quota
 * against an account this request is not going to touch.
 */
function activeCodexAccountId(config: OcxConfig): string | null {
  return getEffectiveActiveCodexAccountId(config) ?? null;
}

/**
 * Resolve the account id used for pool-scoped quota/health checks.
 * Explicit `null` means the pre-fallback preview found no usable account — do not
 * substitute `activeCodexAccountId` (that active id may itself be unusable).
 */
function resolvePoolFallbackAccountId(
  config: OcxConfig,
  accountId?: string | null,
): string | null {
  if (typeof accountId === "string") return accountId;
  if (accountId === null) return null;
  return activeCodexAccountId(config);
}

function resolveRouteFallbackAccountId(
  route: RouteResult | null,
  config: OcxConfig,
  accountId?: string | null,
  now = Date.now(),
  poolAccountPreview?: SubagentPoolAccountPreview,
  modelEligibleAccountIds?: ReadonlySet<string>,
): string | null {
  if (route?.codexAccountId !== undefined) return route.codexAccountId;
  if (route && isPoolCodexRoute(route) && poolAccountPreview) {
    return poolAccountPreview(route.modelId, now, modelEligibleAccountIds);
  }
  return resolvePoolFallbackAccountId(config, accountId);
}

function isRoutableFallbackModel(model: string, config: OcxConfig): boolean {
  const slash = model.indexOf("/");
  if (slash > 0) {
    if (codexAccountNamespaceForModel(config.codexAccountNamespaces, model)) return true;
    const providerName = model.slice(0, slash);
    if (!hasOwnProvider(config.providers, providerName)) {
      // Allow well-known "vendor/model" ids (e.g. anthropic/claude-*) to flow as
      // raw model ids through the default provider, but reject stale/typo prefixes.
      return knownProviderIdSet.has(providerName.toLowerCase());
    }
    const provider = config.providers[providerName];
    if (provider?.disabled === true) return false;
  }
  return true;
}

export function isNativeModelQuotaExhausted(
  model: string,
  config: OcxConfig,
  accountId?: string | null,
  now = Date.now(),
): boolean {
  const route = tryRouteFallbackModel(config, model);
  if (!route || !isPoolCodexRoute(route)) return false;
  const resolvedAccountId = resolveRouteFallbackAccountId(route, config, accountId);
  if (!resolvedAccountId) return false;
  const quota = getAccountQuota(resolvedAccountId);
  const usage = computeCodexUsageScore(quota, getPoolAccountPlan(config, resolvedAccountId));
  if (usage >= CODEX_UNKNOWN_USAGE_SCORE) return false;
  return usage >= quotaThreshold(config);
}

export function isModelHealthBlocked(
  model: string,
  config: OcxConfig,
  accountId?: string | null,
  now = Date.now(),
): boolean {
  const route = tryRouteFallbackModel(config, model);
  const poolScoped = !!route && isPoolCodexRoute(route);
  const health = modelHealth.get(
    healthKey(
      model,
      resolveRouteFallbackAccountId(route, config, accountId),
      poolScoped,
    ),
  );
  return !!health && health.unavailableUntil > now;
}

export function isSubagentModelUnavailable(
  model: string,
  config: OcxConfig,
  accountId?: string | null,
  now = Date.now(),
  accountUsabilityOptions?: CodexAccountUsabilityOptions,
  poolAccountPreview?: SubagentPoolAccountPreview,
  modelEligibleAccountIdsForModel?: SubagentModelEligibleAccountIds,
): boolean {
  if (isDisabledFallbackModel(model, config)) return true;
  if (!isRoutableFallbackModel(model, config)) return true;
  const route = tryRouteFallbackModel(config, model);
  if (!route || route.provider.disabled === true) return true;
  const modelEligibleAccountIds = modelEligibleAccountIdsForModel?.(route.modelId);
  const candidateAccountUsabilityOptions = modelEligibleAccountIds !== undefined
    ? {
        ...accountUsabilityOptions,
        modelEligibleAccountIds,
      }
    : accountUsabilityOptions;
  const resolvedAccountId = resolveRouteFallbackAccountId(
    route,
    config,
    accountId,
    now,
    poolAccountPreview,
    candidateAccountUsabilityOptions?.modelEligibleAccountIds,
  );
  const accountUnavailable = (
    candidateAccountId: string | null,
    usabilityOptions: CodexAccountUsabilityOptions | undefined,
    includeQuotaExhaustion: boolean,
  ): boolean => {
    if (isModelHealthBlocked(model, config, candidateAccountId, now)) return true;
    if (!isPoolCodexRoute(route)) return false;

    // Pool candidates need a usable account. Derive requirement from the resolved
    // route (canonical openai defaults to pool even when codexAccountMode is omitted).
    if (!candidateAccountId) return true;
    if (isCodexAccountPaused(config, candidateAccountId)) return true;
    if (!isCodexAccountUsable(config, candidateAccountId, usabilityOptions)) return true;
    if (route.codexAccountId !== undefined) {
      // An account-qualified route is pinned and cannot consume Pool's recovery-probe
      // escape hatch. Honor both account-wide and model-scoped cooldowns so fallback
      // advances instead of selecting a candidate that exact auth will reject.
      const quotaScope = codexQuotaScopeForModel(route.modelId);
      if (getCodexQuotaHealthSnapshot(candidateAccountId, quotaScope, now) !== null) return true;
    } else {
      const quotaScope = codexQuotaScopeForModel(route.modelId);
      const cooldown = getCodexQuotaHealthSnapshot(candidateAccountId, quotaScope, now);
      if (cooldown !== null) {
        const probeAvailable = cooldown.quotaScope
          ? canAcquireCodexQuotaScopeProbeLease(candidateAccountId, cooldown.quotaScope, now)
          : canAcquireCodexQuotaProbeLease(candidateAccountId, now);
        if (!probeAvailable) return true;
      }
    }
    if (
      !includeQuotaExhaustion
      || (
        candidateAccountId === MAIN_CODEX_ACCOUNT_ID
        && usabilityOptions?.nativeMainSelectionOnly === true
      )
    ) return false;
    return isNativeModelQuotaExhausted(model, config, candidateAccountId, now);
  };

  // Prefer a genuinely usable entitled pool account. Preview can deliberately return
  // the configured active account even when no selectable candidate exists, so a
  // null/main-only check is not enough to detect the temporary-drain case.
  if (!accountUnavailable(resolvedAccountId, candidateAccountUsabilityOptions, true)) return false;

  // During a temporary native-main drain, entitlement discovery excludes main to
  // preserve the credential fence. If no non-main candidate can serve an unqualified
  // gated model, retain main only as a read-free sentinel: final auth owns the atomic
  // claim and returns maintenance instead of letting a routed fallback bypass it.
  const preserveDrainingMainCandidate = route.codexAccountId === undefined
    && candidateAccountUsabilityOptions?.nativeMainSelectionOnly === true
    && ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(route.modelId);
  if (!preserveDrainingMainCandidate) return true;
  const drainingMainUsabilityOptions: CodexAccountUsabilityOptions = {
    ...candidateAccountUsabilityOptions,
    modelEligibleAccountIds: new Set([
      ...(modelEligibleAccountIds ?? []),
      MAIN_CODEX_ACCOUNT_ID,
    ]),
  };
  // Quota scoring main would lazily read the native credential/plan. Cached health,
  // pause, reauth, and cooldown state are safe; defer physical scoring to final auth.
  return accountUnavailable(MAIN_CODEX_ACCOUNT_ID, drainingMainUsabilityOptions, false);
}

export function selectAvailableSubagentModel(
  primary: string,
  config: OcxConfig,
  extraFallback: readonly string[] = [],
  accountId?: string | null,
  now = Date.now(),
  nativeFallbackOnly = false,
  accountUsabilityOptions?: CodexAccountUsabilityOptions,
  trailingFallback: readonly string[] = [],
  poolAccountPreview?: SubagentPoolAccountPreview,
  modelEligibleAccountIdsForModel?: SubagentModelEligibleAccountIds,
  resolvedChain?: readonly string[],
): { model: string; rewritten: boolean; skipped: string[] } {
  const chain = resolvedChain ?? normalizedChain(primary, config, extraFallback, trailingFallback);
  const skipped: string[] = [];
  for (const candidate of chain) {
    if (nativeFallbackOnly) {
      const route = tryRouteFallbackModel(config, candidate);
      if (!route || !isCanonicalOpenAiForwardProvider(route.provider)) {
        skipped.push(candidate);
        continue;
      }
    }
    if (isSubagentModelUnavailable(
      candidate,
      config,
      accountId,
      now,
      accountUsabilityOptions,
      poolAccountPreview,
      modelEligibleAccountIdsForModel,
    )) {
      skipped.push(candidate);
      continue;
    }
    return { model: candidate, rewritten: !slugsEquivalent(candidate, primary), skipped };
  }
  return { model: primary, rewritten: false, skipped };
}

export function noteSubagentModelFailure(
  model: string,
  message: string,
  config: OcxConfig,
  accountId?: string | null,
  now = Date.now(),
  ttlMs?: number,
): void {
  const interval = ttlMs ?? DEFAULT_SUBAGENT_MODEL_FALLBACK_POLL_MS;
  if (!isRateLimitOrQuotaFailureMessage(message)) return;
  const route = tryRouteFallbackModel(config, model);
  const poolScoped = !!route && isPoolCodexRoute(route);
  modelHealth.set(
    healthKey(
      model,
      resolveRouteFallbackAccountId(route, config, accountId),
      poolScoped,
    ),
    {
      unavailableUntil: now + interval,
      reason: "quota_exhausted",
    },
  );
  sweepExpiredOnWrite(now);
}

export function sweepExpiredSubagentModelHealth(now = Date.now()): number {
  let removed = 0;
  for (const [key, health] of modelHealth) {
    if (health.unavailableUntil > now) continue;
    modelHealth.delete(key);
    removed += 1;
  }
  return removed;
}

export function resetSubagentModelFallbackStateForTests(): void {
  modelHealth.clear();
  quotaPrimedAt.clear();
  quotaPrimeInFlight = null;
  subagentQuotaPrimeForTests = null;
}

/** Test-only: inject the quota prime implementation used by {@link maybePrimeSubagentQuota}. */
export function setSubagentQuotaPrimeForTests(fn: SubagentQuotaPrimeFn | null): void {
  subagentQuotaPrimeForTests = fn;
}

/** Test-only: inspect shared prime TTL / in-flight state. */
export function getSubagentQuotaPrimeStateForTests(): {
  primedAt: number;
  inFlight: boolean;
} {
  return {
    primedAt: quotaPrimedAt.get("global") ?? 0,
    inFlight: quotaPrimeInFlight !== null,
  };
}

function rewriteParsedModel(parsed: OcxParsedRequest, model: string): void {
  parsed.modelId = model;
  if (parsed._rawBody && typeof parsed._rawBody === "object") {
    (parsed._rawBody as { model?: string }).model = model;
  }
}

const TOML_MODEL = /^(model)\s*=\s*("(?:\\.|[^"\\])*")\s*$/;

function parseTomlQuotedString(raw: string): string {
  const trimmed = raw.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"");
  }
  return trimmed;
}

function readAgentModel(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(TOML_MODEL);
      if (!match) continue;
      const model = parseTomlQuotedString(match[2] ?? "");
      return model.trim() === "" ? null : model.trim();
    }
  } catch {
    return null;
  }
  return null;
}

export function readCodexAgentModel(role: string, codexHome = CODEX_HOME): string | null {
  const file = join(codexHome, "agents", `${role}.toml`);
  if (!existsSync(file)) return null;
  return readAgentModel(file);
}

export function resolveAgentModelFallbackForPrimary(
  primary: string,
  codexHome = CODEX_HOME,
  namespaces?: unknown,
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  const push = (model: string | null | undefined) => {
    if (!model || model.trim() === "") return;
    const trimmed = model.trim();
    // Match global-chain de-dupe: keep account-selector prefixes case-sensitive when
    // those selectors are configured, while ordinary provider/model ids stay case-insensitive.
    const key = fallbackChainKey(trimmed, namespaces);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(trimmed);
  };
  for (const role of listCodexAgentRoles(codexHome)) {
    const model = readCodexAgentModel(role, codexHome);
    if (!model || !slugsEquivalent(model, primary)) continue;
    for (const fallback of readCodexAgentModelFallback(role, codexHome)) push(fallback);
  }
  return merged;
}

function subagentQuotaPrimeBlockedByHostCircuit(config: OcxConfig): boolean {
  if (normalizeUpstreamHostCircuitThreshold(config.upstreamHostCircuitThreshold) === 0) return false;
  const key = upstreamHostHealthKey(OPENAI_CODEX_PROVIDER_ID, CODEX_FORWARD_ORIGIN);
  return getUpstreamHostHealth(key)?.cooldownUntil !== undefined;
}

/**
 * Per-primary-model fallback chains from opencodex config (#1190).
 *
 * Storing `model_fallback` inside `$CODEX_HOME/agents/*.toml` makes Codex >= 0.146
 * reject the whole role file as an unknown field. The config-keyed map is the
 * supported home for that metadata; keys match the requested primary model id,
 * using the same raw/encoded slug tolerance as the TOML role lookup.
 */
export function resolveConfiguredModelFallbackForPrimary(
  primary: string,
  config: OcxConfig,
): string[] {
  const byModel = config.subagentModelFallbackByModel;
  if (!byModel || typeof byModel !== "object") return [];
  const entries: string[] = [];
  const seen = new Set<string>();
  const push = (model: string) => {
    const trimmed = model.trim();
    if (trimmed === "") return;
    const key = fallbackChainKey(trimmed, config.codexAccountNamespaces);
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(trimmed);
  };
  for (const [key, chain] of Object.entries(byModel)) {
    if (!slugsEquivalent(key, primary)) continue;
    for (const model of chain) push(model);
  }
  return entries;
}

/**
 * Best-effort quota refresh before subagent model selection.
 * Concurrent callers share one in-flight promise. The success TTL is updated only
 * after a successful refresh so failures remain retryable. Errors are swallowed so
 * spawn routing can continue. When the canonical ChatGPT origin is circuit-blocked,
 * cached quota is used instead of sending credential-bearing usage probes to the
 * same origin before the request's final host admission check.
 */
export function maybePrimeSubagentQuota(
  config: OcxConfig,
  now = Date.now(),
  options: { nativeMainReadsForbidden?: boolean } = {},
): Promise<void> {
  if (options.nativeMainReadsForbidden) return Promise.resolve();
  if (subagentQuotaPrimeBlockedByHostCircuit(config)) return Promise.resolve();
  if (quotaPrimeInFlight) return quotaPrimeInFlight;
  if (!shouldPrimeSubagentQuota(config, now)) return Promise.resolve();

  quotaPrimeInFlight = (async () => {
    try {
      // Re-check after claiming single-flight ownership so a circuit opened by
      // a concurrent request cannot race us into a fresh usage-probe pass.
      if (subagentQuotaPrimeBlockedByHostCircuit(config)) return;
      if (subagentQuotaPrimeForTests) {
        await subagentQuotaPrimeForTests(config, "subagent-spawn");
      } else {
        const { primeCodexPoolQuotas } = await import("./auth-api");
        await primeCodexPoolQuotas(config, "subagent-spawn");
      }
      quotaPrimedAt.set("global", Date.now());
    } catch {
      // Owning boundary: do not fail the spawn path when priming is unavailable.
      // Leave quotaPrimedAt untouched so a later spawn can retry.
    } finally {
      quotaPrimeInFlight = null;
    }
  })();
  return quotaPrimeInFlight;
}

export function recordSubagentQuotaFailureForThreadSpawn(
  headers: Headers,
  model: string,
  message: string | number,
  config: OcxConfig,
  accountId?: string | null,
  now = Date.now(),
): void {
  if (!isThreadSpawnRequest(headers)) return;
  noteSubagentModelFailure(model, String(message), config, accountId, now, pollIntervalMs(config));
}

export function applySubagentModelFallback(
  parsed: OcxParsedRequest,
  headers: Headers,
  config: OcxConfig,
  accountId?: string | null,
  now = Date.now(),
  nativeFallbackOnly = false,
  accountUsabilityOptions?: CodexAccountUsabilityOptions,
  poolAccountPreview?: SubagentPoolAccountPreview,
  modelEligibleAccountIdsForModel?: SubagentModelEligibleAccountIds,
  resolvedFallbackChain?: readonly string[] | null,
): { from?: string; to?: string; skipped?: string[] } | null {
  if (!isThreadSpawnRequest(headers)) return null;
  const fallbackChain = resolvedFallbackChain === undefined
    ? resolveSubagentFallbackChain(parsed, config)
    : resolvedFallbackChain;
  if (!fallbackChain) return null;
  const selection = selectAvailableSubagentModel(
    parsed.modelId,
    config,
    [],
    accountId,
    now,
    nativeFallbackOnly,
    accountUsabilityOptions,
    [],
    poolAccountPreview,
    modelEligibleAccountIdsForModel,
    fallbackChain,
  );
  if (!selection.rewritten) return selection.skipped.length > 0
    ? { from: parsed.modelId, to: parsed.modelId, skipped: selection.skipped }
    : null;
  const from = parsed.modelId;
  rewriteParsedModel(parsed, selection.model);
  return { from, to: selection.model, skipped: selection.skipped };
}

/** Resolve the effective fallback chain once for one logical spawn request. */
export function resolveSubagentFallbackChain(
  parsed: OcxParsedRequest,
  config: OcxConfig,
): readonly string[] | null {
  const tomlRoleFallback = resolveAgentModelFallbackForPrimary(
    parsed.modelId,
    getCodexHome(),
    config.codexAccountNamespaces,
  );
  // Config-keyed chains are the supported per-role home (#1190); TOML `model_fallback`
  // stays readable for backwards compatibility with homes written before Codex 0.146.
  const configuredFallback = resolveConfiguredModelFallbackForPrimary(parsed.modelId, config);
  const globalFallback = config.subagentModelFallback ?? [];
  if (globalFallback.length === 0 && configuredFallback.length === 0 && tomlRoleFallback.length === 0) return null;
  return normalizedChain(parsed.modelId, config, configuredFallback, tomlRoleFallback);
}

/** Whether the effective fallback chain crosses an account-gated native Pool model. */
export function subagentFallbackNeedsModelEntitlements(
  fallbackChain: readonly string[] | null,
  config: OcxConfig,
): boolean {
  return fallbackChain?.some((candidate) => {
    const route = tryRouteFallbackModel(config, candidate);
    return !!route
      && isPoolCodexRoute(route)
      && ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(route.modelId);
  }) === true;
}

export function subagentFallbackGuidanceText(config: OcxConfig): string {
  const chain = config.subagentModelFallback ?? [];
  if (chain.length === 0) return "";
  const quoted = chain.map(model => `"${model}"`).join(", ");
  return ` Subagent model fallback chain (priority order): ${quoted}. When the primary model is quota-exhausted, opencodex rewrites thread_spawn requests to the next available model automatically.`;
}

const TOML_MODEL_FALLBACK_KEY = /^\s*(?:model_fallback|"model_fallback"|'model_fallback')\s*=/;

type TomlModelFallbackField = { present: false; value: null } | { present: true; value: string[] | null };

type TomlScanState = {
  inMultilineString: '"""' | "'''" | null;
  arrayDepth: number;
};

/** Track TOML strings, comments, and array brackets on one line. */
function scanTomlLine(line: string, state: TomlScanState): void {
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "#") return;
    if (ch === '"' || ch === "'") {
      const delimiter = ch.repeat(3);
      if (line.startsWith(delimiter, i)) {
        const end = findTomlMultilineStringEnd(line, i + 3, ch);
        if (end === -1) {
          state.inMultilineString = delimiter as '"""' | "'''";
          return;
        }
        i = end + 3;
        continue;
      }
      i++;
      while (i < line.length) {
        if (ch === '"' && line[i] === "\\") {
          i += 2;
          continue;
        }
        if (line[i] === ch) break;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "[") state.arrayDepth++;
    else if (ch === "]") state.arrayDepth = Math.max(0, state.arrayDepth - 1);
    i++;
  }
}

/** Parse a TOML string starting at `start`; returns the decoded value and end offset. */
function parseTomlStringAt(text: string, start: number): { value: string; end: number } | null {
  const quote = text[start]!;
  const delimiter = quote.repeat(3);
  if (text.startsWith(delimiter, start)) {
    const end = findTomlMultilineStringEnd(text, start + 3, quote);
    if (end === -1) return null;
    let value = text.slice(start + 3, end).trim();
    if (quote === '"') value = value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    return { value, end: end + 3 };
  }
  let i = start + 1;
  let value = "";
  while (i < text.length) {
    const ch = text[i]!;
    if (quote === '"' && ch === "\\") {
      const next = text[i + 1];
      if (next === '"' || next === "\\") {
        value += next;
        i += 2;
        continue;
      }
    }
    if (ch === quote) return { value, end: i + 1 };
    value += ch;
    i++;
  }
  return null;
}

function findTomlMultilineStringEnd(text: string, from: number, quote: string): number {
  const delimiter = quote.repeat(3);
  let index = text.indexOf(delimiter, from);
  while (index !== -1) {
    if (quote === "'") return index;
    let backslashes = 0;
    for (let j = index - 1; j >= 0 && text[j] === "\\"; j--) backslashes += 1;
    if (backslashes % 2 === 0) return index;
    index = text.indexOf(delimiter, index + 1);
  }
  return -1;
}

/** After an array close, only horizontal whitespace, an inline comment, or the line end is valid. */
function isValidTomlArrayTail(text: string, from: number): boolean {
  let i = from;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  if (i >= text.length || text[i] === "\n" || text[i] === "\r") return true;
  if (text[i] === "#") {
    while (i < text.length && text[i] !== "\n") i += 1;
    return true;
  }
  return false;
}

/** Parse a TOML string-array value; null when the value is not a well-formed array of strings. */
function parseTomlStringArrayValue(text: string): string[] | null {
  const values: string[] = [];
  let i = 0;
  const skipIgnored = () => {
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "#") {
        while (i < text.length && text[i] !== "\n") i += 1;
        continue;
      }
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      break;
    }
  };
  skipIgnored();
  if (text[i] !== "[") return null;
  i += 1;
  let expectValue = true;
  for (;;) {
    skipIgnored();
    if (i >= text.length) return null;
    const ch = text[i]!;
    if (ch === "]") {
      if (!isValidTomlArrayTail(text, i + 1)) return null;
      return values;
    }
    if (ch === ",") {
      if (expectValue) return null; // leading or doubled comma
      expectValue = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (!expectValue) return null; // adjacent strings must be comma-separated
      const parsed = parseTomlStringAt(text, i);
      if (!parsed) return null;
      values.push(parsed.value);
      i = parsed.end;
      expectValue = false;
      continue;
    }
    return null;
  }
}

/**
 * TOML-aware, presence-aware parse of the `model_fallback` field. Quoted keys
 * are recognized, and text inside strings (including multiline strings) is
 * never treated as a key. `present` is true whenever the key exists, even when
 * the value is not a readable string array; `value` is null in that case.
 */
function parseTomlModelFallbackField(content: string): TomlModelFallbackField {
  const lines = content.split(/\r?\n/);
  const state: TomlScanState = { inMultilineString: null, arrayDepth: 0 };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (state.inMultilineString) {
      const end = findTomlMultilineStringEnd(line, 0, state.inMultilineString[0]!);
      if (end === -1) continue;
      state.inMultilineString = null;
      scanTomlLine(line.slice(end + 3), state);
      continue;
    }
    if (state.arrayDepth === 0) {
      const key = line.match(TOML_MODEL_FALLBACK_KEY);
      if (key) {
        const rest = `${line.slice(key[0].length)}\n${lines.slice(i + 1).join("\n")}`;
        return { present: true, value: parseTomlStringArrayValue(rest) };
      }
    }
    scanTomlLine(line, state);
  }
  return { present: false, value: null };
}

export function readAgentModelFallback(filePath: string): string[] | null {
  try {
    const content = readFileSync(filePath, "utf8");
    const parsed = parseTomlModelFallbackField(content);
    return parsed.present ? parsed.value : null;
  } catch {
    return null;
  }
}

export function readCodexAgentModelFallback(role: string, codexHome = CODEX_HOME): string[] {
  const file = join(codexHome, "agents", `${role}.toml`);
  if (!existsSync(file)) return [];
  return readAgentModelFallback(file) ?? [];
}

/**
 * True when the role TOML carries a `model_fallback` key, even an empty array.
 * Presence is what matters for the doctor scan: Codex >= 0.146 rejects the
 * field as unknown and skips the whole role regardless of its value. Uses the
 * same TOML-aware parse as the fallback-reading path, so quoted keys count and
 * text inside string literals does not.
 */
export function hasCodexAgentModelFallbackField(role: string, codexHome = CODEX_HOME): boolean {
  const file = join(codexHome, "agents", `${role}.toml`);
  if (!existsSync(file)) return false;
  try {
    const content = readFileSync(file, "utf8");
    return parseTomlModelFallbackField(content).present;
  } catch {
    return false;
  }
}

/** Roles whose TOML still carries `model_fallback`, including empty arrays. */
export function scanCodexAgentRolesWithTomlModelFallback(codexHome = CODEX_HOME): string[] {
  return listCodexAgentRoles(codexHome).filter(role => hasCodexAgentModelFallbackField(role, codexHome));
}

export function listCodexAgentRoles(codexHome = CODEX_HOME): string[] {
  const dir = join(codexHome, "agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith(".toml"))
    .map(name => name.slice(0, -".toml".length));
}

/** True when a new quota prime should start (no success within the poll interval). */
export function shouldPrimeSubagentQuota(config: OcxConfig, now = Date.now()): boolean {
  const last = quotaPrimedAt.get("global") ?? 0;
  return now - last >= pollIntervalMs(config);
}
