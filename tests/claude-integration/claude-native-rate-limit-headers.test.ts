import { expect, test } from "bun:test";
import { handleClaudeCountTokens, handleClaudeMessages } from "../../src/server/claude-messages";
import { anthropicRateLimitHeaders } from "../../src/server/anthropic-rate-limit-headers";
import type { OcxConfig } from "../../src/types";

const rateHeaders = {
  "Anthropic-Ratelimit-Unified-5h-Utilization": "0.35",
  "anthropic-ratelimit-unified-7d-utilization": "0.62",
  "anthropic-ratelimit-unified-reset": "1790913600",
  "anthropic-ratelimit-requests-remaining": "42",
};

const cases = [
  { name: "SSE", status: 200, type: "text/event-stream", body: 'event: message_stop\ndata: {"type":"message_stop"}\n\n', stream: true },
  { name: "JSON", status: 200, type: "application/json", body: '{"type":"message","content":[]}', stream: false },
  { name: "upstream error", status: 429, type: "application/json", body: '{"type":"error","error":{"type":"rate_limit_error","message":"fixture refusal"}}', stream: false },
  { name: "count_tokens", status: 200, type: "application/json", body: '{"input_tokens":42}', stream: false, path: "/v1/messages/count_tokens" },
];

for (const fixture of cases) {
  test(`native ${fixture.name} relays rate-limit headers without unrelated upstream headers`, async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(fixture.body, {
          status: fixture.status,
          headers: {
            ...rateHeaders,
            "content-type": fixture.type,
            "retry-after": "30",
            "set-cookie": "fixture=session",
            "x-upstream-private": "fixture-only",
          },
        });
      },
    });
    const config = {
      providers: {},
      claudeCode: { anthropicBaseUrl: upstream.url.toString().replace(/\/$/, "") },
    } as OcxConfig;
    try {
      const request = new Request(`http://localhost${fixture.path ?? "/v1/messages"}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sk-ant-oat01-fixture" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 16, messages: [{ role: "user", content: "fixture" }], stream: fixture.stream }),
      });
      const response = fixture.path
        ? await handleClaudeCountTokens(request, config)
        : await handleClaudeMessages(request, config, { model: "claude-sonnet-4-6", provider: "anthropic-native" });
      const receivedBody = await response.text();
      expect(response.status).toBe(fixture.status);
      for (const [name, value] of Object.entries(rateHeaders)) {
        expect(response.headers.get(name)).toBe(value);
      }
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("x-upstream-private")).toBeNull();
      expect(response.headers.get("content-type")).toBe(fixture.type);
      if (!fixture.stream) expect(response.headers.get("retry-after")).toBe("30");
      expect(receivedBody).toBe(fixture.body);
    } finally {
      await upstream.stop(true);
    }
  });
}

test("missing rate-limit observations are not fabricated", () => {
  expect(anthropicRateLimitHeaders(new Headers({ "content-type": "application/json", "set-cookie": "fixture=session" }))).toEqual({});
});

test("the relay accepts only the Anthropic rate-limit header family", () => {
  expect(anthropicRateLimitHeaders(new Headers({ "ANTHROPIC-RATELIMIT-UNIFIED-STATUS": "allowed", "x-ratelimit-remaining": "100", "anthropic-request-id": "fixture-request" })))
    .toEqual({ "anthropic-ratelimit-unified-status": "allowed" });
});
