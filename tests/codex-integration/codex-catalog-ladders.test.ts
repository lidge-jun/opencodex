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
  buildCatalogEntries,
  mergeCatalogEntriesForSync,
  nativeEffortClamp,
  shouldApplyNativeEffortClamp,
} from "../../src/codex/catalog";

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
