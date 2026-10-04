import { readConfigAdmissionSnapshot } from "../config/diagnostics";
import { readRuntimePort } from "../config/process-state";
import { readClientConnectionState } from "../client/state";
import { getActiveTurnCount, isDraining, isRecyclingForExit, isShutdownDraining } from "../server/lifecycle";
import type { OcxConfig } from "../types";
import { observeCatalogHealFile, selectCatalogHealPath, type CatalogObservation } from "./catalog/heal-observation";
import { subscribeCatalogPublication } from "./catalog/publication-observer";
import { configEnablesRoutedNamespace, ocxRoutedNamespaceCounts } from "./catalog/routed-removal";
import { inspectCodexHomeOwner } from "./codex-home-owner";
import { shouldSyncCodexOnStart } from "./desired-state";
import { JOURNAL_PATH, journalOwner } from "./journal";
import { CODEX_HOME, DEFAULT_CATALOG_PATH, resolveCodexConfigPath } from "./paths";
import { siblingOfLivePort } from "./sibling-start";

export type { CatalogObservation } from "./catalog/heal-observation";
export const CATALOG_HEAL_TICK_MS = 30_000;
export const CATALOG_HEAL_RECHECK_MS = 5 * 60_000;
export const CATALOG_HEAL_WINDOW_MS = 60 * 60_000;
export const CATALOG_HEAL_MAX_ATTEMPTS = 6;
export const CATALOG_HEAL_MAX_HEALS = 3;

export type CatalogSelfHealGate = "sibling" | "exiting" | "idle" | "runtime-record" | "config-unavailable" | "codex-off" | "not-owner" | "client";
export interface CatalogSelfHealGates {
  siblingOfLivePort(): number | null;
  exiting(): boolean;
  idle(): boolean;
  runtimeOwned(): boolean;
  /** File-backed config authority; missing, malformed or salvaged config returns null. */
  loadConfig(): OcxConfig | null;
  ownsCodexHome(): boolean;
  clientConnected(): boolean;
  clientJournalOwner(): boolean;
}
export interface CatalogHealOutcome { readonly committed: boolean }
export interface CatalogHealLifecycle {
  readonly beforeCommit: () => boolean;
  readonly expectedCatalogPath: string;
}
export interface CatalogSelfHealRecord {
  readonly at: string;
  readonly lostNamespaces: number;
  readonly committed: boolean;
}
export interface CatalogSelfHealHandle {
  stop(): void;
  lastHeal(): CatalogSelfHealRecord | null;
  tickForTests(): Promise<void>;
}
export interface CatalogSelfHealDeps {
  scheduleFn?: (fn: () => void, ms: number) => { cancel(): void };
  now?: () => number;
  catalogPath?: () => string | null;
  observe?: (path: string, readContent: boolean) => CatalogObservation | null;
  converge?: (config: OcxConfig, lifecycle: CatalogHealLifecycle) => Promise<CatalogHealOutcome>;
  subscribe?: typeof subscribeCatalogPublication;
  gates?: Partial<CatalogSelfHealGates>;
  log?: Pick<Console, "warn">;
}

function defaultSchedule(fn: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}

async function convergeOwnCatalog(config: OcxConfig, lifecycle: CatalogHealLifecycle): Promise<CatalogHealOutcome> {
  const [{ armDetachedConfigBaseline }, { createManagementConvergeCodex }, { createCatalogConvergeRequest }] = await Promise.all([
    import("../config"), import("./management-convergence"), import("./catalog-admission"),
  ]);
  if (!lifecycle.beforeCommit()) return { committed: false };
  // Discovery persistence rebases this detached snapshot against current disk config.
  armDetachedConfigBaseline(config);
  const outcome = await createManagementConvergeCodex(config, lifecycle)(createCatalogConvergeRequest({ deadlineMs: 1_000 }));
  return { committed: outcome.kind === "catalog-only" && outcome.catalogRefresh.status === "committed" };
}

export function evaluateCatalogSelfHealGates(gates: CatalogSelfHealGates):
  { readonly open: true; readonly config: OcxConfig } | { readonly open: false; readonly gate: CatalogSelfHealGate } {
  if (gates.siblingOfLivePort() !== null) return { open: false, gate: "sibling" };
  if (gates.exiting()) return { open: false, gate: "exiting" };
  if (!gates.idle()) return { open: false, gate: "idle" };
  if (!gates.runtimeOwned()) return { open: false, gate: "runtime-record" };
  const config = gates.loadConfig();
  if (config === null) return { open: false, gate: "config-unavailable" };
  if (!shouldSyncCodexOnStart(config)) return { open: false, gate: "codex-off" };
  if (gates.clientConnected() || gates.clientJournalOwner()) return { open: false, gate: "client" };
  if (!gates.ownsCodexHome()) return { open: false, gate: "not-owner" };
  return { open: true, config };
}

