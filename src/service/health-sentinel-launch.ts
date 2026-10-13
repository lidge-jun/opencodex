/**
 * Start the opt-in service health sentinel beside a managed service proxy (#6671).
 *
 * The sentinel (health-sentinel-main.ts) is a separate process with its own event loop. It asks
 * this proxy's `/healthz` and, if the proxy stays alive but stops answering, terminates it so the
 * service manager restarts it. This module decides whether to start one, starts it, and stops it
 * on shutdown. It never blocks startup: spawning is synchronous and fire-and-forget, and every
 * failure is logged and ignored.
 *
 * Only a managed service child gets a sentinel. A foreground `ocx start` has nobody to restart it,
 * a desktop sidecar has the app's own supervisor, and a sibling proxy is not the service.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { OcxConfig } from "../types";
import { serviceHealthRecoveryEnabled } from "../config/feature-flags";
import { getConfigDir } from "../config/paths";
import { getRuntimePortPath, readRuntimePort } from "../config/process-state";
import { isManagedServiceEnvironment } from "../config/serving-runtimes";
import { didRunDrainStartHooks, registerDrainStartHook, registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import { isStandaloneBinary } from "../lib/standalone";
import { HEALTH_SENTINEL_ENV, readRecoveryEntries, type RecoveryEntry } from "./health-sentinel-main";
import { serviceStatePaths } from "./state";

/** Private argv the compiled binary handles before CLI dispatch (src/cli/index.ts). */
export const HEALTH_SENTINEL_STANDALONE_ARG = "__health-sentinel";
export const HEALTH_SENTINEL_HISTORY_FILE = "service-health-recovery.json";
export const HEALTH_SENTINEL_LOG_FILE = "service-health-sentinel.log";
/** A recovery this recent is announced by the replacement's first log lines. */
const RECENT_RECOVERY_NOTICE_MS = 15 * 60_000;

/** Variables the sentinel may inherit. Credentials and proxy settings are deliberately absent. */
const INHERITED_ENV = [
  "PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "SystemDrive", "ComSpec",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "LANG", "TZ",
] as const;

export type HealthSentinelLaunchInput = {
  enabled: boolean;
  managedService: boolean;
  standalone: boolean;
  sibling: boolean;
  execPath: string;
  entryPath: string;
  entryExists: boolean;
};

export type HealthSentinelLaunchDecision =
  | { launch: true; argv: string[] }
  /** `reason` is null when the feature is simply off, so nothing is logged. */
  | { launch: false; reason: string | null };

export function decideHealthSentinelLaunch(input: HealthSentinelLaunchInput): HealthSentinelLaunchDecision {
  if (!input.enabled) return { launch: false, reason: null };
  if (!input.managedService) return { launch: false, reason: "this proxy is not running as the managed service" };
  if (input.sibling) return { launch: false, reason: "this proxy is a sibling of the service" };
  if (input.standalone) return { launch: true, argv: [input.execPath, HEALTH_SENTINEL_STANDALONE_ARG] };
  if (!input.entryExists) return { launch: false, reason: "the sentinel entry is missing from this installation" };
  return { launch: true, argv: [input.execPath, input.entryPath] };
}

export function healthSentinelEnvironment(
  parent: NodeJS.ProcessEnv,
  paths: { targetPid: number; runtimePath: string; historyPath: string; logPath: string; statePaths: readonly string[] },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  env[HEALTH_SENTINEL_ENV.targetPid] = String(paths.targetPid);
  env[HEALTH_SENTINEL_ENV.runtimePath] = paths.runtimePath;
  env[HEALTH_SENTINEL_ENV.historyPath] = paths.historyPath;
  env[HEALTH_SENTINEL_ENV.logPath] = paths.logPath;
  env[HEALTH_SENTINEL_ENV.statePaths] = JSON.stringify(paths.statePaths);
  const timing = parent[HEALTH_SENTINEL_ENV.timing];
  if (timing !== undefined) env[HEALTH_SENTINEL_ENV.timing] = timing;
  return env;
}

