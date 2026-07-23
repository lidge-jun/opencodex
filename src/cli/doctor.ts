/**
 * `ocx doctor` - read-only environment diagnostics.
 *
 * Explains WHY ChatGPT quota may never populate (and thus why account
 * auto-switch can appear stuck), especially on WSL2 where outbound fetch to
 * chatgpt.com can be blocked by NAT/DNS/VPN/proxy differences. Observe-only:
 * it never sets proxy env, relocates state dirs, mutates quota, or changes
 * networking. See devlog/_plan/260630_wsl-account-autoswitch/30_*.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigDir, getConfigPath, readConfigDiagnostics, readPid, readRuntimePort, resolveEnvValue } from "../config";
import { gracefulStopHost } from "../lib/process-control";
import { loadServiceTokenFromFile } from "../lib/service-secrets";
import { readCodexTokens } from "../codex/auth-collision";
import { resolveCodexHomeDir as resolveCodexHomeDirImpl, isWslRuntime, listWslWindowsCodexHomes, wslAutomountRoot, type CodexHomeDeps } from "../codex/home";
import { findCodexOnPath, isWindowsInteropDir } from "../codex/shim";
import { countPendingOpencodexHistory } from "../codex/history-provider";
import { collectProjectCodexConfigWarnings, formatProjectCodexConfigWarningsForDoctor } from "../codex/project-config-warnings";
import { collectStartupHealth, startupHealthSummary } from "../codex/autostart-health";
import {
  displayCodexRuntimePath,
  loadLastEffortClamp,
  persistCodexRuntime,
  resolveAndPersistCodexRuntime,
  resolveCodexRuntime,
} from "../codex/runtime";
export { resolveCodexHomeDir } from "../codex/home";

const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const PROBE_TIMEOUT_MS = 8000;

export type PathRow = { label: string; path: string; exists: boolean };

export function collectPaths(): PathRow[] {
  const codexHome = resolveCodexHomeDirImpl();
  const opencodexHome = getConfigDir();
  return [
    { label: "CODEX_HOME", path: codexHome, exists: existsSync(codexHome) },
    { label: "CODEX_HOME/auth.json", path: join(codexHome, "auth.json"), exists: existsSync(join(codexHome, "auth.json")) },
    { label: "OPENCODEX_HOME", path: opencodexHome, exists: existsSync(opencodexHome) },
    { label: "OPENCODEX_HOME/config.json", path: getConfigPath(), exists: existsSync(getConfigPath()) },
  ];
}

export type FsTypeInfo = { fstype: string; mount: string; isDrvfs: boolean; isMntDrive: boolean };

/**
 * Parse `/proc/mounts`-shaped content and return the longest mount-point prefix
 * covering `path`. `mountsContent` is injectable for testing; in production the
 * caller passes the real file (or null off-Linux -> "n/a").
 */
export function detectFsType(path: string, mountsContent: string | null): FsTypeInfo {
  const isMntDrive = /^\/mnt\/[a-z]\//i.test(path) || /^\/mnt\/[a-z]$/i.test(path);
  if (!mountsContent) {
    return { fstype: "n/a", mount: "", isDrvfs: false, isMntDrive };
  }
  let best: { mount: string; fstype: string } | null = null;
  for (const line of mountsContent.split("\n")) {
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const mount = parts[1]!;
    const fstype = parts[2]!;
    if (path === mount || path.startsWith(mount.endsWith("/") ? mount : `${mount}/`) || mount === "/") {
      if (!best || mount.length > best.mount.length) best = { mount, fstype };
    }
  }
  const fstype = best?.fstype ?? "unknown";
  return {
    fstype,
    mount: best?.mount ?? "",
    isDrvfs: fstype === "drvfs" || fstype === "9p",
    isMntDrive,
  };
}

function readMounts(): string | null {
  try {
    return process.platform === "linux" ? readFileSync("/proc/mounts", "utf-8") : null;
  } catch {
    return null;
  }
}

export type WslDualInstallDiagnostic = {
  wsl: boolean;
  automountRoot: string;
  effectiveCodexHome: string;
  effectiveIsWindowsMount: boolean;
  linuxCodexConfigured: boolean;
  windowsCodexHomes: string[];
  dualInstall: boolean;
  interopCodexOnPath: string | null;
};

