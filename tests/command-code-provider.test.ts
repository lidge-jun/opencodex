import { afterEach, describe, expect, test } from "bun:test";
import { createCommandCodeAdapter } from "../src/adapters/command-code";
import { loginCommandCode, parseCommandCodeCallback, shouldImportLocalCommandCodeAuth } from "../src/oauth/command-code";
import { buildModelsRequest, OAUTH_PROVIDERS } from "../src/oauth";
import { commandCodeReasoningEfforts, resetCommandCodeReasoningEffortsForTest } from "../src/providers/command-code-efforts";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const provider: OcxProviderConfig = {
  adapter: "command-code",
  baseUrl: "https://api.commandcode.ai",
  authMode: "oauth",
  apiKey: "secret-command-key",
  defaultMaxOutputTokens: 64_000,
};

function parsed(modelId = "deepseek/deepseek-v4-flash"): OcxParsedRequest {
  return {
    modelId,
    stream: true,
    context: {
      systemPrompt: ["system"],
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools: [{ name: "lookup", description: "lookup", parameters: { type: "object" } }],
    },
    options: { reasoning: "high", maxOutputTokens: 100 },
  };
}

async function builtRequest(...args: Parameters<ReturnType<typeof createCommandCodeAdapter>["buildRequest"]>) {
  return createCommandCodeAdapter(provider).buildRequest(...args);
}

afterEach(() => resetCommandCodeReasoningEffortsForTest());

