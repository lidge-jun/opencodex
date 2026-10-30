import { expect, test } from "bun:test";
import { fileIdentityKey, sameFileIdentity } from "../../src/lib/file-identity";

test("compares and formats adjacent large file IDs", () => {
  const a = { dev: 7n, ino: 2n ** 53n };
  const b = { dev: 7n, ino: a.ino + 1n };
  expect(Number(a.ino)).toBe(Number(b.ino));
  expect(sameFileIdentity(a, a)).toBe(true);
  expect(sameFileIdentity(a, b)).toBe(false);
  expect(sameFileIdentity(a, { ...a, dev: 8n })).toBe(false);
  expect(fileIdentityKey(b).split(":").map(BigInt)).toEqual([b.dev, b.ino]);
});
