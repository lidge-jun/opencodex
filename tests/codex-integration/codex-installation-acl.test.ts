import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexInstallationIdForAccount } from "../../src/codex/installation-id";
import { hardenSecretDirAsync, resetHardenedStateForTests, setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests, setPlatformForTests, verifySecretPathAcl, windowsSecretAclReapPendingAtOrBelow, withWindowsSecretAclSettled } from "../../src/lib/windows-secret-acl";
import { resolveTrustedWindowsIcaclsExe } from "../../src/lib/windows-elevation";
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
for (const existing of [false, true]) test(`in-flight directory ACL work permits independently hardened secret (existing=${existing})`, async () => {
  let unblock!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const path = join(root, "codex-installation-secret");
  if (existing) writeFileSync(path, Buffer.alloc(32, 7));
  const hardened: string[] = [];
  setIcaclsRunnerForTests(args => { hardened.push(args[0]!); return ok; });
  setAsyncIcaclsRunnerForTests(async () => { entered(); await gate; return ok; });
  const pending = hardenSecretDirAsync(root, { required: true });
  await started;
  try {
    expect(codexInstallationIdForAccount("account-a", root)).toMatch(/^[0-9a-f-]{36}$/);
    expect(hardened).toContain(path);
    expect(readFileSync(path).length).toBe(32);
    if (existing) expect(readFileSync(path)).toEqual(Buffer.alloc(32, 7));
  } finally { unblock(); await pending; }
  await withWindowsSecretAclSettled(root, () => undefined);
  expect(windowsSecretAclReapPendingAtOrBelow(join(root, "child"), true)).toBe(false);
  expect(codexInstallationIdForAccount("account-a", join(root, "child"))).toMatch(/^[0-9a-f-]{36}$/);
});

test("an existing secret still fails closed on its own ACL failure during directory hardening", async () => {
  const path = join(root, "codex-installation-secret");
  writeFileSync(path, Buffer.alloc(32, 7));
  let unblock!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  setAsyncIcaclsRunnerForTests(async () => { entered(); await gate; return ok; });
  const pending = hardenSecretDirAsync(root, { required: true });
  await started;
  let secretAttempts = 0;
  setIcaclsRunnerForTests(args => {
    if (args[0] === path) secretAttempts++;
    return { ...ok, success: false, exitCode: 5 };
  });
  try {
    expect(() => codexInstallationIdForAccount("account-a", root)).toThrow("Codex installation identity unavailable");
    expect(secretAttempts).toBeGreaterThan(0);
    expect(readFileSync(path)).toEqual(Buffer.alloc(32, 7));
  } finally { unblock(); await pending; }
});

test("failed empty-file ACL admission never writes secret bytes", () => {
  let attempted = false;
  setIcaclsRunnerForTests(args => {
    if (!args[0]!.includes(".codex-installation-secret-")) return ok;
    attempted = true;
    expect(readFileSync(args[0]!).length).toBe(0);
    return { ...ok, success: false, exitCode: 5 };
  });
  expect(() => codexInstallationIdForAccount("account-a", root)).toThrow("Codex installation identity unavailable");
  expect(attempted).toBe(true);
  expect(existsSync(join(root, "codex-installation-secret"))).toBe(false);
});

for (const existing of [false, true]) test.if(process.platform === "win32")(`native protected secret survives parent ACL propagation (existing=${existing})`, async () => {
  const path = join(root, "codex-installation-secret");
  if (existing) writeFileSync(path, Buffer.alloc(32, 7));
  let entered!: () => void;
  let unblock!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  setAsyncIcaclsRunnerForTests(async args => {
    entered();
    await gate;
    const child = Bun.spawn([resolveTrustedWindowsIcaclsExe(), ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { success: exitCode === 0, exitCode, timedOut: false, stdout, stderr };
  });
  const pending = hardenSecretDirAsync(root, { required: true });
  await started;
  let id: string;
  try {
    id = codexInstallationIdForAccount("account-a", root);
    expect(verifySecretPathAcl(path)).toBe(true);
    if (existing) expect(readFileSync(path)).toEqual(Buffer.alloc(32, 7));
  } finally { unblock(); await pending; }
  expect(verifySecretPathAcl(path)).toBe(true);
  expect(codexInstallationIdForAccount("account-a", root)).toBe(id!);
});
