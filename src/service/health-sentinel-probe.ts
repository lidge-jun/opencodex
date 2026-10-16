/**
 * The service health sentinel's one question to the proxy it watches: does `GET /healthz`
 * produce a complete answer before the deadline (#6671)?
 *
 * The request goes through {@link directLocalHttpFetch}: raw `node:net`, so neither proxy
 * environment variables nor the bundled runtime's fetch stack (#6684) are involved, with capped
 * response framing and an absolute deadline. Only the timing decides liveness; the body's `pid`
 * lets the policy tell the target from another process that took the port.
 */
import { isIP } from "node:net";

import { isWildcardHostname } from "../codex/loopback-target";
import { directLocalHttpFetch } from "../server/direct-local-http";
import type { HealthProbeOutcome } from "./health-sentinel-policy";

export type HealthProbeTarget = { hostname: string; port: number };

export type HealthProbeIo = {
  now?: () => number;
  fetch?: (url: string, timeoutMs: number) => Promise<Response>;
};

/**
 * Numeric probe endpoint only; unknown DNS destinations cannot authorize recovery. Wildcard
 * spellings use the server's own predicate (`*`, `0`, `00.0.0.000`, `::0`, ...), so every bind
 * the server accepts as a wildcard is probed on loopback instead of standing the sentinel down.
 */
export function probeUrlHost(hostname: string | undefined): string | null {
  let value = (hostname ?? "").trim();
  if (isWildcardHostname(value)) return value.includes(":") ? "[::1]" : "127.0.0.1";
  if (value.startsWith("[") || value.endsWith("]")) {
    if (!value.startsWith("[") || !value.endsWith("]")) return null;
    value = value.slice(1, -1);
    if (isIP(value) !== 6) return null;
  }
  if (!value || value === "0.0.0.0" || /^localhost\.?$/i.test(value)) return "127.0.0.1";
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6 || value.includes("%")) return null;
  const host = new URL(`http://[${value}]/`).hostname;
  return host === "[::]" ? "[::1]" : host;
}

/** `pid` from a `/healthz` JSON body, or null when the body does not carry one. */
export function healthzPid(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

export async function probeHealth(target: HealthProbeTarget, timeoutMs: number, io: HealthProbeIo = {}): Promise<HealthProbeOutcome> {
  const now = io.now ?? Date.now;
  const fetchFn = io.fetch ?? ((url: string, deadlineMs: number) => directLocalHttpFetch(url, { headers: { accept: "application/json" } }, { timeoutMs: deadlineMs }));
  const startedAt = now();
  const hostname = probeUrlHost(target.hostname);
  if (hostname === null) return { kind: "error", startedAt, endedAt: now() };
  try {
    const response = await fetchFn(`http://${hostname}:${target.port}/healthz`, timeoutMs);
    // The framed body is already in memory; reading it cannot wait on the target.
    const body = await response.text().catch(() => "");
    return { kind: "answered", pid: healthzPid(body), startedAt, endedAt: now() };
  } catch (error) {
    const endedAt = now();
    const failure = error as { name?: unknown; code?: unknown };
    if (failure?.name === "TimeoutError") return { kind: "timeout", startedAt, endedAt };
    if (failure?.code === "ECONNREFUSED") return { kind: "refused", startedAt, endedAt };
    return { kind: "error", startedAt, endedAt };
  }
}
