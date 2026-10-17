import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxUsage } from "../../types";
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "../base";
import { buildSystemPrompt } from "../coding-agent/protocol";
import { getConfigDir } from "../../config/paths";
import {
  buildStepCliArgs,
  resolveStepCliProfile,
  STEP_CLI_PROFILE,
  type StepCliProfile,
} from "./profiles";
import {
  resolveStepCliBinaryPath,
  stepCliProcessEnvironment,
  type StepCliSession,
  StepSessionError,
  type StepSessionDeps,
  type StepSessionEvent,
} from "./session";
import { StepSessionPool, type StepConversationRef } from "./session-pool";
import { buildStepSdkTools, resolveStepToolName, StepToolCatalogError } from "./tool-bridge";
import { STEP_CLI_CONTINUATION_KEY, STEP_CLI_HOST, STEP_CLI_TOOL_SERVER } from "./constants";
import type { StepFrame } from "./stdio-frames";

export interface StepCliAdapterDeps extends StepSessionDeps {
  /** Injection seam so tests never spawn a real CLI. */
  openSession?: StepSessionPool;
}

/** `providerState` slot carrying the conversation handle between requests. */
type StepProviderState = { [STEP_CLI_CONTINUATION_KEY]: { handle: string; sessionId: string } };

/**
 * How long a conversation's process survives without traffic.
 *
 * Long enough that a Codex thread's pauses between turns do not tear the conversation down, short
 * enough that an abandoned thread does not leave a StepCode process running.
 */
const STEP_CLI_IDLE_TIMEOUT_MS = 10 * 60_000;

/**
 * Per-request turn state, keyed by the process that owns it.
 *
 * `createStepCliAdapter` runs once per request, so nothing that has to survive a request boundary can
 * live in its closure: a reverse request arriving during request N+1 would be routed to an instance
 * that no longer exists, and the conversation would silently restart. `devin/trajectory.ts` keeps its
 * conversation map at module scope for the same reason.
 */
interface StepTurnRuntime {
  ref: StepConversationRef;
  pool: StepSessionPool;
  emit: (event: AdapterEvent) => void;
  settle: () => void;
  done: Promise<void>;
  emittedNames: Map<string, string>;
}

const turnRuntimes = new WeakMap<StepCliSession, StepTurnRuntime>();
const lastAssistantUsage = new WeakMap<StepCliSession, OcxUsage>();

/** One pool per OpenCodex home, so two homes in one process never share a StepCode session. */
const pools = new Map<string, StepSessionPool>();

/** Drop every live session. Used by tests and available to a config reload. */
export async function clearStepCliSessions(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map(pool => pool.closeAll()));
}

function poolFor(home: string, deps: StepCliAdapterDeps): StepSessionPool {
  const existing = pools.get(home);
  if (existing) return existing;
  const { env, cwd } = stepCliProcessEnvironment(home);
  const pool = new StepSessionPool(
    {
      openCodexHome: home,
      idleTimeoutMs: STEP_CLI_IDLE_TIMEOUT_MS,
      buildOptions: () => ({
        binary: resolveStepCliBinaryPath(deps.which),
        args: buildStepCliArgs(undefined, undefined),
        env,
        cwd,
        handshakeTimeoutMs: 30_000,
        requestTimeoutMs: 120_000,
        // StepCode's own tool window is 120s and answering later produces a `permission_denied`
        // message inside the model's context, so the hold is bounded shorter and fails the turn.
        reverseRequestHoldMs: 110_000,
        idleTimeoutMs: STEP_CLI_IDLE_TIMEOUT_MS,
        killGraceMs: 2_000,
      }),
    },
    sessionHandlers,
    deps,
  );
  pools.set(home, pool);
  return pool;
}

/**
 * A reverse request the CLI is waiting on this peer to answer.
 *
 * `permission.request` is allowed immediately because the approval already happened upstream of this
 * adapter. A `sdk_tool.invoke` is deliberately NOT answered here: its result only exists once the
 * client has executed the tool and sent its next request, and answering it is how that result reaches
 * the model inside the query the model is already running.
 */
