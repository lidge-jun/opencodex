import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExportModel } from "../src/clients/config-export";
import { fileIO, type IntegrationIO } from "../src/integrations/config-io";
import { INTEGRATION_CLIENTS, INTEGRATION_CLIENT_IDS } from "../src/integrations/registry";
import { readIntegrationState } from "../src/integrations/state";
import { createIntegrationStateStore, type IntegrationStateStore } from "../src/integrations/store";
import { applyIntegration } from "../src/integrations/writer";
import type { IntegrationWriterLockSeams } from "../src/integrations/writer-lock";
import { handleManagementAPI } from "../src/server/management-api";
import {
  setIntegrationMutationFlightTestHooks,
  setIntegrationPathTestHooks,
} from "../src/server/management/integration-routes";
import type { OcxConfig } from "../src/types";
import { catalogConvergenceFactory } from "./helpers/catalog-convergence";

/**
 * Route contract for devlog/_fin/260802_client_toggle_api/040 §6-§7.
 *
 * Every refusal here is produced by the real writer against a real temp HOME
 * and a real temp store. A status-only fake would let a branch that never
 * runs look covered, which is the one thing this suite exists to prevent.
 */
let base = "";
let home = "";
let storeRoot = "";
let store: IntegrationStateStore;

/**
 * The CSRF wire test fetches the real served page, which only exists when the
 * GUI build does. CI runs `bun test` BEFORE `GUI build`, so the artifact is
 * absent on a fresh checkout — build it once here instead of letting the page
 * fall back to the JSON root payload (which silently voids the wire test).
 */
{
  if (!existsSync(join(import.meta.dir, "..", "gui", "dist", "index.html"))) {
    const build = Bun.spawnSync({
      cmd: ["bun", "run", "build:gui"],
      cwd: join(import.meta.dir, ".."),
      stdout: "inherit",
      stderr: "inherit",
    });
    if (build.exitCode !== 0) throw new Error("gui build failed for the wire-level CSRF suite");
  }
}

/**
 * The environment the ROUTE resolves paths with — never `process.env`.
 *
 * Bun's `os.homedir()` ignores a mid-process `HOME` assignment, so rewriting
 * the variable is not isolation; only passing `home` explicitly is. An earlier
 * draft of this suite learned that by creating a real `~/.hermes/config.yaml`.
 */
const routeEnv = {} as NodeJS.ProcessEnv;

/**
 * A key shaped exactly like a real one, assembled at runtime so the privacy
 * scanner sees no literal secret while the running config still holds a
 * serializable one — without that, "no key leaked" asserts nothing.
 */
const REAL_LOOKING_KEY = ["ocx", "live", "9f3c7a2b41d84e6fa05c8e17b3d92764"].join("_");

const MODELS_FIXTURE: ExportModel[] = [
  { namespaced: "a/m1", provider: "a", id: "m1", contextWindow: 128_000 },
];

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "a",
    apiKeys: [{ id: "key-1", name: "default", key: REAL_LOOKING_KEY, createdAt: new Date(0).toISOString() }],
    providers: {
      a: {
        adapter: "openai-chat",
        baseUrl: "https://a.example/v1",
        apiKey: REAL_LOOKING_KEY,
        liveModels: false,
        models: ["m1"],
        modelContextWindows: { m1: 128_000 },
        modelReasoningEfforts: { m1: ["minimal", "low", "high"] },
      },
    },
  } as unknown as OcxConfig;
}

let config: OcxConfig;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ocx-management-integrations-"));
  home = join(base, "home");
  storeRoot = join(base, "store", "integrations");
  mkdirSync(home, { recursive: true });
  store = createIntegrationStateStore(storeRoot);
  config = baseConfig();
  setIntegrationMutationFlightTestHooks({ store });
  setIntegrationPathTestHooks({ env: routeEnv, home });
});

afterEach(() => {
  setIntegrationMutationFlightTestHooks(null);
  setIntegrationPathTestHooks(null);
  rmSync(base, { recursive: true, force: true });
});

/** Hermes: installed by creating its home directory; YAML on disk. */
function installHermes(): string {
  const spec = INTEGRATION_CLIENTS.hermes;
  const dir = spec.detectDir(routeEnv, home);
  mkdirSync(dir, { recursive: true });
  return spec.configPath(routeEnv, home);
}

function installOmp(): string {
  const spec = INTEGRATION_CLIENTS.omp;
  const dir = spec.detectDir(routeEnv, home);
  mkdirSync(dir, { recursive: true });
  return spec.configPath(routeEnv, home);
}

function installDsh(): string {
  const spec = INTEGRATION_CLIENTS.dsh;
  mkdirSync(spec.detectDir(routeEnv, home), { recursive: true });
  return spec.configPath(routeEnv, home);
}

function installMcode(): string {
  const spec = INTEGRATION_CLIENTS.mcode;
  mkdirSync(spec.detectDir(routeEnv, home), { recursive: true });
  return spec.configPath(routeEnv, home);
}

function hermesConfigPath(): string {
  return INTEGRATION_CLIENTS.hermes.configPath(routeEnv, home);
}

async function rawApi(path: string, init: RequestInit = {}): Promise<Response | null> {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  return handleManagementAPI(
    new Request(url, { ...init, headers: { Host: url.host, ...(init.headers ?? {}) } }),
    url,
    config,
    { saveConfigPreservingClaudeCode: () => {}, createManagementConvergeCodex: catalogConvergenceFactory() },
  );
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await rawApi(path, init);
  expect(response).not.toBeNull();
  return response!;
}