type WslDualInstallDeps = CodexHomeDeps & {
  pathValue?: string;
  effectiveCodexHome?: string;
};

/**
 * WSL + Windows dual-install visibility: which `.codex` home each side owns,
 * whether the effective home sits on a Windows mount, and whether the `codex`
 * on PATH is actually the Windows launcher reached through drive interop.
 * Read-only; hints are printed by runDoctor, never applied.
 */
export function collectWslDualInstall(deps: WslDualInstallDeps = {}): WslDualInstallDiagnostic {
  const wsl = isWslRuntime(deps);
  const effectiveCodexHome = deps.effectiveCodexHome ?? resolveCodexHomeDirImpl(deps);
  if (!wsl) {
    return {
      wsl: false,
      automountRoot: "/mnt",
      effectiveCodexHome,
      effectiveIsWindowsMount: false,
      linuxCodexConfigured: false,
      windowsCodexHomes: [],
      dualInstall: false,
      interopCodexOnPath: null,
    };
  }
  const automountRoot = wslAutomountRoot(deps);
  const exists = deps.existsSync ?? existsSync;
  const home = (deps.homedir ?? homedir)();
  const linuxCodexConfigured = !!home && exists(join(home, ".codex", "config.toml"));
  const windowsCodexHomes = listWslWindowsCodexHomes(deps);
  const onPath = findCodexOnPath({
    pathValue: deps.pathValue ?? process.env.PATH,
    wsl: false, // scan everything; classify interop ourselves
    posixPaths: true, // WSL PATH entries are POSIX regardless of the host running doctor
    automountRoot,
    // When a fake fs is injected (tests), the real lstat/readFile would miss its
    // synthetic paths; treat every injected hit as a plain non-shim file.
    ...(deps.existsSync ? { exists: deps.existsSync, isShimFile: () => false, isDirectory: () => false } : {}),
  });
  const interopCodexOnPath = onPath && isWindowsInteropDir(onPath, automountRoot) ? onPath : null;
  return {
    wsl,
    automountRoot,
    effectiveCodexHome,
    effectiveIsWindowsMount: isWindowsInteropDir(effectiveCodexHome, automountRoot),
    linuxCodexConfigured,
    windowsCodexHomes,
    dualInstall: linuxCodexConfigured && windowsCodexHomes.length > 0,
    interopCodexOnPath,
  };
}

const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const;

export type ProxyEnvRow = { key: string; present: boolean };
export type EnvMap = Record<string, string | undefined>;

/** Report only presence/absence of proxy env vars - never the value (it may
 * embed credentials). Checks both upper- and lower-case forms. */
export function collectProxyEnv(env: EnvMap = process.env): ProxyEnvRow[] {
  return PROXY_KEYS.map(key => ({
    key,
    present: !!(env[key]?.trim() || env[key.toLowerCase()]?.trim()),
  }));
}

export type ConfiguredProxyDiagnostic = {
  key: "config.proxy";
  present: boolean;
  configured: boolean;
  source: "default" | "file" | "fallback";
  detail: string;
};

function envReferenceName(value: string): string | null {
  const braced = value.match(/^\$\{(\w+)\}$/);
  if (braced) return braced[1]!;
  const bare = value.match(/^\$(\w+)$/);
  return bare ? bare[1]! : null;
}

export function collectConfiguredProxy(): ConfiguredProxyDiagnostic {
  const diagnostics = readConfigDiagnostics();
  const rawProxy = typeof diagnostics.config.proxy === "string" ? diagnostics.config.proxy.trim() : "";
  if (diagnostics.error) {
    return {
      key: "config.proxy",
      present: false,
      configured: false,
      source: diagnostics.source,
      detail: `config unreadable (${diagnostics.error})`,
    };
  }
  if (!rawProxy) {
    return {
      key: "config.proxy",
      present: false,
      configured: false,
      source: diagnostics.source,
      detail: "not configured",
    };
  }

  const envName = envReferenceName(rawProxy);
  const resolved = resolveEnvValue(rawProxy);
  if (resolved?.trim()) {
    return {
      key: "config.proxy",
      present: true,
      configured: true,
      source: diagnostics.source,
      detail: envName ? `env reference ${envName} resolved` : "value hidden",
    };
  }

  return {
    key: "config.proxy",
    present: false,
    configured: true,
    source: diagnostics.source,
    detail: envName ? `env reference ${envName} is unset` : "empty after resolution",
  };
}

