import { expect, test } from "bun:test";

// Diagnostic probe, not for merge. Same trivial file as #4839, but based on e2304ce0e3 (the
// base of PR #4837) instead of current dev, to test whether the macOS shard 1 wedge belongs to
// that base rather than to anything in #4837.
test("parity probe", () => {
  expect(1).toBe(1);
});
