import { describe, expect, test } from "bun:test";
import { decodeServerSentEvents } from "../src/lib/sse-decoder";

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
  for await (const record of decodeServerSentEvents(chunkedStream(chunks))) records.push(record);
  return records;
}

async function collectWithComments(chunks: string[]) {
  const records = [];
  for await (const record of decodeServerSentEvents(chunkedStream(chunks), { includeComments: true })) {
    records.push(record);
  }
  return records;
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
});
