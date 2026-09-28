/**
 * One proxied turn, run by Anthropic's own harness through the Claude Agent SDK.
 *
 * This is the correction the row is for. The 2.65.0 construction spawned `claude -p` with a replaced
 * system prompt, no session and the tools stripped, and drove it from a foreign client — the harness
 * as a puppet. Here the harness is the agent: its process, its session for the turn, its prompt
 * preset with the caller's contract appended, its sign-in. OpenCodex contributes the projection, the
 * tool catalog it is allowed to advertise, and the stream mapping.
 *
 * The bridge contract below is the same one `../coding-agent/turn.ts` enforces for the spawned-CLI
 * families (init handshake before any call, exact catalog names, a per-turn call cap, `tool_choice`
 * and incomplete-call fail-closed paths). Two transports, one contract; the branches are deliberately
 * parallel to that file's so a change to one is visible next to the other.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainedUtf8Bytes, truncateRetainedUtf8 } from "../../lib/admission";
import { isStandaloneBinary } from "../../lib/standalone";
import { isTranslatorBudgetExceededError } from "../../lib/translator-budget";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { modelRecordValue } from "../../reasoning-effort";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import type { IncomingMeta } from "../base";
import {
  resolveCodingAgentBinary,
  resolveProfileByBaseUrl,
  type CodingAgentProviderProfile,
  type WhichFn,
} from "../coding-agent/profile";
import {
  buildConversationInput,
  MAX_TOOL_BLOCK_STARTS,
  mapStreamMessageToEvents,
  projectedHistoryCharLimit,
  releaseOpenToolBlocks,
  toolBridgeInitError,
  type StreamMessage,
  type StreamParseState,
} from "../coding-agent/protocol";
import { redactSecrets } from "../coding-agent/turn";
import { buildChildEnv } from "./env";
import { createHarnessProcessSupervisor, reapHarnessQuarantine, type HarnessSpawnFn, type HarnessTreeKillFn } from "./harness-process";
import type { ClaudeCliProfile } from "./profiles";
import { buildAgentSdkTurnOptions } from "./sdk-options";

/** The Agent SDK surface this adapter uses; narrow on purpose, so the test seam stays small. */
export interface ClaudeAgentSdkQuery {
  [Symbol.asyncIterator](): AsyncIterator<StreamMessage>;
  return?(value?: unknown): Promise<IteratorResult<StreamMessage>>;
}

export interface ClaudeAgentSdkModule {
  query(params: { prompt: string | AsyncIterable<StreamMessage>; options: Record<string, unknown> }): ClaudeAgentSdkQuery;
}

/** Loads the Agent SDK package. Injectable so tests never start a real harness. */
export type ClaudeAgentSdkLoader = () => Promise<ClaudeAgentSdkModule>;

export const loadClaudeAgentSdkModule: ClaudeAgentSdkLoader = async () => {
  return await import("@anthropic-ai/claude-agent-sdk") as unknown as ClaudeAgentSdkModule;
};

/** Capture-only catalog handed to the runner by the adapter (see `./sdk-bridge.ts`). */
export interface ClaudeAgentSdkToolBridge {
  serverName: string;
  emittedNameMap: Map<string, string>;
  maxTurnToolCalls: number;
  requireToolCall: boolean;
  instance: McpServer;
}

/** Per-turn injectables: the SDK loader, PATH discovery, the two ceilings, and the owned child. */
export interface ClaudeAgentSdkDeps {
  loadSdk?: ClaudeAgentSdkLoader;
  which?: WhichFn;
  /** Test seam for the compiled-binary executable resolution. */
  isStandalone?: () => boolean;
  /** Overall wall-clock ceiling for one turn (ms). */
  timeoutMs?: number;
  /** How long to wait for an aborted turn to settle before answering the client (ms). */
  reapTimeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL for the harness child (ms). */
  killGraceMs?: number;
  /** Test seam for the owned harness process; the default uses `node:child_process`. */
  spawnHarnessProcess?: HarnessSpawnFn;
  /** Platform seam for the harness tree terminator and its process group (tests). */
  harnessPlatform?: NodeJS.Platform;
  /** Test seam for the harness tree terminator; see `./harness-process.ts`. */
  killHarnessProcessTree?: HarnessTreeKillFn;
  /** Creates the turn neutral working directory. Test seam; the default uses the system temp dir. */
  makeScratchDir?: () => Promise<string>;
  /** Removes that directory once the harness is gone. */
  removeScratchDir?: (dir: string) => Promise<void>;
}

