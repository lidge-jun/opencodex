import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

type Rec = Record<string, any>;
const REASONING = "Inspect the fixture before answering.";
const ADMISSION_KEY = "fixture-data-key";
const USER = { role: "user", content: "Inspect the fixture." };
const tool = (id: string) => ({ id, type: "function", function: { name: "inspect", arguments: "{}" } });
const TOOLS = [{ type: "function", function: { name: "inspect", parameters: { type: "object", properties: {} } } }];
const ASSISTANT = { role: "assistant", content: null, tool_calls: [tool("call_a"), tool("call_b")] };
const HISTORY = [USER, ASSISTANT, { role: "tool", tool_call_id: "call_a", content: "a" },
  { role: "tool", tool_call_id: "call_b", content: "b" }];
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome;
let home: string;
let proxy: ReturnType<typeof startServer> | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let captured: Rec[];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-native-reasoning-"));
  process.env.OPENCODEX_HOME = home;
  codexHome = installIsolatedCodexHome("ocx-native-reasoning-codex-");
  captured = [];
  clearReasoningReplayCacheForTests();
});
afterEach(async () => {
  await proxy?.stop(true);
  upstream?.stop(true);
  proxy = undefined;
  upstream = undefined;
  clearReasoningReplayCacheForTests();
  codexHome.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function start(providerName: string, model: string, options: {
  sse?: boolean;
  provider?: Partial<OcxProviderConfig>;
  requireOriginal?: boolean;
  truncate?: boolean;
} = {}) {
  upstream = Bun.serve({ port: 0, async fetch(req) {
    expect(new URL(req.url).pathname).toBe("/v1/chat/completions");
    const body = await req.json() as Rec;
    captured.push(body);
    // DeepSeek requires reasoning on every assistant turn when tools are supplied,
    // including earlier turns that answered without invoking a tool.
    if (body.tools?.length && body.messages.some((m: Rec) => m.role === "assistant"
        && (typeof m.reasoning_content !== "string" || m.reasoning_content.length === 0))) {
      return Response.json({ error: { type: "invalid_request_error",
        message: "The `reasoning_content` in the thinking mode must be passed back to the API." } }, { status: 400 });
    }
    const assistant = body.messages.find((m: Rec) => m.role === "assistant" && m.tool_calls?.length);
    if (assistant) {
      if (typeof assistant.reasoning_content !== "string" || assistant.reasoning_content.length === 0
          || (options.requireOriginal && assistant.reasoning_content !== REASONING)) {
        return Response.json({ error: { type: "invalid_request_error",
          message: "The `reasoning_content` in the thinking mode must be passed back to the API." } }, { status: 400 });
      }
      return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }] });
    }
    if (options.sse) {
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Inspect the " } }] },
        { choices: [{ index: 0, delta: { reasoning_content: "fixture before answering." } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ ...tool("call_a"), index: 0 }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ ...tool("call_b"), index: 1 }] } }] },
        ...(!options.truncate ? [{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }] : []),
      ];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")
        + (options.truncate ? "" : "data: [DONE]\n\n"), { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ choices: [{ index: 0,
      message: { ...ASSISTANT, reasoning_content: REASONING }, finish_reason: "tool_calls" }] });
  } });
  saveConfig({ port: 0,
    apiKeys: [{ id: "fixture-key-id", name: "fixture", key: ADMISSION_KEY, createdAt: "2026-01-01T00:00:00Z" }],
    defaultProvider: providerName, providers: { [providerName]: {
    adapter: "openai-chat", baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
    apiKey: "fixture-key", allowPrivateNetwork: true, models: [model], ...options.provider,
  } } } as OcxConfig);
  proxy = startServer(0);
  return async (messages: Rec[], stream = false, thread: string | null = "fixture-thread", extra: Rec = {}) => {
    const response = await fetch(new URL("/v1/chat/completions", proxy!.url), {
      method: "POST", headers: { "content-type": "application/json", "x-opencodex-api-key": ADMISSION_KEY,
        ...(thread ? { "thread-id": thread } : {}) },
      body: JSON.stringify({ model: `${providerName}/${model}`, stream, messages, tools: TOOLS, ...extra }),
    });
    const text = await response.text();
    return { status: response.status, text };
  };
}

