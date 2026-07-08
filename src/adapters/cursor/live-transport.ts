import http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { namespacedToolName, type OcxProviderConfig, type OcxUsage } from "../../types";
import { CONNECT_FLAG_END_STREAM, decodeAvailableConnectFrames, encodeConnectFrame } from "./framing";
import { activePromptText, encodeCursorRunRequest } from "./protobuf-request";
import { createCursorProtobufEventState, finalizeTurnEvents, mapCursorProtobufServerMessage, mapSyntheticMcpExecToToolEvents } from "./protobuf-events";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  AskQuestionInteractionResponseSchema,
  AskQuestionRejectedSchema,
  AskQuestionResultSchema,
  ClientHeartbeatSchema,
  CreatePlanRequestResponseSchema,
  CreatePlanResultSchema,
  CreatePlanSuccessSchema,
  ExaFetchRequestResponseSchema,
  ExaFetchRequestResponse_RejectedSchema,
  ExaSearchRequestResponseSchema,
  ExaSearchRequestResponse_RejectedSchema,
  InteractionResponseSchema,
  SetupVmEnvironmentResultSchema,
  SetupVmEnvironmentSuccessSchema,
  SwitchModeRequestResponseSchema,
  SwitchModeRequestResponse_RejectedSchema,
  WebSearchRequestResponseSchema,
  WebSearchRequestResponse_RejectedSchema,
  type AgentServerMessage,
  type ExecServerMessage,
  type InteractionQuery,
  type InteractionResponse,
} from "./gen/agent_pb";
import { debugProviderDiagnostic } from "../../lib/debug";
import { classifyCursorError, isCursorBenignCancelError, safeCursorErrorMessage } from "./cursor-errors";
import { mcpArgsFromToolCall } from "./protobuf-events";
import { OCX_RESPONSES_TOOL_PROVIDER } from "./tool-definitions";
import { cursorUnsafeNativeLocalExecEnabled, handleCursorNativeExec, handleCursorNativeKv, type CursorNativeExecContext } from "./native-exec";
import { resolveMcpServers } from "./mcp-config";
import { CursorMcpManager } from "./mcp-manager";
import { buildMcpToolDefinitions, mcpDepsFromManager } from "./native-exec-mcp";
import { desktopDepsFromConfig } from "./native-exec-desktop";
import {
  buildCursorToolDefinitions,
  cursorRequestAdvertisesApplyPatch,
  cursorRequestHasShellAlias,
  cursorToolInputSchema,
  cursorToolWireName,
  cursorToolsForActivePrompt,
  isGenericToolUseCountDemoPrompt,
  requestedCursorToolUseCount,
} from "./tool-definitions";
import type { CursorNativeToolDeps } from "./native-exec-tools";
import type { CursorClientMessage, CursorRunRequest, CursorServerMessage } from "./types";
import type { CursorTransport, CursorTransportFactoryInput } from "./transport";

const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";
const CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";
const HEARTBEAT_MS = 5_000;
const CURSOR_FIRST_FRAME_TIMEOUT_MS = 30_000;
const CLIENT_TOOL_FINALIZE_GRACE_MS = 50;
const GENERIC_TOOL_COUNT_MIN_FINALIZE_GRACE_MS = 750;
const GENERIC_TOOL_COUNT_MAX_FINALIZE_GRACE_MS = 1_800;
const GENERIC_TOOL_COUNT_PER_TOOL_GRACE_MS = 125;

export class CursorMissingCredentialError extends Error {
  readonly code = "cursor_missing_credential";

  constructor() {
    super("Cursor live transport requires a Cursor access token in provider.apiKey, Authorization, or OPENCODEX_CURSOR_TEST_TOKEN.");
    this.name = "CursorMissingCredentialError";
  }
}

export function resolveCursorToken(provider: OcxProviderConfig, headers?: Headers): string {
  const providerKey = provider.apiKey?.trim();
  if (providerKey) return providerKey;

  const forwarded = headers?.get("authorization") ?? headers?.get("Authorization");
  if (forwarded?.toLowerCase().startsWith("bearer ")) return forwarded.slice("bearer ".length).trim();

  const envToken = process.env.OPENCODEX_CURSOR_TEST_TOKEN?.trim();
  if (envToken) return envToken;
  throw new CursorMissingCredentialError();
}

/**
 * Classify a Connect end-stream (trailer) frame. Cursor terminates EVERY stream with this
 * frame; success is signalled by the ABSENCE of an `error` field (typically `{}`), not by the
 * absence of the frame. Returns null on success, an Error only on a real Connect error.
 * Mirrors jawcode `parseConnectEndStream` (see devlog 350.98). Exported for unit testing.
 */
export function parseConnectEndStreamError(payload: Uint8Array): Error | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as { error?: { code?: string; message?: string } };
    if (parsed?.error) {
      return new Error(`Cursor Connect error ${parsed.error.code ?? "unknown"}: ${parsed.error.message ?? "Unknown error"}`);
    }
    return null;
  } catch {
    return new Error("Cursor Connect end-stream error");
  }
}

