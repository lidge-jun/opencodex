import { describe, expect, spyOn, test } from "bun:test";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatGptBrowserAdapter } from "../src/adapters/chatgpt-browser";
import { buildCatalogEntries } from "../src/codex/catalog";
import {
  buildChatGptBrowserPrompt,
  buildOracleBrowserArgs,
  CHATGPT_BROWSER_MODEL_ID,
  ChatGptBrowserError,
  assertOracleCompatible,
  oracleVersionIsCompatible,
  parseChatGptBrowserResponse,
  ORACLE_CHATGPT_PRO_MODEL,
  resetOracleCompatibilityCacheForTests,
  runOracleBrowserTurn,
} from "../src/adapters/chatgpt-browser-oracle";
import { providerConfigSeed } from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { routeModel } from "../src/router";
import { resolveAdapter } from "../src/server/adapter-resolve";
import { buildProviderWorkspace, isFreeProvider } from "../gui/src/provider-workspace/catalog";
import { providerAuthSurface } from "../gui/src/provider-workspace/auth";
import { isLocalProvider } from "../gui/src/provider-workspace/kind";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";

function request(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: CHATGPT_BROWSER_MODEL_ID,
    stream: true,
    context: {
      systemPrompt: ["Be precise."],
      tools: [{
        name: "read_file",
        description: "Read one file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }],
      messages: [
        { role: "user", content: "Review this change.", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "What constraint matters?" }], timestamp: 2 },
        { role: "developer", content: "Prefer the smallest safe change.", timestamp: 3 },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read_file",
          content: "const answer = 42;",
          isError: false,
          timestamp: 4,
        },
      ],
    },
    options: {},
    ...overrides,
  };
}

function provider(): OcxProviderConfig {
  return {
    adapter: "chatgpt-browser",
    baseUrl: "https://chatgpt.com",
    models: [CHATGPT_BROWSER_MODEL_ID],
    defaultModel: CHATGPT_BROWSER_MODEL_ID,
    liveModels: false,
  };
}

async function runAdapter(
  runBrowserTurn: (prompt: string) => Promise<{ answerText: string }>,
  parsed = request(),
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  const adapter = createChatGptBrowserAdapter(provider(), { runBrowserTurn });
  await adapter.runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
  return events;
}

function withoutHeartbeats(events: AdapterEvent[]): AdapterEvent[] {
  return events.filter(event => event.type !== "heartbeat");
}

function protocolAnswer(prompt: string, payload: Record<string, unknown>): string {
  const conversation = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)) as {
    responseProtocol: { nonce: string };
  };
  return JSON.stringify({ nonce: conversation.responseProtocol.nonce, ...payload });
}

describe("ChatGPT browser prompt", () => {
  test("serializes the Responses conversation and client tool contract", () => {
    const prompt = buildChatGptBrowserPrompt(request());
    expect(prompt).toContain("Tools listed in conversation.tools are executed by the client");
    const payload = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)) as {
      model: string;
      system: string[];
      messages: Array<{ role: string; content: unknown }>;
      tools: Array<{ name: string }>;
      responseProtocol: { nonce: string };
    };
    expect(payload.model).toBe(CHATGPT_BROWSER_MODEL_ID);
    expect(payload.system).toEqual(["Be precise."]);
    expect(payload.messages.map(message => message.role)).toEqual(["user", "assistant", "developer", "tool"]);
    expect(payload.messages[3]!.content).toMatchObject({
      toolCallId: "call_1",
      toolName: "read_file",
      output: "const answer = 42;",
    });
    expect(payload.tools).toEqual([expect.objectContaining({ name: "read_file" })]);
    expect(payload.responseProtocol.nonce).toBeString();
  });

  test("compacts verbose tool prose while preserving the callable JSON shape", () => {
    const verbose = "schema guidance ".repeat(1_000);
    const parsed = request({
      context: {
        messages: [{ role: "user", content: "Use the tool.", timestamp: 1 }],
        tools: [{
          name: "verbose_tool",
          description: verbose,
          parameters: {
            type: "object",
            description: verbose,
            properties: {
              path: { type: "string", description: verbose },
            },
            required: ["path"],
          },
        }],
      },
    });
    const prompt = buildChatGptBrowserPrompt(parsed);
    const payload = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)) as {
      tools: Array<{ description: string; parameters: Record<string, unknown> }>;
    };
    expect(payload.tools[0]!.description.length).toBeLessThanOrEqual(240);
    expect(JSON.stringify(payload.tools[0]!.parameters)).not.toContain("schema guidance");
    expect(payload.tools[0]!.parameters).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
    expect(prompt.length).toBeLessThan(2_000);
  });

  test("fails closed for image input", () => {
    const parsed = request({
      context: {
        messages: [{
          role: "user",
          content: [{ type: "image", imageUrl: "data:image/png;base64,abc" }],
          timestamp: 1,
        }],
      },
    });
    expect(() => buildChatGptBrowserPrompt(parsed)).toThrow(ChatGptBrowserError);
    try {
      buildChatGptBrowserPrompt(parsed);
    } catch (error) {
      expect((error as ChatGptBrowserError).code).toBe("unsupported_content");
    }
  });
});

