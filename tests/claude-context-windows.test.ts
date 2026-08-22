import { describe, expect, test } from "bun:test";
import { AUTO_COMPACT_WINDOW_DEFAULT, boundedContextWindows, buildClaudeContextWindows, effectiveModelEnv, resolveAutoContext, shouldMarkOneMillion, withOneMillionMarker } from "../src/claude/context-windows";
import { desktop3pAlias } from "../src/claude/desktop-3p";

describe("claude context-window map (devlog 260712 B2)", () => {
  const routed = [
    { provider: "cursor", id: "gpt-5.6-luna", contextWindow: 1_000_000 },
    { provider: "opencode-go", id: "glm-5.2", contextWindow: 1_000_000 },
    { provider: "mock", id: "small-model", contextWindow: 128_000 },
    { provider: "mock", id: "no-window" },
  ];

  test("registers all four selector forms for routed models", () => {
    const map = buildClaudeContextWindows([], routed);
    expect(map["cursor/gpt-5.6-luna"]).toBe(1_000_000);
    expect(map[desktop3pAlias("cursor", "gpt-5.6-luna")]).toBe(1_000_000);
    expect(map["claude-ocx-cursor--gpt-5.6-luna"]).toBe(1_000_000);
    expect(map["mock/small-model"]).toBe(128_000);
    expect(map["mock/no-window"]).toBeUndefined();
  });

  test("registers native slugs (bare + desktop alias + legacy alias)", () => {
    const map = buildClaudeContextWindows(["gpt-5.6-sol", "gpt-5.4"], []);
    // Authoritative native overrides: gpt-5.6 natives follow Codex 272k, gpt-5.4 native 1M.
    expect(map["gpt-5.6-sol"]).toBe(272_000);
    expect(map[desktop3pAlias("native", "gpt-5.6-sol")]).toBe(272_000);
    expect(map["claude-ocx-native--gpt-5.6-sol"]).toBe(272_000);
    expect(map["gpt-5.4"]).toBe(1_000_000);
  });

  test("first-wins on alias collisions (registry policy)", () => {
    // test/model-123 and test/model-155 share the 3-char code (known golden collision).
    const map = buildClaudeContextWindows([], [
      { provider: "test", id: "model-123", contextWindow: 111 },
      { provider: "test", id: "model-155", contextWindow: 222 },
    ]);
    expect(map[desktop3pAlias("test", "model-123")]).toBe(111);
    // provider/id keys stay distinct even when the alias collides.
    expect(map["test/model-155"]).toBe(222);
  });

  test("withOneMillionMarker marks only >=1M, never double-suffixes, ignores unknown", () => {
    const windows = { "cursor/gpt-5.6-luna": 1_000_000, "mock/small-model": 128_000 };
    expect(withOneMillionMarker("cursor/gpt-5.6-luna", windows)).toBe("cursor/gpt-5.6-luna[1m]");
    expect(withOneMillionMarker("cursor/gpt-5.6-luna[1m]", windows)).toBe("cursor/gpt-5.6-luna[1m]");
    expect(withOneMillionMarker("mock/small-model", windows)).toBe("mock/small-model");
    expect(withOneMillionMarker("unknown-model", windows)).toBe("unknown-model");
    expect(withOneMillionMarker(undefined, windows)).toBeUndefined();
  });

  test("effectiveModelEnv emits the exact six-slot map with the effective-haiku contract", () => {
    const windows = { "cursor/gpt-5.6-luna": 1_000_000, "mock/small-model": 128_000 };
    const env = effectiveModelEnv({
      model: "cursor/gpt-5.6-luna",
      smallFastModel: "mock/small-model",
      tierModels: { opus: "cursor/gpt-5.6-luna", sonnet: "mock/small-model" },
    }, windows);
    expect(env.ANTHROPIC_MODEL).toBe("cursor/gpt-5.6-luna[1m]");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("cursor/gpt-5.6-luna[1m]");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("mock/small-model");
    // effective-haiku: tierModels.haiku absent -> smallFastModel feeds BOTH haiku vars.
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("mock/small-model");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("mock/small-model");
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBeUndefined();
  });

  test("tierModels.haiku wins over smallFastModel for both haiku vars", () => {
    const env = effectiveModelEnv({ smallFastModel: "a", tierModels: { haiku: "b" } }, {});
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("b");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("b");
  });

  test("boundedContextWindows resolves null on a slow acquisition (deterministic delay fixture)", async () => {
    const slow = () => new Promise<Record<string, number>>(resolve => setTimeout(() => resolve({ x: 1 }), 200));
    expect(await boundedContextWindows(slow, 20)).toBeNull();
    expect(await boundedContextWindows(async () => ({ y: 2 }), 1_000)).toEqual({ y: 2 });
    expect(await boundedContextWindows(async () => { throw new Error("boom"); }, 1_000)).toBeNull();
  });
});

