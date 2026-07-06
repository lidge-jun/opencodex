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
import { loadConfig, readPid, readRuntimePort } from "../config";

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
  readRuntimeFn?: (pid?: number) => { pid?: number; port: number; hostname?: string } | null;
  configFn?: () => { port?: number; hostname?: string };
  timeoutMs?: number;
}

export interface LiveProxy {
  pid: number | null;
  port: number;
  /** Raw bind hostname the probe succeeded against; compose URLs via `probeHostname`. */
  hostname?: string;
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
  try {
    const res = await fetchFn(`http://${probeHostname(opts.hostname)}:${port}/healthz`, {
      signal: AbortSignal.timeout(io.timeoutMs ?? 750),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as HealthzIdentity | null;
    if (!isOpencodexHealthz(body)) return null;
    const pid = typeof body?.pid === "number" ? body.pid : null;
    if (opts.expectedPid !== undefined && pid !== null && pid !== opts.expectedPid) return null;
    return { pid };
  } catch {
    return null;
  }
}

/**
 * Locate the live proxy: pid file → runtime-port record → identity probe. Falls back to
 * the configured port ONLY when no runtime record answers, so a fallback-port proxy is
 * found and a foreign listener on the configured port is rejected.
 */
export async function findLiveProxy(io: LivenessIo = {}): Promise<LiveProxy | null> {
  const readPidFn = io.readPidFn ?? readPid;
  const readRuntimeFn = io.readRuntimeFn ?? readRuntimePort;
  const configFn = io.configFn ?? loadConfig;

  const pid = readPidFn();
  let probedPort: number | null = null;
  if (pid) {
    const runtime = readRuntimeFn(pid);
    if (runtime?.port) {
      probedPort = runtime.port;
      const identity = await proxyIdentityAt(runtime.port, { hostname: runtime.hostname, expectedPid: pid }, io);
      if (identity) return { pid, port: runtime.port, hostname: runtime.hostname };
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
    if (identity) return { pid: identity.pid ?? null, port: record.port, hostname: record.hostname };
  }

  const config = configFn();
  const port = config.port ?? 10100;
  const identity = await proxyIdentityAt(port, { hostname: config.hostname }, io);
  if (identity) return { pid: identity.pid ?? pid ?? null, port, hostname: config.hostname };
  return null;
}
