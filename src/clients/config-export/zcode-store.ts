// ZCode personal provider store export.
import type { ExportContext, ManagedContribution, ManagedFragment } from "./contracts";
import { authoritativeContextWindow, inputModalitiesForClient, normalizeExportModels, zcodeSelectableEfforts } from "./model-metadata";
import { OPENCODE_PROVIDER_ID, LOOPBACK_API_KEY_PLACEHOLDER } from "./constants";
import { formatSelectorConjunction } from "../../integrations/merge";

/**
 * The file ZCode 3.14 and later actually read their custom providers from.
 *
 * `v2/config.json` — the file {@link buildZcodeContribution} writes — is still
 * parsed by this client, but only by a one-shot `importLegacy` hook that runs
 * when this store is missing. The client creates the store on first launch, so
 * on any install that has ever run the import is already spent and a later
 * write to the old file is read by nobody (#5348).
 *
 * The shape below is the client's own, quoted from the report that opened
 * #5348: it is what the client's `importLegacyPersonalProviderConfig` produced
 * when it migrated this project's block, so it is observed output rather than a
 * schema this project invented. Everything the client persists that we have not
 * seen it derive from our block is deliberately absent — an omitted field is a
 * field the client still owns.
 */
export const ZCODE_STORE_SCHEMA_VERSION = 1;

/**
 * `group` places the provider among the user's own personal providers rather
 * than the builtin list the client ships and rewrites. `api.type` is the same
 * choice `kind: "openai"` makes in the legacy block: the OpenAI Responses
 * protocol, which is the only surface this proxy speaks natively.
 */
export const ZCODE_STORE_PROVIDER_GROUP = "standard-personal";
export const ZCODE_STORE_API_TYPE = "openai-responses";
export const ZCODE_STORE_PROVIDER_NAME = "OpenCodex";

/** Where the store keeps one rule per provider, and one per (provider, model). */
export const ZCODE_STORE_PROVIDER_RULES_PATH = ["config", "providerConfigRules", "providerRules"] as const;
export const ZCODE_STORE_MODEL_RULES_PATH = ["config", "modelConfigRules", "providerModelRules"] as const;

export interface ZcodeStoreProviderRule {
  providerId: string;
  enabled: true;
  providerName: string;
  config: {
    group: string;
    access: { type: "api-key"; apiKey: string };
    api: { type: string; baseUrl: string };
    personalModelIds: string[];
    modelOrder: string[];
  };
}

/**
 * One model rule, as the client's own store loader accepts it.
 *
 * The capability fields are the client's schema, not ours: ZCode 3.14's CLI
 * bundle parses each `providerModelRules` entry with a strict object whose
 * `config.properties` admits `inputFormat.{supportsText..supportsPdf}` (booleans)
 * and whose `config.optionSpecs` admits `reasoningLevel.values` (non-empty,
 * deduplicated) plus an optional compiled `map`. With no `map`, the chosen level
 * is validated against `values` and forwarded verbatim to the wire field the
 * `openai-responses` api type uses — `reasoning.effort`, which is exactly the
 * Codex vocabulary our ladder already carries, so no mapping is emitted.
 */
export interface ZcodeStoreModelRule {
  providerId: string;
  modelId: string;
  config: {
    properties: {
      contextWindow?: number;
      inputFormat?: { supportsImage: true };
    };
    optionSpecs?: {
      reasoningLevel: { values: string[] };
    };
  };
}

/**
 * Is this document a store whose schema we can write?
 *
 * Only the one version whose shape has been observed. A store carrying any
 * other `schemaVersion` — or none, or a document that is not an object — is a
 * file we cannot merge into without asserting a nesting we have never seen,
 * and a wrong assertion there does not fail loudly: it replaces the provider
 * list the user keeps in the same file. The integration reports the write as
 * ineffective in that case instead of guessing.
 */
export function zcodeStoreSchemaEstablished(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  return (parsed as Record<string, unknown>).schemaVersion === ZCODE_STORE_SCHEMA_VERSION;
}

/**
 * The selector addressing one model rule, or null when the id cannot be spelled.
 *
 * A rule is identified by the PAIR, so both fields are named: a selector
 * carrying only the model would match another provider's rule for the same
 * model. The conjunction grammar reserves `,` and `]`, and a model id holding
 * either cannot be addressed unambiguously — that row ships without its
 * model rule rather than with a selector that points somewhere else.
 */
