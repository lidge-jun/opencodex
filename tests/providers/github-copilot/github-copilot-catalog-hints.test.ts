import { beforeEach, describe, expect, test } from "bun:test";
import { captureProviderGather, type ModelsAuthResolver } from "../../../src/codex/catalog/gather-capture";
import { fetchProviderModelsWithAuth } from "../../../src/codex/catalog/provider-models";
import { clearModelCache } from "../../../src/codex/model-cache";
import { clearCopilotAutoModelsForTests, type CopilotModel } from "../../../src/providers/github-copilot-auto";
import type { OcxProviderConfig } from "../../../src/types";

const auth: ModelsAuthResolver = { kind: "observed", resolve: () => ({ apiKey: "synthetic-catalog-key", observed: true }) };
beforeEach(() => { clearModelCache("github-copilot"); clearCopilotAutoModelsForTests(); });

function fixture(mode: OcxProviderConfig["copilotModelSelection"], rows: CopilotModel[]) {
  let requests = 0;
  const provider: OcxProviderConfig = {
    adapter: "openai-chat", authMode: "key", baseUrl: "https://api.githubcopilot.com",
    copilotModelSelection: mode, models: ["live-model", "combo-model", "dropped-model"],
    retainModels: ["retained-model"],
    modelDisplayNames: { auto: "Configured Auto", "live-model": "Configured live" },
    modelContextWindows: { auto: 48_000, "live-model": 48_000, "retained-model": 40_000 },
    modelReasoningEfforts: { auto: ["low", "high"], "live-model": ["low", "high"] },
    modelCapabilities: { auto: { inputModalities: ["text", "image"] }, "live-model": { inputModalities: ["text", "image"] } },
    fetch: (async () => { requests++; return Response.json({ data: rows }); }) as typeof fetch,
  } as OcxProviderConfig;
  return { provider, requests: () => requests };
}
async function gather(provider: OcxProviderConfig) {
  const captured = captureProviderGather("github-copilot", provider, auth, new Set(["combo-model"]));
  return fetchProviderModelsWithAuth(captured, 60_000, 32_000, auth);
}
function expectHints(model: Awaited<ReturnType<typeof gather>>["models"][number], label: string) {
  expect(model.displayName).toBe(label);
  expect(model.contextWindow).toBe(32_000);
  expect(model.contextCap).toBe(32_000);
  expect(model.contextCapped).toBe(true);
  expect(model.reasoningEfforts).toEqual(["low", "high"]);
  expect(model.inputModalities).toEqual(["text", "image"]);
}

describe("Copilot catalog configuration projection", () => {
  test("forced Auto applies hints and cap without discovering or retaining named selectors", async () => {
    const { provider, requests } = fixture("auto", []);
    provider.liveModels = false;
    const result = await gather(provider);
    expect(result.outcome.state).toBe("authoritative");
    expect(result.models.map(model => model.id)).toEqual(["auto"]);
    expectHints(result.models[0]!, "Configured Auto");
    expect(requests()).toBe(0);
    expect(provider.models).toEqual(["live-model", "combo-model", "dropped-model"]);
    expect(provider.retainModels).toEqual(["retained-model"]);
  });

  test("detected Auto applies hints while saved retain/combo models stay out of the picker", async () => {
    const { provider, requests } = fixture("detect", [{ id: "live-model", model_picker_enabled: false }]);
    const result = await gather(provider);
    expect(result.models.map(model => model.id)).toEqual(["auto"]);
    expectHints(result.models[0]!, "Configured Auto");
    expect(requests()).toBe(1);
  });

  for (const mode of ["manual", "detect"] as const) {
    test(`${mode} discovery applies config hints/cap and retains explicit and combo selectors on warm reads`, async () => {
      const { provider, requests } = fixture(mode, [{ id: "live-model", model_picker_enabled: true,
        context_length: 128_000, capabilities: { vision: false } }]);
      for (let read = 0; read < 2; read++) {
        const result = await gather(provider);
        expect(result.outcome.state).toBe("authoritative");
        expect(result.models.map(model => model.id)).toEqual(["live-model", "combo-model", "retained-model"]);
        expectHints(result.models[0]!, "Configured live");
        expect(result.models.find(model => model.id === "retained-model")?.contextWindow).toBe(32_000);
      }
      expect(requests()).toBe(1);
    });
  }

  test("legacy discovery without permission metadata preserves the shared retention contract", async () => {
    const { provider } = fixture(undefined, [{ id: "live-model", context_length: 128_000 }]);
    const result = await gather(provider);
    expect(result.models.map(model => model.id)).toEqual(["live-model", "combo-model", "retained-model"]);
    expectHints(result.models[0]!, "Configured live");
  });
});
