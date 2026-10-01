import { describe, expect, test } from "bun:test";
import { parseRequest } from "../../src/responses/parser";
import { createAdvisorGuard, type AdvisorPlan, type AdvisorConsultOutcome } from "../../src/server/responses/advisor-slot";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";

const ADVICE: AdvisorConsultOutcome = {
  ok: true,
  isError: false,
  content: "<opencodex_advisor>\nadvice body\n</opencodex_advisor>",
};

function planFrom(recorder: {
  consults: { reason: string; question: string | undefined }[];
  outcome?: AdvisorConsultOutcome;
}): AdvisorPlan {
  return {
    consult: async (_parsed, reason, question) => {
      recorder.consults.push({ reason, question });
      return recorder.outcome ?? ADVICE;
    },
    formatUnavailable: (kind, error) => `<opencodex_advisor_unavailable>\n${kind}: ${error}\n</opencodex_advisor_unavailable>`,
  };
}

function advisorCallEvents(id: string, args: object = { question: "what next?" }): AdapterEvent[] {
  return [
    { type: "tool_call_start", id, name: "advisor" },
    { type: "tool_call_delta", arguments: JSON.stringify(args) },
    { type: "tool_call_end" },
  ];
}

function makeContinuation() {
  const requests: OcxParsedRequest[] = [];
  const queues: AdapterEvent[][] = [];
  return {
    requests,
    queues,
    continuation: async (parsed: OcxParsedRequest): Promise<AsyncIterable<AdapterEvent>> => {
      requests.push(parsed);
      const events = queues.shift() ?? [{ type: "text_delta", text: "continued" }, { type: "done" }];
      return (async function* () { yield* events; })();
    },
  };
}

