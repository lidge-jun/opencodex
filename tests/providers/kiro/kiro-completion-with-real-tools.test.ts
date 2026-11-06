import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createKiroAdapter } from "../../../src/adapters/kiro";
import { KIRO_COMPLETION_TOOL_NAME } from "../../../src/adapters/kiro-constants";
import { resetKiroThrottleStateForTests } from "../../../src/adapters/kiro-retry";
import { buildResponseJSON } from "../../../src/bridge";
import { encodeMessage } from "../../../src/lib/eventstream-decoder";
import { createTranslatorBudget, releaseTranslatedEvent } from "../../../src/lib/translator-budget";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

/**
 * The model can send a real tool call and the private final-answer call in one turn, because the
 * prompt tells it to put independent calls in one block. The turn then continues through the real
 * tools and the final answer is dropped. It was a non-retryable 502 once the tool call had been
 * relayed, which no combo can recover from.
 */
const provider: OcxProviderConfig = {
  adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", apiKey: "ksk_test",
};
const parsed: OcxParsedRequest = {
  modelId: "claude-sonnet-4.5", stream: true, options: {},
  context: {
    messages: [{ role: "user", content: "Inspect the workspace." }],
    tools: [{ name: "bash", description: "Run a command", parameters: { type: "object" } }],
  },
};
const ANSWER = "The workspace is ready and nothing needs changing.";
const frame = (type: string, payload: object) => encodeMessage(
  { ":message-type": "event", ":event-type": type },
  new TextEncoder().encode(JSON.stringify(payload)),
);
const text = (content: string) => frame("assistantResponseEvent", { content });
function tool(name: string, input: object, id: string): Uint8Array[] {
  return [
    frame("toolUseEvent", { name, toolUseId: id }),
    frame("toolUseEvent", { name, toolUseId: id, input: JSON.stringify(input) }),
    frame("toolUseEvent", { name, toolUseId: id, stop: true }),
  ];
}
const bash = (id = "call-1") => tool("bash", { command: "pwd" }, id);
const completion = (answer = ANSWER, id = "complete-1") => tool(KIRO_COMPLETION_TOOL_NAME, { answer }, id);
function response(frames: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of frames) controller.enqueue(value);
      controller.close();
    },
  }));
}

let warnings: string[] = [];
let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warnings = [];
  warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.join(" ")); });
});
afterEach(() => {
  warn.mockRestore();
  resetKiroThrottleStateForTests();
});

/** One physical send per entry of `legs`; a second entry answers the bounded completion retry. */
async function run(legs: Uint8Array[][], buffered = false) {
  const adapter = createKiroAdapter(provider);
  const budget = createTranslatorBudget();
  const events: AdapterEvent[] = [];
  let physicalRequests = 0;
  try {
    const request = await adapter.buildRequest(structuredClone(parsed));
    const upstream = await adapter.fetchResponse!(request, {
      executor: (async () => response(legs[Math.min(physicalRequests++, legs.length - 1)]!)) as typeof fetch,
    });
    if (buffered) events.push(...await adapter.parseResponse!(upstream, budget));
    else for await (const event of adapter.parseStream(upstream, budget)) events.push(event);
    if (buffered) for (const event of events) releaseTranslatedEvent(event, budget);
    expect(budget.snapshot().currentBytes).toBe(0);
    return { events, physicalRequests };
  } finally {
    budget.dispose();
  }
}

const droppedLines = () => warnings.filter(line => line.startsWith("[kiro] dropped the private final-answer call"));

/** What the client sees: the real tool call, the tool_use end of turn, and no trace of the answer. */
function expectToolTurn(events: AdapterEvent[]): void {
  expect(events.some(event => event.type === "error")).toBe(false);
  expect(events.filter(event => event.type === "tool_call_start")).toEqual([
    { type: "tool_call_start", id: "call-1", name: "bash" },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "done", endTurn: false });
  expect(events.filter(event => event.type === "text_delta" && event.phase === "final_answer")).toEqual([]);
  const wire = JSON.stringify(events);
  expect(wire).not.toContain(ANSWER);
  expect(wire).not.toContain(KIRO_COMPLETION_TOOL_NAME);
  const json = buildResponseJSON(events, "claude-sonnet-4.5") as { output: Array<{ type: string }> };
  expect(json.output.filter(item => item.type === "function_call")).toHaveLength(1);
}

