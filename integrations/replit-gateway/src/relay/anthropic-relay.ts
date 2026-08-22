import type { AnthropicRelay } from "./types";
import { joinUpstreamEndpoint } from "../origin";
import { upstreamFetchPolicy, assertNoRedirect } from "../redirect";
import { ANTHROPIC_FORWARDABLE_REQUEST_HEADERS } from "./relay-constants";
import { mergeForwardableRequestHeaders } from "./request-forward";
import { createRelayedResponse } from "./sse-relay";
import { buildAnthropicUpstreamHeaders } from "./upstream-headers";

export type { AnthropicRelay };

export function createAnthropicRelay(): AnthropicRelay {
  return {
    async handleMessages(request, context) {
      const upstreamUrl = joinUpstreamEndpoint(context.config.anthropic.baseUrl, "/messages");
      const headers = buildAnthropicUpstreamHeaders(context.config.anthropic);
      mergeForwardableRequestHeaders(
        request.headers,
        headers,
        ANTHROPIC_FORWARDABLE_REQUEST_HEADERS,
      );

      const upstream = assertNoRedirect(
        await fetch(upstreamUrl, {
          method: request.method,
          headers,
          body: request.body,
          signal: context.upstreamSignal,
          ...upstreamFetchPolicy(),
        }),
      );

      return createRelayedResponse(upstream, {
        clientSignal: context.clientSignal,
        upstreamSignal: context.upstreamSignal,
      });
    },
  };
}

export function createUnimplementedAnthropicRelay(): AnthropicRelay {
  return {
    async handleMessages() {
      return Response.json(
        {
          error: {
            type: "not_implemented",
            message: "Anthropic messages relay is not implemented",
          },
        },
        { status: 501 },
      );
    },
  };
}
