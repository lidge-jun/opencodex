import { afterEach, describe, expect, test } from "bun:test";
import { createKiroAdapter } from "../../../src/adapters/kiro";
import { KIRO_COMPLETION_RETRY_MESSAGE, KIRO_COMPLETION_TOOL_NAME } from "../../../src/adapters/kiro-constants";
import { resetKiroThrottleStateForTests } from "../../../src/adapters/kiro-retry";
import { encodeMessage } from "../../../src/lib/eventstream-decoder";
import { createTranslatorBudget } from "../../../src/lib/translator-budget";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

// claude-sonnet-5 answers a trivial request in plain text with END_TURN instead of calling the
// private completion tool, so the bounded completion retry fires even though the held text WAS the
// answer. The retry used to open with "Continue the existing task"; the model read that as the
// user's next message and called the completion tool with "There's no active task in this
// conversation for me to continue", superseding the correct "OK". The frames below are the shape
// captured from the live upstream for that turn.

const provider: OcxProviderConfig = {
  adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", apiKey: "ksk_test",
};
// A Claude Code Messages turn reduced to what matters here: tools (so completion is `required`),
// an effort without a native Kiro field for this model, and a one-word answer.
const parsed: OcxParsedRequest = {
  modelId: "claude-sonnet-5", stream: true, options: { reasoning: "high" },
  context: {
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    tools: [
      { name: "Read", description: "Read a file", parameters: { type: "object", properties: { file_path: { type: "string" } } } },
      { name: "Bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } } },
    ],
  },
};
const frame = (type: string, payload: object) => encodeMessage(
  { ":message-type": "event", ":event-type": type },
  new TextEncoder().encode(JSON.stringify(payload)),
);
const tail = [
  frame("contextUsageEvent", { contextUsagePercentage: 0.33 }),
  frame("meteringEvent", { unit: "credit", unitPlural: "credits", usage: 0.0077 }),
];
// First attempt: the answer as ordinary text, then a native END_TURN.
const plainTextAnswer = [
  frame("initial-response", { conversationId: "" }),
  frame("assistantResponseEvent", { content: "O" }),
  frame("assistantResponseEvent", { content: "K" }),
  frame("metadataEvent", { stopReason: "END_TURN" }),
  ...tail,
];
// Retry: the same answer resubmitted through the completion tool, streamed in pieces.
const completionAnswer = [
  frame("initial-response", { conversationId: "" }),
  frame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "toolu-1" }),
  frame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "toolu-1", input: "{\"answer\":" }),
  frame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "toolu-1", input: " \"OK\"}" }),
  frame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "toolu-1", stop: true }),
  frame("metadataEvent", { stopReason: "TOOL_USE" }),
  ...tail,
];
/** A Kiro event-stream response that replays the given frames in order. */
function response(frames: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    /** Enqueue every frame, then close the stream. */
    start(controller) {
      for (const value of frames) controller.enqueue(value);
      controller.close();
    },
  }));
}
afterEach(resetKiroThrottleStateForTests);

/**
 * Run one Claude Code-shaped turn through the adapter: the first send answers with `first`, the
 * bounded retry with `retry`. Returns the client events, the physical send ordinals, every request
 * body, and the retry's parsed `conversationState` when a retry was sent.
 */
async function run(first: Uint8Array[], retry: Uint8Array[]) {
  const adapter = createKiroAdapter(provider);
  const budget = createTranslatorBudget();
  const sends: number[] = [];
  const events: AdapterEvent[] = [];
  const bodies: string[] = [];
  try {
    const request = await adapter.buildRequest(structuredClone(parsed));
    const upstream = await adapter.fetchResponse!(request, {
      /** Record each request body and answer the first send and the retry with their frames. */
      executor: (async (_url, init) => {
        bodies.push(String(init?.body));
        return response(bodies.length === 1 ? first : retry);
      }) as typeof fetch,
      onPhysicalSend: send => { sends.push(send.ordinal); },
    });
    for await (const event of adapter.parseStream(upstream, budget)) events.push(event);
    expect(budget.snapshot().currentBytes).toBe(0);
    const retryState = bodies[1] ? JSON.parse(bodies[1]).conversationState : undefined;
    return { events, sends, bodies, retryState };
  } finally {
    budget.dispose();
  }
}

describe("Kiro completion retry after a plain-text answer (claude-sonnet-5)", () => {
  test("the retry states the turn's state instead of presuming an open task", () => {
    // The phrase the model answered with "no active task ... to continue".
    expect(KIRO_COMPLETION_RETRY_MESSAGE).not.toContain("Continue the existing task");
    expect(KIRO_COMPLETION_RETRY_MESSAGE).toContain("no final answer has reached the user yet");
    // A direct completion route for a retry with no previous reply (reasoning only), and the
    // resubmit clause for a held plain-text answer.
    expect(KIRO_COMPLETION_RETRY_MESSAGE)
      .toContain(`If the task is complete, call ${KIRO_COMPLETION_TOOL_NAME} now with the complete final answer;`);
    expect(KIRO_COMPLETION_RETRY_MESSAGE).toContain("if your previous reply already was that answer, submit it unchanged.");
    // The progress-prose path the retry exists for (#531) keeps its instruction.
    expect(KIRO_COMPLETION_RETRY_MESSAGE).toContain("next real tool call now");
  });

  test("a plain-text END_TURN answer is replayed and resubmitted through the completion tool", async () => {
    const { events, sends, bodies, retryState } = await run(plainTextAnswer, completionAnswer);
    expect(bodies).toHaveLength(2);
    expect(sends).toEqual([1, 2]);
    // The held answer is replayed as the model's own previous reply, and the retry instruction is
    // the whole following user turn, so "your previous reply" points at exactly that text.
    expect(retryState.history.at(-1)).toEqual({ assistantResponseMessage: { content: "OK" } });
    expect(retryState.currentMessage.userInputMessage.content).toBe(KIRO_COMPLETION_RETRY_MESSAGE);
    expect(retryState.currentMessage.userInputMessage.userInputMessageContext.tools
      .some((tool: { toolSpecification: { name: string } }) => tool.toolSpecification.name === KIRO_COMPLETION_TOOL_NAME))
      .toBe(true);
    // One final answer: the resubmitted completion supersedes the held plain-text copy.
    expect(events.filter(event => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "OK", phase: "final_answer" },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  });

  test("a retry without replayable text appends the same instruction to the original request", async () => {
    // Reasoning only and no stop reason: nothing to replay, so there is no previous reply and the
    // conditional sentence is vacuous rather than false.
    const reasoningOnly = [
      frame("initial-response", { conversationId: "" }),
      frame("reasoningContentEvent", { text: "The user wants the word OK." }),
      ...tail,
    ];
    const { retryState, events } = await run(reasoningOnly, completionAnswer);
    expect(retryState.history ?? []).toEqual([]);
    const content: string = retryState.currentMessage.userInputMessage.content;
    expect(content).toContain("Reply with exactly: OK");
    expect(content.endsWith(KIRO_COMPLETION_RETRY_MESSAGE)).toBe(true);
    expect(events.filter(event => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "OK", phase: "final_answer" },
    ]);
  });
});
