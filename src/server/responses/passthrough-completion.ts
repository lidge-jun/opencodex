import type { AdapterRequest } from "../../adapters/base";
import { formatErrorResponse } from "../../bridge";
import { resolveStallTimeoutMs } from "../../stall-timeout";
import type { OcxConfig } from "../../types";
import { recordKeyWireAttemptUsage, usageFromResponsesPayload, type RequestLogContext } from "../request-log";
import { isPlainObject } from "../responses-snapshot-codec";
import { guardOpenGatewayCompletion } from "./opengateway-completion-guard";

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
    recordUsage: usage => { recordKeyWireAttemptUsage(logCtx, usageFromResponsesPayload(usage)); },
    retry: async () => {
      const result = await rebuildAndRefetch("empty-completion");
      if (!("failed" in result)) return result;
      return result.failed instanceof Response ? result.failed
        : formatErrorResponse(502, "upstream_error", "Native recovery changed the provider wire");
    },
  });
}
