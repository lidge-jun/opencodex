/**
 * Adapter delivery straight into a Chat or Messages client's wire (PF-09).
 *
 * The streaming adapter branch normally bridges the guarded event stream into Responses SSE and
 * lets the ingress convert that into the client's wire. With a `clientEncoder` option the same
 * events are encoded directly instead; everything the bridge did besides framing keeps happening:
 *
 * - the events are also collected, charged to the request's translator budget, and folded with
 *   `buildResponseJSON` at the terminal, so the replay caches, `rememberResponseState`,
 *   `notifyResponseComplete` and `commitReasoningReplayServingRoute` see a completed response
 *   exactly when the bridge's `onCompletedResponse` would have fired;
 * - the key-usage binding receives the adapter usage under the bridge's rules;
 * - the stream is tracked for turn lifetime and stops the upstream the same way;
 * - the request log receives the facts its Responses SSE tap used to read (client-wire.ts).
 */
import type { AdapterEvent, OcxConfig, OcxProviderContinuationState, OcxReasoningReplayScopeRef, OcxUsage } from "../../types";
import type { AdmissionLease } from "../../lib/admission";
import {
  releaseTranslatedEvent,
  retainTranslatedEvent,
  type TranslatorBudget,
} from "../../lib/translator-budget";
import { buildResponseJSON } from "../../bridge";
import { responsesUsage, uuid } from "../../bridge/internal";
import { awaitThoughtSignatureDurability } from "../../responses/thought-signature-replay";
import { attemptDeliveryRecorder } from "../../usage/attempt-delivery";
import { encodeChatCompletionSse, collectChatCompletionResponse } from "../../protocols/encoders/chat";
import { encodeAnthropicMessageSse, collectAnthropicMessageResponse } from "../../protocols/encoders/messages";
import type { ClientEncodeHooks, EncodedTerminal } from "../../protocols/encoders/adapter-events";
import { upstreamWireForAdapter } from "../../protocols/contract";
import { markAttemptProtocolPath } from "../../protocols/trace";
import { deliveryModeForLane, requestPathForLane } from "../../protocols/path";
import { resolveProtocolSettings } from "../../protocols/settings";
import { trackStreamLifetime } from "../lifecycle";
import type { RequestLogContext } from "../request-log";
import type { ClientEncoderOption, HandleResponsesOptions } from "../responses/core-options";
import { attachClientWireLog, createClientWireLog, markClientWire } from "./client-wire";

const CLIENT_SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

/**
 * Whether a Chat or Messages ingress asks for direct encoding on the route it settled: the
 * rollout switch is on and the route is one concrete non-Responses target. Combo and policy
 * routes read or retry the Responses body after delivery, and a Responses-wire route is the
 * passthrough case this work leaves alone.
 */
export function directEncodersApply(
  config: Pick<OcxConfig, "protocols">,
  route: { combo?: unknown; routeKind?: string; provider: { adapter: string } } | null | undefined,
): boolean {
  if (!route || !resolveProtocolSettings(config).rollout.directEncoders) return false;
  if (route.combo !== undefined || route.routeKind === "policy") return false;
  return upstreamWireForAdapter(route.provider.adapter) !== "responses";
}

/**
 * The encoder this delivery may use, or undefined to keep the Responses body. The final route
 * is re-checked because core can still change it after the ingress decided: a combo child's
 * body is read by the combo's commit logic, a policy route may hop on an error body, a
 * compaction turn must emit its synthetic item, and a Responses-wire upstream stays as it is.
 */
export function clientEncoderForDelivery(
  options: Pick<HandleResponsesOptions, "clientEncoder" | "comboAttempt">,
  logCtx: Pick<RequestLogContext, "routeDecision">,
  routedCompaction: boolean,
  adapterName: string,
): ClientEncoderOption | undefined {
  const encoder = options.clientEncoder;
  if (!encoder || options.comboAttempt || routedCompaction) return undefined;
  if (logCtx.routeDecision?.routeKind === "policy" || logCtx.routeDecision?.routeKind === "combo") return undefined;
  if (upstreamWireForAdapter(adapterName) === "responses") return undefined;
  return encoder;
}

export interface ClientEncodedDelivery {
  encoder: ClientEncoderOption;
  events: AsyncIterable<AdapterEvent>;
  logCtx: RequestLogContext;
  translatorBudget: TranslatorBudget;
  /** Model on the folded response and the log payloads, as on the bridge's snapshots. */
  responseModelId: string;
  adapterName: string;
  fold: {
    replayCacheScope?: OcxReasoningReplayScopeRef;
    hideThinkingSummary?: boolean;
    toolNsMap?: Map<string, { namespace: string; name: string; freeform?: true }>;
    declaredToolNames?: ReadonlySet<string>;
    toolParameterSchemas?: ReadonlyMap<string, Record<string, unknown>>;
    freeformToolNames?: Set<string>;
    toolSearchToolNames?: Set<string>;
  };
  stallTimeoutSec?: number;
  turnAdmissionLease?: AdmissionLease;
  onFirstOutput?: () => void;
  /** The bridge's `onCancel`: stop completion notification and abort the upstream. */
  stopUpstream: () => void;
  /** Turn-lifetime cleanup when the client body finishes or is cancelled. */
  onStreamDone: () => void;
  /** The bridge's `onCompletedResponse`, fed the folded response. */
  onCompletedResponse: (response: Record<string, unknown>, providerState?: OcxProviderContinuationState) => void;
  /** The bridge's `onUsage`. */
  bindUsage: (usage: OcxUsage | undefined) => void;
}

