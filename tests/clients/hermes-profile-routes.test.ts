import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENCODE_PROVIDER_ID } from "../../src/clients/config-export";
import { cleanupOwnedIntegrationsBeforeUninstall } from "../../src/cli/uninstall-integrations";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { HermesProfileError } from "../../src/integrations/hermes-profiles";
import type { ManagementContext } from "../../src/server/management/context";
import { hermesRequestScope, scopeHermesProfileRequest } from "../../src/server/management/hermes-profile-routes";
import { disableIntegrationCoordinated, restoreIntegrationCoordinated } from "../../src/integrations/writer";
import { handleManagementAPI } from "../../src/server/management-api";
import { loadExportModels } from "../../src/server/management/model-rows";
import {
  setIntegrationMutationFlightTestHooks,
  setIntegrationPathTestHooks,
} from "../../src/server/management/integration-routes";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * Issue #7674: Hermes keeps one home per profile (the default home, then
 * <root>/profiles/<name>/ with its own config.yaml), and Connect only ever wrote
 * the default one. Every case drives the real route, writer and store against
 * a temp home; the route never sees process.env.
 */
const routeEnv = {} as NodeJS.ProcessEnv;
let base = "";
let home = "";
let storeRoot = "";
let store: IntegrationStateStore;
let config: OcxConfig;

const DEFAULT_TEXT = "model:\n  default: anthropic/claude-sonnet-4\n";
const CODER_TEXT = "# coder bot\nmodel:\n  default: openrouter/some-model\nproviders:\n  other:\n    api: https://other.example/v1\n";

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "a",
    providers: {
      a: {
        adapter: "openai-chat",
        baseUrl: "https://a.example/v1",
        apiKey: "test-placeholder",
        liveModels: false,
        models: ["m1"],
        modelContextWindows: { m1: 128_000 },
      },
    },
  } as unknown as OcxConfig;
}

function defaultHome(): string {
  return INTEGRATION_CLIENTS.hermes.detectDir(routeEnv, home);
}

function profileHome(name: string): string {
  return join(defaultHome(), "profiles", name);
}

function makeProfile(name: string, files: Record<string, string>): string {
  const dir = profileHome(name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ocx-hermes-profiles-"));
  home = join(base, "home");
  storeRoot = join(base, "store", "integrations");
  mkdirSync(home, { recursive: true });
  store = createIntegrationStateStore(storeRoot);
  config = baseConfig();
  setIntegrationMutationFlightTestHooks({ store });
  setIntegrationPathTestHooks({ env: routeEnv, home });
  mkdirSync(defaultHome(), { recursive: true });
  writeFileSync(join(defaultHome(), "config.yaml"), DEFAULT_TEXT);
  makeProfile("coder", { "config.yaml": CODER_TEXT, "SOUL.md": "coder\n" });
});

afterEach(() => {
  setIntegrationMutationFlightTestHooks(null);
  setIntegrationPathTestHooks(null);
  removeTreeWithRetry(base);
});

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL("http://127.0.0.1:10100" + path);
  const response = await handleManagementAPI(
    new Request(url, { ...init, headers: { Host: url.host, ...(init.headers ?? {}) } }),
    url,
    config,
    { saveConfigPreservingClaudeCode: () => {}, createManagementConvergeCodex: catalogConvergenceFactory() },
  );
  expect(response).not.toBeNull();
  return response!;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function profileStore(name: string): IntegrationStateStore {
  return createIntegrationStateStore(join(storeRoot, "hermes-profiles", name));
}

const coderConfig = () => join(profileHome("coder"), "config.yaml");
const defaultConfig = () => join(defaultHome(), "config.yaml");

