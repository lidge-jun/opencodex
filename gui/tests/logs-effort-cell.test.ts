import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "../src/pages/Logs.tsx"), "utf8");

/**
 * The table's effort cell used to stack the wire field (`reasoning_effort=high`) under the
 * label. It repeated the label, and in the mono font it outgrew the 9% column and painted
 * over the provider cell. The wire field stays reachable in the cell title and the detail
 * dialog, so a reader who wants it still has it.
 */
describe("Logs table effort cell", () => {
  test("renders the effort label only, with the wire field as the cell title", () => {
    const cell = source.match(/<td className="mono log-reasoning-cell" title=\{reasoningWire\}>([^]*?)<\/td>/);
    expect(cell).not.toBeNull();
    expect(cell![1].trim()).toBe("{effortLabel(log)}");
    expect(cell![1]).not.toContain("reasoningWire");
  });

  test("the detail dialog still shows the wire field next to the label", () => {
    expect(source).toContain('{effortLabel(detail)}{reasoningWire ? ` (${reasoningWire})` : ""}');
  });
});
