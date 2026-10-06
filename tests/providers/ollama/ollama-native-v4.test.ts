import { describe, expect, spyOn, test } from "bun:test";
import { createOllamaNativeAdapter } from "../../../src/adapters/ollama-native";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";
import { REASONING_EFFORT_OMIT_SENTINEL } from "../../../src/reasoning-effort";
import type { AdapterEvent } from "../../../src/types";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { TranslatorBudgetExceededError } from "../../../src/lib/translator-budget";
import { jsonStringPartsUtf8Bytes } from "../../../src/lib/json-byte-size";

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "ollama-native",
    baseUrl: "https://ollama.com/v1",
    authMode: "key",
    apiKey: "test-key-not-a-real-credential",
    liveModels: false,
    models: ["glm-5.3-flash"],
    ...overrides,
  } as OcxProviderConfig;
}

function parsedWith(options: Record<string, unknown> = {}, modelId = "glm-5.3-flash"): OcxParsedRequest {
  return { modelId, stream: true, options, context: { messages: [{ role: "user", content: "hi" }] } } as unknown as OcxParsedRequest;
}

/**
 * V4 corrections: EOF accounting parity and boundary-first omit semantics.
 */

describe("ollama-native — EOF vs newline accounting parity", () => {
  /** One buffered terminal record: `textSize` content + one tool call with `argSize` of arguments. */
  function record(textSize: number, argSize: number): Record<string, unknown> {
    return {
      model: "m",
      message: {
        role: "assistant",
        content: "r".repeat(textSize),
        tool_calls: [{
          index: 0, type: "function", id: "c0",
          function: { name: "ns_x__f", arguments: { blob: "a".repeat(argSize) } },
        }],
      },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 1,
      eval_count: 1,
    };
  }

  async function run(rec: unknown, eof: boolean) {
    const adapter = createOllamaNativeAdapter(provider());
    const budget = createTestTranslatorBudget();
    const text = JSON.stringify(rec) + (eof ? "" : "\n");
    const response = new Response(new TextEncoder().encode(text), {
      headers: { "content-type": "application/x-ndjson" },
    });
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(response, budget)) events.push(event);
    return { events, snapshot: budget.snapshot() };
  }

  test("small terminal record: identical events and identical outcome for both terminators", async () => {
    const rec = record(4 * 1024 * 1024, 1024 * 1024);
    const nl = await run(rec, false);
    const eof = await run(rec, true);
    expect(eof.events.map(e => e.type)).toEqual(nl.events.map(e => e.type));
    expect(nl.events.some(e => e.type === "tool_call_start")).toBe(true);
    expect(eof.events.at(-1)?.type).toBe("done");
    expect(eof.snapshot.highWaterBytes).toBe(nl.snapshot.highWaterBytes);
  });

  test("non-vacuous near-limit record: aggregate (record + parsed tool args) exceeds the 32 MiB turn cap, while the record itself and each tool argument stay under their individual limits — same budget outcome for both terminators", async () => {
    // Margins: content 30 MiB + args 1.5 MiB => line ≈ 31.5 MiB (< 32 MiB record/line ceiling;
    // args 1.5 MiB < the 2 MiB per-call tool-argument limit). While the record is retained, the
    // parsed tool-argument copy pushes the aggregate translator charge past 32 MiB, so BOTH
    // terminators must fail with translation_buffer_limit. If the EOF residual were released
    // before tool translation, the args alone (1.5 MiB) would fit and the EOF case would emit
    // the tool call — the asymmetry that proves the record stays charged until translated.
    const rec = record(30 * 1024 * 1024, 1.5 * 1024 * 1024);
    const nl = await run(rec, false);
    const eof = await run(rec, true);
    for (const label of ["newline", "eof"]) {
      const events = label === "newline" ? nl.events : eof.events;
      expect(events, label).toHaveLength(1);
      expect(events[0], label).toMatchObject({ type: "error", code: "translation_buffer_limit" });
    }
    expect(nl.snapshot.highWaterBytes).toBe(eof.snapshot.highWaterBytes);
  });
});

