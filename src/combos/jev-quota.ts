import { getCachedProviderQuota } from "../providers/quota-routing-cache";
import type { ProviderQuota } from "../providers/quota-types";
import type { JevQuotaTier } from "./jev-decision-contract";

/**
 * Opt-in quota signals for JEV decisions (`combos[*].decisionQuotaSignals: true`).
 *
 * The source is the in-memory provider quota report cache: the same last-published rows
 * `ocx provider quota` and the dashboard Providers page show. For a Codex account pool that row
 * is the pool aggregate (the effective account when no aggregate exists); for other OAuth
 * providers it is the active account; for key providers the active key. It is read
 * synchronously and never triggers a probe, so a decision never waits on quota. It is advisory
 * evidence for the decision model only and gates nothing: exhaustion vetoes stay with
 * `src/combos/resolve.ts`.
 */

/** Quota rows older than this, or stamped in the future, are unknown and send nothing. */
export const JEV_QUOTA_SIGNAL_MAX_AGE_MS = 30 * 60_000;
export const JEV_QUOTA_LIMITED_PERCENT = 70;
export const JEV_QUOTA_NEARLY_EXHAUSTED_PERCENT = 90;

export interface JevQuotaSignal {
  tier: JevQuotaTier;
  /** Whole percent used of the worst relevant window, 0..100. */
  usedPercent: number;
  /** Window name as shown to the decision model, e.g. `5h`, `weekly`, `Fable weekly`. */
  window: string;
  /** Seconds until that window resets, when the producer reported a future reset. */
  resetsInSeconds?: number;
}

export type JevQuotaReader = (provider: string, now: number) => ProviderQuota | null;

const defaultReader: JevQuotaReader = (provider, now) =>
  getCachedProviderQuota(provider, now, JEV_QUOTA_SIGNAL_MAX_AGE_MS);

/**
 * Model-family windows (Anthropic `seven_day_<family>`, `weekly_scoped` limits). The producer
 * sets `scope: "model"` only for weekly family counters, so the label is rendered as weekly.
 */
const MODEL_FAMILY_WINDOWS: Record<string, string> = {
  fable: "Fable weekly",
  opus: "Opus weekly",
  sonnet: "Sonnet weekly",
};

export function jevQuotaTier(usedPercent: number): JevQuotaTier {
  if (usedPercent >= JEV_QUOTA_NEARLY_EXHAUSTED_PERCENT) return "nearly_exhausted";
  if (usedPercent >= JEV_QUOTA_LIMITED_PERCENT) return "limited";
  return "healthy";
}

/**
 * The worst relevant window of one provider quota row for one model, or undefined when the row
 * is stale or carries no usable window.
 *
 * Relevant windows are the provider-wide 5h/weekly/monthly meters plus model-scoped family
 * windows whose family the model id names. Unscoped custom windows (credit pools, secondary
 * meters such as a Cursor API-usage pool, Spark) and USD credits are left out: they do not say
 * how much of this model's subscription remains. A window whose reported reset has passed has
 * already rolled over, so its percentage no longer describes the account.
 */
