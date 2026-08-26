import { createHash } from "node:crypto";
import type { AdapterEvent, OcxProviderConfig } from "../types";
import type { ProviderAdapter } from "./base";
import { isTranslatorBudgetExceededError } from "../lib/translator-budget";
import { cursorExecDeniedMessage, cursorRequestDeclaresFullAccess } from "./cursor/exec-policy";
import { isCursorBenignCancelError, isCursorInvalidArgumentError, safeCursorErrorMessage, type CursorSizeContext } from "./cursor/cursor-errors";
import { cursorCheckpointModelAffinityId, inferCursorContextWindow, isCursorExternalWireModel } from "./cursor/discovery";
import { createCursorKvStore, type CursorKvStore } from "./cursor/kv-store";
import { mapCursorServerMessage } from "./cursor/message-mapper";
import {
  createCursorRequest,
  cursorCoveredPrefixDigest,
  cursorInstructionDigest,
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
  invalidateCursorCheckpoint,
} from "./cursor/checkpoint-store";
import { debugProviderDiagnostic } from "../lib/debug";
import { estimateTokens } from "../lib/token-estimate";
import { rememberCursorThreadConversation } from "./cursor/thread-continuity";
import { runCursorTurnWithRetry } from "./cursor/transport-retry";
import {
  createDisabledCursorTransport,
  CursorTransportDisabledError,
  type CursorTransportFactory,
} from "./cursor/transport";

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
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
  if (message) return safeCursorErrorMessage(message, sizeContext);
  return "Cursor upstream error: transport failed before completion.";
}

/**
 * Size prior for bare resource_exhausted classification (devlog 260): a rough input
 * estimate over the outgoing text vs the model's context window. Only used to keep
 * SMALL requests on the 429 class — unknown/large stays on the overflow mapping.
 */
function cursorRequestSizeContext(request: { modelId: string; system: string[]; messages: { content: string }[] }): CursorSizeContext {
  const text = [...request.system, ...request.messages.map(message => message.content)].join("\n");
  return {
    estimatedInputTokens: estimateTokens(text, request.modelId),
    contextWindow: inferCursorContextWindow(request.modelId),
  };
}

export function createCursorAdapter(provider: OcxProviderConfig, deps: CursorAdapterDeps = {}): ProviderAdapter {
  return {
    name: "cursor",

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
        if (!_parsed._cursorIdentityScope) {
          try {
            const token = resolveCursorToken(provider, incoming.headers);
            _parsed._cursorIdentityScope = createHash("sha256")
              .update("ocx:cursor:acct:")
              .update(token)
              .digest("hex")
              .slice(0, 16);
          } catch {
            /* Missing credential is handled by the live transport path below. */
          }
        }
        const inheritedCheckpointRef = _parsed._providerContinuation?.cursor?.checkpointRef;
        const previousConversationId = _parsed._cursorConversationId;
        let request = createCursorRequest(_parsed);
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

        const commitCapturedCheckpoint = (activeRequest: ReturnType<typeof createCursorRequest>): void => {
          if (
            replayUnsafe
            || emittedClientTool
            || activeRequest.contextUsageStoreCheckpoints === false
            || !lastTransport?.captured
            || lastTransport.captured.byteLength === 0
          ) return;
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
          });
          if (!checkpointRef) return;
          if (previousRef && previousRef !== checkpointRef) invalidateCursorCheckpoint(previousRef);
          _parsed._providerContinuation = {
            ...(_parsed._providerContinuation ?? {}),
            cursor: {
              ...(_parsed._providerContinuation?.cursor ?? {}),
              conversationId: activeRequest.conversationId,
              checkpointUsable: true,
              checkpointRef,
            },
          };
          debugProviderDiagnostic("cursor", "checkpoint-continuation", {
            mode: activeRequest.continuationMode ?? "full-replay",
            conversationHash: activeRequest.conversationId.slice(0, 16),
            checkpointRefHash: cursorCheckpointRefHash(checkpointRef),
            checkpointBytes: lastTransport.captured.byteLength,
            wireModel: activeRequest.modelId,
          });
        };

        const runOnce = async (activeRequest: ReturnType<typeof createCursorRequest>) => {
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
              if (captured) lastTransport = { captured };
              const events = mapCursorServerMessage(message, {
                kv,
                writeClient: clientMessage => {
                  void activeTransport.writeClient(clientMessage);
                },
              });
              for (const event of events) {
                if (event.type !== "heartbeat") emittedOutput = true;
                if (event.type === "done") {
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
                  emit(event);
                }
              }
            },
          );
        };

        try {
          await runOnce(request);
        } catch (err) {
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
          const failedConversationId = request.conversationId;
          lastTransport = undefined;
          _parsed._cursorConversationId = undefined;
          request = createCursorRequest(_parsed, { forceFreshConversation: true });
          rekeyContextUsage(failedConversationId, request.conversationId);
          _parsed._cursorConversationId = request.conversationId;
          // Persist recovery for store:false clients that only send a parent thread id, so the
          // next turn does not recompute the stale deterministic thread hash. Isolated helper /
          // compaction turns must not park their throwaway id under the parent thread key.
          if (_parsed._clientThreadId && _parsed._cursorIsolateConversation !== true) {
            rememberCursorThreadConversation(
              _parsed._clientThreadId,
              request.conversationId,
              _parsed._cursorIdentityScope,
            );
          }
          await runOnce(request);
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
          ...(partialUsage ? { usage: partialUsage } : {}),
        });
      }
    },
  };
}
