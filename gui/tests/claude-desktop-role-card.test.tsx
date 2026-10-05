import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ClaudeDesktop from "../src/pages/ClaudeDesktop";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";

/**
 * Design D1: the Models card sets the Opus and Haiku defaults without showing tiers, and
 * the family lanes live under a folded Advanced disclosure. Mounted, because the contract is
 * the profile the card produces and the warnings the folded summary must still show.
 */

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

function model(route: string, label: string, family: string, available = true) {
  return { route, label, available, contextWindow: 200_000, effortSupported: true, assignment: { family, alias: `alias-${label}` } };
}

// Eight models so the lane pager and the search input are both in play (LANE_PAGE = 6,
// LANE_SEARCH_MIN = 4).
const MODELS = [
  ...Array.from({ length: 7 }, (_, i) => model(`prov/opus-${i}`, `Opus Model ${i}`, "opus")),
  model("prov/only-sonnet", "Sonnet Model", "sonnet"),
];

function payload() {
  return {
    profile: {
      version: 1,
      assignments: Object.fromEntries(MODELS.map(m => [m.route, m.assignment])),
      defaults: { opus: "prov/opus-0", fable: null, sonnet: "prov/only-sonnet", haiku: null },
    },
    models: MODELS,
    rendered: [],
    port: 10100,
  };
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      const body = String(url).includes("/status")
        ? { desiredEnabled: true, applied: true, appliedAt: null, stale: false, health: { lastRequestAt: null, requestCount: 0, errorCount: 0 } }
        : payload();
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
    },
  });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  clearClientResourceStoresForTests();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount() {
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><ClaudeDesktop apiBase="" /></LanguageProvider>);
  });
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });
}

function combobox(name: string): HTMLButtonElement {
  const found = container.querySelector(`[role="combobox"][aria-label="${name}"]`);
  if (!found) throw new Error(`combobox not found: ${name}`);
  return found as unknown as HTMLButtonElement;
}

async function choose(name: string, optionText: string) {
  await act(async () => { combobox(name).click(); });
  const option = Array.from(testWindow.document.querySelectorAll('[role="option"]'))
    .find(o => (o.textContent ?? "").trim() === optionText) as unknown as HTMLElement | undefined;
  if (!option) throw new Error(`option not found: ${optionText}`);
  await act(async () => { option.click(); });
}

test("the lanes sit inside a folded Advanced disclosure", async () => {
  await mount();
  const advanced = container.querySelector("details.claude-desktop-advanced") as unknown as HTMLDetailsElement;
  expect(advanced).not.toBeNull();
  expect(advanced.open).toBe(false);
  expect(advanced.querySelector(".ocx-group-stack")).not.toBeNull();
  // The folded summary still names every family and its default.
  const summary = advanced.querySelector("summary")!.textContent ?? "";
  for (const family of ["Opus", "Fable", "Sonnet", "Haiku"]) expect(summary).toContain(family);
  expect(summary).toContain("prov/opus-0");
});

test("choosing a Quick task model moves it into Haiku as its default", async () => {
  await mount();
  expect(combobox("Quick task model").textContent).toContain("Not set");
  await choose("Quick task model", "Opus Model 3");
  expect(container.querySelector(".claude-dirty")?.textContent).toBe("Unsaved changes");
  const haiku = Array.from(container.querySelectorAll(".claude-desktop-advanced-chip"))
    .find(chip => chip.textContent?.startsWith("Haiku"));
  expect(haiku?.textContent).toContain("prov/opus-3");
  const quickRow = Array.from(container.querySelectorAll(".claude-desktop-list-row"))
    .find(row => row.textContent?.includes("Opus Model 3"));
  expect(quickRow?.textContent).toContain("Quick tasks");
});

test("each role select leaves out the model the other role holds", async () => {
  await mount();
  await act(async () => { combobox("Quick task model").click(); });
  const options = Array.from(testWindow.document.querySelectorAll('[role="option"]')).map(o => (o.textContent ?? "").trim());
  expect(options).not.toContain("Opus Model 0");
  expect(options).toContain("Sonnet Model");
});

test("choosing a Default model from another family moves it into Opus", async () => {
  await mount();
  await choose("Default model", "Sonnet Model");
  const opus = Array.from(container.querySelectorAll(".claude-desktop-advanced-chip"))
    .find(chip => chip.textContent?.startsWith("Opus"));
  expect(opus?.textContent).toContain("prov/only-sonnet");
  const sonnet = Array.from(container.querySelectorAll(".claude-desktop-advanced-chip"))
    .find(chip => chip.textContent?.startsWith("Sonnet"));
  expect(sonnet?.textContent).toContain("empty");
});
