import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  workspaceMetadataCache,
  pruneWorkspaceMetadataCache,
  MAX_WORKSPACE_METADATA_ENTRIES,
} from "../src/adapters/command-code";

beforeEach(() => {
  workspaceMetadataCache.clear();
});

afterEach(() => {
  workspaceMetadataCache.clear();
});

describe("workspaceMetadataCache eviction", () => {
  const dummyValue = { isGitRepo: false, currentBranch: "", mainBranch: "", gitStatus: "", recentCommits: [] as string[] };

  test("expired entries are evicted before capacity check", () => {
    const now = Date.now();
    // Insert 3 entries: two expired, one fresh.
    workspaceMetadataCache.set("/old1", { collectedAt: now - 60_000, value: dummyValue });
    workspaceMetadataCache.set("/old2", { collectedAt: now - 45_000, value: dummyValue });
    workspaceMetadataCache.set("/fresh", { collectedAt: now - 1_000, value: dummyValue });
    expect(workspaceMetadataCache.size).toBe(3);

    pruneWorkspaceMetadataCache(now);

    // The two expired entries (>= 30s TTL) should be gone; the fresh one stays.
    expect(workspaceMetadataCache.size).toBe(1);
    expect(workspaceMetadataCache.has("/fresh")).toBe(true);
    expect(workspaceMetadataCache.has("/old1")).toBe(false);
    expect(workspaceMetadataCache.has("/old2")).toBe(false);
  });

  test("oldest live entry is evicted when at capacity with no expired entries", () => {
    const now = Date.now();
    // Fill to exactly MAX_WORKSPACE_METADATA_ENTRIES with fresh entries.
    for (let i = 0; i < MAX_WORKSPACE_METADATA_ENTRIES; i++) {
      workspaceMetadataCache.set(`/dir-${i}`, { collectedAt: now - (MAX_WORKSPACE_METADATA_ENTRIES - i), value: dummyValue });
    }
    expect(workspaceMetadataCache.size).toBe(MAX_WORKSPACE_METADATA_ENTRIES);

    pruneWorkspaceMetadataCache(now);

    // The oldest entry (/dir-0, collectedAt = now - 128) should be evicted.
    expect(workspaceMetadataCache.size).toBe(MAX_WORKSPACE_METADATA_ENTRIES - 1);
    expect(workspaceMetadataCache.has("/dir-0")).toBe(false);
    // The newest entry should still be present.
    expect(workspaceMetadataCache.has(`/dir-${MAX_WORKSPACE_METADATA_ENTRIES - 1}`)).toBe(true);
  });

  test("cache never exceeds the cap", () => {
    const now = Date.now();
    // Simulate inserting more entries than the cap by calling prune before each insertion.
    for (let i = 0; i < MAX_WORKSPACE_METADATA_ENTRIES + 10; i++) {
      pruneWorkspaceMetadataCache(now + i);
      workspaceMetadataCache.set(`/dir-${i}`, { collectedAt: now + i, value: dummyValue });
    }
    expect(workspaceMetadataCache.size).toBeLessThanOrEqual(MAX_WORKSPACE_METADATA_ENTRIES);
  });

  test("prune on an empty cache is a no-op", () => {
    expect(workspaceMetadataCache.size).toBe(0);
    pruneWorkspaceMetadataCache(Date.now());
    expect(workspaceMetadataCache.size).toBe(0);
  });
});
