import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildClientContribution, type ExportModel, type ManagedContribution } from "../../src/clients/config-export";
import { refreshOwnedCatalogIntegrations } from "../../src/integrations/catalog-refresh";
import { readPath } from "../../src/integrations/merge";
import { canonicalContribution, fingerprint, semanticContribution } from "../../src/integrations/ownership";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { readIntegrationState } from "../../src/integrations/state";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, disableIntegration, restoreIntegration } from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const clients = ["opencode", "kilo"] as const;
const config: OcxConfig = {
  port: 10100, hostname: "127.0.0.1", defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:10100/v1" } },
};
const models: ExportModel[] = [{
  namespaced: "mock/reasoner", provider: "mock", id: "reasoner", contextWindow: 100_000,
  maxTokens: 8_192, reasoningEfforts: ["none", "low", "high"], defaultReasoningEffort: "low",
  inputModalities: ["text", "image"],
}];
const original = '{\n  "model": "personal/model",\n  "mcp": {"personal": {"enabled": true}},\n  "provider": {"personal": {"name": "Keep me", "options": {"apiKey": "{env:PERSONAL_API_KEY}"}}}\n}\n';

describe("OpenCode and Kilo owned model configuration convergence", () => {
  let root: string;
  let home: string;
  let store: IntegrationStateStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-client-metadata-refresh-"));
    home = join(root, "home");
    store = createIntegrationStateStore(join(root, "state", "integrations"));
    for (const client of clients) {
      mkdirSync(INTEGRATION_CLIENTS[client].detectDir({}, home), { recursive: true });
      writeFileSync(INTEGRATION_CLIENTS[client].configPath({}, home), original);
    }
  });
  afterEach(() => removeTreeWithRetry(root));

  function input(clientId: typeof clients[number], roster = models) {
    return { clientId, config, models: roster, port: 10100, env: {}, home, store };
  }
  function document(client: typeof clients[number]): Record<string, any> {
    return JSON.parse(readFileSync(INTEGRATION_CLIENTS[client].configPath({}, home), "utf8"));
  }
  function expected(client: typeof clients[number], roster = models) {
    return buildClientContribution(client, { config, baseUrl: "http://127.0.0.1:10100/v1", models: roster });
  }

  test("unowned configs are untouched and do not load models", async () => {
    let loads = 0;
    expect(await refreshOwnedCatalogIntegrations({ ...input("opencode"), models: async () => {
      loads++;
      return models;
    } })).toEqual([]);
    expect(loads).toBe(0);
    for (const client of clients) expect(readFileSync(INTEGRATION_CLIENTS[client].configPath({}, home), "utf8")).toBe(original);
  });

  test("default fan-out refreshes both clients from one roster without choosing a model", async () => {
    for (const client of clients) expect(applyIntegration(input(client)).ok).toBe(true);
    const updated = models.map(model => ({ ...model, defaultReasoningEffort: "high", contextWindow: 90_000 }));
    let loads = 0;
    const outcomes = await refreshOwnedCatalogIntegrations({ ...input("opencode"), models: async () => {
      loads++;
      return updated;
    } });
    expect(outcomes).toEqual(clients.map(client => ({ client, ok: true, changed: true })));
    expect(loads).toBe(1);
    for (const client of clients) {
      expect(document(client)).toMatchObject(JSON.parse(original));
      for (const fragment of expected(client, updated).fragments) {
        expect(readPath(document(client), fragment.path)).toEqual(fragment.value);
      }
    }
  });

  test.each(clients)("an unchanged legacy %s block upgrades as stale, snapshots first and remains reversible", async client => {
    expect(applyIntegration(input(client)).ok).toBe(true);
    const legacy = structuredClone(expected(client)) as ManagedContribution;
    const doc = document(client);
    for (const fragment of legacy.fragments) {
      const provider = fragment.value as Record<string, any>;
      for (const entry of Object.values(provider.models) as Record<string, any>[]) {
        for (const key of Object.keys(entry)) {
          if (!["name", "limit", "attachment", "modalities"].includes(key)) delete entry[key];
        }
      }
      doc[fragment.path[0]!][fragment.path[1]!] = provider;
    }
    const path = INTEGRATION_CLIENTS[client].configPath({}, home);
    const legacyBytes = JSON.stringify(doc, null, 2) + "\n";
    writeFileSync(path, legacyBytes);
    const record = store.readRecords()[client]!;
    store.putRecord({ ...record, fileFingerprint: fingerprint(legacyBytes),
      blockFingerprint: fingerprint(canonicalContribution(legacy)),
      semanticBlockFingerprint: fingerprint(semanticContribution(legacy)) });
    expect(readIntegrationState(input(client)).state).toBe("stale");
    expect(await refreshOwnedCatalogIntegrations(input(client), [client]))
      .toEqual([{ client, ok: true, changed: true }]);
    const refreshOp = store.listOperations(client)[0]!;
    expect(store.readSnapshot(refreshOp)).toMatchObject({ kind: "stored", text: legacyBytes });
    expect(readIntegrationState(input(client)).state).toBe("current");
    expect(restoreIntegration({ ...input(client), opId: refreshOp.opId }).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(legacyBytes);
  });

  test.each(clients)("a hand-edited %s block is not overwritten or reported refreshed", async client => {
    expect(applyIntegration(input(client)).ok).toBe(true);
    const doc = document(client);
    doc.provider.opencodex.name = "User edited";
    const path = INTEGRATION_CLIENTS[client].configPath({}, home);
    const before = JSON.stringify(doc);
    writeFileSync(path, before);
    const outcome = await refreshOwnedCatalogIntegrations(input(client), [client]);
    expect(outcome).toHaveLength(1);
    expect(outcome[0]).toMatchObject({ client, ok: false, state: "conflict" });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test.each(clients)("disabling %s leaves personal settings and implicit refresh cannot reconnect it", async client => {
    expect(applyIntegration(input(client)).ok).toBe(true);
    expect(disableIntegration(input(client)).ok).toBe(true);
    expect(document(client)).toEqual(JSON.parse(original));
    expect(await refreshOwnedCatalogIntegrations(input(client), [client])).toEqual([]);
  });

  test.each(clients)("manually removing the owned %s block never causes implicit recreation", async client => {
    expect(applyIntegration(input(client)).ok).toBe(true);
    const path = INTEGRATION_CLIENTS[client].configPath({}, home);
    writeFileSync(path, original);
    expect(await refreshOwnedCatalogIntegrations(input(client), [client])).toEqual([{
      client, ok: true, changed: false, reason: "managed block is absent; refresh did not reconnect it",
    }]);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("a competing Kilo candidate refuses refresh without blocking OpenCode", async () => {
    for (const client of clients) expect(applyIntegration(input(client)).ok).toBe(true);
    const path = INTEGRATION_CLIENTS.kilo.configPath({}, home);
    const before = readFileSync(path, "utf8");
    writeFileSync(join(INTEGRATION_CLIENTS.kilo.detectDir({}, home), "config.json"), '{"provider":{"opencodex":{"name":"Competing"}}}');
    const updated = models.map(model => ({ ...model, defaultReasoningEffort: "high" }));
    const results = await refreshOwnedCatalogIntegrations(input("opencode", updated));
    expect(results[0]).toEqual({ client: "opencode", ok: true, changed: true });
    expect(results[1]).toMatchObject({ client: "kilo", ok: false, state: "conflict" });
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
