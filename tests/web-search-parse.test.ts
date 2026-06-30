import { describe, expect, test } from "bun:test";
import { parseSidecarSSE } from "../src/web-search/parse";

function sse(events: { type: string; [k: string]: unknown }[]): Response {
  const body = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

describe("parseSidecarSSE trailing Sources block", () => {
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
