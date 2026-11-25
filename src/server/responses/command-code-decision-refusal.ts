import { markProxyError, rememberProxyErrorMessage } from "../../lib/client-error-body";
import { COMMAND_CODE_DECISION_MODEL_MESSAGE, isCommandCodeDecisionRoute } from "../../providers/command-code-decision-models";
import type { OcxProviderConfig } from "../../types";
import { markPolicyCandidateRefusal } from "./policy-request-scope";

/**
 * The Responses pipeline's early refusal of a Command Code System One decision model (#8997),
 * taken before sidecar auth or any sidecar work (vision, web search) can spend effort on a request
 * no Command Code chat endpoint will serve. Every combo and policy candidate runs this pipeline.
 *
 * - 404 `model_not_found` is the shape OpenAI itself answers for a model that is not a chat model,
 *   and the code combos read as target-local, so a combo listing a decision model moves on.
 * - Policy-candidate provenance: nothing was sent, so policy fallback skips this candidate without
 *   committing its hop or making it the next fallback decision's source.
 */
export function commandCodeDecisionRouteRefusal(
  provider: Pick<OcxProviderConfig, "baseUrl">, modelId: string, logCtx: object,
): Response | undefined {
  if (!isCommandCodeDecisionRoute(provider, modelId)) return undefined;
  rememberProxyErrorMessage(logCtx, COMMAND_CODE_DECISION_MODEL_MESSAGE, { status: 404, type: "invalid_request_error", code: "model_not_found" });
  return markPolicyCandidateRefusal(markProxyError(new Response(JSON.stringify({ error: {
    type: "invalid_request_error", code: "model_not_found", param: null, message: COMMAND_CODE_DECISION_MODEL_MESSAGE,
  } }), { status: 404, headers: { "Content-Type": "application/json" } })));
}
