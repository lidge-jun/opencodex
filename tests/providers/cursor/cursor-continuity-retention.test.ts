import { describe, expect, test } from "bun:test";
import {
  clearCursorOverflowRemintForTests,
  CURSOR_OVERFLOW_REMINT_MAX_ENTRIES,
  cursorOverflowRemintCountForTests,
  markCursorOverflowSurfaced,
  shouldSkipCursorOverflowRemint,
  shouldSurfaceCursorOverflowFirst,
} from "../../../src/adapters/cursor/thread-continuity";

describe("Cursor overflow remint retention", () => {
  test("bounds per-scope state", () => {
    clearCursorOverflowRemintForTests();
    for (let index = 0; index < CURSOR_OVERFLOW_REMINT_MAX_ENTRIES + 20; index++) {
      markCursorOverflowSurfaced(`scope-${index}`);
    }
    expect(cursorOverflowRemintCountForTests()).toBe(CURSOR_OVERFLOW_REMINT_MAX_ENTRIES);
    clearCursorOverflowRemintForTests();
  });

  test("read-only checks do not allocate retention entries", () => {
    clearCursorOverflowRemintForTests();
    expect(shouldSurfaceCursorOverflowFirst("missing")).toBe(true);
    expect(shouldSkipCursorOverflowRemint("missing")).toBe(false);
    expect(cursorOverflowRemintCountForTests()).toBe(0);
  });
});
