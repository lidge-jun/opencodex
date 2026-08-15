import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import type { AdapterEvent } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));

const provider = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key" };

async function collect(body: string): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of createOpenAIChatAdapter(provider).parseStream(new Response(body))) out.push(e);
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

  test("T9b: id-only first chunk followed by index+id continuation stays ONE call", async () => {
    const events = await collect(sse([
      chunkOf([{ id: "call_b", function: { name: "read", arguments: "{\"p\"" } }]),
      chunkOf([{ index: 0, id: "call_b", function: { arguments: ":\"x\"}" } }]),
      chunkOf([], "tool_calls"),
    ]));
    expect(assembled(events)).toEqual([{ id: "call_b", name: "read", args: "{\"p\":\"x\"}" }]);
  });
});
