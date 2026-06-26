import { describe, expect, test } from "bun:test";
import { createCursorKvStore } from "../src/adapters/cursor/kv-store";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("Cursor KV store", () => {
  test("set clones incoming Uint8Array", () => {
    const store = createCursorKvStore();
    const value = bytes(1, 2);

    store.set("a", value);
    value[0] = 9;

    expect(Array.from(store.get("a") ?? [])).toEqual([1, 2]);
  });

  test("get returns a clone instead of the stored mutable reference", () => {
    const store = createCursorKvStore({ a: bytes(1, 2) });
    const first = store.get("a");

    if (!first) throw new Error("expected value");
    first[0] = 9;

    expect(Array.from(store.get("a") ?? [])).toEqual([1, 2]);
  });

  test("missing key returns undefined", () => {
    expect(createCursorKvStore().get("missing")).toBeUndefined();
  });
});
