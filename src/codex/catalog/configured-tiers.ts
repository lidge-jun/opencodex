import { COMBO_NAMESPACE } from "../../combos";
import type { OcxProviderConfig } from "../../types";
import { decodeRoutedModelId } from "../../providers/slug-codec";
import { fastPolicyForModel } from "../../providers/service-tier";
import type { ResolvedFastPolicy } from "../../providers/fastwire";
import { catalogModelSlug, type CatalogModel, type RawEntry } from "./parsing";
import { preserveOperatorUltraFastTiers } from "./operator-tiers";

const MANAGED_ULTRAFAST = "opencodex_managed_ultrafast";

/** Advertise Flex only when the final route can forward the caller's exact flex tier. */
export function supportsConfiguredFlex(policy: ResolvedFastPolicy | undefined): boolean {
  return policy?.eligibility === "eligible"
    && policy.fastWire?.kind === "service-tier"
    && policy.fastWire.canonicalToWire.flex === "flex"
    && policy.forwardCallerTier;
}

/** Advertise Ultra Fast only when the eligible final wire explicitly maps that exact tier. */
export function supportsConfiguredUltraFast(policy: ResolvedFastPolicy | undefined): boolean {
  return policy?.eligibility === "eligible"
    && policy.fastWire?.kind === "service-tier"
    && policy.fastWire.canonicalToWire.ultrafast === "ultrafast";
}

/** Carry captured capability to catalog projection without treating persisted metadata as authority. */
export function configuredUltraFastSlugs(models: readonly CatalogModel[]): ReadonlySet<string> {
  const declarations = new Map<string, boolean>();
  for (const model of models) {
    const slug = catalogModelSlug(model);
    const supported = model.provider !== COMBO_NAMESPACE && model.nativeAlias !== true
      && model.supportsServiceTier === true && model.supportsUltraFastTier === true;
    // A conflicting duplicate cannot lend its capability to the surviving row.
    declarations.set(slug, supported && declarations.get(slug) !== false);
  }
  return new Set([...declarations].filter(([, supported]) => supported).map(([slug]) => slug));
}

/** Apply current configuration, or retain an independently supplied exact-row operator tier. */
export function applyConfiguredUltraFast(
  entry: RawEntry,
  previous: RawEntry | undefined,
  configured: boolean,
  retainOperatorTier: boolean,
): void {
  // This marker only rejects stale generated metadata; it never authorizes a new tier.
  const wasManaged = previous?.[MANAGED_ULTRAFAST] === entry.slug;
  preserveOperatorUltraFastTiers(entry, wasManaged || configured ? undefined : previous, retainOperatorTier);
  delete entry[MANAGED_ULTRAFAST];
  if (!configured) return;
  entry.service_tiers = [...(Array.isArray(entry.service_tiers) ? entry.service_tiers : []), {
    id: "ultrafast",
    name: "Ultra Fast",
    description: "Higher speed and usage; provider access required",
  }];
  entry.additional_speed_tiers = [
    ...(Array.isArray(entry.additional_speed_tiers) ? entry.additional_speed_tiers : []), "ultrafast",
  ];
  // Advertising a selectable capability does not opt the user into its increased usage.
  entry[MANAGED_ULTRAFAST] = entry.slug;
}

/**
 * Re-evaluate persisted routed Flex choices using current provider configuration. Degraded
 * discovery keeps disk rows but cannot let a withdrawn wire declaration keep old picker tiers.
 * Only rows tied to a configured provider are judged; unmanaged foreign rows are untouched.
 */
export function retainedFlexPolicyBySlug(
  providers: Readonly<Record<string, OcxProviderConfig>>,
  rows: readonly RawEntry[],
  observedModels: readonly CatalogModel[],
): ReadonlyMap<string, boolean> {
  const result = new Map<string, boolean>();
  const currentModels = new Map<string, CatalogModel[]>();
  for (const model of observedModels) {
    const slug = catalogModelSlug(model);
    const candidates = currentModels.get(slug) ?? [];
    candidates.push(model);
    currentModels.set(slug, candidates);
  }
  for (const row of rows) {
    const slug = typeof row.slug === "string" ? row.slug : "";
    const slash = slug.indexOf("/");
    if (slash <= 0) continue;
    const namespace = slug.slice(0, slash);
    const owner = Object.entries(providers).find(([name, provider]) =>
      name === namespace || provider.alias === namespace);
    if (!owner) continue;
    const [name, provider] = owner;
    if (provider.disabled === true || namespace === COMBO_NAMESPACE || name === COMBO_NAMESPACE) {
      result.set(slug, false);
      continue;
    }
    const observed = currentModels.get(slug);
    if (observed?.length) {
      // The current gather re-applies captured policy hints; conflicting rows fail closed.
      result.set(slug, observed.every(model =>
        model.provider !== COMBO_NAMESPACE && model.nativeAlias !== true
        && model.supportsServiceTier === true && model.supportsFlexTier === true));
      continue;
    }
    const requested = slug.slice(slash + 1);
    const aliased = Object.entries(provider.modelAliases ?? {})
      .filter(([, alias]) => alias === requested).map(([id]) => id);
    // A non-unique short alias is not authority for a capability declaration.
    if (aliased.length > 1) {
      result.set(slug, false);
      continue;
    }
    const knownIds = [
      ...(provider.models ?? []),
      ...Object.keys(provider.modelSupportsServiceTier ?? {}),
      ...Object.keys(provider.modelAliases ?? {}),
      ...Object.keys(provider.modelAdapters ?? {}),
    ];
    const modelId = aliased[0] ?? decodeRoutedModelId(requested, knownIds);
    result.set(slug, supportsConfiguredFlex(fastPolicyForModel(provider, modelId, name)));
  }
  return result;
}
