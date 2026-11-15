import { expect, test } from "bun:test";
import { extractPassiveWireModel } from "../../src/providers/quota/passive-wire-model";

test("finds a model after multi-megabyte Anthropic and Responses inputs", () => {
  const text = "x".repeat(3 * 1024 * 1024);
  for (const input of [{ messages: [{ role: "user", content: text }] }, { input: [{ content: text }] }]) {
    expect(extractPassiveWireModel(JSON.stringify({ ...input, model: "actual-model" }))).toBe("actual-model");
  }
});

test("uses the last top-level model, ignoring nested values and string decoys", () => {
  expect(extractPassiveWireModel('{"model":"first","input":[{"model":"nested"},"\\\"model\\\":\\\"decoy\\\""],"model":"last"}')).toBe("last");
  expect(extractPassiveWireModel('{"model":"first","model":null}')).toBeUndefined();
  expect(extractPassiveWireModel('{"input":{"model":"nested"}}')).toBeUndefined();
});

test("decodes JSON escapes in top-level names and model values", () => {
  expect(extractPassiveWireModel('{"mo\\u0064el":"vendor\\u002fmodel-1"}')).toBe("vendor/model-1");
  expect(extractPassiveWireModel('{"\\u006d\\u006f\\u0064\\u0065\\u006c":"' + "\\u0061".repeat(128) + '"}')).toBe("a".repeat(128));
  expect(extractPassiveWireModel('{"model":"vendor\\/model"}')).toBe("vendor/model");
  expect(extractPassiveWireModel('{"model":"a\\nb"}')).toBeUndefined();
  expect(extractPassiveWireModel('{"model":"first","model":"' + "\\u0061".repeat(129) + '"}')).toBeUndefined();
});

test("requires valid complete JSON, including after an apparent model", () => {
  for (const body of [
    '{"model":"first",}', '{"model":"first"} trailing', '{"model":"first", "x": [1,]}',
    '{"model":"first", "x":"bad\\q"}', '{"model":"first", "x":"bad\nstring"}',
    '{"model":"first", "x":01}', '{"model":"first", "x":-}', '{"model":"first", "x":1.}',
    '{"model":"first", "x":1e+}', '{"model":"first", "x":true false}',
    '{"model":"first", "x": {"a" 1}}', '[{"model":"first"}]',
    '{"model":"first", "x":"\\u0z00"}', '{"model":"first", "x":{}} garbage',
  ]) expect(extractPassiveWireModel(body)).toBeUndefined();
});

test("enforces the existing model contract and bounded input and nesting", () => {
  expect(extractPassiveWireModel(JSON.stringify({ model: "a".repeat(128) }))).toBe("a".repeat(128));
  for (const model of ["", "a".repeat(129), " bad", "a b", "-bad", "ü"]) {
    expect(extractPassiveWireModel(JSON.stringify({ model }))).toBeUndefined();
  }
  expect(extractPassiveWireModel('{"input":"' + "x".repeat(17 * 1024 * 1024) + '","model":"m"}')).toBeUndefined();
  expect(extractPassiveWireModel('{"input":' + "[".repeat(200) + "0" + "]".repeat(200) + ',"model":"m"}')).toBeUndefined();
  expect(extractPassiveWireModel(new URLSearchParams({ model: "m" }))).toBeUndefined();
});

test("matches JSON.parse for varied valid object structures and duplicate models", () => {
  const values = [null, true, false, 0, -1.25e30, "quote \" slash \\ newline\n", [], {}, [{ model: "nested" }]];
  for (const value of values) {
    for (const later of [undefined, "actual", null, 42, { model: "nested" }, "bad model"]) {
      const body = '{"model":"original","payload":' + JSON.stringify(value)
        + (later === undefined ? "" : ',"mo\\u0064el":' + JSON.stringify(later)) + '}';
      const parsed: unknown = JSON.parse(body).model;
      const expected = typeof parsed === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(parsed) ? parsed : undefined;
      expect(extractPassiveWireModel(body)).toBe(expected);
    }
  }
});

test("accepts documents at the length and depth limits and rejects the next unit", () => {
  const prefix = '{"input":"';
  const suffix = '","model":"m"}';
  const exact = prefix + "x".repeat(16 * 1024 * 1024 - prefix.length - suffix.length) + suffix;
  expect(extractPassiveWireModel(exact)).toBe("m");
  expect(extractPassiveWireModel(exact + " ")).toBeUndefined();
  const nested = (count: number) => '{"input":' + "[".repeat(count) + "0" + "]".repeat(count) + ',"model":"m"}';
  expect(extractPassiveWireModel(nested(127))).toBe("m");
  expect(extractPassiveWireModel(nested(128))).toBeUndefined();
});
