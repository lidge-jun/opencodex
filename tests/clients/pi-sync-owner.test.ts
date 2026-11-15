import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClientConfig } from "../../src/clients/config-export";
import type { ExportModel, PiGeneratedConfig } from "../../src/clients/config-export/contracts";
import { PI_SYNC_ROUTE, refreshPiThroughServer } from "../../src/cli/pi-sync";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { handleManagementAPI } from "../../src/server/management-api";
import { PI_SYNC_PATH, setIntegrationMutationFlightTestHooks, setIntegrationPathTestHooks } from "../../src/server/management/integration-routes";
import { loadExportModels, resetExportSnapshotForTests } from "../../src/server/management/model-rows";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

/**
 * Pi may carry raw nested selectors, and only the serving proxy can prove one (#8172). These cases
 * pin that every Pi document is built inside that proxy: `ocx sync` asks the running proxy to
 * refresh Pi instead of rebuilding it from the CLI's own configuration, and the builder drops
 * native rows that Codex Direct would answer with 401.
 */

const piModels = (document: PiGeneratedConfig) => document.providers.opencodex!.models.map(model => model.id);

describe("Pi export in Codex Direct mode", () => {
  const models: ExportModel[] = [
    { namespaced: "gpt-5.6-luna", provider: "openai", id: "gpt-5.6-luna", native: true },
    { namespaced: "safe/model", provider: "safe", id: "model" },
  ];
  const config = (mode: "direct" | "pool") => ({
    port: 10100, hostname: "127.0.0.1", defaultProvider: "safe",
    providers: {
      openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", codexAccountMode: mode },
      safe: { adapter: "openai-chat", baseUrl: "https://safe.example/v1" },
    },
  }) as unknown as OcxConfig;
  const build = (mode: "direct" | "pool") => buildClientConfig("pi", { baseUrl: "http://127.0.0.1:10100/v1", models, config: config(mode) }) as PiGeneratedConfig;

  test("native rows are left out when the serving proxy runs Codex Direct", () => {
    expect(piModels(build("direct"))).toEqual(["safe/model"]);
  });

  test("native rows stay for a proxy that serves them with its own credentials", () => {
    expect(piModels(build("pool")).sort()).toEqual(["gpt-5.6-luna", "safe/model"]);
  });
});

describe("ocx sync refreshes Pi through the serving proxy", () => {
  // Only the ownership read matters to the CLI side; the server owns every write.
  const ownedStore = (owned: boolean): IntegrationStateStore => ({
    readRecords: () => (owned ? { pi: { clientId: "pi", configPath: "/fixture/models.json" } } : {}),
  }) as unknown as IntegrationStateStore;

  test("an unconnected Pi never reaches the server", async () => {
    let called = false;
    const outcomes = await refreshPiThroughServer({ store: ownedStore(false), request: (async () => { called = true; return {}; }) as never });
    expect(outcomes).toEqual([]);
    expect(called).toBe(false);
  });

  test("a connected Pi is refreshed by the running proxy, never locally", async () => {
    const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
    const outcomes = await refreshPiThroughServer({
      store: ownedStore(true),
      request: (async (path: string, init?: RequestInit) => {
        calls.push({ path, init });
        return { results: [{ client: "pi", ok: true, changed: true }, { client: "mcode", ok: true }] };
      }) as never,
    });
    expect(calls).toEqual([{ path: PI_SYNC_ROUTE, init: expect.objectContaining({ method: "POST", body: "{}" }) }]);
    expect(outcomes).toEqual([{ client: "pi", ok: true, changed: true }]);
  });

  test("a refused or unsupported server answer is a Pi outcome, with no local fallback", async () => {
    const failed = await refreshPiThroughServer({ store: ownedStore(true), request: (async () => { throw new Error("route missing"); }) as never });
    expect(failed).toEqual([{ client: "pi", ok: false, reason: "route missing" }]);
    const old = await refreshPiThroughServer({ store: ownedStore(true), request: (async () => ({ ok: true })) as never });
    expect(old[0]).toMatchObject({ client: "pi", ok: false });
  });

  test("the CLI's local refresh list no longer rebuilds Pi", () => {
    const source = readFileSync(repoPath("src", "cli", "sync-command.ts"), "utf8");
    const list = /refreshOwnedCatalogIntegrations\([\s\S]*?\}, \[([^\]]*)\]\)/.exec(source)?.[1] ?? "";
    expect(list).toContain('"mcode"');
    expect(list).not.toContain('"pi"');
    expect(source).toContain("refreshPiThroughServer");
    expect(PI_SYNC_ROUTE).toBe(PI_SYNC_PATH);
  });
});

