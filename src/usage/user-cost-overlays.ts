/**
 * Runtime registry for user-configured provider cost overlays
 * (`providers.<name>.modelCosts` in config.json — per-model prices in ocx's
 * flat `modelXxx` convention, mirroring opencode's per-model pricing).
 *
 * The usage cost estimator stays pure: it receives overlays as parameters and
 * defaults to this registry, which is refreshed at the config chokepoints
 * (loadConfig and every persist path). A refresh that actually changes the
 * rows replaces the active array with a NEW identity and bumps a version
 * counter, so the estimator's memo and the /api/usage summary cache skip stale
 * rows without cross-module invalidation. Refreshes with byte-identical rows
 * are no-ops: config is reloaded at many chokepoints and an unchanged reload
 * must not churn the version (see refreshUserCostOverlays). The configured
 * provider-name set is part of the change identity: adding or removing a
 * provider changes which names may collapse to a label base in the resolver,
 * so it bumps the version even when no overlay row changed.
 *
 * Display-time estimation only — these rows never affect billing.
 */
import type { OcxConfig, OcxProviderConfig, ProviderCostOverlay } from "../types";
import { MAX_COST4_RATE, type ExpectedPriceOverlay } from "./expected-prices";
import { redactSecretString } from "../lib/redact";

const EMPTY: readonly ExpectedPriceOverlay[] = [];

let active: readonly ExpectedPriceOverlay[] = EMPTY;
let activeSignature = "";
let activeConfigured = new Set<string>();
let version = 0;
let preservedDiskOnlyProviders: Record<string, OcxProviderConfig> | null = null;

/**
 * Preservation owner metadata rides through the shallow config projections in
 * config.ts via an enumerable SYMBOL key. JSON.stringify ignores symbol keys,
 * so the tag is process-local only and can never reach config.json or a DTO.
 */
const PRESERVATION_OWNER_STATE = Symbol("opencodex.user-cost-overlay-preservation-owner");
const PERSISTED_PROVIDER_DELETIONS = Symbol("opencodex.persisted-provider-deletions");

type PreservationOwnerState = {
  refs: number;
  config: OcxConfig;
  ownedProviders: Set<string>;
};

type PreservationTaggedConfig = OcxConfig & {
  [PRESERVATION_OWNER_STATE]?: PreservationOwnerState;
  [PERSISTED_PROVIDER_DELETIONS]?: readonly string[];
};

const preservationOwnerStates = new Set<PreservationOwnerState>();

function providerNames(config: OcxConfig): Set<string> {
  return new Set(Object.keys(config.providers ?? {}));
}

/** Register one active live-config owner. Multiple server leases may share one config object. */
export function registerPreservedProviderOwner(config: OcxConfig): void {
  const tagged = config as PreservationTaggedConfig;
  const existing = tagged[PRESERVATION_OWNER_STATE];
  if (existing && preservationOwnerStates.has(existing)) {
    existing.refs += 1;
    existing.ownedProviders = providerNames(config);
    return;
  }
  const state: PreservationOwnerState = {
    refs: 1,
    config,
    ownedProviders: providerNames(config),
  };
  // Enumerable is deliberate: projectCustomModelCatalogMigration and the live
  // binding guard use object spread, which must carry this process-local tag to
  // the serialization view. Symbol keys are still omitted by JSON.stringify.
  Object.defineProperty(tagged, PRESERVATION_OWNER_STATE, {
    value: state,
    enumerable: true,
    configurable: true,
  });
  preservationOwnerStates.add(state);
}

/**
 * Refresh a registered owner's provider snapshot from a successful disk read.
 *
 * A provider still present on disk remains owned even if the live object
 * temporarily omits it: management DELETE has an async-import gap between
 * mutating the live config and committing the write, and a reconciler tick in
 * that gap must not erase the deletion authority. Conversely, providers that
 * disappeared from disk are no longer considered owned, and newly present
 * providers are adopted only when this live config actually has the row.
 */
export function refreshPreservedProviderOwner(config: OcxConfig, disk: OcxConfig): void {
  const state = (config as PreservationTaggedConfig)[PRESERVATION_OWNER_STATE];
  if (!state || !preservationOwnerStates.has(state)) return;
  const diskNames = providerNames(disk);
  for (const name of [...state.ownedProviders]) {
    if (!diskNames.has(name)) state.ownedProviders.delete(name);
  }
  for (const name of Object.keys(config.providers ?? {})) {
    if (diskNames.has(name)) state.ownedProviders.add(name);
  }
}

