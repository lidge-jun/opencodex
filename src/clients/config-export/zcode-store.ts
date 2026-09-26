// ZCode personal provider store export.
import type { ExportContext, ManagedContribution, ManagedFragment } from "./contracts";
import { authoritativeContextWindow, inputModalitiesForClient, normalizeExportModels } from "./model-metadata";
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

export interface ZcodeStoreModelRule {
  providerId: string;
  modelId: string;
  config: { properties: { contextWindow: number } };
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
 * context window rather than with a selector that points somewhere else.
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
 * model rule per row that has an authoritative context window.
 *
 * A row without one ships no model rule at all, which is the same
 * authoritative-window rule the legacy block follows — an emitted stand-in
 * would be a guessed capability. Reasoning ladders have no counterpart here
 * that this project has observed the client produce, so none is written.
 */
export function buildZcodeStoreContribution(ctx: ExportContext): ManagedContribution {
  const fragments: ManagedFragment[] = [{
    path: [...ZCODE_STORE_PROVIDER_RULES_PATH, `[providerId=${OPENCODE_PROVIDER_ID}]`],
    value: buildZcodeStoreProviderRule(ctx),
  }];
  for (const model of normalizeExportModels(ctx.models)) {
    if (inputModalitiesForClient("pi", model.inputModalities) === null) continue;
    const contextWindow = authoritativeContextWindow(model.contextWindow);
    if (contextWindow === undefined) continue;
    const selector = modelRuleSelector(model.namespaced);
    if (selector === null) continue;
    const rule: ZcodeStoreModelRule = {
      providerId: OPENCODE_PROVIDER_ID,
      modelId: model.namespaced,
      config: { properties: { contextWindow } },
    };
    fragments.push({ path: [...ZCODE_STORE_MODEL_RULES_PATH, selector], value: rule });
  }
  return { clientId: "zcode", fragments };
}