describe("Oracle browser contract", () => {
  test("pins standard ChatGPT, current Pro selection, stdin, and foreground output capture", () => {
    const args = buildOracleBrowserArgs("/tmp/answer.md");
    expect(ORACLE_CHATGPT_PRO_MODEL).toBe("gpt-5.5-pro");
    expect(args).toEqual(expect.arrayContaining([
      "--engine", "browser",
      "--model", ORACLE_CHATGPT_PRO_MODEL,
      "--browser-model-strategy", "select",
      "--browser-thinking-time", "extended",
      "--browser-timeout", "60m",
      "--chatgpt-url", "https://chatgpt.com/",
      "--no-notify",
      "--wait",
      "--prompt", "-",
      "--write-output", "/tmp/answer.md",
    ]));
    expect(args).not.toContain("codex");
    expect(args).not.toContain("api");
  });

  test("requires the audited Oracle model-selection contract", () => {
    expect(oracleVersionIsCompatible("Oracle 0.16.1")).toBe(true);
    expect(oracleVersionIsCompatible("0.17.0")).toBe(true);
    expect(oracleVersionIsCompatible("oracle/1.0.0")).toBe(true);
    expect(oracleVersionIsCompatible("0.16.0")).toBe(false);
    expect(oracleVersionIsCompatible("unknown")).toBe(false);
  });

  test.skipIf(process.platform === "win32")("cancellation during version probing never starts a browser submission", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocx-oracle-abort-test-"));
    const command = join(dir, "oracle");
    const submitted = join(dir, "submitted");
    const previousMarker = process.env.OPENCODEX_TEST_ORACLE_SUBMITTED;
    try {
      await writeFile(command, [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then",
        "  sleep 0.25",
        "  printf 'Oracle 0.16.1\\n'",
        "  exit 0",
        "fi",
        ": > \"$OPENCODEX_TEST_ORACLE_SUBMITTED\"",
        "exit 99",
        "",
      ].join("\n"));
      await chmod(command, 0o700);
      process.env.OPENCODEX_TEST_ORACLE_SUBMITTED = submitted;
      const controller = new AbortController();
      const pending = runOracleBrowserTurn("must not be submitted", {
        command,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 20);
      await expect(pending).rejects.toMatchObject({ code: "aborted" });
      await expect(access(submitted)).rejects.toThrow();
    } finally {
      if (previousMarker === undefined) delete process.env.OPENCODEX_TEST_ORACLE_SUBMITTED;
      else process.env.OPENCODEX_TEST_ORACLE_SUBMITTED = previousMarker;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("bounds and reaps a hung Oracle version probe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocx-oracle-probe-timeout-"));
    const command = join(dir, "oracle");
    try {
      await writeFile(command, ["#!/bin/sh", "sleep 10", ""].join("\n"));
      await chmod(command, 0o700);
      resetOracleCompatibilityCacheForTests();
      const started = performance.now();
      await expect(assertOracleCompatible(command, { timeoutMs: 50 }))
        .rejects.toMatchObject({ code: "oracle_missing" });
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("accepts only nonce-bound final answers or known tool calls", () => {
    const parsed = request();
    expect(parseChatGptBrowserResponse(
      '{"nonce":"n","type":"final","text":"Done"}', parsed, "n",
    )).toEqual({ type: "final", text: "Done" });
    expect(parseChatGptBrowserResponse(
      '{"nonce":"n","type":"tool_call","name":"read_file","arguments":{"path":"a.ts"}}', parsed, "n",
    )).toMatchObject({ type: "tool_call", name: "read_file", arguments: { path: "a.ts" } });
    expect(() => parseChatGptBrowserResponse(
      '{"nonce":"wrong","type":"final","text":"Done"}', parsed, "n",
    )).toThrow(ChatGptBrowserError);
    expect(() => parseChatGptBrowserResponse(
      '{"nonce":"n","type":"tool_call","name":"shell","arguments":{}}', parsed, "n",
    )).toThrow(ChatGptBrowserError);
    expect(() => parseChatGptBrowserResponse(
      '{"nonce":"n","type":"tool_call","name":"read_file","arguments":{"path":42}}', parsed, "n",
    )).toThrow(ChatGptBrowserError);
    expect(() => parseChatGptBrowserResponse(
      '{"nonce":"n","type":"tool_call","name":"read_file","arguments":{}}', parsed, "n",
    )).toThrow(ChatGptBrowserError);
  });

  test("enforces named tool choices and fails when the named tool is unavailable", () => {
    const named = request({ options: { toolChoice: { name: "read_file" } } });
    expect(() => parseChatGptBrowserResponse(
      '{"nonce":"n","type":"final","text":"Done"}', named, "n",
    )).toThrow(ChatGptBrowserError);
    expect(() => buildChatGptBrowserPrompt(request({
      context: { messages: [], tools: [] },
      options: { toolChoice: { name: "read_file" } },
    }))).toThrow(ChatGptBrowserError);
  });
});

describe("ChatGPT browser adapter", () => {
  test("emits a final answer and estimated usage", async () => {
    let captured = "";
    const events = await runAdapter(async prompt => {
      captured = prompt;
      return { answerText: protocolAnswer(prompt, { type: "final", text: "Use a narrower interface." }) };
    });
    expect(events[0]).toEqual({ type: "heartbeat" });
    const terminalEvents = withoutHeartbeats(events);
    expect(captured).toContain("Review this change.");
    expect(terminalEvents[0]).toEqual({
      type: "text_delta",
      text: "Use a narrower interface.",
      phase: "final_answer",
    });
    expect(terminalEvents[1]).toMatchObject({
      type: "done",
      endTurn: true,
      usage: { estimated: true },
    });
  });

  test("emits a validated client tool call", async () => {
    const events = withoutHeartbeats(await runAdapter(async prompt => ({
      answerText: protocolAnswer(prompt, {
        type: "tool_call",
        name: "read_file",
        arguments: { path: "src/router.ts" },
      }),
    })));
    expect(events.slice(0, 3)).toMatchObject([
      { type: "tool_call_start", name: "read_file" },
      { type: "tool_call_delta", arguments: '{"path":"src/router.ts"}' },
      { type: "tool_call_end" },
    ]);
    expect(events[3]).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
  });

  test("preserves actionable fail-closed error categories", async () => {
    const cases = [
      ["login_required", 401, "browser login is required"],
      ["model_unavailable", 403, "no fallback model was used"],
      ["quota_exhausted", 402, "no fallback model was used"],
      ["timeout", 400, "timed out"],
      ["oracle_missing", 503, "oracle is not installed"],
      ["oracle_incompatible", 503, "oracle 0.16.1 or newer"],
    ] as const;
    for (const [code, status, messageFragment] of cases) {
      const events = await runAdapter(async () => { throw new ChatGptBrowserError(code); });
      const terminalEvents = withoutHeartbeats(events);
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]).toMatchObject({
        type: "error",
        code,
        status,
        errorType: "chatgpt_browser_error",
      });
      expect((terminalEvents[0] as Extract<AdapterEvent, { type: "error" }>).message.toLowerCase())
        .toContain(messageFragment);
    }
  });

  test("logs unexpected exceptions while keeping the client error generic", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    const original = new Error("diagnostic sentinel");
    try {
      const events = withoutHeartbeats(await runAdapter(async () => { throw original; }));
      expect(events[0]).toMatchObject({ code: "browser_failed", retryable: false });
      expect(log).toHaveBeenCalledWith(
        "[chatgpt-browser] unexpected runTurn failure:",
        original,
      );
    } finally {
      log.mockRestore();
    }
  });

  test("rejects every other model without invoking Oracle", async () => {
    let called = false;
    const events = await runAdapter(async () => {
      called = true;
      return { answerText: "unexpected" };
    }, request({ modelId: "gpt-5.6-sol" }));
    expect(called).toBe(false);
    expect(events[0]).toMatchObject({ type: "error", code: "model_not_supported", status: 400 });
  });
});

