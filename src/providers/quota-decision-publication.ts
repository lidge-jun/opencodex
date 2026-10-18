/** Producer projection: only measured subscription windows reach advisory snapshots. */
import type { ProviderQuota } from "./quota-types";
import type { StoredAccountQuota } from "../codex/quota-types";
import { resetAtToMs } from "../codex/quota-types";
import type { DecisionQuotaWindow } from "./quota-decision-snapshot";
import { decisionQuotaSinkActive, publishDecisionAccountQuota } from "../lib/decision-quota-sink";
const rawWindows = new WeakMap<ProviderQuota, readonly DecisionQuotaWindow[]>();
/** Producer retains raw advisory projection separately from unchanged display/hard policy. */
export function bindRawDecisionWindows(quota: ProviderQuota, windows: readonly DecisionQuotaWindow[]): void { if (decisionQuotaSinkActive()) rawWindows.set(quota, windows); }
/**
 * Raw windows a binding producer attached to this observation, or undefined. Binding producers
 * (Anthropic usage/header parsers) bind only while advisory evidence is active, so an observation
 * parsed while inactive has none and must stay unknown rather than fall back to display fields,
 * which drop invalid resets and clamp percentages.
 */
export function boundDecisionWindows(quota: ProviderQuota): DecisionQuotaWindow[] | undefined {
  const raw = rawWindows.get(quota);
  return raw ? raw.map(row => ({ ...row })) : undefined;
}
/** Project a provider quota report onto decision windows, preferring raw windows bound by the producer over the display fields. */
export function providerDecisionWindows(quota: ProviderQuota): DecisionQuotaWindow[] {
  const raw = rawWindows.get(quota);
  if (raw) return raw.map(row => ({ ...row }));
  const windows: DecisionQuotaWindow[] = [];
  for (const [window, percent, reset] of [
    ["5h", "fiveHourPercent", "fiveHourResetAt"], ["weekly", "weeklyPercent", "weeklyResetAt"], ["monthly", "monthlyPercent", "monthlyResetAt"],
  ] as const) {
    if (quota[percent] !== undefined) windows.push({ window, percent: quota[percent]!, observedAt: quota.updatedAt, ...(quota[reset] !== undefined ? { resetAt: quota[reset] } : {}) });
  }
  for (const row of Array.isArray(quota.customWindows) ? quota.customWindows : []) {
    const window = typeof row?.label === "string" ? row.label.trim().toLowerCase() : "";
    if (row?.scope === "model" && (window === "fable" || window === "opus" || window === "sonnet")) {
      windows.push({ window, percent: row.percent, observedAt: row.passiveObservedAt ?? quota.updatedAt, ...(row.resetAt !== undefined ? { resetAt: row.resetAt } : {}) });
    }
  }
  return windows;
}
/** Publish decision windows for one Anthropic pool account, bound to its credential generation; a null quota publishes no windows. */
export function publishAnthropicDecisionQuota(id: string, generation: string, quota: ProviderQuota | null, partial = false): void {
  if (!decisionQuotaSinkActive()) return;
  // A non-null observation without a raw binding was parsed while inactive: unknown, never display fallback.
  const windows = quota ? boundDecisionWindows(quota) : [];
  if (windows) publishDecisionAccountQuota("anthropic", id, generation, windows, partial);
}
type CodexObservation = Omit<StoredAccountQuota, "updatedAt">;
type CodexWindow = "short" | "weekly" | "monthly";
const rawCodexWindows = new WeakMap<CodexObservation, readonly DecisionQuotaWindow[]>();
/** Keep invalid resets and the producer clock apart from compatibility display/policy parsing. */
export function bindRawCodexDecisionResets(raw: CodexObservation, resets: Record<CodexWindow, unknown>, observedAt: number): void {
  if (!decisionQuotaSinkActive()) return;
  const windows = codexDecisionWindows(raw, observedAt).map(row => {
    const value = resets[row.window === "5h" ? "short" : row.window as CodexWindow];
    if (value === undefined || value === null) return row;
    const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    return { ...row, resetAt: Number.isFinite(numeric) && numeric >= 0 ? resetAtToMs(numeric) : NaN };
  });
  rawCodexWindows.set(raw, windows);
}
/** Build decision windows from a raw Codex observation, stamping each with the producer clock rather than a merge-time clock. */
function codexDecisionWindows(raw: CodexObservation, observedAt: number): DecisionQuotaWindow[] {
  const windows: DecisionQuotaWindow[] = [];
  for (const kind of ["short", "weekly", "monthly"] as const) {
    const percent = raw[`${kind}Percent`];
    const reset = raw[`${kind}ResetAt`];
    if (percent !== undefined) windows.push({ window: kind === "short" ? "5h" : kind, percent, observedAt,
      ...(reset !== undefined ? { resetAt: resetAtToMs(reset) } : {}) });
  }
  return windows;
}
/** Publish decision windows for a Codex or main account from the raw observation, never from the display merge, so carried windows cannot acquire a fresh clock. */
export function publishCodexDecisionQuota(id: string, generation: number, raw: CodexObservation, observedAt: number, provider = "codex", partial = true): void {
  if (!decisionQuotaSinkActive()) return;
  // RAW observation, never the display merge: carried windows cannot acquire a fresh clock.
  // Header/WHAM parsers bind reset validity only while active; an unbound observation stays unknown.
  const windows = rawCodexWindows.get(raw);
  if (windows) publishDecisionAccountQuota(provider, id, generation, windows, partial);
}
