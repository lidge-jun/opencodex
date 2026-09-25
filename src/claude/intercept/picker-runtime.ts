/**
 * Claude Desktop picker mode: when to terminate claude.ai, and the pieces that do it.
 *
 * Picker mode lists opencodex models by name in Desktop's Code-tab picker while Desktop stays
 * first-party. Desktop's own egress profile (wp4) points the app at the intercept CONNECT proxy;
 * for every tunnel the proxy asks `selectTunnel`, and only `claude.ai:443` can ever come back as
 * `intercept`. Everything else, and claude.ai whenever any condition fails, is a blind tunnel.
 *
 * The decision is cached by `refresh()` and only read by `selectTunnel`, so a CONNECT never
 * waits on the keychain or the catalog. Arming needs all of: macOS, the persisted resolved mode is
 * first-party (observation-aware, so a pre-field first-party install counts), Desktop intent on,
 * `claudeCode.intercept.picker !== false`, the disarm latch clear, the picker listener up and the
 * current picker CA trusted in the login keychain. `disarm()` stops terminating immediately and
 * latches; only the picker controller's owner-only `rearm()` clears the latch.
 */
import { join } from "node:path";
import type { OcxConfig } from "../../types";
import type { ClaudeDesktopMode } from "../desktop-first-party";
import type { TunnelDecision } from "./connect-proxy";
import type { PemKeyPair } from "./local-ca";
import { PICKER_HOST, ensurePickerCa, issuePickerLeaf, pickerCaFingerprints, pickerLeafCertPath, pickerStateDir, type PickerCa } from "./picker-ca";
import { startPickerListener, type PickerListenerHandle } from "./picker-listener";
import { createPickerModelSnapshot, type PickerModelSnapshot, type PickerRouteInput } from "./picker-models";
import { inspectPickerTrust, type PickerTrustState, type SecurityRunner } from "./picker-trust";

export type TunnelChoice = TunnelDecision;

/** A claude.ai CONNECT that arrives before the first refresh waits at most this long. */
export const PICKER_STARTUP_WAIT_MS = 3_000;
export const PICKER_REFRESH_INTERVAL_MS = 60_000;
export const PICKER_TRUST_TTL_MS = 30_000;
/** Discovery for the picker list is refreshed in the background once the snapshot is this old. */
export const PICKER_MODELS_MAX_AGE_MS = 5 * 60_000;
export const PICKER_MODELS_FILE = "models.json";

export type PickerRuntimeReason =
  | "active"
  | "starting"
  | "unsupported_platform"
  | "not_desired"
  | "disarmed"
  | "busy"
  | "trust_untrusted"
  | "trust_unknown"
  | "listener_failed"
  | "refresh_failed"
  | "stopped";

export interface PickerRuntimeStatus {
  desired: boolean;
  supported: boolean;
  trust: PickerTrustState;
  listenerReady: boolean;
  effective: boolean;
  latched: boolean;
  reason: PickerRuntimeReason;
  models: number;
  snapshotAt: number | null;
  /** Last time Desktop fetched a bootstrap through the picker listener (null = not since start). */
  lastBootstrapAt: number | null;
}

export interface PickerRuntime {
  selectTunnel(host: string, port: number): TunnelChoice | null | Promise<TunnelChoice | null>;
  refreshTrust(): Promise<PickerTrustState>;
  refresh(): Promise<void>;
  disarm(): void;
  rearm(): Promise<void>;
  ensureStarted(): Promise<void>;
  start(): Promise<void>;
  readonly ready: Promise<void>;
  status(): PickerRuntimeStatus;
  stop(): Promise<void>;
}

export interface CreatePickerRuntimeOptions {
  config: OcxConfig;
  /** Persisted config for every decision; defaults to `loadConfig`. */
  readConfig?: () => OcxConfig;
  /** True while the picker controller holds its lock; refresh() then never arms. */
  isBusy?: () => boolean;
  configDir: string;
  loadRoutes: () => Promise<PickerRouteInput>;
  security?: SecurityRunner;
  platform?: NodeJS.Platform;
  now?: () => number;
  trustTtlMs?: number;
  startupWaitMs?: number;
  refreshIntervalMs?: number;
  /** Test seam: the observation-aware resolved Desktop mode for a config. */
  resolveMode?: (config: OcxConfig) => ClaudeDesktopMode | Promise<ClaudeDesktopMode>;
  /** Test seam: the claude.ai terminator. */
  startListener?: typeof startPickerListener;
  log?: (line: string) => void;
}

