import { isNativeControlResponse } from "./native-response-control";
import type { ResponsesRequestContext, ResponsesAdmissionState } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import type { ResponsesSidecarAuth } from "./request-sidecar-auth";
import type { ResponsesEffects } from "./response-effects";
import type { PassthroughExchange } from "./passthrough-dispatch";
import {
  sanitizePassthroughHeaders,
  createSseInspector,
  markEagerRelaySseResponse,
  markNativePassthroughSseResponse,
  consumeForInspection,
  consumeForResponseLogMetadata,
  relaySseWithFailedTail,
  relayWithAbort,
} from "../relay";
import { isUsageDebugEnabled } from "../../usage/debug";
import { isReplayRefusalResponse } from "../../lib/upstream-retry";
import { teeWithBoundedInspection } from "../inspection-tee";
import {
  codexForwardTerminalOutcomeRecorder,
  usesCodexForwardPoolAuth,
  codexQuotaOutcomeMeta,
  codexDenialOutcomeMeta,
  isFixedCodexAccount,
  shouldDeferCodexResetDerivedCooldown,
} from "./core-codex-account";
import type { ResponsesTerminalStatus } from "../../bridge";
import { isCodexWsQuotaObservedResponse, isCodexWsUpstreamResponse } from "./ws-upstream";
import { recordSubagentQuotaFailureForThreadSpawn } from "../../codex/subagent-model-fallback";
import { recordCodexUpstreamOutcome } from "../../codex/routing";
import { codexProbeLeaseId, codexProbeQuotaScope, codexTransientProbeGrant, releaseCodexAuthContextProbeLease } from "../../codex/auth-context";
import { consumeComboFailure } from "./core-combo-failure";
import { readDisplaySafeErrorText } from "./core-errors";
import { streamingContextOverflowResponse, jsonContextOverflowResponse } from "./context-overflow";
import { formatPassthroughUpstreamError } from "./passthrough-error";
import { rewriteUpstreamPolicyRefusal } from "./policy-refusal";
import {
  resolvePassthroughWebSearchBridgeAuth,
  planPassthroughWebSearchBridge,
  createPassthroughWebSearchBridgeStream,
  createPassthroughWebSearchBridgeExecutor,
} from "../../web-search/passthrough-bridge";
import { bridgeSearchReplayScope } from "../../responses/bridge-search-replay-cache";
import { fetchWithHeaderTimeout, providerFetch } from "./fetch-helpers";
import { providerApiKeySelectionIsCurrent } from "../../providers/api-key-selection";
import { requiresVisionPreprocessing } from "../../vision";
import { checkOutboundBodySize, describeOutboundBodyRefusal } from "./outbound-body-guard";
import { relayResponsesSseWithTerminalRepair } from "../responses-terminal-repair";
import {
  hasResponsesSnapshotRepair,
  createResponsesSnapshotBlockRewrite,
} from "../responses-snapshot-repair";
import { createResponsesModelPayloadRewrite, rewriteResponsesModelJson } from "../responses-model-rewrite";
import { createImageGenCallRestoreRewrite, restoreImageGenCallsInJson } from "../responses-image-gen-repair";
import {
  createSelfNamedToolCallNamespaceScrubRewrite,
  scrubSelfNamedToolCallNamespaceInJson,
} from "../responses-self-named-namespace-scrub";
import {
  createMuseToolNameRestoreRewrite,
  restoreMuseToolNamesInJson,
} from "../../responses/muse-tool-name-alias";
import {
  createRoutedNamespaceCallRestoreRewrite,
  restoreRoutedNamespaceCallsInJson,
} from "../../responses/namespace-tool-compat";
import {
  hasResponsesItemIdRepair,
  createResponsesItemIdPayloadRewrite,
  repairResponsesJsonItemIds,
} from "../responses-item-id-repair";
import {
  payloadRewriteAsBlockRewrite,
  composeSsePayloadRewrites,
  composeSseBlockRewrites,
  relaySseWithBlockRewrite,
} from "../sse-payload-rewrite";
import { createRoutedCustomToolRestoreBlockRewrite } from "../responses-custom-tool-repair";
import { createRoutedToolSearchRestoreBlockRewrite } from "../responses-tool-search-repair";
import { createGithubCopilotResponsesBlockRewrite } from "../github-copilot-responses-repair";
import {
  createGrokResponsesControlFrameBlockRewrite,
  createGrokResponsesTimestampBlockRewrite,
} from "../grok-responses-control-frame";
import { createGrokResponsesSparseTerminalBlockRewrite } from "../grok-responses-snapshot-repair";
import { isXaiResponsesDestination } from "../../providers/xai-transport";
import {
  createGrokUpstreamEnvelopeEchoBlockRewrite,
  responsesRequestMayReplayToolOutput,
  stripGrokUpstreamEnvelopeEchoFromResponsesJson,
} from "../grok-upstream-envelope-echo";
import {
  createPlaintextV2AgentMessageCallRestoreRewrite,
  restorePlaintextV2AgentMessageCallsInJsonResult,
  PLAINTEXT_V2_AGENT_MESSAGE_RESTORE_OVERFLOW_MESSAGE,
} from "../../responses/plaintext-v2-agent-messages";
import { createResponsesFieldBackfillBlockRewrite } from "./responses-field-backfill";
import { createResponsesFunctionToolRepairBlockRewrite } from "../responses-function-tool-repair";
import {
  createUndeclaredToolCallGuardBlockRewrite,
  currentTurnWireToolCatalogBody,
  undeclaredToolCallNameInResponse,
  undeclaredToolCallMessage,
  normalizeDefaultNamespaceInJson,
} from "../responses-undeclared-tool-guard";
import { isZenFreeEndpoint, zenFreeHasApiKey } from "../../adapters/opencode-free-session";
import { ZEN_FREE_GATE_NAMES, zenFreeGateGuidanceText } from "../../adapters/opencode-free-tools";
import { isWin32EagerRewrite, selectEagerPath } from "../../lib/bun-stream-caps";

/**
 * Platform override for the two relay-path policy calls below. Tests only.
 *
 * The eager relay is reachable only on win32 and darwin, so a Linux shard cannot exercise it
 * without claiming to be one of them. Overwriting `process.platform` globally does that, and a
 * great deal more: every filesystem, ACL and state-directory decision in the process follows it,
 * and the spend-ledger owner lowercases its home on win32, which on a case-sensitive filesystem
 * names a DIFFERENT directory. A row that did that stopped being able to reserve its send and
 * delivered no terminal at all, reporting as a relay defect. This narrows the claim to the two
 * calls that actually choose the relay path.
 */
let relayPlatformForTests: NodeJS.Platform | undefined;

