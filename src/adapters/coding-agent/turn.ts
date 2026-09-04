import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import { commandInvocation } from "../../lib/win-exec";
import type { IncomingMeta } from "../base";
import { buildConversationInput, CodingAgentProtocolError, mapStreamMessageToEvents, readJsonLines, type StreamParseState } from "./protocol";
import { resolveCodingAgentBinary, resolveProfileByBaseUrl, type CodingAgentProviderProfile, type WhichFn } from "./profile";

/** Injectable spawn for tests; production uses node:child_process. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface CodingAgentDeps {
  spawn?: SpawnFn;
  which?: WhichFn;
  /** Overall wall-clock ceiling for one turn (ms). */
  timeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL (ms). */
  killGraceMs?: number;
  /** Maximum time to wait for a child that never reports close after termination (ms). */
  reapTimeoutMs?: number;
  /** Test seam for Windows command-shim invocation. */
  platform?: NodeJS.Platform;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
/** Bound captured stderr so an error message can never carry an unbounded (or secret) payload. */
const MAX_STDERR_BYTES = 8 * 1024;

/** Env keys a CLI needs to run; everything else is dropped so the child env is scoped and deterministic. */
const INHERITED_ENV_KEYS = [
  "PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP",
  "SHELL", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "COMSPEC", "PATHEXT", "SYSTEMDRIVE", "USERNAME", "TZ",
] as const;

/**
 * Base scoped child-process environment (§六/§十四).
 *
 * Never mutates `process.env` (no cross-provider pollution under concurrency) and never inherits a
 * parent vendor variable, so a stray region switch in the host shell cannot flip a provider's
 * region: the profile is the sole authority. Family builders layer the credential + region vars on
 * top of this.
 */
export function baseScopedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

