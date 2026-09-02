import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigMutationLockError, loadConfig, saveConfig, withConfigMutationLockSync } from "../src/config";
import { CodexCredentialRefreshLockTimeoutError, getCodexAccountCredential, saveCodexAccountCredential } from "../src/codex/account-store";
import type { OcxConfig } from "../src/types";
import { ManagementRequest, managementHeaders } from "./helpers/management-auth";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let testRoot = "";
let previousOpencodexHome: string | undefined;

function config(port = 10100): OcxConfig {
  return { port, providers: {}, defaultProvider: "openai" };
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for child marker ${path}`);
}

async function waitForOwnedChild(child: ReturnType<typeof Bun.spawn>): Promise<number> {
  const result = await Promise.race([
    child.exited.then(exitCode => ({ exitCode })),
    Bun.sleep(5_000).then(() => null),
  ]);
  if (result) return result.exitCode;
  child.kill();
  await child.exited;
  throw new Error("Timed out waiting for owned config-lock child");
}

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  testRoot = mkdtempSync(join(import.meta.dir, ".tmp-config-mutation-lock-"));
  process.env.OPENCODEX_HOME = testRoot;
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  removeTreeWithRetry(testRoot);
});

test("a live cross-process holder is not stolen and runtime writers fail immediately", async () => {
  saveConfig(config());
  const readyPath = join(testRoot, "holder-ready");
  const releasePath = join(testRoot, "holder-release");
  const configModuleUrl = pathToFileURL(join(import.meta.dir, "../src/config.ts")).href;
  const childSource = `
    import { existsSync, writeFileSync } from "node:fs";
    import { withConfigMutationLockSync } from ${JSON.stringify(configModuleUrl)};
    withConfigMutationLockSync(() => {
      writeFileSync(${JSON.stringify(readyPath)}, "ready");
      while (!existsSync(${JSON.stringify(releasePath)})) Bun.sleepSync(10);
    });
  `;
  const child = Bun.spawn([process.execPath, "-e", childSource], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, OPENCODEX_HOME: testRoot },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    try {
      await waitForPath(readyPath);
    } catch (error) {
      child.kill();
      await child.exited;
      const stderr = await new Response(child.stderr).text().catch(() => "");
      throw new Error(`${(error as Error).message}\nchild stderr: ${stderr}`);
    }
    const startedAt = performance.now();
    expect(() => saveConfig(config(20200))).toThrow(ConfigMutationLockError);
    expect(() => saveCodexAccountCredential("busy-account", {
      accessToken: "busy-access",
      refreshToken: "busy-refresh",
      expiresAt: Date.now() + 60_000,
      chatgptAccountId: "busy-chatgpt-account",
    })).toThrow(CodexCredentialRefreshLockTimeoutError);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(loadConfig().port).toBe(10100);
    expect(getCodexAccountCredential("busy-account")).toBeNull();
  } finally {
    writeFileSync(releasePath, "release");
    expect(await waitForOwnedChild(child)).toBe(0);
  }

  saveConfig(config(20200));
  saveCodexAccountCredential("busy-account", {
    accessToken: "fresh-access",
    refreshToken: "fresh-refresh",
    expiresAt: Date.now() + 60_000,
    chatgptAccountId: "fresh-chatgpt-account",
  });
  expect(loadConfig().port).toBe(20200);
  expect(getCodexAccountCredential("busy-account")?.accessToken).toBe("fresh-access");
});

test("an abruptly exited holder releases the OS-backed transaction without stale recovery", async () => {
  saveConfig(config());
  const enteredPath = join(testRoot, "crashed-holder-entered");
  const configModuleUrl = pathToFileURL(join(import.meta.dir, "../src/config.ts")).href;
  const childSource = `
    import { writeFileSync } from "node:fs";
    import { withConfigMutationLockSync } from ${JSON.stringify(configModuleUrl)};
    withConfigMutationLockSync(() => {
      writeFileSync(${JSON.stringify(enteredPath)}, "entered");
      process.exit(0);
    });
  `;
  const child = Bun.spawn([process.execPath, "-e", childSource], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, OPENCODEX_HOME: testRoot },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await waitForOwnedChild(child)).toBe(0);
  expect(existsSync(enteredPath)).toBe(true);
  expect(() => saveConfig(config(30300))).not.toThrow();
  expect(loadConfig().port).toBe(30300);
});

test("a throwing mutation releases the lock and leaves writers available", () => {
  saveConfig(config());
  expect(() => withConfigMutationLockSync(() => {
    throw new Error("mutation failed");
  })).toThrow("mutation failed");
  expect(() => saveConfig(config(50500))).not.toThrow();
  expect(loadConfig().port).toBe(50500);
});

test("management API maps config mutation lock contention to retryable 503", async () => {
  saveConfig(config());
  const readyPath = join(testRoot, "mgmt-holder-ready");
  const releasePath = join(testRoot, "mgmt-holder-release");
  const configModuleUrl = pathToFileURL(join(import.meta.dir, "../src/config.ts")).href;
  const childSource = `
    import { existsSync, writeFileSync } from "node:fs";
    import { withConfigMutationLockSync } from ${JSON.stringify(configModuleUrl)};
    withConfigMutationLockSync(() => {
      writeFileSync(${JSON.stringify(readyPath)}, "ready");
      while (!existsSync(${JSON.stringify(releasePath)})) Bun.sleepSync(10);
    });
  `;
  const child = Bun.spawn([process.execPath, "-e", childSource], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, OPENCODEX_HOME: testRoot },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    await waitForPath(readyPath);
    const { handleManagementAPI } = await import("../src/server/management-api");
    const url = new URL("http://localhost/api/codex-auth/auto-switch");
    const response = await handleManagementAPI(
      new ManagementRequest(url, {
        method: "PUT",
        headers: managementHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ threshold: 50 }),
      }),
      url,
      config(),
    );
    expect(response?.status).toBe(503);
    expect(await response!.json()).toMatchObject({
      error: "Configuration is busy; retry shortly",
      code: "CONFIG_MUTATION_LOCK_UNAVAILABLE",
    });
  } finally {
    writeFileSync(releasePath, "release");
    expect(await waitForOwnedChild(child)).toBe(0);
  }
});
