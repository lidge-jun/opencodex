import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hardenSecretDir, hardenSecretDirAsync, hardenElevatedStageDir, resetHardenedStateForTests,
  setPlatformForTests, setIcaclsRunnerForTests, setAsyncIcaclsRunnerForTests, setStatForTests,
  setNowForTests, hardenedSecretDirCountForTests, timedOutSecretPathCountForTests,
} from "../../src/lib/windows-secret-acl";
import { setWindowsOwnerAclRunnerForTests, setWindowsOwnerAclAsyncRunnerForTests, windowsEntriesAclMatches, windowsPrivateEntriesAclMatches } from "../../src/lib/windows-owner-acl";
import { setWindowsPrincipalRunnerForTests, setAsyncWindowsPrincipalRunnerForTests, resetWindowsPrincipalForTests, resolveCurrentWindowsPrincipal } from "../../src/lib/windows-user-principal";
import { withClientLifecycleSync } from "../../src/client/lifecycle-lock";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const SID = "S-1-5-21-9-9-9-1001";
const OTHER = "S-1-5-21-9-9-9-1002";
const options = { required: true, verifyExistingRuntimeDirectory: true };
const OK = { success: true, timedOut: false, exitCode: 0, stdout: "" };
const principal = { ...OK, stdout: `${SID}\r\nTESTHOST\\tester` };
let root = "";
let commands: string[][];
let savedVerify: string | undefined;

function descriptor(owner = SID, flags = 4100, ace = `A|0|0|3|2032127|${SID}|False`) {
  return `U|${SID}|${SID}|False\nE|0|${owner}|${flags}|1\n${ace}\nEND\n`;
}
function verification(stdout: string, timedOut = false) {
  setWindowsOwnerAclRunnerForTests(() => ({ ...OK, stdout, timedOut }));
  setWindowsOwnerAclAsyncRunnerForTests(async () => ({ ...OK, stdout, timedOut }));
}

test("runtime directory accepts an enabled administrator owner without changing strict private policy", () => {
  const output = descriptor("S-1-5-32-544", 37892).replace(`U|${SID}|${SID}|False`, `U|${SID}|${SID}|True`);
  expect(windowsPrivateEntriesAclMatches(output, [{ path: "unused", directory: true }])).toBe(false);
  const entries = [{ path: "unused", directory: true, policy: "private-runtime-directory" as const }];
  expect(windowsEntriesAclMatches(output, entries)).toBe(true);
  expect(windowsEntriesAclMatches(output.replace("|True\n", "|False\n"), entries)).toBe(false);
  expect(windowsEntriesAclMatches(output, [{ ...entries[0]!, directory: false }])).toBe(false);
  expect(windowsEntriesAclMatches(output.replace(`U|${SID}|${SID}|True`, `U|${SID}|name|True`), entries)).toBe(false);
  expect(windowsEntriesAclMatches(output.replace(`2032127|${SID}|`, "2032127|S-1-1-0|"), entries)).toBe(false);
});

for (const async of [false, true]) {
  test(`enabled administrator-owned runtime directory avoids ${async ? "async" : "sync"} propagation`, async () => {
    verification(descriptor("S-1-5-32-544", 37892).replace(`U|${SID}|${SID}|False`, `U|${SID}|${SID}|True`));
    const result = async ? await hardenSecretDirAsync(root, options) : hardenSecretDir(root, options);
    expect(result.ok).toBe(true);
    expect(commands).toEqual([]);
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-lifecycle-acl-"));
  commands = [];
  savedVerify = process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  setPlatformForTests("win32");
  setWindowsPrincipalRunnerForTests(() => principal);
  setAsyncWindowsPrincipalRunnerForTests(async () => principal);
  setIcaclsRunnerForTests(args => { commands.push(args); return OK; });
  setAsyncIcaclsRunnerForTests(async args => { commands.push(args); return OK; });
  verification(descriptor());
});
afterEach(() => {
  setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null);
  setWindowsOwnerAclRunnerForTests(null); setWindowsOwnerAclAsyncRunnerForTests(null);
  setWindowsPrincipalRunnerForTests(null); setAsyncWindowsPrincipalRunnerForTests(null);
  setStatForTests(null); setNowForTests(null); setPlatformForTests(null);
  resetHardenedStateForTests(); resetWindowsPrincipalForTests();
  if (savedVerify === undefined) delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  else process.env.OPENCODEX_ACL_VERIFY_EXISTING = savedVerify;
  removeTreeWithRetry(root);
});