describe("ChatGPT browser provider registry", () => {
  test("is an explicit static experimental preset with no API or Codex route", () => {
    const entry = PROVIDER_REGISTRY.find(provider => provider.id === "chatgpt-browser")!;
    expect(entry).toMatchObject({
      adapter: "chatgpt-browser",
      baseUrl: "https://chatgpt.com",
      authKind: "local",
      dashboardPreset: true,
      models: [CHATGPT_BROWSER_MODEL_ID],
      defaultModel: CHATGPT_BROWSER_MODEL_ID,
      liveModels: false,
    });
    const seed = providerConfigSeed(entry);
    expect(seed.authMode).toBe("local");
    expect(seed.modelInputModalities).toEqual({ [CHATGPT_BROWSER_MODEL_ID]: ["text"] });
    expect(seed.modelReasoningEfforts).toEqual({ [CHATGPT_BROWSER_MODEL_ID]: [] });
    expect(seed.parallelToolCalls).toBe(false);
    expect(seed.noVisionModels).toBeUndefined();
    expect(resolveAdapter(seed).name).toBe("chatgpt-browser");

    const [catalog] = buildCatalogEntries(null, [], [{
      id: CHATGPT_BROWSER_MODEL_ID,
      provider: "chatgpt-browser",
      inputModalities: ["text"],
      reasoningEfforts: [],
      supportsVerbosity: false,
    }]);
    expect(catalog).toMatchObject({
      slug: "chatgpt-browser/gpt-5.6-pro",
      supports_search_tool: false,
      supports_parallel_tool_calls: false,
      supported_reasoning_levels: [],
      input_modalities: ["text"],
      support_verbosity: false,
    });
    expect(catalog).not.toHaveProperty("web_search_tool_type");
    expect(catalog).not.toHaveProperty("supports_websockets");
  });

  test("appears ready in the provider GUI without a fake API key or free/local-runtime badge", () => {
    const entry = PROVIDER_REGISTRY.find(provider => provider.id === "chatgpt-browser")!;
    const seed = providerConfigSeed(entry);
    const sections = buildProviderWorkspace({
      "chatgpt-browser": { ...seed, hasApiKey: false },
    });
    expect(sections.ready.map(provider => provider.name)).toEqual(["chatgpt-browser"]);
    expect(sections.needsSetup).toEqual([]);
    expect(isFreeProvider(sections.ready[0]!)).toBe(false);
    expect(isLocalProvider(sections.ready[0]!)).toBe(false);
    expect(providerAuthSurface(sections.ready[0]!)).toBeNull();
  });

  test("routes only the explicit namespace and never claims bare GPT ids", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
        "chatgpt-browser": provider(),
      },
    };
    expect(routeModel(config, "gpt-5.6-pro").providerName).toBe("openai");
    expect(routeModel(config, "chatgpt-browser/gpt-5.6-pro")).toMatchObject({
      providerName: "chatgpt-browser",
      modelId: "gpt-5.6-pro",
      provider: { adapter: "chatgpt-browser", baseUrl: "https://chatgpt.com" },
    });
    config.providers["chatgpt-browser"]!.disabled = true;
    expect(() => routeModel(config, "chatgpt-browser/gpt-5.6-pro")).toThrow("Provider is disabled");
  });
});
