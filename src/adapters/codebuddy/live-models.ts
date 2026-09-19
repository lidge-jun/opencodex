import { execFile } from "node:child_process";
import { commandInvocation } from "../../lib/win-exec";
import { isValidModelDiscoveryModelId } from "../../providers/model-discovery-limits";
import { baseScopedEnv, redactSecrets } from "../coding-agent/turn";
import { resolveCodingAgentBinary, type WhichFn } from "../coding-agent/profile";
import type { CodeBuddyProfile } from "./profiles";

const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_MODELS = 128;

export type CodeBuddyModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: "cli_not_found" | "timeout" | "process" | "invalid_output" | "empty" | "too_large"; detail?: string };

export interface CodeBuddyExecResult { stdout: string; stderr: string }
export type CodeBuddyExecFn = (
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; timeout: number; maxBuffer: number; windowsHide: boolean; windowsVerbatimArguments?: boolean },
) => Promise<CodeBuddyExecResult>;

export interface CodeBuddyModelsDeps {
  which?: WhichFn;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  exec?: CodeBuddyExecFn;
}

type CodeBuddyModelsFetcher = (profile: CodeBuddyProfile, apiKey: string) => CodeBuddyModelsResult | Promise<CodeBuddyModelsResult>;
let codeBuddyModelsFetcherForTests: CodeBuddyModelsFetcher | null = null;

export function setFetchCodeBuddyModelsForTests(next: CodeBuddyModelsFetcher | null): void {
  codeBuddyModelsFetcherForTests = next;
}

const ROSTER_LINE = /--model <model>\s+Model for the current session\. Please provide the model ID\. Currently supported: \(([^)]*)\)/;

/**
 * Parse the account-scoped model roster out of `codebuddy --help`.
 *
 * The help surface reflects the current subscription roster dynamically (the same CLI
 * build can print a different list on a different day), so it is the authority for what
 * the client exposes. `custom:*` selectors are per-user CLI configuration pointing at
 * operator-defined upstreams, not shared catalog rows, and are excluded.
 */
export function parseCodeBuddyHelpRoster(stdout: string): CodeBuddyModelsResult {
  if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) return { ok: false, error: "too_large" };
  const match = ROSTER_LINE.exec(stdout);
  if (!match) return { ok: false, error: "invalid_output", detail: "CodeBuddy help roster line is missing" };
  const models: string[] = [];
  const seen = new Set<string>();
  for (const raw of (match[1] ?? "").split(",")) {
    const id = raw.trim();
    if (!id || id.startsWith("custom:") || seen.has(id) || !isValidModelDiscoveryModelId(id)) continue;
    seen.add(id);
    models.push(id);
    if (models.length >= MAX_MODELS) break;
  }
  return models.length > 0 ? { ok: true, models } : { ok: false, error: "empty" };
}

function execCodeBuddy(
  command: string,
  args: readonly string[],
  options: Parameters<CodeBuddyExecFn>[2],
): Promise<CodeBuddyExecResult> {
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

/**
 * Discover the account-scoped roster the CLI exposes for this key via the --help surface.
 *
 * The roster line is printed per signed-in account (an isolated home yields only the
 * anonymous floor), so the credential and region env travel with the probe and the
 * caller binds the result to the key's fingerprint.
 */
export async function fetchCodeBuddyModels(
  profile: CodeBuddyProfile,
  apiKey: string,
  deps: CodeBuddyModelsDeps = {},
): Promise<CodeBuddyModelsResult> {
  if (codeBuddyModelsFetcherForTests) return codeBuddyModelsFetcherForTests(profile, apiKey);
  const binary = resolveCodingAgentBinary(profile, deps.which);
  if (!binary) return { ok: false, error: "cli_not_found", detail: profile.installHint };
  const env = {
    ...baseScopedEnv(),
    NO_COLOR: "1",
    [profile.tokenEnv]: apiKey,
    CODEBUDDY_INTERNET_ENVIRONMENT: profile.internetEnvironment,
  };
  const invocation = commandInvocation(binary, ["--help"], deps.platform ?? process.platform, { env });
  try {
    const result = await (deps.exec ?? execCodeBuddy)(invocation.file, invocation.args, {
      ...invocation.options,
      env,
      timeout: deps.timeoutMs ?? 8_000,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    return parseCodeBuddyHelpRoster(result.stdout);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    const stderr = redactSecrets(failure.stderr ?? failure.message ?? String(error), profile.tokenEnv, apiKey).trim().slice(0, 512);
    if (failure.killed || failure.code === "ETIMEDOUT") return { ok: false, error: "timeout", detail: "CodeBuddy model discovery timed out" };
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { ok: false, error: "too_large" };
    return { ok: false, error: "process", ...(stderr ? { detail: stderr } : {}) };
  }
}
