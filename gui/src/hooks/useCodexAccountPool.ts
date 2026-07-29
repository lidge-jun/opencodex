import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountQuota } from "../codex-quota-utils";
import { accountNeedsReauth } from "../oauth-health-display";

/**
 * Codex account pool DATA layer (WP3 / 030_account_state_lift.md).
 *
 * Ownership rule: exactly one caller instantiates this hook (Providers.tsx), and every
 * surface that shows Codex accounts — the Providers Overview tab and the Accounts tab —
 * reads the SAME controller. Mounting CodexAccountPool twice used to fork the state, so
 * an action on one surface was invisible to the other.
 *
 * Q6 boundary: this hook owns list/active/loading/switching plus the mutating actions.
 * Modals, toasts, prompts and popovers stay in the presentation layer.
 */

export interface CodexAccountEntry {
  id: string;
  email: string;
  alias?: string;
  plan?: string;
  /** Required, not optional: the API always distinguishes the app-login row. */
  isMain: boolean;
  /** Persisted routing exclusion. Paused accounts remain visible but cannot be selected. */
  paused: boolean;
  hasCredential: boolean;
  quota: AccountQuota | null;
  needsReauth?: boolean;
  health?: { status: "healthy" | "cooldown" | "reauth_required" | "warning"; reason?: string; until?: string };
  healthLabel?: string;
  healthSummary?: string;
  healthAction?: string;
}

export type CodexAccountLoadState = "loading" | "ready" | "error";

export type CodexAccountActionResult<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; reason: "busy" | "request" | "reload" };

/**
 * The auto-switch threshold arrives on the same /active response as the account list.
 * The presentation layer owns that setting's UI state, so it subscribes here instead of
 * passing an observer into load(): background polls have no caller to pass one, and two
 * delivery paths would notify the same observer twice per explicit load.
 */
export interface CodexAccountLoadObserver {
  beginActiveRead(): number;
  acceptActiveRead(value: unknown, startedRevision: number): void;
  rejectActiveRead(): void;
}

/** Opaque lease. Two callers pausing for the same reason must not cancel each other. */
export type PauseToken = { readonly __brand: "codex-pool-pause" };

export interface CodexAccountPoolController {
  accounts: CodexAccountEntry[];
  activeId: string | null;
  loadState: CodexAccountLoadState;
  switchingId: string | null;
  pauseUpdatingId: string | null;
  pausingExhausted: boolean;
  activeNeedsReauth: boolean;

  load(refreshQuota?: boolean): Promise<boolean>;
  switchAccount(id: string | null): Promise<CodexAccountActionResult<{ activeId: string | null }>>;
  setAccountPaused(id: string, paused: boolean): Promise<CodexAccountActionResult>;
  pauseExhaustedAccounts(): Promise<CodexAccountActionResult<{ pausedCount: number }>>;
  saveAlias(id: string, alias: string): Promise<CodexAccountActionResult>;
  removeAccount(id: string): Promise<CodexAccountActionResult>;
  syncAfterAccountAdded(): Promise<CodexAccountActionResult>;

  pauseRefresh(): PauseToken;
  resumeRefresh(token: PauseToken): void;
  subscribeLoadObserver(observer: CodexAccountLoadObserver): () => void;
  /** Last threshold an actual /active read returned; undefined before the first success. */
  readLastThreshold(): unknown;
}

const REFRESH_INTERVAL_MS = 30_000;

