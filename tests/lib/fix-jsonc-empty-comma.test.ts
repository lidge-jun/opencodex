import { describe, expect, test } from "bun:test";
import { parseJsonc } from "../../src/lib/jsonc";

describe("JSONC trailing comma grammar", () => {
  test.each(["[,]", "{,}", "[ /* note */ , ]", "{ // note\n , }", "[{,}]"])("refuses a leading comma: %s", text => {
    expect(() => parseJsonc(text)).toThrow(SyntaxError);
  });
  test("still accepts trailing commas after actual members", () => {
    expect(parseJsonc('{"items": [1, true, null, {}, [], "comma,]",],}')).toEqual({
      items: [1, true, null, {}, [], "comma,]"],
    });
    expect(parseJsonc("[]")).toEqual([]);
    expect(parseJsonc("{}")).toEqual({});
  });
  test.each(["[1,,]", '{"a":1,,}', '{"a":,}'])("does not repair another malformed separator: %s", text => {
    expect(() => parseJsonc(text)).toThrow(SyntaxError);
  });
});
