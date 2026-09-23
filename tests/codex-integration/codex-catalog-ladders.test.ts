/**
 * Pure catalog-ladder cases, held in a sibling file.
 *
 * Split out of codex-v2-gate.test.ts for the reason recorded in d3ca5522db and
 * #4908: that file sits at its file-size ratchet cap and the cap only ever moves
 * downward, so a case added after it was set fails the ratchet for every later
 * pull request. These two blocks were chosen because they call pure functions and
 * read no environment or module state, so moving them cannot change what they
 * assert. The cases are unchanged.
 */
import { describe, expect, test } from "bun:test";
import {
  CANONICAL_NATIVE_CATALOG_CONTENT_POLICY,
  buildCatalogEntries,
  mergeCatalogEntriesFromObservedState,
  mergeCatalogEntriesForSync,
  nativeEffortClamp,
  shouldApplyNativeEffortClamp,
} from "../../src/codex/catalog";
import type { ObservedCatalogMergeInput } from "../../src/codex/catalog";
import {
  applyConfigHintsToCachedModels,
  applyProviderConfigHints,
  suppressedSyntheticMaxCatalogSlugs,
} from "../../src/codex/catalog/model-hints";

function template(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.\nUse tools carefully.",
    model_messages: { instructions_template: "You are Codex, a coding agent based on GPT-5." },
    tool_mode: "code",
    supported_reasoning_levels: [
      { effort: "low", description: "l" }, { effort: "medium", description: "m" },
      { effort: "high", description: "h" }, { effort: "xhigh", description: "x" },
    ],
    default_reasoning_level: "medium",
  };
}

function efforts(entry: { supported_reasoning_levels?: unknown }): string[] {
  return (entry.supported_reasoning_levels as Array<{ effort: string }> ?? []).map(l => l.effort);
}

function mergeObserved(
  input: Pick<ObservedCatalogMergeInput, "catalogModels" | "routedEntries">
    & Partial<ObservedCatalogMergeInput>,
): Record<string, unknown>[] {
  return mergeCatalogEntriesFromObservedState({
    baselineCatalogModels: [],
    baseline: new Map(),
    featured: [],
    wsEnabled: false,
    template: template(),
    disabledModels: new Set(),
    selectedModelsByProvider: new Map(),
    gatheredProviderNames: new Set(),
    degradedProviderNames: new Set(),
    legacyCustomModelSlugs: new Set(),
    multiAgentMode: "default",
    multiAgentV2Enabled: false,
    exactComboSlugs: new Set(),
    hasPhysicalComboProvider: false,
    includeNativeOpenAi: true,
    accountBoundEntries: [],
    policy: {
      ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY,
      warningPolicy: "emit",
    },
    ...input,
  });
}

