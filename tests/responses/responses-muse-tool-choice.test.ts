import { afterEach, describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { normalizeMuseToolCatalog } from "../../src/adapters/openai-responses/muse-tool-catalog";
import { tagHistoricalInputItems } from "../../src/responses/item-provenance";
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

function build(provider: OcxProviderConfig, rawBody: Record<string, unknown>, compact = false, replayPrefixLength?: number) {
  return createAdapter(provider).buildRequest({
    modelId: "muse-spark-1.3",
    _compactionRequest: compact,
    _replayPrefixLen: replayPrefixLength,
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


describe("Meta Muse Responses include compatibility", () => {
  test("drops output encryption while preserving supported reasoning, other includes and caller input", () => {
    for (const model of ["muse-spark-1.3", "muse-wonder-1.0", "muse-wonder-full-1.0"]) {
      const raw = { model, include: ["reasoning.encrypted_content", "output.encrypted_content", "message.output_text.logprobs"], store: false };
      const original = structuredClone(raw);
      const body = JSON.parse(build(meta, raw).body);
      expect(body.include).toEqual(["reasoning.encrypted_content", "message.output_text.logprobs"]);
      expect(body.model).toBe(model);
      expect(body.store).toBe(false);
      expect(raw).toEqual(original);
    }
  });

  test("routed compaction preserves supported reasoning encryption", () => {
    const raw = { include: ["reasoning.encrypted_content", "output.encrypted_content"], store: false };
    const body = JSON.parse(build(meta, raw, true).body);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(raw.include).toEqual(["reasoning.encrypted_content", "output.encrypted_content"]);
  });

  test("omits include when only unsupported output encryption was requested", () => {
    expect(JSON.parse(build(meta, { include: ["output.encrypted_content"] }).body)).not.toHaveProperty("include");
  });

  test("preserves unknown and malformed includes for upstream validation", () => {
    for (const include of [undefined, null, "output.encrypted_content", { value: "output.encrypted_content" }, ["future.include"], [["output.encrypted_content"]]]) {
      expect(JSON.parse(build(meta, { include }).body).include).toEqual(include);
    }
  });

  test("does not infer Meta from a model name, path or lookalike hostname", () => {
    for (const baseUrl of ["https://api.openai.com/v1", "https://api.meta.ai.example.test/v1", "https://example.test/api.meta.ai/v1"]) {
      const include = ["reasoning.encrypted_content", "output.encrypted_content"];
      expect(JSON.parse(build({ ...meta, baseUrl }, { include }).body).include).toEqual(include);
    }
  });
});


describe("Meta Muse additional tool catalogs", () => {
  const lookup = { type: "function", name: "lookup", parameters: { type: "object", properties: {} } };
  test("moves current namespace tools to the public catalog without changing messages or caller data", () => {
    const message = { type: "message", role: "user", content: "continue" };
    const raw = { input: [{ type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [lookup] }] }, message] };
    const original = structuredClone(raw);
    const body = JSON.parse(build(meta, raw).body);
    expect(body.input).toEqual([message]);
    expect(body.tools).toEqual([lookup]);
    expect(raw).toEqual(original);
  });

  test("removes replayed wrappers without authorizing their historical tools", () => {
    const message = { type: "message", role: "user", content: "continue" };
    const raw = { tools: [], input: [{ type: "additional_tools", tools: [lookup] }, message] };
    const body = JSON.parse(build(meta, raw, false, 1).body);
    expect(body.input).toEqual([message]);
    expect(body.tools).toEqual([]);
  });

  test("ignores malformed historical catalogs while normalizing current declarations", () => {
    for (const historical of [
      { type: "additional_tools" },
      { type: "additional_tools", tools: [{ type: "namespace", name: "old", tools: [{ type: "web_search" }] }] },
    ]) {
      const definition = { name: "read", parameters: { type: "object", properties: {} } };
      const raw = { input: [historical, { type: "additional_tools", tools: [{ type: "function", function: definition }] }] };
      const original = structuredClone(raw);
      const body = JSON.parse(build(meta, raw, false, 1).body);
      expect(body.input).toEqual([]);
      expect(body.tools).toEqual([{ type: "function", ...definition }]);
      expect(raw).toEqual(original);
    }
  });

  test("does not promote historical search discoveries or let removed history shift current declarations", () => {
    const stale = { ...lookup, name: "stale" };
    const live = { ...lookup, name: "live" };
    const raw = { input: [
      { type: "configuration_update", config: {} },
      { type: "additional_tools", tools: [stale] },
      { type: "tool_search_output", call_id: "old_search", tools: [stale] },
      { type: "additional_tools", tools: [live] },
      { type: "tool_search_output", call_id: "new_search", tools: [{ ...lookup, name: "loaded" }] },
    ] };
    const body = JSON.parse(build(meta, raw, false, 3).body);
    expect(body.tools.map((entry: { name: string }) => entry.name).sort()).toEqual(["live", "loaded"]);
    expect(body.input.some((item: { type: string }) => item.type === "additional_tools")).toBe(false);
    expect(JSON.stringify(body.input)).toContain("stale");
  });

  test("a historical duplicate cannot consume the current declaration", () => {
    const current = { ...lookup, description: "Current declaration" };
    const body = JSON.parse(build(meta, { input: [
      { type: "additional_tools", tools: [lookup] },
      { type: "additional_tools", tools: [current] },
    ] }, false, 1).body);
    expect(body.tools).toEqual([current]);
  });

  test("rejects malformed catalogs before partial promotion", () => {
    for (const raw of [
      { tools: null, input: [{ type: "additional_tools", tools: [lookup] }] },
      { input: [{ type: "additional_tools", tools: null }, { type: "additional_tools", tools: [lookup] }] },
      { input: [{ type: "additional_tools", tools: [lookup, { type: "namespace", name: "bad", tools: null }] }] },
      { input: [{ type: "additional_tools", tools: [lookup, null] }] },
      { input: [{ type: "tool_search_output", call_id: "s1", tools: [lookup, { type: "namespace", name: "bad", tools: null }] }] },
    ]) {
      const original = structuredClone(raw);
      expect(() => build(meta, raw)).toThrow("Malformed tool catalog for Meta Responses.");
      expect(raw).toEqual(original);
    }
  });

  test("current declarations keep their schema when search discovers the same tool", () => {
    const declared = { ...lookup, defer_loading: true, parameters: { type: "object", properties: { project_id: { type: "string" } } } };
    const discovered = { ...lookup, parameters: { type: "object", properties: { admin_mode: { type: "boolean" } } } };
    for (const namespace of [undefined, "functions", "workspace"]) {
      const catalog = namespace ? [{ type: "namespace", name: namespace, tools: [declared] }] : [declared];
      const discoveries = namespace === "workspace" ? [{ type: "namespace", name: namespace, tools: [discovered] }] : [discovered];
      for (const tools of [undefined, []]) {
        const raw = { tools, input: [
          { type: "additional_tools", tools: catalog },
          { type: "tool_search_output", call_id: "s1", tools: discoveries },
        ] };
        const original = structuredClone(raw);
        const body = JSON.parse(build(meta, raw).body);
        expect(body.tools).toHaveLength(1);
        expect(body.tools[0].parameters).toEqual(declared.parameters);
        expect(body.tools[0]).not.toHaveProperty("defer_loading");
        expect(raw).toEqual(original);
      }
    }
  });

  test("unrepresentable namespace children fail without a partial catalog", () => {
    for (const invalid of [
      { type: "namespace", name: "inner", tools: [lookup] },
      { ...lookup, name: "bad\u0000name" },
      { type: "web_search" },
    ]) {
      const group = { type: "namespace", name: "outer", tools: [lookup, invalid] };
      for (const raw of [
        { tools: [group], input: [] },
        { input: [{ type: "additional_tools", tools: [group] }] },
        { input: [{ type: "tool_search_output", call_id: "s1", tools: [group] }] },
      ]) expect(() => build(meta, raw)).toThrow("Malformed tool catalog for Meta Responses.");
    }
    expect(() => build(meta, { tools: [{ type: "namespace", name: "bad\nname", tools: [lookup] }] }))
      .toThrow("Malformed tool catalog for Meta Responses.");
  });

  test("explicit bare declarations win over reserved namespace duplicates in either carrier order", () => {
    const bare = { ...lookup, parameters: { type: "object", properties: { project_id: { type: "string" } } } };
    const group = { type: "namespace", name: "functions", tools: [{ ...lookup, parameters: { type: "object", properties: { group_id: { type: "string" } } } }] };
    for (const raw of [
      { tools: [group], input: [{ type: "additional_tools", tools: [bare] }] },
      { tools: [bare], input: [{ type: "additional_tools", tools: [group] }] },
      { input: [{ type: "additional_tools", tools: [group] }, { type: "additional_tools", tools: [bare] }] },
      { input: [{ type: "additional_tools", tools: [bare] }, { type: "additional_tools", tools: [group] }] },
      { tools: [group, bare], input: "continue" },
    ]) {
      const original = structuredClone(raw);
      expect(JSON.parse(build(meta, raw).body).tools).toEqual([bare]);
      expect(raw).toEqual(original);
    }
  });

  test("validates top-level catalogs with string or omitted input", () => {
    for (const input of ["continue", undefined]) {
      expect(() => build(meta, { input, tools: [lookup, { type: "namespace", name: "bad", tools: null }] }))
        .toThrow("Malformed tool catalog for Meta Responses.");
    }
  });

  test("normalizes nested function definitions across input forms and catalog carriers", () => {
    const definition = { name: "read", description: "Read a project", parameters: { type: "object", properties: { project_id: { type: "string" } } }, strict: true };
    const nested = { type: "function", function: definition };
    for (const raw of [
      { input: "continue", tools: [nested] },
      { input: undefined, tools: [nested] },
      { input: [], tools: [nested] },
      { input: [{ type: "additional_tools", tools: [nested] }] },
      { input: [{ type: "tool_search_output", call_id: "s1", tools: [nested] }] },
    ]) {
      const original = structuredClone(raw);
      expect(JSON.parse(build(meta, raw).body).tools).toEqual([{ type: "function", ...definition }]);
      expect(raw).toEqual(original);
    }
  });

  test("preserves historical custom-call conversion without declaring the old tool", () => {
    for (const toolChoice of ["auto", "none"]) {
      const raw = { tool_choice: toolChoice, input: [
        { type: "additional_tools", tools: [{ type: "custom", name: "old_exec", description: "Historical tool" }] },
        { type: "custom_tool_call", name: "old_exec", call_id: "c1", input: "historical input" },
        { type: "custom_tool_call_output", call_id: "c1", output: "historical output" },
        { type: "message", role: "user", content: "continue" },
      ] };
      const original = structuredClone(raw);
      const request = build(meta, raw, false, 3);
      const body = JSON.parse(request.body);
      expect(body.tools).toEqual([]);
      expect(body.input).toEqual([
        { type: "function_call", name: "old_exec", call_id: "c1", arguments: JSON.stringify({ input: "historical input" }) },
        { type: "function_call_output", call_id: "c1", output: "historical output" },
        original.input[3],
      ]);
      expect(request.convertedRoutedCustomToolNames?.has("old_exec")).toBe(false);
      expect(raw).toEqual(original);
    }
  });

  test("malformed nested catalogs return a client error without sending upstream", async () => {
    const config = { port: 0, defaultProvider: "fixture", providers: { fixture: { ...meta, authMode: "key" } } } as OcxConfig;
    const savedFetch = globalThis.fetch;
    let sends = 0;
    globalThis.fetch = (async () => { sends++; throw new Error("must not send"); }) as typeof fetch;
    try {
      releaseSpendHome ??= acquireOwnedSpendHome();
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture/muse-spark-1.3", input: [
          { type: "additional_tools", tools: [lookup, { type: "namespace", name: "bad", tools: null }] },
          { type: "message", role: "user", content: "continue" },
        ] }),
      }), config, { model: "", provider: "" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error", message: "Malformed tool catalog for Meta Responses." } });
      expect(sends).toBe(0);
    } finally { globalThis.fetch = savedFetch; }
  });

  test("none clears declarations after promotion and long-name aliasing", () => {
    const body = JSON.parse(build(meta, { input: [{ type: "additional_tools", tools: [tool] }], tool_choice: "none" }).body);
    expect(body.tools).toEqual([]);
    expect(body.input).toEqual([]);
  });

  test("leaves the private wrapper intact for unrelated destinations", () => {
    const raw = { input: [{ type: "additional_tools", tools: [lookup] }] };
    for (const baseUrl of ["https://api.openai.com/v1", "https://api.meta.ai.example.test/v1"]) {
      expect(JSON.parse(build({ ...meta, baseUrl }, raw).body).input).toEqual(raw.input);
    }
  });
});

test("Meta catalog follows item provenance once an earlier rewrite shortened the input", () => {
  const schema = { type: "object", properties: {} };
  const tagged = tagHistoricalInputItems([
    { type: "additional_tools", tools: [{ type: "function", name: "old_tool", parameters: schema }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "earlier" }] },
    { type: "tool_search_output", call_id: "search", status: "completed", execution: "client", tools: [{ type: "function", name: "lookup", parameters: schema }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "now" }] },
  ], 2);
  // Zed lifted the replayed wrapper before the delegate ran, so the numeric prefix of 2 is stale.
  const body = normalizeMuseToolCatalog({ model: "muse", input: tagged.slice(1) }, 2) as { tools?: { name?: string }[]; input: unknown[] };
  expect(body.tools?.map(tool => tool.name)).toEqual(["lookup"]);
  expect(JSON.stringify(body.input)).not.toContain("old_tool");
});
