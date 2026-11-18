import { describe, expect, spyOn, test } from "bun:test";
import { getDefaultConfig, validateConfigCandidate } from "../../src/config";
import { configDiagnosticsFromRaw } from "../../src/config/diagnostics";
import { configSchema } from "../../src/config/schema/config-schema";
import { warnDegradedTopLevelOptIns } from "../../src/config/load-degrade";
import { resolveRoutedCatalogDefaults } from "../../src/config/schema/routed-catalog-defaults";

// #6872: config-first defaults for routed catalog rows. The block accepts exactly the owner's
// allowlist; every other shape is refused on write and dropped (whole block) on read.
const invalid: unknown[] = [
  null, [], true, "high",
  { defaultVerbosity: "max" }, { defaultVerbosity: "LOW" }, { defaultVerbosity: null },
  // supportVerbosity is outside the owner's allowlist: verbosity support stays the provider's.
  { supportVerbosity: true }, { supportVerbosity: false }, { includeSkillsUsageInstructions: 1 },
  { includeAppsUsageInstructions: null }, { includePluginUsageInstructions: "yes" },
  // Serialized catalog spellings and fields outside the allowlist are unknown keys, not aliases.
  { include_skills_usage_instructions: true }, { supportsSearchTool: false },
  { truncationPolicy: { mode: "tokens", limit: 1 } }, { nodeReplAutoReviewRequired: true },
  { includeSkillsUsageInstructions: true, toolMode: "shell" },
];

describe("routedCatalogDefaults configuration", () => {
  test("an absent block resolves to no defaults", () => {
    expect(getDefaultConfig().routedCatalogDefaults).toBeUndefined();
    expect(resolveRoutedCatalogDefaults(getDefaultConfig())).toBeUndefined();
    expect(resolveRoutedCatalogDefaults({ routedCatalogDefaults: {} })).toBeUndefined();
  });

  test("valid blocks persist verbatim and explicit false stays false", () => {
    const block = {
      includeSkillsUsageInstructions: true,
      includeAppsUsageInstructions: false,
      includePluginUsageInstructions: false,
      defaultVerbosity: "medium" as const,
    };
    const parsed = validateConfigCandidate({ ...getDefaultConfig(), routedCatalogDefaults: block });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.routedCatalogDefaults).toEqual(block);
    expect(resolveRoutedCatalogDefaults(parsed.config)).toEqual(block);
  });

  test("defaultVerbosity accepts exactly low, medium and high", () => {
    for (const defaultVerbosity of ["low", "medium", "high"] as const) {
      const parsed = validateConfigCandidate({ ...getDefaultConfig(), routedCatalogDefaults: { defaultVerbosity } });
      expect(parsed.ok).toBe(true);
      expect(resolveRoutedCatalogDefaults({ routedCatalogDefaults: { defaultVerbosity } })).toEqual({ defaultVerbosity });
    }
  });

  test("invalid writes are refused while an invalid disk block falls back to today's derivation", () => {
    for (const block of invalid) {
      const candidate = { ...getDefaultConfig(), routedCatalogDefaults: block };
      const result = validateConfigCandidate(candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("routedCatalogDefaults");
      const parsed = configSchema.parse(candidate);
      expect(parsed.routedCatalogDefaults).toBeUndefined();
      expect(parsed.providers).toEqual(candidate.providers);
      expect(resolveRoutedCatalogDefaults(parsed)).toBeUndefined();
      // A synthetic config that bypassed the schema resolves the same way as the degraded read.
      expect(resolveRoutedCatalogDefaults({ routedCatalogDefaults: block } as never)).toBeUndefined();
      const diagnostics = configDiagnosticsFromRaw(JSON.stringify(candidate));
      expect(diagnostics.error).toBeNull();
      expect(diagnostics.warnings?.join(" ")).toContain("routedCatalogDefaults ignored");
    }
  });

  test("loading a malformed block warns instead of failing silently", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const raw = { ...getDefaultConfig(), routedCatalogDefaults: { defaultVerbosity: "max" } };
      warnDegradedTopLevelOptIns(raw, configSchema.parse(raw));
      expect(warning.mock.calls.some(call => String(call[0]).includes("invalid routedCatalogDefaults"))).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });

  test("the resolved value is a detached snapshot of the config", () => {
    const config = { routedCatalogDefaults: { includeSkillsUsageInstructions: true } };
    const resolved = resolveRoutedCatalogDefaults(config);
    config.routedCatalogDefaults.includeSkillsUsageInstructions = false;
    expect(resolved).toEqual({ includeSkillsUsageInstructions: true });
    expect(Object.isFrozen(resolved)).toBe(true);
  });
});
