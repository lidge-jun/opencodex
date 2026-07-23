import type { AdapterEvent, OcxProviderConfig } from "../types";
import type { ProviderAdapter } from "./base";
import { cursorExecDeniedMessage, cursorRequestDeclaresFullAccess } from "./cursor/exec-policy";
import { isCursorBenignCancelError, isCursorInvalidArgumentError, safeCursorErrorMessage } from "./cursor/cursor-errors";
import { isCursorExternalWireModel } from "./cursor/discovery";
import { createCursorKvStore, type CursorKvStore } from "./cursor/kv-store";
import { mapCursorServerMessage } from "./cursor/message-mapper";
import { createCursorRequest, generatedCursorConversationId } from "./cursor/request-builder";
import {
  createLiveCursorTransport,
  CursorMissingCredentialError,
  rekeyCursorContextUsage,
} from "./cursor/live-transport";
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
        _parsed._cursorConversationId ??= generatedCursorConversationId();
        const previousConversationId = _parsed._cursorConversationId;
        let request = createCursorRequest(_parsed);
        // Keep remembered conversation id in sync when the request builder mints a fresh id
        // for external-model tool-result continuations (stateless replay).
        if (request.conversationId !== previousConversationId) {
          rekeyContextUsage(previousConversationId, request.conversationId);
        }
        _parsed._cursorConversationId = request.conversationId;
        let emittedOutput = false;
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
          // One-shot fallback: only for external-model tool-result continuations that fail
          // with Connect invalid_argument before any non-heartbeat output was forwarded.
          // Replaying after text/tool events would duplicate output.
          if (
            !isCursorInvalidArgumentError(err)
            || !isCursorExternalWireModel(request.modelId)
            || !lastRawIsToolResult
            || emittedOutput
            || incoming.abortSignal?.aborted
          ) {
            throw err;
          }
          const failedConversationId = request.conversationId;
          _parsed._cursorConversationId = undefined;
          request = createCursorRequest(_parsed, { forceFreshConversation: true });
          rekeyContextUsage(failedConversationId, request.conversationId);
          _parsed._cursorConversationId = request.conversationId;
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