describe("ollama-native — exact late-attribution JSON-string budget", () => {
  const cap = 256 * 1024;
  const caption = (name: string, id: string, error = false, namespace?: string) =>
    `[ocx] additional output for previously issued tool "${namespace ? `${namespace}__${name}` : name}" (${id}):\n${error ? "ERROR: " : ""}`;
  const bytes = (value: string) => Buffer.byteLength(JSON.stringify(value));
  const history = (name: string, id: string, count = 1, error = false, namespace?: string) => {
    const result = { role: "toolResult", toolCallId: id, toolName: name, toolNamespace: namespace,
      content: "first", isError: false, timestamp: 1 };
    return [
      { role: "assistant", content: [{ type: "toolCall", id, name, namespace, arguments: {} }], timestamp: 0 },
      result, { role: "assistant", content: [{ type: "text", text: "settled" }], timestamp: 2 },
      ...Array.from({ length: count }, () => ({ ...result, content: "tail", isError: error })),
    ];
  };
  const request = (messages: unknown[]) => ({ ...parsedWith(), context: { messages } }) as OcxParsedRequest;
  const padded = (seed: string, id: string, target = cap, error = false, namespace?: string) =>
    seed + "x".repeat(target - bytes(caption(seed, id, error, namespace)));

  for (const [label, seed, error, namespace] of [
    ["ASCII", "exec", false, undefined],
    ["JSON escapes", '\u0000"\\\t\n', false, undefined],
    ["multibyte", "é한😀", false, undefined],
    ["lone high surrogate", "\ud800", false, undefined],
    ["lone low surrogate", "\udc00", false, undefined],
    ["surrogate pair", "\ud83d\ude00", false, undefined],
    ["namespace and error marker", "exec", true, "한\ud800"],
  ] as const) {
    test(`admits exactly 256 KiB of joined attribution: ${label}`, () => {
      const name = padded(seed, "call", cap, error, namespace);
      const expected = caption(name, "call", error, namespace);
      expect(bytes(expected)).toBe(cap);
      const built = createOllamaNativeAdapter(provider()).buildRequest(request(history(name, "call", 1, error, namespace)));
      expect(JSON.parse(built.body).messages.at(-1).content).toBe(expected + "tail");
    });
    test(`rejects one JSON byte over 256 KiB: ${label}`, () => {
      const name = padded(seed, "call", cap + 1, error, namespace);
      expect(bytes(caption(name, "call", error, namespace))).toBe(cap + 1);
      expect(() => createOllamaNativeAdapter(provider()).buildRequest(request(history(name, "call", 1, error, namespace))))
        .toThrow(TranslatorBudgetExceededError);
    });
  }

  test("the exact budget accumulates across repeated output and different settled calls", () => {
    const first = padded("first", "one", cap / 4);
    const second = padded("second", "two", cap / 4);
    expect(3 * bytes(caption(first, "one")) + bytes(caption(second, "two"))).toBe(cap);
    const adapter = createOllamaNativeAdapter(provider());
    const messages = [...history(first, "one", 3), ...history(second, "two")];
    const built = JSON.parse(adapter.buildRequest(request(messages)).body).messages;
    expect(built.filter((message: { role: string }) => message.role === "user")).toHaveLength(4);
    expect(built.at(-1).content).toBe(caption(second, "two") + "tail");
    expect(3 * bytes(caption(first, "one")) + bytes(caption(second + "x", "two"))).toBe(cap + 1);
    expect(() => adapter.buildRequest(request([...history(first, "one", 3), ...history(second + "x", "two")])))
      .toThrow(TranslatorBudgetExceededError);
    expect(JSON.parse(adapter.buildRequest(request(messages)).body).messages).toEqual(built);
  });

  test("32 complete 8192-byte captions fill the budget; one byte or another caption is refused", () => {
    const name = padded("exec", "one", cap / 32);
    const expected = caption(name, "one");
    expect(bytes(expected)).toBe(8192);
    const adapter = createOllamaNativeAdapter(provider());
    const built = JSON.parse(adapter.buildRequest(request(history(name, "one", 32))).body).messages;
    expect(built.filter((message: { role: string }) => message.role === "user")
      .map((message: { content: string }) => message.content)).toEqual(Array(32).fill(expected + "tail"));
    expect(() => adapter.buildRequest(request(history(name, "one", 33)))).toThrow(TranslatorBudgetExceededError);
    const second = padded("exec", "two", cap / 32) + "x";
    expect(31 * bytes(expected) + bytes(caption(second, "two"))).toBe(cap + 1);
    expect(() => adapter.buildRequest(request([...history(name, "one", 31), ...history(second, "two")])))
      .toThrow(TranslatorBudgetExceededError);
  });
});

