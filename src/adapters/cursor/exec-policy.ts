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
    `Cursor legacy mock transport cannot execute ${execCase}.`,
    "Production Cursor requests use the live protobuf native exec bridge.",
    "The legacy mock path returns a non-executing placeholder for tests only.",
  ].join(" ");
}

export function cursorExecResult(requestId: string, execCase: string): CursorClientMessage {
  if (execCase === "requestContextArgs") {
    return {
      type: "exec_result",
      requestId,
      ok: true,
      message: "Cursor request context is empty in legacy mock transport mode.",
    };
  }
  return {
    type: "exec_result",
    requestId,
    ok: false,
    message: cursorExecDeniedMessage(execCase),
  };
}
