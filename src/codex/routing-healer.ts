import { readFileSync } from "node:fs";
import { loadConfig } from "../config";
import { readRuntimePort } from "../config/process-state";
import { readClientConnectionState } from "../client/state";
import { appendDebugLogLine } from "../lib/debug-log-buffer";
import { redactUserPath } from "../lib/redact";
import { isRecyclingForExit, isShutdownDraining } from "../server/lifecycle";
import { probeEndpointLiveness, type EndpointLiveness } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";
import { shouldSyncCodexOnStart } from "./desired-state";
import { injectCodexConfig, type CodexInjectResult, type InjectCodexOptions } from "./inject";
import { standaloneCodexRoutingTarget } from "./inject/routing-target";
import { journaledInjectedOpenaiBaseUrl, journaledInjectedRealtimeWsBaseUrl, journalOwner } from "./journal";
import { effectiveLoopbackListenerPort, shouldInjectApiAuthHeader } from "./loopback-target";
import { CODEX_CONFIG_PATH } from "./paths";
import {
  detectCodexRoutingDrift,
  type CodexRoutingDrift,
  type CodexRoutingDriftTarget,
  type JournaledCodexRouting,
} from "./routing-drift";
import { siblingOfLivePort } from "./sibling-start";

/**
 * The live owner re-points Codex routing that a dead instance left on another loopback port.
 *
 * Startup sync is the last time an owner looks at `config.toml`. When something else re-points the
 * opencodex-owned routing at its own port and then dies, every new Codex thread fails with
 * "Connection refused" while this proxy keeps serving its own port. This loop closes that gap.
 *
 * Cost: one read of `config.toml` every 10 s from an unref'd timer, and nothing else while the
 * bytes are unchanged. Probes, gates and the journal run only while owned routing names a port this
 * process does not serve. Nothing here touches the request path.
 *
 * It writes only when every foreign target has been dead on at least two probes spanning 20 s, a
 * final probe still says dead, and every gate is open. The write is the ordinary injector with no
 * catalog path (so no catalog gather and the current `model_catalog_json` stays), a short lock
 * timeout, and a synchronous guard that re-reads `config.toml` under the lock and aborts when the
 * routing changed since the probe. A refusal that raced another write of `config.toml` is the same
 * abort, not a refusal. A live foreign opencodex is never fought; an unknown answer never advances
 * the streak. The caps pause the loop for at most an hour and never stop it. Detection, gates and
 * probes read the journal read-only, so watching never deletes an unreadable journal (a heal write
 * goes through the injector's ordinary journal handling). Started only from `handleStart`'s owner
 * path and stopped first in its exit cleanup.
 */

export const ROUTING_HEAL_TICK_MS = 10_000;
export const ROUTING_HEAL_MIN_DEAD_PROBES = 2;
export const ROUTING_HEAL_MIN_DEAD_SPAN_MS = 20_000;
export const ROUTING_HEAL_LOCK_TIMEOUT_MS = 1_000;
/** While the bytes stay equal, a live foreign owner, an unknown answer or a closed gate is looked at again only this often. */
export const ROUTING_HEAL_RECHECK_MS = 30_000;
export const ROUTING_HEAL_REFUSED_BACKOFF_MS = 10 * 60_000;
export const ROUTING_HEAL_WINDOW_MS = 60 * 60_000;
/** Rate cap: write attempts (busy ones included) per rolling window; more pause until the oldest leaves it. */
export const ROUTING_HEAL_MAX_ATTEMPTS = 6;
/**
 * Flap cap: this many successful heals in one window means another writer keeps re-pointing it, so a
 * further heal waits until the oldest leaves the window, then needs a fresh dead streak.
 */
export const ROUTING_HEAL_MAX_HEALS = 3;

export type CodexRoutingHealGate =
  | "sibling"
  | "exiting"
  | "runtime-record"
  | "codex-off"
  | "admission-token"
  | "target-not-served"
  | "client";

