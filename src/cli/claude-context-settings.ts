import { resolveAutoContext, AUTO_COMPACT_WINDOW_MIN } from "../claude/context-windows";
import type { OcxConfig } from "../types";
import type { ClaudeLaunchEnv } from "./claude";

/** Session-only compact windows: the current model selects its setting after /model switches. */
export function withClaudeContextSettings(
  args: string[],
  env: ClaudeLaunchEnv,
  config: OcxConfig,
  contextWindows: Record<string, number>,
  base: ClaudeLaunchEnv,
): { args: string[]; env: ClaudeLaunchEnv } {
  const unchanged = { args, env };
  // An operator's env/CLI policy remains authoritative. Native launches never call this helper.
  if (base.CLAUDE_CODE_AUTO_COMPACT_WINDOW) return unchanged;
  const auto = resolveAutoContext(config.claudeCode);
  if (!auto.enabled) return unchanged;
  const separator = args.indexOf("--");
  const options = separator < 0 ? args : args.slice(0, separator);
  // Do not reinterpret the client's settings grammar, files, or repeated-option precedence.
  if (options.some(arg => arg === "--settings" || arg.startsWith("--settings=")
    || arg === "--autocompact" || arg.startsWith("--autocompact="))) return unchanged;

  const modelSettings: Record<string, { autoCompactWindow: number }> = Object.create(null);
  for (const [selector, window] of Object.entries(contextWindows)) {
    if (!Number.isSafeInteger(window) || window >= auto.compactWindow || window < AUTO_COMPACT_WINDOW_MIN) continue;
    // Reserve space for summarization, without exceeding the client's supported compact range.
    const compactWindow = Math.floor(window * 0.95);
    if (compactWindow >= AUTO_COMPACT_WINDOW_MIN) modelSettings[selector] = { autoCompactWindow: compactWindow };
  }
  if (Object.keys(modelSettings).length === 0) return unchanged;

  const settings = { autoCompactWindow: auto.compactWindow, modelSettings };
  const childEnv = { ...env };
  delete childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  return { args: ["--settings", JSON.stringify(settings), ...args], env: childEnv };
}
