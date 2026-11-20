import type { ProviderAdapter } from "./base";
import type { OcxProviderConfig } from "../types";
import { markProxyError, rememberProxyErrorMessage } from "../lib/client-error-body";
import {
  COMMAND_CODE_DECISION_MODEL_MESSAGE,
  isCommandCodeDecisionModel,
  isCommandCodeHost,
} from "../providers/command-code-decision-models";

/** True when this provider/model pair is a Command Code decision model, whatever the provider is named. */
export function isCommandCodeDecisionRoute(provider: Pick<OcxProviderConfig, "baseUrl">, modelId: string): boolean {
  return isCommandCodeHost(provider.baseUrl) && isCommandCodeDecisionModel(modelId);
}

/**
 * The Responses pipeline's early refusal, taken before sidecar auth or any sidecar work (vision,
 * web search) can spend effort on a request no Command Code chat endpoint will serve. Each combo or
 * policy candidate runs this pipeline, so a candidate is refused the same way. Nothing is sent.
 * 404 `model_not_found` is the shape OpenAI itself answers for a model that is not a chat model,
 * and the one combos read as target-local: a combo that lists a decision model moves to its next
 * target instead of failing the request.
 */
export function commandCodeDecisionRouteRefusal(
  provider: Pick<OcxProviderConfig, "baseUrl">, modelId: string, logCtx: object,
): Response | undefined {
  if (!isCommandCodeDecisionRoute(provider, modelId)) return undefined;
  rememberProxyErrorMessage(logCtx, COMMAND_CODE_DECISION_MODEL_MESSAGE, { status: 404, type: "invalid_request_error", code: "model_not_found" });
  return markProxyError(new Response(JSON.stringify({ error: {
    type: "invalid_request_error", code: "model_not_found", param: null, message: COMMAND_CODE_DECISION_MODEL_MESSAGE,
  } }), { status: 404, headers: { "Content-Type": "application/json" } }));
}

/**
 * Refuse a chat request for a Command Code System One decision model before anything is sent
 * (#8997). Applied once in `createRegisteredAdapter`, so the OAuth preset (`command-code`
 * adapter, `/alpha/generate`), the API-key preset (`openai-chat`, `/provider/v1/chat/completions`)
 * and any renamed provider pointed at the same host are covered by one check. Throwing from
 * `buildRequest` is the established client-safe 400: dispatch answers it without a send. This is
 * the backstop for paths that build a request outside the Responses pipeline's early refusal.
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
