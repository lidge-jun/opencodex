import { describe, expect, test } from "bun:test";
import {
  DesktopProfileError,
  emptyDesktopProfile,
  moveDesktopRoute,
  parseDesktopProfile,
  reconcileDesktopProfile,
  renderDesktopProfile,
  setDesktopFamilyDefault,
  type DesktopProfileModel,
} from "../src/claude/desktop-profile";

const models: DesktopProfileModel[] = [
  { route: "native/gpt-5.6-sol", label: "GPT 5.6 Sol", contextWindow: 1_000_000 },
  { route: "cursor/gpt-5.6-luna", label: "GPT 5.6 Luna", contextWindow: 200_000 },
  { route: "anthropic/claude-fable-5", label: "Claude Fable 5", contextWindow: 1_000_000 },
];

describe("Claude Desktop profile", () => {
  test("reconciles new routes into Opus with stable unique date aliases", () => {
    const first = reconcileDesktopProfile(undefined, models);
    const second = reconcileDesktopProfile(first, [...models].reverse());
    expect(second).toEqual(first);
    expect(first.defaults.opus).toBe("anthropic/claude-fable-5");
    expect(first.assignments["anthropic/claude-fable-5"]?.alias).toBe("claude-fable-5");
    expect(first.assignments["native/gpt-5.6-sol"]?.alias).toMatch(/^claude-opus-4-8-2026\d{4}$/);
    expect(new Set(Object.values(first.assignments).map(value => value.alias)).size).toBe(3);
  });

  test("moves routes and maintains one default per non-empty family", () => {
    const base = reconcileDesktopProfile(undefined, models);
    const moved = moveDesktopRoute(base, "cursor/gpt-5.6-luna", "haiku", true);
    expect(moved.assignments["cursor/gpt-5.6-luna"]?.family).toBe("haiku");
    expect(moved.defaults.haiku).toBe("cursor/gpt-5.6-luna");
    const selected = setDesktopFamilyDefault(moved, "opus", "native/gpt-5.6-sol");
    expect(selected.defaults.opus).toBe("native/gpt-5.6-sol");
    expect(() => setDesktopFamilyDefault(selected, "opus", null)).toThrow(DesktopProfileError);
  });

  test("retains unavailable routes and promotes an active sibling only while rendering", () => {
    let profile = reconcileDesktopProfile(undefined, models);
    profile = setDesktopFamilyDefault(profile, "opus", "native/gpt-5.6-sol");
    const withoutDefault = renderDesktopProfile(profile, models.filter(model => model.route !== "native/gpt-5.6-sol"));
    expect(withoutDefault.find(model => model.family === "opus")?.isFamilyDefault).toBe(true);
    expect(profile.defaults.opus).toBe("native/gpt-5.6-sol");
    const restored = renderDesktopProfile(profile, models);
    expect(restored.find(model => model.route === "native/gpt-5.6-sol")?.isFamilyDefault).toBe(true);
  });

  test("renders family defaults first and only asserts 1M from authoritative metadata", () => {
    let profile = reconcileDesktopProfile(undefined, models);
    profile = moveDesktopRoute(profile, "cursor/gpt-5.6-luna", "haiku", true);
    const rendered = renderDesktopProfile(profile, models);
    expect(rendered.slice(0, 2).map(model => model.route)).toEqual([
      profile.defaults.opus,
      profile.defaults.haiku,
    ]);
    expect(rendered.find(model => model.route === "native/gpt-5.6-sol")?.supports1m).toBe(true);
    expect(rendered.find(model => model.route === "cursor/gpt-5.6-luna")?.supports1m).toBe(false);
  });

  test("rejects unknown fields, duplicate aliases and invalid defaults", () => {
    const profile = reconcileDesktopProfile(undefined, models);
    expect(() => parseDesktopProfile({ ...profile, extra: true })).toThrow("unknown field");
    const duplicate = structuredClone(profile);
    duplicate.assignments["cursor/gpt-5.6-luna"]!.alias = duplicate.assignments["native/gpt-5.6-sol"]!.alias;
    expect(() => parseDesktopProfile(duplicate)).toThrow("duplicate alias");
    const wrongDefault = structuredClone(profile);
    wrongDefault.defaults.haiku = "native/gpt-5.6-sol";
    expect(() => parseDesktopProfile(wrongDefault)).toThrow("empty family");
  });

  test("fills all 365 encoded slots then fails without mutating the saved profile", () => {
    const encoded = Array.from({ length: 365 }, (_, index) => ({
      route: `test/model-${index}`,
      label: `Model ${index}`,
    }));
    const full = reconcileDesktopProfile(emptyDesktopProfile(), encoded);
    const snapshot = structuredClone(full);
    expect(Object.keys(full.assignments)).toHaveLength(365);
    expect(() => reconcileDesktopProfile(full, [...encoded, { route: "test/overflow", label: "Overflow" }])).toThrow("365 encoded date slots");
    expect(full).toEqual(snapshot);
  });
});
