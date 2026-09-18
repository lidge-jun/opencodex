import { describe, expect, spyOn, test } from "bun:test";
import {
  clearCursorOverflowRemintForTests,
  CURSOR_OVERFLOW_REMINT_MAX_ENTRIES,
  CURSOR_OVERFLOW_REMINT_TTL_MS,
  cursorOverflowRemintCountForTests,
  markCursorOverflowSurfaced,
  recordCursorOverflowRemint,
  shouldSkipCursorOverflowRemint,
  shouldSurfaceCursorOverflowFirst,
} from "../../../src/adapters/cursor/thread-continuity";

describe("Cursor overflow remint retention", () => {
  test("capped activity refreshes idle expiry without replenishing the allowance", () => {
    clearCursorOverflowRemintForTests();
    let at = 1_000;
    const clock = spyOn(Date, "now").mockImplementation(() => at);
    try {
      markCursorOverflowSurfaced("active");
      for (let attempt = 0; attempt < 3; attempt++) expect(recordCursorOverflowRemint("active")).toBe(true);
      for (let interval = 0; interval < 8; interval++) {
        at += CURSOR_OVERFLOW_REMINT_TTL_MS / 4;
        expect(shouldSkipCursorOverflowRemint("active")).toBe(true);
        expect(shouldSurfaceCursorOverflowFirst("active")).toBe(false);
      }
      at += CURSOR_OVERFLOW_REMINT_TTL_MS + 1;
      expect(shouldSkipCursorOverflowRemint("active")).toBe(false);
      expect(shouldSurfaceCursorOverflowFirst("active")).toBe(true);
      expect(cursorOverflowRemintCountForTests()).toBe(0);
    } finally {
      clock.mockRestore();
      clearCursorOverflowRemintForTests();
    }
  });

  test("capped activity moves an existing scope behind older eviction candidates", () => {
    clearCursorOverflowRemintForTests();
    try {
      markCursorOverflowSurfaced("active");
      for (let attempt = 0; attempt < 3; attempt++) expect(recordCursorOverflowRemint("active")).toBe(true);
      for (let index = 0; index < CURSOR_OVERFLOW_REMINT_MAX_ENTRIES - 1; index++) {
        markCursorOverflowSurfaced(`other-${index}`);
      }
      expect(shouldSkipCursorOverflowRemint("active")).toBe(true);
      markCursorOverflowSurfaced("new");
      expect(shouldSurfaceCursorOverflowFirst("other-0")).toBe(true);
      expect(shouldSkipCursorOverflowRemint("active")).toBe(true);
      expect(cursorOverflowRemintCountForTests()).toBe(CURSOR_OVERFLOW_REMINT_MAX_ENTRIES);
    } finally {
      clearCursorOverflowRemintForTests();
    }
  });

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