describe("Hermes profile selection (#7674)", () => {
  test("apply to a named profile writes only that profile and owns it in its own store", async () => {
    const response = await api("/api/client-integrations/hermes?profile=coder", json("PUT", { enabled: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, clientId: "hermes", changed: true });

    const written = readFileSync(coderConfig(), "utf8");
    const parsed = Bun.YAML.parse(written) as {
      model: { default: string };
      providers: Record<string, { models?: Record<string, unknown> }>;
    };
    // The profile's own model and providers survive; only our provider entry is added.
    expect(parsed.model.default).toBe("openrouter/some-model");
    expect(parsed.providers.other).toBeDefined();
    expect(Object.keys(parsed.providers[OPENCODE_PROVIDER_ID]?.models ?? {})).toContain("a/m1");
    expect(written).toContain("# coder bot");
    expect(readFileSync(defaultConfig(), "utf8")).toBe(DEFAULT_TEXT);

    expect(store.readRecords().hermes).toBeUndefined();
    expect(profileStore("coder").readRecords().hermes?.configPath).toBe(coderConfig());
  });

  test("the profile list reports each profile from its own store", async () => {
    makeProfile("ghost", {});
    makeProfile("Upper", { "config.yaml": "x: 1\n" });
    makeProfile("gone", { "config.yaml": "x: 1\n" });
    mkdirSync(join(defaultHome(), "profiles", ".deleted", "gone"), { recursive: true });
    makeProfile("writer", { ".env": "" });
    expect((await api("/api/client-integrations/hermes?profile=coder", json("PUT", { enabled: true }))).status).toBe(200);

    const response = await api("/api/client-integrations/hermes/profiles");
    expect(response.status).toBe(200);
    const body = await response.json() as { profiles: Array<{ hermesProfile: string; configPath: string; state: string; installed: boolean }> };
    expect(body.profiles.map(row => row.hermesProfile)).toEqual(["default", "coder", "writer"]);
    expect(body.profiles.map(row => row.configPath)).toEqual([
      defaultConfig(), coderConfig(), join(profileHome("writer"), "config.yaml"),
    ]);
    expect(body.profiles.map(row => row.state)).toEqual(["absent", "current", "absent"]);
    expect(body.profiles.every(row => row.installed)).toBe(true);
  });

  test("a scoped state read names the profile it describes", async () => {
    const response = await api("/api/client-integrations/hermes?profile=coder");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ clientId: "hermes", hermesProfile: "coder", configPath: coderConfig(), state: "absent" });
  });

  test("journal, undo and disable stay inside the selected profile", async () => {
    expect((await api("/api/client-integrations/hermes?profile=coder", json("PUT", { enabled: true }))).status).toBe(200);
    const scoped = await api("/api/client-integrations/journal?client=hermes&profile=coder");
    expect(scoped.status).toBe(200);
    const rows = (await scoped.json() as { operations: Array<{ opId: string; kind: string; configPath: string; undoable: boolean }> }).operations;
    expect(rows.map(row => [row.kind, row.configPath, row.undoable])).toEqual([["apply", coderConfig(), true]]);

    const root = await api("/api/client-integrations/journal?client=hermes");
    expect((await root.json() as { operations: unknown[] }).operations).toEqual([]);

    // The root store does not know this operation, so an unscoped undo cannot reach it.
    expect((await api("/api/client-integrations/restore", json("POST", { opId: rows[0]!.opId }))).status).toBe(404);
    const undone = await api("/api/client-integrations/restore?client=hermes&profile=coder", json("POST", { opId: rows[0]!.opId }));
    expect(undone.status).toBe(200);
    expect(readFileSync(coderConfig(), "utf8")).toBe(CODER_TEXT);
    expect(profileStore("coder").readRecords().hermes).toBeUndefined();

    expect((await api("/api/client-integrations/hermes?profile=coder", json("PUT", { enabled: true }))).status).toBe(200);
    const disabled = await api("/api/client-integrations/hermes?profile=coder", json("PUT", { enabled: false }));
    expect(disabled.status).toBe(200);
    expect(readFileSync(coderConfig(), "utf8")).toBe(CODER_TEXT);
    expect(readFileSync(defaultConfig(), "utf8")).toBe(DEFAULT_TEXT);
  });

  test("a confirmed plan binds to the selected profile", async () => {
    await loadExportModels(config);
    const preview = await api("/api/client-integrations/preview?client=hermes&profile=coder", json("POST", { clientId: "hermes", operation: "apply" }));
    expect(preview.status).toBe(200);
    const plan = await preview.json() as { fingerprint: string; clientId: string; canApply: boolean };
    expect(plan.clientId).toBe("hermes");
    expect(plan.canApply).toBe(true);

    const mismatched = await api("/api/client-integrations/preview?client=hermes&profile=coder", json("POST", { clientId: "pi", operation: "apply" }));
    expect(mismatched.status).toBe(400);

    // The default profile's plan describes a different file, so it cannot confirm this one.
    const defaultPlan = await (await api("/api/client-integrations/preview", json("POST", { clientId: "hermes", operation: "apply" }))).json() as { fingerprint: string };
    expect(defaultPlan.fingerprint).not.toBe(plan.fingerprint);
    const crossBound = await api("/api/client-integrations/hermes?profile=coder", json("PUT", {
      enabled: true, operation: "apply", planFingerprint: defaultPlan.fingerprint,
    }));
    expect(crossBound.status).toBe(409);
    expect(readFileSync(coderConfig(), "utf8")).toBe(CODER_TEXT);

    const applied = await api("/api/client-integrations/hermes?profile=coder", json("PUT", {
      enabled: true, operation: "apply", planFingerprint: plan.fingerprint,
    }));
    expect(applied.status).toBe(200);
    expect(profileStore("coder").readRecords().hermes?.configPath).toBe(coderConfig());
    expect(readFileSync(defaultConfig(), "utf8")).toBe(DEFAULT_TEXT);
  });

  test("invalid and unknown profiles are refused before anything is written", async () => {
    for (const [selector, status] of [["..%2Fcoder", 400], ["Coder", 400], ["ghost", 404], ["", 400]] as const) {
      const response = await api("/api/client-integrations/hermes?profile=" + selector, json("PUT", { enabled: true }));
      expect(response.status).toBe(status);
    }
    expect(readFileSync(coderConfig(), "utf8")).toBe(CODER_TEXT);
    expect(existsSync(join(storeRoot, "hermes-profiles"))).toBe(false);
    // Profile selectors on other clients are still refused.
    expect((await api("/api/client-integrations/pi?profile=coder", json("PUT", { enabled: true }))).status).toBe(400);
  });

  test("no selector and profile=default keep writing the default profile", async () => {
    expect((await api("/api/client-integrations/hermes?profile=default", json("PUT", { enabled: true }))).status).toBe(200);
    expect(store.readRecords().hermes?.configPath).toBe(defaultConfig());
    expect(readFileSync(coderConfig(), "utf8")).toBe(CODER_TEXT);
    expect((await api("/api/client-integrations/hermes", json("PUT", { enabled: false }))).status).toBe(200);
    expect(readFileSync(defaultConfig(), "utf8")).toBe(DEFAULT_TEXT);
  });

  test("uninstall removes the provider from every owned profile", async () => {
    expect((await api("/api/client-integrations/hermes", json("PUT", { enabled: true }))).status).toBe(200);
    expect((await api("/api/client-integrations/hermes?profile=coder", json("PUT", { enabled: true }))).status).toBe(200);
    const result = await cleanupOwnedIntegrationsBeforeUninstall({
      createStore: () => store,
      loadConfig: () => config,
      loadModels: () => loadExportModels(config),
      disable: input => disableIntegrationCoordinated(input),
      env: routeEnv,
      home,
    });
    expect(result).toEqual({ attempted: 2, changed: 2 });
    expect(readFileSync(coderConfig(), "utf8")).toBe(CODER_TEXT);
    expect(readFileSync(defaultConfig(), "utf8")).toBe(DEFAULT_TEXT);
    expect(profileStore("coder").readRecords()).toEqual({});
  });
});

