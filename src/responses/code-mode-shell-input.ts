import { unwrapFreeformToolInput } from "./apply-patch-envelope";
import { scanFreeformWrapper } from "./freeform-wrapper-scan";

const SHELL_ARGUMENT_KEYS = new Set([
  "cmd", "command", "workdir", "shell", "login", "tty", "yield_time_ms",
  "max_output_tokens", "sandbox_permissions", "justification", "prefix_rule",
]);
let javascriptParser: Bun.Transpiler | undefined;

/** Recognize shell arguments, never guess a shell from an ordinary freeform program. */
export function parseCodeModeShellInput(argumentsText: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    // Only the canonical input wrapper is removed: the cmd/command object is the payload.
    parsed = JSON.parse(unwrapFreeformToolInput(argumentsText));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const args = parsed as Record<string, unknown>;
  if (Object.keys(args).some(key => !SHELL_ARGUMENT_KEYS.has(key))) return undefined;
  const keys = ["cmd", "command"].filter(key => Object.hasOwn(args, key));
  if (keys.length !== 1) return undefined;
  const command = args[keys[0]!];
  if (typeof command !== "string" || command.trim() === "") return undefined;
  // cmd/command also exist as historical JavaScript fallback fields. Preserve every valid
  // program, including ambiguous identifiers such as `ls`. Parsing never executes the source.
  try {
    javascriptParser ??= new Bun.Transpiler({ loader: "js" });
    javascriptParser.scan(`async function __codeModeInput() {\n${command}\n}`);
    return undefined;
  } catch {
    const { command: _alias, ...rest } = args;
    return { ...rest, cmd: command };
  }
}

/** Hold possible shell objects until completion can choose their executable representation. */
export function mayBecomeCodeModeShellInput(argumentsText: string, input: string): boolean {
  const head = input.trimStart();
  if (head === "" || head.startsWith("{")) return true;
  // Canonical JavaScript streams progressively; avoid reparsing its growing wrapper on every
  // delta. The shared prefix scanner is bounded independently of the command's size.
  if (input === argumentsText || scanFreeformWrapper(argumentsText).kind === "input") return false;
  try {
    const args = JSON.parse(argumentsText);
    // A fallback cmd value becomes visible only when the outer object closes. Do not emit
    // that command before completion replaces it with tools.exec_command JavaScript.
    return !!args && typeof args === "object" && !Object.hasOwn(args, "input")
      && (Object.hasOwn(args, "cmd") || Object.hasOwn(args, "command"));
  } catch {
    return false;
  }
}
