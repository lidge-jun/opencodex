import { loadConfig } from "../../src/config";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleManagementAPI } from "../../src/server/management-api";
import { MANAGEMENT_JSON_BODY_MAX_BYTES } from "../../src/server/management/body";
import { setIntegrationMutationFlightTestHooks, setIntegrationPathTestHooks } from "../../src/server/management/integration-routes";
import { defaultIntegrationIO } from "../../src/integrations/config-io";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration } from "../../src/integrations/writer";
import { refreshOwnedCatalogIntegrations } from "../../src/integrations/catalog-refresh";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { exportSnapshotIdentity, loadExportModels, previewExportSnapshot, resetExportSnapshotForTests } from "../../src/server/management/model-rows";
import { asideGuardFor } from "../../src/server/management/aside-profile-routes";
import { previewIntegration, type IntegrationMutationPlan } from "../../src/integrations/mutation-plan";
import { setCached } from "../../src/codex/model-cache";

let root: string;
let home: string;
let store: IntegrationStateStore;
let config: OcxConfig;
let isolation: IsolatedCodexHome;
let priorOcxHome: string | undefined;
let saved: OcxConfig | undefined;
/**
 * Runs inside the preference write, which is where the window this fixture exercises lives: the
 * confirmation has been checked, nothing has been written to the client yet, and an editor outside
 * this process can still change the target.
 */
let onPersist: (() => void) | undefined;
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
  onPersist = undefined;
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
    saveConfigPreservingClaudeCode: value => { saved = structuredClone(value); onPersist?.(); },
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

