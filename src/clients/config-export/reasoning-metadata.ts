import { canonicalizeReasoningEfforts, isDeclaredReasoningEffort } from "../../reasoning-effort";
import { knownReasoningSupport, type OpencodeCatalogModel } from "./contracts";

/** Unknown and explicitly empty ladders have different client-side meanings. */
export function exportReasoningEfforts(model: OpencodeCatalogModel): string[] | undefined {
  return model.reasoningEfforts === undefined ? undefined : canonicalizeReasoningEfforts(model.reasoningEfforts);
}

/** Carry an authoritative default, never invent one or revive a cleared ladder. */
export function exportDefaultReasoningEffort(model: OpencodeCatalogModel): string | undefined {
  const effort = model.defaultReasoningEffort;
  if (typeof effort !== "string" || !isDeclaredReasoningEffort(effort)) return undefined;
  const efforts = exportReasoningEfforts(model);
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
  const variants = efforts?.length
    ? Object.fromEntries(efforts.map(effort => [effort, { reasoningEffort: effort }]))
    : reasoning === true ? suppressed : undefined;
  return {
    ...(typeof reasoning === "boolean" ? { reasoning } : {}),
    ...(defaultEffort !== undefined ? { options: { reasoningEffort: defaultEffort } } : {}),
    ...(reasoning === true || model.supportsReasoningSummaries === true
      ? { interleaved: { field: "reasoning_content" } } : {}),
    ...(variants !== undefined ? { variants } : {}),
  };
}
