import { expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { armClaudeCodeBaseline, getConfigPath, getDefaultConfig, loadConfig, saveConfigPreservingClaudeCode } from "../../src/config";
import { readConfigDiagnostics } from "../../src/config/diagnostics";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { buildClaudeReplayConfig } from "../../src/server/claude-messages";
import { parseRequest } from "../../src/responses/parser";
import { planVisionSidecar, shouldResolveOpenAiVisionSidecar } from "../../src/vision/plan";
import { planWebSearch, shouldResolveOpenAiWebSearchSidecar } from "../../src/web-search";
import { createTempHome } from "../helpers/temp-home";

test("retired OpenCode Free entries and dependent routes are skipped on load, once per process", () => {
  const home = createTempHome("ocx-removed-provider-");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const provider = { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/v1", keyOptional: true };
    const raw = {
      ...getDefaultConfig(),
      defaultProvider: "opencode-free",
      providers: {
        "opencode-free": provider,
        typed: { ...provider, type: "opencode-free" },
        adapter: { ...provider, adapter: "opencode-free" },
        nestedPreset: { ...provider, preset: { id: "opencode-free" } },
        preset: { ...provider, presetId: "opencode-free" },
        healthy: { adapter: "openai-chat", baseUrl: "https://example.test/v1", defaultModel: "keep", note: "opencode-free" },
      },
      combos: {
        mixed: { targets: [{ provider: "opencode-free", model: "big-pickle" }, { provider: "healthy", model: "keep" }] },
        retired: { targets: [{ provider: "typed", model: "big-pickle" }] },
        dependentJudge: { strategy: "jev", decisionModel: "combo/judge", targets: [{ provider: "healthy", model: "keep" }] },
        judge: { strategy: "jev", decisionModel: "opencode-free/big-pickle", targets: [{ provider: "healthy", model: "keep" }] },
      },
      routingProfiles: {
        mixed: { candidates: [{ provider: "preset", model: "big-pickle" }, { provider: "healthy", model: "keep" }] },
        retired: { candidates: [{ provider: "opencode-free", model: "big-pickle" }] },
      },
      subagentModels: ["opencode-free/big-pickle", "healthy/keep"],
      subagentModelFallback: ["typed/big-pickle", "combo/retired", "policy/retired", "healthy/keep"],
      subagentModelFallbackByModel: { "opencode-free/big-pickle": ["healthy/keep"], "healthy/keep": ["preset/big-pickle", "healthy/keep"], "healthy/empty": ["preset/big-pickle"] },
      claudeCode: { enabled: false, subagentModelForce: "opencode-free/big-pickle", model: "opencode-free/big-pickle", tierModels: { opus: "healthy/keep" } },
      modelPickerOrder: ["opencode-free/big-pickle", "healthy/keep"],
    };
    const bytes = JSON.stringify(raw, null, 2);
    writeFileSync(getConfigPath(), bytes);
    const loaded = loadConfig();
    expect(Object.keys(loaded.providers).sort()).toEqual(["healthy", "openai"]);
    expect(loaded.defaultProvider).toBe("openai");
    expect(loaded.providers.healthy.defaultModel).toBe("keep");
    expect(loaded.providers.healthy.note).toBe("opencode-free");
    expect(loaded.combos).toEqual({ mixed: { targets: [{ provider: "healthy", model: "keep" }] } });
    expect(loaded.routingProfiles).toEqual({ mixed: { candidates: [{ provider: "healthy", model: "keep" }] } });
    expect(loaded.subagentModels).toEqual(["healthy/keep"]);
    expect(loaded.subagentModelFallback).toEqual(["healthy/keep"]);
    expect(loaded.subagentModelFallbackByModel).toEqual({ "healthy/keep": ["healthy/keep"] });
    expect(loaded.claudeCode?.subagentModelForce).toBeUndefined();
    expect(loaded.claudeCode?.model).toBeUndefined();
    expect(loaded.claudeCode?.tierModels).toEqual({ opus: "healthy/keep" });
    expect(loaded.modelPickerOrder).toEqual(["healthy/keep"]);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    expect(() => loadConfig()).not.toThrow();
    expect(readConfigDiagnostics().config.providers).toEqual(loaded.providers);
    const warnings = warn.mock.calls.filter(([message]) => String(message).includes("opencode-free support was removed"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]![0]).toContain("403");
    expect(warnings[0]![0]).toContain("#7255");
    expect(warnings[0]![0]).toContain("opencode-go");
    expect(warnings[0]![0]).not.toMatch(/\b\d+\.\d+\.\d+\b/);
    expect(PROVIDER_REGISTRY.some(entry => entry.id === "opencode-free")).toBe(false);
  } finally { warn.mockRestore(); home.remove(); }
});

function withLegacyConfig(patch: Record<string, unknown>, check: (bytes: string) => void): void {
  const home = createTempHome("ocx-removed-references-");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const bytes = JSON.stringify({
      ...getDefaultConfig(), defaultProvider: "healthy",
      providers: {
        "opencode-free": { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/v1", alias: " retired-alias " },
        healthy: { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
      },
      ...patch,
    });
    writeFileSync(getConfigPath(), bytes);
    check(bytes);
  } finally { warn.mockRestore(); home.remove(); }
}

test("retired desktop assignments repair defaults without losing healthy profile state", () => {
  const desktopProfile = {
    version: 1,
    assignments: {
      "opencode-free/opus": { family: "opus", alias: "claude-opus-4-8-20260101" },
      "opencode-free/fable": { family: "fable", alias: "claude-opus-4-8-20260102" },
      "opencode-free/haiku": { family: "haiku", alias: "claude-opus-4-8-20260103" },
      "healthy/z": { family: "opus", alias: "claude-opus-4-8-20260104" },
      "healthy/a": { family: "opus", alias: "claude-opus-4-8-20260105" },
      "healthy/sonnet": { family: "sonnet", alias: "claude-opus-4-8-20260106" },
      "healthy/haiku": { family: "haiku", alias: "claude-opus-4-8-20260107" },
    },
    defaults: { opus: "opencode-free/opus", fable: "opencode-free/fable", sonnet: "healthy/sonnet", haiku: "opencode-free/haiku" },
    appliedFingerprint: "preserved-marker", appliedAt: "2026-10-19T00:00:00Z",
  };
  withLegacyConfig({ claudeCode: { enabled: false, desktopProfile } }, bytes => {
    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("file");
    const expected = {
      ...desktopProfile,
      assignments: Object.fromEntries(Object.entries(desktopProfile.assignments).filter(([route]) => route.startsWith("healthy/"))),
      defaults: { opus: "healthy/a", fable: null, sonnet: "healthy/sonnet", haiku: "healthy/haiku" },
    };
    expect(diagnostics.config.claudeCode?.desktopProfile).toEqual(expected);
    expect(loadConfig().claudeCode?.desktopProfile).toEqual(expected);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
  });
});

test.each([false, true])("unrelated saves cannot resurrect retired Claude routes (healthy disk edit: %s)", diskEdit => {
  withLegacyConfig({ claudeCode: {
    enabled: false, model: "opencode-free/old", subagentModelForce: "retired-alias/old",
    tierModels: { opus: "healthy/keep" },
  } }, bytes => {
    const live = loadConfig();
    armClaudeCodeBaseline(live);
    expect(live.claudeCode?.model).toBeUndefined();
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    if (diskEdit) {
      const raw = JSON.parse(bytes);
      raw.claudeCode.tierModels.sonnet = "healthy/edited";
      writeFileSync(getConfigPath(), JSON.stringify(raw));
    }
    for (const fastMode of [true, false]) {
      live.fastMode = fastMode;
      saveConfigPreservingClaudeCode(live);
      expect(live.claudeCode?.model).toBeUndefined();
      expect(live.claudeCode?.subagentModelForce).toBeUndefined();
      expect(live.claudeCode?.tierModels).toEqual({ opus: "healthy/keep", ...(diskEdit ? { sonnet: "healthy/edited" } : {}) });
      const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8"));
      expect(persisted.claudeCode).toEqual(live.claudeCode);
      expect(persisted.fastMode).toBe(fastMode);
      expect(persisted.providers["opencode-free"]).toBeUndefined();
    }
  });
});

test.each([false, true])("retired source allowlists and injection dependencies load without degradation (mixed: %s)", mixed => {
  withLegacyConfig({
    compactionRouting: { model: "healthy/keep", sourceModels: ["opencode-free/*", ...(mixed ? ["healthy/*"] : [])] },
    injectionModel: "opencode-free/old", injectionEffort: "high", syncCodexSubagentDefaults: true,
  }, bytes => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 2; i++) {
        const loaded = loadConfig();
        expect(loaded.compactionRouting).toEqual(mixed ? { model: "healthy/keep", sourceModels: ["healthy/*"] } : undefined);
        expect(loaded.injectionModel).toBeUndefined();
        expect(loaded.injectionEffort).toBeUndefined();
        expect(loaded.syncCodexSubagentDefaults).toBeUndefined();
        expect(readConfigDiagnostics().source).toBe("file");
      }
      expect(warn.mock.calls.filter(([message]) => /compactionRouting|syncCodexSubagentDefaults/.test(String(message)))).toEqual([]);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    } finally { warn.mockRestore(); }
  });
});

