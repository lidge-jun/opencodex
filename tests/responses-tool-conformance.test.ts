import { describe, expect, it } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { cursorRequestUsesCodeMode } from "../src/adapters/cursor/tool-definitions";
import type { AdapterEvent } from "../src/types";
import { jsonItemTypes, jsonToolItems, streamedView } from "./helpers/responses-conformance";

/**
 * Responses tool round-trip conformance
 * (devlog/_plan/260813_routed_tool_discovery_profiles/030-034).
 *
 * The plan's premise was that a translator reading only top-level `tools` can silently erase
 * terminal, custom and namespace tools, and that the model then emits ordinary text and
 * completes normally — a failure that looks like model behavior rather than protocol loss.
 * That premise is partly obsolete here: `additional_tools` IS parsed and merged. This suite
 * covers PART of the residual exposure — malformed input, unknown tool kinds, and
 * stream/non-stream divergence. It is a STARTING slice of the 030-034 programme, not a
 * complete conformance layer: the end-to-end declaration/call/result/second-turn execution
 * loop, compaction and resume with a discovered tool, the full collision matrix, per-adapter
 * declaration comparison, transport-error parity, and the conformance artifacts are absent.
 *
 * Several cases below deliberately pin CURRENT degradation rather than desired behavior.
 * They are labeled as such, so a future change to that behavior fails here loudly instead of
 * being discovered by a user whose tool vanished.
 */

const MODEL = "deepseek/glm-5.2";

function request(input: unknown[], tools?: unknown[]): Record<string, unknown> {
  return {
    model: MODEL,
    input,
    ...(tools ? { tools } : {}),
  };
}

function toolNames(parsed: ReturnType<typeof parseRequest>): string[] {
  return (parsed.context.tools ?? []).map(tool => tool.name);
}

describe("Responses Lite additional_tools declaration merge", () => {
  const fnTool = { type: "function", name: "read_file", parameters: { type: "object", properties: {} } };
  const nsTool = {
    type: "namespace",
    name: "github",
    tools: [{ type: "function", name: "search", parameters: { type: "object", properties: {} } }],
  };
  const customTool = { type: "custom", name: "apply_patch" };

  it("merges top-level tools and additional_tools input items", () => {
    const parsed = parseRequest(request(
      [{ type: "additional_tools", role: "developer", tools: [customTool] }],
      [fnTool],
    ));
    expect(toolNames(parsed)).toEqual(["read_file", "apply_patch"]);
  });

  it("accepts an additional_tools-only request, the Codex Desktop responses_lite shape", () => {
    // The tool surface rides INSIDE input rather than body.tools. A translator that reads
    // only body.tools sees an empty catalog and the turn silently loses every tool.
    const parsed = parseRequest(request(
      [{ type: "additional_tools", role: "developer", tools: [fnTool, nsTool, customTool] }],
    ));
    // Namespaced children keep their BARE name; the namespace rides alongside on the tool.
    expect(toolNames(parsed)).toEqual(["read_file", "search", "apply_patch"]);
    expect(parsed.context.tools?.find(tool => tool.name === "search")?.namespace).toBe("github");
  });

  it("flattens Codex 0.147 built-in functions and preserves nested custom exec", () => {
    const parsed = parseRequest(request([
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [
              { type: "custom", name: "exec", description: "Run JavaScript with nested helpers." },
              { type: "function", name: "wait", parameters: { type: "object", properties: {} } },
            ],
          },
          {
            type: "namespace",
            name: "collaboration",
            tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object", properties: {} } }],
          },
        ],
      },
    ]));

    const exec = parsed.context.tools?.find(tool => tool.name === "exec");
    const wait = parsed.context.tools?.find(tool => tool.name === "wait");
    const spawn = parsed.context.tools?.find(tool => tool.name === "spawn_agent");
    expect(exec).toMatchObject({ name: "exec", freeform: true });
    expect(exec?.namespace).toBeUndefined();
    expect(wait?.namespace).toBeUndefined();
    expect(spawn?.namespace).toBe("collaboration");
    expect(cursorRequestUsesCodeMode(parsed.context.tools)).toBe(true);
  });

  it("preserves wire order across multiple additional_tools groups", () => {
    const parsed = parseRequest(request([
      { type: "additional_tools", role: "developer", tools: [fnTool] },
      { type: "additional_tools", role: "developer", tools: [customTool] },
    ]));
    expect(toolNames(parsed)).toEqual(["read_file", "apply_patch"]);
  });

  it("lets the top-level declaration win a qualified-name collision", () => {
    const shadowed = { type: "function", name: "read_file", parameters: { type: "object", properties: { shadow: { type: "string" } } } };
    const parsed = parseRequest(request(
      [{ type: "additional_tools", role: "developer", tools: [shadowed] }],
      [fnTool],
    ));
    expect(toolNames(parsed)).toEqual(["read_file"]);
    // The surviving entry is the TOP-LEVEL one, not the nested shadow.
    expect(parsed.context.tools?.[0]?.parameters).toEqual(fnTool.parameters as never);
  });

  it("CURRENT BEHAVIOR: a malformed additional_tools item is ignored, not rejected", () => {
    // devlog 031 asks for explicit failure here. Today the item is skipped silently, so a
    // typo in the tool surface degrades to "model has no tools" with no diagnostic. Pinned
    // so that changing it to a hard error is a visible, deliberate decision.
    //
    // A WELL-FORMED sibling group rides along deliberately: without it this case would also
    // pass if additional_tools support were deleted outright, and "ignored one bad item"
    // would be indistinguishable from "lost the whole feature".
    const parsed = parseRequest(request([
      { type: "additional_tools", role: "developer", tools: "not-an-array" },
      { type: "additional_tools", role: "developer", tools: [fnTool] },
    ]));
    expect(toolNames(parsed)).toEqual(["read_file"]);
  });
});

