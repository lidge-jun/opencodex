import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectGuiBundleFreshness,
  newestModifiedMs,
  staleGuiBundleLines,
} from "../../src/server/gui-freshness";

/** Write `name` under `root` with an explicit mtime, creating parents as needed. */
function writeAt(root: string, name: string, secondsSinceEpoch: number): string {
  const path = join(root, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  utimesSync(path, secondsSinceEpoch, secondsSinceEpoch);
  return path;
}

describe("gui bundle freshness", () => {
  test("sources newer than the bundle are stale, and the advice names the rebuild", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-gui-fresh-"));
    writeAt(root, "dist/assets/index-AAAAAAAA.js", 1_000_000);
    writeAt(root, "src/pages/Usage.tsx", 2_000_000);

    const freshness = inspectGuiBundleFreshness({
      bundlePath: join(root, "dist"),
      sourcePath: join(root, "src"),
    });

    expect(freshness.stale).toBe(true);
    const lines = staleGuiBundleLines(freshness);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("bun run build:gui");
  });

  test("a bundle rebuilt after its sources is not stale and says nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-gui-fresh-"));
    writeAt(root, "src/pages/Usage.tsx", 1_000_000);
    writeAt(root, "dist/assets/index-BBBBBBBB.js", 2_000_000);

    const freshness = inspectGuiBundleFreshness({
      bundlePath: join(root, "dist"),
      sourcePath: join(root, "src"),
    });

    expect(freshness.stale).toBe(false);
    expect(staleGuiBundleLines(freshness)).toEqual([]);
  });

  test("an unknown side is never stale, because a packaged install ships no sources", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-gui-fresh-"));
    writeAt(root, "dist/assets/index-CCCCCCCC.js", 2_000_000);

    const missingSources = inspectGuiBundleFreshness({
      bundlePath: join(root, "dist"),
      sourcePath: join(root, "src"),
    });
    expect(missingSources.sourceModifiedMs).toBeNull();
    expect(missingSources.stale).toBe(false);

    const missingBundle = inspectGuiBundleFreshness({
      bundlePath: null,
      sourcePath: join(root, "dist"),
    });
    expect(missingBundle.bundleModifiedMs).toBeNull();
    expect(missingBundle.stale).toBe(false);
  });

  test("node_modules cannot make a tree look newer than its own files", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-gui-fresh-"));
    writeAt(root, "src/pages/Usage.tsx", 1_000_000);
    writeAt(root, "src/node_modules/dep/index.js", 9_000_000);

    expect(newestModifiedMs(join(root, "src"))).toBe(1_000_000_000);
  });
});
