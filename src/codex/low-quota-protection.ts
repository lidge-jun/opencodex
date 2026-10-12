import type { OcxConfig } from "../types";
import { isSelectableCodexPoolAccount } from "./account-id";
import { isCodexAccountPaused, setCodexAccountPaused } from "./account-pause";
import { createLowQuotaEventLedger, type LowQuotaEvent } from "./low-quota-events";
import { registerLowQuotaObserver } from "./low-quota-observer";
import { resetAtToMs } from "./quota-types";

type Window = "short" | "weekly";
type Notice = { window: Window; percentUsed: number; threshold: number };
type Dependencies = {
  persist?: (config: OcxConfig) => void | Promise<void>;
  notify?: (notice: Notice) => void | Promise<void>;
};
type EventBase = Omit<LowQuotaEvent, "timestamp" | "status" | "delivery">;
type Episode = { reset: string; notice: "in-flight" | "logged" | "delivered" | "failed" | undefined; pausedByUs: boolean; noticeBase?: EventBase };
export type LowQuotaRegistration = (() => void) & {
  hasPendingSave(): boolean;
  flush(): Promise<void>;
  listEvents(limit?: number): LowQuotaEvent[];
};

const RETRY_DELAYS_MS = [100, 250];
const FLUSH_DEADLINE_MS = 500;