describe("Responses tool-kind discrimination", () => {
  it("maps each known kind onto its internal marker", () => {
    const parsed = parseRequest(request([], [
      { type: "function", name: "fn", parameters: { type: "object", properties: { path: { type: "string" } } } },
      { type: "custom", name: "freeform" },
      { type: "tool_search", execution: "client", description: "search", parameters: { type: "object", properties: {} } },
      { type: "namespace", name: "ns", tools: [{ type: "function", name: "child", parameters: { type: "object", properties: {} } }] },
    ]));
    const byName = new Map((parsed.context.tools ?? []).map(tool => [tool.name, tool]));
    // NOTE: this asserts function-declaration BEHAVIOR, not branch discrimination. The
    // explicit `type === "function"` branch and the generic named-tool fallback both call
    // pushFn(t) (parser.ts:157 and :194), so they are observably identical for a named tool
    // and NO assertion can tell them apart. Deleting the explicit branch keeps this green on
    // purpose; what it does pin is that a declared schema reaches the model intact.
    expect(byName.get("fn")?.parameters).toEqual({ type: "object", properties: { path: { type: "string" } } } as never);
    expect(byName.get("freeform")?.freeform).toBe(true);
    expect(byName.get("tool_search")?.toolSearch).toBe(true);
    expect(byName.get("child")?.namespace).toBe("ns");
  });

  it("CURRENT BEHAVIOR: an unknown NAMED kind survives as a callable function", () => {
    // Better than the historical silent drop, but the original kind is not recoverable, so
    // the response cannot be restored as that kind either.
    const parsed = parseRequest(request([], [
      { type: "computer_use_preview", name: "computer", parameters: { type: "object", properties: {} } },
    ]));
    expect(toolNames(parsed)).toEqual(["computer"]);
    expect(parsed.context.tools?.[0]?.freeform).toBeUndefined();
  });

  it("CURRENT BEHAVIOR: an unknown UNNAMED kind disappears entirely", () => {
    // This is the plan's silent-loss class, still live. There is no name to pass through, so
    // the declaration is dropped with no diagnostic.
    const parsed = parseRequest(request([], [
      { type: "some_future_hosted_tool", config: { enabled: true } },
    ]));
    expect(parsed.context.tools ?? []).toEqual([]);
  });

  it("preserves custom namespace children while unknown child kinds still disappear", () => {
    const parsed = parseRequest(request([], [
      {
        type: "namespace",
        name: "ns",
        tools: [
          { type: "function", name: "kept", parameters: { type: "object", properties: {} } },
          { type: "custom", name: "freeform" },
          { type: "computer_use_preview", name: "dropped" },
        ],
      },
    ]));
    expect(toolNames(parsed)).toEqual(["kept", "freeform"]);
    expect(parsed.context.tools?.[1]).toMatchObject({
      name: "freeform",
      namespace: "ns",
      freeform: true,
    });
  });
});