describe("POST /api/client-integrations/pi/sync", () => {
  let root: string;
  let home: string;
  let store: IntegrationStateStore;
  let isolation: IsolatedCodexHome;
  let priorOcxHome: string | undefined;
  const env: NodeJS.ProcessEnv = {};
  let config: OcxConfig;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-pi-sync-route-"));
    home = join(root, "home");
    // Pi counts as installed when its agent directory exists.
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    priorOcxHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = join(root, "config");
    isolation = installIsolatedCodexHome("ocx-pi-sync-codex-");
    store = createIntegrationStateStore(join(root, "store"));
    config = { port: 10100, hostname: "127.0.0.1", defaultProvider: "fixture", fastRows: false, providers: {
      fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", liveModels: false, models: ["one", "two"], selectedModels: ["one"] },
    } } as OcxConfig;
    setIntegrationPathTestHooks({ home, env });
    setIntegrationMutationFlightTestHooks({ store });
    resetExportSnapshotForTests();
  });

  afterEach(() => {
    setIntegrationPathTestHooks(null);
    setIntegrationMutationFlightTestHooks(null);
    isolation.restore();
    if (priorOcxHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = priorOcxHome;
    removeTreeWithRetry(root);
  });

  async function api(pathname: string, method: string, body?: string) {
    const url = new URL(`http://127.0.0.1:10100${pathname}`);
    const response = await handleManagementAPI(new Request(url, {
      method, headers: { Host: url.host, "content-type": "application/json" }, ...(body === undefined ? {} : { body }),
    }), url, config, { createManagementConvergeCodex: catalogConvergenceFactory() });
    if (!response) throw new Error("route missing");
    return response;
  }
  const piFile = () => join(home, ".pi", "agent", "models.json");
  const writtenIds = () => (JSON.parse(readFileSync(piFile(), "utf8")) as PiGeneratedConfig).providers.opencodex!.models
    .map(model => model.id).filter(id => id.startsWith("fixture/"));

  test("an unconnected Pi is left alone", async () => {
    const response = await api(PI_SYNC_PATH, "POST", "{}");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, clientId: "pi", results: [] });
    expect(existsSync(piFile())).toBe(false);
  });

  test("only an empty object is accepted", async () => {
    const response = await api(PI_SYNC_PATH, "POST", JSON.stringify({ models: ["x"] }));
    expect(response.status).toBe(400);
  });

  test("a connected Pi is rebuilt from the serving proxy's own configuration", async () => {
    await loadExportModels(config, []);
    const enabled = await api("/api/client-integrations/pi", "PUT", JSON.stringify({ enabled: true }));
    if (enabled.status !== 200) throw new Error(await enabled.text());
    expect(writtenIds()).toEqual(["fixture/one"]);
    // The serving proxy's configuration moves on; the refresh must follow it, not a CLI snapshot.
    config.providers.fixture!.selectedModels = ["one", "two"];
    resetExportSnapshotForTests();
    const response = await api(PI_SYNC_PATH, "POST", "{}");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, clientId: "pi", results: [{ client: "pi", ok: true, changed: true }] });
    expect(writtenIds().sort()).toEqual(["fixture/one", "fixture/two"]);
  });
});

