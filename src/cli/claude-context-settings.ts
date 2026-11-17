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
  options: { selectors?: readonly string[]; platform?: NodeJS.Platform } = {},
): { args: string[]; env: ClaudeLaunchEnv } {
  const unchanged = { args, env };
  // An operator's env/CLI policy remains authoritative. Native launches never call this helper.
  if (base.CLAUDE_CODE_AUTO_COMPACT_WINDOW) return unchanged;
  const auto = resolveAutoContext(config.claudeCode);
  if (!auto.enabled) return unchanged;
  const separator = args.indexOf("--");
  const cliOptions = separator < 0 ? args : args.slice(0, separator);
  // Do not reinterpret the client's settings grammar, files, or repeated-option precedence.
  if (cliOptions.some(arg => arg === "--settings" || arg.startsWith("--settings=")
    || arg === "--autocompact" || arg.startsWith("--autocompact="))) return unchanged;

  const modelSettings: Record<string, { autoCompactWindow: number }> = Object.create(null);
  const selectors = new Set(options.selectors ?? []);
  for (const key of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"]) {
    if (env[key]) selectors.add(env[key]!);
  }
  for (const selector of selectors) {
    const window = contextWindows[selector] ?? contextWindows[selector.replace(/\[1m\]$/i, "")];
    if (window === undefined) continue;
    if (!Number.isSafeInteger(window) || window >= auto.compactWindow || window < AUTO_COMPACT_WINDOW_MIN) continue;
    // Reserve space for summarization, without exceeding the client's supported compact range.
    const compactWindow = Math.floor(window * 0.95);
    if (compactWindow >= AUTO_COMPACT_WINDOW_MIN) modelSettings[selector] = { autoCompactWindow: compactWindow };
  }
  if (Object.keys(modelSettings).length === 0) return unchanged;

  const serialized = JSON.stringify({ autoCompactWindow: auto.compactWindow, modelSettings });
  // Leave headroom for cmd.exe shim escaping and the rest of the command line.
  const budget = (options.platform ?? process.platform) === "win32" ? 4000 : 32000;
  if (serialized.length > budget) return unchanged;
  const childEnv = { ...env };
  delete childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  return { args: ["--settings", serialized, ...args], env: childEnv };
}
