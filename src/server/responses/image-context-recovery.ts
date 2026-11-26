import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "../../adapters/base";
import type { OcxParsedRequest } from "../../types";
import type { PhysicalSendReporter } from "../../lib/request-execution-budget";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { readDisplaySafeErrorText } from "./core-errors";
import { isRewrittenUpstreamError, markRewrittenUpstreamError } from "../../adapters/upstream-http-error";
import { carryProxyError, isProxyError } from "../../lib/client-error-body";
import { checkOutboundBodySize } from "./outbound-body-guard";
import { releaseTranslatedEvent, type TranslatorBudget } from "../../lib/translator-budget";
import { carryReplayRefusal, hasUpstreamReplayRefusal, isAutomaticReplayBlocked, projectReplayRefusal, replayRefusalBodyCode, SendBudgetExhaustedError } from "../../lib/upstream-retry";
import { COMPACT_PROMPT, SUMMARY_PREFIX } from "../../responses/compaction";
import { sameProviderContinuationOwner } from "../../responses/provider-continuation";
import { deferPhysicalSendReporter } from "./deferred-send-reporter";
import { fetchWithHeaderTimeout, providerFetch } from "./fetch-helpers";
import { transientSendCapFor, type ResponsesSendBudget } from "./request-send-budget";
import { bindAdapterResponseSpend } from "./request-spend";
import { splitAnthropicImageContext } from "./anthropic-image-context";
import type { ResponsesRequestContext } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import { transientRetryPolicyFor } from "../../providers/key-failover";

type RecoveryBudget = Pick<ResponsesSendBudget, "remainingTransientSendBudget" | "targetSendsUsed" | "imageRecoverySendReporter">;
type ImageRecoveryTransport = Pick<ResponsesTransport, "pinAnthropicImageRecovery" | "noteRoutedAttemptSend">;
type RecoveredExchange = { response: Response; request?: AdapterRequest };
const SUMMARY_MAX_TOKENS = 1024;

function wireOutputLimit({ body }: AdapterRequest): number | undefined {
  const { max_tokens } = JSON.parse(body) as { max_tokens: number };
  return Number.isSafeInteger(max_tokens) && max_tokens > 0 ? max_tokens : undefined;
}

export type AnthropicImageRecovery = (
  response: Response, parsed: OcxParsedRequest, adapter: ProviderAdapter, signal: AbortSignal,
) => Promise<RecoveredExchange>;