test("a previewed profile change commits once and then has no roster to replay against", async () => {
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

  // Replaying the same confirmation is refused before anything is written, and the reason is the
  // earlier of the two: committing wrote the Aside preference into the configuration, so the
  // roster this plan was bound to no longer describes the configuration in hand and there is
  // nothing to replan against until the collection is read again. Production reaches the same
  // point through the file, which the preference write also rewrites.
  const replay = await api("/api/client-integrations/aside/profiles/1", "PUT", {
    enabled: true, operation: "apply", planFingerprint: plan.fingerprint,
  });
  expect(replay.status).toBe(409);
  expect((await replay.json() as { code: string }).code).toBe("integration_preview_unavailable");
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
  const sibling2Before = readFileSync(path(2), "utf8");
  const preview = await api("/api/client-integrations/aside/profiles/1/preview", "POST", { operation: "restore", opId });
  expect(preview.status).toBe(200);
  const plan = await preview.json() as {
    canApply: boolean; fingerprint: string; profileId?: number;
    changes: Array<{ kind: string; path: string }>;
  };
  expect(plan.canApply).toBe(true);
  expect(plan.profileId).toBe(1);
  /*
   * This undo takes the managed block back out, because the apply it reverses had nothing of ours
   * before it. Saying so requires reading the ownership of the file being rewritten, which lives
   * in the profile's own store, while the row and its snapshot were resolved out of the root one.
   * Reading the selected row's store instead would describe another file's ownership.
   */
  expect(plan.changes.some(change => change.kind === "remove")).toBe(true);
  expect(plan.changes.some(change => change.kind === "add")).toBe(false);

  const undo = await api("/api/client-integrations/aside/profiles/1/restore", "POST", {
    opId, operation: "restore", planFingerprint: plan.fingerprint,
  });
  expect(undo.status).toBe(200);
  const result = await undo.json() as { ok: boolean; changed: boolean; clientId: string; profileId: number; opId: string };
  expect(result).toMatchObject({ ok: true, changed: true, clientId: "aside", profileId: 1 });
  expect(typeof result.opId).toBe("string");

  // Restored from the copy that was chosen, byte for byte.
  expect(readFileSync(path(1), "utf8")).toBe(original);

  // The undo is journalled in the profile's own store as a restore row, rather than inferred from
  // a substring of two files concatenated together.
  const profileRows = readFileSync(join(profileStore, "journal.jsonl"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line) as { kind: string; opId: string });
  expect(profileRows.filter(row => row.kind === "restore")).toEqual([
    expect.objectContaining({ kind: "restore", opId: result.opId }),
  ]);
  expect(profileRows.some(row => row.opId === opId)).toBe(true);

  // The copy resolution chose is not rewritten, and the sibling profile is untouched in both its
  // document and its store.
  expect(readFileSync(join(root, "store", "journal.jsonl"), "utf8")).toBe(rows);
  expect(readFileSync(join(root, "store", snapshotName), "utf8")).toBe(original);
  expect(readFileSync(path(2), "utf8")).toBe(sibling2Before);
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

test("a bound confirmation is refused when the roster it was planned against has moved", async () => {
  // The guard the route installs, exercised with the input a mutation would be written from. Only
  // the rows are carried into the mutation, so an ordinary load completing while it prepares can
  // replace or retire the snapshot without the carried rows noticing.
  resetExportSnapshotForTests();
  // A roster with rows in it, so the plan below is a real apply rather than a noop.
  await loadExportModels(config, [{ id: "one", provider: "fixture" }]);
  const identity = exportSnapshotIdentity(config);
  expect(identity).not.toBeNull();
  const roster = previewExportSnapshot(config);
  expect(roster).not.toBeNull();

  const profileStore = createIntegrationStateStore(join(root, "store", "aside-profiles", "1"));
  const prepared = {
    clientId: "aside" as const,
    config,
    models: roster!.models,
    port: 10100,
    env,
    home,
    store: profileStore,
    resolvedPaths: { configPath: path(1), detectDir: join(home, ".aside", "u", "1") },
  };
  const plan = previewIntegration(prepared, { operation: "apply" as const, profileId: 1 });
  expect(plan.canApply).toBe(true);

  const capture: { plan: IntegrationMutationPlan | null } = { plan: null };
  const guard = asideGuardFor({ config }, identity!, 1, { operation: "apply", fingerprint: plan.fingerprint }, {}, capture);

  // Current roster, matching fingerprint: the confirmation stands.
  expect(await guard(prepared)).toBeNull();

  // A discovery publishes while this change is in flight. The rows the guard holds are unchanged,
  // and they are no longer the roster the operator was shown.
  expect(setCached("fixture", [{ id: "published-mid-flight", provider: "fixture" }])).toBe(true);
  expect(exportSnapshotIdentity(config)).toBeNull();
  const refused = await guard(prepared);
  expect(refused).toMatchObject({ ok: false, reason: "conflict", clientId: "aside", profileId: 1 });
  expect(refused?.message).toContain("roster changed");
  expect(capture.plan).not.toBeNull();
});

test("a confirmed disable of a profile with nothing applied saves the preference and touches no file", async () => {
  /*
   * willChange: false is a statement about the managed client document, and the plan says so. The
   * change still records the operator's desired sync preference for that profile, which happens
   * before any client document is touched, so the document and its history stay exactly as they
   * were while the preference is saved.
   */
  await seedRoster();
  const before = readFileSync(path(1), "utf8");
  const profileStoreBefore = treeWitness(join(root, "store", "aside-profiles", "1"));
  const rootStoreBefore = treeWitness(join(root, "store"));

  const preview = await api("/api/client-integrations/aside/profiles/1/preview", "POST", { operation: "disable" });
  expect(preview.status).toBe(200);
  const plan = await preview.json() as { canApply: boolean; willChange: boolean; fingerprint: string };
  expect(plan.canApply).toBe(true);
  expect(plan.willChange).toBe(false);

  const disabled = await api("/api/client-integrations/aside?profile=1", "PUT", {
    enabled: false, operation: "disable", planFingerprint: plan.fingerprint,
  });
  expect(disabled.status).toBe(200);

  // Nothing in the client's document or in either store moved.
  expect(readFileSync(path(1), "utf8")).toBe(before);
  expect(treeWitness(join(root, "store", "aside-profiles", "1"))).toBe(profileStoreBefore);
  expect(treeWitness(join(root, "store"))).toBe(rootStoreBefore);

  // The preference is the one thing that was written, and it is what the operator asked for.
  expect(saved?.asideProfileSync?.profiles?.["1"]).toBe(false);
  expect(config.asideProfileSync?.profiles?.["1"]).toBe(false);
});

test("a target edited while the preference is being saved is not overwritten by the old confirmation", async () => {
  /*
   * Aside takes no writer lock, and its preference write sits between the confirmation check and
   * the write that check authorizes. An overwrite does not ask the writer's own conflict question,
   * so without a second look the confirmation about the earlier file would land on the later one.
   */
  await seedRoster();
  const foreign = JSON.stringify({ theme: "keep", providers: { opencodex: { models: [{ id: "written-by-someone-else" }] } } });
  writeFileSync(path(1), foreign);

  const preview = await api("/api/client-integrations/aside/profiles/1/preview", "POST", { operation: "overwrite" });
  expect(preview.status).toBe(200);
  const plan = await preview.json() as { canApply: boolean; fingerprint: string };
  expect(plan.canApply).toBe(true);

  const edited = JSON.stringify({ theme: "edited-after-the-check", providers: { opencodex: { models: [{ id: "still-not-ours" }] } } });
  onPersist = () => { writeFileSync(path(1), edited); };

  const commit = await api("/api/client-integrations/aside?profile=1", "PUT", {
    enabled: true, overwriteConflict: true, operation: "overwrite", planFingerprint: plan.fingerprint,
  });

  expect(commit.status).toBe(409);
  expect((await commit.json() as { code: string }).code).toBe("integration_preview_stale");
  // The file the editor wrote is the file that is still there.
  expect(readFileSync(path(1), "utf8")).toBe(edited);
});

test("an unchanged target still commits the same confirmed overwrite", async () => {
  // The control for the case above: nothing moves in the window, and the confirmation stands.
  await seedRoster();
  writeFileSync(path(1), JSON.stringify({ theme: "keep", providers: { opencodex: { models: [{ id: "written-by-someone-else" }] } } }));

  const preview = await api("/api/client-integrations/aside/profiles/1/preview", "POST", { operation: "overwrite" });
  const plan = await preview.json() as { canApply: boolean; fingerprint: string };
  expect(plan.canApply).toBe(true);

  const commit = await api("/api/client-integrations/aside?profile=1", "PUT", {
    enabled: true, overwriteConflict: true, operation: "overwrite", planFingerprint: plan.fingerprint,
  });

  expect(commit.status).toBe(200);
  // The block that was there is the one the overwrite was for, and it is gone.
  expect(JSON.stringify(document(1))).not.toContain("written-by-someone-else");
  expect(document(1).providers.opencodex).toBeDefined();
});

test("a confirmed drift restore does not rewrite a target edited while preferences were saved", async () => {
  /*
   * Confirming drift says the operator accepted the difference they were shown. It does not say
   * they accepted one that appeared afterwards, and the snapshot checks say nothing about the
   * target file.
   *
   * The row is left only in the root store, so a restore that proceeded would copy it and its
   * snapshot into this profile's own store first. That copy is history, and the coordinated
   * restore cannot take it back: a refusal from inside it returns before the restore transaction
   * begins, so nothing compensates. The refusal therefore has to happen before the copy, and the
   * store witnesses below are what say it did.
   */
  const enabled = await (await api("/api/client-integrations/aside?profile=1", "PUT", { enabled: true })).json();
  expect(enabled.ok).toBe(true);
  const opId = enabled.opId as string;

  const profileStore = join(root, "store", "aside-profiles", "1");
  const snapshotName = join("snapshots", "aside", opId);
  writeFileSync(join(root, "store", "journal.jsonl"), readFileSync(join(profileStore, "journal.jsonl"), "utf8"));
  mkdirSync(join(root, "store", "snapshots", "aside"), { recursive: true });
  writeFileSync(join(root, "store", snapshotName), readFileSync(join(profileStore, snapshotName), "utf8"));
  rmSync(join(profileStore, snapshotName));

  writeFileSync(path(1), JSON.stringify({ theme: "drifted-before-the-preview" }));
  await seedRoster();
  const preview = await api("/api/client-integrations/aside/profiles/1/preview", "POST", {
    operation: "restore", opId, confirmDrift: true,
  });
  expect(preview.status).toBe(200);
  const plan = await preview.json() as { canApply: boolean; fingerprint: string };
  expect(plan.canApply).toBe(true);

  const profileStoreBefore = treeWitness(profileStore);
  const rootStoreBefore = treeWitness(join(root, "store"));
  const edited = JSON.stringify({ theme: "edited-after-the-check" });
  onPersist = () => { writeFileSync(path(1), edited); };

  const undo = await api("/api/client-integrations/aside/profiles/1/restore", "POST", {
    opId, operation: "restore", confirmDrift: true, planFingerprint: plan.fingerprint,
  });

  expect(undo.status).toBe(409);
  expect((await undo.json() as { code: string }).code).toBe("integration_preview_stale");
  // The editor's file is the one still there, and no history was written on the way to refusing.
  expect(readFileSync(path(1), "utf8")).toBe(edited);
  expect(treeWitness(profileStore)).toBe(profileStoreBefore);
  expect(treeWitness(join(root, "store"))).toBe(rootStoreBefore);
});

test("a target edited after the history copy is still not rewritten by the old confirmation", async () => {
  /*
   * The copy and the restore are two moments, and an edit can land between them: the coordinated
   * restore has no writer lock to hold one out, and it still awaits before beginning. The check
   * before the copy accepts the file as it was; the one inside the coordinated restore is what has
   * to see the file as it became.
   */
  const enabled = await (await api("/api/client-integrations/aside?profile=1", "PUT", { enabled: true })).json();
  expect(enabled.ok).toBe(true);
  const opId = enabled.opId as string;

  const profileStore = join(root, "store", "aside-profiles", "1");
  const snapshotName = join("snapshots", "aside", opId);
  writeFileSync(join(root, "store", "journal.jsonl"), readFileSync(join(profileStore, "journal.jsonl"), "utf8"));
  mkdirSync(join(root, "store", "snapshots", "aside"), { recursive: true });
  writeFileSync(join(root, "store", snapshotName), readFileSync(join(profileStore, snapshotName), "utf8"));
  rmSync(join(profileStore, snapshotName));

  writeFileSync(path(1), JSON.stringify({ theme: "drifted-before-the-preview" }));
  await seedRoster();
  const preview = await api("/api/client-integrations/aside/profiles/1/preview", "POST", {
    operation: "restore", opId, confirmDrift: true,
  });
  const plan = await preview.json() as { canApply: boolean; fingerprint: string };
  expect(plan.canApply).toBe(true);

  // The absent destination snapshot is the observable boundary. Neither restore preflight nor
  // either pre-import check can trigger the edit; only a read after the real copy can do so.
  const copiedSnapshotPath = join(profileStore, snapshotName);
  const sourceSnapshot = readFileSync(join(root, "store", snapshotName), "utf8");
  expect(existsSync(copiedSnapshotPath)).toBe(false);
  const edited = JSON.stringify({ theme: "edited-after-the-copy" });
  let editedAfterCopy = false;
  /*
   * A file-level seam only. The Aside layer rebinds the journal and record writers to the
   * profile's own store whatever io it is handed, so the history assertions below still describe
   * the store they name.
   */
  const base = defaultIntegrationIO(store);
  setIntegrationMutationFlightTestHooks({
    store,
    io: {
      ...base,
      readText: (target: string) => {
        if (target === path(1) && !editedAfterCopy && existsSync(copiedSnapshotPath)) {
          expect(readFileSync(copiedSnapshotPath, "utf8")).toBe(sourceSnapshot);
          editedAfterCopy = true;
          writeFileSync(path(1), edited);
        }
        return base.readText(target);
      },
    },
  });

  const undo = await api("/api/client-integrations/aside/profiles/1/restore", "POST", {
    opId, operation: "restore", confirmDrift: true, planFingerprint: plan.fingerprint,
  });

  expect(editedAfterCopy).toBe(true);
  expect(readFileSync(copiedSnapshotPath, "utf8")).toBe(sourceSnapshot);
  expect(saved?.asideProfileSync?.profiles?.["1"]).toBe(false);
  expect(undo.status).toBe(409);
  expect((await undo.json() as { code: string }).code).toBe("integration_preview_stale");
  // The editor's file survives: no restore transaction ran.
  expect(readFileSync(path(1), "utf8")).toBe(edited);
  // The copied history and the saved preference may remain; what must not is a restore row.
  const profileRows = readFileSync(join(profileStore, "journal.jsonl"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line) as { kind: string });
  expect(profileRows.some(row => row.kind === "restore")).toBe(false);
});
