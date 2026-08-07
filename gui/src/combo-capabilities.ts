import type { ComboTarget } from "./combo-workspace-data";
import type { ModelOption } from "./components/combo-workspace-types";

/** Whether every complete target advertises image input. */
export function comboImagesSupported(targets: ComboTarget[], models: ModelOption[]): boolean {
  const complete = targets.filter((target) => target.provider.trim() && target.model.trim());
  if (complete.length === 0) return false;
  return complete.every((target) => {
    const model = models.find(
      (row) => row.provider === target.provider.trim() && row.id === target.model.trim(),
    );
    return !!model?.inputModalities?.includes("image");
  });
}
