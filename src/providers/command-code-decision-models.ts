/**
 * Command Code's System One decision models (#8997).
 *
 * Command Code lists `typesafe/jev` and its versioned ids in `/provider/v1/models` next to its chat
 * models, but serves them only at `POST /provider/v1/systemone` with the `{model, state, questions}`
 * decision contract (https://commandcode.ai/docs/provider). Its chat endpoints answer 403 for them,
 * so they are neither catalog chat rows nor chat routes; a JEV combo reaches them through a
 * `jev-decision` provider pointed at the System One endpoint.
 *
 * Dependency-free so the provider registry (discovery filter) and the adapter registry (request
 * guard) share one definition.
 */
import type { ProviderModelDiscoveryFilter } from "./registry/types";

/** The native id fragment every decision model carries. */
export const COMMAND_CODE_DECISION_MODEL_ID_FRAGMENT = "typesafe/jev";
/** The same fragment with the slash folded to a dash, as Codex-facing encoded slugs carry it. */
const ENCODED_DECISION_MODEL_ID_FRAGMENT = "typesafe-jev";

/**
 * Discovery admission shared by both Command Code presets: decision rows are not chat rows. Both
 * spellings are matched so discovery hides exactly the ids request admission refuses.
 */
export const COMMAND_CODE_DECISION_MODEL_DISCOVERY_FILTER: ProviderModelDiscoveryFilter = {
  noneOf: [{ path: ["id"], containsAny: [COMMAND_CODE_DECISION_MODEL_ID_FRAGMENT, ENCODED_DECISION_MODEL_ID_FRAGMENT], caseInsensitive: true }],
};

/** Where Command Code serves the decision models. */
export const COMMAND_CODE_SYSTEMONE_ENDPOINT = "https://api.commandcode.ai/provider/v1/systemone";

/** Command Code's API host, shared by the OAuth (`command-code`) and API-key (`commandcode`) presets. */
export const COMMAND_CODE_API_HOST = "api.commandcode.ai";

/**
 * True for a Command Code decision model id: the id, with every slash folded to a dash, contains
 * `typesafe-jev` (case-insensitive). On native ids this is exactly the discovery filter (either
 * spelling), and it also covers the Codex-facing encoded slug of every id discovery hides, which a
 * stale selection can still send after discovery stopped listing the row.
 */
export function isCommandCodeDecisionModel(modelId: string): boolean {
  return modelId.toLowerCase().replaceAll("/", "-").includes(ENCODED_DECISION_MODEL_ID_FRAGMENT);
}

/** True when a provider's baseUrl points at Command Code, whatever the provider is named. */
export function isCommandCodeHost(baseUrl: string | undefined): boolean {
  try {
    return new URL(baseUrl ?? "").hostname.toLowerCase() === COMMAND_CODE_API_HOST;
  } catch {
    return false;
  }
}

/** True when this provider/model pair is a Command Code decision model, whatever the provider is named. */
export function isCommandCodeDecisionRoute(provider: { baseUrl?: string }, modelId: string): boolean {
  return isCommandCodeHost(provider.baseUrl) && isCommandCodeDecisionModel(modelId);
}

/**
 * Client copy for a chat request that named a decision model. A fixed sentence of proxy literals
 * only (no model id), so the Chat and Messages presenters can pass it through instead of replacing
 * it with generic "rejected" copy; it is registered in client-error-body's PROXY_FIXED_MESSAGES.
 */
export const COMMAND_CODE_DECISION_MODEL_MESSAGE = "Command Code serves its typesafe/jev System One decision models only at POST "
  + COMMAND_CODE_SYSTEMONE_ENDPOINT + "; they cannot answer chat requests. Use one as the decision service of a "
  + "JEV combo (a jev-decision provider pointed at that endpoint), or choose a chat model.";
