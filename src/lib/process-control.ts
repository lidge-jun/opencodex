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
  /**
   * Nonce of the pending-teardown receipt this caller claimed.
   *
   * `ocx stop` sets it because it restores shared client config itself, only after
   * proving a stopped Task Scheduler did not respawn the proxy (#3008). The nonce is what
   * makes the deferral an owned obligation rather than a flag anyone can set: the proxy
   * honours it only when it names the receipt actually on disk. Direct callers omit it
   * and keep the self-contained behaviour.
   */
  deferSharedTeardownNonce?: string;
  /**
   * Endpoint the caller already resolved for this pid.
   *
   * `ocx stop` records this same snapshot in its pending-teardown receipt. Re-reading the
   * runtime file here could pick up a different one, which would make the receipt name an
   * endpoint the stop never contacted — and recovery probes exactly that endpoint.
   */
  runtimeEndpoint?: { hostname: string; port: number };
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
 * `"refused"` forbids forced stop. `"teardown-unconfirmed"` means the process exited,
 * but its assigned shared teardown was not confirmed; callers must not kill it again.
 */
export type GracefulStopResult = boolean | "refused" | "teardown-unconfirmed";

/**
 * The server's own explanation for the most recent 409, captured so `stopProxy` can report
 * the real reason. There is more than one: a scheduler wrapper under another home, or the
 * proxy being the installed service itself (#4023). Module-scoped because
 * `GracefulStopResult` is a public contract with several callers, and widening it to carry
 * the text would change every one of them for a message only this file reports.
 */
let lastRefusalMessage: string | null = null;

/**
 * The server's machine-readable reason for the most recent 409, captured alongside the
 * message so a refusal that arrives without a body still names the right cause. Without it
 * the fallback has to guess, and guessing "ownership" sent operators to re-check
 * CODEX_HOME for a refusal the scheduler wrapper had issued (#4169).
 */
let lastRefusalCode: string | null = null;

/** The server's explanation for the most recent 409, or `null` when it sent none. */
export function lastStopRefusalMessage(): string | null {
  return lastRefusalMessage;
}

/** The server's `code` for the most recent 409, or `null` when it sent none. */
export function lastStopRefusalCode(): string | null {
  return lastRefusalCode;
}

/**
 * Wording for a refusal whose body carried no message. Each branch mirrors a refusal the
 * management API can return from `POST /api/stop`; the default stays cause-neutral because
 * naming the wrong cause is worse than naming none — it costs the operator the time they
 * spend acting on it.
 *
 * These name the cause only. The command belongs to {@link refusalNextStep}, because the
 * only callers of `stopProxy` are `ocx stop` and the service manager's own cleanup, and a
 * message that told either of them to run `ocx stop` would be the #4169 loop again.
 */
function refusalFallbackMessage(code: string | null): string {
  switch (code) {
    case "respawnable_service":
      return "The running proxy refused to stop: a service manager that can respawn it owns "
        + "the process.";
    case "self_unload_service":
      return "The running proxy refused to stop: it is the installed service itself, so "
        + "stopping the manager from inside it would end the process before native Codex is "
        + "restored.";
    case "service_state_unknown":
      return "The running proxy refused to stop: the service manager state could not be read, "
        + "so it cannot tell whether a wrapper would respawn it.";
    default:
      return "The running proxy refused to stop and sent no reason.";
  }
}

/**
 * What is actually left to do when `ocx stop` is the command that received the refusal.
 *
 * Every refusal `POST /api/stop` produces is written for an API client, so it recommends
 * `ocx stop` — which is the command already running when the CLI prints it. That is the
 * loop #4169 reports: the endpoint points at `ocx stop`, `ocx stop` repeats the endpoint,
 * and neither names the wrapper that is refusing. `ocx stop` has already asked the service
 * manager to stop by the time this is reached, so the remaining question is always what the
 * service manager is doing, and no branch may answer with the command that just failed.
 */
