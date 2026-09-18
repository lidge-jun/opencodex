import {
  applyNativeMain, canApplyNativeMain, canRegisterNativeMain, NativeMainError, nativeMainErrorCode,
  readNativeMainSnapshot, registerNativeMain, sameNativeMainScope,
  type NativeMainAction, type NativeMainErrorCode, type NativeMainSnapshot,
} from "./native-main-profiles";

export interface NativeMainProfileState {
  open: boolean;
  busy: boolean;
  blocked: boolean;
  snapshot: NativeMainSnapshot | null;
  label: string;
  action: NativeMainAction | null;
  confirmedStopped: boolean;
  previous: { id: string | null; home: string; active: string } | null;
  error: NativeMainErrorCode | null;
  result: "saved" | "restart" | "done" | null;
  refreshFailed: boolean;
}
type Listener = (state: NativeMainProfileState) => void;

/** The account refresh is someone else's promise, so it gets its own bound. */
const ACCOUNT_REFRESH_TIMEOUT_MS = 20_000;
const ACCOUNT_REFRESH_TIMED_OUT = Symbol("account-refresh-timeout");

/** One in-memory disclosure session per apiBase; no timers or reads until opened. */
export class NativeMainProfileSession {
  state: NativeMainProfileState = {
    open: false, busy: false, blocked: false, snapshot: null, label: "", action: null,
    confirmedStopped: false, previous: null, error: null, result: null, refreshFailed: false,
  };
  private listener: Listener | null = null;
  private epoch = 0;
  private pending: AbortController | null = null;
  private onChanged: (signal?: AbortSignal) => unknown | Promise<unknown> = () => {};
  private restartRequired = false;
  private resultHome: string | null = null;

  private readonly apiBase: string;
  private readonly accountRefreshTimeoutMs: number;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(apiBase: string, accountRefreshTimeoutMs = ACCOUNT_REFRESH_TIMEOUT_MS, fetchImpl?: typeof fetch) {
    this.apiBase = apiBase;
    this.accountRefreshTimeoutMs = accountRefreshTimeoutMs;
    this.fetchImpl = fetchImpl;
  }

  attach(listener: Listener): () => void {
    const epoch = ++this.epoch;
    this.listener = listener;
    listener(this.state);
    return () => {
      if (this.epoch !== epoch) return;
      this.epoch++;
      this.listener = null;
      this.pending?.abort();
      this.pending = null;
      // StrictMode may reattach this same instance. Do not revive an uncertain
      // mutation's confirmation or old snapshot on the next mount.
      if (this.state.busy) this.state = { ...this.state, busy: false, snapshot: null,
        action: null, confirmedStopped: false, previous: null, refreshFailed: true };
    };
  }

  updateOptions(blocked: boolean, onChanged: (signal?: AbortSignal) => unknown | Promise<unknown>): void {
    this.onChanged = onChanged;
    if (this.state.blocked !== blocked) this.set({ blocked, action: null, confirmedStopped: false });
  }
  private set(patch: Partial<NativeMainProfileState>): void {
    this.state = { ...this.state, ...patch };
    this.listener?.(this.state);
  }
  private current(epoch: number): boolean { return this.epoch === epoch && this.listener !== null; }
  private accept(snapshot: NativeMainSnapshot): void {
    const p = this.state.previous;
    const changedHome = this.resultHome !== null && this.resultHome !== snapshot.doctor.effectiveCodexHome;
    if (changedHome) { this.restartRequired = false; this.resultHome = null; }
    this.set({ snapshot, ...(changedHome ? { result: null } : {}), previous: p && p.home === snapshot.doctor.effectiveCodexHome
      && p.active === snapshot.doctor.activeProfileId ? p : null });
  }

  setLabel(label: string): void { if (!this.pending) this.set({ label }); }
  setStopped(confirmedStopped: boolean): void {
    if (!this.pending && this.state.action && !this.state.blocked) this.set({ confirmedStopped });
  }
  select(action: NativeMainAction | null): void {
    if (this.pending) return;
    if (action && (this.state.blocked || this.state.refreshFailed || !this.state.snapshot
      || !canApplyNativeMain(this.state.snapshot, action))) return;
    this.set({ action, confirmedStopped: false, error: null });
  }
  async toggle(): Promise<void> {
    if (this.pending) return;
    const open = !this.state.open;
    this.set({ open, action: null, confirmedStopped: false });
    if (open) await this.refresh();
  }

  private async run(operation: (epoch: number, signal: AbortSignal) => Promise<void>): Promise<void> {
    // Synchronous lease: duplicate clicks cannot start another read or write.
    if (!this.listener || this.pending || this.state.blocked) return;
    const epoch = this.epoch;
    const controller = new AbortController();
    this.pending = controller;
    const timeout = setTimeout(() => controller.abort(), 45_000);
    this.set({ busy: true });
    try { await operation(epoch, controller.signal); }
    catch (error) {
      if (this.current(epoch)) this.set({ error: nativeMainErrorCode(error), snapshot: null });
    } finally {
      clearTimeout(timeout);
      if (this.current(epoch)) { this.pending = null; this.set({ busy: false }); }
    }
  }