/**
 * Whether picker mode should run for this persisted config and resolved mode. Desktop intent uses
 * the durable-intent rule of `claudeDesktopIntegrationEnabled` (src/codex/desired-state.ts): only an
 * explicit `false` turns it off. The picker preference is the same: on unless explicitly false.
 */
export function pickerDesired(
  config: Pick<OcxConfig, "claudeCode" | "clientIntegrations">,
  mode: ClaudeDesktopMode,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "darwin"
    && config.clientIntegrations?.["claude-desktop"] !== false
    && mode === "first-party"
    && config.claudeCode?.intercept?.picker !== false;
}

async function defaultResolveMode(config: OcxConfig): Promise<ClaudeDesktopMode> {
  // Dynamic: desktop-first-party imports intercept/runtime, which imports this module.
  const { observeClaudeDesktopMode, resolveClaudeDesktopMode } = await import("../desktop-first-party");
  return resolveClaudeDesktopMode(config, observeClaudeDesktopMode(config));
}

async function defaultReadConfig(): Promise<() => OcxConfig> {
  const { loadConfig } = await import("../../config");
  return loadConfig;
}

export function createPickerRuntime(options: CreatePickerRuntimeOptions): PickerRuntime {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const trustTtlMs = options.trustTtlMs ?? PICKER_TRUST_TTL_MS;
  const startupWaitMs = options.startupWaitMs ?? PICKER_STARTUP_WAIT_MS;
  const refreshIntervalMs = options.refreshIntervalMs ?? PICKER_REFRESH_INTERVAL_MS;
  const resolveMode = options.resolveMode ?? defaultResolveMode;
  const startListener = options.startListener ?? startPickerListener;
  const log = options.log ?? (() => {});

  let desired = false;
  let armed = false;
  let latched = false;
  let stopped = false;
  let started = false;
  let firstRefreshDone = false;
  let generation = 0;
  let reason: PickerRuntimeReason = "starting";
  let trust: PickerTrustState = "unknown";
  let trustCheckedAt = -Infinity;
  let trustFor: string | null = null;
  let ca: PickerCa | null = null;
  let caSha1: string | null = null;
  let leaf: PemKeyPair | null = null;
  let snapshot: PickerModelSnapshot | null = null;
  let listener: PickerListenerHandle | null = null;
  let listenerPromise: Promise<PickerListenerHandle> | null = null;
  let lastBootstrapAt: number | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let readConfig: (() => OcxConfig) | null = options.readConfig ?? null;
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });

  function closeListener(): void {
    const pending = listenerPromise;
    listenerPromise = null;
    listener = null;
    if (pending) void pending.then(handle => handle.close()).catch(() => {});
  }

  function ensureMaterial(): { ca: PickerCa; leaf: PemKeyPair; sha1: string } {
    if (!ca || !leaf || !caSha1) {
      ca = ensurePickerCa(options.configDir);
      leaf = issuePickerLeaf(ca, options.configDir);
      caSha1 = pickerCaFingerprints(ca.certPem).sha1;
    }
    return { ca, leaf, sha1: caSha1 };
  }

  function ensureSnapshot(): PickerModelSnapshot {
    snapshot ??= createPickerModelSnapshot(options.loadRoutes, join(pickerStateDir(options.configDir), PICKER_MODELS_FILE));
    return snapshot;
  }

  async function inspectTrust(force: boolean): Promise<PickerTrustState> {
    const { sha1 } = ensureMaterial();
    if (!force && trustFor === sha1 && now() - trustCheckedAt < trustTtlMs) return trust;
    trust = await inspectPickerTrust(pickerLeafCertPath(options.configDir), sha1, options.security, platform);
    trustFor = sha1;
    trustCheckedAt = now();
    return trust;
  }

  /** CA, leaf, snapshot and listener. Resolves false when a disarm overtook it. */
  async function startPieces(gen: number): Promise<boolean> {
    const material = ensureMaterial();
    ensureSnapshot().refreshIfStale(PICKER_MODELS_MAX_AGE_MS);
    if (!listenerPromise) {
      const current = startListener({
        leaf: material.leaf,
        models: () => {
          lastBootstrapAt = now();
          return ensureSnapshot().current()?.models ?? [];
        },
        log,
      });
      listenerPromise = current;
      current.catch(() => { if (listenerPromise === current) listenerPromise = null; });
    }
    const pending = listenerPromise;
    const handle = await pending;
    if (gen !== generation || latched || stopped || listenerPromise !== pending) return false;
    listener = handle;
    return true;
  }

  async function evaluate(bypassBusy: boolean, forceTrust: boolean): Promise<void> {
    const gen = generation;
    if (stopped) return;
    try {
      readConfig ??= await defaultReadConfig();
      const fresh = readConfig();
      const mode = await resolveMode(fresh);
      if (gen !== generation || stopped) return;
      desired = pickerDesired(fresh, mode, platform);
      if (!desired || latched) {
        armed = false;
        reason = platform !== "darwin" ? "unsupported_platform" : latched ? "disarmed" : "not_desired";
        closeListener();
        return;
      }
      if (!bypassBusy && options.isBusy?.()) {
        reason = armed ? reason : "busy";
        return;
      }
      let up: boolean;
      try {
        up = await startPieces(gen);
      } catch {
        armed = false;
        reason = "listener_failed";
        return;
      }
      if (!up) return;
      const state = await inspectTrust(forceTrust);
      if (gen !== generation || latched || stopped) return;
      armed = state === "trusted" && listener !== null;
      reason = armed ? "active" : state === "unknown" ? "trust_unknown" : state === "unsupported" ? "unsupported_platform" : "trust_untrusted";
    } catch (error) {
      if (gen !== generation) return;
      armed = false;
      reason = "refresh_failed";
      log(`picker refresh failed (${error instanceof Error ? error.name : "error"})`);
    }
  }

  function currentChoice(): TunnelChoice {
    return armed && listener && !latched && !stopped
      ? { kind: "intercept", port: listener.port }
      : { kind: "blind" };
  }

  return {
    ready,
    selectTunnel(host, port) {
      if (host.toLowerCase() !== PICKER_HOST || port !== 443) return null;
      if (!started || firstRefreshDone || stopped) return currentChoice();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), startupWaitMs); });
      return Promise.race([ready.then(() => "ready" as const), timeout]).then(outcome => {
        clearTimeout(timer);
        return outcome === "ready" ? currentChoice() : { kind: "blind" as const };
      });
    },
    async refreshTrust() {
      return inspectTrust(true);
    },
    async refresh() {
      await evaluate(false, false);
    },
    disarm() {
      latched = true;
      armed = false;
      generation += 1;
      reason = "disarmed";
      closeListener();
    },
    async rearm() {
      if (stopped) return;
      latched = false;
      await evaluate(true, true);
    },
    async ensureStarted() {
      if (latched || stopped) return;
      await startPieces(generation);
    },
    start() {
      if (started) return ready;
      started = true;
      void evaluate(false, false).finally(() => {
        firstRefreshDone = true;
        resolveReady();
      });
      interval = setInterval(() => { void evaluate(false, false); }, refreshIntervalMs);
      (interval as { unref?: () => void }).unref?.();
      return ready;
    },
    status() {
      const current = snapshot?.current() ?? null;
      return {
        desired,
        supported: platform === "darwin",
        trust,
        listenerReady: listener !== null,
        effective: armed && listener !== null && !latched && !stopped,
        latched,
        reason: stopped ? "stopped" : reason,
        models: current?.models.length ?? 0,
        snapshotAt: current?.builtAt ?? null,
        lastBootstrapAt,
      };
    },
    async stop() {
      stopped = true;
      armed = false;
      generation += 1;
      if (interval) clearInterval(interval);
      interval = null;
      firstRefreshDone = true;
      resolveReady();
      const pending = listenerPromise;
      listenerPromise = null;
      listener = null;
      if (pending) await pending.then(handle => handle.close(), () => {});
    },
  };
}
