import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildClientConfigText, buildClientContribution, buildQoderClientConfig, EXPORT_CLIENTS, qoderConfigPath, type ExportContext } from "../../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, disableIntegration, overwriteIntegration, refreshIntegration, restoreIntegration, type IntegrationWriteInput } from "../../src/integrations/writer";
import { previewIntegration } from "../../src/integrations/mutation-plan";
import { readIntegrationState } from "../../src/integrations/state";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { handleExportCommand } from "../../src/cli/export-command";
import { canonicalContribution, fingerprint, fragmentPathsOf, semanticContribution } from "../../src/integrations/ownership";
import type { ManagedContribution } from "../../src/clients/config-export";
import { handleManagementAPI } from "../../src/server/management-api";

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

function fixture(clientId: "qoder" | "qoder-cn" = "qoder") {
  const home = mkdtempSync(join(tmpdir(), "ocx-qoder-test-"));
  roots.push(home);
  const path = INTEGRATION_CLIENTS[clientId].configPath({}, home);
  mkdirSync(dirname(path), { recursive: true });
  const original = {
    theme: "dark", providers: { other: { type: "custom" } },
    modelConfigs: { selected: "other/model", customModels: [{ provider: "other", model: "mock/a", apiKey: "user-placeholder" }] },
  };
  const before = JSON.stringify(original, null, 4) + "\n";
  writeFileSync(path, before);
  const input: IntegrationWriteInput = {
    clientId, config, port: 10100, models: context.models,
    home, env: {}, store: createIntegrationStateStore(join(home, "store")),
  };
  return { path, original, before, input, read: () => JSON.parse(readFileSync(path, "utf8")) };
}

