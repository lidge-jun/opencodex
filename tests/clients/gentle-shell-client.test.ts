import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClientConfig, buildClientContribution, type ExportModel } from "../../src/clients/config-export";
import { refreshOwnedCatalogIntegrations } from "../../src/integrations/catalog-refresh";
import { previewIntegration } from "../../src/integrations/mutation-plan";
import { readIntegrationState } from "../../src/integrations/state";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, disableIntegration, restoreIntegration } from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const config: OcxConfig = {
  port: 10100, hostname: "127.0.0.1", defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:10100/v1" } },
};
const models: ExportModel[] = [{ namespaced: "mock/reasoner", provider: "mock", id: "reasoner",
  contextWindow: 128000, maxTokens: 8192, reasoningEfforts: ["low", "high"], inputModalities: ["text", "image"] }];
const original = '{"providers":{"personal":{"models":[]}},"settings":{"keep":true}}\n';
let home: string;
let path: string;
let pi: string;
let store: ReturnType<typeof createIntegrationStateStore>;
const input = () => ({ clientId: "gentle-shell" as const, config, models, port: 10100, env: {}, home, store });
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-gentle-connect-"));
  path = join(home, ".gentle-shell", "agent", "models.json");
  pi = join(home, ".pi", "agent", "models.json");
  mkdirSync(join(home, ".gentle-shell", "agent"), { recursive: true });
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(path, original);
  writeFileSync(pi, original);
  store = createIntegrationStateStore(join(home, "state", "integrations"));
});
afterEach(() => removeTreeWithRetry(home));

test("Gentle Shell export reuses Pi protocol and stamps independent ownership", () => {
  const ctx = { config, models, baseUrl: "http://127.0.0.1:10100/v1" };
  const document = buildClientConfig("gentle-shell", ctx);
  expect(document).toEqual(buildClientConfig("pi", ctx));
  expect(buildClientContribution("gentle-shell", ctx)).toEqual({
    ...buildClientContribution("pi", ctx), clientId: "gentle-shell",
  });
});

test("preview, enable, disable and restore preserve Pi and foreign settings", () => {
  const preview = previewIntegration(input(), { operation: "apply" });
  expect(preview.canApply).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(applyIntegration(input()).ok).toBe(true);
  expect(readIntegrationState(input()).state).toBe("current");
  const applied = readFileSync(path, "utf8");
  expect(JSON.parse(applied)).toMatchObject(JSON.parse(original));
  expect(disableIntegration(input()).ok).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(original));
  const operation = store.listOperations("gentle-shell")[0]!;
  expect(restoreIntegration({ ...input(), opId: operation.opId }).ok).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(applied);
  expect(readFileSync(pi, "utf8")).toBe(original);
});

test("default refresh touches only owned catalogs and preserves Pi ownership", async () => {
  let loads = 0;
  expect(await refreshOwnedCatalogIntegrations({ ...input(), models: () => { loads++; return models; } })).toEqual([]);
  expect(loads).toBe(0);
  expect(applyIntegration(input()).ok).toBe(true);
  expect(applyIntegration({ ...input(), clientId: "pi" }).ok).toBe(true);
  const piBefore = readIntegrationState({ ...input(), clientId: "pi" });
  const updated = [...models, { namespaced: "mock/new", provider: "mock", id: "new" }];
  expect(await refreshOwnedCatalogIntegrations({ ...input(), models: updated })).toEqual([
    { client: "pi", ok: true, changed: true }, { client: "gentle-shell", ok: true, changed: true },
  ]);
  expect(readIntegrationState({ ...input(), models: updated }).state).toBe("current");
  expect(readIntegrationState({ ...input(), clientId: "pi", models: updated }).state).toBe("current");
  expect(piBefore.state).toBe("current");
});

test("foreign edits and changed launcher home refuse without new operations", async () => {
  expect(applyIntegration(input()).ok).toBe(true);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  doc.providers.opencodex.baseUrl = "http://127.0.0.1:1234/v1";
  const edited = JSON.stringify(doc);
  writeFileSync(path, edited);
  const count = store.listOperations("gentle-shell").length;
  expect(await refreshOwnedCatalogIntegrations(input())).toMatchObject([{ client: "gentle-shell", ok: false }]);
  expect(readFileSync(path, "utf8")).toBe(edited);
  expect(store.listOperations("gentle-shell")).toHaveLength(count);
  writeFileSync(join(home, ".gentle-shell", "config.json"), '{"home":"link"}');
  expect(previewIntegration(input(), { operation: "apply" }).canApply).toBe(false);
  expect(applyIntegration(input()).ok).toBe(false);
  expect(readFileSync(pi, "utf8")).toBe(original);
  expect(readFileSync(path, "utf8")).toBe(edited);
  expect(store.listOperations("gentle-shell")).toHaveLength(count);
});
