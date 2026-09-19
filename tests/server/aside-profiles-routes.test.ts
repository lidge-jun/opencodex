import { loadConfig } from "../../src/config";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleManagementAPI } from "../../src/server/management-api";
import { MANAGEMENT_JSON_BODY_MAX_BYTES } from "../../src/server/management/body";
import { setIntegrationMutationFlightTestHooks, setIntegrationPathTestHooks } from "../../src/server/management/integration-routes";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration } from "../../src/integrations/writer";
import { refreshOwnedCatalogIntegrations } from "../../src/integrations/catalog-refresh";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { loadExportModels, resetExportSnapshotForTests } from "../../src/server/management/model-rows";

let root: string;
let home: string;
let store: IntegrationStateStore;
let config: OcxConfig;
let isolation: IsolatedCodexHome;
let priorOcxHome: string | undefined;
let saved: OcxConfig | undefined;
const env: NodeJS.ProcessEnv = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-aside-profile-routes-"));
  home = join(root, "home");
  priorOcxHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = join(root, "config");
  isolation = installIsolatedCodexHome("ocx-aside-profile-codex-");
  store = createIntegrationStateStore(join(root, "store"));
  mkdirSync(join(home, ".aside"), { recursive: true });
  writeFileSync(join(home, ".aside", "accounts.json"), JSON.stringify({
    currentAccountId: 0, accounts: [{ id: 0, name: "Primary" }, { id: 1, name: "Local one" }, { id: 2, name: "Local two" }],
    sessions: { private: { accessToken: "do-not-project" } },
  }));
  for (const id of [0,1,2]) {
    mkdirSync(join(home, ".aside", "u", String(id)), { recursive: true });
    writeFileSync(path(id), JSON.stringify({ theme: "keep", providers: { personal: { models: [] } } }));
  }
  config = { port: 10100, hostname: "127.0.0.1", defaultProvider: "fixture", fastRows: false, providers: {
    fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", liveModels: false, models: ["one","two"] },
  } } as OcxConfig;
  saved = undefined;
  setIntegrationPathTestHooks({ home, env });
  setIntegrationMutationFlightTestHooks({ store });
});

afterEach(() => {
  setIntegrationPathTestHooks(null);
  setIntegrationMutationFlightTestHooks(null);
  isolation.restore();
  if (priorOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = priorOcxHome;
  removeTreeWithRetry(root);
});

function path(id: number): string { return join(home, ".aside", "u", String(id), "models.json"); }

/** Whole-tree content, so an appended journal row or replaced snapshot cannot hide. */
function treeWitness(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir, { recursive: true })
    .map(entry => String(entry))
    .sort()
    .map(entry => {
      const full = join(dir, entry);
      if (!existsSync(full) || statSync(full).isDirectory()) return `${entry}/`;
      return `${entry}:${readFileSync(full, "utf8")}`;
    })
    .join("\u0000");
}