describe("Qoder client integration", () => {
  test("the export CLI writes Qoder JSON and refuses a remote placeholder without creating a file", async () => {
    const f = fixture();
    // The CLI asks the live management route, so the serving process's bind decides admission.
    const oldHome = process.env.OPENCODEX_HOME;
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.OPENCODEX_HOME = join(f.input.home!, "ocx");
    process.env.CODEX_HOME = join(f.input.home!, "codex");
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    const live = (hostname: string) => ({
      ...config, hostname,
      providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1", liveModels: false, models: ["a", "b"] } },
    }) as OcxConfig;
    let liveConfig = live("127.0.0.1");
    const server = Bun.serve({
      port: 0,
      fetch: async req => await handleManagementAPI(req, new URL(req.url), liveConfig) ?? new Response("not found", { status: 404 }),
    });
    const log = console.log;
    const error = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      const output = join(f.input.home!, "export.json");
      const deps = { baseUrl: `http://127.0.0.1:${server.port}`, configImpl: () => config };
      expect(await handleExportCommand(["--client", "qoder", "--out", output], deps)).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8")).providers.opencodex.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      const before = readFileSync(output, "utf8");
      liveConfig = live("0.0.0.0");
      expect(await handleExportCommand(["--client", "qoder", "--out", output, "--force"], deps)).not.toBe(0);
      expect(readFileSync(output, "utf8")).toBe(before);
    } finally {
      console.log = log;
      console.error = error;
      server.stop(true);
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
    }
  });

  test("QODER_CONFIG_DIR relocates both the written settings file and detection", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-qoder-dir-"));
    roots.push(root);
    const relocated = join(root, "relocated-qoder");
    const env = { QODER_CONFIG_DIR: relocated };
    expect(qoderConfigPath(env, "/home/test")).toBe(join(relocated, "settings.json"));
    expect(INTEGRATION_CLIENTS.qoder.detectDir(env, "/home/test")).toBe(relocated);
    expect(qoderConfigPath({ QODER_CONFIG_DIR: "~/q" }, "/home/test")).toBe(join("/home/test", "q", "settings.json"));
    expect(() => qoderConfigPath({ QODER_CONFIG_DIR: "relative/qoder" }, "/home/test")).toThrow("QODER_CONFIG_DIR");
    mkdirSync(relocated, { recursive: true });
    writeFileSync(join(relocated, "settings.json"), JSON.stringify({ theme: "dark" }));
    const input: IntegrationWriteInput = {
      clientId: "qoder", config, port: 10100, models: context.models,
      home: root, env, store: createIntegrationStateStore(join(root, "store")),
    };
    expect(applyIntegration(input).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(relocated, "settings.json"), "utf8")).providers.opencodex).toBeDefined();
    expect(existsSync(join(root, ".qoder"))).toBe(false);
    expect(disableIntegration(input).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(relocated, "settings.json"), "utf8"))).toEqual({ theme: "dark" });
  });

  test("exports only the provider catalog with normalized model order and context limits", () => {
    const doc = buildQoderClientConfig(context);
    expect(doc.providers.opencodex).toEqual({
      type: "openai-compatible", protocol: "openai", displayName: "opencodex",
      baseUrl: context.baseUrl, apiKey: "opencodex-loopback", defaultModel: "mock/a",
      models: [
        { model: "mock/a", displayName: "mock/a", contextWindow: 200000 },
        { model: "mock/b", displayName: "mock/b", contextWindow: 128000 },
      ],
    });
    expect(doc).not.toHaveProperty("modelConfigs");
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
    expect(f.read().modelConfigs.customModels).toHaveLength(1);
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

  test("provider model IDs do not require legacy array selectors", () => {
    const contribution = buildClientContribution("qoder", {
      ...context, models: [{ namespaced: "mock/a,b", provider: "mock", id: "a,b" }],
    });
    expect(contribution.fragments.map(fragment => fragment.path)).toEqual([["providers", "opencodex"]]);
  });

  test.each([false, true])("legacy refresh removes only owned duplicate rows (edited=%s)", edited => {
    const f = fixture();
    expect(applyIntegration(f.input).ok).toBe(true);
    const provider = {
      type: "openai-compatible", protocol: "openai", displayName: "opencodex",
      baseUrl: context.baseUrl, apiKey: "opencodex-loopback", defaultModel: "mock/a",
      models: [{ model: "mock/a" }, { model: "mock/b" }],
    };
    const legacyModels = [
      { provider: "opencodex", apiKey: "opencodex-loopback", model: "mock/a", baseURL: context.baseUrl, displayName: "mock/a", maxInputTokens: 200000 },
      { provider: "opencodex", apiKey: "opencodex-loopback", model: "mock/b", baseURL: context.baseUrl, displayName: "mock/b", maxInputTokens: 128000 },
    ];
    const legacy: ManagedContribution = {
      clientId: "qoder",
      fragments: [
        { path: ["providers", "opencodex"], value: provider },
        ...legacyModels.map(model => ({
          path: ["modelConfigs", "customModels", `[v2:provider=opencodex,model=${model.model}]`], value: model,
        })),
      ],
    };
    const document = f.read();
    document.providers.opencodex = provider;
    document.modelConfigs.customModels = [...f.original.modelConfigs.customModels, ...legacyModels];
    const text = JSON.stringify(document);
    writeFileSync(f.path, text);
    f.input.store!.putRecord({
      ...f.input.store!.readRecords().qoder!,
      fileFingerprint: fingerprint(text),
      blockFingerprint: fingerprint(canonicalContribution(legacy)),
      semanticBlockFingerprint: fingerprint(semanticContribution(legacy)),
      fragmentPaths: fragmentPathsOf(legacy),
    });
    if (edited) document.modelConfigs.customModels[1].maxInputTokens = 123456;
    else document.theme = "light";
    const before = JSON.stringify(document);
    writeFileSync(f.path, before);
    const result = refreshIntegration(f.input);
    if (edited) {
      expect(result).toMatchObject({ ok: false, reason: "conflict" });
      expect(readFileSync(f.path, "utf8")).toBe(before);
    } else {
      expect(result).toMatchObject({ ok: true });
      expect(f.read().modelConfigs.customModels).toEqual(f.original.modelConfigs.customModels);
      expect(f.read().providers.opencodex).toEqual(buildQoderClientConfig(context).providers.opencodex);
      expect(f.input.store!.readRecords().qoder!.fragmentPaths).toEqual([["providers", "opencodex"]]);
      expect(refreshIntegration(f.input)).toMatchObject({ ok: true, changed: false });
      expect(disableIntegration(f.input).ok).toBe(true);
      expect(f.read()).toEqual({ ...f.original, theme: "light" });
    }
  });

  for (const clientId of ["qoder", "qoder-cn"] as const) {
    const unowned = { provider: "opencodex", model: "mock/a", apiKey: "user-placeholder", displayName: "mine" };

    test.each([false, true])(`${clientId}: an unowned opencodex row for an exported model refuses before writing (recorded=%s)`, recorded => {
      const f = fixture(clientId);
      if (recorded) expect(applyIntegration(f.input).ok).toBe(true);
      const document = f.read();
      document.modelConfigs.customModels.push(unowned);
      const before = JSON.stringify(document, null, 2);
      writeFileSync(f.path, before);
      const records = JSON.stringify(f.input.store!.readRecords());
      expect(readIntegrationState(f.input)).toMatchObject({ state: "conflict", reason: "unowned-key" });
      for (const operation of ["apply", "overwrite", "disable"] as const) {
        expect(previewIntegration(f.input, { operation })).toMatchObject({ canApply: false, refusalReason: "conflict" });
      }
      const writes = recorded
        ? [refreshIntegration(f.input), applyIntegration(f.input), overwriteIntegration(f.input), disableIntegration(f.input)]
        : [applyIntegration(f.input), overwriteIntegration(f.input)];
      for (const result of writes) expect(result).toMatchObject({ ok: false, reason: "conflict", message: expect.stringContaining("modelConfigs.customModels") });
      expect(readFileSync(f.path, "utf8")).toBe(before);
      expect(JSON.stringify(f.input.store!.readRecords())).toBe(records);
    });

    test(`${clientId}: opencodex rows for other models and other providers' rows for exported models do not conflict`, () => {
      const f = fixture(clientId);
      const document = f.read();
      document.modelConfigs.customModels.push({ ...unowned, model: "mock/z" }, { ...unowned, provider: "elsewhere" });
      writeFileSync(f.path, JSON.stringify(document));
      expect(readIntegrationState(f.input)).toMatchObject({ state: "absent" });
      expect(applyIntegration(f.input)).toMatchObject({ ok: true, state: "current" });
      expect(f.read().modelConfigs.customModels).toEqual(document.modelConfigs.customModels);
      expect(disableIntegration(f.input).ok).toBe(true);
      expect(f.read()).toEqual(document);
    });
  }
});
