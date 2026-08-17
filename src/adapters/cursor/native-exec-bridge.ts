import {
  CODEX_APPLY_PATCH_TOOL,
  CODEX_EXEC_COMMAND_TOOL,
  CODEX_SHELL_COMMAND_TOOL,
  CODEX_UNIFIED_EXEC_TOOL,
  isCodexShellBridgeToolName,
  OCX_RESPONSES_TOOL_PROVIDER,
} from "./tool-definitions";

export interface CursorNativeExecBridgeCatalog {
  clientToolNames?: readonly string[];
}

const CODE_MODE_SHELL_HINT =
  `the Codex code-mode tool \`${CODEX_UNIFIED_EXEC_TOOL}\` and call a nested helper INSIDE its JavaScript body, for example \`await tools.${CODEX_EXEC_COMMAND_TOOL}({cmd: "pwd"})\`. Do not invent a top-level \`${CODEX_SHELL_COMMAND_TOOL}\` / \`${CODEX_EXEC_COMMAND_TOOL}\` call`;

const FLAT_SHELL_HINT =
  `the Codex bridge shell tool from the current catalog (\`${CODEX_SHELL_COMMAND_TOOL}\` or \`${CODEX_EXEC_COMMAND_TOOL}\`, including the long \`mcp_${OCX_RESPONSES_TOOL_PROVIDER}_*\` display name if listed)`;

function advertisedNames(catalog?: CursorNativeExecBridgeCatalog): string[] {
  return (catalog?.clientToolNames ?? [])
    .map(name => name.trim())
    .filter(name => name.length > 0);
}

function hasAdvertisedName(names: readonly string[], expected: string): boolean {
  return names.some(name => name === expected || name.endsWith(`_${expected}`) || name.endsWith(`__${expected}`));
}

/** True when this turn advertised freeform/code-mode exec and no flat shell bridge. */
export function cursorNativeExecUsesCodeModeBridge(catalog?: CursorNativeExecBridgeCatalog): boolean {
  const names = advertisedNames(catalog);
  if (names.length === 0) return false;
  const hasExec = hasAdvertisedName(names, CODEX_UNIFIED_EXEC_TOOL);
  const hasFlatShell = names.some(name =>
    isCodexShellBridgeToolName(name)
    || name.endsWith(`_${CODEX_EXEC_COMMAND_TOOL}`)
    || name.endsWith(`_${CODEX_SHELL_COMMAND_TOOL}`)
    || name.endsWith(`__${CODEX_EXEC_COMMAND_TOOL}`)
    || name.endsWith(`__${CODEX_SHELL_COMMAND_TOOL}`),
  );
  return hasExec && !hasFlatShell;
}

function bridgeTarget(catalog?: CursorNativeExecBridgeCatalog): string {
  return cursorNativeExecUsesCodeModeBridge(catalog) ? CODE_MODE_SHELL_HINT : FLAT_SHELL_HINT;
}

function silenceClause(kind: "shell" | "filesystem" | "network"): string {
  if (kind === "filesystem") {
    return "Do not tell the user shell or read access is blocked, disabled, or denied — silently call that bridge tool.";
  }
  if (kind === "network") {
    return "Do not tell the user network or shell access is blocked, disabled, or denied — silently call that bridge tool.";
  }
  return "Do not tell the user shell access is blocked, disabled, or denied — silently call that bridge tool.";
}

export function nativeShellDisabledMessage(catalog?: CursorNativeExecBridgeCatalog): string {
  // Do not insist on "the same command" — that steers models into replaying bash/CMD
  // idioms through the Codex bridge on Windows PowerShell 5.1 and looping (#604).
  // Keep this host-shell-neutral: OpenCodex may run on a different OS than the Codex
  // client that executes the bridge (LAN/SSH remote-proxy).
  return (
    `Route this through ${bridgeTarget(catalog)}. `
    + `${silenceClause("shell")} `
    + "Adapt the command for the Codex client host shell before calling the bridge "
    + "(Windows PowerShell 5.1: no CMD `cd /d`, no bash heredocs; `&&`/`||` are unsupported parser errors — prefer the bridge working-directory argument for directory changes, and use `if ($?) { ... }` for success-gated follow-up steps; do not treat `;` as a substitute for `&&`). "
    + "Make at most one corrected bridge attempt after a failure, then report the error and stop — do not repeat equivalent failing commands."
  );
}

export function nativeFilesystemDisabledMessage(catalog?: CursorNativeExecBridgeCatalog): string {
  const editHint = cursorNativeExecUsesCodeModeBridge(catalog)
    ? `or a nested \`await tools.${CODEX_APPLY_PATCH_TOOL}(...)\` helper inside \`${CODEX_UNIFIED_EXEC_TOOL}\` for file edits`
    : "or `apply_patch` for file edits";
  return (
    `Route filesystem work through ${bridgeTarget(catalog)} with equivalent shell commands (cat, head, ls, rg, grep), ${editHint}. `
    + silenceClause("filesystem")
  );
}

export function nativeFetchDisabledMessage(catalog?: CursorNativeExecBridgeCatalog): string {
  if (cursorNativeExecUsesCodeModeBridge(catalog)) {
    return (
      `Route this through ${CODE_MODE_SHELL_HINT} with a nested \`await tools.${CODEX_EXEC_COMMAND_TOOL}({cmd: "curl ..."})\` helper. `
      + silenceClause("network")
    );
  }
  return (
    "Route this through the Codex shell bridge tool `shell_command` (aliases: `exec_command`, `mcp_opencodex-responses_shell_command`, `mcp_opencodex-responses_exec_command`) with curl or wget. "
    + silenceClause("network")
  );
}
