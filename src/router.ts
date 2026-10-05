import type { CodexAccountMode, OcxConfig, OcxProviderConfig } from "./types";
import { createHash } from "node:crypto";
import { peekAuthStore } from "./oauth/store";
import { resolveDevinApiBaseUrl, validateDevinApiBaseUrl } from "./oauth/devin/api-base";
import {
  getCombo,
  isComboTargetInCooldown,
  preservesPhysicalComboProvider,
  targetKey,
  tryPickComboModel,
  type ComboPick,
} from "./combos";
import type { NormalizedComboConfig } from "./combos/types";
import { hasOwnProvider } from "./config/provider-name";
import { reconcileRouterWarningMemos, routedProviderConfig } from "./providers/routed-config";
import { assertProviderDestinationAllowed } from "./lib/destination-policy";
import {
  PROVIDER_REGISTRY,
  providerCodexAccountMode,
} from "./providers/registry";
// Imported from the module directly rather than through the registry facade, which is at its
// file-size cap.
import { registryModelIdKeys } from "./providers/registry/model-ids";
import { providerMatchesRegistryTransportWithStaticGuards } from "./providers/static-model-discovery";
import {
  isCanonicalOpenAiForwardProvider,
  LEGACY_CHATGPT_PROVIDER_ID,
  LEGACY_OPENAI_MULTI_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_ID,
} from "./providers/openai-tiers";
import { decodeRoutedModelIdOrThrow, encodeRoutedModelId } from "./providers/slug-codec";
import { effectiveProviderAliasDecision, resolveModelAlias } from "./providers/default-aliases";
import { resolveBlockedModelRedirect } from "./lib/shadow-call";
import { getRoutingCached } from "./codex/model-cache";
import { codexAccountNamespaceEntries } from "./codex/account-namespaces";
import {
  buildRouteDecisionTrace,
  type RouteDecisionKind,
  type RouteDecisionTraceV1,
  type TraceCandidateInput,
} from "./routing/trace";
import { getRoutingProfile, resolvePolicyProfileId, POLICY_NAMESPACE } from "./routing/profile";
import { evaluatePolicyProfile, type PolicyRequestEvidence } from "./routing/evaluator";
import { assemblePolicyCandidateEvidence } from "./routing/compatibility/assemble";
import { resolveModelPolicy, type ResolvedModelPolicy } from "./providers/resolved-model-policy";

export class UnknownRoutingPolicyError extends Error {
  constructor(readonly profileId: string) {
    super(`Unknown routing policy: ${profileId}`);
    this.name = "UnknownRoutingPolicyError";
  }
}

export class NoEligiblePolicyCandidateError extends Error {
  /** Evaluation trace (with per-candidate exclusions) when nothing qualified. */
  readonly trace?: RouteDecisionTraceV1;

  constructor(readonly profileId: string, trace?: RouteDecisionTraceV1) {
    super(`No eligible candidates for policy profile: ${profileId}`);
    this.name = "NoEligiblePolicyCandidateError";
    this.trace = trace;
  }
}

export interface RouteResult {
  providerName: string;
  provider: OcxProviderConfig;
  modelId: string;
  /** Immutable static policy for the current final wire model. */
  staticPolicy: ResolvedModelPolicy;
  /** Which deterministic routing path produced this route (RI-01). */
  routeKind: RouteDecisionKind;
  /** Stable wire reason code for the selected route (RI-01). */
  routeReason: string;
  codexAccountMode?: CodexAccountMode;
  /** Exact account selected by an account-qualified native model. */
  codexAccountId?: string;
  /** Public namespace used by the account-qualified selector. */
  codexAccountNamespace?: string;
  combo?: ComboPick;
  /** Bounded route-decision trace (RI-01); never contains secrets. */
  routeDecision?: RouteDecisionTraceV1;
  /**
   * Full eligible provider/model membership from a policy evaluation, keyed
   * "provider\u0000model". The trace's candidate list is bounded; fallback
   * redirect checks need membership for eligible rows that were truncated out.
   */
  policyEligibility?: ReadonlySet<string>;
  /**
   * Set when a blocked-model redirect moved the request to a different
   * provider. Caller credentials addressed to the source route must not follow
   * it, exactly as for combo and policy routes.
   */
  credentialDomainRewrite?: true;
}