/** Redact the profile's credential and common secret shapes before surfacing diagnostics. */
export function redactSecrets(text: string, tokenEnv: string, credential?: string): string {
  const escaped = tokenEnv.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let redacted = text;
  if (credential) redacted = redacted.split(credential).join("[redacted]");
  return redacted
    .replace(new RegExp(`(${escaped}\\s*[:=]\\s*)\\S+`, "gi"), "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{6,})\b/g, "[redacted]");
}

export interface CodingAgentTurnInput {
  /** Region profiles for this family; the turn fails closed if the base URL matches none. */
  profiles: readonly CodingAgentProviderProfile[];
  provider: OcxProviderConfig;
  parsed: OcxParsedRequest;
  incoming: IncomingMeta;
  emit: (event: AdapterEvent) => void;
  /** Family-specific headless argument builder (tools disabled, model, reasoning, system prompt). */
  buildArgs: (profile: CodingAgentProviderProfile, parsed: OcxParsedRequest, provider: OcxProviderConfig) => string[];
  /** Family-specific scoped env builder (credential + region switch on top of baseScopedEnv). */
  buildEnv: (profile: CodingAgentProviderProfile, apiKey: string) => Record<string, string>;
  deps: CodingAgentDeps;
}

/**
 * Run one headless coding-agent CLI turn as an OpenCodex `runTurn` (§七/§三十).
 *
 * Single transport for every official coding-agent CLI provider: fail closed on a non-canonical
 * destination, pre-flight the credential and binary, spawn with a scoped env and tools disabled, feed
 * the replayed conversation over stream-json, map the vendor's Anthropic-aligned frames to
 * AdapterEvents, and always reap the process. Codex retains tool ownership: the CLI runs with its own
 * tools disabled, so this turn yields text/reasoning (the control-protocol tool bridge is a
 * documented fast-follow).
 */
export async function runCodingAgentTurn(input: CodingAgentTurnInput): Promise<void> {
  const { profiles, provider, parsed, incoming, emit, buildArgs, buildEnv, deps } = input;
  const spawnFn = deps.spawn ?? nodeSpawn;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const reapTimeoutMs = deps.reapTimeoutMs ?? (killGraceMs * 2 + 250);

  if (incoming.abortSignal?.aborted) {
    emit({ type: "error", message: "Coding-agent turn was aborted before start." });
    return;
  }

  // Fail closed on a non-canonical destination BEFORE any credential is placed in an env (§十六).
  const profile = resolveProfileByBaseUrl(profiles, provider.baseUrl);
  if (!profile) {
    emit({
      type: "error",
      message: "Provider base URL is not a canonical region destination; the credential was not sent.",
      status: 400,
      errorType: "invalid_request_error",
      code: "non_canonical_destination",
      retryable: false,
    });
    return;
  }
  const apiKey = provider.apiKey;
  if (!apiKey) {
    emit({
      type: "error",
      message: `${profile.label} credential missing — add an API key for this provider (${profile.tokenEnv}).`,
      status: 401,
      errorType: "authentication_error",
      code: "missing_credential",
      retryable: false,
    });
    return;
  }
  // Pre-flight binary discovery so a missing CLI is a clear error, not a mid-turn ENOENT (§二十六).
  const binary = resolveCodingAgentBinary(profile, deps.which);
  if (!binary) {
    emit({
      type: "error",
      message: `${profile.label} CLI not found on PATH. Install it with: ${profile.installHint}`,
      status: 500,
      errorType: "upstream_error",
      code: "cli_not_found",
      retryable: false,
    });
    return;
  }

  const args = buildArgs(profile, parsed, provider);
  const env = buildEnv(profile, apiKey);
  const invocation = commandInvocation(binary, args, deps.platform ?? process.platform, { env });

  let child: ChildProcess;
  try {
    child = spawnFn(invocation.file, invocation.args, {
      ...invocation.options,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    emit({
      type: "error",
      message: redactSecrets(err instanceof Error ? err.message : String(err), profile.tokenEnv, apiKey),
      status: 500,
      errorType: "upstream_error",
      code: "cli_spawn_failed",
      retryable: false,
    });
    return;
  }

  // `spawn()` reports launch failures such as ENOENT asynchronously through `error`; they are not
  // reliably thrown by the call above. Subscribe immediately and create the lifecycle promise now,
  // before stdout can end, so neither a fast close nor a launch failure can be missed by the reap step.
  let childProcessError: Error | undefined;
  const processLifecycle = new Promise<void>(resolve => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("error", err => {
      childProcessError = err;
      // A launch failure has no process to reap and is not guaranteed to emit `close` on every runtime.
      if (child.pid === undefined) settle();
    });
    child.once("close", settle);
    if (child.exitCode !== null) settle();
  });

  let terminalEmitted = false;
  const emitOnce = (event: AdapterEvent): void => {
    if (event.type === "done" || event.type === "error" || event.type === "incomplete") {
      if (terminalEmitted) return;
      terminalEmitted = true;
    }
    emit(event);
  };

  const stderrChunks: string[] = [];
  let killed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (): void => {
    if (killed || child.killed) return;
    killed = true;
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, killGraceMs);
  };

  const stopStream = (): void => {
    try { child.stdout?.destroy(); } catch { /* already closed */ }
  };
  const onAbort = (): void => {
    kill();
    stopStream();
  };
  incoming.abortSignal?.addEventListener("abort", onAbort, { once: true });
  const timeoutTimer = setTimeout(() => {
    kill();
    stopStream();
    emitOnce({ type: "error", message: `${profile.label} turn timed out.`, status: 504, errorType: "upstream_error", code: "timeout", retryable: true });
  }, timeoutMs);

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (stderrChunks.join("").length < MAX_STDERR_BYTES) stderrChunks.push(chunk);
  });

  const cleanup = (): void => {
    clearTimeout(timeoutTimer);
    incoming.abortSignal?.removeEventListener("abort", onAbort);
    try { child.stdin?.destroy(); } catch { /* ignore */ }
    // Termination is owned by the reap step below, not here: killing in cleanup would set
    // `child.killed` and let the wait resolve before the process is actually reaped (§三十).
  };

  let streamProtocolError: string | undefined;
  let turnError: string | undefined;
  const state: StreamParseState = {
    sawPartialText: false,
    sawPartialThinking: false,
    sawTerminalResult: false,
    openToolCallId: undefined,
  };

  try {
    // Write the replayed conversation, then close stdin so a single-shot turn can complete.
    const stdin = child.stdin;
    if (stdin) {
      stdin.on("error", () => { /* EPIPE if the CLI exits early; surfaced via close/stderr */ });
      for (const line of buildConversationInput(parsed)) stdin.write(`${line}\n`);
      stdin.end();
    }
    const stdout = child.stdout;
    if (!stdout) throw new CodingAgentProtocolError(`${profile.label} CLI produced no stdout stream`);
    try {
      for await (const message of readJsonLines(stdout)) {
        if (incoming.abortSignal?.aborted) break;
        for (const event of mapStreamMessageToEvents(message, state)) {
          emitOnce(event.type === "error"
            ? { ...event, message: redactSecrets(event.message, profile.tokenEnv, apiKey) }
            : event);
        }
        if (terminalEmitted) break;
      }
    } catch (err) {
      kill();
      streamProtocolError = err instanceof Error ? err.message : String(err);
    }
  } catch (err) {
    kill();
    turnError = err instanceof Error ? err.message : String(err);
  } finally {
    cleanup();
  }

  // Reap the process so no zombie is left behind (§三十): wait for the real `close`, and
  // force-terminate only if it lingers past the grace window after the stream ended.
  const graceTimer = setTimeout(() => { kill(); }, killGraceMs);
  let reapTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    processLifecycle,
    new Promise<void>(resolve => {
      reapTimer = setTimeout(resolve, reapTimeoutMs);
    }),
  ]);
  clearTimeout(graceTimer);
  if (reapTimer) clearTimeout(reapTimer);
  if (killTimer) clearTimeout(killTimer);

  if (!terminalEmitted) {
    const stderr = redactSecrets(boundedStderr(stderrChunks), profile.tokenEnv, apiKey);
    if (incoming.abortSignal?.aborted) {
      emitOnce({ type: "error", message: `${profile.label} turn was aborted.`, retryable: false });
    } else if (childProcessError) {
      emitOnce({
        type: "error",
        message: `${profile.label} CLI failed to start: ${redactSecrets(childProcessError.message, profile.tokenEnv, apiKey)}`,
        status: 500,
        errorType: "upstream_error",
        code: "cli_spawn_failed",
        retryable: false,
      });
    } else if (turnError) {
      emitOnce({
        type: "error",
        message: redactSecrets(turnError, profile.tokenEnv, apiKey),
        status: 502,
        errorType: "upstream_error",
      });
    } else if (streamProtocolError) {
      emitOnce({
        type: "error",
        message: redactSecrets(streamProtocolError, profile.tokenEnv, apiKey),
        status: 502,
        errorType: "upstream_error",
        code: "protocol_error",
        retryable: false,
      });
    } else if (child.exitCode !== null && child.exitCode !== 0) {
      const exitMsg = stderr
        ? `${profile.label} CLI exited with code ${child.exitCode}: ${stderr}`
        : `${profile.label} CLI exited with non-zero exit code ${child.exitCode}`;
      emitOnce({
        type: "error",
        message: exitMsg,
        status: 502,
        errorType: "upstream_error",
        code: "process_exit_error",
        retryable: false,
      });
    } else if (!state.sawTerminalResult) {
      const msg = stderr
        ? `${profile.label} CLI ended without a terminal result frame: ${stderr}`
        : `${profile.label} CLI ended without a terminal result frame`;
      emitOnce({
        type: "error",
        message: msg,
        status: 502,
        errorType: "upstream_error",
        code: "protocol_error",
        retryable: false,
      });
    }
  }
}

function boundedStderr(chunks: string[]): string {
  let total = 0;
  const kept: string[] = [];
  for (const chunk of chunks) {
    if (total >= MAX_STDERR_BYTES) break;
    kept.push(chunk);
    total += chunk.length;
  }
  return kept.join("").slice(0, MAX_STDERR_BYTES).trim();
}
