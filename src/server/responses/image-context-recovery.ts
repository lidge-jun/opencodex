import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "../../adapters/base";
import type { OcxParsedRequest } from "../../types";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { carryProxyError, isProxyError } from "../../lib/client-error-body";
import { checkOutboundBodySize } from "./outbound-body-guard";
import { releaseTranslatedEvent, type TranslatorBudget } from "../../lib/translator-budget";
import { isNonReplayableResponse, SendBudgetExhaustedError } from "../../lib/upstream-retry";
import { COMPACT_PROMPT, SUMMARY_PREFIX } from "../../responses/compaction";
import { sameProviderContinuationOwner } from "../../responses/provider-continuation";
import { readDisplaySafeErrorText } from "./core-errors";
import { deferPhysicalSendReporter } from "./deferred-send-reporter";
import { fetchWithHeaderTimeout, providerFetch } from "./fetch-helpers";
import { transientSendCapFor, type ResponsesSendBudget } from "./request-send-budget";
import { splitAnthropicImageContext } from "./anthropic-image-context";
import type { ResponsesRequestContext } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import { transientRetryPolicyFor } from "../../providers/key-failover";

type RecoveryBudget = Pick<ResponsesSendBudget, "remainingTransientSendBudget" | "targetSendsUsed" | "imageRecoverySendReporter">;
type ImageRecoveryTransport = Pick<ResponsesTransport, "pinAnthropicImageRecovery" | "noteRoutedAttemptSend">;
type RecoveredExchange = { response: Response; request?: AdapterRequest };

export type AnthropicImageRecovery = (
  response: Response, parsed: OcxParsedRequest, adapter: ProviderAdapter, signal: AbortSignal,
) => Promise<RecoveredExchange>;

/** Preserve the bounded refusal while releasing its original pacing lease. */
export async function retainAdapterFailureResponse(response: Response, signal: AbortSignal): Promise<{
  response: Response; text: string;
}> {
  const text = await readDisplaySafeErrorText(response, signal, "");
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const retained = new Response(text, { status: response.status, statusText: response.statusText, headers });
  return { response: carryProxyError(response, retained), text };
}