export function refusalNextStep(code: string | null): string {
  switch (code) {
    case "respawnable_service":
      return "This stop already asked the service manager to stop, so running `ocx stop` "
        + "again is not the missing step. Run `ocx service status` to see whether a wrapper "
        + "is still installed and able to respawn the proxy.";
    case "self_unload_service":
      return "This stop already asked the service manager to stop, so running `ocx stop` "
        + "again is not the missing step. Run `ocx service status` to see whether the service "
        + "is still registered.";
    case "service_state_unknown":
      return "Run `ocx service status` to see the query error, repair the service manager "
        + "access, then retry.";
    default:
      return "Run `ocx service status` to inspect the service state.";
  }
}

/**
 * A proxy declined shutdown (HTTP 409). There is more than one reason it can say no — a
 * scheduler wrapper under another home, or the proxy being the installed service itself
 * (#4023) — so the server's own message is carried through rather than guessed at.
 *
 * The refusal's `code` travels on the error because the reporting caller has to act on the
 * cause, not re-parse prose: the message is the server's, and it recommends a command the
 * CLI has already run.
 */
export class ProxyOwnershipRefusedError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.code = code;
  }
}

/**
 * Ask a running proxy to stop itself via the management API (`POST /api/stop`), which
 * drains in-flight turns, restores native Codex, and cleans its pid/runtime files.
 * This is the only way to get a GRACEFUL stop on Windows, where the POSIX
 * SIGTERM-then-SIGKILL ladder does not exist and `taskkill /F` gives the proxy no
 * chance to run its shutdown handlers. Returns false when the proxy can't be reached
 * or doesn't exit in time — callers fall back to {@link killProxy}. Returns `"refused"`
 * when the proxy declines the stop (HTTP 409), which callers must NOT force past.
 * True requires the expected shared-teardown response and an observed exit. It does not
 * attest the process exit code or completion of every drain/shutdown hook.
 */
export async function stopProxyGracefully(pid: number, io: GracefulStopIo = {}): Promise<GracefulStopResult> {
  return (await stopProxyGracefullyDetailed(pid, io)).result;
}

/**
 * The refusal a single stop attempt received, carried back to that attempt's caller.
 *
 * Module-scoped state cannot do this job: two overlapping stops race, and the first would
 * report the second's cause. The exported accessors stay as observational state for callers
 * that only want the last refusal, but the error text is built from this per-call value.
 */
type StopRefusal = { message: string | null; code: string | null };

