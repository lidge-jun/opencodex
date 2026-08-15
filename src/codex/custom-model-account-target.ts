import type { OcxConfig, OcxCustomModel, OcxProviderConfig } from "../types";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import { routedSlug } from "../providers/slug-codec";
import {
  isValidCodexAccountNamespaceTarget,
  MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET,
} from "./account-namespace-match";
import { isSelectableCodexPoolAccount, MAIN_CODEX_ACCOUNT_ID } from "./account-id";

export const CUSTOM_MODEL_CODEX_ACCOUNT_TARGET_GRAMMAR_ERROR =
  "codexAccountTarget must be @main or a valid Codex pool-account id";

export const CUSTOM_MODEL_CODEX_ACCOUNT_TARGET_PROVIDER_ERROR =
  "codexAccountTarget is supported only on the canonical openai Codex-forward provider";

export const CUSTOM_MODEL_CODEX_ACCOUNT_TARGET_ACCOUNT_ERROR =
  "codexAccountTarget must be @main or an existing Codex pool-account id";

function canonicalProviderForTargetCheck(
  providerName: string,
  provider: OcxProviderConfig | undefined,
): OcxProviderConfig | undefined {
  if (!provider) return undefined;
  return providerName === OPENAI_CODEX_PROVIDER_ID && provider.authMode === undefined
    ? { ...provider, authMode: "forward" }
    : provider;
}

/** Server-authoritative capability used by management clients before offering the selector. */
export function providerSupportsCustomModelCodexAccountTarget(
  providerName: string,
  provider: OcxProviderConfig | undefined,
): boolean {
  const canonical = canonicalProviderForTargetCheck(providerName, provider);
  return providerName === OPENAI_CODEX_PROVIDER_ID
    && canonical !== undefined
    && isCanonicalOpenAiForwardProvider(canonical);
}

/** Public config grammar. The internal `__main__` sentinel is deliberately not accepted. */
export function normalizeCustomModelCodexAccountTarget(target: unknown): string | undefined {
  if (!isValidCodexAccountNamespaceTarget(target)) return undefined;
  return target === MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET ? MAIN_CODEX_ACCOUNT_ID : target;
}

export function customModelCodexAccountTargetError(
  providerName: string,
  provider: OcxProviderConfig | undefined,
  target: unknown,
): string | undefined {
  if (normalizeCustomModelCodexAccountTarget(target) === undefined) {
    return CUSTOM_MODEL_CODEX_ACCOUNT_TARGET_GRAMMAR_ERROR;
  }
  if (!providerSupportsCustomModelCodexAccountTarget(providerName, provider)) {
    return CUSTOM_MODEL_CODEX_ACCOUNT_TARGET_PROVIDER_ERROR;
  }
  return undefined;
}

/**
 * Validate a newly assigned target. Retained orphan bindings remain editable when the exact
 * stored value is resubmitted, but a new typo/fabricated Pool id must not create an invisible row.
 */
export function customModelCodexAccountTargetAssignmentError(
  config: Pick<OcxConfig, "providers" | "codexAccounts">,
  providerName: string,
  target: unknown,
  previousTarget?: string,
): string | undefined {
  const structuralError = customModelCodexAccountTargetError(
    providerName,
    config.providers[providerName],
    target,
  );
  if (structuralError) return structuralError;
  if (target === previousTarget) return undefined;
  const accountId = normalizeCustomModelCodexAccountTarget(target);
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return undefined;
  return (config.codexAccounts ?? []).some(account => (
    isSelectableCodexPoolAccount(account) && account.id === accountId
  ))
    ? undefined
    : CUSTOM_MODEL_CODEX_ACCOUNT_TARGET_ACCOUNT_ERROR;
}

function matchingCustomModels(
  config: Pick<OcxConfig, "customModels">,
  providerName: string,
  modelId: string,
): OcxCustomModel[] {
  const requestedSlug = routedSlug(providerName, modelId);
  return (config.customModels ?? []).filter(model => (
    routedSlug(model.provider, model.modelId) === requestedSlug
  ));
}

function ambiguousCustomModelAccountBindingError(): Error {
  return new Error("Ambiguous custom model account binding: duplicate custom model rows disagree");
}

/**
 * Resolve one explicit custom-row binding through the same fixed-account machinery used by
 * account-qualified selectors. A malformed hand edit fails closed instead of degrading to Pool.
 */
export function customModelCodexAccountIdForRoute(
  config: Pick<OcxConfig, "customModels" | "providers">,
  providerName: string,
  modelId: string,
): string | undefined {
  const matches = matchingCustomModels(config, providerName, modelId);
  const targeted = matches.filter(model => model.codexAccountTarget !== undefined);
  if (targeted.length === 0) return undefined;
  if (targeted.length !== matches.length) throw ambiguousCustomModelAccountBindingError();

  let resolvedAccountId: string | undefined;
  for (const model of targeted) {
    const error = customModelCodexAccountTargetError(
      providerName,
      config.providers[providerName],
      model.codexAccountTarget,
    );
    if (error) throw new Error(`Invalid custom model account binding: ${error}`);
    const accountId = normalizeCustomModelCodexAccountTarget(model.codexAccountTarget);
    if (resolvedAccountId !== undefined && accountId !== resolvedAccountId) {
      throw ambiguousCustomModelAccountBindingError();
    }
    resolvedAccountId = accountId;
  }
  return resolvedAccountId;
}

/** Whether a target-bound custom row is discoverable with the current structural accounts. */
export function customModelCodexAccountTargetAvailable(
  config: Pick<OcxConfig, "codexAccounts" | "customModels" | "providers">,
  model: OcxCustomModel,
): boolean {
  let accountId: string | undefined;
  try {
    accountId = customModelCodexAccountIdForRoute(config, model.provider, model.modelId);
  } catch {
    return false;
  }
  if (accountId === undefined) return true;
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return true;
  return (config.codexAccounts ?? []).some(account => (
    isSelectableCodexPoolAccount(account) && account.id === accountId
  ));
}

/**
 * Remove routed rows whose backing custom override cannot currently route.
 *
 * Management pickers deliberately need a broader set than `filterCatalogVisibleModels`: rows
 * disabled at the model level and currently-unselected rows must stay available for repair and
 * allowlist editing. Provider-disabled rows and structurally unavailable exact-account targets,
 * however, cannot execute and must not be offered as new active choices.
 */
export function filterModelsByCustomRouteAvailability<
  T extends { provider: string; id: string },
>(
  models: readonly T[],
  config: Pick<OcxConfig, "codexAccounts" | "customModels" | "providers">,
): T[] {
  const unavailableSlugs = new Set(
    (config.customModels ?? [])
      .filter(model => (
        config.providers[model.provider]?.disabled === true
        || !config.providers[model.provider]
        || !customModelCodexAccountTargetAvailable(config, model)
      ))
      .map(model => routedSlug(model.provider, model.modelId)),
  );
  return models.filter(model => (
    config.providers[model.provider]?.disabled !== true
    && !unavailableSlugs.has(routedSlug(model.provider, model.id))
  ));
}

/** Used by account add/delete convergence without exposing a selector or private account id. */
export function hasCustomModelCodexAccountTarget(
  config: Pick<OcxConfig, "customModels">,
  accountId: string,
): boolean {
  return (config.customModels ?? []).some(model => (
    normalizeCustomModelCodexAccountTarget(model.codexAccountTarget) === accountId
  ));
}
