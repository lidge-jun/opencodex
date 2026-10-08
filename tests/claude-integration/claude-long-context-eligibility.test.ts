/**
 * Long windows (>= the default compact window) are 1M on every Claude surface whose runner may
 * lack CLAUDE_CODE_AUTO_COMPACT_WINDOW; real Anthropic rows of either pool still need a genuine
 * 1M (devlog/_plan/261009_claude_1m_default/020_long_context_eligibility.md).
 */
import { describe, expect, test } from "bun:test";
import { claudeSurfaceSupportsOneMillion, isLongContextWindow, routeSupportsOneMillion } from "../../src/claude/long-context";
import { AUTO_CONTEXT_OFF, UNPAIRED_AUTO_CONTEXT } from "../../src/claude/context-windows";
import { buildAnthropicModelInfos } from "../../src/claude/model-info";
import { generateDesktop3pModels } from "../../src/claude/desktop-3p";
import { withSubagentContextMarker } from "../../src/claude/subagent-model";

const ASTRA_872K = { modelWindows: { "gpt-6-astra": 872_000 } };

describe("isLongContextWindow / claudeSurfaceSupportsOneMillion", () => {
  test("the floor is the default compact window, never a configurable one", () => {
    for (const window of [undefined, 0, 200_000, 262_144, 400_000, 829_799]) expect(isLongContextWindow(window)).toBe(false);
    for (const window of [829_800, 872_000, 922_000, 1_000_000, 2_000_000]) expect(isLongContextWindow(window)).toBe(true);
  });

  test("Claude models on either Anthropic pool need a genuine 1M; a gateway that shares the name does not", () => {
    expect(claudeSurfaceSupportsOneMillion("anthropic", "claude-sonnet-5", 872_000)).toBe(false);
    expect(claudeSurfaceSupportsOneMillion("anthropic2", "claude-sonnet-5", 872_000)).toBe(false);
    expect(claudeSurfaceSupportsOneMillion("anthropic2", "claude-sonnet-5", 1_000_000)).toBe(true);
    // A configured gateway named anthropic2 serving another vendor's model is not an Anthropic pool.
    expect(claudeSurfaceSupportsOneMillion("anthropic2", "kimi-k3", 900_000)).toBe(true);
    expect(routeSupportsOneMillion("native/gpt-6-astra", 872_000)).toBe(true);
    expect(routeSupportsOneMillion("kimi/k3", 262_144)).toBe(false);
  });
});

describe("Anthropic discovery 1M variants", () => {
  const variants = (infos: ReturnType<typeof buildAnthropicModelInfos>) => infos.filter(info => info.id.endsWith("[1m]"));

  test("an 872k native gets a variant that reports its real input ceiling", () => {
    const infos = buildAnthropicModelInfos(["gpt-6-astra"], [], UNPAIRED_AUTO_CONTEXT, "readable", undefined, ASTRA_872K);
    const [variant] = variants(infos);
    expect(variant?.display_name).toBe("gpt-6-astra (native) · 1M");
    expect(variant?.max_input_tokens).toBe(872_000);
    expect(variants(buildAnthropicModelInfos(["gpt-6-astra"], [], AUTO_CONTEXT_OFF, "readable", undefined, ASTRA_872K))).toHaveLength(0);
  });

  test("a custom compact window does not lower the floor (#854)", () => {
    const routed = [{ provider: "example", id: "mid", contextWindow: 400_000 }];
    expect(variants(buildAnthropicModelInfos([], routed, { enabled: true, compactWindow: 350_000 }, "readable"))).toHaveLength(0);
  });

  test("a long routed row without an input ceiling advertises its window, not 1e6", () => {
    const infos = buildAnthropicModelInfos([], [{ provider: "example", id: "long", contextWindow: 900_000 }], UNPAIRED_AUTO_CONTEXT, "readable");
    expect(variants(infos).map(info => info.max_input_tokens)).toEqual([900_000]);
  });

  test("Anthropic rows and short windows get no widened variant", () => {
    const routed = [
      { provider: "anthropic", id: "claude-x", contextWindow: 872_000 },
      { provider: "anthropic2", id: "claude-y", contextWindow: 872_000 },
      { provider: "kimi", id: "k3", contextWindow: 262_144 },
    ];
    expect(variants(buildAnthropicModelInfos([], routed, UNPAIRED_AUTO_CONTEXT, "readable"))).toHaveLength(0);
  });
});

describe("Desktop 3P", () => {
  test("an 872k native offers and prefers 1M; a 262k route does not", () => {
    const [astra] = generateDesktop3pModels(["gpt-6-astra"], [], undefined, ASTRA_872K);
    expect(astra).toMatchObject({ supports1m: true, prefer1m: true });
    const [k3] = generateDesktop3pModels([], [{ provider: "kimi", id: "k3", contextWindow: 262_144 }]);
    expect(k3!.supports1m).toBeUndefined();
    expect(k3!.prefer1m).toBeUndefined();
  });
});

describe("generated subagent markers", () => {
  const alias = "ocx-claude-native--gpt-6-astra";

  test("an 872k window is marked, a 262k window is not, and an unsafe marker is stripped", () => {
    expect(withSubagentContextMarker(alias, { [alias]: 872_000 })).toBe(`${alias}[1m]`);
    expect(withSubagentContextMarker(alias, { [alias]: 262_144 })).toBe(alias);
    expect(withSubagentContextMarker(`${alias}[1m]`, { [alias]: 262_144 })).toBe(alias);
  });

  test("a capped Claude row on Pool 2 stays unmarked even when a connected window map lists it", () => {
    // Connected launches read the published catalog, which keeps capped Anthropic rows.
    const pool2 = "ocx-claude-anthropic2--claude-sonnet-5";
    expect(withSubagentContextMarker(pool2, { [pool2]: 900_000 })).toBe(pool2);
    expect(withSubagentContextMarker(`${pool2}[1m]`, { [pool2]: 900_000 })).toBe(pool2);
    expect(withSubagentContextMarker(pool2, { [pool2]: 1_000_000 })).toBe(`${pool2}[1m]`);
  });
});
