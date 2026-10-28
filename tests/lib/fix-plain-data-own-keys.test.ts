import { describe, expect, test } from "bun:test";
import { copyPlainData } from "../../src/lib/plain-data";

describe("plain-data own property preservation", () => {
  test.each([null, 7, { retained: true }])("copies __proto__ as data: %j", value => {
    const input = JSON.parse(`{"__proto__":${JSON.stringify(value)},"constructor":"kept"}`);
    const result = copyPlainData(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("copy refused");
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(Object.hasOwn(result.value, "__proto__")).toBe(true);
    expect(JSON.stringify(result.value)).toBe(JSON.stringify(input));
    expect(Object.getOwnPropertyDescriptor(result.value, "__proto__")).toMatchObject({
      enumerable: true, writable: true, configurable: true,
    });
  });
  test("detaches nested prototype-named data", () => {
    const input = JSON.parse('{"nested":{"__proto__":{"flag":true}}}');
    const result = copyPlainData(input);
    if (!result.ok) throw new Error("copy refused");
    input.nested.__proto__.flag = false;
    expect(result.value.nested.__proto__.flag).toBe(true);
    expect(result.value.nested.flag).toBeUndefined();
  });
  test("still refuses accessors without invoking them", () => {
    let calls = 0;
    const input = Object.defineProperty({}, "__proto__", { enumerable: true, get() { calls++; return {}; } });
    expect(copyPlainData(input)).toEqual({ ok: false });
    expect(calls).toBe(0);
  });
});
