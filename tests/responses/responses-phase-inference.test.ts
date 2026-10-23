import { describe, expect, test } from "bun:test";
import { createResponsesPhaseInferenceBlockRewrite } from "../../src/server/responses-phase-inference";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { relaySseWithBlockRewrite } from "../../src/server/sse-payload-rewrite";

function sse(type: string, body: Record<string, unknown>): string {
  return "event: " + type + "\ndata: " + JSON.stringify({ type, ...body }) + "\n\n";
}

function messageDone(outputIndex: number, text: string, phase?: string): string {
  const item: Record<string, unknown> = {
    type: "message", id: "msg_" + outputIndex, status: "completed", role: "assistant",
    content: [{ type: "output_text", text }],
  };
  if (phase) item.phase = phase;
  return sse("response.output_item.done", { output_index: outputIndex, item });
}

function functionCallAdded(outputIndex: number): string {
  return sse("response.output_item.added", {
    output_index: outputIndex,
    item: { type: "function_call", id: "fc_" + outputIndex, call_id: "call_" + outputIndex, name: "shell", arguments: "{}" },
  });
}

function completed(output: Record<string, unknown>[]): string {
  return sse("response.completed", { response: { id: "resp_1", status: "completed", output } });
}

function phaseOf(block: string): string | undefined {
  const dataLine = block.split("\n").find(line => line.startsWith("data:"))!.slice(5).trim();
  const parsed = JSON.parse(dataLine) as { item?: { phase?: string }; response?: { output?: { phase?: string }[] } };
  if (parsed.response) return parsed.response.output?.map(item => item.phase).join(",");
  return parsed.item?.phase;
}

