import { readFileSync, realpathSync, statSync } from "node:fs";

import { loadConfig } from "../config";
import { readClientConnectionState } from "../client/state";
import { isRecyclingForExit, isShutdownDraining } from "../server/lifecycle";
import type { OcxConfig } from "../types";
import { selectDriftHealCatalogPath } from "./catalog-auto-refresh";
import { configEnablesRoutedNamespace, ocxRoutedNamespaceCounts } from "./catalog/routed-removal";
import type { RawCatalog } from "./catalog/parsing";
import { inspectCodexHomeOwner } from "./codex-home-owner";
import { shouldSyncCodexOnStart } from "./desired-state";
import { JOURNAL_PATH } from "./journal";
import { CODEX_HOME, DEFAULT_CATALOG_PATH, resolveCodexConfigPath } from "./paths";
import { siblingOfLivePort } from "./sibling-start";

/**
 * The live owner republishes a Codex catalog that lost the routed models it publishes (#6529).
 *
 * Startup sync, management writes and the hourly refresh are the only times the owner writes the
 * catalog. A catalog another process rewrote in between (the #6529 incident: native-only, from a
 * process with an empty OPENCODEX_HOME) stayed wrong until the next of those, which for a quiet
 * install can be days. This loop closes that gap.
 *
 * Cost: one `stat` of the catalog every 30 s from an unref'd timer. The file is parsed only when
 * its identity (device, inode, size, mtime) changed. A heal runs only when routed namespaces that
 * were in the catalog are gone, the owner's config still enables them, and every gate is open. It
 * is the owner's ordinary catalog convergence, so the config-backed removal rule, the Codex-home
 * binding and the audit trail all apply. Whatever that convergence publishes becomes the new
 * baseline, so a namespace the owner itself legitimately emptied (an authoritative empty provider)
 * is looked at once, not fought. Rate and flap caps pause the loop for at most an hour and never
 * stop it. Started only from `handleStart`'s owner path and stopped in its exit cleanup.
 */

export const CATALOG_HEAL_TICK_MS = 30_000;
export const CATALOG_HEAL_RECHECK_MS = 5 * 60_000;
export const CATALOG_HEAL_WINDOW_MS = 60 * 60_000;
/** Convergence attempts (refused and failed ones included) per rolling window. */
export const CATALOG_HEAL_MAX_ATTEMPTS = 6;
/** Successful republishes per window: more means another writer keeps rewriting the catalog. */
export const CATALOG_HEAL_MAX_HEALS = 3;

export type CatalogSelfHealGate = "sibling" | "exiting" | "codex-off" | "not-owner" | "client";

export interface CatalogSelfHealGates {
  siblingOfLivePort(): number | null;
  exiting(): boolean;
  loadConfig(): OcxConfig;
  /** This process's OPENCODEX_HOME is the one the Codex home's journal is bound to (or nothing is bound). */
  ownsCodexHome(): boolean;
  /** A connected client takes its catalog from the hub (`ocx catalog pull`), not from this config. */
  clientConnected(): boolean;
}

export interface CatalogObservation {
  /** Device, inode, size and mtime; equal signatures are not read again. */
  readonly signature: string;
  readonly catalog: RawCatalog | null;
}

export interface CatalogHealOutcome {
  /** The convergence wrote a catalog (changed or not). */
  readonly committed: boolean;
}

export interface CatalogSelfHealRecord {
  readonly at: string;
  readonly lostNamespaces: number;
  readonly committed: boolean;
}

export interface CatalogSelfHealHandle {
  stop(): void;
  lastHeal(): CatalogSelfHealRecord | null;
  /** Test-only: run one tick now. */
  tickForTests(): Promise<void>;
}

export interface CatalogSelfHealDeps {
  scheduleFn?: (fn: () => void, ms: number) => { cancel(): void };
  now?: () => number;
  catalogPath?: () => string | null;
  observe?: (path: string, readContent: boolean) => CatalogObservation | null;
  converge?: (config: OcxConfig) => Promise<CatalogHealOutcome>;
  gates?: Partial<CatalogSelfHealGates>;
  log?: Pick<Console, "warn">;
}

function defaultSchedule(fn: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === "function") timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

function observeCatalogFile(path: string, readContent: boolean): CatalogObservation | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (!readContent) return { signature, catalog: null };
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const catalog = parsed !== null && typeof parsed === "object" && Array.isArray((parsed as RawCatalog).models)
      ? parsed as RawCatalog : null;
    return { signature, catalog };
  } catch {
    return null;
  }
}

function canonicalCodexHome(): string {
  try {
    return realpathSync.native(CODEX_HOME);
  } catch {
    return CODEX_HOME;
  }
}

async function convergeOwnCatalog(config: OcxConfig): Promise<CatalogHealOutcome> {
  const [{ armDetachedConfigBaseline }, { createManagementConvergeCodex }, { createCatalogConvergeRequest }] = await Promise.all([
    import("../config"),
    import("./management-convergence"),
    import("./catalog-admission"),
  ]);
  // Same as the hourly refresh: convergence may persist discovery fields after its provider
  // awaits, so this independently loaded snapshot saves as a rebase against disk.
  armDetachedConfigBaseline(config);
  const outcome = await createManagementConvergeCodex(config)(createCatalogConvergeRequest({ deadlineMs: 1_000 }));
  return { committed: outcome.kind === "catalog-only" && outcome.catalogRefresh.status === "committed" };
}

