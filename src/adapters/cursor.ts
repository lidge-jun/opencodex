import { createHash } from "node:crypto";
import type { AdapterEvent, OcxProviderConfig } from "../types";
import type { ProviderAdapter } from "./base";
import { isTranslatorBudgetExceededError } from "../lib/translator-budget";
import { cursorExecDeniedMessage, cursorRequestDeclaresFullAccess } from "./cursor/exec-policy";
import { isCursorBenignCancelError, isCursorIncompleteToolCallMessage, isCursorInvalidArgumentError, isCursorOverflowRemintCandidate, isCursorRootEnvelopeError, safeCursorErrorMessage, type CursorSizeContext } from "./cursor/cursor-errors";
import { cursorCheckpointModelAffinityId, inferCursorContextWindow, isCursorExternalWireModel } from "./cursor/discovery";
import { createCursorKvStore, type CursorKvStore } from "./cursor/kv-store";
import { mapCursorServerMessage } from "./cursor/message-mapper";
import {
  createCursorRequest,
  cursorClientThreadOwner,
  cursorCoveredPrefixDigest,
  cursorInstructionDigest,
  cursorRequestEmitsFastVariant,
} from "./cursor/request-builder";
import {
  createLiveCursorTransport,
  CursorMissingCredentialError,
  rekeyCursorContextUsage,
  resolveCursorToken,
  capturedCursorCheckpointBytes,
} from "./cursor/live-transport";
import {
  commitCursorCheckpoint,
  cursorCheckpointRefHash,
  cursorCheckpointShape,
  invalidateCursorCheckpoint,
} from "./cursor/checkpoint-store";
import { debugProviderDiagnostic } from "../lib/debug";
import { isDebugEnabled } from "../lib/debug-settings";
import { createAdapterTierMetadata } from "../providers/fastwire";
import { estimateTokens } from "../lib/token-estimate";
import {
  clearCursorIncompleteToolRemint,
  cursorIncompleteToolRemintScopeKey,
  clearCursorEnvelopeEchoRemint,
  cursorEnvelopeEchoRemintScopeKey,
  cursorOverflowRemintScopeKey,
  markCursorOverflowSurfaced,
  recordCursorIncompleteToolRemint,
  recordCursorEnvelopeEchoRemint,
  recordCursorOverflowRemint,
  rememberCursorThreadConversation,
  shouldSkipCursorOverflowRemint,
  shouldSurfaceCursorOverflowFirst,
} from "./cursor/thread-continuity";
import { runCursorTurnWithRetry } from "./cursor/transport-retry";
import { cursorRequestHasShellAlias, cursorRequestUsesCodeMode } from "./cursor/tool-definitions";
import {
  CURSOR_OUTPUT_GUARD_MAX_HOLD_BYTES,
  CURSOR_ECHO_RETRY_CONTINUATION_TEXT,
  CURSOR_ROUTING_COMMENTARY_RETRY_TEXT,
  CursorEnvelopeEchoSniffer,
  CursorMidstreamEchoObserver,
  CursorRoutingCommentaryError,
  CursorRoutingCommentarySniffer,
  CursorToolResultEchoError,
} from "./cursor/envelope-echo";
import {
  createDisabledCursorTransport,
  CursorTransportDisabledError,
  type CursorTransportFactory,
} from "./cursor/transport";
import { cursorLiveRosterScope } from "./cursor/catalog";

export const CURSOR_API_URL = "https://api2.cursor.sh";

export {
  CURSOR_EXEC_CASES_DENIED,
  cursorExecDeniedMessage,
  type CursorDeniedExecCase,
} from "./cursor/exec-policy";

const CURSOR_TRANSPORT_DISABLED_MESSAGE = [
  "An explicit disabled Cursor transport was injected.",
  "Production Cursor requests use live transport when a Cursor access token is configured.",
].join(" ");

export interface CursorAdapterDeps {
  createTransport?: CursorTransportFactory;
  kv?: CursorKvStore;
  /** Test seam: observe/replace context-usage rekeying on conversation-id rotation. */
  rekeyContextUsage?: (fromConversationId: string, toConversationId: string) => void;
}

