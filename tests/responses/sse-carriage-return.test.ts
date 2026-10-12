import { describe, expect, test } from "bun:test";
import { decodeServerSentEvents } from "../../src/lib/sse-decoder";
import { createTranslatorBudget } from "../../src/lib/translator-budget";

/** Decode a fragmented fixture stream and assert that the decoder releases its retained byte budget. */
async function collect(chunks: string[]) {
  const budget = createTranslatorBudget();
  const source = new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  } });
  try {
    const records = [];
    for await (const event of decodeServerSentEvents(source, { translatorBudget: budget, includeComments: true })) records.push(event);
    expect(budget.snapshot().currentBytes).toBe(0);
    return records;
  } finally { budget.dispose(); }
}

describe("SSE line ending compatibility", () => {
  test.each(["\r", "\n", "\r\n"])("decodes %j framing at every character boundary", async ending => {
    const wire = ["event: delta", "data: one", "data: two", "", ": ping", "data: three", "", ""].join(ending);
    const expected = [{ kind: "event", event: "delta", data: "one\ntwo" }, { kind: "comment", comment: "ping" }, { kind: "event", data: "three" }];
    expect(await collect([wire])).toEqual(expected);
    expect(await collect([...wire])).toEqual(expected);
  });
  test("handles mixed delimiters and an unterminated final event", async () => {
    expect(await collect(["data: one\r", "\n\r", "data: two\n\n", "data: three\r"])).toEqual([
      { kind: "event", data: "one" }, { kind: "event", data: "two" }, { kind: "event", data: "three" },
    ]);
  });
  test("preserves non-newline data immediately after a split CR", async () => {
    expect(await collect(["data: one\r", "data: two\r", "\r"])).toEqual([{ kind: "event", data: "one\ntwo" }]);
  });
  test("counts a CRLF split between chunks as one line ending", async () => {
    // A second line ending here would be a blank line and dispatch "a" and "b" as two events.
    expect(await collect(["data: a\r", "\ndata: b\r\n\r\n"])).toEqual([{ kind: "event", data: "a\nb" }]);
    expect(await collect(["data: a\r", "", "\ndata: b\r", "\n\r", "\n"])).toEqual([{ kind: "event", data: "a\nb" }]);
  });
  test("treats LF followed by CR as two line endings", async () => {
    expect(await collect(["data: a\n\rdata: b\n\n"])).toEqual([{ kind: "event", data: "a" }, { kind: "event", data: "b" }]);
  });
  test.each(["\n", "\r", "\r\n"])("decodes many %j records from one chunk", async ending => {
    const count = 500;
    const wire = Array.from({ length: count }, (_, index) => `data: {"n":${index}}${ending}${ending}`).join("");
    const records = await collect([wire]);
    expect(records).toHaveLength(count);
    expect(records.at(-1)).toEqual({ kind: "event", data: `{"n":${count - 1}}` });
  });
  test("keeps a UTF-8 code point split next to a CR delimiter", async () => {
    const bytes = new TextEncoder().encode("data: 한\r\r");
    const source = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.slice(0, 7));
      controller.enqueue(bytes.slice(7, 9));
      controller.enqueue(bytes.slice(9));
      controller.close();
    } });
    const budget = createTranslatorBudget();
    try {
      const records = [];
      for await (const event of decodeServerSentEvents(source, { translatorBudget: budget })) records.push(event);
      expect(records).toEqual([{ data: "한" }]);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { budget.dispose(); }
  });
  test("ends a data line at a raw CR but keeps an escaped CR in JSON", async () => {
    expect(await collect(["data: a\rb\n\n"])).toEqual([{ kind: "event", data: "a" }]);
    expect(await collect(['data: {"t":"a\\rb"}\r\n\r\n'])).toEqual([{ kind: "event", data: '{"t":"a\\rb"}' }]);
  });
  test("dispatches a CR-delimited event while the upstream remains open", async () => {
    const budget = createTranslatorBudget();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({ start(value) {
      controller = value;
      controller.enqueue(new TextEncoder().encode("data: live\r\r"));
    } });
    const events = decodeServerSentEvents(source, { translatorBudget: budget });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const next = await Promise.race([events.next(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("event waited for EOF")), 2_000);
      })]);
      expect(next).toEqual({ value: { data: "live" }, done: false });
    } finally {
      clearTimeout(timer); controller.close(); await events.return(undefined); budget.dispose();
    }
  });
});
