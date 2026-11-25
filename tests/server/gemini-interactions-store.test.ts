import { afterEach, describe, expect, test } from "bun:test";
import {
  INTERACTION_TTL_MS,
  KEYLESS_INTERACTION_OWNER,
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
    expect(rememberInteraction(entry("a", "owner-2", "different"), 1_001)).toBe(false);
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

  test("keyless writes preserve retained history at capacity and reuse expired space", () => {
    for (let i = 0; i < MAX_OWNER_INTERACTIONS; i++) {
      expect(rememberInteraction(entry(String(i), KEYLESS_INTERACTION_OWNER), i)).toBe(true);
    }
    expect(rememberInteraction(entry("0", KEYLESS_INTERACTION_OWNER, "updated"), 0)).toBe(true);
    const next = entry("next", KEYLESS_INTERACTION_OWNER);
    expect(rememberInteraction(next, MAX_OWNER_INTERACTIONS)).toBe(false);
    expect(recallInteraction("0", KEYLESS_INTERACTION_OWNER, MAX_OWNER_INTERACTIONS)).toBeDefined();
    expect(recallInteraction("next", KEYLESS_INTERACTION_OWNER, MAX_OWNER_INTERACTIONS)).toBeUndefined();
    expect(rememberInteraction(next, INTERACTION_TTL_MS)).toBe(true);
    expect(recallInteraction("1", KEYLESS_INTERACTION_OWNER, INTERACTION_TTL_MS)).toBeDefined();
    expect(interactionsRetainedStoreSnapshot().count).toBe(MAX_OWNER_INTERACTIONS);
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

describe("stored Gemini interactions at the global limit", () => {
  test("a full store never evicts another owner's entry; the writer evicts its own oldest or keeps nothing", () => {
    for (let owner = 0; owner < 5; owner++) {
      for (let n = 0; n < MAX_OWNER_INTERACTIONS; n++) {
        const ownerId = owner === 0 && n === 0 ? KEYLESS_INTERACTION_OWNER : `owner-${owner}`;
        expect(rememberInteraction(entry(`o${owner}-${n}`, ownerId), 1_000 + n)).toBe(true);
      }
    }
    expect(interactionsRetainedStoreSnapshot().count).toBe(1_000);
    expect(rememberInteraction(entry("shared-new", KEYLESS_INTERACTION_OWNER), 5_000)).toBe(false);
    // A newcomer owns nothing to evict, so its interaction is not kept and nobody loses history.
    expect(rememberInteraction(entry("new", "owner-new"), 5_000)).toBe(false);
    expect(recallInteraction("o0-0", KEYLESS_INTERACTION_OWNER, 5_001)).toBeDefined();
    // An owner already in the store makes room from its own entries.
    expect(rememberInteraction(entry("o1-next", "owner-1"), 5_002)).toBe(true);
    expect(recallInteraction("o1-0", "owner-1", 5_003)).toBeUndefined();
    expect(recallInteraction("o0-0", KEYLESS_INTERACTION_OWNER, 5_003)).toBeDefined();
    expect(interactionsRetainedStoreSnapshot().count).toBe(1_000);
  });
});
