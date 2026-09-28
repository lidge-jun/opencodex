import { saveConfigPreservingClaudeCode } from "../config";
import type { OcxConfig } from "../types";
import { MAIN_CODEX_ACCOUNT_ID, isSelectableCodexPoolAccount } from "./account-id";
import { isCodexAccountPaused, setCodexAccountPaused } from "./account-pause";
import { publishLowQuotaEvent, type LowQuotaEvent } from "./low-quota-events";
import { registerLowQuotaObserver } from "./low-quota-observer";
import { resetAtToMs } from "./quota-types";

type Window = "short" | "weekly";
type Notice = { window: Window; percentUsed: number; threshold: number };
type Dependencies = {
  persist?: (config: OcxConfig) => void | Promise<void>;
  notify?: (notice: Notice) => void | Promise<void>;
};
type EventBase = Omit<LowQuotaEvent, "timestamp" | "status" | "delivery">;
type Episode = { reset: string; notice: "in-flight" | "delivered" | "failed" | undefined; pausedByUs: boolean; noticeBase?: EventBase };
export type LowQuotaRegistration = (() => void) & { flush(): Promise<void> };

const RETRY_DELAYS_MS = [100, 250];
const FLUSH_DEADLINE_MS = 500;

/** Each server owns its own policy, episode state and deferred writer. */
export function registerCodexLowQuotaProtection(config: OcxConfig, deps: Dependencies = {}): LowQuotaRegistration {
  const episodes = new Map<string, Episode>();
  const persist = deps.persist ?? saveConfigPreservingClaudeCode;
  const notify = deps.notify ?? (() => {});
  let policyKey: string | undefined;
  let closed = false;
  let generation = 0;
  let dirty = false;
  let attempts = 0;
  let retryDelay: number | undefined;
  let saveFlight: Promise<void> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPause: EventBase | null = null;

  function event(base: EventBase,
    delivery: LowQuotaEvent["delivery"], status: LowQuotaEvent["status"]): void {
    publishLowQuotaEvent({ ...base, delivery, status, timestamp: Date.now() });
  }
  function cancelTimer(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
  }
  function scheduleSave(delay = 0): void {
    if (closed || saveTimer || saveFlight) return;
    const ownerGeneration = generation;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (closed || ownerGeneration !== generation) {
        if (lastPause) event(lastPause, "pause-save", "cancelled");
        return;
      }
      void runSave();
    }, delay);
    saveTimer.unref?.();
  }
  function runSave(): Promise<void> {
    if (closed || !dirty) return saveFlight ?? Promise.resolve();
    if (saveFlight) return saveFlight;
    cancelTimer();
    const ownerGeneration = generation;
    dirty = false;
    saveFlight = Promise.resolve().then(() => {
      if (closed || ownerGeneration !== generation) {
        if (lastPause) event(lastPause, "pause-save", "cancelled");
        return;
      }
      return persist(config);
    }).then(() => {
      if (!closed && ownerGeneration === generation) {
        attempts = 0;
        if (lastPause) event(lastPause, "pause-save", "delivered");
      }
    }, () => {
      if (closed || ownerGeneration !== generation) return;
      if (lastPause) event(lastPause, "pause-save", "failed");
      console.warn("[codex-low-quota] pause persistence failed");
      dirty = true;
      retryDelay = RETRY_DELAYS_MS[attempts++];
    }).finally(() => {
      saveFlight = null;
      if (dirty && !closed) {
        if (retryDelay !== undefined) scheduleSave(retryDelay);
        else if (attempts === 0) scheduleSave();
        retryDelay = undefined;
      }
    });
    return saveFlight;
  }
  function close(): void {
    if (closed) return;
    closed = true;
    generation++;
    cancelTimer();
    if (dirty && lastPause) event(lastPause, "pause-save", "cancelled");
    for (const episode of episodes.values()) {
      if (episode.notice === "in-flight" && episode.noticeBase) event(episode.noticeBase, "notice", "cancelled");
    }
    dirty = false;
    unregister();
  }
  async function flush(): Promise<void> {
    if (closed) return;
    const deadline = Date.now() + FLUSH_DEADLINE_MS;
    // Drain the in-flight write and any coalesced save before closing the owner.
    while (saveFlight || dirty) {
      cancelTimer();
      const flight = saveFlight ?? runSave();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const completed = await Promise.race([
        flight.then(() => true),
        new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (!completed || Date.now() >= deadline) {
        if (lastPause) event(lastPause, "pause-save", "failed");
        console.warn("[codex-low-quota] pause persistence flush timed out");
        break;
      }
      if (attempts > RETRY_DELAYS_MS.length) break;
    }
    close();
  }

  const unregister = registerLowQuotaObserver((accountId, quota) => {
    if (closed) return;
    const policy = config.codexPool?.lowQuotaProtection;
    const nextKey = JSON.stringify(policy);
    if (policyKey !== nextKey) { episodes.clear(); policyKey = nextKey; }
    if (!policy?.enabled) return;
    const liveIds = new Set([MAIN_CODEX_ACCOUNT_ID,
      ...(config.codexAccounts ?? []).filter(isSelectableCodexPoolAccount).map(account => account.id)]);
    for (const key of episodes.keys()) if (!liveIds.has(key.split("\u0000")[0]!)) episodes.delete(key);
    if (!liveIds.has(accountId)) return;
    for (const window of ["short", "weekly"] as const) {
      if (!policy.windows[window]) continue;
      const percentUsed = quota[`${window}Percent`];
      const rawReset = quota[`${window}ResetAt`];
      if (typeof percentUsed !== "number" || !Number.isFinite(percentUsed) || percentUsed < 0 || percentUsed > 100) continue;
      if (rawReset !== undefined && (!Number.isFinite(rawReset) || resetAtToMs(rawReset) <= Date.now())) continue;
      const key = `${accountId}\u0000${window}`;
      if (percentUsed < policy.threshold) {
        const prior = episodes.get(key);
        if (prior?.notice === "in-flight" && prior.noticeBase) event(prior.noticeBase, "notice", "cancelled");
        episodes.delete(key);
        continue;
      }
      const resetAt = rawReset === undefined ? null : resetAtToMs(rawReset);
      const reset = resetAt === null ? "unknown" : String(resetAt);
      let episode = episodes.get(key);
      if (!episode || episode.reset !== reset) {
        episode = { reset, notice: undefined, pausedByUs: false };
        episodes.set(key, episode);
      }
      const base = { accountId, window, percentUsed, resetAt };
      if (dirty && attempts > RETRY_DELAYS_MS.length) {
        attempts = 0;
        scheduleSave();
      }
      if (policy.actions.pause && !isCodexAccountPaused(config, accountId) && !episode.pausedByUs) {
        setCodexAccountPaused(config, accountId, true);
        episode.pausedByUs = true;
        lastPause = base;
        dirty = true;
        attempts = 0;
        retryDelay = undefined;
        event(base, "pause-save", "pending");
        scheduleSave();
      }
      // A manual resume leaves pausedByUs set until recovery or a new reset episode.
      if (policy.actions.notify && episode.notice !== "in-flight" && episode.notice !== "delivered") {
        episode.notice = "in-flight";
        episode.noticeBase = base;
        event(base, "notice", "pending");
        console.warn(`[codex-low-quota] ${window === "short" ? "5-hour" : "weekly"} quota reached ${percentUsed}% used (threshold ${policy.threshold}%)`);
        try {
          void Promise.resolve(notify({ window, percentUsed, threshold: policy.threshold })).then(() => {
            if (closed || episodes.get(key) !== episode) return;
            event(base, "notice", "delivered");
            episode.notice = "delivered";
            episode.noticeBase = undefined;
          }, () => {
            if (closed || episodes.get(key) !== episode) return;
            event(base, "notice", "failed");
            episode.notice = "failed";
            episode.noticeBase = undefined;
          });
        } catch {
          event(base, "notice", "failed");
          episode.notice = "failed";
          episode.noticeBase = undefined;
        }
      }
    }
  });
  return Object.assign(close, { flush });
}