for (const async of [false, true]) {
  test(`strict existing directory skips propagation without an env switch (${async ? "async" : "sync"})`, async () => {
    const result = async ? await hardenSecretDirAsync(root, options) : hardenSecretDir(root, options);
    expect(result.ok).toBe(true);
    expect(commands).toEqual([]);
  });
  for (const [name, output, timedOut] of [
    ["foreign owner", descriptor(OTHER), false],
    ["unprotected DACL", descriptor(SID, 4), false],
    ["broad grantee", descriptor(SID, 4100, "A|0|0|3|2032127|S-1-1-0|False"), false],
    ["missing child inheritance", descriptor(SID, 4100, `A|0|0|0|2032127|${SID}|False`), false],
    ["unreadable descriptor", "", false],
    ["timed out verification", descriptor(), true],
  ] as const) {
    test(`required ${async ? "async" : "sync"} hardening refuses ${name} when mutation fails`, async () => {
      verification(output, timedOut);
      const fail = (args: string[]) => { commands.push(args); return { ...OK, success: false, exitCode: 5 }; };
      setIcaclsRunnerForTests(fail); setAsyncIcaclsRunnerForTests(async args => fail(args));
      if (async) await expect(hardenSecretDirAsync(root, options)).rejects.toThrow();
      else expect(() => hardenSecretDir(root, options)).toThrow();
      expect(commands[0]?.[1]).toBe("/grant:r");
    });
  }
}

test("a replacement or metadata change during verification cannot skip hardening", () => {
  let ino = 1n;
  let ctimeNs = 1n;
  setStatForTests(() => ({ dev: 1n, ino, ctimeNs }));
  for (const changed of ["object", "freshness"]) {
    resetHardenedStateForTests(); commands = [];
    setWindowsOwnerAclRunnerForTests(() => {
      if (changed === "object") ino++; else ctimeNs++;
      return { ...OK, stdout: descriptor() };
    });
    hardenSecretDir(root, options);
    expect(commands.map(args => args[1])).toEqual(["/grant:r", "/inheritance:r", "/remove:g"]);
  }
});

test("unobservable identity cannot authorize skipping directory hardening", () => {
  setStatForTests(() => ({ dev: 1n, ino: 0n, ctimeNs: 1n }));
  expect(() => hardenSecretDir(root, options)).toThrow();
  expect(commands[0]?.[1]).toBe("/grant:r");
});

test("strict verification cannot fall through to the legacy name-only shortcut", () => {
  process.env.OPENCODEX_ACL_VERIFY_EXISTING = "1";
  verification(descriptor(OTHER));
  setIcaclsRunnerForTests(args => {
    commands.push(args);
    return args.length === 1
      ? { ...OK, stdout: `${root} TESTHOST\\tester:(OI)(CI)(F)\r\n\r\n` }
      : { ...OK, success: false, exitCode: 5 };
  });
  // Populate the legacy identity cache without hardening this directory.
  resolveCurrentWindowsPrincipal(1000);
  expect(() => hardenSecretDir(root, options)).toThrow();
  expect(commands[0]?.[1]).toBe("/grant:r");
});

