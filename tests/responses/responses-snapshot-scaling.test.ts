import { expect, spyOn, test } from "bun:test";
import { createResponsesSnapshotBlockRewrite } from "../../src/server/responses-snapshot-repair";
import { MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES as LIMIT } from "../../src/server/relay";

type Event = { type: string; delta?: string; text?: string; response?: { output?: Array<{ content: Array<{ text: string }> }> } };

function tracker() {
  const rewrite = createResponsesSnapshotBlockRewrite();
  const send = (event: Record<string, unknown>) => rewrite(`data: ${JSON.stringify(event)}`)
    .map(block => JSON.parse(block.slice("data: ".length)) as Event);
  const add = (index: number) => send({ type: "response.output_item.added", output_index: index, item: { type: "message", id: `m${index}` } });
  const delta = (index: number, text: string) => send({ type: "response.output_text.delta", output_index: index, item_id: `m${index}`, delta: text });
  const replace = (index: number, text: string) => send({ type: "response.output_text.done", output_index: index, item_id: `m${index}`, text });
  const finish = () => send({ type: "response.completed", response: { id: "r" } });
  return { rewrite, send, add, delta, replace, finish };
}

test("snapshot repair measures only new text instead of every accumulated prefix", () => {
  const t = tracker();
  t.add(0);
  const fragment = "x".repeat(256);
  const fragments = 1024;
  const original = Buffer.byteLength;
  let measuredChars = 0;
  let calls = 0;
  const measure = spyOn(Buffer, "byteLength");
  measure.mockImplementation((value, encoding) => {
    if (typeof value === "string") { measuredChars += value.length; calls++; }
    return original(value, encoding);
  });
  try {
    for (let i = 0; i < fragments; i++) t.delta(0, fragment);
  } finally {
    measure.mockRestore();
  }
  try {
    expect(calls).toBeGreaterThanOrEqual(fragments);
    expect(measuredChars).toBeLessThanOrEqual(fragment.length * fragments * 2);
    expect(t.finish().find(event => event.type === "response.output_text.done")?.text).toBe(fragment.repeat(fragments));
  } finally { t.rewrite.dispose?.(); }
});

for (const highSource of ["delta", "snapshot"] as const) {
  test(`snapshot repair counts a split surrogate pair at the byte cap (${highSource})`, () => {
    const t = tracker();
    try {
      t.add(0);
      const prefix = "x".repeat(LIMIT - 4) + "\ud83d";
      if (highSource === "delta") t.delta(0, prefix);
      else t.replace(0, prefix);
      t.delta(0, "");
      t.delta(0, "\ude00"); // The assembled emoji is 4 bytes, not two 3-byte replacements.
      t.replace(0, "ok");
      t.add(1);
      const output = t.delta(1, "x".repeat(LIMIT - 2));
      expect(output.map(event => event.type)).toContain("response.content_part.added");
      t.replace(1, "done");
      const terminal = t.finish();
      const items = terminal.find(event => event.type === "response.completed")?.response?.output;
      expect(items?.map(item => item.content[0]?.text)).toEqual(["ok", "done"]);
    } finally { t.rewrite.dispose?.(); }
  });
}

test("snapshot repair refunds closed text before admitting the next open item", () => {
  const t = tracker();
  try {
    t.add(0);
    t.delta(0, "x".repeat(LIMIT));
    t.send({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m0", content: [] } });
    t.add(1);
    expect(t.delta(1, "x".repeat(LIMIT)).map(event => event.type)).toContain("response.content_part.added");
  } finally { t.rewrite.dispose?.(); }
});

test("snapshot repair accepts the exact aggregate cap and stops retaining above it", () => {
  const t = tracker();
  try {
    t.add(0);
    t.add(1);
    t.delta(0, "x".repeat(LIMIT - 3));
    expect(t.delta(1, "한").map(event => event.type)).toContain("response.content_part.added");
    const overflow = t.delta(1, "!");
    expect(overflow.at(-1)?.delta).toBe("!");
    expect(t.finish().map(event => event.type)).toEqual(["response.completed"]);
  } finally { t.rewrite.dispose?.(); }
});

test("snapshot repair preserves empty, non-ASCII and unpaired-surrogate deltas", () => {
  const t = tracker();
  const deltas = ["한", "\ud83d", "", "\ude00", "\ud83d", "x", "\ude00"];
  try {
    t.add(0);
    for (const delta of deltas) expect(t.delta(0, delta).at(-1)?.delta).toBe(delta);
    const terminal = t.finish();
    expect(terminal.find(event => event.type === "response.output_text.done")?.text).toBe(deltas.join(""));
  } finally { t.rewrite.dispose?.(); }
});
