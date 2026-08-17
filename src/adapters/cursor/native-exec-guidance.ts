export const CODE_MODE_BRIDGE_GUIDANCE =
  "This request uses Codex code mode. Call the top-level `exec` tool with JavaScript in its body, then call `await tools.exec_command({ ... })` inside that body and emit the result with `text(...)`. Do not call `shell_command`, `exec_command`, or `mcp_opencodex-responses_*` as top-level tools; those names are nested helpers in code mode.";

export function codeModeBridgeGuidance(enabled: boolean | undefined): string | undefined {
  return enabled === true ? CODE_MODE_BRIDGE_GUIDANCE : undefined;
}

export function codeModeNestedHelperGuidance(enabled: boolean | undefined): string | undefined {
  return enabled === true
    ? "This request uses Codex code mode. Call the top-level `exec` tool with JavaScript in its body, then call the matching `await tools.<helper>(...)` listed in that tool's description and emit the result with `text(...)`. Do not call nested helper names as top-level tools."
    : undefined;
}
