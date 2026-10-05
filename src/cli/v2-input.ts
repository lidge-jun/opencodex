import { CliUsageError } from "./runtime-api";

type V2Controls = { json: boolean; live: boolean; acknowledge: boolean };
export type V2ParsedCommand = V2Controls & (
  | { verb: "status" | "on" | "off" }
  | { verb: "mode"; value: "v1" | "default" | "v2" }
  | { verb: "keep-native-v1"; value: boolean }
  | { verb: "threads"; value: number }
  | { verb: "mode-hint"; value: string | null }
);

export const V2_USAGE = "Usage: ocx v2 [status|on|off|mode <v1|default|v2>|keep-native-v1 <on|off>|threads <n>|mode-hint <text|--clear>] [--live] [--json]\nFor literal reserved hint text: ocx v2 mode-hint [--live] [--json] -- <text>\nOnly live mode accepts --acknowledge-surface-advisory.";

/** Parse all controls before touching native/config state. A terminator protects literal hints. */
export function parseV2Command(argv: readonly string[]): V2ParsedCommand {
  const boundary = argv.indexOf("--");
  const prefix = boundary < 0 ? argv : argv.slice(0, boundary);
  const suffix = boundary < 0 ? [] : argv.slice(boundary + 1);
  const controls: V2Controls = { json: false, live: false, acknowledge: false };
  const operands: string[] = [];
  for (const arg of prefix) {
    const flag = arg === "--json" ? "json" : arg === "--live" ? "live"
      : arg === "--acknowledge-surface-advisory" ? "acknowledge" : undefined;
    if (["--json=", "--live=", "--acknowledge-surface-advisory="].some(prefix => arg.startsWith(prefix))) {
      throw new CliUsageError("v2: control flags do not take values; use -- for literal hint text", V2_USAGE);
    }
    if (flag) {
      if (controls[flag]) throw new CliUsageError("v2: duplicate control flag", V2_USAGE);
      controls[flag] = true;
    } else operands.push(arg);
  }
  const verb = (operands.shift() ?? "status").trim().toLowerCase();
  const invalid = (message: string): never => { throw new CliUsageError(message, V2_USAGE); };
  if (controls.acknowledge && (!controls.live || verb !== "mode")) {
    invalid("v2: advisory acknowledgment requires explicit live mode");
  }
  if (boundary >= 0 && (verb !== "mode-hint" || operands.length !== 0 || suffix.length !== 1)) {
    invalid("v2: the terminator requires exactly one literal mode-hint operand");
  }
  if (verb === "status" || verb === "on" || verb === "off") {
    if (operands.length) invalid("v2: unexpected operands or flags");
    return { ...controls, verb };
  }
  const values = boundary >= 0 ? suffix : operands;
  if (values.length !== 1) invalid(verb === "keep-native-v1" ? "v2 keep-native-v1: expected on|off" : "v2: exactly one value is required");
  const raw = values[0]!;
  if (verb === "mode-hint") {
    if (!raw.trim()) invalid("v2 mode-hint: pass nonblank text, or --clear to unset it");
    // Legacy unreserved hyphen-leading hint strings remain ordinary content.
    return { ...controls, verb, value: boundary < 0 && raw === "--clear" ? null : raw };
  }
  const value = raw.trim().toLowerCase();
  if (verb === "mode" && (value === "v1" || value === "default" || value === "v2")) {
    return { ...controls, verb, value };
  }
  if (verb === "keep-native-v1" && (value === "on" || value === "off")) {
    return { ...controls, verb, value: value === "on" };
  }
  if (verb === "keep-native-v1") invalid("v2 keep-native-v1: expected on|off");
  if (verb === "threads") {
    const count = Number(value);
    if (Number.isSafeInteger(count) && count >= 1) return { ...controls, verb, value: count };
    invalid("v2 threads: pass a safe integer >= 1");
  }
  return invalid("v2: invalid command or value");
}
