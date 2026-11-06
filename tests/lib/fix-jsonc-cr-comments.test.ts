import { describe, expect, test } from "bun:test";
import { canonicalizeJsonc, hasJsoncComments, parseJsonc } from "../../src/lib/jsonc";

describe("JSONC line ending compatibility", () => {
  test.each(["\r", "\n", "\r\n"])("ends line comments at %j", newline => {
    const text = `{// comment${newline}"enabled": true,// following field${newline}"count": 2${newline}}`;
    expect(parseJsonc(text)).toEqual({ enabled: true, count: 2 });
    expect(hasJsoncComments(text)).toBe(true);
  });
  test("retains string escapes and comment-like URL contents", () => {
    const text = '{"url":"https://example.com//x","text":"\\r"}';
    expect(canonicalizeJsonc(text)).toBe(text);
    expect(hasJsoncComments(text)).toBe(false);
  });
  test("a terminal CR ends the comment without repairing an incomplete document", () => {
    expect(() => parseJsonc('{// comment\r')).toThrow();
  });
});
