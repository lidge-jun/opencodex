import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { getRequestLogEntries } from "../../src/server/request-log";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const thinking = { type: "thinking", thinking: [{ type: "text", text: "We" }], closed: true };
const content = [thinking, { type: "text", text: "Hello" }, { type: "text", text: "!" }];
const usage = { prompt_tokens: 12, completion_tokens: 4 };
const actualFetch = globalThis.fetch;
let home = "";
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  codexHome = installIsolatedCodexHome("ocx-native-mistral-");
  home = mkdtempSync(join(tmpdir(), "ocx-native-mistral-"));
  process.env.OPENCODEX_HOME = home;
});
afterEach(() => {
  globalThis.fetch = actualFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  codexHome.restore();
  removeTreeWithRetry(home);
});

async function exchange(upstreamStream: boolean, clientStream: boolean, parts: unknown[] = content, baseUrl = "https://api.mistral.ai/v1") {
  let sends = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== baseUrl + "/chat/completions") throw new Error("Unexpected outbound request in fixture");
    sends++;
    const common = { id: "chatcmpl-fixture", model: "deepseek-v4-1-flash-1017", created: 1 };
    if (!upstreamStream) return Response.json({ ...common, object: "chat.completion", choices: [
      { index: 0, message: { role: "assistant", content: parts }, finish_reason: "stop" },
    ], usage });
    const chunks = parts === content
      ? [{ choices: [{ index: 0, delta: { role: "assistant", content: [thinking] } }] },
        { choices: [{ index: 0, delta: { content: parts.slice(1) } }] }]
      : [{ choices: [{ index: 0, delta: { content: parts } }], usage }];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify({ ...common, ...chunk })}\n\n`).join("")
      + `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  saveConfig({ port: 0, defaultProvider: "fixture", providers: {
    fixture: { adapter: "openai-chat", authMode: "key", baseUrl, apiKey: "test-key", models: ["deepseek-v4-1-flash-1017"] },
  } });
  const server = startServer(0);
  try {
    const response = await actualFetch(new URL("/v1/chat/completions", server.url), { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture/deepseek-v4-1-flash-1017", messages: [{ role: "user", content: "Hi" }], stream: clientStream }) });
    const text = await response.text();
    return { status: response.status, text, sends, log: getRequestLogEntries().at(-1), payloads: clientStream
      ? text.split(/\r?\n/).filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)))
      : [JSON.parse(text)] };
  } finally { await server.stop(true); }
}

describe("native Mistral typed content becomes OpenAI Chat strings", () => {
  for (const upstreamStream of [false, true]) for (const clientStream of [false, true]) {
    test(`upstream SSE=${upstreamStream}, caller stream=${clientStream}`, async () => {
      const result = await exchange(upstreamStream, clientStream);
      expect(result.status).toBe(200);
      expect(result.sends).toBe(1);
      const messages = result.payloads.flatMap(frame => frame.choices ?? []).map(choice => choice.delta ?? choice.message);
      expect(messages.map(message => message.content ?? "").join("")).toBe("Hello!");
      expect(messages.map(message => message.reasoning_content ?? "").join("")).toBe("We");
      expect(messages.every(message => !Array.isArray(message.content))).toBe(true);
      expect(result.payloads.some(frame => frame.usage?.prompt_tokens === 12)).toBe(true);
      if (clientStream) expect(result.text).toContain("data: [DONE]");
    });
  }
  test("other Chat destinations retain their content representation", async () => {
    const result = await exchange(false, false, content, "https://gateway.example/v1");
    expect(result.payloads[0].choices[0].message.content).toEqual(content);
  });
  test("an unsupported array block fails closed instead of forwarding an object", async () => {
    for (const streaming of [false, true]) {
      const result = await exchange(streaming, streaming, [{ type: "unknown", text: "private fixture" }]);
      expect(result.text).not.toContain("private fixture");
      expect(result.log?.usage).toMatchObject({ inputTokens: 12, outputTokens: 4 });
      expect(result.text).toContain("error");
      if (!streaming) expect(result.status).toBe(502);
    }
  });
});
