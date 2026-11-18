import { comboFailureEvidence } from "../../src/lib/client-error-body";
import { expect, test } from "bun:test";
import { saveConfig } from "../../src/config";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import type { OcxConfig } from "../../src/types";
const sentinel = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
const errors = [
  { type: "invalid_request_error", message: `prompt is too long ${sentinel}` },
  { type: "request_too_large", message: `prompt is too long ${sentinel}` },
  { type: sentinel, code: sentinel, message: sentinel },
  { message: `Your input exceeds the context window of this model ${sentinel}` },
  { type: "server_error", code: "server_error", message: `Your input exceeds the context window of this model ${sentinel}` },
  { type: "rate_limit_error", status: 429, message: `too many tokens per minute ${sentinel}` },
];
for (const native of [false, true]) for (const folded of [false, true]) for (const [i, error] of errors.entries()) {
  test(`${native ? "native" : "translated"} ${folded ? "folded" : "HTTP"} ${i} keeps original decisions`, async () => {
    const release = acquireOwnedSpendHome(); clearKeyCooldowns();
    let calls = 0;
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      calls++;
      const raw = { type: "error", error, request_id: sentinel, [sentinel]: sentinel };
      const body = native ? `event: error\ndata: ${JSON.stringify(raw)}\n\n`
        : `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error } })}\n\n`;
      return folded ? new Response(body, { headers: { "content-type": "text/event-stream" } })
        : Response.json(raw, { status: error.status ?? 400, headers: { "request-id": `req_${sentinel}` } });
    } });
    try {
      const config = { port: 0, defaultProvider: "fixture", providers: { fixture: {
        adapter: native ? "anthropic" : "openai-responses", baseUrl: upstream.url.toString(),
        authMode: "key", apiKey: "fixture", allowPrivateNetwork: true, models: ["wire-model"],
        transientRetry: { maxAttempts: 1 },
      } }, protocols: { rollout: { managedMessagesNative: native } } } as OcxConfig;
      saveConfig(config);
      const ctx: any = { model: "", provider: "" };
      const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture/wire-model", stream: false, max_tokens: 16, messages: [{ role: "user", content: "fixture" }] }) }), config, ctx);
      const text = await response.text();
      if (!folded) {
        const evidence = comboFailureEvidence(response);
        expect(evidence).toBeDefined();
        expect(Object.keys(JSON.parse(evidence!)).sort()).toEqual(["error", "type"]);
        if (native) expect(Object.hasOwn(JSON.parse(evidence!).error, "code")).toBe(false);
      }
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain(sentinel);
      const headers = JSON.stringify([...response.headers]);
      expect(headers.length).toBeGreaterThan(0);
      expect(headers).not.toContain(sentinel);
      expect(calls).toBe(1);
      const body = JSON.parse(text);
      const overflow = i < 2 || (!native && (i === 3 || i === 4));
      expect(response.status).toBe(overflow ? 400 : folded ? 502 : error.status ?? 400);
      if (overflow) expect(body.error.message).toBe("prompt is too long: The request exceeds the model's context window.");
      if (native) expect(Object.hasOwn(body.error, "code")).toBe(false);
      if (!native && overflow) expect(body.error.code).toBe("context_length_exceeded");
    } finally { release(); await upstream.stop(true); }
  });
}

test("native buffered reader retains a primitive original diagnostic internally", async () => {
  const release = acquireOwnedSpendHome();
  const config: any = { defaultProvider: "fixture", providers: { fixture: {
    adapter: "anthropic", authMode: "key", apiKey: "fixture", models: ["wire-model"], baseUrl: "http://127.0.0.1:1", allowPrivateNetwork: true,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({ pull() { throw sentinel; } }), { headers: { "content-type": "application/json" } }),
  } }, protocols: { rollout: { managedMessagesNative: true } } };
  saveConfig(config);
  try {
    const context: any = { model: "", provider: "" };
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ model: "fixture/wire-model", messages: [{ role: "user", content: "fixture" }], max_tokens: 16, stream: false }) }), config, context);
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text.length).toBeGreaterThan(0); expect(text).not.toContain(sentinel);
    expect(context.upstreamError).toBe(sentinel);
  } finally { release(); }
});