export interface CodexRoutingHealGates {
  siblingOfLivePort(): number | null;
  /** True while the process is recycling for exit or draining for shutdown. */
  exiting(): boolean;
  /** The port in this home's runtime record when that record names this process. */
  runtimePortOfThisProcess(): number | null;
  loadConfig(): OcxConfig;
  /** Any client-connection state other than disconnected (connected, link, invalid). */
  clientConnected(): boolean;
  /** The journal names a connected client as its owner (read-only). */
  clientJournalOwner(): boolean;
}

export type CodexRoutingHealGateResult =
  | { readonly open: true; readonly config: OcxConfig; readonly targetPort: number }
  | { readonly open: false; readonly gate: CodexRoutingHealGate };

/** Cheapest first; `loadConfig` and the journal only when the in-memory gates are open. */
export function evaluateCodexRoutingHealGates(
  port: number,
  ownPorts: ReadonlySet<number>,
  gates: CodexRoutingHealGates,
): CodexRoutingHealGateResult {
  if (gates.siblingOfLivePort() !== null) return { open: false, gate: "sibling" };
  if (gates.exiting()) return { open: false, gate: "exiting" };
  if (gates.runtimePortOfThisProcess() !== port) return { open: false, gate: "runtime-record" };
  const config = gates.loadConfig();
  // Codex ON and not hub-gated; the injector re-checks this under its lock.
  if (!shouldSyncCodexOnStart(config)) return { open: false, gate: "codex-off" };
  if (shouldInjectApiAuthHeader(config)) return { open: false, gate: "admission-token" };
  const targetPort = Number(new URL(standaloneCodexRoutingTarget(port, config).baseUrl).port);
  if (!ownPorts.has(targetPort)) return { open: false, gate: "target-not-served" };
  if (gates.clientConnected() || gates.clientJournalOwner()) return { open: false, gate: "client" };
  return { open: true, config, targetPort };
}

export interface CodexRoutingHealRecord {
  readonly at: string;
  readonly fromUrls: readonly string[];
  readonly toPort: number;
  readonly probes: number;
  readonly deadForMs: number;
}

export interface CodexRoutingHealerHandle {
  stop(): void;
  lastHeal(): CodexRoutingHealRecord | null;
}

export interface CodexRoutingHealerDeps {
  /** Schedule `fn` after `ms`; defaults to an unref'd setTimeout. */
  scheduleFn?: (fn: () => void, ms: number) => { cancel(): void };
  /** Monotonic milliseconds. */
  now?: () => number;
  /** `config.toml` text, or null when absent or unreadable. */
  readConfig?: () => string | null;
  readJournaled?: () => JournaledCodexRouting;
  probe?: (target: { port: number; hostname: string }) => Promise<EndpointLiveness>;
  inject?: (port: number, config: OcxConfig, options: InjectCodexOptions) => Promise<CodexInjectResult>;
  gates?: Partial<CodexRoutingHealGates>;
  log?: Pick<Console, "warn">;
  debugLine?: (line: string) => void;
}

/** Thrown by the under-lock guard: the routing changed after it was proven dead. */
class RoutingHealAborted extends Error {
  constructor() {
    super("Codex routing changed before the heal could be written.");
    this.name = "RoutingHealAborted";
  }
}

function defaultSchedule(fn: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === "function") timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

function readCodexConfigText(): string | null {
  try {
    return readFileSync(CODEX_CONFIG_PATH, "utf8");
  } catch {
    return null;
  }
}

const defaultGates: CodexRoutingHealGates = {
  siblingOfLivePort,
  exiting: () => isRecyclingForExit() || isShutdownDraining(),
  runtimePortOfThisProcess: () => readRuntimePort(process.pid)?.port ?? null,
  loadConfig,
  clientConnected: () => readClientConnectionState().kind !== "disconnected",
  clientJournalOwner: () => journalOwner({ readOnly: true })?.kind === "client",
};