/** A preview only answers from a roster an authoritative load already finished. */
async function seedRoster(): Promise<void> {
  resetExportSnapshotForTests();
  await loadExportModels(config, []);
}
function document(id: number) { return JSON.parse(readFileSync(path(id), "utf8")); }
async function api(pathname: string, method = "GET", body?: unknown) {
  return rawApi(pathname, method, body === undefined ? undefined : JSON.stringify(body));
}
async function rawApi(pathname: string, method: string, body?: string) {
  const url = new URL(`http://127.0.0.1:10100${pathname}`);
  const response = await handleManagementAPI(new Request(url, {
    method, headers: { Host: url.host, "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  }), url, config, {
    saveConfigPreservingClaudeCode: value => { saved = structuredClone(value); },
    createManagementConvergeCodex: catalogConvergenceFactory(),
    refreshOwnedCatalogIntegrations: input => refreshOwnedCatalogIntegrations({ ...input, store, env, home }),
  });
  if (!response) throw new Error("route missing");
  return response;
}

async function prepareAsideSync(): Promise<void> {
  config.providers.fixture!.selectedModels = ["one"];
  const enabled = await api("/api/client-integrations/aside/profiles", "PUT", { enabled: true });
  expect(enabled.status).toBe(200);
  expect(await enabled.json()).toMatchObject({ ok: true });
  for (const id of [0, 1, 2]) expect(fixtureModelIds(id)).toEqual(["fixture/one"]);
  // Change the runtime selection without triggering a different endpoint's sync.
  config.providers.fixture!.selectedModels = ["two"];
}

function fixtureModelIds(id: number): string[] {
  return document(id).providers.opencodex.models
    .filter((model: { id: string }) => model.id.startsWith("fixture/"))
    .map((model: { id: string }) => model.id);
}

test.each([undefined, "{}"])("Aside sync accepts body %j and refreshes every enabled profile with HTTP 200", async body => {
  await prepareAsideSync();
  const response = await rawApi("/api/client-integrations/aside/sync", "POST", body);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true, clientId: "aside",
    results: [0, 1, 2].map(profileId => ({ client: "aside", profileId, ok: true, changed: true })),
  });
  for (const id of [0, 1, 2]) {
    expect(fixtureModelIds(id)).toEqual(["fixture/two"]);
    expect(document(id).theme).toBe("keep");
    expect(document(id).providers.personal).toEqual({ models: [] });
  }
});

test("bodyless Aside sync returns HTTP 207 for one conflict while refreshing its siblings", async () => {
  await prepareAsideSync();
  const edited = document(1);
  edited.providers.opencodex.baseUrl = "https://user-edit.example.test/v1";
  const editedBytes = JSON.stringify(edited);
  writeFileSync(path(1), editedBytes);
  const response = await api("/api/client-integrations/aside/sync", "POST");
  expect(response.status).toBe(207);
  expect(await response.json()).toMatchObject({
    ok: false, clientId: "aside", results: [
      { client: "aside", profileId: 0, ok: true, changed: true },
      { client: "aside", profileId: 1, ok: false, state: "conflict", refusalReason: "conflict" },
      { client: "aside", profileId: 2, ok: true, changed: true },
    ],
  });
  expect(readFileSync(path(1), "utf8")).toBe(editedBytes);
  for (const id of [0, 2]) expect(fixtureModelIds(id)).toEqual(["fixture/two"]);
  expect(await (await api("/api/client-integrations/aside/profiles/1")).json())
    .toMatchObject({ enabled: true, state: "conflict" });
});

test.each(['{"enabled":true}', '{"profile":1}', '{"overwriteConflict":true}', "[]", "null", "true", "{"])(
  "Aside sync rejects nonempty options or invalid JSON %s before mutation", async body => {
    const before = [0, 1, 2].map(id => readFileSync(path(id), "utf8"));
    const response = await rawApi("/api/client-integrations/aside/sync", "POST", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_aside_profile", clientId: "aside" });
    expect([0, 1, 2].map(id => readFileSync(path(id), "utf8"))).toEqual(before);
    expect(saved).toBeUndefined();
    expect(store.listOperations("aside")).toEqual([]);
  },
);

test.each(["?profile=0", "?profile=invalid", "?client=pi"])("bodyless Aside sync rejects selector %s", async selector => {
  expect((await api(`/api/client-integrations/aside/sync${selector}`, "POST")).status).toBe(400);
  expect(saved).toBeUndefined();
  expect(store.listOperations("aside")).toEqual([]);
});

test("Aside sync retains the JSON body size limit before accepting an empty-body fallback", async () => {
  const response = await rawApi("/api/client-integrations/aside/sync", "POST", " ".repeat(MANAGEMENT_JSON_BODY_MAX_BYTES + 1));
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: "request body too large" });
  expect(saved).toBeUndefined();
  expect(store.listOperations("aside")).toEqual([]);
});

