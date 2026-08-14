import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { createGoogleAdapter } from "../src/adapters/google";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import {
  TRANSLATOR_MAX_CALL_ARGUMENT_BYTES,
  TRANSLATOR_MAX_TURN_BYTES,
  createTranslatorBudget,
  releaseTranslatedEvent,
  retainTranslatedEvent,
  translatorObservedBufferSnapshot,
} from "../src/lib/translator-budget";
import type { AdapterEvent } from "../src/types";
import { SPAWN_BUDGET_MS } from "./helpers/test-budget";

async function textWithin(stream: ReadableStream<Uint8Array>, timeoutMs = 2_000): Promise<string> {
  return await Promise.race([
    new Response(stream).text(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream did not terminate")), timeoutMs)),
  ]);
}

describe("translator budget", () => {
  test("incremental event retention transfers array-tail ownership during in-order release", () => {
    const budget = createTranslatorBudget({ maxTurnBytes: 4_096 });
    const first = { type: "text_delta", text: "first" };
    const second = { type: "done" };
    try {
      retainTranslatedEvent(first, budget);
      expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength(JSON.stringify([first])));

      retainTranslatedEvent(second, budget, first);
      expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength(JSON.stringify([first, second])));

      releaseTranslatedEvent(first, budget);
      expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength(JSON.stringify([second])));
      releaseTranslatedEvent(second, budget);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      budget.dispose();
    }
  });

  test("incremental event retention rejects an event object that already owns a lease", () => {
    const budget = createTranslatorBudget({ maxTurnBytes: 4_096 });
    const event = { type: "heartbeat" };
    try {
      retainTranslatedEvent(event, budget);
      const retainedBytes = budget.snapshot().currentBytes;
      expect(() => retainTranslatedEvent(event, budget)).toThrow(/already retained/);
      expect(budget.snapshot().currentBytes).toBe(retainedBytes);
      releaseTranslatedEvent(event, budget);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      budget.dispose();
    }
  });

  test("one one-shot tool call admits exactly 2 MiB and rejects one byte over", () => {
    const exact = createTranslatorBudget();
    exact.openCall("call");
    exact.chargeRetained(TRANSLATOR_MAX_CALL_ARGUMENT_BYTES, { kind: "tool_args", callId: "call" });
    expect(exact.snapshot().currentBytes).toBe(TRANSLATOR_MAX_CALL_ARGUMENT_BYTES);
    exact.dispose();
    const over = createTranslatorBudget();
    over.openCall("call");
    expect(() => over.chargeRetained(TRANSLATOR_MAX_CALL_ARGUMENT_BYTES + 1, { kind: "tool_args", callId: "call" })).toThrow(/translator/);
    over.dispose();
  });

  test("a fragmented tool call through the OpenAI adapter admits exactly 2 MiB and rejects one byte over", async () => {
    const adapter = createOpenAIChatAdapter({
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      apiKey: "key",
    });
    const argumentText = `{"value":"${"x".repeat(TRANSLATOR_MAX_CALL_ARGUMENT_BYTES - 12)}"}`;
    expect(Buffer.byteLength(argumentText)).toBe(TRANSLATOR_MAX_CALL_ARGUMENT_BYTES);

    const parse = async (text: string): Promise<AdapterEvent[]> => {
      const split = 1024 * 1024;
      const fragments = [text.slice(0, split), text.slice(split)];
      const frames = fragments.map((argumentsFragment, index) => `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{
          index: 0,
          ...(index === 0 ? { id: "call_1" } : {}),
          function: {
            ...(index === 0 ? { name: "test_tool" } : {}),
            arguments: argumentsFragment,
          },
        }] } }],
      })}\n\n`);
      frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      frames.push("data: [DONE]\n\n");
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      });
      const budget = createTranslatorBudget();
      try {
        const events: AdapterEvent[] = [];
        for await (const event of adapter.parseStream(new Response(body), budget)) events.push(event);
        return events;
      } finally {
        budget.dispose();
      }
    };

    const exact = await parse(argumentText);
    expect(exact.some(event => event.type === "tool_call_end")).toBe(true);
    expect(exact.some(event => event.type === "error")).toBe(false);

    const over = await parse(argumentText + "x");
    expect(over.at(-1)).toMatchObject({ type: "error", code: "translation_buffer_limit" });
  }, 60_000);

  test("OpenAI cumulative arguments reject when the old and replacement strings overlap past the turn cap", async () => {
    const adapter = createOpenAIChatAdapter({
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      apiKey: "key",
    });
    const firstFragment = "x".repeat(512 * 1024);
    const frames = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "test_tool", arguments: firstFragment } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "x" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
    const budget = createTranslatorBudget();
    budget.chargeRetained(31 * 1024 * 1024, { kind: "retained_collectors" });
    const events: AdapterEvent[] = [];
    try {
      for await (const event of adapter.parseStream(new Response(frames), budget)) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: "error", code: "translation_buffer_limit" });
    } finally {
      budget.dispose();
    }
  }, 60_000);

  test("reserveTransient charges full old plus full new overlap before every replacement swap", () => {
    const budget = createTranslatorBudget({ maxTurnBytes: 100 });
    budget.chargeRetained(30, { kind: "reasoning" });
    const reservation = budget.reserveTransient(50, { kind: "reasoning" });
    expect(budget.snapshot()).toMatchObject({ currentBytes: 80, highWaterBytes: 80 });
    reservation.commitRetained();
    budget.releaseRetained(30, { kind: "reasoning" });
    expect(budget.snapshot().currentBytes).toBe(50);
    budget.dispose();
  });

  test("chargeRetained is used only for insertion growth with no replaced allocation", () => {
    const budget = createTranslatorBudget({ maxTurnBytes: 100 });
    budget.chargeRetained(40, { kind: "retained_collectors" });
    expect(budget.snapshot()).toMatchObject({ currentBytes: 40, highWaterBytes: 40 });
    budget.dispose();
  });

  test("standalone aggregate translator bytes admit exactly 32 MiB and fail one byte over", () => {
    const budget = createTranslatorBudget();
    budget.chargeRetained(TRANSLATOR_MAX_TURN_BYTES, { kind: "retained_collectors" });
    expect(budget.snapshot().currentBytes).toBe(TRANSLATOR_MAX_TURN_BYTES);
    expect(() => budget.chargeRetained(1, { kind: "reasoning" })).toThrow(/translator/);
    budget.dispose();
  });

  test("one undisposed turn cannot consume another turn's hard cap", () => {
    const first = createTranslatorBudget();
    const second = createTranslatorBudget();
    try {
      first.chargeRetained(TRANSLATOR_MAX_TURN_BYTES, { kind: "retained_collectors" });
      second.chargeRetained(TRANSLATOR_MAX_TURN_BYTES, { kind: "retained_collectors" });
      expect(second.snapshot().currentBytes).toBe(TRANSLATOR_MAX_TURN_BYTES);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  test("translator observed snapshot maps activeCalls to active and omits internal overflows", () => {
    const baseline = translatorObservedBufferSnapshot().active;
    const budget = createTranslatorBudget();
    budget.openCall("a");
    expect(translatorObservedBufferSnapshot()).toEqual(expect.objectContaining({ active: baseline + 1 }));
    expect(translatorObservedBufferSnapshot()).not.toHaveProperty("overflows");
    budget.dispose();
  });

  test("MCP payload observation raises highWaterBytes without consuming per-call or per-turn hard budget", () => {
    const budget = createTranslatorBudget();
    const release = budget.observeExternallyCapped("mcp_payload", TRANSLATOR_MAX_TURN_BYTES + 1);
    expect(budget.snapshot().currentBytes).toBe(TRANSLATOR_MAX_TURN_BYTES + 1);
    budget.chargeRetained(TRANSLATOR_MAX_TURN_BYTES, { kind: "request_copies" });
    release();
    budget.dispose();
  });

  test("translator overflow terminates with response.failed, no truncated done item, and one upstream cancel", async () => {
    const budget = createTranslatorBudget({ maxTurnBytes: 1_024 });
    let cancels = 0;
    async function* events(): AsyncGenerator<AdapterEvent> {
      yield { type: "tool_call_start", id: "call_1", name: "exec_command" };
      yield { type: "tool_call_delta", arguments: `{"cmd":"${"x".repeat(2_000)}"}` };
      yield { type: "tool_call_end" };
      yield { type: "done" };
    }
    const text = await textWithin(bridgeToResponsesSSE(
      events(),
      "test/model",
      undefined,
      undefined,
      undefined,
      () => { cancels += 1; },
      2_000,
      { translatorBudget: budget },
    ));

    expect(text).toContain("event: response.failed");
    expect(text).toContain('"code":"translation_buffer_limit"');
    expect(text).toContain("data: [DONE]");
    expect(text).not.toContain("response.function_call_arguments.done");
    expect(text).not.toContain("response.output_item.done");
    expect(cancels).toBe(1);
    expect(budget.snapshot().activeCalls).toBe(0);
    budget.dispose();
  });

  test("client cancellation invokes the bridge upstream cancel boundary once", async () => {
    let cancels = 0;
    async function* events(): AsyncGenerator<AdapterEvent> {
      yield { type: "heartbeat" };
      yield { type: "heartbeat" };
    }
    const stream = bridgeToResponsesSSE(
      events(),
      "test/model",
      undefined,
      undefined,
      undefined,
      () => { cancels += 1; },
    );
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel(new DOMException("client closed", "AbortError"));
    await Promise.resolve();
    expect(cancels).toBe(1);
  });

  test("11 MiB non-stream responses transfer parse ownership through buildResponseJSON without overflowing", async () => {
    const content = "x".repeat(11 * 1024 * 1024);
    const cases = [
      {
        adapter: createOpenAIChatAdapter({ adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "key" }),
        payload: { choices: [{ message: { content } }], usage: {} },
      },
      {
        adapter: createAnthropicAdapter({ adapter: "anthropic", baseUrl: "https://example.test", apiKey: "key" }),
        payload: { content: [{ type: "text", text: content }], usage: {}, stop_reason: "end_turn" },
      },
      {
        adapter: createGoogleAdapter({ adapter: "google", baseUrl: "https://example.test", apiKey: "key" }),
        payload: {
          candidates: [{ content: { parts: [{ text: content }] }, finishReason: "STOP" }],
          usageMetadata: {},
        },
      },
    ];

    for (const { adapter, payload } of cases) {
      const budget = createTranslatorBudget();
      const events = await adapter.parseResponse!(new Response(JSON.stringify(payload)), budget);
      expect(events.some(event => event.type === "text_delta" && event.text.length === content.length)).toBe(true);
      const json = buildResponseJSON(events, "test/model", { translatorBudget: budget });
      expect((json.output as Array<{ content?: Array<{ text?: string }> }>)[0]?.content?.[0]?.text?.length).toBe(content.length);
      expect(budget.snapshot().currentBytes).toBeLessThan(TRANSLATOR_MAX_TURN_BYTES);
      budget.dispose();
    }
  }, 60_000);
});

test("production adapter contract rejects omitted translator budgets at typecheck", async () => {
  const base = [
    "x", "tsc", "--noEmit", "--target", "ESNext", "--module", "ESNext",
    "--moduleResolution", "bundler", "--types", "bun-types", "--strict", "--skipLibCheck",
    // TypeScript 7 refuses to run with files on the command line while a
    // tsconfig.json is present (TS5112); the fixture is checked standalone.
    "--ignoreConfig",
  ];
  const invalid = Bun.spawnSync(["bun", ...base, "tests/fixtures/translator-budget-required.invalid.ts"]);
  expect(invalid.exitCode).not.toBe(0);
  expect(invalid.stdout.toString() + invalid.stderr.toString()).toContain("TS2554");
  const valid = Bun.spawnSync(["bun", ...base, "tests/fixtures/translator-budget-required.valid.ts"]);
  expect(valid.exitCode).toBe(0);
}, SPAWN_BUDGET_MS); // two real tsc child processes ARE the assertion; windows runner measured ~5.5s against Bun's 5s default.
