import { isCodexReasoningEffort } from "../reasoning-effort";
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../codex/catalog/native-models";
import type {
  OcxComboConfig,
  OcxComboDefaultEffort,
  OcxComboStrategy,
  OcxComboTarget,
  OcxConfig,
  OcxProviderConfig,
} from "../types";

export const COMBO_NAMESPACE = "combo";

export function preservesPhysicalComboProvider(
  config: Pick<OcxConfig, "providers" | "combos">,
): boolean {
  return Object.hasOwn(config.providers, COMBO_NAMESPACE)
    && Object.keys(config.combos ?? {}).length === 0;
}

const COMBO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * Public alias shape: one optional "/" segment, each segment id-shaped. Bare aliases
 * (no "/") are the masquerade case — the combo answers to a mandated model id with no
 * `combo/` prefix. Codex-facing slugs tolerate at most one "/", so deeper paths reject.
 */
const COMBO_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
/** Bare aliases in this family require the explicit `nativeAlias` opt-in below. */
const NATIVE_OPENAI_FAMILY_PATTERN = /^(?:gpt-|o1-|o3-|o4-|codex-)/;

export interface ComboValidationIssue {
  path: Array<string | number>;
  message: string;
}

export interface NormalizedComboConfig {
  strategy: OcxComboStrategy;
  stickyLimit: number;
  defaultEffort: OcxComboDefaultEffort | null;
  /** Disable image input; `auto` preserves the intersection derived from all targets. */
  imageInput: "auto" | "disabled";
  /** Trimmed public alias, or null when the combo keeps the default `combo/<id>` slug. */
  alias: string | null;
  /** Explicit native-family alias opt-in. */
  nativeAlias: boolean;
  /** Display-only label for the catalog row, or null when unset. */
  displayName: string | null;
  targets: Array<Required<OcxComboTarget>>;
}

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

/**
 * Cross-combo alias checks that need the full combos map (uniqueness). Kept separate
 * from `comboConfigIssues` so config-file validation and the management API share it.
 */
export function comboAliasIssues(
  id: string,
  alias: string,
  combos: Record<string, OcxComboConfig> | undefined,
  options: { excludeComboId?: string; allowNativeAlias?: boolean } = {},
): ComboValidationIssue[] {
  const issues: ComboValidationIssue[] = [];
  if (!COMBO_ALIAS_PATTERN.test(alias)) {
    issues.push({
      path: ["alias"],
      message: "alias must use letters, numbers, dot, underscore, or hyphen, with at most one \"/\" segment",
    });
    return issues;
  }
  if (alias === COMBO_NAMESPACE || alias.startsWith(`${COMBO_NAMESPACE}/`)) {
    issues.push({
      path: ["alias"],
      message: `alias must not use the reserved "${COMBO_NAMESPACE}/" namespace`,
    });
  }
  if (!alias.includes("/")
    && NATIVE_OPENAI_FAMILY_PATTERN.test(alias)
    && options.allowNativeAlias !== true) {
    issues.push({
      path: ["alias"],
      message: "bare aliases in the OpenAI native family require nativeAlias=true",
    });
  }
  for (const [otherId, other] of Object.entries(combos ?? {})) {
    if (otherId === id || otherId === options.excludeComboId) continue;
    const otherAlias = typeof other?.alias === "string" ? other.alias.trim() : "";
    if (otherAlias && otherAlias === alias) {
      issues.push({
        path: ["alias"],
        message: `alias "${alias}" is already used by combo "${otherId}"`,
      });
    }
  }
  return issues;
}

export interface ComboValidationOptions {
  requireEnabledTarget?: boolean;
  /** Full combos map for alias uniqueness checks; omitted during early config load. */
  combos?: Record<string, OcxComboConfig>;
  /** Combo being renamed — its stored alias is excluded from uniqueness checks. */
  excludeComboId?: string;
}

export function comboConfigIssues(
  id: string,
  raw: unknown,
  providers: Record<string, OcxProviderConfig>,
  options: ComboValidationOptions = {},
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
  if (body.imageInput !== undefined && body.imageInput !== "auto" && body.imageInput !== "disabled") {
    issues.push({ path: ["imageInput"], message: 'imageInput must be "auto" or "disabled"' });
  }

  if (body.alias !== undefined) {
    if (typeof body.alias !== "string") {
      issues.push({ path: ["alias"], message: "alias must be a string" });
    } else {
      const alias = body.alias.trim();
      if (alias) {
        issues.push(...comboAliasIssues(id, alias, options.combos, {
          ...options,
          allowNativeAlias: body.nativeAlias === true,
        }));
      }
    }
  }

  if (body.nativeAlias !== undefined && typeof body.nativeAlias !== "boolean") {
    issues.push({ path: ["nativeAlias"], message: "nativeAlias must be a boolean" });
  }
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string") {
      issues.push({ path: ["displayName"], message: "displayName must be a string" });
    } else if (body.displayName.trim().length > 128 || /[\u0000-\u001f\u007f]/.test(body.displayName)) {
      issues.push({
        path: ["displayName"],
        message: "displayName must be at most 128 characters and contain no control characters",
      });
    }
  }
  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  const nativeAlias = body.nativeAlias === true;
  if (nativeAlias && !SUPPORTED_NATIVE_OPENAI_SLUGS.has(alias)) {
    issues.push({
      path: ["nativeAlias"],
      message: "nativeAlias requires a currently supported bare OpenAI-native model alias",
    });
  }
  if (nativeAlias && (typeof body.displayName !== "string" || body.displayName.trim().length === 0)) {
    issues.push({ path: ["displayName"], message: "displayName is required for native aliases" });
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
  options: ComboValidationOptions = {},
): string | null {
  return comboConfigIssues(id, raw, providers, options)[0]?.message ?? null;
}

export function normalizeComboConfig(raw: OcxComboConfig): NormalizedComboConfig {
  const alias = typeof raw.alias === "string" ? raw.alias.trim() : "";
  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  return {
    strategy: raw.strategy ?? "failover",
    stickyLimit: raw.stickyLimit ?? 1,
    defaultEffort: raw.defaultEffort ?? null,
    imageInput: raw.imageInput === "disabled" ? "disabled" : "auto",
    alias: alias || null,
    nativeAlias: raw.nativeAlias === true,
    displayName: displayName || null,
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

export function listLiveComboTargetKeys(
  config: { combos?: Record<string, OcxComboConfig> },
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const id of listComboIds(config)) {
    const combo = getCombo(config, id);
    if (!combo) continue;
    for (const target of combo.targets) keys.add(`${id}::${targetKey(target)}`);
  }
  return keys;
}

export function getCombo(
  config: { combos?: Record<string, OcxComboConfig> },
  id: string,
): NormalizedComboConfig | undefined {
  const combos = config.combos;
  if (!combos || !Object.hasOwn(combos, id)) return undefined;
  return normalizeComboConfig(combos[id]!);
}