/** Each server owns its own policy, episode state and deferred writer. */
export function registerCodexLowQuotaProtection(config: OcxConfig, deps: Dependencies = {}): LowQuotaRegistration {
  const episodes = new Map<string, Episode>();
  const autoPausedAccounts = new Set<string>();
  const ledger = createLowQuotaEventLedger();
  let policyKey: string | undefined;
  let closed = false;
  let generation = 0;
  let dirty = false;
  let attempts = 0;
  let retryDelay: number | undefined;
  let saveFlight: Promise<void> | null = null;
  let activeSave: { events: Map<string, EventBase>; started: boolean; settled: boolean } | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingPauseEvents = new Map<string, EventBase>();
  const pauseStatus = new WeakMap<EventBase, LowQuotaEvent["status"]>();

  function event(base: EventBase,
    delivery: LowQuotaEvent["delivery"], status: LowQuotaEvent["status"]): void {
    if (delivery === "pause-save") pauseStatus.set(base, status);
    ledger.publish({ ...base, delivery, status, timestamp: Date.now() });
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
        for (const base of pendingPauseEvents.values()) {
          if (pauseStatus.get(base) === "pending") event(base, "pause-save", "cancelled");
        }
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
    const saving = new Map(pendingPauseEvents);
    const flightState = { events: saving, started: false, settled: false };
    activeSave = flightState;
    dirty = false;
    saveFlight = Promise.resolve().then(async () => {
      if (closed || ownerGeneration !== generation) {
        return;
      }
      if (deps.persist) {
        flightState.started = true;
        return deps.persist(config);
      }
      // Import only for an actual deferred save, then recheck ownership: an import
      // that resolves after a timed-out flush must not start a late config write.
      const { saveConfigPreservingClaudeCode } = await import("../config/live-reconcile");
      if (closed || ownerGeneration !== generation) {
        return;
      }
      flightState.started = true;
      saveConfigPreservingClaudeCode(config);
    }).then(() => {
      flightState.settled = true;
      if (flightState.started) {
        attempts = 0;
        for (const [key, base] of saving) {
          event(base, "pause-save", isCodexAccountPaused(config, base.accountId) ? "succeeded" : "cancelled");
          if (pendingPauseEvents.get(key) === base) pendingPauseEvents.delete(key);
        }
      }
    }, () => {
      flightState.settled = true;
      if (flightState.started || !closed) {
        for (const base of saving.values()) event(base, "pause-save", "failed");
      }
      if (flightState.started) {
        for (const [key, base] of saving) {
          if (pendingPauseEvents.get(key) === base && closed) pendingPauseEvents.delete(key);
        }
      }
      if (closed || ownerGeneration !== generation) return;
      console.warn("[codex-low-quota] pause persistence failed");
      dirty = true;
      retryDelay = RETRY_DELAYS_MS[attempts++];
    }).finally(() => {
      if (activeSave === flightState) activeSave = null;
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
    for (const [key, base] of pendingPauseEvents) {
      if (activeSave?.started && activeSave.events.get(key) === base) continue;
      if (pauseStatus.get(base) === "pending") event(base, "pause-save", "cancelled");
      pendingPauseEvents.delete(key);
    }
    for (const episode of episodes.values()) {
      if (episode.notice === "in-flight" && episode.noticeBase) event(episode.noticeBase, "notice", "cancelled");
    }
    dirty = false;
    autoPausedAccounts.clear();
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
        new Promise<false>(resolve => {
          timeout = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (!completed || Date.now() >= deadline) {
        const inFlight = activeSave;
        const stillRunning = inFlight !== null && inFlight.started && !inFlight.settled;
        if (inFlight && stillRunning) {
          for (const base of inFlight.events.values()) event(base, "pause-save", "pending");
        }
        console.warn(stillRunning
          ? "[codex-low-quota] pause persistence flush timed out; in-flight save remains pending"
          : "[codex-low-quota] pause persistence flush reached its deadline");
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
    if (policyKey !== nextKey) {
      for (const episode of episodes.values()) {
        if (episode.notice === "in-flight" && episode.noticeBase) event(episode.noticeBase, "notice", "cancelled");
      }
      episodes.clear();
      autoPausedAccounts.clear();
      policyKey = nextKey;
    }
    if (!policy?.enabled) return;
    const liveIds = new Set((config.codexAccounts ?? []).filter(isSelectableCodexPoolAccount).map(account => account.id));
    for (const id of autoPausedAccounts) if (!liveIds.has(id)) autoPausedAccounts.delete(id);
    for (const [key, episode] of episodes) {
      if (liveIds.has(key.split("\u0000")[0]!)) continue;
      if (episode.notice === "in-flight" && episode.noticeBase) event(episode.noticeBase, "notice", "cancelled");
      episodes.delete(key);
    }
    if (!liveIds.has(accountId)) return;
    // A manual resume ends this policy's active pause, but each already-high
    // window keeps its episode marker until recovery or a new reset.
    if (!isCodexAccountPaused(config, accountId)) autoPausedAccounts.delete(accountId);
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
      if (autoPausedAccounts.has(accountId) && isCodexAccountPaused(config, accountId)) {
        episode.pausedByUs = true;
      }
      if (dirty && attempts > RETRY_DELAYS_MS.length) {
        attempts = 0;
        scheduleSave();
      }
      if (policy.actions.pause && !isCodexAccountPaused(config, accountId) && !episode.pausedByUs) {
        setCodexAccountPaused(config, accountId, true);
        autoPausedAccounts.add(accountId);
        episode.pausedByUs = true;
        pendingPauseEvents.set(key, base);
        dirty = true;
        attempts = 0;
        retryDelay = undefined;
        event(base, "pause-save", "pending");
        scheduleSave();
      }
      // A manual resume leaves pausedByUs set until recovery or a new reset episode.
      if (policy.actions.notify && episode.notice !== "in-flight" && episode.notice !== "logged" && episode.notice !== "delivered") {
        console.warn(`[codex-low-quota] ${window === "short" ? "5-hour" : "weekly"} quota reached ${percentUsed}% used (threshold ${policy.threshold}%)`);
        if (!deps.notify) {
          event(base, "notice", "logged");
          episode.notice = "logged";
          continue;
        }
        episode.notice = "in-flight";
        episode.noticeBase = base;
        event(base, "notice", "pending");
        try {
          void Promise.resolve(deps.notify({ window, percentUsed, threshold: policy.threshold })).then(() => {
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
  return Object.assign(close, {
    hasPendingSave: () => dirty || saveFlight !== null || saveTimer !== null,
    flush,
    listEvents: ledger.list,
  });
}
