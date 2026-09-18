import { redactSecretString } from "../../lib/redact";
import type { OcxConfig } from "../../types";
import { encodeRoutedModelId } from "../../providers/slug-codec";
import { canonicalAutoReviewModelKey, isValidAutoReviewModel as isValidAutoReviewTarget } from "../../config/provider-validation";
import { readConfiguredAutoReviewModel } from "./parsing";
import type { RawEntry } from "./parsing";
import { configuredCatalogEntry } from "./subagent-roster";

const AUTO_REVIEW_ROOT_MARKER = "opencodex_auto_review_root";

interface RootAutoReviewStamp {
  slug: string;
  original: string | null;
  applied: string;
}

function rootAutoReviewStamp(entry: RawEntry): RootAutoReviewStamp | undefined {
  const value = entry[AUTO_REVIEW_ROOT_MARKER];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const stamp = value as Record<string, unknown>;
  if (stamp.slug !== entry.slug || typeof stamp.slug !== "string"
    || typeof stamp.applied !== "string"
    || (stamp.original !== null && typeof stamp.original !== "string")) return undefined;
  return stamp as unknown as RootAutoReviewStamp;
}


/** True when the value is a valid Codex catalog auto-review selector. */
export function isValidAutoReviewModel(value: unknown): value is string {
  return isValidAutoReviewTarget(value);
}

export type AutoReviewModelOverrideResult = "absent" | "applied" | "invalid" | "unresolved";

/** True when a catalog row was synthesized by opencodex instead of coming from upstream. */
function isRoutedCatalogEntry(entry: RawEntry): boolean {
  const slug = typeof entry.slug === "string" ? entry.slug : "";
  return slug.includes("/")
    || (typeof entry.description === "string" && entry.description.startsWith("Routed via opencodex → "));
}

/** Restore an owned native value, retaining provenance to avoid legacy reclassification. */
function clearAutoReviewOverrideValue(entry: RawEntry): void {
  const stamp = rootAutoReviewStamp(entry);
  if (stamp) {
    if (entry.auto_review_model_override === stamp.applied) entry.auto_review_model_override = stamp.original;
  } else {
    entry.auto_review_model_override = null;
    delete entry[AUTO_REVIEW_ROOT_MARKER];
  }
}

/**
 * Legacy whole-catalog root stamp: releases before AUTO_REVIEW_ROOT_MARKER wrote root stamps that
 * are textually identical to an upstream value, so the only way to recognize one is the uniform
 * signature the no-provider path relies on — a single value that a routed row also carries.
 * Returns the stamped values when the observed rows match that shape.
 */
function legacyRootStampValues(observedModels: readonly RawEntry[]): ReadonlySet<string> | undefined {
  if (observedModels.some(entry => entry?.[AUTO_REVIEW_ROOT_MARKER] !== undefined)) return undefined;
  const configuredValues = new Set(observedModels.flatMap(entry => {
    const value = entry?.auto_review_model_override;
    return typeof value === "string" && value.trim() ? [value] : [];
  }));
  const globalStamp = configuredValues.size === 1
    && observedModels.some(entry => {
      const value = entry.auto_review_model_override;
      return isRoutedCatalogEntry(entry)
        && typeof value === "string"
        && value.trim().length > 0
        && configuredValues.has(value);
    })
    && observedModels.every(entry => {
      const value = entry?.auto_review_model_override;
      return value === null
        || value === undefined
        || (typeof value === "string" && configuredValues.has(value));
    });
  return globalStamp ? configuredValues : undefined;
}

/**
 * Sweep legacy root stamps off the rows a root removal owns, before provider plans land.
 *
 * Root removal reaches marker-tagged native rows on its own, but a catalog written before the
 * marker only carries the legacy signature — and provider stamping rewrites that signature before
 * the root pass could read it, so the sweep has to run first.
 */
