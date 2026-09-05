import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../codex/catalog/native-models";
import type { OcxComboConfig, OcxComboTarget, OcxConfig } from "../types";

export const COMBO_NAMESPACE = "combo";

export function preservesPhysicalComboProvider(
  config: Pick<OcxConfig, "providers" | "combos">,
): boolean {
  return Object.hasOwn(config.providers, COMBO_NAMESPACE)
    && Object.keys(config.combos ?? {}).length === 0;
}

const COMBO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** True only for an explicitly opted-in bare native-family alias. */
export function isNativeAliasCombo(
  combo: { alias?: string | null; nativeAlias?: boolean },
): boolean {
  const alias = typeof combo.alias === "string" ? combo.alias.trim() : "";
  return combo.nativeAlias === true
    && SUPPORTED_NATIVE_OPENAI_SLUGS.has(alias);
}

export function targetKey(target: Pick<OcxComboTarget, "provider" | "model">): string {
  return `${target.provider}/${target.model}`;
}

export function parseComboModelId(modelId: string): string | null {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || modelId.slice(0, slash) !== COMBO_NAMESPACE) return null;
  const id = modelId.slice(slash + 1);
  return id.length > 0 ? id : null;
}

export function comboModelId(id: string): string {
  return `${COMBO_NAMESPACE}/${id}`;
}

/** Public model id clients request: the alias when set, else the default `combo/<id>`. */
export function comboPublicModelId(id: string, combo: { alias?: string | null }): string {
  const alias = typeof combo.alias === "string" ? combo.alias.trim() : "";
  return alias || comboModelId(id);
}

/**
 * Persisted selector that hides a combo from discovery. Native aliases keep the canonical
 * `combo/<id>` selector because their bare public id remains the native OpenAI disable key.
 */
export function comboDisabledModelId(
  id: string,
  combo: { alias?: string | null; nativeAlias?: boolean },
): string {
  return isNativeAliasCombo(combo) ? comboModelId(id) : comboPublicModelId(id, combo);
}

/** Every persisted selector that can refer to this combo in `disabledModels`. */
export function comboDisabledModelSelectors(
  id: string,
  combo: { alias?: string | null; nativeAlias?: boolean },
): string[] {
  const canonical = comboModelId(id);
  const preferred = comboDisabledModelId(id, combo);
  return preferred === canonical ? [canonical] : [canonical, preferred];
}

/**
 * Resolve a client-requested model id to a combo config key. The canonical `combo/<id>`
 * form wins first (back-compat); otherwise an exact alias match across configured combos.
 */
export function resolveComboId(
  config: { combos?: Record<string, OcxComboConfig> },
  modelId: string,
): string | null {
  const direct = parseComboModelId(modelId);
  if (direct) return direct;
  const combos = config.combos;
  if (!combos) return null;
  for (const [id, raw] of Object.entries(combos)) {
    if (!raw || typeof raw !== "object") continue;
    const alias = typeof raw.alias === "string" ? raw.alias.trim() : "";
    if (alias && alias === modelId) return id;
  }
  return null;
}


export function isValidComboId(id: string): boolean {
  return COMBO_ID_PATTERN.test(id);
}
