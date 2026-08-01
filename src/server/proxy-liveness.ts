/**
 * Runtime-state-first proxy liveness with identity checking.
 *
 * Historically `ensure`/`start` probed only `config.port` and accepted ANY 2xx /healthz:
 * a proxy that started on a fallback port was invisible (duplicate starts, Codex synced
 * back to a dead port), and a foreign app answering 200 on the configured port counted
 * as "our proxy". Liveness now (1) prefers the pid + runtime-port record and (2) requires
 * the /healthz body to identify as opencodex.
 *
 * Lives outside cli.ts (which dispatches argv at module top level) so tests can import it.
 */
import { loadConfig, readAlivePid, readRuntimePort, verifyPidIdentity } from "../config";

export interface HealthzIdentity {
  service?: unknown;
  status?: unknown;
  version?: unknown;
  uptime?: unknown;
  pid?: unknown;
}

export interface LivenessIo {
  fetchFn?: typeof fetch;
  readPidFn?: () => number | null;
  /**
   * Full identity check of the passed candidate pid; must return the SAME pid or null.
   * Destructive callers only ever receive pids that passed this gate.
   */
  verifyPidFn?: (candidatePid: number) => number | null;
  readRuntimeFn?: (pid?: number) => { pid?: number; port: number; hostname?: string } | null;
  configFn?: () => { port?: number; hostname?: string };
  timeoutMs?: number;
  /**
   * How many times to retry a probe that failed with a transport error (timeout /
   * connection refused). Definitive answers (non-OK HTTP, foreign /healthz body, pid
   * mismatch) do not retry. Default 1 = no retry. Stop paths should pass 2–3 (#764).
   */
  attempts?: number;
  sleepFn?: (ms: number) => Promise<void>;
  /**
   * Absolute wall-clock deadline for discovery. When set, each probe attempt aborts
   * once the remaining budget cannot cover another fetch — so multi-candidate
   * `findLiveProxy` under `SERVICE_STOP_LIVENESS` cannot overrun the stop-path
   * verification window (#764 / CodeRabbit).
   */
  deadlineAt?: number;
  nowFn?: () => number;
}

/** Default probe options for service stop / orphan cleanup — a just-bound proxy can miss a single 750ms probe. */
export const SERVICE_STOP_LIVENESS: Pick<LivenessIo, "timeoutMs" | "attempts"> = {
  timeoutMs: 1500,
  attempts: 3,
};

export interface LiveProxy {
  pid: number | null;
  port: number;
  /** Raw bind hostname the probe succeeded against; compose URLs via `probeHostname`. */
  hostname?: string;
  /** Whether the successful probe used runtime-port metadata or the configured listen port. */
  source: "runtime" | "config";
}

/**
 * Host to probe for a given bind hostname: wildcards answer on IPv4 loopback, and raw
 * IPv6 addresses must be bracketed or the composed URL is invalid.
 */