/** The first line of an injector or error message, with home paths and secret-shaped values masked. */
function logDetail(message: string): string {
  return redactUserPath(message.split("\n")[0] ?? "");
}

function endpointLabel(target: CodexRoutingDriftTarget): string {
  return `${target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname}:${target.port}`;
}

export function startCodexRoutingHealer(options: {
  port: number;
  config: OcxConfig;
  deps?: CodexRoutingHealerDeps;
}): CodexRoutingHealerHandle {
  const { port, config } = options;
  const deps = options.deps ?? {};
  let stopped = false;
  let pending: { cancel(): void } | undefined;
  let last: CodexRoutingHealRecord | null = null;
  const handle: CodexRoutingHealerHandle = {
    stop() {
      stopped = true;
      pending?.cancel();
      pending = undefined;
    },
    lastHeal: () => last,
  };
  // Admission-token (non-loopback) routing is never healed, and the bind scope is fixed for the
  // process lifetime, so such an owner starts no timer at all.
  if (shouldInjectApiAuthHeader(config)) return handle;

  const listenerPort = effectiveLoopbackListenerPort(config, port);
  const ownPorts: ReadonlySet<number> = new Set(listenerPort === null ? [port] : [port, listenerPort]);
  const scheduleFn = deps.scheduleFn ?? defaultSchedule;
  const clock = deps.now ?? (() => performance.now());
  const readConfig = deps.readConfig ?? readCodexConfigText;
  const readJournaled = deps.readJournaled ?? ((): JournaledCodexRouting => ({
    openaiBaseUrl: journaledInjectedOpenaiBaseUrl({ readOnly: true }),
    realtimeWsBaseUrl: journaledInjectedRealtimeWsBaseUrl({ readOnly: true }),
  }));
  const probe = deps.probe ?? (target => probeEndpointLiveness(target));
  const inject = deps.inject ?? injectCodexConfig;
  const gates: CodexRoutingHealGates = { ...defaultGates, ...deps.gates };
  const log = deps.log ?? console;
  const debugLine = deps.debugLine ?? appendDebugLogLine;

  // The verdict for the last bytes read. Unchanged bytes with a non-foreign verdict cost nothing.
  let cache: { content: string; kind: CodexRoutingDrift["kind"] } | null = null;
  let streak: { key: string; firstDeadAt: number; probes: number } | null = null;
  let recheckAt = 0;
  /** After a real refusal; cleared as soon as routing is not foreign any more. */
  let backoffUntil = 0;
  /** While a cap is reached: until the oldest counted attempt or heal leaves the window. */
  let pausedUntil = 0;
  const announcedLive = new Set<number>();
  const attempts: number[] = [];
  const heals: number[] = [];
  let rateCapAnnounced = false;
  let flapCapAnnounced = false;

  const warn = (line: string) => {
    try { log.warn(line); } catch { /* logging never breaks the loop */ }
    try { debugLine(line); } catch { /* the debug buffer is best-effort */ }
  };

  const detect = (content: string): CodexRoutingDrift =>
    detectCodexRoutingDrift(content, { ownPorts, journaled: readJournaled });

  /** "live" wins over "unknown", which wins over "dead": all must be dead to proceed. */
  const probeAll = async (targets: readonly CodexRoutingDriftTarget[]): Promise<{ verdict: EndpointLiveness; livePorts: number[] }> => {
    const byPort = new Map<number, CodexRoutingDriftTarget>();
    for (const target of targets) if (!byPort.has(target.port)) byPort.set(target.port, target);
    const livePorts: number[] = [];
    let unknown = false;
    for (const target of byPort.values()) {
      let result: EndpointLiveness;
      try { result = await probe({ port: target.port, hostname: target.hostname }); }
      catch { result = "unknown"; }
      if (result === "live") livePorts.push(target.port);
      else if (result === "unknown") unknown = true;
    }
    return { verdict: livePorts.length > 0 ? "live" : unknown ? "unknown" : "dead", livePorts };
  };

  const standDownForLive = (livePorts: readonly number[]) => {
    streak = null;
    recheckAt = clock() + ROUTING_HEAL_RECHECK_MS;
    for (const livePort of livePorts) {
      if (announcedLive.has(livePort)) continue;
      announcedLive.add(livePort);
      warn(`Codex routing points at another running opencodex on port ${livePort}; leaving it.`);
    }
  };

  /** A cap pauses probing and writing until `until`; the streak starts over once it has passed. */
  const pauseUntil = (until: number) => {
    streak = null;
    pausedUntil = until;
  };

  const heal = async (
    content: string,
    targets: readonly CodexRoutingDriftTarget[],
    proven: { firstDeadAt: number; probes: number },
  ) => {
    const now = clock();
    while (attempts.length > 0 && now - attempts[0]! >= ROUTING_HEAL_WINDOW_MS) attempts.shift();
    while (heals.length > 0 && now - heals[0]! >= ROUTING_HEAL_WINDOW_MS) heals.shift();
    if (heals.length >= ROUTING_HEAL_MAX_HEALS) {
      pauseUntil(heals[0]! + ROUTING_HEAL_WINDOW_MS);
      if (!flapCapAnnounced) warn(`Codex routing was re-pointed at a dead port ${heals.length} times within an hour; the self-heal pauses until that hour has passed so it does not fight another writer. Run 'ocx sync' to repair routing now.`);
      flapCapAnnounced = true;
      return;
    }
    flapCapAnnounced = false;
    if (attempts.length >= ROUTING_HEAL_MAX_ATTEMPTS) {
      pauseUntil(attempts[0]! + ROUTING_HEAL_WINDOW_MS);
      if (!rateCapAnnounced) warn("Codex routing self-heal paused after repeated attempts; it resumes within the hour. Run 'ocx sync' to repair now.");
      rateCapAnnounced = true;
      return;
    }
    rateCapAnnounced = false;
    // One final look right before the write, then the gates again: the probe may have taken seconds.
    const final = await probeAll(targets);
    if (stopped) return; // the exit cleanup ran while the probe was out
    if (final.verdict === "live") { standDownForLive(final.livePorts); return; }
    if (final.verdict !== "dead") { recheckAt = clock() + ROUTING_HEAL_RECHECK_MS; return; }
    const gate = evaluateCodexRoutingHealGates(port, ownPorts, gates);
    if (!gate.open) {
      streak = null;
      if (gate.gate === "sibling") stopped = true;
      return;
    }
    attempts.push(clock());
    const deadPorts = new Set(targets.map(target => target.port));
    const guard = () => {
      const current = readConfig();
      const drift = current === null ? null : detect(current);
      if (drift?.kind !== "foreign" || drift.targets.some(target => !deadPorts.has(target.port))) {
        throw new RoutingHealAborted();
      }
    };
    /*
     * Whether a failed write raced another writer. A coordinated home re-reads its admission under
     * the lock BEFORE this guard runs, so a config.toml rewritten between the plan and the lock
     * comes back as a plain refusal. Moved bytes are the same abort as the guard's; only a refusal
     * over the very bytes that were proven dead backs off.
     */
    const raced = (): boolean => {
      const current = readConfig();
      if (current !== content) return true;
      const drift = detect(current);
      return drift.kind !== "foreign" || drift.targets.some(target => !deadPorts.has(target.port));
    };
    let result: CodexInjectResult;
    try {
      result = await inject(port, gate.config, { lockTimeoutMs: ROUTING_HEAL_LOCK_TIMEOUT_MS, beforeClientWrite: guard });
    } catch (error) {
      streak = null;
      cache = null;
      if (error instanceof RoutingHealAborted || raced()) return;
      backoffUntil = clock() + ROUTING_HEAL_REFUSED_BACKOFF_MS;
      warn(`Codex routing self-heal failed (${logDetail(error instanceof Error ? error.message : String(error))}); retrying in 10 minutes. Run 'ocx sync' to repair now.`);
      return;
    }
    if (result.success && result.status !== "skipped" && result.configApplied !== false) {
      heals.push(clock());
      streak = null;
      cache = null;
      const fromUrls = [...new Set(targets.map(target => target.url))];
      last = {
        at: new Date().toISOString(),
        fromUrls,
        toPort: gate.targetPort,
        probes: proven.probes + 1,
        deadForMs: Math.round(clock() - proven.firstDeadAt),
      };
      const from = [...new Set(targets.map(endpointLabel))].join(", ");
      warn(`Codex routing pointed at ${from}, where no opencodex answers; re-pointed it at this proxy on port ${gate.targetPort}. Codex threads opened meanwhile keep the old address until you reopen them.`);
      return;
    }
    // Busy lock: keep the proven streak so the next tick re-probes and tries again.
    if (result.retryable) return;
    streak = null;
    cache = null;
    // Skipped under the lock (Codex OFF, hub, sibling), an external provider appeared, or a race.
    if (result.success || raced()) return;
    backoffUntil = clock() + ROUTING_HEAL_REFUSED_BACKOFF_MS;
    warn(`Codex routing self-heal was refused (${logDetail(result.message)}); retrying in 10 minutes. Run 'ocx sync' to repair now.`);
  };

  const evaluate = async () => {
    if (gates.siblingOfLivePort() !== null) { stopped = true; return; }
    const content = readConfig();
    if (content === null) { cache = null; streak = null; return; }
    const unchanged = cache !== null && cache.content === content;
    if (unchanged && cache!.kind !== "foreign") return;
    const drift = detect(content);
    cache = { content, kind: drift.kind };
    if (drift.kind !== "foreign") {
      streak = null;
      recheckAt = 0;
      backoffUntil = 0;
      announcedLive.clear();
      return;
    }
    const now = clock();
    if (now < backoffUntil || now < pausedUntil) return;
    if (unchanged && now < recheckAt) return;
    const gate = evaluateCodexRoutingHealGates(port, ownPorts, gates);
    if (!gate.open) {
      streak = null;
      recheckAt = now + ROUTING_HEAL_RECHECK_MS;
      if (gate.gate === "sibling") stopped = true;
      return;
    }
    const probed = await probeAll(drift.targets);
    if (stopped) return;
    if (probed.verdict === "live") { standDownForLive(probed.livePorts); return; }
    // Unknown never advances the streak and never resets it; it is asked again at the recheck pace.
    if (probed.verdict !== "dead") { recheckAt = clock() + ROUTING_HEAL_RECHECK_MS; return; }
    recheckAt = 0;
    const probedAt = clock();
    const key = [...new Set(drift.targets.map(target => target.port))].sort((a, b) => a - b).join(",");
    if (!streak || streak.key !== key) {
      streak = { key, firstDeadAt: probedAt, probes: 1 };
      return;
    }
    streak.probes += 1;
    if (streak.probes < ROUTING_HEAL_MIN_DEAD_PROBES || probedAt - streak.firstDeadAt < ROUTING_HEAL_MIN_DEAD_SPAN_MS) return;
    await heal(content, drift.targets, streak);
  };

  const tick = async () => {
    pending = undefined;
    if (stopped) return;
    try { await evaluate(); } catch {
      // A background check never throws into the timer; an unreadable config.json is looked at
      // again at the slower recheck pace rather than on every tick.
      recheckAt = clock() + ROUTING_HEAL_RECHECK_MS;
    }
    if (!stopped) pending = scheduleFn(() => { void tick(); }, ROUTING_HEAL_TICK_MS);
  };

  pending = scheduleFn(() => { void tick(); }, ROUTING_HEAL_TICK_MS);
  return handle;
}
