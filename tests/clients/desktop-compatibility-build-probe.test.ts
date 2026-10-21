import { expect, test } from "bun:test";
import { createInstalledBuildProbe, DESKTOP_COMPATIBILITY_ASSESSED_VERSION, DESKTOP_COMPATIBILITY_ASSESSED_FAMILY } from "../../src/codex/desktop-compatibility/installed-build";
import type { DesktopAppInstall } from "../../src/codex/desktop-app/types";

const installed = (version = DESKTOP_COMPATIBILITY_ASSESSED_VERSION): DesktopAppInstall => ({
  id: DESKTOP_COMPATIBILITY_ASSESSED_FAMILY, root: `C:\\Program Files\\WindowsApps\\OpenAI.Codex_${version}_x64__2p2nqsd0c76g0`, relaunch: `${DESKTOP_COMPATIBILITY_ASSESSED_FAMILY}!App`,
});

test("matching version text cannot qualify a foreign package family, publisher or app entry", async () => {
  const original = installed();
  for (const candidate of [{ ...original, id: "Foreign.Codex_2p2nqsd0c76g0" },
    { ...original, relaunch: `${original.id}!Other` },
    { ...original, root: original.root.replace("__2p2nqsd0c76g0", "__foreign") },
    { ...original, id: "OpenAI.Codex_foreign", relaunch: "OpenAI.Codex_foreign!App", root: original.root.replace("__2p2nqsd0c76g0", "__foreign") },
    { ...original, root: original.root + "_extra" }]) {
    const probe = createInstalledBuildProbe(async () => candidate);
    expect(await probe.check()).toBe(false); await probe.close();
  }
});

test("concurrent build checks share only the pending query and refresh after it settles", async () => {
  let calls = 0, release!: (value: DesktopAppInstall | null) => void;
  const probe = createInstalledBuildProbe(async () => { calls++; return new Promise(resolve => { release = resolve; }); });
  const first = probe.check(), second = probe.check();
  await Bun.sleep(0); expect(calls).toBe(1);
  release(installed()); expect(await first).toBe(true); expect(await second).toBe(true);
  const changed = probe.check(); await Bun.sleep(0); expect(calls).toBe(2);
  release(installed("99.1.1.0")); expect(await changed).toBe(false);
  await probe.close();
});

test("shutdown aborts the owned query and waits for its cleanup before settling", async () => {
  let aborted = false, reaped!: () => void, closed = false;
  const probe = createInstalledBuildProbe(signal => new Promise(resolve => {
    reaped = () => resolve(null);
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
  }));
  const pending = probe.check(); await Bun.sleep(0);
  const closing = probe.close().then(() => { closed = true; });
  await Bun.sleep(0); expect(aborted).toBe(true); expect(closed).toBe(false);
  reaped(); await closing; expect(await pending).toBe(false); expect(await probe.check()).toBe(false);
});

test("a failed probe is closed and the next fresh query can recover", async () => {
  let calls = 0;
  const probe = createInstalledBuildProbe(async () => { if (++calls === 1) throw new Error("fixture failure"); return installed(); });
  expect(await probe.check()).toBe(false); expect(await probe.check()).toBe(true);
  await probe.close();
});

test("build assessment exposes only the last completed public package metadata", async () => {
  let install: DesktopAppInstall | null = null, calls = 0;
  const probe = createInstalledBuildProbe(async () => (++calls, install));
  expect(probe.lastResult()).toBeNull();
  install = installed("26.1007.9446.0");
  expect(await probe.check()).toBe(false);
  const unverified = probe.lastResult();
  expect(unverified).toMatchObject({ assessedVersion: DESKTOP_COMPATIBILITY_ASSESSED_VERSION, observedVersion: "26.1007.9446.0", verified: false });
  expect(unverified!.completedAt).toBeGreaterThan(0);
  expect(JSON.stringify(unverified)).not.toContain("WindowsApps");
  install = installed();
  expect(await probe.check()).toBe(true);
  expect(probe.lastResult()).toMatchObject({ observedVersion: DESKTOP_COMPATIBILITY_ASSESSED_VERSION, verified: true });
  install = { ...installed(), root: "E:\elsewhere\not-a-package-name" };
  expect(await probe.check()).toBe(false);
  expect(probe.lastResult()!.observedVersion).toBeNull();
  install = null;
  expect(await probe.check()).toBe(false);
  expect(probe.lastResult()!.observedVersion).toBeNull();
  const settled = probe.lastResult()!;
  expect(calls).toBe(4); await probe.close();
  expect(probe.lastResult()).toEqual(settled);
});

test("an interrupted in-flight check preserves the last completed assessment", async () => {
  let calls = 0, queryAborted = false, secondStarted!: () => void;
  const started = new Promise<void>(resolve => { secondStarted = resolve; });
  const probe = createInstalledBuildProbe(signal => { calls++; return calls === 1 ? Promise.resolve(installed())
    : new Promise<DesktopAppInstall | null>(resolve => { secondStarted(); signal.addEventListener("abort", () => { queryAborted = true; resolve(installed("9.9.9.9")); }, { once: true }); }); });
  expect(await probe.check()).toBe(true);
  const pending = probe.check();
  await started; expect(calls).toBe(2);
  let settled = false; void pending.then(() => { settled = true; });
  await Bun.sleep(0); expect(settled).toBe(false);
  const closing = probe.close(); expect(queryAborted).toBe(true);
  expect(await pending).toBe(false); await closing;
  expect(probe.lastResult()!.verified).toBe(true);
  expect(probe.lastResult()!.observedVersion).toBe(DESKTOP_COMPATIBILITY_ASSESSED_VERSION);
});

test("a completed probe failure reports unverified instead of retaining a stale verdict", async () => {
  let calls = 0;
  const probe = createInstalledBuildProbe(async () => (++calls === 1 ? installed() : Promise.reject(new Error("fixture failure"))));
  expect(await probe.check()).toBe(true);
  expect(await probe.check()).toBe(false);
  expect(probe.lastResult()).toMatchObject({ observedVersion: null, verified: false });
  await probe.close();
});
