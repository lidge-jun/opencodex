import { expect, test } from "bun:test";
import { handleClaudeCountTokens, handleClaudeMessages } from "../../src/server/claude-messages";
import { collectAnthropicMessage, responsesSseToAnthropicSse } from "../../src/claude/outbound";
import { foldAnthropicMessage, encodeAnthropicMessageSse } from "../../src/protocols/encoders/messages";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { AdapterEvent, OcxConfig } from "../../src/types";

const sentinel = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
const input = { model: "claude-sonnet-4-6", max_tokens: 16, messages: [{ role: "user", content: "fixture" }], stream: false };
function contained(text: string) {
  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toContain(sentinel);
}
for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
  for (const status of [200, 400, 401, 402, 403, 404, 409, 413, 429, 500, 502, 503, 504, 529]) {
    test(`buffered passthrough ${path} ${status} ${status === 200 ? "preserves the body" : "rebuilds the envelope"}`, async () => {
      const raw = { type: "error", request_id: sentinel, [sentinel]: sentinel, error: {
        type: sentinel, message: sentinel, code: sentinel, param: sentinel, details: { error_code: sentinel }, nested: [sentinel],
      } };
      const upstream = Bun.serve({ port: 0, fetch: () => Response.json(raw, { status, headers: {
        "request-id": `req_${sentinel}`, "anthropic-ratelimit-requests-remaining": "00042",
        [`anthropic-ratelimit-${sentinel}`]: sentinel, "retry-after": "0",
      } }) });
      try {
        const config = { providers: {}, claudeCode: { anthropicBaseUrl: upstream.url.toString() } } as OcxConfig;
        const req = new Request(`http://localhost${path}`, { method: "POST", headers: {
          "content-type": "application/json", authorization: "Bearer sk-ant-oat01-fixture",
        }, body: JSON.stringify(input) });
        const response = path.endsWith("count_tokens") ? await handleClaudeCountTokens(req, config)
          : await handleClaudeMessages(req, config, { model: input.model, provider: "anthropic-native" });
        const text = await response.text();
        expect(response.status).toBe(status);
        if (status === 200) expect(text).toBe(JSON.stringify(raw));
        else contained(text);
        const headers = JSON.stringify([...response.headers]);
        contained(headers);
        expect(response.headers.get("anthropic-ratelimit-requests-remaining")).toBe("42");
        expect(response.headers.get("retry-after")).toBe("0");
        if (status !== 200) {
          expect(Object.keys(JSON.parse(text)).sort()).toEqual(["error", "type"]);
          expect(Object.keys(JSON.parse(text).error).sort()).toEqual(["message", "type"]);
        }
      } finally { await upstream.stop(true); }
    });
  }
}
const failures = [
  { message: sentinel, type: sentinel, code: sentinel },
  { message: `rate limit reached ${sentinel}` },
  { message: `Your input exceeds the context window of this model ${sentinel}` },
  { message: `Your input exceeds the context window of this model ${sentinel}`, code: "server_error" },
  { message: `too many tokens per minute ${sentinel}`, type: "rate_limit_error", code: "rate_limit_exceeded", status: 429 },
  { message: sentinel, type: "rate_limit_error" },
  { message: `Your input exceeds the context window of this model ${sentinel}`, code: "upstream_server_error" },
];
for (const [index, error] of failures.entries()) {
  for (const direct of [false, true]) test(`${direct ? "direct" : "converter"} failed ${index} owns message and preserves decided type`, async () => {
    const budget = createTestTranslatorBudget();
    const frames = `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error } })}\n\n`;
    const events = (async function* () { yield { ...error, type: "error", errorType: error.type } as AdapterEvent; })();
    const stream = direct ? encodeAnthropicMessageSse(events, { model: "fixture", translatorBudget: budget })
      : responsesSseToAnthropicSse(new Response(frames).body!, "fixture", { translatorBudget: budget, pingIntervalMs: 0 });
    const text = await new Response(stream).text();
    contained(text);
    expect(text).toContain("event: error\n");
    const payload = JSON.parse(text.split("data: ").at(-1)!);
    if (index === 2 || index === 3 || index === 6) expect(payload.error).toMatchObject({ type: "invalid_request_error", code: "context_length_exceeded", message: "prompt is too long: The request exceeds the model's context window." });
    if (index === 4 || index === 5) expect(payload.error.type).toBe("rate_limit_error");
    const foldBudget = createTestTranslatorBudget();
    const fold = direct ? await foldAnthropicMessage((async function* () { yield { ...error, type: "error", errorType: error.type } as AdapterEvent; })(), { model: "fixture", translatorBudget: foldBudget }) : null;
    if (fold) {
      const body = await fold.text(); contained(body);
      expect(fold.status).toBe(index === 2 || index === 3 || index === 6 ? 400 : 502);
      expect(JSON.parse(body).error.type).toBe(payload.error.type);
    }
  });
}
test("converter reader exception uses fixed wording", async () => {
  const stream = new ReadableStream<Uint8Array>({ pull() { throw new Error(sentinel); } });
  const text = await new Response(responsesSseToAnthropicSse(stream, "fixture", { translatorBudget: createTestTranslatorBudget(), pingIntervalMs: 0 })).text();
  contained(text);
  expect(text).toContain("The proxy could not reach or read the provider.");
});
for (const role of [sentinel, { [sentinel]: sentinel }, [sentinel]]) test(`rejected role ${JSON.stringify(role)} uses a placeholder`, async () => {
  const req = new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ ...input, model: "fixture/model", messages: [{ role, content: "fixture" }] }) });
  const response = await handleClaudeMessages(req, { providers: {}, claudeCode: { enabled: true } } as OcxConfig, { model: "fixture/model", provider: "fixture" });
  const text = await response.text(); contained(text);
  expect(JSON.parse(text).error.message).toBe("unsupported message role: unsupported");
});

