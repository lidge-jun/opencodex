import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import type { OcxConfig } from "../../src/types";
import type { Desktop3pModelEntry } from "../../src/claude/desktop-3p";
import { repoPath, fixturePath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

const DATA_KEY = "test-key";
const cliPath = repoPath("src/cli/index.ts");
const preloadPath = fixturePath("claude-desktop-network-guard.ts");
const roots: string[] = [];
const children: ReturnType<typeof spawnOwned>[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void | Promise<void> }> = [];

function fixture(side: string, allowedOrigins: string[]) {
  const root = mkdtempSync(join(tmpdir(), "ocx-desktop-" + side + "-"));
  roots.push(root);
  const paths = {
    root, ocx: join(root, "ocx"), codex: join(root, "codex"),
    desktop: join(root, "desktop"), user: join(root, "user"),
    denied: join(root, "denied-network.txt"),
  };
  for (const path of [paths.ocx, paths.codex, paths.desktop, paths.user]) mkdirSync(path, { recursive: true });
  // A valid, isolated API-key auth file prevents fallback to a real OAuth account.
  writeFileSync(join(paths.codex, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "fixture-only-not-a-real-key" }), { mode: 0o600 });
  const env: Record<string, string | undefined> = {
    HOME: paths.user, USERPROFILE: paths.user,
    OPENCODEX_HOME: paths.ocx, CODEX_HOME: paths.codex,
    OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: paths.desktop,
    CLAUDE_CONFIG_DIR: join(paths.user, ".claude"),
    XDG_CONFIG_HOME: join(paths.user, ".config"), XDG_DATA_HOME: join(paths.user, ".local", "share"),
    XDG_RUNTIME_DIR: join(root, "runtime"), APPDATA: join(paths.user, "AppData", "Roaming"),
    LOCALAPPDATA: join(paths.user, "AppData", "Local"),
    PATH: [dirname(process.execPath), ...(process.platform === "win32"
      ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
      : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(delimiter),
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    CI: "true", TERM: "dumb", NO_PROXY: "127.0.0.1,localhost",
    OCX_TEST_ALLOWED_ORIGINS: JSON.stringify(allowedOrigins),
    OCX_TEST_DENIED_REQUESTS: paths.denied,
  };
  mkdirSync(env.XDG_RUNTIME_DIR!, { recursive: true });
  if (process.platform === "win32") {
    // A fresh profile otherwise rebuilds PowerShell's command-analysis cache
    // in every CLI child. Seed an owned copy; background updates must never
    // write the runner's or developer's original cache.
    const cache = join(root, "module-analysis-cache");
    env.PSModuleAnalysisCachePath = cache;
    const source = Object.entries(process.env).find(([key]) =>
      key.toLowerCase() === "psmoduleanalysiscachepath")?.[1];
    if (source && isAbsolute(source)) {
      try {
        const before = lstatSync(source);
        if (before.isFile() && !before.isSymbolicLink()) {
          copyFileSync(source, cache);
          if (lstatSync(cache).size !== before.size) rmSync(cache, { force: true });
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ESTALE") {
          throw new Error("Desktop fixture could not read or copy the PowerShell module cache");
        }
        rmSync(cache, { force: true });
      }
    }
  }
  return { ...paths, env };
}
type Fixture = ReturnType<typeof fixture>;

function writeConfig(fx: Fixture, config: OcxConfig): void {
  writeFileSync(join(fx.ocx, "config.json"), JSON.stringify(config), { mode: 0o600 });
}
function readConfig(fx: Fixture): OcxConfig {
  return JSON.parse(readFileSync(join(fx.ocx, "config.json"), "utf8")) as OcxConfig;
}
function spawnOwned(fx: Fixture, args: string[]) {
  const child = Bun.spawn({
    cmd: [process.execPath, "--preload", preloadPath, cliPath, ...args],
    cwd: fx.root, env: fx.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const owned = { child, stdout: new Response(child.stdout).text(), stderr: new Response(child.stderr).text() };
  children.push(owned);
  return owned;
}
async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
async function stopOwned(owned: ReturnType<typeof spawnOwned>): Promise<void> {
  if (owned.child.exitCode === null) owned.child.kill("SIGTERM");
  try { await within(owned.child.exited, 8_000, "CLI shutdown deadline"); }
  catch {
    if (owned.child.exitCode === null) owned.child.kill("SIGKILL");
    await within(owned.child.exited, 5_000, "CLI forced shutdown deadline");
  }
  await within(Promise.all([owned.stdout, owned.stderr]), 5_000, "CLI output drain deadline");
}
async function startHub(fx: Fixture) {
  const owned = spawnOwned(fx, ["start"]);
  const deadline = performance.now() + 45_000;
  while (performance.now() < deadline) {
    if (owned.child.exitCode !== null) {
      throw new Error("Hub exited before readiness: " + await within(owned.stderr, 5_000, "Exited hub output deadline"));
    }
    try {
      const runtime = JSON.parse(readFileSync(join(fx.ocx, "runtime-port.json"), "utf8")) as { pid: number; port: number };
      if (runtime.pid === owned.child.pid && runtime.port > 0) {
        const origin = "http://127.0.0.1:" + runtime.port;
        const ready = await fetch(origin + "/readyz", { signal: AbortSignal.timeout(500) });
        await ready.text();
        if (ready.ok) return { owned, origin, port: runtime.port };
      }
    } catch { /* listener/runtime record is not ready */ }
    await Bun.sleep(20);
  }
  throw new Error("Hub readiness deadline");
}

function mockProvider() {
  const inference: Array<{ url: string; model: unknown }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") return Response.json({ object: "list", data: [] });
      if (url.pathname !== "/v1/chat/completions") return new Response("unexpected fixture path", { status: 404 });
      const body = await req.json() as { model?: unknown };
      inference.push({ url: req.url, model: body.model });
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant", content: "fixture reply" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2 } },
      ];
      return new Response(chunks.map(chunk => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  servers.push(server);
  return { server, inference };
}
function profile(chosenDay: string, decoyDay: string): NonNullable<NonNullable<OcxConfig["claudeCode"]>["desktopProfile"]> {
  return {
    version: 1,
    assignments: {
      "chosen/model-target": { family: "opus", alias: "claude-opus-4-8-" + chosenDay },
      "decoy/model-decoy": { family: "sonnet", alias: "claude-opus-4-8-" + decoyDay },
    },
    defaults: { opus: "chosen/model-target", fable: null, sonnet: "decoy/model-decoy", haiku: null },
  };
}
function deniedTraffic(fx: Fixture): string {
  return existsSync(fx.denied) ? readFileSync(fx.denied, "utf8") : "";
}

afterEach(async () => {
  const failures: unknown[] = [];
  for (const owned of children.splice(0)) {
    try { await stopOwned(owned); }
    catch (error) {
      failures.push(error);
      if (owned.child.exitCode === null) children.push(owned);
    }
  }
  for (const server of servers.splice(0)) {
    try { await server.stop(true); } catch (error) { failures.push(error); }
  }
  for (const root of roots.splice(0)) {
    try { removeTreeWithRetry(root); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Desktop process fixture cleanup failed");
}, 90_000);

for (const storedProfile of [true, false]) {
  test("connected Desktop uses hub IDs across a cold restart (stored profile=" + storedProfile + ")", async () => {
    const chosen = mockProvider();
    const decoy = mockProvider();
    const hub = fixture("hub", [chosen.server.url.origin, decoy.server.url.origin]);
    hub.env.OPENCODEX_API_AUTH_TOKEN = DATA_KEY;
    const provider = (target: ReturnType<typeof mockProvider>, model: string) => ({
      adapter: "openai-chat" as const, baseUrl: target.server.url.origin + "/v1",
      apiKey: "fixture-provider-key", models: [model], liveModels: false, allowPrivateNetwork: true,
    });
    writeConfig(hub, {
      port: 0, hostname: "127.0.0.1", runtimeRole: "hub",
      defaultProvider: "decoy", codexAutoStart: false, syncResumeHistory: false,
      clientIntegrations: { codex: false, grok: false, "claude-desktop": false },
      providers: { chosen: provider(chosen, "model-target"), decoy: provider(decoy, "model-decoy") },
      subagentModels: ["decoy/model-decoy", "chosen/model-target"],
      claudeCode: {
        enabled: true, nativePassthrough: false, desktopNativeModels: true,
        systemEnv: false, injectAgents: false,
        ...(storedProfile ? { desktopProfile: profile("20260211", "20260212") } : {}),
      },
    } as OcxConfig);
    const first = await startHub(hub);
    // Retain the allocated endpoint so the client's persisted origin survives restart.
    writeConfig(hub, { ...readConfig(hub), port: first.port });
    const client = fixture("client", [first.origin]);
    const localProfile = profile("20260911", "20260912");
    writeConfig(client, {
      port: 1, hostname: "127.0.0.1", runtimeRole: "client", defaultProvider: "unused",
      providers: { unused: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "unused-fixture-key", liveModels: false, models: ["client-only"], allowPrivateNetwork: true } },
      claudeCode: { desktopProfile: localProfile, systemEnv: false, injectAgents: false },
      clientIntegrations: { codex: false, grok: false, "claude-desktop": false },
      client: {
        serverUrl: first.origin, managementUrl: first.origin, managementTransport: "direct",
        selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "fixture-client",
        tokenFingerprint: createHash("sha256").update(DATA_KEY).digest("hex"),
        protocolVersion: 1, connectedAt: "2026-01-01T00:00:00.000Z",
      },
    } as OcxConfig);
    writeFileSync(join(client.ocx, "service-api-token"), DATA_KEY + "\n", { mode: 0o600 });
    const snapshotResponse = await fetch(first.origin + "/v1/models?ids=desktop&format=desktop-config", {
      headers: { "x-opencodex-api-key": DATA_KEY }, signal: AbortSignal.timeout(5_000),
    });
    expect(snapshotResponse.status).toBe(200);
    expect(snapshotResponse.headers.get("cache-control")).toBe("no-store");
    const snapshot = await snapshotResponse.json() as { version: number; models: Desktop3pModelEntry[] };
    expect(snapshot.version).toBe(1);
    expect(snapshot.models.some(model => model.labelOverride.includes("(native)"))).toBe(true);
    const chosenEntry = snapshot.models.find(model => model.labelOverride === "Model Target (chosen)");
    expect(chosenEntry).toBeDefined();
    if (storedProfile) expect(chosenEntry!.name).toBe("claude-opus-4-8-20260211");
    else expect(chosenEntry!.name).toMatch(/^claude-opus-4-8-[a-z][a-z0-9]{2}$/);

    const apply = spawnOwned(client, ["claude", "desktop", "apply", "--static"]);
    // The Windows known-folder lookup alone may validly use its 30s budget
    // (22.8s in hosted tracing); leave room for the rest of this real CLI apply.
    const appliedCode = await within(apply.child.exited, SPAWN_BUDGET_MS, "Remote Desktop apply deadline");
    const appliedOutput = await within(Promise.all([apply.stdout, apply.stderr]), 5_000, "Apply output drain deadline");
    if (appliedCode !== 0) throw new Error("Remote Desktop apply failed: " + appliedOutput[1]);
    expect(appliedOutput.join("\n")).not.toContain(DATA_KEY);
    const metadata = JSON.parse(readFileSync(join(client.desktop, "_meta.json"), "utf8")) as { appliedId: string };
    const written = JSON.parse(readFileSync(join(client.desktop, metadata.appliedId + ".json"), "utf8"));
    expect(written.inferenceGatewayBaseUrl).toBe(first.origin);
    expect(written.inferenceGatewayApiKey).toBe(DATA_KEY);
    expect(written.inferenceModels).toEqual(snapshot.models);
    expect(readConfig(client).claudeCode?.desktopProfile).toEqual(localProfile);
    if (!storedProfile) expect(readConfig(hub).claudeCode?.desktopProfile).toBeUndefined();

    const send = async (origin: string) => {
      const response = await fetch(origin + "/v1/messages", {
        method: "POST", signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json", "x-opencodex-api-key": DATA_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: chosenEntry!.name, max_tokens: 8, stream: true, messages: [{ role: "user", content: "hello" }] }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("message_stop");
    };
    await send(first.origin);
    expect(chosen.inference).toEqual([{ url: chosen.server.url.origin + "/v1/chat/completions", model: "model-target" }]);
    expect(decoy.inference).toEqual([]);

    await stopOwned(first.owned);
    const restarted = await startHub(hub);
    expect(restarted.origin).toBe(first.origin);
    // No model discovery call occurs between restart and this saved-ID request.
    await send(restarted.origin);
    expect(chosen.inference).toEqual([
      { url: chosen.server.url.origin + "/v1/chat/completions", model: "model-target" },
      { url: chosen.server.url.origin + "/v1/chat/completions", model: "model-target" },
    ]);
    expect(decoy.inference).toEqual([]);
    await stopOwned(restarted.owned);
    expect(deniedTraffic(hub)).toBe("");
    expect(deniedTraffic(client)).toBe("");
  }, { timeout: 240_000 });
}
