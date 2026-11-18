import { advisorServerToolDestination, hasAdvisorServerTools } from "../../adapters/anthropic/advisor-tool";
import { addProtocolEntryReason } from "../../protocols/trace";
import type { HandleResponsesOptions, HostedAdvisorSpendScope, ResponsesRequestContext } from "./core-options";
import { HostedAdvisorSpendRefusal } from "./policy-request-scope";
import type { PreparedResponsesRequest } from "./request-prepare";
import { responsesHasCapturedSpendCeiling } from "./request-send-budget";
import { responsesHostedAdvisorSpendTarget } from "./request-spend-target";
import { captureRequestSpendPolicy } from "./request-spend";
import type { ResponsesTransport } from "./request-transport";

/** Keep the numeric snapshot and optional decision on the original translated turn. */
export function captureHostedAdvisorSpendScope(options: HandleResponsesOptions): HostedAdvisorSpendScope | undefined {
  if (options.hostedAdvisorSpendScope) return options.hostedAdvisorSpendScope;
  if (options.inboundWire === "anthropic" && hasAdvisorServerTools({
    _anthropicServerTools: options.anthropicServerTools,
    _anthropicServerReplay: options.anthropicServerReplay,
  })) return { ceilings: captureRequestSpendPolicy(), optionalWithheld: false };
  return undefined;
}

/** Refuse the admitted candidate before vision can send any part of the turn. */
export function initialHostedAdvisorSpendRefusal(
  context: ResponsesRequestContext,
  { parsed, route }: Pick<PreparedResponsesRequest, "parsed" | "route">,
  { initialAdapterProvider }: Pick<ResponsesTransport, "initialAdapterProvider">,
): Response | undefined {
  const { options, req, logCtx } = context;
  if (options.anthropicHostedAdvisorSelection !== "selected" || !options.sendBudget
    || !advisorServerToolDestination(initialAdapterProvider) || !hasAdvisorServerTools(parsed)
    || !responsesHasCapturedSpendCeiling(options.sendBudget, req, logCtx, responsesHostedAdvisorSpendTarget(logCtx, route.providerName, initialAdapterProvider))) {
    return undefined;
  }
  addProtocolEntryReason(logCtx, "advisor-tool-withheld-by-spend-policy");
  return new HostedAdvisorSpendRefusal().response();
}
