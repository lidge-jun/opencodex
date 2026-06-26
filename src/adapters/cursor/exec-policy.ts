import type { CursorClientMessage } from "./types";

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

export function cursorExecResult(requestId: string, execCase: string): CursorClientMessage {
  if (execCase === "requestContextArgs") {
    return {
      type: "exec_result",
      requestId,
      ok: true,
      message: "Cursor request context is empty in safe scaffold mode.",
    };
  }
  return {
    type: "exec_result",
    requestId,
    ok: false,
    message: cursorExecDeniedMessage(execCase),
  };
}
