import { CliUsageError } from "./runtime-api";
import { isMultiAgentModelKey, isMultiAgentModelMode } from "../config/multi-agent-surface";
import type { MultiAgentModelMode } from "../types/multi-agent";

type V2Controls = { json: boolean; live: boolean; acknowledge: boolean; plaintextAcknowledged?: true };
export type V2ParsedCommand = V2Controls & (
  | { verb: "status" | "on" | "off" }
  | { verb: "mode"; value: "v1" | "default" | "v2" | "v2-plaintext" }
  | { verb: "keep-native-v1"; value: boolean }
  /** `value: null` removes the model's entry, so it follows the global mode again. */
  | { verb: "model-mode"; model: string; value: MultiAgentModelMode | null }
  | { verb: "threads"; value: number }
  | { verb: "mode-hint"; value: string | null }
);

export const V2_USAGE = "Usage: ocx v2 [status|on|off|mode <v1|default|v2|v2-plaintext>|model-mode <model> <v1|v2|v2-plaintext|default>|keep-native-v1 <on|off>|threads <n>|mode-hint <text|--clear>] [--live] [--json]\nmodel-mode gives one catalog model its own surface; default removes the entry so the model follows the mode again.\nEntering v2-plaintext requires --acknowledge-plaintext-agent-messages: task text may remain in history, provider requests and local response/debug state. Catalog pins affect new sessions; enabled compilation also affects subsequent eligible canonical ChatGPT requests from existing V2 sessions. Existing ciphertext is not decrypted, stored history is not rewritten, and disabling does not delete retained copies.\nFor literal reserved hint text: ocx v2 mode-hint [--live] [--json] -- <text>\nOnly live mode accepts --acknowledge-surface-advisory.";

/** Parse all controls before touching native/config state. A terminator protects literal hints. */
export function parseV2Command(argv: readonly string[]): V2ParsedCommand {
  const boundary = argv.indexOf("--");
  const prefix = boundary < 0 ? argv : argv.slice(0, boundary);
  const suffix = boundary < 0 ? [] : argv.slice(boundary + 1);
  const controls: V2Controls = { json: false, live: false, acknowledge: false };
  const operands: string[] = [];
  for (const arg of prefix) {
    const flag = arg === "--json" ? "json" : arg === "--live" ? "live"
      : arg === "--acknowledge-surface-advisory" ? "acknowledge"
      : arg === "--acknowledge-plaintext-agent-messages" ? "plaintextAcknowledged" : undefined;
    if (["--json=", "--live=", "--acknowledge-surface-advisory=", "--acknowledge-plaintext-agent-messages="].some(prefix => arg.startsWith(prefix))) {
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
  const plaintextTarget = verb === "mode" ? operands[0] : verb === "model-mode" ? operands[1] : undefined;
  if (controls.plaintextAcknowledged && plaintextTarget?.trim().toLowerCase() !== "v2-plaintext") {
    invalid("v2: plaintext acknowledgment applies only to mode v2-plaintext");
  }
  if (boundary >= 0 && (verb !== "mode-hint" || operands.length !== 0 || suffix.length !== 1)) {
    invalid("v2: the terminator requires exactly one literal mode-hint operand");
  }
  if (verb === "status" || verb === "on" || verb === "off") {
    if (operands.length) invalid("v2: unexpected operands or flags");
    return { ...controls, verb };
  }
  if (verb === "model-mode") {
    if (boundary >= 0 || operands.length !== 2) invalid("v2 model-mode: expected <model> <v1|v2|v2-plaintext|default>");
    // The model id keeps its case and spelling: it is matched against catalog slugs.
    const model = operands[0]!;
    const value = operands[1]!.trim().toLowerCase();
    if (!isMultiAgentModelKey(model)) invalid("v2 model-mode: the model id must be a trimmed, non-empty catalog id");
    if (value === "default") return { ...controls, verb, model, value: null };
    if (isMultiAgentModelMode(value)) return { ...controls, verb, model, value };
    invalid("v2 model-mode: expected <model> <v1|v2|v2-plaintext|default>");
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
  if (verb === "mode" && (value === "v1" || value === "default" || value === "v2" || value === "v2-plaintext")) {
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
