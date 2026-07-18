import type { OcxComboConfig, OcxComboStrategy, OcxComboTarget, OcxConfig } from "../types";
import { hasOwnProvider, isValidProviderName } from "../config";

export const COMBO_NAMESPACE = "combo";

const COMBO_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function isValidComboId(id: string): boolean {
  return COMBO_ID_PATTERN.test(id);
}

/** Parse `combo/<id>` → id, or null if not a combo namespace. */
export function parseComboModelId(modelId: string): string | null {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return null;
  if (modelId.slice(0, slash) !== COMBO_NAMESPACE) return null;
  const id = modelId.slice(slash + 1).trim();
  return id.length > 0 ? id : null;
}

export function comboModelId(comboId: string): string {
  return `${COMBO_NAMESPACE}/${comboId}`;
}

export function targetKey(target: Pick<OcxComboTarget, "provider" | "model">): string {
  return `${target.provider}/${target.model}`;
}

export function normalizeComboConfig(raw: OcxComboConfig): OcxComboConfig {
  const strategy: OcxComboStrategy = raw.strategy === "round-robin" ? "round-robin" : "failover";
  const stickyLimit = typeof raw.stickyLimit === "number" && Number.isFinite(raw.stickyLimit)
    ? Math.max(1, Math.min(100, Math.trunc(raw.stickyLimit)))
    : 1;
  const targets = (raw.targets ?? []).map(t => ({
    provider: t.provider.trim(),
    model: t.model.trim(),
    ...(typeof t.weight === "number" && Number.isFinite(t.weight) && t.weight >= 1
      ? { weight: Math.min(10_000, Math.trunc(t.weight)) }
      : {}),
  }));
  return { strategy, stickyLimit, targets };
}

/** Validate a combo definition against the live provider map. Returns an error string or null. */
export function comboConfigError(comboId: string, raw: unknown, config: OcxConfig): string | null {
  if (!isValidComboId(comboId)) {
    return "combo id must start with a letter/number and use letters, numbers, dot, underscore, or hyphen (max 64)";
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "combo must be an object";
  const body = raw as OcxComboConfig;
  if (body.strategy !== undefined && body.strategy !== "failover" && body.strategy !== "round-robin") {
    return 'strategy must be "failover" or "round-robin"';
  }
  if (body.stickyLimit !== undefined) {
    if (typeof body.stickyLimit !== "number" || !Number.isFinite(body.stickyLimit) || body.stickyLimit < 1) {
      return "stickyLimit must be a positive number";
    }
  }
  if (!Array.isArray(body.targets) || body.targets.length === 0) {
    return "targets must be a non-empty array";
  }
  for (let i = 0; i < body.targets.length; i++) {
    const t = body.targets[i];
    if (!t || typeof t !== "object") return `targets[${i}] must be an object`;
    if (typeof t.provider !== "string" || !t.provider.trim()) return `targets[${i}].provider is required`;
    if (typeof t.model !== "string" || !t.model.trim()) return `targets[${i}].model is required`;
    if (!isValidProviderName(t.provider.trim())) return `targets[${i}].provider is not a valid provider name`;
    if (!hasOwnProvider(config.providers, t.provider.trim())) {
      return `targets[${i}].provider "${t.provider.trim()}" is not configured`;
    }
    if (config.providers[t.provider.trim()]?.disabled === true) {
      return `targets[${i}].provider "${t.provider.trim()}" is disabled`;
    }
    if (t.weight !== undefined) {
      if (typeof t.weight !== "number" || !Number.isFinite(t.weight) || t.weight < 1) {
        return `targets[${i}].weight must be a number >= 1`;
      }
    }
  }
  return null;
}

export function listComboIds(config: OcxConfig): string[] {
  return Object.keys(config.combos ?? {}).sort((a, b) => a.localeCompare(b));
}

export function getCombo(config: OcxConfig, comboId: string): OcxComboConfig | undefined {
  const raw = config.combos?.[comboId];
  return raw ? normalizeComboConfig(raw) : undefined;
}
