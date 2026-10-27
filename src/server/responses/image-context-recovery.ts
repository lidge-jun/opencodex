import type { ResponsesRequestContext, ResponsesDispatchers } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import { prepareAnthropicImageContext, ImageContextError } from "./anthropic-image-context";
import { sameProviderContinuationOwner } from "../../responses/provider-continuation";
import { decodeCompactionSummary } from "../../responses/compaction";
import { addFinalRequestLog, type RequestLogContext } from "../request-log";
import { formatErrorResponse } from "../../bridge";
import type { OcxParsedRequest } from "../../types";
import type { ProviderAdapter } from "../../adapters/base";
import { readDisplaySafeErrorText } from "./core-errors";
import { isNonReplayableResponse } from "../../lib/upstream-retry";

export type ImageContextPreparation = (upstreamRejected?: boolean, attempt?: OcxParsedRequest, adapter?: ProviderAdapter) => Promise<Response | undefined>;

/** Release the refused send before admitting its summary; retain the original terminal failure. */
export async function recoverImageContextResponse(response: Response, parsed: OcxParsedRequest, adapter: ProviderAdapter,
  prepare: ImageContextPreparation, signal: AbortSignal): Promise<{ response: Response; changed: boolean }> {
  if (response.status !== 413 || adapter.name !== "anthropic" || isNonReplayableResponse(response)
    || !parsed.context.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === "image"))) return { response, changed: false };
  const text = await readDisplaySafeErrorText(response, signal, "");
  const headers = new Headers(response.headers); headers.delete("content-length"); headers.delete("content-encoding");
  const retained = new Response(text, { status: response.status, headers });
  const before = parsed.context.messages;
  const refusal = await prepare(true, parsed, adapter);
  return { response: refusal ?? retained, changed: !refusal && parsed.context.messages !== before };
}

/** Keep image recovery inside the owning request's admission, cancellation and send budget. */
export function createImageContextPreparation(
  { req, config, logCtx, options }: ResponsesRequestContext,
  requestState: PreparedResponsesRequest,
  transportState: ResponsesTransport,
  dispatchers: ResponsesDispatchers,
): Response | ImageContextPreparation {
  const summaryContext = options.imageSummaryContext;
  if (summaryContext) {
    if (!requestState.parsed._providerContinuationOwner
      || !sameProviderContinuationOwner(summaryContext.owner, requestState.parsed._providerContinuationOwner)) {
      return formatErrorResponse(409, "image_compaction_owner_changed", "Serving account changed before image compaction; retry the request.");
    }
    requestState.parsed.context.messages = summaryContext.messages;
    requestState.parsed._anthropicImageOwner = summaryContext.owner;
  }
  return async (upstreamRejected = false, attempt = requestState.parsed, adapter = transportState.activeAdapter ?? transportState.adapter) => {
    if (summaryContext || adapter.name !== "anthropic" || upstreamRejected && attempt._compactionRequest) return;
    try {
      await prepareAnthropicImageContext({ parsed: attempt, adapter, upstreamRejected,
        incoming: { headers: requestState.selectedForwardHeaders, providerName: requestState.route.providerName,
          translatorBudget: options.translatorBudget, abortSignal: options.abortSignal },
        async summarize(context) {
          const headers = new Headers(req.headers);
          headers.delete("content-length"); headers.delete("content-encoding");
          const raw = requestState.parsed._rawBody as Record<string, unknown>;
          const body: Record<string, unknown> = { ...raw, model: `${requestState.route.providerName}/${requestState.route.modelId}`,
            stream: false, store: false, input: [{ type: "compaction_trigger" }] };
          delete body.previous_response_id;
          const started = Date.now();
          const childLog: RequestLogContext = { model: requestState.route.modelId, provider: requestState.route.providerName,
            conversationId: logCtx.conversationId };
          let status = 502;
          let succeeded = false;
          try {
            const child = new Request(req.url, { method: "POST", headers, body: JSON.stringify(body), signal: options.abortSignal });
            const response = await dispatchers.handleResponses(child, config, childLog, {
              translatorBudget: options.translatorBudget, sendBudget: options.sendBudget,
              abortSignal: options.abortSignal, turnAdmissionLease: options.turnAdmissionLease,
              admission: options.admission, openAiSidecarAuth: options.openAiSidecarAuth,
              nativeCallerAuth: options.nativeCallerAuth, callerDirectAuth: options.callerDirectAuth,
              internalDecisionCall: true, imageSummaryContext: context, recordTerminalOutcomes: false,
              compactionRecoveryAttempted: true, inboundTransport: options.inboundTransport,
            });
            status = response.status;
            const result = await response.json() as { status?: unknown; output?: Array<{ type?: string; encrypted_content?: unknown }> };
            const items = Array.isArray(result.output) ? result.output : [];
            const compactions = items.filter(item => item.type === "compaction");
            const text = compactions.length === 1 && typeof compactions[0]!.encrypted_content === "string"
              ? decodeCompactionSummary(compactions[0]!.encrypted_content) : null;
            if (!response.ok || result.status !== "completed" || !text?.trim()
              || items.some(item => !["compaction", "reasoning"].includes(item.type ?? ""))) {
              status = response.ok ? 502 : response.status;
              throw new ImageContextError("Image compaction failed to return a completed text-only summary.", status);
            }
            succeeded = true;
            return text;
          } finally {
            if (!succeeded) childLog.errorCode ??= "image_compaction_summary";
            addFinalRequestLog(`ocx-${crypto.randomUUID().replaceAll("-", "")}`, started, childLog, status);
          }
        },
      });
    } catch (error) {
      if (options.abortSignal?.aborted) return formatErrorResponse(499, "client_cancelled", "Client cancelled image compaction.");
      if (error instanceof ImageContextError) return formatErrorResponse(error.status, "image_compaction_failed", error.message);
      throw error;
    }
  };
}
