import { isCodexReasoningEffort } from "../reasoning-effort";
import type {
  OcxComboConfig,
  OcxComboDefaultEffort,
  OcxComboStrategy,
  OcxComboTarget,
  OcxProviderConfig,
} from "../types";

export const COMBO_NAMESPACE = "combo";
const COMBO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ComboValidationIssue {
  path: Array<string | number>;
  message: string;
}

export interface NormalizedComboConfig {
  strategy: OcxComboStrategy;
  stickyLimit: number;
  defaultEffort: OcxComboDefaultEffort | null;
  targets: Array<Required<OcxComboTarget>>;
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

export function comboConfigIssues(
  id: string,
  raw: unknown,
  providers: Record<string, OcxProviderConfig>,
  options: { requireEnabledTarget?: boolean } = {},
): ComboValidationIssue[] {
  const issues: ComboValidationIssue[] = [];
  if (!isValidComboId(id)) {
    issues.push({
      path: [],
      message: "combo id must start with a letter/number and use letters, numbers, dot, underscore, or hyphen (max 64)",
    });
  }
  if (Object.hasOwn(providers, COMBO_NAMESPACE)) {
    issues.push({
      path: [],
      message: 'provider name "combo" collides with the reserved "combo/" namespace while combos are configured',
    });
  }
  if (Object.hasOwn(providers, id)) {
    issues.push({
      path: [],
      message: `combo id "${id}" collides with configured provider name "${id}"`,
    });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ path: [], message: "combo must be an object" });
    return issues;
  }

  const body = raw as Record<string, unknown>;
  if (body.strategy !== undefined
    && body.strategy !== "failover"
    && body.strategy !== "round-robin") {
    issues.push({ path: ["strategy"], message: 'strategy must be "failover" or "round-robin"' });
  }
  if (body.stickyLimit !== undefined
    && (typeof body.stickyLimit !== "number" || !Number.isInteger(body.stickyLimit)
      || body.stickyLimit < 1
      || body.stickyLimit > 100)) {
    issues.push({ path: ["stickyLimit"], message: "stickyLimit must be an integer from 1 to 100" });
  }
  if (body.defaultEffort !== undefined
    && body.defaultEffort !== null
    && (typeof body.defaultEffort !== "string" || !isCodexReasoningEffort(body.defaultEffort))) {
    issues.push({
      path: ["defaultEffort"],
      message: "defaultEffort must be one of: low, medium, high, xhigh, max, ultra",
    });
  }

  if (!Array.isArray(body.targets) || body.targets.length === 0) {
    issues.push({ path: ["targets"], message: "targets must be a non-empty array" });
    return issues;
  }

  const seen = new Set<string>();
  let configuredProviderCount = 0;
  let enabledProviderCount = 0;
  for (let i = 0; i < body.targets.length; i++) {
    const rawTarget = body.targets[i];
    if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) {
      issues.push({ path: ["targets", i], message: `targets[${i}] must be an object` });
      continue;
    }
    const target = rawTarget as Record<string, unknown>;
    const provider = typeof target.provider === "string" ? target.provider.trim() : "";
    const model = typeof target.model === "string" ? target.model.trim() : "";

    if (!provider) {
      issues.push({ path: ["targets", i, "provider"], message: `targets[${i}].provider is required` });
    } else if (!Object.hasOwn(providers, provider)) {
      issues.push({
        path: ["targets", i, "provider"],
        message: `targets[${i}].provider "${provider}" is not configured`,
      });
    } else {
      configuredProviderCount += 1;
      if (providers[provider]?.disabled !== true) enabledProviderCount += 1;
    }

    if (!model) {
      issues.push({ path: ["targets", i, "model"], message: `targets[${i}].model is required` });
    }
    if (target.weight !== undefined
      && (typeof target.weight !== "number" || !Number.isInteger(target.weight)
        || target.weight < 1
        || target.weight > 10_000)) {
      issues.push({
        path: ["targets", i, "weight"],
        message: `targets[${i}].weight must be an integer from 1 to 10000`,
      });
    }

    if (provider && model) {
      const key = targetKey({ provider, model });
      if (seen.has(key)) {
        issues.push({ path: ["targets", i], message: `duplicate combo target "${key}"` });
      } else {
        seen.add(key);
      }
    }
  }
  if (options.requireEnabledTarget
    && configuredProviderCount === body.targets.length
    && enabledProviderCount === 0) {
    issues.push({
      path: ["targets"],
      message: "targets must include at least one enabled provider",
    });
  }
  return issues;
}

export function comboConfigError(
  id: string,
  raw: unknown,
  providers: Record<string, OcxProviderConfig>,
  options: { requireEnabledTarget?: boolean } = {},
): string | null {
  return comboConfigIssues(id, raw, providers, options)[0]?.message ?? null;
}

export function normalizeComboConfig(raw: OcxComboConfig): NormalizedComboConfig {
  return {
    strategy: raw.strategy ?? "failover",
    stickyLimit: raw.stickyLimit ?? 1,
    defaultEffort: raw.defaultEffort ?? null,
    targets: raw.targets.map(target => ({
      provider: target.provider.trim(),
      model: target.model.trim(),
      weight: target.weight ?? 1,
    })),
  };
}

export function comboDefaultEffort(
  config: { combos?: Record<string, OcxComboConfig> },
  id: string,
): OcxComboDefaultEffort | null {
  const combos = config.combos;
  if (!combos || !Object.hasOwn(combos, id)) return null;
  const value: unknown = combos[id]!.defaultEffort ?? null;
  return typeof value === "string" && isCodexReasoningEffort(value)
    ? value as OcxComboDefaultEffort
    : null;
}

export function isValidComboId(id: string): boolean {
  return COMBO_ID_PATTERN.test(id);
}

export function listComboIds(config: { combos?: Record<string, OcxComboConfig> }): string[] {
  return Object.keys(config.combos ?? {}).sort((a, b) => a.localeCompare(b));
}

export function getCombo(
  config: { combos?: Record<string, OcxComboConfig> },
  id: string,
): NormalizedComboConfig | undefined {
  const combos = config.combos;
  if (!combos || !Object.hasOwn(combos, id)) return undefined;
  return normalizeComboConfig(combos[id]!);
}
