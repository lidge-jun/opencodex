import type { AdapterEvent, OcxProviderConfig } from "../types";
import type { ProviderAdapter } from "./base";

export const CURSOR_API_URL = "https://api2.cursor.sh";

export const CURSOR_EXEC_CASES_DENIED = [
  "readArgs",
  "lsArgs",
  "grepArgs",
  "writeArgs",
  "deleteArgs",
  "shellArgs",
  "shellStreamArgs",
  "diagnosticsArgs",
  "mcpArgs",
  "fetchArgs",
  "recordScreenArgs",
  "computerUseArgs",
  "unknownExecCase",
] as const;

export type CursorDeniedExecCase = (typeof CURSOR_EXEC_CASES_DENIED)[number];

export function cursorExecDeniedMessage(execCase: string): string {
  return [
    `Cursor exec request denied (${execCase}).`,
    "The Cursor bridge is installed in safe scaffold mode.",
    "No read, write, delete, shell, diagnostics, MCP, fetch, screen, or computer-use command was executed.",
  ].join(" ");
}

export function createCursorAdapter(provider: OcxProviderConfig): ProviderAdapter {
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
      emit({
        type: "error",
        message: [
          "Cursor adapter scaffold is installed, but live Cursor transport is disabled in this build.",
          "This prevents accidental file writes or shell execution while the exec bridge is not audited.",
          "Manual config may use adapter=\"cursor\", but all Cursor read/write/shell/delete/MCP requests remain denied.",
        ].join(" "),
      });
    },
  };
}