test.each(["/api/client-integrations/aside/profiles", "/api/client-integrations/aside/profiles/1"])(
  "Aside PUT still requires its enabled body at %s", async pathname => {
    const before = [0, 1, 2].map(id => readFileSync(path(id), "utf8"));
    expect((await api(pathname, "PUT")).status).toBe(400);
    expect((await api(pathname, "PUT", {})).status).toBe(400);
    expect([0, 1, 2].map(id => readFileSync(path(id), "utf8"))).toEqual(before);
    expect(saved).toBeUndefined();
  },
);

test("legacy connection refreshes all profiles, and an individual off survives selection refresh and reload", async () => {
  expect(applyIntegration({ clientId: "aside", config, port: 10100, store, env, home,
    models: [{ provider: "fixture", id: "one", namespaced: "fixture/one" }] }).ok).toBe(true);
  const initial = await (await api("/api/client-integrations/aside/profiles")).json();
  expect(initial.profiles).toHaveLength(3);
  expect(JSON.stringify(initial)).not.toContain("do-not-project");
  expect((await api("/api/selected-models", "PUT", { provider: "fixture", models: ["one"] })).status).toBe(200);
  for (const id of [0,1,2]) {
    expect(document(id).providers.opencodex.models.filter((m: { id: string }) => m.id.startsWith("fixture/")).map((m: { id: string }) => m.id)).toEqual(["fixture/one"]);
    expect(document(id).theme).toBe("keep");
    expect(document(id).providers.personal).toEqual({ models: [] });
  }
  expect((await api("/api/client-integrations/aside?profile=1", "PUT", { enabled: false })).status).toBe(200);
  config = structuredClone(saved!);
  expect((await api("/api/selected-models", "PUT", { provider: "fixture", models: ["two"] })).status).toBe(200);
  expect(document(1).providers.opencodex).toBeUndefined();
  for (const id of [0,2]) expect(document(id).providers.opencodex.models.some((m: { id: string }) => m.id === "fixture/two")).toBe(true);
  const state = await (await api("/api/client-integrations/aside?profile=1")).json();
  expect(state).toMatchObject({ profileId: 1, enabled: false, state: "absent" });
});

test("profile history and Undo cannot recreate an undone enable on the next sync", async () => {
  const enabled = await (await api("/api/client-integrations/aside?profile=2", "PUT", { enabled: true })).json();
  expect(enabled.ok).toBe(true);
  const journal = await (await api("/api/client-integrations/journal?client=aside&profile=2")).json();
  expect(journal.operations[0]).toMatchObject({ profileId: 2, opId: enabled.opId, undoable: true });
  expect((await api("/api/client-integrations/restore?client=aside&profile=2", "POST", { opId: enabled.opId })).status).toBe(200);
  config = structuredClone(saved!);
  await api("/api/selected-models", "PUT", { provider: "fixture", models: ["one"] });
  expect(document(2).providers.opencodex).toBeUndefined();
  expect(document(0).providers.opencodex).toBeUndefined();
});

test("profile zero can be planned; it is a real profile, not an absent one", async () => {
  await seedRoster();
  const response = await api("/api/client-integrations/aside/profiles/0/preview", "POST", { operation: "apply" });
  expect(response.status).toBe(200);
  const plan = await response.json() as { canApply: boolean; profileId?: number; fingerprint: string };
  expect(plan.canApply).toBe(true);
  expect(plan.profileId).toBe(0);
  // A plan names places, never the profile's location.
  expect(JSON.stringify(plan)).not.toContain(home);
});

