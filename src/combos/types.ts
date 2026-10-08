import { isCodexReasoningEffort, isDeclaredReasoningEffort } from "../reasoning-effort";
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../codex/catalog/native-models";
import type { OcxComboConfig, OcxComboCooldownWaitPolicy, OcxComboDefaultEffort, OcxComboDefaultEffortMode, OcxComboReasoningEffortMode, OcxComboStrategy, OcxComboTarget, OcxProviderConfig } from "../types";
import { COMBO_NAMESPACE, isValidComboId, resolveComboId, targetKey } from "./identifiers";
import {
  CANONICAL_JEV_DECISION_PROVIDER,
  JEV_DECISION_TIMEOUT_MAX_MS,
  JEV_DECISION_TIMEOUT_MIN_MS,
  isSystemOneEndpoint,
} from "./jev-decision-contract";

export const COMBO_DEFAULT_WAIT_FOR_COOLDOWN_MS = 0;
export const JEV_MAX_CANDIDATE_FIELD_CHARS = 512;
export {
  JEV_DECISION_TIMEOUT_DEFAULT_MS,
  JEV_DECISION_TIMEOUT_MAX_MS,
  JEV_DECISION_TIMEOUT_MIN_MS,
  isSystemOneEndpoint,
} from "./jev-decision-contract";
export { COMBO_NAMESPACE, preservesPhysicalComboProvider, isNativeAliasCombo, targetKey, parseComboModelId, comboModelId, comboPublicModelId, comboDisabledModelId, comboDisabledModelSelectors, resolveComboId, isValidComboId } from "./identifiers";

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

export interface NormalizedComboTarget {
  provider: string;
  model: string;
  weight: number;
  /** Emergency-only target, deferred under `cooldownWaitPolicy` (#5691). */
  lastResort: boolean;
  reasoningEfforts?: OcxComboDefaultEffort[];
  /** Optional JEV decision description. */
  modelProfile?: string;
}