function clearLegacyRootStamps(models: readonly RawEntry[], sourceModels: readonly RawEntry[] = []): void {
  const legacyStamp = legacyRootStampValues([...models, ...sourceModels]);
  if (legacyStamp === undefined) return;
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const current = entry.auto_review_model_override;
    if (entry[AUTO_REVIEW_ROOT_MARKER] === undefined
      && typeof current === "string" && legacyStamp.has(current)) clearAutoReviewOverrideValue(entry);
  }
}

/**
 * Clear the root selector from every row this path owns: routed rows, rows stamped by a release
 * that writes the provenance marker, and the legacy whole-catalog stamp that predates it.
 */
function clearAutoReviewModelOverride(
  models: readonly RawEntry[],
  sourceModels: readonly RawEntry[] = [],
): void {
  const legacyStamp = legacyRootStampValues([...models, ...sourceModels]);
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const current = entry.auto_review_model_override;
    if (isRoutedCatalogEntry(entry)
      || (entry[AUTO_REVIEW_ROOT_MARKER] === true || rootAutoReviewStamp(entry) !== undefined)
      || (legacyStamp !== undefined && typeof current === "string" && legacyStamp.has(current))) {
      clearAutoReviewOverrideValue(entry);
    }
  }
}

/** Warn once about a malformed or unresolvable root auto-review selector. */
function warnAutoReviewModelDiagnostic(
  reason: "invalid" | "unresolved",
  configured: string,
): void {
  const safeConfigured = JSON.stringify(redactSecretString(configured));
  const detail = reason === "unresolved"
    ? "the selector was not found in the final catalog"
    : "the selector format is invalid";
  console.warn(
    `[opencodex] auto_review_model ${detail} (${safeConfigured}); preserving normal upstream auto-review behavior.`,
  );
}

/** Warn once about a malformed or unresolvable provider-scoped auto-review selector. */
function warnProviderAutoReviewModelDiagnostic(
  reason: "invalid" | "unresolved",
  provider: string,
  configured: string,
): void {
  const safeProvider = JSON.stringify(redactSecretString(provider));
  const safeConfigured = JSON.stringify(redactSecretString(configured));
  const detail = reason === "unresolved"
    ? "the selector was not found in the final catalog"
    : "the selector format is invalid";
  console.warn(
    `[opencodex] auto_review_model for provider ${safeProvider} ${detail} (${safeConfigured}); using the next valid provider/root selector or upstream behavior.`,
  );
}

/**
 * Note once when a bare selector resolves to a row outside the provider it was configured on.
 *
 * That is how a native model is named as a reviewer, so it stays usable, but a mistyped target must
 * not be silent: the operator sees which catalog row actually supplies the reviewer.
 */
function warnProviderAutoReviewForeignTarget(provider: string, configured: string, target: string): void {
  const safeProvider = JSON.stringify(redactSecretString(provider));
  const safeConfigured = JSON.stringify(redactSecretString(configured));
  const safeTarget = JSON.stringify(redactSecretString(target));
  console.warn(
    `[opencodex] auto_review_model for provider ${safeProvider} (${safeConfigured}) resolved to ${safeTarget}, which is not a row of that provider; that catalog row supplies the reviewer.`,
  );
}

/** Preserve native upstream overrides and the root-derived provenance marker from source rows. */
function preserveNativeAutoReviewModelOverrides(
  models: readonly RawEntry[],
  sourceModels: readonly RawEntry[],
): void {
  const existing = new Map<string, { value: string | null; root: true | RootAutoReviewStamp | undefined }>();
  for (const entry of sourceModels) {
    const slug = typeof entry.slug === "string" ? entry.slug : undefined;
    const value = entry.auto_review_model_override;
    if (!slug || isRoutedCatalogEntry(entry)) continue;
    if (typeof value === "string" || value === null) {
      existing.set(slug, { value, root: rootAutoReviewStamp(entry) ?? (entry[AUTO_REVIEW_ROOT_MARKER] === true ? true : undefined) });
    }
  }
  for (const entry of models) {
    const slug = typeof entry.slug === "string" ? entry.slug : undefined;
    if (!slug || isRoutedCatalogEntry(entry) || !existing.has(slug)) continue;
    const saved = existing.get(slug)!;
    entry.auto_review_model_override = saved.value;
    if (saved.root) entry[AUTO_REVIEW_ROOT_MARKER] = structuredClone(saved.root);
    else delete entry[AUTO_REVIEW_ROOT_MARKER];
  }
}

