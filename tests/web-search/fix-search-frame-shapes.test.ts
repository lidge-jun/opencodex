import { describe, expect, spyOn, test } from "bun:test";
import { MAX_SIDECAR_DECODED_CHARS, parseSidecarSSE } from "../../src/web-search/parse";

const response = (frames: unknown[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""));

describe("sidecar text-done snapshots", () => {
  test.each([false, true])("orders output-only parts among fully indexed parts, reverse arrival: %s", async reverse => {
    const frames = [
      { type: "response.output_text.done", output_index: 0, text: "A" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "B" },
    ];
    if (reverse) frames.reverse();
    expect(await parseSidecarSSE(response([...frames, { type: "response.completed" }])))
      .toEqual({ text: "AB", sources: [] });
  });

  test("reconciles a unique output-only part with a partial completed output", async () => {
    expect(await parseSidecarSSE(response([
      { type: "response.output_text.done", output_index: 0, text: "draft" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "B" },
      { type: "response.completed", response: { output: [
        { type: "message", content: [{ type: "output_text", text: "A" }] }, null,
      ] } },
    ]))).toEqual({ text: "AB", sources: [] });
  });

  test("does not infer a content index from a multi-part completed item", async () => {
    expect(await parseSidecarSSE(response([
      { type: "response.output_text.done", output_index: 0, text: "A" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "B" },
      { type: "response.completed", response: { output: [
        { type: "message", content: [{ type: "output_text", text: "X" }, { type: "output_text", text: "Y" }] }, null,
      ] } },
    ]))).toEqual({ text: "XYAB", sources: [] });
  });

  test("fills a missing completed output from an output-only stream without full indexes", async () => {
    expect(await parseSidecarSSE(response([
      { type: "response.output_text.done", output_index: 0, text: "A" },
      { type: "response.completed", response: { output: [
        null, { type: "message", content: [{ type: "output_text", text: "B" }] },
      ] } },
    ]))).toEqual({ text: "AB", sources: [] });
  });

  test("does not reconcile an output-only part with a conflicting completed item ID", async () => {
    expect(await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "a", output_index: 0, text: "A" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "B" },
      { type: "response.completed", response: { output: [
        { id: "other", type: "message", content: [{ type: "output_text", text: "X" }] }, null,
      ] } },
    ]))).toEqual({ text: "XAB", sources: [] });
  });

  test("fills a malformed single completed text block from its output-only stream", async () => {
    expect(await parseSidecarSSE(response([
      { type: "response.output_text.done", output_index: 0, text: "A" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "B" },
      { type: "response.completed", response: { output: [
        { type: "message", content: [{ type: "output_text", text: 7 }] }, null,
      ] } },
    ]))).toEqual({ text: "AB", sources: [] });
  });

  test("keeps distinct output-only indexes and repeated snapshots", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", output_index: 0, text: "First. " },
      { type: "response.output_text.done", output_index: 1, text: "Second." },
      { type: "response.output_text.done", output_index: 0, text: "First. " },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "First. Second.", sources: [] });
  });

  test.each([false, true])("reconciles output-only and full identities with other parts present: %s", async fullFirst => {
    const partial = { output_index: 1 };
    const full = { output_index: 1, content_index: 0 };
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "First. " },
      { type: "response.output_text.delta", ...(fullFirst ? full : partial), delta: "draft" },
      { type: "response.output_text.done", ...(fullFirst ? partial : full), text: "Second." },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "First. Second.", sources: [] });
  });

  test("keeps output identities separate even when item IDs conflict with them", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "a", output_index: 0, text: "First. " },
      { type: "response.output_text.done", item_id: "a", output_index: 1, text: "Second." },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "First. Second.", sources: [] });
  });

  test("reconciles a malformed completed part at its original position", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "a", text: "First. " },
      { type: "response.output_text.done", item_id: "b", text: "Second." },
      { type: "response.completed", response: { output: [
        { id: "a", type: "message", content: [{ type: "output_text", text: 7 }] },
        { id: "b", type: "message", content: [{ type: "output_text", text: "Second." }] },
      ] } },
    ]));
    expect(result).toEqual({ text: "First. Second.", sources: [] });
  });

  test("keeps distinct content indexes without item or output identity", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", content_index: 0, text: "First. " },
      { type: "response.output_text.done", content_index: 1, text: "Second." },
      { type: "response.output_text.done", content_index: 0, text: "First. " },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "First. Second.", sources: [] });
  });

  test.each([false, true])("indexed part lookup does bounded work with item identity: %s", async identified => {
    const frames: unknown[] = Array.from({ length: 1000 }, (_, output_index) =>
      ({ type: "response.output_text.delta", output_index, content_index: output_index,
        ...(identified ? { item_id: "item_a" } : {}), delta: "" }));
    frames.push({ type: "response.completed" });
    let scanned = 0;
    const methods = ["entries", "keys", "values", Symbol.iterator] as const;
    const spies = methods.map(method => {
      const original = Map.prototype[method];
      return spyOn(Map.prototype, method).mockImplementation(function (this: Map<unknown, unknown>) {
        scanned += this.size;
        return Reflect.apply(original, this, []);
      });
    });
    try {
      expect(await parseSidecarSSE(response(frames))).toEqual({ text: "", sources: [] });
      expect(scanned).toBeLessThanOrEqual(10000);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test.each([false, true])("keeps distinct item IDs when the first event is indexed: %s", async indexed => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "item_a", ...(indexed ? { output_index: 0, content_index: 0 } : {}), text: "First. " },
      { type: "response.output_text.done", item_id: "item_b", text: "Second." },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "First. Second.", sources: [] });
  });

  test.each([false, true])("matches the same item across indexed and unindexed events, indexed first: %s", async indexedFirst => {
    const indexed = { item_id: "item_a", output_index: 0, content_index: 0 };
    const unindexed = { item_id: "item_a" };
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", ...(indexedFirst ? indexed : unindexed), delta: "draft" },
      { type: "response.output_text.done", ...(indexedFirst ? unindexed : indexed), text: "Final" },
      { type: "response.output_text.done", item_id: "item_a", text: "Final" },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "Final", sources: [] });
  });

  test("keeps distinct content parts of the same unindexed item", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "item_a", content_index: 0, text: "First. " },
      { type: "response.output_text.done", item_id: "item_a", content_index: 1, text: "Second." },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "First. Second.", sources: [] });
  });

  test("tracks identity as an unindexed part gains an item and content index", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", delta: "draft" },
      { type: "response.output_text.done", item_id: "item_a", text: "old" },
      { type: "response.output_text.done", item_id: "item_a", content_index: 0, text: "First. " },
      { type: "response.output_text.done", item_id: "item_a", content_index: 1, text: "Second." },
      { type: "response.output_text.done", item_id: "item_a", content_index: 0, text: "First. " },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "First. Second.", sources: [] });
  });

  test("matches item identity among multiple parts and preserves indexed order", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", item_id: "item_b", output_index: 1, content_index: 0, delta: "draft" },
      { type: "response.output_text.done", item_id: "item_a", output_index: 0, content_index: 0, text: "First. " },
      { type: "response.output_text.done", item_id: "item_b", text: "Second." },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "First. Second.", sources: [] });
  });

  test("keeps streamed identified items when completed output is malformed", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "item_a", text: "First. " },
      { type: "response.output_text.done", item_id: "item_b", text: "Second." },
      { type: "response.completed", response: { output: [null] } },
    ]));
    expect(result).toEqual({ text: "First. Second.", sources: [] });
  });
  for (const indexed of [false, true]) {
    test(`repeated ${indexed ? "indexed" : "unindexed"} done text is not appended twice`, async () => {
      const indexes = indexed ? { output_index: 0, content_index: 0 } : {};
      const done = { type: "response.output_text.done", ...indexes, text: "Final answer 😀" };
      expect(await parseSidecarSSE(response([done, done, { type: "response.completed" }])))
        .toEqual({ text: "Final answer 😀", sources: [] });
    });
  }

  test("the last full snapshot replaces earlier text for the same part", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "draft" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "First version" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "Final version" },
      { type: "response.output_text.done", output_index: 0, content_index: 1, text: " Other part." },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "Final version Other part.", sources: [] });
  });

  test.each(["", "   "])("a blank final snapshot replaces the draft: %j", async text => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "draft" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "final" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text, sources: [] });
  });

  test("distinct parts with identical done text remain distinct", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "Same." },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "Same." },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "Same.Same.", sources: [] });
  });

  test("partial completed output falls back to the last snapshot of its missing part", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "Old" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "Final" },
      { type: "response.completed", response: { output: [
        null, { type: "message", content: [{ type: "output_text", text: " second" }] },
      ] } },
    ]));
    expect(result).toEqual({ text: "Final second", sources: [] });
  });

  test("a blank snapshot does not restore a missing part's draft during partial completion", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "draft" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "" },
      { type: "response.completed", response: { output: [
        null, { type: "message", content: [{ type: "output_text", text: "second" }] },
      ] } },
    ]));
    expect(result).toEqual({ text: "second", sources: [] });
  });

  test("repeated full snapshots still consume the decoded payload budget", async () => {
    const done = { type: "response.output_text.done", output_index: 0, content_index: 0,
      text: "x".repeat(Math.floor(MAX_SIDECAR_DECODED_CHARS / 2) + 1) };
    const result = await parseSidecarSSE(response([done, done, { type: "response.completed" }]));
    expect(result.error).toBe("sidecar response decoded text limit reached");
  });
});

