import { describe, expect, test } from "bun:test";
import { createResponsesPhaseInferenceBlockRewrite } from "../../src/server/responses-phase-inference";

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
    const rewrite = createResponsesPhaseInferenceBlockRewrite();
    const out = [messageDone(0, "checking the grid"), functionCallAdded(1)].flatMap(b => rewrite(b));
    expect(out.map(phaseOf)).toEqual(["commentary", undefined]);
    rewrite.dispose?.();
  });

  test("message at turn end becomes final_answer and the snapshot mirrors it", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite();
    const out = [messageDone(0, "all done"), completed([{ type: "message", id: "msg_0", role: "assistant" }])]
      .flatMap(b => rewrite(b));
    expect(out.map(phaseOf)).toEqual(["final_answer", "final_answer"]);
    rewrite.dispose?.();
  });

  test("two consecutive messages mark the first as commentary", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite();
    const out = [
      messageDone(0, "intermediate"),
      messageDone(1, "final"),
      completed([{ type: "message", id: "msg_0", role: "assistant" }, { type: "message", id: "msg_1", role: "assistant" }]),
    ].flatMap(b => rewrite(b));
    expect(out.map(phaseOf)).toEqual(["commentary", "final_answer", "final_answer,final_answer"]);
    rewrite.dispose?.();
  });

  test("explicit phases are left untouched", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite();
    const block = messageDone(0, "hi", "commentary");
    const out = [...rewrite(block), ...rewrite(functionCallAdded(1))];
    expect(out.map(phaseOf)).toEqual(["commentary", undefined]);
    rewrite.dispose?.();
  });

  test("non-message blocks pass through unchanged", () => {
    const rewrite = createResponsesPhaseInferenceBlockRewrite();
    const block = functionCallAdded(0);
    expect(rewrite(block)).toEqual([block]);
    rewrite.dispose?.();
  });
});