test("all routed reference sites and whitespace aliases are pruned while healthy references remain", () => {
  withLegacyConfig({
    providers: {
      "opencode-free": { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/v1", alias: " retired-alias " },
      healthy: { adapter: "openai-chat", baseUrl: "https://example.test/v1", defaultModel: "retired-alias/old",
        autoReviewModel: "opencode-free/reviewer", autoReviewModelOverrides: {
          model: "retired-alias/reviewer", "opencode-free/source": "healthy/reviewer", keep: "healthy/reviewer",
        } },
    },
    combos: { retired: { alias: " retired-combo ", targets: [{ provider: "opencode-free", model: "old" }] } },
    codexRoleTiers: { fast: ["retired-alias/old", "healthy/keep"], standard: ["opencode-free/old"], frontier: ["retired-combo"] },
    visionSidecar: { backend: "routed", model: "retired-alias/old" },
    webSearchSidecar: { backend: "openai", model: "opencode-free/old" },
    shadowCallIntercept: { enabled: true, model: "healthy/keep", sourceModels: ["opencode-free/*", "healthy/*"] },
  }, bytes => {
    const loaded = loadConfig();
    expect(readConfigDiagnostics().source).toBe("file");
    expect(loaded.codexRoleTiers).toEqual({ fast: ["healthy/keep"], standard: [], frontier: [] });
    expect(loaded.visionSidecar).toEqual({ backend: "routed", enabled: false });
    expect(loaded.webSearchSidecar).toEqual({ backend: "openai", enabled: false });
    expect(loaded.shadowCallIntercept).toEqual({ enabled: true, model: "healthy/keep", sourceModels: ["healthy/*"] });
    expect(loaded.providers.healthy.defaultModel).toBeUndefined();
    expect(loaded.providers.healthy.autoReviewModel).toBeUndefined();
    expect(loaded.providers.healthy.autoReviewModelOverrides).toEqual({ keep: "healthy/reviewer" });
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
  });
  withLegacyConfig({ shadowCallIntercept: { enabled: true, model: "healthy/keep", sourceModels: ["opencode-free/*"] } }, () => {
    expect(loadConfig().shadowCallIntercept).toBeUndefined();
  });
});

test.each([false, true, undefined])("retired sidecar targets stay disabled through load, diagnostics and saves (enabled: %s)", enabled => {
  const routes = {
    combos: { retired: { alias: " retired-combo ", targets: [{ provider: "opencode-free", model: "old" }] } },
    routingProfiles: { retired: { alias: " retired-policy ", candidates: [{ provider: "opencode-free", model: "old" }] } },
  };
  for (const model of ["opencode-free/old", " retired-alias/old ", "combo/retired", "retired-combo", "policy/retired", "retired-policy"]) {
    const settings = { ...(enabled === undefined ? {} : { enabled }), model, timeoutMs: 12_345, reasoning: "low" };
    const vision = { ...settings, backend: "routed", maxDescriptionsPerTurn: 2 };
    const search = { ...settings, backend: "openai", maxSearchesPerTurn: 3 };
    withLegacyConfig({ ...routes, visionSidecar: vision, webSearchSidecar: search }, bytes => {
      const expectedVision = { backend: "routed", enabled: false, timeoutMs: 12_345, reasoning: "low", maxDescriptionsPerTurn: 2 };
      const expectedSearch = { backend: "openai", enabled: false, timeoutMs: 12_345, reasoning: "low", maxSearchesPerTurn: 3 };
      const live = loadConfig();
      const check = (config: ReturnType<typeof loadConfig>) => {
        expect(config.visionSidecar).toEqual(expectedVision);
        expect(config.webSearchSidecar).toEqual(expectedSearch);
      };
      check(live);
      const diagnostics = readConfigDiagnostics();
      expect(diagnostics.source).toBe("file");
      check(diagnostics.config);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
      armClaudeCodeBaseline(live);
      for (const fastMode of [true, false]) {
        live.fastMode = fastMode;
        saveConfigPreservingClaudeCode(live);
        check(live);
        check(JSON.parse(readFileSync(getConfigPath(), "utf8")));
        check(loadConfig());
        expect(loadConfig().fastMode).toBe(fastMode);
      }
    });
  }
}, 60_000);

test.each([false, true, undefined])("healthy sidecar settings keep their activation and targets (enabled: %s)", enabled => {
  const settings = { ...(enabled === undefined ? {} : { enabled }), model: "healthy/keep", reasoning: "low", timeoutMs: 12_345 };
  const visionSidecar = { ...settings, backend: "routed", maxDescriptionsPerTurn: 2 };
  const webSearchSidecar = { ...settings, backend: "openai", maxSearchesPerTurn: 3 };
  withLegacyConfig({ visionSidecar, webSearchSidecar }, bytes => {
    const live = loadConfig();
    expect(live.visionSidecar).toEqual(visionSidecar);
    expect(live.webSearchSidecar).toEqual(webSearchSidecar);
    expect(readConfigDiagnostics().config.visionSidecar).toEqual(visionSidecar);
    expect(readConfigDiagnostics().config.webSearchSidecar).toEqual(webSearchSidecar);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    armClaudeCodeBaseline(live);
    live.fastMode = true;
    saveConfigPreservingClaudeCode(live);
    expect(loadConfig().visionSidecar).toEqual(visionSidecar);
    expect(loadConfig().webSearchSidecar).toEqual(webSearchSidecar);
  });
});

test.each([false, true, undefined])("Claude retired overrides stay disabled without changing healthy globals (enabled: %s)", enabled => {
  const request = parseRequest({ model: "healthy/blind", tools: [{ type: "web_search" }], input: [{ role: "user", content: [
    { type: "input_text", text: "Describe and search." }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
  ] }] });
  const globalVision = { enabled: true, backend: "routed", model: "healthy/vision", timeoutMs: 12_345 };
  const globalSearch = { enabled: true, backend: "exa", model: "healthy/search", exaApiKey: "fixture-exa-key" };
  for (const globals of [false, true]) for (const model of ["opencode-free/old", " retired-alias/old ", "combo/retired", "retired-combo", "policy/retired", "retired-policy"]) {
    const activation = enabled === undefined ? {} : { enabled };
    withLegacyConfig({
      ...(globals ? { visionSidecar: globalVision, webSearchSidecar: globalSearch } : {}),
      combos: { retired: { alias: " retired-combo ", targets: [{ provider: "opencode-free", model: "old" }] } },
      routingProfiles: { retired: { alias: " retired-policy ", candidates: [{ provider: "opencode-free", model: "old" }] } },
      claudeCode: { enabled: true, visionSidecar: { ...activation, backend: "routed", model }, webSearchSidecar: { ...activation, backend: "openai", model } },
    }, bytes => {
      const live = loadConfig();
      live.providers.healthy!.modelInputModalities = { blind: ["text"], vision: ["text", "image"] };
      const check = (config: ReturnType<typeof loadConfig>) => {
        expect(config.visionSidecar).toEqual(globals ? globalVision : undefined);
        expect(config.webSearchSidecar).toEqual(globals ? globalSearch : undefined);
        expect(config.claudeCode?.visionSidecar).toEqual({ enabled: false, backend: "routed" });
        expect(config.claudeCode?.webSearchSidecar).toEqual({ enabled: false, backend: "openai" });
        const effective = buildClaudeReplayConfig(config);
        const provider = { ...config.providers.healthy!, noVisionModels: ["blind"] };
        expect(planVisionSidecar(effective, provider, "blind", request, undefined, { providerName: "healthy" })).toBeUndefined();
        expect(shouldResolveOpenAiVisionSidecar(effective, provider, "blind", request, "healthy")).toBe(false);
        expect(planWebSearch(effective, request, false, provider, "blind")).toBeUndefined();
        expect(shouldResolveOpenAiWebSearchSidecar(effective, request, false)).toBe(false);
      };
      check(live);
      expect(readConfigDiagnostics().source).toBe("file");
      check(readConfigDiagnostics().config);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
      // The same legitimate global/default config remains usable outside the Claude override.
      const provider = live.providers.healthy!;
      expect(planVisionSidecar(live, provider, "blind", request, undefined, { providerName: "healthy" })?.backend).toBe(globals ? "routed" : undefined);
      expect(planWebSearch(live, request, false, provider, "blind")?.backend).toBe(globals ? "exa" : undefined);
      expect(shouldResolveOpenAiVisionSidecar(live, provider, "blind", request, "healthy")).toBe(!globals);
      expect(shouldResolveOpenAiWebSearchSidecar(live, request, false)).toBe(!globals);
      armClaudeCodeBaseline(live);
      for (const fastMode of [true, false]) {
        live.fastMode = fastMode;
        saveConfigPreservingClaudeCode(live);
        check(live);
        check(JSON.parse(readFileSync(getConfigPath(), "utf8")));
        check(loadConfig());
      }
    });
  }
}, 60_000);

test("unrelated providers and config remain unchanged", () => {
  const home = createTempHome("ocx-retained-provider-");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const raw = getDefaultConfig();
    writeFileSync(getConfigPath(), JSON.stringify(raw));
    expect(loadConfig().providers).toEqual(raw.providers);
    expect(warn.mock.calls).toHaveLength(0);
  } finally { warn.mockRestore(); home.remove(); }
});