describe("tool_search call and output history", () => {
  it("loads definitions returned by a tool_search_output into the active catalog", () => {
    const parsed = parseRequest(request([
      { type: "message", role: "user", content: [{ type: "input_text", text: "find it" }] },
      { type: "tool_search_call", id: "ts_1", call_id: "ts_1", execution: "client", arguments: "{\"query\":\"repl\"}", status: "completed" },
      {
        type: "tool_search_output",
        call_id: "ts_1",
        status: "completed",
        execution: "client",
        tools: [{ type: "function", name: "node_repl", parameters: { type: "object", properties: {} } }],
      },
    ], [
      { type: "tool_search", execution: "client", description: "search", parameters: { type: "object", properties: {} } },
    ]));

    // The discovered tool must be callable on the NEXT turn, or deferred discovery is a
    // one-way trip and the model can never invoke what it just found.
    expect(toolNames(parsed)).toContain("node_repl");
    const loaded = parsed.context.tools?.find(tool => tool.name === "node_repl");
    expect(loaded?.loadedFromToolSearch).toBe(true);
  });

  it("preserves the search call itself in assistant history, paired with its result", () => {
    // Loading the discovered DEFINITIONS is not enough: if the tool_search_call disappears
    // from history, the next upstream request has an orphaned result and providers reject
    // the turn. Asserts the call survives with its id, and that the paired result carries
    // the same id so the two can be matched.
    const parsed = parseRequest(request([
      { type: "message", role: "user", content: [{ type: "input_text", text: "find it" }] },
      { type: "tool_search_call", id: "ts_1", call_id: "ts_1", execution: "client", arguments: "{\"query\":\"repl\"}", status: "completed" },
      {
        type: "tool_search_output",
        call_id: "ts_1",
        status: "completed",
        execution: "client",
        tools: [{ type: "function", name: "node_repl", parameters: { type: "object", properties: {} } }],
      },
    ], [
      { type: "tool_search", execution: "client", description: "search", parameters: { type: "object", properties: {} } },
    ]));

    const messages = parsed.context.messages;
    const assistant = messages.find(message => message.role === "assistant");
    const call = Array.isArray(assistant?.content)
      ? assistant.content.find(part => (part as { type?: string }).type === "toolCall") as { id?: string; name?: string } | undefined
      : undefined;
    expect(call?.name).toBe("tool_search");
    expect(call?.id).toBe("ts_1");

    const result = messages.find(message => message.role === "toolResult") as { toolCallId?: string; toolName?: string } | undefined;
    expect(result?.toolCallId).toBe("ts_1");
    expect(result?.toolName).toBe("tool_search");
  });

  it("flattens a namespaced tool discovered through tool_search", () => {
    const parsed = parseRequest(request([
      {
        type: "tool_search_output",
        call_id: "ts_2",
        status: "completed",
        execution: "client",
        tools: [{
          type: "namespace",
          name: "browser",
          tools: [{ type: "function", name: "open", parameters: { type: "object", properties: {} } }],
        }],
      },
    ], [
      { type: "tool_search", execution: "client", description: "search", parameters: { type: "object", properties: {} } },
    ]));
    expect(toolNames(parsed)).toContain("open");
    expect(parsed.context.tools?.find(tool => tool.name === "open")?.namespace).toBe("browser");
  });
});