function encodeClientMessage(message: Parameters<typeof create<typeof AgentClientMessageSchema>>[1]): Uint8Array {
  return encodeConnectFrame(toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, message)));
}

/**
 * Decide how to handle an `execServerMessage.mcpArgs` frame for a client (Responses-provider) tool.
 *
 * A stateless Responses proxy cannot send Cursor a real `mcpResult` later (Cursor's MCP exec is
 * synchronous on the live h2 stream; there is no deferred-result signal). So when Cursor asks us to
 * run a client Responses tool we must:
 *   1. surface the tool call to Codex (tool_call_start/delta/end),
 *   2. deliberately END turn 1 as `done`/completed — Cursor will never send `turnEnded` because it
 *      is waiting for an `mcpResult` that never comes, so relying on the stall watchdog would make
 *      turn 1 `response.incomplete` and drop the conversation id (continuation dies at step 1), and
 *   3. cancel the Cursor run WITHOUT writing any fake `mcpResult`.
 * The real tool result arrives on the NEXT /v1/responses request as structured history.
 *
 * Pure (no I/O) so the decision is unit-testable. `handleServerMessage` performs the side effects.
 */
export interface McpArgsPlan {
  handledByResponsesBridge: boolean;
  events: CursorServerMessage[];
  cancelCursorRun: boolean;
  /**
   * The Responses bridge owns this exec and every known client tool call is committed, but turn 1 is
   * NOT ended synchronously: a sibling call may still be announced in a later receive chunk. The
   * transport arms a revocable grace timer and only ends the turn (see finalizeAfterDrain) if the set
   * is still drained when it fires.
   */
  finalizeWhenDrained: boolean;
  writeMcpResult?: never;
}

export function planMcpArgsHandling(
  execMsg: ExecServerMessage,
  state: ReturnType<typeof createCursorProtobufEventState>,
): McpArgsPlan {
  if (execMsg.message.case !== "mcpArgs") {
    return { handledByResponsesBridge: false, events: [], cancelCursorRun: false, finalizeWhenDrained: false };
  }
  const args = execMsg.message.value;
  if (args.providerIdentifier !== OCX_RESPONSES_TOOL_PROVIDER) {
    // A real MCP server tool: native exec handles it (executed locally, real mcpResult written).
    return { handledByResponsesBridge: false, events: [], cancelCursorRun: false, finalizeWhenDrained: false };
  }

  // From here on the Responses bridge owns the exec: never fall through to native exec, which would
  // send Cursor a bogus "bridge suspension not implemented" mcpResult error.
  const toolEvents = mapSyntheticMcpExecToToolEvents(args, `exec_${execMsg.id}`, {
    allowEmptyArgs: true,
    state,
  });

  if (toolEvents.some(event => event.type === "error")) {
    // The error is itself the terminal signal; do not also emit `done`.
    return { handledByResponsesBridge: true, events: toolEvents, cancelCursorRun: true, finalizeWhenDrained: false };
  }

  // Parallel safety ("tool use N"): Cursor sends one exec mcpArgs per client tool call. An empty
  // openToolCalls set proves only that every KNOWN call is committed, not that Cursor has finished
  // announcing siblings — a sibling's toolCallStarted can still arrive in a later receive chunk. So
  // never end turn 1 synchronously here: surface this call's events, and when the set is drained flag
  // finalizeWhenDrained so the transport arms a revocable grace timer (finalizeAfterDrain re-checks
  // the guard when it fires). While siblings are still open, just keep the stream open.
  return {
    handledByResponsesBridge: true,
    events: toolEvents,
    cancelCursorRun: false,
    finalizeWhenDrained: state.openToolCalls.size === 0,
  };
}

/**
 * Build the `interactionResponse` reply for a server `interactionQuery`. Cursor's server-side agent
 * BLOCKS on these queries until the client answers (matching `id`); an unanswered query is the
 * proven cause of the heartbeat-only stall → watchdog `upstream_stall_timeout` → upstream 502 loop
 * (devlog 260702_cursor-live-stability-rca). ocx is a headless non-interactive client, so:
 *   - createPlan: acknowledge success (the agent proceeds to execute); the plan text is surfaced to
 *     Codex as visible output so the user still sees it.
 *   - askQuestion: reject with a reason — the agent must proceed autonomously; there is no human to
 *     answer mid-turn. (Future: bridge to a Codex user-input request.)
 *   - switchMode / webSearch / exaSearch / exaFetch: reject (deterministic default; web search has
 *     its own sidecar path outside this transport).
 *   - setupVmEnvironment: the result schema has no error case — reply success so the agent is not
 *     left waiting; the command itself was never run locally.
 * Pure (no I/O) for unit testing; `handleServerMessage` writes the frame and emits liveness.
 */
