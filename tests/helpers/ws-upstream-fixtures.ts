import {
  codexWsUpstreamFetch as rawCodexWsUpstreamFetch,
  shouldUseCodexWsUpstream as rawShouldUseCodexWsUpstream,
} from "../../src/server/responses/ws-upstream";

/**
 * Runtime pin and request shapes for the Codex WebSocket upstream suite.
 *
 * Moved verbatim out of tests/responses/ws-upstream.test.ts: that file sits at its file-size
 * cap, and the repository answer to a cap is a sibling helper rather than compressed control
 * flow. The two wrappers exist only to bind the pinned runtime identity, which is what makes
 * the suite read the bounded-relay path instead of whatever the host Bun reports.
 */
export const BOUNDED_WS_RUNTIME = "1.4.0";

export function shouldUseCodexWsUpstream(url: string, init?: RequestInit, upstreamWebsocket?: boolean): boolean {
  return rawShouldUseCodexWsUpstream(url, init, BOUNDED_WS_RUNTIME, upstreamWebsocket);
}

export function codexWsUpstreamFetch(
  url: string,
  init: RequestInit,
  fallback: typeof fetch,
): Promise<Response> {
  return rawCodexWsUpstreamFetch(url, init, fallback, BOUNDED_WS_RUNTIME);
}

export function streamingInit(body: Record<string, unknown> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify({ model: "gpt-5.5", stream: true, ...body }),
  };
}