/**
 * The directory a proxied turn runs in.
 *
 * Empty on purpose. The harness preset reports its working directory and a git-status summary to
 * the model, and with `process.cwd()` those describe the machine OpenCodex was started from -
 * the operator own checkout, by file name. The client own workspace reaches the model through
 * the request instead, which is the only place it belongs.
 */
async function makeScratchDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ocx-claude-agent-sdk-"));
}

async function removeScratchDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_REAP_TIMEOUT_MS = 5_000;
/** Bound captured stderr so an error message can never carry an unbounded (or secret) payload. */
const MAX_STDERR_BYTES = 8 * 1024;

export interface ClaudeAgentSdkTurnInput {
  profiles: readonly CodingAgentProviderProfile[];
  provider: OcxProviderConfig;
  parsed: OcxParsedRequest;
  incoming: IncomingMeta;
  emit: (event: AdapterEvent) => void;
  /** Absent for a text/reasoning-only turn. */
  toolBridge?: ClaudeAgentSdkToolBridge;
  deps: ClaudeAgentSdkDeps;
}

/**
 * Project the replayed conversation into the single user frame the harness receives.
 *
 * The client replays its own transcript, so the frame is a projection rather than the harness's own
 * memory: the same text the spawned-CLI route wrote to stdin, delivered through the SDK's prompt
 * channel instead of a pipe.
 */
async function* projectedPrompt(frames: readonly string[]): AsyncGenerator<StreamMessage> {
  for (const line of frames) {
    let frame: { message?: unknown };
    try {
      frame = JSON.parse(line) as { message?: unknown };
    } catch {
      continue;
    }
    if (frame.message === undefined) continue;
    yield { type: "user", message: frame.message, parent_tool_use_id: null };
  }
}

function boundedStderr(chunks: readonly string[]): string {
  const joined = chunks.join("");
  // Every chunk is already bounded at ingestion; this is the byte-exact bound on the joined result.
  return (retainedUtf8Bytes(joined) > MAX_STDERR_BYTES
    ? truncateRetainedUtf8(joined, MAX_STDERR_BYTES)
    : joined).trim();
}