export function probeHostname(hostname: string | undefined): string {
  const trimmed = (hostname ?? "").trim();
  if (!trimmed || trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]") return "127.0.0.1";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

/**
 * True when a /healthz body identifies an opencodex proxy. Accepts the explicit
 * `service: "opencodex"` marker, plus the legacy `{status, version, uptime}` trio so a
 * still-running pre-identity proxy (e.g. right after `ocx update`) is not mistaken for a
 * foreign server and shadow-started over.
 */
export function isOpencodexHealthz(body: HealthzIdentity | null): boolean {
  if (!body) return false;
  if (body.service === "opencodex") return true;
  if (body.service !== undefined) return false;
  return body.status === "ok" && typeof body.version === "string" && typeof body.uptime === "number";
}

/** Identity-checked /healthz probe; null when unreachable, non-OK, or not our proxy. */
export async function proxyIdentityAt(
  port: number,
  opts: { hostname?: string; expectedPid?: number } = {},
  io: LivenessIo = {},
): Promise<{ pid: number | null } | null> {
  const fetchFn = io.fetchFn ?? fetch;
  const sleepFn = io.sleepFn ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const nowFn = io.nowFn ?? Date.now;
  const baseTimeoutMs = io.timeoutMs ?? 750;
  const requestedAttempts = Math.trunc(io.attempts ?? 1);
  const attempts = Number.isNaN(requestedAttempts)
    ? 1
    : Math.max(1, Math.min(requestedAttempts, 5));

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const remainingMs = io.deadlineAt === undefined ? baseTimeoutMs : io.deadlineAt - nowFn();
    if (remainingMs <= 0) return null;
    const timeoutMs = Math.min(baseTimeoutMs, remainingMs);
    try {
      const res = await fetchFn(`http://${probeHostname(opts.hostname)}:${port}/healthz`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as HealthzIdentity | null;
      if (!isOpencodexHealthz(body)) return null;
      const pid = typeof body?.pid === "number" ? body.pid : null;
      if (opts.expectedPid !== undefined && pid !== null && pid !== opts.expectedPid) return null;
      return { pid };
    } catch {
      // Transport failure (timeout / refused) — retry while budget remains; a proxy that
      // has only just begun listening can miss a single short probe (#764).
      if (attempt >= attempts) return null;
      if (io.deadlineAt !== undefined && io.deadlineAt - nowFn() <= 0) return null;
      await sleepFn(100);
    }
  }
  return null;
}

/**
 * Locate the live proxy: pid file → runtime-port record → identity probe. Falls back to
 * the configured port ONLY when no runtime record answers, so a fallback-port proxy is
 * found and a foreign listener on the configured port is rejected.
 */
export async function findLiveProxy(io: LivenessIo = {}): Promise<LiveProxy | null> {
  // Prefer the cheap alive-pid check: the Windows cmdline probe (WMIC/PowerShell) is too
  // expensive for waitForProxy's 150ms poll loop, and /healthz identity is the real trust gate.
  const readPidFn = io.readPidFn ?? readAlivePid;
  const verifyPidFn = io.verifyPidFn ?? verifyPidIdentity;
  const readRuntimeFn = io.readRuntimeFn ?? readRuntimePort;
  const configFn = io.configFn ?? loadConfig;

  // The cheap pid is discovery-only. Before it can appear in a returned (killable) result
  // it must pass the full identity check AND the verifier must echo the exact candidate —
  // a pidfile rewrite between discovery and verification can never swap in another process.
  const killablePid = (candidate: number | null): number | null => {
    if (candidate === null) return null;
    const verified = verifyPidFn(candidate);
    return verified === candidate ? verified : null;
  };

  const verifiedReportedPid = (reported: number | null): number | null => {
    if (reported === null) return null;
    if (!Number.isSafeInteger(reported) || reported <= 0) return null;
    const verified = verifyPidFn(reported);
    return verified === reported ? verified : null;
  };

  const pid = readPidFn();
  let probedPort: number | null = null;
  if (pid) {
    const runtime = readRuntimeFn(pid);
    if (runtime?.port) {
      probedPort = runtime.port;
      const identity = await proxyIdentityAt(runtime.port, { hostname: runtime.hostname, expectedPid: pid }, io);
      if (identity) {
        // healthz confirmed the pid itself → trusted; a pidless legacy body did not,
        // so the cheap pid must pass full identity verification before it is returned.
        const trusted = identity.pid === pid ? pid : killablePid(pid);
        return { pid: trusted, port: runtime.port, hostname: runtime.hostname, source: "runtime" };
      }
    }
  }

  // Orphan recovery: the pid file can be lost/corrupt while the proxy is alive (crash of a
  // sibling command, manual deletion). The runtime record still says where it listens —
  // identity-probe it so ensure/update/stop see the live proxy instead of shadowing it.
  const record = readRuntimeFn();
  if (record?.port && record.port !== probedPort) {
    const expectedPid = typeof record.pid === "number" ? record.pid : undefined;
    const identity = await proxyIdentityAt(record.port, { hostname: record.hostname, expectedPid }, io);
    // Only the healthz-reported pid is authoritative here. The record's pid may be stale
    // (its process dead, the port reused by a pidless legacy proxy) — synthesizing it
    // would hand destructive callers (stopProxy → kill fallback) a reusable pid.
    if (identity) {
      return { pid: verifiedReportedPid(identity.pid), port: record.port, hostname: record.hostname, source: "runtime" };
    }
  }

  const config = configFn();
  const port = config.port ?? 10100;
  const identity = await proxyIdentityAt(port, { hostname: config.hostname }, io);
  if (identity) {
    return {
      pid: verifiedReportedPid(identity.pid) ?? killablePid(pid),
      port,
      hostname: config.hostname,
      source: "config",
    };
  }
  return null;
}
