import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseNativeRuntimePool } from "../../src/adapters/muse-msp/runtime-pool";
import { startServer, waitForFailedStartRollback } from "../../src/server";
import { getConfigDir, saveConfig } from "../../src/config";
import type { OcxConfig } from "../../src/types";

test("server shutdown and failed startup drain their own Muse pool", async () => {
  const home = await mkdtemp(join(tmpdir(), "ocx-muse-server-test-"));
  const previous = { OPENCODEX_HOME: process.env.OPENCODEX_HOME, CODEX_HOME: process.env.CODEX_HOME, OCX_DISABLE_UPDATE_CHECK: process.env.OCX_DISABLE_UPDATE_CHECK };
  process.env.OPENCODEX_HOME = join(home, "ocx"); process.env.CODEX_HOME = join(home, "codex"); process.env.OCX_DISABLE_UPDATE_CHECK = "1";
  const pool = new MuseNativeRuntimePool(), failedPool = new MuseNativeRuntimePool();
  let server: ReturnType<typeof startServer> | undefined;
  let listener: ReturnType<typeof Bun.serve> | undefined;
  let release!: () => void, closed = 0, failedClosed = 0;
  const wait = new Promise<void>(resolve => { release = resolve; });
  try {
    expect(getConfigDir()).toBe(join(home, "ocx"));
    saveConfig({ port: 0, hostname: "127.0.0.1", codexAutoStart: false, integrations: { codex: { enabled: false }, claudeCode: { enabled: false } },
      apiKeys: [], defaultProvider: "claude-cli", providers: { "claude-cli": { adapter: "claude-cli", baseUrl: "https://example.invalid", authMode: "key", apiKey: "dummy", selectedModels: ["test"] } } } as OcxConfig);
    pool.acquire("route", () => ({ async run() { return []; }, onResponseRendered() {}, async close() { closed++; } }), "target");
    server = startServer(0, { museNativeRuntimePool: pool });
    expect((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status).toBe(200);
    await server.stop(true); server = undefined;
    expect(closed).toBe(1);

    failedPool.acquire("route", () => ({ async run() { return []; }, onResponseRendered() {}, async close() { failedClosed++; await wait; } }), "target");
    listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("fixture"); } });
    let failure: unknown;
    try { startServer(listener.port, { museNativeRuntimePool: failedPool }); } catch (error) { failure = error; }
    expect(failure).toBeDefined();
    let rollbackDone = false;
    const rollback = waitForFailedStartRollback(failure).then(() => { rollbackDone = true; });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(failedClosed).toBe(1); expect(rollbackDone).toBe(false);
    release(); await rollback; expect(rollbackDone).toBe(true);
  } finally {
    release(); await server?.stop(true); await Promise.allSettled([pool.close(), failedPool.close()]); listener?.stop(true);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(home, { recursive: true, force: true });
  }
}, 20000);
