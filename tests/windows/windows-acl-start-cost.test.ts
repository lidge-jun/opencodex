/**
 * Windows first-start ACL cost — `src/lib/windows-secret-acl.ts` memo attribution
 * across a content write, and the resulting cost of one `atomicWriteFile`.
 *
 * What is under test is not a timing budget but a COUNT: how many icacls
 * invocations one secret write performs. Every ACL-hardened write used to run the
 * three-step mutation twice, because the temp is hardened while it is still empty
 * and hardened again before the rename, and the content written in between moves
 * the memo's freshness component (`ctimeNs`, which libuv reports from the NTFS
 * ChangeTime on Windows). The second sequence reapplied the ACL the file already
 * had.
 *
 * Several cases model `ctimeNs` as the file's byte length through
 * `setStatForTests`. That is deliberate and it is what keeps them from asserting
 * nothing: the real value is a filesystem clock, and on a coarse-resolution volume
 * two adjacent operations can share a tick, so a test that waited for the clock to
 * move would be asserting the volume's timestamp resolution rather than this
 * module's attribution rule. Modelled this way, the freshness provably moves with
 * the content write and provably does not move otherwise.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hardenElevatedStageDir,
  hardenSecretDir,
  hardenSecretPath,
  hardenedSecretPathCountForTests,
  reattributeHardenedSecretPath,
  resetHardenedStateForTests,
  setAsyncIcaclsRunnerForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
  setStatForTests,
  type IcaclsResult,
} from "../../src/lib/windows-secret-acl";
import {
  resetWindowsPrincipalForTests,
  setAsyncWindowsPrincipalRunnerForTests,
  setWindowsPrincipalRunnerForTests,
} from "../../src/lib/windows-user-principal";
import {
  atomicWriteFile,
  atomicWriteFileAsync,
  setWindowsHardeningForTests,
} from "../../src/config/atomic-write";

import { setWindowsOwnerAclRunnerForTests } from "../../src/lib/windows-owner-acl";

const OK: IcaclsResult = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const PRINCIPAL = {
  success: true,
  exitCode: 0,
  timedOut: false,
  // Two lines exactly: the SID icacls grants by, then the account name.
  stdout: "S-1-5-21-9-9-9-1001\r\nTESTHOST\\tester",
};

/** Real object identity, freshness modelled as the byte length. See the file header. */
function sizeAsFreshness(path: string): { dev: bigint; ino: bigint; ctimeNs: bigint } {
  const s = statSync(path, { bigint: true });
  return { dev: s.dev, ino: s.ino, ctimeNs: s.size };
}

let testDir = "";
let commands: string[][] = [];
let previousAclTimeout: string | undefined;
let previousVerifyExisting: string | undefined;
let previousBatchRestrictions: string | undefined;

beforeEach(() => {
  previousAclTimeout = process.env.OPENCODEX_ACL_TIMEOUT_MS;
  previousVerifyExisting = process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  previousBatchRestrictions = process.env.OPENCODEX_ACL_BATCH_RESTRICTIONS;
  delete process.env.OPENCODEX_ACL_TIMEOUT_MS;
  delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  delete process.env.OPENCODEX_ACL_BATCH_RESTRICTIONS;
  testDir = mkdtempSync(join(tmpdir(), "ocx-acl-cost-"));
  commands = [];
  setPlatformForTests("win32");
  // An injected principal runner outranks both the synthetic POSIX principal and a
  // real PowerShell spawn, so no case here depends on which host it runs on.
  setWindowsPrincipalRunnerForTests(() => PRINCIPAL);
  setAsyncWindowsPrincipalRunnerForTests(async () => PRINCIPAL);
  setIcaclsRunnerForTests(args => { commands.push(args); return OK; });
  setAsyncIcaclsRunnerForTests(async args => { commands.push(args); return OK; });
});