describe("JSON string-parts byte accounting", () => {
  for (const [label, parts] of [
    ["no parts", []], ["empty parts", ["", ""]], ["ASCII", ["a", "b"]],
    ["escaped controls", ['"\\\u0000', "\b\t\n\f\r"]],
    ["multibyte", ["é한", "😀\u2028\u2029"]],
    ["pair split across parts", ["\ud83d", "\ude00"]],
    ["pair across empty parts", ["\ud83d", "", "", "\ude00"]],
    ["unpaired at end", ["a", "\ud800"]],
    ["unpaired before ASCII", ["\ud800", "", "a"]],
    ["high-high-low boundary", ["\ud800", "\ud800", "\udc00"]],
    ["low-high boundary", ["\udc00", "\ud800"]],
  ] as const) {
    test(`matches the serialized joined string and its inclusive limit: ${label}`, () => {
      const exact = Buffer.byteLength(JSON.stringify(parts.join("")));
      expect(jsonStringPartsUtf8Bytes(parts, exact)).toBe(exact);
      expect(() => jsonStringPartsUtf8Bytes(parts, exact - 1)).toThrow(TranslatorBudgetExceededError);
    });
  }
  test("measurement never joins parts and stops before reading an oversized tail", () => {
    const parts = ["x".repeat(1024)];
    const join = spyOn(parts, "join");
    try {
      expect(jsonStringPartsUtf8Bytes(parts, 1026)).toBe(1026);
      expect(join).not.toHaveBeenCalled();
      Object.defineProperty(parts, 1, { get() { throw new Error("unreachable tail"); } });
      expect(() => jsonStringPartsUtf8Bytes(parts, 16)).toThrow(TranslatorBudgetExceededError);
      expect(join).not.toHaveBeenCalled();
    } finally { join.mockRestore(); }
  });
});

describe("ollama-native — omit sentinel under the ultra boundary", () => {
  test("ultra→__omit__ with max→high must CLAMP, not omit (boundary-first)", async () => {
    const adapter = createOllamaNativeAdapter({
      ...provider(),
      models: ["glm-5.3-flash"],
      modelReasoningEfforts: { "glm-5.3-flash": ["low", "medium", "high"] },
      modelReasoningEffortMap: {
        "glm-5.3-flash": { ultra: REASONING_EFFORT_OMIT_SENTINEL, max: "high" },
      },
    } as never);
    const { body } = await adapter.buildRequest(parsedWith({ reasoning: "ultra" }));
    expect(JSON.parse(String(body)).think).toBe("high");
  });

  test("max→__omit__ is honoured (inverse control)", async () => {
    const adapter = createOllamaNativeAdapter({
      ...provider(),
      modelReasoningEffortMap: { "glm-5.3-flash": { max: REASONING_EFFORT_OMIT_SENTINEL } },
    } as never);
    const { body } = await adapter.buildRequest(parsedWith({ reasoning: "max" }));
    expect(JSON.parse(String(body))).not.toHaveProperty("think");
  });

  test("none→__omit__ omits: the explicit mapping outranks the native none=>false fallback", async () => {
    const adapter = createOllamaNativeAdapter({
      ...provider(),
      modelReasoningEffortMap: { "glm-5.3-flash": { none: REASONING_EFFORT_OMIT_SENTINEL } },
    } as never);
    const { body } = await adapter.buildRequest(parsedWith({ reasoning: "none" }));
    expect(JSON.parse(String(body))).not.toHaveProperty("think");
  });

  test("none without an omit mapping still serializes think:false", async () => {
    const adapter = createOllamaNativeAdapter(provider());
    const { body } = await adapter.buildRequest(parsedWith({ reasoning: "none" }));
    expect(JSON.parse(String(body)).think).toBe(false);
  });
});