const defaultGates: CatalogSelfHealGates = {
  siblingOfLivePort,
  exiting: () => isRecyclingForExit() || isShutdownDraining(),
  loadConfig,
  ownsCodexHome: () => {
    const owner = inspectCodexHomeOwner(canonicalCodexHome());
    return owner.kind === "owned" || owner.kind === "unbound";
  },
  clientConnected: () => readClientConnectionState().kind !== "disconnected",
};

/** Cheapest first. The config is loaded only once the in-memory gates are open. */
export function evaluateCatalogSelfHealGates(
  gates: CatalogSelfHealGates,
): { readonly open: true; readonly config: OcxConfig } | { readonly open: false; readonly gate: CatalogSelfHealGate } {
  if (gates.siblingOfLivePort() !== null) return { open: false, gate: "sibling" };
  if (gates.exiting()) return { open: false, gate: "exiting" };
  const config = gates.loadConfig();
  if (!shouldSyncCodexOnStart(config)) return { open: false, gate: "codex-off" };
  if (gates.clientConnected()) return { open: false, gate: "client" };
  if (!gates.ownsCodexHome()) return { open: false, gate: "not-owner" };
  return { open: true, config };
}

export function startCodexCatalogSelfHeal(options: { deps?: CatalogSelfHealDeps } = {}): CatalogSelfHealHandle {
  const deps = options.deps ?? {};
  const scheduleFn = deps.scheduleFn ?? defaultSchedule;
  const clock = deps.now ?? (() => performance.now());
  const catalogPath = deps.catalogPath
    ?? (() => selectDriftHealCatalogPath(JOURNAL_PATH, DEFAULT_CATALOG_PATH, resolveCodexConfigPath));
  const observe = deps.observe ?? observeCatalogFile;
  const converge = deps.converge ?? convergeOwnCatalog;
  const gates: CatalogSelfHealGates = { ...defaultGates, ...deps.gates };
  const log = deps.log ?? console;

  let stopped = false;
  let pending: { cancel(): void } | undefined;
  let running = false;
  let last: CatalogSelfHealRecord | null = null;
  /** The routed namespaces last accepted as this owner's catalog, and the file identity they came from. */
  let baseline: { path: string; signature: string; namespaces: ReadonlySet<string> } | null = null;
  let recheckAt = 0;
  const attempts: number[] = [];
  const heals: number[] = [];

  const accept = (path: string): void => {
    const seen = observe(path, true);
    baseline = seen?.catalog
      ? { path, signature: seen.signature, namespaces: new Set(ocxRoutedNamespaceCounts(seen.catalog).keys()) }
      : null;
  };

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const path = catalogPath();
      if (path === null) return;
      const now = clock();
      const quick = observe(path, false);
      if (quick === null) return;
      if (baseline?.path === path && baseline.signature === quick.signature) return;
      if (baseline === null || baseline.path !== path) {
        accept(path);
        return;
      }
      // A closed gate or a spent cap already looked at this change; wait before reading it again.
      if (now < recheckAt) return;
      const seen = observe(path, true);
      if (seen?.catalog == null) return;
      const present = new Set(ocxRoutedNamespaceCounts(seen.catalog).keys());
      const lost = [...baseline.namespaces].filter(namespace => !present.has(namespace));
      if (lost.length === 0) {
        baseline = { path, signature: seen.signature, namespaces: present };
        return;
      }
      const gate = evaluateCatalogSelfHealGates(gates);
      if (!gate.open) {
        // The loss stays visible to a later tick, once the gate opens.
        recheckAt = now + CATALOG_HEAL_RECHECK_MS;
        return;
      }
      const lostEnabled = lost.filter(namespace => configEnablesRoutedNamespace(gate.config, namespace));
      if (lostEnabled.length === 0) {
        // The owner's own config dropped them: a legitimate removal, not a loss.
        baseline = { path, signature: seen.signature, namespaces: present };
        return;
      }
      while (attempts.length > 0 && now - attempts[0]! >= CATALOG_HEAL_WINDOW_MS) attempts.shift();
      while (heals.length > 0 && now - heals[0]! >= CATALOG_HEAL_WINDOW_MS) heals.shift();
      if (attempts.length >= CATALOG_HEAL_MAX_ATTEMPTS || heals.length >= CATALOG_HEAL_MAX_HEALS) {
        recheckAt = Math.min(attempts[0] ?? now, heals[0] ?? now) + CATALOG_HEAL_WINDOW_MS;
        return;
      }
      attempts.push(now);
      // Privacy scan: a count only, never provider names, model ids or paths.
      log.warn(`[catalog-self-heal] the Codex catalog lost the routed models of ${lostEnabled.length} provider namespace${lostEnabled.length === 1 ? "" : "s"} this proxy publishes; republishing`);
      let committed = false;
      try {
        committed = (await converge(gate.config)).committed;
      } catch {
        committed = false;
      }
      if (stopped) return;
      if (committed) heals.push(now);
      else recheckAt = now + CATALOG_HEAL_RECHECK_MS;
      last = { at: new Date().toISOString(), lostNamespaces: lostEnabled.length, committed };
      // What the owner's convergence published is the new baseline, even when it still lacks a
      // namespace: that provider is empty by the owner's own account, so it is not fought.
      accept(path);
    } finally {
      running = false;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    pending = scheduleFn(() => {
      void tick().finally(schedule);
    }, CATALOG_HEAL_TICK_MS);
  };
  schedule();

  return {
    stop() {
      stopped = true;
      pending?.cancel();
      pending = undefined;
    },
    lastHeal: () => last,
    tickForTests: tick,
  };
}
