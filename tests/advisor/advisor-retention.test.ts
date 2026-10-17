import { expect, test } from "bun:test";
import { createAdvisorGuard } from "../../src/server/responses/advisor-slot";
import { MAX_ADVISOR_RETAINED_CALLS, MAX_ADVISOR_RETAINED_EVENTS } from "../../src/server/responses/advisor-retention";
import { createTranslatorBudget, retainTranslatedEvent, releaseTranslatedEvent, TRANSLATOR_MAX_CALL_ARGUMENT_BYTES, type TranslatorBudget } from "../../src/lib/translator-budget";
import { parseRequest } from "../../src/responses/parser";
import { usageFromOpenAIChat } from "../../src/adapters/openai-chat/response-events";
import type { AdapterEvent, OcxParsedRequest, OcxProviderOpaqueToolCallMetadata } from "../../src/types";

const done: AdapterEvent = { type: "done" };
const overflow = { type: "error", status: 502, errorType: "upstream_error", code: "translation_buffer_limit" };
const parsed = () => parseRequest({ model: "worker", input: "fixture", stream: true });
const stream = (events: AdapterEvent[]) => (async function* () { yield* events; })();
function* call(id: string, args = "{}", metadata?: OcxProviderOpaqueToolCallMetadata): Generator<AdapterEvent> {
  yield { type: "tool_call_start", id, name: "advisor", ...(metadata ? { providerMetadata: metadata } : {}) };
  yield { type: "tool_call_delta", arguments: args };
  yield { type: "tool_call_end" };
}
async function run(firstEvents: AsyncIterable<AdapterEvent>, budget?: TranslatorBudget, continuation?: (next: OcxParsedRequest) => AsyncIterable<AdapterEvent>) {
  const requests: OcxParsedRequest[] = [];
  const questions: (string | undefined)[] = [];
  const guard = createAdvisorGuard({
    consult: async (_next, _reason, question) => { questions.push(question); return { ok: true, isError: false, content: "advice" }; },
    formatUnavailable: () => "limit result",
  });
  const events: AdapterEvent[] = [];
  for await (const event of guard({ parsed: parsed(), firstEvents, translatorBudget: budget, continuation: next => {
    requests.push(next);
    return continuation?.(next) ?? stream([{ type: "text_delta", text: "answer" }, done]);
  } })) events.push(event);
  return { events, requests, questions };
}

test("parser call release cannot free the Advisor's retained argument copies", async () => {
  const budget = createTranslatorBudget({ maxTurnBytes: 2_048 });
  let closed = 0;
  const first = (async function* () {
    for (let i = 0; i < 8; i++) {
      const id = `c${i}`;
      budget.openCall(id);
      try {
        yield { type: "tool_call_start", id, name: "advisor" } as AdapterEvent;
        budget.chargeRetained(500, { kind: "tool_args", callId: id });
        yield { type: "tool_call_delta", arguments: " ".repeat(500) } as AdapterEvent;
      } finally { budget.closeCall(id); closed++; }
      yield { type: "tool_call_end" } as AdapterEvent;
    }
    yield done;
  })();
  try {
    const result = await run(first, budget);
    expect(result.events.at(-1)).toMatchObject(overflow);
    expect(result.questions).toHaveLength(0);
    expect(closed).toBeGreaterThan(1);
    expect(budget.snapshot().currentBytes).toBe(0);
    expect(budget.snapshot().activeCalls).toBe(0);
    expect(budget.snapshot().highWaterBytes).toBeLessThanOrEqual(2_048);
  } finally { budget.dispose(); }
});