/**
 * Record the attempt's observed path: the request still goes through the internal Responses
 * bridge until the codecs decode to IR directly, so the request path and mode stay the bridge's;
 * the response now reaches the client from the IR without the internal Responses hop.
 */
function markDirectEncoderPath(logCtx: RequestLogContext, encoder: ClientEncoderOption, adapter: string): void {
  const attempt = logCtx.activeAttempt;
  if (!attempt) return;
  const upstream = upstreamWireForAdapter(attempt.adapter || adapter);
  markAttemptProtocolPath(attempt, {
    mode: deliveryModeForLane(encoder.protocol, "bridge", upstream),
    requestPath: requestPathForLane(encoder.protocol, "bridge", upstream),
    responsePath: [upstream, "ir", encoder.protocol],
  });
}

export async function deliverClientEncodedResponse(input: ClientEncodedDelivery): Promise<Response> {
  const { encoder, logCtx, translatorBudget } = input;
  markDirectEncoderPath(logCtx, encoder, input.adapterName);
  const log = createClientWireLog();
  const responseId = `resp_${uuid()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const snapshot = (status: string): Record<string, unknown> => ({
    id: responseId, object: "response", created_at: createdAt,
    status, model: input.responseModelId, output: [], usage: null,
  });
  log.record({ kind: "observe", payload: { type: "response.created", response: snapshot("in_progress") } });

  // Collected copies: the adapter's own objects may already carry a lease from a buffered batch.
  const collected: AdapterEvent[] = [];
  let sealed = false;
  const releaseCollected = () => {
    sealed = true;
    for (const event of collected) releaseTranslatedEvent(event, translatorBudget);
    collected.length = 0;
  };
  const events = (async function* (): AsyncGenerator<AdapterEvent> {
    for await (const event of input.events) {
      if (!sealed) {
        const copy = { ...event } as AdapterEvent;
        retainTranslatedEvent(copy, translatorBudget, collected.at(-1));
        collected.push(copy);
      }
      yield event;
    }
  })();
  const fold = (): Record<string, unknown> | undefined => {
    if (sealed) return undefined;
    sealed = true;
    try {
      return buildResponseJSON(collected, input.responseModelId, {
        ...input.fold,
        enforceDeclaredToolNames: false,
        translatorBudget,
        recordBufferedDelivery: false,
      });
    } catch {
      return undefined;
    } finally {
      releaseCollected();
    }
  };

  const recorder = attemptDeliveryRecorder(translatorBudget);
  let completedResponseDelivered = false;
  const terminalPayload = (terminal: EncodedTerminal): Record<string, unknown> => ({
    type: terminal.status === "completed" ? "response.completed"
      : terminal.status === "failed" ? "response.failed"
      : "response.incomplete",
    response: {
      ...snapshot(terminal.status),
      ...(terminal.endTurn !== undefined ? { end_turn: terminal.endTurn } : {}),
      usage: terminal.usageOnWire ? responsesUsage(terminal.usage) : null,
      ...(terminal.incomplete ? { incomplete_details: { ...terminal.incomplete } } : {}),
      ...(terminal.error ? { error: terminal.error, last_error: terminal.error } : {}),
      ...(terminal.retryable !== undefined ? { retryable: terminal.retryable } : {}),
    },
  });
  const hooks: ClientEncodeHooks = {
    ...(input.onFirstOutput ? { onFirstOutput: input.onFirstOutput } : {}),
    async beforeTerminal(terminal) {
      const response = terminal.overflow ? (releaseCollected(), undefined) : fold();
      if (terminal.durable) await awaitThoughtSignatureDurability();
      if (terminal.completedResponse && response && !completedResponseDelivered) {
        completedResponseDelivered = true;
        input.onCompletedResponse(response, terminal.providerState);
      }
      if (terminal.reportUsage) input.bindUsage(terminal.usage);
    },
    afterTerminal(terminal) {
      log.record({ kind: "terminal", status: terminal.status, payload: terminalPayload(terminal) });
    },
    stopUpstream: input.stopUpstream,
    onClientCancel() {
      releaseCollected();
      log.record({ kind: "cancel" });
    },
    onRelayed(observation) {
      recorder?.noteRelayedEvent(observation);
    },
  };
  const encodeOptions = {
    model: encoder.model,
    translatorBudget,
    ...input.fold,
    ...(input.stallTimeoutSec !== undefined ? { stallTimeoutSec: input.stallTimeoutSec } : {}),
    hooks,
  };
  const encoded = encoder.protocol === "chat"
    ? encodeChatCompletionSse(events, encodeOptions)
    : encodeAnthropicMessageSse(events, {
      ...encodeOptions,
      ...(encoder.inputTokenFloor !== undefined ? { inputTokenFloor: encoder.inputTokenFloor } : {}),
    });
  const tracked = trackStreamLifetime(encoded, new AbortController(), input.onStreamDone, input.turnAdmissionLease);

  let response: Response;
  if (encoder.stream) {
    response = new Response(tracked, { status: 200, headers: CLIENT_SSE_HEADERS });
  } else {
    // The routed turn always streams internally; a non-streaming client gets the fold.
    response = encoder.protocol === "chat"
      ? await collectChatCompletionResponse(tracked, encoder.model, translatorBudget)
      : await collectAnthropicMessageResponse(tracked, encoder.model, translatorBudget);
  }
  return attachClientWireLog(markClientWire(response, encoder.protocol), log);
}
