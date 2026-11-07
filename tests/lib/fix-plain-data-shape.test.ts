import { describe, expect, test } from "bun:test";
import { canonicalPlainData } from "../../src/lib/plain-data";

describe("canonical plain-data structural identity", () => {
  test.each([[{}, []], [{ a: 1 }, [["a", 1]]], [{ nested: {} }, { nested: [] }]])("distinguishes different container shapes: %j and %j", (left, right) => {
    expect(canonicalPlainData(left)).not.toBe(canonicalPlainData(right));
  });
  test("keeps object key order irrelevant at every depth", () => {
    expect(canonicalPlainData({ b: [1, { y: 2, x: 1 }], a: null }))
      .toBe(canonicalPlainData({ a: null, b: [1, { x: 1, y: 2 }] }));
  });
  test("keeps array order and primitive types significant", () => {
    expect(canonicalPlainData([1, 2])).not.toBe(canonicalPlainData([2, 1]));
    expect(canonicalPlainData(1)).not.toBe(canonicalPlainData("1"));
    expect(canonicalPlainData(null)).not.toBe(canonicalPlainData({}));
  });
});