function handleReverseRequest(session: StepCliSession, frame: StepFrame): void {
  const turn = turnRuntimes.get(session);
  if (!turn) return;

  if (frame.method === "permission.request") {
    session.allowPermission(frame);
    return;
  }

  if (frame.method === "sdk_tool.invoke") {
    const payload = (frame.payload ?? {}) as {
      input?: unknown;
      toolUseId?: string;
      serverName?: string;
      toolName?: string;
    };
    // The descriptor's `toolName` is BARE; the name StepCode registered is
    // `${serverName}__${toolName}`. Recomposing the wire name from both fields is what makes the
    // lookup work, and a lookup that misses has to refuse rather than guess.
    const serverName = typeof payload.serverName === "string" ? payload.serverName : "";
    const bareName = typeof payload.toolName === "string" ? payload.toolName : "";
    const wireName = serverName && bareName ? `${serverName}__${bareName}` : bareName;
    const resolved = resolveStepToolName(wireName, turn.emittedNames);
    if (!resolved) {
      session.refuseToolCall(
        frame,
        `OpenCodex did not declare ${wireName || "this tool"} for this turn, so the call was not executed.`,
      );
      return;
    }
    const callId =
      typeof payload.toolUseId === "string" && payload.toolUseId.length > 0
        ? payload.toolUseId
        : `call_${frame.id}`;
    turn.pool.rememberHeldTool(turn.ref, frame.id);
    turn.emit({ type: "tool_call_start", id: callId, name: resolved });
    turn.emit({ type: "tool_call_delta", arguments: JSON.stringify(asRecord(payload.input)) });
    turn.emit({ type: "tool_call_end" });
    turn.emit({
      type: "done",
      stopReason: "tool_use",
      providerState: continuationFor(turn.ref, session.sessionId),
    });
    turnRuntimes.delete(session);
    turn.settle();
    return;
  }

  // An unrecognised reverse method still needs an answer rather than being left to expire inside the
  // model's context.
  session.denyPermission(frame, `OpenCodex does not handle ${frame.method ?? "this request"}.`);
}

/**
 * Map one runtime frame onto the client's event stream.
 *
 * The framed protocol nests the projected message: a frame is `{queryId, message: {...}}` and the
 * event type lives at `message.type`, NOT at `payload.type` the way `step --mode json` prints it.
 * Reading the wrong level makes every turn look idle until it times out, so the nesting is resolved
 * once here and every branch below works off the inner message.
 */
function handleRuntimeEvent(session: StepCliSession, frame: StepFrame): void {
  const turn = turnRuntimes.get(session);
  if (!turn) return;
  const payload = asRecord(frame.payload);
  const message = asRecord(payload.message ?? payload);
  const type = typeof message.type === "string" ? message.type : undefined;

  if (type === "stream_event") {
    const event = asRecord(message.event);
    const delta = asRecord(event.delta);
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      turn.emit({ type: "text_delta", text: delta.text });
      return;
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      turn.emit({ type: "thinking_delta", thinking: delta.thinking });
    }
    return;
  }

  if (type === "assistant") {
    const usage = toUsage(asRecord(asRecord(message.message).usage));
    if (usage) lastAssistantUsage.set(session, usage);
    return;
  }

  if (type === "status" && (message.status === "turn_complete" || message.status === "done")) {
    const usage = lastAssistantUsage.get(session);
    turn.emit({
      type: "done",
      ...(usage ? { usage } : {}),
      stopReason: "stop",
      providerState: continuationFor(turn.ref, session.sessionId),
    });
    turnRuntimes.delete(session);
    turn.settle();
    return;
  }

  if (type === "permission_denied") {
    turn.emit({
      type: "error",
      message: `StepCode refused a tool call: ${typeof message.message === "string" ? message.message : "denied"}`,
      status: 400,
      errorType: "invalid_request_error",
      code: "step_cli_permission_denied",
      retryable: false,
    });
    turnRuntimes.delete(session);
    turn.settle();
  }
}

const sessionHandlers = {
  onEvent(event: StepSessionEvent): void {
    if (event.type === "reverse_request") {
      handleReverseRequest(event.session, event.frame);
      return;
    }
    handleRuntimeEvent(event.session, event.frame);
  },
};