export function parseProcessEnvBlock(content: string): EnvMap {
  const env: EnvMap = {};
  for (const entry of content.split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return env;
}

export type RunningProxyEnvDiagnostic =
  | { status: "not_running"; rows: ProxyEnvRow[] }
  | { status: "ok"; pid: number; rows: ProxyEnvRow[] }
  | { status: "unavailable"; pid: number; reason: string; rows: ProxyEnvRow[] };

type RunningProxyEnvDeps = {
  readPidFn?: () => number | null;
  readEnvironFn?: (pid: number) => string | null;
  platform?: NodeJS.Platform | string;
};

function readProcessEnviron(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf-8");
  } catch {
    return null;
  }
}

/*
 * [Decision Log]
 * - Purpose: Make `ocx doctor` distinguish the current shell env from the already-running proxy process env.
 * - Alternatives: Rename the old section only; parse service-manager env for each OS; read the recorded proxy PID's env presence.
 * - Rationale: PID env presence is the narrowest useful diagnostic on Linux/WSL, avoids secret value output, and keeps unsupported platforms explicit.
 */
export function collectRunningProxyEnv(deps: RunningProxyEnvDeps = {}): RunningProxyEnvDiagnostic {
  const rowsWhenEmpty = () => collectProxyEnv({});
  const pid = (deps.readPidFn ?? readPid)();
  if (!pid) return { status: "not_running", rows: rowsWhenEmpty() };

  const platform = deps.platform ?? process.platform;
  if (platform !== "linux" && !deps.readEnvironFn) {
    return {
      status: "unavailable",
      pid,
      reason: "process env inspection is only supported on Linux",
      rows: rowsWhenEmpty(),
    };
  }

  const content = (deps.readEnvironFn ?? readProcessEnviron)(pid);
  if (content === null) {
    return {
      status: "unavailable",
      pid,
      reason: "could not read process environment",
      rows: rowsWhenEmpty(),
    };
  }

  return {
    status: "ok",
    pid,
    rows: collectProxyEnv(parseProcessEnvBlock(content)),
  };
}

export type WhamProbeResult = {
  ok: boolean;
  status: number | null;
  durationMs: number;
  classification: "ok" | "timeout" | "connect_error" | string;
  authenticated: boolean;
};

/**
 * Replicate the runtime WHAM fetch shape (same URL, 8s timeout, main-token
 * headers when present) so the probe fails exactly where the real path fails.
 * `fetchImpl` is injectable for testing.
 */