function put(clientId: string, enabled: boolean): Promise<Response> {
  return api(`/api/client-integrations/${clientId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

/** A toggle that also waives the conflict refusal. */
function putOverwrite(clientId: string, body: Record<string, unknown>): Promise<Response> {
  return api(`/api/client-integrations/${clientId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function restore(body: unknown): Promise<Response> {
  return api("/api/client-integrations/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface JournalRow {
  opId: string;
  clientId: string;
  kind: string;
  at: string;
  configPath: string;
  snapshot: "none" | "stored" | "expired";
  undoable: boolean;
}

async function journal(query = ""): Promise<JournalRow[]> {
  const response = await api(`/api/client-integrations/journal${query}`);
  expect(response.status).toBe(200);
  return (await response.json() as { operations: JournalRow[] }).operations;
}

const INVALID_CLIENT_BODY = {
  error: "invalid integration client",
  code: "invalid_integration_client",
  validClients: [...INTEGRATION_CLIENT_IDS],
};

/** Let every pending microtask/IO turn run before observing shared state. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** Every file under a root with its exact bytes — the byte-identity witness. */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else out[rel] = readFileSync(abs, "utf8");
    }
  };
  walk(root, "");
  return out;
}

/** Same, but an absent root is a fact to preserve rather than an error. */
function snapshotTreeIfPresent(root: string): Record<string, string> | null {
  return existsSync(root) ? snapshotTree(root) : null;
}

describe("GET /api/client-integrations", () => {
  test("lists all registry clients in registry order", async () => {
    installHermes();
    const response = await api("/api/client-integrations");
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as { clients: { clientId: string; configPath: string }[] };

    expect(body.clients.map(c => c.clientId)).toEqual([...INTEGRATION_CLIENT_IDS]);
    for (const client of body.clients) {
      expect(client.configPath.startsWith(home)).toBe(true);
    }
    // The route must read through the SAME store the caller bound, or a test
    // that isolates writes still reads the developer's real snapshots.
    const models = await exportModels();
    expect(body.clients).toEqual(INTEGRATION_CLIENT_IDS.map(clientId =>
      JSON.parse(JSON.stringify(readIntegrationState({
        clientId, models, config, port: 10100, store, env: routeEnv, home,
      })))));
    expect(text).not.toContain(REAL_LOOKING_KEY);
  });

  test("returns one five-state record for a single client", async () => {
    installHermes();
    expect((await put("hermes", true)).status).toBe(200);
    const before = store.listOperations().length;

    const response = await api("/api/client-integrations/hermes");
    expect(response.status).toBe(200);
    const body = await response.json() as { clientId: string; state: string; configPath: string; installed: boolean };
    expect(body.clientId).toBe("hermes");
    expect(body.state).toBe("current");
    expect(body.installed).toBe(true);
    expect(body.configPath).toBe(hermesConfigPath());
    // A read is a read: it appends nothing.
    expect(store.listOperations()).toHaveLength(before);
  });
});

/** The models the route itself derives, so expectations cannot drift from it. */
async function exportModels(): Promise<ExportModel[]> {
  const { loadExportModels } = await import("../src/server/management/model-rows");
  return loadExportModels(config);
}

describe("client validation", () => {
  test("unknown path and journal clients return the exact 400 registry envelope", async () => {
    const path = await api("/api/client-integrations/zed");
    expect(path.status).toBe(400);
    expect(await path.json()).toEqual(INVALID_CLIENT_BODY);

    const filter = await api("/api/client-integrations/journal?client=zed");
    expect(filter.status).toBe(400);
    expect(await filter.json()).toEqual(INVALID_CLIENT_BODY);

    expect(store.listOperations()).toHaveLength(0);
  });

  test("unsupported methods and deeper paths are declined by the module", async () => {
    /*
     * The module returns `null`, which is the whole contract: the unknown-route
     * envelope stays the outer server's to own. `handleManagementAPI` itself
     * has no 404 for a plain GET, so asserting a status here would be
     * asserting someone else's behavior.
     */
    const deeper = await rawApi("/api/client-integrations/hermes/extra");
    expect(deeper).toBeNull();
    const method = await rawApi("/api/client-integrations/hermes", { method: "DELETE" });
    expect(method).toBeNull();
    const journalPost = await rawApi("/api/client-integrations/journal", { method: "POST" });
    expect(journalPost).toBeNull();
  });
});

describe("PUT /api/client-integrations/:clientId", () => {
  test("applies and disables through the writer", async () => {
    const configPath = installHermes();

    const applied = await put("hermes", true);
    expect(applied.status).toBe(200);
    const applyBody = await applied.json() as { ok: boolean; changed: boolean; state: string; opId?: string };
    expect(applyBody.ok).toBe(true);
    expect(applyBody.changed).toBe(true);
    expect(typeof applyBody.opId).toBe("string");
    expect(readFileSync(configPath, "utf8")).toContain("opencodex");
    expect((await (await api("/api/client-integrations/hermes")).json() as { state: string }).state).toBe("current");

    const disabled = await put("hermes", false);
    expect(disabled.status).toBe(200);
    const disableBody = await disabled.json() as { ok: boolean; changed: boolean };
    expect(disableBody.ok).toBe(true);
    expect(disableBody.changed).toBe(true);
    expect(readFileSync(configPath, "utf8")).not.toContain("opencodex");

    // Two immutable rows: the journal records history, it does not fold it.
    expect(store.listOperations("hermes").map(row => row.kind)).toEqual(["disable", "apply"]);
  });

  test("a client that is not installed is refused without writing", async () => {
    const response = await put("hermes", true);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "integration_mutation_failed",
      clientId: "hermes",
      reason: "not_installed",
    });
    expect(existsSync(hermesConfigPath())).toBe(false);
    expect(store.listOperations()).toHaveLength(0);
  });

  test("MCode apply and stale refresh write context and reasoning capabilities", async () => {
    const configPath = installMcode();
    expect((await put("mcode", true)).status).toBe(200);

    const applied = Bun.YAML.parse(readFileSync(configPath, "utf8")) as {
      custom_provider: { opencodex: { models: Record<string, unknown> } };
    };
    expect(applied.custom_provider.opencodex.models["a/m1"]).toEqual({
      limit: { context: 128_000 },
      thinking: { effortOptions: ["minimal", "low", "high"] },
    });

    config.providers.a!.modelContextWindows = { m1: 256_000 };
    config.providers.a!.modelReasoningEfforts = { m1: ["low", "medium", "max"] };
    const refreshed = await put("mcode", true);
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json() as { changed: boolean }).changed).toBe(true);

    const afterRefresh = Bun.YAML.parse(readFileSync(configPath, "utf8")) as {
      custom_provider: { opencodex: { models: Record<string, unknown> } };
    };
    expect(afterRefresh.custom_provider.opencodex.models["a/m1"]).toEqual({
      limit: { context: 256_000 },
      thinking: { effortOptions: ["low", "medium", "max"] },
    });
    expect(store.listOperations("mcode").map(row => row.kind)).toEqual(["refresh", "apply"]);
  });
});