function refusal(
  message: string,
  status: number,
  code: string,
  errorType = "invalid_request_error",
): AdapterEvent {
  return { type: "error", message, status, errorType, code, retryable: false };
}

/**
 * Refuse image input the way the Qoder and Claude Code rows do.
 *
 * `query.input` does carry an image block to the model, but this route publishes text-only models,
 * and an image the harness silently drops produces a confident answer to the wrong question. An
 * operator with the vision sidecar on the request path still gets pictures captioned into text.
 */
function hasImageInput(parsed: OcxParsedRequest): boolean {
  return parsed.context.messages.some(message =>
    Array.isArray(message.content) && message.content.some(part => part.type === "image"),
  );
}

/**
 * Identify the conversation this request belongs to.
 *
 * StepCode keeps a conversation only inside one process, so every request of a Codex thread has to
 * land on the same session. The thread identity is what Codex already sends on EVERY request —
 * `thread-id`, then the session-affinity headers — which is the resolution `devin`, `zed`, `cursor`
 * and `google` use, and it works on the first request of a conversation. `previous_response_id` and
 * the proxy's continuation store are only fallbacks: depending on persisted provider state would mean
 * a conversation silently restarting whenever that store misses an entry.
 */
function conversationHandle(parsed: OcxParsedRequest, incoming: IncomingMeta): string {
  const own = incoming.headers.get("thread-id")?.trim() || parsed._codexOwnThreadId?.trim();
  if (own) return `own:${own}`;
  const affinity =
    incoming.headers.get("session_id")?.trim() ||
    incoming.headers.get("session-id")?.trim() ||
    incoming.headers.get("x-session-affinity")?.trim();
  if (affinity) return `session:${affinity}`;
  // A parent thread id belongs to the SUB-agent it spawned, so it must not be read as this turn's own
  // conversation; it is only consulted when no parent is present.
  if (!incoming.headers.has("x-codex-parent-thread-id")) {
    const client = parsed._clientThreadId?.trim();
    if (client) return `client:${client}`;
  }
  if (parsed.previousResponseId) return `response:${parsed.previousResponseId}`;
  return "default";
}

function continuationFor(ref: StepConversationRef, sessionId: string | undefined): StepProviderState | undefined {
  if (!ref) return undefined;
  return { [STEP_CLI_CONTINUATION_KEY]: { handle: ref.handle, sessionId: sessionId ?? ref.sessionId } };
}

/** The newest tool result in the request, if this turn is the answer to a captured call. */
export function latestToolResult(
  parsed: OcxParsedRequest,
): { content: readonly unknown[]; isError?: boolean } | undefined {
  for (let index = parsed.context.messages.length - 1; index >= 0; index -= 1) {
    const message = parsed.context.messages[index];
    if (!message || message.role !== "toolResult") continue;
    const raw = message.content;
    const text =
      typeof raw === "string"
        ? raw
        : raw
            .filter(part => part.type === "text")
            .map(part => (part as { text: string }).text)
            .join("");
    return { content: [{ type: "text", text }], ...(message.isError ? { isError: true } : {}) };
  }
  return undefined;
}

function toUsage(usage: Record<string, unknown>): OcxUsage | undefined {
  const input = typeof usage.input === "number" ? usage.input : undefined;
  const output = typeof usage.output === "number" ? usage.output : undefined;
  if (input === undefined && output === undefined) return undefined;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(typeof usage.cacheRead === "number" ? { cachedInputTokens: usage.cacheRead } : {}),
  };
}

/**
 * StepCode model ids carry no provider prefix; the CLI owns its own default provider.
 */
function stepModelId(modelId: string): string {
  return modelId.startsWith(`${STEP_CLI_TOOL_SERVER}/`)
    ? modelId.slice(STEP_CLI_TOOL_SERVER.length + 1)
    : modelId;
}

/**
 * StepCode's per-query thinking control is a token budget, so an effort has to be converted.
 *
 * The mapping is deliberately lossy and the registry only advertises the three rungs Step actually
 * serves, so a client never believes it chose a depth it did not.
 */
