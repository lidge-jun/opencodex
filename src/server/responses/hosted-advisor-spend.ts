import { advisorServerToolDestination, hasAdvisorServerTools } from "../../adapters/anthropic/advisor-tool";
import { addProtocolEntryReason } from "../../protocols/trace";
import { hasConflictingApiKeyHeaders } from "../../providers/api-key-response-ownership";
import type { OcxProviderConfig } from "../../types";
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

/** Operator headers are appended by the Messages serializer and cannot establish credential ownership. */
export function hostedAdvisorSpendRefusalFor(
  provider: OcxProviderConfig, hasCapturedSpendCeiling: () => boolean,
): HostedAdvisorSpendRefusal | undefined {
  if (!advisorServerToolDestination(provider)) return undefined;
  if (provider.headers && hasConflictingApiKeyHeaders(Object.keys(provider.headers))) {
    return new HostedAdvisorSpendRefusal("ambiguous-credentials");
  }
  if (hasCapturedSpendCeiling()) return new HostedAdvisorSpendRefusal("ceiling");
  return undefined;
}

/** Refuse the admitted candidate before vision can send any part of the turn. */
export function initialHostedAdvisorSpendRefusal(
  context: ResponsesRequestContext,
  { parsed, route }: Pick<PreparedResponsesRequest, "parsed" | "route">,
  { initialAdapterProvider }: Pick<ResponsesTransport, "initialAdapterProvider">,
): Response | undefined {
  const { options, req, logCtx } = context;
  if (options.anthropicHostedAdvisorSelection !== "selected" || !hasAdvisorServerTools(parsed)) return undefined;
  const { sendBudget } = options;
  const refusal = hostedAdvisorSpendRefusalFor(initialAdapterProvider, () => sendBudget !== undefined
    && responsesHasCapturedSpendCeiling(sendBudget, req, logCtx, responsesHostedAdvisorSpendTarget(logCtx, route.providerName, initialAdapterProvider)));
  if (!refusal) return undefined;
  addProtocolEntryReason(logCtx, "advisor-tool-withheld-by-spend-policy");
  return refusal.response();
}
