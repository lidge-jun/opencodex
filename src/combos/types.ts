import type { OcxComboTarget } from "../types";

export const COMBO_NAMESPACE = "combo";
export const COMBO_DEFAULT_EFFORT = "medium";

const COMBO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidComboId(id: string): boolean {
  return COMBO_ID_PATTERN.test(id);
}

export function parseComboModelId(modelId: string): string | null {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || modelId.slice(0, slash) !== COMBO_NAMESPACE) return null;
  const id = modelId.slice(slash + 1).trim();
  return id.length > 0 ? id : null;
}

export function comboModelId(id: string): string {
  return `${COMBO_NAMESPACE}/${id}`;
}

export function targetKey(target: Pick<OcxComboTarget, "provider" | "model">): string {
  return `${target.provider}/${target.model}`;
}