export function captureRouteStaticPolicy(
  providerName: string,
  modelId: string,
  provider: OcxProviderConfig,
  effectiveAlias?: string | null,
  inboundWire: "responses" | "chat" | "anthropic" = "responses",
): ResolvedModelPolicy {
  const registryEntry = PROVIDER_REGISTRY.find(entry => entry.id === providerName);
  const transportMatchedRegistry = !!registryEntry
    && providerMatchesRegistryTransportWithStaticGuards(providerName, provider);
  return resolveModelPolicy({
    providerName,
    modelId,
    provider,
    registryEntry,
    transportMatchedRegistry,
    inboundWire,
    modelCapabilities: provider.modelCapabilities?.[modelId],
    ...(provider.authMode ? { effectiveAuth: { authMode: provider.authMode } } : {}),
    ...(effectiveAlias !== undefined ? { effectiveAlias } : {}),
  });
}

const MODEL_PROVIDER_PATTERNS: Array<{ providerNames: string[]; prefixes: string[] }> = [
  {
    providerNames: ["anthropic"],
    prefixes: [
    "claude-", "claude-sonnet-", "claude-opus-", "claude-haiku-",
    ],
  },
  {
    providerNames: ["groq"],
    prefixes: [
    "llama-", "mixtral-", "gemma-",
    ],
  },
];

/**
 * Known native model ids for a provider — the decode source for the Codex slug codec
 * (src/providers/slug-codec.ts). Union of static config ids, registry seeds, and the
 * last-known-good live /models cache (may be empty on a cold start; decode then passes
 * unknown ids through unchanged for an honest upstream error).
 */
export function knownModelIdsForProvider(
  provName: string,
  prov: OcxProviderConfig,
  config?: Pick<OcxConfig, "customModels">,
): string[] {
  const ids = new Set<string>();
  for (const id of prov.models ?? []) ids.add(id);
  if (prov.defaultModel) ids.add(prov.defaultModel);
  const registry = providerMatchesRegistryTransportWithStaticGuards(provName, prov)
    ? PROVIDER_REGISTRY.find(entry => entry.id === provName)
    : undefined;
  for (const id of registry?.models ?? []) ids.add(id);
  // Registry model-keyed hint maps double as known native ids (e.g. NVIDIA carries no
  // static models list but names `moonshotai/kimi-k2.6` in its effort/window maps). Which
  // maps count is classified by the registry itself rather than listed here, so an id declared
  // only in a map this function forgot is no longer undecodable, and a new model-keyed field
  // fails typecheck until its keys are given a meaning.
  for (const id of registry ? registryModelIdKeys(registry) : []) ids.add(id);
  const cachedModels = getRoutingCached(provName, () => {
    // This callback runs only for a scoped entry, not for each provider in an alias scan.
    const routed = routedProviderConfig(provName, prov);
    let key = routed.apiKey;
    let destination = routed.baseUrl;
    if (routed.authMode === "oauth") {
      const set = peekAuthStore()[provName];
      const account = set?.accounts.find(row => row.id === set.activeAccountId);
      if (!account || account.needsReauth || !Number.isFinite(account.credential.expires)
        || account.credential.expires <= Date.now()) return undefined;
      key = account.credential.access;
      if (routed.adapter === "devin") destination = validateDevinApiBaseUrl(account.credential.apiBaseUrl) ?? routed.baseUrl;
    }
    if (!key) return undefined;
    return createHash("sha256")
      .update(routed.adapter === "devin"
        ? JSON.stringify([key, resolveDevinApiBaseUrl(destination)])
        : key)
      .digest("hex");
  });
  for (const cached of cachedModels ?? []) ids.add(cached.id);
  for (const model of config?.customModels ?? []) {
    if (model.provider === provName && model.modelId) ids.add(model.modelId);
  }
  return [...ids];
}

/**
 * One notice per provider id: the destination is an operator-configured key
 * (never a caller-supplied string), so the log carries no request content.
 */
