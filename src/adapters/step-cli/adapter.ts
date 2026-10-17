import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxUsage } from "../../types";
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "../base";
import { buildSystemPrompt } from "../coding-agent/protocol";
import { CODING_AGENT_TOOL_LIMITS } from "../coding-agent/tool-catalog";
import { getConfigDir } from "../../config/paths";
import { registerOptionalShutdownHook } from "../../lib/optional-shutdown-hooks";
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
import {
  StepSessionPool,
  type StepConversationHost,
  type StepConversationRef,
  type StepConversationSession,
} from "./session-pool";
import { buildStepSdkTools, resolveStepToolName, StepToolCatalogError } from "./tool-bridge";
import { STEP_CLI_CONTINUATION_KEY, STEP_CLI_HOST, STEP_CLI_TOOL_SERVER } from "./constants";
import type { StepFrame } from "./stdio-frames";

export interface StepCliAdapterDeps extends StepSessionDeps {
  /** Injection seam so tests drive the real `runTurn` path without a CLI. */
  openSession?: StepConversationHost;
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
  pool: StepConversationHost;
  emit: (event: AdapterEvent) => void;
  settle: () => void;
  done: Promise<void>;
  emittedNames: Map<string, string>;
}

const turnRuntimes = new WeakMap<StepConversationSession, StepTurnRuntime>();
const lastAssistantUsage = new WeakMap<StepConversationSession, OcxUsage>();
/** Query currently owned by each session, so an abandoned turn can interrupt exactly that one. */
const lastQueryId = new WeakMap<StepConversationSession, string>();

/** How many turns may queue behind one conversation before a caller is told to retry. */
const MAX_QUEUED_TURNS = 2;

/**
 * Hard ceiling on waiting for a terminal event from the CLI.
 *
 * The turn would otherwise wait for the client's abort, and a client that never aborts (or a CLI that
 * went quiet) would hold the conversation lock for the life of the process. Set well above
 * StepCode's own 120s tool window so a legitimate slow tool is never cut short.
 */
const STEP_CLI_TERMINAL_DEADLINE_MS = 10 * 60_000;

/**
 * Backoff for re-opening a query the runtime still considers busy.
 *
 * A turn settles when the CLI reports `turn_complete`, which can be a moment before the runtime frees
 * its single query slot. Measured on the real CLI: the very next request on the same conversation then
 * failed with `SESSION_BUSY`. The conversation lock means no other turn of ours is in flight while this
 * runs, so retrying here cannot collide with our own work — it is only bridging the runtime's own
 * handover delay.
 */
const STEP_CLI_QUERY_RETRY_DELAYS_MS = [200, 600, 1500] as const;

interface ConversationLock {
  /** Settles when every queued turn ahead of this one has finished. */
  readonly chain: Promise<void>;
  /** Turns waiting or running; used to refuse an unbounded pile-up. */
  waiters: number;
}

/**
 * Per-conversation serialisation.
 *
 * StepCode serves ONE query per process, and this proxy's turn state is keyed by that process, so two
 * overlapping turns on one conversation overwrite each other's runtime, interrupt each other's query
 * and close each other's session — which is exactly what two clients sharing a `thread-id` produce,
 * and it was measured as both requests failing with `SESSION_NOT_FOUND` and `step_cli_session_closed`.
 * Turns are therefore queued in arrival order.
 *
 * Sequential traffic is unaffected: a turn that finishes before the next arrives takes an empty chain
 * and completes without yielding.
 */
const conversationLocks = new Map<string, ConversationLock>();

async function withConversationLock<T>(handle: string, task: () => Promise<T>): Promise<T> {
  const existing = conversationLocks.get(handle);
  if (existing && existing.waiters >= MAX_QUEUED_TURNS + 1) {
    throw new Error(
      `StepCode serves one turn per conversation at a time and ${existing.waiters} are already queued for this one.`,
    );
  }
  const previous = existing?.chain ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const chain = previous.then(
    () => gate,
    () => gate,
  );
  const entry: ConversationLock = { chain, waiters: (existing?.waiters ?? 0) + 1 };
  conversationLocks.set(handle, entry);
  void chain.finally(() => {
    // Drop the entry once this turn's chain drains, unless a later turn already replaced it — otherwise
    // the map would retain one settled promise per conversation handle for the life of the process.
    if (conversationLocks.get(handle) === entry) conversationLocks.delete(handle);
  });
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    entry.waiters -= 1;
    release();
  }
}