test("a previewed profile change commits once and then reports itself stale", async () => {
  await seedRoster();
  const preview = await api("/api/client-integrations/aside/profiles/1/preview", "POST", { operation: "apply" });
  expect(preview.status).toBe(200);
  const plan = await preview.json() as { canApply: boolean; fingerprint: string };
  expect(plan.canApply).toBe(true);

  const commit = await api("/api/client-integrations/aside/profiles/1", "PUT", {
    enabled: true, operation: "apply", planFingerprint: plan.fingerprint,
  });
  expect(commit.status).toBe(200);
  expect(document(1).providers.opencodex).toBeDefined();
  const committed = readFileSync(path(1), "utf8");

  // Replaying the same confirmation describes a profile that is no longer in that state. Without
  // a real comparison this would apply a second time.
  const replay = await api("/api/client-integrations/aside/profiles/1", "PUT", {
    enabled: true, operation: "apply", planFingerprint: plan.fingerprint,
  });
  expect(replay.status).toBe(409);
  expect((await replay.json() as { code: string }).code).toBe("integration_preview_stale");
  expect(readFileSync(path(1), "utf8")).toBe(committed);
  // The refusal must not touch a sibling profile either.
  expect(document(2).providers.opencodex).toBeUndefined();
});

test("a stale profile confirmation is refused before the preference is written", async () => {
  await seedRoster();
  const preview = await api("/api/client-integrations/aside/profiles/2/preview", "POST", { operation: "apply" });
  const plan = await preview.json() as { fingerprint: string };
  const before = readFileSync(path(2), "utf8");
  const homeBefore = treeWitness(join(home, ".aside"));
  const storeBefore = treeWitness(join(root, "store"));

  const response = await api("/api/client-integrations/aside/profiles/2", "PUT", {
    enabled: true, operation: "apply", planFingerprint: `${plan.fingerprint}-not-current`,
  });
  expect(response.status).toBe(409);
  expect((await response.json() as { code: string }).code).toBe("integration_preview_stale");
  expect(readFileSync(path(2), "utf8")).toBe(before);
  // Ownership records, snapshots and journal rows live in the store, and an Aside import writes
  // history before any writer runs, so the target file alone would not see either of them.
  expect(treeWitness(join(home, ".aside"))).toBe(homeBefore);
  expect(treeWitness(join(root, "store"))).toBe(storeBefore);
  // Aside persists its preference before any writer runs, so a check that fired later would have
  // saved this already.
  expect(saved).toBeUndefined();
});

test("a bound undo follows the copy resolution actually chose", async () => {
  await seedRoster();
  const original = readFileSync(path(1), "utf8");
  const applied = await api("/api/client-integrations/aside/profiles/1", "PUT", { enabled: true });
  expect(applied.status).toBe(200);
  expect(document(1).providers.opencodex).toBeDefined();

  const profileStore = join(root, "store", "aside-profiles", "1");
  const rows = readFileSync(join(profileStore, "journal.jsonl"), "utf8");
  const opId = JSON.parse(rows.trim().split("\n")[0] ?? "{}").opId as string;
  expect(typeof opId).toBe("string");

  /*
   * The same operation can live in more than one store with different retention. Resolution
   * prefers the copy whose snapshot still exists, so putting a stored copy in the root store and
   * expiring the profile's own forces it to choose the alternate. If a preview and the mutation
   * resolved independently they could pick different copies, and the confirmation would then
   * describe an operation other than the one that runs.
   */
  writeFileSync(join(root, "store", "journal.jsonl"), rows);
  const snapshotName = join("snapshots", "aside", opId);
  mkdirSync(join(root, "store", "snapshots", "aside"), { recursive: true });
  writeFileSync(join(root, "store", snapshotName), readFileSync(join(profileStore, snapshotName), "utf8"));
  rmSync(join(profileStore, snapshotName));

  const siblingBefore = treeWitness(join(root, "store", "aside-profiles", "2"));
  const preview = await api("/api/client-integrations/aside/profiles/1/preview", "POST", { operation: "restore", opId });
  expect(preview.status).toBe(200);
  const plan = await preview.json() as { canApply: boolean; fingerprint: string; profileId?: number };
  expect(plan.canApply).toBe(true);
  expect(plan.profileId).toBe(1);

  const undo = await api("/api/client-integrations/aside/profiles/1/restore", "POST", {
    opId, operation: "restore", planFingerprint: plan.fingerprint,
  });
  expect(undo.status).toBe(200);

  // Restored from the copy that was chosen, and the journal records both the undo and the apply.
  expect(readFileSync(path(1), "utf8")).toBe(original);
  const finalRows = readFileSync(join(root, "store", "journal.jsonl"), "utf8")
    + readFileSync(join(profileStore, "journal.jsonl"), "utf8");
  expect(finalRows).toContain(opId);
  expect(finalRows).toContain("restore");
  expect(treeWitness(join(root, "store", "aside-profiles", "2"))).toBe(siblingBefore);
});