type NamespaceObservation = { path: string; signature: string; namespaces: ReadonlySet<string> | null };

/** Owner lifecycle only: importing this module starts no timer or publication subscription. */
export function startCodexCatalogSelfHeal(options: { port?: number; deps?: CatalogSelfHealDeps } = {}): CatalogSelfHealHandle {
  const deps = options.deps ?? {};
  const scheduleFn = deps.scheduleFn ?? defaultSchedule;
  const clock = deps.now ?? (() => performance.now());
  const catalogPath = deps.catalogPath ?? (() => selectCatalogHealPath(JOURNAL_PATH, DEFAULT_CATALOG_PATH, resolveCodexConfigPath));
  const observe = deps.observe ?? observeCatalogHealFile;
  const converge = deps.converge ?? convergeOwnCatalog;
  const gates: CatalogSelfHealGates = {
    siblingOfLivePort,
    exiting: () => isRecyclingForExit() || isShutdownDraining(),
    idle: () => !isDraining() && getActiveTurnCount() === 0,
    runtimeOwned: () => {
      const runtime = readRuntimePort(process.pid);
      return runtime !== null && runtime.siblingOfPort === undefined
        && (options.port === undefined || runtime.port === options.port);
    },
    loadConfig: () => {
      const snapshot = readConfigAdmissionSnapshot();
      return snapshot.kind === "read" && snapshot.diagnostics.source === "file"
        ? snapshot.diagnostics.config : null;
    },
    ownsCodexHome: () => {
      const owner = inspectCodexHomeOwner(CODEX_HOME);
      return owner.kind === "owned" || owner.kind === "unbound";
    },
    clientConnected: () => readClientConnectionState().kind !== "disconnected",
    clientJournalOwner: () => journalOwner({ readOnly: true })?.kind === "client",
    ...deps.gates,
  };
  const log = deps.log ?? console;
  let stopped = false;
  let released = false;
  let generation = 0;
  let timer: { cancel(): void } | undefined;
  let running = false;
  let last: CatalogSelfHealRecord | null = null;
  let target: string | null = null;
  let baseline: NamespaceObservation | null = null;
  let observed: NamespaceObservation | null = null;
  let pendingRetry: { path: string; lostNamespaces: readonly string[] } | null = null;
  let recheckAt = 0;
  const attempts: number[] = [];
  const heals: number[] = [];

  const read = (path: string): NamespaceObservation | null => {
    const quick = observe(path, false);
    if (quick === null) return null;
    if (observed?.path === path && observed.signature === quick.signature) return observed;
    const seen = observe(path, true);
    if (seen === null) return null;
    observed = { path, signature: seen.signature, namespaces: seen.catalog ? new Set(ocxRoutedNamespaceCounts(seen.catalog).keys()) : null };
    return observed;
  };
  const accept = (path: string): void => {
    const seen = read(path);
    if (seen?.namespaces != null) baseline = seen;
  };
  const clear = (): void => {
    generation += 1;
    baseline = observed = null;
    pendingRetry = null;
    recheckAt = 0;
  };
  const updateTarget = (path: string | null): void => {
    // Unavailable selection is not evidence of a different target or lost authority.
    if (path === null) return;
    if (target === path) return;
    clear();
    target = path;
  };
  const beforeCommit = (path: string, entryGeneration: number): boolean => {
    try {
      return !stopped && !released && generation === entryGeneration
        && catalogPath() === path && evaluateCatalogSelfHealGates(gates).open;
    } catch { return false; }
  };
  const capRetryAt = (now: number): number => {
    while (attempts.length && now - attempts[0]! >= CATALOG_HEAL_WINDOW_MS) attempts.shift();
    while (heals.length && now - heals[0]! >= CATALOG_HEAL_WINDOW_MS) heals.shift();
    return Math.max(
      attempts.length >= CATALOG_HEAL_MAX_ATTEMPTS ? attempts[0]! + CATALOG_HEAL_WINDOW_MS : 0,
      heals.length >= CATALOG_HEAL_MAX_HEALS ? heals[0]! + CATALOG_HEAL_WINDOW_MS : 0,
    );
  };

  const tick = async (): Promise<void> => {
    if (stopped || running || released) return;
    running = true;
    try {
      const path = catalogPath();
      updateTarget(path);
      if (path === null) return;
      // Pending cache/funnel failure is independent of catalog stat or apparent repaired rows.
      if (pendingRetry) {
        const config = gates.loadConfig();
        if (config === null) return;
        const enabled = pendingRetry.lostNamespaces.filter(ns => configEnablesRoutedNamespace(config, ns));
        if (enabled.length === 0) {
          pendingRetry = null;
          recheckAt = 0;
          const seen = read(path);
          if (seen?.namespaces != null) baseline = seen;
          return;
        }
        pendingRetry = { path, lostNamespaces: enabled };
      }
      const now = clock();
      if (now < recheckAt) return;
      const seen = read(path);
      // Missing/corrupt custom paths are unavailable, never reconstructed from the default.
      if (seen?.namespaces == null) return;
      if (baseline === null) { baseline = seen; return; }
      if (!pendingRetry) {
        if (baseline.signature === seen.signature) return;
        const lost = [...baseline.namespaces!].filter(ns => !seen.namespaces!.has(ns));
        if (lost.length === 0) { baseline = seen; return; }
        pendingRetry = { path, lostNamespaces: lost };
      }
      const gate = evaluateCatalogSelfHealGates(gates);
      if (!gate.open) { recheckAt = now + CATALOG_HEAL_RECHECK_MS; return; }
      const lostEnabled = pendingRetry.lostNamespaces.filter(ns => configEnablesRoutedNamespace(gate.config, ns));
      if (lostEnabled.length === 0) { pendingRetry = null; baseline = seen; return; }
      pendingRetry = { path, lostNamespaces: lostEnabled };
      const cappedUntil = capRetryAt(now);
      if (cappedUntil > now) { recheckAt = cappedUntil; return; }
      attempts.push(now);
      const entryGeneration = generation;
      log.warn(`[catalog-self-heal] republishing ${lostEnabled.length} lost routed provider namespace${lostEnabled.length === 1 ? "" : "s"}`);
      let committed = false;
      try { committed = (await converge(gate.config, {
        beforeCommit: () => beforeCommit(path, entryGeneration), expectedCatalogPath: path,
      })).committed; }
      catch { /* Failed attempts retain pending retry and consume the attempt budget. */ }
      if (stopped || released || generation !== entryGeneration || catalogPath() !== path) return;
      last = { at: new Date().toISOString(), lostNamespaces: lostEnabled.length, committed };
      if (committed) {
        heals.push(clock());
        pendingRetry = null;
        recheckAt = 0;
        accept(path); // Authoritative emptiness is a successful owner baseline too.
      } else recheckAt = clock() + CATALOG_HEAL_RECHECK_MS;
    } catch {
      log.warn("[catalog-self-heal] observation unavailable; deferred");
    } finally { running = false; }
  };

  const unsubscribe = (deps.subscribe ?? subscribeCatalogPublication)(event => {
    if (stopped) return;
    // Native restoration can remove the journal before notification. Fence the known
    // target (and target-less releases) without resolving possibly unavailable evidence.
    const release = event.kind === "native-released" || event.intent === "restore";
    if (release && (event.path === null || event.path === target)) {
      clear();
      released = true;
      return;
    }
    const path = catalogPath();
    if (event.path !== null && event.path !== target && event.path !== path) return;
    if (release) {
      clear();
      released = true; // Only a later accepted owner publication can re-arm this lifecycle.
      return;
    }
    if (running) return; // Catalog-success/cache-failure must not accept a baseline.
    if (!evaluateCatalogSelfHealGates(gates).open || event.path !== path) return;
    updateTarget(path);
    released = false;
    pendingRetry = null;
    recheckAt = 0;
    accept(event.path);
  });
  // Capture immediately after startup sync, before a foreign write can become the first tick.
  try { updateTarget(catalogPath()); if (target !== null) accept(target); }
  catch { /* Unavailable observation can be retried by the scheduled tick. */ }
  const schedule = (): void => {
    if (stopped) return;
    timer = scheduleFn(() => {
      void tick().catch(() => log.warn("[catalog-self-heal] scheduled observation failed")).finally(schedule);
    }, CATALOG_HEAL_TICK_MS);
  };
  schedule();
  return {
    stop() { stopped = true; clear(); timer?.cancel(); timer = undefined; unsubscribe(); },
    lastHeal: () => last,
    tickForTests: tick,
  };
}
