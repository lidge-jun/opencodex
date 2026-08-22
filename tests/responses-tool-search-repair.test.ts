import { describe, expect, test } from "bun:test";
import { isTranslatorBudgetExceededError } from "../src/lib/translator-budget";
import {
  restoreRoutedToolSearchCallsInJson,
  rewriteRoutedToolSearchForUpstream,
} from "../src/responses/tool-search-compat";
import { createRoutedToolSearchRestoreBlockRewrite } from "../src/server/responses-tool-search-repair";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

function frame(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...payload })}`;
}

function dataPayload(block: string): Record<string, unknown> {
  const line = block.split(/\r?\n/).find(entry => entry.startsWith("data:"));
  if (!line) throw new Error("missing SSE data line");
  return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
}

const searchTool = {
  type: "tool_search",
  execution: "client",
  description: "Search deferred tools",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
};

function fixtureConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "fixture",
    providers: {
      fixture: {
        adapter: "openai-responses",
        baseUrl: "https://fixture.test/v1",
        authMode: "key",
        apiKey: "fixture-key",
      },
    },
  } as OcxConfig;
}

describe("routed Responses tool-search compatibility", () => {
  test("lowers top-level and Responses Lite declarations plus tool choice without mutating input", () => {
    const raw = {
      model: "deepseek-v4-flash",
      input: [{ type: "additional_tools", tools: [searchTool] }],
      tools: [searchTool, { type: "function", name: "ordinary", parameters: { type: "object" } }],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "tool_search" }, { type: "function", name: "ordinary" }],
      },
    };

    const rewritten = rewriteRoutedToolSearchForUpstream(raw);
    const body = rewritten.body as {
      tools: Array<Record<string, unknown>>;
      input: Array<{ tools: Array<Record<string, unknown>> }>;
      tool_choice: { mode: string; tools: Array<Record<string, unknown>> };
    };

    expect(rewritten.names).toEqual(new Set(["tool_search"]));
    expect(rewritten.body).not.toBe(raw);
    expect(raw.tools[0]).toHaveProperty("type", "tool_search");
    expect(body.tools[0]).toEqual({
      type: "function",
      name: "tool_search",
      description: "Search deferred tools",
      parameters: searchTool.parameters,
    });
    expect(body.input[0]?.tools[0]).toMatchObject({ type: "function", name: "tool_search" });
    expect(body.tool_choice.mode).toBe("required");
    expect(body.tool_choice.tools[0]).toEqual({ type: "function", name: "tool_search" });
    expect(body.tools[1]).toEqual(raw.tools[1]);
  });

  test("does not mark an ordinary same-named function for privileged restoration", () => {
    const raw = {
      tools: [{ type: "function", name: "tool_search", parameters: { type: "object" } }],
    };
    const rewritten = rewriteRoutedToolSearchForUpstream(raw);

    expect(rewritten.body).toBe(raw);
    expect(rewritten.names).toEqual(new Set());
  });

  test("aliases a private search away from an ordinary same-named function", () => {
    const raw = {
      tools: [
        searchTool,
        { type: "function", name: "tool_search", parameters: { type: "object" } },
      ],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [
          { type: "tool_search" },
          { type: "function", name: "tool_search" },
        ],
      },
    };
    const rewritten = rewriteRoutedToolSearchForUpstream(raw);
    const body = rewritten.body as {
      tools: Array<Record<string, unknown>>;
      tool_choice: { tools: Array<Record<string, unknown>> };
    };

    expect(rewritten.names).toEqual(new Set(["opencodex_tool_search"]));
    expect(body.tools[0]).toMatchObject({ type: "function", name: "opencodex_tool_search" });
    expect(body.tools[1]).toEqual(raw.tools[1]);
    expect(body.tool_choice.tools).toEqual([
      { type: "function", name: "opencodex_tool_search" },
      { type: "function", name: "tool_search" },
    ]);

    const restored = JSON.parse(restoreRoutedToolSearchCallsInJson(JSON.stringify({
      output: [
        { type: "function_call", name: "opencodex_tool_search", arguments: "{}" },
        { type: "function_call", name: "tool_search", arguments: "{}" },
      ],
    }), rewritten.names)) as { output: Array<Record<string, unknown>> };
    expect(restored.output[0]?.type).toBe("tool_search_call");
    expect(restored.output[1]).toMatchObject({ type: "function_call", name: "tool_search" });
  });

  test("a forced ordinary same-named function does not authorize private-search restoration", () => {
    const rewritten = rewriteRoutedToolSearchForUpstream({
      tools: [
        searchTool,
        { type: "function", name: "tool_search", parameters: { type: "object" } },
      ],
      tool_choice: { type: "function", name: "tool_search" },
    });
    const body = rewritten.body as {
      tools: Array<Record<string, unknown>>;
      tool_choice: Record<string, unknown>;
    };

    expect(body.tools[0]).toMatchObject({ type: "function", name: "opencodex_tool_search" });
    expect(body.tool_choice).toEqual({ type: "function", name: "tool_search" });
    expect(rewritten.names).toEqual(new Set());
  });

  test("rewrites prior private search history to public function call pairs", () => {
    const previousTools = [{ type: "function", name: "deferred_read", parameters: { type: "object" } }];
    const rewritten = rewriteRoutedToolSearchForUpstream({
      tools: [searchTool],
      input: [
        {
          type: "tool_search_call",
          id: "tsc_previous",
          call_id: "call_previous",
          execution: "client",
          arguments: { query: "database" },
          status: "completed",
        },
        {
          type: "tool_search_output",
          call_id: "call_previous",
          execution: "client",
          status: "completed",
          tools: previousTools,
        },
      ],
    });
    const input = (rewritten.body as { input: Array<Record<string, unknown>> }).input;

    expect(input[0]).toEqual({
      type: "function_call",
      id: "fc_previous",
      call_id: "call_previous",
      name: "tool_search",
      arguments: '{"query":"database"}',
      status: "completed",
    });
    expect(input[1]).toMatchObject({
      type: "function_call_output",
      call_id: "call_previous",
    });
    expect(JSON.parse(String(input[1]?.output))).toEqual({ tools: previousTools, status: "completed" });
  });

  test("restores only the converted function name in bounded JSON", () => {
    const restored = JSON.parse(restoreRoutedToolSearchCallsInJson(JSON.stringify({
      id: "resp_1",
      output: [
        { type: "function_call", id: "fc_search", call_id: "call_search", name: "tool_search", arguments: '{"query":"database"}', status: "completed" },
        { type: "function_call", id: "fc_other", call_id: "call_other", name: "ordinary", arguments: "{}", status: "completed" },
      ],
    }), new Set(["tool_search"]))) as { output: Array<Record<string, unknown>> };

    expect(restored.output[0]).toEqual({
      type: "tool_search_call",
      id: "tsc_search",
      call_id: "call_search",
      execution: "client",
      arguments: { query: "database" },
      status: "completed",
    });
    expect(restored.output[1]).toMatchObject({ type: "function_call", name: "ordinary" });
  });

  test("restores the SSE item lifecycle and suppresses function argument frames", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createRoutedToolSearchRestoreBlockRewrite(new Set(["tool_search"]), budget);

    expect(rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc_search",
      delta: '{"query":',
    }))).toEqual([]);
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);

    const added = rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_search",
        call_id: "call_search",
        name: "tool_search",
        arguments: "",
        status: "in_progress",
      },
    }));
    expect(added).toHaveLength(1);
    expect(dataPayload(added[0]!).item).toEqual({
      type: "tool_search_call",
      id: "tsc_search",
      call_id: "call_search",
      execution: "client",
      arguments: {},
      status: "in_progress",
    });
    expect(budget.snapshot().currentBytes)
      .toBe(Buffer.byteLength(JSON.stringify("fc_search"), "utf8"));

    expect(rewrite(frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_search",
      arguments: '{"query":"database"}',
    }))).toEqual([]);

    const done = rewrite(frame("response.output_item.done", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_search",
        call_id: "call_search",
        name: "tool_search",
        arguments: '{"query":"database"}',
        status: "completed",
      },
    }));
    expect(dataPayload(done[0]!).item).toMatchObject({
      type: "tool_search_call",
      id: "tsc_search",
      arguments: { query: "database" },
    });
    rewrite.dispose?.();
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("replays an ordinary pending argument frame and releases unmatched terminal state", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createRoutedToolSearchRestoreBlockRewrite(new Set(["tool_search"]), budget);

    expect(rewrite(frame("response.function_call_arguments.delta", {
      output_index: 1,
      delta: '{"path":',
    }))).toEqual([]);
    const ordinary = rewrite(frame("response.output_item.added", {
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_regular",
        call_id: "call_regular",
        name: "ordinary",
        arguments: "",
        status: "in_progress",
      },
    }));
    expect(ordinary).toHaveLength(2);
    expect(dataPayload(ordinary[0]!).item_id).toBe("fc_regular");
    expect(dataPayload(ordinary[1]!).item).toMatchObject({ type: "function_call", name: "ordinary" });

    expect(rewrite(frame("response.function_call_arguments.delta", {
      output_index: 9,
      delta: "unmatched",
    }))).toEqual([]);
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
    expect(rewrite(frame("response.completed", {
      response: { id: "resp_done", status: "completed", output: [] },
    }))).toHaveLength(1);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("falls back to raw pass-through when the pending collector budget is exhausted", () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 64 });
    const rewrite = createRoutedToolSearchRestoreBlockRewrite(new Set(["tool_search"]), budget);
    const pending = frame("response.function_call_arguments.delta", {
      output_index: 0,
      delta: "x".repeat(256),
    });

    expect(rewrite(pending)).toEqual([pending]);
    expect(budget.snapshot().currentBytes).toBe(0);
    const added = frame("response.output_item.added", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_search",
        call_id: "call_search",
        name: "tool_search",
        arguments: "",
      },
    });
    expect(rewrite(added)).toEqual([added]);
  });

  test("handleResponses lowers and restores a streaming search call", async () => {
    const savedFetch = globalThis.fetch;
    let outboundBody: Record<string, unknown> | undefined;
    const upstreamItem = {
      type: "function_call",
      id: "fc_search",
      call_id: "call_search",
      name: "tool_search",
      arguments: '{"query":"database"}',
      status: "completed",
    };
    const upstream = [
      frame("response.output_item.added", { output_index: 0, item: { ...upstreamItem, arguments: "", status: "in_progress" } }),
      frame("response.function_call_arguments.delta", { output_index: 0, item_id: "fc_search", delta: upstreamItem.arguments }),
      frame("response.function_call_arguments.done", { output_index: 0, item_id: "fc_search", arguments: upstreamItem.arguments }),
      frame("response.output_item.done", { output_index: 0, item: upstreamItem }),
      frame("response.completed", { response: { id: "resp_1", status: "completed", output: [upstreamItem] } }),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    globalThis.fetch = (async (_input, init) => {
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/deepseek-v4-flash",
          stream: true,
          input: [{ role: "user", content: [{ type: "input_text", text: "find a database tool" }] }],
          tools: [
            searchTool,
            { type: "custom", name: "exec", description: "Run JavaScript", format: { type: "grammar", syntax: "lark" } },
          ],
        }),
      }), fixtureConfig(), { model: "", provider: "" });
      const clientSse = await response.text();
      const outboundTools = outboundBody?.tools as Array<Record<string, unknown>> | undefined;

      expect(outboundTools?.[0]).toMatchObject({ type: "function", name: "tool_search" });
      expect(outboundTools?.[1]).toMatchObject({ type: "function", name: "exec" });
      expect(clientSse).toContain('"type":"tool_search_call"');
      expect(clientSse).toContain('"id":"tsc_search"');
      expect(clientSse).not.toContain("response.function_call_arguments");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handleResponses restores a non-streaming search call", async () => {
    const savedFetch = globalThis.fetch;
    let outboundBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "resp_json",
        status: "completed",
        output: [{
          type: "function_call",
          id: "fc_search",
          call_id: "call_search",
          name: "tool_search",
          arguments: '{"query":"database"}',
          status: "completed",
        }],
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/deepseek-v4-flash",
          stream: false,
          input: [{ role: "user", content: [{ type: "input_text", text: "find a database tool" }] }],
          tools: [searchTool],
        }),
      }), fixtureConfig(), { model: "", provider: "" });
      const body = await response.json() as { output: Array<Record<string, unknown>> };
      const outboundTools = outboundBody?.tools as Array<Record<string, unknown>> | undefined;

      expect(outboundTools?.[0]).toMatchObject({ type: "function", name: "tool_search" });
      expect(body.output[0]).toEqual({
        type: "tool_search_call",
        id: "tsc_search",
        call_id: "call_search",
        execution: "client",
        arguments: { query: "database" },
        status: "completed",
      });
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handleResponses forwards second-turn search history in public function form", async () => {
    const savedFetch = globalThis.fetch;
    let outboundBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "resp_next", status: "completed", output: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/deepseek-v4-flash",
          stream: false,
          tools: [searchTool],
          input: [
            {
              type: "tool_search_call",
              id: "tsc_previous",
              call_id: "call_previous",
              execution: "client",
              arguments: { query: "database" },
              status: "completed",
            },
            {
              type: "tool_search_output",
              call_id: "call_previous",
              execution: "client",
              status: "completed",
              tools: [{ type: "function", name: "deferred_read", parameters: { type: "object" } }],
            },
            { role: "user", content: [{ type: "input_text", text: "use the loaded tool" }] },
          ],
        }),
      }), fixtureConfig(), { model: "", provider: "" });
      const input = outboundBody?.input as Array<Record<string, unknown>> | undefined;

      expect(input?.[0]).toMatchObject({
        type: "function_call",
        id: "fc_previous",
        call_id: "call_previous",
        name: "tool_search",
      });
      expect(typeof input?.[0]?.arguments).toBe("string");
      expect(input?.[1]).toMatchObject({
        type: "function_call_output",
        call_id: "call_previous",
      });
      expect(input?.some(item => item.type === "tool_search_call" || item.type === "tool_search_output")).toBe(false);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("tool_choice none prevents restoring an ignored upstream search call", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: "resp_json",
      status: "completed",
      output: [{
        type: "function_call",
        id: "fc_search",
        call_id: "call_search",
        name: "tool_search",
        arguments: '{"query":"database"}',
        status: "completed",
      }],
    }), { headers: { "content-type": "application/json" } })) as typeof fetch;

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/deepseek-v4-flash",
          stream: false,
          input: [{ role: "user", content: [{ type: "input_text", text: "do not call tools" }] }],
          tools: [searchTool],
          tool_choice: "none",
        }),
      }), fixtureConfig(), { model: "", provider: "" });
      const body = await response.json() as { output: Array<Record<string, unknown>> };

      expect(body.output[0]).toMatchObject({
        type: "function_call",
        name: "tool_search",
      });
      expect(body.output[0]).not.toHaveProperty("execution");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("history-only replay still arms restoration for the lowered call", () => {
    // A turn may replay tool_search history WITHOUT re-declaring the tool. The history is
    // lowered to function_call either way, so leaving \`names\` empty would hand the client a
    // public function_call for what it issued as a private search call.
    const { body, names } = rewriteRoutedToolSearchForUpstream({
      model: "fixture/deepseek-v4-flash",
      tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
      input: [
        {
          type: "tool_search_call",
          id: "tsc_old",
          call_id: "call_old",
          execution: "client",
          arguments: { query: "x" },
          status: "completed",
        },
        { type: "tool_search_output", call_id: "call_old", execution: "client", status: "completed", tools: [] },
      ],
    });

    expect(names.has("tool_search")).toBe(true);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ type: "function_call", id: "fc_old", name: "tool_search" });
    expect(input[1]).toMatchObject({ type: "function_call_output", call_id: "call_old" });
  });

  test("overflow keeps suppressing frames for an already-restored routed item", () => {
    const rewrite = createRoutedToolSearchRestoreBlockRewrite(new Set(["tool_search"]));

    // Open and restore a routed item.
    const opened = rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_search", name: "tool_search", arguments: "" },
    }));
    expect(dataPayload(opened[0]!).item).toMatchObject({ type: "tool_search_call", id: "tsc_search" });

    // Overflow the pending buffer on a DIFFERENT, unclassified item id.
    for (let i = 0; i <= 256; i += 1) {
      rewrite(frame("response.function_call_arguments.delta", {
        output_index: 1,
        item_id: "fc_unknown",
        delta: "x",
      }));
    }

    // The restored item's public argument frames must still be suppressed. Clearing the routed
    // id on overflow would leak them and give the client a mixed private/public lifecycle for
    // one call — the exact defect this rewrite exists to prevent.
    const leaked = rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc_search",
      delta: "{",
    }));
    expect(leaked).toEqual([]);

    // Unrelated traffic still passes through untouched after overflow.
    const other = rewrite(frame("response.output_text.delta", { output_index: 2, delta: "hi" }));
    expect(other).toHaveLength(1);
  });

  // `output_item.done` ends the ITEM, not the id's relevance. Forgetting the routed id there
  // meant a trailing argument frame — which some upstreams emit after done — fell through to
  // the unknown-id branch and reached the client as a public `function_call_arguments.*` for
  // an item the client was told is a private `tool_search_call`.
  test("a routed id stays suppressed after output_item.done", () => {
    const rewrite = createRoutedToolSearchRestoreBlockRewrite(new Set(["tool_search"]));

    rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_search", name: "tool_search", arguments: "" },
    }));
    const done = rewrite(frame("response.output_item.done", {
      output_index: 0,
      item: { type: "function_call", id: "fc_search", name: "tool_search", arguments: "{}" },
    }));
    expect(dataPayload(done[0]!).item).toMatchObject({ type: "tool_search_call" });

    const trailing = rewrite(frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_search",
      arguments: "{}",
    }));
    expect(trailing).toEqual([]);

    const trailingDelta = rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc_search",
      delta: "x",
    }));
    expect(trailingDelta).toEqual([]);
  });

  test("an ordinary item's frames still pass through after its done", () => {
    const rewrite = createRoutedToolSearchRestoreBlockRewrite(new Set(["tool_search"]));

    rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_plain", name: "not_routed", arguments: "" },
    }));
    rewrite(frame("response.output_item.done", {
      output_index: 0,
      item: { type: "function_call", id: "fc_plain", name: "not_routed", arguments: "{}" },
    }));

    // Retaining routed ids must not accidentally start swallowing ordinary ones.
    const trailing = rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc_plain",
      delta: "x",
    }));
    expect(trailing).toHaveLength(1);
  });

  test("bounds classified item ids by count and releases the retained charge", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createRoutedToolSearchRestoreBlockRewrite(new Set(["tool_search"]), budget);
    let expectedRetainedBytes = 0;

    for (let index = 0; index < 256; index += 1) {
      const itemId = `fc_${index}`;
      expectedRetainedBytes += Buffer.byteLength(JSON.stringify(itemId), "utf8");
      rewrite(frame("response.output_item.done", {
        output_index: index,
        item: { type: "function_call", id: itemId, name: "tool_search", arguments: "{}" },
      }));
    }

    const beforeOverflow = budget.snapshot().currentBytes;
    expect(beforeOverflow).toBe(expectedRetainedBytes);
    let overflow: unknown;
    try {
      rewrite(frame("response.output_item.done", {
        output_index: 256,
        item: { type: "function_call", id: "fc_overflow", name: "tool_search", arguments: "{}" },
      }));
    } catch (error) {
      overflow = error;
    }
    expect(isTranslatorBudgetExceededError(overflow)).toBe(true);
    expect(overflow).toBeInstanceOf(Error);
    expect((overflow as Error).message).toBe("translator item_ids count exceeded 256 items");
    expect(budget.snapshot().currentBytes).toBe(beforeOverflow);

    rewrite.dispose?.();
    rewrite.dispose?.();
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("bounds classified item ids by serialized UTF-8 bytes", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createRoutedToolSearchRestoreBlockRewrite(new Set(["tool_search"]), budget);
    const nearlyFullId = "x".repeat(256 * 1024 - 7);
    rewrite(frame("response.output_item.done", {
      output_index: 0,
      item: { type: "function_call", id: nearlyFullId, name: "tool_search", arguments: "{}" },
    }));
    expect(budget.snapshot().currentBytes).toBe(256 * 1024 - 5);
    rewrite(frame("response.output_item.done", {
      output_index: 1,
      item: { type: "function_call", id: "界", name: "tool_search", arguments: "{}" },
    }));
    expect(budget.snapshot().currentBytes).toBe(256 * 1024);

    let overflow: unknown;
    try {
      rewrite(frame("response.output_item.done", {
        output_index: 2,
        item: {
          type: "function_call",
          id: "y",
          name: "tool_search",
          arguments: "{}",
        },
      }));
    } catch (error) {
      overflow = error;
    }
    if (!isTranslatorBudgetExceededError(overflow)) throw overflow;
    expect(overflow.kind).toBe("item_ids");
    expect(overflow.limitBytes).toBe(256 * 1024);
    expect(budget.snapshot().currentBytes).toBe(256 * 1024);
    rewrite.dispose?.();
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("deduplicates and reclassifies one item id without double charging", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createRoutedToolSearchRestoreBlockRewrite(new Set(["tool_search"]), budget);
    const itemId = "fc_shared";
    const retainedBytes = Buffer.byteLength(JSON.stringify(itemId), "utf8");
    const emit = (event: "response.output_item.added" | "response.output_item.done", name: string) => {
      rewrite(frame(event, {
        output_index: 0,
        item: { type: "function_call", id: itemId, name, arguments: "{}" },
      }));
      expect(budget.snapshot().currentBytes).toBe(retainedBytes);
    };

    emit("response.output_item.added", "tool_search");
    emit("response.output_item.done", "tool_search");
    const argument = frame("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: itemId,
      delta: "x",
    });
    expect(rewrite(argument)).toEqual([]);
    emit("response.output_item.added", "ordinary");
    expect(rewrite(argument)).toEqual([argument]);
    emit("response.output_item.done", "tool_search");
    expect(rewrite(argument)).toEqual([]);

    rewrite(frame("response.completed", {
      response: { id: "resp_done", status: "completed", output: [] },
    }));
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("releases routed ids on terminal and DONE after pending passthrough", () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 64 });
    const rewrite = createRoutedToolSearchRestoreBlockRewrite(new Set(["tool_search"]), budget);
    const routedBytes = Buffer.byteLength(JSON.stringify("fc_search"), "utf8");
    const ordinaryBytes = Buffer.byteLength(JSON.stringify("fc_plain"), "utf8");
    rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_search", name: "tool_search", arguments: "{}" },
    }));
    rewrite(frame("response.output_item.added", {
      output_index: 1,
      item: { type: "function_call", id: "fc_plain", name: "ordinary", arguments: "{}" },
    }));
    expect(budget.snapshot().currentBytes).toBe(routedBytes + ordinaryBytes);

    const pending = frame("response.function_call_arguments.delta", {
      output_index: 1,
      item_id: "unknown",
      delta: "x".repeat(256),
    });
    expect(rewrite(pending)).toEqual([pending]);
    expect(budget.snapshot().currentBytes).toBe(routedBytes);
    rewrite(frame("response.completed", {
      response: { id: "resp_done", status: "completed", output: [] },
    }));
    expect(budget.snapshot().currentBytes).toBe(0);

    const doneBudget = createTestTranslatorBudget();
    const doneRewrite = createRoutedToolSearchRestoreBlockRewrite(new Set(["tool_search"]), doneBudget);
    doneRewrite(frame("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_done", name: "tool_search", arguments: "{}" },
    }));
    expect(doneBudget.snapshot().currentBytes).toBeGreaterThan(0);
    expect(doneRewrite("data: [DONE]")).toEqual(["data: [DONE]"]);
    expect(doneBudget.snapshot().currentBytes).toBe(0);
    doneRewrite.dispose?.();
    expect(doneBudget.snapshot().currentBytes).toBe(0);
  });
});