afterEach(() => {
  setWindowsHardeningForTests(null);
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
  setStatForTests(null);
  setPlatformForTests(null);
  setWindowsPrincipalRunnerForTests(null);
  setAsyncWindowsPrincipalRunnerForTests(null);
  resetWindowsPrincipalForTests();
  resetHardenedStateForTests();
  if (previousAclTimeout === undefined) delete process.env.OPENCODEX_ACL_TIMEOUT_MS;
  else process.env.OPENCODEX_ACL_TIMEOUT_MS = previousAclTimeout;
  if (previousVerifyExisting === undefined) delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  else process.env.OPENCODEX_ACL_VERIFY_EXISTING = previousVerifyExisting;
  if (previousBatchRestrictions === undefined) delete process.env.OPENCODEX_ACL_BATCH_RESTRICTIONS;
  else process.env.OPENCODEX_ACL_BATCH_RESTRICTIONS = previousBatchRestrictions;
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

/** Just the icacls verb from each recorded invocation. */
function steps(): (string | undefined)[] {
  return commands.map(args => args[1]);
}

describe("harden memo attribution across a content write", () => {
  test("a re-attributed write leaves the next harden of the same object free", () => {
    setStatForTests(sizeAsFreshness);
    const file = join(testDir, "secret.tmp");
    writeFileSync(file, "", "utf-8");

    hardenSecretPath(file, { required: true });
    const afterFirstHarden = commands.length;
    expect(afterFirstHarden).toBeGreaterThan(0);

    writeFileSync(file, "secret", "utf-8");
    expect(reattributeHardenedSecretPath(file)).toBe(true);

    hardenSecretPath(file, { required: true });
    expect(commands.length).toBe(afterFirstHarden);
  });

  test("without re-attribution the same content write costs a second full sequence", () => {
    setStatForTests(sizeAsFreshness);
    const file = join(testDir, "secret.tmp");
    writeFileSync(file, "", "utf-8");

    hardenSecretPath(file, { required: true });
    const afterFirstHarden = commands.length;

    writeFileSync(file, "secret", "utf-8");
    hardenSecretPath(file, { required: true });

    // This is the cost the re-attribution removes, pinned so the case above
    // cannot quietly become vacuous if freshness stops moving with the write.
    expect(commands.length).toBe(afterFirstHarden * 2);
  });

  test("freshness moving again after re-attribution still forces a full harden", () => {
    const file = join(testDir, "secret.tmp");
    writeFileSync(file, "", "utf-8");
    let ctimeNs = 100n;
    setStatForTests(() => ({ dev: 1n, ino: 10n, ctimeNs }));

    hardenSecretPath(file, { required: true });
    const afterFirstHarden = commands.length;

    ctimeNs = 200n;  // the caller's content write
    expect(reattributeHardenedSecretPath(file)).toBe(true);
    ctimeNs = 300n;  // anything else that touches this object, including its DACL

    hardenSecretPath(file, { required: true });

    // Re-attribution absorbs one freshness move, the one its caller declared.
    // It does not make the memo stop watching: a later move — which on Windows
    // includes a permission change — still misses and is hardened in full.
    expect(commands.length).toBe(afterFirstHarden * 2);
  });

  test("a different object at the path retires the memo rather than inheriting it", () => {
    const file = join(testDir, "secret.tmp");
    writeFileSync(file, "", "utf-8");
    let ino = 10n;
    setStatForTests(() => ({ dev: 1n, ino, ctimeNs: 100n }));

    hardenSecretPath(file, { required: true });
    const afterFirstHarden = commands.length;
    expect(hardenedSecretPathCountForTests()).toBe(1);

    ino = 11n;
    expect(reattributeHardenedSecretPath(file)).toBe(false);
    expect(hardenedSecretPathCountForTests()).toBe(0);

    hardenSecretPath(file, { required: true });
    expect(commands.length).toBe(afterFirstHarden * 2);
  });

  test("an unreadable path retires the memo rather than inheriting it", () => {
    const file = join(testDir, "secret.tmp");
    writeFileSync(file, "", "utf-8");
    let readable = true;
    setStatForTests(() => {
      if (!readable) throw new Error("stat refused");
      return { dev: 1n, ino: 10n, ctimeNs: 100n };
    });

    hardenSecretPath(file, { required: true });
    expect(hardenedSecretPathCountForTests()).toBe(1);

    readable = false;
    expect(reattributeHardenedSecretPath(file)).toBe(false);
    expect(hardenedSecretPathCountForTests()).toBe(0);
  });

  test("re-attribution invents nothing when no harden was recorded for the path", () => {
    setStatForTests(sizeAsFreshness);
    const file = join(testDir, "secret.tmp");
    writeFileSync(file, "data", "utf-8");

    expect(reattributeHardenedSecretPath(file)).toBe(false);
    expect(hardenedSecretPathCountForTests()).toBe(0);

    hardenSecretPath(file, { required: true });
    expect(commands.length).toBeGreaterThan(0);
  });
});

describe("atomicWriteFile Windows ACL cost", () => {
  for (const mode of ["sync", "async"]) test(`opted-in ${mode} write grants its owner before one restriction command`, async () => {
    process.env.OPENCODEX_ACL_BATCH_RESTRICTIONS = "1";
    setWindowsHardeningForTests(true);
    setStatForTests(sizeAsFreshness);
    const destination = join(testDir, "config.json");
    if (mode === "sync") atomicWriteFile(destination, "new");
    else await atomicWriteFileAsync(destination, "new");
    const target = commands[0]?.[0];
    expect(commands).toEqual([
      [target, "/grant:r", "*S-1-5-21-9-9-9-1001:(F)"],
      [target, "/inheritance:r", "/remove:g", "*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545"],
    ]);
    expect(readFileSync(destination, "utf8")).toBe("new");
  });

  for (const mode of ["sync", "async"]) test(`ambiguous compound failure preserves the previous destination (${mode})`, async () => {
    process.env.OPENCODEX_ACL_BATCH_RESTRICTIONS = "1";
    setWindowsHardeningForTests(true);
    const destination = join(testDir, "config.json");
    writeFileSync(destination, "previous");
    const runner = (args: string[]): IcaclsResult => {
      commands.push(args);
      if (args.includes("/inheritance:r") && args.includes("/remove:g")) return { ...OK, success: false, exitCode: 1 };
      return OK;
    };
    setIcaclsRunnerForTests(runner);
    setAsyncIcaclsRunnerForTests(async args => runner(args));
    if (mode === "sync") expect(() => atomicWriteFile(destination, "replacement")).toThrow();
    else await expect(atomicWriteFileAsync(destination, "replacement")).rejects.toThrow();
    expect(commands.some(args => args.includes("/inheritance:r") && args.includes("/remove:g"))).toBe(true);
    expect(steps()).not.toContain("/findsid");
    expect(readFileSync(destination, "utf8")).toBe("previous");
    expect(hardenedSecretPathCountForTests()).toBe(0);
  });

  test("opted-in elevated staging keeps its separate ACL sequence", () => {
    process.env.OPENCODEX_ACL_BATCH_RESTRICTIONS = "1";
    expect(hardenElevatedStageDir(testDir, { required: true }).ok).toBe(true);
    expect(steps()).toEqual(["/grant:r", "/inheritance:r", "/remove:g"]);
    expect(commands[0]).toContain("*S-1-5-32-544:(OI)(CI)(RX)");
  });

  test("a secret write performs one ACL mutation sequence, not two", () => {
    setWindowsHardeningForTests(true);
    setStatForTests(sizeAsFreshness);
    const destination = join(testDir, "auth.json");

    atomicWriteFile(destination, '{"token":"secret"}');

    expect(readFileSync(destination, "utf-8")).toBe('{"token":"secret"}');
    expect(steps()).toEqual(["/grant:r", "/inheritance:r", "/remove:g"]);
    // The temp's memo is released with the temp, so the map does not grow per write.
    expect(hardenedSecretPathCountForTests()).toBe(0);
  });

  test("the asynchronous writer performs the same single sequence", async () => {
    setWindowsHardeningForTests(true);
    setStatForTests(sizeAsFreshness);
    const destination = join(testDir, "auth-async.json");

    await atomicWriteFileAsync(destination, '{"token":"secret"}');

    expect(readFileSync(destination, "utf-8")).toBe('{"token":"secret"}');
    expect(steps()).toEqual(["/grant:r", "/inheritance:r", "/remove:g"]);
    expect(hardenedSecretPathCountForTests()).toBe(0);
  });

  test("hardening the temp is still required: a failure fails the write closed", () => {
    setWindowsHardeningForTests(true);
    setStatForTests(sizeAsFreshness);
    setIcaclsRunnerForTests(args => {
      commands.push(args);
      return { success: false, exitCode: 1, timedOut: false, stdout: "" };
    });
    const destination = join(testDir, "auth-closed.json");

    expect(() => atomicWriteFile(destination, '{"token":"secret"}')).toThrow(/EICACLS/);
    expect(existsSync(destination)).toBe(false);
  });
});

test("runtime directory ACL proof is reused only while its object and metadata match", () => {
  const testDir = mkdtempSync(join(tmpdir(), "ocx-runtime-directory-acl-"));
  const owner = "S-1-5-21-100-200-300-1001";
  let observation = { dev: 1n, ino: 2n, ctimeNs: 3n };
  let verified = true;
  let reads = 0;
  const options = { required: true, verifyExistingRuntimeDirectory: true };
  setPlatformForTests("win32");
  setStatForTests(() => observation);
  setWindowsOwnerAclRunnerForTests(() => {
    reads++;
    return { success: verified, timedOut: false, stdout: `U|${owner}|${owner}|False\nE|0|${owner}|4100|1\nA|0|0|3|2032127|${owner}|False\nEND\n` };
  });
  setWindowsPrincipalRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: `${owner}\nfixture-user\n` }));
  setIcaclsRunnerForTests(() => ({ success: false, exitCode: 1, timedOut: false, stdout: "" }));
  try {
    expect(hardenSecretDir(testDir, options)).toEqual({ ok: true });
    expect(hardenSecretDir(testDir, options)).toEqual({ ok: true });
    expect(reads).toBe(1);
    observation = { ...observation, ctimeNs: 4n };
    expect(hardenSecretDir(testDir, options)).toEqual({ ok: true });
    expect(reads).toBe(2);
    observation = { ...observation, ino: 5n };
    verified = false;
    expect(() => hardenSecretDir(testDir, options)).toThrow();
    expect(reads).toBe(3);
  } finally {
    setPlatformForTests(null);
    setStatForTests(null);
    setWindowsOwnerAclRunnerForTests(null);
    setWindowsPrincipalRunnerForTests(null);
    setIcaclsRunnerForTests(null);
    resetWindowsPrincipalForTests();
    resetHardenedStateForTests();
    rmSync(testDir, { recursive: true, force: true });
  }
});
