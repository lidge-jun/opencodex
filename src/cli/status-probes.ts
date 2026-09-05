import { readPidFileValue, readRuntimePort } from "../config/process-state";
import { isOpencodexHealthz, probeHostname } from "../server/proxy-liveness";
import { directLocalHttpFetch } from "../server/direct-local-http";
import { isProcessAlive } from "../lib/process-control";

type HealthCheck = {
  ok: boolean;
  url: string;
  message: string;
  label: string;
  /** True only for a connect-phase refusal: proof that nothing holds the port. */
  refused?: boolean;
};

export type ListenTarget = {
  port: number;
  hostname?: string;
  source: "runtime" | "config";
  healthUrl: string;
  dashboardUrl: string;
};

export function proxyHealthFailureReason(error: unknown, signal: AbortSignal): "timed out" | "unreachable" {
  return signal.aborted || (error instanceof Error && error.name === "AbortError")
    ? "timed out"
    : "unreachable";
}

/**
 * "Nothing is listening" is narrower than "the probe failed". `unreachable` covers every
 * non-abort failure, including a socket that was ACCEPTED and then reset — which is what
 * an in-flight start looks like mid-bind. Only a connect-phase refusal proves the port is
 * free, so this reads the underlying errno instead of the display string.
 */
export function isConnectionRefused(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (code === "ECONNREFUSED" || code === "ConnectionRefused") return true;
    // Bun surfaces the refusal as a plain message on some platforms; the errno name is
    // still the discriminator, not a substring of arbitrary prose.
    if (typeof code === "string" && code.endsWith("ECONNREFUSED")) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A proxy killed by a native trap or SIGKILL never runs the exit cleanup that removes
 * `ocx.pid` and `runtime-port.json` (only SIGINT/SIGTERM/SIGHUP and normal exit are
 * wired to it), so both records outlive it. That makes "crashed" and "never started"
 * distinguishable — and #1419 is what it costs when we discard the distinction: the
 * reporter's unsupervised `ocx gui` proxy died and every later command said only
 * "not running", never that a previous process had exited or that a service would
 * have restarted it.
 *
 * Two races have to stay closed, because a false "it crashed" is worse than a missing
 * hint. `handleStart` binds the port BEFORE it publishes either record, so:
 *
 * - a start that publishes between two reads is caught by comparing the raw records
 *   observed before and after the probes (the same snapshot discipline
 *   `removePidIfValueIs` uses for deletion);
 * - a start that has bound but not yet published leaves both snapshots identical, so
 *   records alone cannot see it. That one is excluded on the port instead: the probe
 *   must have been REFUSED at connect, which is the only outcome proving nothing holds
 *   the port. A socket that is accepted and then reset — an in-flight bind — is not a
 *   refusal, so review caught `unreachable` being too broad for this job.
 *
 * What this can and cannot prove: the records outliving their process establish that the
 * previous run did not complete its cleanup. It does not establish a cause, and it cannot
 * fully exclude a clean exit whose `unlinkSync` failed, because cleanup ignores that
 * error (`src/cli/index.ts:324-325`) and the records carry no session provenance. The
 * wording therefore says the records remain and the run MAY have exited unexpectedly.
 */
export function isUncleanExitEvidence(input: {
  live: boolean;
  healthOk: boolean;
  healthRefused: boolean;
  ownerPidAlive: boolean;
  pidRecordBefore: number | null;
  pidRecordAfter: number | null;
  runtimePidBefore: number | null;
  runtimePidAfter: number | null;
}): boolean {
  if (input.live || input.healthOk) return false;
  if (!input.healthRefused) return false;
  if (input.ownerPidAlive) return false;
  if (input.pidRecordBefore !== input.pidRecordAfter) return false;
  if (input.runtimePidBefore !== input.runtimePidAfter) return false;
  return input.pidRecordAfter !== null || input.runtimePidAfter !== null;
}

export async function checkProxyHealth(target: ListenTarget): Promise<HealthCheck> {
  const url = target.healthUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const response = await directLocalHttpFetch(url, { signal: controller.signal });
    if (!response.ok) {
      const message = `returned HTTP ${response.status}`;
      return { ok: false, url, message, label: `${url} ${message}` };
    }
    const body = await response.json().catch(() => null) as { service?: unknown; status?: unknown; version?: unknown; uptime?: unknown } | null;
    if (!isOpencodexHealthz(body)) {
      const message = "responded, but not an opencodex proxy";
      return { ok: false, url, message, label: `${url} ${message}` };
    }
    const version = typeof body?.version === "string" ? ` v${body.version}` : "";
    const uptime = typeof body?.uptime === "number" ? `, uptime ${Math.round(body.uptime)}s` : "";
    const message = `ok${version}${uptime}`;
    return { ok: true, url, message, label: `${url} ${message}` };
  } catch (error) {
    const reason = proxyHealthFailureReason(error, controller.signal);
    return { ok: false, url, message: reason, label: `${url} ${reason}`, refused: isConnectionRefused(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The ONE evidence gatherer for stale-process state, shared by `ocx status` and
 * `ocx doctor`.
 *
 * It deliberately probes the port named by the STALE RECORD, not the configured display
 * port. Review found the two commands disagreeing precisely here: a proxy that hopped to
 * a fallback port, or a config whose port changed after the crash, left status probing
 * the configured port while doctor probed the recorded one, so one reported a crash and
 * the other did not. The question being asked is "is the process that wrote this record
 * gone?", and only that record's own port can answer it.
 *
 * `live` short-circuits before the probe so a healthy install pays nothing.
 */
export async function probeUncleanExitState(input: {
  live: boolean;
  port?: number;
  hostname?: string | null;
}): Promise<boolean> {
  if (input.live) return false;
  const pidRecordBefore = readPidFileValue();
  const runtimeBefore = readRuntimePort();
  const runtimePidBefore = runtimeBefore?.pid ?? null;
  if (pidRecordBefore === null && runtimePidBefore === null) return false;
  const ownerPid = pidRecordBefore ?? runtimePidBefore;
  if (ownerPid !== null && isProcessAlive(ownerPid)) return false;
  // The recorded port is the evidence target. Fall back to the configured port only when
  // no runtime record exists, which is the pid-file-only case.
  const port = runtimeBefore?.port ?? input.port ?? 10100;
  const hostname = runtimeBefore?.hostname ?? input.hostname ?? undefined;
  const health = await checkProxyHealth({
    port,
    hostname,
    source: runtimeBefore ? "runtime" : "config",
    healthUrl: `http://${probeHostname(hostname)}:${port}/healthz`,
    dashboardUrl: `http://localhost:${port}/`,
  });
  const pidRecordAfter = readPidFileValue();
  const runtimePidAfter = readRuntimePort()?.pid ?? null;
  const ownerPidAfter = pidRecordAfter ?? runtimePidAfter;
  return isUncleanExitEvidence({
    live: false,
    healthOk: health.ok,
    healthRefused: health.refused === true,
    ownerPidAlive: ownerPidAfter !== null && isProcessAlive(ownerPidAfter),
    pidRecordBefore,
    pidRecordAfter,
    runtimePidBefore,
    runtimePidAfter,
  });
}
