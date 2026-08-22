import http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { namespacedToolName, type OcxProviderConfig, type OcxUsage } from "../../types";
import { CONNECT_FLAG_END_STREAM, ConnectFrameError, consumeConnectFrames, encodeConnectFrame } from "./framing";
import {
  CURSOR_MAX_EFFECTIVE_CONNECT_PAYLOAD_BYTES,
  CURSOR_MAX_CONNECT_FRAME_BYTES,
  CURSOR_MAX_PENDING_FRAMES,
  CURSOR_PENDING_FRAMES_RESUME,
  CURSOR_TRANSPORT_MAX_BUFFERED_BYTES,
  CURSOR_TRANSPORT_RESUME_BYTES,
  TranslatorBudgetExceededError,
  type TranslatorBudget,
} from "../../lib/translator-budget";
import { activePromptText, prepareCursorRunRequest } from "./protobuf-request";
import { prepareCursorRawMessages, resolveActiveCursorImages } from "./images";
import { cursorRequestMessagesFromRaw } from "./request-builder";
import {
  createCursorContextUsageTracker,
  createCursorProtobufEventState,
  finalizeTurnEvents,
  mapCursorProtobufServerMessage,
  mapSyntheticMcpExecToToolEvents,
  reportableContextTokens,
  resolvedTurnUsage,
  usageFromContextTokens,
} from "./protobuf-events";
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
  ConversationStateStructureSchema,
  ExaFetchRequestResponseSchema,
  ExaFetchRequestResponse_ApprovedSchema,
  ExaSearchRequestResponseSchema,
  ExaSearchRequestResponse_ApprovedSchema,
  InteractionResponseSchema,
  SwitchModeRequestResponseSchema,
  SwitchModeRequestResponse_RejectedSchema,
  WebSearchRequestResponseSchema,
  WebSearchRequestResponse_ApprovedSchema,
  type AgentServerMessage,
  type ExecServerMessage,
  type InteractionQuery,
  type InteractionResponse,
} from "./gen/agent_pb";
import { debugProviderDiagnostic } from "../../lib/debug";
import { classifyCursorError, CursorUnexpectedCancelError, isCursorAbortError, isCursorBenignCancelError, safeCursorErrorMessage } from "./cursor-errors";
import { mcpArgsFromToolCall } from "./protobuf-events";
import { OCX_RESPONSES_TOOL_PROVIDER } from "./tool-definitions";
import {
  handleCursorNativeExec,
  handleCursorNativeKv,
  releaseCursorBlobRequestScope,
  type CursorBlobRequestScopeToken,
  type CursorNativeExecContext,
} from "./native-exec";
import { effectiveCursorNativeExecAllow } from "./exec-policy";
import { resolveMcpServers } from "./mcp-config";
import { CursorMcpManager } from "./mcp-manager";
import { buildMcpToolDefinitions, mcpDepsFromManager } from "./native-exec-mcp";
import { desktopDepsFromConfig } from "./native-exec-desktop";
import {
  buildCursorToolDefinitions,
  cursorRequestAdvertisesApplyPatch,
  cursorRequestHasShellAlias,
  cursorToolArgNormalizeSchema,
  cursorToolWireName,
  cursorToolsForActivePrompt,
  isCursorSyntheticStructuredEditTool,
  isGenericToolUseCountDemoPrompt,
  requestedCursorToolUseCount,
} from "./tool-definitions";
import type { CursorNativeToolDeps } from "./native-exec-tools";
import {
  terminateBackgroundShellsForSession,
  type BackgroundShellTerminationReport,
} from "./native-exec-shell";
import type { CursorClientMessage, CursorRunRequest, CursorServerMessage } from "./types";
import type { CursorTransport, CursorTransportFactoryInput } from "./transport";
import { CursorHttp1BidiConnection } from "./http1-bidi";
import { isPinnedHttp1 } from "../../lib/upstream-http-version";

const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";
const CURSOR_CLIENT_VERSION = "cli-2026.07.08-0c04a8a";
const HEARTBEAT_MS = 5_000;
const CURSOR_FIRST_FRAME_TIMEOUT_MS = 30_000;
/**
 * T04 (senpi #1062 second half): after the first frame, a turn with NO inbound decoded
 * frames for this long is failed instead of waiting for the 300s bridge stall watchdog
 * (issue #2210). Reset on every decoded AgentServerMessage.
 */
const CURSOR_STREAM_SILENCE_FAIL_MS = 30_000;
/**
 * A stream that produces ONLY liveness frames (server heartbeat / conversationCheckpointUpdate)
 * for this long is equally stuck — the server is alive but the turn is not progressing.
 * Reset on every decoded frame that is not liveness-only.
 */
const CURSOR_STREAM_HEARTBEAT_ONLY_FAIL_MS = 90_000;
/**
 * After `turnEnded` is decoded, the application turn is complete. A server that keeps
 * HTTP/2 open past this point cannot hold the turn hostage (senpi #1062): we close our side
 * after a short grace so any trailing frames (late usage, checkpoint) still land.
 */
const TURN_ENDED_CLOSE_GRACE_MS = 500;
const CURSOR_TIMEOUT_DESTROY_GRACE_MS = 1_000;
const CLIENT_TOOL_FINALIZE_GRACE_MS = 50;
const GENERIC_TOOL_COUNT_MIN_FINALIZE_GRACE_MS = 750;
const GENERIC_TOOL_COUNT_MAX_FINALIZE_GRACE_MS = 1_800;
const GENERIC_TOOL_COUNT_PER_TOOL_GRACE_MS = 125;
const cursorContextUsageTracker = createCursorContextUsageTracker();

/**
 * Single-shot terminal settlement for one Cursor turn: whichever of fail/finish wins first owns
 * the terminal; later calls are no-ops. Prevents double-terminal mutation when multiple sources
 * race (stream error + session error, end + late session error, timeout + destroy error).
 * Exported for direct unit testing — the callbacks are otherwise private to run()/open().
 */
export function createTerminalSettler(hooks: {
  fail: (error: Error) => void;
  finish: () => void;
  clearTimer: () => void;
}): { settleFail: (error: Error) => void; settleFinish: () => void; settled: () => boolean } {
  let settled = false;
  return {
    settleFail(error) {
      if (settled) return;
      settled = true;
      hooks.clearTimer();
      hooks.fail(error);
    },
    settleFinish() {
      if (settled) return;
      settled = true;
      hooks.clearTimer();
      hooks.finish();
    },
    settled: () => settled,
  };
}

/**
 * Arm the post-close destroy fallback for a timed-out turn: close() waits for in-flight frames,
 * but a dead socket can ignore it, leaving a stalled TLS session past the timeout. Exported for
 * unit testing with fakes. The timer is unref'd so it never holds the process open.
 */