/** Preserve the bounded refusal while releasing its original pacing lease. */
export async function retainAdapterFailureResponse(response: Response, signal: AbortSignal): Promise<{
  response: Response; text: string;
}> {
  // Same contract as readDisplaySafeErrorText, but remembering whether the whole body survived: a
  // retained copy of a truncated, unsafe or unreadable body is not the provider's evidence (#9017).
  let text = "";
  let complete = false;
  try {
    const body = await readBoundedResponseBody(response, { signal });
    text = body.displaySafe ? body.text : "";
    complete = body.displaySafe && !body.truncated;
  } catch {
    text = "";
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const retained = new Response(text, { status: response.status, statusText: response.statusText, headers });
  if (!complete || isRewrittenUpstreamError(response)) markRewrittenUpstreamError(retained);
  return { response: carryReplayRefusal(response, carryProxyError(response, retained)), text };
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
      || response.status !== 413 || isProxyError(response)) return { response };
    const vetoed = await hasUpstreamReplayRefusal(response, signal, { requireCompleteBody: true });
    signal.throwIfAborted();
    if (vetoed) return { response };
    const owner = parsed._providerContinuationOwner;
    const pin = transport.pinAnthropicImageRecovery(response);
    if (!owner || !pin || !sameProviderContinuationOwner(owner, pin.owner)) return { response };
    const split = splitAnthropicImageContext(parsed.context.messages);
    if (!split || !adapter.parseResponse || !pin.request.body.includes('"type":"image"')) return { response };

    const total = transientRetryPolicyFor(route.provider)?.attempts;
    const remaining = () => budget.remainingTransientSendBudget(transientSendCapFor(total, budget.targetSendsUsed));
    if (remaining() < 2) return { response };
    const { response: retained, text } = await retainAdapterFailureResponse(response, signal);
    signal.throwIfAborted();
    const originalRefusalCode = replayRefusalBodyCode(text);
    if (originalRefusalCode) return { response: carryReplayRefusal(retained, projectReplayRefusal(originalRefusalCode)) };
    // Require a provider size refusal and an actual image-bearing, compactable history.
    if (recoveryAttempted.has(translatorBudget)
      || !/request_too_large|payload_too_large|(?:request|payload|image|body)[^\n]{0,60}too large/i.test(text)) {
      return { response: retained };
    }
    recoveryAttempted.add(translatorBudget);
    const originalBytes = Buffer.byteLength(pin.request.body, "utf8");
    const incoming: IncomingMeta = { headers: selectedForwardHeaders, completedToolBlocks,
      providerName: route.providerName, translatorBudget, abortSignal: signal };
    const send = async (wire: AdapterRequest, input: OcxParsedRequest, minimum: number, outputLimit: number) => {
      signal.throwIfAborted();
      if (!pin.isCurrent() || remaining() < minimum) throw new SendBudgetExhaustedError();
      const physical = budget.imageRecoverySendReporter(wire.body, outputLimit);
      const receipt = deferPhysicalSendReporter(physical);
      try {
        const run = () => fetchWithHeaderTimeout(wire.url, {
          method: wire.method, headers: wire.headers, body: wire.body,
        }, signal, connectMs, input.stream, providerFetch(route.provider, options.codexWsRuntimeIdentity, {
          httpOnly: true, providerName: route.providerName, modelId: route.modelId,
          dispatchOverride: pin.dispatchOverride(wire, input),
          onPhysicalDispatch: () => {
            if (remaining() < minimum || !receipt.beforeDispatch()) throw new SendBudgetExhaustedError();
            if (input._anthropicImageSummary) pin.recordRefusalSpend?.();
            transport.noteRoutedAttemptSend(undefined, "image-413");
          },
        }));
        const response = await (receipt.report.execute ? receipt.report.execute(run) : run());
        return { response, recordUsage: physical.recordUsage };
      } finally {
        receipt.report.close?.();
      }
    };
    const fits = (wire: AdapterRequest) => Buffer.byteLength(wire.body, "utf8") < originalBytes
      && checkOutboundBodySize(wire.body, config.maxUpstreamBodyBytes).admitted;
    let terminalSummary: Response | undefined;
    try {
      signal.throwIfAborted();
      if (!pin.isCurrent()) return { response: retained };
      const originalLimit = wireOutputLimit(pin.request);
      if (originalLimit === undefined) return { response: retained };
      const summaryLimit = Math.min(originalLimit, SUMMARY_MAX_TOKENS);
      const summaryInput: OcxParsedRequest = {
        ...parsed, stream: false, _anthropicImageOwner: owner, _anthropicImageSummary: true,
        _anthropicServerTools: undefined, _anthropicServerReplay: undefined,
        options: { toolChoice: "none", reasoning: "none", thinkingEnabled: false, maxOutputTokens: summaryLimit },
        context: { ...parsed.context, tools: undefined, messages: [...split.history, {
          role: "user", timestamp: 0,
          content: `${COMPACT_PROMPT}\n\nReturn only the handoff summary. Do not call tools or continue the task.`,
        }] },
      };
      const summaryRequest = await adapter.buildRequest(summaryInput, incoming);
      let summarySend: Awaited<ReturnType<typeof send>>;
      try {
        if (!fits(summaryRequest) || !summaryRequest.body.includes('"type":"image"')) return { response: retained };
        const outputLimit = wireOutputLimit(summaryRequest);
        if (outputLimit === undefined || outputLimit > summaryLimit) return { response: retained };
        summarySend = await send(summaryRequest, summaryInput, 2, outputLimit);
      } finally { summaryRequest.releaseBodyObservation?.(); }
      const { response: summaryResponse, recordUsage: recordSummaryUsage } = summarySend;
      carryReplayRefusal(summaryResponse, retained);
      if (!summaryResponse.ok) {
        if (await hasUpstreamReplayRefusal(summaryResponse, signal)) return { response: summaryResponse };
        const summaryText = await readDisplaySafeErrorText(summaryResponse, signal, "");
        const refusalCode = replayRefusalBodyCode(summaryText);
        if (refusalCode) return { response: carryReplayRefusal(summaryResponse, projectReplayRefusal(refusalCode)) };
        return { response: retained };
      }
      const payload = await readBoundedResponseBody(summaryResponse, { signal });
      if (!payload.displaySafe) return { response: retained };
      const refusalCode = replayRefusalBodyCode(payload.text);
      if (refusalCode) terminalSummary = carryReplayRefusal(summaryResponse, projectReplayRefusal(refusalCode));
      const { content } = JSON.parse(payload.text) as { content?: Array<{ type?: unknown }> };
      const textOnly = Array.isArray(content)
        && content.every(block => ["text", "thinking", "redacted_thinking"].includes(String(block?.type)));
      const events = await adapter.parseResponse(new Response(payload.text, { headers: summaryResponse.headers }),
        translatorBudget, summaryRequest.tierLog);
      let summary = "";
      let completed = false;
      let invalid = false;
      for (const event of events) {
        if ("usage" in event && event.usage) recordSummaryUsage?.(event.usage);
        if (event.type === "done") completed = event.stopReason === "end_turn" || event.stopReason === "stop_sequence";
        else if (event.type === "text_delta" && !event.anthropicThinkingSignature) summary += event.text;
        else if (event.type.startsWith("tool_call") || event.type.startsWith("web_search")
          || event.type === "error" || event.type === "incomplete") invalid = true;
        releaseTranslatedEvent(event, translatorBudget);
      }
      if (terminalSummary) return { response: terminalSummary };
      if (!textOnly || invalid || !completed || !summary.trim() || isAutomaticReplayBlocked(summaryResponse)) return { response: retained };

      const successor: OcxParsedRequest = { ...parsed, _anthropicImageOwner: owner,
        context: { ...parsed.context, messages: [
          { role: "user", timestamp: 0, content: `${SUMMARY_PREFIX}\n\n${summary}` }, ...split.retained,
        ] },
      };
      const request = await adapter.buildRequest(successor, incoming);
      try {
        if (!fits(request)) return { response: retained };
        const outputLimit = wireOutputLimit(request);
        if (outputLimit === undefined) return { response: retained };
        const { response: replacement, recordUsage } = await send(request, successor, 1, outputLimit);
        if (replacement.ok) {
          bindAdapterResponseSpend(replacement, recordUsage);
          parsed.context.messages = successor.context.messages;
          parsed._anthropicImageOwner = owner;
        }
        return { response: replacement, request };
      } finally { request.releaseBodyObservation?.(); }
    } catch (error) {
      if (signal.aborted) throw error;
      return { response: terminalSummary ?? retained };
    }
  };
}
