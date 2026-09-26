/**
 * Provider-owned compatibility declarations must remain admission metadata.
 * If a model calls one anyway, the client receives actionable assistant text;
 * real caller-owned tools and unrelated undeclared calls keep their contracts.
 */
import { describe, expect, test } from "bun:test";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import type { IncomingMeta, ProviderAdapter } from "../../src/adapters/base";
import {
  providerCompatibilityFunctionCallRedirect,
  transformProviderRequest,
} from "../../src/adapters/provider-compatibility";
import { withProviderRequestCompatibility } from "../../src/adapters/provider-compatibility-adapter";
import { providerConfigSeed } from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { nativeChatDeclineReason } from "../../src/server/chat-native";
import {
  createUndeclaredToolCallGuardBlockRewrite,
} from "../../src/server/responses-undeclared-tool-guard";
import {
  createCompatibilityCallRedirectBlockRewrite,
  redirectCompatibilityCallsInJson,
} from "../../src/server/responses-compatibility-call-redirect";
import type { RouteResult } from "../../src/router";
import { handleResponses } from "../../src/server/responses";
import { expandPreviousResponseInput } from "../../src/responses/state";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "opencode-free")!;

function provider(apiKey?: string): OcxProviderConfig {
  return { ...providerConfigSeed(entry), ...(apiKey ? { apiKey } : {}) };
}

function parsed(tools: OcxParsedRequest["context"]["tools"] = []): OcxParsedRequest {
  return {
    modelId: "big-pickle",
    stream: true,
    context: { messages: [{ role: "user", content: "hi" }], tools },
    options: {},
  };
}

function incoming(): IncomingMeta {
  return { headers: new Headers(), translatorBudget: createTranslatorBudget() };
}

function stub(events: readonly AdapterEvent[]): ProviderAdapter {
  return {
    name: "stub",
    buildRequest(request) {
      const tools = (request.context.tools ?? []).map(tool => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
      return {
        url: "https://example.test/chat/completions",
        method: "POST",
        headers: {},
        body: JSON.stringify({ model: request.modelId, messages: [], ...(tools.length ? { tools } : {}) }),
      };
    },
    async *parseStream() { yield* events; },
  };
}

async function collect(adapter: ProviderAdapter): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of adapter.parseStream(new Response("x"), createTranslatorBudget())) events.push(event);
  return events;
}

