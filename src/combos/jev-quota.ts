import { anthropicModelFamily } from "../oauth/anthropic-model-family";
/** Advisory quota only: loaded snapshots, never serving-account selection or hard eligibility. */
import { resolveAnthropicModelRoute, routeCandidates } from "../oauth/anthropic-model-routes";
import type { OcxConfig } from "../types";
import { readLoadedDecisionKeyQuota, readLoadedDecisionQuotaPool, type DecisionQuotaWindow } from "../providers/quota-decision-snapshot";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers-destination";
import { providerCodexAccountMode } from "../providers/registry";
import { NATIVE_RESERVE_MODEL } from "../codex/catalog/native-models";
import { isSelectableCodexPoolAccount, MAIN_CODEX_ACCOUNT_ID } from "../codex/account-id";
import { JEV_QUOTA_DEFAULT_TIERS, jevQuotaRank, jevQuotaTier, type JevQuotaTier, type ResolvedJevQuotaTiers, type JevQuotaDecisionSummary } from "./jev-quota-config";
export const JEV_QUOTA_SIGNAL_MAX_AGE_MS = 30 * 60_000;
export interface JevQuotaSignal {
  tier: JevQuotaTier;
  usedPercent?: number;
  window?: DecisionQuotaWindow["window"];
  resetsInSeconds?: number;
}
/** Build the signal used when evidence is missing, stale or invalid; it ties healthy. */
const unknown = (): JevQuotaSignal => ({ tier: "unknown" });
/** Reduce decision quota windows to the worst applicable window for a model, ignoring cold, stale, future, invalid or reset-expired rows. */
export function jevQuotaSignalFromWindows(windows: readonly DecisionQuotaWindow[] | undefined, model: string, now: number, tiers = JEV_QUOTA_DEFAULT_TIERS): JevQuotaSignal {
  let worst: DecisionQuotaWindow | undefined;
  for (const row of windows ?? []) {
    if (!["5h", "weekly", "monthly"].includes(row.window) && anthropicModelFamily(model)?.toLowerCase() !== row.window) continue;
    if (!Number.isFinite(now) || now < 0 || !Number.isFinite(row.observedAt) || row.observedAt < 0 || row.observedAt > now
      || now - row.observedAt > JEV_QUOTA_SIGNAL_MAX_AGE_MS || !Number.isFinite(row.percent) || row.percent < 0 || row.percent > 100
      || row.resetAt !== undefined && (!Number.isFinite(row.resetAt) || row.resetAt < 0 || row.resetAt <= now)) continue;
    if (!worst || row.percent > worst.percent) worst = row;
  }
  if (!worst) return unknown();
  return { tier: jevQuotaTier(worst.percent, tiers), usedPercent: worst.percent, window: worst.window,
    ...(worst.resetAt !== undefined ? { resetsInSeconds: Math.min(31_536_000, Math.ceil((worst.resetAt - now) / 1000)) } : {}) };
}
/** Unknown ties healthy; stable order within tiers. Exhaustion requires EVERY usable row known. */
export function jevQuotaPoolSignal(signals: readonly JevQuotaSignal[]): JevQuotaSignal {
  return signals.reduce<JevQuotaSignal | undefined>((best, signal) => !best || jevQuotaRank(signal.tier) < jevQuotaRank(best.tier) ? signal : best, undefined) ?? unknown();
}
/** Read only already-loaded evidence for a target provider and model and return its quota signal; never resolves credentials or probes upstream. */
export function jevQuotaSignalForTarget(config: OcxConfig, provider: string, model: string, now = Date.now(), tiers: ResolvedJevQuotaTiers = JEV_QUOTA_DEFAULT_TIERS): JevQuotaSignal {
  const row = config.providers[provider];
  if (!row || row.disabled) return unknown();
  if (provider === "anthropic" && row.authMode === "oauth" && config.anthropicAccountPool?.enabled === true) {
    const route = resolveAnthropicModelRoute(config, model);
    if (route.error) return unknown();
    const usable = (readLoadedDecisionQuotaPool("anthropic") ?? []).filter(account => account.usable);
    const ids = new Set(routeCandidates(usable.map(account => account.id), route.decision));
    return jevQuotaPoolSignal(usable.filter(account => ids.has(account.id)).map(account => jevQuotaSignalFromWindows(account.windows, model, now, tiers)));
  }
  if (isCanonicalOpenAiForwardProvider(row) && providerCodexAccountMode(provider, row) === "pool") {
    if (model.toLowerCase().split("/").at(-1) === NATIVE_RESERVE_MODEL) return unknown();
    const roster = readLoadedDecisionQuotaPool("codex");
    if (!roster) return unknown();
    const paused = new Set(config.pausedCodexAccountIds ?? []);
    const ids = new Set((config.codexAccounts ?? []).filter(isSelectableCodexPoolAccount).map(account => account.id));
    const loadedIds = new Set(roster.map(account => account.id));
    const signals = roster.filter(account => account.usable && ids.has(account.id) && !paused.has(account.id))
      .map(account => jevQuotaSignalFromWindows(account.windows, model, now, tiers));
    for (const id of ids) if (!loadedIds.has(id) && !paused.has(id)) signals.push(unknown());
    if (!paused.has(MAIN_CODEX_ACCOUNT_ID)) {
      const main = readLoadedDecisionQuotaPool("codex-main")?.[0];
      if (!main || main.usable) signals.push(jevQuotaSignalFromWindows(main?.windows, model, now, tiers));
    }
    return jevQuotaPoolSignal(signals);
  }
  return jevQuotaSignalFromWindows(readLoadedDecisionKeyQuota(provider, row), model, now, tiers);
}
/** Render the short natural-language quota clause appended to an option description. */
export function jevQuotaClause(signal: JevQuotaSignal): string {
  return ` Quota ${signal.tier}${signal.usedPercent !== undefined ? ` (${signal.usedPercent}% of ${signal.window} used)` : ""}.`;
}
/** Project a quota signal onto the outbound criterion object: tier, used percentage, window and reset delay only. */
export function jevQuotaCriterion(signal: JevQuotaSignal): Record<string, unknown> {
  return { tier: signal.tier, ...(signal.usedPercent !== undefined ? { used_percent: signal.usedPercent, window: signal.window } : {}),
    ...(signal.resetsInSeconds !== undefined ? { resets_in_seconds: signal.resetsInSeconds } : {}) };
}
export const JEV_QUOTA_INSTRUCTION = "Remaining subscription quota is advisory: among adequate options prefer healthier quota; unknown is not exhausted. Never change the target or effort allowlist.";
/** Count candidate quota tiers and record the selected candidate's tier; undefined when no candidate carried quota evidence. */
export function jevQuotaDecisionSummary(candidates: readonly { key: string; quota?: JevQuotaSignal }[], selectedKey: string): JevQuotaDecisionSummary | undefined {
  if (!candidates.some(candidate => candidate.quota)) return undefined;
  const summary: JevQuotaDecisionSummary = { unknown: 0, healthy: 0, moderate: 0, limited: 0, nearly_exhausted: 0 };
  for (const candidate of candidates) {
    const tier = candidate.quota?.tier ?? "unknown";
    summary[tier]++;
    if (candidate.key === selectedKey) summary.selected = tier;
  }
  return summary;
}
