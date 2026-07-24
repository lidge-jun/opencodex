import { createHash } from "node:crypto";
import type { AdapterEvent, OcxProviderConfig } from "../types";
import type { ProviderAdapter } from "./base";
import { cursorExecDeniedMessage, cursorRequestDeclaresFullAccess } from "./cursor/exec-policy";
import { isCursorBenignCancelError, isCursorInvalidArgumentError, safeCursorErrorMessage } from "./cursor/cursor-errors";
import { isCursorExternalWireModel } from "./cursor/discovery";
import { createCursorKvStore, type CursorKvStore } from "./cursor/kv-store";
import { mapCursorServerMessage } from "./cursor/message-mapper";
import { createCursorRequest } from "./cursor/request-builder";
import {
  createLiveCursorTransport,
  CursorMissingCredentialError,
  rekeyCursorContextUsage,
  resolveCursorToken,
} from "./cursor/live-transport";
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

function safeCursorTransportError(err: unknown): string {
  if (err instanceof CursorTransportDisabledError) return CURSOR_TRANSPORT_DISABLED_MESSAGE;
  if (err instanceof CursorMissingCredentialError) {
    return "Cursor live transport is enabled, but no Cursor access token is configured. Set provider.apiKey or OPENCODEX_CURSOR_TEST_TOKEN.";
  }
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
  if (message) return safeCursorErrorMessage(message);
  return "Cursor upstream error: transport failed before completion.";
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
      try {
        const makeTransport = deps.createTransport ?? createLiveCursorTransport;
        const kv = deps.kv ?? createCursorKvStore();
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
        const previousConversationId = _parsed._cursorConversationId;
        let request = createCursorRequest(_parsed);
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

        const runOnce = async (activeRequest: ReturnType<typeof createCursorRequest>) => {
          await runCursorTurnWithRetry(
            makeTransport,
            {
              provider,
              headers: incoming.headers,
              requestDeclaresFullAccess: cursorRequestDeclaresFullAccess(activeRequest),
            },
            activeRequest,
            incoming.abortSignal,
            (message, activeTransport) => {
              if (incoming.abortSignal?.aborted) {
                emit({ type: "error", message: "Cursor turn was aborted." });
                return;
              }
              if (message.type === "local_side_effect") replayUnsafe = true;
              const events = mapCursorServerMessage(message, {
                kv,
                writeClient: clientMessage => {
                  void activeTransport.writeClient(clientMessage);
                },
              });
              for (const event of events) {
                if (event.type !== "heartbeat") emittedOutput = true;
                emit(event);
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
      } catch (err) {
        if (isCursorBenignCancelError(err)) return;
        const partialUsage = (err as { partialUsage?: import("../types").OcxUsage }).partialUsage;
        emit({ type: "error", message: safeCursorTransportError(err), ...(partialUsage ? { usage: partialUsage } : {}) });
      }
    },
  };
}
