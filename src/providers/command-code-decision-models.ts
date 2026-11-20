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

/** The native id fragment every decision model carries; the discovery filter matches it as a substring. */
export const COMMAND_CODE_DECISION_MODEL_ID_FRAGMENT = "typesafe/jev";

/** Discovery admission shared by both Command Code presets: decision rows are not chat rows. */
export const COMMAND_CODE_DECISION_MODEL_DISCOVERY_FILTER: ProviderModelDiscoveryFilter = {
  noneOf: [{ path: ["id"], containsAny: [COMMAND_CODE_DECISION_MODEL_ID_FRAGMENT], caseInsensitive: true }],
};

/** Where Command Code serves the decision models. */
export const COMMAND_CODE_SYSTEMONE_ENDPOINT = "https://api.commandcode.ai/provider/v1/systemone";

/** Command Code's API host, shared by the OAuth (`command-code`) and API-key (`commandcode`) presets. */
export const COMMAND_CODE_API_HOST = "api.commandcode.ai";

/**
 * True for a Command Code decision model id. Two forms:
 * - native ids, with exactly the discovery filter's semantics (case-insensitive substring
 *   `typesafe/jev`), so request admission refuses every id discovery hides;
 * - the Codex-facing encoded form (`typesafe-jev...`, slash folded to a dash) that a stale
 *   selection can still send after discovery stopped listing the row. Prefix-anchored, so an id
 *   such as `claude-typesafe-jev` that the API-key preset pins to its Messages wire never matches.
 */
export function isCommandCodeDecisionModel(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return id.includes(COMMAND_CODE_DECISION_MODEL_ID_FRAGMENT) || id.startsWith("typesafe-jev");
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
