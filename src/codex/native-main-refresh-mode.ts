/**
 * Who refreshes the native main ChatGPT credential (#2999).
 *
 * Codex owns `CODEX_HOME/auth.json`. It rewrites the file in place and serializes its own
 * refreshes only inside one process, so any second writer can race it, and a lost race
 * retires the grant. In "codex" mode OpenCodex never writes the file: it asks the Codex
 * binary to refresh through `app-server` `getAuthStatus` and uses the bearer that call
 * returns. In "opencodex" mode the guarded writer in `main-account.ts` refreshes as before.
 *
 * The default is "codex" only when a version-checked binary is available. Without one, or
 * when the operator sets `nativeMainRefresh: "opencodex"`, the guarded writer stays.
 */
import { codexExecInvocation } from "./exec-invocation";
import { resolveCodexHomeDir } from "./home";
import { compareCodexVersions, displayCodexRuntimePath, resolveCodexRuntimeAsync } from "./runtime";
import type { ResolveCodexRuntimeResult } from "./runtime";
import { isTestHomeGuardArmed } from "../lib/test-home-guard";
import type { OcxConfig } from "../types/config";

export type NativeMainRefreshMode = "codex" | "opencodex";

/**
 * Supported floor for app-server `getAuthStatus` with `includeToken`/`refreshToken` that
 * withholds the token after a permanent refresh failure, the only reauth signal on the wire.
 * Releases from about 0.118 already withhold it; 0.130.0 is the first with the handler in
 * `request_processors/account_processor.rs` and is chosen conservatively.
 */
export const CODEX_AUTH_STATUS_MIN_VERSION = "0.130.0";

export type NativeMainRefreshReason =
  | "codex-compatible"
  | "configured-opencodex"
  | "codex-missing"
  | "codex-too-old"
  | "test-guard";

export interface NativeMainRefreshResolution {
  readonly mode: NativeMainRefreshMode;
  readonly configured: NativeMainRefreshMode | "auto";
  readonly reason: NativeMainRefreshReason;
  readonly command?: string;
  readonly version?: string | null;
}

export interface CodexAuthStatus {
  readonly authMethod: string | null;
  readonly authToken: string | null;
  readonly requiresOpenaiAuth: boolean | null;
}

export class CodexAuthStatusError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAuthStatusError";
  }
}

let resolutionForTests: NativeMainRefreshResolution | null = null;

/** Test seam: pin the resolution so no test spawns the developer's real Codex binary. */
export function setNativeMainRefreshResolutionForTests(value: NativeMainRefreshResolution | null): void {
  resolutionForTests = value;
}

function configuredMode(config: Pick<OcxConfig, "nativeMainRefresh"> | null | undefined): NativeMainRefreshMode | "auto" {
  const value = config?.nativeMainRefresh;
  return value === "codex" || value === "opencodex" ? value : "auto";
}

export async function resolveNativeMainRefreshMode(
  config: Pick<OcxConfig, "nativeMainRefresh"> | null | undefined,
  deps: { resolveRuntime?: () => Promise<ResolveCodexRuntimeResult> } = {},
): Promise<NativeMainRefreshResolution> {
  if (resolutionForTests) return resolutionForTests;
  const configured = configuredMode(config);
  if (configured === "opencodex") return { mode: "opencodex", configured, reason: "configured-opencodex" };
  // Tests run against throwaway CODEX_HOMEs; delegating would spawn the real binary.
  if (!deps.resolveRuntime && isTestHomeGuardArmed()) return { mode: "opencodex", configured, reason: "test-guard" };
  const resolved = await (deps.resolveRuntime ?? (() => resolveCodexRuntimeAsync({ discoverAlternatives: false })))();
  const { command, version, source } = resolved.runtime;
  if (source === "fallback" && version === null) {
    return { mode: "opencodex", configured, reason: "codex-missing" };
  }
  if (version === null || compareCodexVersions(version, CODEX_AUTH_STATUS_MIN_VERSION) < 0) {
    return { mode: "opencodex", configured, reason: "codex-too-old", command, version };
  }
  return { mode: "codex", configured, reason: "codex-compatible", command, version };
}

/**
 * One `getAuthStatus` round trip against a short-lived `codex app-server` on stdio.
 *
 * `model_provider="openai"` is forced because an authless Desktop injection sets
 * `requires_openai_auth = false` on the OpenCodex provider, and then the server reports no
 * credential at all. The process inherits CODEX_HOME so it reads the same login (file or
 * keyring) Codex itself uses.
 */