export async function probeWham(fetchImpl: typeof fetch = fetch): Promise<WhamProbeResult> {
  const tokens = readCodexTokens();
  const headers: Record<string, string> = {};
  if (tokens) {
    headers.Authorization = `Bearer ${tokens.access_token}`;
    headers["ChatGPT-Account-Id"] = tokens.account_id;
  }
  const start = performance.now();
  try {
    const resp = await fetchImpl(WHAM_USAGE_URL, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const durationMs = Math.round(performance.now() - start);
    return {
      ok: resp.ok,
      status: resp.status,
      durationMs,
      classification: resp.ok ? "ok" : `http_${resp.status}`,
      authenticated: !!tokens,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const name = err instanceof Error ? err.name : String(err);
    const classification = name === "TimeoutError" || name === "AbortError"
      ? "timeout"
      : "connect_error";
    return { ok: false, status: null, durationMs, classification, authenticated: !!tokens };
  }
}

/**
 * Service-process memory/runtime introspection (#314 WP4).
 *
 * Doctor runs in its OWN Bun process; the only honest source for the SERVICE
 * process identity (Bun version, RSS, stream-mode gate decision) is the
 * authed management endpoint added in WP3. Observe-only: failures render as
 * honest status lines, never as fake data, and never fail the command.
 */
export type ServiceMemoryData = {
  pid: number;
  bunVersion: string;
  platform: string;
  rss: number;
  heapUsed: number;
  jscHeap: { heapSize: number } | null;
  streamMode: string;
  eagerRelay: { useEagerRelay: boolean; reason: string } | null;
  watchdog: { warnThresholdBytes: number; lastWarnAt: number | null } | null;
};

export type ServiceMemoryReport =
  | { status: "ok"; data: ServiceMemoryData }
  | { status: "unauthorized" }
  | { status: "unreachable"; error: string };

const SERVICE_MEMORY_TIMEOUT_MS = 2000;
const DEFAULT_MEMORY_THRESHOLD_BYTES = 4 * 1024 ** 3;

export async function fetchServiceMemory(
  host: string,
  port: number,
  token: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceMemoryReport> {
  try {
    const res = await fetchImpl(`http://${host}:${port}/api/system/memory`, {
      headers: token ? { "x-opencodex-api-key": token } : {},
      signal: AbortSignal.timeout(SERVICE_MEMORY_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return { status: "unauthorized" };
    if (!res.ok) return { status: "unreachable", error: `http ${res.status}` };
    const body = await res.json() as Partial<ServiceMemoryData>;
    if (typeof body.pid !== "number" || typeof body.bunVersion !== "string" || typeof body.rss !== "number") {
      return { status: "unreachable", error: "malformed response" };
    }
    return {
      status: "ok",
      data: {
        pid: body.pid,
        bunVersion: body.bunVersion,
        platform: typeof body.platform === "string" ? body.platform : "unknown",
        rss: body.rss,
        heapUsed: typeof body.heapUsed === "number" ? body.heapUsed : 0,
        jscHeap: body.jscHeap && typeof body.jscHeap.heapSize === "number" ? { heapSize: body.jscHeap.heapSize } : null,
        streamMode: typeof body.streamMode === "string" ? body.streamMode : "auto",
        eagerRelay: body.eagerRelay && typeof body.eagerRelay.reason === "string"
          ? { useEagerRelay: body.eagerRelay.useEagerRelay === true, reason: body.eagerRelay.reason }
          : null,
        watchdog: body.watchdog && typeof body.watchdog.warnThresholdBytes === "number"
          ? { warnThresholdBytes: body.watchdog.warnThresholdBytes, lastWarnAt: body.watchdog.lastWarnAt ?? null }
          : null,
      },
    };
  } catch (err) {
    return { status: "unreachable", error: err instanceof Error ? err.name : "fetch failed" };
  }
}

const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))}MB`;

/** Render the doctor "Memory / runtime" section lines (testable without console capture). */
export function formatServiceMemoryLines(report: ServiceMemoryReport): string[] {
  const lines: string[] = [];
  lines.push(`  --     doctor process Bun ${Bun.version} (this is NOT the service process)`);
  if (report.status === "unauthorized") {
    lines.push("  --     proxy reachable but rejected the request — set OPENCODEX_API_AUTH_TOKEN to match the service");
    return lines;
  }
  if (report.status === "unreachable") {
    lines.push(`  --     proxy not reachable (not running?) [${report.error}]`);
    return lines;
  }
  const d = report.data;
  lines.push(`  ok     service pid ${d.pid}: Bun ${d.bunVersion} on ${d.platform}`);
  lines.push(`         rss=${mb(d.rss)}, heapUsed=${mb(d.heapUsed)}${d.jscHeap ? `, jscHeap=${mb(d.jscHeap.heapSize)}` : ""}`);
  lines.push(`         streamMode=${d.streamMode}${d.eagerRelay ? ` (eager relay: ${d.eagerRelay.useEagerRelay ? "on" : "off"}, ${d.eagerRelay.reason})` : ""}`);
  if (d.watchdog) {
    lines.push(`         watchdog threshold=${mb(d.watchdog.warnThresholdBytes)}${d.watchdog.lastWarnAt ? `, last warn ${new Date(d.watchdog.lastWarnAt).toISOString()}` : ", no warnings"}`);
  }
  // Interpretation rule (devlog 040): reuse the watchdog's own threshold so
  // doctor and watchdog never disagree about "high"; jsShare discriminates
  // JS-heap growth from native runtime growth (the #314 shape).
  const threshold = d.watchdog?.warnThresholdBytes ?? DEFAULT_MEMORY_THRESHOLD_BYTES;
  const jsShare = d.rss > 0 ? Math.max(d.heapUsed, d.jscHeap?.heapSize ?? 0) / d.rss : 0;
  if (d.rss < threshold) {
    lines.push("         memory usage looks normal");
  } else if (jsShare < 0.25) {
    lines.push("  !!     high RSS with a small JS heap — native-side growth (Bun runtime buffers/handles). See docs: troubleshooting/windows-memory");
  } else if (jsShare >= 0.5) {
    lines.push("  !!     high RSS dominated by the JS heap — likely an opencodex bug; please report it");
  } else {
    lines.push("  !!     high RSS, indeterminate split — capture two doctor runs over time to see the trend");
  }
  // Version-claiming (never binary-claiming): the endpoint cannot distinguish
  // the bundled binary from an OPENCODEX_BUN_PATH override of the same version.
  if (d.platform === "win32" && d.eagerRelay?.reason === "auto-known-bad") {
    lines.push(`         service is running Bun ${d.bunVersion} on Windows — a version affected by the upstream Bun memory issue.`);
    lines.push("         Options: wait for a bundled runtime update, or set OPENCODEX_BUN_PATH to a runtime you trust (unvalidated — own risk),");
    lines.push("         or opt into streamMode \"eager-relay\" via PUT /api/settings (crash risk on this runtime; see docs).");
  }
  return lines;
}

export async function runDoctor(args: string[] = []): Promise<void> {
  if (args.includes("--fix-codex-runtime")) {
    const resolved = resolveCodexRuntime();
    if (!resolved.newerAvailable) {
      console.log("No newer Codex runtime found; keeping current selection.");
      const current = resolveAndPersistCodexRuntime();
      console.log(`Selected: ${displayCodexRuntimePath(current.runtime.command)} (${current.runtime.version ?? "unknown"})`);
      return;
    }
    persistCodexRuntime({
      command: resolved.newerAvailable.command,
      version: resolved.newerAvailable.version,
      source: "configured",
    });
    console.log(`Updated Codex runtime to ${displayCodexRuntimePath(resolved.newerAvailable.command)} (${resolved.newerAvailable.version ?? "unknown"}).`);
    console.log("Run ocx sync to refresh the catalog against this runtime.");
    return;
  }

  console.log("opencodex doctor\n");

  // Ordering note: the memory/runtime section renders after "Running proxy
  // process proxy env" below; helpers live above runDoctor for testability.

  const paths = collectPaths();
  const mounts = readMounts();
  console.log("Paths");
  for (const row of paths) {
    const fs = detectFsType(row.path, mounts);
    const flags = [fs.fstype !== "n/a" ? `fs=${fs.fstype}` : null, fs.isDrvfs || fs.isMntDrive ? "WSL /mnt drive" : null]
      .filter(Boolean).join(", ");
    console.log(`  ${row.exists ? "ok " : "-- "} ${row.label}: ${row.path}${flags ? `  (${flags})` : ""}`);
  }

  const startup = collectStartupHealth(readConfigDiagnostics().config);
  console.log("\nCodex restart safety");
  console.log(`  ${startup.rebootSafe ? "ok " : "!! "} ${startupHealthSummary(startup)}`);
  console.log(`       routing=${startup.routingKind}, service=${startup.serviceViable ? "viable" : startup.serviceInstalled ? "installed-but-unhealthy" : "absent"}, shim=${startup.shimHealthy ? "healthy" : startup.shimInstalled ? "stale" : "absent"}`);

  console.log("\nCodex runtime selection");
  {
    const resolved = resolveCodexRuntime();
    const selected = resolved.runtime;
    console.log(`  ok  Selected runtime: ${displayCodexRuntimePath(selected.command)} (${selected.version ?? "unknown"}, source=${selected.source})`);
    const envFailures = resolved.failures.filter(item => item.source === "environment");
    for (const failure of envFailures) {
      console.log(`  !!  Invalid CODEX_CLI_PATH: ${failure.reason}`);
    }
    const shimFailures = resolved.failures.filter(item => item.source === "shim");
    if (shimFailures.length > 0) {
      console.log(`  !!  Stale shim target rejected (${shimFailures.length})`);
    }
    if (resolved.replacedConfigured) {
      console.log(`  !!  Preferred runtime unavailable; fell back to ${displayCodexRuntimePath(selected.command)}`);
    }
    if (resolved.newerAvailable) {
      console.log(`  !!  Multiple Codex installations found.`);
      console.log(`  ok  Newer usable runtime found: ${displayCodexRuntimePath(resolved.newerAvailable.command)} (${resolved.newerAvailable.version ?? "unknown"})`);
      console.log("       Suggested: set CODEX_CLI_PATH to the desired binary and run ocx sync.");
      console.log("       Optional: ocx doctor --fix-codex-runtime");
    }
    const lastClamp = loadLastEffortClamp();
    if (lastClamp && lastClamp.removedEfforts.length > 0) {
      console.log(`  !!  ${lastClamp.removedEfforts.join(" and ")} were removed during catalog sync.`);
      console.log("       Suggested: set CODEX_CLI_PATH to a newer Codex binary and run ocx sync.");
    }
  }

  const currentProxyEnv = collectProxyEnv();
  const configuredProxy = collectConfiguredProxy();
  const runningProxyEnv = collectRunningProxyEnv();

  console.log("\nCurrent doctor process proxy env (presence only)");
  for (const row of currentProxyEnv) {
    console.log(`  ${row.present ? "set    " : "unset  "} ${row.key}`);
  }

  console.log("\nConfigured proxy (value hidden)");
  console.log(`  ${configuredProxy.present ? "set    " : "unset  "} ${configuredProxy.key} (${configuredProxy.source}; ${configuredProxy.detail})`);

  console.log("\nRunning proxy process proxy env (presence only)");
  if (runningProxyEnv.status === "not_running") {
    console.log("  --     no running ocx proxy process found");
  } else if (runningProxyEnv.status === "unavailable") {
    console.log(`  --     pid ${runningProxyEnv.pid}: ${runningProxyEnv.reason}`);
  } else {
    console.log(`  ok     pid ${runningProxyEnv.pid}`);
    for (const row of runningProxyEnv.rows) {
      console.log(`  ${row.present ? "set    " : "unset  "} ${row.key}`);
    }
  }

  // #314: service-process memory/runtime identity via the authed management
  // endpoint. readPid() FIRST (liveness), then the pid-scoped runtime record —
  // readRuntimePort alone can serve a stale file pointing at a foreign port.
  console.log("\nMemory / runtime");
  {
    const livePid = readPid();
    const runtime = livePid ? readRuntimePort(livePid) : null;
    if (!runtime) {
      console.log(`  --     doctor process Bun ${Bun.version} (this is NOT the service process)`);
      console.log("  --     no running ocx proxy found (no live pid/runtime record)");
    } else {
      const token = process.env.OPENCODEX_API_AUTH_TOKEN ?? loadServiceTokenFromFile(process.env);
      const report = await fetchServiceMemory(gracefulStopHost(runtime.hostname), runtime.port, token);
      for (const line of formatServiceMemoryLines(report)) console.log(line);
    }
  }

  console.log("\nWHAM reachability");
  const probe = await probeWham();
  const detail = probe.status !== null ? `status=${probe.status}` : `error=${probe.classification}`;
  console.log(`  ${probe.ok ? "ok " : "-- "} ${WHAM_USAGE_URL}`);
  console.log(`       ${detail}, ${probe.durationMs}ms, ${probe.authenticated ? "authenticated" : "unauthenticated"}`);

  // Design B upgrade visibility: threads still tagged opencodex are invisible to the native
  // Codex app until the one-time migration lands. Read-only probe (readonly sqlite, 100ms
  // busy timeout) — reports state, never mutates.
  console.log("\nCodex history migration");
  const pending = countPendingOpencodexHistory();
  if (pending.failed) {
    console.log("  --     state DB locked or unreadable (Codex app open?) — migration state unknown");
  } else if (pending.pendingRows === 0 && pending.backupEntries === 0) {
    console.log("  ok     no legacy opencodex-tagged threads pending");
  } else {
    console.log(`  --     ${pending.pendingRows} thread(s) still tagged opencodex, ${pending.backupEntries} backup manifest entr${pending.backupEntries === 1 ? "y" : "ies"}`);
  }

  console.log("\nProject Codex configs");
  const projectWarnings = collectProjectCodexConfigWarnings();
  if (projectWarnings.length === 0) {
    console.log("  ok     no project-local provider bypass detected");
  } else {
    for (const line of formatProjectCodexConfigWarningsForDoctor(projectWarnings)) {
      console.log(line);
    }
  }

  const dual = collectWslDualInstall();
  if (dual.wsl) {
    console.log("\nWSL Codex installs");
    console.log(`  ${dual.linuxCodexConfigured ? "ok " : "-- "} Linux ~/.codex/config.toml`);
    if (dual.windowsCodexHomes.length > 0) {
      for (const winHome of dual.windowsCodexHomes) console.log(`  ok  Windows ${winHome}`);
    } else {
      console.log("  --  no Windows-profile .codex detected under /mnt/c/Users");
    }
    console.log(`      effective CODEX_HOME: ${dual.effectiveCodexHome}${dual.effectiveIsWindowsMount ? " (Windows mount)" : ""}`);
    if (dual.interopCodexOnPath) {
      console.log(`  --  codex on PATH is the Windows launcher via interop: ${dual.interopCodexOnPath}`);
    }
  }

  // Hints, not fixes.
  const hints: string[] = [];
  const anyDrvfs = paths.some(p => detectFsType(p.path, mounts).isDrvfs || detectFsType(p.path, mounts).isMntDrive);
  const noProxy = currentProxyEnv.every(p => !p.present) && !configuredProxy.present;
  if (!startup.rebootSafe) {
    const command = startup.recommendedCommand ?? startup.commands.restoreNative;
    hints.push(`Codex is pinned to the local proxy without persistent startup protection. After restart, requests can reconnect indefinitely. Run '${command}'.`);
  }
  if (anyDrvfs) {
    hints.push("State dir is on a Windows-mounted (/mnt) drive. Prefer the Linux home (~) under WSL for token/lock reliability.");
  }
  if (!probe.ok) {
    if (probe.classification === "timeout" || probe.classification === "connect_error") {
      hints.push("WHAM probe could not reach chatgpt.com. On WSL2 this is often NAT/DNS/VPN. Quota cannot prime, so auto-switch stays on unknown scores.");
      if (noProxy) {
        hints.push("No proxy is visible to this doctor process and config.proxy is unset or unresolved. If Windows uses a proxy/VPN, set config.proxy or start ocx from a shell with HTTP(S)_PROXY.");
      }
    }
  }
  if (pending.failed || pending.pendingRows > 0 || pending.backupEntries > 0) {
    hints.push("Legacy chat threads are still tagged opencodex (or the DB was locked). The running proxy retries the migration automatically; to force it now, close the Codex app and run 'ocx sync'.");
  }
  if (dual.dualInstall && !dual.effectiveIsWindowsMount) {
    hints.push(`Codex is installed on BOTH WSL and Windows. Each side keeps its own ~/.codex (logins, config, catalog are separate); ocx here manages the Linux one. To share a single home, set CODEX_HOME=${dual.windowsCodexHomes[0] ?? `${dual.automountRoot}/c/Users/<you>/.codex`} in WSL (drvfs file locking is less reliable).`);
    hints.push("localhost is one-way in WSL2 NAT mode: Windows-side codex reaches this WSL proxy via localhost (localhostForwarding, on by default), but a Windows-side proxy is NOT reachable from WSL via localhost — use networkingMode=mirrored in .wslconfig for both directions.");
  }
  if (dual.interopCodexOnPath) {
    hints.push("The `codex` found on PATH is the Windows launcher reached through WSL interop; ocx will not shim it (a WSL shim breaks Windows invocations). Install codex inside WSL (npm i -g @openai/codex) or run 'ocx ensure' from Windows.");
  }
  if (hints.length > 0) {
    console.log("\nHints");
    for (const h of hints) console.log(`  - ${h}`);
  }
}
