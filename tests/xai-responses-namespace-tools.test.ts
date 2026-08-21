import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import type { OcxParsedRequest, OcxProviderConfig, OcxConfig } from "../src/types";
import {
  NamespaceToolCompatibilityError,
  restoreNamespaceToolCallsInJson,
} from "../src/responses/namespace-tool-compat";
import { handleResponses } from "../src/server/responses";

const xaiProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://cli-chat-proxy.grok.com/v1",
  authMode: "key",
  apiKey: "test-token",
};

function parsed(rawBody: Record<string, unknown>): OcxParsedRequest {
  return {
    modelId: "grok-4.6",
    context: { messages: [{ role: "user", content: "inspect", timestamp: 0 }] },
    stream: false,
    options: {},
    _rawBody: rawBody,
  };
}

function build(rawBody: Record<string, unknown>) {
  return createResponsesPassthroughAdapter(xaiProvider).buildRequest(parsed(rawBody), {
    translatorBudget: createTestTranslatorBudget(),
  });
}

describe("xAI Responses namespace tool compatibility", () => {
  test("flattens the current Codex functions namespace without dropping callable tools", () => {
    const request = build({
      model: "xai/grok-4.6",
      input: "inspect",
      tools: [
        { type: "function", name: "top", parameters: { type: "object" } },
        { type: "web_search" },
        { type: "function", name: "other", parameters: { type: "object" } },
        {
          type: "namespace",
          name: "functions",
          description: "Codex callable tools",
          tools: [
            { type: "function", name: "exec_command", description: "run", parameters: { type: "object" } },
            { type: "custom", name: "exec", description: "code", format: { type: "grammar" } },
          ],
        },
      ],
    });
    const body = JSON.parse(request.body) as { tools: Array<Record<string, unknown>> };

    expect(body.tools.some(tool => tool.type === "namespace")).toBe(false);
    expect(body.tools.some(tool => tool.type === "custom")).toBe(false);
    expect(body.tools.map(tool => tool.name).filter(Boolean)).toEqual(["top", "other", "exec_command", "exec"]);
    expect(request.convertedRoutedCustomToolNames).toContain("exec");
    expect(request.convertedNamespaceToolAliases?.size).toBe(0);
  });

  test("aliases MCP namespaces and restores the client-facing call", () => {
    const request = build({
      model: "xai/grok-4.6",
      input: [{ type: "function_call", call_id: "call_old", namespace: "mcp__fs", name: "read", arguments: "{}" }],
      tools: [{
        type: "namespace",
        name: "mcp__fs",
        tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
      }],
      tool_choice: { type: "function", namespace: "mcp__fs", name: "read" },
    });
    const body = JSON.parse(request.body) as {
      tools: Array<{ type: string; name: string }>;
      input: Array<{ namespace?: string; name: string }>;
      tool_choice: { namespace?: string; name: string };
    };

    expect(body.tools).toEqual([{ type: "function", name: "mcp__fs__read", parameters: { type: "object" } }]);
    expect(body.input[0]).toMatchObject({ name: "mcp__fs__read" });
    expect(body.input[0].namespace).toBeUndefined();
    expect(body.tool_choice).toMatchObject({ type: "function", name: "mcp__fs__read" });
    const restored = restoreNamespaceToolCallsInJson(
      JSON.stringify({ output: [{ type: "function_call", name: "mcp__fs__read", call_id: "call_1" }] }),
      request.convertedNamespaceToolAliases!,
    );
    expect(JSON.parse(restored).output[0]).toMatchObject({
      type: "function_call",
      namespace: "mcp__fs",
      name: "read",
      call_id: "call_1",
    });
  });

  test("fails closed for unsupported children and alias collisions", () => {
    expect(() => build({
      model: "xai/grok-4.6",
      tools: [{ type: "namespace", name: "mcp__fs", tools: [{ type: "shell", name: "read" }] }],
    })).toThrow(NamespaceToolCompatibilityError);
    expect(() => build({
      model: "xai/grok-4.6",
      tools: [
        { type: "function", name: "mcp__fs__read", parameters: { type: "object" } },
        { type: "namespace", name: "mcp__fs", tools: [{ type: "function", name: "read", parameters: {} }] },
      ],
    })).toThrow("collides");
  });

  test("leaves non-xAI Responses providers byte-compatible", () => {
    const raw = {
      model: "fixture/model",
      tools: [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "read", parameters: {} }] }],
    };
    const request = createResponsesPassthroughAdapter({
      ...xaiProvider,
      baseUrl: "https://fixture.test/v1",
    }).buildRequest(parsed(raw), { translatorBudget: createTestTranslatorBudget() });
    expect(JSON.parse(request.body).tools[0].type).toBe("namespace");
    expect(request.convertedNamespaceToolAliases).toBeUndefined();
  });

  test("round-trips a harmless namespaced call through handleResponses", async () => {
    const savedFetch = globalThis.fetch;
    let outbound: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      outbound = JSON.parse(String(init?.body));
      return Response.json({
        status: "completed",
        output: [{ type: "function_call", name: "mcp__lab__inspect", call_id: "call_1", arguments: "{}" }],
      });
    }) as typeof fetch;
    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: { fixture: xaiProvider },
    } as OcxConfig;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/grok-4.6",
          stream: false,
          input: "inspect",
          tools: [{
            type: "namespace",
            name: "mcp__lab",
            tools: [{ type: "function", name: "inspect", parameters: { type: "object" } }],
          }],
        }),
      }), config, { model: "", provider: "" });
      expect((outbound?.tools as Array<Record<string, unknown>>)[0]).toMatchObject({
        type: "function",
        name: "mcp__lab__inspect",
      });
      expect((await response.json() as { output: Array<Record<string, unknown>> }).output[0]).toMatchObject({
        type: "function_call",
        namespace: "mcp__lab",
        name: "inspect",
      });
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("restores a namespaced call on the streaming path Codex 0.148 uses", async () => {
    const savedFetch = globalThis.fetch;
    const item = {
      type: "function_call",
      name: "mcp__lab__inspect",
      call_id: "call_stream",
      arguments: "{}",
      status: "completed",
    };
    const upstream = [
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item })}\n\n`,
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    globalThis.fetch = (async () => new Response(upstream, {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: { fixture: xaiProvider },
    } as OcxConfig;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/grok-4.6",
          stream: true,
          input: "inspect",
          tools: [{
            type: "namespace",
            name: "mcp__lab",
            tools: [{ type: "function", name: "inspect", parameters: { type: "object" } }],
          }],
        }),
      }), config, { model: "", provider: "" });
      const client = await response.text();
      expect(client).not.toContain("mcp__lab__inspect");
      expect(client.match(/\"namespace\":\"mcp__lab\"/g)).toHaveLength(3);
      expect(client).toContain("data: [DONE]");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