/** Stamp a root-derived override and mark native rows so later root removal is durable. */
function stampRootAutoReviewOverride(entry: RawEntry, target: string): void {
  if (!isRoutedCatalogEntry(entry)) {
    const previous = rootAutoReviewStamp(entry);
    const current = entry.auto_review_model_override;
    entry[AUTO_REVIEW_ROOT_MARKER] = {
      slug: typeof entry.slug === "string" ? entry.slug : "",
      original: previous && current === previous.applied
        ? previous.original : typeof current === "string" ? current : null,
      applied: target,
    } satisfies RootAutoReviewStamp;
  } else {
    delete entry[AUTO_REVIEW_ROOT_MARKER];
  }
  entry.auto_review_model_override = target;
}

/** Stamp a provider-derived override; provider stamps never fall under root removal. */
function stampProviderAutoReviewOverride(entry: RawEntry, target: string): void {
  entry.auto_review_model_override = target;
  delete entry[AUTO_REVIEW_ROOT_MARKER];
}

/**
 * Apply the root Codex auto-review selector to every catalog row, or clear it when the value is
 * absent, blank, malformed, or does not resolve against the assembled catalog.
 */
export function applyAutoReviewModelOverride(
  models: RawEntry[] | undefined,
  autoReviewModel: string | null | undefined,
  sourceModels: readonly RawEntry[] = [],
): AutoReviewModelOverrideResult {
  if (!models || !Array.isArray(models)) return "absent";
  if (autoReviewModel === null || autoReviewModel === undefined) {
    clearAutoReviewModelOverride(models, sourceModels);
    return "absent";
  }
  const trimmed = autoReviewModel.trim();
  if (!trimmed) {
    clearAutoReviewModelOverride(models, sourceModels);
    return "absent";
  }
  if (!isValidAutoReviewModel(trimmed)) {
    clearAutoReviewModelOverride(models, sourceModels);
    warnAutoReviewModelDiagnostic("invalid", trimmed);
    return "invalid";
  }
  if (!configuredCatalogEntry(models, trimmed)) {
    clearAutoReviewModelOverride(models, sourceModels);
    warnAutoReviewModelDiagnostic("unresolved", trimmed);
    return "unresolved";
  }
  for (const entry of models) {
    if (entry && typeof entry === "object") {
      stampRootAutoReviewOverride(entry, trimmed);
    }
  }
  return "applied";
}

/** Validated provider-scoped target with both the configured spelling and catalog slug. */
interface ValidProviderReviewTarget {
  configured: string;
  target: string;
}

/** One provider's resolved provider-wide and per-model auto-review targets. */
interface ProviderReviewPlan {
  wide?: ValidProviderReviewTarget;
  perModel: Map<string, ValidProviderReviewTarget>;
}

/** Public provider namespace of a routed catalog row, when it has one. */
function catalogEntryProviderName(entry: RawEntry): string | undefined {
  const slug = typeof entry.slug === "string" ? entry.slug : "";
  const slash = slug.indexOf("/");
  return slash > 0 && isRoutedCatalogEntry(entry) ? slug.slice(0, slash) : undefined;
}

/** Encoded model-id segment of a routed catalog row, when it has one. */
function catalogEntryModelSegment(entry: RawEntry): string | undefined {
  const slug = typeof entry.slug === "string" ? entry.slug : "";
  const slash = slug.indexOf("/");
  return slash > 0 ? slug.slice(slash + 1) : undefined;
}

