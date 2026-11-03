import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { commandInvocation } from "../../lib/win-exec";
import { isValidModelDiscoveryModelId } from "../../providers/model-discovery-limits";
import { baseScopedEnv, redactSecrets } from "../coding-agent/turn";
import { resolveCodingAgentBinary, type WhichFn } from "../coding-agent/profile";
import type { QoderProfile } from "./profiles";

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_MODELS = 256;

export type QoderModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: "auth" | "cli_not_found" | "timeout" | "process" | "invalid_output" | "empty" | "too_large"; detail?: string };

export interface QoderExecResult { stdout: string; stderr: string }
export type QoderExecFn = (
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; timeout: number; maxBuffer: number; windowsHide: boolean; windowsVerbatimArguments?: boolean },
) => Promise<QoderExecResult>;

export interface QoderModelsDeps {
  which?: WhichFn;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  exec?: QoderExecFn;
}

type QoderModelsFetcher = (profile: QoderProfile, apiKey: string) => QoderModelsResult | Promise<QoderModelsResult>;
let qoderModelsFetcherForTests: QoderModelsFetcher | null = null;

export function setFetchQoderModelsForTests(next: QoderModelsFetcher | null): void {
  qoderModelsFetcherForTests = next;
}

export function parseQoderModelList(stdout: string): QoderModelsResult {
  if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) return { ok: false, error: "too_large" };
  const lines = stdout.split(/\r?\n/);
  const header = lines.findIndex(raw => /^model$/i.test(raw.trim()));
  if (header < 0) return { ok: false, error: "invalid_output", detail: "Qoder model list header is missing" };
  const models: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines.slice(header + 1)) {
    const id = raw.trim();
    if (!id || seen.has(id) || !isValidModelDiscoveryModelId(id)) continue;
    seen.add(id);
    models.push(id);
    if (models.length >= MAX_MODELS) break;
  }
  return models.length > 0 ? { ok: true, models } : { ok: false, error: "empty" };
}

/**
 * Upper bound for one background `--list-models` run. The CLI starts a full agent runtime before it
 * lists the account's roster; 14.5 s was measured on a working install (#8115), so the former 8 s
 * bound discarded successful listings. Failures still end in the stale/static catalog and back off.
 */
export const QODER_MODEL_DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * Deadline of an interactive caller (the dashboard connection test). When it passes, the caller
 * reports the provider as still discovering; the run itself keeps its background bound.
 */
export const QODER_INTERACTIVE_DEADLINE_MS = 8_000;

/**
 * A successful listing stays joinable this long after it finished, so the catalog re-sync a late
 * result triggers reads it instead of starting a second CLI run.
 */
export const QODER_DISCOVERY_REUSE_MS = 60_000;

type QoderDiscoveryFlight = { promise: Promise<QoderModelsResult>; succeededAt?: number };
const qoderDiscoveryFlights = new Map<string, QoderDiscoveryFlight>();

function qoderDiscoveryKey(profile: QoderProfile, apiKey: string): string {
  // The roster is entitlement-specific, so one flight serves exactly one PAT.
  return `${profile.providerId}\0${createHash("sha256").update(apiKey).digest("hex")}`;
}

function joinableFlight(key: string, now: number): QoderDiscoveryFlight | undefined {
  const flight = qoderDiscoveryFlights.get(key);
  if (!flight) return undefined;
  if (flight.succeededAt === undefined || now - flight.succeededAt < QODER_DISCOVERY_REUSE_MS) return flight;
  qoderDiscoveryFlights.delete(key);
  return undefined;
}

/** True while a run for this PAT is in flight or its success can still be joined. */
export function qoderDiscoveryJoinable(profile: QoderProfile, apiKey: string, now = Date.now()): boolean {
  return joinableFlight(qoderDiscoveryKey(profile, apiKey), now) !== undefined;
}

/**
 * One `--list-models` run per PAT, shared by the background catalog gather and interactive callers.
 * A failed run is forgotten when it settles; a successful one stays joinable for the reuse window.
 */
export function discoverQoderModels(profile: QoderProfile, apiKey: string, now = Date.now()): Promise<QoderModelsResult> {
  const key = qoderDiscoveryKey(profile, apiKey);
  const existing = joinableFlight(key, now);
  if (existing) return existing.promise;
  const flight: QoderDiscoveryFlight = {
    promise: Promise.resolve().then(() => fetchQoderModels(profile, apiKey)).then(result => {
      if (result.ok) flight.succeededAt = Date.now();
      else if (qoderDiscoveryFlights.get(key) === flight) qoderDiscoveryFlights.delete(key);
      return result;
    }, error => {
      if (qoderDiscoveryFlights.get(key) === flight) qoderDiscoveryFlights.delete(key);
      throw error;
    }),
  };
  qoderDiscoveryFlights.set(key, flight);
  return flight.promise;
}

export function clearQoderDiscoveryFlightsForTests(): void {
  qoderDiscoveryFlights.clear();
}

function execQoder(command: string, args: readonly string[], options: Parameters<QoderExecFn>[2]): Promise<QoderExecResult> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** Discover the roster exposed to this exact PAT via the documented `--list-models` command. */
export async function fetchQoderModels(profile: QoderProfile, apiKey: string, deps: QoderModelsDeps = {}): Promise<QoderModelsResult> {
  if (qoderModelsFetcherForTests) return qoderModelsFetcherForTests(profile, apiKey);
  const binary = resolveCodingAgentBinary(profile, deps.which);
  if (!binary) return { ok: false, error: "cli_not_found", detail: profile.installHint };
  const env = { ...baseScopedEnv(), NO_COLOR: "1", [profile.tokenEnv]: apiKey };
  const invocation = commandInvocation(binary, ["--list-models"], deps.platform ?? process.platform, { env });
  try {
    const result = await (deps.exec ?? execQoder)(invocation.file, invocation.args, {
      ...invocation.options,
      env,
      timeout: deps.timeoutMs ?? QODER_MODEL_DISCOVERY_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    return parseQoderModelList(result.stdout);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    const stderr = redactSecrets(failure.stderr ?? failure.message ?? String(error), profile.tokenEnv, apiKey).trim().slice(0, 512);
    if (failure.killed || failure.code === "ETIMEDOUT") return { ok: false, error: "timeout", detail: "Qoder model discovery timed out" };
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { ok: false, error: "too_large" };
    const auth = /not logged in|invalid (?:personal access )?token|authentication/i.test(stderr);
    return { ok: false, error: auth ? "auth" : "process", ...(stderr ? { detail: stderr } : {}) };
  }
}
