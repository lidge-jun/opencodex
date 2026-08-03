import { describe, expect, test } from "bun:test";
import { buildAnthropicModelInfos, nativeEffectiveLadder } from "../src/claude/model-info";
import { nativeEffortClamp } from "../src/codex/catalog";

describe("anthropic-flavor ModelInfo discovery entries (devlog 130 B4b)", () => {
  test("routed model with adapter-reported ladder advertises exactly those rungs", () => {
    const [info] = buildAnthropicModelInfos([], [{
      provider: "cursor", id: "gpt-5.6-luna",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      contextWindow: 1_000_000,
      inputModalities: ["text", "image"],
    }]);
    expect(info!.id).toMatch(/^claude-opus-4-8-[a-z][0-9a-z]{2}$/);
    expect(info!.display_name).toBe("gpt-5.6-luna (cursor)");
    expect(info!.type).toBe("model");
    expect(info!.created_at).toBe("2026-01-01T00:00:00Z");
    expect(info!.max_input_tokens).toBe(1_000_000);
    expect(info!.max_tokens).toBeNull();
    expect(info!.capabilities.effort.supported).toBe(true);
    expect(info!.capabilities.effort.low.supported).toBe(true);
    expect(info!.capabilities.effort.max.supported).toBe(true);
    expect(info!.capabilities.effort.xhigh).toEqual({ supported: true });
    expect(info!.capabilities.thinking.supported).toBe(true);
    expect(info!.capabilities.thinking.types.adaptive.supported).toBe(true);
    expect(info!.capabilities.image_input.supported).toBe(true);
  });

  test("routed model WITHOUT a reported ladder never guesses (supported:false)", () => {
    const [info] = buildAnthropicModelInfos([], [{ provider: "p", id: "mystery-model" }]);
    expect(info!.capabilities.effort.supported).toBe(false);
    expect(info!.capabilities.effort.xhigh).toBeNull();
    expect(info!.capabilities.thinking.supported).toBe(false);
    expect(info!.max_input_tokens).toBeNull();
  });

  test("non-anthropic rungs (ultra) are filtered out of the capability set", () => {
    const [info] = buildAnthropicModelInfos([], [{ provider: "p", id: "m", reasoningEfforts: ["ultra"] }]);
    expect(info!.capabilities.effort.supported).toBe(false);
  });

  test("real anthropic routed models keep their canonical id", () => {
    const [info] = buildAnthropicModelInfos([], [{ provider: "anthropic", id: "claude-opus-4-8", reasoningEfforts: ["low", "high", "max"] }]);
    expect(info!.id).toBe("claude-opus-4-8");
    expect(info!.capabilities.effort.max.supported).toBe(true);
  });

  test("native effective ladder only advertises clamp-identity rungs (audit R4#1)", () => {
    for (const slug of ["gpt-5.5", "gpt-5.4", "gpt-5.6-sol"]) {
      for (const rung of nativeEffectiveLadder(slug)) {
        expect(rung).not.toBe("ultra");
        const clamped = nativeEffortClamp(slug, rung);
        // null = identity passthrough; a non-null clamp result must equal the rung itself.
        if (clamped !== null) expect(clamped).toBe(rung);
      }
    }
  });

  test("duplicate ids are deduplicated", () => {
    const infos = buildAnthropicModelInfos([], [
      { provider: "p", id: "m" },
      { provider: "p", id: "m" },
    ]);
    expect(infos).toHaveLength(1);
  });

  test("[1m] picker variants: only >=1M models get a second row (devlog 260712 B1)", () => {
    const infos = buildAnthropicModelInfos([], [
      { provider: "cursor", id: "gpt-5.6-luna", contextWindow: 1_000_000, reasoningEfforts: ["low", "high", "max"] },
      { provider: "mock", id: "small-model", contextWindow: 128_000 },
    ]);
    const ids = infos.map(i => i.id);
    const lunaBase = ids.find(id => !id.includes("[1m]") && id !== ids[0]) ?? ids[0];
    const variants = infos.filter(i => i.id.endsWith("[1m]"));
    expect(variants).toHaveLength(1);
    expect(variants[0]!.id).toBe(`${infos[0]!.id}[1m]`);
    expect(variants[0]!.display_name.endsWith("· 1M")).toBe(true);
    expect(variants[0]!.max_input_tokens).toBe(1_000_000);
    // capabilities are shared with the base row.
    expect(variants[0]!.capabilities.effort.max.supported).toBe(true);
    expect(String(lunaBase)).toBeDefined();
  });

  test("[1m] variants cover 1M NATIVES too (audit R1#1) — and skip sub-1M natives", () => {
    const infos = buildAnthropicModelInfos(["gpt-5.4", "gpt-5.6-sol"], []);
    const variants = infos.filter(i => i.id.endsWith("[1m]"));
    expect(variants).toHaveLength(1); // gpt-5.4 (1M) only; gpt-5.6-sol native is 372k
  });

  test("[1m] variant never double-suffixes or duplicates (audit R1#11)", () => {
    const infos = buildAnthropicModelInfos([], [
      // Anthropic passthrough keeps its id verbatim, so an id already carrying the
      // marker must not grow a second one.
      { provider: "anthropic", id: "claude-opus-4-6[1m]", contextWindow: 1_000_000 },
    ]);
    expect(infos.filter(i => i.id.includes("[1m][1m]")).length).toBe(0);
    expect(infos).toHaveLength(1);
  });

  test("no [1m] rows for sub-1M models, even with auto-context enabled (#854 contract)", () => {
    const auto = { enabled: true, compactWindow: 350_000 };
    const infos = buildAnthropicModelInfos(["gpt-5.4", "gpt-5.6-sol"], [
      { provider: "mock", id: "small-model", contextWindow: 128_000 },
      { provider: "mock", id: "mid-model", contextWindow: 300_000 }, // < compact window: unsafe, no row
    ], auto);
    const variants = infos.filter(i => i.id.endsWith("[1m]"));
    // The [1m] marker makes Claude Code account 1e6 tokens: only the
    // authoritative 1M model may carry it — never the 372K route.
    expect(variants).toHaveLength(1);
    expect(variants[0]!.display_name.includes("gpt-5.4")).toBe(true);
    expect(variants[0]!.display_name.endsWith("· 1M")).toBe(true);
    expect(variants[0]!.max_input_tokens).toBe(1_000_000);
  });

  test("auto-context never widens anthropic passthrough rows (audit 021 #3)", () => {
    const auto = { enabled: true, compactWindow: 350_000 };
    const infos = buildAnthropicModelInfos([], [
      { provider: "anthropic", id: "claude-opus-4-8", contextWindow: 500_000 },
      { provider: "anthropic", id: "claude-big-5", contextWindow: 1_000_000 },
    ], auto);
    const variants = infos.filter(i => i.id.endsWith("[1m]"));
    expect(variants).toHaveLength(1); // only the genuine 1M anthropic row
    expect(variants[0]!.display_name.includes("claude-big-5")).toBe(true);
  });

  test("readable id style serves claude-ocx ids with hash fallback + readable [1m] variants (devlog 050)", () => {
    const auto = { enabled: true, compactWindow: 350_000 };
    const infos = buildAnthropicModelInfos(["gpt-5.6-sol"], [
      { provider: "cursor", id: "gpt-5.6-luna", contextWindow: 1_000_000 },
      { provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000 },
      { provider: "weird--provider", id: "m1", contextWindow: 128_000 }, // unrepresentable -> hash fallback
    ], auto, "readable");
    const ids = infos.map(i => i.id);
    expect(ids).toContain("claude-ocx-native--gpt-5.6-sol");
    // 372k native: NO [1m] variant under the authoritative-window contract.
    expect(ids).not.toContain("claude-ocx-native--gpt-5.6-sol[1m]");
    expect(ids).toContain("claude-ocx-cursor--gpt-5.6-luna");
    expect(ids).toContain("claude-ocx-cursor--gpt-5.6-luna[1m]");
    expect(ids).toContain("claude-opus-4-8"); // anthropic canonical passthrough
    expect(ids.some(id => /^claude-opus-4-8-[a-z][0-9a-z]{2}$/.test(id))).toBe(true); // fallback row survives
    // Default style stays hashed (desktop contract untouched).
    const hashed = buildAnthropicModelInfos(["gpt-5.6-sol"], [], auto);
    expect(hashed.map(i => i.id).some(id => id.startsWith("claude-ocx-"))).toBe(false);
  });
});
