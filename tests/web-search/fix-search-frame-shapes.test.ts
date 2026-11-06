import { describe, expect, test } from "bun:test";
import { parseSidecarSSE } from "../../src/web-search/parse";

const response = (frames: unknown[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""));
describe("search SSE field shapes", () => {
  test.each([7, {}, [], true])("ignores a non-string event type: %j", async type => {
    const result = await parseSidecarSSE(response([{ type }, { type: "response.output_text.delta", delta: "kept" }, { type: "response.completed" }]));
    expect(result).toEqual({ text: "kept", sources: [] });
  });
  test.each([{}, "invalid", 7])("keeps deltas if terminal output is not an array: %j", async output => {
    const result = await parseSidecarSSE(response([{ type: "response.output_text.delta", delta: "kept" }, { type: "response.completed", response: { output } }]));
    expect(result.text).toBe("kept");
  });
  test("skips null output/content entries and non-array annotations", async () => {
    const result = await parseSidecarSSE(response([{ type: "response.completed", response: { output: [
      null, 7, { type: "message", content: [null, false, { type: "output_text", text: "kept", annotations: {} }] },
    ] } }]));
    expect(result).toEqual({ text: "kept", sources: [] });
  });
  test("prefers streamed text over a completed output that skipped malformed entries", async () => {
    const citation = { type: "url_citation", url: "https://example.com/second", title: "Second" };
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", delta: "First. Second." },
      { type: "response.completed", response: { output: [
        null, { type: "message", content: [{ type: "output_text", text: "Second.", annotations: [citation] }] },
      ] } },
    ]));
    expect(result).toEqual({ text: "First. Second.", sources: [{ url: citation.url, title: citation.title }] });
  });
  test("keeps a part's deltas when only another part sent its done text", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "First. " },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "First. " },
      { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "Second." },
      { type: "response.completed", response: { output: [
        null, { type: "message", content: [{ type: "output_text", text: "Second." }] },
      ] } },
    ]));
    expect(result).toEqual({ text: "First. Second.", sources: [] });
  });
  test("uses each part's done text over its own deltas", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "draft" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "First. " },
      { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "Second." },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "First. Second.", sources: [] });
  });
  test("matches an unindexed done event to the only indexed part", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello" },
      { type: "response.output_text.done", text: "Hello" },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "Hello", sources: [] });
  });
  test("matches an indexed done event to preceding unindexed deltas", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "Hello" },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "Hello", sources: [] });
  });
  test("keeps distinct indexed parts after identifying an unindexed part", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", delta: "draft" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "Second. " },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "First. " },
      { type: "response.output_text.done", output_index: 0, content_index: 1, text: "Middle. " },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "First. Middle. Second. ", sources: [] });
  });
  test("keeps ambiguous unindexed text separate when multiple indexed parts exist", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "First. " },
      { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "Second. " },
      { type: "response.output_text.delta", delta: "Unindexed." },
      { type: "response.output_text.done", output_index: 2, content_index: 0, text: "Third. " },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "First. Second. Third. Unindexed.", sources: [] });
  });
  test("assembles indexed parts in index order rather than arrival order", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "Second." },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "First. " },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "First. Second.", sources: [] });
  });
  test("keeps valid completed parts that the indexed stream never sent", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "First. " },
      { type: "response.completed", response: { output: [
        null, { type: "message", content: [{ type: "output_text", text: "Second." }] },
      ] } },
    ]));
    expect(result).toEqual({ text: "First. Second.", sources: [] });
  });
  test("fills an output_text block whose text is not a string from the indexed stream", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", output_index: 0, content_index: 1, delta: "Second." },
      { type: "response.completed", response: { output: [
        { type: "message", content: [{ type: "output_text", text: "First. " }, { type: "output_text", text: 42 }] },
      ] } },
    ]));
    expect(result).toEqual({ text: "First. Second.", sources: [] });
  });
  test("keeps the completed text when malformed entries leave no streamed text", async () => {
    const result = await parseSidecarSSE(response([{ type: "response.completed", response: { output: [
      { type: "message", content: "not-an-array" }, { type: "message", content: [{ type: "output_text", text: "kept" }] },
    ] } }]));
    expect(result).toEqual({ text: "kept", sources: [] });
  });
  test("does not expose non-string error messages", async () => {
    const result = await parseSidecarSSE(response([{ type: "response.failed", response: { error: { message: { raw: true } } } }]));
    expect(result.error).toBe("sidecar stream ended with response.failed");
  });
  test.each(["response.failed", "response.incomplete", "error"])("uses a fallback for empty or blank %s messages", async type => {
    for (const message of ["", " \t\n"]) {
      for (const error of [{ response: { error: { message } } }, { error: { message } }, { message }]) {
        const result = await parseSidecarSSE(response([
          { type: "response.output_text.delta", delta: "partial" },
          { type, ...error },
        ]));
        expect(result).toEqual({ text: "partial", sources: [], error: `sidecar stream ended with ${type}` });
      }
    }
  });
});
