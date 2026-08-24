import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { createCommandCodeAdapter } from "../src/adapters/command-code";
import { createGoogleAdapter } from "../src/adapters/google";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import { createTranslatorBudget, translatorObservedBufferSnapshot } from "../src/lib/translator-budget";
import type { AdapterEvent, OcxProviderConfig } from "../src/types";

/**
 * `JSON.parse("null")` returns `null` without throwing, so a `try/catch` around a body parse
 * cannot see it. #1240 closed that at the SSE *frame* root for the four SSE parsers. Two rungs
 * were never swept, because neither is an SSE frame parser:
 *
 *   - the BUFFERED body root, on the `parseResponse` path reached from
 *     `src/server/responses/core.ts` for non-streaming turns;
 *   - the NDJSON frame root in the Command Code transport.
 *
 * And inside a well-formed anthropic body, `content` was consumed unchecked, so the #1332/#2232
 * nested-shape ladder was open there too.
 *
 * Every assertion below is written as PARITY against a control that was already handled correctly
 * — an unparseable body, or the same field on a sibling adapter — so the test states the actual
 * requirement rather than re-encoding each adapter's exact wording and drifting when it changes.
 */

// Valid JSON that does not deserialize to a record. Only `null` ever threw; property access on a
// number, string, boolean or array is legal JS, so those were silently accepted as empty bodies.
// Both are wrong for the same reason, so they are asserted together.
const NON_RECORD_BODIES = ["null", "42", '"text"', "true", "[]", "[null]"] as const;

// The syntactically-invalid control, correct before this change on every adapter here.
const INVALID_JSON_BODY = "{not json}";

const googleProvider = { adapter: "google", baseUrl: "https://example.test/v1", apiKey: "k", authMode: "key" } as OcxProviderConfig;
const anthropicProvider = { adapter: "anthropic", baseUrl: "https://example.test/v1", apiKey: "k", authMode: "key" } as OcxProviderConfig;
const commandCodeProvider: OcxProviderConfig = { adapter: "command-code", baseUrl: "https://api.command.example", apiKey: "k" };
const openAIChatProvider = { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "k", authMode: "key" } as OcxProviderConfig;

function jsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

function ndjsonResponse(lines: string[]): Response {
  return new Response(lines.map(l => `${l}\n`).join(""), {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

function errorEvent(events: AdapterEvent[]): Extract<AdapterEvent, { type: "error" }> | undefined {
  return events.find(e => e.type === "error") as Extract<AdapterEvent, { type: "error" }> | undefined;
}

function text(events: AdapterEvent[]): string {
  return events.flatMap(e => (e.type === "text_delta" ? [e.text] : [])).join("");
}

describe("google parseResponse: buffered body root", () => {
  const parse = (body: string) =>
    createGoogleAdapter(googleProvider).parseResponse!(jsonResponse(body), createTestTranslatorBudget());

  test("an unparseable body reports a structured error (control)", async () => {
    const events = await parse(INVALID_JSON_BODY);
    expect(errorEvent(events)).toBeDefined();
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test.each(NON_RECORD_BODIES)("a valid-JSON non-record body (%s) is treated like the control", async body => {
    // Before the guard, `null` threw `null is not an object (evaluating 'raw.error')` out of
    // parseResponse; the others reached `json.candidates` as `undefined` and reported "no
    // candidates". Both now fail closed the same way an unparseable body does.
    const events = await parse(body);
    expect(errorEvent(events)).toBeDefined();
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("the value type is named, so a log distinguishes the shapes", async () => {
    expect(errorEvent(await parse("null"))?.message).toContain("null");
    expect(errorEvent(await parse("[]"))?.message).toContain("array");
  });

  test("a healthy body is unaffected", async () => {
    const events = await parse(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "PONG" }] }, finishReason: "STOP" }],
    }));
    expect(text(events)).toBe("PONG");
    expect(events.some(e => e.type === "done")).toBe(true);
  });
});