/** The line a replacement prints when the sentinel recently terminated its predecessor. */
export function recentRecoveryNotice(entries: readonly RecoveryEntry[], selfPid: number, now: number): string | null {
  const latest = entries.at(-1);
  if (!latest || latest.pid === selfPid || latest.state === "skipped" || latest.state === "failed") return null;
  if (now - latest.at < 0 || now - latest.at > RECENT_RECOVERY_NOTICE_MS) return null;
  const seconds = Math.round((now - latest.at) / 1000);
  const what = latest.state === "terminated" ? "terminated" : "tried to terminate";
  return `⚠️  The service health sentinel ${what} the previous proxy (pid ${latest.pid}) ${seconds}s ago because it stopped answering /healthz. Requests it held were not replayed and may already have reached the upstream.`;
}

type SpawnedSentinel = { pid: number; stdin: unknown; kill(): void; unref(): void };

export type HealthSentinelHandle = { pid: number; stop(): void };

let active: { child: SpawnedSentinel; detachHooks: () => void } | null = null;

export function startServiceHealthSentinel(
  config: Pick<OcxConfig, "serviceHealthRecovery">,
  deps: {
    env?: NodeJS.ProcessEnv;
    spawn?: (argv: string[], env: Record<string, string>) => SpawnedSentinel;
    log?: (line: string) => void;
    now?: () => number;
  } = {},
): HealthSentinelHandle | null {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  const enabled = serviceHealthRecoveryEnabled(config);
  if (!enabled) return null;
  // A drain that already began (a stop or restart during startup) must not gain a sentinel.
  if (didRunDrainStartHooks()) return null;
  const configDir = getConfigDir();
  const historyPath = join(configDir, HEALTH_SENTINEL_HISTORY_FILE);
  const notice = recentRecoveryNotice(readRecoveryEntries(historyPath) ?? [], process.pid, (deps.now ?? Date.now)());
  if (notice) log(notice);
  const entryPath = fileURLToPath(new URL("./health-sentinel-main.ts", import.meta.url));
  const runtime = readRuntimePort(process.pid);
  const decision = decideHealthSentinelLaunch({
    enabled,
    managedService: isManagedServiceEnvironment(env),
    standalone: isStandaloneBinary(),
    sibling: runtime?.siblingOfPort !== undefined,
    execPath: process.execPath,
    entryPath,
    entryExists: existsSync(entryPath),
  });
  if (!decision.launch) {
    if (decision.reason) log(`service health recovery is enabled but not started: ${decision.reason}`);
    return null;
  }
  stopServiceHealthSentinel();
  const childEnv = healthSentinelEnvironment(env, {
    targetPid: process.pid,
    runtimePath: getRuntimePortPath(),
    historyPath,
    logPath: join(configDir, HEALTH_SENTINEL_LOG_FILE),
    statePaths: serviceStatePaths(),
  });
  let child: SpawnedSentinel;
  try {
    child = (deps.spawn ?? ((argv, childEnvironment) => Bun.spawn(argv, {
      // The sentinel's stdin is this process's lifeline: it sees EOF when this process exits.
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      env: childEnvironment,
      windowsHide: true,
    })))(decision.argv, childEnv);
  } catch (error) {
    log(`service health recovery could not start its sentinel: ${error instanceof Error ? error.name : "error"}`);
    return null;
  }
  child.unref();
  // Keep the subprocess and its stdin sink referenced for this process's lifetime.
  const handle = { child, detachHooks: () => {} };
  active = handle;
  // Withdraw as soon as any drain begins: a deliberate stop whose drain stalls must stay a stop.
  const detachDrain = registerDrainStartHook("service-health-sentinel", stopServiceHealthSentinel);
  const detachShutdown = registerOptionalShutdownHook("service-health-sentinel", stopServiceHealthSentinel);
  handle.detachHooks = () => { detachDrain(); detachShutdown(); };
  log(`service health recovery: sentinel pid ${child.pid} watches this proxy (pid ${process.pid})`);
  return { pid: child.pid, stop: stopServiceHealthSentinel };
}

/** Stop the sentinel before a deliberate shutdown so it never judges a draining process. */
export function stopServiceHealthSentinel(): void {
  const current = active;
  if (!current) return;
  active = null;
  current.detachHooks();
  try { current.child.kill(); } catch { /* already gone */ }
  const sink = current.child.stdin as { end?: () => unknown } | null;
  try { sink?.end?.(); } catch { /* already closed */ }
}