describe("Hermes profile scope boundaries (#7674 audit)", () => {
  afterEach(() => { delete routeEnv.HERMES_HOME; });

  test("a second profile is busy while another profile's write is in flight, never joined", async () => {
    makeProfile("writer", { "config.yaml": CODER_TEXT });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    setIntegrationMutationFlightTestHooks({ store, run: async operation => { entered(); await gate; return operation(); } });
    const coder = api("/api/client-integrations/hermes?profile=coder", json("PUT", { enabled: true }));
    await started;
    const writer = await api("/api/client-integrations/hermes?profile=writer", json("PUT", { enabled: true }));
    expect(writer.status).toBe(409);
    expect(await writer.json()).toMatchObject({ code: "integration_mutation_busy" });
    const fallback = await api("/api/client-integrations/hermes", json("PUT", { enabled: true }));
    expect(fallback.status).toBe(409);
    release();
    expect((await coder).status).toBe(200);
    expect(readFileSync(join(profileHome("writer"), "config.yaml"), "utf8")).toBe(CODER_TEXT);
    expect(profileStore("writer").readRecords()).toEqual({});
    expect(readFileSync(defaultConfig(), "utf8")).toBe(DEFAULT_TEXT);
  });

  test("a Hermes-scoped history request never reaches another client's operation", async () => {
    mkdirSync(INTEGRATION_CLIENTS.pi.detectDir(routeEnv, home), { recursive: true });
    expect((await api("/api/client-integrations/pi", json("PUT", { enabled: true }))).status).toBe(200);
    const piOp = store.listOperations("pi")[0]!.opId;
    store.appendJournal({
      opId: "aside-foreign-op", clientId: "aside", kind: "apply", at: new Date().toISOString(),
      configPath: join(home, "aside-config.json"), snapshot: { kind: "none" },
      resultFingerprint: "", resultAbsent: true, priorRecord: null,
    });
    for (const profile of ["default", "coder"]) {
      for (const opId of [piOp, "aside-foreign-op"]) {
        const scope = "client=hermes&profile=" + profile;
        expect((await api("/api/client-integrations/restore?" + scope, json("POST", { opId }))).status).toBe(404);
        expect((await api("/api/client-integrations/restore/preview?" + scope, json("POST", { opId }))).status).toBe(404);
        expect((await api("/api/client-integrations/journal?" + scope + "&opId=" + opId, { method: "DELETE" })).status).toBe(404);
      }
      const rows = await api("/api/client-integrations/journal?client=hermes&profile=" + profile);
      expect((await rows.json() as { operations: Array<{ clientId: string }> }).operations.every(row => row.clientId === "hermes")).toBe(true);
    }
    expect(store.listOperations("pi").map(row => row.opId)).toEqual([piOp]);
  });

  test("a profile of the same name under another Hermes home cannot take over its ownership", async () => {
    expect((await api("/api/client-integrations/hermes?profile=coder", json("PUT", { enabled: true }))).status).toBe(200);
    // Resolved before HERMES_HOME moves: afterwards coderConfig() names the other root's profile.
    const originalPath = coderConfig();
    const original = readFileSync(originalPath, "utf8");
    const otherRoot = join(base, "other-hermes");
    mkdirSync(join(otherRoot, "profiles", "coder"), { recursive: true });
    writeFileSync(join(otherRoot, "config.yaml"), DEFAULT_TEXT);
    writeFileSync(join(otherRoot, "profiles", "coder", "config.yaml"), CODER_TEXT);
    routeEnv.HERMES_HOME = otherRoot;

    for (const body of [{ enabled: true }, { enabled: true, overwriteConflict: true }, { enabled: false }]) {
      const response = await api("/api/client-integrations/hermes?profile=coder", json("PUT", body));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "hermes_profile_owner_mismatch" });
    }
    expect(readFileSync(join(otherRoot, "profiles", "coder", "config.yaml"), "utf8")).toBe(CODER_TEXT);
    expect(readFileSync(originalPath, "utf8")).toBe(original);
    expect(original).toContain("opencodex:");
    expect(profileStore("coder").readRecords().hermes?.configPath).toBe(originalPath);
    const listed = await (await api("/api/client-integrations/hermes/profiles")).json() as { profiles: Array<{ hermesProfile: string; state: string; error?: string }> };
    expect(listed.profiles.find(row => row.hermesProfile === "coder")).toMatchObject({ state: "unsafe", error: expect.any(String) });
  });

  test("a linked profile is not listed, and a profile swapped for a link before the write is refused", async () => {
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "config.yaml"), CODER_TEXT);
    symlinkSync(elsewhere, profileHome("linked"), "junction");
    expect((await api("/api/client-integrations/hermes?profile=linked", json("PUT", { enabled: true }))).status).toBe(404);

    const moved = join(defaultHome(), "profiles", "coder-moved");
    setIntegrationMutationFlightTestHooks({
      store,
      run: async operation => {
        renameSync(profileHome("coder"), moved);
        symlinkSync(moved, profileHome("coder"), "junction");
        return operation();
      },
    });
    const response = await api("/api/client-integrations/hermes?profile=coder", json("PUT", { enabled: true }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "integration_unsafe" });
    expect(readFileSync(join(moved, "config.yaml"), "utf8")).toBe(CODER_TEXT);
    expect(readFileSync(join(elsewhere, "config.yaml"), "utf8")).toBe(CODER_TEXT);
    expect(profileStore("coder").readRecords()).toEqual({});
  });
});

