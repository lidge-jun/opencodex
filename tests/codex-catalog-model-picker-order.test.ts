import { describe, expect, test } from "bun:test";
import {
  buildCatalogEntriesFromObservedState,
  effectiveSubagentRoster,
  MAX_SPAWN_AGENT_MODEL_OVERRIDES,
} from "../src/codex/catalog/sync";
import type { CatalogModel } from "../src/types";

// #1649: config.modelPickerOrder assigns a deterministic priority band to non-featured routed
// rows so a catalog with more than 5 routed models keeps a stable picker order across rebuilds,
// independent of the 5-slot subagentModels spawn_agent cap.

function template(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    tool_mode: "code",
  };
}

const goModels = [
  { id: "glm-5.2", provider: "jd-chat", owned_by: "jd" },
  { id: "kimi-k3", provider: "jd-chat", owned_by: "jd" },
  { id: "deepseek-v4-pro", provider: "tyler", owned_by: "tyler" },
  { id: "sonnet-5", provider: "jd-claude", owned_by: "jd" },
] as unknown as CatalogModel[];

function build(overrides: { featured?: string[]; modelPickerOrder?: unknown }) {
  const entries = buildCatalogEntriesFromObservedState({
    template: template() as never,
    gptSlugs: [],
    goModels,
    featured: overrides.featured,
    modelPickerOrder: overrides.modelPickerOrder as string[] | undefined,
    wsEnabled: false,
    multiAgentMode: "default",
    exactComboSlugs: new Set(),
    accountSelectors: [],
    suppressedBareNativeSlugs: new Set(),
    disabledNativeAccountSlugs: new Set(),
    multiAgentV2Enabled: false,
  });
  return Object.fromEntries(entries.map(e => {
    const r = e as Record<string, unknown>;
    return [r.slug as string, r.priority as number];
  })) as Record<string, number>;
}