for (const direct of [false, true]) test(`${direct ? "direct" : "converter"} uses original structured billing evidence`, async () => {
  const error = { type: "rate_limit_error", code: "insufficient_quota", message: sentinel, status: 429 };
  const events = (async function* () { yield { ...error, type: "error", errorType: error.type } as AdapterEvent; })();
  const budget = createTestTranslatorBudget();
  const stream = direct ? encodeAnthropicMessageSse(events, { model: "fixture", translatorBudget: budget })
    : responsesSseToAnthropicSse(new Response(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error } })}\n\n`).body!, "fixture", { translatorBudget: budget });
  const text = await new Response(stream).text();
  expect(text.length).toBeGreaterThan(0); expect(text).not.toContain(sentinel);
  expect(JSON.parse(text.split("data: ").at(-1)!).error).toEqual({ type: "rate_limit_error", message: "The provider account has no remaining quota or credits." });
});
test("direct reader exception uses the transport contract", async () => {
  const events = (async function* (): AsyncGenerator<AdapterEvent> { throw new Error(sentinel); })();
  const text = await new Response(encodeAnthropicMessageSse(events, { model: "fixture", translatorBudget: createTestTranslatorBudget() })).text();
  expect(text.length).toBeGreaterThan(0); expect(text).not.toContain(sentinel);
  expect(text).toContain("The proxy could not reach or read the provider.");
});
test("a direct reader exception quoting overflow wording does not gain an overflow code", async () => {
  const events = (async function* (): AsyncGenerator<AdapterEvent> { throw new Error("prompt is too long"); })();
  const text = await new Response(encodeAnthropicMessageSse(events, { model: "fixture", translatorBudget: createTestTranslatorBudget() })).text();
  expect(JSON.parse(text.split("data: ").at(-1)!).error.type).toBe("overloaded_error");
  expect(text).not.toContain("context_length_exceeded");
});

for (const [status, message, expectedStatus, expectedCode] of [
  [500, "Your input exceeds the context window of this model", 400, "context_length_exceeded"],
  [500, "x".repeat(450) + " Your input exceeds the context window of this model", 400, "context_length_exceeded"],
  [500, "If input exceeds the context window, shorten it; the server is unavailable", 529, undefined],
  [500, "If input exceeds the context window, shorten it. This input exceeds the context window.", 400, "context_length_exceeded"],
  [402, "Your input exceeds the context window of this model", 402, undefined],
  [429, "Your input exceeds the context window of this model", 429, undefined],
] as const) {
  test(`translated plain-text HTTP ${status} keeps the correct overflow or billing class`, async () => {
    const releaseSpend = acquireOwnedSpendHome();
    let sends = 0;
    const config = { defaultProvider: "a", providers: { a: {
      adapter: "openai-responses", authMode: "key", baseUrl: "https://responses.example/v1", apiKey: "key-a",
      models: ["m"], transientRetryOn5xx: { attempts: 3 },
    } } } as unknown as OcxConfig;
    const req = new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, model: "m" }) });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { sends += 1; return new Response(message, { status }); }) as typeof fetch;
    try {
      const response = await handleClaudeMessages(req, config, { model: "", provider: "" });
      const error = (await response.json() as { error: { code?: string; message: string } }).error;
      expect(response.status, JSON.stringify({ sends, error })).toBe(expectedStatus);
      if (expectedCode) {
        expect(sends).toBe(1);
        expect(error.code).toBe(expectedCode);
        expect(error.message).toBe("prompt is too long: The request exceeds the model's context window.");
      } else {
        expect(error.code).not.toBe("context_length_exceeded");
        if (status === 500) expect(sends).toBe(3);
      }
    } finally { globalThis.fetch = originalFetch; releaseSpend(); }
  });
}

for (const count of [false, true]) test(`success ${count ? "count_tokens" : "Messages"} has a literal JSON media type`, async () => {
  const raw = count ? '{"input_tokens":42}' : '{"type":"message","content":[]}';
  const upstream = Bun.serve({ port: 0, fetch: () => new Response(raw, { headers: { "content-type": `application/json; fixture=${sentinel}` } }) });
  try {
    const req = new Request(`http://localhost/v1/messages${count ? "/count_tokens" : ""}`, { method: "POST", headers: { authorization: "Bearer sk-ant-oat01-fixture" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 16, messages: [{ role: "user", content: "fixture" }], stream: false }) });
    const config: any = { providers: {}, claudeCode: { anthropicBaseUrl: upstream.url.toString() } };
    const response = count ? await handleClaudeCountTokens(req, config) : await handleClaudeMessages(req, config, { model: "fixture", provider: "fixture" });
    expect(await response.text()).toBe(raw);
    expect(response.headers.get("content-type")).toBe("application/json");
    const text = JSON.stringify([...response.headers]);
    expect(text.length).toBeGreaterThan(0); expect(text).not.toContain(sentinel);
  } finally { await upstream.stop(true); }
});
