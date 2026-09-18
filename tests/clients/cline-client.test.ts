import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildClientConfig, buildClientConfigText, buildClientContribution, clineConfigPath, EXPORT_CLIENTS, type ExportContext } from "../../src/clients/config-export";
import type { ClineGeneratedConfig } from "../../src/clients/config-export/cline";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { decodeClinePair, encodeClinePair, parseClineDocument, serializeClineDocument } from "../../src/integrations/cline-document";
import { PARSE_FAILED } from "../../src/integrations/config-io";

const context: ExportContext = {
  baseUrl: "http://127.0.0.1:10100/v1",
  models: [
    { namespaced: "mock/vision", provider: "mock", id: "vision", contextWindow: 200000, inputModalities: ["text", "image"] },
    { namespaced: "mock/unknown", provider: "mock", id: "unknown" },
    { namespaced: "mock/audio", provider: "mock", id: "audio", inputModalities: ["audio"] },
  ],
};

describe("Cline shared SDK store contract", () => {
  test("emits separate native documents with canonical selectors and no invented limits", () => {
    // Oracle: cline/cline cfe9cadab996, core/types/provider-settings.ts and local-provider-registry.ts.
    const doc = buildClientConfig("cline", context) as ClineGeneratedConfig;
    expect(doc.settings.version).toBe(1);
    expect(doc.settings.providers.opencodex!.settings).toEqual({ provider: "opencodex", protocol: "openai-responses", client: "openai", apiKey: "opencodex-loopback", baseUrl: context.baseUrl });
    expect(doc.settings).not.toHaveProperty("lastUsedProvider");
    expect(doc.catalog.providers.opencodex!.models).toEqual({
      "mock/vision": { name: "vision (mock)", contextWindow: 200000, modalities: { input: ["text", "image"], output: ["text"] }, supportsVision: true },
      "mock/unknown": { name: "unknown (mock)" },
    });
    expect(buildClientContribution("cline", context).fragments.map(f => f.path)).toEqual([
      ["settings", "providers", "opencodex"], ["catalog", "providers", "opencodex"],
    ]);
    expect(EXPORT_CLIENTS.cline.summarize(doc)).toEqual({ modelCount: 2, modelsWithoutLimits: 1 });
    expect(JSON.parse(buildClientConfigText("cline", context).text)).toEqual(doc);
  });

  test("honors the upstream path override order and refuses colliding/relative targets", () => {
    const home = join(process.cwd(), "synthetic-home");
    expect(clineConfigPath({}, home)).toBe(join(home, ".cline", "data", "settings", "providers.json"));
    expect(clineConfigPath({ CLINE_DIR: "~/root" }, home)).toBe(join(home, "root", "data", "settings", "providers.json"));
    expect(clineConfigPath({ CLINE_DIR: "~/root", CLINE_DATA_DIR: "~/data" }, home)).toBe(join(home, "data", "settings", "providers.json"));
    const env = { CLINE_PROVIDER_SETTINGS_PATH: "~/custom/provider.json", CLINE_DATA_DIR: "~/data", CLINE_DIR: "~/root" };
    expect(clineConfigPath(env, home)).toBe(join(home, "custom", "provider.json"));
    expect(INTEGRATION_CLIENTS.cline.detectDir(env, home)).toBe(join(home, "custom"));
    expect(() => clineConfigPath({ CLINE_DIR: "relative" }, home)).toThrow("CLINE_DIR");
    expect(() => clineConfigPath({ CLINE_PROVIDER_SETTINGS_PATH: "~/MODELS.JSON" }, home)).toThrow("must differ");
  });

  test("raw snapshots preserve whitespace and absence, while unsafe native data refuses", () => {
    const pair = { settings: '{ "version": 1, "providers": {} }\n', catalog: null };
    expect(decodeClinePair(encodeClinePair(pair))).toEqual(pair);
    expect(decodeClinePair(null)).toEqual({ settings: null, catalog: null });
    for (const settings of ['{"version":2}', '{"providers":[]}', '{"x":1,"x":2}', 'null', '{"x":1e999}']) {
      expect(parseClineDocument(encodeClinePair({ settings, catalog: null }))).toBe(PARSE_FAILED);
    }
    const doc = buildClientConfig("cline", context);
    expect(parseClineDocument(serializeClineDocument(doc))).toEqual(doc);
  });
});
