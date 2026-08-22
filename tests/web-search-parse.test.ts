import { describe, expect, test } from "bun:test";
import { MAX_SIDECAR_RESPONSE_BYTES, parseSidecarSSE } from "../src/web-search/parse";

function sse(events: { type: string; [k: string]: unknown }[]): Response {
  const body = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function joinBytes(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Parse one authoritative completed-text event through the production SSE path. */
async function parseCompletedText(text: string) {
  return parseSidecarSSE(sse([
    { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", annotations: [], text }] }] } },
  ]));
}

describe("parseSidecarSSE trailing Sources block", () => {
  test("accepts exactly the byte cap, keeps complete events, and cancels without another read", async () => {
    const encoder = new TextEncoder();
    const event = encoder.encode(`data:${JSON.stringify({
      type: "response.output_text.delta",
      delta: "A",
    })}\n\n`);
    const paddingBytes = MAX_SIDECAR_RESPONSE_BYTES - event.byteLength;
    const padding = encoder.encode(`:${"x".repeat(paddingBytes - 2)}\n`);
    const bytes = joinBytes(event, padding);
    expect(bytes.byteLength).toBe(MAX_SIDECAR_RESPONSE_BYTES);

    const chunks = [bytes.subarray(0, 12_345), bytes.subarray(12_345)];
    let reads = 0;
    let cancels = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        const chunk = chunks.shift();
        if (!chunk) throw new Error("parser read past the sidecar byte cap");
        controller.enqueue(chunk);
      },
      cancel() { cancels += 1; },
    });

    const out = await parseSidecarSSE(new Response(body));
    expect(out.text).toBe("A");
    expect(reads).toBe(2);
    expect(cancels).toBe(1);
  });

  test("keeps complete no-space data events and drops a partial event at the cap", async () => {
    const encoder = new TextEncoder();
    const complete = encoder.encode(`data:${JSON.stringify({
      type: "response.output_text.delta",
      delta: "A",
    })}\n\n`);
    const partial = encoder.encode('data:{"type":"response.output_text.delta","delta":"B');
    const oversized = new Uint8Array(MAX_SIDECAR_RESPONSE_BYTES + 32);
    oversized.set(complete);
    oversized.set(partial, complete.byteLength);
    oversized.fill(0x78, complete.byteLength + partial.byteLength);
    let cancels = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(oversized); },
      cancel() { cancels += 1; },
    });

    const out = await parseSidecarSSE(new Response(body));
    expect(out.text).toBe("A");
    expect(cancels).toBe(1);
  });

  test("does not flush a truncated multibyte sequence at the cap", async () => {
    const encoder = new TextEncoder();
    const complete = encoder.encode(`data:${JSON.stringify({
      type: "response.output_text.delta",
      delta: "A",
    })}\n\n`);
    const partialPrefix = encoder.encode('data:{"type":"response.output_text.delta","delta":"');
    const filler = new Uint8Array(
      MAX_SIDECAR_RESPONSE_BYTES - complete.byteLength - partialPrefix.byteLength - 1,
    ).fill(0x78);
    const oversized = joinBytes(complete, partialPrefix, filler, encoder.encode("😀\"}\n\n"));

    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(oversized); },
    });
    const out = await parseSidecarSSE(new Response(body));
    expect(out.text).toBe("A");
    expect(out.text).not.toContain("�");
  });

  test("returns bounded partial output when body cancellation rejects", async () => {
    const encoder = new TextEncoder();
    const event = encoder.encode(`data:${JSON.stringify({
      type: "response.output_text.delta",
      delta: "A",
    })}\n\n`);
    const oversized = new Uint8Array(MAX_SIDECAR_RESPONSE_BYTES + 1).fill(0x78);
    oversized.set(event);
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(oversized); },
      cancel() { return Promise.reject(new Error("cancel failed")); },
    });

    const out = await parseSidecarSSE(new Response(body));
    expect(out.text).toBe("A");
  });

  test("extracts sources from a markdown Sources block when annotations are empty", async () => {
    const text = "Node 24.18.0 is the latest LTS.\n\nSources:\n" +
      "- Node.js Download page: https://nodejs.org/en/download/current\n" +
      "- Node.js release archive: https://nodejs.org/en/download/archive/current";
    const res = sse([
      { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", annotations: [], text }] }] } },
    ]);
    const out = await parseSidecarSSE(res);
    expect(out.sources).toEqual([
      { url: "https://nodejs.org/en/download/current", title: "Node.js Download page" },
      { url: "https://nodejs.org/en/download/archive/current", title: "Node.js release archive" },
    ]);
    // The Sources block is stripped from the answer text (so the tool_result renderer won't double it).
    expect(out.text).toBe("Node 24.18.0 is the latest LTS.");
    expect(out.text).not.toContain("Sources:");
  });

  test("handles title (url), [md](url), bare url and numbered forms", async () => {
    const text = "Answer.\n\nSources:\n" +
      "1. FIFA dates (https://www.fifa.com/a)\n" +
      "- [FIFA final](https://www.fifa.com/b)\n" +
      "- https://www.fifa.com/c";
    const res = sse([
      { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", annotations: [], text }] }] } },
    ]);
    const out = await parseSidecarSSE(res);
    expect(out.sources.map(s => s.url)).toEqual([
      "https://www.fifa.com/a", "https://www.fifa.com/b", "https://www.fifa.com/c",
    ]);
    expect(out.sources[0]).toEqual({ url: "https://www.fifa.com/a", title: "FIFA dates" });
    expect(out.sources[1]).toEqual({ url: "https://www.fifa.com/b", title: "FIFA final" });
    expect(out.sources[2]).toEqual({ url: "https://www.fifa.com/c" });
  });

  test("annotation title wins; text-block only fills new URLs", async () => {
    const text = "Answer.\n\nSources:\n- text title: https://x.test/1\n- https://x.test/2";
    const res = sse([
      { type: "response.completed", response: { output: [{ type: "message", content: [{
        type: "output_text",
        annotations: [{ type: "url_citation", url: "https://x.test/1", title: "annotation title" }],
        text,
      }] }] } },
    ]);
    const out = await parseSidecarSSE(res);
    // /1 came from the annotation (its title wins); /2 is added from the text block.
    expect(out.sources).toEqual([
      { url: "https://x.test/1", title: "annotation title" },
      { url: "https://x.test/2" },
    ]);
  });

  test("sanitizes structured and trailing sources before returning them", async () => {
    const text = "Answer.\n\nSources:\n" +
      "- Credential URL: https://user:pass@private.test/path\n" +
      "- Safe trailing URL: https://safe.test/trailing";
    const res = sse([
      { type: "response.completed", response: { output: [{ type: "message", content: [{
        type: "output_text",
        annotations: [
          { type: "url_citation", url: "javascript:alert(1)", title: "unsafe" },
          { type: "url_citation", url: "https://safe.test/structured", title: "bad\u0001title" },
        ],
        text,
      }] }] } },
    ]);

    const out = await parseSidecarSSE(res);
    expect(out.sources).toEqual([
      { url: "https://safe.test/structured" },
      { url: "https://safe.test/trailing", title: "Safe trailing URL" },
    ]);
    expect(out.text).toBe("Answer.");
  });

  test("strips a recognized Sources block even when every citation is rejected", async () => {
    const out = await parseCompletedText(
      "Answer.\n\nSources:\n- Credential URL: https://user:pass@private.test/path",
    );
    expect(out).toEqual({ text: "Answer.", sources: [] });
  });

  test("strips a trailing non-HTTP URI citation after rejecting it", async () => {
    const out = await parseCompletedText(
      "Answer.\n\nSources:\n- Unsafe: javascript:alert(1)",
    );
    expect(out).toEqual({ text: "Answer.", sources: [] });
  });

  test("preserves prose after a blank line following a rejected citation", async () => {
    const out = await parseCompletedText(
      "Answer.\n\nSources:\n- Credential URL: https://user:pass@private.test/path\n\n" +
      "For details visit https://good.test/guide",
    );
    expect(out).toEqual({
      text: "Answer.\n\nFor details visit https://good.test/guide",
      sources: [],
    });
  });

  test("no Sources block leaves text and sources untouched", async () => {
    const text = "Just an answer mentioning https://example.com inline, no sources section.";
    const res = sse([
      { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", annotations: [], text }] }] } },
    ]);
    const out = await parseSidecarSSE(res);
    expect(out.text).toBe(text);
    expect(out.sources).toEqual([]);
  });

  test("recognizes a markdown-prefixed Sources header (### Sources: / **Sources**)", async () => {
    const text = "Latest is 24.18.0.\n\n### Sources:\n" +
      "- Node download: https://nodejs.org/en/download/current\n" +
      "- Release archive: https://nodejs.org/en/download/archive/current";
    const res = sse([
      { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", annotations: [], text }] }] } },
    ]);
    const out = await parseSidecarSSE(res);
    expect(out.sources).toEqual([
      { url: "https://nodejs.org/en/download/current", title: "Node download" },
      { url: "https://nodejs.org/en/download/archive/current", title: "Release archive" },
    ]);
    expect(out.text).toBe("Latest is 24.18.0.");
    expect(out.text).not.toContain("Sources");
  });

  test.each([
    "Source",
    "sources",
    "  Sources :  ",
    "### Sources:",
    "######> *Sources***",
    "**Sources**",
    "Sources* *",
    "Sources:*",
    "Sources* : *",
    "\u00a0Sources\u2003:\t*",
  ])("preserves accepted Sources-header forms: %s", async header => {
    const out = await parseCompletedText(`Answer.\n\n${header}\n- https://x.test/source`);
    expect(out.text).toBe("Answer.");
    expect(out.sources).toEqual([{ url: "https://x.test/source" }]);
  });

  test.each([
    "Sources* * *",
    "Sources:* *",
    "Sources* *:",
    "####### Sources",
    "# # Sources",
    "> # Sources",
    "SourcesX",
    "Sources-",
    "Sources#",
    "Sources::",
    "Sources:*:",
    "Sources * * :",
  ])("preserves rejected Sources-header forms: %s", async header => {
    const text = `Answer.\n\n${header}\n- https://x.test/source`;
    const out = await parseCompletedText(text);
    expect(out.text).toBe(text);
    expect(out.sources).toEqual([]);
  });

  test("handles a long valid Sources header with two star runs", async () => {
    const header = `Sources${"*".repeat(20_000)} : ${"*".repeat(19_999)}`;
    const out = await parseCompletedText(`Answer.\n\n${header}\n- https://x.test/source`);
    expect(out.text).toBe("Answer.");
    expect(out.sources).toEqual([{ url: "https://x.test/source" }]);
  });

  test("rejects a long near-miss with a third separated star run", async () => {
    const header = `Sources${"*".repeat(13_333)} ${"*".repeat(13_333)} ${"*".repeat(13_334)}`;
    const text = `Answer.\n\n${header}\n- https://x.test/source`;
    const out = await parseCompletedText(text);
    expect(out.text).toBe(text);
    expect(out.sources).toEqual([]);
  });

  test("pairs a title line with the URL on the FOLLOWING line (multiline entry)", async () => {
    const text = "Answer.\n\nSources:\n" +
      "- Node.js Download page\n" +
      "  https://nodejs.org/en/download/current\n" +
      "- Node.js release archive\n" +
      "  https://nodejs.org/en/download/archive/current";
    const res = sse([
      { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", annotations: [], text }] }] } },
    ]);
    const out = await parseSidecarSSE(res);
    expect(out.sources).toEqual([
      { url: "https://nodejs.org/en/download/current", title: "Node.js Download page" },
      { url: "https://nodejs.org/en/download/archive/current", title: "Node.js release archive" },
    ]);
    expect(out.text).toBe("Answer.");
  });

  test("strips trailing punctuation from captured URLs", async () => {
    const text = "Answer.\n\nSources:\n" +
      "- First: https://x.test/a;\n" +
      "- Second: https://x.test/b.\n" +
      "- Third: <https://x.test/c>,";
    const res = sse([
      { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", annotations: [], text }] }] } },
    ]);
    const out = await parseSidecarSSE(res);
    expect(out.sources.map(s => s.url)).toEqual([
      "https://x.test/a", "https://x.test/b", "https://x.test/c",
    ]);
  });

  test("preserves prose that follows the source list instead of stripping to EOF", async () => {
    const text = "Answer body.\n\nSources:\n" +
      "- One: https://x.test/1\n" +
      "- Two: https://x.test/2\n\n" +
      "Note: prices may have changed since publication.";
    const res = sse([
      { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", annotations: [], text }] }] } },
    ]);
    const out = await parseSidecarSSE(res);
    expect(out.sources.map(s => s.url)).toEqual(["https://x.test/1", "https://x.test/2"]);
    expect(out.text).toBe("Answer body.\n\nNote: prices may have changed since publication.");
    expect(out.text).not.toContain("Sources");
    expect(out.text).not.toContain("x.test");
  });
});