export function planInteractionQueryReply(query: InteractionQuery): { response: InteractionResponse; replyCase: string; planText?: string } {
  const NON_INTERACTIVE_REASON = "opencodex bridge is non-interactive; proceed without this interaction.";
  const q = query.query;
  const respond = (result: InteractionResponse["result"]): InteractionResponse =>
    create(InteractionResponseSchema, { id: query.id, result });

  if (q.case === "createPlanRequestQuery") {
    const args = q.value.args;
    const parts = [
      args?.name ? `Plan: ${args.name}` : undefined,
      args?.overview?.trim() ? args.overview.trim() : undefined,
      args?.plan?.trim() ? args.plan.trim() : undefined,
    ].filter((part): part is string => typeof part === "string" && part.length > 0);
    return {
      response: respond({
        case: "createPlanRequestResponse",
        value: create(CreatePlanRequestResponseSchema, {
          result: create(CreatePlanResultSchema, { result: { case: "success", value: create(CreatePlanSuccessSchema, {}) } }),
        }),
      }),
      replyCase: "createPlanRequestResponse:success",
      planText: parts.length > 0 ? `${parts.join("\n\n")}\n` : undefined,
    };
  }
  if (q.case === "askQuestionInteractionQuery") {
    return {
      response: respond({
        case: "askQuestionInteractionResponse",
        value: create(AskQuestionInteractionResponseSchema, {
          result: create(AskQuestionResultSchema, {
            result: { case: "rejected", value: create(AskQuestionRejectedSchema, { reason: NON_INTERACTIVE_REASON }) },
          }),
        }),
      }),
      replyCase: "askQuestionInteractionResponse:rejected",
    };
  }
  if (q.case === "switchModeRequestQuery") {
    return {
      response: respond({
        case: "switchModeRequestResponse",
        value: create(SwitchModeRequestResponseSchema, {
          result: { case: "rejected", value: create(SwitchModeRequestResponse_RejectedSchema, { reason: NON_INTERACTIVE_REASON }) },
        }),
      }),
      replyCase: "switchModeRequestResponse:rejected",
    };
  }
  if (q.case === "webSearchRequestQuery") {
    return {
      response: respond({
        case: "webSearchRequestResponse",
        value: create(WebSearchRequestResponseSchema, {
          result: { case: "rejected", value: create(WebSearchRequestResponse_RejectedSchema, { reason: NON_INTERACTIVE_REASON }) },
        }),
      }),
      replyCase: "webSearchRequestResponse:rejected",
    };
  }
  if (q.case === "exaSearchRequestQuery") {
    return {
      response: respond({
        case: "exaSearchRequestResponse",
        value: create(ExaSearchRequestResponseSchema, {
          result: { case: "rejected", value: create(ExaSearchRequestResponse_RejectedSchema, { reason: NON_INTERACTIVE_REASON }) },
        }),
      }),
      replyCase: "exaSearchRequestResponse:rejected",
    };
  }
  if (q.case === "exaFetchRequestQuery") {
    return {
      response: respond({
        case: "exaFetchRequestResponse",
        value: create(ExaFetchRequestResponseSchema, {
          result: { case: "rejected", value: create(ExaFetchRequestResponse_RejectedSchema, { reason: NON_INTERACTIVE_REASON }) },
        }),
      }),
      replyCase: "exaFetchRequestResponse:rejected",
    };
  }
  if (q.case === "setupVmEnvironmentArgs") {
    return {
      response: respond({
        case: "setupVmEnvironmentResult",
        value: create(SetupVmEnvironmentResultSchema, {
          result: { case: "success", value: create(SetupVmEnvironmentSuccessSchema, {}) },
        }),
      }),
      replyCase: "setupVmEnvironmentResult:success",
    };
  }
  // Unknown/future query case: an empty response still unblocks the matching id.
  return { response: respond({ case: undefined, value: undefined } as InteractionResponse["result"]), replyCase: "empty" };
}

/**
 * Re-check the drain guard at grace-timer fire time and finalize turn 1 only if still drained. A
 * sibling client tool call announced after the timer was armed reopens `openToolCalls`, so this
 * returns `[]` (the pending finalize is revoked); a later drain re-arms it. Pure for unit testing.
 */
export function finalizeAfterDrain(state: ReturnType<typeof createCursorProtobufEventState>): CursorServerMessage[] {
  if (state.terminated) return [];
  if (state.openToolCalls.size > 0) return [];
  return finalizeTurnEvents(state);
}