/** Internal test contract, not operator configuration: no config key reaches this. */
export function setRelayPlatformForTests(platform: NodeJS.Platform | undefined): void {
  relayPlatformForTests = platform;
}
import { linkAbortSignal, UPSTREAM_JSON_BODY_READ_OPTIONS } from "./core-lifetime";
import { registerTurn, unregisterTurn, trackStreamLifetime } from "../lifecycle";
import { relaySseEagerBounded } from "../relay-eager";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { idleDeadline } from "../../lib/abort";
import { resolveStallTimeoutMs } from "../../stall-timeout";
import { formatErrorResponse } from "../../bridge";
import { inspectResponseLogJson } from "../request-log";
import { restoreRoutedCustomCallsInJson } from "../../responses/custom-tool-compat";
import { restoreRoutedToolSearchCallsInJson } from "../../responses/tool-search-compat";
import { responsesJsonToSseStream } from "../responses-json-events";

const PLAINTEXT_V2_SSE_PREFIX_LIMIT = 4096;

/** Prefix-probe budget: bounds one silent gap and the whole probe alike. */
interface PlaintextV2SseProbeOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

function classifyPlaintextV2SsePrefix(prefix: string): "sse" | "unknown" | "more" {
  const lastLineEnd = prefix.lastIndexOf("\n");
  if (lastLineEnd < 0) return "more";
  for (const rawLine of prefix.slice(0, lastLineEnd + 1).split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line || line.startsWith(":")) continue;
    if (/^(id|retry):/.test(line)) continue;
    if (line.startsWith("event:")) {
      return /^event:\s*(?:response\.[\w.-]+|error)$/.test(line) ? "sse" : "unknown";
    }
    if (line.startsWith("data:")) {
      try {
        const value = JSON.parse(line.slice(5).trim()) as { type?: unknown };
        return typeof value.type === "string" && /^(?:response\.[\w.-]+|error)$/.test(value.type)
          ? "sse" : "unknown";
      } catch {
        return "unknown";
      }
    }
    return "unknown";
  }
  return "more";
}

/**
 * Confirm an unlabeled successful body is Responses SSE before alias restoration.
 *
 * The probe waits at most `timeoutMs` for a first recognized event, then hands the body to the
 * client with no deadline of its own: a stall in the prefix is a probe failure, and a stall after
 * it belongs to the delivered stream.
 */
async function classifyPlaintextV2SseResponse(
  response: Response,
  probe: PlaintextV2SseProbeOptions,
): Promise<Response> {
  if (!response.body) return response;
  const reader = response.body.getReader();
  // A non-conforming stream can throw synchronously from cancel(); neither that nor a
  // rejected cancel may escape past the probe's own deadline.
  const cancelReader = (reason?: unknown): void => {
    try {
      void reader.cancel(reason).catch(() => undefined);
    } catch {
      // Some stream implementations throw synchronously from cancel().
    }
  };
  const unrecognized = (): Response => new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  const { timeoutMs, signal } = probe;
  const stalled = new DOMException("Plaintext V2 SSE prefix probe stalled", "TimeoutError");
  let rejectProbe: ((reason: unknown) => void) | undefined;
  const failed = new Promise<never>((_resolve, reject) => { rejectProbe = reject; });
  // The race below always observes this rejection; this covers a deadline that fires after the
  // race already settled with a chunk, which would otherwise be an unhandled rejection.
  void failed.catch(() => undefined);
  const inactivity = idleDeadline(timeoutMs, () => rejectProbe?.(stalled));
  // A drip-fed body can restart the inactivity window forever, so the probe also carries one
  // total budget that starts when the probe begins.
  const totalTimer = timeoutMs > 0 ? setTimeout(() => rejectProbe?.(stalled), timeoutMs) : undefined;
  const onAbort = (): void => rejectProbe?.(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const decoder = new TextDecoder();
  const buffered: Uint8Array[] = [];
  let prefix = "";
  let inspectedBytes = 0;
  try {
    while (inspectedBytes < PLAINTEXT_V2_SSE_PREFIX_LIMIT) {
      if (signal?.aborted) throw signal.reason;
      // Armed for every read, so a chunk that arrives restarts the window at the next iteration.
      inactivity.reset();
      const read = reader.read();
      // Observe a late read rejection when the deadline or the client wins the race.
      void read.catch(() => undefined);
      const next = await Promise.race([read, failed]);
      if (signal?.aborted) throw signal.reason;
      if (next.done) break;
      buffered.push(next.value);
      const inspected = next.value.subarray(0, PLAINTEXT_V2_SSE_PREFIX_LIMIT - inspectedBytes);
      inspectedBytes += inspected.byteLength;
      prefix += decoder.decode(inspected, { stream: true });
      const kind = classifyPlaintextV2SsePrefix(prefix);
      if (kind === "sse") {
        let bufferedIndex = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (bufferedIndex < buffered.length) {
              controller.enqueue(buffered[bufferedIndex++]!);
              return;
            }
            try {
              const result = await reader.read();
              if (result.done) controller.close();
              else controller.enqueue(result.value);
            } catch (error) {
              controller.error(error);
            }
          },
          cancel(reason) { return reader.cancel(reason); },
        });
        const headers = new Headers(response.headers);
        headers.set("content-type", "text/event-stream");
        return new Response(body, { status: response.status, statusText: response.statusText, headers });
      }
      if (kind === "unknown") break;
    }
  } catch (error) {
    // Timeout, client abort, or a failed read fails closed through the unrecognized-body exit,
    // which the caller already answers as the unsupported-content-type 502.
    cancelReader(error);
    return unrecognized();
  } finally {
    inactivity.cancel();
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    signal?.removeEventListener("abort", onAbort);
  }
  cancelReader();
  return unrecognized();
}

