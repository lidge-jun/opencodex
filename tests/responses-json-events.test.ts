import { describe, expect, test } from "bun:test";
import {
  MAX_SYNTHESIZED_OUTPUT_ITEMS,
  responsesJsonEventSequence,
  responsesJsonToSseBody,
  responsesJsonToSseStream,
} from "../src/server/responses-json-events";

describe("responsesJsonEventSequence", () => {
  test("completed: created → per-item done → completed terminal", () => {
    const frames = responsesJsonEventSequence({
      id: "r1",
      status: "completed",
      output: [{ type: "message", id: "m1" }, { type: "function_call", id: "fc1" }],
    });
    expect(frames.map(frame => frame.type)).toEqual([
      "response.created",
      "response.output_item.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const created = frames[0]!.response as Record<string, unknown>;
    expect(created.status).toBe("in_progress");
    expect(created.output).toEqual([]);
    expect(frames[1]!.output_index).toBe(0);
    expect(frames[2]!.output_index).toBe(1);
    expect((frames[3]!.response as Record<string, unknown>).status).toBe("completed");
  });

  test("failed and incomplete statuses are preserved, not upgraded", () => {
    for (const status of ["failed", "incomplete"]) {
      const frames = responsesJsonEventSequence({ id: "r", status, output: [] });
      expect(frames.at(-1)!.type).toBe(`response.${status}`);
      expect((frames.at(-1)!.response as Record<string, unknown>).status).toBe(status);
    }
  });

  test("empty and non-array outputs yield the minimal sequence", () => {
    expect(responsesJsonEventSequence({ id: "r" }).map(frame => frame.type))
      .toEqual(["response.created", "response.completed"]);
    expect(responsesJsonEventSequence({ id: "r", output: null }).map(frame => frame.type))
      .toEqual(["response.created", "response.completed"]);
  });

  test("the payload rewrite hook runs on every frame (060 seam)", () => {
    const frames = responsesJsonEventSequence(
      { id: "r", status: "completed", output: [{ type: "message", id: "uuid-1" }] },
      payload => ({ ...payload, stamped: true }),
    );
    expect(frames.every(frame => frame.stamped === true)).toBe(true);
  });
});

describe("responsesJsonToSseBody", () => {
  test("serializes the sequence with exactly one [DONE] trailer", () => {
    const body = responsesJsonToSseBody({ id: "r", status: "completed", output: [{ type: "message", id: "m" }] });
    const frames = body.split("\n\n").filter(part => part.trim().length > 0);
    expect(frames).toHaveLength(4);
    expect(frames[0]).toContain('"type":"response.created"');
    expect(frames[1]).toContain('"type":"response.output_item.done"');
    expect(frames[2]).toContain('"type":"response.completed"');
    expect(frames[3]).toBe("data: [DONE]");
    expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  test("rejects output arrays that could amplify synthesized frames", () => {
    const output = Array.from({ length: MAX_SYNTHESIZED_OUTPUT_ITEMS + 1 }, () => null);
    expect(() => responsesJsonToSseBody({ id: "r", output })).toThrow(RangeError);
    expect(() => responsesJsonToSseStream({ id: "r", output })).toThrow(RangeError);
  });

  test("streams one SSE frame per pull and ends with [DONE]", async () => {
    const stream = responsesJsonToSseStream({
      id: "r",
      status: "completed",
      output: [{ type: "message", id: "m" }],
    });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }
    expect(chunks).toHaveLength(4);
    expect(chunks.at(-1)).toBe("data: [DONE]\n\n");
  });
});
