import { describe, expect, test } from "bun:test";
import { decodeServerSentEvents } from "../src/lib/sse-decoder";
import {
  TRANSLATOR_MAX_SSE_EVENT_BYTES,
  TRANSLATOR_MAX_TURN_BYTES,
  createTranslatorBudget,
} from "../src/lib/translator-budget";

function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]) {
  const records = [];
  const translatorBudget = createTranslatorBudget();
  try {
    for await (const record of decodeServerSentEvents(chunkedStream(chunks), { translatorBudget })) records.push(record);
    return records;
  } finally {
    translatorBudget.dispose();
  }
}

async function collectWithComments(chunks: string[]) {
  const records = [];
  const translatorBudget = createTranslatorBudget();
  try {
    for await (const record of decodeServerSentEvents(chunkedStream(chunks), { includeComments: true, translatorBudget })) {
      records.push(record);
    }
    return records;
  } finally {
    translatorBudget.dispose();
  }
}

describe("text/event-stream decoder", () => {
  test("preserves event state across arbitrary reader chunks", async () => {
    expect(await collect([
      "event: content_",
      "block_delta\n",
      "data: {\"type\":\"content_block_delta\"}\n\n",
    ])).toEqual([{
      event: "content_block_delta",
      data: '{"type":"content_block_delta"}',
    }]);
  });

  test("dispatches the terminal record without a final newline or blank delimiter", async () => {
    expect(await collect([
      "event: message_stop\n",
      'data: {"type":"message_stop"}',
    ])).toEqual([{
      event: "message_stop",
      data: '{"type":"message_stop"}',
    }]);
  });

  test("joins multiline data and accepts CRLF framing", async () => {
    expect(await collect([
      "event: custom\r\ndata: first\r\n",
      "data: second\r\n\r\n",
    ])).toEqual([{ event: "custom", data: "first\nsecond" }]);
  });

  test("yields comment and event records only when comments are opted in", async () => {
    expect(await collectWithComments([
      ": keepalive\n",
      "event: custom\ndata: payload\n\n",
    ])).toEqual([
      { kind: "comment", comment: "keepalive" },
      { kind: "event", event: "custom", data: "payload" },
    ]);
  });

  test("default mode ignores comments and preserves the kind-less record shape", async () => {
    const records = await collect([
      ": keepalive\n",
      "event: custom\ndata: payload\n\n",
    ]);

    expect(records).toEqual([{ event: "custom", data: "payload" }]);
    expect("kind" in records[0]).toBe(false);
  });

  test("admits 17 MiB and exact 32 MiB logical events while accounting source/value overlap", async () => {
    for (const size of [17 * 1024 * 1024, TRANSLATOR_MAX_SSE_EVENT_BYTES]) {
      const payload = "x".repeat(size);
      const translatorBudget = createTranslatorBudget({ maxTurnBytes: 4 * TRANSLATOR_MAX_SSE_EVENT_BYTES });
      try {
        const records = [];
        for await (const record of decodeServerSentEvents(
          chunkedStream([`data: ${payload}\n\n`]),
          { translatorBudget },
        )) records.push(record);
        expect(records).toHaveLength(1);
        expect(records[0]?.data.length).toBe(size);
        expect(translatorBudget.snapshot().highWaterBytes).toBeGreaterThanOrEqual(3 * size);
        expect(translatorBudget.snapshot().currentBytes).toBe(0);
      } finally {
        translatorBudget.dispose();
      }
    }
  }, 60_000);

  test("rejects an SSE event one byte over 32 MiB", async () => {
    const payload = "x".repeat(TRANSLATOR_MAX_SSE_EVENT_BYTES + 1);
    const translatorBudget = createTranslatorBudget({ maxTurnBytes: 4 * TRANSLATOR_MAX_SSE_EVENT_BYTES });
    try {
      await expect(async () => {
        for await (const _record of decodeServerSentEvents(
          chunkedStream([`data: ${payload}\n\n`]),
          { translatorBudget },
        )) { /* unreachable */ }
      }).toThrow(expect.objectContaining({ code: "translation_buffer_limit" }));
    } finally {
      translatorBudget.dispose();
    }
  }, 60_000);

  test("rejects a 20 MiB event while the consumer turn already retains 20 MiB", async () => {
    const translatorBudget = createTranslatorBudget();
    const retained = 20 * 1024 * 1024;
    translatorBudget.chargeRetained(retained, { kind: "retained_collectors" });
    try {
      const records = [];
      await expect(async () => {
        for await (const record of decodeServerSentEvents(
          chunkedStream([`data: ${"x".repeat(retained)}\n\n`]),
          { translatorBudget },
        )) records.push(record);
      }).toThrow(expect.objectContaining({ code: "translation_buffer_limit" }));
      expect(translatorBudget.snapshot().highWaterBytes).toBeLessThanOrEqual(TRANSLATOR_MAX_TURN_BYTES);
      expect(records).toHaveLength(0);
    } finally {
      translatorBudget.dispose();
    }
  }, 60_000);
});
