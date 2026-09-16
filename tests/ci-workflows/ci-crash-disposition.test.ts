import { expect, test } from "bun:test";

// Diagnostic probe, not for merge. It exists only to occupy the same position in the sorted
// test-file list as tests/ci-workflows/ci-crash-disposition.test.ts on PR #4837, so that the
// ONLY difference between this branch and that one, for shard assignment purposes, is the
// file's content. Bun assigns --shard round-robin over the sorted file list, so adding any one
// file here flips the shard of every file after it.
test("parity probe", () => {
  expect(1).toBe(1);
});
