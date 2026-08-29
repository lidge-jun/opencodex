/**
 * Provider-neutral empty-exec-output normalization.
 *
 * A code-mode `exec` cell that never calls `text()`/`notify()` returns nothing: the last
 * expression value is NOT echoed automatically. The routed model reads a blank tool result,
 * concludes its earlier output was lost, and burns turns re-running the same call or restarting
 * the task from scratch. Naming that state explicitly is what breaks the loop.
 *
 * This module owns the shared detection so every adapter reports the same thing. Cursor keeps its
 * own wrapper (`normalizeCursorToolResultText`) for Computer Use precedence and isError policy;
 * Kiro consumes this helper directly.
 */

/**
 * Matches exec wrappers whose only payload is an empty-output marker.
 *
 * `Script failed` is deliberately NOT in this set. A failed cell with no captured output is still
 * a FAILURE, and the success guidance below ("not a blocked tool", "do not re-run") would erase the
 * only signal that anything went wrong — reachable through Responses history, where
 * `function_call_output` is parsed with `isError: false`. Cursor keeps its own broader regex for
 * Computer Use, where a failed wrapper is separately marked `isError`.
 */
export const EMPTY_EXEC_OUTPUT_REGEX = /^(?:(?:Script completed|Command finished|Execution finished)[^\n]*\n+)?(?:Wall time[^\n]*\n+)?(?:Output:\s*)?(?:<empty>)?\s*$/;

/**
 * True when a trimmed exec wrapper says the cell FAILED and carried no output.
 *
 * Deliberately a line scan rather than a regex. The equivalent pattern needs a run of
 * `[^\n]*`, `\n*`, `\s*` groups that can each match the same whitespace, so a malformed
 * wrapper that never completes the match makes the engine try every split between them.
 * Measured on Bun 1.4: a single `Script failed` line padded with 30k spaces took ~820ms
 * and 60k took ~3.1s — quadratic, on text that arrives from a tool result and can be
 * attacker-influenced. Each line here is classified exactly once, so there is nothing to
 * backtrack over: the same 60k input is ~0.02ms.
 *
 * Blank separator lines are matched the way the previous pattern's `\n*` did — a line of
 * spaces is NOT a separator, only a genuinely empty one is — except that a CRLF blank line
 * now counts. The old pattern accepted `\n\n` but not `\r\n\r\n`, so a CRLF wrapper was
 * reported as an empty SUCCESS and the failure signal was erased. That was a latent bug,
 * and fixing it is the point of describing the boundary explicitly.
 */
export function isFailedEmptyExecWrapper(trimmed: string): boolean {
  if (!trimmed.startsWith("Script failed")) return false;
  const lines = trimmed.split(/\r?\n/);
  let i = 1;
  const skipEmpty = (): void => { while (i < lines.length && lines[i] === "") i++; };
  skipEmpty();
  if (i < lines.length && lines[i]!.startsWith("Wall time")) { i++; skipEmpty(); }
  if (i < lines.length && lines[i]!.startsWith("Output:")) {
    const after = lines[i]!.slice("Output:".length).trim();
    // Real payload after the marker: this wrapper is not empty and must pass through.
    if (after !== "" && after !== "<empty>") return false;
    i++;
    // A bare `Output:` left the old `\s*` free to swallow any trailing whitespace,
    // including whitespace-only lines; `Output: <empty>` consumed the marker first and
    // only `\n*`-style empty lines could follow.
    if (after === "") { while (i < lines.length && lines[i]!.trim() === "") i++; }
    else skipEmpty();
  }
  if (i < lines.length && lines[i] === "<empty>") { i++; skipEmpty(); }
  while (i < lines.length && lines[i]!.trim() === "") i++;
  return i >= lines.length;
}

/** Guidance for a failed cell whose output was empty: the failure must survive normalization. */
export const FAILED_EXEC_OUTPUT_MESSAGE =
  "[exec failed with no captured output: the cell raised before emitting anything. This is a real failure, not an empty success — inspect the call for a thrown error or syntax problem before retrying.]";