export function clientToolFinalizeGraceMsForRequest(request: CursorRunRequest, baseGraceMs = CLIENT_TOOL_FINALIZE_GRACE_MS): number {
  if (request.rawMessages?.at(-1)?.role === "toolResult") return baseGraceMs;
  const text = activePromptText(request);
  if (!cursorRequestHasShellAlias(request.tools) || !isGenericToolUseCountDemoPrompt(text)) return baseGraceMs;
  const requestedCount = requestedCursorToolUseCount(text);
  const expandedGraceMs = requestedCount
    ? Math.min(
        GENERIC_TOOL_COUNT_MAX_FINALIZE_GRACE_MS,
        Math.max(GENERIC_TOOL_COUNT_MIN_FINALIZE_GRACE_MS, requestedCount * GENERIC_TOOL_COUNT_PER_TOOL_GRACE_MS),
      )
    : GENERIC_TOOL_COUNT_MIN_FINALIZE_GRACE_MS;
  return Math.max(baseGraceMs, expandedGraceMs);
}

class LiveCursorTransport implements CursorTransport {
  private session?: http2.ClientHttp2Session;
  private stream?: http2.ClientHttp2Stream;
  private heartbeat?: ReturnType<typeof setInterval>;
  private firstFrameTimer?: ReturnType<typeof setTimeout>;
  private committed = false;
  private expectedClose = false;
  private pendingFinalize?: ReturnType<typeof setTimeout>;
  private readonly clientToolFinalizeGraceMs: number;
  private activeClientToolFinalizeGraceMs: number;
  private readonly token: string;
  private readonly mcpManager?: CursorMcpManager;
  private readonly desktopDeps: CursorNativeToolDeps;
  private execContext: CursorNativeExecContext = {};
  private mcpPrepared?: Promise<void>;
  // Per-turn diagnostic counters/timestamps when provider debug is on (`ocx debug provider on`). Stamped in open(), cleared on
  // close; safe to read after a stream failure because open() owns the only writer before run().
  private turnStartedAt = 0;
  private framesReceived = 0;
  private firstFrameAt?: number;
  private firstFrameLogged = false;

  constructor(private readonly input: CursorTransportFactoryInput) {
    this.token = resolveCursorToken(input.provider, input.headers);
    // Grace window before a drained client-tool turn is finalized. Small enough not to look like a
    // stall, large enough to catch a sibling tool call announced in the next receive chunk. Injectable
    // so the transport-level race test can drive it deterministically.
    this.clientToolFinalizeGraceMs = input.clientToolFinalizeGraceMs ?? CLIENT_TOOL_FINALIZE_GRACE_MS;
    this.activeClientToolFinalizeGraceMs = this.clientToolFinalizeGraceMs;
    // Desktop (computer-use / record-screen) executors are available even with no MCP servers.
    this.desktopDeps = desktopDepsFromConfig(input.provider.desktopExecutor);
    this.execContext = { ...this.desktopDeps, unsafeAllowNativeLocalExec: cursorUnsafeNativeLocalExecEnabled(input.provider) };
    const servers = resolveMcpServers(input.provider);
    if (servers.length > 0) {
      this.mcpManager = new CursorMcpManager(servers, {
        log: message => console.warn(message),
      });
    }
  }

  /**
   * Connect MCP servers and compute the tool definitions advertised to the Cursor server.
   * MUST complete before the first `requestContextArgs` (the server only calls MCP tools it was
   * told about), so `run()` awaits this before opening the stream. Best-effort: any failure
   * leaves an empty tool list and MCP disabled for the stream, never blocking the conversation.
   */
  private prepareMcp(): Promise<void> {
    if (!this.mcpManager) return Promise.resolve();
    if (!this.mcpPrepared) {
      this.mcpPrepared = (async () => {
        try {
          const mcpToolDefs = await buildMcpToolDefinitions(this.mcpManager!);
          this.execContext = {
            ...this.desktopDeps,
            ...mcpDepsFromManager(this.mcpManager!),
            mcpToolDefs,
            unsafeAllowNativeLocalExec: cursorUnsafeNativeLocalExecEnabled(this.input.provider),
          };
        } catch (err) {
          console.warn(`[cursor-mcp] preparation failed, MCP disabled for this stream: ${err instanceof Error ? err.message : String(err)}`);
          this.execContext = { ...this.desktopDeps, unsafeAllowNativeLocalExec: cursorUnsafeNativeLocalExecEnabled(this.input.provider) };
        }
      })();
    }
    return this.mcpPrepared;
  }

  toJSON(): Record<string, string> {
    return { type: "LiveCursorTransport", credential: "redacted" };
  }

