import type { AdapterEvent, OcxProviderConfig } from "../types";
import type { ProviderAdapter } from "./base";
import { cursorExecDeniedMessage } from "./cursor/exec-policy";
import { createCursorKvStore, type CursorKvStore } from "./cursor/kv-store";
import { mapCursorServerMessage } from "./cursor/message-mapper";
import { createCursorRequest } from "./cursor/request-builder";
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
  "Cursor adapter scaffold is installed, but live Cursor transport is disabled in this build.",
  "This prevents accidental file writes or shell execution while the exec bridge is not audited.",
  "Manual config may use adapter=\"cursor\", but all Cursor read/write/shell/delete/MCP requests remain denied.",
].join(" ");

export interface CursorAdapterDeps {
  createTransport?: CursorTransportFactory;
  kv?: CursorKvStore;
}

function safeCursorTransportError(err: unknown): string {
  if (err instanceof CursorTransportDisabledError) return CURSOR_TRANSPORT_DISABLED_MESSAGE;
  return [
    "Cursor transport failed before completion.",
    "No Cursor native file, shell, MCP, fetch, screen, or computer-use command was executed.",
  ].join(" ");
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
      const transport = (deps.createTransport ?? createDisabledCursorTransport)(provider);
      const kv = deps.kv ?? createCursorKvStore();
      const request = createCursorRequest(_parsed);
      try {
        for await (const message of transport.run(request, incoming.abortSignal)) {
          if (incoming.abortSignal?.aborted) {
            emit({ type: "error", message: "Cursor turn was aborted." });
            return;
          }
          const events = mapCursorServerMessage(message, {
            kv,
            writeClient: clientMessage => {
              void transport.writeClient(clientMessage);
            },
          });
          for (const event of events) emit(event);
        }
      } catch (err) {
        emit({ type: "error", message: safeCursorTransportError(err) });
      } finally {
        await transport.close?.();
      }
    },
  };
}
