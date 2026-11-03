import { expect, test } from "bun:test";
import { saveConfig } from "../../src/config";
import { handleClaudeCountTokens, handleClaudeMessages } from "../../src/server/claude-messages";
import { collectAnthropicMessageResponse, encodeAnthropicMessageSse, foldAnthropicMessage } from "../../src/protocols/encoders/messages";
import { responsesSseToAnthropicSse } from "../../src/claude/outbound";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import type { AdapterEvent, OcxConfig } from "../../src/types";
const sentinel = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
const lanes = ["passthrough", "count_tokens", "native-http", "native-fold", "translated-http", "translated-fold", "translated-json", "converter", "direct-stream", "direct-fold", "direct-collector"] as const;
for (const lane of lanes) for (const type of ["invalid_request_error", "request_too_large"]) for (const throughput of [false, true]) {
  test(`${lane}: ${type} ${throughput ? "throughput exclusion" : "compaction wording"}`, async () => {
    const message = `${throughput ? "too many tokens per minute" : "prompt is too long: 210000 tokens > 200000 maximum"} ${sentinel}`;
    const error = { type, code: "context_length_exceeded", message, status: 400 };
    let response: Response;
    let upstream: ReturnType<typeof Bun.serve> | undefined;
    let release: (() => void) | undefined;
    try {
      if (["converter", "direct-stream", "direct-fold", "direct-collector"].includes(lane)) {
        const events = () => (async function* () { yield { ...error, type: "error", errorType: type } as AdapterEvent; })();
        const translatorBudget = createTestTranslatorBudget();
        if (lane === "direct-fold") response = await foldAnthropicMessage(events(), { model: "fixture", translatorBudget });
        else if (lane === "direct-collector") response = await collectAnthropicMessageResponse(new Response(`event: error\ndata: ${JSON.stringify({ type: "error", error })}\n\n`).body!, "fixture", translatorBudget);
        else response = new Response(lane === "converter"
          ? responsesSseToAnthropicSse(new Response(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error } })}\n\n`).body!, "fixture", { translatorBudget, pingIntervalMs: 0 })
          : encodeAnthropicMessageSse(events(), { model: "fixture", translatorBudget }));
      } else {
        const passthrough = lane === "passthrough" || lane === "count_tokens";
        const native = lane.startsWith("native");
        release = acquireOwnedSpendHome(); clearKeyCooldowns();
        upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
          if (lane.endsWith("fold")) return new Response(native
            ? `event: error\ndata: ${JSON.stringify({ type: "error", error })}\n\n`
            : `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
          if (lane === "translated-json") return Response.json({ status: "failed", error });
          return Response.json({ type: "error", error }, { status: 400 });
        } });
        const config = (passthrough ? { providers: {}, claudeCode: { anthropicBaseUrl: upstream.url.toString() } }
          : { defaultProvider: "fixture", providers: { fixture: { adapter: native ? "anthropic" : "openai-responses", baseUrl: upstream.url.toString(), authMode: "key", apiKey: "fixture", allowPrivateNetwork: true, models: ["wire-model"] } }, protocols: { rollout: { managedMessagesNative: native } } }) as OcxConfig;
        saveConfig(config);
        const request = new Request(`http://localhost/v1/messages${lane === "count_tokens" ? "/count_tokens" : ""}`, { method: "POST", headers: { "content-type": "application/json", ...(passthrough ? { authorization: "Bearer sk-ant-oat01-fixture" } : {}) }, body: JSON.stringify({ model: passthrough ? "claude-sonnet-4-6" : "fixture/wire-model", max_tokens: 16, stream: false, messages: [{ role: "user", content: "fixture" }] }) });
        response = lane === "count_tokens" ? await handleClaudeCountTokens(request, config) : await handleClaudeMessages(request, config, { model: "fixture", provider: "fixture" });
      }
      const text = await response.text();
      expect(text.length).toBeGreaterThan(0); expect(text).not.toContain(sentinel);
      if (throughput) expect(text).not.toContain("prompt is too long");
      else expect(text).toContain("prompt is too long");
      const payload = lane === "converter" || lane === "direct-stream" ? JSON.parse(text.split("data: ").at(-1)!) : JSON.parse(text);
      const nativeFold = lane === "native-fold";
      const expectedStatus = lane === "converter" || lane === "direct-stream" ? 200 : nativeFold && throughput ? 502 : 400;
      expect(response.status).toBe(expectedStatus);
      const expectedType = lane === "passthrough" || lane === "count_tokens" || lane === "native-http" || lane === "direct-collector" ? type : nativeFold && throughput ? "api_error" : "invalid_request_error";
      expect(payload.error.type).toBe(expectedType);
      if (lane === "native-http" || nativeFold) expect(Object.hasOwn(payload.error, "code")).toBe(false);
      else expect(payload.error.code).toBe("context_length_exceeded");
    } finally { release?.(); await upstream?.stop(true); }
  });
}