/** Case-preserving encoded key used to match per-model override maps. */
function providerModelKey(modelId: string): string {
  return canonicalAutoReviewModelKey(modelId);
}

/**
 * True when another routed row of this provider already carries `alias` as its own model id.
 *
 * The alias API validates against whatever ids discovery has reported so far, so on a cold start an
 * alias can be persisted that later turns out to name a different row. A key using it is then not
 * an alternate spelling of the aliased model — it is that row's id — and must not be propagated.
 */
function aliasNamesAnotherRoutedRow(models: readonly RawEntry[], provider: string, alias: string): boolean {
  const encoded = encodeRoutedModelId(alias);
  return models.some(entry => isRoutedCatalogEntry(entry)
    && catalogEntryProviderName(entry) === provider
    && catalogEntryModelSegment(entry) === encoded);
}

/** Resolve one configured target against the assembled catalog; bare values name a model of the same provider. */
function resolveProviderReviewTarget(
  models: readonly RawEntry[],
  provider: string,
  configuredRaw: unknown,
): { kind: "valid"; value: ValidProviderReviewTarget; foreign?: boolean } | { kind: "invalid"; configured: string } | { kind: "unresolved"; configured: string } | { kind: "absent" } {
  if (typeof configuredRaw !== "string") return { kind: "absent" };
  const configured = configuredRaw.trim();
  if (!configured) return { kind: "absent" };
  if (!isValidAutoReviewModel(configured)) return { kind: "invalid", configured };
  const prefix = `${provider}/`;
  let match: RawEntry | undefined;
  const sameProviderCandidate = (rawModelId: string): RawEntry | undefined => models.find(entry => {
    if (!isRoutedCatalogEntry(entry) || typeof entry.slug !== "string" || !entry.slug.startsWith(prefix)) return false;
    const segment = catalogEntryModelSegment(entry);
    return segment !== undefined && segment === encodeRoutedModelId(rawModelId);
  });
  // A bare selector names a model of this provider. A full selector that resolves in the
  // assembled catalog already names the exact row, including a same-provider encoded slug.
  if (!configured.includes("/")) {
    match = sameProviderCandidate(configured);
  }
  match ??= configuredCatalogEntry(models, configured);
  if (!match && configured.startsWith(prefix)) {
    match = sameProviderCandidate(configured.slice(prefix.length));
  }
  if (!match) {
    // A raw model id may itself contain "/" (for example zenmux moonshotai/kimi-k3).
    // After the full-selector lookup misses, try that spelling as a same-provider id.
    match = sameProviderCandidate(configured);
  }
  if (!match) return { kind: "unresolved", configured };
  const target = typeof match.slug === "string" ? match.slug : configured;
  // A qualified selector may name another provider's row on purpose; only a bare value that lands
  // outside this provider is worth reporting.
  const foreign = !configured.includes("/") && catalogEntryProviderName(match) !== provider;
  return { kind: "valid", value: { configured, target }, ...(foreign ? { foreign: true } : {}) };
}

