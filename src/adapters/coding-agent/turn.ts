import { execFileSync, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import { commandInvocation } from "../../lib/win-exec";
import { isStandaloneBinary } from "../../lib/standalone";
import { modelRecordValue } from "../../reasoning-effort";
import type { IncomingMeta } from "../base";
import {
  buildConversationInput,
  CodingAgentProtocolError,
  mapStreamMessageToEvents,
  projectedHistoryCharLimit,
  readJsonLines,
  toolBridgeInitError,
  type StreamParseState,
} from "./protocol";
import { resolveCodingAgentBinary, resolveProfileByBaseUrl, type CodingAgentProviderProfile, type WhichFn } from "./profile";

/** Injectable spawn for tests; production uses node:child_process. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Injectable Windows process-tree terminator; production uses taskkill /T /F. */
export type KillWindowsProcessTreeFn = (pid: number) => void;

/** Per-turn injectables: spawn/which seams for tests plus wall-clock ceilings for timeout, kill grace, and bounded reap. */
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
  /** Test seam for terminating a Windows CLI and all descendants. */
  killWindowsProcessTree?: KillWindowsProcessTreeFn;
  /** Test seam for a catalog/config write failure after private bridge-directory creation. */
  writeToolBridgeFile?: typeof writeFile;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
/** Bound captured stderr so an error message can never carry an unbounded (or secret) payload. */
const MAX_STDERR_BYTES = 8 * 1024;

function killWindowsProcessTree(pid: number): void {
  const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
  execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
    stdio: "pipe",
    windowsHide: true,
  });
}

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

/** Inputs for one headless CLI turn: region profiles, request context, and family-specific arg/env builders. */
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
  /**
   * Opt-in capture-only tool bridge. When present with a non-empty catalog, the turn writes a
   * validated catalog plus an MCP config to a private temp dir, passes `--mcp-config` (with exact
   * `--allowedTools`) alongside the family's tools-disabled args, translates captured tool_use
   * names back to request wire names, and terminates the process tree at `message_stop` because
   * the capture-only MCP handler intentionally never answers. Execution stays with the client.
   */
  toolBridge?: CodingAgentToolBridgeInput;
  deps: CodingAgentDeps;
}

/** Opt-in capture-only tool bridge for one coding-agent CLI turn. */
export interface CodingAgentToolBridgeInput {
  /** MCP server name advertised to the CLI; tool_use blocks render it as `mcp__<name>__<tool>`. */
  serverName: string;
  /** Absolute path of the capture-only MCP server module, run with the serving runtime. */
  serverModulePath: string;
  /** Validated tool catalog advertised over ListTools; the server never executes a call. */
  tools: ReadonlyArray<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  /** CLI-emitted tool name (`mcp__<server>__<tool>`) to the request's wire tool name. */
  emittedNameMap: Map<string, string>;
  /** Captured tool_use blocks accepted in one assistant message. */
  maxTurnToolCalls: number;
  /**
   * The request's `tool_choice` requires a tool call (`required`, or a named selection).
   * The nested CLI has no documented force-tool flag, so this is enforced locally: a
   * terminal text result on a required turn fails closed instead of silently succeeding.
   */
  requireToolCall?: boolean;
}

