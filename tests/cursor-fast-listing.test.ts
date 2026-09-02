import { describe, expect, test } from "bun:test";
import { cursorFastCapableBases, cursorFastIdFor, resolveCursorSelection } from "../src/adapters/cursor/catalog";
import { buildAnthropicModelInfos } from "../src/claude/model-info";
import { AUTO_CONTEXT_OFF } from "../src/claude/context-windows";
import { desktop3pAlias } from "../src/claude/desktop-3p";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { decideTier } from "../src/providers/fastwire";
import { fastPolicyForModel } from "../src/providers/service-tier";
import type { CatalogModel } from "../src/codex/catalog";

function cursorModel(id: string, contextWindow = 1_000_000): CatalogModel {
  return { provider: "cursor", id, contextWindow, reasoningEfforts: ["low", "high"] } as CatalogModel;
}

const listIds = (models: CatalogModel[], fastMode?: boolean) =>
  buildAnthropicModelInfos([], models, AUTO_CONTEXT_OFF, "readable", desktop3pAlias, undefined, fastMode)
    .map(info => info.id);

/**
 * Codex has a Fast toggle, so its rows stay umbrella rows. Claude Code and other
 * OpenAI-compatible clients have none — they can only pick a listed id — so the global
 * switch offers them the fast identity directly
 * (devlog 260902_cursor_unified_identity/030).
 */
describe("global fast switch lists -fast identities outside Codex", () => {
  test("the listed id and the Codex toggle converge on the same wire", () => {
    // The guard against the whole point of the feature: two surfaces, one behaviour.
    // A bare -fast suffix would NOT satisfy this for a thinking-default base.
    for (const base of cursorFastCapableBases()) {
      const listed = cursorFastIdFor(base);
      expect(listed).toBeDefined();
      expect(resolveCursorSelection(listed!, "max").wireId)
        .toBe(resolveCursorSelection(base, "max", undefined, { fast: true }).wireId);
    }
  });

  test("a thinking-default base lists its thinking-fast id, a regular-default base its fast id", () => {
    expect(cursorFastIdFor("claude-opus-5")).toBe("claude-opus-5-thinking-fast");
    expect(cursorFastIdFor("grok-4.6")).toBe("grok-4.6-fast");
  });

  test("a base with no fast variant yields no fast id at all", () => {
    for (const base of ["kimi-k3", "gpt-5.6-sol", "glm-5.3", "gemini-3.7-flash"]) {
      expect(cursorFastIdFor(base)).toBeUndefined();
    }
  });

  test("Claude Code discovery lists the umbrella id with the switch off", () => {
    expect(listIds([cursorModel("claude-opus-5")], false))
      .toContain("claude-ocx-cursor--claude-opus-5");
    expect(listIds([cursorModel("claude-opus-5")], undefined))
      .toContain("claude-ocx-cursor--claude-opus-5");
  });

  test("Claude Code discovery lists the fast identity with the switch on", () => {
    expect(listIds([cursorModel("claude-opus-5")], true))
      .toContain("claude-ocx-cursor--claude-opus-5-thinking-fast");
    expect(listIds([cursorModel("grok-4.6", 500_000)], true))
      .toContain("claude-ocx-cursor--grok-4.6-fast");
  });

  test("the switch leaves a base without a fast variant alone", () => {
    expect(listIds([cursorModel("kimi-k3")], true)).toContain("claude-ocx-cursor--kimi-k3");
  });

  test("Desktop 3P hashed aliases are untouched by the switch", () => {
    // Hashes are written into Desktop's config; rewriting them would strand a saved pick.
    const off = buildAnthropicModelInfos([], [cursorModel("claude-opus-5")], AUTO_CONTEXT_OFF, "desktop3p", desktop3pAlias, undefined, false);
    const on = buildAnthropicModelInfos([], [cursorModel("claude-opus-5")], AUTO_CONTEXT_OFF, "desktop3p", desktop3pAlias, undefined, true);
    expect(on.map(i => i.id)).toEqual(off.map(i => i.id));
  });

  test("fastMode alone promotes an umbrella request, with no caller service_tier", () => {
    // The persisted-config case: a client still naming the umbrella id must go fast too.
    const config = providerConfigSeed(getProviderRegistryEntry("cursor")!);
    const decide = (id: string, fastMode?: boolean) =>
      decideTier(fastPolicyForModel(config, id, "cursor"), fastMode, undefined);

    expect(decide("claude-opus-5", true)).toEqual({ kind: "set", value: "fast" });
    expect(decide("grok-4.6", true)).toEqual({ kind: "set", value: "fast" });
    expect(decide("kimi-k3", true)).toEqual({ kind: "drop" });
    // And the switch off must not promote.
    expect(decide("claude-opus-5", false)).toEqual({ kind: "drop" });
  });
});
