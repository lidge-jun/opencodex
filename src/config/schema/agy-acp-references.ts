/**
 * Configuration rules for the Antigravity ACP provider (plan 080, R2-1).
 *
 * Pure and structural: this module reads the candidate configuration only. It imports no router,
 * routed-config, key store or runtime selection state, so validating a config never reads a
 * credential and never depends on cooldowns or health. An ACP provider is the canonical
 * `antigravity-acp` row (whatever adapter it was saved with) or any row whose adapter is `agy-acp`.
 */
import { AGY_ACP_DEFAULT_MODEL, AGY_ACP_SEED_MODELS } from "../../providers/registry/agy-acp-models";
import { aliasTemplateError, expandAliasTemplate } from "../../providers/alias-template";
import { isBareOpenAiFamilyModel } from "../../codex/control-plane-models";
import { OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers-destination";
import { effectiveModelAliases } from "../../providers/default-aliases";
import { COMBO_NAMESPACE, preservesPhysicalComboProvider } from "../../combos/identifiers";

export const AGY_ACP_PROVIDER_ID = "antigravity-acp";
export const AGY_ACP_ADAPTER = "agy-acp";

type ProviderLike = {
  disabled?: unknown;
  defaultAliases?: unknown;
  adapter?: unknown; apiKey?: unknown; apiKeyPool?: unknown; authMode?: unknown; models?: unknown; defaultModel?: unknown;
  modelAliases?: unknown; alias?: unknown; aliasTemplate?: unknown; oauthAccountFailover?: unknown;
  anthropicAccountPool?: unknown; codexAccountMode?: unknown;
};
type ComboLike = { alias?: unknown; targets?: unknown; decisionModel?: unknown };
export interface ConfigLike {
  providers?: Record<string, unknown>;
  defaultProvider?: unknown;
  defaultModelAliases?: unknown;
  combos?: unknown;
  customModels?: unknown;
  subagentModelFallback?: unknown;
  subagentModelFallbackByModel?: unknown;
  memoryModels?: unknown;
  injectionModel?: unknown;
  syncCodexSubagentDefaults?: unknown;
  compactionRouting?: unknown;
  shadowCallIntercept?: unknown;
}
export interface AgyAcpConfigIssue { path: (string | number)[]; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const GEMINI_ID = /^gemini[-.]/i;
const EFFORT_SUFFIX = /(?:[-@:](?:minimal|low|medium|high|xhigh|max|none))$/i;

export function isAgyAcpProvider(name: string, provider: unknown): boolean {
  return name === AGY_ACP_PROVIDER_ID || (isRecord(provider) && provider.adapter === AGY_ACP_ADAPTER);
}

function providerEntries(config: ConfigLike): Array<[string, ProviderLike]> {
  return isRecord(config.providers)
    ? Object.entries(config.providers).filter((entry): entry is [string, ProviderLike] => isRecord(entry[1]))
    : [];
}

function comboEntries(config: ConfigLike): Array<[string, ComboLike]> {
  return isRecord(config.combos)
    ? Object.entries(config.combos).filter((entry): entry is [string, ComboLike] => isRecord(entry[1]))
    : [];
}

function comboTargetProviders(combo: ComboLike): string[] {
  if (!Array.isArray(combo.targets)) return [];
  return combo.targets
    .map(target => (isRecord(target) && typeof target.provider === "string" ? target.provider.trim() : ""))
    .filter(Boolean);
}

/** customModels rows that name a provider: `{provider, modelId}`, as the router reads them. */
function customModelEntries(config: ConfigLike): Array<{ provider: string; modelId: unknown; index: number }> {
  if (!Array.isArray(config.customModels)) return [];
  return config.customModels.flatMap((row, index) =>
    isRecord(row) && typeof row.provider === "string" ? [{ provider: row.provider, modelId: row.modelId, index }] : []);
}

/** Configured routing claims plus the canonical ACP seed, reserved conservatively. */
function staticRoutingIds(name: string, provider: ProviderLike): Set<string> {
  const ids = new Set<string>();
  if (Array.isArray(provider.models)) for (const m of provider.models) if (typeof m === "string") ids.add(m);
  if (typeof provider.defaultModel === "string") ids.add(provider.defaultModel);
  if (name === AGY_ACP_PROVIDER_ID) {
    ids.add(AGY_ACP_DEFAULT_MODEL);
    for (const m of AGY_ACP_SEED_MODELS) ids.add(m);
  }
  return ids;
}

/**
 * Every configured provider a model selector could structurally resolve to. Conservative on
 * purpose: a selector the structure cannot place resolves to the default provider, so an
 * unresolved reference is never treated as safely elsewhere. Model aliases map one native id to
 * one alias inside one provider (they never name another alias), so one lookup level is complete.
 * Provider and model aliases compare case-insensitively, as the router does.
 */
export function selectorCandidateProviders(config: ConfigLike, selector: string): Set<string> {
  const out = new Set<string>();
  const raw = selector.trim();
  if (!raw) return out;
  const providers = providerEntries(config);
  const combos = comboEntries(config);
  const physicalCombo = preservesPhysicalComboProvider({
    providers: config.providers ?? {}, combos: isRecord(config.combos) ? config.combos : undefined,
  });
  const comboNamed = (name: string) => combos.filter(([id, combo]) => id === name || combo.alias === name);
  if (!physicalCombo && raw.startsWith(`${COMBO_NAMESPACE}/`)) {
    for (const [, combo] of comboNamed(raw.slice(COMBO_NAMESPACE.length + 1))) for (const p of comboTargetProviders(combo)) out.add(p);
    return out;
  }
  const slash = raw.indexOf("/");
  if (slash > 0) {
    const prefix = raw.slice(0, slash);
    const lower = prefix.toLowerCase();
    for (const [name, provider] of providers) {
      if (name === prefix || (typeof provider.alias === "string" && provider.alias.trim().toLowerCase() === lower)) out.add(name);
    }
    if (out.size > 0) return out;
  }
  const openai = providers.find(([name]) => name === OPENAI_CODEX_PROVIDER_ID)?.[1];
  if (openai && openai.disabled !== true && isBareOpenAiFamilyModel(raw)) return new Set([OPENAI_CODEX_PROVIDER_ID]);
  const bases = new Set([raw, raw.replace(EFFORT_SUFFIX, "")]);
  const lowerBases = [...bases].map(base => base.toLowerCase());
  const customModels = customModelEntries(config);
  for (const [name, provider] of providers) {
    if (provider.disabled === true) continue;
    const routingIds = staticRoutingIds(name, provider);
    const catalogIds = customModels.flatMap(row =>
      row.provider === name && typeof row.modelId === "string" ? [row.modelId] : []);
    // Reserve catalog-only ACP IDs conservatively without letting other catalogs hide the default.
    if (isAgyAcpProvider(name, provider)) for (const id of catalogIds) routingIds.add(id);
    const known = [...new Set([...routingIds, ...catalogIds])];
    const manual = isRecord(provider.modelAliases) ? provider.modelAliases : {};
    const modelAliases = Object.fromEntries(Object.entries(manual)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const assigned = effectiveModelAliases({ defaultModelAliases: config.defaultModelAliases === true }, {
      modelAliases, defaultAliases: typeof provider.defaultAliases === "boolean" ? provider.defaultAliases : undefined,
    }, known);
    const aliases = new Set([...assigned.values()].map(({ alias }) => alias.toLowerCase()));
    const template = provider.aliasTemplate;
    if (typeof template === "string" && !aliasTemplateError(template)) {
      const providerAlias = typeof provider.alias === "string" ? provider.alias.trim() || undefined : undefined;
      for (const modelId of known) {
        if (assigned.has(modelId)) continue;
        const expanded = expandAliasTemplate(template, providerAlias, modelId);
        // The structural check reserves potential matches even if the live roster has a collision.
        if ("alias" in expanded) aliases.add(expanded.alias.toLowerCase());
      }
    }
    if ([...bases].some(base => routingIds.has(base)) || lowerBases.some(base => aliases.has(base))) out.add(name);
  }
  for (const base of bases) {
    for (const [, combo] of comboNamed(base)) for (const p of comboTargetProviders(combo)) out.add(p);
  }
  if (out.size === 0 && typeof config.defaultProvider === "string") out.add(config.defaultProvider);
  return out;
}

const CREDENTIAL_MESSAGE = "The Antigravity CLI (ACP) provider uses the CLI's own sign-in: it takes no API key, key pool, account or OAuth setting.";

/** Invalid ACP-only settings. The disk loader uses the same checks to repair just these leaves. */
export function agyAcpProviderFieldIssues(config: ConfigLike): AgyAcpConfigIssue[] {
  const issues: AgyAcpConfigIssue[] = [];
  for (const [name, provider] of providerEntries(config)) {
    if (!isAgyAcpProvider(name, provider)) continue;
    const at = (field: string) => ["providers", name, field];
    if (provider.apiKey !== undefined && (typeof provider.apiKey !== "string" || provider.apiKey.trim())) issues.push({ path: at("apiKey"), message: CREDENTIAL_MESSAGE });
    if (provider.apiKeyPool !== undefined) issues.push({ path: at("apiKeyPool"), message: CREDENTIAL_MESSAGE });
    if (provider.oauthAccountFailover !== undefined) issues.push({ path: at("oauthAccountFailover"), message: CREDENTIAL_MESSAGE });
    // Account binding fields: the CLI's single sign-in is the only account this provider has.
    if (provider.anthropicAccountPool !== undefined) issues.push({ path: at("anthropicAccountPool"), message: CREDENTIAL_MESSAGE });
    if (provider.codexAccountMode !== undefined) issues.push({ path: at("codexAccountMode"), message: CREDENTIAL_MESSAGE });
    if (provider.authMode !== undefined && provider.authMode !== "key") issues.push({ path: at("authMode"), message: CREDENTIAL_MESSAGE });
    if (Array.isArray(provider.models)) {
      provider.models.forEach((model, i) => {
        if (typeof model !== "string" || !GEMINI_ID.test(model)) {
          issues.push({ path: ["providers", name, "models", i], message: "The Antigravity CLI (ACP) provider serves Gemini models only." });
        }
      });
    }
    if (isRecord(provider.modelAliases)) {
      for (const native of Object.keys(provider.modelAliases)) {
        if (!GEMINI_ID.test(native)) issues.push({ path: ["providers", name, "modelAliases", native], message: "The Antigravity CLI (ACP) provider serves Gemini models only." });
      }
    }
    if (provider.defaultModel !== undefined && (typeof provider.defaultModel !== "string" || !GEMINI_ID.test(provider.defaultModel))) {
      issues.push({ path: at("defaultModel"), message: "The Antigravity CLI (ACP) provider serves Gemini models only." });
    }
  }
  return issues;
}

/** Issues for the Antigravity ACP provider rules; empty when there are no ACP providers. */
export function agyAcpConfigIssues(config: ConfigLike): AgyAcpConfigIssue[] {
  const acp = new Set(providerEntries(config).filter(([name, provider]) => isAgyAcpProvider(name, provider)).map(([name]) => name));
  if (acp.size === 0) return [];
  const issues = agyAcpProviderFieldIssues(config);
  for (const row of customModelEntries(config)) {
    if (acp.has(row.provider) && (typeof row.modelId !== "string" || !GEMINI_ID.test(row.modelId))) {
      issues.push({ path: ["customModels", row.index, "modelId"], message: "The Antigravity CLI (ACP) provider serves Gemini models only." });
    }
  }
  for (const [id, combo] of comboEntries(config)) {
    // A JEV decision model runs an automated decision call on every request through the combo.
    if (typeof combo.decisionModel === "string" && [...selectorCandidateProviders(config, combo.decisionModel)].some(name => acp.has(name))) {
      issues.push({ path: ["combos", id, "decisionModel"], message: "The Antigravity CLI (ACP) provider cannot decide for a combo: it serves interactive, user-directed turns only." });
    }
    if (!Array.isArray(combo.targets)) continue;
    combo.targets.forEach((target, i) => {
      const provider = isRecord(target) && typeof target.provider === "string" ? target.provider.trim() : "";
      if (provider && acp.has(provider)) {
        issues.push({ path: ["combos", id, "targets", i, "provider"], message: "The Antigravity CLI (ACP) provider cannot be a combo target: it serves interactive, user-directed turns only." });
      }
    });
  }
  return issues.concat(agyAcpUnattendedTargetIssues(config));
}

/** Selectors the adapter refuses for unattended helpers and subagents. */
export function agyAcpUnattendedTargetIssues(config: ConfigLike): AgyAcpConfigIssue[] {
  const issues: AgyAcpConfigIssue[] = [];
  if (!providerEntries(config).some(([name, provider]) => isAgyAcpProvider(name, provider))) return issues;
  const selectsAcp = (selector: unknown): boolean =>
    typeof selector === "string" && [...selectorCandidateProviders(config, selector)].some(name => {
      const provider = config.providers?.[name];
      return isRecord(provider) && isAgyAcpProvider(name, provider);
    });
  const fallbackMessage = "The Antigravity CLI (ACP) provider cannot be a subagent fallback: it serves interactive, user-directed turns only.";
  const checkList = (list: unknown, path: (string | number)[]): void => {
    if (!Array.isArray(list)) return;
    list.forEach((entry, i) => {
      if (selectsAcp(entry)) issues.push({ path: [...path, i], message: fallbackMessage });
    });
  };
  checkList(config.subagentModelFallback, ["subagentModelFallback"]);
  if (isRecord(config.subagentModelFallbackByModel)) {
    for (const [model, list] of Object.entries(config.subagentModelFallbackByModel)) checkList(list, ["subagentModelFallbackByModel", model]);
  }
  if (config.syncCodexSubagentDefaults === true && selectsAcp(config.injectionModel)) {
    issues.push({ path: ["injectionModel"], message: "The Antigravity CLI (ACP) provider cannot be the managed subagent default: it serves interactive, user-directed turns only." });
  }
  const compaction = config.compactionRouting;
  if (isRecord(compaction) && Array.isArray(compaction.triggers) && compaction.triggers.includes("auto") && selectsAcp(compaction.model)) {
    issues.push({ path: ["compactionRouting", "model"], message: "The Antigravity CLI (ACP) provider cannot run automatic compaction: it serves interactive, user-directed turns only." });
  }
  if (isRecord(config.memoryModels)) {
    for (const phase of ["extract", "consolidation"] as const) {
      const setting = config.memoryModels[phase];
      if (isRecord(setting) && selectsAcp(setting.model)) {
        issues.push({ path: ["memoryModels", phase, "model"], message: "The Antigravity CLI (ACP) provider cannot run Codex memory turns: it serves interactive, user-directed turns only." });
      }
    }
  }
  if (isRecord(config.shadowCallIntercept) && config.shadowCallIntercept.enabled === true && selectsAcp(config.shadowCallIntercept.model)) {
    issues.push({ path: ["shadowCallIntercept", "model"], message: "The Antigravity CLI (ACP) provider cannot be the shadow-call target: it serves interactive, user-directed turns only." });
  }
  return issues;
}