describe("streaming and non-streaming tool parity", () => {
  const nsMap = new Map([["ns__child", { namespace: "ns", name: "child" }]]);
  const freeform = new Set(["apply_patch"]);
  const toolSearch = new Set(["tool_search"]);

  const cases: Array<{ label: string; events: AdapterEvent[] }> = [
    {
      label: "function call",
      events: [
        { type: "tool_call_start", id: "call_fn", name: "read_file" },
        { type: "tool_call_delta", arguments: "{\"path\"" },
        { type: "tool_call_delta", arguments: ":\"a.txt\"}" },
        { type: "tool_call_end" },
        { type: "done" },
      ],
    },
    {
      label: "custom/freeform call with split escapes and non-ASCII",
      events: [
        { type: "tool_call_start", id: "call_custom", name: "apply_patch" },
        { type: "tool_call_delta", arguments: "{\"input\":\"안녕 \\" },
        { type: "tool_call_delta", arguments: "\"quoted\\\" 世界\"}" },
        { type: "tool_call_end" },
        { type: "done" },
      ],
    },
    {
      label: "namespaced call",
      events: [
        { type: "tool_call_start", id: "call_ns", name: "ns__child" },
        { type: "tool_call_delta", arguments: "{}" },
        { type: "tool_call_end" },
        { type: "done" },
      ],
    },
    {
      label: "tool_search call",
      events: [
        { type: "tool_call_start", id: "call_ts", name: "tool_search" },
        { type: "tool_call_delta", arguments: "{\"query\":\"repl\"}" },
        { type: "tool_call_end" },
        { type: "done" },
      ],
    },
    {
      label: "text before a call",
      events: [
        { type: "text_delta", text: "working" },
        { type: "tool_call_start", id: "call_after_text", name: "read_file" },
        { type: "tool_call_delta", arguments: "{}" },
        { type: "tool_call_end" },
        { type: "done" },
      ],
    },
  ];

  for (const { label, events } of cases) {
    it(`agrees across snapshot, incremental frames and JSON for a ${label}`, async () => {
      const view = await streamedView(events, MODEL, nsMap, freeform, toolSearch);
      const json = jsonToolItems(events, MODEL, { toolNsMap: nsMap, freeformToolNames: freeform, toolSearchToolNames: toolSearch });

      // Three surfaces, not two. `response.completed` is what a reconnecting client sees;
      // `output_item.done` is what a client consuming normal incremental frames sees. The
      // bridge builds them separately, so comparing only the snapshot hides an item that is
      // correct at the end and wrong on the wire (devlog 034).
      expect(view.incremental).toEqual(view.snapshot);
      expect(view.snapshot).toEqual(json);
    });
  }

  it("preserves assistant text alongside the call on both transports", async () => {
    // The tool-item filter hides non-call output, so without this the "text before a call"
    // fixture would be just another function-call parity case.
    const textCase = cases.find(entry => entry.label.startsWith("text"))!;
    const view = await streamedView(textCase.events, MODEL, nsMap, freeform, toolSearch);
    const jsonTypes = jsonItemTypes(textCase.events, MODEL, { toolNsMap: nsMap, freeformToolNames: freeform, toolSearchToolNames: toolSearch });
    expect(view.snapshotItemTypes).toContain("message");
    expect(jsonTypes).toContain("message");
    expect(view.snapshotItemTypes).toEqual(jsonTypes);
  });

  it("restores namespace identity identically on both transports", async () => {
    // NormalizedToolItem carries `namespace`, so dropping namespace restoration from either
    // bridge fails here. An earlier revision omitted the field and could not see it at all.
    const nsCase = cases.find(entry => entry.label.startsWith("namespaced"))!;
    const view = await streamedView(nsCase.events, MODEL, nsMap, freeform, toolSearch);
    const json = jsonToolItems(nsCase.events, MODEL, { toolNsMap: nsMap, freeformToolNames: freeform, toolSearchToolNames: toolSearch });

    // ABSOLUTE assertions first. Equality alone is satisfied by EQUAL DEGRADATION: deleting
    // namespace restoration from BOTH bridges keeps the two sides identical, so a pure
    // comparison test would stay green while the identity was lost on the wire.
    for (const item of [view.snapshot[0], view.incremental[0], json[0]]) {
      expect(item?.name).toBe("child");
      expect(item?.namespace).toBe("ns");
    }
    expect(view.incremental).toEqual(view.snapshot);
    expect(view.snapshot).toEqual(json);
  });

  it("carries the tool_search payload rather than an empty object", async () => {
    // tool_search arguments may be an object rather than a string; the normalizer keeps the
    // value verbatim so replacing it with {} on both paths cannot pass silently.
    const tsCase = cases.find(entry => entry.label.startsWith("tool_search"))!;
    const view = await streamedView(tsCase.events, MODEL, nsMap, freeform, toolSearch);
    const json = jsonToolItems(tsCase.events, MODEL, { toolNsMap: nsMap, freeformToolNames: freeform, toolSearchToolNames: toolSearch });
    expect(JSON.stringify(view.snapshot[0]?.payload)).toContain("repl");
    expect(view.snapshot).toEqual(json);
  });

  it("restores each kind as its own item type rather than collapsing to function_call", async () => {
    const kinds = await Promise.all(cases.map(async ({ events }) => {
      const view = await streamedView(events, MODEL, nsMap, freeform, toolSearch);
      return view.snapshot[0]?.type;
    }));
    expect(kinds).toEqual([
      "function_call",
      "custom_tool_call",
      "function_call",
      "tool_search_call",
      "function_call",
    ]);
  });

  it("keeps namespaced custom and function tools distinct when their logical names collide", async () => {
    const collidingNsMap = new Map<string, { namespace: string; name: string; freeform?: true }>([
      ["functions__exec", { namespace: "functions", name: "exec", freeform: true }],
      ["mcp__remote__exec", { namespace: "mcp__remote", name: "exec" }],
    ]);
    const events: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_custom", name: "functions__exec" },
      { type: "tool_call_delta", arguments: '{"input":"pwd"}' },
      { type: "tool_call_end" },
      { type: "tool_call_start", id: "call_function", name: "mcp__remote__exec" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "done" },
    ];

    const view = await streamedView(events, MODEL, collidingNsMap, new Set(["exec"]));
    const json = jsonToolItems(events, MODEL, {
      toolNsMap: collidingNsMap,
      freeformToolNames: new Set(["exec"]),
    });

    expect(view.incremental).toEqual(view.snapshot);
    expect(view.snapshot).toEqual(json);
    expect(view.snapshot.map(item => item.type)).toEqual(["custom_tool_call", "function_call"]);
    expect(view.snapshot[1]).toMatchObject({ name: "exec", namespace: "mcp__remote" });
  });

  it("emits the exact custom input fragments on the streamed path only", async () => {
    const custom = cases.find(entry => entry.label.startsWith("custom"))!;
    const view = await streamedView(custom.events, MODEL, nsMap, freeform, toolSearch);
    expect(view.eventNames).toContain("response.custom_tool_call_input.delta");
    expect(view.eventNames).not.toContain("response.function_call_arguments.delta");
    // Exact ordered fragments, not just the event name: a corrupted, duplicated or reordered
    // delta stream would otherwise pass.
    expect(view.deltas.join("")).toBe(String(view.snapshot[0]?.payload ?? ""));
    // Exactly one terminal item event for the one call.
    expect(view.eventNames.filter(name => name === "response.output_item.done")).toHaveLength(1);
  });
});