export function useCodexAccountPool(apiBase: string, enabled = true): CodexAccountPoolController {
  const [accounts, setAccounts] = useState<CodexAccountEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<CodexAccountLoadState>("loading");
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [pauseUpdatingId, setPauseUpdatingId] = useState<string | null>(null);
  const [pausingExhausted, setPausingExhausted] = useState(false);
  // Pause leases live in a ref: pausing must not re-render, and the effect below reads
  // the live set rather than a captured snapshot.
  const [pauseCount, setPauseCount] = useState(0);
  const pauseTokensRef = useRef<Set<PauseToken>>(new Set());
  const loadGenerationRef = useRef(0);
  // Set by switchAccount so a background load already in flight cannot roll the active
  // id back to a value the server had not yet committed when that request was issued.
  const pendingActiveIdRef = useRef<{ id: string | null } | null>(null);
  const observersRef = useRef<Set<CodexAccountLoadObserver>>(new Set());
  // Last threshold value an actual /active read returned. Surfaces that mount after a
  // load already finished read it to seed their UI instead of waiting a poll interval.
  const lastThresholdRef = useRef<{ value: unknown } | null>(null);
  const switchingRef = useRef<string | null>(null);
  const pauseMutationRef = useRef<"bulk" | { accountId: string } | null>(null);

  const subscribeLoadObserver = useCallback((observer: CodexAccountLoadObserver) => {
    observersRef.current.add(observer);
    return () => { observersRef.current.delete(observer); };
  }, []);

  /** Last threshold an actual read returned, or undefined when none has succeeded yet. */
  const readLastThreshold = useCallback(() => lastThresholdRef.current?.value, []);

  const load = useCallback(async (refreshQuota = false): Promise<boolean> => {
    const generation = ++loadGenerationRef.current;
    // Snapshot subscribers so an unsubscribe mid-flight cannot desync begin/accept pairs.
    const observers = [...observersRef.current];
    const revisions = new Map<CodexAccountLoadObserver, number>();
    for (const observer of observers) revisions.set(observer, observer.beginActiveRead());
    if (!refreshQuota) setLoadState("loading");

    const accountsTask = (async (): Promise<boolean> => {
      try {
        const response = await fetch(`${apiBase}/api/codex-auth/accounts${refreshQuota ? "?refresh=1" : ""}`);
        if (!response.ok) throw new Error("account load failed");
        const payload = await response.json();
        if (loadGenerationRef.current === generation) setAccounts(payload.accounts ?? []);
        return true;
      } catch {
        return false;
      }
    })();

    const activeTask = (async (): Promise<boolean> => {
      try {
        const response = await fetch(`${apiBase}/api/codex-auth/active`);
        if (!response.ok) throw new Error("active account load failed");
        const active = await response.json();
        if (loadGenerationRef.current === generation) {
          const serverActiveId = active.activeCodexAccountId ?? null;
          const pending = pendingActiveIdRef.current;
          if (pending && serverActiveId !== pending.id) {
            // Stale read: keep the accepted value and let the next load reconcile.
          } else {
            pendingActiveIdRef.current = null;
            setActiveId(serverActiveId);
          }
          lastThresholdRef.current = { value: active.autoSwitchThreshold };
          for (const observer of observers) {
            observer.acceptActiveRead(active.autoSwitchThreshold, revisions.get(observer)!);
          }
        }
        return true;
      } catch {
        if (loadGenerationRef.current === generation) {
          for (const observer of observers) observer.rejectActiveRead();
        }
        return false;
      }
    })();

    const [accountsOk, activeOk] = await Promise.all([accountsTask, activeTask]);
    // A newer load already superseded this one; leave its state in place.
    if (loadGenerationRef.current !== generation) return false;
    setLoadState(accountsOk && activeOk ? "ready" : "error");
    return accountsOk && activeOk;
  }, [apiBase]);

  // Initial load plus background refresh. Owned here so mounting or unmounting a surface
  // never changes the request count.
  // Initial load. Deliberately independent of `pauseCount`: previously every pause
  // transition re-ran this effect and enqueued a fetch while supposedly paused.
  useEffect(() => {
    // `enabled` is false for the inert instance a nested consumer still has to create
    // (hooks cannot be called conditionally). Without this guard, embedding
    // CodexAccountPool under a page that already owns a controller would start a second
    // poll loop and issue duplicate requests on every mount.
    if (!enabled) return;
    const timeout = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [enabled, load]);

  // Background refresh, suspended while any pause lease is held.
  useEffect(() => {
    if (!enabled || pauseCount > 0) return;
    const interval = window.setInterval(() => { void load(); }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [enabled, load, pauseCount]);

  const pauseRefresh = useCallback((): PauseToken => {
    const token = {} as PauseToken;
    pauseTokensRef.current.add(token);
    setPauseCount(pauseTokensRef.current.size);
    return token;
  }, []);

  const resumeRefresh = useCallback((token: PauseToken) => {
    if (!pauseTokensRef.current.delete(token)) return;
    setPauseCount(pauseTokensRef.current.size);
  }, []);

  const switchAccount = useCallback(async (id: string | null) => {
    if (switchingRef.current) return { ok: false, reason: "busy" } as const;
    switchingRef.current = id ?? "__main__";
    setSwitchingId(id ?? "__main__");
    try {
      const response = await fetch(`${apiBase}/api/codex-auth/active`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: id }),
      });
      if (!response.ok) throw new Error("account switch failed");
      const result = await response.json().catch(() => ({})) as { activeCodexAccountId?: string | null };
      const selectedId = result.activeCodexAccountId ?? id;
      pendingActiveIdRef.current = { id: selectedId ?? null };
      setActiveId(selectedId ?? null);
      // Reconcile in the background: the switch is already accepted upstream, so a slow
      // reload must not hold the caller's confirmation dialog open.
      void load();
      return { ok: true, activeId: selectedId ?? null } as const;
    } catch {
      return { ok: false, reason: "request" } as const;
    } finally {
      switchingRef.current = null;
      setSwitchingId(null);
    }
  }, [apiBase, load]);

  const saveAlias = useCallback(async (id: string, alias: string) => {
    try {
      const response = await fetch(`${apiBase}/api/codex-auth/accounts/alias`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, alias: alias.trim() }),
      });
      if (!response.ok) return { ok: false, reason: "request" } as const;
      await load();
      return { ok: true } as const;
    } catch {
      return { ok: false, reason: "request" } as const;
    }
  }, [apiBase, load]);

  const setAccountPaused = useCallback(async (id: string, paused: boolean) => {
    if (pauseMutationRef.current) return { ok: false, reason: "busy" } as const;
    pauseMutationRef.current = { accountId: id };
    setPauseUpdatingId(id);
    try {
      const response = await fetch(`${apiBase}/api/codex-auth/accounts/pause`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, paused }),
      });
      if (!response.ok) return { ok: false, reason: "request" } as const;
      const raw = await response.json().catch(() => ({}));
      const result = (raw && typeof raw === "object" ? raw : {}) as { activeCodexAccountId?: string | null };
      setAccounts(current => current.map(account => (
        account.id === id || (id === "__main__" && account.isMain)
          ? { ...account, paused }
          : account
      )));
      if (Object.prototype.hasOwnProperty.call(result, "activeCodexAccountId")) {
        const nextActiveId = result.activeCodexAccountId ?? null;
        pendingActiveIdRef.current = { id: nextActiveId };
        setActiveId(nextActiveId);
      }
      void load();
      return { ok: true } as const;
    } catch {
      return { ok: false, reason: "request" } as const;
    } finally {
      pauseMutationRef.current = null;
      setPauseUpdatingId(null);
    }
  }, [apiBase, load]);

  const pauseExhaustedAccounts = useCallback(async () => {
    if (pauseMutationRef.current) return { ok: false, reason: "busy" } as const;
    pauseMutationRef.current = "bulk";
    setPausingExhausted(true);
    try {
      const response = await fetch(`${apiBase}/api/codex-auth/accounts/pause-exhausted`, { method: "PUT" });
      if (!response.ok) return { ok: false, reason: "request" } as const;
      const raw = await response.json().catch(() => ({}));
      const result = (raw && typeof raw === "object" ? raw : {}) as {
        pausedAccountIds?: string[];
        pausedCount?: number;
        activeCodexAccountId?: string | null;
      };
      const pausedIds = new Set(result.pausedAccountIds ?? []);
      setAccounts(current => current.map(account => (
        pausedIds.has(account.id) || (pausedIds.has("__main__") && account.isMain)
          ? { ...account, paused: true }
          : account
      )));
      if (Object.prototype.hasOwnProperty.call(result, "activeCodexAccountId")) {
        const nextActiveId = result.activeCodexAccountId ?? null;
        pendingActiveIdRef.current = { id: nextActiveId };
        setActiveId(nextActiveId);
      }
      void load();
      return { ok: true, pausedCount: result.pausedCount ?? pausedIds.size } as const;
    } catch {
      return { ok: false, reason: "request" } as const;
    } finally {
      pauseMutationRef.current = null;
      setPausingExhausted(false);
    }
  }, [apiBase, load]);

  const removeAccount = useCallback(async (id: string) => {
    try {
      const response = await fetch(
        `${apiBase}/api/codex-auth/accounts?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!response.ok) return { ok: false, reason: "request" } as const;
      await load();
      return { ok: true } as const;
    } catch {
      return { ok: false, reason: "request" } as const;
    }
  }, [apiBase, load]);

  const syncAfterAccountAdded = useCallback(async () => {
    const ok = await load();
    return ok ? ({ ok: true } as const) : ({ ok: false, reason: "reload" } as const);
  }, [load]);

  const activePoolAccount = activeId && activeId !== "__main__"
    ? accounts.find(a => a.id === activeId)
    : null;
  const mainAccount = accounts.find(a => a.isMain);
  // Include health-only reauth so Providers overview attention matches row CTAs.
  const activeAccount = activePoolAccount ?? mainAccount;
  const activeNeedsReauth = !activeAccount?.paused && accountNeedsReauth(activeAccount);

  return {
    accounts,
    activeId,
    loadState,
    switchingId,
    pauseUpdatingId,
    pausingExhausted,
    activeNeedsReauth,
    load,
    switchAccount,
    setAccountPaused,
    pauseExhaustedAccounts,
    saveAlias,
    removeAccount,
    syncAfterAccountAdded,
    pauseRefresh,
    resumeRefresh,
    subscribeLoadObserver,
    readLastThreshold,
  };
}