describe("Command Code provider", () => {
  test("registry and OAuth surfaces stay in parity", () => {
    const registry = PROVIDER_REGISTRY.find(row => row.id === "command-code");
    expect(registry).toMatchObject({
      adapter: "command-code",
      authKind: "oauth",
      defaultModel: "deepseek/deepseek-v4-flash",
      liveModels: true,
      modelDiscovery: {
        url: "https://api.commandcode.ai/provider/v1/models",
        maxResponseBytes: 262_144,
        maxModels: 256,
      },
    });
    expect(registry?.models).toBeUndefined();
    expect(registry?.modelReasoningEfforts).toMatchObject({
      "deepseek/deepseek-v4-flash": ["high", "max"],
      "zai-org/glm-5.2": ["high", "max"],
    });
    expect(OAUTH_PROVIDERS["command-code"]?.providerConfig).toMatchObject({
      adapter: "command-code",
      baseUrl: "https://api.commandcode.ai",
      authMode: "oauth",
    });
  });

  test("validates callback shape and state without exposing the key", () => {
    const secret = "super-secret-callback-key";
    const parsedCallback = parseCommandCodeCallback({ apiKey: secret, state: "state", userId: "u", userName: "name", keyName: "cli" }, "state");
    expect(parsedCallback).toMatchObject({ userId: "u" });
    let thrown = "";
    try {
      parseCommandCodeCallback({ apiKey: secret, state: "wrong", userId: "u", userName: "name", keyName: "cli" }, "state");
    } catch (error) { thrown = String(error); }
    expect(thrown).toContain("state mismatch");
    expect(thrown).not.toContain(secret);
  });

  test("rejects an already-aborted login before it creates a callback server", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before login"));
    await expect(loginCommandCode({ signal: controller.signal }, { importLocal: "off" })).rejects.toThrow("cancelled before login");
  });

  test("accepts a manually pasted API key when the browser callback cannot reach the loopback server", async () => {
    const controller = new AbortController();
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const href = String(input);
      calls.push(href);
      if (href.includes("whoami")) return new Response(JSON.stringify({ ok: true, user: { id: "u-1", userName: "tester" } }), { status: 200 });
      throw new Error(`unexpected fetch: ${href}`);
    }) as typeof globalThis.fetch;
    try {
      const credentials = await loginCommandCode({
        onAuth: () => {},
        onProgress: () => {},
        onManualCodeInput: async () => "sk-pasted-key",
        signal: controller.signal,
      }, { importLocal: "off" });
      expect(credentials).toMatchObject({ access: "sk-pasted-key", source: "oauth", accountId: "u-1" });
      expect(calls.some(href => href.includes("whoami"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects a pasted API key whose whoami identity is incomplete", async () => {
    const controller = new AbortController();
    const originalFetch = globalThis.fetch;
    let whoamiCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const href = String(input);
      if (href.includes("whoami")) {
        whoamiCalls += 1;
        return new Response(JSON.stringify({ ok: true, user: { id: "", userName: "" } }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${href}`);
    }) as typeof globalThis.fetch;
    try {
      // With an incomplete identity, the manual loop keeps re-prompting; abort to stop it.
      const login = loginCommandCode({
        onAuth: () => {},
        onProgress: () => {},
        onManualCodeInput: async () => "sk-incomplete-key",
        signal: controller.signal,
      }, { importLocal: "off" });
      controller.abort(new Error("cancelled"));
      await expect(login).rejects.toThrow("cancelled");
      expect(whoamiCalls).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses live account discovery and only imports local CLI auth for the first account", () => {
    const request = buildModelsRequest(provider, "secret-command-key", "command-code");
    expect(request).toEqual({
      url: "https://api.commandcode.ai/provider/v1/models",
      headers: { Authorization: "Bearer secret-command-key" },
    });
    expect(shouldImportLocalCommandCodeAuth()).toBe(true);
    expect(shouldImportLocalCommandCodeAuth({ importLocal: "off" })).toBe(false);
  });

  test("builds the proprietary generate request with an officially supported effort and bearer auth", async () => {
    const built = await builtRequest(parsed());
    const body = JSON.parse(built.body);
    expect(built.url).toBe("https://api.commandcode.ai/alpha/generate");
    expect(built.headers.Authorization).toBe("Bearer secret-command-key");
    expect(body.params).toMatchObject({ model: "deepseek/deepseek-v4-flash", reasoning_effort: "high", max_tokens: 100, stream: true });
    expect(body.params.tools[0]).toMatchObject({ name: "lookup" });
    expect(built.body).not.toContain("secret-command-key");
  });

  test("passes every canonical Command Code id through unchanged", async () => {
    const built = await builtRequest(parsed("xai/grok-4.5"));
    expect(JSON.parse(built.body).params.model).toBe("xai/grok-4.5");
  });

  test("carries tool-result images in a follow-up user message instead of dropping them", async () => {
    const image = "data:image/png;base64,AAAA";
    const built = await builtRequest({
      ...parsed(),
      context: {
        ...parsed().context,
        messages: [{
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "view_image",
          content: [{ type: "text", text: "screenshot:" }, { type: "image", imageUrl: image }],
          isError: false,
          timestamp: 1,
        }],
      },
    });
    const body = JSON.parse(built.body);
    expect(body.params.messages).toEqual([
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "view_image", output: { type: "text", value: "screenshot:[image]" } }] },
      { role: "user", content: [{ type: "image", image, mediaType: "image/png" }] },
    ]);
  });

  test("keeps the generate config to bounded workspace and git metadata", async () => {
    const built = await builtRequest(parsed());
    const body = JSON.parse(built.body);
    expect(body.config).toHaveProperty("isGitRepo");
    expect(body.config).toHaveProperty("currentBranch");
    expect(body.config).toHaveProperty("mainBranch");
    expect(body.config).toHaveProperty("gitStatus");
    expect(body.config).toHaveProperty("recentCommits");
    expect(Array.isArray(body.config.recentCommits)).toBe(true);
    expect(body.config.recentCommits.length).toBeLessThanOrEqual(8);
    expect(body.config.recentCommits.every((entry: string) => entry.length <= 512)).toBe(true);
    expect(body.config.gitStatus.length).toBeLessThanOrEqual(2048);
    expect(body.config.structure).toBeInstanceOf(Array);
    expect(typeof body.config.workingDir).toBe("string");
    expect(built.headers["x-project-slug"]?.length ?? 0).toBeLessThanOrEqual(64);
    // This test runs inside a git worktree, so the real (non-fallback) metadata path
    // must populate the repo/branch instead of returning the empty fallback.
    expect(body.config.isGitRepo).toBe(true);
    expect(body.config.currentBranch).not.toBe("");
  });

  test("does not advertise an unverified effort for models absent from the official table", async () => {
    const built = await builtRequest(parsed("moonshotai/Kimi-K3"));
    expect(JSON.parse(built.body).params).not.toHaveProperty("reasoning_effort");
  });

  test("maps ultra and xhigh to the max wire effort and honors legacy alias ids", async () => {
    const ultra = await builtRequest({ ...parsed(), options: { reasoning: "ultra", maxOutputTokens: 100 } });
    expect(JSON.parse(ultra.body).params.reasoning_effort).toBe("max");
    const xhigh = await builtRequest({ ...parsed(), options: { reasoning: "xhigh", maxOutputTokens: 100 } });
    expect(JSON.parse(xhigh.body).params.reasoning_effort).toBe("max");
    // Legacy compatibility id resolves to the canonical effort table before the lookup.
    const legacy = await builtRequest({ ...parsed(), modelId: "deepseek-v4-flash" });
    expect(JSON.parse(legacy.body).params.reasoning_effort).toBe("high");
  });

  test("filters tool declarations when tool_choice disables tools", async () => {
    const built = await builtRequest({ ...parsed(), options: { toolChoice: "none" } });
    expect(JSON.parse(built.body).params.tools).toEqual([]);
  });

  test("matches a forced namespaced tool choice by dot alias", async () => {
    const namespacedParsed = {
      ...parsed(),
      context: {
        ...parsed().context,
        tools: [{ name: "exec_command", namespace: "functions", description: "exec", parameters: { type: "object" } }],
      },
      options: { toolChoice: { name: "functions.exec_command" } },
    };
    const built = await builtRequest(namespacedParsed);
    const tools = JSON.parse(built.body).params.tools;
    expect(tools).toEqual([{ name: "functions__exec_command", description: "exec", input_schema: { type: "object" } }]);
  });

  test("refreshes a stale official effort record only after a reasoning rejection and retries without it", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      requests.push({ url: href, body: typeof init?.body === "string" ? init.body : undefined });
      if (href.includes("commandcode.ai/models/")) {
        return new Response("Reasoning efforts high are supported; no other reasoning settings.");
      }
      return requests.filter(request => request.url.endsWith("/alpha/generate")).length === 1
        ? new Response(JSON.stringify({ error: "unsupported reasoning_effort" }), { status: 400 })
        : new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    const adapter = createCommandCodeAdapter({ ...provider, fetch } as OcxProviderConfig);
    const request = await adapter.buildRequest({ ...parsed(), options: { reasoning: "max" } });
    const response = await adapter.fetchResponse!(request);
    expect(response.ok).toBe(true);
    expect(commandCodeReasoningEfforts("deepseek/deepseek-v4-flash")).toEqual(["high"]);
    const generated = requests.filter(request => request.url.endsWith("/alpha/generate"));
    expect(JSON.parse(generated[1]!.body!).params).not.toHaveProperty("reasoning_effort");
  });

  test("omits effort when the caller did not choose one", async () => {
    const built = await builtRequest({ ...parsed("claude-haiku-4-5"), options: { maxOutputTokens: 100 } });
    expect(JSON.parse(built.body).params).not.toHaveProperty("reasoning_effort");
  });

  test("parses NDJSON text, reasoning, tools, usage, and finish", async () => {
    const response = new Response([
      JSON.stringify({ type: "reasoning-delta", text: "think" }),
      JSON.stringify({ type: "text-delta", text: "hello" }),
      JSON.stringify({ type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: { q: "x" } }),
      JSON.stringify({ type: "finish", rawFinishReason: "tool_use", totalUsage: { inputTokens: 10, outputTokens: 4, inputTokenDetails: { cacheReadTokens: 6, cacheWriteTokens: 2 } } }),
    ].join("\n"));
    const events = [];
    for await (const event of createCommandCodeAdapter(provider).parseStream(response, createTestTranslatorBudget())) events.push(event);
    expect(events).toEqual([
      { type: "thinking_delta", thinking: "think" },
      { type: "text_delta", text: "hello" },
      { type: "tool_call_start", id: "call_1", name: "lookup" },
      { type: "tool_call_delta", arguments: '{"q":"x"}' },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 6, cacheReadInputTokens: 6, cacheCreationInputTokens: 2 }, stopReason: "tool_use" },
    ]);
  });

  test("yields an error event for upstream error events", async () => {
    const response = new Response(JSON.stringify({ type: "error", error: { message: "upstream boom" } }));
    const events = [];
    for await (const event of createCommandCodeAdapter(provider).parseStream(response, createTestTranslatorBudget())) events.push(event);
    expect(events).toEqual([
      { type: "error", message: "upstream boom", status: 502 },
      { type: "done", usage: undefined, stopReason: undefined },
    ]);
  });

  test("emits a fallback done when the stream ends without a finish event", async () => {
    const response = new Response(JSON.stringify({ type: "text-delta", text: "partial" }));
    const events = [];
    for await (const event of createCommandCodeAdapter(provider).parseStream(response, createTestTranslatorBudget())) events.push(event);
    expect(events).toEqual([
      { type: "text_delta", text: "partial" },
      { type: "done", usage: undefined, stopReason: undefined },
    ]);
  });

  test("strips SSE data: framing if the gateway ever switches stream shapes", async () => {
    const response = new Response([
      "data: " + JSON.stringify({ type: "text-delta", text: "a" }),
      "data: " + JSON.stringify({ type: "text-delta", text: "b" }),
      "data: [DONE]",
    ].join("\n"));
    const events = [];
    for await (const event of createCommandCodeAdapter(provider).parseStream(response, createTestTranslatorBudget())) events.push(event);
    expect(events).toEqual([
      { type: "text_delta", text: "a" },
      { type: "text_delta", text: "b" },
      { type: "done", usage: undefined, stopReason: undefined },
    ]);
  });

  test("treats finish-step as a terminal event and emits only one done", async () => {
    const response = new Response([
      JSON.stringify({ type: "text-delta", text: "hi" }),
      JSON.stringify({ type: "finish-step", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }),
      JSON.stringify({ type: "finish", rawFinishReason: "stop", totalUsage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }),
    ].join("\n"));
    const events = [];
    for await (const event of createCommandCodeAdapter(provider).parseStream(response, createTestTranslatorBudget())) events.push(event);
    expect(events).toEqual([
      { type: "text_delta", text: "hi" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }, stopReason: "stop" },
    ]);
  });

  test("always requests streaming upstream so non-stream clients still get NDJSON", async () => {
    const built = await builtRequest({ ...parsed(), stream: false });
    expect(JSON.parse(built.body).params.stream).toBe(true);
  });
});