describe("modelPickerOrder (#1649)", () => {
  test.each([
    ["non-array string", "tyler/deepseek-v4-pro"],
    ["null", null],
    ["number", 42],
  ])("malformed %s input is ignored without crashing catalog sync", (_label, modelPickerOrder) => {
    const p = build({ modelPickerOrder });
    expect(p["tyler/deepseek-v4-pro"]).toBe(5);
    expect(p["jd-chat/kimi-k3"]).toBe(5);
  });

  test("non-string array members are ignored while valid slugs survive", () => {
    const p = build({
      modelPickerOrder: ["tyler/deepseek-v4-pro", null, 42, { slug: "jd-chat/kimi-k3" }],
    });
    expect(p["tyler/deepseek-v4-pro"]).toBeGreaterThanOrEqual(1000);
    expect(p["jd-chat/kimi-k3"]).toBe(5);
  });

  test("unset leaves every non-featured routed row at the flat default priority", () => {
    const p = build({});
    expect(p["jd-chat/glm-5.2"]).toBe(5);
    expect(p["jd-chat/kimi-k3"]).toBe(5);
    expect(p["tyler/deepseek-v4-pro"]).toBe(5);
    expect(p["jd-claude/sonnet-5"]).toBe(5);
  });

  test("listed rows sort among themselves in declared order, in the high picker tier", () => {
    const p = build({
      modelPickerOrder: [
        "tyler/deepseek-v4-pro",
        "jd-chat/kimi-k3",
        "jd-chat/glm-5.2",
      ],
    });
    // Declared order is honored among the listed rows.
    expect(p["tyler/deepseek-v4-pro"]).toBeLessThan(p["jd-chat/kimi-k3"]);
    expect(p["jd-chat/kimi-k3"]).toBeLessThan(p["jd-chat/glm-5.2"]);
    // Listed rows occupy the high picker tier (>= 1000); an unlisted, non-featured row keeps its
    // default priority (5) and therefore is NOT reordered by modelPickerOrder.
    expect(p["tyler/deepseek-v4-pro"]).toBeGreaterThanOrEqual(1000);
    expect(p["jd-claude/sonnet-5"]).toBe(5);
  });

  test("featured rows keep their top priority ahead of the picker-order band", () => {
    const p = build({
      featured: ["jd-claude/sonnet-5"],
      modelPickerOrder: ["tyler/deepseek-v4-pro", "jd-chat/kimi-k3"],
    });
    // Featured wins outright (priority 0).
    expect(p["jd-claude/sonnet-5"]).toBe(0);
    // Picker-order rows come after the featured band.
    expect(p["tyler/deepseek-v4-pro"]).toBeGreaterThan(p["jd-claude/sonnet-5"]);
    expect(p["tyler/deepseek-v4-pro"]).toBeLessThan(p["jd-chat/kimi-k3"]);
  });

  // Regression for the review on #1666: modelPickerOrder must not change spawn_agent candidate
  // eligibility. spawn_agent takes the first MAX_SPAWN_AGENT_MODEL_OVERRIDES picker rows by
  // ascending priority. The picker-order band lives in the high (>= 1_000) tier, so featured
  // rows (0..N-1) and any default-tier routed rows (priority 5) fill the candidate window first;
  // a row that is ONLY placed by modelPickerOrder does not displace a default-tier candidate.
  test("picker-order-only rows do not displace default-tier spawn_agent candidates", () => {
    const manyRouted = [
      // Not in modelPickerOrder -> stay at default priority 5 -> fill the candidate window.
      { id: "unlisted-a", provider: "jd-chat", owned_by: "jd" },
      { id: "unlisted-b", provider: "jd-chat", owned_by: "jd" },
      { id: "unlisted-c", provider: "jd-chat", owned_by: "jd" },
      { id: "unlisted-d", provider: "jd-chat", owned_by: "jd" },
      { id: "unlisted-e", provider: "jd-chat", owned_by: "jd" },
      // Placed only by modelPickerOrder -> high tier -> must stay out of the candidate window.
      { id: "deepseek-v4-pro", provider: "tyler", owned_by: "tyler" },
      { id: "kimi-k3", provider: "jd-chat", owned_by: "jd" },
    ] as unknown as CatalogModel[];
    const order = ["tyler/deepseek-v4-pro", "jd-chat/kimi-k3"];
    const entries = buildCatalogEntriesFromObservedState({
      template: template() as never,
      gptSlugs: [],
      goModels: manyRouted,
      featured: [],
      modelPickerOrder: order,
      wsEnabled: false,
      multiAgentMode: "default",
      exactComboSlugs: new Set(),
      accountSelectors: [],
      suppressedBareNativeSlugs: new Set(),
      disabledNativeAccountSlugs: new Set(),
      multiAgentV2Enabled: false,
    });
    const candidateSlugs = effectiveSubagentRoster([], "default", entries).candidates.map(c => c.model);
    expect(candidateSlugs.length).toBe(MAX_SPAWN_AGENT_MODEL_OVERRIDES);
    // The picker-order-only rows are pushed to the high tier and never enter the window.
    expect(candidateSlugs).not.toContain("tyler/deepseek-v4-pro");
    expect(candidateSlugs).not.toContain("jd-chat/kimi-k3");
  });

  // Documents the scope boundary raised in review: modelPickerOrder targets routed
  // <provider>/<model> rows only. A bare native slug listed here must NOT reorder its native
  // passthrough row (native ordering goes through subagentModels).
  test("a bare native slug in modelPickerOrder does not reorder its native row", () => {
    const entries = buildCatalogEntriesFromObservedState({
      template: template() as never,
      gptSlugs: ["gpt-5.5", "gpt-5.4"],
      goModels: [{ id: "glm-5.2", provider: "jd-chat", owned_by: "jd" }] as unknown as CatalogModel[],
      featured: [],
      modelPickerOrder: ["gpt-5.4", "jd-chat/glm-5.2"],
      wsEnabled: false,
      multiAgentMode: "default",
      exactComboSlugs: new Set(),
      accountSelectors: [],
      suppressedBareNativeSlugs: new Set(),
      disabledNativeAccountSlugs: new Set(),
      multiAgentV2Enabled: false,
    });
    const p = Object.fromEntries((entries as Record<string, unknown>[]).map(e => [e.slug as string, e.priority as number]));
    // The native row keeps its native priority (9), untouched by modelPickerOrder.
    expect(p["gpt-5.4"]).toBe(9);
    // The routed row IS placed in the high picker tier.
    expect(p["jd-chat/glm-5.2"]).toBeGreaterThanOrEqual(1000);
  });

  // Decisive regression for #1666: even when EVERY routed row is listed in modelPickerOrder in
  // reverse order (exhausting the default tier entirely), the spawn_agent candidate SET is
  // unchanged. This is the case a single display-priority band cannot satisfy; the candidate
  // window is derived from the natural priority (opencodex_spawn_priority), not display order.
  test("candidate set is unchanged when all routed rows are listed in reverse order", () => {
    const sixRouted = [
      { id: "m1", provider: "jd-chat", owned_by: "jd" },
      { id: "m2", provider: "jd-chat", owned_by: "jd" },
      { id: "m3", provider: "jd-chat", owned_by: "jd" },
      { id: "m4", provider: "jd-chat", owned_by: "jd" },
      { id: "m5", provider: "jd-chat", owned_by: "jd" },
      { id: "m6", provider: "jd-chat", owned_by: "jd" },
    ] as unknown as CatalogModel[];
    const buildWith = (modelPickerOrder?: string[]) => buildCatalogEntriesFromObservedState({
      template: template() as never,
      gptSlugs: [],
      goModels: sixRouted,
      featured: [],
      modelPickerOrder,
      wsEnabled: false,
      multiAgentMode: "default",
      exactComboSlugs: new Set(),
      accountSelectors: [],
      suppressedBareNativeSlugs: new Set(),
      disabledNativeAccountSlugs: new Set(),
      multiAgentV2Enabled: false,
    });
    const baseline = effectiveSubagentRoster([], "default", buildWith(undefined)).candidates.map(c => c.model);
    const reversed = ["jd-chat/m6", "jd-chat/m5", "jd-chat/m4", "jd-chat/m3", "jd-chat/m2", "jd-chat/m1"];
    const withOrder = effectiveSubagentRoster([], "default", buildWith(reversed)).candidates.map(c => c.model);
    // The candidate SET (membership) is identical regardless of display reordering.
    expect([...withOrder].sort()).toEqual([...baseline].sort());
    expect(withOrder.length).toBe(MAX_SPAWN_AGENT_MODEL_OVERRIDES);
  });
});
