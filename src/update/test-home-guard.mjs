// Match the test home guard in ../lib/test-home-guard.ts for the Node launcher.
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";

function canonicalize(path) {
  let current = resolve(path);
  const remaining = [];
  for (;;) {
    try { return join(realpathSync.native(current), ...remaining.reverse()); }
    catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      remaining.push(current.slice(parent.length + 1)); current = parent;
    }
  }
}
const protectedHome = canonicalize(join(process.env.OCX_REAL_HOME?.trim() || homedir(), ".opencodex"));
export function isTestHomeGuardArmed() {
  if (process.env.OCX_TEST_HOME_GUARD === "1") return true;
  if (process.env.OCX_TEST_HOME_GUARD === "0") return false;
  const entry = globalThis.Bun?.main ?? process.argv[1];
  return typeof entry === "string" && /[._](?:test|spec)\.[cm]?[jt]sx?$/i.test(basename(entry));
}
if (process.env.OCX_TEST_HOME_GUARD !== "0" && process.env.OCX_TEST_HOME_GUARD !== "1" && isTestHomeGuardArmed()) {
  process.env.OCX_TEST_HOME_GUARD = "1";
}
export function assertNotRealHomeUnderTest(home) {
  if (!isTestHomeGuardArmed()) return;
  const path = canonicalize(home);
  const normalize = value => process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
  if (normalize(path) === normalize(protectedHome)) throw new Error("refusing to write the real OpenCodex home from a test process");
}
