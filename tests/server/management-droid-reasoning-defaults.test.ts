import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { droidConfigPath, droidHomeDir } from "../../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { handleManagementAPI } from "../../src/server/management-api";
import { loadExportModels, resetExportSnapshotForTests } from "../../src/server/management/model-rows";
import { setIntegrationMutationFlightTestHooks, setIntegrationPathTestHooks } from "../../src/server/management/integration-routes";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const HEADER = "x-opencodex-droid-default-effort";
const routeEnv = {} as NodeJS.ProcessEnv;
let root: string;
let home: string;
let store: IntegrationStateStore;
let config: OcxConfig;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-management-droid-effort-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  store = createIntegrationStateStore(join(root, "store", "integrations"));
  config = {
    port: 10100, hostname: "127.0.0.1", defaultProvider: "a",
    providers: {
      a: {
        adapter: "openai-chat", baseUrl: "https://a.example/v1", liveModels: false,
        models: ["m1"], modelReasoningEfforts: { m1: ["low", "high"] },
      },
    },
  } as unknown as OcxConfig;
  resetExportSnapshotForTests();
  setIntegrationMutationFlightTestHooks({ store });
  setIntegrationPathTestHooks({ env: routeEnv, home });
});

afterEach(() => {
  resetExportSnapshotForTests();
  setIntegrationMutationFlightTestHooks(null);
  setIntegrationPathTestHooks(null);
  removeTreeWithRetry(root);
});

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const response = await handleManagementAPI(
    new Request(url, { ...init, headers: { Host: url.host, ...(init.headers ?? {}) } }),
    url,
    config,
    { saveConfigPreservingClaudeCode: () => {}, createManagementConvergeCodex: catalogConvergenceFactory() },
  );
  expect(response).not.toBeNull();
  return response!;
}

async function postPreview(body: unknown): Promise<Response> {
  return api("/api/client-integrations/preview", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

async function putDroid(body: unknown): Promise<Response> {
  return api("/api/client-integrations/droid", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

async function setupCatalog(): Promise<string> {
  await loadExportModels(config, [{ id: "m1", provider: "a", reasoningEfforts: ["low", "high"] }]);
  mkdirSync(droidHomeDir(routeEnv, home), { recursive: true });
  const path = droidConfigPath(routeEnv, home);
  writeFileSync(path, '{"customModels":[]}\n');
  return path;
}

describe("Droid reasoning defaults management contract", () => {
  test("preview binds the supplied map, commit persists it, and status projects owned values", async () => {
    const path = await setupCatalog();
    const defaults = { "a/m1": "high" };
    const preview = await postPreview({ clientId: "droid", operation: "apply", droidReasoningDefaults: defaults });
    expect(preview.status).toBe(200);
    const plan = await preview.json() as { canApply: boolean; fingerprint: string };
    expect(plan.canApply).toBe(true);

    const commit = await putDroid({ enabled: true, operation: "apply", planFingerprint: plan.fingerprint, droidReasoningDefaults: defaults });
    expect(commit.status).toBe(200);
    const settings = JSON.parse(readFileSync(path, "utf8")) as { customModels: Array<Record<string, unknown>> };
    expect(settings.customModels[0]).toMatchObject({ extraHeaders: { [HEADER]: "high" } });

    const status = await api("/api/client-integrations/droid");
    expect(status.status).toBe(200);
    const projected = await status.json() as {
      clientId: string; state: string;
      droidReasoning: { models: Array<{ model: string; label: string; efforts: string[] }>; defaults: Record<string, string> };
    };
    expect(projected.clientId).toBe("droid");
    expect(projected.state).toBe("current");
    expect(projected.droidReasoning.models.find(model => model.model === "a/m1")).toEqual({
      model: "a/m1", label: "M1", efforts: ["low", "high"],
    });
    expect(projected.droidReasoning.defaults).toEqual(defaults);
  });

  test("preview and commit reject undeclared models or efforts", async () => {
    await setupCatalog();
    for (const droidReasoningDefaults of [{ "a/missing": "high" }, { "a/m1": "medium" }]) {
      const preview = await postPreview({ clientId: "droid", operation: "apply", droidReasoningDefaults });
      expect(preview.status).toBe(400);
      expect(await preview.json()).toMatchObject({ code: "invalid_droid_reasoning_defaults" });
      const commit = await putDroid({ enabled: true, droidReasoningDefaults });
      expect(commit.status).toBe(400);
      expect(await commit.json()).toMatchObject({ code: "invalid_droid_reasoning_defaults" });
    }
  });

  test("changing the defaults after preview refuses the write", async () => {
    const path = await setupCatalog();
    const before = readFileSync(path, "utf8");
    const preview = await postPreview({
      clientId: "droid", operation: "apply", droidReasoningDefaults: { "a/m1": "high" },
    });
    expect(preview.status).toBe(200);
    const plan = await preview.json() as { fingerprint: string };
    const changed = await putDroid({
      enabled: true, operation: "apply", planFingerprint: plan.fingerprint,
      droidReasoningDefaults: { "a/m1": "low" },
    });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: "integration_preview_stale" });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(store.listOperations("droid")).toEqual([]);
  });

  test("the map is rejected for another client and for disable", async () => {
    await setupCatalog();
    const otherClient = await postPreview({ clientId: "dsh", operation: "apply", droidReasoningDefaults: {} });
    expect(otherClient.status).toBe(400);
    const disabled = await putDroid({ enabled: false, droidReasoningDefaults: {} });
    expect(disabled.status).toBe(400);
  });
});