export async function runClaudeAgentSdkTurn(input: ClaudeAgentSdkTurnInput): Promise<void> {
  const { profiles, provider, parsed, incoming, emit, toolBridge, deps } = input;
  const profile = resolveProfileByBaseUrl(profiles, provider.baseUrl);
  const apiKey = provider.apiKey ?? "";

  if (incoming.abortSignal?.aborted) {
    emit({ type: "error", message: "Claude Agent SDK turn was aborted before start." });
    return;
  }

  // Fail closed on a non-canonical destination before the harness starts (§十六): the subscription
  // reaches exactly one host, and an overridden base URL would hand a signed-in account elsewhere.
  if (!profile) {
    emit({
      type: "error",
      message: "Provider base URL is not a canonical region destination; the turn was not started.",
      status: 400,
      errorType: "invalid_request_error",
      code: "non_canonical_destination",
      retryable: false,
    });
    return;
  }

  // A compiled single-file binary cannot resolve the Claude Code build the SDK ships from inside its
  // `$bunfs` module tree — the SDK documents that — so there the turn drives the `claude` on PATH,
  // the binary this row required before it moved onto the SDK. A normal install lets the SDK use the
  // build it ships, which is version-matched to the protocol it speaks.
  let executablePath: string | undefined;
  if ((deps.isStandalone ?? isStandaloneBinary)()) {
    executablePath = resolveCodingAgentBinary(profile, deps.which);
    if (!executablePath) {
      emit({
        type: "error",
        message: `${profile.label} executable is not on PATH and this build cannot use the copy bundled with the Agent SDK. Install it with: ${profile.installHint}`,
        status: 500,
        errorType: "upstream_error",
        code: "cli_not_found",
        retryable: false,
      });
      return;
    }
  }

  const loadSdk = deps.loadSdk ?? loadClaudeAgentSdkModule;
  let sdk: ClaudeAgentSdkModule;
  try {
    sdk = await loadSdk();
  } catch (err) {
    emit({
      type: "error",
      message: redactSecrets(
        `The Claude Agent SDK could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
        profile.tokenEnv,
        apiKey,
      ),
      status: 500,
      errorType: "upstream_error",
      code: "claude_agent_sdk_unavailable",
      retryable: false,
    });
    return;
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const reapTimeoutMs = deps.reapTimeoutMs ?? DEFAULT_REAP_TIMEOUT_MS;
  const abortController = new AbortController();
  const onAbort = (): void => abortController.abort();
  incoming.abortSignal?.addEventListener("abort", onAbort, { once: true });

  const stderrChunks: string[] = [];
  let stderrBytes = 0;
  const onStderr = (chunk: string): void => {
    // Bound at ingestion and in UTF-8 bytes. The running total says nothing about the size of this
    // chunk, so a single oversized callback would otherwise be retained whole and only cut after the
    // join; a code-unit cut would also let multi-byte text carry several times the advertised bound.
    const remaining = MAX_STDERR_BYTES - stderrBytes;
    if (remaining <= 0) return;
    const kept = retainedUtf8Bytes(chunk) <= remaining ? chunk : truncateRetainedUtf8(chunk, remaining);
    if (kept.length === 0) return;
    stderrChunks.push(kept);
    stderrBytes += retainedUtf8Bytes(kept);
  };

  let scratchDir: string;
  try {
    scratchDir = await (deps.makeScratchDir ?? makeScratchDir)();
  } catch (err) {
    emit({
      type: "error",
      message: redactSecrets(
        `Claude Agent SDK turn could not create its scratch directory: ` + (err instanceof Error ? err.message : String(err)),
        profile.tokenEnv,
        apiKey,
      ),
      status: 500,
      errorType: "upstream_error",
      code: "claude_agent_sdk_scratch_unavailable",
      retryable: false,
    });
    return;
  }

  // The harness is owned here rather than by the SDK, because the SDK's cleanup is bounded short of
  // the process it started: `query.return()` settling is not evidence that the child is gone, and the
  // turn must not delete its scratch cwd or answer the client underneath a live process. The two
  // things the SDK's own spawn did for the child that a custom spawner has to keep - the stderr pump
  // and the real exit - are in `./harness-process.ts`.
  // Sweep the quarantine once per turn. A survivor from an earlier turn is observed here and, when
  // it has closed, hands its bounded cleanup lease back; a turn that cannot be observed any more is
  // dropped with a warning there. No timer of its own, and no cost while the quarantine is empty.
  reapHarnessQuarantine();

  const harness = createHarnessProcessSupervisor({
    onStderr,
    reapTimeoutMs,
    ...(deps.killGraceMs !== undefined ? { killGraceMs: deps.killGraceMs } : {}),
    ...(deps.spawnHarnessProcess !== undefined ? { spawn: deps.spawnHarnessProcess } : {}),
    ...(deps.harnessPlatform !== undefined ? { platform: deps.harnessPlatform } : {}),
    ...(deps.killHarnessProcessTree !== undefined ? { killProcessTree: deps.killHarnessProcessTree } : {}),
  });

  const options = buildAgentSdkTurnOptions({
    provider,
    parsed,
    cwd: scratchDir,
    env: buildChildEnv(profile as ClaudeCliProfile, apiKey),
    abortController,
    onStderr,
    spawnHarnessProcess: harness.spawn,
    ...(executablePath !== undefined ? { executablePath } : {}),
    ...(toolBridge !== undefined
      ? {
          toolCatalog: {
            serverName: toolBridge.serverName,
            instance: toolBridge.instance,
            allowedNames: [...toolBridge.emittedNameMap.keys()],
          },
        }
      : {}),
  });

  // A terminal frame is held here instead of being emitted where it is decided; the tail delivers the
  // one this turn owes the client. That ordering is load-bearing, not stylistic: the bridge closes the
  // response body on the terminal frame, and the body's EOF is what releases the global turn-admission
  // lease. Delivered from inside the event loop, it would admit the next turn while this one's harness
  // is still being reaped - the same leak the process ownership in `./harness-process.ts` exists to
  // close, one layer up. Non-terminal frames are unaffected and still stream as they arrive.
  let terminalDecided = false;
  let pendingTerminal: AdapterEvent | undefined;
  const emitOnce = (event: AdapterEvent): void => {
    if (event.type === "done" || event.type === "error" || event.type === "incomplete") {
      if (terminalDecided) return;
      terminalDecided = true;
      pendingTerminal = event;
      return;
    }
    emit(event);
  };

  const timeoutTimer = setTimeout(() => {
    abortController.abort();
    emitOnce({
      type: "error",
      message: `${profile.label} turn timed out.`,
      status: 504,
      errorType: "upstream_error",
      code: "timeout",
      retryable: true,
    });
  }, timeoutMs);

  const historyCharLimit = projectedHistoryCharLimit(
    modelRecordValue(provider.modelContextWindows, parsed.modelId) ?? provider.contextWindow,
  );
  const promptFrames = buildConversationInput(parsed, { maxHistoryChars: historyCharLimit });

  const state: StreamParseState = {
    sawPartialText: false,
    sawPartialThinking: false,
    sawTerminalResult: false,
    openToolBlocks: new Map(),
    // The shared parser owns tool-state admission since dev's #6081/#6083: the per-turn ceiling and
    // the request's translator budget are set on the state here, exactly as the spawned-CLI turn
    // sets them, so a capture path cannot retain tool identity or argument fragments unbounded.
    translatorBudget: incoming.translatorBudget,
    maxToolBlockStarts: toolBridge?.maxTurnToolCalls,
    strictToolBlockCapture: Boolean(toolBridge),
    partialToolCallIds: toolBridge ? new Set<string>() : undefined,
  };

  let query: ClaudeAgentSdkQuery | undefined;
  let streamError: string | undefined;
  let streamProtocolCode: string | undefined;
  // A successful result frame that arrived after every captured tool call completed but before
  // message_stop: the leg still ends with the synthesized done(tool_use) at message_stop, so this
  // frame's usage (authoritative vendor accounting) is folded into the synthesis instead of ending
  // the turn as a text completion the client would accept and then wait on.
  let deferredResultDone: Extract<AdapterEvent, { type: "done" }> | undefined;
  let initValidated = false;

  try {
    query = sdk.query({ prompt: projectedPrompt(promptFrames), options: options as unknown as Record<string, unknown> });
    let failClosed = false;
    // Read the stream against the turn's own abort signal instead of trusting the iterator to end.
    // A timeout or a client disconnect has to stop the turn even while the harness keeps talking, and
    // the SDK kills its process when the controller fires — this is what makes that reachable from
    // here rather than only from inside the SDK.
    const iterator = query[Symbol.asyncIterator]();
    const aborted = new Promise<"aborted">(resolve => {
      if (abortController.signal.aborted) {
        resolve("aborted");
        return;
      }
      abortController.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    while (true) {
      const next = await Promise.race([
        iterator.next().then(result => ({ kind: "frame" as const, result })),
        aborted.then(() => ({ kind: "aborted" as const, result: undefined })),
      ]);
      if (next.kind === "aborted") break;
      if (next.result === undefined || next.result.done === true) break;
      const message = next.result.value;
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
          break;
        }
        if (message.type === "system" && message.subtype === "init") initValidated = true;
      }
      const mappedEvents = mapStreamMessageToEvents(message, state);
      if (state.toolCallLimitExceeded) {
        // The parser refuses the start that would pass the ceiling before it allocates the block, so
        // this flag is the only signal that a call was dropped. Without it the turn would run on with
        // the dropped call invisible to the completeness invariants below.
        emitOnce({
          type: "error",
          message: `Claude Agent SDK returned more than the ${Math.min(MAX_TOOL_BLOCK_STARTS, state.maxToolBlockStarts ?? MAX_TOOL_BLOCK_STARTS)}-tool-call turn limit.`,
          status: 502,
          errorType: "upstream_error",
          code: "tool_call_limit",
          retryable: false,
        });
        break;
      }
      if (toolBridge && state.uncapturedToolUse) {
        emitOnce({
          type: "error",
          message: "Claude Agent SDK returned a tool call without a partial tool capture.",
          status: 502,
          errorType: "upstream_error",
          code: "protocol_error",
          retryable: false,
        });
        break;
      }
      for (const event of mappedEvents) {
        if (toolBridge && !initValidated && event.type === "done") {
          emitOnce({
            type: "error",
            message: "Claude Agent SDK ended before the tool bridge init handshake completed.",
            status: 502,
            errorType: "upstream_error",
            code: "tool_bridge_init_missing",
            retryable: false,
          });
          failClosed = true;
          break;
        }
        if (toolBridge && event.type === "tool_call_start") {
          // The catalog is only real once the harness acknowledged the bridge in its init frame; a
          // call that arrives before that means the model acted on a catalog this bridge never
          // validated, so fail closed before the call is counted or renamed.
          if (!initValidated) {
            emitOnce({
              type: "error",
              message: "Claude Agent SDK called a tool before the tool bridge init handshake completed.",
              status: 502,
              errorType: "upstream_error",
              code: "tool_bridge_init_missing",
              retryable: false,
            });
            failClosed = true;
            break;
          }
          const wireName = toolBridge.emittedNameMap.get(event.name);
          if (wireName === undefined) {
            emitOnce({
              type: "error",
              message: "Claude Agent SDK called a tool outside the isolated catalog.",
              status: 502,
              errorType: "upstream_error",
              code: "undeclared_tool_call",
              retryable: false,
            });
            failClosed = true;
            break;
          }
          emitOnce({ ...event, name: wireName });
          continue;
        }
        if (
          toolBridge?.requireToolCall === true
          && !terminalDecided
          && event.type === "done"
          && event.stopReason !== "tool_use"
          && (state.completedToolCalls ?? 0) === 0
        ) {
          // `tool_choice: required|named`: a text-only terminal result must not become a successful
          // completion the client can accept, and the bridge has no way to force the harness either.
          emitOnce({
            type: "error",
            message: "Claude Agent SDK finished without calling the required tool.",
            status: 502,
            errorType: "upstream_error",
            code: "tool_call_required",
            retryable: false,
          });
          failClosed = true;
          break;
        }
        if (
          toolBridge
          && !terminalDecided
          && event.type === "done"
          && (state.toolBlockStarts ?? 0) > 0
          && (state.completedToolCalls ?? 0) !== (state.toolBlockStarts ?? 0)
        ) {
          emitOnce({
            type: "error",
            message: "Claude Agent SDK ended with an incomplete tool call.",
            status: 502,
            errorType: "upstream_error",
            code: "protocol_error",
            retryable: false,
          });
          failClosed = true;
          break;
        }
        if (
          toolBridge
          && !terminalDecided
          && event.type === "done"
          && (state.toolBlockStarts ?? 0) > 0
          && (state.completedToolCalls ?? 0) === (state.toolBlockStarts ?? 0)
        ) {
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
        && !terminalDecided
        && state.sawMessageStop
        && (state.toolBlockStarts ?? 0) > 0
        && (state.completedToolCalls ?? 0) !== (state.toolBlockStarts ?? 0)
      ) {
        emitOnce({
          type: "error",
          message: "Claude Agent SDK ended with an incomplete tool call.",
          status: 502,
          errorType: "upstream_error",
          code: "protocol_error",
          retryable: false,
        });
        break;
      }
      if (toolBridge && !terminalDecided && state.sawMessageStop && (state.completedToolCalls ?? 0) > 0) {
        // The capture handler never answers, so the harness parks after message_stop. The completed
        // tool_use blocks ARE this turn's structured output: end the leg here, let the SDK abort the
        // process, and hand the call to the client, which executes it and continues the conversation.
        const terminalUsage = deferredResultDone?.usage ?? state.partialUsage;
        emitOnce({
          type: "done",
          stopReason: "tool_use",
          endTurn: false,
          ...(terminalUsage ? { usage: terminalUsage } : {}),
        });
        break;
      }
      if (terminalDecided) break;
    }
  } catch (err) {
    streamError = err instanceof Error ? err.message : String(err);
    // A translator-budget overflow is a boundedness verdict with its own code; keep it instead of
    // flattening it into the generic SDK error the rest of this branch reports.
    if (isTranslatorBudgetExceededError(err)) streamProtocolCode = err.code;
  }

  // Release the parser's retained tool identity, argument fragments and per-ID leases on every exit
  // path: terminal frame, fail-closed break, abort, or a budget error thrown mid-stream.
  releaseOpenToolBlocks(state);
  clearTimeout(timeoutTimer);
  incoming.abortSignal?.removeEventListener("abort", onAbort);
  // End the turn from this side: aborting the query stops the harness process (and with it the
  // in-process MCP server), and the wait is bounded so a harness that ignores the abort cannot hold
  // the client's request open.
  abortController.abort();
  // The SDK's teardown waits on its own clock - 2000 ms before it even schedules SIGTERM - while the
  // completion the client sees is gated on the ladder below, which owns the child. Terminating here
  // first keeps the guarantee this file exists for (no answer, and no admitted next turn, underneath
  // a live harness) without billing the client for a clock that is not about the process: the SDK is
  // left to unwind on a process that is already gone.
  const sdkSettle = query?.return !== undefined
    ? query.return(undefined).catch(() => undefined)
    : Promise.resolve();
  let reapTimer: ReturnType<typeof setTimeout> | undefined;
  const settleSdk = async (): Promise<void> => {
    await Promise.race([
      sdkSettle,
      new Promise<void>(resolve => { reapTimer = setTimeout(resolve, reapTimeoutMs); }),
    ]);
    if (reapTimer !== undefined) clearTimeout(reapTimer);
  };
  // The SDK's cleanup waited on its own bounded clock, not on the process: it schedules SIGTERM two
  // seconds out and SIGKILL five seconds after that, with both timers unref'd. The child is
  // terminated here - bounded TERM, grace, KILL, and the process tree where the platform supports
  // one - and the outcome says how far that got. `allExited` is the gate for the scratch cwd: a
  // process that never exited may still be using it, and deleting it underneath one is exactly the
  // premature cleanup this ownership exists to prevent.
  const cleanup = await harness.terminate();
  if (cleanup.allExited) {
    // The harness is gone; nothing of the operator is left in there.
    await (deps.removeScratchDir ?? removeScratchDir)(scratchDir).catch(() => undefined);
  }
  if (!cleanup.confirmed || cleanup.overCapacity) {
    // Never silently: an unresolved teardown is the one state a caller cannot see for itself.
    const survivors = cleanup.unresolved
      .map(entry => `${entry.pid ?? "?"}:${entry.reason}${entry.signalFailed ? ":signal-refused" : ""}`)
      .join(", ");
    console.warn(
      "opencodex: claude-agent-sdk harness cleanup unconfirmed ("
      + (survivors.length > 0 ? survivors : "no child named")
      + (cleanup.overCapacity ? ", cleanup lease unavailable" : "")
      + `; ${cleanup.quarantined} quarantined`
      + `); ${cleanup.allExited ? "the scratch cwd was released" : `leaving ${scratchDir} in place`}`,
    );
  }

  // A turn that still owns a process it could not take down has no success to hand over: the client
  // would read the answer as the turn's whole outcome while the harness behind it outlives the turn,
  // and a client that cancels repeats that without ever seeing why. A teardown outside the bounded
  // accounting is the same state - unaccounted, therefore not reported as clean.
  const ownsUnfinishedTeardown = !cleanup.allExited || cleanup.overCapacity;
  const deliverTerminal = (): void => {
    if (pendingTerminal === undefined) return;
    if (pendingTerminal.type === "done" && ownsUnfinishedTeardown) {
      const named = cleanup.unresolved.length > 0
        ? cleanup.unresolved.map(entry => `${entry.pid ?? "?"}:${entry.reason}`).join(", ")
        : "cleanup capacity";
      emit({
        type: "error",
        message:
          `Claude Agent SDK turn ended with a harness process this server still owns (${named}); `
          + "the answer is withheld rather than reported as a completed turn.",
        status: 502,
        errorType: "upstream_error",
        code: "harness_teardown_unresolved",
        retryable: false,
      });
      return;
    }
    emit(pendingTerminal);
  };

  if (terminalDecided) {
    deliverTerminal();
    await settleSdk();
    return;
  }
  const harnessStderr = boundedStderr(stderrChunks);
  const stderr = redactSecrets(harnessStderr, profile.tokenEnv, apiKey);
  if (incoming.abortSignal?.aborted) {
    emitOnce({ type: "error", message: `${profile.label} turn was aborted.`, retryable: false });
  } else if (streamError !== undefined) {
    // An exit error used to arrive with the SDK's own stderr tail, and only the SDK local spawn this
    // adapter replaced ever filled that tail. The harness's stderr reaches this turn through its own
    // sink now, so the one message that reports a dead harness keeps the evidence instead of losing it.
    const message = harnessStderr.length > 0 && !streamError.includes(harnessStderr)
      ? `${streamError}: ${harnessStderr}`
      : streamError;
    emitOnce({
      type: "error",
      message: redactSecrets(message, profile.tokenEnv, apiKey),
      status: 502,
      errorType: "upstream_error",
      code: streamProtocolCode ?? "claude_agent_sdk_error",
      retryable: false,
    });
  } else if (toolBridge && deferredResultDone !== undefined && !state.sawMessageStop) {
    emitOnce({
      type: "error",
      message: "Claude Agent SDK delivered a terminal result before message_stop on a tool-bridge turn.",
      status: 502,
      errorType: "upstream_error",
      code: "protocol_error",
      retryable: false,
    });
  } else if (!state.sawTerminalResult) {
    emitOnce({
      type: "error",
      message: stderr
        ? `${profile.label} turn ended without a terminal result frame: ${stderr}`
        : `${profile.label} turn ended without a terminal result frame`,
      status: 502,
      errorType: "upstream_error",
      code: "protocol_error",
      retryable: false,
    });
  }
  // The one terminal frame this turn owes the client, delivered only now that the harness behind it
  // is gone. The bridge closes the response body on this frame and that EOF releases the global
  // turn-admission lease, so a frame emitted earlier would let the next turn start while a
  // TERM-resistant harness is still being reaped.
  deliverTerminal();
  // Bounded, and no longer on the client's clock: the SDK's generator unwinds on its own terms after
  // the answer, and nothing of the turn is waiting on it but this line.
  await settleSdk();
}
