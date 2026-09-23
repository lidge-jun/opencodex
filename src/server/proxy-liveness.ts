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
import { loadConfig } from "../config";
import { isWildcardHostname } from "../codex/loopback-target";
import { readAlivePid, readRuntimePort, verifyPidIdentity } from "../config/process-state";
import { directLocalHttpFetch } from "./direct-local-http";

export interface HealthzIdentity {
  service?: unknown;
  status?: unknown;
  version?: unknown;
  uptime?: unknown;
  pid?: unknown;
  port?: unknown;
  /**
   * Which listener answered: the standalone/hub server omits it, and the connected-client
   * machine listener reports `"client"` (src/client/machine-listener.ts). It is the only
   * on-the-wire way to tell those two apart, because both bind `config.port ?? 10100`.
   */
  role?: unknown;
  restartCapability?: unknown;
  providerReloadCapability?: unknown;
  asideSyncCapability?: unknown;
  guiPairCapability?: unknown;
}

export type EndpointLiveness = "live" | "dead" | "unknown";

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

/** Default per-probe fetch ceiling shared by liveness and readiness probes. */
export const DEFAULT_PROBE_TIMEOUT_MS = 750;

/** Default probe options for service stop / orphan cleanup — a just-bound proxy can miss a single 750ms probe. */
export const SERVICE_STOP_LIVENESS: Pick<LivenessIo, "timeoutMs" | "attempts"> = {
  timeoutMs: 1500,
  attempts: 3,
};

/**
 * Probe budget for a decision whose wrong answer starts a DUPLICATE proxy (#5004).
 *
 * `start` used the 750ms single-attempt default for both the pre-bind owner probe and
 * (implicitly) the busy-port question behind the ephemeral hop. On Windows that answered
 * "nothing is listening" for a proxy the previous command had just refused to shadow, and
 * the hop then spawned a second instance that took over this home's pid/runtime records
 * and re-pointed Codex at itself. A single unanswered probe is not evidence of absence
 * when the failure mode is a duplicate instance, so the start path borrows the numbers
 * the stop path already uses for the mirror-image decision.
 */
export const START_OWNERSHIP_LIVENESS: Pick<LivenessIo, "timeoutMs" | "attempts"> = {
  timeoutMs: 1500,
  attempts: 3,
};

type LivenessFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface LiveProxy {
  pid: number | null;
  port: number;
  /** Raw bind hostname the probe succeeded against; compose URLs via `probeHostname`. */
  hostname?: string;
  /** Whether the successful probe used runtime-port metadata or the configured listen port. */
  source: "runtime" | "config";
  /**
   * Version the live proxy reported on `/healthz`, when it reported one.
   *
   * Carried so a stale `ocx` on PATH can be detected without a second request: the
   * identity probe already parsed and validated this body. Absent for a legacy proxy whose
   * healthz body predates the field.
   */
  version?: string;
  /**
   * Role the live listener reported on `/healthz`, when it reported one: `"client"` for the
   * connected-client machine listener, absent for a standalone or hub proxy.
   *
   * Liveness deliberately still ACCEPTS a client-role listener — see `isOpencodexHealthz`.
   * The role is carried so a caller that needs a management plane (src/cli/runtime-api.ts)
   * can refuse one, while `stop` and orphan cleanup keep finding the process they must act
   * on. Absent for a proxy whose healthz body predates the field.
   */
  role?: string;
}

/**
 * Host to probe for a given bind hostname: wildcards answer on IPv4 loopback, and raw
 * IPv6 addresses must be bracketed or the composed URL is invalid.
 *
 * The wildcard test is `isWildcardHostname`, not a list of spellings. This function used to
 * know exactly three (`0.0.0.0`, `::`, `[::]`) while the bind-scope predicate knew every
 * all-zero form, so `ocx` composed `http://0.0.0.0.:10100` or `http://*:10100` — unreachable
 * URLs — for a config the server itself treated as a wildcard bind. One predicate, both sides.
 */