test.each(["../0", "01", "-1", "9007199254740992"])("rejects invalid profile %s before file mutation", async id => {
  const before = [0,1,2].map(i => readFileSync(path(i), "utf8"));
  const response = await api(`/api/client-integrations/aside?profile=${encodeURIComponent(id)}`, "PUT", { enabled: true });
  expect(response.status).toBe(400);
  expect([0,1,2].map(i => readFileSync(path(i), "utf8"))).toEqual(before);
  expect(saved).toBeUndefined();
});

test("a non-Aside client cannot silently consume a profile selector", async () => {
  expect((await api("/api/client-integrations/pi?profile=0", "PUT", { enabled: true })).status).toBe(400);
  expect(saved).toBeUndefined();
});


test("invalid persisted profile policy fails closed without resetting the surrounding config", () => {
  const configRoot = process.env.OPENCODEX_HOME!;
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(join(configRoot, "config.json"), JSON.stringify({ ...config, asideProfileSync: { allProfiles: true, profiles: { "1": "off" } } }));
  const loaded = loadConfig();
  expect(loaded.asideProfileSync).toEqual({ allProfiles: false });
  expect(loaded.port).toBe(10100);
  expect(loaded.providers.fixture).toBeDefined();
});

test.each(["%61side", "as%69de"])("alternate Aside spelling %s cannot reach the legacy writer", async spelling => {
  const before = [0,1,2].map(id => readFileSync(path(id), "utf8"));
  expect((await api(`/api/client-integrations/${spelling}`, "PUT", { enabled: true })).status).toBe(400);
  expect(saved).toBeUndefined();
  expect([0,1,2].map(id => readFileSync(path(id), "utf8"))).toEqual(before);
  expect(store.listOperations("aside")).toEqual([]);
});

test("conflicting client selectors cannot restore Aside or delete its history", async () => {
  const on = await (await api("/api/client-integrations/aside/profiles/0", "PUT", { enabled: true })).json();
  await api("/api/client-integrations/aside/profiles/0", "PUT", { enabled: false });
  const before = readFileSync(path(0), "utf8");
  const policy = structuredClone(config.asideProfileSync);
  expect((await api("/api/client-integrations/restore?client=pi&profile=0", "POST", { opId: on.opId })).status).toBe(400);
  expect((await api(`/api/client-integrations/journal?client=pi&profile=0&opId=${on.opId}`, "DELETE")).status).toBe(400);
  expect(readFileSync(path(0), "utf8")).toBe(before);
  expect(config.asideProfileSync).toEqual(policy);
  const history = await (await api("/api/client-integrations/aside/profiles/0/journal")).json();
  expect(history.operations.some((row: { opId: string }) => row.opId === on.opId)).toBe(true);
});

test("dedicated nested paths retain profile scope for status, history and restore", async () => {
  const on = await (await api("/api/client-integrations/aside/profiles/2", "PUT", { enabled: true })).json();
  expect(on).toMatchObject({ ok: true, profileId: 2 });
  expect(await (await api("/api/client-integrations/aside/profiles/2")).json()).toMatchObject({ profileId: 2, enabled: true });
  expect((await api("/api/client-integrations/aside/profiles/2?profile=1", "PUT", { enabled: false })).status).toBe(400);
  expect((await api("/api/client-integrations/aside/profiles/2/restore", "POST", { opId: on.opId })).status).toBe(200);
  expect(document(2).providers.opencodex).toBeUndefined();
  expect(document(0).providers.opencodex).toBeUndefined();
});