export async function recoverAdapterImageContext(
  recover: AnthropicImageRecovery, response: Response, parsed: OcxParsedRequest,
  transport: Pick<ResponsesTransport, "activeAdapter" | "sameTargetRequest" | "sameTargetParsed" | "sameTargetToken" | "transportToken">,
  signal: AbortSignal, refreshToolAliases: (request: AdapterRequest) => void,
): Promise<Response | undefined> {
  try {
    const recovered = await recover(response, parsed, transport.activeAdapter, signal);
    if (recovered.request) {
      transport.sameTargetRequest = recovered.request;
      transport.sameTargetParsed = parsed;
      transport.sameTargetToken = transport.transportToken;
      refreshToolAliases(recovered.request);
    }
    return recovered.response;
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

// The ingress translator budget is shared by combo targets and compaction attempts.
const recoveryAttempted = new WeakSet<TranslatorBudget>();

/** One summary and one resend, using the original route, pacing, ledger and caller signal. */
export function createAnthropicImageRecovery(
  { config, options }: Pick<ResponsesRequestContext, "config" | "options">,
  { route, translatorBudget, selectedForwardHeaders, completedToolBlocks }: Pick<PreparedResponsesRequest,
    "route" | "translatorBudget" | "selectedForwardHeaders" | "completedToolBlocks">,
  transport: ImageRecoveryTransport,
  budget: RecoveryBudget,
  connectMs: number,
): AnthropicImageRecovery {
  return async (response, parsed, adapter, signal) => {
    if (recoveryAttempted.has(translatorBudget) || adapter.name !== "anthropic" || parsed._compactionRequest
      || response.status !== 413 || isProxyError(response) || isNonReplayableResponse(response)) return { response };
    signal.throwIfAborted();
    const owner = parsed._providerContinuationOwner;
    const pin = transport.pinAnthropicImageRecovery(response);
    if (!owner || !pin || !sameProviderContinuationOwner(owner, pin.owner)) return { response };
    const split = splitAnthropicImageContext(parsed.context.messages);
    if (!split || !adapter.parseResponse || !pin.request.body.includes('"type":"image"')) return { response };

    const total = transientRetryPolicyFor(route.provider)?.attempts;
    const remaining = () => budget.remainingTransientSendBudget(transientSendCapFor(total, budget.targetSendsUsed));
    if (remaining() < 2) return { response };
    const { response: retained, text } = await retainAdapterFailureResponse(response, signal);
    // Require a provider size refusal and an actual image-bearing, compactable history.
    if (recoveryAttempted.has(translatorBudget)
      || !/request_too_large|payload_too_large|(?:request|payload|image|body)[^\n]{0,60}too large/i.test(text)) {
      return { response: retained };
    }
    recoveryAttempted.add(translatorBudget);
    const originalBytes = Buffer.byteLength(pin.request.body, "utf8");
    const incoming: IncomingMeta = { headers: selectedForwardHeaders, completedToolBlocks,
      providerName: route.providerName, translatorBudget, abortSignal: signal };
    const send = async (wire: AdapterRequest, input: OcxParsedRequest, minimum: number): Promise<Response> => {
      signal.throwIfAborted();
      if (!pin.isCurrent() || remaining() < minimum) throw new SendBudgetExhaustedError();
      const receipt = deferPhysicalSendReporter(budget.imageRecoverySendReporter(wire.body, (JSON.parse(wire.body) as { max_tokens: number }).max_tokens));
      try {
        const run = () => fetchWithHeaderTimeout(wire.url, {
          method: wire.method, headers: wire.headers, body: wire.body,
        }, signal, connectMs, input.stream, providerFetch(route.provider, options.codexWsRuntimeIdentity, {
          httpOnly: true, providerName: route.providerName, modelId: route.modelId,
          dispatchOverride: pin.dispatchOverride(wire, input),
          onPhysicalDispatch: () => {
            if (remaining() < minimum || !receipt.beforeDispatch()) throw new SendBudgetExhaustedError();
            transport.noteRoutedAttemptSend(undefined, "image-413");
          },
        }));
        return await (receipt.report.execute ? receipt.report.execute(run) : run());
      } finally {
        receipt.report.close?.();
      }
    };
    const fits = (wire: AdapterRequest) => Buffer.byteLength(wire.body, "utf8") < originalBytes
      && checkOutboundBodySize(wire.body, config.maxUpstreamBodyBytes).admitted;
    try {
      signal.throwIfAborted();
      if (!pin.isCurrent()) return { response: retained };
      const { max_tokens } = JSON.parse(pin.request.body) as { max_tokens: number };
      if (!Number.isSafeInteger(max_tokens) || max_tokens <= 0) return { response: retained };
      const summaryInput: OcxParsedRequest = {
        ...parsed, stream: false, _anthropicImageOwner: owner,
        _anthropicServerTools: undefined, _anthropicServerReplay: undefined,
        options: { toolChoice: "none", maxOutputTokens: Math.min(max_tokens, 1024) },
        context: { ...parsed.context, tools: undefined, messages: [...split.history, {
          role: "user", timestamp: 0,
          content: `${COMPACT_PROMPT}\n\nReturn only the handoff summary. Do not call tools or continue the task.`,
        }] },
      };
      const summaryRequest = await adapter.buildRequest(summaryInput, incoming);
      let summaryResponse: Response;
      try {
        if (!fits(summaryRequest) || !summaryRequest.body.includes('"type":"image"')) return { response: retained };
        summaryResponse = await send(summaryRequest, summaryInput, 2);
      } finally { summaryRequest.releaseBodyObservation?.(); }
      if (!summaryResponse.ok) {
        void summaryResponse.body?.cancel().catch(() => {});
        return { response: retained };
      }
      const payload = await readBoundedResponseBody(summaryResponse, { signal });
      if (!payload.displaySafe) return { response: retained };
      const { content } = JSON.parse(payload.text) as { content?: Array<{ type?: unknown }> };
      const textOnly = Array.isArray(content)
        && content.every(block => ["text", "thinking", "redacted_thinking"].includes(String(block?.type)));
      const events = await adapter.parseResponse(new Response(payload.text, { headers: summaryResponse.headers }),
        translatorBudget, summaryRequest.tierLog);
      let summary = "";
      let completed = false;
      let invalid = false;
      for (const event of events) {
        if (event.type === "done") completed = event.stopReason === "end_turn" || event.stopReason === "stop_sequence";
        else if (event.type === "text_delta" && !event.anthropicThinkingSignature) summary += event.text;
        else if (event.type.startsWith("tool_call") || event.type.startsWith("web_search")
          || event.type === "error" || event.type === "incomplete") invalid = true;
        releaseTranslatedEvent(event, translatorBudget);
      }
      if (!textOnly || invalid || !completed || !summary.trim()) return { response: retained };

      const successor: OcxParsedRequest = { ...parsed, _anthropicImageOwner: owner,
        context: { ...parsed.context, messages: [
          { role: "user", timestamp: 0, content: `${SUMMARY_PREFIX}\n\n${summary}` }, ...split.retained,
        ] },
      };
      const request = await adapter.buildRequest(successor, incoming);
      try {
        if (!fits(request)) return { response: retained };
        const replacement = await send(request, successor, 1);
        if (replacement.ok) {
          parsed.context.messages = successor.context.messages;
          parsed._anthropicImageOwner = owner;
        }
        return { response: replacement, request };
      } finally { request.releaseBodyObservation?.(); }
    } catch (error) {
      if (signal.aborted) throw error;
      return { response: retained };
    }
  };
}
