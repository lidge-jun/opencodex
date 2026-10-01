import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ownerRegistryDir, readOwnerRegistry, registerOwnerRegistryHome } from "../../src/config/owner-registry";
import { setWindowsHardeningForTests } from "../../src/config/atomic-write";
import { resetHardenedStateForTests, setIcaclsRunnerForTests, setPlatformForTests, type IcaclsResult } from "../../src/lib/windows-secret-acl";
import { setWindowsPrincipalRunnerForTests } from "../../src/lib/windows-user-principal";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousEnv = {
  OPENCODEX_HOME: process.env.OPENCODEX_HOME,
  OCX_OWNER_REGISTRY_DIR: process.env.OCX_OWNER_REGISTRY_DIR,
  OPENCODEX_ACL_VERIFY_EXISTING: process.env.OPENCODEX_ACL_VERIFY_EXISTING,
};
const success: IcaclsResult = { success: true, exitCode: 0, timedOut: false, stdout: "" };
let root: string;
let home: string;
let calls: string[][];

beforeEach(() => {
  // The no-follow writer canonicalizes the registry directory before naming its temp file, so
  // the mocked icacls runner sees the real path. On macOS tmpdir() sits under /var, a symlink to
  // /private/var: an uncanonical root made the prefix assertion throw inside the runner, the
  // required entry hardening failed, and registration silently wrote nothing.
  root = realpathSync(mkdtempSync(join(tmpdir(), "ocx-owner-registry-acl-")));
  home = join(root, "home");
  mkdirSync(home);
  writeFileSync(join(home, "runtime-port.json"), "{}\n");
  process.env.OPENCODEX_HOME = home;
  process.env.OCX_OWNER_REGISTRY_DIR = join(root, "registry");
  delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  calls = [];
  resetHardenedStateForTests();
  setPlatformForTests("win32");
  setWindowsHardeningForTests(true);
  setWindowsPrincipalRunnerForTests(() => ({ ...success, stdout: "S-1-5-21-1-2-3-1001\nSYNTHETIC\\owner\n" }));
  setIcaclsRunnerForTests(args => {
    expect(args[0]!.startsWith(root + sep)).toBe(true);
    calls.push([...args]);
    return success;
  });
});

afterEach(() => {
  setIcaclsRunnerForTests(null);
  setWindowsPrincipalRunnerForTests(null);
  setWindowsHardeningForTests(null);
  setPlatformForTests(null);
  resetHardenedStateForTests();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeTreeWithRetry(root);
});

test("registry publication requires the owner-only Windows directory ACL before writing an entry", () => {
  const dir = ownerRegistryDir();
  mkdirSync(dir);
  chmodSync(dir, 0o777);
  setIcaclsRunnerForTests(args => {
    expect(args[0]!.startsWith(root + sep)).toBe(true);
    calls.push([...args]);
    if (args[0] === dir) expect(readdirSync(dir)).toEqual([]);
    return success;
  });

  registerOwnerRegistryHome(home);

  expect(calls.slice(0, 3)).toEqual([
    [dir, "/grant:r", "*S-1-5-21-1-2-3-1001:(OI)(CI)(F)"],
    [dir, "/inheritance:r"],
    [dir, "/remove:g", "*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545"],
  ]);
  expect(readOwnerRegistry().homes).toEqual([home]);
  const entries = readdirSync(dir);
  expect(entries).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(dir, entries[0]!), "utf8"))).toEqual({ home, v: 1 });
});

for (const failingStep of ["/grant:r", "/inheritance:r", "/remove:g", "timeout"] as const) {
  test(`registry publication writes no entry when directory hardening fails at ${failingStep}`, () => {
    const dir = ownerRegistryDir();
    setIcaclsRunnerForTests(args => {
      expect(args[0]!.startsWith(root + sep)).toBe(true);
      calls.push([...args]);
      if (args[0] === dir && (args[1] === failingStep || failingStep === "timeout")) {
        return { success: false, exitCode: failingStep === "timeout" ? null : 5, timedOut: failingStep === "timeout", stdout: "" };
      }
      // A failed broad-SID removal is not harmless: verification still finds the grant.
      return args[0] === dir && args[1] === "/findsid" ? { ...success, stdout: dir } : success;
    });

    expect(() => registerOwnerRegistryHome(home)).not.toThrow();

    expect(readdirSync(dir)).toEqual([]);
    expect(readOwnerRegistry().homes).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(args => args[0] === dir)).toBe(true);
  });
}

test("registry publication refuses a directory symlink without hardening or writing through it", () => {
  const target = join(root, "foreign-directory");
  mkdirSync(target);
  const canary = join(target, "canary");
  writeFileSync(canary, "synthetic canary\n");
  symlinkSync(target, ownerRegistryDir(), "junction");

  registerOwnerRegistryHome(home);

  expect(calls).toEqual([]);
  expect(readdirSync(target)).toEqual(["canary"]);
  expect(readFileSync(canary, "utf8")).toBe("synthetic canary\n");
});
