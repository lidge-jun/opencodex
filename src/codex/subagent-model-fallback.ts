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
  codexQuotaScopeForModel,
  computeCodexUsageScore,
  getCodexQuotaHealthSnapshot,
  getEffectiveActiveCodexAccountId,
  getPoolAccountPlan,
  isCodexAccountInCooldown,
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
import {
  getUpstreamHostHealth,
  normalizeUpstreamHostCircuitThreshold,
  upstreamHostHealthKey,
} from "./upstream-host-health";
export const DEFAULT_SUBAGENT_MODEL_FALLBACK_POLL_MS = 60_000;

const CODEX_FORWARD_ORIGIN = new URL(CODEX_FORWARD_BASE_URL).origin.toLowerCase();

type SubagentQuotaPrimeFn = (config: OcxConfig, reason: string) => Promise<void>;
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

function normalizedChain(primary: string, config: OcxConfig, extra: readonly string[] = []): string[] {
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
): string | null {
  return route?.codexAccountId ?? resolvePoolFallbackAccountId(config, accountId);
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
): boolean {
  if (isDisabledFallbackModel(model, config)) return true;
  if (!isRoutableFallbackModel(model, config)) return true;
  const route = tryRouteFallbackModel(config, model);
  if (!route || route.provider.disabled === true) return true;
  if (isModelHealthBlocked(model, config, accountId, now)) return true;
  if (!isPoolCodexRoute(route)) return false;

  // Pool candidates need a usable account. Derive requirement from the resolved
  // route (canonical openai defaults to pool even when codexAccountMode is omitted).
  const resolvedAccountId = resolveRouteFallbackAccountId(route, config, accountId);
  if (!resolvedAccountId) return true;
  if (isCodexAccountPaused(config, resolvedAccountId)) return true;
  if (!isCodexAccountUsable(config, resolvedAccountId, accountUsabilityOptions)) return true;
  if (route.codexAccountId !== undefined) {
    // An account-qualified route is pinned and cannot consume Pool's recovery-probe
    // escape hatch. Honor both account-wide and model-scoped cooldowns so fallback
    // advances instead of selecting a candidate that exact auth will reject.
    const quotaScope = codexQuotaScopeForModel(route.modelId);
    if (getCodexQuotaHealthSnapshot(resolvedAccountId, quotaScope, now) !== null) return true;
  } else if (
    isCodexAccountInCooldown(resolvedAccountId, now)
    && !canAcquireCodexQuotaProbeLease(resolvedAccountId, now)
  ) {
    return true;
  }
  return isNativeModelQuotaExhausted(model, config, accountId, now);
}

export function selectAvailableSubagentModel(
  primary: string,
  config: OcxConfig,
  extraFallback: readonly string[] = [],
  accountId?: string | null,
  now = Date.now(),
  nativeFallbackOnly = false,
  accountUsabilityOptions?: CodexAccountUsabilityOptions,
): { model: string; rewritten: boolean; skipped: string[] } {
  const chain = normalizedChain(primary, config, extraFallback);
  const skipped: string[] = [];
  for (const candidate of chain) {
    if (nativeFallbackOnly) {
      const route = tryRouteFallbackModel(config, candidate);
      if (!route || !isCanonicalOpenAiForwardProvider(route.provider)) {
        skipped.push(candidate);
        continue;
      }
    }
    if (isSubagentModelUnavailable(candidate, config, accountId, now, accountUsabilityOptions)) {
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
): { from?: string; to?: string; skipped?: string[] } | null {
  if (!isThreadSpawnRequest(headers)) return null;
  const tomlRoleFallback = resolveAgentModelFallbackForPrimary(
    parsed.modelId,
    getCodexHome(),
    config.codexAccountNamespaces,
  );
  // Config-keyed chains are the supported per-role home (#1190); TOML `model_fallback`
  // stays readable for backwards compatibility with homes written before Codex 0.146.
  const roleFallback = [
    ...resolveConfiguredModelFallbackForPrimary(parsed.modelId, config),
    ...tomlRoleFallback,
  ];
  const globalFallback = config.subagentModelFallback ?? [];
  if (globalFallback.length === 0 && roleFallback.length === 0) return null;
  const selection = selectAvailableSubagentModel(
    parsed.modelId,
    config,
    roleFallback,
    accountId,
    now,
    nativeFallbackOnly,
    accountUsabilityOptions,
  );
  if (!selection.rewritten) return selection.skipped.length > 0
    ? { from: parsed.modelId, to: parsed.modelId, skipped: selection.skipped }
    : null;
  const from = parsed.modelId;
  rewriteParsedModel(parsed, selection.model);
  return { from, to: selection.model, skipped: selection.skipped };
}

export function subagentFallbackGuidanceText(config: OcxConfig): string {
  const chain = config.subagentModelFallback ?? [];
  if (chain.length === 0) return "";
  const quoted = chain.map(model => `"${model}"`).join(", ");
  return ` Subagent model fallback chain (priority order): ${quoted}. When the primary model is quota-exhausted, opencodex rewrites thread_spawn requests to the next available model automatically.`;
}

const TOML_STRING_ARRAY = /^(model_fallback)\s*=\s*\[(.*)\]\s*$/s;

function parseTomlStringArray(raw: string): string[] {
  const matches = [...raw.matchAll(/"((?:\\.|[^"\\])*)"/g)];
  return matches.map(match => match[1]!.replace(/\\"/g, "\""));
}

function parseTomlModelFallback(content: string): string[] | null {
  const match = content.match(/^\s*model_fallback\s*=\s*\[(.*?)\]\s*$/ms);
  if (!match) return null;
  return parseTomlStringArray(match[1] ?? "");
}

export function readAgentModelFallback(filePath: string): string[] | null {
  try {
    const content = readFileSync(filePath, "utf8");
    const multiline = parseTomlModelFallback(content);
    if (multiline) return multiline;
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(TOML_STRING_ARRAY);
      if (!match) continue;
      return parseTomlStringArray(match[2] ?? "");
    }
  } catch {
    return null;
  }
  return null;
}

export function readCodexAgentModelFallback(role: string, codexHome = CODEX_HOME): string[] {
  const file = join(codexHome, "agents", `${role}.toml`);
  if (!existsSync(file)) return [];
  return readAgentModelFallback(file) ?? [];
}

/**
 * Roles whose TOML still carries `model_fallback`. Codex >= 0.146 rejects the
 * entire role file as an unknown field (#1190), so these files are skipped by
 * the native runtime even though opencodex can still read them.
 */
export function scanCodexAgentRolesWithTomlModelFallback(codexHome = CODEX_HOME): string[] {
  return listCodexAgentRoles(codexHome).filter(
    role => readCodexAgentModelFallback(role, codexHome).length > 0,
  );
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