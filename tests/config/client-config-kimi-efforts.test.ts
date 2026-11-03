import { describe, expect, test } from "bun:test";
import { buildClientConfig, kimiModelAlias, type ExportContext, type ExportModel, type KimiGeneratedConfig } from "../../src/clients/config-export";
import { serializeDocument } from "../../src/integrations/serialize";
import type { OcxConfig } from "../../src/types";

// #8095: the Kimi Code export dropped the declared effort ladder and default, so routed models
// such as kimi/k3.1-pro offered no thinking-effort selection in Kimi Code.
const base = { provider: "kimi", contextWindow: 1_048_576 };
const MODELS: ExportModel[] = [
  { ...base, namespaced: "kimi/k3.1-pro", id: "k3.1-pro", displayName: "K3.1 Pro", inputModalities: ["text", "image"],
    reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "low", supportsReasoningEffort: true },
  { ...base, namespaced: "kimi/ultra-ladder", id: "ultra-ladder", reasoningEfforts: ["ultra", "high", "Medium", "minimal", "high"], defaultReasoningEffort: "ultra" },
  { ...base, namespaced: "kimi/empty-ladder", id: "empty-ladder", reasoningEfforts: [], defaultReasoningEffort: "high" },
  { ...base, namespaced: "kimi/undeclared", id: "undeclared", inputModalities: ["text"] },
  { ...base, namespaced: "kimi/only-ultra", id: "only-ultra", reasoningEfforts: ["ultra"] },
  { ...base, namespaced: "kimi/no-effort", id: "no-effort", reasoningEfforts: ["low", "high"], supportsReasoningEffort: false },
  { ...base, namespaced: "kimi/no-reasoning", id: "no-reasoning", reasoningEfforts: ["low", "high"], supportsReasoning: false },
  { ...base, namespaced: "kimi/malformed", id: "malformed", reasoningEfforts: [7, "high", null] as unknown as string[], defaultReasoningEffort: 3 as unknown as string },
];
const config = { port: 10100, hostname: "127.0.0.1", defaultProvider: "kimi", providers: {} } as unknown as OcxConfig;
const ctx: ExportContext = { baseUrl: "http://127.0.0.1:10100/v1", models: MODELS, config };
const doc = () => buildClientConfig("kimi", ctx) as KimiGeneratedConfig;
const block = (namespaced: string) => doc().models[kimiModelAlias(namespaced)]!;

describe("kimi export declares effort metadata (#8095)", () => {
  test("a declared ladder and default become support_efforts, default_effort and thinking", () => {
    expect(block("kimi/k3.1-pro")).toEqual({
      provider: "opencodex", model: "kimi/k3.1-pro", max_context_size: 1_048_576, display_name: "K3.1 Pro",
      capabilities: ["thinking", "image_in"], support_efforts: ["low", "high", "max"], default_effort: "low",
    });
  });

  test("unsupported levels such as ultra are filtered, order follows Kimi, and a default outside the ladder is dropped", () => {
    const entry = block("kimi/ultra-ladder");
    expect(entry.support_efforts).toEqual(["medium", "high"]);
    expect(entry).not.toHaveProperty("default_effort");
    expect(entry.capabilities).toEqual(["thinking"]);
  });

  test.each(["kimi/empty-ladder", "kimi/undeclared", "kimi/only-ultra", "kimi/no-effort", "kimi/no-reasoning"])("%s gets no invented ladder or thinking capability", namespaced => {
    const entry = block(namespaced);
    expect(entry).not.toHaveProperty("support_efforts");
    expect(entry).not.toHaveProperty("default_effort");
    expect(entry).not.toHaveProperty("capabilities");
  });

  test("non-string ladder entries and defaults are ignored instead of failing the export", () => {
    expect(block("kimi/malformed")).toMatchObject({ support_efforts: ["high"], capabilities: ["thinking"] });
    expect(block("kimi/malformed")).not.toHaveProperty("default_effort");
  });

  test("the effort fields round-trip through TOML", () => {
    const text = serializeDocument(doc(), "toml");
    expect(text).toContain("support_efforts");
    expect(Bun.TOML.parse(text)).toEqual(doc() as unknown as Record<string, unknown>);
  });
});

