import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flushWindowsSecretAclReapsBeforeRemoval,
  hardenSecretPathAsync,
  resetHardenedStateForTests,
  setAsyncIcaclsBeltSchedulerForTests,
  setAsyncIcaclsRunnerForTests,
  setNowForTests,
  setPlatformForTests,
  windowsSecretAclReapPendingAtOrBelow,
  windowsSecretAclReapPendingForPath,
  type IcaclsResult,
} from "../../src/lib/windows-secret-acl";
import { setSyntheticWindowsPrincipalForTests } from "../../src/lib/windows-user-principal";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Directory junctions avoid Windows file-symlink privileges. Skip only if the host
// actually refuses alias creation, rather than excluding Windows coverage by OS.
const directoryAliasesAvailable = (() => {
  const probe = mkdtempSync(join(tmpdir(), "ocx-acl-alias-probe-"));
  try {
    const real = join(probe, "real");
    mkdirSync(real);
    symlinkSync(real, join(probe, "alias"), "junction");
    return true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return false;
  } finally { removeTreeWithRetry(probe); }
})();

const success: IcaclsResult = { success: true, exitCode: 0, timedOut: false, stdout: "" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let root = "";
let previousVerify: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-acl-removal-"));
  previousVerify = process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  resetHardenedStateForTests();
  setPlatformForTests("win32");
  setSyntheticWindowsPrincipalForTests("*S-1-5-21-1-2-3-1001");
});
afterEach(async () => {
  await flushWindowsSecretAclReapsBeforeRemoval(root);
  setAsyncIcaclsRunnerForTests(null);
  setAsyncIcaclsBeltSchedulerForTests(null);
  setNowForTests(null);
  setPlatformForTests(null);
  resetHardenedStateForTests();
  if (previousVerify === undefined) delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  else process.env.OPENCODEX_ACL_VERIFY_EXISTING = previousVerify;
  removeTreeWithRetry(root);
});
function secret(path = join(root, "secret")): string {
  writeFileSync(path, "fixture");
  return path;
}
function holdRunner() {
  const entered = deferred<void>(), release = deferred<IcaclsResult>();
  setAsyncIcaclsRunnerForTests(() => { entered.resolve(); return release.promise; });
  return { entered: entered.promise, release: () => release.resolve(success) };
}
async function expectHeld(path: string) {
  let drained = false;
  const barrier = flushWindowsSecretAclReapsBeforeRemoval(path).then(() => { drained = true; });
  await Promise.resolve();
  expect(windowsSecretAclReapPendingAtOrBelow(path)).toBe(true);
  expect(drained).toBe(false);
  return { barrier };
}

