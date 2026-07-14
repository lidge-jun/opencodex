import type { OcxProviderConfig } from "../../types";
import type { CursorClientMessage } from "./types";

export type CursorNativeExecMode = "off" | "codex-sandbox" | "on";

/** Codex permissions template marker, e.g. "`sandbox_mode` is `danger-full-access`". */
export const CURSOR_SANDBOX_FULL_ACCESS_RE = /sandbox_mode[^\n]{0,80}danger-full-access/i;

/**
 * Config-owner-selected policy; explicit mode wins, legacy boolean maps to "on".
 * The UNSET default is "codex-sandbox": native local exec is APPROVED for requests that
 * declare the Codex danger-full-access sandbox (the normal full-access Codex flow — "approve
 * most") and DENIED for requests that do not. Set `nativeLocalExec: "off"` to deny all, or
 * "on" to always allow. Legacy `unsafeAllowNativeLocalExec: true` still maps to "on".
 * Security note: codex-sandbox trusts a caller-controlled full-access marker the proxy cannot
 * verify, and the auth-free loopback bind admits any local process — see the src/types.ts doc.
 */
export function resolveCursorNativeExecMode(provider: OcxProviderConfig): CursorNativeExecMode {
  const mode = provider.nativeLocalExec;
  if (mode === "off" || mode === "codex-sandbox" || mode === "on") return mode;
  return provider.unsafeAllowNativeLocalExec === true ? "on" : "codex-sandbox";
}

/**
 * True when the request itself declares the Codex full-access sandbox. Carriers are the
 * system/instructions entries and developer-role messages ONLY — user/assistant/tool text
 * never authorizes (smallest spoof surface inside the codex-sandbox mode).
 */
export function cursorRequestDeclaresFullAccess(
  request: { system: string[]; messages: Array<{ role: string; content: string }> },
): boolean {
  for (const entry of request.system) {
    if (CURSOR_SANDBOX_FULL_ACCESS_RE.test(entry)) return true;
  }
  for (const message of request.messages) {
    if (message.role === "developer" && CURSOR_SANDBOX_FULL_ACCESS_RE.test(message.content)) return true;
  }
  return false;
}

/** Effective per-request allowance: "on" always, "codex-sandbox" only when declared, "off" never. */
export function effectiveCursorNativeExecAllow(provider: OcxProviderConfig, requestDeclaresFullAccess: boolean): boolean {
  const mode = resolveCursorNativeExecMode(provider);
  if (mode === "on") return true;
  if (mode === "codex-sandbox") return requestDeclaresFullAccess;
  return false;
}

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