describe("single-flight", () => {
  test("duplicate apply joins for 120 seconds and an older flight returns busy 409", async () => {
    installHermes();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let clock = 1_000_000;
    const io: IntegrationIO = { ...fileIO(), now: () => clock, ...bookkeeping() };
    setIntegrationMutationFlightTestHooks({
      store,
      io,
      run: async operation => { runs += 1; await gate; return operation(); },
    });

    try {
      const first = put("hermes", true);
      const joined = put("hermes", true);
      // The route awaits its model load before reaching the flight map, so the
      // count is only meaningful after both requests have had a turn.
      await settle();
      expect(runs).toBe(1);

      clock += 121_000;
      const busy = await put("hermes", true);
      expect(busy.status).toBe(409);
      expect(await busy.json()).toEqual({
        error: "integration mutation busy",
        code: "integration_mutation_busy",
        clientId: "hermes",
      });
      expect(runs).toBe(1);

      release();
      expect((await first).status).toBe(200);
      expect((await joined).status).toBe(200);
    } finally {
      release();
    }
  });

  test("a flight older than ten minutes is replaced without stale cleanup winning", async () => {
    installHermes();
    let runs = 0;
    const releases: (() => void)[] = [];
    /** One gate per run, so both flights can be in the air at once. */
    const gateFor = (): Promise<void> => new Promise<void>(resolve => releases.push(resolve));
    let clock = 2_000_000;
    setIntegrationMutationFlightTestHooks({
      store,
      io: { ...fileIO(), now: () => clock, ...bookkeeping() },
      run: async operation => {
        runs += 1;
        await gateFor();
        return operation();
      },
    });

    try {
      const stale = put("hermes", true);
      await settle();
      expect(runs).toBe(1);

      clock += 11 * 60_000;
      const replacement = put("hermes", true);
      await settle();
      expect(runs).toBe(2);

      /*
       * The replacement is STILL IN THE AIR when the stale flight finishes.
       * That is the whole point: its `finally` runs against a map entry that
       * is no longer its own, and an unguarded `delete` would evict the live
       * replacement. Awaiting the replacement first, as an earlier draft did,
       * removed the very race the identity check exists for.
       */
      releases[0]!();
      expect((await stale).status).toBe(200);
      await settle();

      // The replacement still owns the client, so an identical request joins
      // it rather than starting a third run.
      const joined = put("hermes", true);
      await settle();
      expect(runs).toBe(2);

      releases[1]!();
      expect((await replacement).status).toBe(200);
      expect((await joined).status).toBe(200);
      expect(runs).toBe(2);
    } finally {
      for (const release of releases) release();
    }
  });
});

describe("cross-process integration writer lock mapping", () => {
  test("an unresolvable DSH path stays a typed unsafe refusal before lock acquisition", async () => {
    setIntegrationPathTestHooks({ env: { DSH_HOME: "relative/dsh-home" }, home });

    const response = await put("dsh", true);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "integration_unsafe",
      clientId: "dsh",
      reason: "unsafe",
      state: "unsafe",
    });
    expect(store.listOperations()).toHaveLength(0);
  });

  test("DSH lock timeout maps to the existing busy 409 without a real wait", async () => {
    const configPath = installDsh();
    let now = 0;
    const lockSeams: IntegrationWriterLockSeams = {
      writeFile: async () => { throw Object.assign(new Error("contended"), { code: "EEXIST" }); },
      removeFile: async () => { throw new Error("must not remove contender"); },
      now: () => now,
      delay: async ms => { now += ms; },
      pid: 11,
    };
    setIntegrationMutationFlightTestHooks({ store, lockSeams });
    const response = await put("dsh", true);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "integration mutation busy",
      code: "integration_mutation_busy",
      clientId: "dsh",
    });
    expect(now).toBe(2_000);
    expect(existsSync(configPath)).toBe(false);
  });

  test("non-contention lock IO maps to integration_internal_error", async () => {
    const configPath = installDsh();
    const lockSeams: IntegrationWriterLockSeams = {
      writeFile: async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
      removeFile: async () => {},
      now: () => 0,
      delay: async () => {},
      pid: 12,
    };
    setIntegrationMutationFlightTestHooks({ store, lockSeams });
    const response = await put("dsh", true);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "integration_internal_error" });
    expect(existsSync(configPath)).toBe(false);
  });
});

