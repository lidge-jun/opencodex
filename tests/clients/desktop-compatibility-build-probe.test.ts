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
