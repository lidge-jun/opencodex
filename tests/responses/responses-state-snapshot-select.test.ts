/**
 * The snapshot writer reuses the per-entry strings it already produced to measure each
 * entry, instead of serializing the whole selection a second time. That is only safe if
 * the file bytes stay exactly what \`JSON.stringify({ version: 2, states })\` wrote before:
 * the unchanged-payload digest skip and every reader depend on them. The expected
 * strings below were produced by the previous implementation.
 */
import { describe, expect, test } from "bun:test";
import type { StoredResponseState } from "../../src/responses/state";
import { selectSnapshotEntries, snapshotPayload } from "../../src/responses/state/snapshot-select";

const RESIDENT_ENTRY_MAX_BYTES = 200;

function fixtureStates(): Map<string, StoredResponseState> {
  const rows: Array<[string, unknown]> = [
    ["resp_old_resident", {
      kind: "resident",
      createdAt: 1,
      items: [{ type: "message", content: 'quote " backslash \\ newline \n tab \t' }],
      providerOutputStart: 1,
      sizeBytes: 999,
    }],
    ["resp_spill", { kind: "spill", createdAt: 2, clientThreadId: "thr_1", spill: { file: "a.json", bytes: 10 }, sizeBytes: 5000 }],
    ["resp_failed", { kind: "spill-failed", createdAt: 3, sizeBytes: 7 }],
    ["resp_multibyte", {
      kind: "resident",
      createdAt: 4,
      items: ["한글 ✓ 🚀", { nested: { a: undefined, b: null, c: [1.5, -0, 1e21] } }],
      sizeBytes: 1,
    }],
    ["resp_oversized", { kind: "resident", createdAt: 5, items: ["x".repeat(300)], sizeBytes: 1 }],
    ["resp_newest", { kind: "resident", createdAt: 6, items: ["newest"], sizeBytes: 1 }],
  ];
  return new Map(rows as Array<[string, StoredResponseState]>);
}

function payload(states: Map<string, StoredResponseState>, totalMaxBytes: number): string {
  return snapshotPayload(selectSnapshotEntries(states, totalMaxBytes, RESIDENT_ENTRY_MAX_BYTES));
}

describe("responses-state snapshot payload bytes", () => {
  test("matches the previous whole-tree serialization when everything fits", () => {
    expect(payload(fixtureStates(), 10_000)).toBe(
      '{"version":2,"states":[["resp_old_resident",{"createdAt":1,"items":[{"type":"message","content":"quote \\" backslash \\\\ newline \\n tab \\t"}],"providerOutputStart":1}],["resp_spill",{"kind":"spill","createdAt":2,"clientThreadId":"thr_1","spill":{"file":"a.json","bytes":10}}],["resp_failed",{"kind":"spill-failed","createdAt":3}],["resp_multibyte",{"createdAt":4,"items":["한글 ✓ 🚀",{"nested":{"b":null,"c":[1.5,0,1e+21]}}]}],["resp_newest",{"createdAt":6,"items":["newest"]}]]}',
    );
  });

  test("matches the previous serialization when the byte budget cuts residents off", () => {
    // Stubs take 160 bytes, the newest resident 50; the multibyte resident's 102 UTF-8
    // bytes then overflow 300, which ends the newest-first resident pass.
    expect(payload(fixtureStates(), 300)).toBe(
      '{"version":2,"states":[["resp_spill",{"kind":"spill","createdAt":2,"clientThreadId":"thr_1","spill":{"file":"a.json","bytes":10}}],["resp_failed",{"kind":"spill-failed","createdAt":3}],["resp_newest",{"createdAt":6,"items":["newest"]}]]}',
    );
  });

  test("an empty store still writes the version envelope", () => {
    expect(payload(new Map(), 10_000)).toBe('{"version":2,"states":[]}');
  });

  test("joining the kept strings equals serializing the parsed entries as one tree", () => {
    for (const budget of [0, 120, 300, 10_000]) {
      const kept = selectSnapshotEntries(fixtureStates(), budget, RESIDENT_ENTRY_MAX_BYTES);
      expect(snapshotPayload(kept)).toBe(JSON.stringify({ version: 2, states: kept.map(entry => JSON.parse(entry)) }));
    }
  });
});
