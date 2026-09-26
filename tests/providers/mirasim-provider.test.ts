import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMirasimAdapter } from "../../src/adapters/mirasim";
import {
  ensureMirasimClaudeAgentSystemMarker,
  MIRASIM_CLAUDE_AGENT_SYSTEM_MARKER,
} from "../../src/adapters/mirasim/anthropic";
import {
  parseMirasimLimits,
  parseMirasimRoster,
  resetMirasimControlPlaneStateForTests,
  setCachedMirasimRosterForTests,
} from "../../src/adapters/mirasim/control-plane";
import { OAUTH_PROVIDERS } from "../../src/oauth";
import { providerConfigSeed } from "../../src/providers/derive";
import { providerOAuthAccountQuotaMode, supportsPerAccountQuota } from "../../src/providers/quota";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import type { OcxProviderConfig } from "../../src/types";
import { parseStreamWithProgress } from "../../src/web-search/progress-stream";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../helpers/translator-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "opencodex-mirasim-provider-"));
  mkdirSync(home, { recursive: true });
  process.env.OPENCODEX_HOME = home;
});

function entry() {
  const found = getProviderRegistryEntry("mirasim");
  if (!found) throw new Error("missing Mirasim registry entry");
  return found;
}

function adapter() {
  const provider = {
    ...providerConfigSeed(entry()),
    apiKey: "synthetic-mirasim-access",
  } as OcxProviderConfig;
  return withTestTranslatorBudget(createMirasimAdapter(provider));
}

function hangingMirasimClaudeResponse(stopReason: string) {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      streamController.enqueue(encoder.encode([
        "event: message_start\n",
        'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
        "event: message_delta\n",
        `data: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: stopReason },
          usage: { output_tokens: 2 },
        })}\n\n`,
        "event: message_stop\n",
        'data: {"type":"message_stop"}\n\n',
      ].join("")));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "x-opencodex-mirasim-response-wire": "anthropic",
      },
    }),
    close() {
      try { controller.close(); } catch { /* already cancelled or closed */ }
    },
    wasCancelled: () => cancelled,
  };
}

