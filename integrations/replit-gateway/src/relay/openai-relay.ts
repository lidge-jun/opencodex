import type { OpenAiRelay } from "./types";
import { joinUpstreamEndpoint } from "../origin";
import { upstreamFetchPolicy, assertNoRedirect } from "../redirect";
import { OPENAI_FORWARDABLE_REQUEST_HEADERS } from "./relay-constants";
import { mergeForwardableRequestHeaders } from "./request-forward";
import { createRelayedResponse } from "./sse-relay";
import { buildOpenAiUpstreamHeaders } from "./upstream-headers";

export type { OpenAiRelay };

export function createOpenAiRelay(): OpenAiRelay {
  return {
    async handleChatCompletions(request, context) {
      const upstreamUrl = joinUpstreamEndpoint(context.config.openai.baseUrl, "/chat/completions");
      const headers = buildOpenAiUpstreamHeaders(context.config.openai);
      mergeForwardableRequestHeaders(
        request.headers,
        headers,
        OPENAI_FORWARDABLE_REQUEST_HEADERS,
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

export function createUnimplementedOpenAiRelay(): OpenAiRelay {
  return {
    async handleChatCompletions() {
      return Response.json(
        {
          error: {
            type: "not_implemented",
            message: "OpenAI chat relay is not implemented",
          },
        },
        { status: 501 },
      );
    },
  };
}