/** Build resolved per-provider plans and emit one diagnostic per bad selector. */
function buildProviderReviewPlans(
  models: readonly RawEntry[],
  config: Pick<OcxConfig, "providers">,
): { plans: Map<string, ProviderReviewPlan>; failure?: "invalid" | "unresolved" } {
  const plans = new Map<string, ProviderReviewPlan>();
  let failure: "invalid" | "unresolved" | undefined;
  const warned = new Set<string>();
  const recordFailure = (kind: "invalid" | "unresolved", provider: string, configured: string): void => {
    const signature = `${provider}\u0000${configured}`;
    if (warned.has(signature)) return;
    warned.add(signature);
    warnProviderAutoReviewModelDiagnostic(kind, provider, configured);
    failure ??= kind;
  };
  const recordForeignTarget = (provider: string, configured: string, target: string): void => {
    const signature = `${provider}\u0000foreign\u0000${configured}`;
    if (warned.has(signature)) return;
    warned.add(signature);
    warnProviderAutoReviewForeignTarget(provider, configured, target);
  };
  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    if (provider.autoReviewModel === undefined && provider.autoReviewModelOverrides === undefined) continue;
    const plan: ProviderReviewPlan = { perModel: new Map() };
    if (provider.autoReviewModel !== undefined) {
      const resolved = resolveProviderReviewTarget(models, name, provider.autoReviewModel);
      if (resolved.kind === "valid") {
        plan.wide = resolved.value;
        if (resolved.foreign) recordForeignTarget(name, resolved.value.configured, resolved.value.target);
      }
      else if (resolved.kind !== "absent") recordFailure(resolved.kind, name, resolved.configured);
    }
    if (provider.autoReviewModelOverrides !== undefined) {
      for (const [modelId, rawTarget] of Object.entries(provider.autoReviewModelOverrides)) {
        const resolved = resolveProviderReviewTarget(models, name, rawTarget);
        if (resolved.kind === "valid") {
          plan.perModel.set(providerModelKey(modelId), resolved.value);
          if (resolved.foreign) recordForeignTarget(name, resolved.value.configured, resolved.value.target);
        } else if (resolved.kind !== "absent") {
          recordFailure(resolved.kind, name, resolved.configured);
        }
      }
    }
    // `modelAliases` publishes a second public name for a model id, and a routed row's slug always
    // carries the upstream id — so accept an override key written in either spelling.
    for (const [modelId, alias] of Object.entries(provider.modelAliases ?? {})) {
      if (typeof alias !== "string" || !alias.trim()) continue;
      if (aliasNamesAnotherRoutedRow(models, name, alias)) continue;
      const idKey = providerModelKey(modelId);
      const aliasKey = providerModelKey(alias);
      if (idKey === aliasKey) continue;
      const fromId = plan.perModel.get(idKey);
      const fromAlias = plan.perModel.get(aliasKey);
      if (fromId !== undefined && fromAlias === undefined) plan.perModel.set(aliasKey, fromId);
      else if (fromAlias !== undefined && fromId === undefined) plan.perModel.set(idKey, fromAlias);
    }
    if (plan.wide !== undefined || plan.perModel.size > 0) plans.set(name, plan);
  }
  return { plans, failure };
}

/** Apply or clear the root selector only on rows without a provider stamp. */
function applyRootSelectorToRemaining(
  models: readonly RawEntry[],
  rootValue: string | null | undefined,
  providerStamped: ReadonlySet<RawEntry>,
): AutoReviewModelOverrideResult {
  const clearRemaining = (): void => {
    for (const entry of models) {
      if (!entry || providerStamped.has(entry)) continue;
      // Native rows written by releases before the root marker cannot be told apart from upstream
      // values once provider stamps diverge. clearLegacyRootStamps sweeps the ones the legacy
      // uniform signature still recognizes before provider plans land, because provider stamping
      // destroys that signature; a catalog that no longer matches it needs a one-off manual sync.
      if (isRoutedCatalogEntry(entry) || entry[AUTO_REVIEW_ROOT_MARKER] === true || rootAutoReviewStamp(entry)) clearAutoReviewOverrideValue(entry);
    }
  };
  if (rootValue === null || rootValue === undefined) {
    clearRemaining();
    return "absent";
  }
  const trimmed = rootValue.trim();
  if (!trimmed) {
    clearRemaining();
    return "absent";
  }
  if (!isValidAutoReviewModel(trimmed)) {
    clearRemaining();
    warnAutoReviewModelDiagnostic("invalid", trimmed);
    return "invalid";
  }
  if (!configuredCatalogEntry(models, trimmed)) {
    clearRemaining();
    warnAutoReviewModelDiagnostic("unresolved", trimmed);
    return "unresolved";
  }
  for (const entry of models) {
    if (!entry || providerStamped.has(entry)) continue;
    stampRootAutoReviewOverride(entry, trimmed);
  }
  return "applied";
}