describe("Mirasim provider", () => {
  afterEach(() => {
    resetMirasimControlPlaneStateForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  });

  test("is a native OAuth provider with an HTTP/1.1-pinned live catalog", () => {
    expect(entry().adapter).toBe("mirasim");
    expect(entry().authKind).toBe("oauth");
    expect(entry().oauthId).toBe("mirasim");
    expect(entry().liveModels).toBe(true);
    expect(entry().modelDiscovery?.path).toBe("/v1/models");
    expect(OAUTH_PROVIDERS.mirasim?.providerConfig.upstreamHttpVersion).toBe("http1.1");
    expect(supportsPerAccountQuota("mirasim")).toBe(true);
    expect(providerOAuthAccountQuotaMode("mirasim")).toBe("probe");
    expect(entry().models).toContain("kimi-k3");
    expect(entry().modelDisplayNames?.["kimi-k3"]).toBe("Kimi K3");
    expect(entry().modelContextWindows?.["kimi-k3"]).toBe(1_048_576);
    expect(entry().modelReasoningEfforts?.["kimi-k3"]).toEqual(["low", "high", "max"]);
  });

  test("routes Claude through Messages and uses adaptive thinking before a roster is observed", async () => {
    const request = await adapter().buildRequest({
      modelId: "claude-haiku-4-5",
      stream: true,
      options: { reasoning: "high" },
      context: {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
    });

    expect(new URL(request.url).pathname).toBe("/v1/messages");
    const body = JSON.parse(request.body) as {
      thinking?: { type?: string; budget_tokens?: number };
      output_config?: { effort?: string };
      system?: Array<{ type?: string; text?: string }>;
    };
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config?.effort).toBe("high");
    expect(body.thinking?.budget_tokens).toBeUndefined();
    expect(body.system?.[0]).toEqual({
      type: "text",
      text: MIRASIM_CLAUDE_AGENT_SYSTEM_MARKER,
      cache_control: { type: "ephemeral" },
    });
    expect(request.headers["x-opencodex-mirasim-wire"]).toBe("anthropic");
  });

  test("prepends the relay's minimum Claude Agent marker without replacing the caller system prompt", async () => {
    const request = await adapter().buildRequest({
      modelId: "claude-haiku-4-5",
      stream: true,
      options: {},
      context: {
        systemPrompt: ["Keep the caller instruction intact."],
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
    });
    const body = JSON.parse(request.body) as {
      system?: Array<{ type?: string; text?: string }>;
    };
    expect(body.system?.[0]).toEqual({
      type: "text",
      text: MIRASIM_CLAUDE_AGENT_SYSTEM_MARKER,
      cache_control: { type: "ephemeral" },
    });
    expect(body.system?.some(block => block.text === "Keep the caller instruction intact.")).toBe(true);
    expect(body.system?.filter(block => block.text === MIRASIM_CLAUDE_AGENT_SYSTEM_MARKER)).toHaveLength(1);
  });

  test("keeps the Claude Agent marker cacheable while capping Mirasim at four breakpoints", () => {
    const body: Record<string, unknown> = {
      system: [{
        type: "text",
        text: "system",
        cache_control: { type: "ephemeral", ttl: "1h" },
      }],
      tools: [{
        name: "lookup",
        cache_control: { type: "ephemeral", ttl: "1h" },
      }],
      messages: [
        {
          role: "user",
          content: [{
            type: "text",
            text: "older",
            cache_control: { type: "ephemeral", ttl: "1h" },
          }],
        },
        {
          role: "user",
          content: [{
            type: "text",
            text: "newer",
            cache_control: { type: "ephemeral", ttl: "1h" },
          }],
        },
      ],
    };

    ensureMirasimClaudeAgentSystemMarker(body);

    const system = body.system as Array<Record<string, unknown>>;
    const tools = body.tools as Array<Record<string, unknown>>;
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(system[0]).toMatchObject({
      type: "text",
      text: MIRASIM_CLAUDE_AGENT_SYSTEM_MARKER,
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
    expect(system[1]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(tools[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(messages[0]?.content[0]?.cache_control).toBeUndefined();
    expect(messages[1]?.content[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("uses the signed roster's budget thinking shape without probing during inference", async () => {
    setCachedMirasimRosterForTests("synthetic-mirasim-access", {
      version: "test-v1",
      agents: {
        claude: [{
          id: "claude-haiku-4-5",
          contextWindow: 200_000,
          effort: ["low", "medium", "high"],
          adaptive: false,
        }],
        codex: [],
      },
    });

    const request = await adapter().buildRequest({
      modelId: "claude-haiku-4-5",
      stream: true,
      options: { reasoning: "high" },
      context: {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
    });
    const body = JSON.parse(request.body) as {
      thinking?: { type?: string; budget_tokens?: number };
      output_config?: { effort?: string };
    };
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 24_576 });
    expect(body.output_config?.effort).toBeUndefined();
  });

  test("strips the [1m] selector and merges the long-context beta without duplication", async () => {
    setCachedMirasimRosterForTests("synthetic-mirasim-access", {
      version: "test-v1",
      agents: {
        claude: [{
          id: "claude-sonnet-5",
          contextWindow: 1_000_000,
          effort: ["low", "high", "max"],
          adaptive: true,
        }],
        codex: [],
      },
    });
    const request = await adapter().buildRequest({
      modelId: "claude-sonnet-5[1m]",
      stream: true,
      options: { reasoning: "high" },
      context: {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
    }, {
      headers: new Headers({
        "anthropic-beta": "other-beta,context-1m-2025-08-07",
      }),
    });
    const body = JSON.parse(request.body) as { model?: string };
    expect(body.model).toBe("claude-sonnet-5");
    expect(request.headers["anthropic-beta"]).toBe(
      "other-beta,context-1m-2025-08-07",
    );
  });

  test.each([
    ["end_turn", "done"],
    ["refusal", "incomplete"],
    ["error", "error"],
  ] as const)("terminates Mirasim Claude parsing after %s message_stop without waiting for relay EOF", async (
    stopReason,
    terminalType,
  ) => {
    const source = hangingMirasimClaudeResponse(stopReason);
    const stream = adapter().parseStream(source.response);
    expect(await stream.next()).toMatchObject({
      done: false,
      value: { type: terminalType },
    });

    const next = stream.next();
    const outcome = await Promise.race([
      next.then(value => ({ kind: "done" as const, value })),
      new Promise<{ kind: "timeout" }>(resolve => {
        setTimeout(() => resolve({ kind: "timeout" }), 50);
      }),
    ]);
    if (outcome.kind === "timeout") source.close();
    const final = outcome.kind === "done" ? outcome.value : await next;

    expect(outcome.kind).toBe("done");
    expect(final.done).toBe(true);
    expect(source.wasCancelled()).toBe(true);
  });

  test("completes the web-search post-terminal drain for Mirasim Claude without relay EOF", async () => {
    const source = hangingMirasimClaudeResponse("end_turn");
    const mirasim = adapter();
    const translatorBudget = createTestTranslatorBudget();
    const events = [];

    for await (const event of parseStreamWithProgress(
      source.response,
      mirasim.parseStream.bind(mirasim),
      {
        inactivityTimeoutMs: 500,
        postTerminalDrainTimeoutMs: 20,
        translatorBudget,
      },
    )) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({
      type: "done",
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(source.wasCancelled()).toBe(true);
  });

  test("routes GPT through Responses and folds ultra to the relay's max single-turn effort", async () => {
    const mirasim = adapter();
    const parsed = {
      modelId: "gpt-5.6-sol",
      stream: false,
      options: { reasoning: "ultra" },
      context: { messages: [] },
      _rawBody: {
        model: "gpt-5.6-sol",
        input: "hello",
        reasoning: { effort: "ultra" },
      },
    };
    expect(mirasim.passthroughFor?.(parsed)).toBe(true);
    const request = await mirasim.buildRequest(parsed);

    expect(new URL(request.url).pathname).toBe("/v1/responses");
    const body = JSON.parse(request.body) as {
      reasoning?: { effort?: string };
      stream?: boolean;
      store?: boolean;
      parallel_tool_calls?: boolean;
      include?: string[];
    };
    expect(body.reasoning?.effort).toBe("max");
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(request.headers["x-opencodex-mirasim-wire"]).toBe("responses");
    expect(mirasim.passthroughFor?.({
      modelId: "claude-haiku-4-5",
      stream: true,
      options: {},
      context: { messages: [] },
    })).toBe(false);
  });

  test("routes Kimi K3 through Responses without rewriting the inference model", async () => {
    const mirasim = adapter();
    const parsed = {
      modelId: "kimi-k3",
      stream: true,
      options: { reasoning: "high" },
      context: { messages: [] },
      _rawBody: {
        model: "kimi-k3",
        input: "hello",
        reasoning: { effort: "high" },
      },
    };
    expect(mirasim.passthroughFor?.(parsed)).toBe(true);
    const request = await mirasim.buildRequest(parsed);

    expect(new URL(request.url).pathname).toBe("/v1/responses");
    const body = JSON.parse(request.body) as {
      model?: string;
      reasoning?: { effort?: string };
      stream?: boolean;
    };
    expect(body.model).toBe("kimi-k3");
    expect(body.reasoning?.effort).toBe("high");
    expect(body.stream).toBe(true);
    expect(request.headers["x-opencodex-mirasim-wire"]).toBe("responses");
  });

  test("keeps GPT-6 code-mode exec native on the Mirasim Responses wire", async () => {
    const mirasim = adapter();
    const exec = {
      type: "custom",
      name: "exec",
      description: "Run JavaScript",
      format: { type: "grammar", syntax: "lark" },
    };
    const request = await mirasim.buildRequest({
      modelId: "gpt-6-astra",
      stream: true,
      options: { reasoning: "high" },
      context: {
        messages: [],
        tools: [{
          name: "exec",
          description: "Run JavaScript",
          parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
          freeform: true,
        }],
      },
      _rawBody: {
        model: "gpt-6-astra",
        input: "run pwd",
        tools: [{ type: "namespace", name: "functions", tools: [exec] }],
        tool_choice: "auto",
      },
    });
    const body = JSON.parse(request.body) as { tools?: Array<Record<string, unknown>> };

    expect(body.tools).toEqual([exec]);
    expect([...(request.convertedRoutedCustomToolNames ?? [])]).not.toContain("exec");
  });

  test("keeps GPT-6 native exec semantics across continuation history and tool_choice", async () => {
    const exec = {
      type: "custom",
      name: "exec",
      description: "Run JavaScript",
      format: { type: "grammar", syntax: "lark" },
    };
    const request = await adapter().buildRequest({
      modelId: "gpt-6-astra",
      stream: true,
      options: {},
      context: {
        messages: [],
        tools: [{
          name: "exec",
          description: "Run JavaScript",
          parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
          freeform: true,
        }],
      },
      _rawBody: {
        model: "gpt-6-astra",
        input: [
          {
            type: "custom_tool_call",
            id: "ctc_previous_exec",
            call_id: "call_previous_exec",
            name: "exec",
            input: 'text("before")',
            status: "completed",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_previous_exec",
            output: "ok",
          },
          { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
        ],
        tools: [{ type: "namespace", name: "functions", tools: [exec] }],
        tool_choice: { type: "custom", namespace: "functions", name: "exec" },
      },
    });
    const body = JSON.parse(request.body) as {
      input?: Array<Record<string, unknown>>;
      tools?: Array<Record<string, unknown>>;
      tool_choice?: Record<string, unknown>;
    };

    expect(body.tools).toEqual([exec]);
    expect(body.tool_choice).toEqual({ type: "custom", name: "exec" });
    expect(body.input?.[0]).toMatchObject({
      type: "custom_tool_call",
      id: "ctc_previous_exec",
      call_id: "call_previous_exec",
      name: "exec",
      input: 'text("before")',
    });
    expect(body.input?.[1]).toEqual({
      type: "custom_tool_call_output",
      call_id: "call_previous_exec",
      output: "ok",
    });
    expect([...(request.convertedRoutedCustomToolNames ?? [])]).not.toContain("exec");
  });

  test("keeps the shared custom-tool fallback for pre-GPT-6 and non-exec tools", async () => {
    const build = async (modelId: string, name: string) => {
      const mirasim = adapter();
      const request = await mirasim.buildRequest({
        modelId,
        stream: true,
        options: {},
        context: {
          messages: [],
          tools: [{
            name,
            description: "custom",
            parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
            freeform: true,
          }],
        },
        _rawBody: {
          model: modelId,
          input: "hello",
          tools: [{ type: "custom", name, description: "custom", format: { type: "text" } }],
        },
      });
      return {
        body: JSON.parse(request.body) as { tools?: Array<Record<string, unknown>> },
        converted: [...(request.convertedRoutedCustomToolNames ?? [])],
      };
    };

    const legacyExec = await build("gpt-5.6-sol", "exec");
    expect(legacyExec.body.tools?.[0]).toMatchObject({ type: "function", name: "exec" });
    expect(legacyExec.converted).toContain("exec");

    const otherCustom = await build("gpt-6-astra", "other_custom");
    expect(otherCustom.body.tools?.[0]).toMatchObject({ type: "function", name: "other_custom" });
    expect(otherCustom.converted).toContain("other_custom");
  });

  test("parses the signed roster conservatively and excludes paid/foreign families", () => {
    const roster = parseMirasimRoster({
      version: "v2",
      agents: {
        claude: [
          {
            id: "Claude-Sonnet-5",
            label: "Sonnet live",
            contextWindow: 1_000_000,
            maxOutput: 128_000,
            autoCompactRatio: 0.8,
            effort: ["low", "HIGH", "high", "bogus"],
            adaptive: true,
          },
          { id: "claude-opus-5-paid", contextWindow: 1_000_000, adaptive: true },
        ],
        codex: [
          { id: "gpt-5.6-sol", contextWindow: 372_000, maxOutput: 128_000, effort: ["max"], adaptive: false },
          { id: "claude-wrong-family", contextWindow: 123_000, adaptive: true },
        ],
      },
    });

    expect(roster?.version).toBe("v2");
    expect(roster?.agents.claude).toEqual([{
      id: "claude-sonnet-5",
      label: "Sonnet live",
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      autoCompactRatio: 0.8,
      effort: ["low", "high"],
      adaptive: true,
    }]);
    expect(roster?.agents.codex.map(model => model.id)).toEqual(["gpt-5.6-sol"]);
  });

  test("normalizes structured /v1/limits windows without promoting model limits to account bars", () => {
    const quota = parseMirasimLimits({
      paid: true,
      degraded: false,
      windows: [
        { name: "5h", budget: 100, used: 25, reset_at: 1_800_000_000, model_scoped: false },
        { name: "7d", budget: 100, used: 99, reset_at: "2030-01-01T00:00:00Z", model_scoped: false },
        { name: "7d_fable", budget: 100, used: 100, model_scoped: true },
      ],
    });

    expect(quota?.fiveHourPercent).toBe(25);
    expect(quota?.weeklyPercent).toBe(100);
    expect(quota?.customWindows).toEqual([
      { label: "Model · 7d_fable", percent: 100 },
    ]);
  });

  test("keeps canonical 5h/7d windows even when there are no custom limits", () => {
    expect(parseMirasimLimits({
      windows: [
        { name: "7d", budget: 100, used: 10, reset_at: 1_800_000_000, model_scoped: false },
      ],
    })).toMatchObject({
      weeklyPercent: 10,
      weeklyResetAt: 1_800_000_000_000,
      customWindows: [],
    });
  });
});