describe("Hermes profile boundaries at the last step (#7674 audit round 2)", () => {
  test("restore runs its synchronous restoreGuard after revalidation and honors its refusal", async () => {
    expect((await api("/api/client-integrations/hermes?profile=coder", json("PUT", { enabled: true }))).status).toBe(200);
    const applied = readFileSync(coderConfig(), "utf8");
    const opId = profileStore("coder").listOperations("hermes")[0]!.opId;
    const order: string[] = [];
    const result = await restoreIntegrationCoordinated({
      clientId: "hermes", models: await loadExportModels(config), config, port: 10100,
      store: profileStore("coder"), env: { ...routeEnv, HERMES_HOME: profileHome("coder") }, home,
      resolvedPaths: { configPath: coderConfig(), detectDir: profileHome("coder") },
      opId, confirmDrift: false,
    }, {
      revalidate: async () => { order.push("revalidate"); return null; },
      // The background-refresh guard stays ignored by restore; restoreGuard is the restore hook.
      guard: () => {
        order.push("guard");
        return null;
      },
      restoreGuard: () => {
        order.push("restoreGuard");
        return { ok: false, reason: "unsafe", state: "unsafe", clientId: "hermes", message: "boundary moved" };
      },
    });
    expect(order).toEqual(["revalidate", "restoreGuard"]);
    expect(result).toMatchObject({ ok: false, message: "boundary moved" });
    expect(readFileSync(coderConfig(), "utf8")).toBe(applied);
  });

  test("the profile list never reads through a linked ownership store", async () => {
    const foreign = join(base, "foreign-store");
    mkdirSync(join(foreign, "snapshots"), { recursive: true });
    // A valid pending retry: reading through this store would prune and rewrite this file.
    writeFileSync(join(foreign, "maintenance.json"), JSON.stringify({ pruneFailures: { hermes: { at: new Date(0).toISOString(), error: "pending" } } }));
    mkdirSync(join(storeRoot, "hermes-profiles"), { recursive: true });
    symlinkSync(foreign, join(storeRoot, "hermes-profiles", "coder"), "junction");
    const before = readFileSync(join(foreign, "maintenance.json"), "utf8");

    const response = await api("/api/client-integrations/hermes/profiles");
    expect(response.status).toBe(200);
    const rows = (await response.json() as { profiles: Array<{ hermesProfile: string; state: string; error?: string }> }).profiles;
    expect(rows.find(row => row.hermesProfile === "coder")).toMatchObject({ state: "unsafe", error: expect.any(String) });
    expect(readFileSync(join(foreign, "maintenance.json"), "utf8")).toBe(before);
    expect((await api("/api/client-integrations/hermes?profile=coder", json("PUT", { enabled: true }))).status).toBe(409);
    expect(readFileSync(coderConfig(), "utf8")).toBe(CODER_TEXT);
  });

  test("uninstall refuses a profile swapped for a link while models load", async () => {
    expect((await api("/api/client-integrations/hermes?profile=coder", json("PUT", { enabled: true }))).status).toBe(200);
    const applied = readFileSync(coderConfig(), "utf8");
    const decoy = join(base, "decoy");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, "config.yaml"), applied);
    const moved = join(defaultHome(), "profiles", "coder-moved");
    await expect(cleanupOwnedIntegrationsBeforeUninstall({
      createStore: () => store,
      loadConfig: () => config,
      loadModels: async () => {
        renameSync(profileHome("coder"), moved);
        symlinkSync(decoy, profileHome("coder"), "junction");
        return loadExportModels(config);
      },
      disable: (input, options) => disableIntegrationCoordinated(input, options),
      env: routeEnv,
      home,
    })).rejects.toThrow(/refused/);
    expect(readFileSync(join(decoy, "config.yaml"), "utf8")).toBe(applied);
    expect(readFileSync(join(moved, "config.yaml"), "utf8")).toBe(applied);
    expect(profileStore("coder").readRecords().hermes).toBeDefined();
  });
});

