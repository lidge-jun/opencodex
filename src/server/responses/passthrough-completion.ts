import type { AdapterRequest } from "../../adapters/base";
import { formatErrorResponse } from "../../bridge";
import { guardResponseBodyInactivity } from "../../lib/response-body-inactivity";
import { resolveStallTimeoutMs } from "../../stall-timeout";
import type { OcxConfig } from "../../types";
import { recordKeyWireAttemptUsage, usageFromResponsesPayload, type RequestLogContext } from "../request-log";
import { isPlainObject } from "../responses-snapshot-codec";
import { deferProtocolSafeResetRecovery, sameDeferredResponseMetadata, type ProtocolSafeResetRecovery } from "./combo-stream-preflight";
import { guardOpenGatewayCompletion } from "./opengateway-completion-guard";
import { carryResponseToolOwnership } from "./response-tool-ownership";

const guardedResetResponses = new WeakSet<Response>();

/** Match both the already-returned head and the expected upstream stream contract. */
export function acceptsDeferredReplacement(original: Response, candidate: Response, upstreamRequestsStream: boolean): boolean {
  const type = candidate.headers.get("content-type")?.toLowerCase() ?? "";
  return sameDeferredResponseMetadata(original, candidate)
    && (type.includes("text/event-stream") || (!type && upstreamRequestsStream));
}

/** The gateway clock must see upstream reads, not generated comments or held preludes. */
export function deferPassthroughResetRecovery(
  response: Response,
  logCtx: RequestLogContext,
  recover: ProtocolSafeResetRecovery,
  options: {
    request: AdapterRequest;
    config: Pick<OcxConfig, "stallTimeoutSec">;
    signal: AbortSignal;
    allowMissingContentType: boolean;
    keepalive: "periodic" | "upstream-activity" | "none";
  },
): Response {
  const guard = options.request.url === "https://apis.opengateway.ai/v1/responses"
    && response.status === 200 && response.body !== null;
  const protect = (source: Response): Response => guard
    ? carryResponseToolOwnership(source, guardResponseBodyInactivity(
      source, options.signal, resolveStallTimeoutMs(options.config.stallTimeoutSec),
    ).response)
    : source;
  const deferred = deferProtocolSafeResetRecovery(protect(response), logCtx, async (error, stage, signal) => {
    // Recover returns only a validated, fresh body; wrapping earlier would hide its lock state.
    const replacement = await recover(error, stage, signal);
    return replacement ? protect(replacement) : null;
  }, options);
  if (guard) guardedResetResponses.add(deferred);
  return deferred;
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
  return guardOpenGatewayCompletion(response, {
    url: request.url,
    body: parseOutboundRequestBody(request.body),
    signal,
    retryEnabled: config.emptyCompletionRetry,
    stallTimeoutMs: resolveStallTimeoutMs(config.stallTimeoutSec),
    initialBodyInactivityGuarded: guardedResetResponses.has(response),
    recordUsage: usage => { recordKeyWireAttemptUsage(logCtx, usageFromResponsesPayload(usage)); },
    retry: async () => {
      const result = await rebuildAndRefetch("empty-completion");
      if (!("failed" in result)) return result;
      return result.failed instanceof Response ? result.failed
        : formatErrorResponse(502, "upstream_error", "Native recovery changed the provider wire");
    },
  });
}
