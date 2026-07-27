import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";

const PREV_HOME = process.env.OPENCODEX_HOME;
beforeAll(() => { process.env.OPENCODEX_HOME = join(tmpdir(), "ocx-prune-" + randomUUID()); });
afterAll(() => { if (PREV_HOME === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = PREV_HOME; });

const { pruneOldArtifacts } = await import("../../src/images/artifacts");

function touch(path: string, content: string = "x", ageMs = 0): void {
  writeFileSync(path, content);
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(path, t, t);
  }
}

describe("pruneOldArtifacts", () => {
  test("count <= maxFiles → no deletion", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-keep-"));
    for (let i = 0; i < 5; i++) touch(join(dir, `f${i}.png`));
    pruneOldArtifacts(dir, 10);
    expect(readdirSync(dir).length).toBe(5);
  });

  test("count > maxFiles → oldest deleted until under limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-trim-"));
    // Create 10 files with staggered mtimes — f0 is oldest (10s ago), f9 is newest (1s ago).
    for (let i = 0; i < 10; i++) {
      touch(join(dir, `f${i}.png`), "data", (10 - i) * 1000);
    }
    pruneOldArtifacts(dir, 5);
    const remaining = readdirSync(dir);
    expect(remaining.length).toBe(5);
    // The 5 newest (f5–f9) should survive; f0–f4 (oldest) deleted.
    for (let i = 0; i < 5; i++) {
      expect(remaining).not.toContain(`f${i}.png`);
    }
    for (let i = 5; i < 10; i++) {
      expect(remaining).toContain(`f${i}.png`);
    }
  });

  test("nonexistent dir → logs warn, no throw", () => {
    expect(() => pruneOldArtifacts(join(tmpdir(), "does-not-exist-" + randomUUID()), 10)).not.toThrow();
  });

  test("default keep count is 200", async () => {
    const { DEFAULT_ARTIFACT_KEEP_COUNT } = await import("../../src/images/artifacts");
    expect(DEFAULT_ARTIFACT_KEEP_COUNT).toBe(200);
  });

  test("maxFiles <= 0 disables pruning (does not delete everything)", () => {
    const { pruneOldArtifacts } = require("../../src/images/artifacts");
    const dir = mkdtempSync(join(tmpdir(), "ocx-prune-zero-"));
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.png`), "x");
    pruneOldArtifacts(dir, 0);
    expect(readdirSync(dir).length).toBe(5);
    pruneOldArtifacts(dir, -1);
    expect(readdirSync(dir).length).toBe(5);
  });
});

describe("pruneOldArtifacts: integration with materializeInlineImage", () => {
  test("writing >keepCount images triggers prune down to limit", async () => {
    const { materializeInlineImage } = await import("../../src/images/artifacts");
    // Use a small keepCount to keep the test fast.
    const KEEP = 3;
    const TOTAL = 6;
    // Minimal valid base64 PNG (1x1 transparent). Decodes to 1 byte — but we need
    // >0 bytes so the empty-check passes. Use "AA==" which decodes to one 0x00 byte.
    const b64 = "AA==";
    const written: string[] = [];
    for (let i = 0; i < TOTAL; i++) {
      const path = await materializeInlineImage(b64, undefined, KEEP);
      written.push(path);
      // Small delay so mtimes are distinct.
      await new Promise(r => setTimeout(r, 5));
    }
    const dir = dirname(written[0]!);
    const remaining = readdirSync(dir);
    expect(remaining.length).toBe(KEEP);
    // The newest KEEP files should be the last ones written.
    for (let i = 0; i < TOTAL; i++) {
      const fname = basename(written[i]!);
      const shouldExist = i >= TOTAL - KEEP;
      const exists = remaining.includes(fname);
      expect(exists).toBe(shouldExist);
    }
  });
});
