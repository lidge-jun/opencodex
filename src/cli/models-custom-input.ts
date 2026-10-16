import { canonicalizeReasoningEfforts, isDeclaredReasoningEffort } from "../reasoning-effort";
import { isValidProviderName } from "../config/provider-name";
import { CliUsageError, takeOptionWithSyntax } from "./runtime-api";

/**
 * Parse and validate the reasoning flags shared by `ocx models add` (offline path).
 * "-" means "inherit" and omits the field entirely; "" means an explicit empty ladder
 * ("no reasoning" override, the same state the dashboard stores for the toggle-off
 * checkbox set). Malformed CSV like `low,,high` or `,,` is rejected instead of being
 * silently normalized. Values are canonicalized into Codex ladder order so the stored
 * config matches what the API stores.
 */
export function parseReasoningArgs(
  reasoningEffortsValue: string | undefined,
  defaultEffortValue: string | undefined,
): { reasoningEfforts?: string[]; defaultReasoningEffort?: string; error?: string } {
  if (reasoningEffortsValue === undefined && defaultEffortValue === undefined) return {};
  let reasoningEfforts: string[] | undefined;
  if (reasoningEffortsValue !== undefined) {
    const trimmed = reasoningEffortsValue.trim();
    if (trimmed === "-") {
      reasoningEfforts = undefined;
    } else if (trimmed === "") {
      // Explicit no-reasoning override, exactly like the API's [] / the dashboard's
      // uncheck-all state.
      reasoningEfforts = [];
    } else {
      const parts = trimmed.split(",").map(value => value.trim());
      if (parts.some(part => part === "")) {
        return { error: "--reasoning-efforts must be comma-separated values from none, minimal, low, medium, high, xhigh, max, ultra (\"\" for no reasoning, \"-\" to inherit)" };
      }
      const invalid = parts.filter(value => !isDeclaredReasoningEffort(value));
      if (invalid.length > 0) {
        return { error: `unsupported reasoning effort: ${invalid.join(", ")} (allowed: none, minimal, low, medium, high, xhigh, max, ultra)` };
      }
      reasoningEfforts = canonicalizeReasoningEfforts(parts);
    }
  }
  let defaultReasoningEffort: string | undefined;
  if (defaultEffortValue !== undefined) {
    const trimmed = defaultEffortValue.trim();
    if (trimmed === "-") {
      defaultReasoningEffort = undefined;
    } else {
      if (!isDeclaredReasoningEffort(trimmed)) {
        return { error: `unsupported reasoning effort: ${trimmed} (allowed: none, minimal, low, medium, high, xhigh, max, ultra)` };
      }
      if (!reasoningEfforts || reasoningEfforts.length === 0) {
        return { error: "--default-reasoning-effort requires --reasoning-efforts" };
      }
      if (!reasoningEfforts.includes(trimmed)) {
        return { error: `--default-reasoning-effort "${trimmed}" is not in the declared reasoning efforts` };
      }
      defaultReasoningEffort = trimmed;
    }
  }
  return { reasoningEfforts, defaultReasoningEffort };
}

export interface CustomModelAddInput {
  provider: string;
  modelId: string;
  displayName?: string;
  contextWindow?: number;
  inputModalities?: string[];
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

/** Parses only the existing add fields; the caller consumes --live and --json. */
export function parseCustomModelAddInput(args: string[]): CustomModelAddInput {
  const display = takeOptionWithSyntax(args, "--display-name")?.value;
  const context = takeOptionWithSyntax(args, "--context-window")?.value;
  const modalities = takeOptionWithSyntax(args, "--modalities")?.value;
  // The inline empty value is meaningful here, unlike ordinary value options.
  const emptyReasoning = args.indexOf("--reasoning-efforts=");
  if (emptyReasoning >= 0) args.splice(emptyReasoning, 1, "--reasoning-efforts", "");
  const efforts = takeOptionWithSyntax(args, "--reasoning-efforts")?.value;
  const defaultEffort = takeOptionWithSyntax(args, "--default-reasoning-effort")?.value;
  if (args.length !== 2 || args.some(arg => !arg.trim() || arg.startsWith("-"))) {
    throw new CliUsageError("A provider and model ID are required; unexpected arguments are not accepted");
  }
  const provider = args[0]!.trim();
  const modelId = args[1]!.trim();
  if (!isValidProviderName(provider)) throw new CliUsageError("Invalid provider name");
  const input: CustomModelAddInput = { provider, modelId };
  const displayName = display?.trim();
  if (displayName?.includes("/")) throw new CliUsageError("Display name must not contain /");
  if (displayName) input.displayName = displayName;
  if (context !== undefined) {
    const value = Number(context);
    if (!Number.isSafeInteger(value) || value <= 0) throw new CliUsageError("Context window must be a positive safe integer");
    input.contextWindow = value;
  }
  if (modalities !== undefined) {
    const values = modalities.split(",").map(value => value.trim());
    if (values.some(value => !["text", "image", "audio"].includes(value))) {
      throw new CliUsageError("Modalities must be comma-separated text, image or audio");
    }
    input.inputModalities = [...new Set(values)];
  }
  const parsed = parseReasoningArgs(efforts, defaultEffort);
  if (parsed.error) throw new CliUsageError("Invalid reasoning options");
  if (parsed.reasoningEfforts !== undefined) input.reasoningEfforts = parsed.reasoningEfforts;
  if (parsed.defaultReasoningEffort !== undefined) input.defaultReasoningEffort = parsed.defaultReasoningEffort;
  return input;
}
