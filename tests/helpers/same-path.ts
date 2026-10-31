import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function canonicalPath(path: string): string {
  let current = resolve(path);
  const remainder: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...remainder.reverse());
    } catch {
      // Missing components are resolved against their nearest existing ancestor.
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      remainder.push(basename(current));
      current = parent;
    }
  }
}

export function samePath(target: unknown, expected: string): boolean {
  if (typeof target === "number" || typeof target === "bigint") return false;
  try {
    const path = target instanceof URL ? fileURLToPath(target) : String(target);
    const actual = canonicalPath(path);
    const reference = canonicalPath(expected);
    return process.platform === "win32"
      ? actual.toLowerCase() === reference.toLowerCase()
      : actual === reference;
  } catch {
    // Invalid paths and unsupported URL schemes never match.
    return false;
  }
}