/** Bookkeeping seams bound to the temp store, as `store.io()` does. */
function bookkeeping(): Pick<IntegrationIO, "appendJournal" | "putRecord" | "dropRecord"> {
  return {
    appendJournal: entry => store.appendJournal(entry),
    putRecord: record => store.putRecord(record),
    dropRecord: clientId => store.dropRecord(clientId),
  };
}

describe("refusals", () => {
  test("invalid OMP alias removal returns unsafe without changing bytes or journal", async () => {
    const configPath = installOmp();
    expect((await put("omp", true)).status).toBe(200);
    const edited = readFileSync(configPath, "utf8")
      .replace("    baseUrl:", "    baseUrl: &opencodex_url")
      .concat("settings:\n  inheritedBase: *opencodex_url\n");
    expect(edited).toContain("    baseUrl: &opencodex_url");
    writeFileSync(configPath, edited);
    const journalBefore = store.listOperations("omp");

    const response = await put("omp", false);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "integration config is unsafe",
      code: "integration_unsafe",
      clientId: "omp",
      state: "unsafe",
      reason: "unsafe",
    });
    expect(readFileSync(configPath, "utf8")).toBe(edited);
    expect(store.listOperations("omp")).toEqual(journalBefore);
  });

  test("conflict rejects disable without changing a managed-field edit", async () => {
    const configPath = installHermes();
    expect((await put("hermes", true)).status).toBe(200);
    const edited = readFileSync(configPath, "utf8").replace(
      "api_mode: chat_completions",
      "api_mode: user_edited",
    );
    writeFileSync(configPath, edited);
    const journalBefore = store.listOperations().length;

    const response = await put("hermes", false);
    expect(response.status).toBe(409);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      error: "integration config conflicts with ownership record",
      code: "integration_conflict",
      clientId: "hermes",
      state: "conflict",
      reason: "conflict",
    });
    // The writer's message names the file and what happened to it. Without
    // asserting it, a refusal could arrive stripped of the one field that
    // tells the user which config to look at.
    expect(body.message).toBe(
      `${configPath} changed after opencodex wrote it; disabling would discard that edit`,
    );
    expect(readFileSync(configPath, "utf8")).toBe(edited);
    expect(store.listOperations()).toHaveLength(journalBefore);
  });

  test("the same conflict is resolvable when the caller waives it by name", async () => {
    const configPath = installHermes();
    expect((await put("hermes", true)).status).toBe(200);
    const edited = readFileSync(configPath, "utf8").replace(
      "api_mode: chat_completions",
      "api_mode: user_edited",
    );
    writeFileSync(configPath, edited);

    // The plain enable is still refused: that is what makes the flag the only door.
    expect((await put("hermes", true)).status).toBe(409);
    expect(readFileSync(configPath, "utf8")).toBe(edited);

    const forced = await putOverwrite("hermes", { enabled: true, overwriteConflict: true });
    expect(forced.status).toBe(200);
    expect(await forced.json()).toMatchObject({ ok: true, clientId: "hermes", state: "current" });
    expect(readFileSync(configPath, "utf8")).not.toContain("api_mode: user_edited");

    // Journaled under its own kind, so the rollback list does not call this an apply.
    const operations = store.listOperations("hermes");
    expect(operations[0]!.kind).toBe("overwrite");
  });

  test("an explicit false waiver is exactly a plain apply, and still refuses", async () => {
    const configPath = installHermes();
    expect((await put("hermes", true)).status).toBe(200);
    const edited = readFileSync(configPath, "utf8").replace(
      "api_mode: chat_completions",
      "api_mode: user_edited",
    );
    writeFileSync(configPath, edited);

    const response = await putOverwrite("hermes", { enabled: true, overwriteConflict: false });
    expect(response.status).toBe(409);
    expect(readFileSync(configPath, "utf8")).toBe(edited);
  });

  test("a non-boolean waiver is rejected, and disable can never carry one", async () => {
    installHermes();
    const nonBoolean = await putOverwrite("hermes", { enabled: true, overwriteConflict: "yes" });
    expect(nonBoolean.status).toBe(400);
    expect(await nonBoolean.json()).toEqual({
      error: "overwriteConflict must be a boolean",
      code: "invalid_overwrite_conflict",
    });

    /*
     * Rejected rather than ignored. Forcing a DISABLE over a conflict is the
     * deletion of unowned work this whole subsystem exists to prevent, so a
     * caller sending the combination has misunderstood the field; answering 200
     * would confirm an intent we refused.
     */
    const forcedDisable = await putOverwrite("hermes", { enabled: false, overwriteConflict: true });
    expect(forcedDisable.status).toBe(400);
    expect(await forcedDisable.json()).toEqual({
      error: "overwriteConflict applies only to enabling an integration",
      code: "invalid_overwrite_conflict",
    });

    expect(store.listOperations()).toHaveLength(0);
  });

  test("a write failure in a non-failure state keeps its own envelope", async () => {
    /*
     * The defect this activates: routing on `state` instead of `reason`.
     *
     * The journal append fails AFTER the file was written, so the writer
     * compensates and returns `write_failed` while the file's own state is
     * `current`. A state-first mapping would answer `integration_conflict`
     * or a 200-shaped success and drop the message, snapshot path and
     * residual flag — the only things that tell the user what to recover.
     */
    installHermes();
    setIntegrationMutationFlightTestHooks({
      store,
      io: {
        ...fileIO(),
        ...bookkeeping(),
        appendJournal: () => { throw new Error("journal volume is full"); },
      },
    });

    const response = await put("hermes", true);
    expect(response.status).toBe(500);
    const body = await response.json() as Record<string, unknown>;
    expect(body.code).toBe("integration_mutation_failed");
    expect(body.reason).toBe("write_failed");
    // The state is NOT a failure state — that is the point.
    expect(body.state).toBe("current");
    expect(typeof body.message).toBe("string");
    expect(body.message as string).toContain("journal");
    // Compensation succeeded, so the file is back and nothing is residual.
    expect(existsSync(hermesConfigPath())).toBe(false);
    expect(body.residual).toBeUndefined();
  });

  test("a failed compensation is disclosed as residual with its snapshot path", async () => {
    const configPath = installHermes();
    writeFileSync(configPath, "providers:\n  other:\n    api: http://elsewhere\n");
    let configWrites = 0;
    setIntegrationMutationFlightTestHooks({
      store,
      io: {
        ...fileIO(),
        ...bookkeeping(),
        appendJournal: () => { throw new Error("journal volume is full"); },
        // Rolling the file back fails too: the file is left intermediate and
        // the response has to say so rather than claim a clean rollback. The
        // rollback is the SECOND write to this path, so count rather than
        // inspect the bytes.
        writeText: (path, text) => {
          if (path === configPath) {
            configWrites += 1;
            if (configWrites > 1) throw new Error("read-only volume");
          }
          writeFileSync(path, text);
        },
      },
    });

    const response = await put("hermes", true);
    expect(response.status).toBe(500);
    const body = await response.json() as Record<string, unknown>;
    expect(body.code).toBe("integration_mutation_failed");
    expect(body.reason).toBe("write_failed");
    expect(body.residual).toBe(true);
    expect(typeof body.snapshotPath).toBe("string");
    expect((body.snapshotPath as string).startsWith(storeRoot)).toBe(true);
  });

  test("unsafe state is readable but toggle mutation is rejected", async () => {
    const configPath = installHermes();
    // A directory where a config file belongs: readable as state, never writable.
    mkdirSync(configPath, { recursive: true });

    const read = await api("/api/client-integrations/hermes");
    expect(read.status).toBe(200);
    expect((await read.json() as { state: string }).state).toBe("unsafe");

    const response = await put("hermes", true);
    expect(response.status).toBe(409);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      error: "integration config is unsafe",
      code: "integration_unsafe",
      clientId: "hermes",
      state: "unsafe",
      reason: "unsafe",
    });
    expect(body.message).toBe(`${configPath} is not a regular file`);
    expect(existsSync(configPath)).toBe(true);
    expect(store.listOperations()).toHaveLength(0);
  });
});

