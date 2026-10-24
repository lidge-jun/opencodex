import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXPORT_CLIENTS, qoderConfigPath } from "../../src/clients/config-export";
import { UnrepresentableSelectorError } from "../../src/integrations/merge";
import { INTEGRATION_CLIENT_IDS } from "../../src/integrations/registry";
import { readIntegrationState } from "../../src/integrations/state";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { handleManagementAPI } from "../../src/server/management-api";
import { setIntegrationMutationFlightTestHooks, setIntegrationPathTestHooks } from "../../src/server/management/integration-routes";
import { resetExportSnapshotForTests } from "../../src/server/management/model-rows";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root: string;
let home: string;
let config: OcxConfig;
let store: ReturnType<typeof createIntegrationStateStore>;
let server: ReturnType<typeof Bun.serve>;
let persisted: number;

function witness(): string {
  return readdirSync(root, { recursive: true }).map(String).sort().map(path => {
    const full = join(root, path);
    return statSync(full).isDirectory() ? `${path}/` : `${path}:${readFileSync(full, "utf8")}`;
  }).join("\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-qoder-selector-state-"));
  home = join(root, "home");
  mkdirSync(home);
  store = createIntegrationStateStore(join(root, "integrations"));
  persisted = 0;
  config = {
    port: 10100, hostname: "127.0.0.1", defaultProvider: "fixture",
    providers: { fixture: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1", liveModels: false, models: ["k3"] } },
  } as OcxConfig;
  setIntegrationPathTestHooks({ home, env: {} });
  setIntegrationMutationFlightTestHooks({ store });
  resetExportSnapshotForTests();
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async req => await handleManagementAPI(req, new URL(req.url), config, {
      saveConfigPreservingClaudeCode: () => { persisted += 1; },
      createManagementConvergeCodex: catalogConvergenceFactory(),
    }) ?? new Response("not found", { status: 404 }),
  });
});

afterEach(async () => {
  await server.stop(true);
  setIntegrationPathTestHooks(null);
  setIntegrationMutationFlightTestHooks(null);
  resetExportSnapshotForTests();
  removeTreeWithRetry(root);
});

function api(path = "", body?: unknown) {
  return fetch(new URL(`/api/client-integrations${path}`, server.url), body === undefined ? undefined : {
    method: path === "/qoder" ? "PUT" : "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

for (const model of ["k3[1m]", "k3,other"]) {
  test(`a selector-hostile Qoder model (${model}) does not break collection or single status`, async () => {
    const control = await (await api("/hermes")).json();
    config.providers.fixture!.models = ["k3", model];
    const before = witness();
    const response = await api();
    expect(response.status).toBe(200);
    const { clients } = await response.json() as { clients: Array<{ clientId: string }> };
    expect(clients.map(client => client.clientId)).toEqual(INTEGRATION_CLIENT_IDS);
    const qoder = clients.find(client => client.clientId === "qoder");
    // The provider-only catalog needs no array selector, so the ID is ordinary.
    expect(qoder).toMatchObject({
      state: "absent", installed: false,
      configPath: qoderConfigPath({}, home), snapshotCount: 0, retentionDegraded: false,
    });
    expect(clients.find(client => client.clientId === "hermes")).toEqual(control);
    const single = await api("/qoder");
    expect(single.status).toBe(200);
    expect(await single.json()).toEqual(qoder);
    expect(witness()).toBe(before);
    expect(persisted).toBe(0);
  });
}

for (const operation of ["apply", "overwrite", "disable"] as const) for (const surface of ["preview", "mutation"] as const) test(`a typed selector refusal stays unsafe in ${operation} ${surface}`, async () => {
  const path = qoderConfigPath({}, home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ theme: "user-owned" }));
  const builder = spyOn(EXPORT_CLIENTS.qoder, "buildContribution").mockImplementation(() => {
    throw new UnrepresentableSelectorError("fixture cannot name its owned element");
  });
  try {
    const before = witness();
    const response = await api(); // Also populates the authoritative preview roster.
    expect(response.status).toBe(200);
    const { clients } = await response.json() as { clients: Array<{ clientId: string }> };
    expect(clients.map(client => client.clientId)).toEqual(INTEGRATION_CLIENT_IDS);
    expect(await (await api("/qoder")).json()).toMatchObject({
      state: "unsafe", reason: "unresolvable-path", installed: true, configPath: path,
    });
    if (surface === "preview") {
      const preview = await api("/preview", { clientId: "qoder", operation });
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({ canApply: false, willChange: false, state: "unsafe", refusalReason: "unsafe" });
    } else {
      const mutation = await api("/qoder", { enabled: operation !== "disable", overwriteConflict: operation === "overwrite" });
      expect(mutation.status).toBe(409);
      expect(await mutation.json()).toMatchObject({ code: "integration_unsafe", reason: "unsafe", state: "unsafe" });
    }
    expect(witness()).toBe(before);
    expect(persisted).toBe(0);
  } finally {
    builder.mockRestore();
  }
});

test("Qoder catalogs with selector-hostile IDs support status, preview and apply", async () => {
  mkdirSync(dirname(qoderConfigPath({}, home)), { recursive: true });
  config.providers.fixture!.models = ["k3", "k3[1m]"];
  expect((await api()).status).toBe(200);
  expect(await (await api("/qoder")).json()).toMatchObject({ state: "absent", installed: true });
  const preview = await api("/preview", { clientId: "qoder", operation: "apply" });
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({ canApply: true });
  expect((await api("/qoder", { enabled: true })).status).toBe(200);
  expect(await (await api("/qoder")).json()).toMatchObject({ state: "current" });
  const written = JSON.parse(readFileSync(qoderConfigPath({}, home), "utf8"));
  expect(written.providers.opencodex.models.map((row: { model: string }) => row.model)).toEqual(expect.arrayContaining(["fixture/k3", "fixture/k3[1m]"]));
  expect(written).not.toHaveProperty("modelConfigs");
});

test("unexpected contribution errors still propagate instead of becoming unsafe refusals", async () => {
  mkdirSync(dirname(qoderConfigPath({}, home)), { recursive: true });
  expect((await api()).status).toBe(200);
  const error = new Error("unexpected builder failure");
  const builder = spyOn(EXPORT_CLIENTS.qoder, "buildContribution").mockImplementation(() => { throw error; });
  try {
    expect(() => readIntegrationState({ clientId: "qoder", config, port: 10100, models: [], home, env: {}, store })).toThrow(error);
    const before = witness();
    const preview = await api("/preview", { clientId: "qoder", operation: "apply" });
    expect(preview.status).toBe(500);
    expect(await preview.json()).toMatchObject({ code: "integration_internal_error", error: error.message });
    for (const enabled of [true, false]) {
      const mutation = await api("/qoder", { enabled });
      expect(mutation.status).toBe(500);
      expect(await mutation.json()).toMatchObject({ code: "integration_internal_error", error: error.message });
    }
    expect(witness()).toBe(before);
    expect(persisted).toBe(0);
  } finally {
    builder.mockRestore();
  }
});