const compactionFallbackWarnings = new Set<string>();
function warnCompactionDefaultProviderFallbackOnce(providerName: string): void {
  if (compactionFallbackWarnings.has(providerName)) return;
  compactionFallbackWarnings.add(providerName);
  console.warn(
    `compaction: no enabled canonical "openai" provider for the native compaction model;`
    + ` summarizing through default provider "${providerName}" instead (#2901).`,
  );
}

/** Test seam: forget which compaction fallbacks have been announced. */
export function resetCompactionFallbackWarningsForTests(): void {
  compactionFallbackWarnings.clear();
}

// `routedProviderConfig` and its warning memo moved to `providers/routed-config.ts`: the
// request-time resolver needs no routing state, and `providers/api-key-selection.ts` importing
// it through this file created an import cycle (router -> quota -> api-keys -> api-key-selection).
export { reconcileRouterWarningMemos, routedProviderConfig } from "./providers/routed-config";

function activeProviderEntries(config: OcxConfig): [string, OcxProviderConfig][] {
  return Object.entries(config.providers)
    .filter(([name, provider]) => name !== LEGACY_CHATGPT_PROVIDER_ID && provider.disabled !== true);
}

export class NoEnabledOpenAiProviderError extends Error {
  constructor(modelId: string) {
    super(
      `Model ${modelId} requires the canonical openai provider. `
      + `Run: ocx provider add openai && ocx sync && ocx restart`,
    );
    this.name = "NoEnabledOpenAiProviderError";
  }
}

/**
 * One immutable selection trace for a combo request: built once from the
 * initial pick, before any child dispatch. Fallback execution stays in the
 * usage entry's `attempts[]`; the trace never changes after selection.
 */
export function comboRouteDecisionTrace(
  config: OcxConfig,
  comboId: string,
  pick: ComboPick,
  requestedModel: string,
): RouteDecisionTraceV1 {
  const combo = getCombo(config, comboId);
  return buildRouteDecisionTrace({
    requestedModel,
    routeKind: "combo",
    selected: {
      provider: pick.target.provider,
      model: pick.target.model,
      reason: "combo-pick",
      candidateIndex: pick.targetIndex,
      ...(combo
        ? { tieBreak: combo.strategy }
        : {}),
    },
    candidates: combo ? comboRouteCandidates(config, pick, combo) : undefined,
  });
}

// Codex uses a small number of control-plane model ids that are not part of the public GPT/o
// naming families. Keep this exact: a broad `codex-*` rule could capture a third-party model.
const CODEX_INTERNAL_OPENAI_MODELS = new Set(["codex-auto-review"]);
const MAX_BLOCKED_MODEL_REDIRECT_EDGES = 5;

interface BlockedModelRedirectState {
  visited: Set<string>;
  edges: number;
}

function crossProviderRedirectTarget(config: OcxConfig, providerName: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0) return undefined;
  const targetProvider = value.slice(0, slash);
  if (targetProvider === providerName || !hasOwnProvider(config.providers, targetProvider)) return undefined;
  const configured = config.providers[targetProvider];
  if (configured.disabled === true) return undefined;
  try {
    const effective = routedProviderConfig(targetProvider, configured);
    const registry = providerMatchesRegistryTransportWithStaticGuards(targetProvider, configured)
      ? PROVIDER_REGISTRY.find(entry => entry.id === targetProvider)
      : undefined;
    const authMode = effective.authMode ?? registry?.authKind ?? "key";
    if (authMode === "forward") return undefined; // The source caller bearer is stripped on a redirect.
    if (authMode === "oauth") {
      if (registry?.authKind !== "oauth") return undefined;
      const usable = peekAuthStore()[targetProvider]?.accounts.some(account =>
        account.paused !== true && account.needsReauth !== true
        && (account.credential.expires > Date.now()
          ? Boolean(account.credential.access.trim())
          : Boolean(account.credential.refresh.trim()))
      );
      return usable ? value : undefined;
    }
    return authMode === "local" || effective.keyOptional === true || Boolean(effective.apiKey?.trim())
      ? value : undefined;
  } catch {
    return undefined;
  }
}