describe("POST /api/client-integrations/restore", () => {
  test("requires explicit drift confirmation and preserves current bytes before overwrite", async () => {
    const configPath = installHermes();
    writeFileSync(configPath, "providers:\n  other:\n    api: http://elsewhere\n");
    const original = readFileSync(configPath, "utf8");
    expect((await put("hermes", true)).status).toBe(200);
    const opId = store.listOperations("hermes")[0]!.opId;

    const drifted = `${readFileSync(configPath, "utf8")}# drifted\n`;
    writeFileSync(configPath, drifted);
    const journalBefore = store.listOperations().length;

    const refused = await restore({ opId });
    expect(refused.status).toBe(409);
    const refusedBody = await refused.json() as Record<string, unknown>;
    expect(refusedBody).toMatchObject({
      error: "restore requires drift confirmation",
      code: "integration_drift_confirmation_required",
      clientId: "hermes",
      reason: "drift_requires_confirm",
    });
    /*
     * The writer's own `message` is asserted, not just the envelope around it.
     * Drift was special-cased once and the hand-written branch dropped it —
     * and `message` is the only field that says WHICH file drifted and where
     * its backup went. A partial match on error/code/clientId/reason stays
     * green through exactly that regression.
     */
    expect(refusedBody.message).toBe(
      "this file changed after that operation; confirm to replace it (the current version is backed up first)",
    );
    expect(readFileSync(configPath, "utf8")).toBe(drifted);
    expect(store.listOperations()).toHaveLength(journalBefore);

    const confirmed = await restore({ opId, confirmDrift: true });
    expect(confirmed.status).toBe(200);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    const rows = store.listOperations("hermes");
    expect(rows[0]!.kind).toBe("restore");
    // The restore is itself undoable: the drifted bytes it replaced are kept.
    const snapshot = store.readSnapshot(rows[0]!);
    expect(snapshot.kind).toBe("stored");
    if (snapshot.kind === "stored") expect(snapshot.text).toBe(drifted);
  });

  test("restore of a none snapshot deletes the file created by apply", async () => {
    const configPath = installHermes();
    expect(existsSync(configPath)).toBe(false);
    expect((await put("hermes", true)).status).toBe(200);

    const rows = await journal("?client=hermes");
    expect(rows[0]!.snapshot).toBe("none");
    expect(rows[0]!.undoable).toBe(true);

    const response = await restore({ opId: rows[0]!.opId });
    expect(response.status).toBe(200);
    expect(existsSync(configPath)).toBe(false);
    expect(store.listOperations("hermes")[0]!.kind).toBe("restore");
    expect((await (await api("/api/client-integrations/hermes")).json() as { state: string }).state).toBe("absent");
  });

  test("distinguishes an unknown operation from an expired snapshot", async () => {
    const configPath = installHermes();
    writeFileSync(configPath, "providers:\n  other:\n    api: http://elsewhere\n");

    const unknown = await restore({ opId: "op-does-not-exist" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: "integration operation not found",
      code: "integration_operation_not_found",
      opId: "op-does-not-exist",
    });

    /*
     * More than ten STORED snapshots for one client: retention keeps the
     * newest ten files, so the oldest tag resolves to `expired` while its
     * history row survives. Apply-from-absent snapshots as `none`, which is
     * never collected, so the loop toggles against an existing file.
     */
    let oldestStored = "";
    for (let i = 0; i < 12; i += 1) {
      const response = await put("hermes", i % 2 === 0);
      expect(response.status).toBe(200);
      const newest = (await journal("?client=hermes"))[0]!;
      if (!oldestStored && newest.snapshot === "stored") oldestStored = newest.opId;
    }
    const rows = await journal("?client=hermes");
    expect(rows.length).toBeGreaterThanOrEqual(12);
    const oldest = rows.find(row => row.opId === oldestStored)!;
    expect(oldest.snapshot).toBe("expired");
    // Retention kept exactly the newest ten files; the rows all survive.
    expect(store.countSnapshots("hermes")).toBe(10);
    expect(rows.filter(row => row.snapshot === "stored")).toHaveLength(10);

    const before = readFileSync(configPath, "utf8");
    const journalBefore = store.listOperations().length;
    const expired = await restore({ opId: oldest.opId });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({
      error: "integration snapshot expired",
      code: "integration_snapshot_expired",
      opId: oldest.opId,
    });
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(store.listOperations()).toHaveLength(journalBefore);
  });
});

