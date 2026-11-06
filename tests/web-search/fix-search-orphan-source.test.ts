import { describe, expect, test } from "bun:test";
import { parseSidecarSSE } from "../../src/web-search/parse";

/** Parse `text` as the only output text of a completed sidecar stream. */
async function parse(text: string) {
  return parseSidecarSSE(new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  } })}\n\n`));
}
describe("search source-list text ownership", () => {
  test("preserves a trailing bullet without a URL", async () => {
    const result = await parse("Answer\n\nSources:\n- https://example.com\n- Remember this conclusion");
    expect(result.text).toBe("Answer\n\n- Remember this conclusion");
    expect(result.sources).toEqual([{ url: "https://example.com" }]);
  });
  test("keeps the first of consecutive unmatched bullets before another URL", async () => {
    const result = await parse("Answer\nSources:\n- https://example.com\n- First note\n- Second note\nhttps://example.org");
    expect(result.text).toBe("Answer\n\n- First note");
    expect(result.sources).toEqual([{ url: "https://example.com" }, { title: "Second note", url: "https://example.org" }]);
  });
  test("preserves a pending note when the next citation has its own title", async () => {
    const result = await parse("Answer\nSources:\n- https://example.com\n- Keep this note\n- Another source: https://example.org");
    expect(result.text).toBe("Answer\n\n- Keep this note");
    expect(result.sources).toEqual([{ url: "https://example.com" }, { title: "Another source", url: "https://example.org" }]);
  });
  test("keeps a note but not a rejected self-titled credential URL", async () => {
    const result = await parse("Answer\nSources:\n- https://example.com\n- Keep this note\n- Token: https://user:secret@private.test/x");
    expect(result.text).toBe("Answer\n\n- Keep this note");
    expect(result.text).not.toContain("secret");
    expect(result.sources).toEqual([{ url: "https://example.com" }]);
  });
  test("keeps a note but not a rejected credential URL after consecutive notes", async () => {
    const result = await parse("Answer\nSources:\n- https://example.com\n- First note\n- Second note\nhttps://user:secret@private.test");
    expect(result.text).toBe("Answer\n\n- First note");
    expect(result.text).not.toContain("secret");
    expect(result.sources).toEqual([{ url: "https://example.com" }]);
  });
  test("treats URI-like text inside inline code as a note", async () => {
    const result = await parse("Answer\nSources:\n- https://example.com\n- Set `mode:fast` before retrying");
    expect(result.text).toBe("Answer\n\n- Set `mode:fast` before retrying");
    expect(result.sources).toEqual([{ url: "https://example.com" }]);
  });
  test("treats URI-like text inside a double-backtick code span as a note", async () => {
    const result = await parse("Answer\nSources:\n- https://example.com\n- Set ``mode:fast`` before retrying");
    expect(result.text).toBe("Answer\n\n- Set ``mode:fast`` before retrying");
    expect(result.sources).toEqual([{ url: "https://example.com" }]);
  });
  test("keeps a note before a bare URL that starts its own list item", async () => {
    const result = await parse("Answer\nSources:\n- https://example.com\n- Keep this note\n- https://example.org");
    expect(result.text).toBe("Answer\n\n- Keep this note");
    expect(result.sources).toEqual([{ url: "https://example.com" }, { url: "https://example.org" }]);
  });
  test("keeps a plus-bullet note before a marked URL item", async () => {
    const result = await parse("Answer\nSources:\n+ Keep this note\n- https://example.com");
    expect(result.text).toBe("Answer\n\n+ Keep this note");
    expect(result.sources).toEqual([{ url: "https://example.com" }]);
  });
  test("strips the closing backtick from a code-formatted citation URL", async () => {
    const result = await parse("Answer\nSources:\n- `https://example.com/page`");
    expect(result.text).toBe("Answer");
    expect(result.sources).toEqual([{ url: "https://example.com/page" }]);
  });
  test("masks inline code in linear time on long unmatched backtick runs", async () => {
    // The previous backreference regex took about 3 s on this 16 KiB line, and the unbounded
    // URI scheme pattern grew quadratically on a long word without a colon.
    const unmatched = "`".repeat(8_000) + "x".repeat(8_000);
    const longWord = "x".repeat(32_000);
    const started = performance.now();
    const result = await parse(`Answer\nSources:\n- https://example.com\n- ${unmatched} mode:fast\n- ${longWord} mode:fast`);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.text).toBe("Answer");
    expect(result.sources).toEqual([{ url: "https://example.com" }]);
  });
  test("still consumes a title followed immediately by its URL", async () => {
    const result = await parse("Answer\nSources:\n- A title\nhttps://example.com\n\nConclusion");
    expect(result.text).toBe("Answer\n\nConclusion");
    expect(result.sources).toEqual([{ title: "A title", url: "https://example.com" }]);
  });
});
