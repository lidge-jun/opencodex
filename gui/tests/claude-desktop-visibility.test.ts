import { expect, test } from "bun:test";
import {
  applyPreview,
  desiredDesktopList,
  filterVisibilityModels,
  normalizeVisibility,
  routeVisible,
  sameVisibility,
  setNewModelPolicy,
  setRoutesVisible,
  visibilityCounts,
} from "../src/pages/claude-desktop-visibility";

/** #7702: the dashboard's Desktop selection math, kept pure so it is testable unmounted. */

const MODELS = [
  { route: "anthropic/claude-sonnet-5", label: "Sonnet 5", available: true },
  { route: "google/gemini-3-pro", label: "Gemini 3 Pro", available: true },
  { route: "xai/grok-5", label: "Grok 5", available: true },
  { route: "deepseek/deepseek-v4", label: "DeepSeek V4", available: false },
];
const ROUTES = MODELS.map(model => model.route);

test("unset lists everything; toggling builds an exclude list that keeps new models listed", () => {
  expect(ROUTES.every(route => routeVisible(null, route))).toBe(true);
  const hidden = setRoutesVisible(null, ["xai/grok-5"], false);
  expect(hidden).toEqual({ mode: "exclude", routes: ["xai/grok-5"] });
  expect(routeVisible(hidden, "new/model")).toBe(true);
  // Showing it again is the same as never having hidden it.
  expect(setRoutesVisible(hidden, ["xai/grok-5"], true)).toBeNull();
});

test("switching the new-model policy rewrites the list without changing today's selection", () => {
  const hidden = setRoutesVisible(null, ["xai/grok-5"], false);
  const include = setNewModelPolicy(hidden, ROUTES, "include");
  expect(include).toEqual({ mode: "include", routes: ["anthropic/claude-sonnet-5", "deepseek/deepseek-v4", "google/gemini-3-pro"] });
  for (const route of ROUTES) expect(routeVisible(include, route)).toBe(routeVisible(hidden, route));
  expect(routeVisible(include, "new/model")).toBe(false);
  expect(sameVisibility(setNewModelPolicy(include, ROUTES, "exclude"), hidden)).toBe(true);
});

test("bulk select acts on the filtered rows only", () => {
  const shown = filterVisibilityModels(MODELS, "", "google").map(model => model.route);
  const include = setRoutesVisible({ mode: "include", routes: [] }, shown, true);
  expect(include).toEqual({ mode: "include", routes: ["google/gemini-3-pro"] });
  expect(filterVisibilityModels(MODELS, "GROK", "").map(model => model.route)).toEqual(["xai/grok-5"]);
});

test("counts keep unavailable selections apart from the selected count", () => {
  expect(visibilityCounts(MODELS, null)).toEqual({ selected: 3, available: 3, selectedUnavailable: 0 });
  expect(visibilityCounts(MODELS, { mode: "include", routes: ["google/gemini-3-pro", "deepseek/deepseek-v4"] }))
    .toEqual({ selected: 1, available: 3, selectedUnavailable: 1 });
});

test("the apply preview diffs the desired list against what Desktop runs", () => {
  const rendered = [
    { route: "google/gemini-3-pro", name: "claude-a", label: "Gemini 3 Pro" },
    { route: "xai/grok-5", name: "claude-b", label: "Grok 5" },
  ];
  const desired = desiredDesktopList(rendered, { mode: "exclude", routes: ["xai/grok-5"] });
  expect(applyPreview(desired, [{ name: "claude-b", label: "Grok 5" }])).toEqual({ added: ["Gemini 3 Pro"], removed: ["Grok 5"] });
  expect(applyPreview(desired, null)).toBeNull();
  // Hiding everything previews the writer's fallback, not an empty list.
  expect(desiredDesktopList(rendered, { mode: "include", routes: [] })).toHaveLength(2);
  expect(normalizeVisibility({ mode: "exclude", routes: [] })).toBeNull();
});
