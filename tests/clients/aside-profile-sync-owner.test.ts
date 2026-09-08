import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { OwnedIntegrationRefreshOutcome } from "../../src/integrations/owned-refresh";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { handleManagementAPI } from "../../src/server/management-api";
import { setIntegrationMutationFlightTestHooks, setIntegrationPathTestHooks } from "../../src/server/management/integration-routes";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath, repoRoot } from "../helpers/repo-root";

const SYNC_PATH = "/api/client-integrations/aside/sync";
const CHILD_BUDGET_MS = 20_000;
let root: string;
let home: string;
let configHome: string;
let config: OcxConfig;
let isolation: IsolatedCodexHome;
let priorConfigHome: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let baseUrl: string;
let mode: "live" | "missing-route" | "old-response";
let writes: number[];
let syncRequests: Array<{ method: string; body: string }>;
const children: Array<ReturnType<typeof startCli>> = [];

function bounded<T>(promise: Promise<T>, label: string, ms = CHILD_BUDGET_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface ChildMessage {
  phase: "ready" | "refreshed" | "refused";
  pid: number;
  staleEnabled: boolean;
  results?: OwnedIntegrationRefreshOutcome[];
  name?: string;
  status?: number;
}

/** An actual CLI module in a second process, with its own already-loaded config. */
function startCli() {
  const helperUrl = pathToFileURL(repoPath("src", "cli", "aside-profiles.ts")).href;
  const configUrl = pathToFileURL(repoPath("src", "config.ts")).href;
  const source = `
    import { once } from "node:events";
    import { createInterface } from "node:readline";
    import { loadConfig } from ${JSON.stringify(configUrl)};
    import { refreshAsideProfilesThroughServer } from ${JSON.stringify(helperUrl)};
    const deadline = setTimeout(() => process.exit(124), ${CHILD_BUDGET_MS});
    const stale = loadConfig();
    const enabled = () => stale.asideProfileSync?.profiles?.["1"] ?? stale.asideProfileSync?.allProfiles ?? false;
    const emit = value => console.log("ASIDE_SYNC_MESSAGE " + JSON.stringify({ pid: process.pid, staleEnabled: enabled(), ...value }));
    const lines = createInterface({ input: process.stdin });
    const gate = once(lines, "line");
    emit({ phase: "ready" });
    const [release] = await gate;
    lines.close();
    process.stdin.pause();
    if (release !== "refresh") throw new Error("unexpected parent gate message");
    try {
      const results = await refreshAsideProfilesThroughServer({ baseUrl: process.env.ASIDE_SYNC_FIXTURE_URL });
      emit({ phase: "refreshed", results });
    } catch (error) {
      emit({ phase: "refused", name: error.name, status: error.status });
    } finally { clearTimeout(deadline); }
  `;
  const child = spawn(process.execPath, ["--eval", source], {
    cwd: repoRoot(), stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env, HOME: home, USERPROFILE: home, OPENCODEX_HOME: configHome,
      CODEX_HOME: isolation.path, XDG_CONFIG_HOME: join(home, ".config"),
      OPENCODEX_ADMIN_AUTH_TOKEN: "", ASIDE_SYNC_FIXTURE_URL: baseUrl,
    },
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-16_384); });
  child.on("error", error => { stderr += error.message; });
  const exited = new Promise<number | null>(resolve => child.once("close", resolve));
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const cli = {
    async next(): Promise<ChildMessage> {
      return bounded((async () => {
        for (;;) {
          const line = await iterator.next();
          if (line.done) throw new Error(`CLI exited before its next gate message: ${stderr}`);
          if (line.value.startsWith("ASIDE_SYNC_MESSAGE ")) {
            return JSON.parse(line.value.slice("ASIDE_SYNC_MESSAGE ".length)) as ChildMessage;
          }
        }
      })(), "CLI gate");
    },
    release() { child.stdin.end("refresh\n"); },
    async finish() {
      const code = await bounded(exited, "CLI exit");
      if (code !== 0) throw new Error(`CLI exited with ${code}: ${stderr}`);
    },
    async dispose() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      try { await bounded(exited, "CLI cleanup", 5_000); } finally { lines.close(); }
    },
  };
  children.push(cli);
  return cli;
}

