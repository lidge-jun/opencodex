import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ChatCompletionsStreamError,
  collectChatCompletion,
  responsesJsonToChatCompletion,
  responsesSseToChatCompletionsSse,
} from "../../src/chat/outbound";
import { jsonCompletionSse, nativeChatSse } from "../../src/server/chat-native-sse";
import type { OcxConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";

type Rec = Record<string, unknown>;
type Frame = {
  error?: { code: string; type: string; message: string };
  choices?: Array<{ delta?: Rec; finish_reason?: string | null }>;
};
const encoder = new TextEncoder();
const model = "refusal-fixture/model";
const event = (type: string, fields: Rec = {}): Rec => ({ type, ...fields });
const part = (refusal: unknown): Rec => ({ type: "refusal", refusal });
const message = (content: unknown[], id?: unknown): Rec => ({
  type: "message", role: "assistant", content, ...(id === undefined ? {} : { id }),
});
const terminal = (output?: unknown[], reason?: string): Rec => event(
  reason ? "response.incomplete" : "response.completed",
  { response: {
    status: reason ? "incomplete" : "completed",
    ...(output ? { output } : {}),
    ...(reason ? { incomplete_details: { reason } } : {}),
  } },
);
const refusalDelta = (delta: unknown, output_index = 0, content_index = 0, ids: Rec = {}): Rec =>
  event("response.refusal.delta", { output_index, content_index, delta, ...ids });
const refusalDone = (refusal: unknown, output_index = 0, content_index = 0, ids: Rec = {}): Rec =>
  event("response.refusal.done", { output_index, content_index, refusal, ...ids });
function wireEvent(value: Rec): string {
  return `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
}
function bytesSource(chunks: string[], onCancel = () => {}, close = true): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream({
    pull(controller) {
      if (next < chunks.length) controller.enqueue(encoder.encode(chunks[next++]!));
      else if (close) controller.close();
    },
    cancel: onCancel,
  }, { highWaterMark: 0 });
}
function translated(events: Rec[], budget = createTestTranslatorBudget(), onCancel = () => {}, close = true) {
  return responsesSseToChatCompletionsSse(bytesSource(events.map(wireEvent), onCancel, close), model, {
    translatorBudget: budget,
  });
}
function frames(wire: string): Frame[] {
  return wire.split("\n\n").filter(block => block.startsWith("data: ") && block !== "data: [DONE]")
    .map(block => JSON.parse(block.slice(6)) as Frame);
}
function refusalText(wire: string): string {
  return frames(wire).map(frame => frame.choices?.[0]?.delta?.refusal ?? "").join("");
}
function firstChoice(completion: Rec) {
  return (completion.choices as Array<{ message: Rec; finish_reason: string }>)[0]!;
}
function expectSuccess(wire: string, refusal: string, reason = "stop") {
  expect(refusalText(wire)).toBe(refusal);
  expect(frames(wire).filter(frame => frame.error)).toHaveLength(0);
  expect(frames(wire).filter(frame => frame.choices?.[0]?.finish_reason)).toEqual([
    expect.objectContaining({ choices: [{ index: 0, delta: {}, finish_reason: reason }] }),
  ]);
  expect(wire.match(/data: \[DONE\]/g)).toHaveLength(1);
}
function expectFailure(wire: string, code: string) {
  expect(frames(wire).filter(frame => frame.error)).toEqual([
    { error: expect.objectContaining({ type: "upstream_error", code }) },
  ]);
  expect(frames(wire).some(frame => frame.choices?.[0]?.finish_reason)).toBe(false);
  expect(wire).not.toContain("data: [DONE]");
}

// Independent oracle: OpenAI SDK ChatCompletionMessage.refusal: string | null,
// Choice.Delta.refusal?: string | null; Responses refusal.delta.delta and
// refusal.done.refusal, keyed by raw output_index/content_index. All text is inert.
describe("Chat refusal projection", () => {
  test("JSON keeps ordered refusal separate from answer, reasoning and tools", () => {
    const completion = responsesJsonToChatCompletion({ output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "reason" }] },
      message([{ type: "output_text", text: "answer" }, part("fixture A"), part(" + B")]),
      { type: "function_call", call_id: "call_fixture", name: "fixture", arguments: "{}" },
      message([part(" + C")]),
    ] }, model);
    expect(firstChoice(completion)).toMatchObject({
      message: { content: "answer", refusal: "fixture A + B + C", reasoning_content: "reason",
        tool_calls: [{ id: "call_fixture", function: { name: "fixture", arguments: "{}" } }] },
      finish_reason: "tool_calls",
    });
    expect(firstChoice(responsesJsonToChatCompletion({ output: [] }, model)).message.refusal).toBeNull();
    expect(firstChoice(responsesJsonToChatCompletion({ output: [message([part("")])] }, model)).message.refusal).toBe("");
    expect(() => responsesJsonToChatCompletion({ output: [message([part(null)])] }, model))
      .toThrow(ChatCompletionsStreamError);
  });

  test("split deltas and all repeated final representations contribute each suffix once", async () => {
    const wire = await new Response(translated([
      event("response.output_item.added", { output_index: 2, item: message([], "item_fixture") }),
      refusalDelta("fixture ", 2, 1, { item_id: "item_fixture" }),
      refusalDelta("A", 2, 1),
      refusalDone("fixture A", 2, 1),
      event("response.content_part.done", { output_index: 2, content_index: 1, part: part("fixture AB") }),
      event("response.output_item.done", { output_index: 2,
        item: message([{ type: "output_text", text: "" }, part("fixture AB")], "item_fixture") }),
      terminal([{}, { type: "reasoning" }, message([{}, part("fixture ABC")], "item_fixture")]),
    ])).text();
    expectSuccess(wire, "fixture ABC");
    expect(frames(wire).filter(frame => frame.choices?.[0]?.delta?.refusal !== undefined)).toHaveLength(1);
  });

  for (const representation of ["done", "part", "item", "terminal"] as const) {
    test(`${representation}-only refusal survives without deltas`, async () => {
      const item = message([part("fixture")]);
      const events = representation === "done" ? [refusalDone("fixture")]
        : representation === "part" ? [event("response.content_part.done", { output_index: 0, content_index: 0, part: part("fixture") })]
        : representation === "item" ? [event("response.output_item.done", { output_index: 0, item })] : [];
      events.push(terminal(representation === "terminal" ? [item] : undefined));
      expectSuccess(await new Response(translated(events)).text(), "fixture");
    });
  }

  test("interleaved parts emit in raw output/content order and leave text live", async () => {
    const wire = await new Response(translated([
      refusalDelta("C", 3, 0), refusalDelta("B", 1, 2), refusalDelta("A", 1, 0),
      event("response.output_text.delta", { delta: "answer" }),
      refusalDelta("2", 1, 2), refusalDelta("1", 1, 0),
      terminal([{}, message([part("A1"), { type: "output_text", text: "answer" }, part("B2")]), {}, message([part("C")])]),
    ])).text();
    expectSuccess(wire, "A1B2C");
    const deltas = frames(wire).flatMap(frame => frame.choices?.map(choice => choice.delta) ?? []);
    expect(deltas.filter(delta => delta?.refusal !== undefined).map(delta => delta?.refusal)).toEqual(["A1", "B2", "C"]);
    expect(deltas.filter(delta => delta?.content).map(delta => delta?.content)).toEqual(["answer"]);
    expect(deltas.findIndex(delta => delta?.content === "answer")).toBeLessThan(deltas.findIndex(delta => delta?.refusal === "A1"));
  });

  test("missing, empty and stale-prefix snapshots preserve text and split Unicode", async () => {
    const wire = await new Response(translated([
      refusalDelta("fixture \ud83d"), refusalDelta("\ude00"),
      event("response.refusal.done", { output_index: 0, content_index: 0 }),
      refusalDone(""), refusalDone("fixture"),
      event("response.content_part.done", { output_index: 0, content_index: 0, part: { type: "refusal" } }),
      event("response.output_item.done", { output_index: 0, item: message([]) }),
      terminal([message([part("fixture ")])]),
    ])).text();
    expectSuccess(wire, "fixture 😀");
  });

  for (const reason of ["max_output_tokens", "content_filter"]) {
    test(`valid incomplete ${reason} flushes refusal with truthful live finish`, async () => {
      expectSuccess(await new Response(translated([
        refusalDelta("fixture"), terminal([message([part("fixture suffix")])], reason),
      ])).text(), "fixture suffix", reason === "max_output_tokens" ? "length" : "content_filter");
    });
  }

  const invalidEvents: Array<[string, Rec]> = [
    ["contradictory done", refusalDone("other")],
    ["nonstring delta", refusalDelta(42)],
    ["nonstring done", refusalDone(null)],
    ["nonstring content part", event("response.content_part.done", { output_index: 0, content_index: 0, part: part([]) })],
    ["contradictory item", event("response.output_item.done", { output_index: 0, item: message([part("other")]) })],
    ["contradictory terminal", terminal([message([part("other")])])],
    ["nonstring terminal", terminal([message([part({})])])],
    ["delta ID mismatch", refusalDelta("suffix", 0, 0, { item_id: "other" })],
    ["nonstring event ID", refusalDone("fixture", 0, 0, { item_id: null })],
    ["snapshot ID mismatch", terminal([message([part("fixture")], "other")])],
    ["nonstring snapshot ID", terminal([message([part("fixture")], 5)])],
    ["sparse snapshot ID mismatch", terminal([{ id: "other" }])],
    ["sparse nonstring snapshot ID", terminal([{ id: null }])],
    ["same ID at another position", terminal([{}, {}, message([part("fixture")], "item_fixture")])],
    ["different part type", terminal([message([{ type: "output_text", text: "fixture" }])])],
    ["negative position", refusalDelta("fixture", -1)],
    ["fractional position", refusalDelta("fixture", 0, 0.5)],
  ];
  for (const [label, invalid] of invalidEvents) {
    test(`${label} fails without refusal or success terminal and cancels upstream`, async () => {
      let cancelled = 0;
      const wire = await new Response(translated([
        refusalDelta("fixture", 0, 0, { item_id: "item_fixture" }), invalid, terminal(),
      ], createTestTranslatorBudget(), () => { cancelled++; }, false)).text();
      expectFailure(wire, "invalid_refusal");
      expect(refusalText(wire)).toBe("");
      expect(cancelled).toBe(1);
    });
  }

  test("failure and unknown incomplete terminals discard buffered refusal", async () => {
    for (const end of [terminal(undefined, "adapter_eof"), event("response.failed", {
      response: { error: { message: "fixture failure" } },
    })]) {
      const wire = await new Response(translated([refusalDelta("fixture"), end])).text();
      expect(refusalText(wire)).toBe("");
      expect(frames(wire).filter(frame => frame.error)).toHaveLength(1);
      expect(wire).not.toContain("data: [DONE]");
      expect(frames(wire).some(frame => frame.choices?.[0]?.finish_reason)).toBe(false);
    }
  });

  test("one item's optional ID constrains all of its content parts", async () => {
    const wire = await new Response(translated([
      refusalDelta("A", 0, 0, { item_id: "first" }),
      refusalDelta("B", 0, 1, { item_id: "second" }), terminal(),
    ])).text();
    expectFailure(wire, "invalid_refusal");
  });

  test("refusal text overflow is bounded and cancels the source", async () => {
    let cancelled = 0;
    const budget = createTestTranslatorBudget({ maxTurnBytes: 4096 });
    const wire = await new Response(translated([
      ...Array.from({ length: 50 }, () => refusalDelta("x".repeat(100))), terminal(),
    ], budget, () => { cancelled++; }, false)).text();
    expectFailure(wire, "translation_buffer_limit");
    expect(budget.snapshot().highWaterBytes).toBeLessThanOrEqual(4096);
    expect(cancelled).toBe(1);
  });

  test("zero-length parts consume metadata budget", async () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 2048 });
    let cancelled = 0;
    const wire = await new Response(translated([
      ...Array.from({ length: 100 }, (_, index) => refusalDone("", 0, index)), terminal(),
    ], budget, () => { cancelled++; }, false)).text();
    expectFailure(wire, "translation_buffer_limit");
    expect(budget.snapshot().overflows).toBe(1);
    expect(cancelled).toBe(1);
  });

  test("small turn budget rejects the whole final batch, including pending role", async () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 900 });
    let cancelled = 0;
    const wire = await new Response(translated([refusalDone("fixture"), terminal()], budget,
      () => { cancelled++; }, false)).text();
    expectFailure(wire, "translation_buffer_limit");
    expect(frames(wire).filter(frame => frame.choices)).toHaveLength(0);
    expect(cancelled).toBe(1);
  });

  test("a reservation failure at DONE cannot leak pending tool/refusal/finish frames", async () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 4096 });
    const reserve = budget.reserveTransient.bind(budget);
    let rejectedDone = false;
    budget.reserveTransient = (bytes, scope) => {
      if (bytes === encoder.encode("data: [DONE]\n\n").byteLength) {
        rejectedDone = true;
        // Exhaust the real configured budget at this precise admission boundary.
        return reserve(4097, scope);
      }
      return reserve(bytes, scope);
    };
    let cancelled = 0;
    const wire = await new Response(translated([
      event("response.output_item.added", { output_index: 0,
        item: { type: "function_call", id: "tool_fixture", call_id: "call_fixture", name: "f", arguments: "{}" } }),
      refusalDone("fixture", 1), terminal(),
    ], budget, () => { cancelled++; }, false)).text();
    expect(rejectedDone).toBe(true);
    expectFailure(wire, "translation_buffer_limit");
    expect(frames(wire).flatMap(frame => frame.choices ?? []).every(choice =>
      !choice.delta?.tool_calls && choice.delta?.refusal === undefined)).toBe(true);
    expect(budget.snapshot().activeCalls).toBe(0);
    expect(cancelled).toBe(1);
  });

  test("successful terminal flush preserves pending tools and releases charged metadata", async () => {
    const budget = createTestTranslatorBudget();
    const charge = budget.chargeRetained.bind(budget);
    const release = budget.releaseRetained.bind(budget);
    let metadataCharged = 0;
    let metadataReleased = 0;
    budget.chargeRetained = (bytes, scope) => {
      charge(bytes, scope);
      if (scope.kind === "item_ids") metadataCharged += bytes;
    };
    budget.releaseRetained = (bytes, scope) => {
      release(bytes, scope);
      if (scope.kind === "item_ids") metadataReleased += bytes;
    };
    const wire = await new Response(translated([
      event("response.output_item.added", { output_index: 0,
        item: { type: "function_call", id: "tool_fixture", call_id: "call_fixture", name: "fixture" } }),
      event("response.function_call_arguments.delta", { item_id: "tool_fixture", delta: "{}" }),
      refusalDelta("fixture", 2, 0, { item_id: "message_fixture" }), terminal(),
    ], budget)).text();
    expectSuccess(wire, "fixture", "tool_calls");
    expect(frames(wire).flatMap(frame => frame.choices?.[0]?.delta?.tool_calls ?? [])).toEqual([
      { index: 0, id: "call_fixture", type: "function", function: { name: "fixture", arguments: "{}" } },
    ]);
    expect(metadataCharged).toBeGreaterThan(0);
    expect(metadataReleased).toBe(metadataCharged);
  });

  test("cancellation releases buffered refusal text and map metadata", async () => {
    const budget = createTestTranslatorBudget();
    let cancelled = 0;
    const reader = translated([
      refusalDelta("fixture"), event("response.heartbeat"),
    ], budget, () => { cancelled++; }, false).getReader();
    await reader.read(); // Heartbeat role proves the preceding refusal was retained.
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
    await reader.cancel();
    reader.releaseLock();
    expect(cancelled).toBe(1);
    expect(budget.snapshot().currentBytes).toBe(0);
  });
});

describe("Chat refusal collection and native serialization", () => {
  test("collector preserves nullable refusal and native JSON-to-SSE round trip", async () => {
    const completion = responsesJsonToChatCompletion({ output: [message([part("fixture")])] }, model);
    const wire = jsonCompletionSse(completion, model);
    expectSuccess(wire, "fixture");
    const collected = await collectChatCompletion(bytesSource([wire]), model, createTestTranslatorBudget());
    expect(firstChoice(collected).message).toMatchObject({ content: null, refusal: "fixture" });
    const empty = await collectChatCompletion(bytesSource([jsonCompletionSse({ choices: [{ message: { content: "answer", refusal: null } }] }, model)]), model, createTestTranslatorBudget());
    expect(firstChoice(empty).message).toMatchObject({ content: "answer", refusal: null });
  });

  test("absent-only refusal evidence stays null while explicit empty refusal stays empty", async () => {
    for (const evidence of [{ type: "refusal" }, part("")]) {
      const budget = createTestTranslatorBudget();
      const completion = await collectChatCompletion(translated([terminal([message([evidence])])], budget), model, budget);
      expect(firstChoice(completion).message.refusal).toBe(Object.hasOwn(evidence, "refusal") ? "" : null);
    }
  });

  test("translated SSE collection uses the same ordered refusal contract", async () => {
    const budget = createTestTranslatorBudget();
    const completion = await collectChatCompletion(translated([
      refusalDelta("B", 1), refusalDelta("A", 0), terminal(),
    ], budget), model, budget);
    expect(firstChoice(completion).message).toMatchObject({ content: null, refusal: "AB" });
  });

  test("native SSE relay leaves refusal deltas intact", async () => {
    const budget = createTestTranslatorBudget();
    const wire = [
      'data: {"choices":[{"index":0,"delta":{"content":"answer","refusal":"fixture"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const relayed = nativeChatSse(bytesSource([wire]), {
      requestedModel: model, translatorBudget: budget, signal: new AbortController().signal, onUsage() {},
    });
    expectSuccess(await new Response(relayed).text(), "fixture");
  });

  test("collector processing overflow cancels its reader and never returns partial JSON", async () => {
    let cancelled = 0;
    const budget = createTestTranslatorBudget({ maxTurnBytes: 1024 });
    const reserve = budget.reserveTransient.bind(budget);
    let failedKind = "";
    budget.reserveTransient = (bytes, scope) => {
      try { return reserve(bytes, scope); } catch (error) { failedKind = scope.kind; throw error; }
    };
    const chunk = `data: ${JSON.stringify({ choices: [{ delta: { refusal: "x".repeat(100) } }] })}\n\n`;
    await expect(collectChatCompletion(bytesSource(Array(20).fill(chunk), () => { cancelled++; }, false), model, budget))
      .rejects.toMatchObject({ status: 502, type: "upstream_error", code: "translation_buffer_limit" });
    expect(failedKind).toBe("retained_collectors");
    expect(cancelled).toBe(1);
  });

  test("collector error cancellation reaches an upstream translator", async () => {
    const translatorBudget = createTestTranslatorBudget();
    const collectorBudget = createTestTranslatorBudget({ maxTurnBytes: 100 });
    let cancelled = 0;
    const stream = translated([refusalDelta("fixture"), event("response.heartbeat")], translatorBudget,
      () => { cancelled++; }, false);
    await expect(collectChatCompletion(stream, model, collectorBudget))
      .rejects.toMatchObject({ code: "translation_buffer_limit" });
    expect(cancelled).toBe(1);
    expect(translatorBudget.snapshot().currentBytes).toBe(0);
  });

  test("malformed native refusal and typed error frames cancel without partial JSON", async () => {
    for (const payload of [
      { choices: [{ delta: { refusal: 17 } }] },
      { error: { message: "fixture error", type: "upstream_error", code: "fixture_error" } },
    ]) {
      let cancelled = 0;
      await expect(collectChatCompletion(bytesSource([`data: ${JSON.stringify(payload)}\n\n`], () => { cancelled++; }, false),
        model, createTestTranslatorBudget())).rejects.toBeInstanceOf(ChatCompletionsStreamError);
      expect(cancelled).toBe(1);
    }
  });
});

// Handler coverage uses only an external fetch stub, never a mocked converter/handler.
// It also exercises #3770's shared JSON fallback after the parent commit is applied.
describe("refusal handler delivery matrix", () => {
  const originalFetch = globalThis.fetch;
  let isolatedHome: IsolatedCodexHome | undefined;
  let previousOcxHome: string | undefined;
  beforeEach(() => {
    previousOcxHome = process.env.OPENCODEX_HOME;
    isolatedHome = installIsolatedCodexHome("ocx-refusal-fixture-");
    process.env.OPENCODEX_HOME = isolatedHome.path;
    globalThis.fetch = (async () => { throw new Error("unstubbed external transport"); }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetProviderRequestPacingForTest();
    if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOcxHome;
    isolatedHome?.restore();
  });
  for (const native of [true, false]) {
    for (const upstreamSse of [true, false]) {
      for (const clientSse of [true, false]) {
        test(`${native ? "native" : "translated"} upstream ${upstreamSse ? "SSE" : "JSON"} -> client ${clientSse ? "SSE" : "JSON"}`, async () => {
          const { handleChatCompletions } = await import("../../src/server/chat-completions");
          const responseJson = { id: "resp_fixture", status: "completed", output: [message([part("fixture")], "item_fixture")] };
          const chatJson = { id: "chatcmpl_fixture", object: "chat.completion", created: 1, model,
            choices: [{ index: 0, message: { role: "assistant", content: null, refusal: "fixture" }, finish_reason: "stop" }] };
          const seen: string[] = [];
          globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            expect(url.origin).toBe("https://refusal.example.test");
            seen.push(url.pathname);
            if (!upstreamSse) return Response.json(native ? chatJson : responseJson);
            const wire = native ? [
              'data: {"choices":[{"index":0,"delta":{"refusal":"fixture"},"finish_reason":null}]}\n\n',
              'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
              "data: [DONE]\n\n",
            ].join("") : [refusalDelta("fixture", 0, 0, { item_id: "item_fixture" }), terminal(responseJson.output)].map(wireEvent).join("");
            return new Response(wire, { headers: { "content-type": "text/event-stream" } });
          }) as typeof fetch;
          const config = {
            port: 0, defaultProvider: "refusal-fixture", providers: {
              "refusal-fixture": { adapter: native ? "openai-chat" : "openai-responses",
                baseUrl: "https://refusal.example.test/v1", apiKey: "fixture-key", authMode: "key" },
            },
          } as OcxConfig;
          const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ model, stream: clientSse, messages: [{ role: "user", content: "inert fixture" }] }),
          }), config, { model: "", provider: "" });
          expect(response.status).toBe(200);
          if (clientSse) expectSuccess(await response.text(), "fixture");
          else expect(firstChoice(await response.json() as Rec).message).toMatchObject({ content: null, refusal: "fixture" });
          expect(seen).toEqual([native ? "/v1/chat/completions" : "/v1/responses"]);
        });
      }
    }
  }
});

test("sparse terminal preserves a matching refusal ID", async () => {
  const wire = await new Response(translated([
    refusalDelta("fixture", 0, 0, { item_id: "item_fixture" }),
    terminal([{ id: "item_fixture" }]),
  ])).text();
  expectSuccess(wire, "fixture");
});

test("JSON refusal charges joined surrogate bytes and rejects retained overflow", () => {
  const budget = createTestTranslatorBudget({ maxTurnBytes: 16 });
  const completion = responsesJsonToChatCompletion({ output: [message([part("\ud83d"), part("\ude00")])] }, model, budget);
  expect(firstChoice(completion).message.refusal).toBe("😀");
  expect(budget.snapshot().currentBytes).toBe(4);
  const small = createTestTranslatorBudget({ maxTurnBytes: 4 });
  expect(() => responsesJsonToChatCompletion({ output: [message([part("fixture")])] }, model, small)).toThrow();
  expect(small.snapshot().overflows).toBe(1);
  expect(small.snapshot().currentBytes).toBe(0);
});
