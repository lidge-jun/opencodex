import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { describe, expect, test } from "bun:test";
import {
  collectFunctionCallRepairSchemas,
  repairFunctionCalls,
  repairFunctionCallsInJson,
} from "../../src/responses/function-call-compat";
import { createResponsesFunctionToolRepairBlockRewrite } from "../../src/server/responses-function-tool-repair";
import { createTranslatorBudget, TranslatorBudgetExceededError } from "../../src/lib/translator-budget";
import { sseDataPayload } from "../../src/server/sse-payload-rewrite";
import { currentTurnWireToolCatalogBody } from "../../src/server/responses-undeclared-tool-guard";

const parameters = { type: "object", properties: {
  cell_id: { type: "string" }, yield_time_ms: { type: "integer" },
  union: { type: ["number", "string"] },
} };
const wait = { type: "function", name: "wait", parameters };
const schemas = collectFunctionCallRepairSchemas({ tools: [wait, { type: "function", name: "get_state" }] });
const raw = '{"cell_id":4,"yield_time_ms":120000.0}';
const canonical = '{"cell_id":"4","yield_time_ms":120000}';

function item(argumentsText: unknown = raw, overrides: Record<string, unknown> = {}) {
  return { type: "function_call", id: "fc_one", call_id: "call_one", name: "wait", arguments: argumentsText, status: "completed", ...overrides };
}
function frame(type: string, fields: Record<string, unknown>) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}`;
}
function payload(block: string): Record<string, unknown> {
  return JSON.parse(sseDataPayload(block)!) as Record<string, unknown>;
}
function repairedItem(argumentsText: unknown, overrides: Record<string, unknown> = {}) {
  return repairFunctionCalls(item(argumentsText, overrides), schemas).value;
}

describe("original function declaration authority", () => {
  const groups = [
    { type: "namespace", name: "left", tools: [wait] },
    { type: "namespace", name: "right", tools: [{ ...wait, parameters: { type: "object", properties: { cell_id: { type: "number" } } } }] },
    { type: "custom", name: "exec", description: "JavaScript" },
    { type: "web_search" },
  ];

  test("preserves schema references and distinct same-inner-name identities", () => {
    const map = collectFunctionCallRepairSchemas({ tools: groups });
    expect([...map.keys()]).toEqual(["left__wait", "right__wait"]);
    expect(map.get("left__wait")?.parameters).toBe(parameters);
    expect(repairFunctionCalls(item('{"cell_id":4}', { namespace: "left" }), map).value)
      .toMatchObject({ arguments: '{"cell_id":"4"}' });
    expect(repairFunctionCalls(item('{"cell_id":4}', { namespace: "right" }), map).changed).toBe(false);
    expect(repairFunctionCalls(item(raw), map).changed).toBe(false);
    expect(repairFunctionCalls(item(raw, { name: "left__wait", namespace: "right" }), map).changed).toBe(false);
    expect(repairFunctionCalls(item(raw, { name: "left__wait", namespace: "functions" }), map).changed).toBe(false);
  });

  test.each([
    [{ type: "function", namespace: "left", name: "wait" }, ["left__wait"]],
    [{ type: "function", name: "left__wait" }, ["left__wait"]],
    [{ type: "function", name: "left.wait" }, ["left__wait"]],
    [{ type: "function", name: "wait" }, []],
    [{ type: "custom", namespace: "left", name: "wait" }, []],
    [{ type: "function", namespace: "right", name: "left__wait" }, []],
    [{ type: "function", namespace: "", name: "left__wait" }, []],
    [{ type: "function", namespace: null, name: "left__wait" }, []],
    [{ type: "file_search", name: "left__wait" }, []],
    ["none", []],
    [null, []],
    [{ type: "allowed_tools", tools: [{ type: "function", namespace: "right", name: "wait" }, { type: "custom", name: "left__wait" }] }, ["right__wait"]],
  ])("honors exact selector %j", (tool_choice, keys) => {
    expect([...collectFunctionCallRepairSchemas({ tools: groups, tool_choice }).keys()]).toEqual(keys);
  });

  test("reserved functions remain bare and support explicit namespace selectors", () => {
    const map = collectFunctionCallRepairSchemas({
      tools: [{ type: "namespace", name: "functions", tools: [wait] }],
      tool_choice: { type: "function", namespace: "functions", name: "wait" },
    });
    expect(map.get("wait")).toMatchObject({ name: "wait", parameters });
    expect(map.get("wait")).not.toHaveProperty("namespace");
    expect(repairFunctionCalls(item(raw, { namespace: "functions" }), map).value).toMatchObject({ arguments: canonical });
  });

  test("reads supplied current-turn groups, not declarations nested in replay messages or metadata", () => {
    const map = collectFunctionCallRepairSchemas({
      input: [{ type: "additional_tools", tools: [wait] }, { type: "message", tools: [{ type: "function", name: "old" }] }],
      metadata: { tools: [{ type: "function", name: "shadow" }] },
    });
    expect([...map.keys()]).toEqual(["wait"]);
    expect(collectFunctionCallRepairSchemas({ input: [{ type: "message", tools: [wait] }] }).size).toBe(0);
  });

  test("conflicting same-wire schemas cannot win by declaration order", () => {
    const other = { ...wait, parameters: { type: "object", properties: { cell_id: { type: "number" } } } };
    for (const tools of [[wait, other], [other, wait], [wait, { type: "custom", name: "wait" }]]) {
      expect(collectFunctionCallRepairSchemas({ tools }).size).toBe(0);
    }
  });

  test("loaded tool_search_output functions retain their original schemas", () => {
    const body = { input: [{ type: "tool_search_output", tools: [wait, { type: "custom", name: "exec" }] }] };
    const before = JSON.stringify(body);
    const map = collectFunctionCallRepairSchemas(body);
    expect([...map.keys()]).toEqual(["wait"]);
    expect(map.get("wait")?.parameters).toBe(parameters);
    expect(repairFunctionCalls(item(), map).value).toEqual(item(canonical));
    expect(JSON.stringify(body)).toBe(before);
  });

  test.each([
    [{ type: "function", name: "left.wait" }, ["left__wait"]],
    [{ type: "function", namespace: "right", name: "wait" }, ["right__wait"]],
    [{ type: "function", name: "wait" }, []],
    [{ type: "custom", name: "left.wait" }, []],
    [{ type: "function", namespace: "right", name: "left__wait" }, []],
    [{ type: "allowed_tools", tools: [{ type: "function", name: "right.wait" }] }, ["right__wait"]],
    ["none", []],
  ])("loaded namespace declarations honor selector %j", (tool_choice, keys) => {
    const body = { tool_choice, input: [{ type: "tool_search_output", tools: groups }] };
    expect([...collectFunctionCallRepairSchemas(body).keys()]).toEqual(keys);
  });

  test("replay-trimmed loaded definitions cannot grant historical schema authority", () => {
    const historical = { ...wait, parameters: { type: "object", properties: { cell_id: { type: "number" } } } };
    const body = { input: [
      { type: "tool_search_output", tools: [historical, { type: "function", name: "old_only" }] },
      { type: "message", role: "user", content: [] },
      { type: "tool_search_output", tools: [wait] },
    ] };
    const map = collectFunctionCallRepairSchemas(currentTurnWireToolCatalogBody(body, 2));
    expect([...map.keys()]).toEqual(["wait"]);
    expect(map.get("wait")?.parameters).toBe(parameters);
    expect(repairFunctionCalls(item(), map).value).toEqual(item(canonical));
    expect(collectFunctionCallRepairSchemas(currentTurnWireToolCatalogBody(body, 3)).size).toBe(0);
  });

  test("loaded and explicit conflicting declarations remain fail-closed in either order", () => {
    const conflict = { ...wait, parameters: { type: "object", properties: { cell_id: { type: "number" } } } };
    for (const [explicit, loaded] of [[wait, conflict], [conflict, wait]]) {
      expect(collectFunctionCallRepairSchemas({ tools: [explicit], input: [{ type: "tool_search_output", tools: [loaded] }] }).size).toBe(0);
    }
  });

  test("namespace wait does not inherit bare wait number-field exceptions", () => {
    const numberWait = { ...wait, parameters: { type: "object", properties: { yield_time_ms: { type: "number" } } } };
    const map = collectFunctionCallRepairSchemas({ tools: [numberWait, { type: "namespace", name: "remote", tools: [numberWait] }] });
    expect(repairFunctionCalls(item('{"yield_time_ms":1000.0}'), map).value).toMatchObject({ arguments: '{"yield_time_ms":1000}' });
    expect(repairFunctionCalls(item('{"yield_time_ms":1000.0}', { namespace: "remote" }), map).changed).toBe(false);
  });
});

describe("pure function completion repair", () => {
  test("repairs integer/string arguments and explicit completed empty arguments", () => {
    expect(repairedItem(raw)).toEqual(item(canonical));
    expect(repairedItem("", { name: "get_state" })).toEqual(item("{}", { name: "get_state" }));
    const missing = { type: "function_call", name: "get_state", status: "completed" };
    expect(repairFunctionCalls(missing, schemas).value).toBe(missing);
  });

  test.each([" ", "{", '{"cell_id":4.5}', '{"yield_time_ms":1.5}', '{"union":4.0}',
    '{"cell_id":9007199254740993}', '{"cell_id":4,"unknown":9007199254740993}', '{"cell_id":4,"unknown":1e400}'])
  ("preserves invalid/disagreeing/unsafe payload %s", argumentsText => {
    const value = item(argumentsText);
    expect(repairFunctionCalls(value, schemas)).toEqual({ value, changed: false });
  });

  test("preserves custom/helper/unknown calls, previews and failed/incomplete snapshots", () => {
    for (const overrides of [{ type: "custom_tool_call", input: raw }, { name: "exec_command" }, { name: "exec" },
      { status: "in_progress" }, { status: "incomplete" }, { namespace: "missing" }]) {
      const value = item(raw, overrides);
      expect(repairFunctionCalls(value, schemas).value).toBe(value);
    }
    for (const status of ["failed", "incomplete", "in_progress"]) {
      const value = { status, output: [item()] };
      expect(repairFunctionCalls(value, schemas).value).toBe(value);
    }
    const added = { type: "response.output_item.added", item: item("") };
    expect(repairFunctionCalls(added, schemas).value).toBe(added);
  });

  test("repairs JSON/item/terminal completions without visiting metadata or adding status", () => {
    const shadow = item();
    const value = { status: "completed", output: [item()], metadata: { shadow } };
    const json = repairFunctionCallsInJson(JSON.stringify(value), schemas);
    expect(JSON.parse(json)).toEqual({ ...value, output: [item(canonical)] });
    expect(repairFunctionCallsInJson(json, schemas)).toBe(json);
    expect(repairFunctionCallsInJson("not JSON", schemas)).toBe("not JSON");
    const noStatus = { ...item("", { name: "get_state" }), status: undefined };
    expect(repairFunctionCalls({ type: "response.output_item.done", item: noStatus }, schemas).value)
      .toEqual({ type: "response.output_item.done", item: { ...noStatus, arguments: "{}" } });
    expect(repairFunctionCalls({ type: "response.completed", response: { output: [noStatus] } }, schemas).value)
      .toEqual({ type: "response.completed", response: { output: [{ ...noStatus, arguments: "{}" }] } });
    expect(repairFunctionCalls(value, new Map()).value).toBe(value);
  });
});

describe("native function completion SSE", () => {
  test("keeps previews exact and repairs every authoritative completion without synthetic deltas", () => {
    const budget = createTranslatorBudget();
    const rewrite = createResponsesFunctionToolRepairBlockRewrite(schemas, budget);
    try {
      const added = frame("response.output_item.added", { output_index: 0, item: item("", { status: "in_progress" }) });
      expect(rewrite(added)).toEqual([added]);
      const delta = frame("response.function_call_arguments.delta", { item_id: "fc_one", delta: raw });
      expect(rewrite(delta)).toEqual([delta]);
      const done = rewrite(frame("response.function_call_arguments.done", { item_id: "fc_one", arguments: raw }));
      expect(done).toHaveLength(1);
      expect(payload(done[0]!)).toMatchObject({ type: "response.function_call_arguments.done", arguments: canonical });
      expect(budget.snapshot().currentBytes).toBe(0);
      const itemDone = rewrite(frame("response.output_item.done", { output_index: 0, item: item() }));
      expect(payload(itemDone[0]!).item).toEqual(item(canonical));
      const terminal = rewrite(frame("response.completed", { response: { status: "completed", output: [item()] } }));
      expect(payload(terminal[0]!).response).toEqual({ status: "completed", output: [item(canonical)] });
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { rewrite.dispose?.(); budget.dispose(); }
  });

  test.each(["response.output_item.done", "response.completed"])("no-arg %s works without arguments.done", type => {
    const rewrite = createResponsesFunctionToolRepairBlockRewrite(schemas);
    try {
      const call = item("", { name: "get_state" });
      const fields = type === "response.completed" ? { response: { status: "completed", output: [call] } } : { output_index: 0, item: call };
      const result = rewrite(frame(type, fields));
      expect(result).toHaveLength(1);
      expect(JSON.stringify(payload(result[0]!))).toContain('"arguments":"{}"');
    } finally { rewrite.dispose?.(); }
  });

  test("correlates early id-less completions and interleaved calls without mixing schemas", () => {
    const budget = createTranslatorBudget();
    const rewrite = createResponsesFunctionToolRepairBlockRewrite(schemas, budget);
    try {
      expect(rewrite(frame("response.function_call_arguments.done", { output_index: 1, arguments: "" }))).toEqual([]);
      rewrite(frame("response.output_item.added", { output_index: 0, item: item("", { status: "in_progress" }) }));
      expect(payload(rewrite(frame("response.function_call_arguments.done", { item_id: "fc_one", arguments: raw }))[0]!))
        .toMatchObject({ arguments: canonical });
      const output = rewrite(frame("response.output_item.added", { output_index: 1, item: item("", { name: "get_state", id: "fc_two", status: "in_progress" }) }));
      expect(output.map(block => payload(block).type)).toEqual(["response.output_item.added", "response.function_call_arguments.done"]);
      expect(payload(output[1]!)).toMatchObject({ arguments: "{}", output_index: 1, item_id: "fc_two" });
      expect(budget.snapshot().currentBytes).toBe(0);
      rewrite.dispose?.();
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { rewrite.dispose?.(); budget.dispose(); }
  });

  test.each([raw, canonical])("index-only completion gets downstream identity even when arguments stay unchanged: %s", argumentsText => {
    const rewrite = createResponsesFunctionToolRepairBlockRewrite(schemas);
    try {
      expect(rewrite(frame("response.function_call_arguments.done", { output_index: 0, arguments: argumentsText }))).toEqual([]);
      const output = rewrite(frame("response.output_item.added", { output_index: 0, item: item("", { status: "in_progress" }) }));
      const calls = new Map<string, string>();
      for (const block of output) {
        const event = payload(block);
        if (event.type === "response.output_item.added") {
          const call = event.item as { id: string; arguments: string };
          calls.set(call.id, call.arguments);
        } else if (event.type === "response.function_call_arguments.done") {
          expect(typeof event.item_id).toBe("string");
          expect(calls.has(event.item_id as string)).toBe(true);
          calls.set(event.item_id as string, event.arguments as string);
        }
      }
      expect([...calls]).toEqual([["fc_one", canonical]]);
    } finally { rewrite.dispose?.(); }
  });

  test("terminal snapshots resolve early completions; authoritative arguments beat previews", () => {
    const rewrite = createResponsesFunctionToolRepairBlockRewrite(schemas);
    try {
      const preview = frame("response.function_call_arguments.delta", { item_id: "fc_one", delta: '{"cell_id":999}' });
      expect(rewrite(preview)).toEqual([preview]);
      expect(rewrite(frame("response.function_call_arguments.done", { item_id: "fc_one", arguments: raw }))).toEqual([]);
      const output = rewrite(frame("response.completed", { response: { output: [item()] } }));
      expect(output).toHaveLength(2);
      expect(payload(output[0]!)).toMatchObject({ arguments: canonical });
      expect(payload(output[1]!).response).toEqual({ output: [item(canonical)] });
    } finally { rewrite.dispose?.(); }
  });

  test.each(["response.failed", "response.incomplete", "response.cancelled"])("%s flushes unknown completions unchanged and frees retention", type => {
    const budget = createTranslatorBudget();
    const rewrite = createResponsesFunctionToolRepairBlockRewrite(schemas, budget);
    try {
      const early = frame("response.function_call_arguments.done", { item_id: "fc_one", arguments: raw });
      expect(rewrite(early)).toEqual([]);
      expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
      const terminal = frame(type, { response: { output: [item()] } });
      expect(rewrite(terminal)).toEqual([early, terminal]);
      expect(budget.snapshot().currentBytes).toBe(0);
      rewrite.dispose?.();
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { rewrite.dispose?.(); budget.dispose(); }
  });

  test("charges identity metadata and early frames, releasing even on overflow or disposal", () => {
    for (const early of [false, true]) {
      const budget = createTranslatorBudget({ maxTurnBytes: 240 });
      const rewrite = createResponsesFunctionToolRepairBlockRewrite(schemas, budget);
      try {
        rewrite(frame("response.output_item.added", { output_index: 0, item: item("", { status: "in_progress" }) }));
        expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
        if (early) {
          expect(() => rewrite(frame("response.function_call_arguments.done", { item_id: "unknown", arguments: "x".repeat(300) })))
            .toThrow(TranslatorBudgetExceededError);
        }
        rewrite.dispose?.();
        expect(budget.snapshot().currentBytes).toBe(0);
      } finally { rewrite.dispose?.(); budget.dispose(); }
    }
  });

  test("empty forward map leaves every frame byte-identical", () => {
    const rewrite = createResponsesFunctionToolRepairBlockRewrite(new Map());
    const block = frame("response.output_item.done", { output_index: 0, item: item() });
    expect(rewrite(block)).toEqual([block]);
  });
});

test("native Responses JSON/SSE and replay share the original function schema repair", async () => {
  const originalFetch = globalThis.fetch;
  const expected = '{"cell_id":"4","yield_time_ms":120000}';
  const output = { type: "function_call", id: "fc_wait", call_id: "call_wait", name: "wait", arguments: '{"cell_id":4,"yield_time_ms":120000.0}', status: "completed" };
  const tools = [{ type: "function", name: "wait", parameters: { type: "object", properties: { cell_id: { type: "string" }, yield_time_ms: { type: "integer" } } } }];
  const config = {
    port: 0, defaultProvider: "fixture",
    providers: { fixture: { adapter: "openai-responses", baseUrl: "https://function-parity.invalid/v1", authMode: "key", apiKey: "fixture-key" } },
  } as OcxConfig;
  let activeId = "";
  let captured: { input?: Array<Record<string, unknown>> } | undefined;
  const sse = (type: string, payload: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://function-parity.invalid/")) throw new Error("unexpected parity fixture destination");
    const body = JSON.parse(String(init?.body));
    captured = body;
    const response = { id: activeId, status: "completed", output: [output] };
    return body.stream ? new Response([
      sse("response.output_item.added", { output_index: 0, item: { ...output, arguments: "", status: "in_progress" } }),
      sse("response.function_call_arguments.delta", { output_index: 0, item_id: output.id, delta: output.arguments }),
      sse("response.function_call_arguments.done", { output_index: 0, item_id: output.id, arguments: output.arguments }),
      sse("response.output_item.done", { output_index: 0, item: output }),
      sse("response.completed", { response }), "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } }) : Response.json(response);
  }) as typeof fetch;
  try {
    for (const stream of [false, true]) {
      activeId = `resp_fn_${crypto.randomUUID()}`;
      const request = (extra: object = {}) => new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture/grok-probe", stream, input: [{ role: "user", content: "synthetic" }], tools, ...extra }),
      });
      const response = await handleResponses(request(), config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      const raw = await response.text();
      if (stream) {
        const events = raw.split("\n").filter(line => line.startsWith("data:") && !line.includes("[DONE]")).map(line => JSON.parse(line.slice(5)));
        expect(events.find(event => event.type === "response.function_call_arguments.done")?.arguments).toBe(expected);
        expect(events.find(event => event.type === "response.output_item.done")?.item.arguments).toBe(expected);
        expect(events.find(event => event.type === "response.completed")?.response.output[0].arguments).toBe(expected);
      } else expect(JSON.parse(raw).output[0].arguments).toBe(expected);
      const previous = activeId;
      activeId = `resp_fn_followup_${crypto.randomUUID()}`;
      const followup = await handleResponses(request({ previous_response_id: previous, input: [{ type: "function_call_output", call_id: "call_wait", output: "done" }] }), config, { model: "", provider: "" });
      await followup.text();
      expect(captured?.input?.find(item => item.type === "function_call" && item.call_id === "call_wait")?.arguments).toBe(expected);
    }
  } finally { globalThis.fetch = originalFetch; }
});
