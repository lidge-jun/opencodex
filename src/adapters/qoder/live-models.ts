import { execFile } from "node:child_process";
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
      timeout: deps.timeoutMs ?? 8_000,
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