describe("a real tool call and the private final answer in one turn", () => {
  for (const buffered of [false, true]) {
    describe(buffered ? "buffered parse" : "streamed parse", () => {
      test("real tool first, then the completion: the tool call goes out, the answer is dropped", async () => {
        const { events, physicalRequests } = await run([[
          text("Checking the workspace."), ...bash(), ...completion(),
          frame("metadataEvent", { stopReason: "END_TURN" }),
        ]], buffered);
        expectToolTurn(events);
        // The prose before the tool is ordinary commentary, released with the tool call.
        expect(events.filter(event => event.type === "text_delta")).toEqual([
          { type: "text_delta", text: "Checking the workspace.", phase: "commentary" },
        ]);
        expect(physicalRequests).toBe(1);
        expect(droppedLines()).toHaveLength(1);
      });

      test("completion first, then the real tool: nothing of the answer was relayed before the tool", async () => {
        const { events, physicalRequests } = await run([[
          text("Checking the workspace."), ...completion(), ...bash(),
          frame("metadataEvent", { stopReason: "END_TURN" }),
        ]], buffered);
        expectToolTurn(events);
        expect(events.filter(event => event.type === "text_delta")).toEqual([
          { type: "text_delta", text: "Checking the workspace.", phase: "commentary" },
        ]);
        // No event of the completion call, and no answer text, comes before the tool call.
        const toolAt = events.findIndex(event => event.type === "tool_call_start");
        expect(JSON.stringify(events.slice(0, toolAt))).not.toContain(ANSWER);
        expect(physicalRequests).toBe(1);
        expect(droppedLines()).toHaveLength(1);
      });

      test("several real tools around one completion all go out; one line is logged", async () => {
        const { events } = await run([[
          ...bash("call-1"), ...completion(), ...bash("call-2"),
        ]], buffered);
        expect(events.some(event => event.type === "error")).toBe(false);
        expect(events.filter(event => event.type === "tool_call_start").map(event => event.type === "tool_call_start" && event.id))
          .toEqual(["call-1", "call-2"]);
        expect(events.at(-1)).toMatchObject({ type: "done", endTurn: false });
        expect(JSON.stringify(events)).not.toContain(ANSWER);
        expect(droppedLines()).toHaveLength(1);
      });

      test("the mix on the bounded completion retry drops the answer the same way", async () => {
        const { events, physicalRequests } = await run([
          [text("Checking the workspace.")],
          [...completion(), ...bash()],
        ], buffered);
        expect(physicalRequests).toBe(2);
        expectToolTurn(events);
        expect(droppedLines()).toHaveLength(1);
      });

      test("a plain completion with no real tool is still the final answer and logs nothing", async () => {
        const { events } = await run([[...completion()]], buffered);
        expect(events.filter(event => event.type === "text_delta")).toEqual([
          { type: "text_delta", text: ANSWER, phase: "final_answer" },
        ]);
        expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
        expect(droppedLines()).toEqual([]);
      });

      test("two completion calls are still an error", async () => {
        const { events } = await run([[...completion("FIRST-ANSWER", "complete-1"), ...completion("SECOND-ANSWER", "complete-2")]], buffered);
        expect(events.at(-1)).toMatchObject({ type: "error", code: "invalid_kiro_completion", retryable: false });
        expect(events.some(event => event.type === "done")).toBe(false);
        expect(JSON.stringify(events)).not.toContain("-ANSWER");
      });

      test("a second completion call is still an error when a real tool sits between or before them", async () => {
        for (const frames of [
          [...bash(), ...completion("one", "complete-1"), ...completion("two", "complete-2")],
          [...completion("one", "complete-1"), ...bash(), ...completion("two", "complete-2")],
        ]) {
          const { events } = await run([frames], buffered);
          expect(events.at(-1)).toMatchObject({ type: "error", code: "invalid_kiro_completion" });
          expect(events.some(event => event.type === "done")).toBe(false);
        }
      });

      test("a malformed completion is still an error next to a real tool", async () => {
        for (const frames of [
          [...bash(), ...tool(KIRO_COMPLETION_TOOL_NAME, { answer: "" }, "complete-1")],
          [...tool(KIRO_COMPLETION_TOOL_NAME, { answer: "" }, "complete-1"), ...bash()],
          [...bash(), frame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "complete-1", input: "{not json" }),
            frame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "complete-1", stop: true })],
        ]) {
          const { events } = await run([frames], buffered);
          expect(events.at(-1)).toMatchObject({ type: "error" });
          expect(events.some(event => event.type === "done")).toBe(false);
        }
      });
    });
  }

  test("the completion call stays reserved when explicit completion is disabled", async () => {
    const adapter = createKiroAdapter(provider);
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(response([...bash(), ...completion()]), createTranslatorBudget())) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ type: "error", code: "kiro_stream_protocol_error", retryable: false });
    expect(droppedLines()).toEqual([]);
  });
});
