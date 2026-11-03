import { samePath } from "../helpers/same-path";
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileIdentityKey, sameFileIdentity, statTimeMs } from "../../src/lib/file-identity";
import { readCodexHomeJournal } from "../../src/codex/codex-home-owner";
import { readBoundedCodexConfig } from "../../src/codex/inject/bounded-config-reader";
import { readBoundedLocalFile } from "../../src/codex/orca-auth-source";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

test("bigint timestamps match numeric stat timestamps", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "ocx-stat-time-"));
  try {
    const path = join(root, "file");
    fs.writeFileSync(path, "fixture");
    for (const time of [1793358320.9811772, 1793358320.5383171, 1700000000.123456789, 1.5]) {
      fs.utimesSync(path, time, time);
      const big = fs.lstatSync(path, { bigint: true });
      const numeric = fs.lstatSync(path);
      expect(statTimeMs(big.mtimeNs)).toBe(numeric.mtimeMs);
      expect(statTimeMs(big.ctimeNs)).toBe(numeric.ctimeMs);
    }
  } finally { removeTreeWithRetry(root); }
});

test("stat milliseconds use whole seconds plus the nanosecond remainder", () => {
  // Dividing the whole nanosecond count rounds differently from the runtime's sec*1e3 + nsec/1e6.
  const ns = 1793358320981177200n;
  expect(statTimeMs(ns)).toBe(1793358320981.1772);
  expect(Number(ns) / 1e6).toBe(1793358320981.177);
});

test("compares and formats adjacent large file IDs", () => {
  const a = { dev: 7n, ino: 2n ** 53n };
  const b = { dev: 7n, ino: a.ino + 1n };
  expect(Number(a.ino)).toBe(Number(b.ino));
  expect(sameFileIdentity(a, a)).toBe(true);
  expect(sameFileIdentity(a, b)).toBe(false);
  expect(sameFileIdentity(a, { ...a, dev: 8n })).toBe(false);
  expect(fileIdentityKey(b).split(":").map(BigInt)).toEqual([b.dev, b.ino]);
});

for (const [name, read] of [
  ["journal", (path: string) => expect(readCodexHomeJournal(path).kind).toBe("unknown")],
  ["config", (path: string) => expect(() => readBoundedCodexConfig(path)).toThrow("changed while it was read")],
  ["local file", (path: string) => expect(() => readBoundedLocalFile(path)).toThrow("Local credential file changed")],
] as const) {
  test(`${name} compares adjacent large file IDs`, () => {
    const scratch = repoPath(".tmp", "ino-audit");
    fs.mkdirSync(scratch, { recursive: true });
    const root = fs.mkdtempSync(join(scratch, "identity-"));
    const path = join(root, "data");
    fs.writeFileSync(path, JSON.stringify({ version: 1, originalConfig: "", originalProfile: null }));
    const id = 2n ** 53n;
    const realStat = fs.statSync, realLstat = fs.lstatSync, realFstat = fs.fstatSync;
    const stat = spyOn(fs, "statSync").mockImplementation(((target, options) => {
      const value = options?.bigint ? realStat(target, { bigint: true }) : realStat(target);
      return samePath(target, path) ? Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ino: options?.bigint ? id : Number(id) }) : value;
    }) as typeof fs.statSync);
    const lstat = spyOn(fs, "lstatSync").mockImplementation(((target, options) => {
      const value = options?.bigint ? realLstat(target, { bigint: true }) : realLstat(target);
      return samePath(target, path) ? Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ino: options?.bigint ? id : Number(id) }) : value;
    }) as typeof fs.lstatSync);
    const fstat = spyOn(fs, "fstatSync").mockImplementation(((fd, options) => {
      const value = options?.bigint ? realFstat(fd, { bigint: true }) : realFstat(fd);
      return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ino: options?.bigint ? id + 1n : Number(id + 1n) });
    }) as typeof fs.fstatSync);
    try { read(path); }
    finally { fstat.mockRestore(); lstat.mockRestore(); stat.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
  });
}