export function probeHostname(hostname: string | undefined): string {
  const trimmed = (hostname ?? "").trim();
  if (!trimmed || isWildcardHostname(trimmed)) return "127.0.0.1";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

/**
 * True when a /healthz body identifies an opencodex proxy. Accepts the explicit
 * `service: "opencodex"` marker, plus the legacy `{status, version, uptime}` trio so a
 * still-running pre-identity proxy (e.g. right after `ocx update`) is not mistaken for a
 * foreign server and shadow-started over.
 *
 * The connected-client machine listener answers with the same `service: "opencodex"` marker
 * and an extra `role: "client"`, and it is accepted here on purpose. Liveness answers "is one
 * of our processes listening on this port", which is exactly what `ocx stop`, orphan cleanup,
 * and duplicate-start avoidance need: rejecting the client role would make those paths blind to
 * a real opencodex process and let them shadow-start over it. Callers that additionally need a
 * management plane discriminate on `LiveProxy.role` instead of narrowing this predicate.
 */
export function isOpencodexHealthz(body: HealthzIdentity | null): boolean {
  if (!body) return false;
  if (body.service === "opencodex") return true;
  if (body.service !== undefined) return false;
  return body.status === "ok" && typeof body.version === "string" && typeof body.uptime === "number";
}

/** A bounded version string safe to carry beyond the untrusted health response. */
export function isHealthzVersion(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

/**
 * "Nothing is listening" is narrower than "the probe failed". Only a connect-phase refusal
 * proves the endpoint is free; a timeout, reset, or other transport failure leaves the
 * question open.
 */
export function isConnectionRefused(error: unknown): boolean {
  const visit = (current: unknown, depth: number): boolean => {
    if (depth >= 4) return false;
    if (current === null || (typeof current !== "object" && typeof current !== "function")) return false;
    const record = current as { code?: unknown; cause?: unknown; errors?: unknown };
    if (record.code === "ECONNREFUSED" || record.code === "ConnectionRefused") return true;
    if (typeof record.code === "string" && record.code.endsWith("ECONNREFUSED")) return true;
    if (Array.isArray(record.errors) && record.errors.length > 0) {
      // One connect attempt fanned out over several addresses reports a single AggregateError.
      // Only a unanimous refusal proves the endpoint is free: a bundle that mixes ECONNREFUSED
      // with a timeout means one address answered nothing at all, and an address whose state is
      // unreadable is unknown, not absence. Collapsing it to "refused" is how a second runtime
      // gets started on a port that already has one.
      return record.errors.every(error => visit(error, depth + 1));
    }
    return visit(record.cause, depth + 1);
  };
  return visit(error, 0);
}

async function classifyHealthz(
  url: string,
  fetchFn: LivenessFetch,
  timeoutMs: number,
): Promise<EndpointLiveness> {
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return "unknown";
    const body = (await response.json().catch(() => undefined)) as HealthzIdentity | null | undefined;
    if (body === undefined) return "unknown";
    return isOpencodexHealthz(body) ? "live" : "dead";
  } catch (error) {
    return isConnectionRefused(error) ? "dead" : "unknown";
  }
}

/**
 * Tri-state probe of one endpoint, the in-process counterpart of
 * `src/update/proxy-liveness-probe.mjs`. Only a connect-phase refusal or a clean 200 that is
 * not ours proves "dead"; a timeout, reset, non-200 or unreadable body leaves the question
 * open. Loopback endpoints are checked on both IPv4 and IPv6 because a listener may bind only
 * one family. Runs in-process because a compiled standalone binary cannot fork `execPath -e`.
 */
export async function probeEndpointLiveness(
  endpoint: { port: number; hostname?: string },
  io: Pick<LivenessIo, "fetchFn" | "timeoutMs"> = {},
): Promise<EndpointLiveness> {
  if (!Number.isFinite(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65535) return "dead";
  const fetchFn = io.fetchFn ?? directLocalHttpFetch;
  const timeoutMs = io.timeoutMs ?? 1500;
  let sawUnknown = false;
  for (const hostname of loopbackProbeHosts(endpoint.hostname)) {
    const result = await classifyHealthz(
      `http://${hostname}:${endpoint.port}/healthz`,
      fetchFn,
      timeoutMs,
    );
    if (result === "live") return "live";
    if (result === "unknown") sawUnknown = true;
  }
  return sawUnknown ? "unknown" : "dead";
}

/** Identity-checked /healthz probe; null when unreachable, non-OK, or not our proxy. */
export async function proxyIdentityAt(
  port: number,
  opts: { hostname?: string; expectedPid?: number } = {},
  io: LivenessIo = {},
): Promise<{ pid: number | null; version?: string; role?: string } | null> {
  const fetchFn = io.fetchFn ?? directLocalHttpFetch;
  const sleepFn = io.sleepFn ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const nowFn = io.nowFn ?? Date.now;
  const baseTimeoutMs = io.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
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
      // Whoever holds the port controls this response. Only carry bounded semver text into
      // diagnostics; dropping anything else prevents terminal controls reaching human output.
      const version = isHealthzVersion(body?.version) ? body.version : undefined;
      // Same guard for the role, for the same reason: absent on a standalone/hub proxy and on
      // a legacy body, and never coerced from a non-string.
      const role = typeof body?.role === "string" ? body.role : undefined;
      return {
        pid,
        ...(version === undefined ? {} : { version }),
        ...(role === undefined ? {} : { role }),
      };
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
  const nowFn = io.nowFn ?? Date.now;
  const deadlineAt = io.deadlineAt;
  const probeIo: LivenessIo = io;
  const budgetExhausted = (): boolean =>
    deadlineAt !== undefined && nowFn() >= deadlineAt;

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
      if (budgetExhausted()) return null;
      probedPort = runtime.port;
      const identity = await proxyIdentityAt(runtime.port, { hostname: runtime.hostname, expectedPid: pid }, probeIo);
      if (identity) {
        // healthz confirmed the pid itself → trusted; a pidless legacy body did not,
        // so the cheap pid must pass full identity verification before it is returned.
        const trusted = identity.pid === pid ? pid : killablePid(pid);
        return {
          pid: trusted,
          port: runtime.port,
          hostname: runtime.hostname,
          source: "runtime",
          ...(identity.version === undefined ? {} : { version: identity.version }),
          ...(identity.role === undefined ? {} : { role: identity.role }),
        };
      }
    }
  }

  // Orphan recovery: the pid file can be lost/corrupt while the proxy is alive (crash of a
  // sibling command, manual deletion). The runtime record still says where it listens —
  // identity-probe it so ensure/update/stop see the live proxy instead of shadowing it.
  const record = readRuntimeFn();
  if (record?.port && record.port !== probedPort) {
    if (budgetExhausted()) return null;
    const expectedPid = typeof record.pid === "number" ? record.pid : undefined;
    const identity = await proxyIdentityAt(record.port, { hostname: record.hostname, expectedPid }, probeIo);
    // Only the healthz-reported pid is authoritative here. The record's pid may be stale
    // (its process dead, the port reused by a pidless legacy proxy) — synthesizing it
    // would hand destructive callers (stopProxy → kill fallback) a reusable pid.
    if (identity) {
      return {
        pid: verifiedReportedPid(identity.pid),
        port: record.port,
        hostname: record.hostname,
        source: "runtime",
        ...(identity.version === undefined ? {} : { version: identity.version }),
        ...(identity.role === undefined ? {} : { role: identity.role }),
      };
    }
  }

  const config = configFn();
  const port = config.port ?? 10100;
  if (budgetExhausted()) return null;
  const identity = await proxyIdentityAt(port, { hostname: config.hostname }, probeIo);
  if (identity) {
    return {
      pid: verifiedReportedPid(identity.pid) ?? killablePid(pid),
      port,
      hostname: config.hostname,
      source: "config",
      ...(identity.version === undefined ? {} : { version: identity.version }),
      ...(identity.role === undefined ? {} : { role: identity.role }),
    };
  }
  return null;
}