test("legitimate multi-call batches preserve questions and every excess call's paired result", async () => {
  const budget = createTranslatorBudget();
  budget.chargeRetained(37, { kind: "retained_collectors" });
  budget.chargeRetained(41, { kind: "request_copies" });
  try {
    const result = await run(stream([
      { type: "thinking_delta", thinking: "reason" }, { type: "thinking_signature", signature: "signature" },
      { type: "redacted_thinking", data: "opaque" }, { type: "text_delta", text: "before" },
      ...Array.from({ length: 5 }, (_, i) => [...call(`c${i}`, JSON.stringify({ question: `질문 ${i} 😀` }))]).flat(), done,
    ]), budget, next => {
      expect(budget.snapshot().currentBytes).toBeGreaterThan(78);
      expect(next.context.messages.filter(m => m.role === "toolResult")).toHaveLength(5);
      return stream([done]);
    });
    expect(result.questions).toEqual(["질문 0 😀", "질문 1 😀", "질문 2 😀"]);
    expect(result.requests).toHaveLength(1);
    const assistant = result.requests[0]!.context.messages.find(m => m.role === "assistant");
    expect(assistant?.content).toContainEqual({ type: "thinking", thinking: "reason", signature: "signature" });
    expect(assistant?.content).toContainEqual({ type: "thinking", thinking: "", redacted: ["opaque"] });
    expect(result.requests[0]!.context.messages.filter(m => m.role === "toolResult").slice(-2).map(m => m.content)).toEqual(["limit result", "limit result"]);
    expect(budget.snapshot().currentBytes).toBe(78);
  } finally { budget.dispose(); }
});

test.each(["thinking_signature", "redacted_thinking", "tool_call_delta"] as const)("empty %s fragments have count admission without a shared budget", async type => {
  const first = (async function* () {
    if (type === "tool_call_delta") yield { type: "tool_call_start", id: "c", name: "advisor" } as AdapterEvent;
    for (let i = 0; i <= MAX_ADVISOR_RETAINED_EVENTS; i++) {
      yield ({ type, ...(type === "thinking_signature" ? { signature: "" } : type === "redacted_thinking" ? { data: "" } : { arguments: "" }) }) as AdapterEvent;
    }
    yield done;
  })();
  expect((await run(first)).events.at(-1)).toMatchObject(overflow);
});

test("ordinary token-sized text and thinking deltas never exhaust the event count", async () => {
  const deltas = (n: number): AdapterEvent[] => Array.from({ length: n }, (_, i) =>
    (i % 2 ? { type: "text_delta", text: "abcd" } : { type: "thinking_delta", thinking: "abcd" }) as AdapterEvent);
  const empty = Array.from({ length: MAX_ADVISOR_RETAINED_EVENTS + 1 }, (_, i) =>
    (i % 2 ? { type: "text_delta", text: "" } : { type: "thinking_delta", thinking: "" }) as AdapterEvent);
  // A plain answer passes through untouched.
  const plain = await run(stream([...deltas(MAX_ADVISOR_RETAINED_EVENTS * 2), ...empty, done]));
  expect(plain.events.at(-1)).toEqual(done);
  expect(plain.requests).toHaveLength(0);
  // A long leg that ends in an advisor call still gets its consultation and continuation.
  const advised = await run(stream([...deltas(MAX_ADVISOR_RETAINED_EVENTS * 2), ...call("c", '{"question":"q"}'), done]));
  expect(advised.questions).toEqual(["q"]);
  expect(advised.requests).toHaveLength(1);
  expect(advised.events.some(event => event.type === "error")).toBe(false);
});

test("closed calls have a separate count limit, including empty arguments", async () => {
  const events = Array.from({ length: MAX_ADVISOR_RETAINED_CALLS + 1 }, (_, i) => [
    { type: "tool_call_start", id: String(i), name: "advisor" }, { type: "tool_call_end" },
  ] as AdapterEvent[]).flat();
  expect((await run(stream([...events, done]))).events.at(-1)).toMatchObject(overflow);
});

test.each(["arguments", "signature", "redacted", "metadata"])("%s bytes are admitted before retention", async representation => {
  const budget = createTranslatorBudget({ maxTurnBytes: 512 });
  const payload = "😀\\\"".repeat(180);
  const metadata = { fixture: payload } as unknown as OcxProviderOpaqueToolCallMetadata;
  const first: AdapterEvent[] = representation === "arguments" ? [...call("c", payload)]
    : representation === "signature" ? [{ type: "thinking_signature", signature: payload }]
    : representation === "redacted" ? [{ type: "redacted_thinking", data: payload }]
    : [...call("c", "{}", metadata)];
  try {
    const result = await run(stream([...first, done]), budget);
    expect(result.events.at(-1)).toMatchObject(overflow);
    expect(result.questions).toHaveLength(0);
    expect(budget.snapshot().currentBytes).toBe(0);
  } finally { budget.dispose(); }
});