function isBareOpenAiFamilyModel(modelId: string): boolean {
  return !modelId.includes("/")
    && (/^(?:gpt-|o1-|o3-|o4-)/.test(modelId) || CODEX_INTERNAL_OPENAI_MODELS.has(modelId));
}

function routeResult(
  config: OcxConfig | undefined,
  providerName: string,
  provider: OcxProviderConfig,
  modelId: string,
  routeKind: RouteDecisionKind,
  routeReason: string,
  redirectState: BlockedModelRedirectState,
): RouteResult {
  const qualified = resolveBlockedModelRedirect(config, `${providerName}/${modelId}`);
  const bare = resolveBlockedModelRedirect(config, modelId);
  const crossTarget = config && (
    crossProviderRedirectTarget(config, providerName, qualified)
    ?? crossProviderRedirectTarget(config, providerName, bare)
  );
  if (crossTarget && config) {
    if (routeKind === "explicit-account") {
      throw new Error("Blocked model redirect cannot leave a pinned account route");
    }
    const source = `${providerName}/${modelId}`;
    if (redirectState.visited.has(source)) {
      throw new Error(`Blocked model redirect cycle detected: ${source}`);
    }
    if (redirectState.edges >= MAX_BLOCKED_MODEL_REDIRECT_EDGES) {
      throw new Error(`Blocked model redirect exceeded maximum redirect depth (${MAX_BLOCKED_MODEL_REDIRECT_EDGES})`);
    }
    redirectState.visited.add(source);
    redirectState.edges += 1;
    const targetRoute = routeModelInternal(config, crossTarget, true, undefined, false, false, redirectState);
    return { ...targetRoute, routeReason: "blocked-model-redirect", credentialDomainRewrite: true };
  }
  // Existing bare mappings remain one post-resolution, same-provider substitution.
  const redirected = bare;
  const effectiveModelId = redirected ?? modelId;
  const effectiveRouteReason = redirected ? "blocked-model-redirect" : routeReason;
  const codexAccountMode = providerCodexAccountMode(providerName, provider);
  const routedProvider = routedProviderConfig(providerName, provider);
  const effectiveAlias = config
    ? effectiveProviderAliasDecision(providerName, provider, config)
    : undefined;
  return {
    providerName,
    provider: routedProvider,
    modelId: effectiveModelId,
    staticPolicy: captureRouteStaticPolicy(providerName, effectiveModelId, routedProvider, effectiveAlias),
    routeKind,
    routeReason: effectiveRouteReason,
    ...(codexAccountMode ? { codexAccountMode } : {}),
  };
}

/**
 * Candidate evidence for a combo route: every configured target with its
 * selection-time eligibility and exclusion reasons. Purely observational; the
 * pick already happened and this never re-selects.
 */
function comboRouteCandidates(
  config: OcxConfig,
  pick: NonNullable<RouteResult["combo"]>,
  combo: NormalizedComboConfig,
): TraceCandidateInput[] {
  const now = Date.now();
  return combo.targets.map((target, index) => {
    const key = targetKey(target);
    const provider = config.providers[target.provider];
    const configured = provider !== undefined;
    const enabled = configured && provider.disabled !== true;
    const inCooldown = isComboTargetInCooldown(pick.comboId, target, now);
    const isSelected = index === pick.targetIndex;
    // The pick's `attempted` list includes the winner itself; only non-selected
    // targets can be "already-attempted" (fallback picks exclude earlier tries).
    const alreadyAttempted = !isSelected && pick.attempted.includes(key);
    const exclusions: TraceCandidateInput["exclusions"] = [];
    if (!configured) exclusions.push({ code: "unconfigured" });
    if (configured && !enabled) exclusions.push({ code: "disabled" });
    if (inCooldown) exclusions.push({ code: "cooldown" });
    if (isSelected && inCooldown) exclusions.push({ code: "selected-despite-cooldown" });
    if (!isSelected && alreadyAttempted && exclusions.length === 0) {
      exclusions.push({ code: "already-attempted" });
    }
    if (!isSelected && exclusions.length === 0) exclusions.push({ code: "not-selected" });
    return {
      provider: target.provider,
      model: target.model,
      eligible: enabled && !inCooldown && !alreadyAttempted,
      exclusions,
    };
  });
}