describe("Responses phase inference block rewrite", () => {
  test("message followed by a tool call becomes commentary", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const out = [messageDone(0, "checking the grid"), functionCallAdded(1)].flatMap(b => rewrite(b));
    expect(out.map(phaseOf)).toEqual(["commentary", undefined]);
    rewrite.dispose?.();
  });

  test("message at turn end becomes final_answer and the snapshot mirrors it", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const out = [messageDone(0, "all done"), completed([{ type: "message", id: "msg_0", role: "assistant" }])]
      .flatMap(b => rewrite(b));
    expect(out.map(phaseOf)).toEqual(["final_answer", "final_answer"]);
    rewrite.dispose?.();
  });

  test("two consecutive messages mark the first as commentary", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const out = [
      messageDone(0, "intermediate"),
      messageDone(1, "final"),
      completed([{ type: "message", id: "msg_0", role: "assistant" }, { type: "message", id: "msg_1", role: "assistant" }]),
    ].flatMap(b => rewrite(b));
    expect(out.map(phaseOf)).toEqual(["commentary", "final_answer", "commentary,final_answer"]);
    rewrite.dispose?.();
  });

  test("message/tool/message keeps item-done and snapshot phases in agreement", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const out = [
      messageDone(0, "checking the grid"),
      functionCallAdded(1),
      messageDone(2, "all done"),
      completed([
        { type: "message", id: "msg_0", role: "assistant" },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "shell", arguments: "{}" },
        { type: "message", id: "msg_2", role: "assistant" },
      ]),
    ].flatMap(b => rewrite(b));
    expect(out.map(phaseOf)).toEqual(["commentary", undefined, "final_answer", "commentary,,final_answer"]);
    rewrite.dispose?.();
  });

  test("multiple messages keep every snapshot phase equal to its item-done phase", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const out = [
      messageDone(0, "first"),
      messageDone(1, "second"),
      messageDone(2, "final"),
      completed([
        { type: "message", id: "msg_0", role: "assistant" },
        { type: "message", id: "msg_1", role: "assistant" },
        { type: "message", id: "msg_2", role: "assistant" },
      ]),
    ].flatMap(b => rewrite(b));
    expect(out.map(phaseOf)).toEqual(["commentary", "commentary", "final_answer", "commentary,commentary,final_answer"]);
    rewrite.dispose?.();
  });

  test("snapshot keeps explicit upstream phases over inferred ones", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const out = [
      messageDone(0, "narration"),
      functionCallAdded(1),
      messageDone(2, "answer", "final_answer"),
      completed([
        { type: "message", id: "msg_0", role: "assistant" },
        { type: "message", id: "msg_2", role: "assistant", phase: "commentary" },
      ]),
    ].flatMap(b => rewrite(b));
    // msg_2 carries an explicit upstream commentary phase, so it wins even
    // though the message happens to close the turn.
    expect(out.map(phaseOf)).toEqual(["commentary", undefined, "final_answer", "commentary,commentary"]);
    rewrite.dispose?.();
  });

  test.each(["commentary", "final_answer"])("snapshot mirrors explicit %s when its phase is omitted", phase => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const out = [
      messageDone(0, "explicit message", phase),
      completed([{ type: "message", id: "msg_0", role: "assistant" }]),
    ].flatMap(b => rewrite(b));
    expect(out.map(phaseOf)).toEqual([phase, phase]);
    rewrite.dispose?.();
  });

  test("explicit and inferred phases stay associated with their own snapshot items", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const out = [
      messageDone(0, "inferred narration"),
      messageDone(1, "explicit narration", "commentary"),
      messageDone(2, "answer"),
      completed([
        { type: "message", id: "msg_2", role: "assistant" },
        { type: "message", id: "msg_0", role: "assistant" },
        { type: "message", id: "msg_1", role: "assistant" },
      ]),
    ].flatMap(b => rewrite(b));
    expect(out.map(phaseOf)).toEqual(["commentary", "commentary", "final_answer", "final_answer,commentary,commentary"]);
    rewrite.dispose?.();
  });

  test("snapshot messages never seen as item-done fall back to final_answer", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const out = [
      messageDone(0, "checking"),
      functionCallAdded(1),
      completed([{ type: "message", id: "msg_9", role: "assistant" }]),
    ].flatMap(b => rewrite(b));
    expect(out.map(phaseOf)).toEqual(["commentary", undefined, "final_answer"]);
    rewrite.dispose?.();
  });

  // Ingwannu P2 on #7375: the snapshot must agree with every item-done phase,
  // including gateways that omit message ids on events or snapshot items.
  function messageDoneWithoutId(outputIndex: number, text: string, phase?: string): string {
    const item: Record<string, unknown> = {
      type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text }],
    };
    if (phase) item.phase = phase;
    return sse("response.output_item.done", { output_index: outputIndex, item });
  }

  test("id-less messages keep item-done and snapshot phases in agreement by output index", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const out = [
      messageDoneWithoutId(0, "checking the grid"),
      functionCallAdded(1),
      messageDoneWithoutId(2, "all done"),
      completed([
        { type: "message", role: "assistant" },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "shell", arguments: "{}" },
        { type: "message", role: "assistant" },
      ]),
    ].flatMap(b => rewrite(b));
    expect(out.map(phaseOf)).toEqual(["commentary", undefined, "final_answer", "commentary,,final_answer"]);
    rewrite.dispose?.();
  });

  test("an explicit id-less commentary phase is reused by output index", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const out = [
      messageDoneWithoutId(0, "explicit narration", "commentary"),
      messageDoneWithoutId(1, "answer"),
      completed([{ type: "message", role: "assistant" }, { type: "message", role: "assistant" }]),
    ].flatMap(b => rewrite(b));
    expect(out.map(phaseOf)).toEqual(["commentary", "final_answer", "commentary,final_answer"]);
    rewrite.dispose?.();
  });

  test("an id on only one side still matches by output index", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const out = [
      messageDoneWithoutId(0, "narration"),
      messageDone(1, "more narration"),
      functionCallAdded(2),
      completed([
        { type: "message", id: "msg_0", role: "assistant" },
        { type: "message", role: "assistant" },
        { type: "function_call", id: "fc_2", call_id: "call_2", name: "shell", arguments: "{}" },
      ]),
    ].flatMap(b => rewrite(b));
    expect(out.map(phaseOf)).toEqual(["commentary", "commentary", undefined, "commentary,commentary,"]);
    rewrite.dispose?.();
  });

  test("a conflicting snapshot id at a known output index still falls back to final_answer", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const out = [
      messageDone(0, "checking"),
      functionCallAdded(1),
      completed([{ type: "message", role: "assistant" }, { type: "message", id: "msg_9", role: "assistant" }]),
    ].flatMap(b => rewrite(b));
    // Position 0 has no snapshot id, so it inherits msg_0's commentary; msg_9 at
    // position 1 names a different message and is not matched by position.
    expect(out.map(phaseOf)).toEqual(["commentary", undefined, "commentary,final_answer"]);
    rewrite.dispose?.();
  });

  test("explicitly phased messages are forwarded without buffering", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const block = messageDone(0, "hi", "commentary");
    // Forwarded immediately: nothing is retained, so a teardown after this
    // block cannot drop the message.
    expect(rewrite(block)).toEqual([block]);
    rewrite.dispose?.();
  });

  test("SSE keepalive comments keep the buffered message pending", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const keepalive = ": keepalive\n\n";
    const out = [messageDone(0, "checking"), keepalive, functionCallAdded(1)].flatMap(b => rewrite(b));
    // The keepalive passes through with the message still buffered; the
    // following tool call is what classifies it.
    expect(out).toEqual([keepalive, out[1]!, functionCallAdded(1)]);
    expect(phaseOf(out[1]!)).toBe("commentary");
    rewrite.dispose?.();
  });

  test("the [DONE] sentinel classifies a still-buffered message as final_answer", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const done = "data: [DONE]\n\n";
    const out = [messageDone(0, "answer"), done].flatMap(b => rewrite(b));
    expect(phaseOf(out[0]!)).toBe("final_answer");
    expect(out[1]).toBe(done);
    rewrite.dispose?.();
  });

  test("explicit phases are left untouched", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const block = messageDone(0, "hi", "commentary");
    const out = [...rewrite(block), ...rewrite(functionCallAdded(1))];
    expect(out.map(phaseOf)).toEqual(["commentary", undefined]);
    rewrite.dispose?.();
  });

  // Codex P2 on #7554: a null or unknown upstream phase is not an explicit
  // decision, so it is inferred and the snapshot agrees with the event.
  test.each([null, "analysis"])("a %p upstream phase is inferred like a missing one", phase => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const done = (index: number, text: string) => sse("response.output_item.done", {
      output_index: index,
      item: { type: "message", id: "msg_" + index, role: "assistant", phase, content: [{ type: "output_text", text }] },
    });
    const narration = done(0, "checking");
    expect(rewrite(narration)).toEqual([]);
    const out = [
      ...rewrite(functionCallAdded(1)),
      ...rewrite(done(2, "answer")),
      ...rewrite(completed([
        { type: "message", id: "msg_0", role: "assistant", phase },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "shell", arguments: "{}" },
        { type: "message", id: "msg_2", role: "assistant", phase },
      ])),
    ];
    expect(out.map(phaseOf)).toEqual(["commentary", undefined, "final_answer", "commentary,,final_answer"]);
    rewrite.dispose?.();
  });

  test("non-message blocks pass through unchanged", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite(createTestTranslatorBudget());
    const block = functionCallAdded(0);
    expect(rewrite(block)).toEqual([block]);
    rewrite.dispose?.();
  });

  test("pending message and ID decisions are charged until teardown", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createResponsesPhaseInferenceBlockRewrite(budget);
    rewrite(messageDone(0, "pending"));
    const pendingBytes = budget.snapshot().currentBytes;
    expect(pendingBytes).toBeGreaterThan(0);
    rewrite(": keepalive");
    expect(budget.snapshot().currentBytes).toBe(pendingBytes);
    rewrite(functionCallAdded(1));
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
    expect(budget.snapshot().currentBytes).toBeLessThan(pendingBytes);
    rewrite.dispose?.();
    rewrite.dispose?.();
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("relay cancellation refunds a pending message retained across keepalives", async () => {
    const budget = createTestTranslatorBudget();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const reader = relaySseWithBlockRewrite(stream,
      createResponsesPhaseInferenceBlockRewrite(budget), budget).getReader();
    source.enqueue(new TextEncoder().encode(messageDone(0, "pending") + ": keepalive\n\n"));
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(": keepalive\n\n");
      expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
    } finally {
      await reader.cancel();
    }
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test.each(["response.completed", "response.incomplete", "response.failed", "[DONE]"])(
    "%s releases the pending block and all ID decisions", type => {
      const budget = createTestTranslatorBudget();
      const rewrite = createResponsesPhaseInferenceBlockRewrite(budget);
      rewrite(messageDone(0, "explicit", "commentary"));
      rewrite(messageDone(1, "pending"));
      expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
      const block = type === "[DONE]" ? "data: [DONE]" : sse(type, {
        response: { id: "r", output: [{ type: "message", id: "msg_0" }, { type: "message", id: "msg_1" }] },
      });
      const output = rewrite(block);
      expect(phaseOf(output[0]!)).toBe("final_answer");
      if (type === "response.failed" || type === "[DONE]") expect(output[1]).toBe(block);
      expect(budget.snapshot().currentBytes).toBe(0);
      rewrite.dispose?.();
      expect(budget.snapshot().currentBytes).toBe(0);
    },
  );

  test("repeated explicit IDs do not accumulate duplicate charges", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createResponsesPhaseInferenceBlockRewrite(budget);
    const commentary = messageDone(0, "explicit", "commentary");
    rewrite(commentary);
    const bytes = budget.snapshot().currentBytes;
    for (let i = 0; i < 100; i++) rewrite(commentary);
    expect(budget.snapshot().currentBytes).toBe(bytes);
    rewrite(messageDone(0, "explicit", "final_answer"));
    expect(budget.snapshot().currentBytes).toBe(bytes + 2);
    rewrite(commentary);
    expect(budget.snapshot().currentBytes).toBe(bytes);
    rewrite.dispose?.();
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("oversized pending message fails through the shared budget", () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 1024 });
    const rewrite = createResponsesPhaseInferenceBlockRewrite(budget);
    rewrite(messageDone(0, "explicit", "commentary"));
    expect(() => rewrite(messageDone(1, "x".repeat(2048)))).toThrow("buffer exceeded");
    expect(budget.snapshot().currentBytes).toBe(0);
    rewrite.dispose?.();
  });

  test("many explicit IDs cannot bypass the shared retention limit", () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 1024 });
    const rewrite = createResponsesPhaseInferenceBlockRewrite(budget);
    expect(() => {
      for (let i = 0; i < 100; i++) rewrite(messageDone(i, "explicit", "commentary"));
    }).toThrow("buffer exceeded");
    expect(budget.snapshot().currentBytes).toBe(0);
    rewrite.dispose?.();
  });
});
