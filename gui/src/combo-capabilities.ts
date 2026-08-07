import type { ComboTarget } from "./combo-workspace-data";
import type { ModelOption } from "./components/combo-workspace-types";

/** Whether every selected target advertises image input (incomplete rows fail closed). */
export function comboImagesSupported(targets: ComboTarget[], models: ModelOption[]): boolean {
  if (targets.length === 0) return false;
  return targets.every((target) => {
    const provider = target.provider.trim();
    const modelId = target.model.trim();
    if (!provider || !modelId) return false;
    const model = models.find((row) => row.provider === provider && row.id === modelId);
    return !!model?.inputModalities?.includes("image");
  });
}
