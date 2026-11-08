import type { AdapterRequest } from "../../adapters/base";
import { formatErrorResponse } from "../../bridge";
import type { MainQuotaDispatch } from "../../codex/main-account-cache";
import { isLocalUpstream } from "../../lib/local-upstream";
import { guardResponseBodyInactivity } from "../../lib/response-body-inactivity";
import { resolveStallTimeoutMs } from "../../stall-timeout";
import type { OcxConfig } from "../../types";
import { recordKeyWireAttemptUsage, usageFromResponsesPayload, type RequestLogContext } from "../request-log";
import { selectProtocolSafeResetResponse, type ProtocolSafeResetRecovery } from "./combo-stream-preflight";
import { bindPublishedMainQuotaDispatch } from "./core-codex-account";
import type { ResponsesAdmissionState } from "./core-options";
import { guardOpenGatewayCompletion } from "./opengateway-completion-guard";
import { parseOutboundRequestBody } from "./outbound-request-body";
import { carryResponseToolOwnership } from "./response-tool-ownership";

export { parseOutboundRequestBody } from "./outbound-request-body";

// A guarded published reset response, mapped to when its selection began holding the head.
const guardedResetResponses = new WeakMap<Response, number>();

/**
 * How long a direct stream's head may wait on the original's own inspection.
 *
 * Returning the response is the latest point this code can still choose a head, but it does not
 * send one: Bun's server writes the head together with the first body bytes, so a window commit
 * also gives the client a comment at once. A healthy slow upstream and a dying one look the same
 * until the source fails, so a direct client gets the original head promptly instead of after a
 * heartbeat interval. A failure observed inside this window may still publish the replacement's
 * own head, as a pre-header reset does.
 */
export const DIRECT_RESET_INSPECTION_WINDOW_MS = 200;

/** Who consumes the selected head: the client directly, the canonical JSON collector, or a combo parent. */
export type ResetSelectionDelivery = "direct-stream" | "buffered-json" | "combo-child";

/** A replacement must still be the stream the upstream request asked for; refetch requires 2xx. */
export function isResetReplacementStream(candidate: Response, upstreamRequestsStream: boolean): boolean {
  const type = candidate.headers.get("content-type")?.toLowerCase() ?? "";
  return type.includes("text/event-stream") || (!type && upstreamRequestsStream);
}

/**
 * Select the native response a reset preflight publishes.
 *
 * A direct stream's head waits on the original's inspection for at most
 * `DIRECT_RESET_INSPECTION_WINDOW_MS`. The canonical JSON collector and a combo parent publish no
 * head before their own inspection ends, so their selection may wait one heartbeat interval. No
 * selection waits longer than the stall budget; see `selectProtocolSafeResetResponse`. A consumer that measures silence on the bytes it
 * receives cannot tell a held prelude, its later replay or a generated comment from an upstream
 * read, and it starts after selection already waited. Both bodies are guarded before preflight, so each physical
 * attempt's stall budget runs on its own upstream reads from its own head. The guard's failure is
 * a timeout, which the reset gate never treats as replayable. The published head carries the main
 * quota proof of the physical attempt that produced it, because the replacement send renews the
 * context's proof.
 */
export function selectPassthroughResetResponse(
  response: Response,
  admission: Pick<ResponsesAdmissionState, "authCtx">,
  logCtx: RequestLogContext,
  recover: ProtocolSafeResetRecovery,
  options: {
    request: AdapterRequest;
    config: Pick<OcxConfig, "stallTimeoutSec">;
    signal: AbortSignal;
    allowMissingContentType: boolean;
    delivery: ResetSelectionDelivery;
  },
): Promise<Response> {
  const openGateway = options.request.url === "https://apis.opengateway.ai/v1/responses"
    && response.status === 200 && response.body !== null;
  const stallMs = resolveStallTimeoutMs(options.config.stallTimeoutSec, { localUpstream: isLocalUpstream(options.request.url) });
  const protect = (source: Response): Response =>
    carryResponseToolOwnership(source, guardResponseBodyInactivity(source, options.signal, stallMs).response);
  const quotaOwner = (): MainQuotaDispatch | undefined =>
    admission.authCtx.kind === "main" ? admission.authCtx.mainQuotaDispatch : undefined;
  const originalOwner = quotaOwner();
  let replacementOwner: MainQuotaDispatch | undefined;
  const heldSince = performance.now();
  return selectProtocolSafeResetResponse(protect(response), logCtx, async (error, stage, signal, accepts) => {
    // Recover returns only a validated, fresh body; wrapping earlier would hide its lock state.
    const replacement = await recover(error, stage, signal, accepts);
    if (!replacement) return null;
    replacementOwner = quotaOwner();
    return protect(replacement);
  }, {
    allowMissingContentType: options.allowMissingContentType,
    // The collector's silence clock sees only delivered bytes; a combo parent holds the head itself.
    keepalive: options.delivery === "buffered-json" ? "upstream-activity" : options.delivery === "combo-child" ? "none" : "periodic",
    inspectionWindowMs: options.delivery === "direct-stream" ? DIRECT_RESET_INSPECTION_WINDOW_MS : undefined,
    signal: options.signal,
    maxSelectionMs: stallMs > 0 ? stallMs : undefined,
    onCommit: (published, owner) => {
      if (openGateway) guardedResetResponses.set(published, heldSince);
      bindPublishedMainQuotaDispatch(published, owner === "replacement" ? replacementOwner : originalOwner);
    },
  });
}

export function guardPassthroughCompletion(
  response: Response,
  request: AdapterRequest,
  config: Pick<OcxConfig, "emptyCompletionRetry" | "stallTimeoutSec">,
  signal: AbortSignal,
  logCtx: RequestLogContext,
  rebuildAndRefetch: (kind: "empty-completion") => Promise<Response | { failed: Response | { kind: "adapter-handoff" } }>,
): Promise<Response> {
  if (request.url !== "https://apis.opengateway.ai/v1/responses") return Promise.resolve(response);
  const heldSince = guardedResetResponses.get(response);
  return guardOpenGatewayCompletion(response, {
    url: request.url,
    body: parseOutboundRequestBody(request.body),
    signal,
    retryEnabled: config.emptyCompletionRetry,
    stallTimeoutMs: resolveStallTimeoutMs(config.stallTimeoutSec),
    initialBodyInactivityGuarded: heldSince !== undefined,
    // The completion hold and reset selection share one bound on how long the head waits.
    initialHoldSpentMs: heldSince === undefined ? 0 : performance.now() - heldSince,
    recordUsage: usage => { recordKeyWireAttemptUsage(logCtx, usageFromResponsesPayload(usage)); },
    retry: async () => {
      const result = await rebuildAndRefetch("empty-completion");
      if (!("failed" in result)) return result;
      return result.failed instanceof Response ? result.failed
        : formatErrorResponse(502, "upstream_error", "Native recovery changed the provider wire");
    },
  });
}
