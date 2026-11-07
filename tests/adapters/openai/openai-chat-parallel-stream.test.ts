import { describe, expect, spyOn, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../../../src/adapters/openai-chat";
import type { TranslatorBudget } from "../../../src/lib/translator-budget";
import type { AdapterEvent } from "../../../src/types";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../../helpers/translator-budget";

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));

const provider = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key" };

async function collect(body: string, budget?: TranslatorBudget): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of createOpenAIChatAdapter(provider).parseStream(new Response(body), budget)) out.push(e);
  return out;
}

function sse(objs: unknown[], done = true): string {
  const frames = objs.map(o => `data: ${JSON.stringify(o)}\n\n`);
  if (done) frames.push("data: [DONE]\n\n");
  return frames.join("");
}

function chunkOf(toolCalls: unknown[], finish?: string) {
  return { choices: [{ delta: { tool_calls: toolCalls }, ...(finish ? { finish_reason: finish } : {}) }] };
}

interface AssembledCall { id: string; name: string; args: string }

/** Reassemble emitted tool calls and assert the sequential bridge contract (no overlap). */
function assembled(events: AdapterEvent[]): AssembledCall[] {
  const calls: AssembledCall[] = [];
  let open: AssembledCall | null = null;
  for (const e of events) {
    if (e.type === "tool_call_start") {
      expect(open).toBeNull();
      open = { id: e.id, name: e.name, args: "" };
    } else if (e.type === "tool_call_delta") {
      expect(open).not.toBeNull();
      if (open) open.args += e.arguments;
    } else if (e.type === "tool_call_end") {
      expect(open).not.toBeNull();
      if (open) calls.push(open);
      open = null;
    }
  }
  expect(open).toBeNull();
  return calls;
}

