import { describe, expect, spyOn, test } from "bun:test";
import { MAX_SIDECAR_DECODED_CHARS, parseSidecarSSE } from "../../src/web-search/parse";

const response = (frames: unknown[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""));

describe("identity transition matrix", () => {
  test.each([
    { draft: 0, anonymous: 1, initial: "X", other: "Y", final: "Second.", expected: "Second.Y" },
    { draft: 1, anonymous: 0, initial: "X", other: "Y", final: "Second.", expected: "YSecond." },
    { draft: 0, anonymous: 1, initial: "A", other: "B", final: "A2", expected: "A2B" },
  ])("preserves both known content positions when the link omits its index: %j", async entry => {
    expect(await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "a", output_index: 0, content_index: entry.draft, text: entry.initial },
      { type: "response.output_text.done", output_index: 0, content_index: entry.anonymous, text: entry.other },
      { type: "response.output_text.done", item_id: "a", output_index: 0, text: entry.final },
      { type: "response.completed" },
    ]))).toEqual({ text: entry.expected, sources: [] });
  });

  test("links a unique item-only draft to an anonymous part with a known content index", async () => {
    expect(await parseSidecarSSE(response([
      { type: "response.output_text.delta", item_id: "a", delta: "A" },
      { type: "response.output_text.delta", item_id: "b", delta: "draft" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "B" },
      { type: "response.output_text.done", item_id: "b", output_index: 1, text: "B" },
      { type: "response.completed" },
    ]))).toEqual({ text: "BA", sources: [] });
  });

  test("emits positioned content-key parts once across promotions and partial finals", async () => {
    for (const kind of ["delta", "done"]) for (const partial of [false, true]) {
      const event = (identity: object, text: string) => ({
        type: `response.output_text.${kind}`, ...identity, [kind === "done" ? "text" : "delta"]: text,
      });
      const result = await parseSidecarSSE(response([
        event({ content_index: 0 }, "A"),
        event({ item_id: "a", content_index: 0 }, kind === "done" ? "A" : ""),
        event({ item_id: "b", output_index: 0, content_index: 0 }, "B"),
        event({ item_id: "a", output_index: 0 }, kind === "done" ? "A" : ""),
        event({ content_index: 1 }, "C"),
        event({ content_index: 1, output_index: 1 }, kind === "done" ? "C" : ""),
        partial ? { type: "response.completed", response: { output: [
          { id: "x", type: "message", content: [{ type: "output_text", text: "X" }] }, null,
        ] } } : { type: "response.completed" },
      ]));
      expect({ kind, partial, text: result.text }).toEqual({ kind, partial, text: partial ? "XABC" : "ABC" });
    }
  });

  test("reconciles output-only snapshots when a later snapshot links the item", async () => {
    const event = (kind: string, identity: object, text: string) => ({
      type: `response.output_text.${kind}`, ...identity, [kind === "done" ? "text" : "delta"]: text,
    });
    for (const first of ["delta", "done"]) for (const anonymous of ["delta", "done"]) for (const anonymousContent of [false, true])
      for (const linkedContent of [false, true]) for (const linkDelta of [false, true])
        for (const reverse of [false, true]) for (const terminal of ["empty", "partial", "complete"]) {
          const drafts = [event(first, { item_id: "a" }, "A"), event(first, { item_id: "b" }, "draft")];
          if (reverse) drafts.reverse();
          const link = { item_id: "b", output_index: 1, ...(linkedContent ? { content_index: 0 } : {}) };
          const result = await parseSidecarSSE(response([
            ...drafts,
            event(anonymous, { output_index: 1, ...(anonymousContent ? { content_index: 0 } : {}) }, "B"),
            ...(linkDelta ? [event("delta", link, "!")] : []),
            event("done", link, "B"),
            terminal === "empty" ? { type: "response.completed" } : {
              type: "response.completed", response: { output: [
                terminal === "partial" ? null : { type: "message", content: [{ type: "output_text", text: "A" }] },
                { id: "b", type: "message", content: [{ type: "output_text", text: "B" }] },
              ] },
            },
          ]));
          expect({ first, anonymous, anonymousContent, linkedContent, linkDelta, reverse, terminal, text: result.text })
            .toEqual({ first, anonymous, anonymousContent, linkedContent, linkDelta, reverse, terminal, text: terminal === "complete" ? "AB" : "BA" });
        }
  });

  test.each([false, true])("keeps a third identity at an output-only position, content index: %s", async content => {
    const position = { output_index: 1, ...(content ? { content_index: 0 } : {}) };
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", item_id: "a", delta: "A" },
      { type: "response.output_text.delta", item_id: "b", delta: "draft" },
      { type: "response.output_text.done", ...position, text: "C" },
      { type: "response.output_text.delta", item_id: "b", ...position, delta: "!" },
      { type: "response.output_text.done", item_id: "c", ...position, text: "D" },
      { type: "response.output_text.done", item_id: "b", ...position, text: "B" },
      { type: "response.completed" },
    ]));
    for (const text of ["A", "B", "C", "D"]) expect(result.text).toContain(text);
  });

  test("does not iterate an ambiguous output bucket while linking snapshots", async () => {
    const frames: unknown[] = Array.from({ length: 400 }, (_, i) =>
      ({ type: "response.output_text.done", item_id: `item_${i}`, output_index: 1, text: "" }));
    frames.push(...Array.from({ length: 400 }, (_, i) =>
      ({ type: "response.output_text.done", item_id: `item_${i}`, output_index: 1, content_index: 0, text: "" })));
    frames.push({ type: "response.completed" });
    let visited = 0;
    const original = Set.prototype[Symbol.iterator];
    const spy = spyOn(Set.prototype, Symbol.iterator).mockImplementation(function (this: Set<unknown>) {
      visited += this.size;
      return Reflect.apply(original, this, []);
    });
    try {
      expect((await parseSidecarSSE(response(frames))).text).toBe("");
      expect(visited).toBeLessThanOrEqual(800);
    } finally {
      spy.mockRestore();
    }
  });

  test.each([false, true])("retains a different content index when the link omits it: %s", async omitted => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", item_id: "a", content_index: 1, delta: "A" },
      { type: "response.output_text.delta", item_id: "b", content_index: 1, delta: "draft" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "C" },
      { type: "response.output_text.done", item_id: "b", output_index: 1, ...(omitted ? {} : { content_index: 1 }), text: "B" },
      { type: "response.completed" },
    ]));
    expect(result.text).toBe("CBA");
  });

  test("keeps the draft's content index when a linking snapshot omits it", async () => {
    expect(await parseSidecarSSE(response([
      { type: "response.output_text.delta", item_id: "a", content_index: 1, delta: "A" },
      { type: "response.output_text.delta", item_id: "b", content_index: 1, delta: "draft" },
      { type: "response.output_text.done", output_index: 1, text: "old" },
      { type: "response.output_text.done", item_id: "b", output_index: 1, text: "B" },
      { type: "response.output_text.done", item_id: "b", output_index: 1, content_index: 0, text: "C" },
      { type: "response.output_text.done", item_id: "b", content_index: 1, text: "B" },
      { type: "response.completed" },
    ]))).toEqual({ text: "CBA", sources: [] });
  });

  test("does not discard an anonymous snapshot on a linking delta alone", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", item_id: "a", delta: "A" },
      { type: "response.output_text.delta", item_id: "b", delta: "draft" },
      { type: "response.output_text.done", output_index: 1, text: "B" },
      { type: "response.output_text.delta", item_id: "b", output_index: 1, content_index: 0, delta: "!" },
      { type: "response.completed" },
    ]));
    expect(result.text).toBe("draft!BA");
  });

  test("joins an anonymous snapshot after a draft gains its position via delta", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", item_id: "a", content_index: 0, delta: "A" },
      { type: "response.output_text.delta", item_id: "b", content_index: 0, delta: "draft" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "B" },
      { type: "response.output_text.delta", item_id: "b", output_index: 1, content_index: 0, delta: "!" },
      { type: "response.output_text.done", item_id: "b", output_index: 1, content_index: 0, text: "B" },
      { type: "response.completed" },
    ]));
    expect(result.text).toBe("BA");
  });

  test("reconciles uniquely linked identities across event types, ordering and final output", async () => {
    const event = (kind: string, identity: object, text: string) => ({
      type: `response.output_text.${kind}`, ...identity, [kind === "done" ? "text" : "delta"]: text,
    });
    for (const first of ["delta", "done"]) for (const anonymous of ["delta", "done"])
      for (const promotion of ["delta", "done"]) for (const reverse of [false, true]) for (const itemOnly of [false, true])
        for (const terminal of ["empty", "partial", "complete"]) {
          const content = itemOnly ? {} : { content_index: 0 };
          const drafts = [event(first, { item_id: "a", ...content }, "A"),
            event(first, { item_id: "b", ...content }, "draft")];
          if (reverse) drafts.reverse();
          const result = await parseSidecarSSE(response([
            ...drafts,
            event(anonymous, { output_index: 1, content_index: 0 }, "B"),
            event(promotion, { item_id: "b", output_index: 1, content_index: 0 }, "draft"),
            event("done", { item_id: "b", output_index: 1, content_index: 0 }, "B"),
            terminal === "empty" ? { type: "response.completed" } : {
              type: "response.completed", response: { output: [
                terminal === "partial" ? null : { type: "message", content: [{ type: "output_text", text: "A" }] },
                { id: "b", type: "message", content: [{ type: "output_text", text: "B" }] },
              ] },
            },
          ]));
          expect(result.text).toBe(terminal === "complete" ? "AB" : "BA");
        }
  });

  test.each([false, true])("a third part at the position prevents merging, partial final: %s", async partial => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", item_id: "a", content_index: 0, delta: "A" },
      { type: "response.output_text.delta", item_id: "b", content_index: 0, delta: "draft" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "C" },
      { type: "response.output_text.delta", item_id: "b", output_index: 1, content_index: 0, delta: "!" },
      { type: "response.output_text.done", item_id: "c", output_index: 1, content_index: 0, text: "D" },
      { type: "response.output_text.done", item_id: "b", output_index: 1, content_index: 0, text: "B" },
      partial ? { type: "response.completed", response: { output: [null,
        { id: "b", type: "message", content: [{ type: "output_text", text: "B" }] },
      ] } } : { type: "response.completed" },
    ]));
    expect(result.text).toBe("BCDA");
  });
  test("promotes a unique item-only draft when an indexed snapshot arrives", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "a", output_index: 0, content_index: 0, text: "A" },
      { type: "response.output_text.delta", item_id: "b", delta: "draftB" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "B" },
      { type: "response.completed" },
    ]));
    expect(result.text).toBe("AB");
  });

  test("preserves item-only drafts when another unpositioned part is compatible", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", item_id: "a", delta: "A" },
      { type: "response.output_text.delta", item_id: "b", content_index: 0, delta: "B" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "C" },
      { type: "response.completed" },
    ]));
    expect(result.text).toBe("CAB");
  });

  test("keeps an indexed snapshot separate when its position has competing identities", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "a", output_index: 0, content_index: 0, text: "A" },
      { type: "response.output_text.done", item_id: "b", output_index: 0, content_index: 0, text: "B" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "C" },
      { type: "response.completed" },
    ]));
    expect(result.text).toBe("ABC");
  });

  test("preserves competing indexed parts beside an anonymous partial completed slot", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "a", output_index: 0, content_index: 0, text: "A" },
      { type: "response.output_text.done", item_id: "b", output_index: 0, content_index: 0, text: "B" },
      { type: "response.completed", response: { output: [
        { type: "message", content: [{ type: "output_text", text: "C" }] }, null,
      ] } },
    ]));
    expect(result.text).toBe("CAB");
  });

  test("matches an identified completed slot without discarding an anonymous competing snapshot", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", item_id: "a", content_index: 0, delta: "A" },
      { type: "response.output_text.delta", item_id: "b", content_index: 0, delta: "draftB" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "C" },
      { type: "response.output_text.delta", item_id: "b", output_index: 1, content_index: 0, delta: "!" },
      { type: "response.completed", response: { output: [null,
        { id: "b", type: "message", content: [{ type: "output_text", text: "B" }] },
      ] } },
    ]));
    expect(result.text).toContain("A");
    expect(result.text).toContain("B");
    expect(result.text).toContain("C");
    expect(result.text).not.toContain("draftB");
  });

  test("uses an explicit item identity when an indexed position is ambiguous", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "a", output_index: 0, content_index: 0, text: "A" },
      { type: "response.output_text.done", item_id: "b", output_index: 0, text: "draftB" },
      { type: "response.output_text.done", item_id: "b", output_index: 0, content_index: 0, text: "B" },
      { type: "response.completed" },
    ]));
    expect(result.text).toBe("AB");
  });

  test("retains all parts when the output index has competing item identities", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "a", output_index: 0, text: "A" },
      { type: "response.output_text.done", item_id: "b", output_index: 0, text: "B" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "C" },
      { type: "response.completed" },
    ]));
    expect(result.text).toBe("CAB");
  });

  test("joins an ambiguous snapshot only when a later frame supplies both identities", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", item_id: "a", content_index: 0, delta: "A" },
      { type: "response.output_text.delta", item_id: "b", content_index: 0, delta: "draftB" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "B" },
      { type: "response.output_text.done", item_id: "b", output_index: 1, content_index: 0, text: "B" },
      { type: "response.completed" },
    ]));
    expect(result.text).toBe("BA");
  });
  test("matches a unique identified content part when an output index arrives without its item ID", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", item_id: "a", output_index: 0, content_index: 0, delta: "draftA" },
      { type: "response.output_text.delta", item_id: "b", content_index: 0, delta: "draftB" },
      { type: "response.output_text.done", item_id: "a", output_index: 0, content_index: 0, text: "A" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "B" },
      { type: "response.completed" },
    ]));
    expect(result.text).toBe("AB");
  });

  test("retains ambiguous identified content parts when an output index arrives without an item ID", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", item_id: "a", content_index: 0, delta: "A" },
      { type: "response.output_text.delta", item_id: "b", content_index: 0, delta: "B" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "C" },
      { type: "response.completed" },
    ]));
    expect(result.text).toBe("CAB");
  });

  test("does not prefer a content-only key over another compatible identified part", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", content_index: 0, delta: "draft" },
      { type: "response.output_text.done", item_id: "a", content_index: 0, text: "A" },
      { type: "response.output_text.done", item_id: "b", content_index: 0, text: "B" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "C" },
      { type: "response.completed" },
    ]));
    expect(result.text).toBe("CAB");
  });

  test.each([false, true])("looks up ambiguous unpositioned parts without scanning their bucket, item-only: %s", async itemOnly => {
    const frames: unknown[] = Array.from({ length: 500 }, (_, i) =>
      ({ type: "response.output_text.delta", item_id: `item_${i}`, ...(itemOnly ? {} : { content_index: 0 }), delta: "" }));
    frames.push(...Array.from({ length: 500 }, (_, output_index) =>
      ({ type: "response.output_text.done", output_index, content_index: 0, text: "" })));
    frames.push({ type: "response.completed" });
    let scanned = 0;
    const original = Set.prototype.values;
    const spy = spyOn(Set.prototype, "values").mockImplementation(function (this: Set<unknown>) {
      scanned += this.size;
      return Reflect.apply(original, this, []);
    });
    try {
      expect((await parseSidecarSSE(response(frames))).text).toBe("");
      expect(scanned).toBeLessThanOrEqual(1000);
    } finally {
      spy.mockRestore();
    }
  });

  test("matches the compatible content index without merging other identified parts", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.delta", item_id: "a", content_index: 1, delta: "A" },
      { type: "response.output_text.delta", item_id: "b", content_index: 0, delta: "draft" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "B" },
      { type: "response.completed" },
    ]));
    expect(result.text).toBe("BA");
  });

  test("preserves a part across overlapping identity subsets and partial completion", async () => {
    const fields = [{ item_id: "a" }, { output_index: 0 }, { content_index: 0 }];
    const identity = (mask: number) => Object.assign({}, ...fields.filter((_, bit) => mask & (1 << bit)));
    for (let first = 1; first < 8; first++) {
      for (let second = 1; second < 8; second++) {
        if (!(first & second) || !((first | second) & 2)) continue;
        for (const partial of [false, true]) {
          const result = await parseSidecarSSE(response([
            { type: "response.output_text.done", ...identity(first), text: "draft" },
            { type: "response.output_text.done", ...identity(second), text: "A" },
            { type: "response.output_text.done", output_index: 1, content_index: 0, text: "B" },
            partial
              ? { type: "response.completed", response: { output: [{ id: "a", type: "message", content: [{ type: "output_text", text: "Final" }] }, null] } }
              : { type: "response.completed" },
          ]));
          expect(result.text).toBe(partial ? "FinalB" : "AB");
        }
      }
    }
  });

  for (const first of [{ item_id: "a" }, { content_index: 0 }]) {
    for (const completion of [false, true]) {
      test(`accumulates output identity ${JSON.stringify(first)}, partial final ${completion}`, async () => {
        const frames: unknown[] = [
          { type: "response.output_text.done", ...first, text: "draft A" },
          { type: "response.output_text.done", ...first, output_index: 0, text: "A" },
          { type: "response.output_text.done", output_index: 1, content_index: 0, text: "B" },
          completion
            ? { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "Final A" }] }, null] } }
            : { type: "response.completed" },
        ];
        expect((await parseSidecarSSE(response(frames))).text).toBe(completion ? "Final AB" : "AB");
      });
    }
  }

  for (const conflict of [
    { item_id: "b", output_index: 0 },
    { item_id: "a", output_index: 1 },
    { item_id: "b", output_index: 0, content_index: 0 },
  ]) {
    test(`retains conflicting identity ${JSON.stringify(conflict)} after later events`, async () => {
      const result = await parseSidecarSSE(response([
        { type: "response.output_text.done", item_id: "a", output_index: 0, text: "A" },
        { type: "response.output_text.done", ...conflict, text: "B" },
        { type: "response.output_text.done", item_id: "c", output_index: 1, text: "C" },
        { type: "response.output_text.done", item_id: "b", output_index: 1, text: "D" },
        { type: "response.completed" },
      ]));
      for (const value of ["A", "B", "C", "D"]) expect(result.text).toContain(value);
    });
  }

  test("orders conflicting parts by their accumulated output indexes", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "a", output_index: 0, text: "A" },
      { type: "response.output_text.done", item_id: "b", output_index: 0, text: "B" },
      { type: "response.output_text.done", output_index: 1, content_index: 0, text: "C" },
      { type: "response.completed" },
    ]));
    expect(result.text).toBe("ABC");
  });

  test("repeated snapshots update the compatible part after conflicting identities", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "a", output_index: 0, text: "A" },
      { type: "response.output_text.done", item_id: "b", output_index: 0, text: "B" },
      { type: "response.output_text.done", item_id: "c", output_index: 1, text: "C" },
      { type: "response.output_text.done", item_id: "b", output_index: 1, text: "draft" },
      { type: "response.output_text.done", item_id: "b", output_index: 1, text: "D" },
      { type: "response.completed" },
    ]));
    expect(result.text).toBe("ABCD");
  });

  test("does not emit a content-only key twice when its acquired position is occupied", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", content_index: 0, text: "A" },
      { type: "response.output_text.done", item_id: "a", content_index: 0, text: "A" },
      { type: "response.output_text.done", item_id: "b", output_index: 0, content_index: 0, text: "B" },
      { type: "response.output_text.done", item_id: "a", output_index: 0, text: "A" },
      { type: "response.completed" },
    ]));
    expect(result.text).toBe("AB");
  });

  test("keeps a conflicting fully indexed stream beside a partial final slot", async () => {
    const result = await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "a", output_index: 0, content_index: 0, text: "A" },
      { type: "response.completed", response: { output: [
        { id: "b", type: "message", content: [{ type: "output_text", text: "B" }] }, null,
      ] } },
    ]));
    expect(result.text).toContain("A");
    expect(result.text).toContain("B");
  });
});

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

  test.each([null, undefined, {}, "invalid"])("keeps message position with malformed content: %j", async content => {
    for (const reverse of [false, true]) {
      const frames = [
        { type: "response.output_text.done", item_id: "a", text: "First. " },
        { type: "response.output_text.done", item_id: "b", text: "draft" },
      ];
      if (reverse) frames.reverse();
      expect(await parseSidecarSSE(response([
        ...frames,
        { type: "response.completed", response: { output: [
          { id: "a", type: "message", content },
          { id: "b", type: "message", content: [{ type: "output_text", text: "Second." }] },
        ] } },
      ]))).toEqual({ text: "First. Second.", sources: [] });
    }
  });

  test("orders all streamed content parts of a malformed completed message", async () => {
    expect(await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "a", content_index: 1, text: "second " },
      { type: "response.output_text.done", item_id: "a", content_index: 0, text: "First " },
      { type: "response.output_text.done", item_id: "b", text: "draft" },
      { type: "response.completed", response: { output: [
        { id: "a", type: "message", content: null },
        { id: "b", type: "message", content: [{ type: "output_text", text: "third." }] },
      ] } },
    ]))).toEqual({ text: "First second third.", sources: [] });
  });

  test("does not replace a conflicting streamed output index from a malformed message", async () => {
    expect(await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "a", output_index: 2, text: "A" },
      { type: "response.output_text.done", item_id: "b", text: "draft" },
      { type: "response.completed", response: { output: [
        { id: "a", type: "message", content: null },
        { id: "b", type: "message", content: [{ type: "output_text", text: "B" }] },
      ] } },
    ]))).toEqual({ text: "BA", sources: [] });
  });

  test("does not infer message positions from duplicate completed item IDs", async () => {
    expect(await parseSidecarSSE(response([
      { type: "response.output_text.done", item_id: "a", text: "A" },
      { type: "response.output_text.done", item_id: "b", text: "draft" },
      { type: "response.completed", response: { output: [
        { id: "a", type: "message", content: null },
        { id: "b", type: "message", content: [{ type: "output_text", text: "B" }] },
        { id: "a", type: "message", content: null },
      ] } },
    ]))).toEqual({ text: "BA", sources: [] });
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
