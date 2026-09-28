import type { ComboTarget } from "./combo-workspace-data";
import type { ModelOption } from "./components/combo-workspace-types";

type ComboImageMemberKind = "vision" | "sidecar" | "blocked" | "missing";

/**
 * One combo member's image story. Classification must survive a reload, so it
 * reads the DECLARED modalities (`inputModalitiesDeclared`) when present: an
 * enrolled member advertises image in the catalog, and only the declaration
 * still says "declared text-only, covered by the sidecar". Rows with no known
 * modalities, or modalities without text, cannot be covered and block the combo.
 */
function imageMemberKind(target: ComboTarget, models: ModelOption[]): ComboImageMemberKind {
  const provider = target.provider.trim();
  const modelId = target.model.trim();
  if (!provider || !modelId) return "missing";
  const model = models.find((row) => row.provider === provider && row.id === modelId);
  if (!model) return "missing";
  const declared = model.inputModalitiesDeclared ?? model.inputModalities;
  if (!declared || declared.length === 0) return "blocked";
  if (declared.includes("image")) return "vision";
  return declared.includes("text") ? "sidecar" : "blocked";
}

/** Whether images can be enabled: every target is known and either images natively or can be declared text-only. */
export function comboImagesSupported(targets: ComboTarget[], models: ModelOption[]): boolean {
  if (targets.length === 0) return false;
  return targets.every((target) => {
    const kind = imageMemberKind(target, models);
    return kind === "vision" || kind === "sidecar";
  });
}

/**
 * Exact targets that need a text-only declaration so the Vision Sidecar covers
 * them when the combo accepts images. Deduplicated in submission order.
 */
export function comboVisionSidecarTargets(
  targets: ComboTarget[],
  models: ModelOption[],
): Array<{ provider: string; model: string }> {
  const seen = new Set<string>();
  const out: Array<{ provider: string; model: string }> = [];
  for (const target of targets) {
    if (imageMemberKind(target, models) !== "sidecar") continue;
    const provider = target.provider.trim();
    const model = target.model.trim();
    const key = `${provider}/${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider, model });
  }
  return out;
}

/**
 * Exact targets that cannot be covered by the Vision Sidecar: their row is
 * known but its modalities are unknown or have no text input. Named in the
 * hint so the operator knows which member blocks the image switch.
 */
export function comboImageBlockedTargets(
  targets: ComboTarget[],
  models: ModelOption[],
): Array<{ provider: string; model: string }> {
  return targets
    .filter((target) => imageMemberKind(target, models) === "blocked")
    .map((target) => ({ provider: target.provider.trim(), model: target.model.trim() }));
}