describe("synthetic max suppression", () => {
  test("resolves discovered, cached, case-folded, and family-key model settings", () => {
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://relay.example.test/v1",
      modelSuppressSyntheticMax: { "MODEL-A": true, family: true },
    };
    expect(applyProviderConfigHints("relay", provider, {
      id: "model-a",
      provider: "relay",
    }).suppressSyntheticMax).toBe(true);
    expect(applyConfigHintsToCachedModels("relay", provider, [{
      id: "family:latest",
      provider: "relay",
    }])[0]?.suppressSyntheticMax).toBe(true);
    expect([...suppressedSyntheticMaxCatalogSlugs(
      { providers: { relay: provider } },
      [],
      [{ slug: "relay/family:latest" }],
    )]).toContain("relay/family:latest");
  });

  test("suppresses only missing routed max, retains ultra and declared max, and clamps a missing max default", () => {
    const routed = [
      { id: "ordinary", provider: "relay", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
      {
        id: "suppressed",
        provider: "relay",
        reasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "max",
        suppressSyntheticMax: true,
      },
      {
        id: "declared-max",
        provider: "relay",
        reasoningEfforts: ["low", "high", "max"],
        defaultReasoningEffort: "max",
        suppressSyntheticMax: true,
      },
    ];
    const entries = buildCatalogEntries(template(), ["gpt-5.5"], routed as never, [], false);
    const ordinary = entries.find(entry => entry.slug === "relay/ordinary")!;
    const suppressed = entries.find(entry => entry.slug === "relay/suppressed")!;
    const declared = entries.find(entry => entry.slug === "relay/declared-max")!;
    const native = entries.find(entry => entry.slug === "gpt-5.5")!;

    expect(efforts(ordinary)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(efforts(suppressed)).toEqual(["low", "medium", "high", "xhigh", "ultra"]);
    expect(suppressed.default_reasoning_level).toBe("xhigh");
    expect(efforts(declared)).toEqual(["low", "high", "max", "ultra"]);
    expect(declared.default_reasoning_level).toBe("max");
    expect(efforts(native)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  test("observed-state repair does not re-add max to a suppressed preserved routed row", () => {
    const disk = {
      ...template(),
      slug: "relay/suppressed",
      display_name: "relay/suppressed",
      supported_reasoning_levels: [
        { effort: "low", description: "l" },
        { effort: "high", description: "h" },
        { effort: "xhigh", description: "x" },
        { effort: "ultra", description: "u" },
      ],
      default_reasoning_level: "max",
    };
    const diskWithMax = {
      ...disk,
      slug: "relay/preserved-max",
      display_name: "relay/preserved-max",
      supported_reasoning_levels: [
        ...disk.supported_reasoning_levels,
        { effort: "max", description: "m" },
      ],
    };
    const merged = mergeObserved({
      catalogModels: [disk, diskWithMax],
      routedEntries: [],
      gatheredProviderNames: new Set(["relay"]),
      degradedProviderNames: new Set(["relay"]),
      suppressedSyntheticMaxSlugs: suppressedSyntheticMaxCatalogSlugs({
        providers: {
          relay: {
            adapter: "openai-chat",
            baseUrl: "https://relay.example.test/v1",
            modelSuppressSyntheticMax: { suppressed: true, "preserved-max": true },
          },
        },
      }, [], [disk, diskWithMax]),
    });
    const preserved = merged.find(entry => entry.slug === "relay/suppressed")!;
    const preservedMax = merged.find(entry => entry.slug === "relay/preserved-max")!;

    expect(efforts(preserved)).toEqual(["low", "high", "xhigh", "ultra"]);
    expect(preserved.default_reasoning_level).toBe("xhigh");
    expect(efforts(preservedMax)).toContain("max");
    expect(preservedMax.default_reasoning_level).toBe("max");
  });
});
describe("catalog ultra (always-on)", () => {
  const routed = [{ id: "glm-5.2", provider: "opencode-go", reasoningEfforts: ["low", "medium", "high", "xhigh"] }];

  test("Go keeps declared efforts while old natives retain mock tiers", () => {
    const entries = buildCatalogEntries(template(), ["gpt-5.5"], routed as never, [], false);
    const native = entries.find(e => e.slug === "gpt-5.5")!;
    const glm = entries.find(e => e.slug === "opencode-go/glm-5.2")!;
    expect(efforts(native)).toContain("ultra");
    expect(efforts(native)).toContain("max");
    expect(efforts(glm)).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("gpt-5.6-sol keeps native ultra + max; luna has max but no native ultra (upstream ladder)", () => {
    const entries = buildCatalogEntries(template(), ["gpt-5.6-sol", "gpt-5.6-luna"], [], [], false);
    const sol = entries.find(e => e.slug === "gpt-5.6-sol")!;
    const luna = entries.find(e => e.slug === "gpt-5.6-luna")!;
    expect(efforts(sol)).toContain("max");
    expect(efforts(sol)).toContain("ultra");
    expect(efforts(luna)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("sync preserves genuine native entries with ultra intact", () => {
    const diskSol = {
      ...template(),
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      supported_reasoning_levels: [
        { effort: "high", description: "h" }, { effort: "max", description: "m" }, { effort: "ultra", description: "u" },
      ],
      default_reasoning_level: "ultra",
    };
    const merged = mergeCatalogEntriesForSync([diskSol as never], [], new Map(), [], false);
    const sol = merged.find(e => e.slug === "gpt-5.6-sol")!;
    expect(efforts(sol)).toContain("ultra");
    expect(efforts(sol)).toContain("max");
    expect(sol.default_reasoning_level).toBe("ultra"); // preserved as-is
  });
});

describe("mock-max wire clamp (nativeEffortClamp)", () => {
  test("gpt-5.5 max/ultra clamp to its real top rung (xhigh)", () => {
    expect(nativeEffortClamp("gpt-5.5", "max")).toBe("xhigh");
    expect(nativeEffortClamp("gpt-5.5", "ultra")).toBe("xhigh");
  });

  test("real-max natives are untouched", () => {
    expect(nativeEffortClamp("gpt-5.6-sol", "max")).toBe(null);
    expect(nativeEffortClamp("gpt-5.6-luna", "max")).toBe(null);
  });

  test("only the canonical built-in OpenAI forward route enters the native clamp gate", () => {
    const nativeProvider = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
    } as const;
    const routedProvider = {
      adapter: "openai-chat",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      authMode: "key",
      apiKey: "dashscope-test",
    } as const;

    expect(shouldApplyNativeEffortClamp("openai", nativeProvider as never, "gpt-5.5")).toBe(true);
    expect(shouldApplyNativeEffortClamp("bailian", routedProvider as never, "glm-5.2-fast-preview")).toBe(false);
    expect(shouldApplyNativeEffortClamp("bailian", routedProvider as never, "bailian/glm-5.2-fast-preview")).toBe(false);
  });

  test("ordinary efforts and routed slugs pass through; unknown BARE natives clamp conservatively", () => {
    expect(nativeEffortClamp("gpt-5.5", "high")).toBe(null);
    expect(nativeEffortClamp("gpt-5.5", undefined)).toBe(null);
    expect(nativeEffortClamp("opencode-go/glm-5.2", "max")).toBe(null);
    // off-snapshot bare native = old low..xhigh ladder -> clamp; future 5.6 variants stay free
    expect(nativeEffortClamp("gpt-totally-unknown", "max")).toBe("xhigh");
    expect(nativeEffortClamp("gpt-5.6-future", "max")).toBe(null);
  });
});