function routeModelInternal(
  config: OcxConfig,
  modelId: string,
  bypassCombos: boolean,
  policyEvidence?: PolicyRequestEvidence,
  allowCompactionNativeFallback = false,
  preview = false,
  redirectState: BlockedModelRedirectState = { visited: new Set<string>(), edges: 0 },
): RouteResult {
  const slash = modelId.indexOf("/");
  // Policy namespace is system-reserved: an explicit `policy/<id>` or a
  // configured profile alias executes the policy evaluator and routes the
  // selected candidate. Only explicit requests reach this branch; concrete
  // recursive targets skip policy resolution entirely (bypassCombos) so an
  // alias matching a selected candidate can never recurse. Missing reserved
  // policy selectors fail before ordinary provider/default resolution.
  const policyId = !bypassCombos ? resolvePolicyProfileId(config, modelId) : null;
  const profile = policyId ? getRoutingProfile(config, policyId) : undefined;
  if (!bypassCombos && !profile && (policyId !== null || modelId.startsWith(`${POLICY_NAMESPACE}/`))) {
    throw new UnknownRoutingPolicyError(policyId ?? modelId.slice(POLICY_NAMESPACE.length + 1));
  }
  if (profile && policyId) {
    // One clock read per decision keeps candidate evidence, exclusions, and
    // scores mutually consistent and reproducible.
    const now = Date.now();
    const candidateEvidence = assemblePolicyCandidateEvidence(config, profile, now, {
      routedProviderConfig,
    });
    const evaluation = evaluatePolicyProfile(config, policyId, policyEvidence ?? {}, candidateEvidence, now);
    if (evaluation.selectedIndex === null) {
      throw new NoEligiblePolicyCandidateError(policyId, evaluation.trace);
    }
    const selected = evaluation.candidates[evaluation.selectedIndex]!;
    const concrete = `${selected.provider}/${selected.model}`;
    const routed = routeModelInternal(config, concrete, true, undefined, false, preview, redirectState);
    if (routed.routeReason === "blocked-model-redirect" && !evaluation.candidates.some(candidate =>
      candidate.provider === routed.providerName && candidate.model === routed.modelId && candidate.eligible
    )) {
      throw new NoEligiblePolicyCandidateError(policyId, evaluation.trace);
    }
    return {
      ...routed,
      routeKind: "policy" as const,
      routeReason: routed.routeReason === "blocked-model-redirect" ? "blocked-model-redirect" : "policy-selected",
      policyEligibility: new Set(evaluation.candidates
        .filter(candidate => candidate.eligible)
        .map(candidate => candidate.provider + "\u0000" + candidate.model)),
      routeDecision: {
        ...evaluation.trace,
        selected: {
          ...evaluation.trace.selected,
          provider: routed.providerName,
          model: routed.modelId,
          reason: routed.routeReason === "blocked-model-redirect" ? "blocked-model-redirect" : evaluation.trace.selected.reason,
        },
      },
    };
  }
  if (slash > 0) {
    const namespace = modelId.slice(0, slash);
    const binding = codexAccountNamespaceEntries(config)
      .find(([candidate]) => candidate === namespace);
    if (binding) {
      const nativeModelId = modelId.slice(slash + 1);
      if (!isBareOpenAiFamilyModel(nativeModelId)) {
        throw new Error(`Codex account namespace ${namespace} only supports native OpenAI model ids`);
      }
      const provider = config.providers[OPENAI_CODEX_PROVIDER_ID];
      if (!provider || provider.disabled === true) {
        throw new NoEnabledOpenAiProviderError(nativeModelId);
      }
      // Registry routing backfills an omitted authMode on the built-in OpenAI row to forward.
      // Mirror only that default here; explicit non-forward modes still fail closed.
      const providerForCanonicalCheck = provider.authMode === undefined
        ? { ...provider, authMode: "forward" as const }
        : provider;
      if (!isCanonicalOpenAiForwardProvider(providerForCanonicalCheck)) {
        throw new NoEnabledOpenAiProviderError(nativeModelId);
      }
      const accountQualified = resolveBlockedModelRedirect(config, modelId);
      if (crossProviderRedirectTarget(config, OPENAI_CODEX_PROVIDER_ID, accountQualified)) {
        throw new Error("Blocked model redirect cannot leave a pinned account route");
      }
      return {
        ...routeResult(config, OPENAI_CODEX_PROVIDER_ID, provider, nativeModelId, "explicit-account", "account-namespace", redirectState),
        // Exact account injection uses the pool credential machinery even when the canonical
        // provider is globally Direct. The fixed id bypasses pool selection entirely.
        codexAccountMode: "pool",
        codexAccountId: binding[1],
        codexAccountNamespace: namespace,
      };
    }
  }

  if (!bypassCombos && !preservesPhysicalComboProvider(config)) {
    const combo = tryPickComboModel(config, modelId, preview);
    if (combo) {
      const concrete = `${combo.target.provider}/${combo.target.model}`;
      // The selected target is already a concrete provider/model reference. Resolve it without
      // consulting combo aliases again, otherwise an alias that shadows the target can recurse.
      const routed = routeModelInternal(config, concrete, true, undefined, false, preview, redirectState);
      return { ...routed, combo, routeKind: "combo" as const, routeReason: routed.routeReason === "blocked-model-redirect" ? "blocked-model-redirect" : "combo-pick" };
    }
  }

  // 0. Explicit "<provider>/<model>" namespace (e.g. "opencode-go/deepseek-v4.1-flash").
  //    Only triggers when the prefix matches a CONFIGURED provider, so genuine
  //    slash-containing model ids (e.g. "anthropic/claude-...") fall through when
  //    no such provider exists.
  if (slash > 0) {
    const requestedProvider = modelId.slice(0, slash);
    const requestedLower = requestedProvider.toLowerCase();
    let provName: string | undefined;

    if (hasOwnProvider(config.providers, requestedProvider)) {
      provName = requestedProvider;
    } else {
      // Pass 1: explicit configured provider aliases (operator override always wins)
      const configuredMatches = Object.entries(config.providers).filter(([, provider]) =>
        typeof provider.alias === "string" && provider.alias.trim().toLowerCase() === requestedLower,
      );
      if (configuredMatches.length === 1) {
        provName = configuredMatches[0]![0];
      } else if (configuredMatches.length > 1) {
        throw new Error("provider alias '" + requestedProvider + "' is ambiguous: " + configuredMatches.map(([n]) => n).sort().join(", "));
      } else {
        // Pass 2: built-in registry aliases, only for providers that do NOT have an explicit alias override
        // and whose registry alias has not been claimed by another configured provider name or alias
        const registryMatches = Object.entries(config.providers).filter(([name, provider]) => {
          if (provider.alias !== undefined) return false;
          const regAlias = PROVIDER_REGISTRY.find(e => e.id === name)?.alias;
          if (!regAlias || regAlias.toLowerCase() !== requestedLower) return false;
          const claimedByOther = Object.entries(config.providers).some(([otherName, p]) =>
            otherName !== name && (
              otherName.toLowerCase() === requestedLower
              || (typeof p.alias === "string" && p.alias.trim().toLowerCase() === requestedLower)
            )
          );
          return !claimedByOther;
        });
        if (registryMatches.length === 1) {
          provName = registryMatches[0]![0];
        } else if (registryMatches.length > 1) {
          throw new Error("provider alias '" + requestedProvider + "' is ambiguous across registry fallbacks: " + registryMatches.map(([n]) => n).sort().join(", "));
        }
      }
    }
    if (!provName) {
      // A genuine slash-containing native model id still falls through unchanged.
    } else {
    if (provName === LEGACY_CHATGPT_PROVIDER_ID || provName === LEGACY_OPENAI_MULTI_PROVIDER_ID) {
      throw new Error(`No provider configured for model: ${modelId}`);
    }
    if (hasOwnProvider(config.providers, provName)) {
      const prov = config.providers[provName];
      if (prov.disabled === true) throw new Error(`Provider is disabled: ${provName}`);
      const known = knownModelIdsForProvider(provName, prov, config);
      // Self-namespaced native id — the vendor segment equals the provider id, so the FULL ref is
      // itself a known model (e.g. orcarouter/auto). Route it whole instead of stripping to the
      // remainder, which would send a bare `auto` the upstream cannot resolve.
      if (known.includes(modelId)) {
        return routeResult(config, provName, prov, modelId, "explicit-provider", "explicit-provider-namespace", redirectState);
      }
      // Codex-facing alias ids (`provider/vendor-model`) decode back to the native
      // slash id via an exact known-id lookup; raw full-slash selectors keep working.
      const requestedModel = modelId.slice(slash + 1);
      const decoded = decodeRoutedModelIdOrThrow(requestedModel, known);
      const nativeModel = known.includes(decoded)
        ? decoded
        : resolveModelAlias(config, prov, known, requestedModel) ?? decoded;
      return routeResult(
        config,
        provName,
        prov,
        nativeModel,
        "explicit-provider",
        "explicit-provider-namespace",
        redirectState,
      );
    }
    }
  }

  if (isBareOpenAiFamilyModel(modelId)) {
    const provider = config.providers[OPENAI_CODEX_PROVIDER_ID];
    if (provider && provider.disabled !== true) {
      return routeResult(config, OPENAI_CODEX_PROVIDER_ID, provider, modelId, "native", "native-family", redirectState);
    }
    // Codex chooses a bare native model for compaction even when the operator's
    // ordinary route is a third-party provider. Keep the native reservation
    // unchanged for ordinary turns; only the explicit compaction surface may
    // use the configured default as its summarizer destination.
    if (allowCompactionNativeFallback
      && config.defaultProvider !== OPENAI_CODEX_PROVIDER_ID
      && config.defaultProvider !== LEGACY_CHATGPT_PROVIDER_ID
      && config.defaultProvider !== LEGACY_OPENAI_MULTI_PROVIDER_ID
      && hasOwnProvider(config.providers, config.defaultProvider)) {
      const defaultProvider = config.providers[config.defaultProvider];
      if (defaultProvider.disabled !== true) {
        warnCompactionDefaultProviderFallbackOnce(config.defaultProvider);
        return routeResult(
          config,
          config.defaultProvider,
          defaultProvider,
          modelId,
          "default-provider",
          "compaction-default-provider",
          redirectState,
        );
      }
    }
    throw new NoEnabledOpenAiProviderError(modelId);
  }

  for (const [provName, prov] of activeProviderEntries(config)) {
    if (prov.defaultModel === modelId
      || (typeof prov.defaultModel === "string" && encodeRoutedModelId(prov.defaultModel) === modelId)) {
      return routeResult(config, provName, prov, prov.defaultModel as string, "explicit-provider", "configured-default-model", redirectState);
    }
  }

  const patternRoute = routeByKnownModelPattern(config, modelId, redirectState);
  if (patternRoute) return patternRoute;

  for (const [provName, prov] of activeProviderEntries(config)) {
    if (prov.models && Array.isArray(prov.models)) {
      const hit = (prov.models as string[]).find(id => id === modelId || encodeRoutedModelId(id) === modelId);
      if (hit !== undefined) {
        return routeResult(config, provName, prov, hit, "explicit-provider", "configured-model-list", redirectState);
      }
    }
  }

  const aliasMatches: Array<{ provider: string; model: string; qualified: string }> = [];
  for (const [provName, prov] of activeProviderEntries(config)) {
    const known = knownModelIdsForProvider(provName, prov, config);
    const native = resolveModelAlias(config, prov, known, modelId);
    if (native) aliasMatches.push({
      provider: provName,
      model: native,
      qualified: `${prov.alias || provName}/${modelId}`,
    });
  }
  if (aliasMatches.length > 1) {
    throw new Error(`model alias '${modelId}' is ambiguous: ${aliasMatches.map(match => match.qualified).sort().join(", ")}`);
  }
  if (aliasMatches[0]) {
    const match = aliasMatches[0];
    return routeResult(config, match.provider, config.providers[match.provider], match.model, "explicit-provider", "model-alias", redirectState);
  }

  if (config.defaultProvider === LEGACY_CHATGPT_PROVIDER_ID) {
    throw new Error(`No provider configured for model: ${modelId}`);
  }
  if (hasOwnProvider(config.providers, config.defaultProvider)) {
    const defaultProv = config.providers[config.defaultProvider];
    if (defaultProv.disabled === true) throw new Error(`Default provider is disabled: ${config.defaultProvider}`);
    return routeResult(config, config.defaultProvider, defaultProv, modelId, "default-provider", "default-provider", redirectState);
  }

  throw new Error(`No provider configured for model: ${modelId}`);
}

