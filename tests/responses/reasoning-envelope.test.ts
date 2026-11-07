import { describe, expect, spyOn, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import type { AdapterEvent } from "../../src/types";
import { anthropicToResponsesBody, anthropicToResponsesTranslation } from "../../src/claude/inbound";
import { decodeReasoningEnvelope, encodeReasoningEnvelope, OCX_REASONING_PREFIX, type ReasoningEnvelope } from "../../src/responses/reasoning-envelope";
import { responsesJsonToAnthropicMessage, responsesSseToAnthropicSse } from "../../src/claude/outbound";
import { createTranslatorBudget, TranslatorBudgetExceededError, translatorObservedBufferSnapshot } from "../../src/lib/translator-budget";
import { jsonUtf8Bytes } from "../../src/lib/json-byte-size";
import * as budgets from "../../src/lib/translator-budget";

describe("reasoning and tool/result envelopes", () => {
  test("preserves ordered thinking blocks and genuine signatures", () => {
    const body = anthropicToResponsesBody({
      model: "m", messages: [{ role: "assistant", content: [
        { type: "thinking", thinking: "first", signature: "sig-first" },
        { type: "tool_use", id: "call-1", name: "Read", input: {} },
        { type: "thinking", thinking: "second", signature: "sig-second" },
      ] }],
    }) as any;
    expect(body.input.map((item: any) => item.type)).toEqual(["reasoning", "function_call", "reasoning"]);
    expect(body.input[0].encrypted_content).toBe(encodeReasoningEnvelope({ sig: "sig-first" }));
    expect(body.input[2].encrypted_content).toBe(encodeReasoningEnvelope({ sig: "sig-second" }));
  });

  test("rejects malformed or nested OpenCodex signatures", () => {
    for (const signature of [
      "ocxr1:not-base64!!!",
      encodeReasoningEnvelope({ sig: "nested" }),
      encodeReasoningEnvelope({ sig: "", txt: "nested-empty-signature" }),
    ]) {
      expect(() => anthropicToResponsesBody({
        model: "m", messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "x", signature }] }],
      })).toThrow();
    }
  });

  test("round-trips redacted thinking without exposing it as a genuine signature", () => {
    const encoded = encodeReasoningEnvelope({ sig: "sig", red: ["red-a", "red-b"] });
    const message = responsesJsonToAnthropicMessage({
      output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "visible" }], encrypted_content: encoded }],
    }, "m") as any;
    expect(message.content[2]).toMatchObject({ type: "thinking", signature: "sig" });
    expect(message.content.slice(0, 2)).toEqual([
      { type: "redacted_thinking", data: "red-a" },
      { type: "redacted_thinking", data: "red-b" },
    ]);
  });

  test("owned fallback is bounded and decodable", () => {
    const message = responsesJsonToAnthropicMessage({
      output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "think" }] }],
    }, "m") as any;
    const signature = message.content[0].signature as string;
    expect(signature.startsWith("ocxr1:")).toBe(true);
    expect(decodeReasoningEnvelope(signature)).toEqual({ txt: "think" });
  });

  test("preserves an explicitly empty fallback text", () => {
    expect(decodeReasoningEnvelope(encodeReasoningEnvelope({ txt: "" }))).toEqual({ txt: "" });
  });

  test("inbound preserves redacted-only reasoning when visible text is empty", () => {
    const body = anthropicToResponsesBody({
      model: "m", messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }] }],
    }) as any;
    expect(body.input).toHaveLength(1);
    expect(body.input[0].type).toBe("reasoning");
    expect(decodeReasoningEnvelope(body.input[0].encrypted_content)?.red).toEqual(["opaque"]);
  });

  test("drops an empty unsigned thinking block", () => {
    const body = anthropicToResponsesBody({
      model: "m", messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "" }] }],
    }) as any;
    expect(body.input).toEqual([]);
  });

  test("preserves signature-only reasoning in JSON output", () => {
    const message = responsesJsonToAnthropicMessage({
      output: [{ type: "reasoning", summary: [], encrypted_content: encodeReasoningEnvelope({ sig: "sig-only" }) }],
    }, "m") as any;
    expect(message.content).toEqual([{ type: "thinking", thinking: "", signature: "sig-only" }]);
  });
});

describe("late reasoning signatures keep Responses item indexes unique", () => {
  const usage = { inputTokens: 1, outputTokens: 1 };
  const endings: AdapterEvent[] = [
    { type: "done", usage },
    { type: "done", usage, stopReason: "max_tokens" },
    { type: "incomplete", reason: "adapter_eof", usage },
    { type: "error", code: "upstream_error", message: "Synthetic failure" },
  ];
  for (const hidden of [false, true]) {
    for (const tool of [false, true]) {
      for (const [index, ending] of endings.entries()) {
        test(`${hidden ? "hidden" : "visible"} thinking, ${tool ? "tool" : "text"}, terminal ${index}`, async () => {
          async function* upstream(): AsyncGenerator<AdapterEvent> {
            yield { type: "thinking_delta", thinking: "A synthetic summary" };
            if (tool) {
              yield { type: "tool_call_start", id: "call_fixture", name: "glob" };
              yield { type: "tool_call_delta", arguments: '{"pattern":"*.py"}' };
            } else {
              yield { type: "text_delta", text: "Selam!" };
            }
            // Devin seals the reasoning after answer/tool deltas, not after its summary.
            yield { type: "thinking_signature", signature: "synthetic-old-signature", afterOutput: true };
            yield { type: "heartbeat" };
            yield { type: "thinking_signature", signature: "synthetic-latest-signature", afterOutput: true };
            yield ending;
          }
          const wire = await new Response(bridgeToResponsesSSE(
            upstream(), "swe-2", undefined, undefined, undefined, undefined, 2000,
            { hideThinkingSummary: hidden },
          )).text();
          const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
          const added = events.filter(event => event.type === "response.output_item.added");
          const done = events.filter(event => event.type === "response.output_item.done");
          // A client keyed by output_index must never lose an open block to another ID.
          expect(new Set(added.map(event => event.output_index)).size).toBe(added.length);
          expect(added.map(event => event.output_index)).toEqual(added.map((_, i) => i));
          for (const event of added) {
            const closed = done.filter(end => end.item.id === event.item.id);
            expect(closed).toHaveLength(1);
            expect(closed[0].output_index).toBe(event.output_index);
          }
          // Model the index-keyed consumer used by pi-ai/DSH. Reusing an index
          // overwrites its open slot and leaves duplicate text or an unfinished call.
          const slots = new Map<number, string>();
          const deltas = new Map<number, string>();
          const completed: string[] = [];
          for (const event of events) {
            if (event.type === "response.output_item.added") slots.set(event.output_index, event.item.id);
            if (["response.output_text.delta", "response.function_call_arguments.delta", "response.reasoning_summary_text.delta"].includes(event.type)) {
              expect(slots.get(event.output_index)).toBe(event.item_id);
              deltas.set(event.output_index, (deltas.get(event.output_index) ?? "") + event.delta);
            }
            if (event.type === "response.output_item.done") {
              expect(slots.get(event.output_index)).toBe(event.item.id);
              if (event.item.type === "message") expect(deltas.get(event.output_index)).toBe("Selam!");
              if (event.item.type === "function_call") expect(deltas.get(event.output_index)).toBe('{"pattern":"*.py"}');
              if (event.item.type === "reasoning" && !hidden && !event.item.encrypted_content) {
                expect(deltas.get(event.output_index)).toBe("A synthetic summary");
              }
              completed.push(event.item.id);
              slots.delete(event.output_index);
            }
          }
          expect(slots.size).toBe(0);
          expect(completed).toHaveLength(added.length);
          const terminal = events.find(event => ["response.completed", "response.incomplete", "response.failed"].includes(event.type));
          expect(terminal.response.output.map((item: { id: string }) => item.id)).toEqual(added.map(event => event.item.id));
          const carriers = done.filter(event => event.item.encrypted_content);
          expect(carriers).toHaveLength(1);
          expect(decodeReasoningEnvelope(carriers[0].item.encrypted_content)?.sig).toBe("synthetic-latest-signature");
          const output = done.filter(event => event.item.type === (tool ? "function_call" : "message"));
          expect(output).toHaveLength(1);
          if (tool) {
            expect(output[0].item.arguments).toBe('{"pattern":"*.py"}');
            expect(output[0].item.status).toBe(index === 0 ? "completed" : "incomplete");
          } else {
            expect(output[0].item.content[0].text).toBe("Selam!");
            if (index === 0) expect(output[0].item.phase).toBe("final_answer");
          }
        });
      }
    }
  }
});

