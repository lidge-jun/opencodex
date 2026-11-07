import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { bootstrapEmbeddedRoot } from "../../src/update/signed-supply.mjs";

describe("embedded update trust root", () => {
  const root = readFileSync(repoPath("src/update/trust-root.json"));
  const expiry = Date.parse("2028-11-07T00:00:00Z");

  test("accepts only the compiled root before expiry and returns an opaque handle", () => {
    const trusted = bootstrapEmbeddedRoot(root, expiry - 1);
    expect(Object.isFrozen(trusted)).toBe(true);
    expect(Object.keys(trusted)).toEqual([]);
    expect(() => bootstrapEmbeddedRoot(root, expiry)).toThrow();
    expect(() => bootstrapEmbeddedRoot(root, expiry + 1)).toThrow();
  });

  test("rejects changed root bytes, invalid clocks and oversized input", () => {
    const altered = Buffer.from(root);
    altered[altered.length - 2] ^= 1;
    expect(() => bootstrapEmbeddedRoot(altered, expiry - 1)).toThrow();
    expect(() => bootstrapEmbeddedRoot(Buffer.alloc(65537), expiry - 1)).toThrow();
    for (const time of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => bootstrapEmbeddedRoot(root, time)).toThrow();
    }
  });
});
