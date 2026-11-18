import { describe, expect, test } from "bun:test";
import { parseRequest } from "../../src/responses/parser";
import { createAdvisorCallResolver, createAdvisorGuard, type AdvisorPlan, type AdvisorConsultOutcome } from "../../src/server/responses/advisor-slot";
import { guardEmptyCompletionEventStream } from "../../src/server/responses/empty-completion-guard";
import { scanEventsForWebSearch } from "../../src/web-search/loop";
import type { AdapterEvent, OcxParsedRequest, OcxToolChoice } from "../../src/types";

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

describe("caller-owned Advisor delivery policy", () => {
  const aliases = [
    { name: "advisor", namespace: undefined },
    { name: "work__advisor", namespace: "work" },
    { name: "work.advisor", namespace: "work" },
    { name: "functions.advisor", namespace: "functions" },
    { name: "functions__advisor", namespace: "functions" },
    { name: "default.work__advisor", namespace: "work" },
  ];
  const advisor = { type: "function", name: "advisor", parameters: { type: "object" } };
  const modes = ["streaming", "buffered", "empty-completion retry", "fetch search"] as const;

  test.each(modes.flatMap(mode => aliases.map(alias => ({ mode, ...alias }))))(
    "retains no denied call fields in %j",
    async ({ mode, name, namespace }) => {
      const parsed = parseRequest({ model: "worker", input: "task", stream: mode !== "buffered",
        tools: [namespace ? { type: "namespace", name: namespace, tools: [advisor] } : advisor],
        tool_choice: { type: "web_search" },
      });
      expect(parsed.options.toolChoice).toBe("auto");
      const resolve = createAdvisorCallResolver(parsed, false);
      expect(resolve(name)).toBe("refused");

      const workerEvents: AdapterEvent[] = [
        { type: "tool_call_start", id: "fixture-call-field", name },
        { type: "tool_call_delta", arguments: '{"question":"fixture-argument-field"}' },
        { type: "tool_call_end" },
        { type: "done" },
      ];
      const recorder = { consults: [] };
      const { requests, continuation } = makeContinuation();
      const guard = createAdvisorGuard(planFrom(recorder));
      const guarded = () => guard({ parsed, continuation, firstEvents: (async function* () { yield* workerEvents; })() });
      let events: AdapterEvent[];
      if (mode === "fetch search") {
        const split = scanEventsForWebSearch(workerEvents, resolve);
        expect(split.calls).toEqual([]);
        events = split.passthrough;
      } else if (mode === "empty-completion retry") {
        events = await collect(guardEmptyCompletionEventStream({
          firstEvents: (async function* (): AsyncGenerator<AdapterEvent> { yield { type: "done" }; })(),
          continuation: guarded,
          preserveRetryError: event => event.type === "error" && event.code === "undeclared_tool_call",
        }));
      } else {
        events = await collect(guarded());
      }
      expect(events.at(-1)).toMatchObject({ type: "error", code: "undeclared_tool_call" });
      expect(events.some(event => event.type.startsWith("tool_call"))).toBe(false);
      expect(JSON.stringify(events)).not.toContain("fixture-call-field");
      expect(JSON.stringify(events)).not.toContain("fixture-argument-field");
      expect(recorder.consults).toEqual([]);
      expect(requests).toEqual([]);
    },
  );

  test.each(["auto", "required", { type: "custom", name: "advisor" }])(
    "allows the matching caller tool under %j",
    tool_choice => {
      const parsed = parseRequest({ model: "worker", input: "task", tool_choice,
        tools: [{ type: "custom", name: "advisor" }] });
      const resolve = createAdvisorCallResolver(parsed, false);
      for (const name of ["advisor", "functions.advisor"]) {
        expect(resolve(name)).toEqual({ clientWireName: "advisor" });
        const split = scanEventsForWebSearch([
          { type: "tool_call_start", id: "client-call", name },
          { type: "tool_call_delta", arguments: '{"input":"client-tool-input"}' },
          { type: "tool_call_end" },
          { type: "done" },
        ], resolve);
        expect(split.calls).toEqual([]);
        expect(split.hasRealToolCall).toBe(true);
        expect(split.passthrough[0]).toMatchObject({ type: "tool_call_start", name: "advisor", id: "client-call" });
      }
    },
  );

  test("keeps an unrelated exact wire name distinct from an Advisor alias", () => {
    const parsed = parseRequest({ model: "worker", input: "task", tool_choice: { type: "web_search" },
      tools: [{ type: "namespace", name: "work", tools: [advisor] }, { ...advisor, name: "work.advisor" }],
    });
    const resolve = createAdvisorCallResolver(parsed, false);
    expect(resolve("work.advisor")).toBeUndefined();
    expect(resolve("work__advisor")).toBe("refused");
  });
});