function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}`;
}

function parseData(block: string): Record<string, unknown> {
  const line = block.split("\n").find(candidate => candidate.startsWith("data: "))!;
  return JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
}

function shellAdded(): string {
  return frame("response.output_item.added", {
    output_index: 2,
    item: { id: "fc_1", type: "function_call", status: "in_progress", name: "shell", call_id: "call_1", arguments: "" },
  });
}

describe("provider compatibility call guidance", () => {
  test("translated adapter events replace only injected calls with guidance", async () => {
    const upstream: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_1", name: "shell" },
      { type: "tool_call_delta", arguments: '{"command":"hi"}' },
      { type: "tool_call_end" },
      { type: "tool_call_start", id: "call_2", name: "exec" },
      { type: "tool_call_delta", arguments: '{"input":"x"}' },
      { type: "tool_call_end" },
      { type: "done" },
    ];
    const adapter = withProviderRequestCompatibility(stub(upstream), provider(), "opencode-free");
    await adapter.buildRequest(parsed(), incoming());
    const seen = await collect(adapter);
    expect(seen.filter(event => event.type === "tool_call_start").map(event => event.name)).toEqual(["exec"]);
    expect(seen.filter(event => event.type === "text_delta").map(event => event.text).join(" "))
      .toContain("The `shell` tool is declared but cannot be executed in this session");
    expect(seen.at(-1)?.type).toBe("done");
  });

  test("a client-owned shell call flows through unchanged", async () => {
    const upstream: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_1", name: "shell" },
      { type: "tool_call_end" },
      { type: "done" },
    ];
    const adapter = withProviderRequestCompatibility(stub(upstream), provider(), "opencode-free");
    await adapter.buildRequest(parsed([
      { name: "shell", description: "ours", parameters: { type: "object", properties: {} } },
      { name: "read", description: "ours", parameters: { type: "object", properties: {} } },
    ]), incoming());
    const seen = await collect(adapter);
    expect(seen.filter(event => event.type === "tool_call_start")).toHaveLength(1);
    expect(seen.some(event => event.type === "text_delta")).toBe(false);
  });

  test("Responses catalogs inside input remain caller-owned", () => {
    const transformed = transformProviderRequest(
      { ...provider(), adapter: "openai-responses" },
      {
        url: "https://example.test/responses",
        method: "POST",
        headers: {},
        body: JSON.stringify({
          model: "big-pickle",
          input: [{
            type: "additional_tools",
            tools: [
              { type: "namespace", name: "functions", tools: [{ type: "function", name: "shell" }] },
              { type: "function", name: "read" },
            ],
          }],
        }),
      },
      { providerId: "opencode-free" },
    );
    expect(JSON.parse(transformed.body).tools).toBeUndefined();
    expect(transformed.compatibilityFunctionCallRedirect).toBeUndefined();
  });

  test("translated non-stream responses apply the same injected-call policy", async () => {
    const upstream: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_1", name: "read" },
      { type: "tool_call_delta", arguments: '{"path":"x"}' },
      { type: "tool_call_end" },
      { type: "done" },
    ];
    const base = stub([]);
    base.parseResponse = async () => upstream;
    const adapter = withProviderRequestCompatibility(base, provider(), "opencode-free");
    await adapter.buildRequest(parsed(), incoming());
    const seen = await adapter.parseResponse!(new Response("{}"), createTranslatorBudget());
    expect(seen.map(event => event.type)).toEqual(["text_delta", "done"]);
    expect(seen[0]).toEqual({
      type: "text_delta",
      text: expect.stringContaining("The `read` tool is declared but cannot be executed in this session"),
    });
  });

  test("Responses SSE redirects an injected call and keeps the turn alive", () => {
    const redirect = providerCompatibilityFunctionCallRedirect(
      { ...provider(), adapter: "openai-responses" },
      { providerId: "opencode-free" },
      new Set(["exec", "wait"]),
    )!;
    const rewrite = createCompatibilityCallRedirectBlockRewrite(redirect);
    const guidance = rewrite(shellAdded());
    expect(guidance).toHaveLength(5);
    expect(JSON.stringify(parseData(guidance[4]!))).toContain("declared but cannot be executed");
    expect(rewrite(frame("response.function_call_arguments.delta", {
      output_index: 2, item_id: "fc_1", delta: "{}",
    }))).toEqual([]);
    expect(rewrite(frame("response.output_item.done", {
      output_index: 2,
      item: { id: "fc_1", type: "function_call", status: "completed", name: "shell", call_id: "call_1", arguments: "{}" },
    }))).toEqual([]);
    const terminal = rewrite(frame("response.completed", {
      response: {
        status: "completed",
        output: [{ id: "fc_1", type: "function_call", name: "shell", call_id: "call_1", arguments: "{}" }],
      },
    }));
    expect(terminal).toHaveLength(1);
    const response = parseData(terminal[0]!).response as { output: Array<{ type: string; content?: unknown }> };
    expect(response.output[0]?.type).toBe("message");
    expect(JSON.stringify(response.output[0]?.content)).toContain("declared but cannot be executed");
  });

  test("unrelated undeclared calls still fail closed", () => {
    const redirect = providerCompatibilityFunctionCallRedirect(
      { ...provider(), adapter: "openai-responses" },
      { providerId: "opencode-free" },
      new Set(["exec"]),
    )!;
    const rewrite = createCompatibilityCallRedirectBlockRewrite(redirect);
    const guard = createUndeclaredToolCallGuardBlockRewrite(new Set(["exec"]));
    const output = rewrite(frame("response.output_item.added", {
      output_index: 3,
      item: { id: "fc_2", type: "function_call", name: "frobnicate", call_id: "call_2", arguments: "" },
    })).flatMap(guard);
    expect(output.join("\n")).toContain("undeclared_tool_call");
  });

  test("completed Responses JSON replaces injected calls but preserves real ones", () => {
    const redirect = providerCompatibilityFunctionCallRedirect(
      { ...provider(), adapter: "openai-responses" },
      { providerId: "opencode-free" },
      new Set(["exec"]),
    )!;
    const rewritten = JSON.parse(redirectCompatibilityCallsInJson(JSON.stringify({
      id: "resp_1",
      status: "completed",
      output: [
        { id: "fc_1", type: "function_call", name: "read", call_id: "call_1", arguments: "{}" },
        { id: "fc_2", type: "function_call", name: "exec", call_id: "call_2", arguments: "{}" },
      ],
    }), redirect)) as { output: Array<{ type: string; name?: string; content?: Array<{ text?: string }> }> };
    expect(rewritten.output[0]?.type).toBe("message");
    expect(rewritten.output[0]?.content?.[0]?.text).toContain("`read`");
    expect(rewritten.output[1]?.name).toBe("exec");
  });

  test("the real Responses relay turns an accidental call into guidance", async () => {
    const config = {
      port: 0,
      defaultProvider: "opencode-free",
      providers: {
        "opencode-free": { ...provider(), adapter: "openai-responses" },
      },
    } as OcxConfig;
    const requestBody = {
      model: "opencode-free/muse-spark-1.3-contributor-free",
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "inspect" }] }],
    };
    const originalFetch = globalThis.fetch;
    const releaseSpendHome = acquireOwnedSpendHome();
    let sentTools: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const text = input instanceof Request ? await input.clone().text() : String(init?.body ?? "{}");
      const body = JSON.parse(text) as { tools?: Array<{ name?: string }> };
      if (Array.isArray(body.tools)) {
        sentTools = body.tools.flatMap(tool => {
          if (typeof tool.name === "string") return [tool.name];
          const nested = (tool as { function?: { name?: unknown } }).function?.name;
          return typeof nested === "string" ? [nested] : [];
        });
      }
      const completed = frame("response.completed", {
        response: {
          id: "resp_1",
          status: "completed",
          output: [{ id: "fc_1", type: "function_call", status: "completed", name: "shell", call_id: "call_1", arguments: "{}" }],
        },
      });
      return new Response([shellAdded(), completed, "data: [DONE]"].join("\n\n") + "\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }), config, { model: "", provider: "" });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(sentTools).toEqual(["shell", "read"]);
      expect(body).toContain("declared but cannot be executed");
      expect(body).toContain("response.completed");
      expect(body).not.toContain('"name":"shell"');
      const replay = JSON.stringify(expandPreviousResponseInput({
        previous_response_id: "resp_1",
        input: "continue",
      }));
      expect(replay).toContain("declared but cannot be executed");
      expect(replay).not.toContain('"name":"shell"');
    } finally {
      globalThis.fetch = originalFetch;
      releaseSpendHome();
    }
  });

  test("native Chat uses the bridge only when recovery is needed", () => {
    const route = {
      providerName: "opencode-free",
      modelId: "big-pickle",
      routeKind: "direct",
      routeReason: "test",
      provider: provider(),
    } as unknown as RouteResult;
    expect(nativeChatDeclineReason(route, { messages: [] })).toBe("bridge-only-policy");
    expect(nativeChatDeclineReason(route, {
      messages: [],
      tools: [
        { type: "function", function: { name: "shell" } },
        { type: "function", function: { name: "read" } },
      ],
    })).toBeUndefined();
    expect(nativeChatDeclineReason({ ...route, provider: provider("zen-key") }, { messages: [] })).toBeUndefined();
  });
});
