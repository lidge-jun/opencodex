import { test, expect } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { MuseNativeRuntimePool } from "../../src/adapters/muse-msp/runtime-pool";
import { MuseMspHost } from "../../src/adapters/muse-msp/host";
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

test("registered Muse route refuses configured spend limits before starting the CLI", async () => {
  const home = await mkdtemp(join(tmpdir(), "ocx-muse-spend-test-"));
  const previous = { OPENCODEX_HOME: process.env.OPENCODEX_HOME, CODEX_HOME: process.env.CODEX_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, OCX_DISABLE_UPDATE_CHECK: process.env.OCX_DISABLE_UPDATE_CHECK, PATH: process.env.PATH };
  process.env.OPENCODEX_HOME = join(home, "ocx"); process.env.CODEX_HOME = join(home, "codex");
  process.env.XDG_CONFIG_HOME = join(home, "config"); process.env.OCX_DISABLE_UPDATE_CHECK = "1";
  process.env.PATH = `${home}${delimiter}${previous.PATH ?? ""}`;
  const executable = join(home, process.platform === "win32" ? "muse.exe" : "muse");
  await writeFile(executable, "fixture"); await chmod(executable, 0o700);
  await mkdir(join(home, "config", "muse"), { recursive: true });
  await writeFile(join(home, "config", "muse", "auth.json"), "{}");
  let hostStarts = 0;
  const originalStart = MuseMspHost.start;
  MuseMspHost.start = async () => { hostStarts++; throw new Error("host must not start"); };
  let server: ReturnType<typeof startServer> | undefined;
  try {
    expect(getConfigDir()).toBe(join(home, "ocx"));
    saveConfig({ port: 0, hostname: "127.0.0.1", codexAutoStart: false, integrations: { codex: { enabled: false }, claudeCode: { enabled: false } },
      spend: { pool: { maxTokens: 100_000 } }, apiKeys: [{ id: "fixture", name: "fixture", key: "dummy-client-key", createdAt: "2026-01-01T00:00:00Z" }],
      defaultProvider: "muse-code", providers: { "muse-code": { adapter: "muse-msp", baseUrl: "https://api.meta.ai/v1", authMode: "key",
        museProjectDeveloperPrompt: true, selectedModels: ["muse-spark-1.3"] } } } as OcxConfig);
    server = startServer(0);
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dummy-client-key", "thread-id": "muse-spend-test" },
      body: JSON.stringify({ model: "muse-code/muse-spark-1.3", stream: false, input: [{ role: "user", content: "test" }] }) });
    expect(await response.text()).toContain("muse_spend_limit_unsupported");
    expect(hostStarts).toBe(0);
  } finally {
    MuseMspHost.start = originalStart; await server?.stop(true);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(home, { recursive: true, force: true });
  }
}, 20000);