describe("#7118 native Chat thinking continuation", () => {
  for (const [providerName, model] of [
    ["go-fixture", "deepseek-v4.1-flash"], ["deepseek-fixture", "deepseek-flash"],
    ["custom", "deepseek/deepseek-v5.2-flash"], ["custom", "DeepSeek-V4.1-Pro:thinking"],
  ]) {
    test(`${providerName}/${model}: JSON response replays original reasoning for parallel tool calls`, async () => {
      const send = start(providerName!, model!, { requireOriginal: true,
        ...(providerName === "go-fixture" ? {
          provider: { preserveReasoningContentModels: ["deepseek-v4-flash", "deepseek-v4.1-flash"] },
        } : {}),
      });
      expect((await send([USER])).status).toBe(200);
      // WorkBuddy-like clients return standard Chat history and omit the provider extension.
      const continued = await send(HISTORY, false, "fixture-thread", { reasoning_effort: "high", logit_bias: { "8": 1 } });
      expect(continued.status).toBe(200);
      expect(captured[1]!.messages[1].reasoning_content).toBe(REASONING);
      expect(captured[1]!.messages[1].tool_calls).toEqual(ASSISTANT.tool_calls);
      expect(captured[1]).not.toHaveProperty("input");
      expect(captured[1]!.logit_bias).toEqual({ "8": 1 });
      // Cache lookup is non-destructive so a retry has the same wire history.
      expect((await send(HISTORY)).status).toBe(200);
    });
  }
  for (const stream of [true, false]) {
    test(`fragmented upstream SSE replays reasoning when client stream=${stream}`, async () => {
      const send = start("go-fixture", "deepseek-v4.1-flash", { sse: true, requireOriginal: true });
      const first = await send([USER], stream);
      expect(first.status).toBe(200);
      expect(first.text).toContain("call_b");
      expect((await send(HISTORY)).status).toBe(200);
      expect(captured[1]!.messages[1].reasoning_content).toBe(REASONING);
    });
  }
  test("a manually preserve-listed custom model participates on the native lane", async () => {
    const send = start("custom", "private-thinking-model", {
      provider: { preserveReasoningContentModels: ["private-thinking-model"] }, requireOriginal: true,
    });
    await send([USER]);
    expect((await send(HISTORY)).status).toBe(200);
  });
  test("supplied reasoning survives unchanged and takes precedence over the cache", async () => {
    const send = start("custom", "deepseek-v4.1-flash");
    await send([USER]);
    const assistant = { ...ASSISTANT, reasoning_content: "client-owned reasoning", name: "assistant-name" };
    expect((await send([USER, assistant, ...HISTORY.slice(2)])).status).toBe(200);
    expect(captured[1]!.messages[1]).toEqual(assistant);
  });
  test("tool-enabled DeepSeek history repairs earlier assistant turns without tool calls", async () => {
    const send = start("custom", "deepseek-v4.1-flash");
    const earlier = { role: "assistant", content: "Earlier answer" };
    const messages = [USER, earlier, { role: "user", content: "Now inspect the fixture" }, ...HISTORY.slice(1)];
    expect((await send(messages)).status).toBe(200);
    expect(captured.at(-1)!.messages[1]).toEqual({ ...earlier, reasoning_content: " " });
    expect(captured.at(-1)!.tools).toEqual(TOOLS);
    expect((await send([USER, { ...earlier, reasoning_content: "original earlier reasoning" },
      ...messages.slice(2)])).status).toBe(200);
    expect(captured.at(-1)!.messages[1].reasoning_content).toBe("original earlier reasoning");
  });
  test("a JSON upstream reply also seeds replay for a streaming client", async () => {
    const send = start("go-fixture", "deepseek-v4.1-flash", { requireOriginal: true });
    const first = await send([USER], true);
    expect(first.text).toContain("data: [DONE]");
    expect((await send(HISTORY)).status).toBe(200);
  });
  test("headerless or resumed cache misses use the configured placeholder, without sharing raw reasoning", async () => {
    const send = start("go-fixture", "deepseek-v4.1-flash");
    await send([USER]);
    for (const thread of [null, "other-thread", "fixture-thread"]) {
      if (thread === "fixture-thread") clearReasoningReplayCacheForTests();
      expect((await send(HISTORY, false, thread)).status).toBe(200);
      expect(captured.at(-1)!.messages[1].reasoning_content).toBe(" ");
    }
  });
  test("an explicit preserve opt-out leaves missing native history unchanged", async () => {
    const send = start("custom", "deepseek-v4.1-flash", { provider: { preserveReasoningContentModels: [] } });
    await send([USER]);
    expect((await send(HISTORY)).status).toBe(400);
    expect(captured[1]!.messages).toEqual(HISTORY);
  });
  test("a placeholder opt-out still permits real cached reasoning", async () => {
    const send = start("custom", "deepseek-v4.1-flash", { provider: { requiresReasoningPlaceholderModels: [] } });
    expect((await send(HISTORY)).status).toBe(400);
    await send([USER]);
    expect((await send(HISTORY)).status).toBe(200);
    expect(captured.at(-1)!.messages[1].reasoning_content).toBe(REASONING);
  });
  test("a truncated tool stream cannot seed continuation reasoning", async () => {
    const send = start("custom", "deepseek-v4.1-flash", {
      sse: true, truncate: true, provider: { requiresReasoningPlaceholderModels: [] },
    });
    const first = await send([USER], true);
    expect(first.text).toContain("upstream_sse_truncated");
    expect((await send(HISTORY)).status).toBe(400);
    expect(captured[1]!.messages).toEqual(HISTORY);
  });
});