/** One pool per OpenCodex home, so two homes in one process never share a StepCode session. */
const pools = new Map<string, StepSessionPool>();

const STEP_CLI_SHUTDOWN_KEY = "step-cli-sessions";
let shutdownHookInstalled = false;

/**
 * Close every live StepCode process when the proxy stops.
 *
 * The sibling CLI routes spawn a child per request and kill it in a `finally`, so they cannot outlive a
 * turn. This route deliberately keeps a process alive for a whole conversation, which means nothing
 * kills it on shutdown: measured, a stopped proxy left an orphaned `step` behind holding the user's
 * subscription session. Closing them here is the only thing standing between a restart and a leak.
 */
function ensureShutdownHook(): void {
  if (shutdownHookInstalled) return;
  shutdownHookInstalled = true;
  registerOptionalShutdownHook(STEP_CLI_SHUTDOWN_KEY, () => {
    for (const pool of pools.values()) void pool.closeAll();
    pools.clear();
  });
}

/** Drop every live session. Used by tests and available to a config reload. */
export async function clearStepCliSessions(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map(pool => pool.closeAll()));
}

function poolFor(home: string, deps: StepCliAdapterDeps): StepSessionPool {
  ensureShutdownHook();
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
/**
 * Exported for its regression tests: every reverse request must be ANSWERED, and the tests drive this
 * exact function rather than a mirror of it.
 */
export function handleReverseRequest(session: StepConversationSession, frame: StepFrame): void {
  const payload = asRecord(frame.payload);
  const expired = payload.__expired === true;
  const turn = turnRuntimes.get(session);

  if (expired) {
    // The hold elapsed, so the client can never answer this call. Refuse it so StepCode stops waiting
    // instead of burning its own window, and do NOT re-dispatch: the client already received this tool
    // call, and a second `tool_call_start` for the same id would be a duplicate.
    session.refuseToolCall(
      frame,
      "The client did not return a tool result inside the window this transport holds a call for.",
    );
    return;
  }

  // Even with no turn registered, a reverse request must be ANSWERED. Dropping it leaves the runtime
  // waiting out its own 60s/120s window with nothing to show for it, and the client has no way to
  // learn that the call was silently dropped.
  if (frame.method === "permission.request") {
    session.allowPermission(frame);
    return;
  }

  if (frame.method === "sdk_tool.invoke" && !turn) {
    session.refuseToolCall(
      frame,
      "OpenCodex is not expecting a tool call for this conversation right now, so it was not executed.",
    );
    return;
  }

  if (!turn) {
    session.denyPermission(frame, `OpenCodex cannot handle ${frame.method ?? "this request"} outside a turn.`);
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
    turn.pool.rememberHeldTool(turn.ref, { frameId: frame.id, callId });
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
/**
 * Exported with `handleReverseRequest` for the same reason: the CLI's event vocabulary is the other
 * half of this transport, and the terminal-event mapping had no test at all until the suite pointed
 * out that it was the one thing a fake process must be able to deliver.
 */
export function handleRuntimeEvent(session: StepConversationSession, frame: StepFrame): void {
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
    // Release the runtime's single query slot for this conversation's next turn. Skipped when a tool
    // call was captured, which ends the turn earlier and keeps the query alive on purpose.
    const queryId = lastQueryId.get(session);
    if (queryId) {
      lastQueryId.delete(session);
      void session.endInput(queryId);
    }
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
export function conversationHandle(parsed: OcxParsedRequest, incoming: IncomingMeta): string | undefined {
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
  // Deliberately undefined rather than a shared "default": Claude Code, Grok Build and generic Chat
  // clients all send requests with no identity, and collapsing them onto one handle would let one
  // client read another's context and deliver its tool result into another's query. The caller mints
  // a private ref instead, so an identity-less request gets its own process and forgets it.
  return undefined;
}

function continuationFor(ref: StepConversationRef, sessionId: string | undefined): StepProviderState | undefined {
  if (!ref) return undefined;
  return { [STEP_CLI_CONTINUATION_KEY]: { handle: ref.handle, sessionId: sessionId ?? ref.sessionId } };
}

/** The newest tool result in the request, with the call it answers. */

/** A `data:` URL split into the base64 payload and media type StepCode's image block expects. */
function parseInlineImageDataUrl(imageUrl: string): { data: string; mimeType: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(imageUrl);
  if (!match) return undefined;
  return { mimeType: match[1]!, data: match[2]! };
}

/**
 * Project a client tool result into the content blocks StepCode's SDK tool accepts.
 *
 * A tool result is not necessarily text. Codex's `view_image` returns an image part, and collapsing
 * that to an empty text block is the same misleading-empty-result failure the wrong-call path already
 * had: the model reports a tool that "returned nothing" instead of saying it could not read the image.
 * Inline `data:` images are forwarded; a remote URL cannot be, so it is replaced by a note the model can
 * act on rather than dropped in silence.
 */
export function projectToolResultContent(
  raw: string | readonly unknown[],
): Array<Record<string, unknown>> {
  if (typeof raw === "string") return raw.length > 0 ? [{ type: "text", text: raw }] : [];
  const blocks: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  for (const part of raw) {
    const block = asRecord(part);
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image" && typeof block.imageUrl === "string") {
      const inline = parseInlineImageDataUrl(block.imageUrl);
      if (inline) {
        blocks.push({ type: "image", data: inline.data, mimeType: inline.mimeType });
        continue;
      }
      notes.push(`an image at ${block.imageUrl} could not be inlined; fetch it yourself if you need it`);
      continue;
    }
    notes.push(`a ${typeof block.type === "string" ? block.type : "unknown"} result part was dropped`);
  }
  for (const note of notes) blocks.push({ type: "text", text: note });
  if (blocks.length === 0) {
    return [{ type: "text", text: "the tool returned no readable content" }];
  }
  return blocks;
}

export function latestToolResult(
  parsed: OcxParsedRequest,
): { content: readonly unknown[]; isError?: boolean; toolCallId: string } | undefined {
  for (let index = parsed.context.messages.length - 1; index >= 0; index -= 1) {
    const message = parsed.context.messages[index];
    if (!message || message.role !== "toolResult") continue;
    return {
      content: projectToolResultContent(message.content),
      toolCallId: message.toolCallId,
      ...(message.isError ? { isError: true } : {}),
    };
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
        // Name the numbers. Codex with many MCP servers flattens every remote tool into the function
        // catalog (measured on a real Codex 0.162.0 client: 1749 tools, 2.5 MB), and the shared
        // CLI-family ceiling is 128 tools / 2 MiB — the same bound `qoder`, `codebuddy` and
        // `claude-cli` enforce. An operator seeing only "exceeds tool count limit" cannot tell a
        // malformed catalog from an oversized one.
        const declared = parsed.context.tools?.length ?? 0;
        emit(
          refusal(
            `This request declares ${declared} tools, over the ${CODING_AGENT_TOOL_LIMITS.maxTools}-tool ceiling ` +
              `every CLI-backed provider shares. Codex flattens each MCP server's tools into this catalog, so an ` +
              `MCP-heavy setup reaches the ceiling; drop or disable MCP servers for this provider, or narrow the ` +
              `tool set in the request. Detail: ${error.message}`,
            400,
            "tool_catalog_invalid",
          ),
        );
        return;
      }

      const sessions = deps.openSession ?? poolFor(getConfigDir(), deps);
      // No identity on the wire means this request cannot belong to any existing conversation, so it
      // gets a private one. Sharing a handle would leak one client's context to another.
      const identified = conversationHandle(parsed, incoming);
      const ref: StepConversationRef = identified
        ? { handle: identified, sessionId: "" }
        : sessions.nextRef();

      let session: StepConversationSession;
      try {
        session = await sessions.open(ref);
        await session.handshake();
      } catch (error) {
        emit(mapSessionFailure(error));
        return;
      }

      // From here on this turn owns the conversation's process and its turn state, so anything else
      // arriving for the same conversation waits rather than corrupting it.
      await withConversationLock(ref.handle, () =>
        driveTurn(parsed, incoming, emit, {
          sessions,
          session,
          ref,
          tools,
          setTimer: deps.setTimeout ?? setTimeout,
          clearTimer: deps.clearTimeout ?? clearTimeout,
        }),
      );
    },
  };
}

/** The body of a turn that already holds its conversation's process. */
/**
 * Open a query, retrying only while the runtime reports its single slot is still busy.
 *
 * Every other failure propagates immediately: a capability or transport problem must not be turned
 * into three silent attempts.
 */
async function startQueryWithBusyRetry(
  session: StepConversationSession,
  options: { model: string | undefined; maxThinkingTokens: number | undefined; sdkTools: readonly unknown[]; streamingInput: boolean },
  delay: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<{ queryId: string; sessionId: string }> {
  let attempt = 0;
  for (;;) {
    try {
      return await session.startQuery(options);
    } catch (error) {
      // Deliberately message-based rather than `instanceof StepSessionError`: a retry predicate that
      // silently stops firing when an error class changes would turn a handover race into a hard
      // failure, which is exactly the failure this retry exists to remove.
      const busy = /one query at a time|SESSION_BUSY/i.test(
        error instanceof Error ? error.message : String(error),
      );
      if (!busy || attempt >= STEP_CLI_QUERY_RETRY_DELAYS_MS.length) throw error;
      await delay(STEP_CLI_QUERY_RETRY_DELAYS_MS[attempt]!);
      attempt += 1;
    }
  }
}

async function driveTurn(
  parsed: OcxParsedRequest,
  incoming: IncomingMeta,
  emit: (event: AdapterEvent) => void,
  context: {
    sessions: StepConversationHost;
    session: StepConversationSession;
    ref: StepConversationRef;
    tools: ReturnType<typeof buildStepSdkTools>;
    setTimer: typeof setTimeout;
    clearTimer: typeof clearTimeout;
  },
): Promise<void> {
  const { sessions, session, ref, tools, setTimer, clearTimer } = context;
  {

      // A tool result the client computed on its previous request goes back first: it releases the
      // reverse request this session is holding, and the model continues inside the same query.
      const held = sessions.takeHeldTool(ref);
      let continuedQuery = false;
      /** Set when the held call was refused because this turn did not answer it. */
      let abandonedQueryId = false;
      if (held) {
        const result = latestToolResult(parsed);
        // Matched by CALL ID, never by position: a client may follow a tool call with a new user
        // message instead of a result, in which case the newest result in the transcript belongs to an
        // earlier call and delivering it would answer the wrong question.
        const matches = Boolean(result) && result!.toolCallId === held.callId;
        const delivered = session.resolveHeldToolResult(
          { id: held.frameId, method: "sdk_tool.invoke" } as StepFrame,
          matches && result ? result! : { content: [{ type: "text", text: "" }], isError: true },
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
        if (matches) {
          // This turn IS the answer to a captured call: the model already has the instruction and is
          // mid-query, so nothing is prompted again.
          continuedQuery = true;
        } else {
          // The client sent something other than the held call's result — typically a new user
          // message. The held call has just been refused, so the query it belongs to is unwinding;
          // leaving it running would make this request's own text unstartable, and swallowing that
          // text would lose the user's turn entirely. Interrupt it and carry on with a fresh query.
          abandonedQueryId = true;
        }
      }

      // Text is suppressed ONLY when this turn really is the answer to the held call; a turn that
      // abandoned the call still carries the user's message and must keep it.
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

      let queryId: string | undefined;
      let deadlineTimer: unknown;
      try {
        if (abandonedQueryId && lastQueryId.get(session)) {
          // The query that owned the abandoned call is still unwinding; stop it before starting a new
          // one, since StepCode serves a single query per process.
          await session.interrupt(lastQueryId.get(session)!);
          lastQueryId.delete(session);
        }
        if (!continuedQuery) {
          const started = await startQueryWithBusyRetry(session, {
            model: stepModelId(parsed.modelId),
            maxThinkingTokens: stepThinkingTokens(parsed),
            sdkTools: tools.sdkTools,
            streamingInput: true,
          });
          queryId = started.queryId;
          lastQueryId.set(session, queryId);
          await session.sendInput(queryId, composePrompt(parsed, userText ?? ""));
        }
      } catch (error) {
        turnRuntimes.delete(session);
        settle();
        emit(mapSessionFailure(error));
        await session.close();
        return;
      }

      // The turn owns the response until it settles: text, a captured tool call, a completion, the
      // client's abort, or the hard deadline. Returning before that leaves the stream without a
      // terminal event; never returning would hold the conversation lock forever.
      await Promise.race([
        done,
        abortSignal(incoming),
        new Promise<void>(resolve => {
          deadlineTimer = setTimer(resolve, STEP_CLI_TERMINAL_DEADLINE_MS);
        }),
      ]);
      clearTimer(deadlineTimer as never);
      if (!turnRuntimes.has(session)) return;

      // The turn is still registered, so nothing terminated it: either the client aborted, or the CLI
      // went quiet. Either way the query is still running inside StepCode, and since it serves one
      // query at a time the NEXT request for this conversation would be rejected or blocked by it.
      // Interrupt it, and close the session when the interrupt cannot be confirmed.
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
      if (queryId) {
        await session.interrupt(queryId);
        if (session.closed) return;
      }
      await session.close();
  }
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
