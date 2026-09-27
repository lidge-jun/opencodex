import { afterEach, describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const meta = { adapter: "openai-responses", baseUrl: "https://api.meta.ai/v1", apiKey: "test-key" } as OcxProviderConfig;
const xai = { ...meta, baseUrl: "https://api.x.ai/v1" } as OcxProviderConfig;
const longName = "mcp__plugin_huggingface-skills_huggingface-skills__hub_repo_search";
const longWireName = "mcp__plugin_huggingface-skills_huggingface-skills__hub__dec57ce4";
const tool = { type: "function", name: longName, parameters: { type: "object", properties: {} } };
let releaseSpendHome: (() => void) | undefined;

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
});

function build(provider: OcxProviderConfig, rawBody: Record<string, unknown>) {
  return createAdapter(provider).buildRequest({
    modelId: "muse-spark-1.3",
    context: { messages: [] },
    stream: false,
    options: {},
    _rawBody: { model: "muse-spark-1.3", input: "continue", ...rawBody },
  }, { headers: new Headers() });
}

describe("Meta Muse tool choice", () => {
  test("none removes declaration carriers while preserving history and caller input", () => {
    const raw = {
      input: [
        { type: "function_call", name: longName, call_id: "c1", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "done" },
        { type: "additional_tools", tools: [tool] },
      ],
      tools: [tool],
      tool_choice: "none",
      parallel_tool_calls: true,
    };
    const original = structuredClone(raw);
    const body = JSON.parse(build(meta, raw).body) as Record<string, unknown>;

    expect(body.tools).toEqual([]);
    expect(body.input).toEqual([
      { ...original.input[0], name: longWireName },
      original.input[1],
    ]);
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("parallel_tool_calls");
    expect(raw).toEqual(original);
  });

  test("auto and omitted choice remain unchanged", () => {
    for (const choice of [undefined, "auto"] as const) {
      const raw = { tools: [tool], ...(choice ? { tool_choice: choice } : {}) };
      const original = structuredClone(raw);
      const body = JSON.parse(build(meta, raw).body) as Record<string, unknown>;
      expect(body.tools).toHaveLength(1);
      expect((body.tools as Array<{ name: string }>)[0]!.name).toHaveLength(64);
      expect(body.tool_choice).toBe(choice);
      expect(raw).toEqual(original);
    }
  });

  test("raw forced hosted choice fails if provider filtering removes its only tool", () => {
    const provider = { ...meta, unsupportedHostedTools: ["web_search"] };
    for (const choice of ["required", { type: "web_search" }]) {
      expect(() => build(provider, {
        tools: [{ type: "web_search" }],
        tool_choice: choice,
      })).toThrow("This tool_choice cannot be preserved for Meta Responses; use auto or none.");
    }
  });

  test("allowed_tools, null and unknown selectors fail with the compatibility error", () => {
    for (const choice of [
      { type: "allowed_tools", mode: "auto", tools: [tool] },
      null,
      { type: "unknown" },
    ]) {
      expect(() => build(meta, { tools: [tool], tool_choice: choice }))
        .toThrow("This tool_choice cannot be preserved for Meta Responses; use auto or none.");
    }
  });

  test("non-Meta Responses destinations retain tool choices", () => {
    const raw = { tools: [tool], tool_choice: { type: "function", name: longName } };
    const body = JSON.parse(build(xai, raw).body) as Record<string, unknown>;
    expect(body.tool_choice).toEqual(raw.tool_choice);
    expect(body.tools).toEqual(raw.tools);
  });

  test("compaction does not bypass forced-choice rejection for a namespaced tool", async () => {
    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: { fixture: { ...meta, authMode: "key" } },
    } as OcxConfig;
    const savedFetch = globalThis.fetch;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return Response.json({ id: "unexpected", status: "completed", output: [] });
    }) as typeof fetch;
    try {
      releaseSpendHome ??= acquireOwnedSpendHome();
      const response = await handleResponsesCompact(new Request("http://localhost/v1/responses/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/muse-spark-1.3",
          input: [{ type: "function_call", name: longName, call_id: "c1", arguments: "{}" }],
          tools: [tool],
          tool_choice: { type: "function", name: longName },
        }),
      }), config, { model: "", provider: "" });
      expect(response.status).toBe(400);
      const error = await response.json() as { error: { message: string } };
      expect(error.error.message).toBe("This tool_choice cannot be preserved for Meta Responses; use auto or none.");
      expect(sends).toBe(0);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handleResponses returns a client 400 before any upstream send", async () => {
    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: { fixture: { ...meta, authMode: "key" } },
    } as OcxConfig;
    const savedFetch = globalThis.fetch;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return new Response("unexpected upstream send", { status: 200 });
    }) as typeof fetch;
    try {
      releaseSpendHome ??= acquireOwnedSpendHome();
      for (const toolChoice of ["required", { type: "function", name: longName }]) {
        const response = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "fixture/muse-spark-1.3",
            input: "use the selected tool",
            tools: [tool],
            tool_choice: toolChoice,
          }),
        }), config, { model: "", provider: "" });
        expect(response.status).toBe(400);
        const error = await response.json() as { error: { type: string; code: string; message: string } };
        expect(error).toMatchObject({ error: { type: "invalid_request_error", code: "invalid_request_error" } });
        expect(error.error.message).toBe("This tool_choice cannot be preserved for Meta Responses; use auto or none.");
      }
      expect(sends).toBe(0);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("none succeeds through handleResponses with no declared tools", async () => {
    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: { fixture: { ...meta, authMode: "key" } },
    } as OcxConfig;
    const savedFetch = globalThis.fetch;
    let outbound: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      outbound = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "resp_none", status: "completed", output: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      releaseSpendHome ??= acquireOwnedSpendHome();
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture/muse-spark-1.3", input: "no tools", tools: [tool], tool_choice: "none" }),
      }), config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      expect(outbound?.tools).toEqual([]);
      expect(outbound).not.toHaveProperty("tool_choice");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
