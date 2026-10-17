import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxUsage } from "../../types";
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "../base";
import { mapReasoningEffort } from "../../reasoning-effort";
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
  StepCliSession,
  StepSessionError,
  type StepSessionDeps,
  type StepSessionEvent,
} from "./session";
import { StepSessionPool, type StepConversationRef } from "./session-pool";
import { buildStepSdkTools, resolveStepToolName, StepToolCatalogError } from "./tool-bridge";
import {
  STEP_CLI_CONTINUATION_KEY,
  STEP_CLI_HOST,
  STEP_CLI_TOOL_SERVER,
} from "./constants";

export interface StepCliAdapterDeps extends StepSessionDeps {
  /** Injection seam so tests never spawn a real CLI. */
  openSession?: StepSessionPool;
  now?: () => number;
}

/** State the client echoes back so a conversation finds its process again. */
type StepProviderState = { step: { handle: string; sessionId: string } };

/**
 * Recover the conversation handle the client echoed back.
 *
 * The proxy strips its own owner metadata before an adapter sees the state, and routes the provider
 * slot by name, so reading the provider key is the whole contract.
 */
function readContinuation(parsed: OcxParsedRequest): StepConversationRef | undefined {
  const step = parsed._providerContinuation?.[STEP_CLI_CONTINUATION_KEY] as StepConversationRef | undefined;
  if (!step || typeof step.handle !== "string" || step.handle.length === 0) return undefined;
  return { handle: step.handle, sessionId: typeof step.sessionId === "string" ? step.sessionId : "" };
}

function continuationFor(ref: StepConversationRef): StepProviderState {
  return { [STEP_CLI_CONTINUATION_KEY]: { handle: ref.handle, sessionId: ref.sessionId } };
}

function refusal(message: string, status: number, code: string, errorType = "invalid_request_error"): AdapterEvent {
  return { type: "error", message, status, errorType, code, retryable: false };
}

/**
 * Refuse image input the way the Qoder and Claude Code rows do.
 *
 * `query.input` does parse an image block and carry it to the model, but this route publishes
 * text-only models, and an image the harness silently drops produces a confident answer to the wrong
 * question. An operator with the vision sidecar on the request path still gets pictures captioned
 * into text before they reach here.
 */
function hasImageInput(parsed: OcxParsedRequest): boolean {
  return parsed.context.messages.some(message =>
    Array.isArray(message.content) && message.content.some(part => part.type === "image"),
  );
}

/**
 * The text StepCode should be asked for on this turn.
 *
 * Only the final user message crosses `query.input`; earlier turns live in the process' session,
 * because the wire reduces every message to text and images. When the client's last message is a
 * tool result the turn continues the existing query instead of starting a new prompt.
 */
