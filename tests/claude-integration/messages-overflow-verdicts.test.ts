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
const laneCases = [
  ["compaction wording", "prompt is too long: 210000 tokens > 200000 maximum", true, false, true],
  ["throughput exclusion", "too many tokens per minute", true, true, false],
  ["quoted wording", "Invalid tool name: 'prompt is too long'", false, false, false],
  ["negated wording", "Your input does not exceed the context window", false, false, false],
  ["validation wording", "Invalid tool name: context window declaration", false, false, false],
  ["conditional wording", "if the prompt is too long, shorten it", false, false, false],
  ["maximum only", "This model's maximum context length is 200000 tokens", false, false, false],
] as const;
for (const lane of lanes) for (const type of ["invalid_request_error", "request_too_large"]) for (const [label, originalMessage, coded, throughput, overflow] of laneCases) {
  test(`${lane}: ${type} ${label}`, async () => {
    const message = `${originalMessage} ${sentinel}`;
    const error = { type, ...(coded ? { code: "context_length_exceeded" } : {}), message, status: 400 };
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
      if (!overflow) expect(text).not.toContain("prompt is too long");
      else expect(text).toContain("prompt is too long");
      const payload = lane === "converter" || lane === "direct-stream" ? JSON.parse(text.split("data: ").at(-1)!) : JSON.parse(text);
      const nativeFold = lane === "native-fold";
      const derivedDirectContext = ["direct-stream", "direct-fold"].includes(lane) && ["negated wording", "validation wording", "maximum only"].includes(label);
      const expectedStatus = lane === "converter" || lane === "direct-stream" ? 200 : nativeFold ? throughput ? 502 : 400 : !coded && !derivedDirectContext && ["translated-json", "direct-fold", "direct-collector"].includes(lane) ? 502 : 400;
      expect(response.status).toBe(expectedStatus);
      const expectedType = lane === "passthrough" || lane === "count_tokens" || lane === "native-http" || lane === "direct-collector" ? type : (nativeFold && throughput) || (lane === "translated-json" && !coded) ? "api_error" : "invalid_request_error";
      expect(payload.error.type).toBe(expectedType);
      if (lane === "native-http" || nativeFold) expect(Object.hasOwn(payload.error, "code")).toBe(false);
      else expect(payload.error.code).toBe(coded || derivedDirectContext ? "context_length_exceeded" : undefined);
    } finally { release?.(); await upstream?.stop(true); }
  });
}

const passthroughCases = [
  ["Anthropic counts", 400, "invalid_request_error", "prompt is too long: 210000 tokens > 200000 maximum", undefined, true],
  ["input verdict", 400, "invalid_request_error", "input is too long for requested model", undefined, true],
  ["size verdict", 413, "request_too_large", "Your request exceeds the model's context window", undefined, true],
  ["coded verdict", 400, "invalid_request_error", "unfamiliar wording", "context_length_exceeded", true],
  ["coded status override", 429, "rate_limit_error", "unfamiliar wording", "context_length_exceeded", true],
  ["quoted verdict", 400, "invalid_request_error", "Invalid tool name: 'prompt is too long'", undefined, false],
  ["negated verdict", 400, "invalid_request_error", "Your input does not exceed the context window", undefined, false],
  ["validation", 400, "invalid_request_error", "Invalid tool name: context window declaration", undefined, false],
  ["conditional", 400, "invalid_request_error", "if the prompt is too long, shorten it", undefined, false],
  ["maximum only", 400, "invalid_request_error", "This model's maximum context length is 200000 tokens", undefined, false],
  ["rate status", 429, "invalid_request_error", "prompt is too long: 210000 tokens > 200000 maximum", undefined, false],
  ["auth status", 401, "invalid_request_error", "input is too long for requested model", undefined, false],
  ["permission status", 403, "invalid_request_error", "input is too long for requested model", undefined, false],
  ["auth type", 400, "authentication_error", "input is too long for requested model", undefined, false],
  ["rate type", 400, "rate_limit_error", "input is too long for requested model", undefined, false],
  ["coded throughput", 429, "rate_limit_error", "too many tokens per minute", "context_length_exceeded", false],
] as const;
for (const count of [false, true]) for (const [label, status, type, message, code, overflow] of passthroughCases) {
  test(`${count ? "count_tokens" : "passthrough"}: original ${label}`, async () => {
    const upstream = Bun.serve({ port: 0, fetch: () => Response.json({ type: "error", error: { type, message: `${message} ${sentinel}`, ...(code ? { code } : {}) } }, { status }) });
    try {
      const config = { providers: {}, claudeCode: { anthropicBaseUrl: upstream.url.toString() } } as OcxConfig;
      const request = new Request(`http://localhost/v1/messages${count ? "/count_tokens" : ""}`, { method: "POST", headers: { authorization: "Bearer sk-ant-oat01-fixture" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 16, stream: false, messages: [{ role: "user", content: "fixture" }] }) });
      const response = count ? await handleClaudeCountTokens(request, config) : await handleClaudeMessages(request, config, { model: "fixture", provider: "fixture" });
      const text = await response.text();
      expect(text.length).toBeGreaterThan(0); expect(text).not.toContain(sentinel);
      expect(response.status).toBe(status);
      const payload = JSON.parse(text);
      expect(payload.error.type).toBe(type);
      expect(payload.error.code).toBe(code);
      expect(payload.error.message.includes("prompt is too long")).toBe(overflow);
    } finally { await upstream.stop(true); }
  });
}

for (const type of ["server_error", "rate_limit_error", "authentication_error"]) test(`native-fold: explicit context code with ${type}`, async () => {
  const release = acquireOwnedSpendHome(); clearKeyCooldowns();
  const error = { type, code: "context_length_exceeded", message: `unfamiliar wording ${sentinel}` };
  const upstream = Bun.serve({ port: 0, fetch: () => new Response(`event: error\ndata: ${JSON.stringify({ type: "error", error })}\n\n`, { headers: { "content-type": "text/event-stream" } }) });
  try {
    const config = { defaultProvider: "fixture", providers: { fixture: { adapter: "anthropic", baseUrl: upstream.url.toString(), authMode: "key", apiKey: "fixture", allowPrivateNetwork: true, models: ["wire-model"] } }, protocols: { rollout: { managedMessagesNative: true } } } as OcxConfig;
    saveConfig(config);
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ model: "fixture/wire-model", max_tokens: 16, stream: false, messages: [{ role: "user", content: "fixture" }] }) }), config, { model: "fixture", provider: "fixture" });
    const text = await response.text();
    expect(text.length).toBeGreaterThan(0); expect(text).not.toContain(sentinel);
    expect(text).toContain("prompt is too long");
    expect(response.status).toBe(502);
    expect(JSON.parse(text).error).toMatchObject({ type: "api_error" });
    expect(Object.hasOwn(JSON.parse(text).error, "code")).toBe(false);
  } finally { release(); await upstream.stop(true); }
});