test("per-call admission is independent of a permissive shared budget", async () => {
  const first = stream([
    { type: "tool_call_start", id: "c", name: "advisor" },
    { type: "tool_call_delta", arguments: " ".repeat(TRANSLATOR_MAX_CALL_ARGUMENT_BYTES / 2) },
    { type: "tool_call_delta", arguments: " ".repeat(TRANSLATOR_MAX_CALL_ARGUMENT_BYTES / 2) },
    { type: "tool_call_delta", arguments: "x" }, done,
  ]);
  expect((await run(first)).events.at(-1)).toMatchObject(overflow);
});

test.each([1, 2])("an exact-limit argument in %s fragment(s) is accepted", async fragments => {
  const first = (async function* () {
    yield { type: "tool_call_start", id: "c", name: "advisor" } as AdapterEvent;
    for (let i = 0; i < fragments; i++) {
      yield { type: "tool_call_delta", arguments: " ".repeat(TRANSLATOR_MAX_CALL_ARGUMENT_BYTES / fragments) } as AdapterEvent;
    }
    yield { type: "tool_call_end" } as AdapterEvent;
    yield done;
  })();
  const result = await run(first);
  expect(result.events.at(-1)).toEqual(done);
  expect(result.questions).toHaveLength(1);
});

test("a single argument fragment one byte over the limit is rejected", async () => {
  const result = await run(stream([...call("c", " ".repeat(TRANSLATOR_MAX_CALL_ARGUMENT_BYTES + 1)), done]));
  expect(result.events.at(-1)).toMatchObject(overflow);
  expect(result.questions).toHaveLength(0);
});

test("aggregate retention is bounded independently of parser call release or shared budget", async () => {
  const first = (async function* () {
    for (let i = 0; i < 34; i++) yield* call(String(i), " ".repeat(1024 * 1024));
    yield done;
  })();
  const result = await run(first);
  expect(result.events.at(-1)).toMatchObject(overflow);
  expect(result.questions).toHaveLength(0);
});

test("real tool arguments pass through without retained copies, and discard the replay leg", async () => {
  const budget = createTranslatorBudget({ maxTurnBytes: 256 });
  const real: AdapterEvent[] = [
    { type: "tool_call_start", id: "real", name: "shell" },
    { type: "tool_call_delta", arguments: "x".repeat(4_096) }, { type: "tool_call_end" }, done,
  ];
  try {
    const result = await run(stream([{ type: "text_delta", text: "visible" }, ...real]), budget);
    expect(result.events.slice(1)).toEqual(real);
    expect(result.requests).toHaveLength(0);
    expect(budget.snapshot().currentBytes).toBe(0);
  } finally { budget.dispose(); }
});

test("replay construction charges overlapping raw and new representations", async () => {
  const budget = createTranslatorBudget({ maxTurnBytes: 1_000 });
  try {
    const result = await run(stream([...call("c", JSON.stringify({ question: "x".repeat(300) })), done]), budget);
    expect(result.events.at(-1)).toMatchObject(overflow);
    expect(result.questions).toHaveLength(0);
    expect(budget.snapshot().currentBytes).toBe(0);
  } finally { budget.dispose(); }
});

test("a bridge lease on the same event remains owned and releasable by the bridge", async () => {
  const budget = createTranslatorBudget();
  const event: AdapterEvent = { type: "text_delta", text: "shared event" };
  retainTranslatedEvent(event, budget);
  const initial = budget.snapshot().currentBytes;
  try {
    expect((await run(stream([event, done]), budget)).events).toEqual([event, done]);
    expect(budget.snapshot().currentBytes).toBe(initial);
    releaseTranslatedEvent(event, budget);
    expect(budget.snapshot().currentBytes).toBe(0);
  } finally { budget.dispose(); }
});