for (const async of [false, true]) {
  for (const changed of ["dev", "ino", "ctimeNs", "unreadable-before", "unreadable-after"]) {
    test(`${async ? "async" : "sync"} verification cannot skip after ${changed}`, async () => {
      let probed = false;
      setStatForTests(() => {
        if (changed === (probed ? "unreadable-after" : "unreadable-before")) throw new Error("unreadable");
        return { dev: probed && changed === "dev" ? 2n : 1n, ino: probed && changed === "ino" ? 2n : 1n,
          ctimeNs: probed && changed === "ctimeNs" ? 2n : 1n };
      });
      const verify = () => { probed = true; return { ...OK, stdout: descriptor() }; };
      setWindowsOwnerAclRunnerForTests(verify);
      setWindowsOwnerAclAsyncRunnerForTests(async () => verify());
      const fail = (args: string[]) => { commands.push(args); return { ...OK, success: false, exitCode: 5 }; };
      setIcaclsRunnerForTests(fail); setAsyncIcaclsRunnerForTests(async args => fail(args));
      if (async) await expect(hardenSecretDirAsync(root, options)).rejects.toThrow();
      else expect(() => hardenSecretDir(root, options)).toThrow();
      expect(commands[0]?.[1]).toBe("/grant:r");
    });
  }
  test(`late successful ${async ? "async" : "sync"} verification cannot exceed the caller budget`, async () => {
    let now = 0;
    setNowForTests(() => now);
    const late = () => { now = 100; return { ...OK, stdout: descriptor() }; };
    setWindowsOwnerAclRunnerForTests(late);
    setWindowsOwnerAclAsyncRunnerForTests(async () => late());
    const bounded = { ...options, deadlineMs: 100 };
    if (async) await expect(hardenSecretDirAsync(root, bounded)).rejects.toThrow();
    else expect(() => hardenSecretDir(root, bounded)).toThrow();
    expect(commands).toEqual([]);
  });
  test(`failed ${async ? "async" : "sync"} verification leaves only the remaining harden budget`, async () => {
    let now = 0;
    setNowForTests(() => now);
    const refuse = () => { now = 40; return { ...OK, stdout: "" }; };
    setWindowsOwnerAclRunnerForTests(refuse);
    setWindowsOwnerAclAsyncRunnerForTests(async () => refuse());
    const budgets: number[] = [];
    setIcaclsRunnerForTests((args, budget) => { commands.push(args); budgets.push(budget); return OK; });
    setAsyncIcaclsRunnerForTests(async (args, budget) => { commands.push(args); budgets.push(budget); return OK; });
    const bounded = { ...options, deadlineMs: 100 };
    const result = async ? await hardenSecretDirAsync(root, bounded) : hardenSecretDir(root, bounded);
    expect(result.ok).toBe(true);
    expect(budgets).toEqual([60, 60, 60]);
  });
  test(`verified ${async ? "async" : "sync"} calls create no mutation or timeout memo`, async () => {
    let probes = 0;
    const verify = () => { probes++; return { ...OK, stdout: descriptor() }; };
    setWindowsOwnerAclRunnerForTests(verify);
    setWindowsOwnerAclAsyncRunnerForTests(async () => verify());
    for (let i = 0; i < 2; i++) {
      if (async) await hardenSecretDirAsync(root, options); else hardenSecretDir(root, options);
    }
    expect(probes).toBe(2);
    expect(hardenedSecretDirCountForTests()).toBe(0);
    expect(timedOutSecretPathCountForTests()).toBe(0);
    expect(commands).toEqual([]);
  });
}

test("required directory failure prevents the lifecycle callback", () => {
  verification("");
  setIcaclsRunnerForTests(args => { commands.push(args); return { ...OK, success: false, exitCode: 5 }; });
  let ran = false;
  expect(() => withClientLifecycleSync(() => { ran = true; }, { lockPath: join(root, "lock.sqlite") })).toThrow("client_lifecycle_lock_failed");
  expect(ran).toBe(false);
});

test("verified secret shape does not satisfy elevated stage grants", () => {
  hardenElevatedStageDir(root, options);
  expect(commands[0]?.[1]).toBe("/grant:r");
  expect(commands[0]).toContain("*S-1-5-18:(OI)(CI)(RX)");
});

test("lifecycle acquisition opts in for its parent and still hardens its database", () => {
  expect(withClientLifecycleSync(() => 42, { lockPath: join(root, "lock.sqlite") })).toBe(42);
  expect(commands.some(args => args[0] === root)).toBe(false);
  expect(commands.filter(args => args[0] === join(root, "lock.sqlite")).map(args => args[1]))
    .toEqual(["/grant:r", "/inheritance:r", "/remove:g"]);
});
