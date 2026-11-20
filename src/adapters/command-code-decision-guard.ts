import type { ProviderAdapter } from "./base";
import type { OcxProviderConfig } from "../types";
import {
  COMMAND_CODE_DECISION_MODEL_MESSAGE,
  isCommandCodeDecisionModel,
  isCommandCodeHost,
} from "../providers/command-code-decision-models";

/**
 * Refuse a chat request for a Command Code System One decision model before anything is sent
 * (#8997). Applied once in `createRegisteredAdapter`, so the OAuth preset (`command-code`
 * adapter, `/alpha/generate`), the API-key preset (`openai-chat`, `/provider/v1/chat/completions`)
 * and any renamed provider pointed at the same host are covered by one check. Throwing from
 * `buildRequest` is the established client-safe 400: dispatch answers it without a send.
 */
export function withCommandCodeDecisionModelGuard<T extends ProviderAdapter>(adapter: T, provider: OcxProviderConfig): T {
  if (!isCommandCodeHost(provider.baseUrl)) return adapter;
  const build = adapter.buildRequest.bind(adapter);
  adapter.buildRequest = (parsed, incoming) => {
    if (isCommandCodeDecisionModel(parsed.modelId)) throw new Error(COMMAND_CODE_DECISION_MODEL_MESSAGE);
    return build(parsed, incoming);
  };
  return adapter;
}