/** Release one active live-config owner lease. */
export function unregisterPreservedProviderOwner(config: OcxConfig): void {
  const tagged = config as PreservationTaggedConfig;
  const state = tagged[PRESERVATION_OWNER_STATE];
  if (!state || !preservationOwnerStates.has(state)) return;
  state.refs -= 1;
  if (state.refs > 0) return;
  preservationOwnerStates.delete(state);
  if (tagged[PRESERVATION_OWNER_STATE] === state) {
    delete tagged[PRESERVATION_OWNER_STATE];
  }
}

/**
 * Remember provider rows that exist on disk but are intentionally absent from
 * the live routing config (added by an external editor after the proxy booted).
 * They are merged back at the config serialization boundary so an unrelated
 * in-process save cannot erase the external provider and its overlay.
 */
export function setPreservedDiskOnlyProviders(
  providers: Record<string, OcxProviderConfig> | null,
): void {
  preservedDiskOnlyProviders = providers;
}

/**
 * Commit an explicit provider deletion only after the persisted serialization
 * view has been accepted by the config write path. This clears the stale
 * preservation row and removes the provider from every active live projection,
 * so a second owner cannot resurrect it on a later unrelated save.
 */
function commitPersistedProviderDeletions(config: OcxConfig): void {
  const tagged = config as PreservationTaggedConfig;
  const deletions = tagged[PERSISTED_PROVIDER_DELETIONS];
  if (!deletions || deletions.length === 0) return;

  const deleted = new Set(deletions);
  if (preservedDiskOnlyProviders) {
    const next = { ...preservedDiskOnlyProviders };
    for (const name of deleted) delete next[name];
    preservedDiskOnlyProviders = Object.keys(next).length > 0 ? next : null;
  }

  for (const state of preservationOwnerStates) {
    for (const name of deleted) {
      state.ownedProviders.delete(name);
      if (state.config.providers) delete state.config.providers[name];
    }
  }
  delete tagged[PERSISTED_PROVIDER_DELETIONS];
}

/**
 * A serialization view of `config` that keeps externally added providers on
 * disk without adding them to live routing state. Live providers win when a
 * name exists in both maps.
 *
 * A registered owner also carries the provider names it previously owned. If
 * that owner now omits one of those providers, the omission is an intentional
 * in-process deletion rather than an old projection that never knew the row.
 * Suppress only those names from preservation for this write. The suppression
 * is committed globally only after refreshUserCostOverlays receives the
 * successfully persisted view, so a failed atomic write cannot destroy the
 * preservation safety net.
 */
export function withPreservedDiskOnlyProviders(config: OcxConfig): OcxConfig {
  const tagged = config as PreservationTaggedConfig;
  const owner = tagged[PRESERVATION_OWNER_STATE];
  const deletedProviders = owner && preservationOwnerStates.has(owner)
    ? [...owner.ownedProviders].filter(name => !Object.hasOwn(config.providers ?? {}, name))
    : [];
  const deletedSet = new Set(deletedProviders);

  let preserved: Record<string, OcxProviderConfig> | null = null;
  if (preservedDiskOnlyProviders) {
    const filtered = Object.entries(preservedDiskOnlyProviders)
      .filter(([name]) => !deletedSet.has(name));
    if (filtered.length > 0) preserved = Object.fromEntries(filtered);
  }

  let persisted: OcxConfig;
  if (preserved && Object.keys(preserved).length > 0) {
    persisted = {
      ...config,
      providers: {
        ...preserved,
        ...config.providers,
      },
    };
  } else if (deletedProviders.length > 0) {
    // Return a distinct object so the persisted-deletion marker remains scoped
    // to this serialization attempt rather than the long-lived live config.
    persisted = { ...config };
  } else {
    return config;
  }

  if (deletedProviders.length > 0) {
    Object.defineProperty(persisted as PreservationTaggedConfig, PERSISTED_PROVIDER_DELETIONS, {
      value: deletedProviders,
      enumerable: false,
      configurable: true,
    });
  }
  return persisted;
}

