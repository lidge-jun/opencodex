import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
  type IcaclsResult,
} from "../../src/lib/windows-secret-acl";
import { setSyntheticWindowsPrincipalForTests } from "../../src/lib/windows-user-principal";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { createTestCaseLifecycle, createTestSandboxCleanup } from "../helpers/test-sandbox-cleanup";

test("sandbox removal waits for producers and the actual reap after the caller belt fires", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-sandbox-reap-"));
  const target = join(root, "fixture.json");
  writeFileSync(target, "{}");
  const started = Promise.withResolvers<void>();
  const reaped = Promise.withResolvers<IcaclsResult>();
  const producers = Promise.withResolvers<void>();
  let fireBelt: (() => void) | undefined;
  let removals = 0;
  let barrierEntered = false;
  let clock = 0;
  setNowForTests(() => clock);
  setPlatformForTests("win32");
  setSyntheticWindowsPrincipalForTests("*S-1-5-21-1-2-3-1001");
  setAsyncIcaclsRunnerForTests(async () => { started.resolve(); return reaped.promise; });
  setAsyncIcaclsBeltSchedulerForTests(callback => { fireBelt = callback; return () => {}; });
  const timeout = { success: false, exitCode: null, timedOut: true, stdout: "" };
  const hardening = hardenSecretPathAsync(target, { required: false, deadlineMs: 10_000 });
  let pending: Promise<void> | undefined;
  try {
    await started.promise;
    clock = 10_001; // The real belt fires after the hardening deadline; no diagnostic probe remains.
    fireBelt!();
    expect((await hardening).ok).toBe(false);
    expect(windowsSecretAclReapPendingAtOrBelow(root)).toBe(true);
    const cleanup = createTestSandboxCleanup({
      drainProducers: () => producers.promise,
      waitForReaps: () => { barrierEntered = true; return flushWindowsSecretAclReapsBeforeRemoval(root); },
      hasPendingReaps: () => windowsSecretAclReapPendingAtOrBelow(root),
      remove: () => { removals++; },
    });
    cleanup.onExit();
    expect(removals).toBe(0);
    pending = cleanup.afterAll();
    expect(barrierEntered).toBe(false);
    producers.resolve();
    await Promise.resolve();
    expect(barrierEntered).toBe(true);
    cleanup.onExit();
    expect(removals).toBe(0);
    // A live event loop, not sleepSync retries, must deliver this exit observation.
    setTimeout(() => reaped.resolve(timeout), 0);
    await pending;
    expect(removals).toBe(1);
    expect(windowsSecretAclReapPendingAtOrBelow(root)).toBe(false);
    await cleanup.afterAll();
    cleanup.onExit();
    expect(removals).toBe(1);
  } finally {
    producers.resolve();
    reaped.resolve(timeout);
    await hardening;
    await pending;
    await flushWindowsSecretAclReapsBeforeRemoval(root);
    setAsyncIcaclsRunnerForTests(null);
    setAsyncIcaclsBeltSchedulerForTests(null);
    setPlatformForTests(null);
    setNowForTests(null);
    setSyntheticWindowsPrincipalForTests(null);
    resetHardenedStateForTests();
    removeTreeWithRetry(root);
  }
});

test("exit defers a root whose producers have not been drained even without a registered reap", () => {
  let removals = 0;
  const cleanup = createTestSandboxCleanup({
    drainProducers: async () => {}, waitForReaps: async () => {},
    hasPendingReaps: () => false, remove: () => { removals++; },
  });
  cleanup.onExit();
  expect(removals).toBe(0);
});

test("case teardown cancels late work and awaits its shared listener stop before the home is released", async () => {
  const lifecycle = createTestCaseLifecycle();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let stopCalls = 0;
  let settled = false;
  const stop = lifecycle.ownStop(async () => { stopCalls++; await released.promise; });
  const work = lifecycle.run(async () => {
    try {
      await new Promise<void>((_resolve, reject) => {
        lifecycle.abort.signal.addEventListener("abort", () => reject(lifecycle.abort.signal.reason), { once: true });
        entered.resolve();
      });
    } finally {
      await stop();
      settled = true;
    }
  });
  await entered.promise;
  const cleanup = lifecycle.close();
  expect(lifecycle.close()).toBe(cleanup);
  await Promise.resolve();
  expect(stopCalls).toBe(1);
  expect(settled).toBe(false);
  released.resolve();
  await cleanup;
  expect(settled).toBe(true);
  expect(stopCalls).toBe(1);
  await expect(work).resolves.toBeUndefined();
});

test("case ownership preserves ordinary assertion failures", async () => {
  const lifecycle = createTestCaseLifecycle();
  const failure = new Error("fixture assertion failure");
  await expect(lifecycle.run(async () => { throw failure; })).rejects.toBe(failure);
  await lifecycle.close();
});

test("case teardown absorbs only its own abort reason", async () => {
  const lifecycle = createTestCaseLifecycle();
  const foreign = new DOMException("foreign cancellation", "AbortError");
  const entered = Promise.withResolvers<void>();
  const work = lifecycle.run(async () => {
    await new Promise<void>((_resolve, reject) => {
      // Same name as the teardown abort, but not the lifecycle's reason.
      lifecycle.abort.signal.addEventListener("abort", () => reject(foreign), { once: true });
      entered.resolve();
    });
  });
  await entered.promise;
  await lifecycle.close();
  await expect(work).rejects.toBe(foreign);
});