function modelRuleSelector(modelId: string): string | null {
  return formatSelectorConjunction([
    { field: "providerId", value: OPENCODE_PROVIDER_ID },
    { field: "modelId", value: modelId },
  ]);
}

/** The rows this export publishes, filtered exactly as the legacy block filters them. */
function storeModels(ctx: ExportContext): string[] {
  const ids: string[] = [];
  for (const model of normalizeExportModels(ctx.models)) {
    if (inputModalitiesForClient("pi", model.inputModalities) === null) continue;
    ids.push(model.namespaced);
  }
  return ids;
}

/**
 * The provider rule the client reads, built from the same context the legacy
 * block is built from.
 *
 * `baseUrl` carries the `/v1` root for the same reason the legacy block does:
 * this client appends `/responses` for the Responses protocol, so requests land
 * on `/v1/responses`. The serialized credential is always the non-secret
 * loopback placeholder.
 */
export function buildZcodeStoreProviderRule(ctx: ExportContext): ZcodeStoreProviderRule {
  const ids = storeModels(ctx);
  return {
    providerId: OPENCODE_PROVIDER_ID,
    enabled: true,
    providerName: ZCODE_STORE_PROVIDER_NAME,
    config: {
      group: ZCODE_STORE_PROVIDER_GROUP,
      access: { type: "api-key", apiKey: LOOPBACK_API_KEY_PLACEHOLDER },
      api: { type: ZCODE_STORE_API_TYPE, baseUrl: `${ctx.baseUrl.replace(/\/v1\/?$/, "")}/v1` },
      personalModelIds: ids,
      /*
       * The client persists the picker order separately from membership. Ours is
       * the catalog order the rest of this export already sorts by, so a refresh
       * that adds a model puts it where every other surface puts it.
       */
      modelOrder: [...ids],
    },
  };
}

/**
 * Everything this project owns inside the store: one provider rule, plus one
 * model rule per row that has anything authoritative to assert.
 *
 * A model rule now exists when the row has any of: an authoritative context
 * window, image input, or a selectable effort ladder. A row with none of the
 * three ships no rule at all, which is the same no-guessed-capability rule the
 * legacy block follows. Image input is asserted only when the catalog declares
 * it — `supportsImage: true` is what gates the client's attachment UI, and a
 * text-only row keeps the client's own defaults rather than being pinned to
 * `false`. `reasoningLevel.values` carries the same ladder (minus the `none`
 * sentinel) the legacy block's `reasoning.variants` carries, so both surfaces
 * offer the picker the catalog declared instead of the store silently losing
 * reasoning and vision the way #5348 lost the provider itself.
 */
export function buildZcodeStoreContribution(ctx: ExportContext): ManagedContribution {
  const fragments: ManagedFragment[] = [{
    path: [...ZCODE_STORE_PROVIDER_RULES_PATH, `[providerId=${OPENCODE_PROVIDER_ID}]`],
    value: buildZcodeStoreProviderRule(ctx),
  }];
  for (const model of normalizeExportModels(ctx.models)) {
    const input = inputModalitiesForClient("pi", model.inputModalities);
    if (input === null) continue;
    const contextWindow = authoritativeContextWindow(model.contextWindow);
    const supportsImage = input.includes("image");
    const efforts = zcodeSelectableEfforts(model.reasoningEfforts);
    if (contextWindow === undefined && !supportsImage && efforts === undefined) continue;
    const selector = modelRuleSelector(model.namespaced);
    if (selector === null) continue;
    const rule: ZcodeStoreModelRule = {
      providerId: OPENCODE_PROVIDER_ID,
      modelId: model.namespaced,
      config: {
        properties: {
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(supportsImage ? { inputFormat: { supportsImage: true } } : {}),
        },
        ...(efforts !== undefined ? { optionSpecs: { reasoningLevel: { values: efforts } } } : {}),
      },
    };
    fragments.push({ path: [...ZCODE_STORE_MODEL_RULES_PATH, selector], value: rule });
  }
  return { clientId: "zcode", fragments };
}
