import { expect, test } from "bun:test";
import { makeCollapseStore, toggleInSet, type StorageLike } from "../src/pages/collapse-store";
import { defaultCollapsedFamilies } from "../src/pages/claude-desktop-lane";

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => (key in data ? data[key]! : null),
    setItem: (key: string, value: string) => { data[key] = value; },
  };
}

const store = makeCollapseStore("test.collapsed.v1");

// null and "empty Set" are different answers and the difference is load-bearing:
// null means "no preference, apply the data-driven default", while an empty Set is the
// user having deliberately opened everything. Collapsing the two would make a fresh
// visit and a fully-expanded visit indistinguishable.
test("no stored value reads as null, not as an empty preference", () => {
  expect(store.read(fakeStorage())).toBeNull();
});

test("an explicitly empty preference survives as an empty Set", () => {
  const storage = fakeStorage({ "test.collapsed.v1": "[]" });
  const read = store.read(storage);
  expect(read).not.toBeNull();
  expect(read!.size).toBe(0);
});

test("values round-trip through storage", () => {
  const storage = fakeStorage();
  store.write(new Set(["fable", "haiku"]), storage);
  expect([...store.read(storage)!].toSorted()).toEqual(["fable", "haiku"]);
});

// Private mode / quota exhaustion throws from setItem. A collapse preference is not
// worth breaking the page over.
test("a throwing setItem does not escape the writer", () => {
  const throwing: StorageLike = {
    getItem: () => null,
    setItem: () => { throw new Error("QuotaExceededError"); },
  };
  expect(() => store.write(new Set(["opus"]), throwing)).not.toThrow();
});

test("corrupt or wrongly-typed payloads fall back to no preference", () => {
  expect(store.read(fakeStorage({ "test.collapsed.v1": "{not json" }))).toBeNull();
  expect(store.read(fakeStorage({ "test.collapsed.v1": '{"a":1}' }))).toBeNull();
  expect(store.read(fakeStorage({ "test.collapsed.v1": '"opus"' }))).toBeNull();
});

test("non-string members are dropped rather than poisoning the set", () => {
  const read = store.read(fakeStorage({ "test.collapsed.v1": '["opus", 3, null, "haiku"]' }));
  expect([...read!].toSorted()).toEqual(["haiku", "opus"]);
});

// The whole reason the store is keyed: the Desktop page and the Models page collapse
// different namespaces, and a shared key would cross-contaminate them.
test("two stores with different keys do not see each other", () => {
  const storage = fakeStorage();
  const other = makeCollapseStore("other.collapsed.v1");
  store.write(new Set(["opus"]), storage);
  expect(other.read(storage)).toBeNull();
});

test("toggleInSet adds and removes without mutating its input", () => {
  const original = new Set(["opus"]);
  const added = toggleInSet(original, "haiku");
  expect([...added].toSorted()).toEqual(["haiku", "opus"]);
  expect([...original]).toEqual(["opus"]);

  const removed = toggleInSet(original, "opus");
  expect(removed.size).toBe(0);
  expect(original.has("opus")).toBe(true);
});

test("all families fold by default", () => {
  expect([...defaultCollapsedFamilies({ opus: 23, fable: 0, sonnet: 0, haiku: 0 })].toSorted())
    .toEqual(["fable", "haiku", "opus", "sonnet"]);
  expect([...defaultCollapsedFamilies({ opus: 12, fable: 0, sonnet: 4, haiku: 0 })].toSorted())
    .toEqual(["fable", "haiku", "opus", "sonnet"]);
  expect([...defaultCollapsedFamilies({ opus: 1, fable: 1, sonnet: 1, haiku: 1 })].toSorted())
    .toEqual(["fable", "haiku", "opus", "sonnet"]);
});