/**
 * Loopback addresses to ask about a port whose holder must be identified before a
 * decision that is destructive when it answers "nobody".
 *
 * A listener and a probe can disagree about what "loopback" means, and on Windows they
 * do. `startServer` canonicalizes a `localhost` bind to 127.0.0.1 precisely because
 * Windows resolves the name IPv6-first (src/server/index.ts), while `probeHostname`
 * hands the literal name back and leaves the family choice to the resolver. A probe that
 * lands on `::1` while the listener holds `127.0.0.1` reports an empty port that another
 * process is demonstrably serving. Both literal addresses are therefore asked, cheapest
 * question first: the extra one costs a refused connection, and skipping it costs a
 * duplicate proxy.
 *
 * A non-loopback bind (a LAN address, a named host) gets exactly one candidate — the
 * address it was configured with. Guessing another interface for it would answer a
 * different question than the caller asked.
 */
export function loopbackProbeHosts(hostname: string | undefined): string[] {
  const primary = probeHostname(hostname);
  if (primary === "127.0.0.1" || /^localhost$/i.test(primary)) return ["127.0.0.1", "[::1]"];
  if (primary === "[::1]") return ["[::1]", "127.0.0.1"];
  return [primary];
}

/**
 * Identity-checked answer to "who holds this exact port", independent of the pid file
 * and the runtime-port record.
 *
 * `findLiveProxy` answers "is a proxy of this home alive", and it can only do that from
 * recorded state plus the configured port. This answers the narrower question a start
 * has to ask before it walks away from a busy port: an opencodex listening THERE, right
 * now, whatever this home's records say about it. Returns null only after every
 * candidate address has failed the identity check with the caller's full probe budget.
 */