describe("auto-context (devlog 260712 020 + audit 021)", () => {
  test("resolveAutoContext: default on at AUTO_COMPACT_WINDOW_DEFAULT, valid custom, range fallback, off switches", () => {
    expect(resolveAutoContext(undefined)).toEqual({ enabled: true, compactWindow: AUTO_COMPACT_WINDOW_DEFAULT });
    expect(resolveAutoContext({ autoCompactWindow: 300_000 })).toEqual({ enabled: true, compactWindow: 300_000 });
    // Out-of-range config (hand-edit) falls back to the default (API rejects these).
    expect(resolveAutoContext({ autoCompactWindow: 50_000 }).compactWindow).toBe(AUTO_COMPACT_WINDOW_DEFAULT);
    expect(resolveAutoContext({ autoCompactWindow: 2_000_000 }).compactWindow).toBe(AUTO_COMPACT_WINDOW_DEFAULT);
    expect(resolveAutoContext({ autoContext: false }).enabled).toBe(false);
    // Legacy maxContextTokens pair takes rule-1 precedence -> auto inert.
    expect(resolveAutoContext({ maxContextTokens: 400_000 }).enabled).toBe(false);
  });

  test("user env override drives the predicate; invalid override disables auto (audit #2)", () => {
    expect(resolveAutoContext({}, "500000")).toEqual({ enabled: true, compactWindow: 500_000 });
    // Invalid or out-of-range env: the CLI would ignore it -> marking sub-1M is unsafe.
    expect(resolveAutoContext({}, "50").enabled).toBe(false);
    expect(resolveAutoContext({}, "9999999").enabled).toBe(false);
    expect(resolveAutoContext({}, "abc").enabled).toBe(false);
    // autoContext=false still wins over a user env value.
    expect(resolveAutoContext({ autoContext: false }, "500000").enabled).toBe(false);
  });

  test("shouldMarkOneMillion: >=1M always; auto widens only windows that host the compact window", () => {
    const auto = { enabled: true, compactWindow: 350_000 };
    expect(shouldMarkOneMillion(1_000_000, { enabled: false, compactWindow: 350_000 })).toBe(true);
    expect(shouldMarkOneMillion(372_000, auto)).toBe(true);
    expect(shouldMarkOneMillion(372_000, { enabled: true, compactWindow: 380_000 })).toBe(false); // real < threshold
    expect(shouldMarkOneMillion(200_000, auto)).toBe(false); // floor is exclusive
    expect(shouldMarkOneMillion(128_000, auto)).toBe(false);
    expect(shouldMarkOneMillion(undefined, auto)).toBe(false);
  });

  test("anthropic sub-1M routes stay out of the map; >=1M anthropic stays in (audit #3)", () => {
    const map = buildClaudeContextWindows([], [
      { provider: "anthropic", id: "claude-opus-4-8", contextWindow: 500_000 },
      { provider: "anthropic", id: "claude-big-5", contextWindow: 1_000_000 },
    ]);
    expect(map["anthropic/claude-opus-4-8"]).toBeUndefined();
    expect(map["anthropic/claude-big-5"]).toBe(1_000_000);
  });

  test("bare routed ids register only when unambiguous across providers (audit #5)", () => {
    const map = buildClaudeContextWindows(["gpt-5.6-sol"], [
      { provider: "cursor", id: "gpt-5.6-luna", contextWindow: 400_000 },
      { provider: "a", id: "shared-model", contextWindow: 300_000 },
      { provider: "b", id: "shared-model", contextWindow: 900_000 },
      // Routed model whose bare id collides with a native slug: native wins (first-wins).
      { provider: "c", id: "gpt-5.6-sol", contextWindow: 999_000 },
    ]);
    expect(map["gpt-5.6-luna"]).toBe(400_000);
    expect(map["shared-model"]).toBeUndefined();
    expect(map["gpt-5.6-sol"]).toBe(272_000); // native default, not 999k
  });

  test("auto-context marks a wide native slot, and turning it off unmarks anything under 1M", () => {
    const windows = buildClaudeContextWindows(["gpt-5.6-sol"], []);
    const env = effectiveModelEnv({ model: "gpt-5.6-sol" }, windows);
    // Default 272k sits under the 829,800 compact window, so the marker stays off.
    expect(env.ANTHROPIC_MODEL).toBe("gpt-5.6-sol");
    const readable = effectiveModelEnv({ model: "claude-ocx-native--gpt-5.6-sol" }, windows);
    expect(readable.ANTHROPIC_MODEL).toBe("claude-ocx-native--gpt-5.6-sol");
    // Opting into the measured 922k ceiling clears the compact window and marks [1m].
    const opted = buildClaudeContextWindows(["gpt-5.6-sol"], [], 922_000);
    expect(effectiveModelEnv({ model: "gpt-5.6-sol" }, opted).ANTHROPIC_MODEL).toBe("gpt-5.6-sol[1m]");
    const solOff = effectiveModelEnv({ model: "gpt-5.6-sol", autoContext: false }, opted);
    expect(solOff.ANTHROPIC_MODEL).toBe("gpt-5.6-sol");
    const subWindows = buildClaudeContextWindows(["gpt-5.5"], []);
    const off = effectiveModelEnv({ model: "gpt-5.5", autoContext: false }, subWindows);
    expect(off.ANTHROPIC_MODEL).toBe("gpt-5.5");
  });

  test("[1m] handling is case-insensitive (audit #7)", () => {
    const windows = { "cursor/gpt-5.6-luna": 1_000_000 };
    expect(withOneMillionMarker("cursor/gpt-5.6-luna[1M]", windows)).toBe("cursor/gpt-5.6-luna[1M]");
    expect(shouldMarkOneMillion(windows["cursor/gpt-5.6-luna"], { enabled: false, compactWindow: 350_000 })).toBe(true);
  });
});