function safeCursorTransportError(err: unknown, sizeContext?: CursorSizeContext): string {
  if (err instanceof CursorTransportDisabledError) return CURSOR_TRANSPORT_DISABLED_MESSAGE;
  if (err instanceof CursorMissingCredentialError) {
    return "Cursor live transport is enabled, but no Cursor access token is configured. Set provider.apiKey or OPENCODEX_CURSOR_TEST_TOKEN.";
  }
  // A locally raised envelope rejection is already safe, specific, and actionable: it was composed
  // here from our own measurements and contains no upstream text. Passing it through
  // `safeCursorErrorMessage` would collapse it to the bare label "Cursor invalid request" (it
  // matches the "invalid"/"exceeds" keyword branch) and discard the counts that tell the operator
  // which limit was hit and by how much.
  if (isCursorRootEnvelopeError(err)) {
    return err instanceof Error ? `Cursor invalid request: ${err.message}` : "Cursor invalid request";
  }
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
  if (message) return safeCursorErrorMessage(message, sizeContext);
  return "Cursor upstream error: transport failed before completion.";
}

/**
 * Size prior for bare resource_exhausted classification (devlog 260): a rough input
 * estimate over the outgoing text vs the model's context window. Only used to keep
 * SMALL requests on the 429 class — unknown/large stays on the overflow mapping.
 */
function cursorRequestSizeContext(request: {
  modelId: string;
  _cursorIdentityScope?: string;
  system: string[];
  messages: { content: string }[];
}): CursorSizeContext {
  const text = [...request.system, ...request.messages.map(message => message.content)].join("\n");
  return {
    estimatedInputTokens: estimateTokens(text, request.modelId),
    // Prefers this identity scope's checkpoint `maxTokens` over the id heuristic
    // so a plan-gated ceiling participates in the 0.5-window overflow vs 429 prior.
    contextWindow: inferCursorContextWindow(request.modelId, {
      identityScope: request._cursorIdentityScope,
    }),
  };
}

