import { ALIBABA_INTL_BASE_URL_CHOICES } from "./base-url-choices";
import { providerConfigSeed } from "./derive";
import { rewriteProviderReferences } from "./provider-id-rewrite";
import { PROVIDER_REGISTRY } from "./registry";
import { codexAccountNamespaceProviderCollisionError } from "../codex/account-namespace-match";
import type { OcxConfig, OcxProviderConfig } from "../types";

const BEIJING_ID = "alibaba-token-plan";
const INTL_ID = "alibaba-token-plan-intl";

/**
 * Credentials and switches the user owns directly. Everything else on the moved
 * row is registry-derived Beijing metadata (`ocx provider add` and the GUI persist
 * it, and registry enrichment only fills absent fields) and must NOT travel to the
 * international id — carrying it would leave the intl provider serving Singapore
 * while advertising the six-model Beijing Personal Edition catalog.
 *
 * `baseUrl` is carried deliberately: the migration only fires for a URL that
 * `ALIBABA_INTL_BASE_URL_CHOICES` recognises, so it is nonblank and
 * placeholder-free and satisfies the override guard in the router.
 * `liveModels` is carried because it is directly user-editable, so resetting it
 * to the seed's `false` would silently undo a deliberate choice.
 * `authMode` is NOT carried — both entries are key-auth and the seed's value is
 * the one matching the destination's registry contract.
 * `defaultModel` and `note` are user-editable too and are handled below.
 */
const USER_OWNED_FIELDS = ["apiKey", "apiKeyPool", "disabled", "baseUrl", "allowPrivateNetwork", "liveModels", "modelCosts"] as const;

export interface AlibabaRegionMigrationProjection {
  config: OcxConfig;
  changed: boolean;
  warnings: string[];
}

const normalize = (url: string): string => url.trim().replace(/\/+$/, "").toLowerCase();

/** True when the saved URL is one the international entry actually serves. */
function isInternationalEndpoint(baseUrl: string): boolean {
  return ALIBABA_INTL_BASE_URL_CHOICES.some(
    choice => choice.baseUrl && normalize(choice.baseUrl) === normalize(baseUrl),
  );
}

/**
 * Seed the destination from the international registry entry, then overlay only
 * what the user owns. `providerConfigSeed` is the same function `ocx provider add`
 * uses, so the migrated row is indistinguishable from one the user had created
 * against the international provider directly.
 */
function buildIntlRow(source: OcxProviderConfig): OcxProviderConfig {
  const entry = PROVIDER_REGISTRY.find(e => e.id === INTL_ID);
  // Fail fast rather than fabricate a row: a missing registry entry means the
  // destination this migration targets no longer exists.
  if (!entry) throw new Error(`registry entry "${INTL_ID}" not found; cannot migrate "${BEIJING_ID}"`);
  const seeded = providerConfigSeed(entry);
  const writable = seeded as unknown as Record<string, unknown>;
  const readable = source as unknown as Record<string, unknown>;
  for (const field of USER_OWNED_FIELDS) {
    if (readable[field] !== undefined) writable[field] = readable[field];
  }

  const servable = new Set(entry.models ?? []);
  // A user-chosen default survives only when the destination can actually serve
  // it; otherwise the international default already on the seed stands.
  if (source.defaultModel && servable.has(source.defaultModel)) seeded.defaultModel = source.defaultModel;
  // Same rule for the allowlist, handled here where the destination catalog is
  // known — never by the generic reference rewriter.
  const selected = source.selectedModels?.filter(id => servable.has(id));
  if (selected && selected.length > 0) seeded.selectedModels = selected;
  else delete seeded.selectedModels;

  // `providerConfigSeed` does not carry `note`, so seed the destination's registry
  // note explicitly, then let a genuinely user-authored note win. Comparing
  // against the SOURCE registry note is what distinguishes "the user typed this"
  // from "the Beijing entry's stock note came along for the ride".
  const beijingNote = PROVIDER_REGISTRY.find(e => e.id === BEIJING_ID)?.note;
  if (entry.note) seeded.note = entry.note;
  if (source.note && source.note !== beijingNote) seeded.note = source.note;

  return seeded;
}

/**
 * Repair a config whose `alibaba-token-plan` entry points at an international
 * endpoint (issue #457). The Beijing entry is pinned to cn-beijing and does not
 * take a baseUrl override by design, so such a config routes an international key
 * to Beijing and fails with 401 on every request.
 *
 * The entry is MOVED to `alibaba-token-plan-intl` rather than the Beijing entry
 * being taught to serve Singapore: the two ids carry different model lists,
 * context windows, modality maps and dashboards, and a URL override cannot carry
 * those contracts across. That override fix shipped once, was backed out twice,
 * and was refused again when PR #459 closed.
 *
 * Refuses to act when the destination is reserved by an account namespace or
 * already holds a value — a provider row or a key the reference rewrite would
 * land on — because choosing which setting wins is a user decision, not a
 * migration's.
 */
export function projectAlibabaRegionMigration(config: OcxConfig): AlibabaRegionMigrationProjection {
  const beijing = config.providers[BEIJING_ID];
  const savedBaseUrl = typeof beijing?.baseUrl === "string" ? beijing.baseUrl : "";
  if (!beijing || !savedBaseUrl || !isInternationalEndpoint(savedBaseUrl)) {
    return { config, changed: false, warnings: [] };
  }
  if (codexAccountNamespaceProviderCollisionError(config.codexAccountNamespaces, INTL_ID)) {
    return {
      config,
      changed: false,
      warnings: [
        `provider "${BEIJING_ID}" needs to move to "${INTL_ID}", but that destination is reserved `
        + `by a configured Codex account namespace. Nothing was changed. Rename the account `
        + `selector or move the provider manually, then restart.`,
      ],
    };
  }
  if (config.providers[INTL_ID]) {
    return {
      config,
      changed: false,
      warnings: [
        `provider "${BEIJING_ID}" is configured with an international endpoint, but "${INTL_ID}" `
        + `already exists. Both were left untouched: merging two credential sets is not a decision `
        + `this migration can make. Move the key to "${INTL_ID}" and delete the unused entry.`,
      ],
    };
  }

  const projected = structuredClone(config);
  delete projected.providers[BEIJING_ID];
  projected.providers[INTL_ID] = buildIntlRow(beijing);
  const { changed: rewritten, collisions } = rewriteProviderReferences(projected, BEIJING_ID, INTL_ID);
  // The rewriter is not transactional, so the clone is already partly rewritten
  // here. Returning the ORIGINAL config discards it.
  if (collisions.length > 0) {
    return {
      config,
      changed: false,
      warnings: [
        `provider "${BEIJING_ID}" needs to move to "${INTL_ID}", but ${collisions.join(", ")} `
        + `already hold values for the destination. Nothing was changed: choosing which value `
        + `survives is not a decision this migration can make. Resolve those entries and restart.`,
      ],
    };
  }

  return {
    config: projected,
    changed: true,
    warnings: [
      `moved provider "${BEIJING_ID}" to "${INTL_ID}": its saved endpoint is the international one, `
      + `which the Beijing entry cannot serve. ${rewritten} reference(s) were re-pointed; the `
      + `international model catalog now applies.`,
    ],
  };
}