/** One responsibility of the Responses request pipeline; state owners are explicit. */
export async function deliverPassthroughResponse(
  requestContext: Pick<ResponsesRequestContext, "logCtx" | "config" | "options" | "req">,
  admissionState: ResponsesAdmissionState,
  requestState: Pick<
    PreparedResponsesRequest,
    | "parsed"
    | "route"
    | "subagentQuotaFailureModel"
    | "subagentFallbackAccountId"
    | "clientRequestedStream"
    | "translatorBudget"
  >,
  transportState: Pick<ResponsesTransport, "requestBindings">,
  sidecarState: Pick<ResponsesSidecarAuth, "openAiSidecar">,
  responseEffects: Pick<
    ResponsesEffects,
    | "plaintextV2AgentMessageToolNames"
    | "commitReasoningReplayServingRoute"
    | "routedMuseToolNameAliases"
    | "routedNamespaceToolAliases"
    | "plaintextV2AgentMessageAliasedToolNames"
    | "recordTerminalOutcomes"
    | "responseCompletionCancelled"
  >,
  nativeExchange: Pick<
    PassthroughExchange,
    | "upstreamResponse"
    | "codexSafetyBufferingOptions"
    | "upstream"
    | "request"
    | "connectMs"
    | "imageGenCallAliases"
    | "selfNamedNamespaceScrubAuthorization"
    | "authorizedBareNamespaceToolAliases"
    | "rememberPassthroughResponseChecked"
    | "routedCustomToolNames"
    | "routedCustomToolRepairNames"
    | "declaredWireToolNames"
    | "routedToolSearchNames"
    | "outboundRequestBody"
    | "functionRepairSchemas"
    | "undeclaredToolGuardActive"
    | "declaredNamelessClientCallTypes"
    | "providerExecutedCallTypes"
    | "declaredBareWireToolNames"
    | "rememberPassthroughResponse"
    | "noteInspectedPayload"
    | "normalizeFunctionCompletionJson"
    | "localUpstream"
  >,
): Promise<Response> {
  const { logCtx, config, options, req } = requestContext;
  const {
    codexSafetyBufferingOptions,
    upstream,
    connectMs,
    imageGenCallAliases,
    selfNamedNamespaceScrubAuthorization,
    authorizedBareNamespaceToolAliases,
    rememberPassthroughResponseChecked,
    routedCustomToolNames,
    routedCustomToolRepairNames,
    declaredWireToolNames,
    routedToolSearchNames,
    functionRepairSchemas,
    declaredNamelessClientCallTypes,
    providerExecutedCallTypes,
    declaredBareWireToolNames,
    rememberPassthroughResponse,
    noteInspectedPayload,
    normalizeFunctionCompletionJson,
  } = nativeExchange;
  const { commitReasoningReplayServingRoute, recordTerminalOutcomes } = responseEffects;
  const { parsed, route, subagentQuotaFailureModel, clientRequestedStream, translatorBudget } = requestState;
  const { openAiSidecar } = sidecarState;
  const { requestBindings } = transportState;

  let upstreamResponse = nativeExchange.upstreamResponse;
  const originalContentType = upstreamResponse.headers.get("content-type");
  if (isUsageDebugEnabled() && originalContentType) logCtx.usageDebugContentType = originalContentType;
  if (responseEffects.plaintextV2AgentMessageToolNames.size > 0
    && upstreamResponse.ok && upstreamResponse.body && parsed.stream
    && !originalContentType?.toLowerCase().includes("text/event-stream")
    && !originalContentType?.toLowerCase().includes("application/json")
    && !isCodexWsUpstreamResponse(upstreamResponse)
    && !(options.nativeControl && isNativeControlResponse(upstreamResponse))) {
    upstreamResponse = await classifyPlaintextV2SseResponse(upstreamResponse, {
      timeoutMs: resolveStallTimeoutMs(config.stallTimeoutSec, { localUpstream: nativeExchange.localUpstream }),
      signal: options.abortSignal ?? req.signal,
    });
  }

    const headers = sanitizePassthroughHeaders(upstreamResponse.headers, codexSafetyBufferingOptions);
    const resolvedModel = headers.get("openai-model")?.trim();
    if (resolvedModel) {
      logCtx.servedModel = resolvedModel;
      if (!logCtx.preserveResolvedModelFromRoute) logCtx.resolvedModel = resolvedModel;
    }
    // ChatGPT may omit Content-Type on SSE responses. Plaintext V2 responses
    // reach this fallback only after their first Responses event is confirmed.
    const passthroughCt = headers.get("content-type")?.toLowerCase();
    const isEventStream = passthroughCt?.includes("text/event-stream")
      || (responseEffects.plaintextV2AgentMessageToolNames.size === 0 && upstreamResponse.ok && !!upstreamResponse.body && !passthroughCt && parsed.stream);
    const recordTerminalOutcome = codexForwardTerminalOutcomeRecorder(
      config,
      admissionState.authCtx,
      route.provider,
      route.modelId,
      logCtx,
    );
    let terminalOutcomeRecorded = false;
    const terminalRecorder = recordTerminalOutcome
      ? (status: ResponsesTerminalStatus, httpStatusOverride?: number): void => {
        if (terminalOutcomeRecorded) return;
        terminalOutcomeRecorded = true;
        recordTerminalOutcome(status, httpStatusOverride);
      }
      : undefined;
    const terminalBodyWillRecord = !!terminalRecorder && upstreamResponse.ok && isEventStream;
    // Capture quota from upstream response for multi-account tracking
   if (usesCodexForwardPoolAuth(admissionState.authCtx, route.provider)) {
      // primary was the 5h window; it now carries weekly data for GPT plans.
      // Prefer primary when present, fall back to secondary for compatibility.
      const quotaMeta = { ...codexQuotaOutcomeMeta(upstreamResponse), ...(await codexDenialOutcomeMeta(upstreamResponse)) };
      const { applyAccountQuotaFromUpstreamHeaders } = await import("../../codex/auth-api");
      if (!isCodexWsQuotaObservedResponse(upstreamResponse)) {
        applyAccountQuotaFromUpstreamHeaders(admissionState.authCtx.accountId, upstreamResponse.headers,
          admissionState.authCtx.writerGeneration, admissionState.authCtx.kind === "main-pool" ? admissionState.authCtx.mainQuotaWriter : undefined,
          { modelId: route.modelId, poolWriter: admissionState.authCtx.kind === "pool" ? admissionState.authCtx.poolQuotaWriter : undefined });
      }
      if (terminalBodyWillRecord) {
        options.setTerminalOutcomeRecorder?.((status, httpStatusOverride) => {
          terminalRecorder(status, httpStatusOverride);
          if (status === "failed" || status === "incomplete") {
            const quotaFailureMessage = [httpStatusOverride, logCtx.terminalHttpStatus]
              .find(value => value === 429 || value === 402);
            if (!isFixedCodexAccount(admissionState.authCtx) && quotaFailureMessage !== undefined) {
              recordSubagentQuotaFailureForThreadSpawn(
                req.headers,
                subagentQuotaFailureModel,
                quotaFailureMessage,
                config,
                requestState.subagentFallbackAccountId,
              );
            }
          }
          options.onNativePassthroughTerminal?.(status);
        });
      } else if (!shouldDeferCodexResetDerivedCooldown(
        upstreamResponse,
        options.deferCodexResetDerivedCooldown,
      ) && !isReplayRefusalResponse(upstreamResponse)) {
        // A refusal this proxy made is not evidence about the account. Recording it would
        // classify the synthetic 429 as quota exhaustion and write a default cooldown against
        // a credential the request may never have reached, and that false signal outlives the
        // request. The sibling recorders on this path already decline: the terminal recorder
        // needs an ok streaming body, and the quota-header snapshot finds no quota headers.
        recordCodexUpstreamOutcome(config, admissionState.authCtx.accountId, upstreamResponse.status, {
          ...quotaMeta,
          threadId: admissionState.authCtx.affinityKey,
          fixedAccount: admissionState.authCtx.fixedAccount,
          modelId: route.modelId,
          probeLeaseId: codexProbeLeaseId(admissionState.authCtx),
          probeQuotaScope: codexProbeQuotaScope(admissionState.authCtx),
          transientProbe: codexTransientProbeGrant(admissionState.authCtx),
          writerGeneration: admissionState.authCtx.writerGeneration,
          // Includes a replay's second 401, which is the case that actually retires the
          // account — fence it on the credential the request was holding.
          ...(admissionState.authCtx.kind === "pool" ? { credentialGeneration: admissionState.authCtx.generation } : {}),
        });
      }
    }

    // Non-2xx passthrough failures must never reach Codex as an empty body —
    // Codex renders that as the opaque "Unknown error" (#452). Combo attempts
    // keep their typed failure envelope. Except for the classified 413 below,
    // non-empty bodies are relayed verbatim
    // (headers included) so pool-retry Activation B/D and client diagnostics stay intact.
    // Manual-redirect policy (#914): a 3xx is relayed as-is (Location preserved
    // through sanitizePassthroughHeaders) so a redirect to a dead host can never
    // masquerade as a pre-connection failure after the credential was seen.
    // The numeric outcome above already classified it neutral — no streak.
    if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: sanitizePassthroughHeaders(upstreamResponse.headers, codexSafetyBufferingOptions),
      });
    }
    if (!upstreamResponse.ok) {
      if (options.comboAttempt) {
        // No pre-read guard here: `consumeComboFailure` -> `readBoundedResponseBody` reads
        // `response.body` itself and already threads the abort signal through its own read,
        // and the combo contract is that this body's getter is touched exactly once (pinned by
        // "captures passthrough failed usage from its original bounded body exactly once").
        // Attaching a guard would be a second `.body` access and break that contract for no
        // gain, since the bounded reader owns settlement on this path.
        const failure = await consumeComboFailure(upstreamResponse, options.abortSignal);
        options.onConsumedComboFailure?.(failure);
        return failure.response;
      }
      // The bounded reader owns the original body, deadline, abort settlement, and lock.
      // Unsafe partial data falls back to #452's non-empty status-only JSON.
      const errorText = await readDisplaySafeErrorText(upstreamResponse, upstream.signal, "");
      if (upstreamResponse.status === 413) {
        return clientRequestedStream
          ? streamingContextOverflowResponse(parsed._responseModelId ?? parsed.modelId, translatorBudget)
          : jsonContextOverflowResponse();
      }
      const policyRefusal = rewriteUpstreamPolicyRefusal({
        status: upstreamResponse.status,
        errorText,
        stream: clientRequestedStream,
        modelId: parsed._responseModelId ?? parsed.modelId,
        destinationIsXai: isXaiResponsesDestination(route.provider),
        translatorBudget,
        turnAdmissionLease: options.turnAdmissionLease,
      });
      if (policyRefusal) return policyRefusal;
      return formatPassthroughUpstreamError(upstreamResponse.status, errorText, {
        statusText: upstreamResponse.statusText,
        headers,
        // Provenance, not inference: `errorText` is empty when the bounded read finds nothing
        // display-safe, and an empty body is exactly what the retryable-429 default fires on.
        replayRefusal: isReplayRefusalResponse(upstreamResponse),
      });
    }

    if (options.nativeControl && isNativeControlResponse(upstreamResponse) && upstreamResponse.body) {
      // A native chain carries several response terminals. Ordinary SSE repair,
      // cancellation-on-terminal and local previous-response replay are single-response
      // contracts and would truncate it. Keep the bounded upstream as the sole reader.
      options.nativeControl.relayActive = true;
      commitReasoningReplayServingRoute(nativeExchange.request.headers);
      const body = trackStreamLifetime(upstreamResponse.body, upstream, undefined, options.turnAdmissionLease);
      return new Response(body, { status: upstreamResponse.status, headers });
    }

    // Bun#32111 workaround: passthrough SSE uses tee()+native relay to avoid the
    // async-pull segfault on Windows. Branch[0] goes directly to the Response (Bun
    // native relay, never enters JS Sink.write); branch[1] is consumed in the
    // background for terminal-outcome/quota inspection only.
    // #314 alternative shape: win32 no-rewrite traffic follows the runtime/config
    // gate; darwin no-rewrite traffic joins it only for explicit
    // `streamMode: "eager-relay"` opt-in. Darwin `auto` always stays tee. The
    // eager shape skips tee and uses one bounded reader with inline inspection
    // (src/server/relay-eager.ts; policy:
    // devlog/_fin/260731_macos_rss_retention/100_darwin_eager_optin.md).
    // The bundled known-bad runtime remains on tee by default on both platforms.
    const grokUpstreamEchoEnabled = isXaiResponsesDestination(route.provider)
      && responsesRequestMayReplayToolOutput(parsed._rawBody);
    if (isEventStream && upstreamResponse.body) {
      // For streamed passthrough, a successful terminal response means non-error upstream status
      // before relay starts. Waiting for SSE completion would retain request state across the whole
      // stream; a later body failure does not undo that this destination accepted and served the turn.
      commitReasoningReplayServingRoute(nativeExchange.request.headers);
      const terminalRepairPolicy = route.staticPolicy.model.responsesTerminalRepair;
      // #3761: opt-in hosted-web-search bridge. Codex always declares the hosted web_search tool,
      // and this branch relays that declaration on the assumption the destination executes it.
      // A KEY-auth gateway that does not (Ollama Cloud GLM) answers with a function_call named
      // web_search that nothing runs, and the undeclared-tool guard below ends the turn. When the
      // provider opts in, the bridge intercepts that one call, runs the search, continues the
      // conversation upstream, and hands back ordinary Responses SSE — so every rewrite below,
      // including the guard itself, still inspects the client-facing stream. Default OFF: without
      // the opt-in this is one planner call and the relay is byte-identical to before.
      const webSearchBridgeAuth = resolvePassthroughWebSearchBridgeAuth(
        route.provider.webSearchBridge?.backend,
        config,
        openAiSidecar,
      );
      const webSearchBridgePlan = planPassthroughWebSearchBridge(parsed, route.provider, {
        providerName: route.providerName,
        isPassthrough: true,
        stream: parsed.stream === true,
        auth: webSearchBridgeAuth,
      });
      // Capture the binding that actually served the first leg, after its permitted reselection.
      const webSearchBridgeBinding = requestBindings.get(nativeExchange.request);
      // Repair must observe the raw first leg before the bridge suppresses an intercepted search
      // lifecycle. Otherwise a provider that leaves that complete call open never arms repair's
      // grace timer, so the bridge cannot execute the search or begin its continuation.
      let passthroughSseBody = terminalRepairPolicy
        ? relayResponsesSseWithTerminalRepair(
          upstreamResponse.body,
          upstream,
          terminalRepairPolicy,
          translatorBudget,
          options.responsesTerminalRepairScheduler,
        )
        : upstreamResponse.body;
      passthroughSseBody = webSearchBridgePlan
        ? createPassthroughWebSearchBridgeStream({
          plan: webSearchBridgePlan,
          firstLeg: passthroughSseBody,
          requestBody: nativeExchange.request.body,
          // Continuation legs replay the same built request with the executed search appended.
          // The first leg already passed the recovery ladder, the outbound size ceiling, and the
          // host circuit; a KEY-auth destination has no OAuth refresh to replay on a later leg.
          send: async (continuationBody: string) => {
            const continuation = await fetchWithHeaderTimeout(
              nativeExchange.request.url,
              { method: nativeExchange.request.method, headers: nativeExchange.request.headers, body: continuationBody },
              upstream.signal,
              connectMs,
              true,
              providerFetch(route.provider, options.codexWsRuntimeIdentity, {
                // Pacing can outlive a manual selection change. A continuation must retain the
                // first leg's key and appended search result, never rebuild from the original turn.
                beforeDispatch: () => {
                  if (webSearchBridgeBinding?.kind !== "api-key"
                    || !providerApiKeySelectionIsCurrent(config, route.providerName, webSearchBridgeBinding.provider)) {
                    throw new Error("API key selection changed during a web-search continuation");
                  }
                },
                providerName: route.providerName,
                modelId: route.modelId,
              }),
              false,
            );
            // The same provider can leave a complete continuation open without a terminal, which
            // stalls the bridge's decide loop exactly like the first leg — so every leg gets the
            // same repair, not only the intercepted first one.
            if (!terminalRepairPolicy || !continuation.ok || !continuation.body) return continuation;
            return new Response(
              relayResponsesSseWithTerminalRepair(
                continuation.body,
                upstream,
                terminalRepairPolicy,
                translatorBudget,
                options.responsesTerminalRepairScheduler,
              ),
              continuation,
            );
          },
          execute: createPassthroughWebSearchBridgeExecutor(webSearchBridgePlan, {
            providerApiKey: route.provider.apiKey ?? "",
            auth: webSearchBridgeAuth,
            hostedTool: parsed._webSearch,
            describeImages: requiresVisionPreprocessing(config, route.provider, route.modelId, route.providerName),
            sidecar: config.webSearchSidecar,
          }),
          // Snapshot the bound conversation, provider, model, destination, and credential. The
          // next turn must match every dimension before its hosted cell can recover this result.
          destinationScope: bridgeSearchReplayScope(parsed._reasoningReplayScope),
          // Appending a search result can push the continuation past the ceiling the first leg
          // was admitted under, so the same limit is re-applied before every later send.
          checkOutboundBody: (continuationBody: string) => {
            const result = checkOutboundBodySize(continuationBody, config.maxUpstreamBodyBytes);
            return result.admitted ? undefined : describeOutboundBodyRefusal(result);
          },
          // Resolution can acquire the account's sole cooldown-recovery probe before the routed
          // provider reveals whether it will request search. Hand an unused lease back on every
          // terminal path; after an executed search, the outcome recorder has already settled it.
          onFinalize: () => releaseCodexAuthContextProbeLease(openAiSidecar?.authContext),
          signal: upstream.signal,
        })
        : passthroughSseBody;
      const repairConfig = route.provider.responsesItemIdRepair;
      // Grok Build renders deltas live but reconstructs its durable assistant
      // turn from the completed response snapshot. Native Responses streams
      // may instead carry the complete items in output_item.done, so the
      // explicit Grok compatibility marker enables strict client compatibility rewrites.
      // The provider's broader snapshot/lifecycle repair remains opt-in.
      const grokClientCompatibilityEnabled = logCtx.surface === "grok";
      const snapshotRepairEnabled = hasResponsesSnapshotRepair(route.provider.responsesSnapshotRepair);
      const githubCopilotRepairEnabled = route.providerName === "github-copilot";
      const responseModelRewrite = parsed._responseModelId !== undefined
        && parsed._responseModelId !== parsed.modelId
        ? createResponsesModelPayloadRewrite(parsed._responseModelId)
        : undefined;
      // Compose opt-in payload rewrites into one parse/stringify pass (image-gen restore first).
      const payloadRewrites = [
        createImageGenCallRestoreRewrite(imageGenCallAliases),
        // #3217: a call whose namespace repeats its own name is unroutable in codex-rs.
        createSelfNamedToolCallNamespaceScrubRewrite(selfNamedNamespaceScrubAuthorization),
        responseEffects.routedMuseToolNameAliases.size > 0
          ? createMuseToolNameRestoreRewrite(responseEffects.routedMuseToolNameAliases)
          : undefined,
        responseEffects.routedNamespaceToolAliases.size > 0
          ? createRoutedNamespaceCallRestoreRewrite(responseEffects.routedNamespaceToolAliases)
          : undefined,
        authorizedBareNamespaceToolAliases.size > 0
          ? createRoutedNamespaceCallRestoreRewrite(authorizedBareNamespaceToolAliases)
          : undefined,
        hasResponsesItemIdRepair(repairConfig)
          ? createResponsesItemIdPayloadRewrite(repairConfig!, translatorBudget)
          : undefined,
        responseModelRewrite,
      ].filter((rewrite): rewrite is NonNullable<typeof rewrite> => rewrite !== undefined);
      // #893: sparse-snapshot gateways get field backfills AND lifecycle event
      // injection at the block level, after payload rewrites. Defaults come
      // from the finalized OUTBOUND body — the normalized internal tool shapes
      // are not the Responses wire shapes the snapshot must mirror.
      // Only validated client blocks may publish plaintext continuation state.
      // Raw inspection precedes rewriting on eager relays, so it cannot own this write.
      const plaintextInspector = !grokUpstreamEchoEnabled && responseEffects.plaintextV2AgentMessageToolNames.size > 0
        ? createSseInspector({ onCompletedResponse: rememberPassthroughResponseChecked })
        : undefined;
      const plaintextEncoder = plaintextInspector ? new TextEncoder() : undefined;
      const rememberPlaintextBlock = plaintextInspector
        ? Object.assign((block: string): readonly string[] => {
          plaintextInspector.feed(plaintextEncoder!.encode(`${block}\n\n`));
          return [block];
        }, { dispose: () => plaintextInspector.dispose() })
        : undefined;
      const blockRewrites = [
        payloadRewrites.length > 0
          ? payloadRewriteAsBlockRewrite(composeSsePayloadRewrites(...payloadRewrites))
          : undefined,
        routedCustomToolNames.size > 0 || routedCustomToolRepairNames.size > 0
          ? createRoutedCustomToolRestoreBlockRewrite(
            routedCustomToolNames,
            translatorBudget,
            routedCustomToolRepairNames,
            declaredWireToolNames,
          )
          : undefined,
        routedToolSearchNames.size > 0
          ? createRoutedToolSearchRestoreBlockRewrite(routedToolSearchNames, translatorBudget)
          : undefined,
        githubCopilotRepairEnabled
          ? createGithubCopilotResponsesBlockRewrite(translatorBudget)
          : undefined,
        grokClientCompatibilityEnabled
          ? createGrokResponsesControlFrameBlockRewrite()
          : undefined,
        grokClientCompatibilityEnabled
          ? createGrokResponsesTimestampBlockRewrite()
          : undefined,
        grokClientCompatibilityEnabled
          ? createGrokResponsesSparseTerminalBlockRewrite(
            translatorBudget,
            nativeExchange.outboundRequestBody,
            {
              clientToolAuthorizationBody: currentTurnWireToolCatalogBody(
                parsed._rawBody,
                parsed._replayPrefixLen ?? 0,
              ),
              routedNamespaceToolAliases: responseEffects.routedNamespaceToolAliases,
              routedMuseToolNameAliases: responseEffects.routedMuseToolNameAliases,
              convertedRoutedCustomToolNames: routedCustomToolNames,
            },
          )
          : undefined,
        snapshotRepairEnabled
          ? createResponsesSnapshotBlockRewrite(nativeExchange.outboundRequestBody, translatorBudget)
          : undefined,
        responseEffects.plaintextV2AgentMessageToolNames.size > 0
          ? payloadRewriteAsBlockRewrite(createPlaintextV2AgentMessageCallRestoreRewrite(
            responseEffects.plaintextV2AgentMessageToolNames, responseEffects.plaintextV2AgentMessageAliasedToolNames,
          ))
          : undefined,
        createResponsesFieldBackfillBlockRewrite(),
        functionRepairSchemas.size > 0
          ? createResponsesFunctionToolRepairBlockRewrite(functionRepairSchemas, translatorBudget)
          : undefined,
        // Last: every rewrite above can still rename or reshape a call item, so the guard must
        // compare the names the client will actually receive against the declared catalog.
        // Keyless Zen tier: a gate declaration the model calls anyway gets
        // guidance instead of a failed turn. Every other route passes
        // undefined and keeps the fail-closed behavior below.
        nativeExchange.undeclaredToolGuardActive
          ? createUndeclaredToolCallGuardBlockRewrite(
            declaredWireToolNames,
            declaredNamelessClientCallTypes,
            providerExecutedCallTypes,
            declaredBareWireToolNames,
            isZenFreeEndpoint(route.provider.baseUrl) && !zenFreeHasApiKey(route.provider)
              ? {
                names: ZEN_FREE_GATE_NAMES,
                message: (name: string, alternatives: readonly string[]) => zenFreeGateGuidanceText(name, alternatives),
              }
              : undefined,
          )
          : undefined,
        grokUpstreamEchoEnabled
          ? createGrokUpstreamEnvelopeEchoBlockRewrite(
            rememberPassthroughResponse ? rememberPassthroughResponseChecked : undefined,
          )
          : undefined,
        rememberPlaintextBlock,
      ].filter((rewrite): rewrite is NonNullable<typeof rewrite> => rewrite !== undefined);
      const clientBlockRewrite = blockRewrites.length > 0
        ? composeSseBlockRewrites(...blockRewrites)
        : undefined;
      const needsClientRewrite = clientBlockRewrite !== undefined;
      const relayPlatform = relayPlatformForTests ?? process.platform;
      // #864: win32 rewrite traffic must never enter the tee()+JS-pull chain
      // (Bun#32111 JS-sink segfault — text frames pass, the terminal block is
      // lost). The eager single reader applies the same rewrites inline.
      const win32EagerRewrite = isWin32EagerRewrite(relayPlatform, needsClientRewrite);
      const eagerPath = selectEagerPath(
        relayPlatform,
        needsClientRewrite,
        config.streamMode ?? "auto",
      );
      // A successful Codex WS upgrade is a push source. If it entered tee(),
      // the inspection branch could drain continuously while the slow client
      // branch retained bytes without a bound. Force the existing bounded,
      // single-reader relay before tee; HTTP fallback responses stay unmarked.
      const forceCodexWsEagerRelay = isCodexWsUpstreamResponse(upstreamResponse);
      const inlineEagerRewrite = needsClientRewrite
        && (forceCodexWsEagerRelay || win32EagerRewrite || eagerPath?.useEagerRelay === true);
      if (forceCodexWsEagerRelay || eagerPath?.useEagerRelay || win32EagerRewrite) {
        const turnAc = new AbortController();
        linkAbortSignal(upstream, turnAc.signal);
        registerTurn(turnAc, options.turnAdmissionLease);
        const reportNativeTerminal = recordTerminalOutcomes
          ? (status: ResponsesTerminalStatus, httpStatusOverride?: number) => {
            terminalRecorder?.(status, httpStatusOverride);
            if (status === "failed" || status === "incomplete") {
              const quotaFailureMessage = [httpStatusOverride, logCtx.terminalHttpStatus]
                .find(value => value === 429 || value === 402);
              if (!isFixedCodexAccount(admissionState.authCtx) && quotaFailureMessage !== undefined) {
                recordSubagentQuotaFailureForThreadSpawn(
                  req.headers,
                  subagentQuotaFailureModel,
                  quotaFailureMessage,
                  config,
                  requestState.subagentFallbackAccountId,
                );
              }
            }
            options.onNativePassthroughTerminal?.(status);
          }
          : undefined;
        const inspector = createSseInspector({
          onTerminal: reportNativeTerminal,
          logCtx,
          onCompletedResponse: rememberPassthroughResponse && !grokUpstreamEchoEnabled && responseEffects.plaintextV2AgentMessageToolNames.size === 0 ? rememberPassthroughResponseChecked : undefined,
          onParsedPayload: noteInspectedPayload,
          onFirstOutput: options.onFirstOutput,
          pinCompletedResponseIdToFirstSeen: githubCopilotRepairEnabled,
        });
        const eagerBody = relaySseEagerBounded(passthroughSseBody, turnAc, {
          inspectChunk: chunk => inspector.feed(chunk),
          finishInspection: () => inspector.finish(),
          disposeInspection: () => inspector.dispose(),
          // Stream lifetime follows the protocol terminal even when this request
          // has no outcome callback configured (reported() would stay false).
          sawTerminal: () => inspector.terminalSeen(),
          ...(clientBlockRewrite
            ? { rewriteBlocks: clientBlockRewrite }
            : {}),
          onSynthetic: (kind, reason) => {
            if (!reportNativeTerminal) return;
            if (kind === "incomplete") {
              logCtx.terminalSource = "synthetic";
              reportNativeTerminal("incomplete");
            } else if (reason === "upstream_error") {
              logCtx.terminalSource = "synthetic";
              reportNativeTerminal("failed", logCtx.terminalHttpStatus ?? 502);
            } else {
              logCtx.transportPhase = "mid_stream";
              logCtx.terminalSource = "synthetic";
              if (logCtx.activeAttempt) logCtx.activeAttempt.streamAborted = true;
              reportNativeTerminal("failed", 502);
            }
          },
          onClientCancel: () => {
            responseEffects.responseCompletionCancelled = true;
            options.onNativePassthroughCancel?.();
          },
          onDone: () => unregisterTurn(turnAc),
        }, {
          clientGoneSignal: options.abortSignal,
          terminalBoundary: codexSafetyBufferingOptions,
          ...(inlineEagerRewrite ? { rewriteBudget: translatorBudget } : {}),
          ...(logCtx.upstreamError === undefined ? {} : { upstreamError: logCtx.upstreamError }),
        });
        // When selected, this relay closes response.completed even if upstream
        // keeps the connection alive. Marked Codex WS traffic, Windows
        // forced-rewrite traffic, and Darwin explicit eager traffic apply
        // client rewrites inline rather than via the tee()+JS-pull chain.
        if (!headers.has("content-type")) headers.set("content-type", "text/event-stream");
        return markEagerRelaySseResponse(
          markNativePassthroughSseResponse(new Response(eagerBody, {
            status: upstreamResponse.status,
            headers,
          })),
        );
      }
      const turnAc = new AbortController();
      const clientGone = new AbortController();
      const clientGoneSignal = options.abortSignal
        ? AbortSignal.any([clientGone.signal, options.abortSignal])
        : clientGone.signal;
      // Pace against raw bytes before rewrites, without detaching terminal ownership.
      const [nativeBody, inspectBody] = teeWithBoundedInspection(passthroughSseBody, { clientGoneSignal });
      linkAbortSignal(upstream, turnAc.signal);
      registerTurn(turnAc, options.turnAdmissionLease);
      const inspectionConsumerOptions = {
        // Request abort can reject the fetch body before the response cancel hook runs.
        clientGoneSignal,
        drainBounds: { ms: 15_000, bytes: 32 * 1024 * 1024 },
        upstream,
        pinCompletedResponseIdToFirstSeen: githubCopilotRepairEnabled,
        onParsedPayload: noteInspectedPayload,
      };
      if (recordTerminalOutcomes) {
        // A real terminal was parsed from the (teed) inspection stream — record it as the outcome
        // even if the client has already disconnected: the turn genuinely reached that terminal, so
        // it must log as completed/failed, not be dropped or downgraded to a cancel (#44). A pure
        // client-cancel (no terminal seen) is finalized separately via consumeForInspection's onCancel.
        const reportNativeTerminal = (status: ResponsesTerminalStatus, httpStatusOverride?: number) => {
          terminalRecorder?.(status, httpStatusOverride);
          if (status === "failed" || status === "incomplete") {
            const quotaFailureMessage = [httpStatusOverride, logCtx.terminalHttpStatus]
              .find(value => value === 429 || value === 402);
            if (!isFixedCodexAccount(admissionState.authCtx) && quotaFailureMessage !== undefined) {
              recordSubagentQuotaFailureForThreadSpawn(
                req.headers,
                subagentQuotaFailureModel,
                quotaFailureMessage,
                config,
                requestState.subagentFallbackAccountId,
              );
            }
          }
          options.onNativePassthroughTerminal?.(status);
        };
        consumeForInspection(
          inspectBody,
          reportNativeTerminal,
          turnAc.signal,
          () => unregisterTurn(turnAc),
          logCtx,
          () => {
            responseEffects.responseCompletionCancelled = true;
            options.onNativePassthroughCancel?.();
          },
          rememberPassthroughResponse && !grokUpstreamEchoEnabled && responseEffects.plaintextV2AgentMessageToolNames.size === 0 ? rememberPassthroughResponseChecked : undefined,
          options.onFirstOutput,
          inspectionConsumerOptions,
        );
      } else {
        consumeForResponseLogMetadata(
          inspectBody,
          logCtx,
          turnAc.signal,
          () => unregisterTurn(turnAc),
          rememberPassthroughResponse && !grokUpstreamEchoEnabled && responseEffects.plaintextV2AgentMessageToolNames.size === 0 ? rememberPassthroughResponseChecked : undefined,
          options.onFirstOutput,
          inspectionConsumerOptions,
        );
      }
      if (!headers.has("content-type")) headers.set("content-type", "text/event-stream");
      // Windows was handled by the eager terminal-aware branch above. Remaining
      // tee traffic can use the JS relay to close on a protocol terminal and to
      // convert a mid-stream reset into a clean response.failed event.
      const rewrittenBody = clientBlockRewrite !== undefined
        ? relaySseWithBlockRewrite(nativeBody, clientBlockRewrite, translatorBudget)
        : nativeBody;
      const clientBody = relaySseWithFailedTail(
        rewrittenBody,
        upstream,
        reason => {
          responseEffects.responseCompletionCancelled = true;
          clientGone.abort(reason);
        },
        { upstreamError: logCtx.upstreamError, terminalBoundary: codexSafetyBufferingOptions },
      );
      return markNativePassthroughSseResponse(new Response(clientBody, {
        status: upstreamResponse.status,
        headers,
      }));
    }
    if (headers.get("content-type")?.toLowerCase().includes("application/json")) {
      // Bounded whole-body read: a non-streaming upstream JSON body is fully materialized
      // here (and again by the request-log finalizer and the WebSocket bridge's reframing),
      // so an unbounded .text() would let a hostile or stuck upstream grow proxy memory
      // without limit. This path is no longer rare — WebSocket turns for models whose
      // streaming terminal event is unreliable are deliberately answered with bounded JSON.
      // Oversize and stall deadlines both fail closed; a partial body is never parsed.
      const bounded = await readBoundedResponseBody(upstreamResponse, UPSTREAM_JSON_BODY_READ_OPTIONS);
      if (bounded.oversized) {
        return formatErrorResponse(502, "upstream_error", "upstream JSON response exceeded the safe body limit");
      }
      if (bounded.truncated) {
        return formatErrorResponse(502, "upstream_error", "upstream JSON response stalled before completing");
      }
      const text = bounded.text;
      inspectResponseLogJson(logCtx, text);
      let plaintextV2RestoreFailed = false;
      let clientJson = (() => {
        const restoredNamespace = restoreRoutedNamespaceCallsInJson(
          scrubSelfNamedToolCallNamespaceInJson(
            restoreMuseToolNamesInJson(
              restoreImageGenCallsInJson(text, imageGenCallAliases),
              responseEffects.routedMuseToolNameAliases,
            ),
            selfNamedNamespaceScrubAuthorization,
          ),
          responseEffects.routedNamespaceToolAliases,
        );
        const restoredAuthorizedBareNamespace = restoreRoutedNamespaceCallsInJson(
          restoredNamespace,
          authorizedBareNamespaceToolAliases,
        );
        const restored = restoreRoutedCustomCallsInJson(
          restoredAuthorizedBareNamespace,
          routedCustomToolNames,
          routedCustomToolRepairNames,
          declaredWireToolNames,
        );
        const restoredToolSearch = restoreRoutedToolSearchCallsInJson(
          restored,
          routedToolSearchNames,
        );
        const normalizedJson = normalizeFunctionCompletionJson(restoredToolSearch);
        const plaintextRestore = restorePlaintextV2AgentMessageCallsInJsonResult(
          normalizedJson, responseEffects.plaintextV2AgentMessageToolNames, responseEffects.plaintextV2AgentMessageAliasedToolNames,
        );
        plaintextV2RestoreFailed = plaintextRestore.overflowed;
        const repaired = plaintextRestore.value;
        const modelRewritten = parsed._responseModelId !== undefined && parsed._responseModelId !== parsed.modelId
          ? rewriteResponsesModelJson(repaired, parsed._responseModelId)
          : repaired;
        return modelRewritten;
      })();
      if (plaintextV2RestoreFailed) {
        return formatErrorResponse(502, "upstream_error", PLAINTEXT_V2_AGENT_MESSAGE_RESTORE_OVERFLOW_MESSAGE);
      }
      if (grokUpstreamEchoEnabled) {
        clientJson = stripGrokUpstreamEnvelopeEchoFromResponsesJson(clientJson);
      }
      // #1700: same fail-closed policy as the SSE relay above. Both the plain JSON answer and
      // the reframed-SSE branch below are built from this body, so one check covers them. This
      // runs BEFORE the continuation cache write below: a refused turn must not become state a
      // later `previous_response_id` replay can expand from.
      if (nativeExchange.undeclaredToolGuardActive) {
        const undeclared = (() => {
          try {
            return undeclaredToolCallNameInResponse(
              JSON.parse(clientJson),
              declaredWireToolNames,
              declaredNamelessClientCallTypes,
              providerExecutedCallTypes,
              declaredBareWireToolNames,
            );
          } catch {
            return undefined;
          }
        })();
        if (undeclared !== undefined) {
          return formatErrorResponse(502, "upstream_error", undeclaredToolCallMessage(undeclared));
        }
        clientJson = normalizeDefaultNamespaceInJson(
          clientJson,
          declaredWireToolNames,
          declaredBareWireToolNames,
        );
      }
      commitReasoningReplayServingRoute(nativeExchange.request.headers);
      try {
        rememberPassthroughResponseChecked(
          JSON.parse(grokUpstreamEchoEnabled ? clientJson : text) as { id?: unknown; output?: unknown; status?: unknown; model?: unknown },
        );
      } catch { /* non-JSON despite content-type; recording is best-effort */ }
      // #875: the transport-neutral reliability policy forced a bounded JSON
      // upstream for a client that asked for SSE. Reframe the completed JSON
      // as the canonical terminal SSE sequence (created → output_item.done →
      // terminal → [DONE]) so Codex commits the turn instead of hanging on a
      // stream that never closes. Non-streaming clients keep the plain JSON.
      if (clientRequestedStream === true
        && options.inboundTransport !== "websocket"
        && route.staticPolicy.model.responsesUpstreamStreaming === false
        && route.provider.adapter === "openai-responses") {
        let completed: Record<string, unknown> | undefined;
        try {
          const parsedCompleted = JSON.parse(clientJson) as unknown;
          if (!parsedCompleted || typeof parsedCompleted !== "object" || Array.isArray(parsedCompleted)) {
            throw new TypeError("bounded Responses JSON is not an object");
          }
          let candidate = parsedCompleted as Record<string, unknown>;
          // The bounded-JSON answer bypasses the SSE relay, so it also bypasses
          // the SSE item-id rewrite. Apply the same client-facing normalization
          // here or this policy would silently disable id repair for the very
          // providers that need it (raw record already happened above).
          if (hasResponsesItemIdRepair(route.provider.responsesItemIdRepair)) {
            candidate = repairResponsesJsonItemIds(candidate, route.provider.responsesItemIdRepair!, translatorBudget);
          }
          completed = candidate;
        } catch {
          // Non-JSON despite content-type: fall through to the plain relay.
        }
        if (completed) {
          let stream: ReadableStream<Uint8Array>;
          try {
            stream = responsesJsonToSseStream(completed);
          } catch (error) {
            if (error instanceof RangeError) {
              return formatErrorResponse(
                502,
                "upstream_error",
                "upstream JSON response exceeded the synthesized SSE item limit",
              );
            }
            throw error;
          }
          const sseHeaders = sanitizePassthroughHeaders(headers, codexSafetyBufferingOptions);
          sseHeaders.set("content-type", "text/event-stream");
          sseHeaders.set("cache-control", "no-store");
          return new Response(stream, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: sseHeaders,
          });
        }
      }
      // WS turns reframe this JSON into events in the bridge, which is the
      // other relay-free path — normalize ids so both bounded-JSON paths agree.
      const outboundJson = options.inboundTransport === "websocket"
        && route.staticPolicy.model.responsesUpstreamStreaming === false
        && hasResponsesItemIdRepair(route.provider.responsesItemIdRepair)
        ? (() => {
          try {
            return JSON.stringify(repairResponsesJsonItemIds(
              JSON.parse(clientJson) as Record<string, unknown>,
              route.provider.responsesItemIdRepair!,
              translatorBudget,
            ));
          } catch {
            return clientJson;
          }
        })()
        : clientJson;
      return new Response(outboundJson, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers,
      });
    }
    if (responseEffects.plaintextV2AgentMessageToolNames.size > 0) {
      try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already closed */ }
      return formatErrorResponse(502, "upstream_error", "plaintext V2 agent-message response used an unsupported content type");
    }
    // An unclassified passthrough body is relayed directly and has no bounded completion observer;
    // use the same non-error-status success boundary as SSE instead of retaining per-stream state.
    commitReasoningReplayServingRoute(nativeExchange.request.headers);
    const body = relayWithAbort(upstreamResponse.body, upstream);
    const turnAc = new AbortController();
    const tracked = body ? trackStreamLifetime(body, turnAc, undefined, options.turnAdmissionLease) : null;
    return new Response(tracked, {
      status: upstreamResponse.status,
      headers,
    });
}
