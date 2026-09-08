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
 * `function_call_output` is parsed with `isError: false`. Cursor combines this set with
 * `isFailedEmptyExecWrapper` below for Computer Use, where a failed wrapper is separately marked
 * `isError`.
 */
export const EMPTY_EXEC_OUTPUT_REGEX = /^(?:(?:Script completed|Command finished|Execution finished)[^\n]*\n+)?(?:Wall time[^\n]*\n+)?(?:Output:\s*)?(?:<empty>)?\s*$/;

function skipFailedWrapperBlankSeparators(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    if (text[index] === "\n") {
      index += 1;
      continue;
    }
    // A CRLF blank line is one separator, not a stray carriage return. The regex this replaced
    // matched only `\n`, so a Windows-produced wrapper never classified and the failure guidance
    // was silently replaced by the empty-SUCCESS message on that platform.
    if (text[index] === "\r" && text[index + 1] === "\n") {
      index += 2;
      continue;
    }
    break;
  }
  return index;
}

function skipFailedWrapperWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && text[index]!.trim() === "") index += 1;
  return index;
}

function skipFailedWrapperLine(text: string, start: number): number {
  const newline = text.indexOf("\n", start);
  return newline === -1 ? text.length : skipFailedWrapperBlankSeparators(text, newline + 1);
}

/**
 * Wrapper for a cell that FAILED without emitting output: empty, but not a success.
 *
 * A single forward scan, replacing a regex whose `\n*` and `\s*` runs sat adjacent over the same
 * span and could be made to backtrack on a long whitespace run followed by one non-matching
 * character. Every loop here advances an index monotonically and the token checks are fixed-length,
 * so the work is bounded by the input length with no path that retries a prefix.
 *
 * Two boundaries are load-bearing and both were divergences in an earlier attempt at this rewrite:
 *
 * - Whitespace after `Output:` may precede the marker, so an INDENTED `<empty>` still classifies.
 *   Rejecting it would leave the wrapper unnormalized and the failure unexplained.
 * - Only whitespace may follow the marker, so a DUPLICATE `<empty>` still does not classify.
 *   Accepting it would erase a real payload as an empty failed wrapper — the damaging direction.
 *
 * Behaviour is otherwise identical to the regex; the CRLF separators above are the only
 * intentional change, verified against a 63-shape differential corpus.
 */