export async function requestCodexAuthStatus(
  command: string,
  options: { refresh: boolean; signal: AbortSignal; codexHome?: string },
): Promise<CodexAuthStatus> {
  if (options.signal.aborted) throw options.signal.reason;
  const invocation = codexExecInvocation(command, ["-c", 'model_provider="openai"', "app-server"]);
  let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">>;
  try {
    proc = Bun.spawn([invocation.file, ...invocation.args], {
      env: { ...process.env, CODEX_HOME: options.codexHome ?? resolveCodexHomeDir() },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      windowsVerbatimArguments: invocation.options.windowsVerbatimArguments,
      windowsHide: true,
    });
  } catch (cause) {
    throw new CodexAuthStatusError("could not start codex app-server", { cause });
  }
  // Abort settles the call by itself. Waiting for stdout to close would hang on a child that
  // ignores SIGTERM or a launcher descendant that keeps the pipe open.
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(options.signal.reason);
    options.signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => { /* observed through the race below */ });
  try {
    const send = (message: unknown) => proc.stdin.write(JSON.stringify(message) + "\n");
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "opencodex", title: null, version: "0" } } });
    send({ method: "initialized" });
    send({ id: 2, method: "getAuthStatus", params: { includeToken: true, refreshToken: options.refresh } });
    await Promise.race([proc.stdin.flush(), aborted]);
    const response = await Promise.race([readResponse(proc.stdout, 2), aborted]);
    if (options.signal.aborted) throw options.signal.reason;
    return parseAuthStatus(response);
  } catch (cause) {
    if (options.signal.aborted) throw options.signal.reason;
    if (cause instanceof CodexAuthStatusError) throw cause;
    throw new CodexAuthStatusError("codex app-server getAuthStatus failed", { cause });
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    stopAppServer(proc);
  }
}

const APP_SERVER_KILL_GRACE_MS = 2_000;

/** SIGTERM now, SIGKILL if the child is still alive after a grace period; never awaited. */
function stopAppServer(proc: { stdin: { end(): unknown }; kill(signal?: number | NodeJS.Signals): void; exited: Promise<number> }): void {
  try { proc.stdin.end(); } catch { /* already closed */ }
  let exited = false;
  void proc.exited.then(() => { exited = true; }, () => { exited = true; });
  try { proc.kill("SIGTERM"); } catch { /* already gone */ }
  const timer = setTimeout(() => {
    if (!exited) try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }, APP_SERVER_KILL_GRACE_MS);
  (timer as { unref?: () => void }).unref?.();
}

const MAX_APP_SERVER_LINE_BYTES = 1_048_576;

async function readResponse(stream: ReadableStream<Uint8Array>, id: number): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { continue; }
      if (!message || typeof message !== "object") continue;
      const record = message as Record<string, unknown>;
      if (record.id !== id) continue;
      if (record.error !== undefined) throw new CodexAuthStatusError("codex app-server rejected getAuthStatus");
      if (!record.result || typeof record.result !== "object") {
        throw new CodexAuthStatusError("codex app-server returned no getAuthStatus result");
      }
      return record.result as Record<string, unknown>;
    }
    if (buffered.length > MAX_APP_SERVER_LINE_BYTES) throw new CodexAuthStatusError("codex app-server line too long");
  }
  throw new CodexAuthStatusError("codex app-server exited before answering getAuthStatus");
}

function parseAuthStatus(result: Record<string, unknown>): CodexAuthStatus {
  const authMethod = typeof result.authMethod === "string" ? result.authMethod : null;
  const authToken = typeof result.authToken === "string" && result.authToken ? result.authToken : null;
  const requiresOpenaiAuth = typeof result.requiresOpenaiAuth === "boolean" ? result.requiresOpenaiAuth : null;
  return { authMethod, authToken, requiresOpenaiAuth };
}

/** `ocx doctor` lines for the active refresh owner. Never includes a credential. */
export function formatNativeMainRefreshDoctorLines(resolution: NativeMainRefreshResolution): string[] {
  const configured = resolution.configured === "auto" ? "auto" : `nativeMainRefresh: "${resolution.configured}"`;
  const binary = resolution.command
    ? `${displayCodexRuntimePath(resolution.command)} (${resolution.version ?? "unknown"})`
    : "none";
  switch (resolution.reason) {
    case "codex-compatible":
      return [`  ok  codex: Codex refreshes the main login through app-server (${binary}; ${configured})`];
    case "configured-opencodex":
      return [`  --  opencodex: OpenCodex refreshes auth.json with its guarded writer (${configured})`];
    case "test-guard":
      return ["  --  opencodex: test guard is armed; Codex delegation is disabled"];
    case "codex-missing":
      return [
        `  !!  opencodex: no Codex binary found, so OpenCodex refreshes auth.json itself (${configured})`,
        `       Install Codex ${CODEX_AUTH_STATUS_MIN_VERSION} or newer to let Codex own its login.`,
      ];
    case "codex-too-old":
      return [
        `  !!  opencodex: Codex ${binary} is older than ${CODEX_AUTH_STATUS_MIN_VERSION}, so OpenCodex refreshes auth.json itself (${configured})`,
        "       Update Codex to let Codex own its login.",
      ];
  }
}
