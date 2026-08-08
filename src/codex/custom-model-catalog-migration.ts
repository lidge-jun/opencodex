import { routedSlug, slugEquivalenceKey } from "../providers/slug-codec";
import type { OcxConfig } from "../types";

const MIGRATION_FIELD = "customModelCatalogMigration";
const MIGRATION_VERSION = 1;

type ConfigRecord = Record<string, unknown>;

interface SupportedMigrationState {
  readonly record: ConfigRecord;
  readonly legacyOwnedSlugs: readonly string[];
}

type ParsedMigrationState =
  | { readonly kind: "absent" }
  | { readonly kind: "supported"; readonly state: SupportedMigrationState }
  | { readonly kind: "unsupported"; readonly value: unknown };

type CustomModelSlugSet =
  | { readonly kind: "valid"; readonly byKey: ReadonlyMap<string, string> }
  | { readonly kind: "invalid" };

function configRecord(value: unknown): ConfigRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ConfigRecord
    : null;
}

function canonicalRoutedSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slug = value.trim();
  const slash = slug.indexOf("/");
  if (slash <= 0 || slash === slug.length - 1) return null;
  const provider = slug.slice(0, slash).trim();
  const modelId = slug.slice(slash + 1).trim();
  if (!provider || !modelId || provider.includes("/")) return null;
  return routedSlug(provider, modelId);
}

function canonicalSlugMap(values: readonly unknown[]): ReadonlyMap<string, string> | null {
  const byKey = new Map<string, string>();
  for (const value of values) {
    const slug = canonicalRoutedSlug(value);
    if (slug === null) return null;
    byKey.set(slugEquivalenceKey(slug), slug);
  }
  return byKey;
}

function parseMigrationState(config: unknown): ParsedMigrationState {
  const record = configRecord(config);
  if (!record || !Object.hasOwn(record, MIGRATION_FIELD)) return { kind: "absent" };
  const value = record[MIGRATION_FIELD];
  const state = configRecord(value);
  if (!state || state.version !== MIGRATION_VERSION || !Array.isArray(state.legacyOwnedSlugs)) {
    return { kind: "unsupported", value };
  }
  const slugs = canonicalSlugMap(state.legacyOwnedSlugs);
  if (slugs === null) return { kind: "unsupported", value };
  return {
    kind: "supported",
    state: {
      record: state,
      legacyOwnedSlugs: [...slugs.values()].sort(),
    },
  };
}

function customModelSlugs(config: unknown): CustomModelSlugSet {
  const record = configRecord(config);
  if (!record || record.customModels === undefined) {
    return { kind: "valid", byKey: new Map() };
  }
  if (!Array.isArray(record.customModels)) return { kind: "invalid" };
  const byKey = new Map<string, string>();
  for (const value of record.customModels) {
    const custom = configRecord(value);
    if (!custom || typeof custom.provider !== "string" || typeof custom.modelId !== "string") {
      return { kind: "invalid" };
    }
    const provider = custom.provider.trim();
    const modelId = custom.modelId.trim();
    if (!provider || !modelId || provider.includes("/")) return { kind: "invalid" };
    const slug = routedSlug(provider, modelId);
    byKey.set(slugEquivalenceKey(slug), slug);
  }
  return { kind: "valid", byKey };
}

function copyMigrationField(target: OcxConfig, source: OcxConfig): void {
  const targetRecord = target as unknown as ConfigRecord;
  const sourceRecord = source as unknown as ConfigRecord;
  if (Object.hasOwn(sourceRecord, MIGRATION_FIELD)) {
    targetRecord[MIGRATION_FIELD] = structuredClone(sourceRecord[MIGRATION_FIELD]);
  } else {
    delete targetRecord[MIGRATION_FIELD];
  }
}

/**
 * Project one-time legacy custom-model ownership onto a whole-config write.
 *
 * The persisted pre-write config is the only authority for pre-marker ownership.
 * Unknown future/malformed state is carried forward byte-for-value and grants no
 * deletion authority; an older binary must never reinterpret or erase it.
 */
export function projectCustomModelCatalogMigration(
  persistedConfig: unknown,
  candidateConfig: OcxConfig,
): OcxConfig {
  const persistedState = parseMigrationState(persistedConfig);
  const candidateState = parseMigrationState(candidateConfig);
  const projected = { ...candidateConfig } as OcxConfig;
  const projectedRecord = projected as unknown as ConfigRecord;

  if (persistedState.kind === "unsupported") {
    projectedRecord[MIGRATION_FIELD] = structuredClone(persistedState.value);
    return projected;
  }
  if (persistedState.kind === "absent" && candidateState.kind === "unsupported") {
    projectedRecord[MIGRATION_FIELD] = structuredClone(candidateState.value);
    return projected;
  }

  const legacyByKey = new Map<string, string>();
  const addLegacy = (slugs: readonly string[]): void => {
    for (const slug of slugs) legacyByKey.set(slugEquivalenceKey(slug), slug);
  };
  if (persistedState.kind === "supported") addLegacy(persistedState.state.legacyOwnedSlugs);
  if (candidateState.kind === "supported") addLegacy(candidateState.state.legacyOwnedSlugs);

  const persistedCustom = customModelSlugs(persistedConfig);
  const candidateCustom = customModelSlugs(candidateConfig);
  // Only an absent persisted version means these rows can predate the ownership marker.
  // Never add candidate-only or post-version models: those are born with custom-model-v1.
  if (persistedState.kind === "absent" && persistedCustom.kind === "valid") {
    for (const [key, slug] of persistedCustom.byKey) legacyByKey.set(key, slug);
  }

  // Establish an empty v1 on the first custom-model add too: the cutover, not list
  // non-emptiness, proves that candidate-only models can never be inferred as legacy.
  // Unrelated saves for users who never configured custom models remain untouched.
  const shouldVersion = persistedState.kind === "supported"
    || candidateState.kind === "supported"
    || (persistedState.kind === "absent"
      && ((persistedCustom.kind === "valid" && persistedCustom.byKey.size > 0)
        || (candidateCustom.kind === "valid" && candidateCustom.byKey.size > 0)));
  if (!shouldVersion) {
    delete projectedRecord[MIGRATION_FIELD];
    return projected;
  }

  const priorRecord = persistedState.kind === "supported" ? persistedState.state.record : {};
  const nextRecord = candidateState.kind === "supported" ? candidateState.state.record : {};
  projectedRecord[MIGRATION_FIELD] = {
    ...structuredClone(priorRecord),
    ...structuredClone(nextRecord),
    version: MIGRATION_VERSION,
    legacyOwnedSlugs: [...legacyByKey.values()].sort(),
  };
  return projected;
}

/** Copy only the internal migration state after the projected write succeeds. */
export function adoptCustomModelCatalogMigration(
  target: OcxConfig,
  projected: OcxConfig,
): void {
  copyMigrationField(target, projected);
}

/** Canonical slugs that may classify old, unmarked OpenCodex custom rows. */
export function legacyCustomModelCatalogSlugs(config: OcxConfig): ReadonlySet<string> {
  const state = parseMigrationState(config);
  return new Set(state.kind === "supported" ? state.state.legacyOwnedSlugs : []);
}