  async *run(request: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorServerMessage> {
    const queue: CursorServerMessage[] = [];
    let notify: (() => void) | undefined;
    let done = false;
    let failure: Error | undefined;
    let state = createCursorProtobufEventState();
    let failureLogged = false;
    // One per-turn summary of the failure path (end-stream error, socket reset, abort) so the
    // operator can see how far the turn got and how it was classified without re-scanning every
    // frame. Gated behind provider debug (`ocx debug provider on`).
    const summarizeFailure = (err: Error): Error => {
      if (!failureLogged && !isCursorBenignCancelError(err)) {
        failureLogged = true;
        debugProviderDiagnostic("cursor", "turn-failed", {
          committed: this.committed,
          framesReceived: this.framesReceived,
          outputTokens: state.usage.outputTokens,
          contextTokens: state.contextTokens,
          firstFrameMs: this.firstFrameAt ? this.firstFrameAt - this.turnStartedAt : undefined,
          elapsedMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : undefined,
          classified: classifyCursorError(err.message),
          errorCode: (err as { code?: unknown }).code ?? undefined,
          message: redactCursorForLog(err.message),
        });
      }
      return err;
    };
    const wake = () => {
      const fn = notify;
      notify = undefined;
      fn?.();
    };

    const push = (message: CursorServerMessage) => {
      queue.push(message);
      wake();
    };

    // Advertise MCP tools before the stream opens — the server only calls tools it was told about.
    await this.prepareMcp();
    const activeText = activePromptText(request);
    this.activeClientToolFinalizeGraceMs = clientToolFinalizeGraceMsForRequest(request, this.clientToolFinalizeGraceMs);
    const cursorVisibleTools = cursorToolsForActivePrompt(request.tools, activeText, request.toolChoice);
    const clientToolDefs = buildCursorToolDefinitions(cursorVisibleTools, request.toolChoice);
    this.execContext = {
      ...this.execContext,
      clientToolDefs,
      rejectNativeFileMutations: cursorRequestAdvertisesApplyPatch(request.tools, request.toolChoice),
    };
    const toolSchemas = new Map<string, unknown>();
    const cursorToolNameMap = new Map<string, string>();
    for (const tool of cursorVisibleTools ?? []) {
      const cursorWireName = cursorToolWireName(tool);
      toolSchemas.set(cursorWireName, cursorToolInputSchema(tool));
      cursorToolNameMap.set(cursorWireName, namespacedToolName(tool.namespace, tool.name));
    }
    state = createCursorProtobufEventState({
      clientToolNames: clientToolDefs.map(tool => tool.toolName || tool.name),
      parallelToolCalls: request.parallelToolCalls,
      toolSchemas,
      cursorToolNameMap,
    });

    this.open(request, signal, state, push, err => {
      failure = err;
      wake();
    }, () => {
      done = true;
      wake();
    });

    while (!done || queue.length > 0) {
      while (queue.length > 0) {
        const message = queue.shift();
        if (message) yield message;
      }
      if (failure) {
        if (isCursorBenignCancelError(failure)) return;
        throw attachPartialUsage(summarizeFailure(failure), state);
      }
      if (done) break;
      await new Promise<void>(resolve => {
        notify = resolve;
      });
    }
    if (failure) {
      if (isCursorBenignCancelError(failure)) return;
      throw attachPartialUsage(summarizeFailure(failure), state);
    }
  }

  writeClient(_message: CursorClientMessage): void {}

  requestCommitted(): boolean {
    return this.committed;
  }

  private clearFirstFrameTimer(): void {
    if (this.firstFrameTimer) {
      clearTimeout(this.firstFrameTimer);
      this.firstFrameTimer = undefined;
    }
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.clearPendingFinalize();
    this.clearFirstFrameTimer();
    this.stream?.close();
    this.session?.close();
    void this.mcpManager?.dispose();
  }

  private cancelCursorRun(): void {
    this.expectedClose = true;
    this.clearPendingFinalize();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.clearFirstFrameTimer();
    try {
      this.stream?.close(http2.constants.NGHTTP2_CANCEL);
    } catch {
      this.stream?.destroy();
    }
    this.session?.close();
    void this.mcpManager?.dispose();
  }

  private clearPendingFinalize(): void {
    if (this.pendingFinalize) {
      clearTimeout(this.pendingFinalize);
      this.pendingFinalize = undefined;
    }
  }

  /**
   * Any frame that records or commits a client tool call revokes a pending finalize: the call set is
   * about to change, so the drain that armed the timer is no longer authoritative. The timer re-arms
   * when the set drains again (see scheduleClientToolFinalize).
   */
  private noteClientToolActivity(): void {
    this.clearPendingFinalize();
  }

  /**
   * Arm the revocable grace timer that ends a drained client-tool turn. On fire it re-checks the
   * drain guard (finalizeAfterDrain): a sibling announced during the window reopened the set, so it
   * emits nothing and waits for the next drain; otherwise it pushes the terminal `done` and cancels
   * the Cursor run with RST_STREAM. No fake mcpResult is ever written.
   */
  private scheduleClientToolFinalize(
    state: ReturnType<typeof createCursorProtobufEventState>,
    push: (message: CursorServerMessage) => void,
  ): void {
    this.clearPendingFinalize();
    this.pendingFinalize = setTimeout(() => {
      this.pendingFinalize = undefined;
      if (this.expectedClose) return;
      const terminal = finalizeAfterDrain(state);
      if (terminal.length === 0) return;
      for (const event of terminal) push(event);
      debugProviderDiagnostic("cursor", "client-tool-suspend", {
        reason: "Responses bridge owns client tools; ending turn without fake mcpResult",
        framesReceived: this.framesReceived,
        elapsedMs: Date.now() - this.turnStartedAt,
      });
      this.cancelCursorRun();
    }, this.activeClientToolFinalizeGraceMs);
  }

  private open(
    request: CursorRunRequest,
    signal: AbortSignal | undefined,
    state: ReturnType<typeof createCursorProtobufEventState>,
    push: (message: CursorServerMessage) => void,
    fail: (error: Error) => void,
    finish: () => void,
  ): void {
    this.turnStartedAt = Date.now();
    this.framesReceived = 0;
    this.firstFrameAt = undefined;
    this.firstFrameLogged = false;
    const dialHost = cursorHostLabel(this.input.provider.baseUrl || "https://api2.cursor.sh");
    debugProviderDiagnostic("cursor", "dial", { host: dialHost });
    this.session = http2.connect(this.input.provider.baseUrl || "https://api2.cursor.sh");
    // The run request is buffered until the HTTP/2 session connects. Failures before `connect`
    // (DNS, ECONNREFUSED, TLS, connect timeout) mean the server never received the request, so they
    // are safe to retry. Once connected, bytes flush to the server and the turn must not be replayed.
    this.session.on("connect", () => {
      this.committed = true;
      debugProviderDiagnostic("cursor", "connected", { connectMs: Date.now() - this.turnStartedAt });
    });
    this.stream = this.session.request({
      ":method": "POST",
      ":path": CURSOR_RUN_PATH,
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      te: "trailers",
      authorization: `Bearer ${this.token}`,
      "x-ghost-mode": "true",
      "x-cursor-client-version": CURSOR_CLIENT_VERSION,
      "x-cursor-client-type": "cli",
      "x-request-id": crypto.randomUUID(),
    });

    // Single owner of the pre-first-frame deadline. Cleared by the first server frame/end-stream and
    // by every terminal path (trailers, error, end, abort, close) so it can never leak.
    const failAndClear = (error: Error) => {
      this.clearFirstFrameTimer();
      if (this.expectedClose) {
        // We already emitted a terminal `done` and cancelled the run (client-tool suspension). The
        // RST_STREAM CANCEL surfaces here as a stream error/abort; it is expected, not a failure.
        debugProviderDiagnostic("cursor", "stream-cancel-expected", {
          code: (error as { code?: unknown }).code,
          message: redactCursorForLog(error.message),
          framesReceived: this.framesReceived,
          elapsedMs: Date.now() - this.turnStartedAt,
        });
        finish();
        return;
      }
      fail(error);
    };
    const session = this.session;
    const stream = this.stream;
    this.firstFrameTimer = setTimeout(() => {
      this.firstFrameTimer = undefined;
      debugProviderDiagnostic("cursor", "first-frame-timeout", { timeoutMs: this.input.firstFrameTimeoutMs ?? CURSOR_FIRST_FRAME_TIMEOUT_MS });
      try { stream.close(); } catch { /* already closing */ }
      try { session.close(); } catch { /* already closing */ }
      fail(new Error("Cursor transport timed out before first response"));
    }, this.input.firstFrameTimeoutMs ?? CURSOR_FIRST_FRAME_TIMEOUT_MS);

    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
    this.stream.on("data", chunk => {
      this.clearFirstFrameTimer();
      if (!this.firstFrameLogged) {
        this.firstFrameLogged = true;
        this.firstFrameAt = Date.now();
        debugProviderDiagnostic("cursor", "first-frame", { latencyMs: this.firstFrameAt - this.turnStartedAt });
      }
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      pending = concatBytes(pending, bytes);
      try {
        const decoded = decodeAvailableConnectFrames(pending);
        pending = decoded.remainder;
        const frames = decoded.frames;
        for (const frame of frames) {
          this.framesReceived++;
          if ((frame.flags & CONNECT_FLAG_END_STREAM) === CONNECT_FLAG_END_STREAM) {
            const endError = parseConnectEndStreamError(frame.payload);
            debugProviderDiagnostic("cursor", "connect-end-stream", endError ? {
              code: cursorConnectErrorCode(frame.payload),
              message: redactCursorForLog(endError.message),
              classified: classifyCursorError(endError.message),
              framesReceived: this.framesReceived,
              elapsedMs: Date.now() - this.turnStartedAt,
            } : { framesReceived: this.framesReceived, elapsedMs: Date.now() - this.turnStartedAt });
            if (endError) failAndClear(endError);
            continue;
          }
          void this.handleServerMessage(fromBinary(AgentServerMessageSchema, frame.payload), state, push).catch(err => {
            failAndClear(err instanceof Error ? err : new Error(String(err)));
          });
        }
      } catch (err) {
        failAndClear(err instanceof Error ? err : new Error(String(err)));
      }
    });
    this.stream.on("trailers", trailers => {
      const status = trailers["grpc-status"];
      if (status !== undefined) debugProviderDiagnostic("cursor", "trailers", { grpcStatus: String(status) });
      if (status && status !== "0") failAndClear(new Error(`Cursor gRPC error ${status}`));
    });
    this.stream.on("error", err => {
      const realErr = err instanceof Error ? err : new Error(String(err));
      if (this.expectedClose) {
        failAndClear(realErr);
        return;
      }
      const code = (realErr as { code?: unknown }).code;
      const errno = (realErr as { errno?: unknown }).errno;
      debugProviderDiagnostic("cursor", "stream-error", {
        code: typeof code === "string" || typeof code === "number" ? String(code) : undefined,
        errno: typeof errno === "string" || typeof errno === "number" ? String(errno) : undefined,
        name: realErr.name,
        message: redactCursorForLog(realErr.message),
        committed: this.committed,
        framesReceived: this.framesReceived,
        elapsedMs: Date.now() - this.turnStartedAt,
      });
      failAndClear(realErr);
    });
    this.stream.on("end", () => {
      this.clearFirstFrameTimer();
      debugProviderDiagnostic("cursor", "stream-end", {
        committed: this.committed,
        framesReceived: this.framesReceived,
        expectedClose: this.expectedClose,
        elapsedMs: Date.now() - this.turnStartedAt,
      });
      finish();
    });

    signal?.addEventListener("abort", () => {
      this.close();
      failAndClear(new Error("Cursor request was aborted"));
    }, { once: true });

    this.stream.write(encodeConnectFrame(encodeCursorRunRequest(request)));
    this.heartbeat = setInterval(() => {
      this.stream?.write(encodeClientMessage({
        message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
      }));
    }, HEARTBEAT_MS);
  }

  private async handleServerMessage(
    message: AgentServerMessage,
    state: ReturnType<typeof createCursorProtobufEventState>,
    push: (message: CursorServerMessage) => void,
  ): Promise<void> {
    if (!this.stream) return;
    debugProviderDiagnostic("cursor", "frame", describeCursorServerFrame(message));
    if (message.message.case === "kvServerMessage") {
      this.stream.write(encodeConnectFrame(handleCursorNativeKv(message.message.value)));
      return;
    }
    if (message.message.case === "execServerMessage") {
      const execMsg = message.message.value;
      if (execMsg.message.case === "mcpArgs") {
        const plan = planMcpArgsHandling(execMsg, state);
        if (plan.handledByResponsesBridge) {
          this.noteClientToolActivity();
          for (const event of plan.events) push(event);
          if (plan.cancelCursorRun) this.cancelCursorRun();
          else if (plan.finalizeWhenDrained) this.scheduleClientToolFinalize(state, push);
          return;
        }
      }
      const replies = await handleCursorNativeExec(message.message.value, this.execContext);
      for (const reply of replies) this.stream.write(encodeConnectFrame(reply));
      return;
    }
    if (message.message.case === "interactionQuery") {
      // The server-side agent BLOCKS until this query is answered with the matching id; leaving it
      // unanswered is the proven stall → watchdog → upstream-502 mechanism. Reply immediately with
      // the non-interactive default and emit liveness so the bridge watchdog sees progress.
      const query = message.message.value;
      const plan = planInteractionQueryReply(query);
      debugProviderDiagnostic("cursor", "interaction-query", { id: query.id, queryCase: query.query.case ?? "unknown", reply: plan.replyCase });
      this.stream.write(encodeClientMessage({ message: { case: "interactionResponse", value: plan.response } }));
      if (!state.terminated) {
        if (plan.planText) push({ type: "text", text: plan.planText });
        push({ type: "heartbeat" });
      }
      return;
    }
    const mapped = mapCursorProtobufServerMessage(message, state);
    if (mapped.length > 0) {
      // A client tool call announced/committed via interactionUpdate (toolCallStarted/partialToolCall/
      // toolCallCompleted) changes the call set, so revoke any finalize armed by an earlier drain.
      if (isClientToolFrame(message)) this.noteClientToolActivity();
      for (const event of mapped) push(event);
      return;
    }
    // The frame produced no outward Responses event (e.g. toolCallStarted / partialToolCall args
    // buffering, toolCallDelta, tokenDelta, or a checkpoint update). Tool-call protocol events are
    // deferred to completion for atomic, parallel-safe emission, so a turn that silently assembles
    // several tool calls can otherwise exceed the bridge's stall watchdog (upstream_stall_timeout).
    // Emit a liveness heartbeat for these progress frames so the watchdog sees the upstream is alive.
    // Never after a terminal (done/truncation): a stray post-terminal frame must stay fully inert.
    if (!state.terminated && isCursorProgressFrame(message)) {
      if (isClientToolFrame(message)) this.noteClientToolActivity();
      push({ type: "heartbeat" });
    }
  }
}

/**
 * Build the best-effort partial usage for a turn that failed before a clean `done` (upstream 502,
 * stream error, abort). Mirrors the clean-finalize math in `finalizeTurnEvents`: the last absolute
 * checkpoint (`contextTokens`) is the cumulative context, the streamed delta stays in outputTokens.
 * Returns undefined when the stream died before ANY token signal (nothing meaningful to report).
 * Exported for unit testing.
 */
export function partialUsageFromEventState(state: ReturnType<typeof createCursorProtobufEventState>): OcxUsage | undefined {
  const out = state.usage.outputTokens;
  const ctx = state.contextTokens;
  if (ctx === undefined && out <= 0) return undefined;
  return ctx !== undefined
    ? { ...state.usage, inputTokens: Math.max(0, ctx - out), totalTokens: ctx, estimated: true }
    : { ...state.usage, estimated: true };
}

/**
 * Attach partial usage to a transport failure so the adapter's error path can surface real token
 * consumption for 502/stall rows instead of `usageStatus: unreported` with 0 tokens.
 */
function attachPartialUsage(failure: Error, state: ReturnType<typeof createCursorProtobufEventState>): Error {
  const usage = partialUsageFromEventState(state);
  if (usage) (failure as Error & { partialUsage?: OcxUsage }).partialUsage = usage;
  return failure;
}

/**
 * Compact frame descriptor for provider debug (`ocx debug provider on`): outer case plus the inner
 * interactionUpdate/exec case and tool-call union case when present. No payload content is logged.
 */
function describeCursorServerFrame(message: AgentServerMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { case: message.message.case ?? "unknown" };
  if (message.message.case === "interactionUpdate") {
    const update = message.message.value.message;
    out.update = update.case ?? "unknown";
    if (update.case === "toolCallStarted" || update.case === "partialToolCall" || update.case === "toolCallCompleted") {
      out.toolCase = update.value.toolCall?.tool.case ?? "none";
      out.callId = update.value.callId;
    }
  } else if (message.message.case === "execServerMessage") {
    out.exec = message.message.value.message.case ?? "unknown";
  } else if (message.message.case === "interactionQuery") {
    out.query = message.message.value.query.case ?? "unknown";
    out.id = message.message.value.id;
  } else if (message.message.case === "kvServerMessage") {
    out.kv = message.message.value.message.case ?? "unknown";
  }
  return out;
}

/**
 * True when a server frame represents real upstream progress that produced no outward Responses
 * event (so the bridge's stall watchdog would otherwise see silence). Covers tool-call assembly,
 * token/checkpoint accounting — the frames `mapCursorProtobufServerMessage` intentionally swallows.
 */
function isCursorProgressFrame(message: AgentServerMessage): boolean {
  if (message.message.case === "conversationCheckpointUpdate") return true;
  if (message.message.case !== "interactionUpdate") return false;
  switch (message.message.value.message.case) {
    case "toolCallStarted":
    case "partialToolCall":
    case "toolCallDelta":
    case "tokenDelta":
      return true;
    default:
      return false;
  }
}

/**
 * A tool-call lifecycle frame that can change the CLIENT tool call set (announce a new sibling or
 * commit one). Used to revoke a pending finalize so a late-announced parallel call is never dropped.
 * Only frames whose inner ToolCall is an ocx-bridged Responses tool (`mcpToolCall` with our provider)
 * count: Cursor-native tool frames (readToolCall/editToolCall/...) are display-plane and must not
 * revoke a pending client-tool finalize. Exported for unit testing.
 */
export function isClientToolFrame(message: AgentServerMessage): boolean {
  if (message.message.case !== "interactionUpdate") return false;
  const update = message.message.value.message;
  switch (update.case) {
    case "toolCallStarted":
    case "partialToolCall":
    case "toolCallCompleted":
      return mcpArgsFromToolCall(update.value.toolCall) !== undefined;
    default:
      return false;
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Host-only label for Cursor transport diagnostics — never leaks path/query/credentials. */
function cursorHostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "cursor";
  }
}

/** Redact a Cursor error message for diagnostic output. Cursor error strings can carry raw
 * credential key=value pairs beyond what redactSecretString covers; safeCursorErrorMessage
 * already applies the full sanitizer plus the classified prefix, so reuse it verbatim. */
function redactCursorForLog(message: string): string {
  return safeCursorErrorMessage(message).slice(0, 300);
}

/** Extract the Connect end-stream `error.code` from the raw trailer frame payload without
 * surfacing the (potentially secret-bearing) message — used for `[ocx:cursor:connect-end-stream]`
 * diagnostics. Returns undefined when the payload is not the expected Connect error shape. */
function cursorConnectErrorCode(payload: Uint8Array): string | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as { error?: { code?: string } };
    return parsed?.error?.code;
  } catch {
    return undefined;
  }
}

export function createLiveCursorTransport(input: CursorTransportFactoryInput): CursorTransport {
  return new LiveCursorTransport(input);
}
