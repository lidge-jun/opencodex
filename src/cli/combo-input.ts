import { JEV_MAX_CANDIDATE_FIELD_CHARS } from "../combos/types";
import { isCodexReasoningEffort } from "../reasoning-effort";
import { readJsonInput } from "./json-input";
import { CliUsageError, takeOptionWithSyntax, type RuntimeApiDeps } from "./runtime-api";

type ComboInput = {
  targets?: Array<Record<string, unknown>>;
  imageInput?: "auto" | "disabled";
  reasoningEffortMode?: "strict" | "adaptive";
  nativeAlias?: boolean;
};
const TARGET_KEYS = new Set(["provider", "model", "weight", "reasoningEfforts", "modelProfile", "lastResort", "metered", "reasoningEffort", "serviceTier"]);

export function parseComboTargets(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) throw new CliUsageError("Targets input must be a nonempty array");
  return value.map(target => {
    if (target === null || typeof target !== "object" || Array.isArray(target)
      || Object.keys(target).some(key => !TARGET_KEYS.has(key))) {
      throw new CliUsageError("Targets input contains an invalid object or unsupported field");
    }
    for (const key of ["provider", "model"]) {
      if (typeof target[key] !== "string" || !target[key].trim() || /[\u0000-\u001f\u007f]/u.test(target[key])) {
        throw new CliUsageError("Each target requires a nonblank provider and raw model ID without control characters");
      }
    }
    if (Object.hasOwn(target, "weight") && (typeof target.weight !== "number"
      || !Number.isInteger(target.weight) || target.weight < 1 || target.weight > 10_000)) {
      throw new CliUsageError("Target weight must be an integer from 1 to 10000");
    }
    if (target.reasoningEffort !== undefined
      && (typeof target.reasoningEffort !== "string" || !isCodexReasoningEffort(target.reasoningEffort))) {
      throw new CliUsageError("Target reasoningEffort must be low, medium, high, xhigh, max or ultra");
    }
    if (target.serviceTier !== undefined && target.serviceTier !== "default" && target.serviceTier !== "priority") {
      throw new CliUsageError("Target serviceTier must be default or priority");
    }
    if (Object.hasOwn(target, "reasoningEfforts") && (!Array.isArray(target.reasoningEfforts)
      || target.reasoningEfforts.length === 0
      || target.reasoningEfforts.some((effort: unknown) => typeof effort !== "string" || !isCodexReasoningEffort(effort))
      || new Set(target.reasoningEfforts).size !== target.reasoningEfforts.length)) {
      throw new CliUsageError("Target reasoningEfforts must contain unique low, medium, high, xhigh, max or ultra values");
    }
    if (Object.hasOwn(target, "modelProfile") && (typeof target.modelProfile !== "string"
      || !target.modelProfile.trim() || target.modelProfile.length > JEV_MAX_CANDIDATE_FIELD_CHARS
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(target.modelProfile))) {
      throw new CliUsageError("Target modelProfile must be nonblank, at most 512 characters, with no controls except tab or newline");
    }
    if (Object.hasOwn(target, "lastResort") && typeof target.lastResort !== "boolean") {
      throw new CliUsageError("Target lastResort must be a boolean");
    }
    if (Object.hasOwn(target, "metered") && typeof target.metered !== "boolean") {
      throw new CliUsageError("Target metered must be a boolean");
    }
    // Preserve raw slashes, target order, explicit false and omitted metadata.
    return { ...target };
  });
}

function takeNativeAlias(args: string[]): boolean | undefined {
  const flag = "--native-alias";
  const positions = args.flatMap((value, index) => value === flag || value.startsWith(`${flag}=`) ? [index] : []);
  if (positions.length === 0) return undefined;
  if (positions.length !== 1) throw new CliUsageError("--native-alias was given more than once");
  const index = positions[0]!;
  const token = args[index]!;
  const inline = token !== flag;
  const next = inline ? token.slice(flag.length + 1) : args[index + 1];
  if (!inline && (next === undefined || next.startsWith("--"))) {
    args.splice(index, 1);
    return true;
  }
  if (next !== "on" && next !== "off") throw new CliUsageError("--native-alias accepts on, off, or the legacy bare flag");
  args.splice(index, inline ? 1 : 2);
  return next === "on";
}

/** Consume only extension options, before the parent set flow resolves a target or reads HTTP. */
export async function prepareComboInput(args: string[], deps: RuntimeApiDeps = {}): Promise<ComboInput> {
  const file = takeOptionWithSyntax(args, "--targets-file")?.value;
  const image = takeOptionWithSyntax(args, "--image-input")?.value;
  const reasoning = takeOptionWithSyntax(args, "--reasoning-effort-mode")?.value;
  const nativeAlias = takeNativeAlias(args);
  if (file !== undefined && args.some(arg => arg === "--targets" || arg.startsWith("--targets="))) {
    throw new CliUsageError("--targets-file cannot be combined with --targets");
  }
  if (image !== undefined && image !== "auto" && image !== "disabled") {
    throw new CliUsageError("--image-input must be auto or disabled");
  }
  if (reasoning !== undefined && reasoning !== "strict" && reasoning !== "adaptive") {
    throw new CliUsageError("--reasoning-effort-mode must be strict or adaptive");
  }
  return {
    ...(file === undefined ? {} : { targets: parseComboTargets(await readJsonInput(file, deps)) }),
    ...(image === undefined ? {} : { imageInput: image }),
    ...(reasoning === undefined ? {} : { reasoningEffortMode: reasoning }),
    ...(nativeAlias === undefined ? {} : { nativeAlias }),
  };
}