describe("anthropic parseResponse: buffered body root", () => {
  const parse = (body: string) =>
    createAnthropicAdapter(anthropicProvider).parseResponse!(jsonResponse(body), createTestTranslatorBudget());

  test.each(NON_RECORD_BODIES)("a valid-JSON non-record body (%s) fails closed", async body => {
    // `response.json()` resolves a body of `null` to `null`, and the cast reached `json.content`
    // on it. The rest were accepted as an empty successful turn.
    const events = await parse(body);
    expect(errorEvent(events)).toBeDefined();
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("a healthy body is unaffected", async () => {
    const events = await parse(JSON.stringify({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "PONG" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 3 },
    }));
    expect(text(events)).toBe("PONG");
    expect(events.some(e => e.type === "done")).toBe(true);
  });
});

describe("anthropic parseResponse: content container and blocks", () => {
  const parseContent = (contentLiteral: string) =>
    createAnthropicAdapter(anthropicProvider).parseResponse!(
      jsonResponse(`{"type":"message","role":"assistant","content":${contentLiteral},"stop_reason":"end_turn"}`),
      createTestTranslatorBudget(),
    );

  // Absence is a legitimate contract and both encodings of it must keep working. Tightening the
  // container must not delete this, exactly as the google guards left `parts: null` alone.
  test.each(["undefined-omitted", "null", "[]"])("absence encoding %s still completes the turn", async encoding => {
    const events = encoding === "undefined-omitted"
      ? await createAnthropicAdapter(anthropicProvider).parseResponse!(
          jsonResponse('{"type":"message","role":"assistant","stop_reason":"end_turn"}'),
          createTestTranslatorBudget(),
        )
      : await parseContent(encoding);
    expect(errorEvent(events)).toBeUndefined();
    expect(events.some(e => e.type === "done")).toBe(true);
  });

  test.each(['"a claimed answer"', "42", "true", '{"type":"text","text":"x"}'])(
    "a present non-array content (%s) fails closed",
    async literal => {
      // The string case is the dangerous one and the reason this is not merely tidiness: a string
      // is iterable, so `for (const block of "a claimed answer")` walked it one CHARACTER at a
      // time, read `undefined` from every `block.type`, emitted nothing, and reported a clean
      // `done` — a successful EMPTY turn for a response that claimed content. Same failure mode as
      // #2231's `parts: "txt"`.
      const events = await parseContent(literal);
      const error = errorEvent(events);
      expect(error).toBeDefined();
      expect(error?.message).toContain("content_not_array");
      expect(events.some(e => e.type === "done")).toBe(false);
    },
  );

  test("a non-record block inside a well-formed array fails closed and names its index", async () => {
    const events = await parseContent('[{"type":"text","text":"first"},null]');
    const error = errorEvent(events);
    expect(error).toBeDefined();
    expect(error?.message).toContain("content_block_not_object");
    expect(error?.message).toContain("blockIndex=1");
    // Fail closed BEFORE emitting: half a claimed answer plus a silent stop is worse than a
    // reported failure, and matches how #1332 handles a malformed nested payload.
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("a well-formed content array is unaffected", async () => {
    const events = await parseContent('[{"type":"text","text":"PONG"},{"type":"tool_use","id":"toolu_1","name":"get","input":{}}]');
    expect(errorEvent(events)).toBeUndefined();
    expect(text(events)).toBe("PONG");
    expect(events.some(e => e.type === "tool_call_start")).toBe(true);
  });
});

describe("command-code ndjson: non-record frame", () => {
  async function collect(lines: string[]): Promise<AdapterEvent[]> {
    const events: AdapterEvent[] = [];
    const adapter = createCommandCodeAdapter(commandCodeProvider);
    for await (const e of adapter.parseStream(ndjsonResponse(lines), createTestTranslatorBudget())) events.push(e);
    return events;
  }

  const HEALTHY_HEAD = ['{"type":"text-delta","text":"P"}', '{"type":"text-delta","text":"ONG"}'];
  const HEALTHY_TAIL = ['{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":1,"outputTokens":2}}'];

  test.each(["null", "42", '"text"', "true", "[]"])(
    "a mid-stream non-record line (%s) is skipped, not fatal",
    async line => {
      // Unlike a buffered body, a stream frame has a next frame to recover into. #1240 established
      // that a non-record frame is padding: terminating on it throws away an answer that has
      // already fully arrived. `null` used to throw `null is not an object ('event.type')`.
      const events = await collect([...HEALTHY_HEAD, line, ...HEALTHY_TAIL]);
      expect(text(events)).toBe("PONG");
      expect(events.some(e => e.type === "done")).toBe(true);
      expect(errorEvent(events)).toBeUndefined();
    },
  );

  test("an unparseable line is skipped the same way (control)", async () => {
    const events = await collect([...HEALTHY_HEAD, INVALID_JSON_BODY, ...HEALTHY_TAIL]);
    expect(text(events)).toBe("PONG");
    expect(events.some(e => e.type === "done")).toBe(true);
  });

  test("a non-record line in the RESIDUAL buffer is skipped", async () => {
    // The trailing-buffer branch (`const final = buffer.trim()`) parses separately from the newline
    // loop and shared the same defect, so it needs its own case.
    //
    // `ndjsonResponse` cannot reach it: it appends a newline to EVERY line, so the newline loop
    // drains the buffer and `final` is always empty. An earlier version of this test used that
    // helper and asserted the same outcome — it passed for the wrong reason, because the residual
    // branch never ran. The body below deliberately omits the trailing newline, and places no
    // finish event before the residual frame, so the malformed line is reachable only via `final`.
    const body = new Response(`${HEALTHY_HEAD.join("\n")}\nnull`, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
    const events: AdapterEvent[] = [];
    const adapter = createCommandCodeAdapter(commandCodeProvider);
    for await (const e of adapter.parseStream(body, createTestTranslatorBudget())) events.push(e);

    expect(text(events)).toBe("PONG");
    expect(events.some(e => e.type === "done")).toBe(true);
  });

  test("a junk-only stream matches EVERY other junk-only control", async () => {
    // NOT the #1240 rule, deliberately. The SSE adapters fail closed on an all-padding stream;
    // this adapter ends every finish-less stream with a terminal `done` on purpose ("so the server
    // does not wait on an adapter that silently stopped emitting"), and an EMPTY body, a
    // blank-line-only body and an unparseable-only body all already do exactly that on unmodified
    // `dev`. So the requirement here is parity with those controls, not termination — asserting
    // otherwise would be demanding a behavior change this diff has no mandate to make.
    // The claim being pinned is that non-record-only joins an EXISTING class rather than forming a
    // new one, so all four members are compared, not just the nearest.
    const nonRecordOnly = await collect(["null", "42", "[]"]);
    for (const control of [[INVALID_JSON_BODY], [""], []]) {
      expect(nonRecordOnly.map(e => e.type)).toEqual((await collect(control)).map(e => e.type));
    }
    expect(errorEvent(nonRecordOnly)).toBeUndefined();
  });
});

describe("openai-chat parseResponse: the claimed assistant message", () => {
  const parseMessage = (messageLiteral: string) =>
    createOpenAIChatAdapter(openAIChatProvider).parseResponse!(
      jsonResponse(`{"choices":[{"message":${messageLiteral},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":1,"completion_tokens":2}}`),
      createTestTranslatorBudget(),
    );

  // The pre-existing `if (!choice.message)` split this input class on TRUTHINESS rather than shape.
  // These two were already refused and must stay refused — they are the control the rest is parity
  // against, and they are why the gap was invisible: the guard looked present because it fired on
  // the two shapes anyone would try first.
  test.each(["null", "0"])("a falsy non-record message (%s) still fails closed", async literal => {
    const events = await parseMessage(literal);
    expect(errorEvent(events)).toBeDefined();
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test.each(['"ANSWER"', "true", "[null]", "[]"])(
    "a truthy non-record message (%s) now fails closed too",
    async literal => {
      // Before: every property read yielded `undefined`, so the turn completed as a SUCCESSFUL
      // EMPTY response for a choice that claimed an assistant message — and any tool call it
      // claimed was silently stranded.
      const events = await parseMessage(literal);
      expect(errorEvent(events)).toBeDefined();
      expect(events.some(e => e.type === "done")).toBe(false);
    },
  );

  test("a non-empty array message does not discard the answer inside it", async () => {
    // #2232's `content: [{ parts: [...] }]` shape, one adapter over: a complete answer sits in the
    // payload, `message.content` reads `undefined` off the array, and the turn reported success.
    const events = await parseMessage('[{"role":"assistant","content":"ANSWER"}]');
    expect(errorEvent(events)).toBeDefined();
    expect(text(events)).toBe("");
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("an empty array message fails closed too - the google carve-out does not transfer", async () => {
    // google DOES accept `content: []`, but that carve-out is specific to a protobuf-derived wire
    // where a repeated field can spell an empty message, and `content` is genuinely an array of
    // blocks there. `message` is a record on a plain-JSON wire that already has `{}`. Importing the
    // exception here would be reasoning from analogy rather than from this wire's contract.
    const events = await parseMessage("[]");
    expect(errorEvent(events)).toBeDefined();
    expect(events.some(e => e.type === "done")).toBe(false);
  });

  test("an empty record message stays legal", async () => {
    const events = await parseMessage("{}");
    expect(errorEvent(events)).toBeUndefined();
    expect(events.some(e => e.type === "done")).toBe(true);
  });

  test("a well-formed message still delivers its text and tool call", async () => {
    const events = await parseMessage('{"role":"assistant","content":"ANSWER","tool_calls":[{"id":"c1","type":"function","function":{"name":"get","arguments":"{}"}}]}');
    expect(errorEvent(events)).toBeUndefined();
    expect(text(events)).toBe("ANSWER");
    expect(events.some(e => e.type === "tool_call_start")).toBe(true);
    expect(events.some(e => e.type === "done")).toBe(true);
  });
});


describe("a guard that fails closed still releases the response-body reservation", () => {
  // These guards return early from inside the region between `chargeRetained(responseBytes)` and
  // the `finally` that releases it, so a return placed on the wrong side of that boundary would
  // strand the whole body in the translator budget on every malformed response — a slow leak that
  // no events-only assertion can see.
  //
  // Asserting "bytes return to baseline after dispose" would NOT catch it: `dispose()` force-clears
  // whatever the budget still holds (`aggregateCurrentBytes -= this.currentBytes`), so that check is
  // vacuously true. The measurement has to happen BEFORE dispose, and the body has to be large
  // enough that a leaked reservation is unmistakable next to the tiny error event legitimately
  // retained on the way out.
  const PADDING = "x".repeat(50_000);

  const cases: [string, OcxProviderConfig, (p: OcxProviderConfig) => { parseResponse?: unknown }, string][] = [
    ["anthropic content non-array", anthropicProvider, createAnthropicAdapter as never,
      `{"content":"${PADDING}","stop_reason":"end_turn"}`],
    ["anthropic block non-record", anthropicProvider, createAnthropicAdapter as never,
      `{"content":[{"type":"text","text":"${PADDING}"},null],"stop_reason":"end_turn"}`],
    ["openai-chat message non-record", openAIChatProvider, createOpenAIChatAdapter as never,
      `{"choices":[{"message":"${PADDING}","finish_reason":"stop"}]}`],
  ];

  test.each(cases)("%s does not strand the body", async (_label, provider, make, body) => {
    const budget = createTranslatorBudget();
    const before = translatorObservedBufferSnapshot().currentBytes;
    const adapter = (make as (p: OcxProviderConfig) => {
      parseResponse: (r: Response, b: unknown) => Promise<AdapterEvent[]>;
    })(provider);
    const events = await adapter.parseResponse(jsonResponse(body), budget);
    const heldBeforeDispose = translatorObservedBufferSnapshot().currentBytes - before;
    budget.dispose();

    expect(errorEvent(events)).toBeDefined();
    // Only the returned error event may still be held. The 50KB body must already be released.
    expect(heldBeforeDispose).toBeLessThan(2_000);
  });
});
