import type { OcxConfig } from "../../src/types";
import type { CatalogModel } from "../../src/codex/catalog";
import { loadExportModels } from "../../src/server/management/model-rows";

export function namingConfig(): OcxConfig {
  return {
    port: 10100, hostname: "127.0.0.1", defaultProvider: "acme", codexDirect: false,
    providers: {
      acme: { adapter: "openai-chat", baseUrl: "https://acme.example/v1", alias: "AC", liveModels: false,
        models: ["vendor/model-x", "model-y:free", "deep/nested/model-z"],
        modelAliases: { "vendor/model-x": "AC-model-x", "model-y:free": "AC-model-y-free" } },
      beta: { adapter: "openai-chat", baseUrl: "https://beta.example/v1", liveModels: false, models: ["model-x"] },
    },
    combos: { "AC-combo": { alias: "AC-combo", targets: [{ provider: "acme", model: "vendor/model-x" }] } },
  } as OcxConfig;
}

export async function namingModels(config: OcxConfig) {
  const roster = Object.entries(config.providers).flatMap(([provider, entry]) =>
    (entry.models ?? []).map(id => ({ provider, id, contextWindow: 100_000, maxOutputTokens: 8_000 })));
  roster.push({ provider: "combo", id: "AC-combo", alias: config.combos?.["AC-combo"]?.alias ?? "AC-combo" } as unknown as typeof roster[number]);
  return (await loadExportModels(config, roster as CatalogModel[])).filter(row => !row.native);
}

export const ROUTED_KEYS = ["AC-combo", "acme/deep-nested-model-z", "acme/model-y:free", "acme/vendor-model-x", "beta/model-x"].sort();
export const ALIAS_KEYS = ["AC-combo", "acme/deep-nested-model-z", "AC/AC-model-y-free", "AC/AC-model-x", "beta/model-x"].sort();

export function exportedKeys(client: "hermes" | "commandcode", document: unknown): string[] {
  type ProviderRoot = { opencodex: { models: Record<string, unknown> } };
  const root = document as { providers: ProviderRoot; provider?: ProviderRoot };
  return Object.keys((client === "hermes" ? root.providers : root.provider ?? root.providers).opencodex.models).sort();
}
