/**
 * Cursor tool-result normalization for Computer Use / node_repl surfaces (#1920/#1866).
 *
 * Scoped re-implementation of PR #1920 per the 260818 campaign disposition
 * (REDESIGN-SMALL: "apply formatted.text at native toolResultPart + decode test").
 * Only empty-output and known-failure-state normalization ships here; screenshot
 * stripping and AXTree text compaction from the original PR are deliberately out
 * of scope (the native path already bounds step size by real serialized bytes,
 * dropping images oldest-first — see toolCallStep in protobuf-request.ts).
 */

import {
  EMPTY_EXEC_OUTPUT_MESSAGE,
  EMPTY_EXEC_OUTPUT_REGEX,
  FAILED_EXEC_OUTPUT_MESSAGE,
  isFailedEmptyExecWrapper,
  isCodexExecBridgeTool,
} from "../exec-tool-result-normalize";

/**
 * Cursor treats a failed-but-empty wrapper as an empty result too (its Computer Use branch marks
 * such results `isError` separately). The shared success regex deliberately excludes
 * `Script failed`, so restore that arm here rather than widening the shared one.
 */
function isEmptyOrFailedExecWrapper(text: string): boolean {
  return EMPTY_EXEC_OUTPUT_REGEX.test(text) || isFailedEmptyExecWrapper(text);
}

const COMPUTER_USE_TOOL_NAMES = new Set([
  "node_repl",
  "node_repl__js",
  "mcp__node_repl__js",
  "get_app_state",
  "list_apps",
  "screenshot",
  "computer_use",
]);

function isNodeReplOrComputerUseTool(toolName?: string, toolNamespace?: string): boolean {
  if (toolNamespace && (toolNamespace === "mcp__node_repl" || toolNamespace.includes("node_repl") || toolNamespace.includes("computer_use"))) {
    return true;
  }
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  if (COMPUTER_USE_TOOL_NAMES.has(lower)) return true;
  return lower.startsWith("mcp__node_repl") || lower.startsWith("mcp__computer_use");
}

/** Failure states the Computer Use / node_repl runtime reports as PLAIN TEXT inside a non-error result. */
const RUNTIME_FAILURE_GUIDANCE: ReadonlyArray<{ marker: string; guidance: string }> = [
  {
    marker: "SkyComputerUseError",
    guidance: "The Computer Use runtime rejected this action. Re-check application state with get_app_state before retrying.",
  },
  {
    marker: "sky is not defined",
    guidance: "The sky binding is unavailable in this context; Computer Use calls only work inside the privileged node_repl session.",
  },
  {
    marker: "has already been declared",
    guidance: "The node_repl session keeps earlier declarations; rename the variable or use var/reassignment instead of redeclaring.",
  },
  {
    marker: "unsupported import in exec",
    guidance: "Imports are not available in this exec context; use the injected globals instead.",
  },
];

export interface NormalizedToolResultText {
  text: string;
  isError: boolean;
  /** True when normalization changed either field (lets callers skip work on the common path). */
  changed: boolean;
}

/**
 * Normalize a Cursor-bound tool-result TEXT payload:
 *  - blank / empty-exec-wrapper output on Computer Use or node_repl tools becomes an
 *    actionable error instead of an empty string the model silently accepts;
 *  - known runtime failure states reported as plain text are marked isError with a
 *    one-line recovery hint appended.
 * Everything else passes through byte-identical.
 */
export function normalizeCursorToolResultText(
  text: string,
  options: { toolName?: string; toolNamespace?: string; isError?: boolean } = {},
): NormalizedToolResultText {
  const isError = options.isError === true;
  const computerUse = isNodeReplOrComputerUseTool(options.toolName, options.toolNamespace);
  if (computerUse && isEmptyOrFailedExecWrapper(text.trim())) {
    return {
      text: "[empty output: the tool ran but produced no stdout or return value. Verify application state with get_app_state, or make the script emit output.]",
      isError: true,
      changed: true,
    };
  }
  if (isCodexExecBridgeTool(options.toolName, options.toolNamespace) && isEmptyOrFailedExecWrapper(text.trim())) {
    return {
      // A `Script failed` wrapper is empty but NOT a success: reporting it as an empty success
      // would erase the only failure signal. Text classification stays separate from Cursor's
      // isError policy, which the Computer Use branch above owns.
      text: isFailedEmptyExecWrapper(text.trim()) ? FAILED_EXEC_OUTPUT_MESSAGE : EMPTY_EXEC_OUTPUT_MESSAGE,
      isError: false,
      changed: true,
    };
  }
  if (!isError) {
    for (const { marker, guidance } of RUNTIME_FAILURE_GUIDANCE) {
      if (text.includes(marker)) {
        return { text: `${text}\n[recovery: ${guidance}]`, isError: true, changed: true };
      }
    }
  }
  return { text, isError, changed: false };
}