export function createCursorAdapter(provider: OcxProviderConfig, deps: CursorAdapterDeps = {}): ProviderAdapter {
  return {
    name: "cursor",

    // Cursor emits Fast as a model variant, so the generic "no field emitted" fallback in
    // adapters/registry.ts would report every Fast turn as downgraded. This recomputes the
    // variant from the same pure inputs the builder uses: tierLogForRunTurn runs BEFORE
    // runTurn, and createCursorRequest mints conversation ids, so rebuilding it here would
    // describe a request that was never sent.
    tierLogForRunTurn(parsed) {
      const fast = cursorRequestEmitsFastVariant(parsed);
      return createAdapterTierMetadata(
        parsed.options.tierObservation,
        parsed.options.tierDecision,
        fast ? "cursor-variant" : null,
        fast ? "fast" : null,
      );
    },

    buildRequest() {
      return {
        url: provider.baseUrl || CURSOR_API_URL,
        method: "POST",
        headers: {},
        body: "",
      };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield {
        type: "error",
        message: "Cursor adapter uses runTurn; the fetch/parseStream path is disabled.",
      };
    },

    async runTurn(_parsed, incoming, emit) {
      if (incoming.abortSignal?.aborted) {
        emit({ type: "error", message: "Cursor turn was aborted before start." });
        return;
      }
      // Captured after createCursorRequest so the catch block can apply the bare-RE
      // size prior (devlog 260) even though `request` is scoped inside the try.
      let requestSizeContext: CursorSizeContext | undefined;
      try {
        const makeTransport = deps.createTransport ?? createLiveCursorTransport;
        const kv = deps.kv ?? createCursorKvStore({}, incoming.translatorBudget);
        const rekeyContextUsage = deps.rekeyContextUsage ?? rekeyCursorContextUsage;
        // Namespace thread→conversation derivation by the authenticated Cursor credential so
        // shared-proxy tenants with different Cursor accounts cannot collide on a parent thread id.
        // Prefer an already-set auth scope (e.g. Codex pool account) when present.
        let liveRosterScope: string | undefined;
        if (!_parsed._cursorIdentityScope) {
          try {
            const token = resolveCursorToken(provider, incoming.headers);
            liveRosterScope = cursorLiveRosterScope(provider.baseUrl, token);
            _parsed._cursorIdentityScope = createHash("sha256")
              .update("ocx:cursor:acct:")
              .update(token)
              .digest("hex")
              .slice(0, 16);
          } catch {
            /* Missing credential is handled by the live transport path below. */
          }
        } else {
          try {
            liveRosterScope = cursorLiveRosterScope(provider.baseUrl, resolveCursorToken(provider, incoming.headers));
          } catch {
            /* Missing credential is handled by the live transport path below. */
          }
        }
        const inheritedCheckpointRef = _parsed._providerContinuation?.cursor?.checkpointRef;
        const previousConversationId = _parsed._cursorConversationId;
        let request = {
          ...createCursorRequest(_parsed, { liveRosterScope }),
          _cursorIdentityScope: _parsed._cursorIdentityScope?.trim() || "local",
        };
        requestSizeContext = cursorRequestSizeContext(request);
        // The builder may derive a stable provider id from the client thread when Responses state
        // is unavailable. Rekey only existing state; there is nothing to migrate on a fresh turn,
        // and isolated helper/compaction turns must never inherit or donate the parent's usage state.
        if (
          previousConversationId
          && request.conversationId !== previousConversationId
          && _parsed._cursorIsolateConversation !== true
        ) {
          rekeyContextUsage(previousConversationId, request.conversationId);
        }
        _parsed._cursorConversationId = request.conversationId;
        let emittedOutput = false;
        let replayUnsafe = false;
        const lastRawIsToolResult = _parsed.context.messages.at(-1)?.role === "toolResult";
        let completedNormally = false;
        let lastTransport: { captured?: Uint8Array } | undefined;
        let emittedClientTool = false;
        let sawIncompleteToolCall = false;
        let sawMidstreamEnvelopeEcho = false;
        // Ordering proof for tool-suspended checkpoints: true only when the newest captured
        // checkpoint bytes arrived AFTER the turn emitted a client tool call, i.e. upstream
        // serialized its suspended-on-tool-call state. Only that snapshot can safely resume
        // with the covered-prefix + trailing-toolResult path (devlog 260826 050).
        let capturedAfterClientTool = false;

        const commitCapturedCheckpoint = (activeRequest: ReturnType<typeof createCursorRequest>): void => {
          const toolSuspendedCommit =
            emittedClientTool
            && capturedAfterClientTool
            && isCursorExternalWireModel(activeRequest.modelId);
          if (
            replayUnsafe
            || (emittedClientTool && !toolSuspendedCommit)
            || activeRequest.contextUsageStoreCheckpoints === false
            || !lastTransport?.captured
            || lastTransport.captured.byteLength === 0
          ) {
            // Refusal diagnostics (devlog 260826 050/080): name the exact guard so a live
            // missing_ref chain can be attributed without instrumented rebuilds.
            debugProviderDiagnostic("cursor", "checkpoint-commit-refused", {
              replayUnsafe,
              emittedClientTool,
              capturedAfterClientTool,
              externalModel: isCursorExternalWireModel(activeRequest.modelId),
              storeCheckpoints: activeRequest.contextUsageStoreCheckpoints !== false,
              capturedBytes: lastTransport?.captured?.byteLength ?? 0,
              // Byte length says nothing about coverage. `pendingToolCalls` does: it is what
              // distinguishes a snapshot that knows about the suspended call from one that merely
              // arrived after it (#4245). Counts only; the decode is skipped unless debug is on.
              capturedShape: isDebugEnabled() ? cursorCheckpointShape(lastTransport?.captured) : undefined,
            });
            return;
          }
          const previousRef = _parsed._providerContinuation?.cursor?.checkpointRef;
          const coveredMessageCount = _parsed.context.messages.length;
          const checkpointRef = commitCursorCheckpoint({
            conversationId: activeRequest.conversationId,
            identityScope: _parsed._cursorIdentityScope,
            modelId: cursorCheckpointModelAffinityId(activeRequest.modelId),
            checkpointBytes: lastTransport.captured,
            coveredMessageCount,
            prefixDigest: cursorCoveredPrefixDigest(_parsed, coveredMessageCount),
            systemDigest: cursorInstructionDigest(_parsed),
            toolSuspended: toolSuspendedCommit,
          });
          if (!checkpointRef) return;
          if (previousRef && previousRef !== checkpointRef) invalidateCursorCheckpoint(previousRef);
          _parsed._providerContinuation = {
            ...(_parsed._providerContinuation ?? {}),
            cursor: {
              ...(_parsed._providerContinuation?.cursor ?? {}),
              conversationId: activeRequest.conversationId,
              // A tool-suspended checkpoint is only usable by the immediate trailing-toolResult
              // continuation; the request-builder guard keys on this checkpointUsable=false and
              // the snapshot's persisted toolSuspended flag for that.
              checkpointUsable: !toolSuspendedCommit,
              checkpointRef,
            },
          };
          debugProviderDiagnostic("cursor", "checkpoint-continuation", {
            mode: activeRequest.continuationMode ?? "full-replay",
            conversationHash: activeRequest.conversationId.slice(0, 16),
            checkpointRefHash: cursorCheckpointRefHash(checkpointRef),
            checkpointBytes: lastTransport.captured.byteLength,
            wireModel: activeRequest.modelId,
            ...(toolSuspendedCommit ? { toolSuspended: true } : {}),
          });
        };

        const runOnce = async (activeRequest: ReturnType<typeof createCursorRequest>) => {
          // Envelope echo quarantine (devlog 260826 gap-10): external full-replay continuations
          // whose trailing input is a tool result sometimes ECHO the replayed "[Tool Result]"
          // envelope as assistant text (kimi-k3 ~30-40% of multi-round probes). Hold the first
          // text deltas until they provably diverge from the markers; a completed marker turns
          // the turn into a retryable semantic failure BEFORE any client-visible delta escapes.
          // Armed for ANY external turn whose replayed history contains a tool result — echo
          // priming was observed live on user-action rounds too (the envelope lives in the
          // flattened history regardless of which role ends the input).
          const armEchoSniffer =
            isCursorExternalWireModel(activeRequest.modelId)
            && (_parsed.context.messages ?? []).some(message => message.role === "toolResult");
          const echoSniffer = armEchoSniffer ? new CursorEnvelopeEchoSniffer() : undefined;
          // Mid-stream observer (devlog 260828 F1/F2): diagnostic-only; armed with the
          // prefix sniffer because both fire on flattened tool-result replay priming.
          const midstreamObserver = armEchoSniffer ? new CursorMidstreamEchoObserver() : undefined;
          const armRoutingCommentarySniffer =
            isCursorExternalWireModel(activeRequest.modelId)
            && (
              cursorRequestUsesCodeMode(activeRequest.tools, activeRequest.toolChoice)
              || cursorRequestHasShellAlias(activeRequest.tools)
            );
          const routingCommentarySniffer = armRoutingCommentarySniffer
            ? new CursorRoutingCommentarySniffer()
            : undefined;
          let guardHeld: AdapterEvent[] = [];
          let guardHeldBytes = 0;
          const guardEncoder = new TextEncoder();
          // Exactly-once observation: every client-bound text delta passes through here
          // exactly once — held deltas only on release, ordinary deltas at emit time.
          const emitTextObserved = (event: AdapterEvent): void => {
            if (event.type === "text_delta") midstreamObserver?.feed(event.text);
            emit(event);
          };
          const releaseGuardHeld = () => {
            for (const held of guardHeld) {
              if (held.type !== "heartbeat") emittedOutput = true;
              emitTextObserved(held);
            }
            guardHeld = [];
            guardHeldBytes = 0;
          };
          // A single frame can carry a multi-megabyte payload (the transport accepts up to the
          // 16 MiB Cursor message bound), so the serialized size is projected — object overhead
          // plus raw payload length — BEFORE any encoded copy exists. Escapes only inflate the
          // exact figure, making the raw length a safe lower bound for the overflow decision.
          const GUARD_EVENT_OVERHEAD_BYTES = 64;
          const projectedGuardEventBytes = (event: AdapterEvent): number =>
            GUARD_EVENT_OVERHEAD_BYTES
            + (event.type === "text_delta"
              ? Buffer.byteLength(event.text, "utf8")
              : event.type === "thinking_delta"
                ? Buffer.byteLength(event.thinking, "utf8")
                : 0);
          const holdGuardEvent = (event: AdapterEvent) => {
            if (guardHeldBytes + projectedGuardEventBytes(event) > CURSOR_OUTPUT_GUARD_MAX_HOLD_BYTES) {
              // Too large to retain even unescaped: settle the sniffers, release what was held,
              // and pass this event through without ever encoding it.
              echoSniffer?.finish();
              routingCommentarySniffer?.finish();
              releaseGuardHeld();
              if (event.type !== "heartbeat") emittedOutput = true;
              emitTextObserved(event);
              return false;
            }
            guardHeld.push(event);
            // Count the complete retained representation, including per-event overhead, so an
            // upstream cannot evade the cap with empty or non-text reasoning frames.
            guardHeldBytes += guardEncoder.encode(JSON.stringify(event)).byteLength;
            if (guardHeldBytes <= CURSOR_OUTPUT_GUARD_MAX_HOLD_BYTES) return true;
            echoSniffer?.finish();
            routingCommentarySniffer?.finish();
            releaseGuardHeld();
            return false;
          };
          // Bound each feed before a sniffer copies or encodes it. Their normal 40 B / 512 B
          // hold thresholds are checked after classification, so one large frame previously
          // let a late match inspect an arbitrary tail. Only these leading UTF-16 prefixes
          // now participate in corrective retry; later text remains ordinary output.
          const ECHO_SNIFF_FEED_MAX_CHARS = 512;
          const ROUTING_SNIFF_FEED_MAX_CHARS = 2048;
          const boundedSniffText = (text: string, maxChars: number): string =>
            text.length > maxChars ? text.slice(0, maxChars) : text;
          const guardsSettled = () =>
            (!echoSniffer || echoSniffer.settled)
            && (!routingCommentarySniffer || routingCommentarySniffer.settled);
          await runCursorTurnWithRetry(
            makeTransport,
            {
              provider,
              headers: incoming.headers,
              translatorBudget: incoming.translatorBudget,
              requestDeclaresFullAccess: cursorRequestDeclaresFullAccess(activeRequest),
              sessionId: activeRequest.conversationId,
              ...(incoming.providerFetch ? { fetch: incoming.providerFetch } : {}),
            },
            activeRequest,
            incoming.abortSignal,
            (message, activeTransport) => {
              if (incoming.abortSignal?.aborted) {
                emit({ type: "error", message: "Cursor turn was aborted." });
                return;
              }
              if (message.type === "local_side_effect") replayUnsafe = true;
              if (message.type === "done") completedNormally = true;
              if (message.type === "tool_call_end") emittedClientTool = true;
              const captured = capturedCursorCheckpointBytes(activeTransport);
              if (captured) {
                if (captured !== lastTransport?.captured) capturedAfterClientTool = emittedClientTool;
                lastTransport = { captured };
              }
             const events = mapCursorServerMessage(message, {
               kv,
               writeClient: clientMessage => {
                 void activeTransport.writeClient(clientMessage);
               },
             });
             for (const event of events) {
                if (event.type === "error" && isCursorIncompleteToolCallMessage(event.message)) {
                  sawIncompleteToolCall = true;
                }
                if (!guardsSettled()) {
                  if (event.type === "text_delta") {
                    // Classify the delta before the aggregate-cap check: an oversized first
                    // delta must still pass the armed sniffers (echo/hallucination detection is
                    // prefix-based), so the cap cannot disarm them before they see the text.
                    if (echoSniffer && !echoSniffer.settled) {
                      const decision = echoSniffer.feed(boundedSniffText(event.text, ECHO_SNIFF_FEED_MAX_CHARS));
                      if (decision.kind === "echo") {
                        guardHeld = [];
                        throw new CursorToolResultEchoError(decision.marker);
                      }
                    }
                    if (routingCommentarySniffer && !routingCommentarySniffer.settled) {
                      const decision = routingCommentarySniffer.feed(boundedSniffText(event.text, ROUTING_SNIFF_FEED_MAX_CHARS));
                      if (decision.kind === "hallucination") {
                        guardHeld = [];
                        throw new CursorRoutingCommentaryError();
                      }
                    }
                    if (!holdGuardEvent(event)) continue;
                    if (guardsSettled()) releaseGuardHeld();
                    continue;
                  } else if (event.type === "thinking_delta" || event.type === "heartbeat") {
                    // Reasoning before first text stays ordered; liveness still passes through.
                    if (event.type === "thinking_delta") {
                      holdGuardEvent(event);
                      continue;
                    }
                  } else {
                    // A tool call, done, or error closes the text quarantine. Re-check the full
                    // held first line before release so a fragmented routing claim cannot leak.
                    echoSniffer?.finish();
                    const routingDecision = routingCommentarySniffer?.finish();
                    if (routingDecision?.kind === "hallucination") {
                      guardHeld = [];
                      throw new CursorRoutingCommentaryError();
                    }
                    releaseGuardHeld();
                  }
                }
                if (event.type !== "heartbeat") emittedOutput = true;
                if (event.type === "done") {
                  const midstreamFindings = midstreamObserver?.findings() ?? [];
                  if (midstreamFindings.length > 0) sawMidstreamEnvelopeEcho = true;
                  for (const finding of midstreamFindings) {
                    debugProviderDiagnostic("cursor", "midstream-envelope-echo", {
                      wireModel: activeRequest.modelId,
                      conversationHash: activeRequest.conversationId.slice(0, 16),
                      marker: finding.marker,
                      offset: finding.offset,
                      callIdCorrupt: finding.callIdCorrupt,
                    });
                  }
                  commitCapturedCheckpoint(activeRequest);
                  const inheritedCursor = _parsed._providerContinuation?.cursor;
                  const isolatedOrCompaction =
                    _parsed._cursorIsolateConversation === true
                    || activeRequest.contextUsageStoreCheckpoints === false;
                  const providerState = inheritedCursor
                    ? {
                        cursor: isolatedOrCompaction
                          ? {
                              conversationId: activeRequest.conversationId,
                              ...(inheritedCursor.checkpointUsable !== undefined
                                ? { checkpointUsable: inheritedCursor.checkpointUsable }
                                : {}),
                            }
                          : { ...inheritedCursor, conversationId: activeRequest.conversationId },
                      }
                    : undefined;
                  emit(providerState ? { ...event, providerState } : event);
                } else {
                  emitTextObserved(event);
                }
              }
            },
            // Cursor's retry ladder re-sends the WHOLE turn, so each attempt is a physical send
            // the enclosing request pays for. A meta without a budget -- every adapter unit test,
            // and any caller predating this -- keeps the adapter's own three attempts (#4546).
            incoming.sendBudget ? { sendBudget: incoming.sendBudget } : {},
          );
        };

        const remintConversationId = (failedConversationId: string) => {
          lastTransport = undefined;
          _parsed._cursorConversationId = undefined;
          const next = {
            ...createCursorRequest(_parsed, { forceFreshConversation: true, liveRosterScope }),
            _cursorIdentityScope: _parsed._cursorIdentityScope?.trim() || "local",
          };
          rekeyContextUsage(failedConversationId, next.conversationId);
          _parsed._cursorConversationId = next.conversationId;
          // Persist recovery for store:false clients that send any stable Cursor thread owner, so
          // the next turn does not recompute the stale deterministic thread hash. Isolated helper /
          // compaction turns must not park their throwaway id under the parent or Desktop owner.
          const threadOwner = cursorClientThreadOwner(_parsed);
          if (threadOwner && _parsed._cursorIsolateConversation !== true) {
            rememberCursorThreadConversation(
              threadOwner,
              next.conversationId,
              _parsed._cursorIdentityScope,
            );
          }
          return next;
        };

        for (;;) {
          try {
            await runOnce(request);
            break;
          } catch (err) {
            const outputGuardRetryText =
              err instanceof CursorToolResultEchoError
                ? CURSOR_ECHO_RETRY_CONTINUATION_TEXT
                : err instanceof CursorRoutingCommentaryError
                  ? CURSOR_ROUTING_COMMENTARY_RETRY_TEXT
                  : undefined;
            // One-shot corrective retry for guarded external output (devlog 260826 gap-10/11).
            // The quarantine guarantees no client-visible delta escaped, so a fresh-conversation
            // retry is safe. A second rejection propagates as an error rather than looping.
            if (
              outputGuardRetryText
              && !emittedOutput
              && !replayUnsafe
              && !incoming.abortSignal?.aborted
            ) {
              debugProviderDiagnostic(
                "cursor",
                err instanceof CursorToolResultEchoError
                  ? "envelope-echo-retry"
                  : "routing-commentary-retry",
                {
                wireModel: request.modelId,
                conversationHash: request.conversationId.slice(0, 16),
                },
              );
              const echoedConversationId = request.conversationId;
              request = {
                ...remintConversationId(echoedConversationId),
                echoRetryContinuationText: outputGuardRetryText,
              };
              await runOnce(request);
              break;
            } else {
              const overflowRemintSafe =
                !lastRawIsToolResult
                && !emittedOutput
                && !replayUnsafe
                && _parsed._cursorIsolateConversation !== true
                && request.contextUsageStoreCheckpoints !== false
                && !incoming.abortSignal?.aborted;
              const overflowScopeKey = cursorOverflowRemintScopeKey(
                cursorClientThreadOwner(_parsed),
                _parsed._cursorIdentityScope,
              );
              if (
                overflowScopeKey
                && overflowRemintSafe
                && isCursorOverflowRemintCandidate(err, requestSizeContext)
              ) {
                if (shouldSkipCursorOverflowRemint(overflowScopeKey)) throw err;
                if (shouldSurfaceCursorOverflowFirst(overflowScopeKey)) {
                  markCursorOverflowSurfaced(overflowScopeKey);
                  throw err;
                }
                if (!recordCursorOverflowRemint(overflowScopeKey)) throw err;
                if (inheritedCheckpointRef) invalidateCursorCheckpoint(inheritedCheckpointRef);
                request = remintConversationId(request.conversationId);
                continue;
              }

              // One-shot fallback for external-model Connect invalid_argument before any
              // non-heartbeat output. Retries apply only to safe plain-user turns; tool-result
              // resumes, local exec/MCP side effects, and already-emitted output fail closed.
              if (
                !isCursorInvalidArgumentError(err)
                || !isCursorExternalWireModel(request.modelId)
                || lastRawIsToolResult
                || emittedOutput
                || replayUnsafe
                || incoming.abortSignal?.aborted
              ) {
                throw err;
              }
              request = remintConversationId(request.conversationId);
              await runOnce(request);
              break;
            }
          }
        }
        const incompleteToolRemintScopeKey =
          _parsed._cursorIsolateConversation !== true
          && request.contextUsageStoreCheckpoints !== false
            ? cursorIncompleteToolRemintScopeKey(
                cursorClientThreadOwner(_parsed),
                _parsed._cursorIdentityScope,
              )
            : null;
        // Incomplete-tool errors are streamed, not thrown. Do not retry this turn; rotate only
        // the next turn's id. request-prepare currently isolates compaction, but adapter callers
        // can bypass that upstream invariant, so checkpoint storage is the local isolation boundary.
        if (sawIncompleteToolCall && incompleteToolRemintScopeKey) {
          if (recordCursorIncompleteToolRemint(incompleteToolRemintScopeKey)) {
            if (inheritedCheckpointRef) invalidateCursorCheckpoint(inheritedCheckpointRef);
            debugProviderDiagnostic("cursor", "incomplete-tool-remint", {
              wireModel: request.modelId,
              conversationHash: request.conversationId.slice(0, 16),
            });
            remintConversationId(request.conversationId);
          } else {
            debugProviderDiagnostic("cursor", "incomplete-tool-remint-exhausted", {
              wireModel: request.modelId,
              conversationHash: request.conversationId.slice(0, 16),
            });
          }
        } else if (!sawIncompleteToolCall && completedNormally && incompleteToolRemintScopeKey) {
          clearCursorIncompleteToolRemint(incompleteToolRemintScopeKey);
        }
        // A mid-stream envelope echo has ALREADY reached the client — the prefix sniffer only
        // watches the first bytes of a turn, and grok-4.6 writes a real sentence before pasting
        // the envelope. It cannot be quarantined, so the recovery is the same as the
        // incomplete-tool case: leave this turn alone and rotate the next turn's id, otherwise
        // the stored echo is replayed and primes the model to echo again.
        //
        // Its own budget, not the incomplete-tool one: echoing is cheap and repeatable while an
        // incomplete client-tool stream is rare and structural, so a shared counter would let a
        // persistently echoing model spend the allowance the other recovery needs. Skipped when
        // the incomplete-tool arm already reminted this turn — one rotation is enough.
        const envelopeEchoRemintScopeKey =
          _parsed._cursorIsolateConversation !== true
          && request.contextUsageStoreCheckpoints !== false
            ? cursorEnvelopeEchoRemintScopeKey(
                cursorClientThreadOwner(_parsed),
                _parsed._cursorIdentityScope,
              )
            : null;
        if (sawMidstreamEnvelopeEcho && !sawIncompleteToolCall && envelopeEchoRemintScopeKey) {
          if (recordCursorEnvelopeEchoRemint(envelopeEchoRemintScopeKey)) {
            if (inheritedCheckpointRef) invalidateCursorCheckpoint(inheritedCheckpointRef);
            debugProviderDiagnostic("cursor", "midstream-envelope-echo-remint", {
              wireModel: request.modelId,
              conversationHash: request.conversationId.slice(0, 16),
            });
            remintConversationId(request.conversationId);
          } else {
            debugProviderDiagnostic("cursor", "midstream-envelope-echo-remint-exhausted", {
              wireModel: request.modelId,
              conversationHash: request.conversationId.slice(0, 16),
            });
          }
        } else if (!sawMidstreamEnvelopeEcho && completedNormally && envelopeEchoRemintScopeKey) {
          clearCursorEnvelopeEchoRemint(envelopeEchoRemintScopeKey);
        }
        if (
          request.checkpointInvalidationReason
          && request.checkpointInvalidationReason !== "missing_ref"
        ) {
          invalidateCursorCheckpoint(inheritedCheckpointRef);
          debugProviderDiagnostic("cursor", "checkpoint-invalidated", {
            reason: request.checkpointInvalidationReason,
          });
        } else if (!completedNormally && request.checkpointInvalidationReason) {
          debugProviderDiagnostic("cursor", "checkpoint-invalidated", {
            reason: request.checkpointInvalidationReason,
          });
        }
        if (
          _parsed._cursorIsolateConversation === true
          || request.contextUsageStoreCheckpoints === false
        ) {
          const inherited = _parsed._providerContinuation?.cursor;
          if (inherited) {
            const { checkpointRef: _ignoredCheckpointRef, ...cursorWithoutCheckpointRef } = inherited;
            _parsed._providerContinuation = {
              ...(_parsed._providerContinuation ?? {}),
              cursor: cursorWithoutCheckpointRef,
            };
          }
        }
      } catch (err) {
        if (isCursorBenignCancelError(err)) return;
        const partialUsage = (err as { partialUsage?: import("../types").OcxUsage }).partialUsage;
        emit({
          type: "error",
          message: isTranslatorBudgetExceededError(err)
            ? "upstream translation buffer exceeded the safe limit"
            : safeCursorTransportError(err, requestSizeContext),
          ...(isTranslatorBudgetExceededError(err)
            ? { status: 502, errorType: "upstream_error", code: "translation_buffer_limit" }
            : {}),
          // A local envelope rejection is a client error with a stable code, and the caller needs
          // that code to distinguish "this conversation cannot be sent" from a transient upstream
          // fault. Without this the class was flattened to a bare message and the code was lost.
          ...(isCursorRootEnvelopeError(err)
            ? { status: 400, errorType: "invalid_request_error", code: "cursor_root_envelope_limit", retryable: false }
            : {}),
          ...(partialUsage ? { usage: partialUsage } : {}),
        });
      }
    },
  };
}