describe("createAdvisorGuard — manual advisor() interception", () => {
  test.each([
    { type: "web_search" },
    { type: "custom", name: "advisor" },
    { type: "allowed_tools", mode: "auto", tools: [{ type: "web_search", name: "advisor" }] },
  ])("translated choice %j cannot authorize Advisor on a later worker leg", async tool_choice => {
    const recorder = { consults: [] as { reason: string; question: string | undefined }[] };
    const denied = parseRequest({ model: "worker", input: "task", stream: true, tool_choice });
    const calls = async function* (): AsyncGenerator<AdapterEvent> {
      yield* advisorCallEvents("worker-call");
      yield { type: "done" };
    };
    let continuations = 0;
    const events = await collect(createAdvisorGuard(planFrom(recorder))({ parsed: baseParsed(), firstEvents: calls(),
      continuation: parsed => {
        continuations++;
        parsed.options = denied.options;
        return calls();
      },
    }));
    expect(recorder.consults).toHaveLength(1);
    expect(continuations).toBe(1);
    expect(events.some(event => event.type.startsWith("tool_call"))).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "undeclared_tool_call" });
  });

  for (const choice of ["none", { name: "shell" }, { allowedTools: ["shell"], mode: "auto" },
    { allowedTools: [], mode: "required" }, { name: "other.advisor" }] satisfies OcxToolChoice[]) {
    test(`a guard cannot consult outside the effective tool choice: ${JSON.stringify(choice)}`, async () => {
      const recorder = { consults: [] as { reason: string; question: string | undefined }[] };
      const { requests, continuation } = makeContinuation();
      const parsed = baseParsed();
      parsed.options.toolChoice = choice;
      parsed.context.tools = [{ name: "shell", parameters: {} }, { name: "advisor", namespace: "work", parameters: {} }];
      const events = await collect(createAdvisorGuard(planFrom(recorder))({ parsed, continuation,
        firstEvents: (async function* () { yield* advisorCallEvents("private-forbidden-call"); yield { type: "done" }; })(),
      }));
      expect(recorder.consults).toEqual([]);
      expect(requests).toEqual([]);
      expect(events.some(event => event.type.startsWith("tool_call"))).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "error", status: 502, code: "undeclared_tool_call" });
    });
  }

  for (const ambiguous of [false, true]) {
    test(`a caller-owned bare Advisor alias requires one authorized identity (ambiguous=${ambiguous})`, async () => {
      const recorder = { consults: [] as { reason: string; question: string | undefined }[] };
      const { requests, continuation } = makeContinuation();
      const parsed = baseParsed();
      parsed.options.toolChoice = { allowedTools: ["work.advisor", "other.advisor"], mode: "auto" };
      parsed.context.tools = [{ name: "advisor", namespace: "work", parameters: {} },
        ...(ambiguous ? [{ name: "advisor", namespace: "other", parameters: {} }] : [])];
      const events = await collect(createAdvisorGuard(planFrom(recorder))({ parsed, continuation,
        firstEvents: (async function* () { yield* advisorCallEvents("client-call"); yield { type: "done" }; })(),
      }));
      expect(recorder.consults).toEqual([]);
      expect(requests).toEqual([]);
      expect(events.some(event => event.type === "tool_call_start")).toBe(!ambiguous);
      expect(events.at(-1)?.type).toBe(ambiguous ? "error" : "done");
    });
  }

  for (const choice of ["auto", "required", { name: "advisor" }, { allowedTools: ["advisor"], mode: "auto" }] satisfies OcxToolChoice[]) {
    test(`an authorized synthetic Advisor remains usable: ${JSON.stringify(choice)}`, async () => {
      const recorder = { consults: [] as { reason: string; question: string | undefined }[] };
      const { requests, continuation } = makeContinuation();
      const parsed = baseParsed();
      parsed.options.toolChoice = choice;
      const events = await collect(createAdvisorGuard(planFrom(recorder))({ parsed, continuation,
        firstEvents: (async function* () { yield* advisorCallEvents("allowed-call"); yield { type: "done" }; })(),
      }));
      expect(recorder.consults).toHaveLength(1);
      expect(requests).toHaveLength(1);
      expect(events.some(event => event.type.startsWith("tool_call"))).toBe(false);
      expect(events.at(-1)?.type).toBe("done");
    });
  }

  test("a continuation that disables tools cannot reuse earlier Advisor permission", async () => {
    const recorder = { consults: [] as { reason: string; question: string | undefined }[] };
    let continuations = 0;
    const calls = async function* (): AsyncGenerator<AdapterEvent> { yield* advisorCallEvents("advisor-call"); yield { type: "done" }; };
    const events = await collect(createAdvisorGuard(planFrom(recorder))({ parsed: baseParsed(), firstEvents: calls(),
      continuation: parsed => { continuations++; parsed.options.toolChoice = "none"; return calls(); },
    }));
    expect(recorder.consults).toHaveLength(1);
    expect(continuations).toBe(1);
    expect(events.some(event => event.type.startsWith("tool_call"))).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", status: 502, code: "undeclared_tool_call" });
  });

  test("buffered forbidden Advisor usage includes the rejected leg once after an earlier consultation", async () => {
    const recorder = { consults: [] as { reason: string; question: string | undefined }[] };
    const parsed = baseParsed();
    parsed.stream = false;
    let continuations = 0;
    const events = await collect(createAdvisorGuard(planFrom(recorder))({ parsed,
      firstEvents: (async function* () {
        yield* advisorCallEvents("allowed-call");
        yield { type: "done", usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 } };
      })(),
      continuation: next => {
        continuations++;
        next.options.toolChoice = "none";
        return (async function* () {
          yield* advisorCallEvents("forbidden-call");
          yield { type: "text_delta", text: "private rejected suffix" };
          yield { type: "done", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
        })();
      },
    }));
    expect(recorder.consults).toHaveLength(1);
    expect(continuations).toBe(1);
    expect(events.some(event => event.type.startsWith("tool_call") || event.type === "text_delta")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "undeclared_tool_call",
      usage: { inputTokens: 111, outputTokens: 23, totalTokens: 134 } });
  });

  test("a forbidden streaming Advisor call does not drain the upstream for usage", async () => {
    const recorder = { consults: [] as { reason: string; question: string | undefined }[] };
    const parsed = baseParsed();
    parsed.options.toolChoice = "none";
    let suffixRead = false, closed = false;
    const { requests, continuation } = makeContinuation();
    const events = await collect(createAdvisorGuard(planFrom(recorder))({ parsed, continuation,
      firstEvents: (async function* (): AsyncGenerator<AdapterEvent> {
        try {
          yield { type: "tool_call_start", id: "private-call", name: "advisor" };
          suffixRead = true;
          yield { type: "done", usage: { inputTokens: 100, outputTokens: 20 } };
        } finally { closed = true; }
      })(),
    }));
    expect(suffixRead).toBe(false);
    expect(closed).toBe(true);
    expect(recorder.consults).toEqual([]);
    expect(requests).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "undeclared_tool_call" });
  });

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
        yield { type: "text_delta", text: "Consulting.", phase: "commentary", anthropicThinkingSignature: "ProgressSignature123456==" };
        yield* advisorCallEvents("a1");
        yield { type: "done" };
      })(),
      continuation,
    }));

    const assistant = requests[0]!.context.messages.find(m => m.role === "assistant");
    expect(assistant && assistant.content.some(p => p.type === "thinking" && p.thinking === "weighing options")).toBe(true);
    expect(assistant && assistant.content.some(p => p.type === "thinking" && p.thinking === "Consulting." && p.signature === "ProgressSignature123456==")).toBe(true);
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
