/**
 * Configuration rules for the Antigravity ACP provider (plan 080, R2-1).
 *
 * Pure and structural: this module reads the candidate configuration only. It imports no router,
 * routed-config, key store or runtime selection state, so validating a config never reads a
 * credential and never depends on cooldowns or health. An ACP provider is the canonical
 * `antigravity-acp` row (whatever adapter it was saved with) or any row whose adapter is `agy-acp`.
 */
export const AGY_ACP_PROVIDER_ID = "antigravity-acp";
export const AGY_ACP_ADAPTER = "agy-acp";
/**
 * Static seed of the canonical registry row (entries-extended.ts), restated because this leaf
 * imports nothing; tests/config/agy-acp-config.test.ts fails if the two drift. The router counts a
 * registry row's seed and default model as known ids even when the configured row lists no models,
 * so a structural check has to count them too.
 */
export const AGY_ACP_DEFAULT_MODEL = "gemini-3.8-flash";
export const AGY_ACP_SEED_MODELS: readonly string[] = ["gemini-3.8-flash", "gemini-4-argon", "gemini-3.7-flash"];

type ProviderLike = {
  adapter?: unknown; apiKey?: unknown; apiKeyPool?: unknown; authMode?: unknown; models?: unknown; defaultModel?: unknown;
  modelAliases?: unknown; alias?: unknown; oauthAccountFailover?: unknown;
};
type ComboLike = { alias?: unknown; targets?: unknown };
export interface ConfigLike {
  providers?: Record<string, unknown>;
  defaultProvider?: unknown;
  combos?: unknown;
  customModels?: unknown;
  subagentModelFallback?: unknown;
  subagentModelFallbackByModel?: unknown;
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

/** Native ids the router would know for a provider without live discovery (router.ts knownModelIdsForProvider). */
function staticKnownIds(config: ConfigLike, name: string, provider: ProviderLike): string[] {
  const ids = new Set<string>();
  if (Array.isArray(provider.models)) for (const m of provider.models) if (typeof m === "string") ids.add(m);
  if (typeof provider.defaultModel === "string") ids.add(provider.defaultModel);
  if (name === AGY_ACP_PROVIDER_ID) {
    ids.add(AGY_ACP_DEFAULT_MODEL);
    for (const m of AGY_ACP_SEED_MODELS) ids.add(m);
  }
  for (const row of customModelEntries(config)) if (row.provider === name && typeof row.modelId === "string") ids.add(row.modelId);
  return [...ids];
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
  const comboNamed = (name: string) => combos.filter(([id, combo]) => id === name || combo.alias === name);
  if (raw.startsWith("combo/")) {
    for (const [, combo] of comboNamed(raw.slice("combo/".length))) for (const p of comboTargetProviders(combo)) out.add(p);
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
  const bases = new Set([raw, raw.replace(EFFORT_SUFFIX, "")]);
  const lowerBases = [...bases].map(base => base.toLowerCase());
  for (const [name, provider] of providers) {
    const known = staticKnownIds(config, name, provider);
    const aliases = isRecord(provider.modelAliases)
      ? Object.values(provider.modelAliases).filter((a): a is string => typeof a === "string").map(a => a.toLowerCase())
      : [];
    if ([...bases].some(base => known.includes(base)) || lowerBases.some(base => aliases.includes(base))) out.add(name);
  }
  for (const base of bases) {
    for (const [, combo] of comboNamed(base)) for (const p of comboTargetProviders(combo)) out.add(p);
  }
  if (out.size === 0 && typeof config.defaultProvider === "string") out.add(config.defaultProvider);
  return out;
}

const CREDENTIAL_MESSAGE = "The Antigravity CLI (ACP) provider uses the CLI's own sign-in: it takes no API key, key pool, account or OAuth setting.";

/** Issues for the Antigravity ACP provider rules; empty when there are no ACP providers. */
export function agyAcpConfigIssues(config: ConfigLike): AgyAcpConfigIssue[] {
  const issues: AgyAcpConfigIssue[] = [];
  const providers = providerEntries(config);
  const acp = new Set(providers.filter(([name, provider]) => isAgyAcpProvider(name, provider)).map(([name]) => name));
  if (acp.size === 0) return issues;
  for (const [name, provider] of providers) {
    if (!acp.has(name)) continue;
    const at = (field: string) => ["providers", name, field];
    if (typeof provider.apiKey === "string" && provider.apiKey.trim()) issues.push({ path: at("apiKey"), message: CREDENTIAL_MESSAGE });
    if (provider.apiKeyPool !== undefined) issues.push({ path: at("apiKeyPool"), message: CREDENTIAL_MESSAGE });
    if (provider.oauthAccountFailover !== undefined) issues.push({ path: at("oauthAccountFailover"), message: CREDENTIAL_MESSAGE });
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
  for (const row of customModelEntries(config)) {
    if (acp.has(row.provider) && (typeof row.modelId !== "string" || !GEMINI_ID.test(row.modelId))) {
      issues.push({ path: ["customModels", row.index, "modelId"], message: "The Antigravity CLI (ACP) provider serves Gemini models only." });
    }
  }
  for (const [id, combo] of comboEntries(config)) {
    if (!Array.isArray(combo.targets)) continue;
    combo.targets.forEach((target, i) => {
      const provider = isRecord(target) && typeof target.provider === "string" ? target.provider.trim() : "";
      if (provider && acp.has(provider)) {
        issues.push({ path: ["combos", id, "targets", i, "provider"], message: "The Antigravity CLI (ACP) provider cannot be a combo target: it serves interactive, user-directed turns only." });
      }
    });
  }
  const fallbackMessage = "The Antigravity CLI (ACP) provider cannot be a subagent fallback: it serves interactive, user-directed turns only.";
  const checkList = (list: unknown, path: (string | number)[]): void => {
    if (!Array.isArray(list)) return;
    list.forEach((entry, i) => {
      if (typeof entry !== "string") return;
      if ([...selectorCandidateProviders(config, entry)].some(name => acp.has(name))) issues.push({ path: [...path, i], message: fallbackMessage });
    });
  };
  checkList(config.subagentModelFallback, ["subagentModelFallback"]);
  if (isRecord(config.subagentModelFallbackByModel)) {
    for (const [model, list] of Object.entries(config.subagentModelFallbackByModel)) checkList(list, ["subagentModelFallbackByModel", model]);
  }
  return issues;
}
