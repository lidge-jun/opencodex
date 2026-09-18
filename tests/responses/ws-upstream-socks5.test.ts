import { describe, expect, test } from "bun:test";
import { configureSocks5Fetch } from "../../src/lib/proxy-env";
import { shouldUseCodexWsUpstream } from "../../src/server/responses/ws-upstream";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const BOUNDED_WS_RUNTIME = "1.4.0";

function streamingInit(body: Record<string, unknown> = {}): RequestInit {
  return { method: "POST", body: JSON.stringify({ model: "gpt-5.5", stream: true, ...body }) };
}

/**
 * Lives outside `ws-upstream.test.ts` because that file is at its committed file-size cap.
 * The assertion belongs with the SOCKS5 work regardless: the WebSocket upstream cannot be
 * negotiated through the SOCKS5 transport, so a configured SOCKS5 route has to fall back to
 * HTTP SSE rather than silently attempting a WS connection the transport cannot carry.
 */
describe("codex WS upstream under a SOCKS5 outbound route", () => {
  test("uses HTTP SSE when SOCKS5 outbound transport is configured", () => {
    const previous = process.env.ALL_PROXY;
    process.env.ALL_PROXY = "socks5://127.0.0.1:10808";
    try {
      expect(shouldUseCodexWsUpstream(CODEX_URL, streamingInit(), BOUNDED_WS_RUNTIME)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.ALL_PROXY;
      else process.env.ALL_PROXY = previous;
      configureSocks5Fetch();
    }
  });
});