test("replay history stays charged while a later leg fails admission", async () => {
  const budget = createTranslatorBudget({ maxTurnBytes: 2_048 });
  let beforeSecondLeg = 0;
  try {
    const result = await run(stream([...call("c"), done]), budget, () => {
      beforeSecondLeg = budget.snapshot().currentBytes;
      return stream([{ type: "redacted_thinking", data: "x".repeat(2_000) }, done]);
    });
    expect(beforeSecondLeg).toBeGreaterThan(0);
    expect(result.events.at(-1)).toMatchObject(overflow);
    expect(budget.snapshot().currentBytes).toBe(0);
  } finally { budget.dispose(); }
});

test.each(["cached_tokens", "reasoning_tokens"])("retained OpenAI Chat %s usage prevents later argument over-admission", async field => {
  for (const withUsage of [false, true]) {
    const budget = createTranslatorBudget({ maxTurnBytes: 6_000 });
    const payload = "u".repeat(1_200);
    const usage = withUsage ? usageFromOpenAIChat({
      [field === "cached_tokens" ? "prompt_tokens_details" : "completion_tokens_details"]: { [field]: payload },
    }) : undefined;
    let admitted = false;
    let retainedAtContinuation = 0;
    try {
      const result = await run(stream([...call("first"), { type: "done", usage }]), budget, () => {
        retainedAtContinuation = budget.snapshot().currentBytes;
        return (async function* () {
          yield { type: "tool_call_start", id: "second", name: "advisor" } as AdapterEvent;
          yield { type: "tool_call_delta", arguments: " ".repeat(4_600) } as AdapterEvent;
          admitted = true;
          yield { type: "tool_call_end" } as AdapterEvent;
          // A real call ends replay retention so the control does not need a second reconstruction.
          yield { type: "tool_call_start", id: "real", name: "shell" } as AdapterEvent;
          yield { type: "tool_call_end" } as AdapterEvent;
          yield done;
        })();
      });
      expect(admitted).toBe(!withUsage);
      if (withUsage) {
        expect(retainedAtContinuation).toBeGreaterThan(payload.length);
        expect(result.events.at(-1)).toMatchObject(overflow);
      } else expect(result.events.at(-1)?.type).toBe("done");
      expect(result.requests).toHaveLength(1);
      expect(budget.snapshot().currentBytes).toBe(0);
      expect(budget.snapshot().highWaterBytes).toBeLessThanOrEqual(6_000);
    } finally { budget.dispose(); }
  }
});

test.each(["done", "error", "incomplete"] as const)("normal numeric usage is merged and released on final %s", async terminal => {
  const budget = createTranslatorBudget();
  const first = usageFromOpenAIChat({ prompt_tokens: 2, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 1 } });
  const second = usageFromOpenAIChat({ prompt_tokens: 5, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 4 } });
  try {
    const result = await run(stream([...call("c"), { type: "done", usage: first }]), budget,
      () => stream([{ type: terminal, usage: second } as AdapterEvent]));
    expect(result.events.at(-1)).toMatchObject({ type: terminal, usage: {
      inputTokens: 7, outputTokens: 10, totalTokens: 17, cachedInputTokens: 1, reasoningOutputTokens: 4,
    } });
    expect(budget.snapshot().currentBytes).toBe(0);
  } finally { budget.dispose(); }
});

test("absent later usage preserves the admitted usage reference until iterator close", async () => {
  const budget = createTranslatorBudget();
  const usage = usageFromOpenAIChat({ prompt_tokens_details: { cached_tokens: "x".repeat(400) } });
  const guard = createAdvisorGuard({ consult: async () => ({ ok: true, isError: false, content: "advice" }), formatUnavailable: () => "limit" });
  const iterator = guard({ parsed: parsed(), translatorBudget: budget,
    firstEvents: stream([...call("c"), { type: "done", usage }]), continuation: () => stream([done]),
  });
  try {
    expect((await iterator.next()).value).toEqual({ type: "assistant_boundary" });
    const terminal = (await iterator.next()).value;
    expect(terminal).toMatchObject({ type: "done", usage });
    expect(terminal && "usage" in terminal ? terminal.usage : undefined).toBe(usage);
    expect(budget.snapshot().currentBytes).toBeGreaterThan(400);
    await iterator.return();
    expect(budget.snapshot().currentBytes).toBe(0);
  } finally { await iterator.return(); budget.dispose(); }
});

