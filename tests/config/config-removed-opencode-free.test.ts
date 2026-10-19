import { expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { getConfigPath, getDefaultConfig, loadConfig } from "../../src/config";
import { readConfigDiagnostics } from "../../src/config/diagnostics";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
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
    expect(PROVIDER_REGISTRY.some(entry => entry.id === "opencode-free")).toBe(false);
  } finally { warn.mockRestore(); home.remove(); }
});

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
