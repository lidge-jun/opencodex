import { randomUUID } from "node:crypto";
import { authenticateGatewayRequest } from "../auth";
import {
  createRelayHandoffRequest,
  readBoundedBody,
  validateRequestContentEncoding,
} from "../body";
import type { GatewayConfig } from "../config";
import { classifyRelayFailure, gatewayErrorResponse } from "../errors";
import { ConcurrencyLimiter, isRequestWithinBounds } from "../limits";
import { formatSafeLogLine, safeLogRecord } from "../logging";
import { toModelAllowlistSet } from "../models";
import { createRelayExecutionContext, type RelayExecutionContext } from "../request-context";
import { createHealthzResponse } from "../health";
import { createAnthropicRelay } from "../relay/anthropic-relay";
import { enforceRelayModel } from "../relay/model-gate";
import { createOpenAiRelay } from "../relay/openai-relay";
import { attachResponseLifecycle } from "../relay/response-lifecycle";
import { createOpenAiModelsResponse } from "../models";
import type { AnthropicRelay, GatewayRelayDeps, OpenAiRelay, RelayContext } from "../relay/types";

export interface GatewayServer {
  fetch(request: Request): Promise<Response>;
  stop(): Promise<void>;
}

function requestPath(req: Request): string {
  return new URL(req.url).pathname;
}

function requiresAuth(pathname: string): boolean {
  return pathname !== "/healthz";
}

async function invokeRelay(
  request: Request,
  config: GatewayConfig,
  allowlist: readonly string[],
  relay: OpenAiRelay | AnthropicRelay,
  invoke: (relayImpl: OpenAiRelay | AnthropicRelay, handoff: Request, context: RelayContext) => Promise<Response>,
  requestId: string,
  releaseSlot: () => void,
): Promise<{ response: Response; category?: Parameters<typeof safeLogRecord>[0]["category"] }> {
  let execution: RelayExecutionContext | undefined;
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    execution?.cleanup();
    releaseSlot();
  };

  try {
    execution = createRelayExecutionContext({
      clientSignal: request.signal,
      clientTimeoutMs: config.limits.clientTimeoutMs,
      upstreamTimeoutMs: config.limits.upstreamTimeoutMs,
    });

    const encoding = validateRequestContentEncoding(request);
    if (!encoding.ok) {
      finalize();
      return { response: gatewayErrorResponse(encoding.category), category: encoding.category };
    }

    const bodyResult = await readBoundedBody(request, config.limits.maxRequestBytes, {
      signal: execution.clientSignal,
      callerAborted: execution.callerAborted,
      clientTimedOut: execution.clientTimedOut,
    });
    if (!bodyResult.ok) {
      finalize();
      return { response: gatewayErrorResponse(bodyResult.category), category: bodyResult.category };
    }

    const modelGate = enforceRelayModel(bodyResult.body, toModelAllowlistSet(allowlist));
    if (!modelGate.ok) {
      finalize();
      return { response: gatewayErrorResponse(modelGate.category), category: modelGate.category };
    }

    const handoff = createRelayHandoffRequest(request, bodyResult.body);

    const context: RelayContext = {
      requestId,
      clientSignal: execution.clientSignal,
      upstreamSignal: execution.upstreamSignal,
      callerAborted: execution.callerAborted,
      clientTimedOut: execution.clientTimedOut,
      upstreamTimedOut: execution.upstreamTimedOut,
      config,
    };

    const response = await invoke(relay, handoff, context);
    if (execution.clientTimedOut()) {
      await response.body?.cancel();
      finalize();
      return { response: gatewayErrorResponse("client_timeout"), category: "client_timeout" };
    }
    if (execution.upstreamTimedOut()) {
      await response.body?.cancel();
      finalize();
      return { response: gatewayErrorResponse("upstream_timeout"), category: "upstream_timeout" };
    }
    if (execution.callerAborted()) {
      await response.body?.cancel();
      finalize();
      return { response: gatewayErrorResponse("client_aborted"), category: "client_aborted" };
    }

    return { response: attachResponseLifecycle(response, finalize) };
  } catch (error) {
    finalize();
    const category = classifyRelayFailure(error, {
      callerAborted: execution?.callerAborted() ?? request.signal.aborted,
      clientTimedOut: execution?.clientTimedOut() ?? false,
      upstreamTimedOut: execution?.upstreamTimedOut() ?? false,
    });
    return { response: gatewayErrorResponse(category), category };
  }
}

export function createGatewayServer(
  config: GatewayConfig,
  deps: GatewayRelayDeps = {},
): GatewayServer {
  const limiter = new ConcurrencyLimiter(config.limits.maxConcurrentRequests);
  const openAiRelay = deps.openAiRelay ?? createOpenAiRelay();
  const anthropicRelay = deps.anthropicRelay ?? createAnthropicRelay();

  const fetch = async (request: Request): Promise<Response> => {
    const started = performance.now();
    const requestId = randomUUID();
    const path = requestPath(request);
    const logAndReturn = (
      response: Response,
      category?: Parameters<typeof safeLogRecord>[0]["category"],
    ) => {
      const line = formatSafeLogLine(safeLogRecord({
        requestId,
        method: request.method,
        path,
        status: response.status,
        durationMs: Math.round(performance.now() - started),
        category,
      }));
      console.info(line);
      return response;
    };

    if (requiresAuth(path)) {
      const auth = authenticateGatewayRequest(request, config.gatewayKey);
      if (!auth.ok) {
        return logAndReturn(gatewayErrorResponse(auth.category), auth.category);
      }
    }

    const bounds = isRequestWithinBounds(request, {
      maxRequestBytes: config.limits.maxRequestBytes,
      maxHeaderBytes: config.limits.maxHeaderBytes,
    });
    if (!bounds.ok) {
      return logAndReturn(gatewayErrorResponse(bounds.category), bounds.category);
    }

    const slot = limiter.tryAcquire();
    if (!slot.ok) {
      return logAndReturn(gatewayErrorResponse(slot.category), slot.category);
    }

    let slotReleased = false;
    let deferSlotRelease = false;
    const releaseSlotOnce = () => {
      if (slotReleased) return;
      slotReleased = true;
      slot.release();
    };

    try {
      if (path === "/healthz" && request.method === "GET") {
        return logAndReturn(createHealthzResponse());
      }

      if (path === "/v1/models" && request.method === "GET") {
        return logAndReturn(createOpenAiModelsResponse(config.openai.allowedModels));
      }

      if (path === "/v1/chat/completions" && request.method === "POST") {
        deferSlotRelease = true;
        const result = await invokeRelay(
          request,
          config,
          config.openai.allowedModels,
          openAiRelay,
          (relayImpl, handoff, context) =>
            (relayImpl as OpenAiRelay).handleChatCompletions(handoff, context),
          requestId,
          releaseSlotOnce,
        );
        return logAndReturn(result.response, result.category);
      }

      if (path === "/v1/messages" && request.method === "POST") {
        deferSlotRelease = true;
        const result = await invokeRelay(
          request,
          config,
          config.anthropic.allowedModels,
          anthropicRelay,
          (relayImpl, handoff, context) =>
            (relayImpl as AnthropicRelay).handleMessages(handoff, context),
          requestId,
          releaseSlotOnce,
        );
        return logAndReturn(result.response, result.category);
      }

      return logAndReturn(gatewayErrorResponse("internal", 404));
    } finally {
      if (!deferSlotRelease) {
        releaseSlotOnce();
      }
    }
  };

  return {
    fetch,
    async stop() {},
  };
}