async function stopProxyGracefullyDetailed(
  pid: number,
  io: GracefulStopIo = {},
): Promise<{ result: GracefulStopResult; refusal: StopRefusal }> {
  const refusal: StopRefusal = { message: null, code: null };
  const done = (result: GracefulStopResult): { result: GracefulStopResult; refusal: StopRefusal } =>
    ({ result, refusal });
  const readRuntime = io.readRuntime ?? readRuntimePort;
  const runtime = io.runtimeEndpoint ?? readRuntime(pid);
  if (!runtime?.port) return done(false);
  const env = io.env ?? process.env;
  const headers: Record<string, string> = {};
  const token = configuredAdminToken(env.OPENCODEX_HOME?.trim() || undefined, env as NodeJS.ProcessEnv);
  if (token) headers["x-opencodex-api-key"] = token;
  const fetchFn = io.fetchFn ?? fetch;
  let sharedTeardownConfirmed = false;
  try {
    // `ocx stop` asks the proxy NOT to restore shared client config: it does that itself,
    // after verifying a stopped Task Scheduler did not respawn the proxy (#3008). Letting
    // the child do it means a survivor found seconds later has already lost its config.
    const stopUrl = `http://${gracefulStopHost(runtime.hostname)}:${runtime.port}/api/stop`
      + (io.deferSharedTeardownNonce
        ? `?deferSharedTeardown=1&teardownNonce=${encodeURIComponent(io.deferSharedTeardownNonce)}`
        : "");
    const res = await fetchFn(stopUrl, {
      method: "POST",
      headers,
      // Hung proxies with many CLOSE_WAIT clients can be slow to accept; give them
      // longer than a health poll so we prefer drain over taskkill /F.
      signal: AbortSignal.timeout(io.exitTimeoutMs ? Math.min(io.exitTimeoutMs, 10_000) : 10_000),
    });
    // 409 is the proxy REFUSING to stop. There is more than one reason it can say no — a
    // respawning service manager, the proxy being the installed service itself, or an
    // unreadable scheduler state — so both the message and the code are captured rather
    // than assumed. That is a policy answer, not a dead endpoint — escalating to SIGTERM
    // here would run the daemon's cleanup and strip shared config out from under the
    // still-running service. Report the refusal instead of forcing.
    if (res.status === 409) {
      const parsed = await res.json()
        .then(body => {
          const record = body as { message?: unknown; code?: unknown } | null;
          const message = record?.message;
          const code = record?.code;
          return {
            message: typeof message === "string" && message.trim() ? message.trim() : null,
            code: typeof code === "string" && code.trim() ? code.trim() : null,
          };
        })
        .catch(() => ({ message: null, code: null }));
      refusal.message = parsed.message;
      refusal.code = parsed.code;
      lastRefusalMessage = parsed.message;
      lastRefusalCode = parsed.code;
      return done("refused");
    }
    if (!res.ok) return done(false);
    const body: unknown = await res.json().catch(() => null);
    const expectedTeardown = io.deferSharedTeardownNonce ? "deferred" : "performed";
    sharedTeardownConfirmed = body !== null
      && typeof body === "object"
      && !Array.isArray(body)
      && "success" in body && body.success === true
      && "sharedTeardown" in body && body.sharedTeardown === expectedTeardown;
  } catch {
    return done(false);
  }
  const waitExit = io.waitExit ?? waitForExit;
  // Honor the server's own drain window: /api/stop answers 200 first, then drains for
  // config.shutdownTimeoutMs. Waiting less than that hard-kills mid-drain.
  const exitTimeoutMs = io.exitTimeoutMs ?? drainDeadlineMs();
  if (!waitExit(pid, exitTimeoutMs)) return done(false);
  return done(sharedTeardownConfirmed ? true : "teardown-unconfirmed");
}

function drainDeadlineMs(): number {
  try {
    return (loadConfig().shutdownTimeoutMs ?? 5000) + 3000;
  } catch {
    return 8000;
  }
}

/** Graceful-first stop: management-API drain, then the platform kill ladder. */
export async function stopProxy(pid: number, io: GracefulStopIo = {}): Promise<boolean> {
  if (!isProcessAlive(pid)) return false;
  const runtime = io.runtimeEndpoint ?? readRuntimePort(pid);
  const { result: graceful, refusal } = await stopProxyGracefullyDetailed(pid, io);
  if (graceful === "refused") {
    // The proxy refused on purpose. Forcing would strip shared config while whatever owns
    // the process keeps it alive. The server's own message is preferred; the fallback is
    // selected from its code so an empty body still names the right cause. Both come from
    // THIS attempt, so an overlapping stop cannot lend it the wrong reason.
    throw new ProxyOwnershipRefusedError(
      refusal.message ?? refusalFallbackMessage(refusal.code),
      refusal.code,
    );
  }
  if (graceful === "teardown-unconfirmed") {
    // Exit was observed, so do not enter the forced-stop fallback. Returning false keeps
    // shared restoration with `ocx stop` instead of claiming that the proxy completed it.
    await waitForStoppedPort(runtime, pid);
    return false;
  }
  if (graceful) {
    await waitForStoppedPort(runtime, pid);
    return true;
  }
  killProxy(pid);
  await waitForStoppedPort(runtime, pid);
  return false;
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
