import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExportModel } from "../../src/clients/config-export";
import { refreshOwnedCatalogIntegrations } from "../../src/integrations/catalog-refresh";
import * as aside from "../../src/integrations/aside-profiles";
import * as owned from "../../src/integrations/owned-refresh";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, type IntegrationWriteInput } from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const models: ExportModel[] = ["alpha", "beta"].map(id => ({ namespaced: `mock/${id}`, provider: "mock", id, contextWindow: 128_000 }));
const original = JSON.stringify({ theme: "dark", providers: { personal: { models: [{ id: "mine" }] } } });
let root: string;
let home: string;
let store: IntegrationStateStore;
let config: OcxConfig;
let priorOcxHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-catalog-admission-"));
  home = join(root, "home");
  store = createIntegrationStateStore(join(root, "state", "integrations"));
  priorOcxHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = join(root, "config");
  for (const id of [0, 1]) {
    mkdirSync(dirname(profilePath(id)), { recursive: true });
    writeFileSync(profilePath(id), original);
  }
  writeFileSync(join(home, ".aside", "accounts.json"), JSON.stringify({
    currentAccountId: 0, accounts: [{ id: 0, name: "First" }, { id: 1, name: "Second" }],
  }));
  config = { port: 12345, hostname: "127.0.0.1", defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1" } },
    asideProfileSync: { allProfiles: true } } as OcxConfig;
});
afterEach(() => {
  if (priorOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = priorOcxHome;
  removeTreeWithRetry(root);
});

function profilePath(id: number): string { return join(home, ".aside", "u", String(id), "models.json"); }
function input() { return { config, models, port: 12345, env: {}, home, store }; }
function seedAside(): void { expect(applyIntegration({ ...input(), clientId: "aside" }).ok).toBe(true); }
function seedPi(): string {
  const spec = INTEGRATION_CLIENTS.pi;
  mkdirSync(spec.detectDir({}, home), { recursive: true });
  mkdirSync(dirname(spec.configPath({}, home)), { recursive: true });
  expect(applyIntegration({ ...input(), clientId: "pi" }).ok).toBe(true);
  return spec.configPath({}, home);
}

test("refreshOnly skips an enabled unowned Aside profile before loading models", async () => {
  let loads = 0;
  expect(await aside.refreshAsideProfiles({ ...input(), models: async () => { loads += 1; return models; } },
    { refreshOnly: true })).toEqual([]);
  expect(loads).toBe(0);
  expect([0, 1].map(id => readFileSync(profilePath(id), "utf8"))).toEqual([original, original]);
  expect(existsSync(store.root)).toBe(false);
});

test("catalog refreshOnly updates the owned Aside profile and leaves its unowned peer alone", async () => {
  seedAside();
  const outcomes = await refreshOwnedCatalogIntegrations({ ...input(), models: models.slice(0, 1) },
    ["aside"], { refreshOnly: true, admit: () => true });
  expect(outcomes).toEqual([{ client: "aside", profileId: 0, ok: true, changed: true }]);
  const doc = JSON.parse(readFileSync(profilePath(0), "utf8"));
  expect(doc.providers.opencodex.models.map((model: { id: string }) => model.id)).toEqual(["mock/alpha"]);
  expect(readFileSync(profilePath(1), "utf8")).toBe(original);
  expect(existsSync(join(store.root, "aside-profiles", "1"))).toBe(false);
});

test("false admission stops the catalog loop before model loading or any client write", async () => {
  seedAside();
  const piPath = seedPi();
  const before = [piPath, profilePath(0), profilePath(1)].map(path => readFileSync(path, "utf8"));
  const records = store.readRecords();
  const operations = store.listOperations();
  let loads = 0;
  expect(await refreshOwnedCatalogIntegrations({ ...input(), models: async () => { loads += 1; return []; } },
    ["pi", "aside"], { refreshOnly: true, admit: () => false })).toEqual([]);
  expect(loads).toBe(0);
  expect([piPath, profilePath(0), profilePath(1)].map(path => readFileSync(path, "utf8"))).toEqual(before);
  expect(store.readRecords()).toEqual(records);
  expect(store.listOperations()).toEqual(operations);
});

test.each(["pi", "aside"] as const)("admission lost during discovery refuses %s and stops later clients", async client => {
  seedAside();
  const piPath = seedPi();
  const before = [piPath, profilePath(0), profilePath(1)].map(path => readFileSync(path, "utf8"));
  const operations = store.listOperations();
  let admitted = true;
  let loads = 0;
  const outcomes = await refreshOwnedCatalogIntegrations({ ...input(), models: async () => {
    loads += 1;
    admitted = false;
    return models.slice(0, 1);
  } }, [client, client === "pi" ? "aside" : "pi"], { refreshOnly: true, admit: () => admitted });
  expect(outcomes).toEqual([{
    client, ok: false, reason: "Background refresh superseded", refusalReason: "superseded_store", state: "current",
    ...(client === "aside" ? { profileId: 0 } : {}),
  }]);
  expect(loads).toBe(1);
  expect([piPath, profilePath(0), profilePath(1)].map(path => readFileSync(path, "utf8"))).toEqual(before);
  expect(store.listOperations()).toEqual(operations);
});

test("Aside carries a synchronous guard refusal's profile identity even on first apply", async () => {
  const checked: string[] = [];
  const outcomes = await aside.refreshAsideProfiles(input(), { guard: (frozen: IntegrationWriteInput) => {
    checked.push(frozen.resolvedPaths!.configPath);
    return { ok: false, reason: "superseded_store", state: "current", clientId: frozen.clientId,
      message: "Background refresh superseded" };
  } });
  expect(checked).toEqual([profilePath(0), profilePath(1)]);
  expect(outcomes.map(row => [row.profileId, row.ok, row.refusalReason])).toEqual([
    [0, false, "superseded_store"], [1, false, "superseded_store"],
  ]);
  expect([0, 1].map(id => readFileSync(profilePath(id), "utf8"))).toEqual([original, original]);
  expect(existsSync(store.root)).toBe(false);
});

test("attended catalog refresh passes no guard and still first-applies enabled Aside profiles", async () => {
  seedPi();
  const refreshOwned = spyOn(owned, "refreshOwnedIntegration");
  const refreshAside = spyOn(aside, "refreshAsideProfiles");
  try {
    const outcomes = await refreshOwnedCatalogIntegrations(input(), ["pi", "aside"]);
    expect(refreshOwned.mock.calls).toHaveLength(1);
    expect(refreshOwned.mock.calls[0]).toHaveLength(1);
    expect(refreshAside.mock.calls).toHaveLength(1);
    expect(refreshAside.mock.calls[0]).toHaveLength(1);
    expect(outcomes.map(row => [row.client, row.profileId, row.ok])).toEqual([
      ["pi", undefined, true], ["aside", 0, true], ["aside", 1, true],
    ]);
    for (const id of [0, 1]) expect(readFileSync(profilePath(id), "utf8")).toContain("opencodex");
  } finally {
    refreshOwned.mockRestore();
    refreshAside.mockRestore();
  }
});