test("a usage merge refusal keeps the previous owner for one content-free budget error", async () => {
  const budget = createTranslatorBudget({ maxTurnBytes: 6_000 });
  const first = usageFromOpenAIChat({ prompt_tokens_details: { cached_tokens: "x".repeat(1_200) } });
  const second = usageFromOpenAIChat({ completion_tokens_details: { reasoning_tokens: "y".repeat(2_000) } });
  try {
    const result = await run(stream([...call("c"), { type: "done", usage: first }]), budget,
      () => stream([{ type: "incomplete", usage: second } as AdapterEvent]));
    expect(result.events.filter(event => event.type === "error")).toHaveLength(1);
    expect(result.events.at(-1)).toMatchObject(overflow);
    const error = result.events.at(-1);
    expect(error && "usage" in error ? error.usage : undefined).toBe(first);
    expect(error && "message" in error ? error.message : undefined).toBe("upstream translation buffer exceeded the safe limit");
    expect(budget.snapshot().currentBytes).toBe(0);
  } finally { budget.dispose(); }
});

test("a successful usage replacement releases the previous large owner before the next leg", async () => {
  const budget = createTranslatorBudget({ maxTurnBytes: 6_000 });
  const first = usageFromOpenAIChat({ prompt_tokens_details: { cached_tokens: "x".repeat(1_200) } });
  const second = usageFromOpenAIChat({ prompt_tokens: 3, completion_tokens: 4 });
  let legs = 0;
  try {
    const result = await run(stream([...call("first"), { type: "done", usage: first }]), budget, () => {
      if (++legs === 1) {
        expect(budget.snapshot().currentBytes).toBeGreaterThan(1_200);
        return stream([...call("second"), { type: "done", usage: second }]);
      }
      expect(budget.snapshot().currentBytes).toBeLessThan(1_200);
      return stream([done]);
    });
    expect(legs).toBe(2);
    expect(result.events.at(-1)).toEqual({ type: "done", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } });
    expect(budget.snapshot().currentBytes).toBe(0);
  } finally { budget.dispose(); }
});

test.each(["error", "incomplete", "throw", "abort", "close", "boundary", "continuation-throw"])("owned reservations release on %s", async exit => {
  const budget = createTranslatorBudget();
  budget.chargeRetained(17, { kind: "retained_collectors" });
  let sourceClosed = false;
  let dispatched = false;
  const first = (async function* () {
    try {
      if (exit === "boundary" || exit === "continuation-throw") { yield* call("c"); yield done; return; }
      yield { type: "text_delta", text: "held" } as AdapterEvent;
      if (exit === "throw") throw new Error("fixture source");
      if (exit === "abort") throw new DOMException("fixture abort", "AbortError");
      yield { type: exit === "incomplete" ? "incomplete" : "error", message: "fixture" } as AdapterEvent;
    } finally { sourceClosed = true; }
  })();
  const guard = createAdvisorGuard({ consult: async () => ({ ok: true, isError: false, content: "advice" }), formatUnavailable: () => "limit" });
  const iterator = guard({ parsed: parsed(), firstEvents: first, translatorBudget: budget, continuation: () => {
    dispatched = true;
    throw new Error("fixture continuation");
  } });
  try {
    if (exit === "close") { await iterator.next(); await iterator.return(); }
    else if (exit === "boundary") {
      expect((await iterator.next()).value).toEqual({ type: "assistant_boundary" });
      expect(budget.snapshot().currentBytes).toBeGreaterThan(17);
      await iterator.return();
      expect(dispatched).toBe(false);
    } else if (exit === "throw") { await expect(async () => { for await (const _event of iterator) {} }).toThrow("fixture source"); }
    else if (exit === "abort") { await expect(async () => { for await (const _event of iterator) {} }).toThrow("fixture abort"); }
    else { for await (const _event of iterator) {} }
    expect(sourceClosed).toBe(true);
    expect(budget.snapshot().currentBytes).toBe(17);
  } finally { await iterator.return(); budget.dispose(); }
});
