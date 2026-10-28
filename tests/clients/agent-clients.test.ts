import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildClientConfigText, buildClientContribution, type ExportContext } from "../../src/clients/config-export";
import { agentConfigPath, agentHomeDir, workbuddyApplyRefusal } from "../../src/clients/config-export/agent-clients";
import { readIntegrationState } from "../../src/integrations/state";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, disableIntegration, refreshIntegration, restoreIntegration, type IntegrationWriteInput } from "../../src/integrations/writer";
import { canonicalSchemaPath } from "../../src/integrations/mutation-plan";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const config = { hostname: "127.0.0.1", port: 10100, defaultProvider: "mock", providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } } } as OcxConfig;
const context: ExportContext = { config, baseUrl: "http://127.0.0.1:10100/v1", models: [
  { namespaced: "mock/a", provider: "mock", id: "a", maxInputTokens: 24000, maxTokens: 8000, supportsTools: true, supportsReasoning: true, inputModalities: ["text", "image"] },
  { namespaced: "mock/b", provider: "mock", id: "b" },
] };
const clients = ["qoder-cn", "workbuddy", "workbuddy-ai"] as const;
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(removeTreeWithRetry); });

for (const id of clients) {
  test(`${id} uses an independent native path and refuses relative overrides`, () => {
    const home = join(tmpdir(), "agent-path-home");
    const filename = id === "qoder-cn" ? "settings.json" : "models.json";
    const key = id === "qoder-cn" ? "QODERCN_CONFIG_DIR" : "WORKBUDDY_CONFIG_DIR";
    expect(INTEGRATION_CLIENTS[id].configPath({}, home)).toBe(join(home, `.${id}`, filename));
    expect(agentConfigPath(id, { [key]: "~/custom" }, home)).toBe(join(home, "custom", filename));
    expect(agentHomeDir(id, { [key]: "~" }, home)).toBe(home);
    expect(() => agentConfigPath(id, { [key]: "relative" }, home)).toThrow(key);
    if (id !== "qoder-cn") expect(agentHomeDir(id, { WORKBUDDY_CONFIG_DIR: " ", CODEBUDDY_CONFIG_DIR: "~/legacy" }, home)).toBe(join(home, "legacy"));
  });

  test(`${id} refuses authenticated or remote placeholder export`, () => {
    for (const hostname of ["0.0.0.0", "::"]) expect(() => buildClientConfigText(id, { ...context, config: { ...config, hostname } })).toThrow("loopback");
    expect(() => buildClientConfigText(id, { ...context, baseUrl: "https://example.com/v1" })).toThrow("loopback");
  });

  for (const arrayRoot of id === "qoder-cn" ? [false] : [false, true]) {
    test(`${id} preserves foreign settings through apply, refresh, disable and byte-exact Undo (${arrayRoot ? "array" : "object"})`, async () => {
      const home = mkdtempSync(join(tmpdir(), "ocx-agent-client-")); roots.push(home);
      const path = agentConfigPath(id, {}, home); mkdirSync(dirname(path), { recursive: true });
      const foreign = { id: "foreign/a", vendor: "Other", name: "User model", url: "http://localhost:12000/v1/chat/completions" };
      const original = id === "qoder-cn" ? { theme: "dark", modelConfigs: { customModels: [{ provider: "other", model: "mock/a" }] } } : arrayRoot ? [foreign] : { theme: "dark", models: [foreign] };
      const before = JSON.stringify(original, null, 4) + "\n"; writeFileSync(path, before);
      const store = createIntegrationStateStore(join(home, "store"));
      const input: IntegrationWriteInput = { clientId: id, config, port: 10100, models: context.models, home, env: {}, store };
      expect((await applyIntegration(input)).ok).toBe(true);
      const opId = store.listOperations(id)[0]!.opId;
      const read = () => JSON.parse(readFileSync(path, "utf8"));
      const rows = (doc: any) => id === "qoder-cn" ? doc.providers.opencodex.models : arrayRoot ? doc : doc.models;
      expect(rows(read())).toHaveLength(id === "qoder-cn" ? 2 : 3);
      if (id !== "qoder-cn") expect(rows(read())[0]).toEqual(foreign);
      expect((await refreshIntegration({ ...input, models: context.models.slice(0, 1) })).ok).toBe(true);
      expect(rows(read())).toHaveLength(id === "qoder-cn" ? 1 : 2);
      expect((await disableIntegration(input)).ok).toBe(true);
      expect(read()).toEqual(original);
      expect((await restoreIntegration({ ...input, opId, confirmDrift: true })).ok).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(before);
    });
  }
}

test("WorkBuddy exports canonical selectors, full chat URL and declared capabilities only", () => {
  const doc = buildClientConfigText("workbuddy", context).document as { models: Record<string, unknown>[] };
  expect(doc.models[0]).toMatchObject({ id: "mock/a", name: "OpenCodex: mock/a", vendor: "OpenAI", url: `${context.baseUrl}/chat/completions`, supportsToolCall: true, supportsImages: true, supportsReasoning: true, maxInputTokens: 24000, maxOutputTokens: 8000 });
  expect(doc.models[1]).not.toHaveProperty("supportsToolCall");
  expect(doc.models[1]).not.toHaveProperty("maxInputTokens");
  expect(buildClientContribution("workbuddy", { ...context, models: [{ namespaced: "mock/a]", provider: "mock", id: "a]" }] }).fragments).toEqual([]);
  expect(workbuddyApplyRefusal({ ...context, document: { availableModels: ["foreign/a"] } })).toContain("availableModels");
  for (const client of clients) for (const fragment of buildClientContribution(client, context).fragments) {
    const path = canonicalSchemaPath(client, fragment.path);
    expect(path).not.toBeNull();
    expect(path).not.toContain("mock/a");
  }
});

test("WorkBuddy visibility restrictions refuse writes without breaking status or disable", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-workbuddy-filter-")); roots.push(home);
  const path = agentConfigPath("workbuddy", {}, home); mkdirSync(dirname(path), { recursive: true });
  const input: IntegrationWriteInput = { clientId: "workbuddy", config, port: 10100, models: context.models, home, env: {}, store: createIntegrationStateStore(join(home, "store")) };
  const before = JSON.stringify({ models: [], availableModels: ["foreign/a"] }); writeFileSync(path, before);
  const refused = applyIntegration(input);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.message).toContain("availableModels");
  expect(readFileSync(path, "utf8")).toBe(before);
  writeFileSync(path, JSON.stringify({ models: [] }));
  expect(applyIntegration(input).ok).toBe(true);
  const applied = JSON.parse(readFileSync(path, "utf8")); applied.availableModels = ["foreign/a"];
  writeFileSync(path, JSON.stringify(applied));
  expect(["current", "stale"]).toContain(readIntegrationState(input).state);
  expect(refreshIntegration(input).ok).toBe(false);
  expect(disableIntegration(input).ok).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ models: [], availableModels: ["foreign/a"] });
});