describe("pending signature terminal safety", () => {
  const usage = { inputTokens: 1, outputTokens: 1 };
  const endings: AdapterEvent[] = [
    { type: "error", code: "upstream_error", message: "synthetic failure" },
    { type: "incomplete", reason: "adapter_eof", usage },
    { type: "done", usage, stopReason: "max_tokens" },
    { type: "tool_call_end", incomplete: true },
    { type: "done", usage },
  ];
  for (const afterOutput of [false, true]) {
    for (const [index, ending] of endings.entries()) {
      test(`open tool signature afterOutput=${afterOutput}, ending=${index}`, async () => {
        async function* upstream(): AsyncGenerator<AdapterEvent> {
          yield { type: "tool_call_start", id: "call_terminal", name: "read" };
          yield { type: "tool_call_delta", arguments: "{}" };
          yield { type: "thinking_signature", signature: "terminal-sig", ...(afterOutput ? { afterOutput: true } : {}) };
          yield ending;
        }
        const wire = await new Response(bridgeToResponsesSSE(upstream(), "m")).text();
        const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
        const tool = events.find(event => event.type === "response.output_item.done" && event.item.type === "function_call");
        expect(tool.item.status).toBe(index === 4 ? "completed" : "incomplete");
        expect(events.filter(event => event.type === "response.function_call_arguments.done")).toHaveLength(index === 4 ? 1 : 0);
        const carrier = events.find(event => event.type === "response.output_item.done" && event.item.encrypted_content);
        expect(decodeReasoningEnvelope(carrier.item.encrypted_content)).toEqual({ sig: "terminal-sig", ...(afterOutput ? { aft: tool.item.id } : {}) });
      });
    }
  }
  for (const afterOutput of [false, true]) {
    test(`malformed tool termination preserves signature afterOutput=${afterOutput}`, async () => {
      /** Emit an invalid call followed by a provider signature and explicit call end. */
      async function* upstream(): AsyncGenerator<AdapterEvent> {
        yield { type: "tool_call_start", id: "call_malformed", name: "read" };
        yield { type: "tool_call_delta", arguments: "{" };
        yield { type: "thinking_signature", signature: "malformed-sig", ...(afterOutput ? { afterOutput: true } : {}) };
        yield { type: "tool_call_end" };
        yield { type: "done", usage };
      }
      const wire = await new Response(bridgeToResponsesSSE(upstream(), "m")).text();
      const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
      const done = events.filter(event => event.type === "response.output_item.done");
      const tool = done.find(event => event.item.type === "function_call");
      const carrier = done.find(event => event.item.encrypted_content);
      expect(tool.item.status).toBe("incomplete");
      expect(events.filter(event => event.type === "response.function_call_arguments.done")).toHaveLength(0);
      expect(decodeReasoningEnvelope(carrier?.item.encrypted_content ?? "")).toEqual({ sig: "malformed-sig", ...(afterOutput ? { aft: tool.item.id } : {}) });
      expect(events.find(event => event.type === "response.failed").response.output).toEqual(done.map(event => event.item));
      expect(events.filter(event => event.type === "response.completed")).toHaveLength(0);
    });
  }
  for (const afterOutput of [false, true]) {
    test(`undeclared tool termination preserves signature afterOutput=${afterOutput}`, async () => {
      /** Retain a completed allowed call while rejecting a later undeclared call. */
      async function* upstream(): AsyncGenerator<AdapterEvent> {
        yield { type: "tool_call_start", id: "call_allowed", name: "read" };
        yield { type: "tool_call_delta", arguments: "{}" };
        yield { type: "tool_call_end" };
        yield { type: "thinking_signature", signature: "undeclared-sig", ...(afterOutput ? { afterOutput: true } : {}) };
        yield { type: "tool_call_start", id: "call_forbidden", name: "undeclared" };
      }
      const wire = await new Response(bridgeToResponsesSSE(
        upstream(), "m", undefined, undefined, undefined, undefined, 2000,
        { declaredToolNames: new Set(["read"]), enforceDeclaredToolNames: true },
      )).text();
      const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
      const done = events.filter(event => event.type === "response.output_item.done");
      const tool = done.find(event => event.item.type === "function_call");
      const carrier = done.find(event => event.item.encrypted_content);
      expect(tool.item.status).toBe("completed");
      expect(done.filter(event => event.item.type === "function_call").map(event => event.item.name)).toEqual(["read"]);
      expect(decodeReasoningEnvelope(carrier?.item.encrypted_content ?? "")).toEqual({ sig: "undeclared-sig", ...(afterOutput ? { aft: tool.item.id } : {}) });
      expect(events.find(event => event.type === "response.failed").response.output).toEqual(done.map(event => event.item));
      expect(events.filter(event => event.type === "response.completed")).toHaveLength(0);
    });
  }
  for (const ending of ["eof", "throw"] as const) {
    for (const earlyEnd of [false, true]) {
      test(`late tool signature survives ${ending}, earlyEnd=${earlyEnd}`, async () => {
        async function* upstream(): AsyncGenerator<AdapterEvent> {
          yield { type: "tool_call_start", id: "call_abnormal", name: "read" };
          yield { type: "tool_call_delta", arguments: "{}" };
          if (earlyEnd) yield { type: "tool_call_end" };
          yield { type: "thinking_signature", signature: "abnormal-sig", afterOutput: true };
          if (ending === "throw") throw new Error("synthetic failure");
        }
        const wire = await new Response(bridgeToResponsesSSE(upstream(), "m")).text();
        const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
        const done = events.filter(event => event.type === "response.output_item.done");
        expect(done.map(event => event.output_index)).toEqual([0, 1]);
        expect(done[0].item.status).toBe(earlyEnd ? "completed" : "incomplete");
        expect(decodeReasoningEnvelope(done[1].item.encrypted_content)).toEqual({ sig: "abnormal-sig", aft: done[0].item.id });
        const terminal = events.find(event => event.type === `response.${ending === "throw" ? "failed" : "incomplete"}`);
        expect(terminal.response.output).toEqual(done.map(event => event.item));
        expect(events.filter(event => event.type === "response.completed")).toHaveLength(0);
      });
    }
  }
});

