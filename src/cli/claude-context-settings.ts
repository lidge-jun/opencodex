import { resolveAutoContext, AUTO_COMPACT_WINDOW_MIN } from "../claude/context-windows";
import { escapeCmdArg } from "../lib/win-exec";
import type { OcxConfig } from "../types";
import type { ClaudeLaunchEnv } from "./claude";

// cmd.exe allows 8,191 characters. Reserve room for the shim path and shell wrapper.
const WINDOWS_CLAUDE_ARGV_BUDGET = 7_000;
const REMOTE_CONTROL_VERBS = new Set(["remote-control", "rc", "bridge", "remote", "sync"]);

// Leading options from `claude --help`. Keep the value arity so an option's
// argument cannot be mistaken for a Remote Control verb.
const CLAUDE_VALUE_OPTIONS = new Set([
  "--agent", "--agents", "--append-system-prompt", "--append-system-prompt-file", "--autocompact",
  "--cloud", "-d", "--debug", "--debug-file", "--effort", "--environment", "--fallback-model",
  "--from-pr", "--input-format", "--json-schema", "--max-budget-usd", "--model", "-n", "--name",
  "--output-format", "--permission-mode", "--permission-prompt-tool", "--permission-prompts",
  "--plugin-dir", "--plugin-url", "--prompt-suggestions", "--remote-control",
  "--remote-control-session-name-prefix", "-r", "--resume", "--session-id", "--setting-sources",
  "--settings", "--system-prompt", "--system-prompt-file", "--system-prompt-snapshot",
  "--teleport", "-w", "--worktree",
]);
const CLAUDE_VARIADIC_OPTIONS = new Set([
  "--add-dir", "--allowedTools", "--allowed-tools", "--betas", "--disallowedTools",
  "--disallowed-tools", "--file", "--mcp-config", "--tools",
]);
const CLAUDE_SWITCHES = new Set([
  "--allow-dangerously-skip-permissions", "--ax-screen-reader", "--background", "--bare", "--bg",
  "--brief", "-c", "--chrome", "--continue", "--dangerously-skip-permissions", "--desktop",
  "--disable-slash-commands", "--exclude-dynamic-system-prompt-sections", "--fork-session",
  "--forward-subagent-text", "--ide", "--include-hook-events", "--include-partial-messages",
  "--no-chrome", "--no-session-persistence", "--replay-user-messages", "--restricted", "--safe-mode",
  "--strict-mcp-config", "--tmux", "--verbose",
]);

function isRemoteControlCommand(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-" || !arg.startsWith("-")) return REMOTE_CONTROL_VERBS.has(arg);
    const flag = arg.split("=", 1)[0]!;
    if (CLAUDE_SWITCHES.has(flag) || (flag.startsWith("-d") && flag.length > 2)) continue;
    const variadic = CLAUDE_VARIADIC_OPTIONS.has(flag);
    // Print mode, help, the option terminator, and unknown options do not lead to a command here.
    if (!variadic && !CLAUDE_VALUE_OPTIONS.has(flag)) return false;
    if (flag !== arg) continue; // Inline value.
    while (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
      i++;
      if (!variadic) break;
    }
  }
  return false;
}

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
  // Remote Control expects its own --settings after the verb.
  if (isRemoteControlCommand(args)) return unchanged;
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
  const isWindows = (options.platform ?? process.platform) === "win32";
  if (serialized.length > (isWindows ? 4_000 : 32_000)) return unchanged;
  const launchArgs = ["--settings", serialized, ...args];
  // Use the worst-case escaping from win-exec: npm's local .cmd shims escape twice.
  if (isWindows && launchArgs.map(arg => escapeCmdArg(arg, true)).join(" ").length > WINDOWS_CLAUDE_ARGV_BUDGET) {
    return unchanged;
  }
  const childEnv = { ...env };
  delete childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  return { args: launchArgs, env: childEnv };
}