describe("async ACL removal ownership", () => {
  test("normal flight holds the removal barrier before the caller belt", async () => {
    const path = secret(), runner = holdRunner();
    const work = hardenSecretPathAsync(path, { required: true });
    try {
      await runner.entered;
      const { barrier } = await expectHeld(root);
      runner.release();
      await barrier;
      expect((await work).ok).toBe(true);
      expect(windowsSecretAclReapPendingAtOrBelow(root)).toBe(false);
      expect(windowsSecretAclReapPendingForPath(path)).toBe(false);
    } finally { runner.release(); await work; }
  });

  test("ownership spans the gap between successive commands", async () => {
    const first = deferred<IcaclsResult>(), entered = deferred<void>(), gap = deferred<void>();
    let calls = 0;
    setAsyncIcaclsRunnerForTests(() => {
      calls++;
      if (calls === 1) { entered.resolve(); return first.promise; }
      return Promise.resolve(success);
    });
    const work = hardenSecretPathAsync(secret(), { required: true });
    try {
      await entered.promise;
      // Runner settlement queues the caller's continuation through several awaits.
      // This observer runs after runner cleanup but before the second command starts.
      void first.promise.then(() => queueMicrotask(() => gap.resolve()));
      first.resolve(success);
      await gap.promise;
      expect(calls).toBe(1);
      expect(windowsSecretAclReapPendingAtOrBelow(root)).toBe(true);
    } finally { first.resolve(success); await work; }
  });

  test("deadline survivor holds removal after its caller has settled", async () => {
    let now = 0, belt: (() => void) | undefined;
    setNowForTests(() => now);
    setAsyncIcaclsBeltSchedulerForTests(callback => { belt = callback; return () => {}; });
    const path = secret(), runner = holdRunner();
    const work = hardenSecretPathAsync(path, { required: false, deadlineMs: 1_000 });
    try {
      await runner.entered;
      now = 1_001;
      belt!();
      expect((await work).ok).toBe(false);
      expect(windowsSecretAclReapPendingForPath(path)).toBe(true);
      const { barrier } = await expectHeld(root);
      runner.release();
      await barrier;
      expect(windowsSecretAclReapPendingForPath(path)).toBe(false);
      expect(windowsSecretAclReapPendingAtOrBelow(root)).toBe(false);
    } finally { runner.release(); await work; }
  });

  test("nested work holds its root and leaves a sibling removable", async () => {
    const nested = join(root, "a"), sibling = join(root, "root2");
    mkdirSync(nested); mkdirSync(sibling);
    const runner = holdRunner(), work = hardenSecretPathAsync(secret(join(nested, "secret")), { required: true });
    try {
      await runner.entered;
      expect(windowsSecretAclReapPendingAtOrBelow(root)).toBe(true);
      expect(windowsSecretAclReapPendingAtOrBelow(sibling)).toBe(false);
      await flushWindowsSecretAclReapsBeforeRemoval(sibling);
    } finally { runner.release(); await work; }
  });

  test.skipIf(!directoryAliasesAvailable).each([true, false])("real/symlink aliases hold removal in both directions (registered alias=%s)", async registeredAlias => {
    const real = join(root, "real"), alias = join(root, "alias");
    mkdirSync(real); symlinkSync(real, alias, "junction");
    secret(join(real, "secret"));
    const runner = holdRunner();
    const work = hardenSecretPathAsync(join(registeredAlias ? alias : real, "secret"), { required: true });
    try {
      await runner.entered;
      const { barrier } = await expectHeld(registeredAlias ? real : alias);
      runner.release(); await barrier;
    } finally { runner.release(); await work; }
  });

  test.skipIf(!directoryAliasesAvailable).each(["deleted", "retargeted"])("alias %s mid-flight retains removal ownership of the original root", async mutation => {
    const real = join(root, "real"), other = join(root, "other"), alias = join(root, "alias");
    mkdirSync(real); mkdirSync(other); symlinkSync(real, alias, "junction");
    secret(join(real, "secret")); secret(join(other, "secret"));
    const runner = holdRunner();
    const work = hardenSecretPathAsync(join(alias, "secret"), { required: false });
    try {
      await runner.entered;
      expect(windowsSecretAclReapPendingAtOrBelow(real)).toBe(true);
      unlinkSync(alias);
      if (mutation === "retargeted") symlinkSync(other, alias, "junction");
      const { barrier } = await expectHeld(real);
      runner.release(); await barrier;
      expect(windowsSecretAclReapPendingAtOrBelow(real)).toBe(false);
    } finally { runner.release(); await work; }
  });

  test.skipIf(!directoryAliasesAvailable)("alias retargeted by runner before open holds both captured and current destinations", async () => {
    const a = join(root, "a"), b = join(root, "b"), alias = join(root, "alias");
    mkdirSync(a); mkdirSync(b); symlinkSync(a, alias, "junction");
    secret(join(a, "secret")); secret(join(b, "secret"));
    const path = join(alias, "secret"), entered = deferred<void>(), release = deferred<IcaclsResult>();
    let first = true;
    setAsyncIcaclsRunnerForTests(args => {
      if (!first) return Promise.resolve(success);
      first = false;
      expect(args[0]).toBe(path);
      unlinkSync(alias); symlinkSync(b, alias, "junction");
      entered.resolve();
      return release.promise;
    });
    const work = hardenSecretPathAsync(path, { required: false });
    try {
      await entered.promise;
      const original = await expectHeld(a);
      const current = await expectHeld(b);
      release.resolve(success);
      await Promise.all([original.barrier, current.barrier]);
      expect(windowsSecretAclReapPendingAtOrBelow(a)).toBe(false);
      expect(windowsSecretAclReapPendingAtOrBelow(b)).toBe(false);
    } finally { release.resolve(success); await work; }
  });

  test.skipIf(!directoryAliasesAvailable)("deadline survivor retains the pre-start identity after alias retargeting", async () => {
    const real = join(root, "real"), other = join(root, "other"), alias = join(root, "alias");
    mkdirSync(real); mkdirSync(other); symlinkSync(real, alias, "junction");
    secret(join(real, "secret")); secret(join(other, "secret"));
    const path = join(alias, "secret"), runner = holdRunner();
    let now = 0, belt: (() => void) | undefined;
    setNowForTests(() => now);
    setAsyncIcaclsBeltSchedulerForTests(callback => { belt = callback; return () => {}; });
    const work = hardenSecretPathAsync(path, { required: false, deadlineMs: 1_000 });
    try {
      await runner.entered;
      expect(windowsSecretAclReapPendingForPath(path)).toBe(false);
      unlinkSync(alias); symlinkSync(other, alias, "junction");
      now = 1_001; belt!();
      expect((await work).ok).toBe(false);
      expect(windowsSecretAclReapPendingForPath(path)).toBe(true);
      const { barrier } = await expectHeld(real);
      runner.release(); await barrier;
      expect(windowsSecretAclReapPendingForPath(path)).toBe(false);
      expect(windowsSecretAclReapPendingAtOrBelow(real)).toBe(false);
    } finally { runner.release(); await work; }
  });

  test("unreadable identity at registration remains conservative after the path becomes readable", async () => {
    const path = secret(), sibling = join(root, "sibling"), native = realpathSync.native;
    mkdirSync(sibling);
    const identity = spyOn(realpathSync, "native").mockImplementation(target => {
      if (target === path) throw Object.assign(new Error("identity denied"), { code: "EACCES" });
      return native(target);
    });
    const runner = holdRunner(), work = hardenSecretPathAsync(path, { required: true });
    try {
      await runner.entered;
      identity.mockRestore();
      const { barrier } = await expectHeld(sibling);
      runner.release(); await barrier;
      expect(windowsSecretAclReapPendingAtOrBelow(sibling)).toBe(false);
    } finally { runner.release(); await work; identity.mockRestore(); }
  });

  test.skipIf(!directoryAliasesAvailable)("deleted target ancestry is resolved through the surviving alias ancestor", async () => {
    const real = join(root, "real"), alias = join(root, "alias"), gone = join(real, "gone");
    mkdirSync(gone, { recursive: true }); symlinkSync(real, alias, "junction");
    const runner = holdRunner();
    const work = hardenSecretPathAsync(secret(join(gone, "secret")), { required: false });
    try {
      await runner.entered;
      rmSync(gone, { recursive: true, force: true });
      const { barrier } = await expectHeld(alias);
      runner.release(); await barrier;
    } finally { runner.release(); await work; }
  });

  test("unreadable removal identity conservatively holds unrelated work", async () => {
    const unreadable = join(root, "unreadable"), native = realpathSync.native;
    mkdirSync(unreadable);
    const identity = spyOn(realpathSync, "native").mockImplementation(path => {
      if (path === unreadable) throw Object.assign(new Error("identity denied"), { code: "EACCES" });
      return native(path);
    });
    const runner = holdRunner(), work = hardenSecretPathAsync(secret(), { required: true });
    try {
      await runner.entered;
      const { barrier } = await expectHeld(unreadable);
      runner.release(); await barrier;
    } finally { runner.release(); await work; identity.mockRestore(); }
  });

  test.each(["ETIMEDOUT", "EICACLS"])("required failure preserves %s and releases ownership", async code => {
    let now = 0;
    setNowForTests(() => now);
    setAsyncIcaclsRunnerForTests(async () => {
      if (code === "ETIMEDOUT") now = 1_001;
      return { success: false, exitCode: code === "EICACLS" ? 5 : null, timedOut: code === "ETIMEDOUT", stdout: "" };
    });
    const path = secret();
    const error = await hardenSecretPathAsync(path, { required: true, deadlineMs: 1_000 }).catch(error => error);
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(path);
    await flushWindowsSecretAclReapsBeforeRemoval(root);
    expect(windowsSecretAclReapPendingForPath(path)).toBe(false);
    expect(windowsSecretAclReapPendingAtOrBelow(root)).toBe(false);
  });

  test("a rejected runner preserves required failure and leaves no registrations", async () => {
    setAsyncIcaclsRunnerForTests(async () => { throw new Error("injected runner failure"); });
    const path = secret();
    const error = await hardenSecretPathAsync(path, { required: true }).catch(error => error);
    expect(error.code).toBe("EICACLS");
    await flushWindowsSecretAclReapsBeforeRemoval(root);
    expect(windowsSecretAclReapPendingAtOrBelow(root)).toBe(false);
    expect(windowsSecretAclReapPendingForPath(path)).toBe(false);
  });
});