describe("Hermes profile store facade (#7674 audit round 3)", () => {
  test("a store swapped after the scope was created refuses every access", async () => {
    expect((await api("/api/client-integrations/hermes?profile=coder", json("PUT", { enabled: true }))).status).toBe(200);
    const url = new URL("http://127.0.0.1:10100/api/client-integrations/journal?client=hermes&profile=coder");
    const req = new Request(url, { method: "DELETE" });
    const scoped = scopeHermesProfileRequest({ req, url, config } as unknown as ManagementContext, { store, env: routeEnv, home });
    expect(scoped).not.toBeInstanceOf(Response);
    const scope = hermesRequestScope(req)!;
    const opId = scope.store.listOperations("hermes")[0]!.opId;
    // Captured before the swap, as a writer holds it through a transaction.
    const io = scope.store.io();
    const record = scope.store.readRecords().hermes!;
    const entry = scope.store.listOperations("hermes")[0]!;

    const foreign = join(base, "foreign-store");
    mkdirSync(foreign, { recursive: true });
    const marker = JSON.stringify({ pruneFailures: { hermes: { at: new Date(0).toISOString(), error: "pending" } } });
    writeFileSync(join(foreign, "maintenance.json"), marker);
    renameSync(join(storeRoot, "hermes-profiles", "coder"), join(storeRoot, "hermes-profiles", "coder-real"));
    symlinkSync(foreign, join(storeRoot, "hermes-profiles", "coder"), "junction");

    expect(() => scope.store.readRecords()).toThrow(HermesProfileError);
    expect(() => scope.store.retryPendingPrunes()).toThrow(HermesProfileError);
    expect(() => scope.store.retireOperation({ tombstone: opId, at: new Date().toISOString(), by: "admin-token" })).toThrow(HermesProfileError);
    expect(() => scope.store.io()).toThrow(HermesProfileError);
    expect(() => io.putRecord(record)).toThrow(HermesProfileError);
    expect(() => io.dropRecord("hermes")).toThrow(HermesProfileError);
    expect(() => io.appendJournal(entry)).toThrow(HermesProfileError);
    expect(readFileSync(join(foreign, "maintenance.json"), "utf8")).toBe(marker);
    expect(readdirSync(foreign)).toEqual(["maintenance.json"]);
  });
});
