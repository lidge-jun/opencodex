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

describe("SSE bounded field prefix", () => {
  test("classifies split field prefixes and resets classification for every line", async () => {
    const wire = "data: first\r\nevent: next\ndata:  second\r: ping\rignored: value\ndata\n\ndata:tail";
    const expected = [
      { kind: "comment", comment: "ping" },
      { kind: "event", event: "next", data: "first\n second\n" },
      { kind: "event", data: "tail" },
    ];
    expect(await collect([wire])).toEqual(expected);
    for (let split = 0; split <= wire.length; split++) {
      expect(await collect([wire.slice(0, split), "", wire.slice(split)])).toEqual(expected);
    }
    expect(await collect([...wire])).toEqual(expected);
  });

  test("preserves a multibyte sixth character across all byte boundaries", async () => {
    const bytes = new TextEncoder().encode("data:한🙂\r\ndata: 界\r\n\r\n");
    for (let split = 0; split <= bytes.length; split++) {
      const budget = createTranslatorBudget();
      const source = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(bytes.subarray(0, split));
        controller.enqueue(bytes.subarray(split));
        controller.close();
      } });
      try {
        const records = [];
        for await (const record of decodeServerSentEvents(source, { translatorBudget: budget })) records.push(record);
        expect(records).toEqual([{ data: "한🙂\n界" }]);
        expect(budget.snapshot().currentBytes).toBe(0);
      } finally { budget.dispose(); }
    }
  });

  test("does not re-extract the prefix from the accumulated long line", async () => {
    const payload = "x".repeat(256 * 1024);
    const wire = `data: ${payload}\n\n`;
    const chunks: string[] = [];
    for (let offset = 0; offset < wire.length; offset += 512) chunks.push(wire.slice(offset, offset + 512));
    const original = String.prototype.slice;
    let growingPrefixReads = 0;
    let records: Awaited<ReturnType<typeof collect>>;
    // Count operations instead of using a wall-clock threshold. Always restore the
    // prototype, including when decoding fails; these tests are not concurrent.
    String.prototype.slice = function(this: string, start: number, end?: number): string {
      if (start === 0 && end === 6 && this.length > 4096) growingPrefixReads++;
      return original.call(this, start, end);
    };
    try { records = await collect(chunks); }
    finally { String.prototype.slice = original; }
    expect(records).toEqual([{ kind: "event", data: payload }]);
    expect(growingPrefixReads).toBe(0);
  });

  test("a partially collected prefix still releases accounting when append admission fails", async () => {
    const budget = createTranslatorBudget();
    const reserve = budget.reserveTransient.bind(budget);
    const failure = new Error("synthetic append admission failure");
    budget.reserveTransient = (bytes, scope) => {
      if (bytes > 256) throw failure;
      return reserve(bytes, scope);
    };
    let cancelled = 0;
    const source = new ReadableStream<Uint8Array>({ start(controller) {
      for (const value of ["da", "ta:", " ", "x".repeat(128), "y".repeat(128)]) {
        controller.enqueue(new TextEncoder().encode(value));
      }
    }, cancel() { cancelled++; } });
    try {
      const iterator = decodeServerSentEvents(source, { translatorBudget: budget });
      await expect(iterator.next()).rejects.toBe(failure);
      expect(budget.snapshot().currentBytes).toBe(0);
      expect(cancelled).toBe(1);
      expect(source.locked).toBe(false);
    } finally { budget.dispose(); }
  });
});
