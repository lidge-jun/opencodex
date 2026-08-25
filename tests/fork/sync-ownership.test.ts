import { describe, expect, test } from "bun:test";
import { classifyPath, isSharedHotspot } from "../../scripts/fork/sync/ownership";
import { mergePackageJson } from "../../scripts/fork/sync/recipes/package-json";

describe("fork sync ownership", () => {
  test("classifies documented fork-owned prefixes", () => {
    for (const path of [
      "src/fork/policy.ts",
      "tests/fork/sync-prepare.test.ts",
      "docs/fork/OWNED.md",
      ".cursor/skills/opencodex-fork-sync/SKILL.md",
      "scripts/fork/sync/cli.ts",
      ".github/workflows/fork-upstream-sync.yml",
      ".github/workflows/fork-pr-mergeable.yml",
    ]) {
      expect(classifyPath(path)).toBe("fork-owned");
    }
  });

  test("classifies shared hotspots before fork defaults", () => {
    for (const path of [
      "src/adapters/google.ts",
      "src/adapters/google-http.ts",
      "src/server/responses/core.ts",
      "src/providers/antigravity-quota.ts",
      "src/providers/quota.ts",
    ]) {
      expect(classifyPath(path)).toBe("shared-hotspot");
      expect(isSharedHotspot(path)).toBe(true);
    }
  });

  test("classifies package metadata as a recipe", () => {
    expect(classifyPath("package.json")).toBe("recipe");
  });

  test("defaults unknown paths to upstream-owned", () => {
    expect(classifyPath("src/providers/new-provider.ts")).toBe("upstream-owned");
  });

  test("preserves fork identity while taking upstream package metadata", () => {
    const ours = JSON.stringify({
      name: "@yansigit/opencodex",
      version: "2.31.0",
      scripts: { forkOnly: "keep out" },
      repository: { url: "https://github.com/yansigit/opencodex" },
    });
    const theirs = JSON.stringify({
      name: "opencodex",
      version: "2.32.0",
      description: "upstream release",
      scripts: { start: "bun src/index.ts" },
      dependencies: { zod: "4.4.3" },
    });

    expect(JSON.parse(mergePackageJson(ours, theirs))).toEqual({
      name: "@yansigit/opencodex",
      version: "2.31.0",
      description: "upstream release",
      scripts: { start: "bun src/index.ts" },
      dependencies: { zod: "4.4.3" },
    });
  });
});
