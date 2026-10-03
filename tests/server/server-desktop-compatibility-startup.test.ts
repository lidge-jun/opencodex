import { expect, test } from "bun:test";
import { scheduleDesktopCompatibilityStartup } from "../../src/server/index/desktop-compatibility-startup";
import { createDesktopCompatibilityService } from "../../src/codex/desktop-compatibility/service";
import { createDesktopCompatibilityRuntime } from "../../src/codex/desktop-compatibility/runtime";
import { getDefaultConfig, validateConfigCandidate } from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import { nativeCompatibilityOwner } from "../../src/codex/desktop-compatibility/routing-binding";
import { createReadinessGate } from "../../src/server/readiness";

test("startup captures the actual bound hostname and clears that owner on shutdown", async () => {
  const config = { ...getDefaultConfig(), hostname: "192.0.2.10" };
  const handle = scheduleDesktopCompatibilityStartup(config, { boundPort: 12001, boundHostname: "127.0.0.1", loopbackPort: 12002, testGuard: true });
  try { expect(nativeCompatibilityOwner()).toMatchObject({ hostname: "127.0.0.1", port: 12001, loopbackPort: 12002 }); }
  finally { await handle.shutdown(); }
  expect(nativeCompatibilityOwner()).toBeNull();
});

test("startup preference is absent by default, strict for writes and safely disabled on malformed disk input", () => {
  expect(getDefaultConfig().desktopCompatibility).toBeUndefined();
  const valid = { ...getDefaultConfig(), desktopCompatibility: { startOnProxyStart: true } };
  expect(validateConfigCandidate(valid).ok).toBe(true);
  for (const setting of [{ startOnProxyStart: "true" }, { startOnProxyStart: true, apply: true }, { enabled: true }]) {
    const value = { ...getDefaultConfig(), desktopCompatibility: setting };
    expect(validateConfigCandidate(value).ok).toBe(false); expect(configSchema.parse(value).desktopCompatibility).toBeUndefined();
  }
});
test("off, unsupported, guarded, sibling and managed-client starts never load the optional runtime", async () => {
  let loads = 0;
  for (const patch of [{ setting: false }, { platform: "linux" }, { testGuard: true }, { sibling: true }, { client: true }]) {
    const config = { ...getDefaultConfig(), desktopCompatibility: { startOnProxyStart: patch.setting ?? true }, ...(patch.client ? { runtimeRole: "client" as const } : {}) };
    const handle = scheduleDesktopCompatibilityStartup(config, { platform: patch.platform ?? "win32", testGuard: patch.testGuard ?? false, sibling: patch.sibling ?? false,
      load: async () => { loads++; throw new Error("must not load"); } });
    await Promise.resolve(); await Promise.resolve();
    await handle.shutdown();
  }
  expect(loads).toBe(0);
});
test("failed optional startup reports a generic diagnostic without failing proxy lifecycle", async () => {
  const warnings: string[] = [];
  const handle = scheduleDesktopCompatibilityStartup({ ...getDefaultConfig(), desktopCompatibility: { startOnProxyStart: true } },
    { platform: "win32", testGuard: false, sibling: false, load: async () => { throw new Error("fixture-sensitive-error"); }, warn: text => warnings.push(text) });
  await Promise.resolve(); await Promise.resolve(); await handle.shutdown();
  expect(warnings).toHaveLength(1); expect(warnings[0]).toContain("did not start"); expect(warnings[0]).not.toContain("fixture-sensitive-error");
});
test("automatic startup and management share one runtime and teardown waits for pending start", async () => {
  let started = 0, stopped = 0, created = 0, ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const service = createDesktopCompatibilityService(() => {
    created++; const runtime = createDesktopCompatibilityRuntime({ platform: "linux" });
    runtime.start = async () => { started++; await waiting; return runtime.status(); };
    runtime.stop = async () => { stopped++; return runtime.status(); };
    return runtime;
  });
  const module = { getDesktopCompatibilityRuntime: () => service.get(), shutdownDesktopCompatibility: () => service.shutdown() };
  const handle = scheduleDesktopCompatibilityStartup({ ...getDefaultConfig(), desktopCompatibility: { startOnProxyStart: true } },
    { platform: "win32", testGuard: false, sibling: false, load: async () => module });
  await Promise.resolve(); await Promise.resolve();
  expect(started).toBe(1); expect(created).toBe(1);
  await expect(service.get().start()).rejects.toThrow("busy");
  let finished = false; const stopping = handle.shutdown().then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false); expect(stopped).toBe(0);
  ready(); await stopping; expect(stopped).toBe(1); expect(service.get()).toBe(service.get());
  await expect(service.get().start()).rejects.toThrow("stopping");
});
test("shutdown before module load finishes prevents late service activation", async () => {
  let release!: () => void, starts = 0, shutdowns = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const runtime = createDesktopCompatibilityRuntime({ platform: "linux" });
  runtime.start = async () => { starts++; return runtime.status(); };
  const handle = scheduleDesktopCompatibilityStartup({ ...getDefaultConfig(), desktopCompatibility: { startOnProxyStart: true } },
    { platform: "win32", testGuard: false, sibling: false, load: async () => {
      await waiting; return { getDesktopCompatibilityRuntime: () => runtime, shutdownDesktopCompatibility: async () => { shutdowns++; } };
    } });
  await Promise.resolve(); const closing = handle.shutdown(); release(); await closing;
  expect(starts).toBe(0); expect(shutdowns).toBe(1);
});

test("automatic observation waits for native configuration readiness", async () => {
  const readiness = createReadinessGate(); let starts = 0, loads = 0;
  const runtime = createDesktopCompatibilityRuntime({ platform: "linux" });
  runtime.start = async () => { starts++; return runtime.status(); };
  const handle = scheduleDesktopCompatibilityStartup({ ...getDefaultConfig(), desktopCompatibility: { startOnProxyStart: true } },
    { platform: "win32", testGuard: false, sibling: false, readiness,
      load: async () => { loads++; return { getDesktopCompatibilityRuntime: () => runtime, shutdownDesktopCompatibility: async () => {} }; } });
  try {
    await Bun.sleep(20); expect(loads).toBe(0); expect(starts).toBe(0);
    readiness.markReady(); await Bun.sleep(150);
    expect(loads).toBe(1); expect(starts).toBe(1);
  } finally { await handle.shutdown(); }
});

test("shutdown cancels pending readiness and never starts a late observation", async () => {
  const readiness = createReadinessGate(); let loads = 0;
  const handle = scheduleDesktopCompatibilityStartup({ ...getDefaultConfig(), desktopCompatibility: { startOnProxyStart: true } },
    { platform: "win32", testGuard: false, sibling: false, readiness,
      load: async () => { loads++; throw new Error("must not load"); }, warn: () => {} });
  await Promise.resolve(); await handle.shutdown(); readiness.markReady(); await Bun.sleep(150);
  expect(loads).toBe(0);
});

test("failed or timed-out readiness leaves optional observation off", async () => {
  for (const failed of [true, false]) {
    const readiness = createReadinessGate(); if (failed) readiness.markFailed();
    let loads = 0; const warnings: string[] = [];
    const handle = scheduleDesktopCompatibilityStartup({ ...getDefaultConfig(), desktopCompatibility: { startOnProxyStart: true } },
      { platform: "win32", testGuard: false, sibling: false, readiness, readinessTimeoutMs: 1,
        load: async () => { loads++; throw new Error("must not load"); }, warn: value => warnings.push(value) });
    await Bun.sleep(150); await handle.shutdown();
    expect(loads).toBe(0); expect(warnings).toHaveLength(1);
  }
});