describe("search SSE field shapes", () => {
  test("matches completed item identity to an unindexed stream during partial completion", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", item_id: "a", delta: "draft " },
      { type: "response.output_text.done", item_id: "b", text: "second" },
      { type: "response.completed", response: { output: [
        { id: "a", type: "message", content: [{ type: "output_text", text: "authoritative " }] }, null,
      ] } },
    ]));
    expect(result).toEqual({ text: "authoritative second", sources: [] });
  });
  test("matches identified content parts independently during partial completion", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", item_id: "a", content_index: 1, delta: "draft second" },
      { type: "response.output_text.delta", item_id: "a", content_index: 0, delta: "draft first" },
      { type: "response.output_text.done", item_id: "b", text: " third" },
      { type: "response.completed", response: { output: [
        { id: "a", type: "message", content: [
          { type: "output_text", text: "first" }, { type: "output_text", text: " second" },
        ] }, null,
      ] } },
    ]));
    expect(result).toEqual({ text: "first second third", sources: [] });
  });
  for (const identity of [{ item_id: "a" }, { output_index: 1 }]) {
    test(`retains a content part when it gains identity ${JSON.stringify(identity)}`, async () => {
      const result = await parseSidecarSSE(response([
        { type: "response.output_text.done", content_index: 0, text: "First. " },
        { type: "response.output_text.done", content_index: 1, text: "Second." },
        { type: "response.output_text.done", content_index: 1, ...identity, text: "Second." },
        { type: "response.completed" },
      ]));
      expect(result).toEqual({ text: "First. Second.", sources: [] });
    });
  }
  test("does not merge content-only parts after their item identities conflict", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", content_index: 0, text: "First. " },
      { type: "response.output_text.done", item_id: "a", content_index: 0, text: "First. " },
      { type: "response.output_text.done", item_id: "b", content_index: 0, text: "Second." },
      { type: "response.completed" },
    ]));
    expect(result).toEqual({ text: "First. Second.", sources: [] });
  });
  test("preserves completed indexed text alongside a separate unindexed part", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", item_id: "a", output_index: 0, content_index: 0, delta: "draft " },
      { type: "response.output_text.done", item_id: "b", text: "second" },
      { type: "response.completed", response: { output: [
        { type: "message", content: [{ type: "output_text", text: "authoritative " }] }, null,
      ] } },
    ]));
    expect(result).toEqual({ text: "authoritative second", sources: [] });
  });
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
