import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { bootstrapEmbeddedRoot } from "../../src/update/signed-supply.mjs";

describe("embedded root input snapshot", () => {
  const original = readFileSync(repoPath("src/update/trust-root.json"));
  const replacement = Buffer.from(original.toString().replace("2028-11-07T00:00:00Z", "2030-11-07T00:00:00Z"));

  test("cannot change authenticated bytes through a typed-array getter", () => {
    class SwitchingBytes extends Uint8Array {
      reads = 0;
      get byteLength(): number {
        if (++this.reads === 2) this.set(replacement);
        return super.byteLength;
      }
    }
    expect(() => bootstrapEmbeddedRoot(new SwitchingBytes(original), Date.parse("2029-01-01T00:00:00Z"))).toThrow();
  });

  test("reads intrinsic typed-array slots without invoking caller getters or iterators", () => {
    class TrappedBytes extends Uint8Array {
      get byteLength(): number { throw new Error("caller getter"); }
      get byteOffset(): number { throw new Error("caller getter"); }
      get buffer(): ArrayBuffer { throw new Error("caller getter"); }
      get length(): number { throw new Error("caller getter"); }
      [Symbol.iterator](): IterableIterator<number> { throw new Error("caller iterator"); }
    }
    expect(() => bootstrapEmbeddedRoot(new TrappedBytes(original), Date.parse("2027-01-01T00:00:00Z"))).not.toThrow();
  });

  test("accepts a private snapshot of shared backing bytes", () => {
    const shared = new Uint8Array(new SharedArrayBuffer(original.length));
    shared.set(original);
    const handle = bootstrapEmbeddedRoot(shared, Date.parse("2027-01-01T00:00:00Z"));
    shared.fill(0);
    expect(Object.isFrozen(handle)).toBe(true);
  });
});