export function codeBuddyMcpInvocation(serverModulePath: string, catalogPath: string, standalone = isStandaloneBinary()): string[] {
  return standalone ? ["__codebuddy-mcp", catalogPath] : [serverModulePath, catalogPath];
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
  const platform = deps.platform ?? process.platform;

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

  const toolBridge = input.toolBridge;
  const writeToolBridgeFile = deps.writeToolBridgeFile ?? writeFile;
  let toolBridgeDir: string | undefined;
  let toolBridgeMcpConfigPath: string | undefined;
  if (toolBridge) {
    if (toolBridge.tools.length === 0 || toolBridge.emittedNameMap.size === 0) {
      emit({
        type: "error",
        message: "Coding-agent tool bridge was supplied without any isolated tools.",
        status: 500,
        errorType: "server_error",
        code: "tool_bridge_empty",
        retryable: false,
      });
      return;
    }
    try {
      toolBridgeDir = await mkdtemp(join(tmpdir(), "ocx-coding-agent-tools-"));
      const catalogPath = join(toolBridgeDir, "catalog.json");
      toolBridgeMcpConfigPath = join(toolBridgeDir, "mcp.json");
      await writeToolBridgeFile(catalogPath, JSON.stringify(toolBridge.tools), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await writeToolBridgeFile(
        toolBridgeMcpConfigPath,
        JSON.stringify({
          mcpServers: {
            [toolBridge.serverName]: {
              type: "stdio",
              command: process.execPath,
              args: codeBuddyMcpInvocation(toolBridge.serverModulePath, catalogPath),
              defer_loading: false,
              alwaysLoad: true,
            },
          },
        }),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    } catch {
      emit({
        type: "error",
        message: "Coding-agent tool bridge could not be staged securely.",
        status: 500,
        errorType: "server_error",
        code: "tool_bridge_setup_failed",
        retryable: false,
      });
      if (toolBridgeDir) await rm(toolBridgeDir, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
  }

  const args = buildArgs(profile, parsed, provider);
  if (toolBridge && toolBridgeMcpConfigPath) {
    // Exact names close the wildcard domain; --strict-mcp-config (family args) keeps user
    // servers out, so the capture server is the only capability this turn can reach.
    args.push("--allowedTools", [...toolBridge.emittedNameMap.keys()].join(","), "--mcp-config", toolBridgeMcpConfigPath);
  }
  const env = buildEnv(profile, apiKey);
  const invocation = commandInvocation(binary, args, platform, { env });

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
    // A synchronous spawn() throw skips the event-loop `finally` below, so the private
    // bridge dir would leak unless it is removed here as well.
    if (toolBridgeDir) await rm(toolBridgeDir, { recursive: true, force: true }).catch(() => undefined);
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
    if (platform === "win32" && child.pid !== undefined) {
      try {
        (deps.killWindowsProcessTree ?? killWindowsProcessTree)(child.pid);
        return;
      } catch { /* fall back to terminating the direct child */ }
    }
    // The capture-only MCP server is the CLI's child. Its stdin closes when the CLI dies, and
    // mcp-server.ts exits on stdin EOF, so this ladder reaps the whole tree without knowing
    // the grandchild pid.
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
  // A successful result frame that arrived after every captured tool call completed but
  // before message_stop. The bridge contract still ends the leg with the synthesized
  // done(tool_use) at message_stop, so the result-derived done(stop) is deferred and its
  // usage (authoritative vendor accounting) is folded into the synthesis. Set inside the
  // stream loop; read by the synthesis and the stream-end error selection below.
  let deferredResultDone: Extract<AdapterEvent, { type: "done" }> | undefined;
  const state: StreamParseState = {
    sawPartialText: false,
    sawPartialThinking: false,
    sawTerminalResult: false,
    openToolCallId: undefined,
    partialToolCallIds: toolBridge ? new Set<string>() : undefined,
  };

  try {
    // Write the replayed conversation, then close stdin so a single-shot turn can complete.
    const stdin = child.stdin;
    if (stdin) {
      stdin.on("error", () => { /* EPIPE if the CLI exits early; surfaced via close/stderr */ });
      // The projected history scales with the model context window on the routed provider row
      // (catalog and config metadata merged): a 1M-token model keeps 3M characters of replay
      // where the flat cap cut it near 50k-130k tokens of content. Absent metadata keeps the
      // flat cap.
      const historyCharLimit = projectedHistoryCharLimit(
        modelRecordValue(provider.modelContextWindows, parsed.modelId) ?? provider.contextWindow,
      );
      for (const line of buildConversationInput(parsed, { maxHistoryChars: historyCharLimit })) stdin.write(`${line}\n`);
      stdin.end();
    }
    const stdout = child.stdout;
    if (!stdout) throw new CodingAgentProtocolError(`${profile.label} CLI produced no stdout stream`);
    try {
      let initValidated = false;
      let toolCallStarts = 0;
      let failClosed = false;
      for await (const message of readJsonLines(stdout)) {
        if (incoming.abortSignal?.aborted) break;
        if (toolBridge) {
          const initError = toolBridgeInitError(message, toolBridge.serverName);
          if (initError) {
            emitOnce({
              type: "error",
              message: initError,
              status: 502,
              errorType: "upstream_error",
              code: "tool_bridge_init_mismatch",
              retryable: false,
            });
            kill();
            break;
          }
          if (message.type === "system" && message.subtype === "init") initValidated = true;
        }
        const mappedEvents = mapStreamMessageToEvents(message, state);
        if (toolBridge && state.uncapturedToolUse) {
          emitOnce({
            type: "error",
            message: "Coding-agent CLI returned a tool call without a partial tool capture.",
            status: 502,
            errorType: "upstream_error",
            code: "protocol_error",
            retryable: false,
          });
          kill();
          break;
        }
        for (const event of mappedEvents) {
          if (toolBridge && !initValidated && event.type === "done") {
            emitOnce({
              type: "error",
              message: "Coding-agent CLI ended before the tool bridge init handshake completed.",
              status: 502,
              errorType: "upstream_error",
              code: "tool_bridge_init_missing",
              retryable: false,
            });
            failClosed = true;
            kill();
            break;
          }
          if (toolBridge && event.type === "tool_call_start") {
            // The catalog is only advertised once the CLI has acknowledged the bridge server in
            // its init handshake. A tool call that arrives before that acknowledgement means the
            // model acted on a catalog this bridge never validated, so fail closed before the
            // call is counted or renamed. Checking at arrival matters: a later init frame used to
            // set initValidated and let an early call finish as a successful done(tool_use).
            if (!initValidated) {
              emitOnce({
                type: "error",
                message: "Coding-agent CLI called a tool before the tool bridge init handshake completed.",
                status: 502,
                errorType: "upstream_error",
                code: "tool_bridge_init_missing",
                retryable: false,
              });
              failClosed = true;
              kill();
              break;
            }
            toolCallStarts += 1;
            if (toolCallStarts > toolBridge.maxTurnToolCalls) {
              emitOnce({
                type: "error",
                message: `Coding-agent CLI returned more than the ${toolBridge.maxTurnToolCalls}-tool-call turn limit.`,
                status: 502,
                errorType: "upstream_error",
                code: "tool_call_limit",
                retryable: false,
              });
              failClosed = true;
              kill();
              break;
            }
            const wireName = toolBridge.emittedNameMap.get(event.name);
            if (wireName === undefined) {
              emitOnce({
                type: "error",
                message: "Coding-agent CLI called a tool outside the isolated catalog.",
                status: 502,
                errorType: "upstream_error",
                code: "undeclared_tool_call",
                retryable: false,
              });
              failClosed = true;
              kill();
              break;
            }
            emitOnce({ ...event, name: wireName });
            continue;
          }
          if (
            toolBridge?.requireToolCall === true
            && !terminalEmitted
            && event.type === "done"
            && event.stopReason !== "tool_use"
            && (state.completedToolCalls ?? 0) === 0
          ) {
            // `tool_choice: required|named` on a bridge turn: a text-only terminal result must not
            // become a successful completion the client can accept. The capture-only bridge has no
            // way to force the nested CLI, so fail closed with the same stable error shape the
            // other bridge contract violations use.
            emitOnce({
              type: "error",
              message: "CodeBuddy finished without calling the required tool.",
              status: 502,
              errorType: "upstream_error",
              code: "tool_call_required",
              retryable: false,
            });
            failClosed = true;
            kill();
            break;
          }
          if (
            toolBridge
            && !terminalEmitted
            && event.type === "done"
            && toolCallStarts > 0
            && (state.completedToolCalls ?? 0) !== toolCallStarts
          ) {
            // A terminal result that arrives while a captured tool call is still open must not
            // become a successful completion the client can accept. The message_stop check after
            // the event loop cannot cover this path: the CLI normally parks on the
            // never-answering capture server, but a stream that delivers the result frame
            // without (or before) message_stop emits done here, and started-but-unfinished
            // calls slipped through as successful turns.
            emitOnce({
              type: "error",
              message: "Coding-agent CLI ended with an incomplete tool call.",
              status: 502,
              errorType: "upstream_error",
              code: "protocol_error",
              retryable: false,
            });
            failClosed = true;
            kill();
            break;
          }
          if (
            toolBridge
            && !terminalEmitted
            && event.type === "done"
            && toolCallStarts > 0
            && (state.completedToolCalls ?? 0) === toolCallStarts
          ) {
            // Every captured call completed and the CLI settled with a successful result before
            // message_stop (instead of parking on the never-answering capture server). Emitting
            // this done(stop) now would end the turn as a text completion and skip the
            // synthesized done(tool_use) the client contract expects. Defer it: message_stop
            // synthesis emits the terminal event with this frame's usage, and a stream that
            // ends without message_stop fails closed with protocol_error below.
            deferredResultDone = event;
            continue;
          }
          emitOnce(event.type === "error"
            ? { ...event, message: redactSecrets(event.message, profile.tokenEnv, apiKey) }
            : event);
        }
        if (failClosed) break;
        if (
          toolBridge
          && !terminalEmitted
          && state.sawMessageStop
          && toolCallStarts > 0
          && (state.completedToolCalls ?? 0) !== toolCallStarts
        ) {
          emitOnce({
            type: "error",
            message: "Coding-agent CLI ended with an incomplete tool call.",
            status: 502,
            errorType: "upstream_error",
            code: "protocol_error",
            retryable: false,
          });
          kill();
          break;
        }
        if (toolBridge && !terminalEmitted && state.sawMessageStop && (state.completedToolCalls ?? 0) > 0) {
          // No init re-check here: a completed call implies a tool_call_start was mapped, and the
          // arrival-time gate above already refuses any start that lands before the handshake.
          // The capture-only MCP handler never answers, so the CLI parks after message_stop.
          // The completed tool_use blocks are this turn's structured output: end the leg here
          // and terminate the tree; the client executes, and the next request continues.
          // Pre-result usage snapshots keep this terminated leg accountable: no result frame
          // ever arrives for a turn parked on the never-answering capture server.
          const terminalUsage = deferredResultDone?.usage ?? state.partialUsage;
          emitOnce({
            type: "done",
            stopReason: "tool_use",
            endTurn: false,
            ...(terminalUsage ? { usage: terminalUsage } : {}),
          });
          kill();
          break;
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
    if (toolBridgeDir) {
      await rm(toolBridgeDir, { recursive: true, force: true }).catch(() => undefined);
    }
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
    } else if (toolBridge && deferredResultDone !== undefined && !state.sawMessageStop) {
      emitOnce({
        type: "error",
        message: `${profile.label} CLI delivered a terminal result before message_stop on a tool-bridge turn.`,
        status: 502,
        errorType: "upstream_error",
        code: "protocol_error",
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
