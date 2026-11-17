import { describe, expect, test } from "bun:test";
import { buildCatalogEntriesFromObservedState } from "../../src/codex/catalog/sync";
import { modelPickerOrder } from "../../src/cli/model-picker-ordering";
import { modelFamily } from "../../src/lib/model-families";
import type { CatalogModel } from "../../src/types";

// The Codex catalog has no group field: a picker "group" is a contiguous run of `priority`.
// Mode `family` saves a complete routed order, and the catalog turns that order into priorities.

const routed = [
  ["jd-chat", "glm-5.2"], ["tyler", "deepseek-v4-pro"], ["agy", "gemini-3.8-flash"], ["jd-claude", "sonnet-5"],
  ["xai", "grok-4.7"], ["jd-gpt", "gpt-6.1-sol"], ["agy", "claude-opus-5-5"], ["jd-chat", "kimi-k3"],
  ["jd-gpt", "gpt-6-luna"], ["local", "mystery-1"], ["agy", "gemini-3.8-pro"],
].map(([provider, id]) => ({ id, provider, owned_by: provider }) as unknown as CatalogModel);
const slugs = routed.map(model => `${model.provider}/${model.id}`);
const pinned = "jd-claude/sonnet-5";

function priorities(order: string[]) {
  const entries = buildCatalogEntriesFromObservedState({
    template: { slug: "gpt-5.5", display_name: "gpt-5.5", description: "Native GPT model", priority: 1, visibility: "list", tool_mode: "code" } as never,
    gptSlugs: [],
    goModels: routed,
    featured: [pinned],
    modelPickerOrder: order,
    wsEnabled: false,
    multiAgentMode: "default",
    exactComboSlugs: new Set(),
    accountSelectors: [],
    suppressedBareNativeSlugs: new Set(),
    disabledNativeAccountSlugs: new Set(),
    multiAgentV2Enabled: false,
  });
  return (entries as Record<string, unknown>[]).map(entry => [entry.slug as string, entry.priority as number] as const)
    .sort((a, b) => a[1] - b[1]);
}

describe("picker order mode family in the Codex catalog", () => {
  test("each family is one contiguous priority run, after the pinned row", () => {
    const order = modelPickerOrder("family", slugs)!;
    const ranked = priorities(order);
    expect(ranked.map(([slug]) => slug)).toEqual([
      pinned,
      "jd-gpt/gpt-6-luna", "jd-gpt/gpt-6.1-sol",
      "agy/gemini-3.8-flash", "agy/gemini-3.8-pro",
      "agy/claude-opus-5-5",
      "xai/grok-4.7",
      "tyler/deepseek-v4-pro",
      "jd-chat/kimi-k3", "jd-chat/glm-5.2",
      "local/mystery-1",
    ]);
    expect(ranked[0]).toEqual([pinned, 0]);
    const families = ranked.slice(1).map(([slug]) => modelFamily(slug).id);
    // No family id reappears after a different one started: one run per family.
    expect(families.filter((id, i) => i === 0 || id !== families[i - 1])).toEqual([...new Set(families)]);
    const priorityList = ranked.map(([, priority]) => priority);
    expect(priorityList).toEqual([...priorityList].sort((a, b) => a - b));
    expect(new Set(priorityList).size).toBe(priorityList.length);
  });
});