export interface NormalizedComboConfig {
  strategy: OcxComboStrategy;
  stickyLimit: number;
  cooldownMs?: number;
  waitForCooldownMs: number;
  /** `before-last-resort` defers lastResort targets while a normal one can be waited out (#5691). */
  cooldownWaitPolicy: OcxComboCooldownWaitPolicy | null;
  defaultEffort: OcxComboDefaultEffort | null;
  /** Client-precedence policy; `fallback` preserves legacy behavior. */
  defaultEffortMode: OcxComboDefaultEffortMode;
  /** Picker-ladder derivation policy; `strict` preserves the legacy intersection rule. */
  reasoningEffortMode: OcxComboReasoningEffortMode;
  /** Disable image input; `auto` preserves the intersection derived from all targets. */
  imageInput: "auto" | "disabled";
  /** Trimmed public alias, or null when the combo keeps the default `combo/<id>` slug. */
  alias: string | null;
  /** Explicit native-family alias opt-in. */
  nativeAlias: boolean;
  /** Display-only label for the catalog row, or null when unset. */
  displayName: string | null;
  /** JEV decision service provider id; absent means the canonical `jev` service. */
  decisionProvider?: string;
  /** Ordinary inference route used for JEV decisions. */
  decisionModel?: string;
  /** JEV decision deadline override; absent keeps the default four-second deadline. */
  decisionTimeoutMs?: number;
  targets: NormalizedComboTarget[];
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
  /**
   * Save-time only: also reject a `decisionProvider` row the runtime would skip (disabled, or no
   * model). Config-file load stays lenient so disabling a referenced row never breaks startup.
   */
  requireUsableDecisionService?: boolean;
  /** Full combos map for alias uniqueness checks; omitted during early config load. */
  combos?: Record<string, OcxComboConfig>;
  /** Ingress selector grammar, injected so combo validation never imports server routing. */
  normalizeDecisionModel?: (model: string) => string;
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
  if (typeof body.alias === "string") {
    const alias = body.alias.toLowerCase();
    for (const [providerName, provider] of Object.entries(providers)) {
      if (provider.alias?.toLowerCase() === alias) {
        issues.push({ path: ["alias"], message: `alias "${body.alias}" is already used by provider "${providerName}"` });
      }
      const model = Object.entries(provider.modelAliases ?? {}).find(([, value]) => value.toLowerCase() === alias);
      if (model) issues.push({ path: ["alias"], message: `alias "${body.alias}" is already used by model "${providerName}/${model[0]}"` });
    }
  }
  if (body.strategy !== undefined
    && body.strategy !== "failover"
    && body.strategy !== "round-robin"
    && body.strategy !== "random"
    && body.strategy !== "least-used"
    && body.strategy !== "reset-window"
    && body.strategy !== "jev") {
    issues.push({ path: ["strategy"], message: 'strategy must be "failover", "round-robin", "random", "least-used", "reset-window", or "jev"' });
  }
  if (body.stickyLimit !== undefined
    && (typeof body.stickyLimit !== "number" || !Number.isInteger(body.stickyLimit)
      || body.stickyLimit < 1
      || body.stickyLimit > 100)) {
    issues.push({ path: ["stickyLimit"], message: "stickyLimit must be an integer from 1 to 100" });
  }
  if (body.cooldownMs !== undefined
    && (typeof body.cooldownMs !== "number" || !Number.isInteger(body.cooldownMs)
      || body.cooldownMs < 1
      || body.cooldownMs > 600_000)) {
    issues.push({ path: ["cooldownMs"], message: "cooldownMs must be an integer from 1 to 600000" });
  }
  if (body.waitForCooldownMs !== undefined
    && (typeof body.waitForCooldownMs !== "number" || !Number.isInteger(body.waitForCooldownMs)
      || body.waitForCooldownMs < 0
      || body.waitForCooldownMs > 600_000)) {
    issues.push({ path: ["waitForCooldownMs"], message: "waitForCooldownMs must be an integer from 0 to 600000" });
  }
  if (body.cooldownWaitPolicy !== undefined && body.cooldownWaitPolicy !== null
    && body.cooldownWaitPolicy !== "before-last-resort") {
    issues.push({
      path: ["cooldownWaitPolicy"],
      message: 'cooldownWaitPolicy must be "before-last-resort" when set',
    });
  }
  if (body.defaultEffort !== undefined
    && body.defaultEffort !== null
    && (typeof body.defaultEffort !== "string" || !isCodexReasoningEffort(body.defaultEffort))) {
    issues.push({
      path: ["defaultEffort"],
      message: "defaultEffort must be one of: low, medium, high, xhigh, max, ultra",
    });
  }
  if (body.defaultEffortMode !== undefined
    && body.defaultEffortMode !== "fallback"
    && body.defaultEffortMode !== "force") {
    issues.push({
      path: ["defaultEffortMode"],
      message: 'defaultEffortMode must be "fallback" or "force"',
    });
  }
  if (body.defaultEffortMode === "force"
    && (typeof body.defaultEffort !== "string" || !isCodexReasoningEffort(body.defaultEffort))) {
    issues.push({
      path: ["defaultEffort"],
      message: "defaultEffort is required when defaultEffortMode is force",
    });
  }
  if (body.imageInput !== undefined && body.imageInput !== "auto" && body.imageInput !== "disabled") {
    issues.push({ path: ["imageInput"], message: 'imageInput must be "auto" or "disabled"' });
  }
  if (body.reasoningEffortMode !== undefined
    && body.reasoningEffortMode !== "strict"
    && body.reasoningEffortMode !== "adaptive") {
    issues.push({
      path: ["reasoningEffortMode"],
      message: 'reasoningEffortMode must be "strict" or "adaptive"',
    });
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
  if (body.decisionProvider !== undefined && body.decisionProvider !== null) {
    const decisionProvider = typeof body.decisionProvider === "string" ? body.decisionProvider.trim() : "";
    if (!decisionProvider) {
      issues.push({ path: ["decisionProvider"], message: "decisionProvider must be a non-empty provider name" });
    } else if (body.strategy !== "jev") {
      issues.push({ path: ["decisionProvider"], message: 'decisionProvider is only valid with strategy "jev"' });
    } else if (decisionProvider === CANONICAL_JEV_DECISION_PROVIDER) {
      // Explicit "jev" means exactly what omission means: the canonical TypeSafe service.
    } else if (!Object.hasOwn(providers, decisionProvider)) {
      issues.push({
        path: ["decisionProvider"],
        message: `decisionProvider "${decisionProvider}" is not configured`,
      });
    } else if (providers[decisionProvider]?.adapter !== "jev-decision") {
      issues.push({
        path: ["decisionProvider"],
        message: `decisionProvider "${decisionProvider}" is not a decision service (adapter must be "jev-decision")`,
      });
    } else if (!isSystemOneEndpoint(String(providers[decisionProvider]?.baseUrl ?? ""))) {
      issues.push({
        path: ["decisionProvider"],
        message: `decisionProvider "${decisionProvider}" baseUrl must be a full HTTPS decision endpoint or an HTTP /systemone endpoint`,
      });
    } else if (options.requireUsableDecisionService && providers[decisionProvider]?.disabled === true) {
      issues.push({
        path: ["decisionProvider"],
        message: `decisionProvider "${decisionProvider}" is disabled`,
      });
    } else if (options.requireUsableDecisionService
      && !providers[decisionProvider]?.defaultModel?.trim()
      && !providers[decisionProvider]?.models?.[0]?.trim()) {
      issues.push({
        path: ["decisionProvider"],
        message: `decisionProvider "${decisionProvider}" has no model (set defaultModel or models)`,
      });
    }
  }
  if (body.decisionModel !== undefined && body.decisionModel !== null) {
    const model = typeof body.decisionModel === "string" ? body.decisionModel.trim() : "";
    if (!model || model.length > JEV_MAX_CANDIDATE_FIELD_CHARS) {
      issues.push({ path: ["decisionModel"], message: `decisionModel must be a non-empty string of at most ${JEV_MAX_CANDIDATE_FIELD_CHARS} characters` });
    } else {
      if (body.strategy !== "jev") {
        issues.push({ path: ["decisionModel"], message: 'decisionModel is only valid with strategy "jev"' });
      }
      if (body.decisionProvider !== undefined && body.decisionProvider !== null) {
        issues.push({ path: ["decisionModel"], message: "decisionModel cannot coexist with decisionProvider" });
      }
      const comboId = resolveComboId({ combos: options.combos }, options.normalizeDecisionModel?.(model) ?? model);
      if (comboId === id || (comboId && options.combos?.[comboId]?.strategy === "jev")) {
        issues.push({ path: ["decisionModel"], message: `decisionModel must not reference ${comboId === id ? "itself" : "a JEV combo"} (combo "${comboId}")` });
      }
    }
  }
  if (body.decisionTimeoutMs !== undefined && body.decisionTimeoutMs !== null) {
    if (typeof body.decisionTimeoutMs !== "number" || !Number.isInteger(body.decisionTimeoutMs)
      || body.decisionTimeoutMs < JEV_DECISION_TIMEOUT_MIN_MS
      || body.decisionTimeoutMs > JEV_DECISION_TIMEOUT_MAX_MS) {
      issues.push({
        path: ["decisionTimeoutMs"],
        message: `decisionTimeoutMs must be an integer from ${JEV_DECISION_TIMEOUT_MIN_MS} to ${JEV_DECISION_TIMEOUT_MAX_MS}`,
      });
    } else if (body.strategy !== "jev") {
      issues.push({ path: ["decisionTimeoutMs"], message: 'decisionTimeoutMs is only valid with strategy "jev"' });
    }
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
    } else if (providers[provider]?.adapter === "jev-decision") {
      issues.push({
        path: ["targets", i, "provider"],
        message: `targets[${i}].provider "${provider}" is a decision service and cannot be a model target`,
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
    if (target.reasoningEfforts !== undefined) {
      if (!Array.isArray(target.reasoningEfforts) || target.reasoningEfforts.length === 0) {
        issues.push({
          path: ["targets", i, "reasoningEfforts"],
          message: `targets[${i}].reasoningEfforts must be a non-empty array`,
        });
      } else {
        const seenEfforts = new Set<OcxComboDefaultEffort>();
        for (let effortIndex = 0; effortIndex < target.reasoningEfforts.length; effortIndex++) {
          const effort = target.reasoningEfforts[effortIndex];
          if (typeof effort !== "string" || !isCodexReasoningEffort(effort)) {
            issues.push({
              path: ["targets", i, "reasoningEfforts", effortIndex],
              message: `targets[${i}].reasoningEfforts[${effortIndex}] must be one of: low, medium, high, xhigh, max, ultra`,
            });
          } else if (seenEfforts.has(effort as OcxComboDefaultEffort)) {
            issues.push({
              path: ["targets", i, "reasoningEfforts", effortIndex],
              message: `targets[${i}].reasoningEfforts must not contain duplicates`,
            });
          } else {
            seenEfforts.add(effort as OcxComboDefaultEffort);
          }
        }
      }
    }
    if (target.lastResort !== undefined && typeof target.lastResort !== "boolean") {
      issues.push({
        path: ["targets", i, "lastResort"],
        message: `targets[${i}].lastResort must be a boolean`,
      });
    }
    if (target.modelProfile !== undefined
      && (typeof target.modelProfile !== "string"
        || target.modelProfile.trim().length === 0
        || target.modelProfile.length > JEV_MAX_CANDIDATE_FIELD_CHARS
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(target.modelProfile))) {
      issues.push({
        path: ["targets", i, "modelProfile"],
        message: `targets[${i}].modelProfile must be a non-empty string of at most ${JEV_MAX_CANDIDATE_FIELD_CHARS} characters; only tab, line feed and carriage return are allowed among control characters`,
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
  const decisionProvider = typeof raw.decisionProvider === "string" ? raw.decisionProvider.trim() : "";
  const decisionModel = typeof raw.decisionModel === "string" ? raw.decisionModel.trim() : "";
  const defaultEffort = typeof raw.defaultEffort === "string" && isCodexReasoningEffort(raw.defaultEffort)
    ? raw.defaultEffort
    : null;
  return {
    strategy: raw.strategy ?? "failover",
    stickyLimit: raw.stickyLimit ?? 1,
    cooldownMs: raw.cooldownMs,
    waitForCooldownMs: raw.waitForCooldownMs ?? COMBO_DEFAULT_WAIT_FOR_COOLDOWN_MS,
    cooldownWaitPolicy: raw.cooldownWaitPolicy === "before-last-resort" ? "before-last-resort" : null,
    defaultEffort,
    defaultEffortMode: raw.defaultEffortMode === "force" && defaultEffort !== null ? "force" : "fallback",
    reasoningEffortMode: raw.reasoningEffortMode === "adaptive" ? "adaptive" : "strict",
    imageInput: raw.imageInput === "disabled" ? "disabled" : "auto",
    alias: alias || null,
    nativeAlias: raw.nativeAlias === true,
    displayName: displayName || null,
    // Explicit "jev" is the default and stays sparse.
    ...(decisionProvider && decisionProvider !== CANONICAL_JEV_DECISION_PROVIDER ? { decisionProvider } : {}),
    ...(decisionModel ? { decisionModel } : {}),
    ...(typeof raw.decisionTimeoutMs === "number" ? { decisionTimeoutMs: raw.decisionTimeoutMs } : {}),
    targets: raw.targets.map(target => ({
      provider: target.provider.trim(),
      model: target.model.trim(),
      weight: target.weight ?? 1,
      ...(target.reasoningEfforts !== undefined
        ? { reasoningEfforts: [...target.reasoningEfforts] }
        : {}),
      ...(typeof target.modelProfile === "string" && target.modelProfile.trim()
        ? { modelProfile: target.modelProfile.trim() }
        : {}),
      lastResort: target.lastResort === true,
    })),
  };
}

/**
 * Load-time stand-in for the ingress synthetic-row grammar: strip a `--fast` suffix, and a
 * `--<effort>` suffix when Cursor effort rows are on. It reads only the string, so schema
 * validation needs no server module, model inventory, or Cursor install detection. The
 * management save path still resolves the exact grammar against the live inventory.
 */
export function lexicalDecisionModelBase(model: string, cursorEffortRows: boolean): string {
  if (model.endsWith("--fast")) return model.slice(0, -"--fast".length);
  if (!cursorEffortRows) return model;
  const separator = model.lastIndexOf("--");
  if (separator <= 0) return model;
  const effort = model.slice(separator + 2);
  return effort !== "none" && isDeclaredReasoningEffort(effort) ? model.slice(0, separator) : model;
}

/**
 * Whether removing `provider` would leave this stored combo invalid: a target uses it, or the
 * combo names it as its JEV decision service. The canonical `jev` id stays valid without a row.
 */
export function comboDependsOnProvider(combo: OcxComboConfig, provider: string): boolean {
  if (combo.targets.some(target => target.provider === provider)) return true;
  if (typeof combo.decisionModel === "string" && combo.decisionModel.trim().startsWith(`${provider}/`)) return true;
  const decisionProvider = typeof combo.decisionProvider === "string" ? combo.decisionProvider.trim() : "";
  return decisionProvider === provider && provider !== CANONICAL_JEV_DECISION_PROVIDER;
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
