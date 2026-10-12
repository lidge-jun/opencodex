import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCompensationFailed,
  compensationPath,
  markCompensationFailed,
  parseCompensation,
  readCompensation,
  writeCompensation,
} from "../../src/link/compensation";

const linkId = "lnk_0123456789abcdef";

test("persists strict compensation markers atomically with private permissions", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-link-compensation-"));
  const path = compensationPath(home);
  const since = "2026-09-25T00:00:00.000Z";
  markCompensationFailed(linkId, since, path);
  expect(readCompensation(path)).toEqual({ version: 1, entries: { [linkId]: { reason: "compensation_failed", since } } });
  // Windows has no POSIX mode bits; the file is protected by the NTFS ACL hardening instead.
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(readCompensation(path));
  clearCompensationFailed(linkId, path);
  expect(readCompensation(path)).toEqual({ version: 1, entries: {} });
});

test("damaged compensation state is empty display evidence and never parses permissively", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-link-compensation-damaged-"));
  const path = compensationPath(home);
  mkdirSync(join(home, "link"), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, entries: { [linkId]: { reason: "compensation_failed", since: "bad", extra: true } } }));
  expect(readCompensation(path)).toEqual({ version: 1, entries: {} });
  expect(() => parseCompensation(readFileSync(path, "utf8"))).toThrow();
  chmodSync(path, 0o600);
});

test("unknown top-level fields are rejected", () => {
  expect(() => parseCompensation(JSON.stringify({ version: 1, entries: {}, extra: true }))).toThrow();
});