  async refresh(): Promise<void> {
    if (this.state.action) return;
    await this.run(async (epoch, signal) => {
      const retryAccountRead = this.state.refreshFailed;
      this.set({ error: null });
      const snapshot = await readNativeMainSnapshot(this.apiBase, signal, this.fetchImpl);
      if (!this.current(epoch)) return;
      this.accept(snapshot);
      this.set({ refreshFailed: false });
      if (retryAccountRead) await this.refreshAccount(epoch);
    });
  }
  private async refreshAccount(epoch: number): Promise<void> {
    if (!this.current(epoch)) return;
    // A callback that never settles would otherwise hold `pending`/`busy` forever and
    // make the session ignore every later refresh, mutation and toggle. Cancel it,
    // stop waiting, and report the refresh as failed rather than as confirmed.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const call = (async () => {
      try { return await this.onChanged(controller.signal); }
      catch { return false; }
    })();
    const bound = new Promise<typeof ACCOUNT_REFRESH_TIMED_OUT>(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(ACCOUNT_REFRESH_TIMED_OUT);
      }, this.accountRefreshTimeoutMs);
    });
    try {
      const ok = await Promise.race([call, bound]);
      if (this.current(epoch) && (ok === false || ok === ACCOUNT_REFRESH_TIMED_OUT)) this.set({ refreshFailed: true });
    } finally { clearTimeout(timer); }
  }
  private async reconcile(epoch: number): Promise<void> {
    if (!this.current(epoch)) return;
    // A timed-out write can have committed. Use a fresh signal, GET only, and
    // refresh the main-account controller even if the profile read fails.
    const controller = new AbortController();
    this.pending = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const snapshot = await readNativeMainSnapshot(this.apiBase, controller.signal, this.fetchImpl);
      if (!this.current(epoch)) return;
      this.accept(snapshot);
    } catch {
      if (this.current(epoch)) this.set({ snapshot: null, refreshFailed: true });
    } finally { clearTimeout(timeout); }
    await this.refreshAccount(epoch);
  }

  async register(): Promise<void> {
    const before = this.state.snapshot;
    const label = this.state.label.trim();
    if (!before || this.state.refreshFailed || !label || this.state.action || !canRegisterNativeMain(before)) return;
    await this.mutate(before, { label });
  }
  async confirm(): Promise<void> {
    const { snapshot, action, confirmedStopped, refreshFailed } = this.state;
    if (!snapshot || !action || !confirmedStopped || refreshFailed || !canApplyNativeMain(snapshot, action)) return;
    await this.mutate(snapshot, { action });
  }

  private async mutate(before: NativeMainSnapshot, input: { label: string } | { action: NativeMainAction }): Promise<void> {
    await this.run(async (epoch, signal) => {
      this.set({ error: null, result: this.restartRequired ? "restart" : null, refreshFailed: false });
      let dispatched = false;
      try {
        const current = await readNativeMainSnapshot(this.apiBase, signal, this.fetchImpl);
        signal.throwIfAborted();
        if (!this.current(epoch) || this.state.blocked) return;
        this.accept(current);
        if (!sameNativeMainScope(before, current) || ("action" in input
          ? !canApplyNativeMain(current, input.action) : !canRegisterNativeMain(current))) {
          throw new NativeMainError("STATE_CHANGED");
        }
        dispatched = true;
        if ("label" in input) {
          const home = await registerNativeMain(this.apiBase, input.label, signal, this.fetchImpl);
          if (!this.current(epoch)) return;
          if (home !== before.doctor.effectiveCodexHome) throw new NativeMainError("STATE_CHANGED");
          this.resultHome = home;
          this.set({ label: "", result: this.restartRequired ? "restart" : "saved" });
        } else {
          const outcome = await applyNativeMain(this.apiBase, input.action, true, signal, this.fetchImpl);
          if (!this.current(epoch)) return;
          if (outcome.effectiveCodexHome !== before.doctor.effectiveCodexHome) throw new NativeMainError("STATE_CHANGED");
          this.resultHome = outcome.effectiveCodexHome;
          this.restartRequired ||= outcome.restartRequired;
          // The API does not return the transaction source. This is a shortcut
          // to the previously displayed profile, never an authoritative undo.
          this.set({ previous: input.action.kind === "switch" ? {
            id: before.doctor.activeProfileId, home: before.doctor.effectiveCodexHome, active: input.action.target,
          } : null, result: this.restartRequired ? "restart" : "done" });
        }
      } catch (error) {
        if (this.current(epoch)) this.set({ error: nativeMainErrorCode(error), previous: null });
      } finally {
        if (this.current(epoch)) this.set({ action: null, confirmedStopped: false });
        if (dispatched) await this.reconcile(epoch);
      }
    });
  }
}