async function collect(generator: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

const baseParsed = (): OcxParsedRequest => parseRequest({
  model: "deepseek/deepseek-v4",
  stream: true,
  input: [{ role: "user", content: "task" }],
});

describe("createAdvisorGuard — manual advisor() interception", () => {
  test("holds the synthetic call, consults, reinjects advice, and re-dispatches the worker", async () => {
    const recorder = { consults: [] as { reason: string; question: string | undefined }[] };
    const { requests, continuation, queues } = makeContinuation();
    queues.push([{ type: "text_delta", text: "final answer" }, { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }]);
    const guard = createAdvisorGuard(planFrom(recorder));

    const events = await collect(guard({
      parsed: baseParsed(),
      firstEvents: (async function* () {
        yield { type: "text_delta", text: "Let me ask the expert." };
        yield* advisorCallEvents("a1");
        yield { type: "done", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
      })(),
      continuation,
    }));

    // The synthetic tool call NEVER reaches the client.
    expect(events.some(e => e.type === "tool_call_start" || e.type === "tool_call_delta" || e.type === "tool_call_end")).toBe(false);
    // Visible text and the internal boundary are preserved, and the continuation answer arrives.
    expect(events.some(e => e.type === "text_delta" && e.text === "Let me ask the expert.")).toBe(true);
    expect(events.some(e => e.type === "assistant_boundary")).toBe(true);
    expect(events.some(e => e.type === "text_delta" && e.text === "final answer")).toBe(true);

    // Exactly one consultation, with the worker's focus question.
    expect(recorder.consults).toEqual([{ reason: "manual", question: "what next?" }]);

    // The continuation request pairs the held call with the advice as tool result.
    expect(requests).toHaveLength(1);
    const messages = requests[0]!.context.messages;
    const assistant = messages.find(m => m.role === "assistant");
    expect(assistant && assistant.content.some(p => p.type === "toolCall" && p.name === "advisor" && p.id === "a1")).toBe(true);
    const result = messages.find(m => m.role === "toolResult");
    expect(result && result.toolCallId === "a1" && JSON.stringify(result.content).includes("advice body")).toBe(true);

    // Usage from the intercepted leg merges into the final terminal event.
    const done = events.find(e => e.type === "done") as { usage?: { inputTokens: number } };
    expect(done.usage?.inputTokens).toBe(110);
  });

  test("a real tool call in the same leg ends interception — the turn belongs to the client", async () => {
    const recorder = { consults: [] as { reason: string; question: string | undefined }[] };
    const { requests, continuation } = makeContinuation();
    const guard = createAdvisorGuard(planFrom(recorder));

    const events = await collect(guard({
      parsed: baseParsed(),
      firstEvents: (async function* () {
        yield* advisorCallEvents("a1");
        yield { type: "tool_call_start", id: "r1", name: "shell" };
        yield { type: "tool_call_delta", arguments: "{}" };
        yield { type: "tool_call_end" };
        yield { type: "done" };
      })(),
      continuation,
    }));

    expect(recorder.consults).toHaveLength(0);
    expect(requests).toHaveLength(0);
    // The REAL tool call passes through untouched.
    expect(events.some(e => e.type === "tool_call_start" && e.name === "shell")).toBe(true);
    expect(events.some(e => e.type === "done")).toBe(true);
  });

  test("consultations are bounded; past the bound the worker gets an explicit limit result", async () => {
    const recorder = { consults: [] as { reason: string; question: string | undefined }[] };
    const { requests, continuation, queues } = makeContinuation();
    for (let i = 0; i < 4; i += 1) {
      queues.push(i === 3
        ? [{ type: "text_delta", text: "done trying" }, { type: "done" }]
        : [{ type: "text_delta", text: "again" }, ...advisorCallEvents(`a${i + 1}`), { type: "done" }]);
    }
    const guard = createAdvisorGuard(planFrom(recorder));

    const events = await collect(guard({
      parsed: baseParsed(),
      firstEvents: (async function* () {
        yield* advisorCallEvents("a0");
        yield { type: "done" };
      })(),
      continuation,
    }));

    // Exactly the bound was consulted; the last call received the limit-reached result.
    expect(recorder.consults).toHaveLength(3);
    const allToolResults = requests.flatMap(r => r.context.messages.filter(m => m.role === "toolResult"));
    const last = allToolResults[allToolResults.length - 1]!;
    expect(String(last.content)).toContain("limit reached");
    expect(events.some(e => e.type === "text_delta" && e.text === "done trying")).toBe(true);
  });

  test("a failed leg (error/incomplete) surfaces as-is instead of building a continuation", async () => {
    const recorder = { consults: [] as { reason: string; question: string | undefined }[] };
    const { requests, continuation } = makeContinuation();
    const guard = createAdvisorGuard(planFrom(recorder));

    const events = await collect(guard({
      parsed: baseParsed(),
      firstEvents: (async function* () {
        yield* advisorCallEvents("a1");
        yield { type: "error", message: "upstream died" };
      })(),
      continuation,
    }));

    expect(recorder.consults).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(events.some(e => e.type === "error" && e.message === "upstream died")).toBe(true);
  });

  test("consultation failure still reinjects an explicit, non-misleading result", async () => {
    const recorder = { consults: [] as { reason: string; question: string | undefined }[] };
    const { requests, continuation, queues } = makeContinuation();
    queues.push([{ type: "text_delta", text: "carrying on" }, { type: "done" }]);
    const guard = createAdvisorGuard(planFrom({
      ...recorder,
      // The real failure shape from runConsultation: the unavailable envelope, NOT the advice
      // wrapper — a failure must never read back as genuine advice (which would suppress the
      // policy for this task).
      outcome: { ok: false, isError: true, content: "<opencodex_advisor_unavailable>\nunavailable\n</opencodex_advisor_unavailable>" },
    }));

    const events = await collect(guard({
      parsed: baseParsed(),
      firstEvents: (async function* () {
        yield* advisorCallEvents("a1");
        yield { type: "done" };
      })(),
      continuation,
    }));

    const result = requests[0]!.context.messages.find(m => m.role === "toolResult");
    expect(result && result.isError === true && String(result.content).includes("unavailable")).toBe(true);
    expect(events.some(e => e.type === "text_delta" && e.text === "carrying on")).toBe(true);
  });

  test("thinking and text produced before the call ride the rebuilt assistant message", async () => {
    const recorder = { consults: [] as { reason: string; question: string | undefined }[] };
    const { requests, continuation, queues } = makeContinuation();
    queues.push([{ type: "done" }]);
    const guard = createAdvisorGuard(planFrom(recorder));

    await collect(guard({
      parsed: baseParsed(),
      firstEvents: (async function* () {
        yield { type: "thinking_delta", thinking: "weighing options" };
        yield { type: "thinking_signature", signature: "sig-1" };
        yield { type: "text_delta", text: "Consulting." };
        yield* advisorCallEvents("a1");
        yield { type: "done" };
      })(),
      continuation,
    }));

    const assistant = requests[0]!.context.messages.find(m => m.role === "assistant");
    expect(assistant && assistant.content.some(p => p.type === "thinking" && p.thinking === "weighing options")).toBe(true);
    expect(assistant && assistant.content.some(p => p.type === "text" && p.text === "Consulting.")).toBe(true);
  });

  test("the second advisor call in one leg sees the first call's advice", async () => {
    const seen: string[] = [];
    const { requests, continuation, queues } = makeContinuation();
    queues.push([{ type: "done" }, { type: "text_delta", text: "both advised" }, { type: "done" }]);
    const plan: AdvisorPlan = {
      consult: async (parsed, _reason, question) => {
        // Record what the advisor can see at consult time.
        seen.push(JSON.stringify(parsed.context.messages));
        return ADVICE;
      },
      formatUnavailable: (kind, error) => `<opencodex_advisor_unavailable>\n${kind}: ${error}\n</opencodex_advisor_unavailable>`,
    };
    const guard = createAdvisorGuard(plan);

    await collect(guard({
      parsed: baseParsed(),
      firstEvents: (async function* () {
        yield* advisorCallEvents("a1", { question: "first?" });
        yield* advisorCallEvents("a2", { question: "second?" });
        yield { type: "done" };
      })(),
      continuation,
    }));

    expect(seen).toHaveLength(2);
    const first = JSON.parse(seen[0]!);
    const second = JSON.parse(seen[1]!);
    // Both calls live in ONE assistant message (two toolCall parts); the second consult
    // additionally sees the first call's advice toolResult.
    expect(second.length).toBe(first.length + 1);
    const secondStr = seen[1]!;
    expect(secondStr).toContain("a1");
    expect(secondStr).toContain("advice body");
  });

  test("empty-completion retry stream passes through advisor guard without leaking synthetic call", async () => {
    const recorder = { consults: [] as { reason: string; question: string | undefined }[] };
    const { requests, continuation, queues } = makeContinuation();
    queues.push([{ type: "text_delta", text: "recovered after retry" }, { type: "done" }]);
    const guard = createAdvisorGuard(planFrom(recorder));

    const retryStream = (async function* () {
      yield* advisorCallEvents("a_retry", { question: "how to retry?" });
      yield { type: "done" };
    })();

    const events = await collect(guard({
      parsed: baseParsed(),
      firstEvents: retryStream,
      continuation,
    }));

    expect(events.some(e => e.type === "tool_call_start" || e.type === "tool_call_delta" || e.type === "tool_call_end")).toBe(false);
    expect(events.some(e => e.type === "text_delta" && e.text === "recovered after retry")).toBe(true);
    expect(recorder.consults).toEqual([{ reason: "manual", question: "how to retry?" }]);
    expect(requests).toHaveLength(1);
  });
});
