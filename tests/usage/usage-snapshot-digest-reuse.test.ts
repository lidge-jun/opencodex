import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUsageSnapshotForManagement, resetUsageReadCacheForTests, usageLogPath, usageReadCacheStatsForTests } from "../../src/usage/log";

let directory: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  directory = mkdtempSync(join(tmpdir(), "ocx-digest-reuse-"));
  process.env.OPENCODEX_HOME = directory;
  resetUsageReadCacheForTests();
});
afterEach(() => {
  resetUsageReadCacheForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(directory, { recursive: true, force: true });
});

const row = (id: string) => JSON.stringify({ requestId: id, provider: "mock", model: "fixture" }) + "\n";
const digest = (text: string, from = 0) => `${from}:${from + Buffer.byteLength(text)}:${createHash("sha256").update(text).digest("hex")}`;

async function measuredRead(maxReadBytes?: number) {
  let hashedBytes = 0;
  const prototype = Object.getPrototypeOf(createHash("sha256"));
  const update = prototype.update;
  const spy = spyOn(prototype, "update").mockImplementation(function (this: unknown, data: string | Uint8Array, ...args: unknown[]) {
    hashedBytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    return update.call(this, data, ...args);
  });
  try {
    return { snapshot: await readUsageSnapshotForManagement(maxReadBytes), get hashedBytes() { return hashedBytes; } };
  } finally {
    spy.mockRestore();
  }
}

describe("retained usage digest reuse", () => {
  test("each unchanged poll hashes the retained bytes exactly once, at either input size", async () => {
    for (const count of [64, 128]) {
      resetUsageReadCacheForTests();
      const text = Array.from({ length: count }, (_, i) => row(String(i).padStart(3, "0"))).join("");
      writeFileSync(usageLogPath(), text);
      const initial = await readUsageSnapshotForManagement();
      for (let poll = 0; poll < 3; poll++) {
        const { snapshot, hashedBytes } = await measuredRead();
        expect(hashedBytes).toBe(Buffer.byteLength(text));
        expect(snapshot.prefixDigest).toBe(digest(text));
        expect(snapshot.entries).toEqual(initial.entries);
        expect(snapshot.entries).not.toBe(initial.entries);
      }
      expect(usageReadCacheStatsForTests()).toEqual({ fullReads: 1, tailReads: 3, parsedLines: count });
    }
  });

  test("growth hashes the new region and a same-inode fixed-width edit still invalidates retention", async () => {
    const original = row("old");
    const appended = row("add");
    const path = usageLogPath();
    writeFileSync(path, original);
    await readUsageSnapshotForManagement();
    appendFileSync(path, appended);
    const grown = await measuredRead();
    expect(grown.hashedBytes).toBe(Buffer.byteLength(original) + Buffer.byteLength(original + appended));
    expect(grown.snapshot.prefixDigest).toBe(digest(original + appended));
    const inode = statSync(path).ino;
    const fd = openSync(path, "r+");
    try { writeSync(fd, Buffer.from(row("new")), 0, Buffer.byteLength(original), 0); }
    finally { closeSync(fd); }
    expect(statSync(path).ino).toBe(inode);
    const rewritten = await readUsageSnapshotForManagement();
    expect(rewritten.entries.map(entry => entry.requestId)).toEqual(["new", "add"]);
    expect(rewritten.prefixDigest).toBe(digest(row("new") + appended));
    expect(usageReadCacheStatsForTests().fullReads).toBe(2);
  });

  test("equal-width sliding windows rehash the post-trim region, then reuse only that region", async () => {
    const a = row("aaa"), b = row("bbb"), c = row("ccc"), d = row("ddd");
    const width = Buffer.byteLength(b + c);
    writeFileSync(usageLogPath(), a + b + c);
    const initial = await readUsageSnapshotForManagement(width);
    expect(initial.rowsBeginAtBytes).toBe(Buffer.byteLength(a));
    appendFileSync(usageLogPath(), d);
    const changed = await measuredRead(width);
    expect(changed.hashedBytes).toBe(2 * width);
    expect(changed.snapshot.prefixDigest).toBe(digest(c + d, Buffer.byteLength(a + b)));
    expect(changed.snapshot.entries.map(entry => entry.requestId)).toEqual(["ccc", "ddd"]);
    const unchanged = await measuredRead(width);
    expect(unchanged.hashedBytes).toBe(width);
    expect(unchanged.snapshot).toEqual(changed.snapshot);
    resetUsageReadCacheForTests();
    expect(await readUsageSnapshotForManagement(width)).toEqual(changed.snapshot);
  });

  test("empty files and trailing invalid bytes retain exact range metadata", async () => {
    writeFileSync(usageLogPath(), "");
    await readUsageSnapshotForManagement();
    const empty = await measuredRead();
    expect(empty.hashedBytes).toBe(0);
    expect(empty.snapshot.prefixDigest).toBe("0:0:empty");
    const text = row("one") + "invalid\n";
    writeFileSync(usageLogPath(), text);
    const first = await readUsageSnapshotForManagement();
    const next = await measuredRead();
    expect(next.hashedBytes).toBe(Buffer.byteLength(text));
    expect(next.snapshot).toEqual(first);
    expect(next.snapshot.prefixDigest).toBe(digest(text));
  });
});
