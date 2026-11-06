import { describe, expect, test } from "bun:test";
import { MAX_SIDECAR_DECODED_CHARS, MAX_SIDECAR_STREAM_BYTES, parseSidecarSSE } from "../../src/web-search/parse";

/** Keep the final data line unterminated and optionally split every UTF-8 byte. */
function eofResponse(wire: string, fragmented = false): Response {
  const bytes = new TextEncoder().encode(wire);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = fragmented ? offset + 1 : bytes.length;
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  }));
}

const prefix = 'data: {"type":"response.output_text.delta","delta":"draft"}\n\n';

describe("Responses sidecar final data line at EOF", () => {
  test.each(["response.completed", "response.done"])("accepts an unterminated %s with authoritative text and sources", async type => {
    const final = { type, response: { output: [{ type: "message", content: [{
      type: "output_text", text: "검색 결과 😀", annotations: [
        { type: "url_citation", url: "https://example.com/result", title: "Source" },
      ],
    }] }] } };
    for (const fragmented of [false, true]) {
      const out = await parseSidecarSSE(eofResponse(prefix + `data:${JSON.stringify(final)}`, fragmented));
      expect(out).toEqual({ text: "검색 결과 😀", sources: [{ url: "https://example.com/result", title: "Source" }] });
    }
  });

  test("accepts a final DONE sentinel without losing earlier deltas", async () => {
    expect(await parseSidecarSSE(eofResponse(prefix + "data: [DONE]")))
      .toEqual({ text: "draft", sources: [] });
  });

  test.each(["response.failed", "response.incomplete", "error"])("preserves the final %s diagnostic", async type => {
    const out = await parseSidecarSSE(eofResponse(prefix + `data: ${JSON.stringify({ type, error: { message: "search stopped" } })}`));
    expect(out).toEqual({ text: "draft", sources: [], error: "search stopped" });
  });

  test("retains final text without treating a text-done event as response completion", async () => {
    const out = await parseSidecarSSE(eofResponse('data: {"type":"response.output_text.done","text":"partial"}'));
    expect(out).toEqual({ text: "partial", sources: [], error: "sidecar stream ended before terminal event" });
  });

  test("an empty body still lacks a terminal event", async () => {
    expect((await parseSidecarSSE(eofResponse(""))).error).toContain("before terminal event");
  });

  test("does not accept an unfinished JSON payload at EOF", async () => {
    const out = await parseSidecarSSE(eofResponse(prefix + 'data: {"type":"response.completed"'));
    expect(out.text).toBe("draft");
    expect(out.error).toContain("before terminal event");
  });

  test("does not flush an otherwise valid final line at the wire ceiling", async () => {
    const tail = 'data: {"type":"response.completed"}';
    const wire = ":" + "x".repeat(MAX_SIDECAR_STREAM_BYTES - tail.length - 2) + "\n" + tail;
    const out = await parseSidecarSSE(eofResponse(wire));
    expect(out.error).toContain("byte limit reached before terminal event");
  });

  test("applies the decoded text limit to the EOF line", async () => {
    const tail = { type: "response.completed", response: { output: [{ type: "message", content: [
      { type: "output_text", text: "x".repeat(MAX_SIDECAR_DECODED_CHARS + 1) },
    ] }] } };
    expect((await parseSidecarSSE(eofResponse(`data: ${JSON.stringify(tail)}`))).error)
      .toBe("sidecar response decoded text limit reached");
  });

  test("a transport read failure does not flush a pending completion", async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) { controller.error(new Error("transport stopped")); return; }
        sent = true;
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}'));
      },
    });
    await expect(parseSidecarSSE(new Response(body))).rejects.toThrow("transport stopped");
  });
});

describe("Responses sidecar SSE line endings", () => {
  for (const [name, endings] of [
    ["LF", ["\n"]],
    ["CRLF", ["\r\n"]],
    ["CR", ["\r"]],
    ["mixed", ["\r", "\n", "\r\n"]],
  ] as const) {
    test.each([["one chunk", false], ["single-byte chunks", true]] as const)(`${name} preserves deltas and citations (%s)`, async (_chunking, fragmented) => {
      const lines = [
        ": heartbeat",
        "event: response.output_text.delta",
        'data:{"type":"response.output_text.delta","delta":"검색 "}',
        "",
        'data: {"type":"response.output_text.delta","delta":"😀"}',
        "",
        `data: ${JSON.stringify({ type: "response.output_text.annotation.added", annotation: {
          type: "url_citation", url: "https://example.com/result", title: "Source",
        } })}`,
        "",
        "data: [DONE]",
      ];
      const wire = lines.map((line, index) => line + endings[index % endings.length]).join("");
      expect(await parseSidecarSSE(eofResponse(wire, fragmented))).toEqual({
        text: "검색 😀", sources: [{ url: "https://example.com/result", title: "Source" }],
      });
    });
  }

  test("preserves a CR-delimited terminal failure and earlier partial text", async () => {
    const wire = prefix.replaceAll("\n", "\r") +
      'data: {"type":"response.failed","error":{"message":"search stopped"}}\r\r';
    expect(await parseSidecarSSE(eofResponse(wire))).toEqual({
      text: "draft", sources: [], error: "search stopped",
    });
  });

  test("CR-delimited text without a terminal event remains incomplete", async () => {
    expect(await parseSidecarSSE(eofResponse(prefix.replaceAll("\n", "\r")))).toEqual({
      text: "draft", sources: [], error: "sidecar stream ended before terminal event",
    });
  });

  test("a CR-delimited terminal event cancels without waiting for EOF", async () => {
    let cancelled = false;
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) throw new Error("read past terminal event");
        sent = true;
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\r\r'));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    expect(await parseSidecarSSE(new Response(body))).toEqual({ text: "", sources: [] });
    expect(cancelled).toBe(true);
  });
});