/** Provider-aware variant: provider rows win and the root selector is the fallback. */
export function applyConfiguredAutoReviewModelOverride(
  models: RawEntry[] | undefined,
  rootAutoReviewModel: string | null | undefined,
  config: Pick<OcxConfig, "providers">,
  sourceModels: readonly RawEntry[] = [],
): AutoReviewModelOverrideResult {
  if (!models || !Array.isArray(models)) return "absent";
  // Runs unconditionally because the sweep only fires on the uniform legacy signature. A resolved
  // root selector restamps every row it touches below, so the call is behavior-preserving there;
  // with the root absent, invalid, or unresolved those clears are final — which is the point, and
  // also the limit: the legacy heuristic cannot tell a root stamp from an identical upstream value.
  clearLegacyRootStamps(models, sourceModels);
  const { plans, failure } = buildProviderReviewPlans(models, config);
  const providerStamped = new Set<RawEntry>();
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const provider = catalogEntryProviderName(entry);
    if (!provider) continue;
    const plan = plans.get(provider);
    if (!plan) continue;
    const modelSegment = catalogEntryModelSegment(entry);
    const perModel = modelSegment === undefined ? undefined : plan.perModel.get(providerModelKey(modelSegment));
    const selected = perModel ?? plan.wide;
    if (!selected) continue;
    stampProviderAutoReviewOverride(entry, selected.target);
    providerStamped.add(entry);
  }
  const rootResult = applyRootSelectorToRemaining(models, rootAutoReviewModel, providerStamped);
  const providerApplied = [...providerStamped].some(entry => typeof entry.auto_review_model_override === "string");
  if (providerApplied) {
    if (rootResult === "invalid" || rootResult === "unresolved") return rootResult;
    return failure ?? "applied";
  }
  return failure ?? rootResult;
}

/** True when any provider row configures a provider-scoped auto-review selector. */
function configHasProviderAutoReview(config: Pick<OcxConfig, "providers">): boolean {
  return Object.values(config.providers ?? {}).some(provider =>
    provider.autoReviewModel !== undefined || provider.autoReviewModelOverrides !== undefined);
}

/** Apply the root Codex auto-review selector after the final catalog merge. */
export function finalizeAutoReviewModelOverride(
  models: RawEntry[] | undefined,
  sourceModels: readonly RawEntry[] = [],
  config?: Pick<OcxConfig, "providers">,
): AutoReviewModelOverrideResult {
  if (models && sourceModels.length > 0) preserveNativeAutoReviewModelOverrides(models, sourceModels);
  if (config && configHasProviderAutoReview(config)) {
    return applyConfiguredAutoReviewModelOverride(models, readConfiguredAutoReviewModel(), config, sourceModels);
  }
  return applyAutoReviewModelOverride(models, readConfiguredAutoReviewModel(), sourceModels);
}
/**
 * Why an account-gated native model stopped being offered, but only when the answer is one the
 * operator can act on.
 *
 * Suppression is an omission: the row is never built, so there is no catalog entry for a reason
 * to ride on and no downstream consumer that could explain it later. #4212's reporter watched
 * their models disappear and reasonably concluded the proxy was broken, because every surface
 * that changed said nothing about the account that caused it.
 *
 * Returns `undefined` for the ordinary case — an account that is simply not entitled to a gated
 * model. That is the default state for most installations, it is not news, and warning about it
 * on every sync would bury the one case that matters. A credential the operator must repair is
 * the case that matters, so that is the only one this speaks up about.
 *
 * Accounts are named with the durable `p`-prefixed log label, the same identifier the dashboard
 * shows, never the raw pool id or the email.
 */
