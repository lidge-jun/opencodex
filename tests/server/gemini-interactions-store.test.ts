import { afterEach, describe, expect, test } from "bun:test";
import {
  INTERACTION_TTL_MS,
  MAX_INTERACTION_BYTES,
  MAX_OWNER_INTERACTIONS,
  clearInteractionsForTests,
  evictOldestInteractionForBudget,
  forgetInteraction,
  interactionsRetainedStoreSnapshot,
  recallInteraction,
  rememberInteraction,
} from "../../src/server/gemini-interactions-store";
import { APP_OWNED_RETAINED_STORE_REGISTRATIONS } from "../../src/lib/app-owned-memory-stores";

const entry = (id: string, owner: string, text = "hi") => ({ id, owner, history: [{ role: "user", content: text }], resource: { id, steps: [] } });

afterEach(() => clearInteractionsForTests());

describe("stored Gemini interactions", () => {
  test("the store is on the app-owned memory roster as an evictable continuation", () => {
    const row = APP_OWNED_RETAINED_STORE_REGISTRATIONS.find(registration => registration.id === "gemini_interactions");
    expect(row).toMatchObject({ category: "continuation", passiveEvictable: true });
  });

  test("an entry is visible only to its owner", () => {
    expect(rememberInteraction(entry("a", "owner-1"), 1_000)).toBe(true);
    expect(recallInteraction("a", "owner-1", 1_001)?.history).toEqual([{ role: "user", content: "hi" }]);
    expect(recallInteraction("a", "owner-2", 1_001)).toBeUndefined();
    expect(recallInteraction("a", undefined, 1_001)).toBeUndefined();
    expect(forgetInteraction("a", "owner-2", 1_001)).toBe(false);
    expect(forgetInteraction("a", "owner-1", 1_001)).toBe(true);
    expect(recallInteraction("a", "owner-1", 1_002)).toBeUndefined();
  });

  test("entries expire 24 hours after their last write", () => {
    rememberInteraction(entry("a", "o"), 0);
    expect(recallInteraction("a", "o", INTERACTION_TTL_MS - 1)).toBeDefined();
    expect(recallInteraction("a", "o", INTERACTION_TTL_MS)).toBeUndefined();
    expect(interactionsRetainedStoreSnapshot().count).toBe(0);
  });

  test("an entry over the per-entry cap, or over a smaller caller cap, is refused and nothing else changes", () => {
    rememberInteraction(entry("a", "o"), 0);
    expect(rememberInteraction(entry("big", "o", "x".repeat(MAX_INTERACTION_BYTES)), 1)).toBe(false);
    expect(rememberInteraction(entry("mid", "o", "x".repeat(2_000)), 1, 1_000)).toBe(false);
    expect(recallInteraction("big", "o", 2)).toBeUndefined();
    expect(recallInteraction("a", "o", 2)).toBeDefined();
  });

  test("an owner at its cap evicts its own oldest entry, never another owner's", () => {
    rememberInteraction(entry("other", "o2"), 0);
    for (let i = 0; i < MAX_OWNER_INTERACTIONS; i++) rememberInteraction(entry("o1-" + i, "o1"), 1 + i);
    rememberInteraction(entry("o1-new", "o1"), 10_000);
    expect(recallInteraction("o1-0", "o1", 10_001)).toBeUndefined();
    expect(recallInteraction("o1-1", "o1", 10_001)).toBeDefined();
    expect(recallInteraction("o1-new", "o1", 10_001)).toBeDefined();
    expect(recallInteraction("other", "o2", 10_001)).toBeDefined();
  });

  test("the app-owned budget sees every byte as evictable and evicts oldest first", () => {
    rememberInteraction(entry("a", "o"), 5);
    rememberInteraction(entry("b", "o"), 6);
    const snapshot = interactionsRetainedStoreSnapshot();
    expect(snapshot).toMatchObject({ count: 2, pinnedBytes: 0, oldestAt: 5 });
    expect(snapshot.evictableBytes).toBe(snapshot.bytes);
    expect(evictOldestInteractionForBudget()).toBeGreaterThan(0);
    expect(recallInteraction("a", "o", 7)).toBeUndefined();
    expect(recallInteraction("b", "o", 7)).toBeDefined();
  });

  test("rewriting an id replaces it and keeps the accounting exact", () => {
    rememberInteraction(entry("a", "o", "one"), 0);
    rememberInteraction(entry("a", "o", "two"), 1);
    expect(recallInteraction("a", "o", 2)?.history).toEqual([{ role: "user", content: "two" }]);
    expect(interactionsRetainedStoreSnapshot().count).toBe(1);
    forgetInteraction("a", "o", 3);
    expect(interactionsRetainedStoreSnapshot()).toMatchObject({ count: 0, bytes: 0 });
  });
});

