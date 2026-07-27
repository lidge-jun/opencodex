import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";

const PREV_HOME = process.env.OPENCODEX_HOME;
beforeAll(() => { process.env.OPENCODEX_HOME = join(tmpdir(), "ocx-prune-" + randomUUID()); });
afterAll(() => { if (PREV_HOME === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = PREV_HOME; });

const { pruneOldArtifacts, pruneArtifacts, DEFAULT_ARTIFACT_KEEP_COUNT } = await import("../../src/images/artifacts");

function touch(path: string, content: string = "x", ageMs = 0): void {
  writeFileSync(path, content);
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(path, t, t);
  }
}

// Minimal valid 1×1 PNG (full 8-byte signature).
const MIN_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("pruneOldArtifacts", () => {
  test("count <= maxFiles → no deletion", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-keep-"));
    for (let i = 0; i < 5; i++) touch(join(dir, `f${i}.png`));
    pruneOldArtifacts(dir, 10);
    expect(readdirSync(dir).length).toBe(5);
  });

  test("count > maxFiles → oldest deleted until under limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-trim-"));
    for (let i = 0; i < 10; i++) {
      touch(join(dir, `f${i}.png`), "data", (10 - i) * 1000);
    }
    pruneOldArtifacts(dir, 5);
    const remaining = readdirSync(dir);
    expect(remaining.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(remaining).not.toContain(`f${i}.png`);
    }
    for (let i = 5; i < 10; i++) {
      expect(remaining).toContain(`f${i}.png`);
    }
  });

  test("maxFiles <= 0 disables pruning (does not wipe directory)", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-disable-"));
    for (let i = 0; i < 4; i++) touch(join(dir, `f${i}.png`));
    pruneOldArtifacts(dir, 0);
    expect(readdirSync(dir).length).toBe(4);
    pruneOldArtifacts(dir, -1);
    expect(readdirSync(dir).length).toBe(4);
  });

  test("nonexistent dir → logs warn, no throw", () => {
    expect(() => pruneOldArtifacts(join(tmpdir(), "does-not-exist-" + randomUUID()), 10)).not.toThrow();
  });

  test("default keep count is 200", () => {
    expect(DEFAULT_ARTIFACT_KEEP_COUNT).toBe(200);
  });
});

describe("pruneArtifacts: integration with materializeInlineImage", () => {
  test("writing >keepCount images then pruning keeps newest", async () => {
    const { materializeInlineImage } = await import("../../src/images/artifacts");
    const KEEP = 3;
    const TOTAL = 6;
    const written: string[] = [];
    for (let i = 0; i < TOTAL; i++) {
      const path = await materializeInlineImage(MIN_PNG_B64);
      written.push(path);
      await new Promise(r => setTimeout(r, 5));
    }
    pruneArtifacts(KEEP);
    const dir = dirname(written[0]!);
    const remaining = readdirSync(dir);
    expect(remaining.length).toBe(KEEP);
    for (let i = 0; i < TOTAL; i++) {
      const fname = basename(written[i]!);
      const shouldExist = i >= TOTAL - KEEP;
      expect(remaining.includes(fname)).toBe(shouldExist);
      expect(existsSync(written[i]!)).toBe(shouldExist);
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
});