describe("GET /api/client-integrations/journal", () => {
  test("derives snapshot tags and undoable per request", async () => {
    const configPath = installHermes();
    expect((await put("hermes", true)).status).toBe(200);
    expect((await put("hermes", false)).status).toBe(200);

    const rows = await journal();
    expect(rows.map(row => row.kind)).toEqual(["disable", "apply"]);
    expect(rows[0]!.snapshot).toBe("stored");
    expect(rows[0]!.undoable).toBe(true);
    // Only the newest row is offered as undo; an older one would rewind past
    // a change the user has not been shown.
    expect(rows[1]!.undoable).toBe(false);

    const filtered = await journal("?client=hermes");
    expect(filtered.map(row => row.opId)).toEqual(rows.map(row => row.opId));

    // A foreign edit revokes undo without touching the stored snapshot tag.
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}# foreign\n`);
    const afterEdit = await journal();
    expect(afterEdit[0]!.undoable).toBe(false);
    expect(afterEdit[0]!.snapshot).toBe("stored");

    /*
     * The row shape is asserted EXACTLY, not by absence of three strings. A
     * checklist of forbidden names cannot catch a field nobody thought to
     * forbid; an exact key set catches every one of them.
     */
    const text = await (await api("/api/client-integrations/journal")).text();
    for (const row of JSON.parse(text).operations as Record<string, unknown>[]) {
      expect(Object.keys(row).sort()).toEqual([
        "at", "clientId", "configPath", "kind", "opId", "snapshot", "undoable",
      ]);
    }
    // The snapshots on disk really do hold the serializable secret, so "no key
    // in the response" is a claim about the serializer rather than about an
    // empty fixture.
    const stored = store.readSnapshot(store.listOperations("hermes")[0]!);
    expect(stored.kind).toBe("stored");
    expect(text).not.toContain(REAL_LOOKING_KEY);
  });

  /**
   * The two fields must agree. Retention deletes snapshot BYTES and leaves the
   * row's persisted tag saying `stored`, so a newest row whose config still
   * matches would report `expired` honestly and then offer undo anyway — the
   * GUI draws the button, restore answers 410.
   */
  test("a newest row whose snapshot bytes are gone is not undoable", async () => {
    const configPath = installHermes();
    // A snapshot only exists when there were bytes to capture, so the file has
    // to pre-date the apply. A first apply to an absent path records `none`.
    writeFileSync(configPath, "providers:\n  mine:\n    api: http://keep\n");
    expect((await put("hermes", true)).status).toBe(200);

    const before = await journal();
    expect(before[0]!.snapshot).toBe("stored");
    expect(before[0]!.undoable).toBe(true);

    // Delete the snapshot file itself, leaving the journal row and the config
    // exactly as they were: the row still says `stored`, and the live config
    // still matches `resultFingerprint`, so nothing but the bytes changed.
    const operation = store.listOperations("hermes")[0]!;
    const resolved = store.readSnapshot(operation);
    expect(resolved.kind).toBe("stored");
    if (resolved.kind === "stored") rmSync(resolved.path, { force: true });

    const after = await journal();
    expect(after[0]!.opId).toBe(operation.opId);
    expect(after[0]!.snapshot).toBe("expired");
    expect(after[0]!.undoable).toBe(false);

    // And the route the button would have called agrees, which is the whole
    // point of deriving both from one resolution.
    expect((await restore({ opId: operation.opId })).status).toBe(410);
  });
});