describe("openai-chat parallel tool call stream assembly", () => {
  test("24 interleaved OpenAI Chat tool calls complete without reordering", async () => {
    const starts = Array.from({ length: 24 }, (_, index) => chunkOf([{
      index,
      id: `call_${index}`,
      function: { name: `tool_${index}`, arguments: `{"index":` },
    }]));
    const finishes = Array.from({ length: 24 }, (_, reverseIndex) => {
      const index = 23 - reverseIndex;
      return chunkOf([{ index, function: { arguments: `${index}}` } }]);
    });
    const events = await collect(sse([...starts, ...finishes, chunkOf([], "tool_calls")]));
    expect(assembled(events)).toEqual(Array.from({ length: 24 }, (_, index) => ({
      id: `call_${index}`,
      name: `tool_${index}`,
      args: `{"index":${index}}`,
    })));
  });

  test("T1: interleaved index-keyed deltas assemble without cross-contamination", async () => {
    const events = await collect(sse([
      chunkOf([{ index: 0, id: "call_a", function: { name: "shell", arguments: "{\"cmd\"" } }]),
      chunkOf([{ index: 1, id: "call_b", function: { name: "read_file", arguments: "{\"path\"" } }]),
      chunkOf([{ index: 0, function: { arguments: ":\"ls\"}" } }]),
      chunkOf([{ index: 1, function: { arguments: ":\"a.txt\"}" } }]),
      chunkOf([], "tool_calls"),
    ]));
    const calls = assembled(events);
    expect(calls).toEqual([
      { id: "call_a", name: "shell", args: "{\"cmd\":\"ls\"}" },
      { id: "call_b", name: "read_file", args: "{\"path\":\"a.txt\"}" },
    ]);
    for (const c of calls) expect(() => JSON.parse(c.args)).not.toThrow();
    expect(events.at(-1)?.type).toBe("done");
  });

  test("T2: standard sequential calls, id only on first chunk of each", async () => {
    const events = await collect(sse([
      chunkOf([{ index: 0, id: "call_1", function: { name: "a", arguments: "{\"x\":" } }]),
      chunkOf([{ index: 0, function: { arguments: "1}" } }]),
      chunkOf([{ index: 1, id: "call_2", function: { name: "b", arguments: "{\"y\":" } }]),
      chunkOf([{ index: 1, function: { arguments: "2}" } }]),
      chunkOf([], "tool_calls"),
    ]));
    expect(assembled(events)).toEqual([
      { id: "call_1", name: "a", args: "{\"x\":1}" },
      { id: "call_2", name: "b", args: "{\"y\":2}" },
    ]);
  });

  test("T2b: null-padded continuation fields preserve the earlier tool call", async () => {
    const events = await collect(sse([
      chunkOf([{ index: 0, id: "call_null_padding", function: { name: "shell", arguments: "{\"x\":" } }]),
      chunkOf([{ index: 0, id: null, function: { name: null, arguments: "1}" } }]),
      chunkOf([{ index: 0, id: null, function: { name: null, arguments: null } }]),
      chunkOf([], "tool_calls"),
    ]));
    expect(assembled(events)).toEqual([{
      id: "call_null_padding",
      name: "shell",
      args: "{\"x\":1}",
    }]);
  });

  test("T3: whole-chunk multi-call (xAI style) emits both calls", async () => {
    const events = await collect(sse([
      chunkOf([
        { index: 0, id: "c1", function: { name: "f1", arguments: "{\"a\":1}" } },
        { index: 1, id: "c2", function: { name: "f2", arguments: "{\"b\":2}" } },
      ], "tool_calls"),
    ]));
    expect(assembled(events)).toEqual([
      { id: "c1", name: "f1", args: "{\"a\":1}" },
      { id: "c2", name: "f2", args: "{\"b\":2}" },
    ]);
  });

  test("T4: single-call regression - same id/name/args, atomic sequence before done", async () => {
    const events = await collect(sse([
      chunkOf([{ index: 0, id: "call_solo", function: { name: "shell", arguments: "{\"cmd\":" } }]),
      chunkOf([{ index: 0, function: { arguments: "\"pwd\"}" } }]),
      chunkOf([], "tool_calls"),
    ]));
    const calls = assembled(events);
    expect(calls).toEqual([{ id: "call_solo", name: "shell", args: "{\"cmd\":\"pwd\"}" }]);
    const types = events.map(e => e.type);
    const start = types.indexOf("tool_call_start");
    expect(types.slice(start)).toEqual(["tool_call_start", "tool_call_delta", "tool_call_end", "done"]);
  });

  test("T5: continuation chunks with neither index nor id append to the last call", async () => {
    const events = await collect(sse([
      chunkOf([{ id: "only_id", function: { name: "f", arguments: "{\"k\":" } }]),
      chunkOf([{ function: { arguments: "\"v\"}" } }]),
      chunkOf([], "tool_calls"),
    ]));
    expect(assembled(events)).toEqual([{ id: "only_id", name: "f", args: "{\"k\":\"v\"}" }]);
  });

  test("T6: late-arriving name still lands on the assembled call", async () => {
    const events = await collect(sse([
      chunkOf([{ index: 0, id: "late", function: { arguments: "{\"z\":9}" } }]),
      chunkOf([{ index: 0, function: { name: "late_name" } }]),
      chunkOf([], "tool_calls"),
    ]));
    expect(assembled(events)).toEqual([{ id: "late", name: "late_name", args: "{\"z\":9}" }]);
  });

  // Previously this asserted the call was flushed with an empty name, on a "no silent drop"
  // rationale. That invariant still holds and is now stronger: an unnamed call cannot vanish
  // silently, because the turn fails loudly instead. What changed is the mechanism — emitting
  // a call the Codex tool-call contract cannot dispatch was never a usable outcome (#1514).
  test("T7: name never arrives - turn fails closed instead of emitting an undispatchable call", async () => {
    const events = await collect(sse([
      chunkOf([{ index: 0, id: "anon", function: { name: null, arguments: "{\"q\":1}" } }]),
      chunkOf([], "tool_calls"),
    ]));
    expect(assembled(events)).toEqual([]);
    expect(events.some(e => e.type === "tool_call_start")).toBe(false);
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect(last && last.type === "error" ? last.message : "").toContain("without a function name");
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("T8: text deltas interleaved mid-assembly pass through and never split a call", async () => {
    const events = await collect(sse([
      chunkOf([{ index: 0, id: "mix", function: { name: "f", arguments: "{\"a\":" } }]),
      { choices: [{ delta: { content: "thinking out loud" } }] },
      chunkOf([{ index: 0, function: { arguments: "1}" } }]),
      chunkOf([], "tool_calls"),
    ]));
    expect(assembled(events)).toEqual([{ id: "mix", name: "f", args: "{\"a\":1}" }]);
    // text must come BEFORE the atomic tool sequence (buffered assembly)
    const types = events.map(e => e.type);
    expect(types.indexOf("text_delta")).toBeLessThan(types.indexOf("tool_call_start"));
  });

  test("stream cut mid-call after finish-less EOF still fails closed (no fabricated done)", async () => {
    const events = await collect(sse([
      chunkOf([{ index: 0, id: "cut", function: { name: "f", arguments: "{\"a\":" } }]),
    ], false));
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("id synthesized at flush when provider never sends one", async () => {
    const events = await collect(sse([
      chunkOf([{ index: 0, function: { name: "noid", arguments: "{}" } }], "tool_calls"),
    ]));
    const calls = assembled(events);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toMatch(/^call_\d+$/);
  });

  test("T9: index+id first chunk followed by id-only continuation stays ONE call", async () => {
    const events = await collect(sse([
      chunkOf([{ index: 0, id: "call_a", function: { name: "shell", arguments: "{\"cmd\"" } }]),
      chunkOf([{ id: "call_a", function: { arguments: ":\"ls\"}" } }]),
      chunkOf([], "tool_calls"),
    ]));
    expect(assembled(events)).toEqual([{ id: "call_a", name: "shell", args: "{\"cmd\":\"ls\"}" }]);
  });

  test("T9b: id-only call retains a later index for index-only continuation", async () => {
    const budget = createTestTranslatorBudget();
    const events = await collect(sse([
      chunkOf([{ id: "call_b", function: { name: "read", arguments: "{\"p\"" } }]),
      chunkOf([{ index: 0, id: "call_b", function: { arguments: ":\"x\"" } }]),
      chunkOf([{ index: 0, function: { arguments: "}" } }]),
      chunkOf([], "tool_calls"),
    ]), budget);
    expect(assembled(events)).toEqual([{ id: "call_b", name: "read", args: "{\"p\":\"x\"}" }]);
    expect(events.at(-1)?.type).toBe("done");
    expect(budget.snapshot()).toMatchObject({ activeCalls: 0, currentBytes: 0, overflows: 0 });
  });

  test("late indexes keep interleaved calls separate without adding budget owners", async () => {
    const budget = createTestTranslatorBudget();
    const response = new Response(sse([
      chunkOf([
        { id: "call_a", function: { name: "read", arguments: "{\"p\":" } },
        { id: "call_b", function: { name: "write", arguments: "{\"p\":" } },
      ]),
      chunkOf([{ index: 9, id: "call_b", function: { arguments: "\"b\"" } }]),
      chunkOf([{ index: 4, id: "call_a", function: { arguments: "\"a\"" } }]),
      chunkOf([{ index: 9, function: { arguments: "}" } }]),
      chunkOf([{ index: 4, function: { arguments: "}" } }]),
      chunkOf([{ id: "call_a", function: { arguments: " " } }]),
      chunkOf([], "tool_calls"),
    ]));
    const events: AdapterEvent[] = [];
    let maxActiveCalls = 0;
    for await (const event of createOpenAIChatAdapter(provider).parseStream(response, budget)) {
      events.push(event);
      maxActiveCalls = Math.max(maxActiveCalls, budget.snapshot().activeCalls);
    }
    expect(assembled(events)).toEqual([
      { id: "call_a", name: "read", args: "{\"p\":\"a\"} " },
      { id: "call_b", name: "write", args: "{\"p\":\"b\"}" },
    ]);
    expect(events.at(-1)?.type).toBe("done");
    expect(maxActiveCalls).toBe(2);
    expect(budget.snapshot()).toMatchObject({ activeCalls: 0, currentBytes: 0, overflows: 0 });
  });

  test("index-only fragments do not guess an association between unindexed calls", async () => {
    const events = await collect(sse([
      chunkOf([
        { id: "call_a", function: { name: "read", arguments: "{\"p\":" } },
        { id: "call_b", function: { name: "write", arguments: "{\"p\":" } },
      ]),
      chunkOf([{ index: 0, function: { arguments: "\"a\"}" } }]),
      chunkOf([{ index: 1, function: { arguments: "\"b\"}" } }]),
      chunkOf([], "tool_calls"),
    ]));
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  test.each([
    ["negative, no ID", -1, undefined],
    ["negative, matching ID", -1, "call_a"],
    ["fractional, no ID", 0.5, undefined],
    ["fractional, matching ID", 0.5, "call_a"],
    ["numeric string, no ID", "0", undefined],
    ["numeric string, matching ID", "0", "call_a"],
    ["empty string", "", undefined],
    ["true", true, undefined],
    ["false", false, undefined],
    ["object", {}, undefined],
    ["array", [], undefined],
  ] as const)("invalid index (%s) aborts without reassigning pending calls", async (_label, index, id) => {
    const budget = createTestTranslatorBudget();
    const response = new Response(sse([
      chunkOf([
        { id: "call_a", function: { name: "read", arguments: '{"p":"a"}' } },
        { id: "call_b", function: { name: "write", arguments: '{"p":"b"}' } },
      ]),
      chunkOf([{ index: 0, id: "call_a", function: { arguments: "" } }]),
      // Whitespace keeps either complete JSON argument valid if the invalid index is
      // mistakenly ignored and this fragment falls back to its ID or the last call.
      chunkOf([{ index, id, function: { arguments: " " } }]),
      chunkOf([{ index: 0, function: { arguments: " " } }]),
      chunkOf([], "tool_calls"),
    ]));
    const events: AdapterEvent[] = [];
    let sawBothPendingReservations = false;
    for await (const event of createOpenAIChatAdapter(provider).parseStream(response, budget)) {
      events.push(event);
      const snapshot = budget.snapshot();
      // Each ASCII JSON argument is nine bytes; the valid alias heartbeat observes
      // both retained reservations before the malformed continuation arrives.
      sawBothPendingReservations ||= snapshot.activeCalls === 2 && snapshot.currentBytes === 18;
      if (event.type === "error") {
        expect(snapshot).toMatchObject({ activeCalls: 0, currentBytes: 0, overflows: 0 });
      }
    }
    expect(sawBothPendingReservations).toBe(true);
    expect(events.filter(event => event.type === "error")).toEqual([expect.objectContaining({
      type: "error",
      status: 502,
      errorType: "upstream_error",
      message: "upstream response contained invalid tool calls (invalid index)",
    })]);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(event => event.type === "done")).toBe(false);
    expect(events.some(event => event.type === "tool_call_start"
      || event.type === "tool_call_delta" || event.type === "tool_call_end")).toBe(false);
    expect(budget.snapshot()).toMatchObject({ activeCalls: 0, currentBytes: 0, overflows: 0 });
  });

  test.each([
    ["missing", undefined],
    ["null", null],
  ] as const)("%s index placeholders preserve continuation through a later valid alias", async (_label, index) => {
    const budget = createTestTranslatorBudget();
    const events = await collect(sse([
      chunkOf([{ index, id: "call_a", function: { name: "read", arguments: '{"p":' } }]),
      chunkOf([{ index, id: "call_a", function: { arguments: '"x"' } }]),
      chunkOf([{ index: 7, id: "call_a", function: { arguments: "}" } }]),
      chunkOf([{ index, function: { arguments: " " } }]),
      chunkOf([{ index: 7, function: { arguments: " " } }]),
      chunkOf([], "tool_calls"),
    ]), budget);
    expect(assembled(events)).toEqual([{ id: "call_a", name: "read", args: '{"p":"x"}  ' }]);
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
    expect(budget.snapshot()).toMatchObject({ activeCalls: 0, currentBytes: 0, overflows: 0 });
  });

  test("rejects distinct unsafe raw JSON indexes before they collapse into one call", async () => {
    const budget = createTestTranslatorBudget();
    // Keep both index literals on the wire: constructing JS numbers before JSON.stringify
    // would already round 9007199254740993 to 9007199254740992. Without rejection,
    // both whitespace fragments would silently join call_a's valid JSON despite call_b's ID/name.
    const response = new Response(String.raw`data: {"choices":[{"delta":{"tool_calls":[{"id":"call_a","function":{"name":"read","arguments":"{}"}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"id":"call_a","function":{"arguments":""}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":9007199254740992,"id":"call_a","function":{"name":"read","arguments":" "}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":9007199254740993,"id":"call_b","function":{"name":"write","arguments":" "}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[]},"finish_reason":"tool_calls"}]}

data: [DONE]

`);
    const events: AdapterEvent[] = [];
    let sawPendingReservation = false;
    for await (const event of createOpenAIChatAdapter(provider).parseStream(response, budget)) {
      events.push(event);
      const snapshot = budget.snapshot();
      sawPendingReservation ||= snapshot.activeCalls === 1 && snapshot.currentBytes === 2;
      if (event.type === "error") {
        expect(snapshot).toMatchObject({ activeCalls: 0, currentBytes: 0, overflows: 0 });
      }
    }
    expect(sawPendingReservation).toBe(true);
    // The first unsafe index terminates before either unsafe fragment emits a heartbeat,
    // a tool call, or done; the buffered reservation is released at the error itself.
    expect(events.map(event => event.type)).toEqual(["heartbeat", "heartbeat", "error"]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      status: 502,
      errorType: "upstream_error",
      message: "upstream response contained invalid tool calls (invalid index)",
    });
    expect(budget.snapshot()).toMatchObject({ activeCalls: 0, currentBytes: 0, overflows: 0 });
  });

  test("retains a late MAX_SAFE_INTEGER alias for index-only continuation", async () => {
    const budget = createTestTranslatorBudget();
    const events = await collect(sse([
      chunkOf([{ id: "call_boundary", function: { name: "read", arguments: '{"p":' } }]),
      chunkOf([{ index: Number.MAX_SAFE_INTEGER, id: "call_boundary", function: { arguments: '"x"' } }]),
      chunkOf([{ index: Number.MAX_SAFE_INTEGER, function: { arguments: "}" } }]),
      chunkOf([], "tool_calls"),
    ]), budget);
    expect(assembled(events)).toEqual([{ id: "call_boundary", name: "read", args: '{"p":"x"}' }]);
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
    expect(budget.snapshot()).toMatchObject({ activeCalls: 0, currentBytes: 0, overflows: 0 });
  });

  test("an observed index wins over a conflicting ID without rebinding either call", async () => {
    const events = await collect(sse([
      chunkOf([{ id: "call_a", function: { name: "read", arguments: "{\"p\":" } }]),
      chunkOf([{ index: 1, id: "call_b", function: { name: "write", arguments: "{\"p\":" } }]),
      chunkOf([{ index: 0, id: "call_a", function: { arguments: "\"a\"" } }]),
      chunkOf([{ index: 1, id: "call_a", function: { arguments: "\"b\"}" } }]),
      chunkOf([{ index: 0, id: "call_b", function: { arguments: "}" } }]),
      chunkOf([{ index: 0, function: { arguments: " " } }]),
      chunkOf([], "tool_calls"),
    ]));
    expect(assembled(events)).toEqual([
      { id: "call_a", name: "read", args: "{\"p\":\"a\"} " },
      { id: "call_b", name: "write", args: "{\"p\":\"b\"}" },
    ]);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("duplicate IDs on established indexed calls keep first-match ID fallback", async () => {
    const events = await collect(sse([
      chunkOf([
        { index: 0, function: { name: "read", arguments: "{\"p\":" } },
        { index: 1, function: { name: "write", arguments: "{\"p\":" } },
      ]),
      chunkOf([{ index: 0, id: "shared", function: { arguments: "\"a\"" } }]),
      chunkOf([{ index: 1, id: "shared", function: { arguments: "\"b\"" } }]),
      chunkOf([{ id: "shared", function: { arguments: "}" } }]),
      chunkOf([{ index: 1, function: { arguments: "}" } }]),
      chunkOf([], "tool_calls"),
    ]));
    expect(assembled(events)).toEqual([
      { id: "shared", name: "read", args: "{\"p\":\"a\"}" },
      { id: "shared", name: "write", args: "{\"p\":\"b\"}" },
    ]);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("a repeated ID on a different index does not replace the first observed alias", async () => {
    const events = await collect(sse([
      chunkOf([{ id: "call_a", function: { name: "read", arguments: "{\"p\":" } }]),
      chunkOf([{ index: 0, id: "call_a", function: { arguments: "\"a\"" } }]),
      chunkOf([{ index: 1, id: "call_a", function: { arguments: "" } }]),
      chunkOf([{ index: 0, function: { arguments: "}" } }]),
      chunkOf([], "tool_calls"),
    ]));
    expect(assembled(events)).toEqual([{ id: "call_a", name: "read", args: "{\"p\":\"a\"}" }]);
    expect(events.at(-1)?.type).toBe("done");
  });

  test.each([9, 10])("late index preserves a %i-byte argument limit across all fragments", async limit => {
    const budget = createTestTranslatorBudget({ maxCallArgumentBytes: limit });
    const events = await collect(sse([
      chunkOf([{ id: "call_a", function: { name: "read", arguments: "{\"p\":" } }]),
      chunkOf([{ index: 0, id: "call_a", function: { arguments: "\"é\"" } }]),
      chunkOf([{ index: 0, function: { arguments: "}" } }]),
      chunkOf([], "tool_calls"),
    ]), budget);
    if (limit === 9) {
      expect(events.at(-1)).toMatchObject({ type: "error", code: "translation_buffer_limit" });
      expect(events.some(event => event.type === "tool_call_start")).toBe(false);
    } else {
      expect(assembled(events)).toEqual([{ id: "call_a", name: "read", args: "{\"p\":\"é\"}" }]);
      expect(events.at(-1)?.type).toBe("done");
    }
    expect(budget.snapshot()).toMatchObject({ activeCalls: 0, currentBytes: 0, overflows: limit === 9 ? 1 : 0 });
  });
});


describe("negotiated block-stop tool completion", () => {
  const completionHeader = { "x-opencodex-tool-completion": "block-stop-v1" };
  const marker = (index: number, id: string) => ({ index, id, x_opencodex_completed: "block-stop-v1" });
  const call = (index: number, id: string, args = '{"cmd":"pwd"}') => ({ index, id, function: { name: "shell", arguments: args } });
  const tail = { choices: [{ delta: { content: "Later text" } }] };
  const prepare = (adapter: ReturnType<typeof createOpenAIChatAdapter>) => adapter.buildRequest({ modelId: "fixture", stream: true, options: {},
    context: { messages: [{ role: "user", content: "fixture", timestamp: 0 }], tools: [] } }, { completedToolBlocks: true });

  async function events(frames: unknown[], optIn = true, acknowledged = true) {
    const adapter = createOpenAIChatAdapter({ ...provider, ...(optIn ? { headers: completionHeader } : {}) });
    prepare(adapter);
    const out: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(new Response(sse(frames), { headers: acknowledged ? completionHeader : {} }), undefined, undefined, { completedToolBlocks: true })) out.push(event);
    return out;
  }
  test("a completed structured call reaches the client before later text, exactly once", async () => {
    const out = await events([chunkOf([call(0, "call_a")]), chunkOf([marker(0, "call_a")]), tail, chunkOf([], "tool_calls")]);
    expect(out.findIndex(e => e.type === "tool_call_end")).toBeLessThan(out.findIndex(e => e.type === "text_delta"));
    expect(assembled(out)).toEqual([{ id: "call_a", name: "shell", args: '{"cmd":"pwd"}' }]);
  });
  test("both configuration opt-in and relay acknowledgment are required", async () => {
    for (const [optIn, ack] of [[false, true], [true, false]]) {
      const out = await events([chunkOf([call(0, "call_a")]), chunkOf([marker(0, "call_a")]), tail, chunkOf([], "tool_calls")], optIn, ack);
      expect(out.findIndex(e => e.type === "text_delta")).toBeLessThan(out.findIndex(e => e.type === "tool_call_start"));
    }
  });
  test("out-of-order completion waits for the original pending-call prefix", async () => {
    const out = await events([chunkOf([call(0, "call_a"), call(1, "call_b")]), chunkOf([marker(1, "call_b")]), tail, chunkOf([marker(0, "call_a")]), chunkOf([], "tool_calls")]);
    expect(assembled(out).map(c => c.id)).toEqual(["call_a", "call_b"]);
    expect(out.findIndex(e => e.type === "text_delta")).toBeLessThan(out.findIndex(e => e.type === "tool_call_start"));
  });
  test("later fragments for a completed call terminate rather than executing it again", async () => {
    const out = await events([chunkOf([call(0, "call_a")]), chunkOf([marker(0, "call_a")]), chunkOf([{ index: 0, function: { arguments: " " } }]), chunkOf([], "tool_calls")]);
    expect(assembled(out)).toHaveLength(1);
    expect(out.at(-1)?.type).toBe("error");
  });
  test("an invalid completion sequence still reports the usage already captured", async () => {
    const out = await events([
      chunkOf([call(0, "call_a")]),
      chunkOf([marker(0, "call_a")]),
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
      chunkOf([{ index: 0, function: { arguments: " " } }]),
      chunkOf([], "tool_calls"),
    ]);
    const error = out.at(-1);
    expect(error?.type).toBe("error");
    expect(error?.message).toContain("invalid negotiated tool completion sequence");
    expect(error?.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });
  test("root input calls stay buffered for existing freeform reconciliation", async () => {
    const out = await events([chunkOf([call(0, "call_a", '{"input":"pwd"}')]), chunkOf([marker(0, "call_a")]), tail, chunkOf([], "tool_calls")]);
    expect(out.findIndex(e => e.type === "text_delta")).toBeLessThan(out.findIndex(e => e.type === "tool_call_start"));
  });
  test("consumer cancellation after a completed call releases reservations without success", async () => {
    const budget = createTestTranslatorBudget();
    const adapter = createOpenAIChatAdapter({ ...provider, headers: completionHeader });
    prepare(adapter);
    const response = new Response(sse([chunkOf([call(0, "call_a")]), chunkOf([marker(0, "call_a")]), tail, chunkOf([], "tool_calls")]), { headers: completionHeader });
    const out: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(response, budget, undefined, { completedToolBlocks: true })) {
      out.push(event);
      if (event.type === "tool_call_end") break;
    }
    expect(assembled(out)).toHaveLength(1);
    expect(out.some(e => e.type === "done" || e.type === "error")).toBe(false);
    expect(response.body?.locked).toBe(false);
    expect(budget.snapshot().currentBytes).toBe(0);
    expect(budget.snapshot().activeCalls).toBe(0);
  });
  test("trusted request construction cannot authorize another response parser", async () => {
    const adapter = createOpenAIChatAdapter({ ...provider, headers: completionHeader });
    prepare(adapter);
    const body = sse([chunkOf([call(0, "call_a")]), chunkOf([marker(0, "call_a")]), tail, chunkOf([], "tool_calls")]);
    for (const streamContext of [undefined, { completedToolBlocks: false }]) {
      const out: AdapterEvent[] = [];
      for await (const event of adapter.parseStream(new Response(body, { headers: completionHeader }), undefined, undefined, streamContext)) out.push(event);
      expect(out.findIndex(e => e.type === "text_delta")).toBeLessThan(out.findIndex(e => e.type === "tool_call_start"));
    }
  });
  test("a marker cannot claim another index or call ID", async () => {
    for (const bad of [marker(1, "call_a"), marker(0, "call_b"), { ...marker(0, "call_a"), x_opencodex_completed: "future-v2" }]) {
      const out = await events([chunkOf([call(0, "call_a")]), chunkOf([bad]), chunkOf([], "tool_calls")]);
      expect(assembled(out)).toHaveLength(0);
      expect(out.at(-1)?.type).toBe("error");
    }
  });
  test("held serialized text and reasoning retain their place ahead of tools", async () => {
    const held = { choices: [{ delta: { content: '<tool_call name="shell">' } }] };
    const reasoning = { choices: [{ delta: { reasoning_content: "fixture reasoning" } }] };
    const out = await events([held, reasoning, chunkOf([call(0, "call_a")]), chunkOf([marker(0, "call_a")]), tail, chunkOf([], "tool_calls")]);
    const start = out.findIndex(e => e.type === "tool_call_start");
    expect(out.findIndex(e => e.type === "text_delta")).toBeLessThan(start);
    expect(out.findIndex(e => e.type === "reasoning_raw_delta")).toBeLessThan(start);
  });
  test("24 reverse markers preserve pending order with no duplicate terminal calls", async () => {
    const calls = Array.from({ length: 24 }, (_, i) => call(i, `call_${i}`));
    const stops = Array.from({ length: 24 }, (_, i) => chunkOf([marker(23-i, `call_${23-i}`)]));
    const out = await events([chunkOf(calls), ...stops, tail, chunkOf([], "tool_calls")]);
    expect(assembled(out).map(c => c.id)).toEqual(calls.map(c => c.id));
    expect(out.findLastIndex(e => e.type === "tool_call_end")).toBeLessThan(out.findIndex(e => e.type === "text_delta"));
  });
  test("invalid or non-object arguments retain the existing terminal path", async () => {
    for (const args of ['{"cmd":', '[]', 'null', '"pwd"']) {
      const out = await events([chunkOf([call(0, "call_a", args)]), chunkOf([marker(0, "call_a")]), tail, chunkOf([], "tool_calls")]);
      expect(out.findIndex(e => e.type === "text_delta")).toBeLessThan(out.findIndex(e => e.type === "tool_call_start"));
    }
  });
  test("a later upstream error preserves the closed call but never reports success", async () => {
    const out = await events([chunkOf([call(0, "call_a")]), chunkOf([marker(0, "call_a")]), { error: { message: "fixture stream failed", type: "server_error" } }]);
    expect(assembled(out)).toHaveLength(1);
    expect(out.at(-1)?.type).toBe("error");
    expect(out.some(e => e.type === "done")).toBe(false);
  });
});

test("fragmented large SSE lines bound UTF-8 counting work without changing tool arguments", async () => {
  const args = JSON.stringify({ code: "x".repeat(256 * 1024) });
  const wire = new TextEncoder().encode(sse([
    chunkOf([{ index: 0, id: "call_fragmented", function: { name: "review", arguments: args } }]),
    chunkOf([], "tool_calls"),
  ]));
  let cursor = 0;
  const source = new ReadableStream<Uint8Array>({ pull(controller) {
    if (cursor === wire.length) { controller.close(); return; }
    const next = Math.min(cursor + 512, wire.length);
    controller.enqueue(wire.subarray(cursor, next)); cursor = next;
  } });
  let encodedCharacters = 0;
  const original = TextEncoder.prototype.encode;
  const counting = spyOn(TextEncoder.prototype, "encode").mockImplementation(function (this: TextEncoder, input?: string) {
    encodedCharacters += input?.length ?? 0;
    return original.call(this, input);
  });
  try {
    const events: AdapterEvent[] = [];
    for await (const event of createOpenAIChatAdapter(provider).parseStream(new Response(source))) events.push(event);
    expect(assembled(events)).toEqual([{ id: "call_fragmented", name: "review", args }]);
    expect(events.at(-1)?.type).toBe("done");
    // A deterministic work bound, not a wall-clock test. Re-encoding the growing
    // unfinished line for every 512-byte fragment exceeds this by orders of magnitude.
    expect(encodedCharacters).toBeLessThan(wire.length * 8);
  } finally { counting.mockRestore(); }
});


test("fragmented SSE carry preserves Unicode, CRLF and unterminated EOF frames", async () => {
  for (const size of [1, 2, 3, 7, 512]) {
    const args = JSON.stringify({ code: "é🐢汉字\r\n" });
    const wire = new TextEncoder().encode(sse([
      chunkOf([{ index: 0, id: "unicode", function: { name: "review", arguments: args } }]),
      chunkOf([], "tool_calls"),
    ]).replaceAll("\n", "\r\n").trimEnd());
    let cursor = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (cursor >= wire.length) { controller.close(); return; }
      controller.enqueue(wire.subarray(cursor, cursor + size)); cursor += size;
    } });
    const events: AdapterEvent[] = [];
    const budget = createTestTranslatorBudget();
    for await (const event of createOpenAIChatAdapter(provider).parseStream(new Response(stream), budget)) events.push(event);
    expect(assembled(events)).toEqual([{ id: "unicode", name: "review", args }]);
    expect(events.at(-1)?.type).toBe("done");
    expect(budget.snapshot().currentBytes).toBe(0);
  }
});


test("fragmented invalid UTF-8 keeps decoder replacement and carry accounting", async () => {
  const wire = new TextEncoder().encode(sse([
    chunkOf([{ index: 0, id: "replacement", function: { name: "review", arguments: JSON.stringify({ code: "MARK" }) } }]),
    chunkOf([], "tool_calls"),
  ]));
  const at = new TextDecoder().decode(wire).indexOf("MARK");
  wire.set([0xed, 0xa0, 0x80], at); // Invalid UTF-8 surrogate, not three ASCII bytes.
  const expected = JSON.stringify({ code: "���K" });
  for (const size of [1, 2, 7]) {
    let cursor = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (cursor >= wire.length) { controller.close(); return; }
      controller.enqueue(wire.subarray(cursor, cursor + size)); cursor += size;
    } });
    const events: AdapterEvent[] = [];const budget = createTestTranslatorBudget();
    for await (const event of createOpenAIChatAdapter(provider).parseStream(new Response(stream), budget)) events.push(event);
    expect(assembled(events)).toEqual([{ id: "replacement", name: "review", args: expected }]);
    expect(events.at(-1)?.type).toBe("done");expect(budget.snapshot().currentBytes).toBe(0);
  }
});