export function jevQuotaSignalFromQuota(
  quota: ProviderQuota | null | undefined,
  model: string,
  now: number,
): JevQuotaSignal | undefined {
  if (!quota || !Number.isFinite(quota.updatedAt) || quota.updatedAt > now
    || now - quota.updatedAt > JEV_QUOTA_SIGNAL_MAX_AGE_MS) return undefined;
  const windows: Array<{ window: string; percent: number | undefined; resetAt: number | undefined }> = [
    { window: "5h", percent: quota.fiveHourPercent, resetAt: quota.fiveHourResetAt },
    { window: "weekly", percent: quota.weeklyPercent, resetAt: quota.weeklyResetAt },
    { window: "monthly", percent: quota.monthlyPercent, resetAt: quota.monthlyResetAt },
  ];
  const modelId = model.toLowerCase();
  for (const custom of Array.isArray(quota.customWindows) ? quota.customWindows : []) {
    if (custom?.scope !== "model" || typeof custom.label !== "string") continue;
    const family = custom.label.trim().toLowerCase();
    const window = Object.hasOwn(MODEL_FAMILY_WINDOWS, family) ? MODEL_FAMILY_WINDOWS[family] : undefined;
    if (window && modelId.includes(family)) windows.push({ window, percent: custom.percent, resetAt: custom.resetAt });
  }
  let worst: { window: string; percent: number; resetAt: number | undefined } | undefined;
  for (const candidate of windows) {
    const { percent, resetAt } = candidate;
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
    if (typeof resetAt === "number" && Number.isFinite(resetAt) && resetAt <= now) continue;
    const used = Math.min(100, Math.max(0, percent));
    if (!worst || used > worst.percent) worst = { window: candidate.window, percent: used, resetAt };
  }
  if (!worst) return undefined;
  const resetsInSeconds = typeof worst.resetAt === "number" && Number.isFinite(worst.resetAt)
    ? Math.max(1, Math.ceil((worst.resetAt - now) / 1000))
    : undefined;
  return {
    tier: jevQuotaTier(worst.percent),
    // Floor keeps the shown number on the same side of each tier boundary as the tier itself.
    usedPercent: Math.floor(worst.percent),
    window: worst.window,
    ...(resetsInSeconds !== undefined ? { resetsInSeconds } : {}),
  };
}

/** Synchronous, cache-only quota signal for one candidate target; never probes. */
export function jevQuotaSignalForTarget(
  provider: string,
  model: string,
  now = Date.now(),
  read: JevQuotaReader = defaultReader,
): JevQuotaSignal | undefined {
  return jevQuotaSignalFromQuota(read(provider, now), model, now);
}

function compactDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/**
 * One short clause appended to a self-hosted option description. Explicit tier words carry the
 * signal; measured with `tev1`, raw numbers alone barely moved a decision.
 */
export function jevQuotaClause(signal: JevQuotaSignal): string {
  const reset = signal.resetsInSeconds !== undefined && signal.tier !== "healthy"
    ? `, resets in ${compactDuration(signal.resetsInSeconds)}`
    : "";
  const usage = `${signal.usedPercent}% of ${signal.window} used${reset}`;
  if (signal.tier === "nearly_exhausted") {
    return ` QUOTA NEARLY EXHAUSTED (${usage}): choose only if no alternative is adequate.`;
  }
  return signal.tier === "limited" ? ` Quota limited (${usage}).` : ` Quota healthy (${usage}).`;
}

/** Structured criterion field for services that accept object criteria (canonical TypeSafe). */
export function jevQuotaCriterion(signal: JevQuotaSignal): Record<string, unknown> {
  return {
    tier: signal.tier,
    used_percent: signal.usedPercent,
    window: signal.window,
    ...(signal.resetsInSeconds !== undefined ? { resets_in_seconds: signal.resetsInSeconds } : {}),
  };
}

export const JEV_QUOTA_INSTRUCTION_DESCRIPTIVE = "Remaining subscription quota matters: among targets adequate for the task, prefer ones with healthy quota; avoid targets marked QUOTA NEARLY EXHAUSTED.";
export const JEV_QUOTA_INSTRUCTION_STRUCTURED = "Remaining subscription quota matters: among targets adequate for the task, prefer ones whose quota tier is healthy; avoid targets whose quota tier is nearly_exhausted.";

/** Privacy-safe decision-log summary: counts per tier over targets, plus the picked target's tier. */
export interface JevQuotaDecisionSummary {
  healthy: number;
  limited: number;
  nearly_exhausted: number;
  selected?: JevQuotaTier;
}

/** Undefined when no candidate carried a signal, so a log row without quota evidence stays unchanged. */
export function jevQuotaDecisionSummary(
  candidates: readonly { key: string; quota?: JevQuotaSignal }[],
  selectedKey: string,
): JevQuotaDecisionSummary | undefined {
  const summary: JevQuotaDecisionSummary = { healthy: 0, limited: 0, nearly_exhausted: 0 };
  let any = false;
  for (const candidate of candidates) {
    if (!candidate.quota) continue;
    any = true;
    summary[candidate.quota.tier] += 1;
    if (candidate.key === selectedKey) summary.selected = candidate.quota.tier;
  }
  return any ? summary : undefined;
}