export async function probePortOwner(
  port: number,
  opts: { hostname?: string } = {},
  io: LivenessIo = {},
): Promise<{ pid: number | null; hostname: string; version?: string; role?: string } | null> {
  for (const hostname of loopbackProbeHosts(opts.hostname)) {
    const identity = await proxyIdentityAt(port, { hostname }, io);
    if (identity) return { ...identity, hostname };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Readiness (/readyz) strict probe.
//
// Liveness (/healthz) confirms the process answers; readiness confirms the
// post-startup Codex sync has settled. A readiness probe is identity-checked the
// same way liveness is, AND additionally enforces the full /readyz contract so
// an adversarial or malformed body can never count as ready:
//
//  - HTTP 200 is required for status="ready"; HTTP 503 is required for pending
//    or failed. Any other HTTP/body-status pairing is an invalid contract.
//  - body.service must be exactly "opencodex".
//  - body.version must be a non-empty string.
//  - body.uptime must be a finite nonnegative number.
//  - body.pid must be a positive integer; when `expectedPid` is supplied it must
//    match exactly.
//  - body.port must be an integer in 1..65535 and equal the probed port.
//  - body.status must be exactly one of pending|ready|failed.
//
// Any unreachable, foreign, legacy, malformed, mismatched, or self-inconsistent
// response returns `null` so callers can never treat an invalid identity/contract
// as ready.
// ─────────────────────────────────────────────────────────────────────────────

interface ReadyzBody {
  service?: unknown;
  version?: unknown;
  uptime?: unknown;
  pid?: unknown;
  port?: unknown;
  status?: unknown;
  // Remote protocol metadata is intentionally additive here. Ordinary
  // readiness remains compatible with legacy standalone servers; `ocx connect`
  // validates these fields separately in src/remote/protocol.ts.
  protocol?: unknown;
  minimumClientProtocol?: unknown;
  managementUrl?: unknown;
}

export interface ReadinessProbeResult {
  /** True ONLY for a valid 200 + status="ready" body with a matching pid. */
  ready: boolean;
  /** Fixed sanitized status. A foreign/unreadable body yields a `null` RESULT, never a `null` status. */
  status: "ready" | "pending" | "failed";
  /** Positive integer pid from a valid body. */
  pid: number;
  /** Integer port from a valid body. */
  port: number;
}

export interface ReadinessProbeIo {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const READYZ_STATUS_VALUES = new Set<"ready" | "pending" | "failed">(["ready", "pending", "failed"]);

/**
 * Validate a parsed /readyz body against the strict contract. Returns the
 * sanitized probe result, or `null` when the body is foreign, legacy,
 * malformed, or fails the pid/port checks. Pure (no I/O) so it is fully
 * deterministic and unit-testable.
 */
export function validateReadyzBody(
  body: unknown,
  port: number,
  opts: { expectedPid?: number } = {},
): ReadinessProbeResult | null {
  if (!body || typeof body !== "object") return null;
  const b = body as ReadyzBody;
  if (b.service !== "opencodex") return null;
  if (typeof b.version !== "string" || b.version.length === 0) return null;
  if (typeof b.uptime !== "number" || !Number.isFinite(b.uptime) || b.uptime < 0) return null;
  if (typeof b.pid !== "number" || !Number.isInteger(b.pid) || b.pid <= 0) return null;
  if (
    typeof b.port !== "number"
    || !Number.isInteger(b.port)
    || b.port < 1
    || b.port > 65535
    || b.port !== port
  ) return null;
  if (typeof b.status !== "string" || !READYZ_STATUS_VALUES.has(b.status as "ready" | "pending" | "failed")) return null;
  const status = b.status as "ready" | "pending" | "failed";
  if (opts.expectedPid !== undefined && b.pid !== opts.expectedPid) return null;
  return { ready: status === "ready", status, pid: b.pid, port: b.port };
}

/**
 * Identity- and contract-checked /readyz probe. Returns `null` when the
 * endpoint is unreachable or the body fails the strict contract (foreign 200,
 * legacy health-only body, non-JSON, missing/malformed/mismatched fields,
 * wrong port/pid, or an HTTP/body-status inconsistency). Returns
 * `{ready:false, ...}` when the body is ours but pending or failed. Returns
 * `{ready:true, ...}` ONLY for a valid 200 body with `status:"ready"` and (when
 * requested) a matching pid.
 */
export async function probeReadiness(
  port: number,
  opts: { hostname?: string; expectedPid?: number } = {},
  io: ReadinessProbeIo = {},
): Promise<ReadinessProbeResult | null> {
  const fetchFn = io.fetchFn ?? directLocalHttpFetch;
  try {
    const res = await fetchFn(`http://${probeHostname(opts.hostname)}:${port}/readyz`, {
      signal: AbortSignal.timeout(io.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
    });
    // Parse even on 503: /readyz returns JSON with a sanitized status while pending.
    const body = (await res.json().catch(() => null)) as unknown;
    const parsed = validateReadyzBody(body, port, opts);
    if (!parsed) return null;
    // HTTP/body-status consistency: ready requires 200; pending/failed require 503.
    if (parsed.status === "ready" && res.status !== 200) return null;
    if (parsed.status !== "ready" && res.status !== 503) return null;
    return parsed;
  } catch {
    return null;
  }
}