function routeWithDecisionTrace(config: OcxConfig, modelId: string, route: RouteResult): RouteResult {
  // Policy routes carry a full evaluation trace already; never rebuild it.
  if (route.routeDecision) return route;
  const accountRef = route.codexAccountNamespace;
  const combo = route.combo ? getCombo(config, route.combo.comboId) : undefined;
  route.routeDecision = buildRouteDecisionTrace({
    requestedModel: modelId,
    routeKind: route.routeKind,
    selected: {
      provider: route.providerName,
      model: route.modelId,
      ...(accountRef ? { accountRef } : {}),
      reason: route.routeReason,
      ...(route.combo ? { candidateIndex: route.combo.targetIndex } : {}),
      ...(combo
        ? { tieBreak: combo.strategy }
        : {}),
    },
    candidates: route.routeKind === "combo" && route.combo && combo
      ? comboRouteCandidates(config, route.combo, combo)
      : undefined,
  });
  return route;
}

export function routeModel(
  config: OcxConfig,
  modelId: string,
  policyEvidence?: PolicyRequestEvidence,
): RouteResult {
  const route = routeModelInternal(config, modelId, false, policyEvidence);
  return routeWithDecisionTrace(config, modelId, route);
}

/** Resolve a route for capability inspection without creating combo selection state. */
export function previewRouteModel(config: OcxConfig, modelId: string): RouteResult {
  return routeWithDecisionTrace(config, modelId, routeModelInternal(config, modelId, false, undefined, false, true));
}

