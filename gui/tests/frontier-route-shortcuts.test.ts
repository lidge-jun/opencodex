import { expect, test } from "bun:test";
import { buildFrontierRouteShortcuts } from "../src/pages/frontier-route-shortcuts";
import type { ModelRow } from "../src/pages/models-shared";

function model(provider: string, id: string): ModelRow {
  return {
    provider,
    id,
    namespaced: `${provider}/${id}`,
    disabled: false,
  };
}

test("resolves the latest non-fast Grok route for xAI and Cursor", () => {
  const shortcuts = buildFrontierRouteShortcuts([
    model("xai", "grok-4.5"),
    model("xai", "grok-4.6-fast"),
    model("xai", "grok-4.6"),
    model("cursor", "grok-4.5"),
    model("cursor", "grok-4.6"),
  ], new Set(["xai", "cursor"]));

  expect(shortcuts.find(shortcut => shortcut.id === "xai-grok")?.route).toBe("xai/grok-4.6");
  expect(shortcuts.find(shortcut => shortcut.id === "cursor-grok")?.route).toBe("cursor/grok-4.6");
});

test("prefers direct Anthropic Opus and falls back to an available Cursor Fable route", () => {
  const shortcuts = buildFrontierRouteShortcuts([
    model("cursor", "claude-opus-5"),
    model("anthropic", "claude-opus-5"),
    model("cursor", "claude-fable-5"),
  ], new Set(["anthropic", "cursor"]));

  expect(shortcuts.find(shortcut => shortcut.id === "opus-5")?.route).toBe("anthropic/claude-opus-5");
  expect(shortcuts.find(shortcut => shortcut.id === "fable-5")?.route).toBe("cursor/claude-fable-5");
});

test("keeps missing routes actionable through their provider setup", () => {
  const shortcuts = buildFrontierRouteShortcuts([], new Set(["anthropic"]));
  const xai = shortcuts.find(shortcut => shortcut.id === "xai-grok");
  const opus = shortcuts.find(shortcut => shortcut.id === "opus-5");

  expect(xai).toMatchObject({ provider: "xai", route: null, providerConfigured: false });
  expect(opus).toMatchObject({ provider: "anthropic", route: null, providerConfigured: true });
});