describe("hidden thinking while a tool remains open", () => {
  const endings = ["error", "incomplete", "truncated", "eof", "throw", "malformed", "tool-incomplete", "tool-end", "done"] as const;
  for (const blocks of [1, 2]) {
    for (const ending of endings) {
      test(`${blocks} ordinary hidden blocks preserve open call through ${ending}`, async () => {
        await checkHiddenTool(blocks, ending, false);
      });
    }
  }
  for (const ending of endings) {
    test(`afterOutput hidden block preserves open call through ${ending}`, async () => {
      await checkHiddenTool(1, ending, true);
    });
  }
  test("redacted hidden blocks do not issue an unfinished call or merge signed blocks", async () => {
    async function* upstream(): AsyncGenerator<AdapterEvent> {
      yield { type: "tool_call_start", id: "call_redacted", name: "read" };
      yield { type: "tool_call_delta", arguments: "{" };
      yield { type: "thinking_delta", thinking: "exact thought" };
      yield { type: "thinking_signature", signature: "normal-sig" };
      yield { type: "redacted_thinking", data: "opaque" };
      yield { type: "error", code: "upstream_error", message: "synthetic failure" };
    }
    const wire = await new Response(bridgeToResponsesSSE(
      upstream(), "m", undefined, undefined, undefined, undefined, 2000, { hideThinkingSummary: true },
    )).text();
    const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    const items = events.filter(event => event.type === "response.output_item.done").map(event => event.item);
    expect(items[0].status).toBe("incomplete");
    expect(items.filter(item => item.encrypted_content).map(item => decodeReasoningEnvelope(item.encrypted_content)))
      .toEqual([{ sig: "normal-sig", txt: "exact thought" }, { red: ["opaque"] }]);
    expect(events.filter(event => event.type === "response.function_call_arguments.done")).toHaveLength(0);
  });

  test("unsigned hidden thinking cannot issue an unfinished call", async () => {
    async function* upstream(): AsyncGenerator<AdapterEvent> {
      yield { type: "tool_call_start", id: "call_unsigned", name: "read" };
      yield { type: "tool_call_delta", arguments: "{" };
      yield { type: "thinking_delta", thinking: "unsealed" };
      yield { type: "error", code: "upstream_error", message: "synthetic failure" };
    }
    const wire = await new Response(bridgeToResponsesSSE(
      upstream(), "m", undefined, undefined, undefined, undefined, 2000, { hideThinkingSummary: true },
    )).text();
    const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    expect(events.find(event => event.type === "response.output_item.done").item.status).toBe("incomplete");
    expect(events.filter(event => event.type === "response.function_call_arguments.done")).toHaveLength(0);
  });

  test("deferred hidden blocks stay bounded by the translator budget", async () => {
    const budget = createTranslatorBudget({ maxTurnBytes: 4096 });
    let produced = 0;
    async function* upstream(): AsyncGenerator<AdapterEvent> {
      yield { type: "tool_call_start", id: "call_bounded", name: "read" };
      yield { type: "tool_call_delta", arguments: "{}" };
      for (; produced < 1000; produced++) {
        yield { type: "thinking_delta", thinking: "x".repeat(256) };
        yield { type: "thinking_signature", signature: `sig-${produced}` };
        yield { type: "tool_call_delta", arguments: "" };
      }
      yield { type: "done" };
    }
    try {
      const wire = await new Response(bridgeToResponsesSSE(
        upstream(), "m", undefined, undefined, undefined, undefined, 2000,
        { hideThinkingSummary: true, translatorBudget: budget },
      )).text();
      expect(produced).toBeLessThan(1000);
      expect(budget.snapshot().highWaterBytes).toBeLessThanOrEqual(4096);
      expect(wire).toContain('"code":"translation_buffer_limit"');
      expect(wire).not.toContain("event: response.function_call_arguments.done");
      expect(wire).not.toContain('"status":"completed"');
    } finally { budget.dispose(); }
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test.each(["entry", "direct"] as const)("borrowed budget releases payload after %s admission failure", async stage => {
    const budget = createTranslatorBudget({ maxTurnBytes: 65536 });
    const charge = budget.chargeRetained.bind(budget);
    const reserve = budget.reserveTransient.bind(budget);
    let failDirectFrame = false;
    const chargeSpy = spyOn(budget, "chargeRetained").mockImplementation((bytes, scope) => {
      if (stage === "entry" && scope.kind === "reasoning" && bytes === 32) throw new TranslatorBudgetExceededError("reasoning", 65536);
      charge(bytes, scope);
    });
    const reserveSpy = spyOn(budget, "reserveTransient").mockImplementation((bytes, scope) => {
      if (failDirectFrame && scope.kind === "live_transient") {
        failDirectFrame = false;
        throw new TranslatorBudgetExceededError("live_transient", 65536);
      }
      return reserve(bytes, scope);
    });
    async function* upstream(): AsyncGenerator<AdapterEvent> {
      if (stage === "entry") {
        yield { type: "tool_call_start", id: "call_admission", name: "read" };
        yield { type: "tool_call_delta", arguments: "{}" };
      }
      yield { type: "thinking_delta", thinking: "hidden" };
      yield { type: "thinking_signature", signature: "sig" };
      if (stage === "entry") yield { type: "tool_call_delta", arguments: "" };
      yield { type: "done" };
    }
    try {
      const wire = await new Response(bridgeToResponsesSSE(
        upstream(), "m", undefined, undefined, undefined, undefined, 2000,
        { hideThinkingSummary: true, translatorBudget: budget, outputItemIds: {
          next(kind) { if (stage === "direct" && kind === "reasoning") failDirectFrame = true; return `${kind}_admission`; },
        } },
      )).text();
      expect(wire.match(/event: response.failed/g)).toHaveLength(1);
      expect(wire).toContain('"code":"translation_buffer_limit"');
      expect(wire).not.toContain("event: response.function_call_arguments.done");
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { chargeSpy.mockRestore(); reserveSpy.mockRestore(); budget.dispose(); }
  });

  test.each([2048, 4096, 8192])("deferred drain respects budget=%s without a second terminal", async maxTurnBytes => {
    const budget = createTranslatorBudget({ maxTurnBytes });
    async function* upstream(): AsyncGenerator<AdapterEvent> {
      yield { type: "tool_call_start", id: "call_drain", name: "read" };
      yield { type: "tool_call_delta", arguments: "{}" };
      for (let i = 0; i < 3; i++) {
        yield { type: "thinking_delta", thinking: "x".repeat(256) };
        yield { type: "thinking_signature", signature: `sig-${i}` };
        yield { type: "tool_call_delta", arguments: "" };
      }
      yield { type: "error", code: "upstream_error", message: "synthetic failure" };
    }
    try {
      const wire = await new Response(bridgeToResponsesSSE(
        upstream(), "m", undefined, undefined, undefined, undefined, 2000,
        { hideThinkingSummary: true, translatorBudget: budget },
      )).text();
      expect(wire.match(/event: response.failed/g)).toHaveLength(1);
      expect(wire.match(/data: \[DONE\]/g)).toHaveLength(1);
      expect(wire).not.toContain("event: response.function_call_arguments.done");
      expect(wire).not.toContain('"status":"completed"');
      expect(budget.snapshot().highWaterBytes).toBeLessThanOrEqual(maxTurnBytes);
    } finally { budget.dispose(); }
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test.each([false, true])("late trailer stays adjacent ahead of deferred normal blocks, failed=%s", async failed => {
    async function* upstream(): AsyncGenerator<AdapterEvent> {
      yield { type: "tool_call_start", id: "call_mixed", name: "read" };
      yield { type: "tool_call_delta", arguments: "{}" };
      yield { type: "thinking_delta", thinking: "normal" };
      yield { type: "thinking_signature", signature: "normal-sig" };
      yield { type: "tool_call_delta", arguments: "" };
      yield { type: "thinking_delta", thinking: "late" };
      yield { type: "thinking_signature", signature: "late-sig", afterOutput: true };
      if (failed) yield { type: "error", code: "upstream_error", message: "synthetic failure" };
      else yield { type: "done" };
    }
    const wire = await new Response(bridgeToResponsesSSE(
      upstream(), "m", undefined, undefined, undefined, undefined, 2000, { hideThinkingSummary: true },
    )).text();
    const items = wire.split("\n").filter(line => line.startsWith("data: {"))
      .map(line => JSON.parse(line.slice(6))).filter(event => event.type === "response.output_item.done").map(event => event.item);
    expect(items[0].status).toBe(failed ? "incomplete" : "completed");
    expect(items.slice(1).map(item => decodeReasoningEnvelope(item.encrypted_content))).toEqual([
      { sig: "late-sig", txt: "late", aft: items[0].id }, { sig: "normal-sig", txt: "normal" },
    ]);
  });

  for (const next of ["summary", "redacted"] as const) {
    for (const failed of [false, true]) {
      test(`hidden raw followed by ${next} keeps the open tool index, failed=${failed}`, async () => {
        async function* upstream(): AsyncGenerator<AdapterEvent> {
          yield { type: "tool_call_start", id: "call_raw", name: "read" };
          yield { type: "tool_call_delta", arguments: '{"value":' };
          yield { type: "reasoning_raw_delta", text: "raw text" };
          if (next === "summary") {
            yield { type: "thinking_delta", thinking: "summary text" };
            yield { type: "thinking_signature", signature: "summary-sig" };
          } else yield { type: "redacted_thinking", data: "opaque" };
          yield { type: "tool_call_delta", arguments: '"ok"}' };
          if (failed) yield { type: "error", code: "upstream_error", message: "synthetic failure" };
          else { yield { type: "tool_call_end" }; yield { type: "done" }; }
        }
        const wire = await new Response(bridgeToResponsesSSE(
          upstream(), "m", undefined, undefined, undefined, undefined, 2000, { hideThinkingSummary: true },
        )).text();
        const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
        const added = events.filter(event => event.type === "response.output_item.added");
        const done = events.filter(event => event.type === "response.output_item.done");
        expect(added.map(event => event.output_index)).toEqual([0, 1, 2]);
        expect(done.map(event => event.output_index)).toEqual([0, 1, 2]);
        expect(done[0].item).toMatchObject({ type: "function_call", arguments: '{"value":"ok"}', status: failed ? "incomplete" : "completed" });
        expect(events.filter(event => event.type === "response.function_call_arguments.delta").map(event => [event.output_index, event.item_id, event.delta]))
          .toEqual([[0, done[0].item.id, '{"value":'], [0, done[0].item.id, '"ok"}']]);
        expect(done.slice(1).map(event => decodeReasoningEnvelope(event.item.encrypted_content))).toEqual([
          { txt: "raw text" }, next === "summary" ? { sig: "summary-sig", txt: "summary text" } : { red: ["opaque"] },
        ]);
        expect(events.find(event => event.type === (failed ? "response.failed" : "response.completed")).response.output).toEqual(done.map(event => event.item));
      });
    }
  }

  test.each([false, true])("redacted block cannot consume a late trailer before owner close, failed=%s", async failed => {
    async function* upstream(): AsyncGenerator<AdapterEvent> {
      yield { type: "tool_call_start", id: "call_late_red", name: "read" };
      yield { type: "tool_call_delta", arguments: "{}" };
      yield { type: "thinking_delta", thinking: "normal" };
      yield { type: "thinking_signature", signature: "normal-sig" };
      yield { type: "tool_call_delta", arguments: "" };
      yield { type: "thinking_delta", thinking: "late" };
      yield { type: "thinking_signature", signature: "late-sig", afterOutput: true };
      yield { type: "redacted_thinking", data: "opaque" };
      yield { type: "tool_call_delta", arguments: "" };
      if (failed) yield { type: "error", code: "upstream_error", message: "synthetic failure" };
      else { yield { type: "tool_call_end" }; yield { type: "done" }; }
    }
    const wire = await new Response(bridgeToResponsesSSE(
      upstream(), "m", undefined, undefined, undefined, undefined, 2000, { hideThinkingSummary: true },
    )).text();
    const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    const done = events.filter(event => event.type === "response.output_item.done");
    expect(done.map(event => event.output_index)).toEqual([0, 1, 2]);
    expect(done[0].item.status).toBe(failed ? "incomplete" : "completed");
    expect(done.slice(1).map(event => decodeReasoningEnvelope(event.item.encrypted_content))).toEqual([
      { sig: "late-sig", txt: "late", aft: done[0].item.id, red: ["opaque"] }, { sig: "normal-sig", txt: "normal" },
    ]);
    expect(events.find(event => event.type === (failed ? "response.failed" : "response.completed")).response.output).toEqual(done.map(event => event.item));
  });

  test.each(["signed", "raw"] as const)("client cancellation releases deferred %s payload and queue charges", async mode => {
    const budget = createTranslatorBudget({ maxTurnBytes: 65536 });
    const queued = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    async function* upstream(): AsyncGenerator<AdapterEvent> {
      yield { type: "tool_call_start", id: "call_cancel", name: "read" };
      yield { type: "tool_call_delta", arguments: "{}" };
      for (let i = 0; i < 2; i++) {
        if (mode === "signed") {
          yield { type: "thinking_delta", thinking: `hidden-${i}` };
          yield { type: "thinking_signature", signature: `sig-${i}` };
        } else {
          yield { type: "reasoning_raw_delta", text: `hidden-${i}` };
          yield { type: "thinking_delta", thinking: "" };
        }
        yield { type: "tool_call_delta", arguments: "" };
      }
      queued.resolve();
      await release.promise;
    }
    const stream = bridgeToResponsesSSE(upstream(), "m", undefined, undefined, undefined,
      () => release.resolve(), 2000, { hideThinkingSummary: true, translatorBudget: budget });
    const reader = stream.getReader();
    const draining = (async () => { while (!(await reader.read()).done) {} })();
    try {
      await queued.promise;
      const before = budget.snapshot().currentBytes;
      const encodedBytes = [0, 1].reduce((sum, i) => sum + Buffer.byteLength(encodeReasoningEnvelope({ txt: `hidden-${i}`, ...(mode === "signed" ? { sig: `sig-${i}` } : {}) })), 0);
      await reader.cancel();
      await draining;
      expect(before - budget.snapshot().currentBytes).toBe(encodedBytes + 2 * 32);
    } finally { release.resolve(); budget.dispose(); }
  });

  /** Exercise hidden blocks between argument fragments without allowing thinking to issue a call. */
  async function checkHiddenTool(blocks: number, ending: typeof endings[number], afterOutput: boolean) {
    const usage = { inputTokens: 1, outputTokens: 1 };
    async function* upstream(): AsyncGenerator<AdapterEvent> {
      yield { type: "tool_call_start", id: "call_interleaved", name: "read" };
      yield { type: "tool_call_delta", arguments: '{"value":' };
      for (let i = 0; i < blocks; i++) {
        yield { type: "thinking_delta", thinking: `hidden-${i}` };
        yield { type: "thinking_signature", signature: `sig-${i}`, ...(afterOutput ? { afterOutput: true } : {}) };
        if (i === 0) yield { type: "tool_call_delta", arguments: '"ok"' };
      }
      if (ending !== "malformed") yield { type: "tool_call_delta", arguments: "}" };
      if (ending === "throw") throw new Error("synthetic interleaved failure");
      if (ending === "error") yield { type: "error", code: "upstream_error", message: "synthetic interleaved failure" };
      if (ending === "incomplete") yield { type: "incomplete", reason: "adapter_eof", usage };
      if (ending === "truncated") yield { type: "done", usage, stopReason: "max_tokens" };
      if (ending === "malformed" || ending === "tool-end") yield { type: "tool_call_end" };
      if (ending === "tool-incomplete") yield { type: "tool_call_end", incomplete: true };
      if (ending === "tool-end" || ending === "done") yield { type: "done", usage };
    }
    const wire = await new Response(bridgeToResponsesSSE(
      upstream(), "m", undefined, undefined, undefined, undefined, 2000, { hideThinkingSummary: true },
    )).text();
    const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    const added = events.filter(event => event.type === "response.output_item.added");
    const done = events.filter(event => event.type === "response.output_item.done");
    const tool = done.find(event => event.item.type === "function_call");
    const success = ending === "tool-end" || ending === "done";
    expect(tool.item.status).toBe(success ? "completed" : "incomplete");
    expect(tool.item.arguments).toBe(ending === "malformed" ? '{"value":"ok"' : '{"value":"ok"}');
    expect(events.filter(event => event.type === "response.function_call_arguments.done")).toHaveLength(success ? 1 : 0);
    expect(added.map(event => event.output_index)).toEqual(added.map((_, index) => index));
    expect(done.map(event => event.output_index)).toEqual(added.map(event => event.output_index));
    const envelopes = done.filter(event => event.item.encrypted_content).map(event => decodeReasoningEnvelope(event.item.encrypted_content));
    expect(envelopes).toEqual(Array.from({ length: blocks }, (_, i) => ({ sig: `sig-${i}`, txt: `hidden-${i}`, ...(afterOutput ? { aft: tool.item.id } : {}) })));
    expect(events.filter(event => event.type === "response.reasoning_summary_text.delta")).toHaveLength(0);
    const terminal = events.filter(event => ["response.completed", "response.failed", "response.incomplete"].includes(event.type));
    expect(terminal).toHaveLength(1);
    expect(terminal[0].response.output).toEqual(done.map(event => event.item));
  }
});

describe("normal interleaved thinking signatures", () => {
  for (const hidden of [false, true]) {
    test(`each block retains its exact text and signature, hidden=${hidden}`, async () => {
      async function* upstream(): AsyncGenerator<AdapterEvent> {
        yield { type: "text_delta", text: "before" };
        yield { type: "thinking_delta", thinking: "thinking A" };
        yield { type: "thinking_signature", signature: "sig-A" };
        yield { type: "text_delta", text: "between" };
        yield { type: "thinking_delta", thinking: "thinking B" };
        yield { type: "thinking_signature", signature: "sig-B" };
        yield { type: "tool_call_start", id: "normal_call", name: "read" };
        yield { type: "tool_call_delta", arguments: "{}" };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      }
      const wire = await new Response(bridgeToResponsesSSE(
        upstream(), "m", undefined, undefined, undefined, undefined, 2000,
        { hideThinkingSummary: hidden },
      )).text();
      const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
      const added = events.filter(event => event.type === "response.output_item.added");
      const done = events.filter(event => event.type === "response.output_item.done");
      expect(added.map(event => event.output_index)).toEqual(added.map((_, i) => i));
      expect(done.map(event => event.output_index)).toEqual(added.map(event => event.output_index));
      const buffered = buildResponseJSON(await Array.fromAsync(upstream()), "m", { hideThinkingSummary: hidden });
      for (const items of [done.map(event => event.item), buffered.output as any[]]) {
        expect(items.map(item => item.type)).toEqual(["message", "reasoning", "message", "reasoning", "function_call"]);
        const envelopes = items.filter(item => item.type === "reasoning").map(item => decodeReasoningEnvelope(item.encrypted_content));
        expect(envelopes).toEqual(hidden
          ? [{ sig: "sig-A", txt: "thinking A" }, { sig: "sig-B", txt: "thinking B" }]
          : [{ sig: "sig-A" }, { sig: "sig-B" }]);
      }
    });
  }
});

describe("reasoning allocation admission", () => {
  test.each(["ascii", "\"\\\n\u0000", "한글😀", "\ud800", "\udc00", ""])('sizes JSON strings exactly: %j', value => {
    const data = { sig: value, red: [value, ""], txt: value, krc: value, omitted: undefined };
    const expected = Buffer.byteLength(JSON.stringify(data));
    expect(jsonUtf8Bytes(data, expected)).toBe(expected);
    expect(() => jsonUtf8Bytes(data, expected - 1)).toThrow(TranslatorBudgetExceededError);
  });

  test("sizes the translated plain-JSON vocabulary", () => {
    const data = { arr: [undefined, null, true, false, 0, -0, 1e30, NaN, Infinity, { text: "x" }], absent: undefined };
    expect(jsonUtf8Bytes(data)).toBe(Buffer.byteLength(JSON.stringify(data)));
  });

  test.each<ReasoningEnvelope>([{ sig: "opaque" }, { red: ["one", "two"] }, { txt: "hidden" }, { krc: "opaque" }, { sig: "s", red: ["r"], txt: "t", krc: "k" }])(
    "rejects before JSON/Buffer materialization and admits the exact projected boundary: %j", envelope => {
      const json = JSON.stringify(envelope);
      const size = Buffer.byteLength(json);
      const base64Bytes = 4 * Math.ceil(size / 3);
      const limit = Math.max(3 * size + 4 * base64Bytes + 2 * OCX_REASONING_PREFIX.length, 8 * (OCX_REASONING_PREFIX.length + base64Bytes));
      const budget = createTranslatorBudget({ maxTurnBytes: limit - 1 });
      const stringify = spyOn(JSON, "stringify");
      const from = spyOn(Buffer, "from");
      let error: unknown;
      let serializations = 0;
      let allocations = 0;
      try { encodeReasoningEnvelope(envelope, budget); } catch (caught) { error = caught; }
      finally {
        serializations = stringify.mock.calls.length;
        allocations = from.mock.calls.length;
        stringify.mockRestore(); from.mockRestore();
      }
      expect(error).toBeInstanceOf(TranslatorBudgetExceededError);
      expect(serializations).toBe(0);
      expect(allocations).toBe(0);
      expect(budget.snapshot().currentBytes).toBe(0);
      budget.dispose();
      const exact = createTranslatorBudget({ maxTurnBytes: limit });
      try {
        const encoded = encodeReasoningEnvelope(envelope, exact);
        expect(encoded).toBe(OCX_REASONING_PREFIX + Buffer.from(json).toString("base64"));
        expect(decodeReasoningEnvelope(encoded, exact)).toEqual(envelope);
        expect(exact.snapshot().currentBytes).toBe(0);
      } finally { exact.dispose(); }
    },
  );

  test("bounds preencoded replay before decoding and preserves native blobs", () => {
    const encoded = encodeReasoningEnvelope({ txt: "" });
    const budget = createTranslatorBudget({ maxTurnBytes: encoded.length * 8 - 1 });
    const from = spyOn(Buffer, "from");
    let error: unknown;
    let allocations = 0;
    try { decodeReasoningEnvelope(encoded, budget); } catch (caught) { error = caught; }
    finally { allocations = from.mock.calls.length; from.mockRestore(); }
    expect(error).toBeInstanceOf(TranslatorBudgetExceededError);
    expect(allocations).toBe(0);
    expect(decodeReasoningEnvelope("native-opaque", budget)).toBeNull();
    expect(budget.snapshot().currentBytes).toBe(0);
    budget.dispose();
    const exact = createTranslatorBudget({ maxTurnBytes: encoded.length * 8 });
    try { expect(decodeReasoningEnvelope(encoded, exact)).toEqual({ txt: "" }); }
    finally { exact.dispose(); }
  });

  test.each(["thinking", "redacted_thinking", "owned"])('accounts cumulatively for %s blocks across messages', type => {
    const before = translatorObservedBufferSnapshot().currentBytes;
    const block = type === "redacted_thinking" ? { type, data: "r" }
      : { type: "thinking", thinking: "", signature: type === "owned" ? encodeReasoningEnvelope({ txt: "t" }) : "s" };
    const budget = createTranslatorBudget({ maxTurnBytes: 256 });
    try {
      expect(() => anthropicToResponsesTranslation({ model: "m", messages: Array.from({ length: 8 }, () => ({ role: "assistant", content: [block] })) }, undefined, budget))
        .toThrow(TranslatorBudgetExceededError);
      expect(budget.snapshot().highWaterBytes).toBeLessThanOrEqual(256);
    } finally { budget.dispose(); }
    expect(translatorObservedBufferSnapshot().currentBytes).toBe(before);
  });

  test.each(["thinking", "redacted_thinking", "owned"])("handler maps %s admission failure to 413 without dispatch and disposes its budget", async type => {
    const { handleClaudeMessages } = await import("../../src/server/claude-messages");
    const payload = "fixture".repeat(128);
    const signature = type === "owned" ? encodeReasoningEnvelope({ txt: payload }) : payload;
    const content = type === "redacted_thinking" ? { type, data: payload }
      : { type: "thinking", thinking: "", signature };
    const request = new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/model", messages: [{ role: "assistant", content: [content] }] }),
    });
    const beforeBytes = budgets.translatorObservedBufferSnapshot().currentBytes;
    const beforeCount = budgets.translatorLiveBudgetCountForTests();
    const create = budgets.createTranslatorBudget;
    const budget = create({ maxTurnBytes: 4096 });
    const reserve = spyOn(budget, "reserveTransient");
    const charge = spyOn(budget, "chargeRetained");
    const factory = spyOn(budgets, "createTranslatorBudget").mockReturnValue(budget);
    const upstream = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("unexpected upstream dispatch"); });
    try {
      const response = await handleClaudeMessages(request, { port: 0, providers: {} }, { model: "", provider: "" });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ type: "error", error: { type: "request_too_large", code: "translation_buffer_limit" } });
      expect(upstream).not.toHaveBeenCalled();
      expect(reserve.mock.calls.some(([, scope]) => scope.kind === "reasoning")).toBe(true);
      expect(charge.mock.calls.filter(([, scope]) => scope.kind === "request_copies")).toHaveLength(0);
      expect(budgets.translatorObservedBufferSnapshot().currentBytes).toBe(beforeBytes);
      expect(budgets.translatorLiveBudgetCountForTests()).toBe(beforeCount);
    } finally { factory.mockRestore(); upstream.mockRestore(); reserve.mockRestore(); charge.mockRestore(); budget.dispose(); }
  });
  test("final request-copy admission returns 413 before serialization and disposes the budget", async () => {
    const { handleClaudeMessages } = await import("../../src/server/claude-messages");
    const request = new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/model", messages: [{ role: "user", content: "x".repeat(200) }] }),
    });
    const beforeBytes = budgets.translatorObservedBufferSnapshot().currentBytes;
    const beforeCount = budgets.translatorLiveBudgetCountForTests();
    const budget = budgets.createTranslatorBudget({ maxTurnBytes: 512 });
    const reserve = spyOn(budget, "reserveTransient");
    const charge = spyOn(budget, "chargeRetained");
    const factory = spyOn(budgets, "createTranslatorBudget").mockReturnValue(budget);
    const stringify = spyOn(JSON, "stringify");
    const upstream = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("unexpected upstream dispatch"); });
    try {
      const response = await handleClaudeMessages(request, { port: 0, providers: {} }, { model: "", provider: "" });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ type: "error", error: { type: "request_too_large", code: "translation_buffer_limit" } });
      expect(charge.mock.calls.filter(([, scope]) => scope.kind === "request_copies")).toHaveLength(1);
      expect(reserve.mock.calls.filter(([, scope]) => scope.kind === "request_copies")).toHaveLength(1);
      expect(stringify.mock.calls.some(([value]) => value && typeof value === "object" && "input" in value)).toBe(false);
      expect(upstream).not.toHaveBeenCalled();
      expect(budgets.translatorObservedBufferSnapshot().currentBytes).toBe(beforeBytes);
      expect(budgets.translatorLiveBudgetCountForTests()).toBe(beforeCount);
    } finally {
      factory.mockRestore(); stringify.mockRestore(); upstream.mockRestore();
      reserve.mockRestore(); charge.mockRestore(); budget.dispose();
    }
  });

  test("successful Request construction retains only its UTF-8 body after releasing temporary copies", async () => {
    const { handleClaudeMessages } = await import("../../src/server/claude-messages");
    const request = new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/model", messages: [{ role: "user", content: "hello" }] }),
    });
    const budget = budgets.createTranslatorBudget({ maxTurnBytes: 4096 });
    const originalCharge = budget.chargeRetained.bind(budget);
    const copies: Array<{ bytes: number; before: number; after: number }> = [];
    const charge = spyOn(budget, "chargeRetained").mockImplementation((bytes, scope) => {
      const before = budget.snapshot().currentBytes;
      originalCharge(bytes, scope);
      if (scope.kind === "request_copies") copies.push({ bytes, before, after: budget.snapshot().currentBytes });
    });
    const reserve = spyOn(budget, "reserveTransient");
    const factory = spyOn(budgets, "createTranslatorBudget").mockReturnValue(budget);
    const stringify = spyOn(JSON, "stringify");
    try {
      const response = await handleClaudeMessages(request, { port: 0, providers: {} }, { model: "", provider: "" });
      expect(response.status).toBe(404); // Serialization succeeded; the synthetic model is deliberately absent.
      await response.text();
      const serialized = stringify.mock.calls.find(([value]) => value && typeof value === "object" && "input" in value)?.[0];
      expect(serialized).toBeDefined();
      const expected = Buffer.byteLength(JSON.stringify(serialized));
      expect(copies).toHaveLength(2);
      expect(copies[1]!.bytes).toBe(expected);
      expect(copies[1]!.before).toBe(copies[0]!.after);
      expect(reserve.mock.calls.filter(([, scope]) => scope.kind === "request_copies").map(([bytes]) => bytes)).toEqual([3 * expected]);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { stringify.mockRestore(); factory.mockRestore(); reserve.mockRestore(); charge.mockRestore(); budget.dispose(); }
  });

  for (const event of [
    { type: "thinking_signature", signature: "r".repeat(256) },
    { type: "redacted_thinking", data: "r".repeat(256) },
    { type: "reasoning_raw_delta", text: "r".repeat(256) },
    { type: "kiro_redacted_reasoning", data: "r".repeat(256) },
  ] as const) {
    for (const mode of ["batch", "stream"] as const) {
      test(`${mode} ${event.type} admits envelope copies against the already charged turn`, async () => {
        const budget = createTranslatorBudget({ maxTurnBytes: 4096 });
        budget.chargeRetained(2048, { kind: "request_copies" });
        const stringify = spyOn(JSON, "stringify");
        try {
          const events: AdapterEvent[] = [event, { type: "done" }];
          if (mode === "batch") {
            expect(() => buildResponseJSON(events, "fixture/model", { translatorBudget: budget, hideThinkingSummary: true }))
              .toThrow(TranslatorBudgetExceededError);
          } else {
            async function* source() { yield* events; }
            const wire = await new Response(bridgeToResponsesSSE(source(), "fixture/model", undefined, undefined, undefined, undefined, undefined,
              { translatorBudget: budget, hideThinkingSummary: true })).text();
            expect(wire).toContain('"code":"translation_buffer_limit"');
            expect(wire).not.toContain('event: response.completed');
          }
          expect(stringify.mock.calls.some(([value]) => value && typeof value === "object"
            && ("sig" in value || "txt" in value || "red" in value || "krc" in value))).toBe(false);
        } finally { stringify.mockRestore(); budget.dispose(); }
      });
    }
  }

  for (const encoded of [false, true]) {
    test(`JSON outbound ${encoded ? "decoding" : "encoding"} uses the caller budget before allocation`, () => {
      const item = encoded
        ? { type: "reasoning", encrypted_content: encodeReasoningEnvelope({ sig: "r".repeat(256) }), summary: [] }
        : { type: "reasoning", summary: [{ type: "summary_text", text: "r".repeat(256) }] };
      const budget = createTranslatorBudget({ maxTurnBytes: 4096 });
      budget.chargeRetained(2048, { kind: "request_copies" });
      const from = spyOn(Buffer, "from");
      try {
        expect(() => responsesJsonToAnthropicMessage({ output: [item] }, "fixture/model", budget)).toThrow(TranslatorBudgetExceededError);
        expect(from).not.toHaveBeenCalled();
      } finally { from.mockRestore(); budget.dispose(); }
    });
  }

  for (const ending of ["throw", "eof", "stall"] as const) {
    for (const overflow of [false, true]) {
      test(`hidden reasoning ${ending} cleanup ${overflow ? "reports one budget failure" : "preserves its admitted terminal"}`, async () => {
        const budget = createTranslatorBudget({ maxTurnBytes: overflow ? 4096 : 65536 });
        budget.chargeRetained(2048, { kind: "request_copies" });
        const accumulated = Promise.withResolvers<void>();
        const pending = Promise.withResolvers<IteratorResult<AdapterEvent>>();
        let reads = 0;
        let returns = 0;
        let cancelled = 0;
        let clears = 0;
        let beat = () => {};
        const source: AsyncIterableIterator<AdapterEvent> = {
          [Symbol.asyncIterator]() { return this; },
          async next() {
            if (++reads === 1) return { done: false, value: { type: "reasoning_raw_delta", text: "r".repeat(256) } };
            accumulated.resolve();
            if (ending === "throw") throw new Error("synthetic generator failure");
            if (ending === "eof") return { done: true, value: undefined };
            return pending.promise;
          },
          async return() { returns++; pending.resolve({ done: true, value: undefined }); return { done: true, value: undefined }; },
        };
        const stringify = spyOn(JSON, "stringify");
        try {
          const stream = bridgeToResponsesSSE(source, "fixture/model", undefined, undefined, undefined,
            () => { cancelled++; }, 500, {
              translatorBudget: budget, hideThinkingSummary: true, stallTimeoutSec: 1,
              timers: { setInterval(callback) { beat = callback; return 1; }, clearInterval() { clears++; beat = () => {}; } },
            });
          const result = new Response(stream).text();
          await accumulated.promise;
          if (ending === "stall") { beat(); beat(); beat(); }
          const wire = await result;
          const envelopes = stringify.mock.calls.filter(([value]) => value && typeof value === "object" && "txt" in value);
          expect(wire.match(/data: \[DONE\]/g)).toHaveLength(1);
          expect(wire).not.toContain("event: response.completed");
          expect(clears).toBe(1);
          if (overflow) {
            expect(envelopes).toHaveLength(0);
            expect(wire.match(/event: response.failed/g)).toHaveLength(1);
            expect(wire).toContain('"code":"translation_buffer_limit"');
            expect(wire).not.toContain("event: response.incomplete");
            expect(cancelled).toBe(1);
            expect(returns).toBe(1);
          } else {
            expect(envelopes).toHaveLength(1);
            expect(wire).not.toContain("translation_buffer_limit");
            expect(wire.match(new RegExp(`event: response.${ending === "throw" ? "failed" : "incomplete"}`, "g"))).toHaveLength(1);
            expect(cancelled).toBe(ending === "eof" ? 0 : 1);
          }
        } finally { stringify.mockRestore(); pending.resolve({ done: true, value: undefined }); budget.dispose(); }
      });
    }
  }

  for (const encoded of [false, true]) {
    test(`SSE outbound ${encoded ? "decoding" : "encoding"} admits against its live turn budget`, async () => {
      const text = "r".repeat(512);
      const events = encoded ? [{ type: "response.output_item.done", item: {
        type: "reasoning", encrypted_content: encodeReasoningEnvelope({ sig: text }), summary: [],
      } }] : [
        { type: "response.reasoning_summary_text.delta", delta: text },
        { type: "response.completed", response: { status: "completed", output: [] } },
      ];
      const frames = events.map(event => new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      const budget = createTranslatorBudget({ maxTurnBytes: 8192 });
      budget.chargeRetained(4096, { kind: "request_copies" });
      const reserve = spyOn(budget, "reserveTransient");
      const from = spyOn(Buffer, "from");
      try {
        const upstream = new ReadableStream<Uint8Array>({ start(controller) { frames.forEach(frame => controller.enqueue(frame)); controller.close(); } });
        const wire = await new Response(responsesSseToAnthropicSse(upstream, "fixture/model", { translatorBudget: budget, pingIntervalMs: 0 })).text();
        expect(reserve.mock.calls.some(([bytes, scope]) => scope.kind === "reasoning" && bytes > 4096)).toBe(true);
        expect(from).not.toHaveBeenCalled();
        expect(wire.match(/event: error/g)).toHaveLength(1);
        expect(wire).toContain('"code":"translation_buffer_limit"');
        expect(wire).not.toContain("event: message_stop");
      } finally { reserve.mockRestore(); from.mockRestore(); budget.dispose(); }
    });
  }

});
