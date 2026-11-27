import { describe, expect, test } from "bun:test";
import { jsonUtf8Bytes } from "../../src/lib/json-byte-size";
import { isTranslatorBudgetExceededError } from "../../src/lib/translator-budget";

const serialized = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("jsonUtf8Bytes", () => {
  test("matches the UTF-8 length of JSON.stringify for plain data", () => {
    const samples: unknown[] = [
      null, 0, -2.5e-7, Number.NaN, true, false, "a\"b\\c\n\u0001é中😀\ud800x\udc00",
      [], {}, [1, undefined, null, [2, {}]],
      { a: undefined, b: 1, c: [undefined], d: { e: "ü", f: undefined } },
      { "k\"ey": [{ x: [[[]]] }], "": "" },
    ];
    for (const sample of samples) expect(jsonUtf8Bytes(sample)).toBe(serialized(sample));
  });

  test("measures data nested deeper than the call stack", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 100_000; i++) deep = i % 2 === 0 ? [deep] : { n: deep };
    // 50,000 arrays add "[]" and 50,000 objects add '{"n":}', around the 6-byte leaf.
    expect(jsonUtf8Bytes(deep, 1024 * 1024)).toBe(50_000 * 2 + 50_000 * 6 + 6);
  });

  test("stops at the first element past the budget instead of walking a wide container", () => {
    let reads = 0;
    const wide = new Proxy(new Array<string>(100_000).fill("x"), {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, receiver);
      },
    });
    let error: unknown;
    try { jsonUtf8Bytes(wide, 16); } catch (caught) { error = caught; }
    expect(isTranslatorBudgetExceededError(error)).toBe(true);
    expect(reads).toBeLessThan(16);
  });

  test("rejects non-JSON values, including a top-level undefined", () => {
    expect(() => jsonUtf8Bytes(undefined)).toThrow(TypeError);
    expect(() => jsonUtf8Bytes({ f: () => 1 })).toThrow(TypeError);
    expect(() => jsonUtf8Bytes([1n])).toThrow(TypeError);
  });
});
