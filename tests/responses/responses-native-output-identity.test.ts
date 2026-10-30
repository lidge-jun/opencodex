import { expect, test } from "bun:test";
import { nativeResponseOutput } from "../../src/server/responses/native-response-output";
import { nativeResponseFingerprint, nativeResponseOutputIdentity } from "../../src/server/responses/native-response-json";

test("native output identity preserves key-order equivalence and duplicate refusal", () => {
  for (const text of ["short", "한".repeat(40), "x".repeat(1024)]) {
    const a = { role: "assistant", content: text };
    const b = { content: text, role: "assistant" };
    expect(nativeResponseOutputIdentity(a)).toBe(nativeResponseOutputIdentity(b));
    expect(nativeResponseOutput(new Map([[0, a]]), [b])).toEqual([b]);
    expect(() => nativeResponseOutput(new Map([[0, a], [1, b]]), [a])).toThrow("Duplicate native completed output identity");
    expect(() => nativeResponseOutput(new Map(), [a, b])).toThrow("Duplicate native terminal output identity");
  }
});

test("native output identity keeps sparse mixed items ordered and rejects contradictions", () => {
  const id = { id: "json:{}", role: "assistant", content: "first" };
  const small = { role: "assistant", content: "second" };
  const large = { role: "assistant", content: "third".repeat(100) };
  const done = new Map([[0, id], [2, small], [9, large]]);
  expect(nativeResponseOutput(done, [id, large])).toEqual([id, small, large]);
  expect(() => nativeResponseOutput(done, [large, id])).toThrow("contradicts");
  expect(() => nativeResponseOutput(done, [{ ...id, content: "changed" }])).toThrow("contradicts");
  expect(nativeResponseOutput(new Map(), [{ id: "json:{}" }, {}])).toEqual([{ id: "json:{}" }, {}]);
});

test("native body identity stays within the former digest key byte bound", () => {
  for (const content of ["", "x".repeat(55), "x".repeat(56), "한".repeat(20), "한".repeat(1000)]) {
    expect(Buffer.byteLength(nativeResponseOutputIdentity({ content }), "utf8")).toBeLessThanOrEqual(69);
  }
  expect(nativeResponseOutputIdentity({ content: [1, 2] })).not.toBe(nativeResponseOutputIdentity({ content: [2, 1] }));
});

test("the exported native fingerprint retains its SHA-256 contract", () => {
  expect(nativeResponseFingerprint({ b: 2, a: 1 })).toBe("43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
  expect(nativeResponseFingerprint({ a: [1, 2] })).not.toBe(nativeResponseFingerprint({ a: [2, 1] }));
  expect(nativeResponseFingerprint({ b: null, a: { y: "한", x: true } })).toBe(nativeResponseFingerprint({ a: { x: true, y: "한" }, b: null }));
});