function profilePath(id: number): string { return join(home, ".aside", "u", String(id), "models.json"); }
function profileFiles() {
  return [0, 1, 2].map(id => {
    const path = profilePath(id);
    const stat = lstatSync(path, { bigint: true });
    return { text: readFileSync(path, "utf8"), ino: stat.ino.toString(), mtime: stat.mtimeNs.toString() };
  });
}
function catalog(id: number): string[] {
  const doc = JSON.parse(readFileSync(profilePath(id), "utf8"));
  return (doc.providers?.opencodex?.models ?? []).map((model: { id: string }) => model.id)
    .filter((id: string) => id.startsWith("fixture/"));
}
function persist(value: OcxConfig = config): void {
  writeFileSync(join(configHome, "config.json"), JSON.stringify(value));
}
async function api(path: string, method = "GET", body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method, headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(5_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-aside-sync-owner-"));
  home = join(root, "home");
  configHome = join(root, "opencodex");
  mkdirSync(configHome, { recursive: true });
  priorConfigHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = configHome;
  isolation = installIsolatedCodexHome("ocx-aside-sync-owner-codex-");
  for (const id of [0, 1, 2]) {
    mkdirSync(join(home, ".aside", "u", String(id)), { recursive: true });
    writeFileSync(profilePath(id), JSON.stringify({ theme: "keep", providers: {} }));
  }
  writeFileSync(join(home, ".aside", "accounts.json"), JSON.stringify({
    currentAccountId: 0, accounts: [{ id: 0, name: "Cloud" }, { id: 1, name: "Local one" }, { id: 2, name: "Local two" }],
  }));
  config = {
    port: 10100, hostname: "127.0.0.1", defaultProvider: "fixture", fastRows: false,
    providers: { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", liveModels: false, models: ["one"] } },
  } as OcxConfig;
  // Match the child's default ownership-store location: a local fallback must
  // encounter real owned targets, rather than vacuously skip an empty store.
  const store = createIntegrationStateStore(join(configHome, "integrations"));
  const io = store.io();
  writes = [];
  syncRequests = [];
  mode = "live";
  setIntegrationPathTestHooks({ home, env: {} });
  setIntegrationMutationFlightTestHooks({ store, io: {
    ...io, writeText(path, text) {
      const id = [0, 1, 2].find(candidate => profilePath(candidate) === path);
      if (id !== undefined) writes.push(id);
      io.writeText(path, text);
    },
  } });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === SYNC_PATH) {
      syncRequests.push({ method: req.method, body: await req.clone().text() });
      if (mode === "missing-route") return Response.json({ error: "endpoint not found" }, { status: 404 });
      if (mode === "old-response") return Response.json({ ok: true });
    }
    return await handleManagementAPI(req, url, config, {
      saveConfigPreservingClaudeCode: persist, createManagementConvergeCodex: catalogConvergenceFactory(),
    }) ?? new Response("Not found", { status: 404 });
  } });
  config.port = server.port!;
  baseUrl = `http://127.0.0.1:${server.port}`;
  persist();
});

afterEach(async () => {
  try { await Promise.all(children.splice(0).map(child => child.dispose())); }
  finally {
    await server?.stop(true);
    server = undefined;
    setIntegrationMutationFlightTestHooks(null);
    setIntegrationPathTestHooks(null);
    isolation.restore();
    if (priorConfigHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = priorConfigHome;
    removeTreeWithRetry(root);
  }
});

async function enableAll(): Promise<void> {
  const response = await api("/api/client-integrations/aside/profiles", "PUT", { enabled: true });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true });
  for (const id of [0, 1, 2]) expect(catalog(id)).toEqual(["fixture/one"]);
}

test("a stale CLI process refreshes only the profiles still enabled by the live server", async () => {
  await enableAll();
  const cli = startCli();
  const ready = await cli.next();
  expect(ready).toMatchObject({ phase: "ready", staleEnabled: true });
  expect(ready.pid).not.toBe(process.pid);
  const disabled = await api("/api/client-integrations/aside/profiles/1", "PUT", { enabled: false });
  expect(disabled.status).toBe(200);
  expect(await disabled.json()).toMatchObject({ ok: true });
  expect(JSON.parse(readFileSync(join(configHome, "config.json"), "utf8")).asideProfileSync.profiles["1"]).toBe(false);
  expect(catalog(1)).toEqual([]);
  const disabledFile = profileFiles()[1];
  // Change only the server's catalog fixture: no selection endpoint may refresh
  // it before the released child reaches the production sync owner.
  config.providers.fixture!.models = ["two"];
  persist();
  writes.length = 0;
  cli.release();
  const result = await cli.next();
  await cli.finish();
  expect(result).toMatchObject({ phase: "refreshed", pid: ready.pid, staleEnabled: true });
  expect(result.results).toEqual([
    { client: "aside", profileId: 0, ok: true, changed: true },
    { client: "aside", profileId: 2, ok: true, changed: true },
  ]);
  expect(syncRequests).toEqual([{ method: "POST", body: "{}" }]);
  expect(writes).toEqual([0, 2]);
  for (const id of [0, 2]) expect(catalog(id)).toEqual(["fixture/two"]);
  expect(profileFiles()[1]).toEqual(disabledFile);
  expect(await (await api("/api/client-integrations/aside/profiles/1")).json())
    .toMatchObject({ profileId: 1, enabled: false, state: "absent" });
}, 45_000);

test.each(["missing-route", "old-response", "offline"] as const)(
  "CLI refuses %s without falling back to local profile writes", async failure => {
    await enableAll();
    const before = profileFiles();
    config.providers.fixture!.models = ["two"];
    persist();
    const configBefore = readFileSync(join(configHome, "config.json"), "utf8");
    if (failure === "offline") { await server!.stop(true); server = undefined; }
    else mode = failure;
    writes.length = 0;
    const cli = startCli();
    expect(await cli.next()).toMatchObject({ phase: "ready", staleEnabled: true });
    cli.release();
    expect(await cli.next()).toMatchObject({
      phase: "refused", name: "RuntimeApiError", status: failure === "offline" ? 503 : failure === "missing-route" ? 404 : 502,
    });
    await cli.finish();
    expect(profileFiles()).toEqual(before);
    expect(readFileSync(join(configHome, "config.json"), "utf8")).toBe(configBefore);
    expect(writes).toEqual([]);
    expect(syncRequests).toEqual(failure === "offline" ? [] : [{ method: "POST", body: "{}" }]);
  }, 45_000,
);
