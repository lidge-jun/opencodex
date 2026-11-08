import { describe, expect, test } from "bun:test";
import { canonicalizeJsonc, hasJsoncComments, parseJsonc } from "../../src/lib/jsonc";
import { PARSE_FAILED, parseConfig } from "../../src/integrations/config-io";

describe("JSONC leading byte-order mark", () => {
  test.each(['{"enabled":true}', '// comment\r\n{"enabled":true,}',
    '/* comment */ {"enabled":true,}'])("accepts one leading BOM before %s", source => {
    expect(parseJsonc(`\uFEFF${source}`)).toEqual({ enabled: true });
    expect(JSON.parse(canonicalizeJsonc(`\uFEFF${source}`))).toEqual({ enabled: true });
  });

  test("preserves literal and escaped BOM characters inside strings", () => {
    const source = '{"literal":"\uFEFFtext","escaped":"\\uFEFFtext"}';
    expect(canonicalizeJsonc(source)).toBe(source);
    expect(canonicalizeJsonc(`\uFEFF${source}`)).toBe(source);
    expect(parseJsonc(`\uFEFF${source}`)).toEqual({ literal: "\uFEFFtext", escaped: "\uFEFFtext" });
  });

  test.each([' \uFEFF{}', '\uFEFF\uFEFF{}', '\uFEFF{"broken":,}'])(
    "does not repair another malformed document: %j", source => {
      expect(() => parseJsonc(source)).toThrow(SyntaxError);
    },
  );

  test("a BOM alone is not reported as a comment", () => {
    expect(hasJsoncComments('\uFEFF{"enabled":true}')).toBe(false);
    expect(hasJsoncComments('\uFEFF// comment\n{"enabled":true}')).toBe(true);
  });

  test("the managed JSONC reader accepts the BOM without widening strict JSON", () => {
    const source = '\uFEFF// config\n{"provider":{"custom":{}},}';
    expect(parseConfig(source, "json", { jsonc: true })).toEqual({ provider: { custom: {} } });
    expect(parseConfig(source, "json")).toBe(PARSE_FAILED);
  });
});

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