function stepThinkingTokens(parsed: OcxParsedRequest): number | undefined {
  const effort = parsed.options.reasoning;
  if (typeof effort !== "string" || effort === "none") return undefined;
  const table: Record<string, number> = {
    minimal: 1_024,
    low: 4_096,
    medium: 16_384,
    high: 32_768,
    xhigh: 65_536,
    max: 65_536,
  };
  return table[effort] ?? table.high!;
}

/**
 * Fold the caller's instructions into the one user message this hop can carry.
 *
 * StepCode cannot replace its session system prompt, so its own coding instructions stay in front of
 * the model's answers. Prepending the client's own instructions keeps the turn answerable under the
 * contract the client believes it set.
 */
function composePrompt(parsed: OcxParsedRequest, userText: string): string {
  const system = buildSystemPrompt(parsed);
  return system ? `${system}\n\n${userText}` : userText;
}

/** Resolves when the client aborts, so a turn in flight does not outlive its request. */
function abortSignal(incoming: IncomingMeta): Promise<void> {
  const signal = incoming.abortSignal;
  if (!signal) return new Promise<void>(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>(resolve => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Translate a transport failure into the actionable error an operator can act on. */
function mapSessionFailure(error: unknown): AdapterEvent {
  if (!(error instanceof StepSessionError)) {
    return {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
  if (error.code === "step_cli_binary_missing" || error.code === "step_cli_capability_missing") {
    return refusal(error.message, 400, error.code);
  }
  if (/not signed in|please run \/login|未登录/i.test(error.message)) {
    return {
      type: "error",
      message:
        "StepCode is not signed in, so this subscription provider has no account to spend. " +
        `Run \`step login\` once and retry. CLI reported: ${error.message}`,
      status: 401,
      errorType: "authentication_error",
      code: "step_cli_not_logged_in",
      retryable: false,
    };
  }
  if (/quota|credit|429|rate limit/i.test(error.message)) {
    return {
      type: "error",
      message: error.message,
      status: 429,
      errorType: "rate_limit_error",
      code: "step_cli_subscription_cooldown",
      retryable: false,
    };
  }
  if (/did not answer .* in time|timed out/i.test(error.message)) {
    return {
      type: "error",
      message: error.message,
      status: 504,
      errorType: "upstream_error",
      code: "timeout",
      retryable: true,
    };
  }
  return {
    type: "error",
    message: error.message,
    status: 502,
    errorType: "upstream_error",
    code: error.code,
    retryable: true,
  };
}

/**
 * Run Codex turns against a StepCode subscription.
 *
 * One StepCode process serves one conversation, and this adapter never executes a tool itself: it
 * declares the client's catalog as StepCode SDK tools, allows the permission check the client's own
 * request already implies, and holds the tool call open so the result the client computes on its next
 * request is delivered back into the query the model is running.
 */
export function createStepCliAdapter(
  provider: OcxProviderConfig,
  deps: StepCliAdapterDeps = {},
): ProviderAdapter {
  const profile: StepCliProfile | undefined = resolveStepCliProfile(provider.baseUrl);

  return {
    name: STEP_CLI_HOST,

    buildRequest(): AdapterRequest {
      return { url: provider.baseUrl, method: "POST", headers: {}, body: "" };
    },
    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield {
        type: "error",
        message: "StepCode CLI adapter uses runTurn; the fetch/parseStream path is disabled.",
      };
    },

    async runTurn(parsed, incoming, emit): Promise<void> {
      if (!profile) {
        emit(
          refusal(
            "This provider row is not pointed at StepCode's canonical destination, so the CLI's own account is never reached.",
            400,
            "step_cli_profile_mismatch",
          ),
        );
        return;
      }
      if (incoming.abortSignal?.aborted) {
        emit({ type: "error", message: "StepCode turn was aborted before start.", retryable: false });
        return;
      }
      if (hasImageInput(parsed)) {
        emit(
          refusal(
            "StepCode image input is not enabled because this CLI route has no verified multimodal contract.",
            400,
            "unsupported_input_modality",
          ),
        );
        return;
      }

      let tools: ReturnType<typeof buildStepSdkTools>;
      try {
        tools = buildStepSdkTools(parsed, STEP_CLI_TOOL_SERVER);
      } catch (error) {
        if (!(error instanceof StepToolCatalogError)) throw error;
        emit(refusal(`Invalid StepCode tool catalog: ${error.message}`, 400, "tool_catalog_invalid"));
        return;
      }

      const sessions = deps.openSession ?? poolFor(getConfigDir(), deps);
      const ref: StepConversationRef = { handle: conversationHandle(parsed, incoming), sessionId: "" };

      let session: StepCliSession;
      try {
        session = await sessions.open(ref);
        await session.handshake();
      } catch (error) {
        emit(mapSessionFailure(error));
        return;
      }

      // A tool result the client computed on its previous request goes back first: it releases the
      // reverse request this session is holding, and the model continues inside the same query.
      const heldFrameId = sessions.takeHeldTool(ref);
      let continuedQuery = false;
      if (heldFrameId) {
        const result = latestToolResult(parsed);
        const delivered = session.resolveHeldToolResult(
          { id: heldFrameId, method: "sdk_tool.invoke" } as StepFrame,
          result ?? { content: [{ type: "text", text: "" }], isError: true },
        );
        if (!delivered) {
          emit(
            refusal(
              "The held StepCode tool call expired before the tool result arrived; StepCode only waits two minutes for one.",
              504,
              "step_cli_tool_result_too_late",
              "upstream_error",
            ),
          );
          await session.close();
          return;
        }
        // This turn IS the answer to a captured call. The model already has the instruction and is
        // mid-query, so nothing is prompted again.
        continuedQuery = true;
      }

      const userText = continuedQuery ? undefined : pendingUserText(parsed);
      if (!continuedQuery && !userText) {
        emit(
          refusal(
            "StepCode carries conversation history inside its own process, so a turn must end with either user text or a tool result.",
            400,
            "step_cli_no_user_text",
          ),
        );
        return;
      }

      let settle!: () => void;
      const done = new Promise<void>(resolve => {
        settle = resolve;
      });
      turnRuntimes.set(session, {
        ref,
        pool: sessions,
        emit,
        settle,
        done,
        emittedNames: tools.emittedNameMap,
      });

      try {
        if (!continuedQuery) {
          const { queryId } = await session.startQuery({
            model: stepModelId(parsed.modelId),
            maxThinkingTokens: stepThinkingTokens(parsed),
            sdkTools: tools.sdkTools,
            streamingInput: true,
          });
          await session.sendInput(queryId, composePrompt(parsed, userText ?? ""));
        }
      } catch (error) {
        turnRuntimes.delete(session);
        settle();
        emit(mapSessionFailure(error));
        await session.close();
        return;
      }

      // The turn owns the response until it settles: text, a captured tool call, a completion, or a
      // client abort. Returning before that leaves the stream without a terminal event.
      await Promise.race([done, abortSignal(incoming)]);
      if (turnRuntimes.has(session)) {
        turnRuntimes.delete(session);
        emit({
          type: "error",
          message: "The StepCode turn ended without a terminal event.",
          status: 502,
          errorType: "upstream_error",
          code: "step_cli_turn_abandoned",
          retryable: true,
        });
        settle();
      }
    },
  };
}

/**
 * The text StepCode should be asked for on this turn.
 *
 * Only the final user message crosses `query.input`; earlier turns live in the process' session,
 * because the wire reduces every message to text and images.
 */
function pendingUserText(parsed: OcxParsedRequest): string | undefined {
  for (let index = parsed.context.messages.length - 1; index >= 0; index -= 1) {
    const message = parsed.context.messages[index];
    if (!message || message.role !== "user") continue;
    if (!Array.isArray(message.content)) {
      return typeof message.content === "string" && message.content.length > 0
        ? message.content
        : undefined;
    }
    const text = message.content
      .filter(part => part.type === "text")
      .map(part => (part as { text: string }).text)
      .join("")
      .trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

export { STEP_CLI_PROFILE };
