import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "../base";
import { getConfigDir } from "../../config/paths";
import { CODING_AGENT_TOOL_LIMITS } from "../coding-agent/tool-catalog";
import { ConversationQueueFullError, ownedConversationHandle, withConversationLock } from "./conversation";
import { STEP_CLI_HOST, STEP_CLI_TOOL_SERVER } from "./constants";
import { sessionHandlers } from "./events";
import { mapSessionFailure, refusal } from "./errors";
import {
  abortSignal,
  composePrompt,
  hasImageInput,
  latestToolResult,
  pendingUserText,
  stepModelId,
  stepThinkingTokens,
  type StepProviderState,
} from "./projection";
import { resolveStepCliProfile, STEP_CLI_PROFILE, type StepCliProfile } from "./profiles";
import {
  beginTurn,
  clearStepCliSessions,
  currentQuery,
  currentTurn,
  endTurn,
  forgetQuery,
  poolFor,
  rememberQuery,
} from "./registry";
import { StepSessionError, type StepSessionDeps } from "./session";
import type { StepConversationHost, StepConversationRef, StepConversationSession } from "./session-pool";
import { buildStepSdkTools, StepToolCatalogError } from "./tool-bridge";
import type { StepFrame } from "./stdio-frames";

/**
 * Codex turns against a Step Plan subscription.
 *
 * This module is the ORCHESTRATION layer and nothing else: it decides what one turn is, in what order
 * it runs, and when it has produced a terminal event. Converting between the client's request shape
 * and the CLI's is `projection`, mapping the CLI's frames back is `events`, conversation identity and
 * turn ordering are `conversation`, and everything that must outlive a request is `registry`.
 */
export interface StepCliAdapterDeps extends StepSessionDeps {
  /** Injection seam so tests drive the real `runTurn` path without a CLI. */
  openSession?: StepConversationHost;
}

/**
 * Per-request turn state, keyed by the process that owns it.
 *
 * `createStepCliAdapter` runs once per request, so nothing that has to survive a request boundary can
 * live in its closure: a reverse request arriving during request N+1 would be routed to an instance
 * that no longer exists, and the conversation would silently restart. `devin/trajectory.ts` keeps its
 * conversation map at module scope for the same reason.
 */

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

      let sessions: StepConversationHost;
      try { sessions = deps.openSession ?? poolFor(getConfigDir(), deps, sessionHandlers); }
      catch (error) { emit(mapSessionFailure(error)); return; }
      // Admission owns the namespace; thread headers only select a conversation within it.
      // Requests without caller ownership receive a private process.
      const identified = ownedConversationHandle(parsed, incoming, provider);
      const ref: StepConversationRef = identified
        ? { handle: identified, sessionId: "" }
        : sessions.nextRef();

      let session!: StepConversationSession;
      try {
        session = await sessions.open(ref);
        await session.handshake();
      } catch (error) {
        await session?.close();
        emit(mapSessionFailure(error));
        return;
      }

      // From here on this turn owns the conversation's process and its turn state, so anything else
      // arriving for the same conversation waits rather than corrupting it.
      try {
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
      } catch (error) {
        if (error instanceof ConversationQueueFullError) {
          // The queue cap is a refusal, not a crash, and this caller never owned the conversation: the
          // session it was handed is the one serving the accepted turn and its queue. Closing it here
          // would disconnect every one of them to turn away a single extra request.
          emit(
            refusal(error.message, 409, "step_cli_conversation_busy", "rate_limit_error", true),
          );
          return;
        }
        // Anything else was raised by this turn after it owned the conversation, so the session state
        // is no longer trustworthy and is closed.
        emit(mapSessionFailure(error));
        await session.close();
      } finally {
        // Keyless callers have no cross-request ownership proof. Their process is request-local.
        if (!identified) await session.close();
      }
    },
  };
}

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
      // A matching held result resumes its original query. An abandoned call must finish
      // unwinding without a turn before the replacement is registered.
      const held = sessions.takeHeldTool(ref);
      const heldResult = held ? latestToolResult(parsed) : undefined;
      // Matched by CALL ID, never by position: a client may follow a tool call with a new user
      // message instead of a result, in which case the newest result in the transcript belongs to an
      // earlier call and delivering it would answer the wrong question.
      // A client that cancels the call and sends only new user text has no tool result in its
      // transcript at all, so `heldResult` can be undefined while `held` exists.
      const heldMatches = held !== undefined && heldResult !== undefined && heldResult.toolCallId === held.callId;
      // This turn IS the answer to a captured call: the model already has the instruction and is
      // mid-query, so nothing is prompted again.
      const continuedQuery = Boolean(held) && heldMatches;
      // The client sent something other than the held call's result — typically a new user message.
      // The query that owned the call is unwinding; leaving it running would make this request's own
      // text unstartable, and swallowing that text would lose the user's turn entirely.
      const abandonedQueryId = Boolean(held) && !heldMatches;

      const catalogKey = JSON.stringify(tools.sdkTools);
      if (held && (held.queryId !== currentQuery(session) || held.catalogKey !== catalogKey)) {
        emit(refusal("The held StepCode call belongs to a different query or tool catalog.", 409, "step_cli_tool_owner_mismatch"));
        await session.close();
        return;
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

      if (abandonedQueryId && held) {
        // Detach the old owner before releasing its hold: completion can arrive synchronously.
        endTurn(session);
        forgetQuery(session);
        session.resolveHeldToolResult(
          { id: held.frameId, method: "sdk_tool.invoke" } as StepFrame,
          { content: [{ type: "text", text: "" }], isError: true },
        );
        await session.interrupt(held.queryId);
        await session.endInput(held.queryId);
      }

      let settle!: () => void;
      const done = new Promise<void>(resolve => {
        settle = resolve;
      });
      beginTurn(session, {
        ref,
        pool: sessions,
        emit,
        settle,
        emittedNames: tools.emittedNameMap,
        catalogKey,
        ...(continuedQuery && held ? { queryId: held.queryId } : {}),
      });

      // Registered FIRST, delivered second. See the comment above: the CLI can answer the moment it
      // receives the result.
      if (held && continuedQuery) {
        const delivered = session.resolveHeldToolResult(
          { id: held.frameId, method: "sdk_tool.invoke" } as StepFrame,
          heldResult!,
        );
        if (!delivered) {
          endTurn(session);
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

      let queryId: string | undefined;
      let deadlineTimer: unknown;
      try {
        if (!continuedQuery) {
          const started = await startQueryWithBusyRetry(session, {
            model: stepModelId(parsed.modelId),
            maxThinkingTokens: stepThinkingTokens(parsed),
            sdkTools: tools.sdkTools,
            streamingInput: true,
          });
          queryId = started.queryId;
          rememberQuery(session, queryId);
          await session.sendInput(queryId, composePrompt(parsed, userText ?? ""));
        }
      } catch (error) {
        endTurn(session);
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
      if (currentTurn(session) === undefined) return;

      // The turn is still registered, so nothing terminated it: either the client aborted, or the CLI
      // went quiet. Either way the query is still running inside StepCode, and since it serves one
      // query at a time the NEXT request for this conversation would be rejected or blocked by it.
      // Interrupt it, and close the session when the interrupt cannot be confirmed.
      endTurn(session);
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

export { STEP_CLI_PROFILE, clearStepCliSessions };
