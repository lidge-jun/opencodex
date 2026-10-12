import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { SerializedToolCallContentBuffer } from "../../../src/adapters/openai-chat/serialized-tool-call-content";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../../helpers/translator-budget";

// An unmatched bare <tool_call> block must not hold the rest of a streamed answer until the turn
// ends (#5548 follow-up). A duplicate is the tail of the content, so prose after a closed block is
// released once it passes the bound; a real duplicate followed by its structured call is still removed.
const BLOCK = "<tool_call><function=exec>text('ok');\n</parameter></function></tool_call>";
const PROSE = "The answer continues here. ".repeat(400); // > 8 KiB of non-whitespace text
const texts = (events: AdapterEvent[]) => events
  .filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta")
  .map(event => event.text)
  .join("");

describe("bounded streaming hold", () => {
  test("prose after a closed unmatched block is released in order, nothing suppressed", () => {
    const buffer = new SerializedToolCallContentBuffer(createTestTranslatorBudget());
    expect(buffer.ingestStreaming("Intro\n")).toEqual([{ type: "text_delta", text: "Intro\n" }]);
    expect(buffer.ingestStreaming(BLOCK)).toEqual([]);
    expect(buffer.ingestStreaming("short tail")).toEqual([]);
    const released = buffer.ingestStreaming(PROSE);
    expect(texts(released)).toBe(BLOCK + "short tail" + PROSE);
    // Scanning resumes: later text passes straight through.
    expect(buffer.ingestStreaming(" more")).toEqual([{ type: "text_delta", text: " more" }]);
    buffer.dispose();
  });

  test("a block still open is not released by the prose rule", () => {
    const buffer = new SerializedToolCallContentBuffer(createTestTranslatorBudget());
    expect(buffer.ingestStreaming("<tool_call><function=write>")).toEqual([]);
    expect(buffer.ingestStreaming(PROSE)).toEqual([]);
    buffer.dispose();
  });

  test("a second block open after a closed one keeps the hold", () => {
    const buffer = new SerializedToolCallContentBuffer(createTestTranslatorBudget());
    expect(buffer.ingestStreaming(BLOCK + "\n<tool_call><function=write>")).toEqual([]);
    expect(buffer.ingestStreaming(PROSE)).toEqual([]);
    buffer.dispose();
  });

  test("the size bound releases a runaway hold before retaining the next delta", () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 16 * 1024 * 1024 });
    const buffer = new SerializedToolCallContentBuffer(budget);
    const chunk = "x".repeat(1024 * 1024);
    expect(buffer.ingestStreaming("<tool_call><function=write>")).toEqual([]);
    for (let i = 0; i < 3; i++) expect(buffer.ingestStreaming(chunk)).toEqual([]);
    const released = buffer.ingestStreaming(chunk + chunk);
    expect(texts(released)).toBe("<tool_call><function=write>" + chunk.repeat(5));
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0, overflows: 0 });
    buffer.dispose();
  });

  test("buffered ingest keeps its unbounded hold", () => {
    const buffer = new SerializedToolCallContentBuffer(createTestTranslatorBudget());
    expect(buffer.ingest(BLOCK)).toBe("");
    expect(buffer.ingest(PROSE)).toBe("");
    buffer.dispose();
  });
});

const MODEL = "mimo-v2.6-flash";
function adapter() {
  const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://gateway.example.test/v1", apiKey: "key" };
  const built = withTestTranslatorBudget(createOpenAIChatAdapter(provider));
  const parsed: OcxParsedRequest = {
    modelId: MODEL,
    stream: true,
    options: {},
    context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] },
  };
  built.buildRequest(parsed);
  return built;
}
const frame = (value: unknown) => "data: " + JSON.stringify(value) + "\n\n";

describe("openai-chat streaming", () => {
  test("an unmatched block followed by a long answer is delivered before the stream ends", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const text of ["Intro\n", BLOCK, PROSE]) controller.enqueue(encoder.encode(frame({ choices: [{ delta: { content: text } }] })));
        // The stream stays open: nothing may depend on its end.
      },
    });
    let seen = "";
    const iterator = adapter().parseStream(new Response(body))[Symbol.asyncIterator]();
    const deadline = Date.now() + 3000;
    while (!seen.includes(PROSE) && Date.now() < deadline) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<AdapterEvent>>(resolve => setTimeout(() => resolve({ done: true, value: undefined }), 1000)),
      ]);
      if (next.done) break;
      if (next.value.type === "text_delta") seen += next.value.text;
    }
    await iterator.return?.();
    expect(seen).toBe("Intro\n" + BLOCK + PROSE);
  });

  test("a duplicated block followed by its structured call is still suppressed", async () => {
    const call = { index: 0, id: "call_exec", function: { name: "exec", arguments: JSON.stringify({ input: "text('ok');" }) } };
    const body = frame({ choices: [{ delta: { content: "Running it.\n" } }] })
      + frame({ choices: [{ delta: { content: BLOCK } }] })
      + frame({ choices: [{ delta: { tool_calls: [call] } }] })
      + frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })
      + "data: [DONE]\n\n";
    const events: AdapterEvent[] = [];
    for await (const event of adapter().parseStream(new Response(body))) events.push(event);
    expect(texts(events)).toBe("Running it.\n");
  });
});


describe("bound bypass paths", () => {
  test("one delta that opens a block and passes the size bound is not retained", () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 16 * 1024 * 1024 });
    const buffer = new SerializedToolCallContentBuffer(budget);
    const big = "<tool_call><function=write>" + "x".repeat(5 * 1024 * 1024);
    expect(texts(buffer.ingestStreaming(big))).toBe(big);
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0 });
    buffer.dispose();
  });

  test("an oversized delta after an open block is delivered after the held text", () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 32 * 1024 * 1024 });
    const buffer = new SerializedToolCallContentBuffer(budget);
    expect(buffer.ingestStreaming("<tool_call><function=write>")).toEqual([]);
    const big = "<tool_call>" + "y".repeat(5 * 1024 * 1024);
    expect(texts(buffer.ingestStreaming(big))).toBe("<tool_call><function=write>" + big);
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0 });
    buffer.dispose();
  });

  test("queued non-text events count toward the size bound", () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 16 * 1024 * 1024 });
    const buffer = new SerializedToolCallContentBuffer(budget);
    expect(buffer.ingestStreaming("<tool_call><function=write>")).toEqual([]);
    const reasoning = { type: "reasoning_raw_delta", text: "r".repeat(1024 * 1024) } as AdapterEvent;
    for (let i = 0; i < 3; i++) expect(buffer.hold(reasoning)).toEqual([{ type: "heartbeat" }]);
    const released = buffer.hold(reasoning);
    expect(released.at(-1)).toEqual(reasoning);
    expect(released.filter(event => event.type === "reasoning_raw_delta")).toHaveLength(4);
    expect(texts(released)).toBe("<tool_call><function=write>");
    expect(budget.snapshot()).toMatchObject({ currentBytes: 0 });
    buffer.dispose();
  });
});