export function armTimeoutDestroyFallback(
  stream: { destroyed: boolean; destroy: () => void },
  session: { destroyed: boolean; destroy: () => void },
  graceMs: number,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    try { if (!stream.destroyed) stream.destroy(); } catch { /* gone */ }
    try { if (!session.destroyed) session.destroy(); } catch { /* gone */ }
  }, graceMs);
  timer.unref?.();
  return timer;
}

/** Carry context-usage totals across conversation-id rotation for external-model replay. */
export function rekeyCursorContextUsage(fromConversationId: string, toConversationId: string): void {
  cursorContextUsageTracker.rekey(fromConversationId, toConversationId);
}

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
 *   - webSearch / exaSearch / exaFetch: APPROVE (empty approval). These are approve/reject
 *     permission gates, not client-run requests — the response schema has no result field, so
 *     approval delegates the search to Cursor's SERVER, which runs it and injects results into the
 *     model server-side (the answer then streams back as textDelta; the display-plane
 *     web_search_tool_call/exa_*_tool_call result frames are native, non-mcp, and safely dropped by
 *     the event mapper). Rejecting them (the old default) killed the model's web capability on the
 *     Cursor path. Tradeoff: approval consumes the user's Cursor web-search/Exa quota. The synthetic
 *     web_search sidecar (src/web-search) is an orthogonal proxy-side path used only when the client
 *     sends a hosted web_search tool; it does not cover Cursor-native web search.
 *   - switchMode: reject (deterministic default; no non-interactive mode switch).
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
          result: { case: "approved", value: create(WebSearchRequestResponse_ApprovedSchema, {}) },
        }),
      }),
      replyCase: "webSearchRequestResponse:approved",
    };
  }
  if (q.case === "exaSearchRequestQuery") {
    return {
      response: respond({
        case: "exaSearchRequestResponse",
        value: create(ExaSearchRequestResponseSchema, {
          result: { case: "approved", value: create(ExaSearchRequestResponse_ApprovedSchema, {}) },
        }),
      }),
      replyCase: "exaSearchRequestResponse:approved",
    };
  }
  if (q.case === "exaFetchRequestQuery") {
    return {
      response: respond({
        case: "exaFetchRequestResponse",
        value: create(ExaFetchRequestResponseSchema, {
          result: { case: "approved", value: create(ExaFetchRequestResponse_ApprovedSchema, {}) },
        }),
      }),
      replyCase: "exaFetchRequestResponse:approved",
    };
  }
  if (q.case === "setupVmEnvironmentArgs") {
    // setupVmEnvironment is not supported — reply with an empty InteractionResponse so the stream
    // stays alive instead of throwing (which kills the entire gRPC connection via failAndClear).
    return {
      response: respond({ case: undefined, value: undefined }),
      replyCase: "unsupported:setupVmEnvironment",
    };
  }
  // Unknown interaction query case — Cursor added a new query type that our protobuf definition
  // does not include yet. Gracefully reply with an empty InteractionResponse (matching id, no
  // result) so the server unblocks and the stream stays alive. Previously this threw, which
  // propagated through .catch → failAndClear and killed the entire connection (#116).
  return {
    response: respond({ case: undefined, value: undefined }),
    replyCase: `unsupported:${q.case ?? "unknown"}`,
  };
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
  private http1Connection?: CursorHttp1BidiConnection;
  private heartbeat?: ReturnType<typeof setInterval>;
  private firstFrameTimer?: ReturnType<typeof setTimeout>;
  private turnEndedCloseTimer?: ReturnType<typeof setTimeout>;
  /**
   * T04 inbound stream-health watchdog. Armed after the request is on the wire, reset by
   * every DECODED frame (raw chunks deliberately do not count — TLS keepalive noise must not
   * defeat it), disarmed by any settle/expected-close path. One timer covers both thresholds:
   * it always fires at min(lastInbound + silence, lastMeaningful + heartbeatOnly) and re-arms
   * when neither deadline has actually elapsed.
   */
  private streamHealthTimer?: ReturnType<typeof setTimeout>;
  private lastInboundFrameAt = 0;
  private lastMeaningfulFrameAt = 0;
  private streamHealthFail?: (error: Error) => void;
  private committed = false;
  private expectedClose = false;
  /**
   * True once a terminal (`done` or `error`) has been admitted to the outbound queue. Read only
   * by the EOF branch below: after a mapper error the bridge has already failed the turn, so
   * failing again on EOF would add a duplicate adapter error for no benefit.
   */
  private emittedTerminal = false;
  private pendingFinalize?: ReturnType<typeof setTimeout>;
  private readonly clientToolFinalizeGraceMs: number;
  private activeClientToolFinalizeGraceMs: number;
  private readonly token: string;
  private readonly mcpManager?: CursorMcpManager;
  private readonly translatorBudget: TranslatorBudget;
  private pendingTransportFrames = 0;
  private transportBufferedBytes = 0;
  private readonly desktopDeps: CursorNativeToolDeps;
  private execContext: CursorNativeExecContext = {};
  private mcpPrepared?: Promise<void>;
  private releaseMcpObservation?: () => void;
  private blobRequestScope?: CursorBlobRequestScopeToken;
  private shellCleanup?: Promise<BackgroundShellTerminationReport>;
  // Per-turn diagnostic counters/timestamps when provider debug is on (`ocx debug provider on`). Stamped in open(), cleared on
  // close; safe to read after a stream failure because open() owns the only writer before run().
  private turnStartedAt = 0;
  private framesReceived = 0;
  private sawAssistantText = false;
 private firstFrameAt?: number;
  private firstFrameLogged = false;
  /** Stable session identifier sent as x-session-id; mirrors IDE session semantics. */
  private readonly sessionId: string;
  /** Per-transport owner for native-exec / background shells. Must not share conversationId. */
  private readonly shellOwnerId = crypto.randomUUID();
  private capturedCheckpointBytes?: Uint8Array;

  constructor(private readonly input: CursorTransportFactoryInput) {
    this.sessionId = input.sessionId?.trim() || crypto.randomUUID();
    this.translatorBudget = input.translatorBudget;
    this.token = resolveCursorToken(input.provider, input.headers);
    // Grace window before a drained client-tool turn is finalized. Small enough not to look like a
    // stall, large enough to catch a sibling tool call announced in the next receive chunk. Injectable
    // so the transport-level race test can drive it deterministically.
    this.clientToolFinalizeGraceMs = input.clientToolFinalizeGraceMs ?? CLIENT_TOOL_FINALIZE_GRACE_MS;
    this.activeClientToolFinalizeGraceMs = this.clientToolFinalizeGraceMs;
    // Desktop (computer-use / record-screen) executors are available even with no MCP servers.
    this.desktopDeps = desktopDepsFromConfig(input.provider.desktopExecutor);
    this.execContext = {
      ...this.desktopDeps,
      sessionId: this.shellOwnerId,
      unsafeAllowNativeLocalExec: effectiveCursorNativeExecAllow(input.provider, input.requestDeclaresFullAccess === true),
    };
    const servers = resolveMcpServers(input.provider);
    if (servers.length > 0) {
      this.mcpManager = new CursorMcpManager(servers, {
        log: message => console.warn(message),
        maxTools: input.provider.mcpMaxTools,
        maxSchemaBytes: input.provider.mcpMaxSchemaBytes,
        maxResultBytes: input.provider.mcpMaxResultBytes,
      });
    }
  }

  /**
   * Connect MCP servers and compute the tool definitions advertised to the Cursor server.
   * MUST complete before the first `requestContextArgs` (the server only calls MCP tools it was
   * told about), so `run()` awaits this before opening the stream. Preparation failures reject the
   * turn instead of silently running with MCP disabled.
   */
  private prepareMcp(): Promise<void> {
    if (!this.mcpManager) return Promise.resolve();
    if (!this.mcpPrepared) {
      this.mcpPrepared = (async () => {
        try {
          const mcpToolDefs = await buildMcpToolDefinitions(this.mcpManager!);
          this.releaseMcpObservation?.();
          this.releaseMcpObservation = this.translatorBudget.observeExternallyCapped(
            "mcp_payload",
            new TextEncoder().encode(JSON.stringify(mcpToolDefs)).byteLength,
          );
          this.execContext = {
            ...this.desktopDeps,
            ...mcpDepsFromManager(this.mcpManager!),
            mcpToolDefs,
            sessionId: this.shellOwnerId,
            unsafeAllowNativeLocalExec: effectiveCursorNativeExecAllow(this.input.provider, this.input.requestDeclaresFullAccess === true),
          };
        } catch (err) {
          throw new Error(`Cursor MCP preparation failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
      })();
    }
    return this.mcpPrepared;
  }

  toJSON(): Record<string, string> {
    return { type: "LiveCursorTransport", credential: "redacted" };
  }

  async *run(request: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorServerMessage> {
    const queue: Array<{ message: CursorServerMessage; bytes: number }> = [];
    let notify: (() => void) | undefined;
    let done = false;
    let failure: Error | undefined;
    let state = createCursorProtobufEventState({ translatorBudget: this.translatorBudget });
    let failureLogged = false;
    // One per-turn summary of the failure path (end-stream error, socket reset, abort) so the
    // operator can see how far the turn got and how it was classified without re-scanning every
    // frame. Gated behind provider debug (`ocx debug provider on`).
    const summarizeFailure = (err: Error): Error => {
      if (!failureLogged && !(this.expectedClose && isCursorBenignCancelError(err))) {
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
    /**
     * A cancel we did not request is a real transport failure, but as a raw `NGHTTP2_CANCEL` it
     * gets swallowed twice over: the adapter re-decides "benign" from the error code alone
     * (`cursor.ts:181`) and drops the turn, and any message that survives is re-matched
     * downstream and labelled an intentional "Cursor stream suspended". Raising a typed error
     * carries the provenance this class already holds.
     *
     * Suppressed once a terminal was emitted: the turn already ended, and a second terminal flips
     * a completed buffered response to failed.
     */
    const classifyTurnFailure = (err: Error): Error => {
      if (!this.expectedClose && !this.emittedTerminal && isCursorBenignCancelError(err)) {
        return summarizeFailure(new CursorUnexpectedCancelError(err));
      }
      return summarizeFailure(err);
    };
    const wake = () => {
      const fn = notify;
      notify = undefined;
      fn?.();
    };

    const push = (message: CursorServerMessage) => {
      const bytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
      this.reserveTransportBytes(bytes);
      if (message.type === "done" || message.type === "error") this.emittedTerminal = true;
      queue.push({ message, bytes });
      wake();
    };

    // Advertise MCP tools before the stream opens — the server only calls tools it was told about.
    await this.prepareMcp();
    // JPEG soft-cap rewrite for active-turn data: images before encode. Rebuild text
    // messages from the prepared raw channel so omission markers replace stale
    // pre-rewrite content that activePromptText and the tool filter would otherwise see.
    const preparedRaw = await prepareCursorRawMessages(request.rawMessages, signal);
    const preparedRawMessages = preparedRaw.messages;
    const selectedImages = await resolveActiveCursorImages(
      preparedRawMessages,
      signal,
      preparedRaw.images,
    );
    const preparedMessages = preparedRawMessages === request.rawMessages
      ? request.messages
      : cursorRequestMessagesFromRaw(preparedRawMessages);
    const activeRequest: CursorRunRequest = {
      ...request,
      messages: preparedMessages,
      rawMessages: preparedRawMessages,
      selectedImages,
    };
    const activeText = activePromptText(activeRequest);
    this.activeClientToolFinalizeGraceMs = clientToolFinalizeGraceMsForRequest(activeRequest, this.clientToolFinalizeGraceMs);
    const cursorVisibleTools = cursorToolsForActivePrompt(activeRequest.tools, activeText, activeRequest.toolChoice);
    const clientToolDefs = buildCursorToolDefinitions(cursorVisibleTools, activeRequest.toolChoice);
    // `request.tools` is the catalog already filtered and budgeted by request-builder. Derive
    // conversion provenance only from tagged synthetic tools that also survive this final prompt
    // filter; a client tool with the same wire name can never opt into conversion by collision.
    const syntheticStructuredEditToolNames = new Set(
      (cursorVisibleTools ?? [])
        .filter(isCursorSyntheticStructuredEditTool)
        .map(cursorToolWireName),
    );
    const freeformToolNames = new Set(
      (cursorVisibleTools ?? [])
        .filter(tool => tool.freeform)
        .map(tool => namespacedToolName(tool.namespace, tool.name)),
    );
    this.execContext = {
      ...this.execContext,
      clientToolDefs,
      rejectNativeFileMutations: cursorRequestAdvertisesApplyPatch(request.tools, request.toolChoice),
      structuredEditAvailable: syntheticStructuredEditToolNames.size > 0,
    };
    const toolSchemas = new Map<string, unknown>();
    const cursorToolNameMap = new Map<string, string>();
    for (const tool of cursorVisibleTools ?? []) {
      const cursorWireName = cursorToolWireName(tool);
      // Normalize against Responses/Codex field names, not the Cursor advertisement schema.
      // Advertising `cmd` while also storing that schema here left `cmd` unmapped and Codex
      // rejected shell_command with "missing field `command`" (#399).
      toolSchemas.set(cursorWireName, cursorToolArgNormalizeSchema(tool));
      cursorToolNameMap.set(cursorWireName, namespacedToolName(tool.namespace, tool.name));
    }
    const contextUsage = cursorContextUsageTracker.controlsForConversation(request.conversationId, {
      clearPrior: request.contextUsageReset === true,
      storeCheckpoints: request.contextUsageStoreCheckpoints !== false,
    });
    // Build the payload once. The estimate is only worth deriving when there is no
    // carry-forward to fall back on — with a carry present it would never be used (#373).
    const prepared = prepareCursorRunRequest(activeRequest, {
      estimateInputTokens: contextUsage.carryForwardTokens === undefined,
    });
    this.blobRequestScope = prepared.blobRequestScope;
    try {
      state = createCursorProtobufEventState({
        clientToolNames: clientToolDefs.map(tool => tool.toolName || tool.name),
        freeformToolNames,
        parallelToolCalls: request.parallelToolCalls,
        toolSchemas,
        cursorToolNameMap,
        syntheticStructuredEditToolNames,
        translatorBudget: this.translatorBudget,
        contextUsage,
        ...(prepared.estimatedInputTokens !== undefined
          ? { estimatedInputTokens: prepared.estimatedInputTokens }
          : {}),
      });
      this.open(prepared.bytes, signal, state, push, err => {
        this.releaseBlobRequestScope();
        failure = err;
        wake();
      }, () => {
        this.releaseBlobRequestScope();
        done = true;
        wake();
      });
    } catch (error) {
      this.releaseBlobRequestScope();
      throw error;
    }

    while (!done || queue.length > 0) {
      while (queue.length > 0) {
        const queued = queue.shift();
        if (queued) {
          this.releaseTransportBytes(queued.bytes);
          yield queued.message;
        }
      }
      if (failure) {
        // A CANCEL is benign only on the client-tool suspend path (expectedClose); an
        // unexpected server-side NGHTTP2_CANCEL must surface as a real transport error.
        if (this.expectedClose && isCursorBenignCancelError(failure)) return;
        // A teardown error arriving AFTER the turn's terminal frame describes the connection,
        // not the turn: the answer is committed and every queued message has been yielded.
        //
        // Narrow on purpose. A benign cancel after a terminal is already swallowed one layer
        // up (`cursor.ts:183`), so widening this to every post-terminal error would change
        // what the adapter sees for genuine faults. What it does cover is the abort case
        // from #1527: `signal.abort` fires `failAndClear(new Error("Cursor request was
        // aborted"))`, which is NOT benign (`cursor-errors.ts:74`), so an ordinary completed
        // turn that is then torn down still surfaced as `turn-failed` with
        // `expectedClose:false`. Only `cancelCursorRun()` sets `expectedClose`, so a normal
        // completion never qualified for the branch above.
        if (this.emittedTerminal && isCursorAbortError(failure)) return;
        throw attachPartialUsage(classifyTurnFailure(failure), state);
      }
      if (done) break;
      await new Promise<void>(resolve => {
        notify = resolve;
      });
    }
    if (failure) {
      if (this.expectedClose && isCursorBenignCancelError(failure)) return;
      if (this.emittedTerminal && isCursorAbortError(failure)) return;
      throw attachPartialUsage(classifyTurnFailure(failure), state);
    }
  }

  writeClient(_message: CursorClientMessage): void {}

  private reserveTransportBytes(bytes: number): void {
    if (this.transportBufferedBytes + bytes > CURSOR_TRANSPORT_MAX_BUFFERED_BYTES) {
      throw new TranslatorBudgetExceededError("cursor_transport", CURSOR_TRANSPORT_MAX_BUFFERED_BYTES);
    }
    this.translatorBudget.chargeRetained(bytes, { kind: "cursor_transport" });
    this.transportBufferedBytes += bytes;
    this.updateTransportFlowControl();
  }

  private releaseTransportBytes(bytes: number): void {
    this.transportBufferedBytes = Math.max(0, this.transportBufferedBytes - bytes);
    this.translatorBudget.releaseRetained(bytes, { kind: "cursor_transport" });
    this.updateTransportFlowControl();
  }

  private updateTransportFlowControl(): void {
    if (
      this.transportBufferedBytes >= CURSOR_TRANSPORT_MAX_BUFFERED_BYTES
      || this.pendingTransportFrames >= CURSOR_MAX_PENDING_FRAMES
    ) {
      this.stream?.pause();
      this.http1Connection?.pause();
      return;
    }
    if (
      this.transportBufferedBytes <= CURSOR_TRANSPORT_RESUME_BYTES
      && this.pendingTransportFrames <= CURSOR_PENDING_FRAMES_RESUME
    ) {
      this.stream?.resume();
      this.http1Connection?.resume();
    }
  }

  private writeConnectFrame(frame: Uint8Array): void {
    if (this.http1Connection) {
      this.http1Connection.write(frame);
      return;
    }
    this.stream?.write(frame);
  }

  requestCommitted(): boolean {
    return this.committed;
  }

  private clearFirstFrameTimer(): void {
    if (this.firstFrameTimer) {
      clearTimeout(this.firstFrameTimer);
      this.firstFrameTimer = undefined;
    }
  }

  private clearStreamHealthTimer(): void {
    if (this.streamHealthTimer) {
      clearTimeout(this.streamHealthTimer);
      this.streamHealthTimer = undefined;
    }
    this.streamHealthFail = undefined;
  }

  /**
   * T04: arm (or re-arm) the inbound stream-health watchdog. `fail` is the turn's
   * failAndClear; the timer owns nothing else. Never armed before the first decoded
   * frame (the first-frame timer covers dial + first response), and disarmed by
   * every settle / expected-close path alongside the other timers.
   */
  private armStreamHealthTimer(fail: (error: Error) => void): void {
    if (this.streamHealthTimer) clearTimeout(this.streamHealthTimer);
    if (this.expectedClose) return;
    this.streamHealthFail = fail;
    const silenceMs = this.input.streamSilenceFailMs ?? CURSOR_STREAM_SILENCE_FAIL_MS;
    const heartbeatOnlyMs = this.input.streamHeartbeatOnlyFailMs ?? CURSOR_STREAM_HEARTBEAT_ONLY_FAIL_MS;
    const now = Date.now();
    const deadline = Math.min(
      this.lastInboundFrameAt + silenceMs,
      this.lastMeaningfulFrameAt + heartbeatOnlyMs,
    );
    this.streamHealthTimer = setTimeout(() => {
      this.streamHealthTimer = undefined;
      const failFn = this.streamHealthFail;
      if (!failFn || this.expectedClose) return;
      const stalledFor = Date.now() - this.lastInboundFrameAt;
      const meaningfulStalledFor = Date.now() - this.lastMeaningfulFrameAt;
      if (stalledFor < silenceMs && meaningfulStalledFor < heartbeatOnlyMs) {
        // A frame landed between arming and firing — re-arm for the fresh deadline.
        this.armStreamHealthTimer(failFn);
        return;
      }
      const heartbeatOnly = stalledFor < silenceMs;
      debugProviderDiagnostic("cursor", "stream-health-timeout", {
        stalledMs: stalledFor,
        meaningfulStalledMs: meaningfulStalledFor,
        heartbeatOnly,
        framesReceived: this.framesReceived,
        elapsedMs: Date.now() - this.turnStartedAt,
      });
      const reason = heartbeatOnly
        ? `Cursor stream stalled: heartbeat-only traffic for ${Math.round(meaningfulStalledFor / 1000)}s without turn progress`
        : `Cursor stream stalled: no inbound frames for ${Math.round(stalledFor / 1000)}s before turnEnded`;
      failFn(new Error(reason));
      try { this.stream?.close(); } catch { this.stream?.destroy(); }
      this.session?.close();
      this.http1Connection?.close();
    }, Math.max(0, deadline - now));
  }

  /**
   * T04: record a decoded inbound frame. Liveness-only frames (server heartbeat,
   * conversationCheckpointUpdate) keep the silence clock fresh but not the progress
   * clock — matching senpi's split so a server that only pings still fails at the
   * heartbeat-only threshold.
   */
  private noteInboundFrame(livenessOnly: boolean): void {
    const now = Date.now();
    this.lastInboundFrameAt = now;
    if (!livenessOnly) this.lastMeaningfulFrameAt = now;
    if (this.streamHealthFail) this.armStreamHealthTimer(this.streamHealthFail);
  }

  /**
   * A clean Connect END_STREAM owns the turn terminal even when Cursor keeps the
   * HTTP body open or tears it down with an abort/reset immediately afterward.
   * Stop client-side liveness work and classify that later transport close as
   * expected without actively sending an RST_STREAM back to Cursor.
   */
  private markProtocolComplete(): void {
    this.expectedClose = true;
    this.clearPendingFinalize();
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    this.clearFirstFrameTimer();
    this.clearStreamHealthTimer();
  }

  private startShellCleanup(): Promise<BackgroundShellTerminationReport> {
    return this.shellCleanup ??= terminateBackgroundShellsForSession(this.shellOwnerId);
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.turnEndedCloseTimer) clearTimeout(this.turnEndedCloseTimer);
    this.clearPendingFinalize();
    this.clearFirstFrameTimer();
    this.clearStreamHealthTimer();
    this.stream?.close();
    this.session?.close();
    this.http1Connection?.close();
    this.releaseBlobRequestScope();
    this.releaseMcpObservation?.();
    this.releaseMcpObservation = undefined;
    void this.mcpManager?.dispose();
    await this.startShellCleanup();
  }

  private cancelCursorRun(): void {
    this.expectedClose = true;
    this.clearPendingFinalize();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.clearFirstFrameTimer();
    this.clearStreamHealthTimer();
    if (this.http1Connection) {
      this.http1Connection.close();
    } else {
      try {
        this.stream?.close(http2.constants.NGHTTP2_CANCEL);
      } catch {
        this.stream?.destroy();
      }
      this.session?.close();
    }
    this.releaseBlobRequestScope();
    this.releaseMcpObservation?.();
    this.releaseMcpObservation = undefined;
    void this.mcpManager?.dispose();
    void this.startShellCleanup().catch(() => { /* close() observes the same cleanup promise */ });
  }

  /**
   * T03 (#1062): after the server sends `turnEnded`, the application turn is complete.
   * A server that keeps the HTTP/2 stream open past this point cannot hold the turn
   * hostage until a 300s bridge idle timeout. Close our side after a short grace so any
   * trailing frames (late usage, checkpoint) still land before we release the socket.
   */
  private closeAfterTurnEnded(): void {
    if (this.turnEndedCloseTimer) return;
    // The application turn is over: the T03 grace timer owns the socket from here.
    // The T04 watchdog must disarm NOW, not at the grace close — a watchdog shorter
    // than the grace would otherwise fail a completed turn.
    this.clearStreamHealthTimer();
    this.turnEndedCloseTimer = setTimeout(() => {
      this.turnEndedCloseTimer = undefined;
      // Only expectedClose (client-tool suspend cancel) blocks the close.
      // emittedTerminal is intentionally NOT checked here: finalizeTurnEvents sets it
      // synchronously during turnEnded mapping, ~500ms before this timer fires, so
      // checking it would make the close unreachable on every real path (the exact
      // scenario this PR exists to fix — senpi #1062).
      if (this.expectedClose) return;
      debugProviderDiagnostic("cursor", "turn-ended-close", {
        committed: this.committed,
        framesReceived: this.framesReceived,
      });
      this.expectedClose = true;
      this.clearFirstFrameTimer();
      this.clearStreamHealthTimer();
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.http1Connection) {
        this.http1Connection.close();
      } else {
        try {
          this.stream?.close();
        } catch {
          this.stream?.destroy();
        }
      }
    }, TURN_ENDED_CLOSE_GRACE_MS);
  }

  private releaseBlobRequestScope(): void {
    const scope = this.blobRequestScope;
    if (!scope) return;
    this.blobRequestScope = undefined;
    releaseCursorBlobRequestScope(scope);
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
    encodedRequest: Uint8Array,
    signal: AbortSignal | undefined,
    state: ReturnType<typeof createCursorProtobufEventState>,
    push: (message: CursorServerMessage) => void,
    fail: (error: Error) => void,
    finish: () => void,
  ): void {
    if (signal?.aborted) {
      fail(signal.reason instanceof Error ? signal.reason : new Error("Cursor request was aborted"));
      return;
    }
    this.turnStartedAt = Date.now();
    this.framesReceived = 0;
    this.sawAssistantText = false;
    this.emittedTerminal = false;
    this.firstFrameAt = undefined;
    this.firstFrameLogged = false;
    const baseUrl = this.input.provider.baseUrl || "https://api2.cursor.sh";
    const useHttp1 = isPinnedHttp1(this.input.provider.upstreamHttpVersion);
    const requestId = crypto.randomUUID();
    const dialHost = cursorHostLabel(baseUrl);
    debugProviderDiagnostic("cursor", "dial", { host: dialHost, transport: useHttp1 ? "http1.1" : "http2" });

    let session: http2.ClientHttp2Session | undefined;
    let stream: http2.ClientHttp2Stream | undefined;
    if (!useHttp1) {
      session = http2.connect(baseUrl);
      this.session = session;
      // The run request is buffered until the HTTP/2 session connects. Failures before `connect`
      // (DNS, ECONNREFUSED, TLS, connect timeout) mean the server never received the request, so they
      // are safe to retry. Once connected, bytes flush to the server and the turn must not be replayed.
      session.on("connect", () => {
        this.committed = true;
        debugProviderDiagnostic("cursor", "connected", {
          transport: "http2",
          connectMs: Date.now() - this.turnStartedAt,
        });
      });
      stream = session.request({
        ":method": "POST",
        ":path": CURSOR_RUN_PATH,
        "content-type": "application/connect+proto",
        "connect-protocol-version": "1",
        te: "trailers",
        authorization: `Bearer ${this.token}`,
        "x-ghost-mode": "true",
        "x-cursor-client-version": CURSOR_CLIENT_VERSION,
        "x-cursor-client-type": "cli",
        "x-request-id": requestId,
        "x-session-id": this.sessionId,
      });
      this.stream = stream;
    }

    // Single-shot terminal owner for this turn (createTerminalSettler): stream error, session
    // error, trailers, end, abort, and the first-frame timeout all race into it, and only the
    // first wins. The first-frame timer is cleared by any settlement so it can never leak.
    const settler = createTerminalSettler({
      fail,
      finish,
      clearTimer: () => {
        this.clearFirstFrameTimer();
        this.clearStreamHealthTimer();
      },
    });
    const failAndClear = (error: Error) => {
      releaseBacklogLease();
      if (this.expectedClose) {
        // We already emitted a terminal `done` and cancelled the run (client-tool suspension). The
        // RST_STREAM CANCEL surfaces here as a stream error/abort; it is expected, not a failure.
        debugProviderDiagnostic("cursor", "stream-cancel-expected", {
          code: (error as { code?: unknown }).code,
          message: redactCursorForLog(error.message),
          framesReceived: this.framesReceived,
          elapsedMs: Date.now() - this.turnStartedAt,
        });
        settler.settleFinish();
        return;
      }
      settler.settleFail(error);
    };
    // Session-level errors (TLS/socket/GOAWAY) do not always propagate to the stream listener;
    // without this handler they could bypass orderly failure reporting entirely.
    const onSessionError = (err: unknown) => {
      const realErr = err instanceof Error ? err : new Error(String(err));
      debugProviderDiagnostic("cursor", "session-error", {
        code: String((realErr as { code?: unknown }).code ?? ""),
        message: redactCursorForLog(realErr.message),
        elapsedMs: Date.now() - this.turnStartedAt,
      });
      failAndClear(realErr);
    };
    this.firstFrameTimer = setTimeout(() => {
      this.firstFrameTimer = undefined;
      debugProviderDiagnostic("cursor", "first-frame-timeout", { timeoutMs: this.input.firstFrameTimeoutMs ?? CURSOR_FIRST_FRAME_TIMEOUT_MS });
      try { stream?.close(); } catch { /* already closing */ }
      try { session?.close(); } catch { /* already closing */ }
      this.http1Connection?.close();
      if (stream && session) {
        // close() waits for in-flight frames; a dead socket can ignore it — force-destroy shortly
        // after so a stalled TLS session cannot linger past the timeout.
        armTimeoutDestroyFallback(stream, session, this.input.timeoutDestroyGraceMs ?? CURSOR_TIMEOUT_DESTROY_GRACE_MS);
      }
      releaseBacklogLease();
      settler.settleFail(new Error("Cursor transport timed out before first response"));
    }, this.input.firstFrameTimeoutMs ?? CURSOR_FIRST_FRAME_TIMEOUT_MS);

    // Raw Connect backlog with a parse cursor: appends copy only the incoming
    // chunk (amortized capacity growth), the consumed prefix is reclaimed
    // lazily, and the RAW used length (headers included) is what the 32 MiB
    // transport cap bounds — payload-only accounting let tiny-frame/header
    // floods slip through.
    let backlog = new Uint8Array();
    let backlogStart = 0;
    let backlogEnd = 0;
    const BACKLOG_COMPACT_MIN_SAVINGS = 64 * 1024;
    const appendBacklog = (chunk: Uint8Array): void => {
      const used = backlogEnd - backlogStart;
      let start = backlogStart;
      let end = backlogEnd;
      // Reclaim the consumed prefix when it is large or needed for capacity.
      if (start > 0 && (start >= BACKLOG_COMPACT_MIN_SAVINGS || end + chunk.byteLength > backlog.byteLength)) {
        backlog = backlog.slice(start, end);
        start = 0;
        end = used;
      }
      if (end + chunk.byteLength > backlog.byteLength) {
        const capacity = Math.max(8192, backlog.byteLength * 2, end + chunk.byteLength);
        const next = new Uint8Array(Math.min(CURSOR_TRANSPORT_MAX_BUFFERED_BYTES, capacity));
        next.set(backlog.subarray(start, end), 0);
        backlog = next;
      }
      backlog.set(chunk, end);
      backlogStart = start;
      backlogEnd = end + chunk.byteLength;
    };
    let frameWork: Promise<void> = Promise.resolve();
    // Idempotent terminal owner for the backlog lease: every settle/close path
    // must leave the raw charge at zero instead of relying on budget disposal.
    let backlogLeaseReleased = false;
    const releaseBacklogLease = () => {
      if (backlogLeaseReleased) return;
      backlogLeaseReleased = true;
      const leftover = backlogEnd - backlogStart;
      if (leftover > 0) this.releaseTransportBytes(leftover);
      backlog = new Uint8Array();
      backlogStart = 0;
      backlogEnd = 0;
    };
    const handleFrame = async (frame: ReturnType<typeof consumeConnectFrames>["frames"][number]) => {
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
        if (endError) {
          failAndClear(endError);
          return;
        }
        // Connect's clean END_STREAM envelope is the protocol terminal. Cursor's RunSSE body can
        // remain open after this frame (or close through an AbortError), so waiting for HTTP EOF
        // strands an otherwise completed turn until the outer bridge stall watchdog fires.
        //
        // Earlier frames in this serialized frameWork chain have already run. Preserve their real
        // turnEnded terminal when present; otherwise finalize the clean protocol end once so open
        // tool calls still fail closed, a text-only turn receives its normal done event, and a
        // drained client-tool turn does not lose the pending terminal when protocol cleanup clears
        // its grace timer.
        const hasPendingClientToolFinalization = this.pendingFinalize !== undefined;
        if (
          !this.expectedClose
          && !state.terminated
          && !this.emittedTerminal
          && (
            state.openToolCalls.size > 0
            || this.sawAssistantText
            || hasPendingClientToolFinalization
          )
        ) {
          const terminal = hasPendingClientToolFinalization && state.openToolCalls.size === 0
            ? finalizeAfterDrain(state)
            : finalizeTurnEvents(state);
          for (const event of terminal) push(event);
        }
        this.markProtocolComplete();
        releaseBacklogLease();
        settler.settleFinish();
        return;
      }
      const decoded = fromBinary(AgentServerMessageSchema, frame.payload);
      // T04: every decoded frame refreshes the silence clock; only non-liveness frames
      // refresh the progress clock. First decoded frame arms the watchdog (the first-frame
      // timer owned everything before this point).
      const decodedUpdate = decoded.message.case === "interactionUpdate" ? decoded.message.value.message?.case : undefined;
      const livenessOnly = decodedUpdate === "heartbeat" || decoded.message.case === "conversationCheckpointUpdate";
      if (!this.streamHealthFail) {
        const now = Date.now();
        this.lastInboundFrameAt = now;
        this.lastMeaningfulFrameAt = now;
        this.streamHealthFail = failAndClear;
      }
      this.noteInboundFrame(livenessOnly);
      await this.handleServerMessage(decoded, state, push);
    };
    const drainPendingFrames = () => {
      const availableSlots = CURSOR_MAX_PENDING_FRAMES - this.pendingTransportFrames;
      const used = backlogEnd - backlogStart;
      if (availableSlots <= 0 || used === 0) {
        this.updateTransportFlowControl();
        return;
      }
      // Cursor decode, zero-copy: frame payloads are views into the backlog, so
      // the charge TRANSFERS — only consumed header bytes leave the counter
      // (payload bytes stay charged and are released when each frame's work
      // finishes). An exact 16 MiB payload therefore peaks at 16 MiB + 5, not
      // at double its size.
      const decoded = consumeConnectFrames(
        backlog.subarray(backlogStart, backlogEnd),
        CURSOR_MAX_EFFECTIVE_CONNECT_PAYLOAD_BYTES,
        availableSlots,
      );
      if (decoded.frames.length > 0) {
        backlogStart += decoded.consumedBytes;
        this.releaseTransportBytes(decoded.consumedBytes - decoded.frames.reduce((n, frame) => n + frame.payload.byteLength, 0));
      }
      for (const frame of decoded.frames) {
        this.pendingTransportFrames += 1;
        this.updateTransportFlowControl();
        frameWork = frameWork
          .then(() => handleFrame(frame))
          .catch(err => failAndClear(err instanceof Error ? err : new Error(String(err))))
          .finally(() => {
            this.releaseTransportBytes(frame.payload.byteLength);
            this.pendingTransportFrames = Math.max(0, this.pendingTransportFrames - 1);
            this.updateTransportFlowControl();
            drainPendingFrames();
          });
      }
    };
    const onData = (chunk: string | Uint8Array) => {
      this.clearFirstFrameTimer();
      // Once the turn has settled, late network bytes must never be charged —
      // the backlog lease is already released and nobody would own these.
      if (settler.settled()) return;
      if (!this.firstFrameLogged) {
        this.firstFrameLogged = true;
        this.firstFrameAt = Date.now();
        debugProviderDiagnostic("cursor", "first-frame", { latencyMs: this.firstFrameAt - this.turnStartedAt });
      }
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let charged = false;
      let appended = false;
      try {
        // RAW chunk bytes (headers included) join the backlog charge; consumed
        // bytes leave it at drain. No whole-backlog replacement copy anymore.
        this.reserveTransportBytes(bytes.byteLength);
        charged = true;
        appendBacklog(bytes);
        appended = true;
        drainPendingFrames();
      } catch (err) {
        // Release ONLY when the reservation succeeded but the append never
        // happened. A failed reservation charged nothing — releasing here
        // would debit unrelated existing ownership; an appended chunk is owned
        // by the terminal backlog cleanup.
        if (charged && !appended) this.releaseTransportBytes(bytes.byteLength);
        failAndClear(err instanceof Error ? err : new Error(String(err)));
      }
    };
    const onTrailers = (trailers: http2.IncomingHttpHeaders) => {
      const status = trailers["grpc-status"];
      if (status !== undefined) debugProviderDiagnostic("cursor", "trailers", { grpcStatus: String(status) });
      if (status && status !== "0") failAndClear(new Error(`Cursor gRPC error ${status}`));
    };
    const onStreamError = (err: unknown) => {
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
    };
    const onStreamEnd = () => {
      this.clearFirstFrameTimer();
      debugProviderDiagnostic("cursor", "stream-end", {
        committed: this.committed,
        framesReceived: this.framesReceived,
        expectedClose: this.expectedClose,
        elapsedMs: Date.now() - this.turnStartedAt,
      });
      // Settle only after queued frame work drains to quiescence (the chain can
      // extend itself while draining), then classify the terminal state:
      // a trailing incomplete frame is a typed failure, and a zero-frame,
      // zero-byte end without an expected close stays the existing unexpected
      // EOF — both beat the old silent success.
      void (async () => {
        let previous: Promise<void>;
        do {
          previous = frameWork;
          await previous;
        } while (previous !== frameWork);
      })().then(() => {
        if (settler.settled()) return;
        const leftover = backlogEnd - backlogStart;
        if (leftover > 0 && !this.expectedClose) {
          releaseBacklogLease();
          settler.settleFail(new ConnectFrameError(
            "frame_incomplete",
            `Cursor Connect stream ended with ${leftover} unconsumed bytes (incomplete frame)`,
          ));
          return;
        }
        if (this.framesReceived === 0 && !this.expectedClose) {
          releaseBacklogLease();
          settler.settleFail(new Error("Cursor stream ended before any response frame (unexpected EOF)"));
          return;
        }
        // `emittedTerminal` joins dev's two conditions so EOF finalization cannot append a
        // second terminal after a mapper error already failed the turn (integration 010).
        if (state.terminated || this.expectedClose || this.emittedTerminal) {
          releaseBacklogLease();
          settler.settleFinish();
          return;
        }
        // Open tools fail-closed as a truncation *event* (finalizeTurnEvents), not a thrown
        // transport error. settleFail here would hide that typed message as adapter_eof.
        if (state.openToolCalls.size > 0) {
          for (const event of finalizeTurnEvents(state)) push(event);
          releaseBacklogLease();
          settler.settleFinish();
          return;
        }
        if (this.framesReceived > 0 && this.sawAssistantText) {
          for (const event of finalizeTurnEvents(state)) push(event);
          releaseBacklogLease();
          settler.settleFinish();
          return;
        }
        releaseBacklogLease();
        settler.settleFinish();
      }).catch((err) => {
        failAndClear(err instanceof Error ? err : new Error(String(err)));
      });
    };

    if (useHttp1) {
      const providerFetch = this.input.fetch
        ?? (this.input.provider as OcxProviderConfig & { fetch?: typeof globalThis.fetch }).fetch;
      this.http1Connection = new CursorHttp1BidiConnection({
        baseUrl,
        token: this.token,
        clientVersion: CURSOR_CLIENT_VERSION,
        sessionId: this.sessionId,
        requestId,
        translatorBudget: this.translatorBudget,
        callbacks: {
          onCommitted: () => {
            this.committed = true;
            debugProviderDiagnostic("cursor", "connected", {
              transport: "http1.1",
              connectMs: Date.now() - this.turnStartedAt,
            });
          },
          onData,
          onEnd: onStreamEnd,
          onError: onStreamError,
        },
        ...(providerFetch ? { fetch: providerFetch } : {}),
      });
      this.http1Connection.start();
    } else {
      session!.on("error", onSessionError);
      stream!.on("data", onData);
      stream!.on("trailers", onTrailers);
      stream!.on("error", onStreamError);
      stream!.on("end", onStreamEnd);
    }

    signal?.addEventListener("abort", () => {
      this.close();
      failAndClear(new Error("Cursor request was aborted"));
    }, { once: true });
    // Close the race between the preflight above and listener installation. No request payload is
    // written until after this check.
    if (signal?.aborted) {
      this.close();
      failAndClear(signal.reason instanceof Error ? signal.reason : new Error("Cursor request was aborted"));
      return;
    }

    this.writeConnectFrame(encodeConnectFrame(encodedRequest));
    this.heartbeat = setInterval(() => {
      this.writeConnectFrame(encodeClientMessage({
        message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
      }));
    }, HEARTBEAT_MS);
  }

  capturedConversationCheckpoint(): Uint8Array | undefined {
    return this.capturedCheckpointBytes;
  }

  private async handleServerMessage(
    message: AgentServerMessage,
    state: ReturnType<typeof createCursorProtobufEventState>,
    push: (message: CursorServerMessage) => void,
  ): Promise<void> {
    if (!this.stream && !this.http1Connection) return;
    debugProviderDiagnostic("cursor", "frame", describeCursorServerFrame(message));
    if (message.message.case === "conversationCheckpointUpdate") {
      try {
        this.capturedCheckpointBytes = toBinary(ConversationStateStructureSchema, message.message.value);
      } catch {
        this.capturedCheckpointBytes = undefined;
      }
    }
    if (message.message.case === "kvServerMessage") {
      this.writeConnectFrame(encodeConnectFrame(handleCursorNativeKv(message.message.value, this.blobRequestScope)));
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
      // Native exec/MCP is handled inside this transport and can mutate files/process state
      // without emitting a Responses tool event. Mark the turn replay-unsafe before executing so
      // an eventual invalid_argument cannot cause the adapter's fresh-conversation fallback to
      // run the same local action twice.
      push({ type: "local_side_effect" });
      const replies = await handleCursorNativeExec(message.message.value, this.execContext);
      for (const reply of replies) this.writeConnectFrame(encodeConnectFrame(reply));
      return;
    }
    if (message.message.case === "interactionQuery") {
      // The server-side agent BLOCKS until this query is answered with the matching id; leaving it
      // unanswered is the proven stall → watchdog → upstream-502 mechanism. Reply immediately with
      // the non-interactive default and emit liveness so the bridge watchdog sees progress.
      const query = message.message.value;
      const plan = planInteractionQueryReply(query);
      debugProviderDiagnostic("cursor", "interaction-query", { id: query.id, queryCase: query.query.case ?? "unknown", reply: plan.replyCase });
      this.writeConnectFrame(encodeClientMessage({ message: { case: "interactionResponse", value: plan.response } }));
      if (!state.terminated) {
        if (plan.planText) {
          this.sawAssistantText = true;
          push({ type: "text", text: plan.planText });
        }
        push({ type: "heartbeat" });
      }
      return;
    }
    // A completion may carry only callId. Capture its ownership before mapping removes the open
    // call, because the embedded-tool classifier cannot identify that valid compact frame.
    const update = message.message.case === "interactionUpdate" ? message.message.value.message : undefined;
    if (update?.case === "turnEnded") {
      // T03: the application turn is complete. Close our side of HTTP/2 after a short
      // grace so a held-open server response cannot pin the turn to the bridge's idle
      // timeout (senpi #1062). finalizeTurnEvents already emitted done via the mapper.
      this.closeAfterTurnEnded();
    }
    const completesOpenClientTool = update?.case === "toolCallCompleted"
      && state.openToolCalls.has(update.value.callId);
    const awaitedNativeArgsBeforeMapping = update?.case === "toolCallCompleted"
      && state.openToolCalls.get(update.value.callId)?.awaitingNativeArgs === true;
    const mapped = mapCursorProtobufServerMessage(message, state);
    if (mapped.some(event => event.type === "text")) this.sawAssistantText = true;
    const beganAwaitingNativeClientToolArgs = update?.case === "toolCallCompleted"
      && !awaitedNativeArgsBeforeMapping
      && state.openToolCalls.get(update.value.callId)?.awaitingNativeArgs === true;
    if (mapped.length > 0) {
      // A client tool call announced/committed via interactionUpdate (toolCallStarted/partialToolCall/
      // toolCallCompleted) changes the call set, so revoke any finalize armed by an earlier drain.
      // A completion can also commit and drain a late call without a following mcpArgs frame; in
      // that case re-arm finalization here so the Responses bridge does not wait forever.
      const clientToolFrame = completesOpenClientTool || isClientToolFrame(message);
      if (clientToolFrame) this.noteClientToolActivity();
      for (const event of mapped) push(event);
      if (
        clientToolFrame
        && state.openToolCalls.size === 0
        && mapped.some(event => event.type === "tool_call_end")
      ) this.scheduleClientToolFinalize(state, push);
      return;
    }
    // The frame produced no outward Responses event (e.g. toolCallStarted / partialToolCall args
    // buffering, a completion waiting for native args, toolCallDelta, tokenDelta, or a checkpoint
    // update). Tool-call protocol events are deferred to completion for atomic, parallel-safe
    // emission, so a turn that silently assembles several tool calls can otherwise exceed the
    // bridge's stall watchdog (upstream_stall_timeout).
    // Emit a liveness heartbeat for these progress frames so the watchdog sees the upstream is alive.
    // Never after a terminal (done/truncation): a stray post-terminal frame must stay fully inert.
    if (!state.terminated && (isCursorProgressFrame(message) || beganAwaitingNativeClientToolArgs)) {
      if (isClientToolFrame(message) || beganAwaitingNativeClientToolArgs) this.noteClientToolActivity();
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
  const hasCurrentCheckpoint = Number.isFinite(state.contextTokens) && (state.contextTokens ?? 0) > 0;
  const hasCurrentOutput = Number.isFinite(out) && out > 0;
  // A carry-forward value belongs to an earlier successful turn. It can complete current-turn
  // usage math after this turn emits output, but cannot by itself prove that a first-frame failure
  // consumed anything.
  if (!hasCurrentCheckpoint && !hasCurrentOutput) return undefined;
  // Same resolution order as a clean turn, so a failed turn does not silently drop
  // back to inputTokens=0 when only the request-local estimate is available (#373).
  return { ...resolvedTurnUsage(state), estimated: true };
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
  } else if (message.message.case === "conversationCheckpointUpdate") {
    out.usedTokens = message.message.value.tokenDetails?.usedTokens ?? 0;
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

export function capturedCursorCheckpointBytes(transport: CursorTransport): Uint8Array | undefined {
  return transport.capturedConversationCheckpoint?.();
}
