import { saveConfigPreservingClaudeCode } from "../config";
import type { OcxConfig } from "../types";
import { MAIN_CODEX_ACCOUNT_ID, isSelectableCodexPoolAccount } from "./account-id";
import { isCodexAccountPaused, setCodexAccountPaused } from "./account-pause";
import { registerLowQuotaObserver } from "./low-quota-observer";
import { resetAtToMs } from "./quota-types";

type Notice = { window: "short" | "weekly"; percentUsed: number; threshold: number };
type Dependencies = {
  persist?: (config: OcxConfig) => void;
  notify?: (notice: Notice) => Promise<void>;
};

/** Register against the live server config so pausing affects the very next pool selection. */
export const setupCodexLowQuotaProtection = registerCodexLowQuotaProtection;
export function registerCodexLowQuotaProtection(config: OcxConfig, deps: Dependencies = {}): () => void {
  const notified = new Map<string, Partial<Record<Notice["window"], string>>>();
  const pendingPauses = new Set<string>();
  let policyKey: string | undefined;
  const persist = deps.persist ?? saveConfigPreservingClaudeCode;
  const notify = deps.notify ?? (async (notice: Notice) => {
    // The proxy may run headless. Keep this fallback local and free of account identifiers.
    console.warn(`[codex-low-quota] ${notice.window === "short" ? "5-hour" : "Weekly"} quota reached ${notice.percentUsed}% used (threshold ${notice.threshold}%)`);
  });
  return registerLowQuotaObserver((accountId, quota) => {
    const policy = config.codexPool?.lowQuotaProtection;
    const nextKey = JSON.stringify(policy);
    if (policyKey !== nextKey) {
      notified.clear();
      policyKey = nextKey;
    }
    if (!policy?.enabled) return;
    const liveIds = new Set([MAIN_CODEX_ACCOUNT_ID,
      ...(config.codexAccounts ?? []).filter(isSelectableCodexPoolAccount).map(account => account.id)]);
    for (const id of notified.keys()) if (!liveIds.has(id)) notified.delete(id);
    for (const id of pendingPauses) if (!liveIds.has(id)) pendingPauses.delete(id);
    if (!liveIds.has(accountId)) return;
    const seen = notified.get(accountId) ?? {};
    for (const window of ["short", "weekly"] as const) {
      if (!policy.windows[window]) continue;
      const percentUsed = quota[`${window}Percent`];
      const resetAt = quota[`${window}ResetAt`];
      if (typeof percentUsed !== "number" || !Number.isFinite(percentUsed) || percentUsed < 0 || percentUsed > 100) continue;
      if (resetAt !== undefined && (!Number.isFinite(resetAt) || resetAtToMs(resetAt) <= Date.now())) continue;
      if (percentUsed < policy.threshold) {
        delete seen[window];
        continue;
      }
      if (policy.actions.pause && (!isCodexAccountPaused(config, accountId) || pendingPauses.has(accountId))) {
        setCodexAccountPaused(config, accountId, true);
        try {
          persist(config);
          pendingPauses.delete(accountId);
        } catch {
          // Keep the live pool protected; retry persistence on its next high observation.
          pendingPauses.add(accountId);
          console.warn("[codex-low-quota] pause persistence failed");
        }
      }
      const episode = resetAt === undefined ? "unknown" : String(resetAtToMs(resetAt));
      if (policy.actions.notify && seen[window] !== episode) {
        seen[window] = episode;
        // Do not serialize future observations behind a slow or unavailable desktop service.
        try { void notify({ window, percentUsed, threshold: policy.threshold }).catch(() => {}); } catch { /* best effort */ }
      }
    }
    if (Object.keys(seen).length) notified.set(accountId, seen);
    else notified.delete(accountId);
  });
}
