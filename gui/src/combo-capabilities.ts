import type { ComboTarget } from "./combo-workspace-data";
import type { ModelOption } from "./components/combo-workspace-types";

type ComboImageMemberKind = "vision" | "sidecar" | "missing";

/**
 * One combo member's image story. A row advertising image is either natively
 * multimodal or an already-declared Vision Sidecar consumer (the catalog widens
 * both). A catalog row without image can be declared text-only on save so the
 * sidecar covers it. Rows absent from the catalog fail closed.
 */
function imageMemberKind(target: ComboTarget, models: ModelOption[]): ComboImageMemberKind {
  const provider = target.provider.trim();
  const modelId = target.model.trim();
  if (!provider || !modelId) return "missing";
  const model = models.find((row) => row.provider === provider && row.id === modelId);
  if (!model) return "missing";
  return model.inputModalities?.includes("image") ? "vision" : "sidecar";
}

/** Whether images can be enabled: every target is known and either images natively or can be declared text-only. */
export function comboImagesSupported(targets: ComboTarget[], models: ModelOption[]): boolean {
  if (targets.length === 0) return false;
  return targets.every((target) => imageMemberKind(target, models) !== "missing");
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
