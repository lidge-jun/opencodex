import { afterEach, describe, expect, test } from "bun:test";
import { createKiroAdapter } from "../../../src/adapters/kiro";
import { KIRO_COMPLETION_TOOL_NAME } from "../../../src/adapters/kiro-constants";
import { resetKiroThrottleStateForTests } from "../../../src/adapters/kiro-retry";
import { encodeMessage } from "../../../src/lib/eventstream-decoder";
import { createTranslatorBudget, releaseTranslatedEvent } from "../../../src/lib/translator-budget";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const provider: OcxProviderConfig = {
  adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", apiKey: "ksk_test",
};
const parsed: OcxParsedRequest = {
  modelId: "claude-opus-5.5", stream: true, options: {},
  context: {
    messages: [{ role: "user", content: "Inspect the workspace." }],
    tools: [{ name: "bash", description: "Run a command", parameters: { type: "object" } }],
  },
};
const frame = (type: string, payload: object) => encodeMessage(
  { ":message-type": "event", ":event-type": type },
  new TextEncoder().encode(JSON.stringify(payload)),
);
const text = (content: string) => frame("assistantResponseEvent", { content });
function tool(name: string, input: object): Uint8Array[] {
  return [
    frame("toolUseEvent", { name, toolUseId: "call-1", input: JSON.stringify(input) }),
    frame("toolUseEvent", { name, toolUseId: "call-1", stop: true }),
  ];
}
const completion = (answer: string) => tool(KIRO_COMPLETION_TOOL_NAME, { answer });
function response(frames: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of frames) controller.enqueue(value);
      controller.close();
    },
  }));
}
afterEach(resetKiroThrottleStateForTests);

async function run(first: Uint8Array[], retry: Uint8Array[], buffered = false) {
  const adapter = createKiroAdapter(provider);
  const budget = createTranslatorBudget();
  const sends: number[] = [];
  const events: AdapterEvent[] = [];
  let visibleAtRetry: AdapterEvent[] = [];
  let physicalRequests = 0;
  try {
    const request = await adapter.buildRequest(structuredClone(parsed));
    const upstream = await adapter.fetchResponse!(request, {
      executor: (async () => {
        if (++physicalRequests === 1) return response(first);
        visibleAtRetry = events.filter(event => event.type === "text_delta");
        return response(retry);
      }) as typeof fetch,
      onPhysicalSend: send => { sends.push(send.ordinal); },
    });
    if (buffered) events.push(...await adapter.parseResponse!(upstream, budget));
    else for await (const event of adapter.parseStream(upstream, budget)) events.push(event);
    if (buffered) for (const event of events) releaseTranslatedEvent(event, budget);
    expect(budget.snapshot().currentBytes).toBe(0);
    return { events, sends, physicalRequests, visibleAtRetry };
  } finally {
    budget.dispose();
  }
}

describe("Kiro single final answer (#6270)", () => {
  for (const buffered of [false, true]) {
    test.each(["END_TURN", "STOP_SEQUENCE", undefined])(
      `plain text ending is held through validation (stop=%s, buffered=${buffered})`,
      async stopReason => {
        const answer = "The workspace is ready.";
        const { events, sends, physicalRequests, visibleAtRetry } = await run(
          [text("The workspace "), text("is ready."),
            ...(stopReason ? [frame("metadataEvent", { stopReason })] : [])],
          [text(answer), ...completion(answer)],
          buffered,
        );
        expect(events.filter(event => event.type === "text_delta")).toEqual([
          { type: "text_delta", text: answer, phase: "final_answer" },
        ]);
        expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
        expect(physicalRequests).toBe(2);
        expect(sends).toEqual([1, 2]);
        expect(visibleAtRetry).toEqual([]);
      },
    );
  }

  test("a real tool ending releases genuine progress without a completion retry", async () => {
    const { events, sends, physicalRequests } = await run(
      [text("Checking the workspace."), ...tool("bash", { command: "pwd" })], [],
    );
    expect(events.filter(event => event.type !== "heartbeat").map(event => event.type))
      .toEqual(["text_delta", "tool_call_start", "tool_call_delta", "tool_call_end", "done"]);
    expect(events.find(event => event.type === "text_delta")).toEqual({
      type: "text_delta", text: "Checking the workspace.", phase: "commentary",
    });
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: false });
    expect(physicalRequests).toBe(1);
    expect(sends).toEqual([1]);
  });

  test("normal private final_answer supersedes prose without a completion retry", async () => {
    const answer = "The workspace is ready.";
    const { events, sends, physicalRequests } = await run([text(answer), ...completion(answer)], []);
    expect(events.filter(event => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: answer, phase: "final_answer" },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(physicalRequests).toBe(1);
    expect(sends).toEqual([1]);
  });

  test("a retry tool call releases first-attempt progress before the tool", async () => {
    const { events } = await run([text("Checking the workspace.")], tool("bash", { command: "pwd" }));
    expect(events.filter(event => event.type !== "heartbeat").map(event => event.type))
      .toEqual(["text_delta", "tool_call_start", "tool_call_delta", "tool_call_end", "done"]);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: false });
  });

  test("a complete retry tool releases held progress while its stream is still open", async () => {
    let releaseEOF!: () => void;
    const eof = new Promise<void>(resolve => { releaseEOF = resolve; });
    let reachedOpenStream!: () => void;
    const openStream = new Promise<void>(resolve => { reachedOpenStream = resolve; });
    const frames = tool("bash", { command: "pwd" });
    const retry = new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = frames.shift();
        if (next) { controller.enqueue(next); return; }
        reachedOpenStream();
        await eof;
        controller.close();
      },
    }, { highWaterMark: 0 }));
    const adapter = createKiroAdapter(provider);
    const budget = createTranslatorBudget();
    const events: AdapterEvent[] = [];
    let physicalRequests = 0;
    try {
      const request = await adapter.buildRequest(structuredClone(parsed));
      const first = await adapter.fetchResponse!(request, {
        executor: (async () => ++physicalRequests === 1
          ? response([text("Checking the workspace.")]) : retry) as typeof fetch,
      });
      const draining = (async () => {
        for await (const event of adapter.parseStream(first, budget)) {
          events.push(event);
        }
      })();
      try {
        await openStream;
        expect(events.filter(event => event.type === "text_delta")).toEqual([
          { type: "text_delta", text: "Checking the workspace.", phase: "commentary" },
        ]);
      } finally { releaseEOF(); await draining; }
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: false });
      expect(physicalRequests).toBe(2);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { budget.dispose(); }
  });

  test("an accepted plain-text retry also replaces first-attempt text", async () => {
    const { events } = await run([text("The workspace is ready.")], [text("The workspace is ready.")]);
    expect(events.filter(event => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "The workspace is ready.", phase: "final_answer" },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  });

  test("an empty retry preserves held progress and stays non-retryable", async () => {
    const { events, physicalRequests } = await run([text("Checking the workspace.")], []);
    expect(events.filter(event => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "Checking the workspace.", phase: "commentary" },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "incomplete", retryable: false, endTurn: false });
    expect(physicalRequests).toBe(2);
  });
});