/**
 * Route a client-selected compaction model. Codex may send a bare native model
 * even when its ordinary turns are configured for another provider; in that
 * one case the configured default provider is a safe summarizer destination.
 * This helper is intentionally separate so ordinary requests retain the
 * canonical OpenAI reservation and exact account selectors remain fail-closed.
 */
export function routeCompactionModel(
  config: OcxConfig,
  modelId: string,
  policyEvidence?: PolicyRequestEvidence,
): RouteResult {
  const route = routeModelInternal(config, modelId, false, policyEvidence, true);
  return routeWithDecisionTrace(config, modelId, route);
}

/** Resolve a combo-selected provider/model target without consulting public combo aliases again. */
export function routeConcreteModel(config: OcxConfig, modelId: string): RouteResult {
  return routeModelInternal(config, modelId, true, undefined);
}

function routeByKnownModelPattern(config: OcxConfig, modelId: string, redirectState: BlockedModelRedirectState): RouteResult | undefined {
  for (const { providerNames, prefixes } of MODEL_PROVIDER_PATTERNS) {
    if (prefixes.some(prefix => modelId.startsWith(prefix))) {
      const matchingProvider = Object.entries(config.providers).find(
        ([name, prov]) => prov.disabled !== true && providerNames.some(providerName => name === providerName || name.startsWith(`${providerName}-`))
      );
      if (matchingProvider) {
        const [provName, prov] = matchingProvider;
        return routeResult(config, provName, prov, modelId, "explicit-provider", "model-pattern", redirectState);
      }
      // Deliberately no "first provider with an Anthropic adapter" fallback here. Picking by
      // object insertion order, without checking `models`, `selectedModels`, `disabledModels` or
      // discovery state, silently moves a request onto a provider the operator never chose, with
      // its own privacy and billing consequences (#1697). A classifier turn that needs a specific
      // target gets it from operator-declared `claudeCode.classifierModel` / `classifierFallbacks`.
    }
  }
  return undefined;
}
