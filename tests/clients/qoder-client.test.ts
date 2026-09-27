import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildClientConfigText, buildClientContribution, buildQoderClientConfig, EXPORT_CLIENTS, qoderConfigPath, type ExportContext } from "../../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, disableIntegration, refreshIntegration, restoreIntegration, type IntegrationWriteInput } from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { handleExportCommand } from "../../src/cli/export-command";

const config = {
  port: 10100, hostname: "127.0.0.1", defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;
const context: ExportContext = {
  baseUrl: "http://127.0.0.1:10100/v1", config,
  models: [
    { namespaced: "mock/b", provider: "mock", id: "b" },
    { namespaced: "mock/a", provider: "mock", id: "a", contextWindow: 200000 },
  ],
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ocx-qoder-test-"));
  roots.push(home);
  const path = qoderConfigPath({}, home);
  mkdirSync(dirname(path), { recursive: true });
  const original = {
    theme: "dark", providers: { other: { type: "custom" } },
    modelConfigs: { selected: "other/model", customModels: [{ provider: "other", model: "mock/a", apiKey: "user-placeholder" }] },
  };
  const before = JSON.stringify(original, null, 4) + "\n";
  writeFileSync(path, before);
  const input: IntegrationWriteInput = {
    clientId: "qoder", config, port: 10100, models: context.models,
    home, env: {}, store: createIntegrationStateStore(join(home, "store")),
  };
  return { path, original, before, input, read: () => JSON.parse(readFileSync(path, "utf8")) };
}

describe("Qoder client integration", () => {
  test("the export CLI writes Qoder JSON and refuses a remote placeholder without creating a file", async () => {
    const f = fixture();
    const server = Bun.serve({ port: 0, fetch: () => Response.json(context.models) });
    const log = console.log;
    const error = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      const output = join(f.input.home!, "export.json");
      const deps = { baseUrl: `http://127.0.0.1:${server.port}`, configImpl: () => config };
      expect(await handleExportCommand(["--client", "qoder", "--out", output], deps)).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8")).providers.opencodex.baseUrl).toBe(`${deps.baseUrl}/v1`);
      const before = readFileSync(output, "utf8");
      expect(await handleExportCommand(["--client", "qoder", "--out", output, "--force"], {
        ...deps, configImpl: () => ({ ...config, hostname: "0.0.0.0" }),
      })).not.toBe(0);
      expect(readFileSync(output, "utf8")).toBe(before);
    } finally {
      console.log = log;
      console.error = error;
      server.stop(true);
    }
  });

  test("exports both JSON catalogs with the requested field casing and normalized model order", () => {
    const doc = buildQoderClientConfig(context);
    expect(doc.providers.opencodex).toEqual({
      type: "openai-compatible", protocol: "openai", displayName: "opencodex",
      baseUrl: context.baseUrl, apiKey: "opencodex-loopback", defaultModel: "mock/a",
      models: [{ model: "mock/a" }, { model: "mock/b" }],
    });
    expect(doc.modelConfigs.customModels).toEqual([
      { provider: "opencodex", apiKey: "opencodex-loopback", model: "mock/a", baseURL: context.baseUrl, displayName: "mock/a", maxInputTokens: 200000 },
      { provider: "opencodex", apiKey: "opencodex-loopback", model: "mock/b", baseURL: context.baseUrl, displayName: "mock/b", maxInputTokens: 128000 },
    ]);
    const exported = buildClientConfigText("qoder", context);
    expect(exported.format).toBe("json");
    expect(exported.mediaType).toContain("application/json");
    expect(JSON.parse(exported.text)).toEqual(doc);
    expect(EXPORT_CLIENTS.qoder.summarize(doc)).toEqual({ modelCount: 2, modelsWithoutLimits: 0 });
    expect(INTEGRATION_CLIENTS.qoder.configPath({}, "/home/test")).toBe(join("/home/test", ".qoder", "settings.json"));
    expect(buildQoderClientConfig({ ...context, models: [] }).providers.opencodex).not.toHaveProperty("defaultModel");
  });

  test("refuses placeholders on remote or wildcard binds, including a loopback dial address", () => {
    for (const hostname of ["0.0.0.0", "::", "192.0.2.1"]) {
      expect(() => buildClientConfigText("qoder", { ...context, config: { ...config, hostname } })).toThrow("loopback");
    }
    expect(() => buildQoderClientConfig({ ...context, baseUrl: "https://example.com/v1" })).toThrow("loopback");
    expect(() => buildQoderClientConfig({ ...context, config: undefined, baseUrl: "http://[::1]:10100/v1" })).not.toThrow();
  });

  test("apply and refresh preserve foreign providers and same-named custom models; disable removes owned entries", () => {
    const f = fixture();
    expect(applyIntegration(f.input).ok).toBe(true);
    const applied = f.read();
    applied.modelConfigs.customModels.reverse();
    applied.theme = "light";
    writeFileSync(f.path, JSON.stringify(applied));
    const updated = { ...f.input, models: [context.models[0]!] };
    expect(refreshIntegration(updated).ok).toBe(true);
    expect(f.read().modelConfigs.customModels).toHaveLength(2);
    expect(f.read().modelConfigs.customModels.find((m: { provider: string }) => m.provider === "other")).toEqual(f.original.modelConfigs.customModels[0]);
    expect(disableIntegration({ ...updated, config: { ...config, hostname: "0.0.0.0" } }).ok).toBe(true);
    expect(f.read()).toEqual({ ...f.original, theme: "light" });
  });

  test("restore recovers exact prior bytes, and non-loopback apply writes nothing", () => {
    const f = fixture();
    const refused = applyIntegration({ ...f.input, config: { ...config, hostname: "0.0.0.0" } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("non_loopback");
    expect(readFileSync(f.path, "utf8")).toBe(f.before);
    expect(applyIntegration(f.input).ok).toBe(true);
    const opId = f.input.store!.listOperations("qoder")[0]!.opId;
    expect(restoreIntegration({ ...f.input, opId }).ok).toBe(true);
    expect(readFileSync(f.path, "utf8")).toBe(f.before);
  });

  test("refuses ambiguous model selectors instead of owning another provider's entry", () => {
    expect(() => buildClientContribution("qoder", { ...context, models: [{ namespaced: "mock/a,b", provider: "mock", id: "a,b" }] })).toThrow("selector");
  });
});
