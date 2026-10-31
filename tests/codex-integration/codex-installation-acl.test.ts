import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexInstallationIdForAccount } from "../../src/codex/installation-id";
import { hardenSecretDirAsync, resetHardenedStateForTests, setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests, setPlatformForTests, windowsSecretAclReapPendingAtOrBelow, withWindowsSecretAclSettled } from "../../src/lib/windows-secret-acl";
let root: string;
const ok = { success: true, exitCode: 0, timedOut: false, stdout: "" };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ocx-installation-acl-")); resetHardenedStateForTests(); setPlatformForTests("win32"); });
afterEach(() => { setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null); setPlatformForTests(null); resetHardenedStateForTests(); rmSync(root, { recursive: true, force: true }); });
test("required directory and empty-file ACL precede the first secret byte", () => {
  const observations: Array<{ target: string; size?: number }> = [];
  setIcaclsRunnerForTests(args => {
    const target = args[0]!;
    observations.push({ target, ...(target.includes(".codex-installation-secret-") ? { size: readFileSync(target).length } : {}) });
    return ok;
  });
  codexInstallationIdForAccount("account-a", root);
  const firstFile = observations.findIndex(item => item.size !== undefined);
  expect(firstFile).toBeGreaterThan(0);
  expect(observations[0]!.target).toBe(root);
  expect(observations[firstFile]!.size).toBe(0);
});
test("failed privacy admission writes no key bytes", () => {
  let observedBytes = 0;
  setIcaclsRunnerForTests(args => {
    if (args[0]!.includes(".codex-installation-secret-")) observedBytes += readFileSync(args[0]!).length;
    return { ...ok, success: false, exitCode: 5, stderr: "denied" };
  });
  expect(() => codexInstallationIdForAccount("private-account", root)).toThrow("Codex installation identity unavailable");
  expect(observedBytes).toBe(0);
  expect(existsSync(join(root, "codex-installation-secret"))).toBe(false);
});
test("in-flight ancestor ACL work refuses synchronous publication, then permits retry", async () => {
  let unblock!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  setIcaclsRunnerForTests(() => ok);
  setAsyncIcaclsRunnerForTests(async () => { entered(); await gate; return ok; });
  const pending = hardenSecretDirAsync(root, { required: true });
  await started;
  try {
    expect(() => codexInstallationIdForAccount("account-a", join(root, "child"))).toThrow("Codex installation identity unavailable");
    expect(readdirSync(root)).toEqual([]);
  } finally { unblock(); await pending; }
  await withWindowsSecretAclSettled(root, () => undefined);
  expect(windowsSecretAclReapPendingAtOrBelow(join(root, "child"), true)).toBe(false);
  expect(codexInstallationIdForAccount("account-a", join(root, "child"))).toMatch(/^[0-9a-f-]{36}$/);
});