/**
 * The guidance itself. Worded to close all three wrong conclusions a model draws from a blank
 * result: that context was lost, that the tool is blocked, and that retrying will differ.
 */
export const EMPTY_EXEC_OUTPUT_MESSAGE =
  "[empty output: the exec cell completed but emitted nothing. This is NOT lost context and NOT a blocked tool — in code mode call text(...) or notify(...) on any value you need to see (a bare await tools.exec_command(...) is not echoed automatically); in shell mode the command simply printed nothing. Do not re-run the same call expecting different output.]";

/**
 * The SAME rule stated BEFORE the first call, for the code-mode tool-catalog nudge.
 *
 * `EMPTY_EXEC_OUTPUT_MESSAGE` above is a repair: it fires only after a model has already spent a
 * call and read a blank result. That recovers the turn but cannot prevent the wasted round trip,
 * and the model still has to guess whether its command failed or its output was merely dropped.
 * Stating the echo rule up front removes the failure instead of explaining it afterwards.
 *
 * Kept beside the recovery text on purpose: the two are one pair guarding one defect, and wording
 * that drifts apart is how a model gets told two different things about the same isolate.
 */
export const CODE_MODE_RESULT_ECHO_SENTENCE =
  "Nothing in the isolate is echoed automatically: a bare trailing `await tools.<name>(...)` or final expression value is DISCARDED, and the cell reports empty output. Pass anything you need to read to `text(...)` (or `notify(...)`) in the same cell — for example `text(JSON.stringify(await tools.exec_command({cmd: \"ls\"})))` — and treat an empty result as your own missing `text(...)` call rather than a failed command or lost context.";

/**
 * Codex exec / shell-bridge tool names (flat and MCP-prefixed display aliases). An empty result
 * here is almost always a code-mode cell that never called text()/notify().
 */
export function isCodexExecBridgeTool(toolName?: string, toolNamespace?: string): boolean {
  if (toolNamespace && toolNamespace.includes("opencodex-responses")) return true;
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  return (
    lower === "exec"
    || lower === "exec_command"
    || lower === "shell_command"
    // Codex CLI/desktop native tool names: the multi-round "이전 출력이 비어 있어 처음부터"
    // restart loop reproduced via codex exec because `shell` was not in this set
    // (devlog 260826 gap-8 QA round 2).
    || lower === "shell"
    || lower === "local_shell"
    || lower === "container.exec"
    || lower.startsWith("mcp_opencodex-responses_")
    || lower.startsWith("mcp__opencodex-responses__")
  );
}

/** True when this result is an exec-bridge call that produced no usable output. */
export function isEmptyExecToolResult(
  text: string,
  options: { toolName?: string; toolNamespace?: string } = {},
): boolean {
  return isCodexExecBridgeTool(options.toolName, options.toolNamespace)
    && EMPTY_EXEC_OUTPUT_REGEX.test(text.trim());
}

/**
 * Returns the guidance text when this is an empty exec-bridge result, else `undefined` so the
 * caller keeps its own fallback. Undefined rather than the original text: an adapter must be able
 * to tell "not my case" from "normalized to the same string".
 */
export function normalizeEmptyExecToolResultText(
  text: string,
  options: { toolName?: string; toolNamespace?: string } = {},
): string | undefined {
  if (!isCodexExecBridgeTool(options.toolName, options.toolNamespace)) return undefined;
  const trimmed = text.trim();
  // Failure first: a failed wrapper must never be described as an empty success.
  if (isFailedEmptyExecWrapper(trimmed)) return FAILED_EXEC_OUTPUT_MESSAGE;
  return EMPTY_EXEC_OUTPUT_REGEX.test(trimmed) ? EMPTY_EXEC_OUTPUT_MESSAGE : undefined;
}