describe("request bodies", () => {
  test("reject malformed JSON and invalid fields with exact envelopes", async () => {
    installHermes();
    const malformed = await api("/api/client-integrations/hermes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid JSON body", code: "invalid_json_body" });

    const nonBoolean = await api("/api/client-integrations/hermes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(nonBoolean.status).toBe(400);
    expect(await nonBoolean.json()).toEqual({ error: "enabled must be a boolean", code: "invalid_enabled" });

    const blankOpId = await restore({ opId: "   " });
    expect(blankOpId.status).toBe(400);
    expect(await blankOpId.json()).toEqual({ error: "opId must be a non-empty string", code: "invalid_op_id" });

    const badConfirm = await restore({ opId: "op-1", confirmDrift: "yes" });
    expect(badConfirm.status).toBe(400);
    expect(await badConfirm.json()).toEqual({ error: "confirmDrift must be a boolean", code: "invalid_confirm_drift" });

    expect(store.listOperations()).toHaveLength(0);
  });

  test("a decompressed body over the bounded reader limit becomes the outer 413", async () => {
    installHermes();
    const oversized = JSON.stringify({ enabled: true, pad: "x".repeat(5 * 1024 * 1024) });
    const response = await api("/api/client-integrations/hermes", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
      body: Bun.gzipSync(new TextEncoder().encode(oversized)),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body too large" });
    expect(store.listOperations()).toHaveLength(0);
  });
});

describe("admission", () => {
  test("the real server admits before it dispatches an integration mutation", async () => {
    /*
     * Calling `requireManagementAuth` by hand and then declining to dispatch
     * proves only that the helper works. The claim worth testing is ORDERING:
     * that `src/server/index.ts` runs admission BEFORE `handleManagementAPI`.
     * Only a real listener can show that, so this one starts one and lets an
     * unauthenticated mutation try to reach the route.
     */
    const previousOpencodexHome = process.env.OPENCODEX_HOME;
    const previousAdmin = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    const serverHome = join(base, "server-home");
    mkdirSync(serverHome, { recursive: true });
    process.env.OPENCODEX_HOME = serverHome;
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ["admission", "secret", "fixture"].join("-");
    installHermes();

    const { saveConfig } = await import("../src/config");
    const { startServer } = await import("../src/server");
    saveConfig(config);
    const server = startServer(0);
    try {
      const target = new URL("/api/client-integrations/hermes", server.url);
      const unauthenticated = await fetch(target, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(unauthenticated.status).toBe(401);
      expect(await unauthenticated.json()).toEqual({ error: "opencodex admin token required" });
      // Admission ran first, so the route never wrote and never journaled.
      expect(existsSync(hermesConfigPath())).toBe(false);
      expect(store.listOperations()).toHaveLength(0);

      // The control: the same request WITH the admin token reaches the route.
      const authenticated = await fetch(target, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-opencodex-api-key": process.env.OPENCODEX_ADMIN_AUTH_TOKEN ?? "",
        },
        body: JSON.stringify({ enabled: true }),
      });
      expect(authenticated.status).toBe(200);
      expect(store.listOperations("hermes")).toHaveLength(1);

      // An authenticated but cross-origin read keeps the management envelope.
      const crossOrigin = await fetch(new URL("/api/client-integrations", server.url), {
        headers: {
          Origin: "http://attacker.test",
          "x-opencodex-api-key": process.env.OPENCODEX_ADMIN_AUTH_TOKEN ?? "",
        },
      });
      expect(crossOrigin.status).toBe(403);
      expect(await crossOrigin.json()).toEqual({ error: "cross-origin request blocked" });
    } finally {
      await server.stop(true);
      if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOpencodexHome;
      if (previousAdmin === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
      else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdmin;
    }
  });

  test("a whole transaction stays inside the bound store", async () => {
    /*
     * The sharpest isolation claim in this work package: apply, disable,
     * restore and the collection read all have to land in the temp root. A
     * SECOND store is seeded and compared byte-for-byte, and — the part that
     * actually matters — the DEFAULT store the route would fall back to is
     * inventoried before and after. Comparing only a second temp directory
     * proves nothing about the developer's own `~/.opencodex/integrations`,
     * which is the directory a lost seam would write to.
     */
    const defaultRoot = createIntegrationStateStore().root;
    const defaultBefore = snapshotTreeIfPresent(defaultRoot);
    const realRoot = join(base, "other-store", "integrations");
    const real = createIntegrationStateStore(realRoot);
    real.captureSnapshot("hermes", "seeded-op", "seeded snapshot bytes\n");
    real.appendJournal({
      opId: "seeded-op",
      clientId: "hermes",
      kind: "apply",
      at: new Date(0).toISOString(),
      configPath: join(base, "elsewhere", "config.yaml"),
      snapshot: { kind: "stored", relPath: join("snapshots", "hermes", "seeded-op") },
      resultFingerprint: "seeded",
      resultAbsent: false,
      priorRecord: null,
    });
    real.markPruneFailure("hermes", "seeded failure");
    const before = snapshotTree(realRoot);

    installHermes();
    expect((await put("hermes", true)).status).toBe(200);
    expect((await put("hermes", false)).status).toBe(200);
    const opId = store.listOperations("hermes")[0]!.opId;
    expect((await restore({ opId })).status).toBe(200);
    expect((await api("/api/client-integrations")).status).toBe(200);

    expect(snapshotTree(realRoot)).toEqual(before);
    // Nothing reached the real default store either — not a file, not a
    // directory, not the maintenance marker.
    expect(snapshotTreeIfPresent(defaultRoot)).toEqual(defaultBefore);
    // …and the whole transaction is in the temp root instead.
    expect(store.listOperations("hermes").length).toBeGreaterThanOrEqual(3);

    /*
     * The collection read is bound too. Undoing the disable puts the applied
     * file back, so hermes reads `current` — and it can only read `current`
     * if the ownership record written during this transaction was found. The
     * default store holds no such record, so an unbound read would answer
     * `conflict` instead: the block would be on disk with nothing claiming it.
     */
    const listed = await (await api("/api/client-integrations")).json() as { clients: { clientId: string; state: string }[] };
    expect(listed.clients.find(client => client.clientId === "hermes")?.state).toBe("current");
    expect(store.listOperations("hermes")[0]!.kind).toBe("restore");
  });

  test("a GUI-session mutation without CSRF is rejected before integration dispatch", async () => {
    /*
     * Driven through a REAL listener, the way a browser reaches this route.
     *
     * Calling `requireManagementAuth` by hand and then declining to dispatch
     * proves only that the helper works: such a test stays green even if
     * src/server/index.ts stopped calling it before `handleManagementAPI`,
     * which is precisely the regression that would let a CSRF-less GUI
     * mutation reach the writer. So the session is obtained the way the GUI
     * obtains it — from the meta tags injected into the served page — and both
     * requests go over the wire.
     */
    const previousOpencodexHome = process.env.OPENCODEX_HOME;
    const previousAdmin = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    const serverHome = join(base, "csrf-server-home");
    mkdirSync(serverHome, { recursive: true });
    process.env.OPENCODEX_HOME = serverHome;
    // A GUI session is only issued when no admin token is configured; with one
    // set, `isApiAuthRequired` declines and there is no CSRF pair to test.
    delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    installHermes();

    const { saveConfig } = await import("../src/config");
    const { startServer } = await import("../src/server");
    saveConfig(config);
    const server = startServer(0);
    try {
      const origin = new URL(server.url).origin;
      /*
       * The session pair comes from the served page's meta tags, exactly as a
       * browser gets it. That page only exists once `gui/dist` is built, and
       * CI runs this suite without building the GUI — which is why this test
       * failed on every CI platform while passing locally against a stale
       * build. The absent-bundle case is handled explicitly below rather than
       * asserted away.
       */
      const page = await fetch(server.url, { headers: { Accept: "text/html" } });
      const html = await page.text();
      const meta = (name: string): string =>
        new RegExp(`<meta name="${name}" content="([^"]*)">`).exec(html)?.[1] ?? "";
      const token = meta("opencodex-session-token");
      const csrf = meta("opencodex-session-csrf");
      if (!token || !csrf) {
        /*
         * No built GUI, so no page to carry the session pair. The server owns
         * the only session map that its own admission will accept, and there
         * is no wire route to mint one without that page — issuing from a
         * fresh auth state would hand us a token this server has never seen
         * and the assertions below would prove nothing.
         *
         * The ordering claim is still covered on this platform: the
         * admin-token test above drives the same listener and asserts an
         * unauthenticated PUT is refused before the route writes or journals.
         */
        // `fileURLToPath`, not `.pathname`: a Windows URL pathname is
        // `/D:/a/...`, which never exists as a filesystem path and would make
        // this guard vacuously true.
        expect(existsSync(fileURLToPath(new URL("../gui/dist/index.html", import.meta.url)))).toBe(false);
        return;
      }

      const target = new URL("/api/client-integrations/hermes", server.url);
      const guiHeaders = {
        Origin: origin,
        "Content-Type": "application/json",
        "x-opencodex-api-key": token,
        "x-opencodex-gui-origin": origin,
      };

      const withoutCsrf = await fetch(target, {
        method: "PUT",
        headers: guiHeaders,
        body: JSON.stringify({ enabled: true }),
      });
      expect(withoutCsrf.status).toBe(401);
      // Admission ran first, so the route never wrote and never journaled.
      expect(existsSync(hermesConfigPath())).toBe(false);
      expect(store.listOperations()).toHaveLength(0);

      // The control: the same request WITH the CSRF token reaches the route.
      const withCsrf = await fetch(target, {
        method: "PUT",
        headers: { ...guiHeaders, "x-opencodex-csrf-token": csrf },
        body: JSON.stringify({ enabled: true }),
      });
      expect(withCsrf.status).toBe(200);
      expect(store.listOperations("hermes")).toHaveLength(1);
    } finally {
      await server.stop(true);
      if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOpencodexHome;
      if (previousAdmin !== undefined) process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdmin;
    }
  });
});
