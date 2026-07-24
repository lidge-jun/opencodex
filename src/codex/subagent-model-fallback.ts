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
import type { OcxParsedRequest, OcxConfig } from "../types";
import { slugsEquivalent } from "../providers/slug-codec";
import { CODEX_HOME, getCodexHome } from "./paths";
import { CODEX_UNKNOWN_USAGE_SCORE, getAccountQuota } from "./quota";
import { computeCodexUsageScore } from "./routing";
import { nativeOpenAiSlugs } from "./catalog";
import { slugEquals } from "../providers/slug-codec";
import { isThreadSpawnRequest } from "../server/effort-policy";
export const DEFAULT_SUBAGENT_MODEL_FALLBACK_POLL_MS = 60_000;

type ModelHealth = {
  unavailableUntil: number;
  reason: string;
};

const modelHealth = new Map<string, ModelHealth>();
const quotaPrimedAt = new Map<string, number>();
const nativeSlugSet = () => new Set(nativeOpenAiSlugs().map(slug => slug.toLowerCase()));

function healthKey(model: string, accountId: string | null): string {
  return `${accountId ?? "none"}::${model.toLowerCase()}`;
}

function getPoolAccountPlan(config: OcxConfig, accountId: string): string | undefined {
  return (config.codexAccounts ?? []).find(account => account.id === accountId)?.plan;
}

function isDisabledFallbackModel(model: string, config: OcxConfig): boolean {
  const disabled = config.disabledModels ?? [];
  if (disabled.length === 0) return false;
  if (!model.includes("/")) return disabled.some(stored => slugEquals(stored, "openai", model));
  const slash = model.indexOf("/");
  const provider = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  return disabled.some(stored => stored === model || slugEquals(stored, provider, modelId));
}

function pollIntervalMs(config: OcxConfig): number {
  const configured = config.subagentModelFallbackPollMs;
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured < 1_000) {
    return DEFAULT_SUBAGENT_MODEL_FALLBACK_POLL_MS;
  }
  return configured;
}

function normalizedChain(primary: string, config: OcxConfig, extra: readonly string[] = []): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  const push = (model: string | undefined) => {
    if (!model || model.trim() === "") return;
    const trimmed = model.trim();
    const key = trimmed.toLowerCase();
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

function isNativeOpenAiSlug(model: string): boolean {
  return nativeSlugSet().has(model.toLowerCase());
}

function quotaThreshold(config: OcxConfig): number {
  const threshold = config.autoSwitchThreshold ?? 80;
  return threshold > 0 ? threshold : Number.POSITIVE_INFINITY;
}

function activeCodexAccountId(config: OcxConfig): string | null {
  return config.activeCodexAccountId ?? null;
}

function resolveFallbackAccountId(config: OcxConfig, accountId?: string | null): string | null {
  return accountId ?? activeCodexAccountId(config);
}

function isRoutableFallbackModel(model: string, config: OcxConfig): boolean {
  const slash = model.indexOf("/");
  if (slash > 0) {
    const providerName = model.slice(0, slash);
    if (!hasOwnProvider(config.providers, providerName)) return false;
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
  if (!isNativeOpenAiSlug(model)) return false;
  const resolvedAccountId = resolveFallbackAccountId(config, accountId);
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
  const health = modelHealth.get(healthKey(model, resolveFallbackAccountId(config, accountId)));
  return !!health && health.unavailableUntil > now;
}

export function isSubagentModelUnavailable(
  model: string,
  config: OcxConfig,
  accountId?: string | null,
  now = Date.now(),
): boolean {
  if (isDisabledFallbackModel(model, config)) return true;
  if (!isRoutableFallbackModel(model, config)) return true;
  if (isModelHealthBlocked(model, config, accountId, now)) return true;
  if (isNativeOpenAiSlug(model)) return isNativeModelQuotaExhausted(model, config, accountId, now);
  return false;
}

export function selectAvailableSubagentModel(
  primary: string,
  config: OcxConfig,
  extraFallback: readonly string[] = [],
  accountId?: string | null,
  now = Date.now(),
): { model: string; rewritten: boolean; skipped: string[] } {
  const chain = normalizedChain(primary, config, extraFallback);
  const skipped: string[] = [];
  for (const candidate of chain) {
    if (isSubagentModelUnavailable(candidate, config, accountId, now)) {
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
  const normalized = String(message).trim();
  const lower = normalized.toLowerCase();
  const numericStatus = Number(normalized);
  const quotaLike = lower.includes("insufficient_quota")
    || lower.includes("quota exhausted")
    || lower.includes("usage limit")
    || lower.includes("exceeded your current quota")
    || lower.includes("account quota exceeded")
    || numericStatus === 429
    || numericStatus === 402;
  if (!quotaLike) return;
  modelHealth.set(healthKey(model, resolveFallbackAccountId(config, accountId)), {
    unavailableUntil: now + interval,
    reason: "quota_exhausted",
  });
}

export function resetSubagentModelFallbackStateForTests(): void {
  modelHealth.clear();
  quotaPrimedAt.clear();
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
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  const push = (model: string | null | undefined) => {
    if (!model || model.trim() === "") return;
    const trimmed = model.trim();
    const key = trimmed.toLowerCase();
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

export function maybePrimeSubagentQuota(config: OcxConfig, now = Date.now()): void {
  if (!shouldPrimeSubagentQuota(config, now)) return;
  void import("./auth-api")
    .then(({ primeCodexPoolQuotas }) => primeCodexPoolQuotas(config, "subagent-spawn"))
    .catch(() => {});
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
): { from?: string; to?: string; skipped?: string[] } | null {
  if (!isThreadSpawnRequest(headers)) return null;
  const roleFallback = resolveAgentModelFallbackForPrimary(parsed.modelId, getCodexHome());
  const globalFallback = config.subagentModelFallback ?? [];
  if (globalFallback.length === 0 && roleFallback.length === 0) return null;
  const selection = selectAvailableSubagentModel(parsed.modelId, config, roleFallback, accountId, now);
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
  const match = content.match(/^\s*model_fallback\s*=\s*\[(.*)\]\s*$/ms);
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

export function listCodexAgentRoles(codexHome = CODEX_HOME): string[] {
  const dir = join(codexHome, "agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith(".toml"))
    .map(name => name.slice(0, -".toml".length));
}

export function shouldPrimeSubagentQuota(config: OcxConfig, now = Date.now()): boolean {
  const key = "global";
  const last = quotaPrimedAt.get(key) ?? 0;
  if (now - last < pollIntervalMs(config)) return false;
  quotaPrimedAt.set(key, now);
  return true;
}
