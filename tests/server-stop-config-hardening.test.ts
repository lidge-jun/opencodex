import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { flushConfigDirHardening, flushConfigDirHardeningForTests, hardenConfigDir } from "../src/config/paths";
import * as windowsAcl from "../src/lib/windows-secret-acl";
import * as nativeStartup from "../src/codex/native-profile-startup";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/**
 * On Windows, `hardenConfigDir()` starts an `icacls.exe` child that holds the config directory
 * open until it exits. `server.stop(true)` used to resolve without waiting for it, so a caller
 * that removed the directory right after a "clean" shutdown got EPERM/EBUSY (mandatory file
 * locking). Every Windows CI shard since e5d588669 failed on exactly that: the fixture teardown
 * of the account-store, auth-api and every live-server suite. The contract now: stop() settles
 * the flight the process itself started.
 */

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const originalPlatform = process.platform;

function config(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "kimi",
    providers: { kimi: { adapter: "openai-chat", baseUrl: "https://kimi.test/v1", liveModels: false, models: ["k3"] } },
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-stop-harden-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-stop-harden-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(config());
});

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  await flushConfigDirHardeningForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

test("server.stop(true) waits for the config-dir ACL flight the startup loadConfig started", async () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  const spy = spyOn(windowsAcl, "hardenSecretDirAsync").mockImplementation(async () => {
    started += 1;
    await pending;
    return { ok: true };
  });
  let server: ReturnType<typeof startServer> | null = null;
  try {
    server = startServer(0);
    expect(started).toBe(1);
    let stopped = false;
    const stopping = server.stop(true).then(() => { stopped = true; });
    // Deterministic oracle: wait until the listener is actually closed (a connect attempt is
    // refused) instead of guessing a delay. After that, the only thing keeping stop() open is
    // the held ACL flight.
    const port = server.port;
    let refused = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      refused = await fetch(`http://127.0.0.1:${port}/healthz`).then(() => false, () => true);
      if (refused) break;
      await Bun.sleep(5);
    }
    // Fail closed: "still pending" is only meaningful once the listener is provably closed.
    expect(refused).toBe(true);
    await Bun.sleep(5);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    server = null;
  } finally {
    release();
    if (server) await server.stop(true);
    spy.mockRestore();
  }
});

test("server.stop(true) resolves promptly when no flight is in progress", async () => {
  const server = startServer(0);
  const t0 = Date.now();
  await server.stop(true);
  expect(Date.now() - t0).toBeLessThan(2_000);
});

test("a rejected native-lifecycle release still drains the ACL flight before stop() settles", async () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let flightSettled = false;
  const aclSpy = spyOn(windowsAcl, "hardenSecretDirAsync").mockImplementation(async () => {
    await pending;
    flightSettled = true;
    return { ok: true };
  });
  const releaseSpy = spyOn(nativeStartup, "releaseNativeMainStartupLifecycle").mockImplementation(async () => {
    throw new Error("native release exploded");
  });
  let server: ReturnType<typeof startServer> | null = null;
  try {
    server = startServer(0);
    let settled: "pending" | "rejected" | "resolved" = "pending";
    let rejection: unknown;
    const stopping = server.stop(true).then(() => { settled = "resolved"; }, (error: unknown) => { settled = "rejected"; rejection = error; });
    await new Promise(resolve => setTimeout(resolve, 60));
    // The release already threw, but stop() must not settle until the flight is drained.
    expect(settled).toBe("pending");
    expect(flightSettled).toBe(false);
    release();
    await stopping;
    expect(flightSettled).toBe(true);
    expect(settled).toBe("rejected");
    // The original failure is what the caller sees; the flush never replaces it.
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("native release exploded");
    server = null;
  } finally {
    release();
    releaseSpy.mockRestore();
    aclSpy.mockRestore();
    if (server) await server.stop(true).catch(() => undefined);
  }
});

test("flushConfigDirHardening scopes to one directory and is a no-op for a stranger", async () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const spy = spyOn(windowsAcl, "hardenSecretDirAsync").mockImplementation(async () => { await pending; return { ok: true }; });
  try {
    hardenConfigDir();
    let settled = false;
    const own = flushConfigDirHardening(testDir).then(() => { settled = true; });
    await flushConfigDirHardening(join(testDir, "not-a-flight"));
    expect(settled).toBe(false);
    release();
    await own;
    expect(settled).toBe(true);
  } finally {
    release();
    spy.mockRestore();
  }
});
