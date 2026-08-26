import { execFileSync } from "node:child_process";
import { loadConfig } from "../config";
import { readRuntimePort } from "../config/process-state";
import { configuredAdminToken } from "./admin-secrets";

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function waitForExit(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  const marker = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    Atomics.wait(marker, 0, 0, 50);
  }
  return !isProcessAlive(pid);
}

/** Injectable seams so the graceful-stop flow is unit-testable without a live proxy. */
export interface GracefulStopIo {
  fetchFn?: typeof fetch;
  readRuntime?: (pid: number) => { port: number; hostname?: string } | null;
  waitExit?: (pid: number, timeoutMs: number) => boolean;
  env?: Record<string, string | undefined>;
  exitTimeoutMs?: number;
}

/**
 * Host to POST /api/stop against: follow the recorded bind hostname when it names a
 * concrete address (a proxy bound to ::1 or a LAN IP is unreachable on 127.0.0.1);
 * loopback aliases and wildcard binds all answer on IPv4 loopback.
 */
export function gracefulStopHost(hostname: string | undefined): string {
  const trimmed = (hostname ?? "").trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || lower === "localhost" || trimmed === "127.0.0.1" || trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]") {
    return "127.0.0.1";
  }
  if (lower === "::1" || lower === "[::1]") return "[::1]";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

/**
 * Outcome of a graceful stop attempt. `"refused"` is distinct from failure: the proxy answered
 * that it must NOT be stopped from here, so callers must not escalate to a forced kill.
 */
export type GracefulStopResult = boolean | "refused";

/** A proxy declined shutdown because a service under another home owns it (HTTP 409). */
export class ProxyOwnershipRefusedError extends Error {}

/**
 * Ask a running proxy to stop itself via the management API (`POST /api/stop`), which
 * drains in-flight turns, restores native Codex, and cleans its pid/runtime files.
 * This is the only way to get a GRACEFUL stop on Windows, where the POSIX
 * SIGTERM-then-SIGKILL ladder does not exist and `taskkill /F` gives the proxy no
 * chance to run its shutdown handlers. Returns false when the proxy can't be reached
 * or doesn't exit in time — callers fall back to {@link killProxy}. Returns `"refused"`
 * when the proxy declines the stop (HTTP 409), which callers must NOT force past.
 */
export async function stopProxyGracefully(pid: number, io: GracefulStopIo = {}): Promise<GracefulStopResult> {
  const readRuntime = io.readRuntime ?? readRuntimePort;
  const runtime = readRuntime(pid);
  if (!runtime?.port) return false;
  const env = io.env ?? process.env;
  const headers: Record<string, string> = {};
  const token = configuredAdminToken(env.OPENCODEX_HOME?.trim() || undefined, env as NodeJS.ProcessEnv);
  if (token) headers["x-opencodex-api-key"] = token;
  const fetchFn = io.fetchFn ?? fetch;
  try {
    const res = await fetchFn(`http://${gracefulStopHost(runtime.hostname)}:${runtime.port}/api/stop`, {
      method: "POST",
      headers,
      // Hung proxies with many CLOSE_WAIT clients can be slow to accept; give them
      // longer than a health poll so we prefer drain over taskkill /F.
      signal: AbortSignal.timeout(io.exitTimeoutMs ? Math.min(io.exitTimeoutMs, 10_000) : 10_000),
    });
    // 409 is the proxy REFUSING to stop (a service installed under another home owns it and
    // would respawn it anyway). That is a policy answer, not a dead endpoint — escalating to
    // SIGTERM here would run the daemon's cleanup and strip shared config out from under the
    // still-running service. Report the refusal instead of forcing.
    if (res.status === 409) return "refused";
    if (!res.ok) return false;
  } catch {
    return false;
  }
  const waitExit = io.waitExit ?? waitForExit;
  // Honor the server's own drain window: /api/stop answers 200 first, then drains for
  // config.shutdownTimeoutMs. Waiting less than that hard-kills mid-drain.
  const exitTimeoutMs = io.exitTimeoutMs ?? drainDeadlineMs();
  return waitExit(pid, exitTimeoutMs);
}

function drainDeadlineMs(): number {
  try {
    return (loadConfig().shutdownTimeoutMs ?? 5000) + 3000;
  } catch {
    return 8000;
  }
}

/** Graceful-first stop: management-API drain, then the platform kill ladder. */
export async function stopProxy(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;
  const runtime = readRuntimePort(pid);
  const graceful = await stopProxyGracefully(pid);
  if (graceful === "refused") {
    // The proxy refused on purpose (foreign service owns it). Forcing would strip shared
    // config while that service keeps the proxy alive.
    throw new ProxyOwnershipRefusedError(
      "The running proxy refused to stop: a service installed under a different "
      + "CODEX_HOME/OPENCODEX_HOME owns it. Run the stop from that home.",
    );
  }
  if (graceful) {
    await waitForStoppedPort(runtime, pid);
    return;
  }
  killProxy(pid);
  await waitForStoppedPort(runtime, pid);
}

/** After stop/kill, wait for the former listen port to become bindable (Windows drain). */
async function waitForStoppedPort(
  runtime: { port: number; hostname?: string } | null | undefined,
  stoppedPid?: number,
): Promise<void> {
  if (!runtime?.port) return;
  try {
    const { reclaimListenPort } = await import("../server/port-reclaim");
    await reclaimListenPort(runtime.port, runtime.hostname ?? "127.0.0.1", {
      timeoutMs: 15_000,
      intervalMs: 100,
      scanIntervalMs: 500,
      // Only the process we just stopped — never kill a newly started twin proxy.
      killOcxHolders: !!(stoppedPid && stoppedPid > 0),
      onlyKillPids: stoppedPid && stoppedPid > 0 ? [stoppedPid] : [],
    });
  } catch {
    /* best-effort — callers that need a hard guarantee reclaim again before bind */
  }
}

export function killProxy(pid: number): void {
  if (!isProcessAlive(pid)) return;
  if (process.platform === "win32") {
    // Windows process.kill(SIGTERM/SIGINT) is TerminateProcess — not a graceful signal.
    // Graceful drain happens only via stopProxyGracefully() (POST /api/stop). This path
    // is the hard fallback: taskkill /T /F so the process tree exits (ghost LISTEN /
    // CLOSE_WAIT are then cleared by reclaimListenPort / SetTcpEntry).
    const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
    try {
      execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], { stdio: "pipe", windowsHide: true });
    } catch (err) {
      if (isProcessAlive(pid)) throw err;
    }
  } else {
    process.kill(pid, "SIGTERM");
    if (!waitForExit(pid, 5000)) process.kill(pid, "SIGKILL");
  }
  if (!waitForExit(pid, 5000)) throw new Error(`process ${pid} did not exit`);
}
