import { canonicalizeReasoningEfforts, isDeclaredReasoningEffort } from "../../reasoning-effort";
import { knownReasoningSupport, type OpencodeCatalogModel } from "./contracts";

type ReasoningMetadata = Pick<OpencodeCatalogModel, "reasoningEfforts" | "defaultReasoningEffort"
  | "supportsReasoning" | "supportsThinkingToggle" | "supportsReasoningEffort" | "defaultThinkingEnabled">;

/** Shared row projection; an effective projection owns the default even when it omits it. */
export function resolveExportReasoningAxes(effective: ReasoningMetadata | undefined, row: ReasoningMetadata) {
  const supportsThinkingToggle = effective?.supportsThinkingToggle ?? row.supportsThinkingToggle;
  const supportsReasoningEffort = effective?.supportsReasoningEffort ?? row.supportsReasoningEffort;
  const defaultThinkingEnabled = effective?.defaultThinkingEnabled ?? row.defaultThinkingEnabled;
  const declaredEfforts = effective?.reasoningEfforts ?? row.reasoningEfforts;
  const effortDisabled = supportsReasoningEffort === false
    || (effective?.supportsReasoning ?? row.supportsReasoning) === false;
  return {
    supportsThinkingToggle,
    supportsReasoningEffort,
    defaultThinkingEnabled,
    reasoningEfforts: declaredEfforts === undefined ? undefined : effortDisabled ? [] : [...declaredEfforts],
    // Falling back through an existing projection would revive a synthetic picker default.
    // Older rows without a projection retain their own declared default.
    defaultReasoningEffort: effortDisabled ? undefined : effective !== undefined
      ? effective.defaultReasoningEffort : row.defaultReasoningEffort,
  };
}

/** Effort-enum client compatibility only; never write these choices back into model facts. */
export function exportReasoningEfforts(model: ReasoningMetadata): string[] | undefined {
  if (model.supportsReasoning === false) return [];
  const efforts = model.reasoningEfforts === undefined ? undefined : canonicalizeReasoningEfforts(model.reasoningEfforts);
  if (model.supportsReasoningEffort === false) {
    return model.supportsThinkingToggle === true ? ["none", "high"] : [];
  }
  if (model.supportsThinkingToggle === true) {
    const strengths = efforts?.filter(effort => effort !== "none") ?? [];
    return strengths.length ? ["none", ...strengths] : ["none", "high"];
  }
  return model.supportsThinkingToggle === false ? efforts?.filter(effort => effort !== "none") : efforts;
}

/** Encode the declared effort/default-thinking choice without inventing a strength. */
export function exportDefaultReasoningEffort(model: ReasoningMetadata): string | undefined {
  const efforts = exportReasoningEfforts(model);
  if (model.supportsThinkingToggle === true && model.supportsReasoning !== false) {
    if (model.defaultThinkingEnabled === false) return "none";
    const toggleOnly = model.supportsReasoningEffort === false
      || !model.reasoningEfforts?.some(effort => isDeclaredReasoningEffort(effort) && effort !== "none");
    if (toggleOnly) return model.defaultThinkingEnabled === true ? "high" : undefined;
    if (model.defaultThinkingEnabled === true && model.defaultReasoningEffort === "none") return undefined;
  }
  const effort = model.defaultReasoningEffort;
  if (typeof effort !== "string" || !isDeclaredReasoningEffort(effort)) return undefined;
  return efforts === undefined || efforts.includes(effort) ? effort : undefined;
}

export type LegacyEffortVariant = { reasoningEffort: string } | { disabled: true };

/** Shared V1-family controls. A disabled-only map suppresses client-invented effort ladders. */
export function legacyReasoningMetadata(model: OpencodeCatalogModel): {
  reasoning?: boolean;
  options?: { reasoningEffort: string };
  interleaved?: { field: "reasoning_content" };
  variants?: Record<string, LegacyEffortVariant>;
} {
  const efforts = exportReasoningEfforts(model);
  const reasoning = model.supportsReasoning ?? knownReasoningSupport({
    ...model, reasoningEfforts: efforts,
  });
  const defaultEffort = exportDefaultReasoningEffort(model);
  // Both legacy runtimes merge generated variants with config, then filter disabled IDs.
  // An unrelated sentinel leaves their generated choices alive. Disable the actual IDs
  // instead (live-tested on Kilo 7.8.3, checked against stock OpenCode V1's merge).
  const suppressed: Record<string, LegacyEffortVariant> = Object.fromEntries(
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"].map(id => [id, { disabled: true }]),
  );
  let variants = efforts?.length
    ? Object.fromEntries(efforts.map(effort => [effort, { reasoningEffort: effort }]))
    : reasoning === true || model.supportsReasoning === false || model.supportsReasoningEffort === false ? suppressed : undefined;
  // Constrained controls replace generated choices; a negative toggle by itself does not
  // declare the still-unknown effort axis unsupported.
  if (model.supportsThinkingToggle === true || model.supportsReasoningEffort !== undefined
    || model.supportsReasoning === false || (model.supportsThinkingToggle === false && efforts !== undefined)) {
    variants = { ...suppressed, ultra: { disabled: true }, ...variants };
  } else if (model.supportsThinkingToggle === false) {
    variants = { none: { disabled: true }, ...variants };
  }
  return {
    ...(typeof reasoning === "boolean" ? { reasoning } : {}),
    ...(defaultEffort !== undefined ? { options: { reasoningEffort: defaultEffort } } : {}),
    ...(reasoning === true || model.supportsReasoningSummaries === true
      ? { interleaved: { field: "reasoning_content" } } : {}),
    ...(variants !== undefined ? { variants } : {}),
  };
}