function pendingUserText(parsed: OcxParsedRequest): string | undefined {
  for (let index = parsed.context.messages.length - 1; index >= 0; index -= 1) {
    const message = parsed.context.messages[index];
    if (!message || message.role !== "user") continue;
    if (!Array.isArray(message.content)) {
      return typeof message.content === "string" && message.content.length > 0 ? message.content : undefined;
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

function toUsage(usage: Record<string, unknown> | undefined): OcxUsage | undefined {
  if (!usage) return undefined;
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
 * Run Codex turns against a StepCode subscription.
 *
 * One StepCode process serves one conversation, and this adapter never executes a tool itself: it
 * declares the client's catalog as StepCode SDK tools, allows the permission check the client's own
 * request already implies, and holds the tool call open so the result the client computes on its next
 * request is delivered back into the query the model is running. That is the same shape as the Claude
 * Code route, except the tool channel is the stdio protocol's reverse requests rather than a
 * capture-only MCP server.
 */
export function createStepCliAdapter(provider: OcxProviderConfig, deps: StepCliAdapterDeps = {}): ProviderAdapter {
  const profile: StepCliProfile | undefined = resolveStepCliProfile(provider.baseUrl);
  let pool: StepSessionPool | undefined = deps.openSession;
  let activeTurn: { session: StepCliSession; emit: (event: AdapterEvent) => void } | undefined;

  const handlers = {
    onEvent(event: StepSessionEvent): void {
      if (event.type === "reverse_request") {
        handleReverseRequest(event.frame);
        return;
      }
      handleRuntimeEvent(event.frame);
    },
  };

  function handleReverseRequest(frame: { id: string; method?: string; payload?: unknown }): void {
    const session = activeTurn?.session;
    if (!session) return;
    if (frame.method === "permission.request") {
      // The client asked for this call; the approval already happened upstream of this adapter.
      session.allowPermission(frame as never);
      return;
    }
    if (frame.method === "sdk_tool.invoke") {
      const payload = (frame.payload ?? {}) as { input?: unknown; toolUseId?: string };
      const declaredName = String((payload as { toolName?: string }).toolName ?? "");
      const wireName = declaredName.startsWith(`${STEP_CLI_TOOL_SERVER}__`)
        ? declaredName.slice(STEP_CLI_TOOL_SERVER.length + 2)
        : declaredName;
      const clientName = activeTurnName.get(session);
      const resolved = clientName ? resolveStepToolName(declaredName, clientName) : undefined;
      if (!resolved) {
        session.denyPermission(frame as never, `OpenCodex did not declare ${declaredName || "this tool"} for this turn.`);
        return;
      }
      const callId = typeof payload.toolUseId === "string" && payload.toolUseId.length > 0
        ? payload.toolUseId
        : `call_${frame.id}`;
      pendingCalls.set(session, { wireName: resolved, callId, input: asRecord(payload.input) });
      heldToolFrames.set(session, frame.id);
      // End the turn here: the client executes the tool and reports it on the next request, which is
      // what releases this held reverse request. Nothing is invented in between.
      activeTurn?.emit({ type: "tool_call_start", id: callId, name: resolved });
      activeTurn?.emit({
        type: "tool_call_delta",
        arguments: JSON.stringify(asRecord(payload.input)),
      });
      activeTurn?.emit({ type: "tool_call_end" });
      activeTurn?.emit({ type: "done", stopReason: "tool_use" });
      activeTurn = undefined;
      return;
    }
    // An unknown reverse method is answered rather than left to time out inside the model.
    session.denyPermission(frame as never, `OpenCodex does not handle ${frame.method ?? "this request"}.`);
  }

  function handleRuntimeEvent(frame: { kind: string; method?: string; payload?: unknown }): void {
    const turn = activeTurn;
    if (!turn) return;
    const payload = asRecord(frame.payload);
    const type = typeof payload.type === "string" ? payload.type : undefined;
    if (type === "stream_event") {
      const event = asRecord(payload.event);
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
    if (type === "status" && payload.status === "turn_complete") {
      const assistant = lastAssistant.get(turn.session);
      turn.emit({
        type: "done",
        ...(assistant ? { usage: assistant } : {}),
        stopReason: "stop",
      });
      activeTurn = undefined;
      return;
    }
    if (type === "permission_denied") {
      turn.emit({
        type: "error",
        message: `StepCode refused a tool call: ${typeof payload.message === "string" ? payload.message : "denied"}`,
        status: 400,
        errorType: "invalid_request_error",
        code: "step_cli_permission_denied",
        retryable: false,
      });
      activeTurn = undefined;
    }
  }

  const pendingCalls = new WeakMap<StepCliSession, { wireName: string; callId: string; input: Record<string, unknown> }>();
  const heldToolFrames = new WeakMap<StepCliSession, string>();
  const activeTurnName = new WeakMap<StepCliSession, Map<string, string>>();
  const lastAssistant = new WeakMap<StepCliSession, OcxUsage>();

  function ensurePool(): StepSessionPool {
    if (!pool) {
      const home = getConfigDir();
      const { env, cwd } = stepCliProcessEnvironment(home);
      const thinkingFor = (parsed: OcxParsedRequest): string | undefined => {
        const effort = mapReasoningEffort(provider, parsed.modelId, parsed.options.reasoning);
        return effort === "minimal" ? "off" : effort;
      };
      pool = new StepSessionPool(
        {
          openCodexHome: home,
          idleTimeoutMs: 10 * 60_000,
          buildOptions: () => ({
            binary: resolveStepCliBinaryPath(deps.which),
            args: buildStepCliArgs(undefined, undefined),
            env,
            cwd,
            handshakeTimeoutMs: 30_000,
            requestTimeoutMs: 120_000,
            reverseRequestHoldMs: 110_000,
            idleTimeoutMs: 10 * 60_000,
            killGraceMs: 2_000,
          }),
        },
        handlers,
        deps,
      );
      void thinkingFor;
    }
    return pool;
  }

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

      const sessions = ensurePool();
      const continuation = readContinuation(parsed);
      const ref = continuation ?? sessions.nextRef();
      let session: StepCliSession;
      try {
        session = await sessions.open(ref);
        await session.handshake();
      } catch (error) {
        emit(mapSessionFailure(error));
        return;
      }

      // A tool result the client computed on its previous request goes back first: it releases the
      // reverse request this session is holding, and the model continues the same query.
      const heldId = sessions.takeHeldTool(ref);
      if (heldId) {
        const result = latestToolResult(parsed);
        const delivered = session.resolveHeldToolResult(
          { id: heldId, method: "sdk_tool.invoke" } as never,
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
      }

      const userText = pendingUserText(parsed);
      if (!userText) {
        emit(
          refusal(
            "StepCode carries conversation history inside its own process, so a turn must end with either user text or a tool result.",
            400,
            "step_cli_no_user_text",
          ),
        );
        return;
      }

      activeTurn = { session, emit };
      activeTurnName.set(session, tools.emittedNameMap);
      try {
        const { queryId } = await session.startQuery({
          model: stepModelId(parsed.modelId),
          maxThinkingTokens: stepThinkingTokens(parsed),
          sdkTools: tools.sdkTools,
          streamingInput: true,
        });
        await session.sendInput(queryId, composePrompt(parsed, userText));
      } catch (error) {
        activeTurn = undefined;
        emit(mapSessionFailure(error));
        await session.close();
      }
    },
  };
}

/** StepCode model ids carry no provider prefix; the CLI owns its own default provider. */
function stepModelId(modelId: string): string {
  return modelId.startsWith(`${STEP_CLI_TOOL_SERVER}/`)
    ? modelId.slice(STEP_CLI_TOOL_SERVER.length + 1)
    : modelId;
}

/** StepCode's per-query thinking control is a token budget, so the effort has to be converted. */
function stepThinkingTokens(parsed: OcxParsedRequest): number | undefined {
  const effort = parsed.options.reasoning;
  if (typeof effort !== "string" || effort === "none") return undefined;
  const table: Record<string, number> = { minimal: 1024, low: 4096, medium: 16384, high: 32768, xhigh: 65536, max: 65536 };
  return table[effort] ?? table.high;
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

/** The newest tool result in the request, if this turn is the answer to a captured call. */
function latestToolResult(parsed: OcxParsedRequest): { content: readonly unknown[]; isError?: boolean } | undefined {
  for (let index = parsed.context.messages.length - 1; index >= 0; index -= 1) {
    const message = parsed.context.messages[index];
    if (!message || message.role !== "toolResult") continue;
    const raw = message.content;
    const text = typeof raw === "string"
      ? raw
      : raw
          .filter(part => part.type === "text")
          .map(part => (part as { text: string }).text)
          .join("");
    return { content: [{ type: "text", text }], ...(message.isError ? { isError: true } : {}) };
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Translate a transport failure into the actionable error an operator can act on. */
function mapSessionFailure(error: unknown): AdapterEvent {
  if (!(error instanceof StepSessionError)) {
    return { type: "error", message: error instanceof Error ? error.message : String(error), retryable: true };
  }
  if (error.code === "step_cli_binary_missing") {
    return refusal(error.message, 400, error.code);
  }
  if (error.code === "step_cli_capability_missing") {
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
    return { type: "error", message: error.message, status: 504, errorType: "upstream_error", code: "timeout", retryable: true };
  }
  return { type: "error", message: error.message, status: 502, errorType: "upstream_error", code: error.code, retryable: true };
}

export { STEP_CLI_PROFILE };
