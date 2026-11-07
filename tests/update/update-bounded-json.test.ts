import { describe, expect, test } from "bun:test";
import { parseBoundedJson } from "../../src/update/update-bounded-json.mjs";

const parse = (text: string, maxBytes = 65536) => parseBoundedJson(Buffer.from(text), maxBytes);

describe("bounded unverified update JSON", () => {
  test("accepts valid values without giving special object keys prototype behavior", () => {
    const value = parse('{"name":"value","items":[true,false,null,42],"__proto__":{"x":1}}') as {
      name: string; items: unknown[]; __proto__: { x: number };
    };
    expect(value.name).toBe("value");
    expect(value.items).toEqual([true, false, null, 42]);
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(value.__proto__.x).toBe(1);
    expect(parse('"\\ud83d\\ude00"')).toBe("😀");
    expect(parse("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parse("-9007199254740991")).toBe(Number.MIN_SAFE_INTEGER);
  });

  test("rejects duplicate decoded names, malformed Unicode, unsafe or noncanonical numbers", () => {
    for (const text of [
      '{"a":1,"\\u0061":2}', '{"x":"\\ud800"}', '{"x":"\\udc00"}',
      '{"x":9007199254740992}', '{"x":-0}', '{"x":1.0}', '{"x":1e1}',
      '{"x":01}', '{"x":true} trailing', '\ufeff{"x":1}',
    ]) expect(() => parse(text)).toThrow();
    expect(() => parseBoundedJson(Uint8Array.from([0x7b, 0x22, 0x80, 0x22, 0x7d]), 65536)).toThrow();
  });

  test("enforces byte, depth, object, array and string limits", () => {
    expect(() => parse('{"x":1}', 6)).toThrow();
    expect(() => parse("[".repeat(17) + "0" + "]".repeat(17))).toThrow();
    expect(() => parse(`{${Array.from({ length: 33 }, (_, i) => `"k${i}":0`).join(",")}}`)).toThrow();
    expect(() => parse(`[${Array(4097).fill("0").join(",")}]`)).toThrow();
    expect(() => parse(`"${"x".repeat(16385)}"`)).toThrow();
    expect(parse("[".repeat(16) + "0" + "]".repeat(16))).toBeDefined();
  });
});
