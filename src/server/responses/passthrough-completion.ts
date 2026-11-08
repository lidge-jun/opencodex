import type { AdapterRequest } from "../../adapters/base";
import { formatErrorResponse } from "../../bridge";
import type { MainQuotaDispatch } from "../../codex/main-account-cache";
import { isLocalUpstream } from "../../lib/local-upstream";
import { guardResponseBodyInactivity } from "../../lib/response-body-inactivity";
import { resolveStallTimeoutMs } from "../../stall-timeout";
import type { OcxConfig } from "../../types";
import { recordKeyWireAttemptUsage, usageFromResponsesPayload, type RequestLogContext } from "../request-log";
import { isPlainObject } from "../responses-snapshot-codec";
import { selectProtocolSafeResetResponse, type ProtocolSafeResetRecovery } from "./combo-stream-preflight";
import { bindPublishedMainQuotaDispatch } from "./core-codex-account";
import type { ResponsesAdmissionState } from "./core-options";
import { guardOpenGatewayCompletion } from "./opengateway-completion-guard";
import { carryResponseToolOwnership } from "./response-tool-ownership";

// A guarded published reset response, mapped to when its selection began holding the head.
const guardedResetResponses = new WeakMap<Response, number>();

/** A replacement must still be the stream the upstream request asked for; refetch requires 2xx. */
export function isResetReplacementStream(candidate: Response, upstreamRequestsStream: boolean): boolean {
  const type = candidate.headers.get("content-type")?.toLowerCase() ?? "";
  return type.includes("text/event-stream") || (!type && upstreamRequestsStream);
}

/**
 * Select the native response a reset preflight publishes.
 *
 * The selection waits at most one heartbeat interval, and never longer than the stall budget, for
 * a head; see `selectProtocolSafeResetResponse`. The gateway clock must see upstream reads, not
 * generated comments or held preludes. The published head carries the main quota proof of the
 * physical attempt that produced it, because the replacement send renews the context's proof.
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
    keepalive: "periodic" | "upstream-activity" | "none";
  },
): Promise<Response> {
  const guard = options.request.url === "https://apis.opengateway.ai/v1/responses"
    && response.status === 200 && response.body !== null;
  const protect = (source: Response): Response => guard
    ? carryResponseToolOwnership(source, guardResponseBodyInactivity(
      source, options.signal, resolveStallTimeoutMs(options.config.stallTimeoutSec),
    ).response)
    : source;
  const quotaOwner = (): MainQuotaDispatch | undefined =>
    admission.authCtx.kind === "main" ? admission.authCtx.mainQuotaDispatch : undefined;
  const originalOwner = quotaOwner();
  let replacementOwner: MainQuotaDispatch | undefined;
  const stallMs = resolveStallTimeoutMs(options.config.stallTimeoutSec, { localUpstream: isLocalUpstream(options.request.url) });
  const heldSince = performance.now();
  return selectProtocolSafeResetResponse(protect(response), logCtx, async (error, stage, signal, accepts) => {
    // Recover returns only a validated, fresh body; wrapping earlier would hide its lock state.
    const replacement = await recover(error, stage, signal, accepts);
    if (!replacement) return null;
    replacementOwner = quotaOwner();
    return protect(replacement);
  }, {
    allowMissingContentType: options.allowMissingContentType,
    keepalive: options.keepalive,
    signal: options.signal,
    maxSelectionMs: stallMs > 0 ? stallMs : undefined,
    onCommit: (published, owner) => {
      if (guard) guardedResetResponses.set(published, heldSince);
      bindPublishedMainQuotaDispatch(published, owner === "replacement" ? replacementOwner : originalOwner);
    },
  });
}

export function parseOutboundRequestBody(bodyText: string): Record<string, unknown> | undefined {
  try {
    const body: unknown = JSON.parse(bodyText);
    return isPlainObject(body) ? body : undefined;
  } catch {
    return undefined;
  }
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