describe("parallel tool-call capability", () => {
  it("CURRENT LIMITATION: interleaved calls cannot be represented by AdapterEvent", async () => {
    // `tool_call_start` carries an id, but `tool_call_delta` and `tool_call_end` do not
    // (src/types.ts:323). Both bridges therefore track ONE current call, so a provider that
    // interleaves two calls has no way to say which fragment belongs to which.
    //
    // A genuine A/B/A/B interleaving: call A is fragmented, B starts mid-flight, then A's
    // continuation arrives. This pins the consequence rather than pretending it works —
    // A's later fragment is misattributed to B, because fragments are routed by ARRIVAL
    // ORDER, not by call id. Giving delta/end a call id should make this fail.
    const interleaved: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_a", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"a" },
      { type: "tool_call_start", id: "call_b", name: "write_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"b" },
      { type: "tool_call_delta", arguments: ".txt\"}" },
      { type: "tool_call_end" },
      { type: "done" },
    ];

    const view = await streamedView(interleaved, MODEL);
    const json = jsonToolItems(interleaved, MODEL);
    // Both transports agree with each other AND with the incremental frames, which is what
    // makes this a contract limitation rather than a transport bug.
    expect(view.incremental).toEqual(view.snapshot);
    expect(view.snapshot).toEqual(json);

    expect(view.snapshot.map(item => item.call_id)).toEqual(["call_a", "call_b"]);
    expect(view.snapshot.map(item => item.name)).toEqual(["read_file", "write_file"]);
    // A keeps only what arrived before B started; B absorbs A's continuation. Neither
    // payload is the JSON its provider actually sent.
    expect(view.snapshot[0]?.payload).toBe("{\"path\":\"a");
    expect(view.snapshot[1]?.payload).toBe("{\"path\":\"b.txt\"}");
  });
});