export function isFailedEmptyExecWrapper(trimmed: string): boolean {
  if (!trimmed.startsWith("Script failed")) return false;

  const firstNewline = trimmed.indexOf("\n", "Script failed".length);
  if (firstNewline === -1) return true;

  let index = skipFailedWrapperBlankSeparators(trimmed, firstNewline + 1);
  if (trimmed.startsWith("Wall time", index)) {
    index = skipFailedWrapperLine(trimmed, index);
  }
  if (trimmed.startsWith("Output:", index)) {
    index = skipFailedWrapperWhitespace(trimmed, index + "Output:".length);
  }
  if (trimmed.startsWith("<empty>", index)) {
    index += "<empty>".length;
  }
  return skipFailedWrapperWhitespace(trimmed, index) === trimmed.length;
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
  "Nothing in the isolate is echoed automatically: a bare trailing `await tools.<name>(...)` or final expression value is DISCARDED, and the cell reports empty output. Pass anything you need to read to `text(...)` (or `notify(...)`) in the same cell — for example `text(JSON.stringify(await tools.exec_command({cmd: 'ls'})))` — and treat an empty result as your own missing `text(...)` call rather than a failed command or lost context.";

/**
 * Host rules a routed model most often breaks on its first code-mode edit or wait, stated BEFORE
 * the call. Wording tracks the Codex host (0.153.2), probed live on 2026-09-07: a non-string
 * argument to `apply_patch` throws "expects a string input"; a body whose first line is not the
 * bare marker (decorated `*** Begin Patch ***`, a code fence, prose) throws "The first line of the
 * patch must be '*** Begin Patch'" — surrounding newlines are tolerated; ES imports throw
 * "Unsupported import in exec"; a command that outlives `yield_time_ms` returns `session_id` for
 * `write_stdin` polling. xai/grok-4.6 hit the first two, abandoned apply_patch for heredoc writes,
 * blocked a turn in a shell sleep loop, and died once on an import. None of that is repairable in
 * the proxy (devlog/_plan/260905_apply_patch_envelope_gap/010 MODE B); it is a contract the proxy
 * had not stated.
 */
export const CODE_MODE_HOST_CONTRACT_SENTENCE =
  "Host contract for the nested helpers: `tools.apply_patch(patch)` takes exactly one string, never an object such as `{input: ...}`; the patch text opens with the bare marker line `*** Begin Patch` and closes with the bare marker line `*** End Patch`, written without a code fence, prose, or extra asterisks on those lines (blank lines or indentation around the markers are tolerated; a decorated or missing marker is rejected). The isolate has no `import`, `require`, or module loader; use the globals the exec tool description lists (for example `tools`, `text`, `notify`, `store`/`load`, `ALL_TOOLS`). For a command that may outlive `yield_time_ms`, let `tools.exec_command` return a `session_id` and poll it on later calls with `tools.write_stdin({session_id, chars: \"\"})` instead of blocking a shell in a sleep loop.";

/**
 * Post-hoc half of the host contract: the four host strings a routed model reads inside a
 * non-error exec result, each paired with the rule it broke. Matched case-insensitively because
 * the host writes "Unsupported import in exec: <spec>" while Cursor's earlier marker was
 * lowercase; one table, one owner, so this text and the pre-call sentence cannot drift.
 */
export const CODE_MODE_HOST_FAILURE_GUIDANCE: ReadonlyArray<{ marker: string; guidance: string }> = [
  {
    marker: "expects a string input",
    guidance: "tools.apply_patch takes exactly one string argument; pass the patch text itself, not an object such as {input: ...}.",
  },
  {
    marker: "the first line of the patch must be",
    guidance: "The patch text must open with the bare marker line `*** Begin Patch`: no code fence, prose, or extra asterisks on that line (blank lines or indentation before it are tolerated).",
  },
  {
    marker: "the last line of the patch must be",
    guidance: "The patch text must close with the bare marker line `*** End Patch`: no trailing text or extra asterisks on that line (blank lines after it are tolerated).",
  },
  {
    marker: "unsupported import in exec",
    guidance: "Imports are not available in this exec context; use the injected globals (tools, text, notify, store, load, ALL_TOOLS) instead.",
  },
];

/** Prefix of every recovery line this module appends; callers use it to recognise replayed annotations. */
export const CODE_MODE_HOST_RECOVERY_PREFIX = "[recovery: ";

// Only a leading failure envelope or a complete host diagnostic establishes error context.
// Do not search for this prefix inside output: successful source reads can quote any of these.
const CODE_MODE_HOST_ERROR_PREFIX = /^(?:Script failed(?:[ \t]*(?:\r?\n|$)|:)|Script error:|(?:Error|TypeError|SyntaxError):|tool `apply_patch` expects a string input\b|apply_patch verification failed:|Unsupported import in exec:)/i;

/** Namespaces under which Cursor displays Codex's own Responses tools (see cursor/tool-naming.ts). */
const CODEX_RESPONSES_DISPLAY_NAMESPACES: ReadonlySet<string> = new Set(["opencodex-responses", "mcp__opencodex-responses"]);
/** Flattened spellings of the same code-mode exec when a client folds the namespace into the name. */
const CODEX_CODE_MODE_EXEC_ALIASES: ReadonlySet<string> = new Set(["exec", "mcp__opencodex-responses__exec", "mcp_opencodex-responses_exec"]);

/**
 * The code-mode `exec` tool by NAME — bare, or under Codex's own `opencodex-responses` display
 * namespace, matched exactly. The four host strings above originate only in that isolate, so flat
 * shell bridges (`exec_command`, `shell`, …) and every other namespace (`mcp__docker`,
 * `mcp__foreign-opencodex-responses`) are excluded: an unrelated server's output that quotes the
 * phrase must not receive Codex guidance. Narrower than `isCodexExecBridgeTool` on purpose; the
 * empty-output repair keeps the wider gate. Callers that KNOW the catalog shape (Kiro's
 * `codeModeExecName`, the Responses body gate) add that check on top; this predicate alone cannot
 * tell a structured tool named `exec` from the freeform one.
 */
export function isCodexCodeModeExecResult(toolName?: string, toolNamespace?: string): boolean {
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  if (toolNamespace !== undefined) return CODEX_RESPONSES_DISPLAY_NAMESPACES.has(toolNamespace) && lower === "exec";
  return CODEX_CODE_MODE_EXEC_ALIASES.has(lower);
}

/**
 * Append a one-line recovery hint when a code-mode exec result starts with a host error context
 * and carries a known diagnostic. Successful wrappers and unframed phrase quotations pass through.
 * Returns undefined when the tool/context/marker does not match or a recovery line is already
 * present (a replayed result must not grow a second one). Never touches error status.
 */
export function annotateCodeModeHostFailure(
  text: string,
  options: { toolName?: string; toolNamespace?: string } = {},
): string | undefined {
  if (!isCodexCodeModeExecResult(options.toolName, options.toolNamespace)) return undefined;
  if (text.includes(CODE_MODE_HOST_RECOVERY_PREFIX)) return undefined;
  if (!CODE_MODE_HOST_ERROR_PREFIX.test(text.trimStart())) return undefined;
  const lower = text.toLowerCase();
  const hit = CODE_MODE_HOST_FAILURE_GUIDANCE.find(({ marker }) => lower.includes(marker));
  return hit ? `${text}\n${CODE_MODE_HOST_RECOVERY_PREFIX}${hit.guidance}]` : undefined;
}

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