/** Test-only reset for the preserved disk-only provider registry. */
export function resetPreservedDiskOnlyProvidersForTests(): void {
  preservedDiskOnlyProviders = null;
  preservationOwnerStates.clear();
}

/** Exact four fields accepted for a user-configured cost tuple. */
export const COST4_RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** Shared per-rate predicate used by config validation, display sanitization, and runtime lifting. */
export function isValidCost4Rate(rate: unknown): rate is number {
  return typeof rate === "number"
    && Number.isFinite(rate)
    && rate >= 0
    && rate <= MAX_COST4_RATE;
}

/** True when `value` is a complete cost entry: all four rates are non-negative finite numbers. */
function validCost4(value: unknown): value is ProviderCostOverlay {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return COST4_RATE_KEYS.every(key => isValidCost4Rate(entry[key]));
}

/**
 * Rebuild the active user-overlay rows from the current config. Malformed rows
 * are skipped (config validation reports them separately); a provider with no
 * overlay contributes nothing.
 */
export function refreshUserCostOverlays(config: OcxConfig): void {
  // Only persisted serialization views carry PERSISTED_PROVIDER_DELETIONS.
  // Committing here means changed writes update owner state only after the
  // atomic write succeeds, while byte-identical successful saves also converge.
  commitPersistedProviderDeletions(config);

  const rows: ExpectedPriceOverlay[] = [];
  const providers = config.providers;
  if (providers) {
    for (const [providerName, provider] of Object.entries(providers)) {
      const costs = provider?.modelCosts;
      if (!costs || typeof costs !== "object" || Array.isArray(costs)) continue;
      for (const [modelId, cost4] of Object.entries(costs)) {
        if (!modelId.trim() || !validCost4(cost4)) continue;
        rows.push({
          provider: providerName,
          modelId,
          // Copy ONLY the four validated rate fields: a hand-edited row may
          // carry extra properties (e.g. a misplaced apiKey) that must never
          // reach display estimates or /api/logs through the registry.
          cost4: {
            input: cost4.input,
            output: cost4.output,
            cacheRead: cost4.cacheRead,
            cacheWrite: cost4.cacheWrite,
          },
          // Display provenance only: redact token-shaped provider/model ids so
          // the source string can never echo a pasted key. Matching still uses
          // the raw fields, and the change-detection signature below MUST keep
          // them raw — distinct ids would otherwise collapse to "[REDACTED]"
          // and skip the version bump.
          source: `config:providers.${redactSecretString(providerName)}.modelCosts[${redactSecretString(modelId)}]`,
          verifiedAt: "user-configured",
          status: "verified",
        });
      }
    }
  }
  // Config is re-loaded at many chokepoints (server start, migrations, persist
  // paths). Bumping the version on every load — even when nothing changed —
  // would invalidate the /api/usage summary cache on unrelated reloads and
  // churn the cost memo. Only a real overlay change bumps the version, so the
  // cache survives reloads of an unchanged config.
  // The signature MUST compare the raw matching fields: two different
  // secret-shaped ids would both redact to "[REDACTED]" and falsely look
  // unchanged, skipping the version bump and serving stale estimates. The
  // signature is process-local state and is never serialized to a response;
  // only the display `source` above is redacted.
  // The configured provider-name set is part of the identity too: adding or
  // removing a provider (even one without an overlay) changes which names are
  // allowed to collapse to a label base, so the resolver memo and the
  // /api/usage summary cache must be invalidated on that change as well.
  const configuredNames = Object.keys(providers ?? {}).sort();
  const signature = `${JSON.stringify(configuredNames)}\u0000${JSON.stringify(rows)}`;
  if (signature === activeSignature) return;
  activeSignature = signature;
  active = rows;
  activeConfigured = new Set(configuredNames);
  version++;
}

/** Active user-configured overlay rows (stable identity until the next refresh). */
export function activeUserCostOverlays(): readonly ExpectedPriceOverlay[] {
  return active;
}

/** Monotonic version bumped on every refresh; used by the estimator memo key. */
export function userCostOverlayVersion(): number {
  return version;
}

/** Configured provider names from the last refresh (pricing-namespace identity). */
export function activeConfiguredProviders(): ReadonlySet<string> {
  return activeConfigured;
}
