import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ClaudeDesktop from "../src/pages/ClaudeDesktop";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { preserveDesktopAppliedState, type DesktopProfile } from "../../src/claude/desktop-profile";

/**
 * #7702: the Desktop model list is a per-model selection. Mounted, because the contract is
 * the save body the page sends and the saved/applied state it shows.
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

// A stored default whose long route went unavailable (R4 audit: it overflowed the Models card).
const STALE_ROUTE = "openrouter/anthropic/claude-sonnet-4.5-thinking-extended-context-preview-20260930";
let withStaleDefault = false;
let puts: Array<Record<string, unknown>> = [];
// Desktop currently runs every model, so a saved narrower selection is pending apply.
let appliedModels: Array<{ name: string; label: string }> = [];
let savedProfile: DesktopProfile | null = null;

function payload() {
  const models = withStaleDefault ? [...MODELS, model(STALE_ROUTE, STALE_ROUTE, "opus", false)] : MODELS;
  return {
    profile: savedProfile ?? {
      version: 1 as const,
      assignments: Object.fromEntries(models.map(m => [m.route, m.assignment])),
      defaults: { opus: withStaleDefault ? STALE_ROUTE : "prov/opus-0", fable: null, sonnet: "prov/only-sonnet", haiku: null },
    },
    models,
    rendered: models.map(m => ({ route: m.route, name: `claude-${m.route.replace(/\W/g, "-")}`, label: m.label })),
    visibility: savedVisibility,
    port: 10100,
  };
}

let savedVisibility: unknown = null;

beforeEach(() => {
  withStaleDefault = false;
  puts = [];
  savedVisibility = null;
  savedProfile = null;
  appliedModels = MODELS.map(m => ({ name: `claude-${m.route.replace(/\W/g, "-")}`, label: m.label }));
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
    value: async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const request = JSON.parse(String(init.body));
        puts.push(request);
        if (savedProfile) savedProfile = preserveDesktopAppliedState(savedProfile, request.profile);
      }
      const body = String(url).includes("/status")
        ? { desiredEnabled: true, applied: true, appliedAt: null, stale: savedProfile !== null && !savedProfile.appliedFingerprint, appliedModels, health: { lastRequestAt: null, requestCount: 0, errorCount: 0 } }
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

function checkbox(label: string): HTMLInputElement {
  const found = container.querySelector(`input[type="checkbox"][aria-label="Show ${label} in Claude Desktop"]`);
  if (!found) throw new Error(`checkbox not found: ${label}`);
  return found as unknown as HTMLInputElement;
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(b => (b.textContent ?? "").trim() === text);
  if (!found) throw new Error(`button not found: ${text}`);
  return found as unknown as HTMLButtonElement;
}

test("unchecking a model marks the page unsaved and saves an exclude selection with the profile", async () => {
  await mount();
  expect(container.querySelector(".claude-visibility-counts")?.textContent).toContain("8 selected");
  expect(checkbox("Opus Model 1").checked).toBe(true);
  await act(async () => { checkbox("Opus Model 1").click(); });
  expect(checkbox("Opus Model 1").checked).toBe(false);
  expect(container.querySelector(".claude-dirty")?.textContent).toBe("Unsaved changes");
  expect(container.querySelector(".claude-visibility-preview")?.textContent).toContain("Removes: Opus Model 1");
  await act(async () => { button("Save").click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(puts).toHaveLength(1);
  expect(puts[0]!.visibility).toEqual({ mode: "exclude", routes: ["prov/opus-1"] });
  expect(puts[0]!.profile).toBeDefined();
});

test("a saved selection Desktop has not received yet reads as pending apply, not up to date", async () => {
  savedVisibility = { mode: "include", routes: ["prov/opus-0"] };
  await mount();
  expect(checkbox("Opus Model 1").checked).toBe(false);
  expect(container.querySelector(".claude-status-bar")?.className).toContain("stale");
  expect(container.querySelector(".claude-status-bar")?.textContent).toContain("Saved — apply to update Desktop");
  expect(container.querySelector(".claude-dirty")?.textContent).toBe("All changes saved");
});

test("clearing every shown model blocks saving", async () => {
  await mount();
  await act(async () => { button("Deselect all matching models").click(); });
  expect(container.textContent).toContain("Select at least one available model.");
  expect(button("Save").disabled).toBe(true);
});

test("editing a draft keeps a newer saved selection pending apply", async () => {
  savedVisibility = { mode: "include", routes: ["prov/opus-0"] };
  await mount();
  await act(async () => { checkbox("Opus Model 1").click(); });
  expect(container.querySelector(".claude-dirty")?.textContent).toBe("Unsaved changes");
  expect(container.querySelector(".claude-status-bar")?.textContent).toContain("Saved — apply to update Desktop");
});

test("saving a new family default without applying does not claim external file edits", async () => {
  savedProfile = { ...payload().profile, appliedFingerprint: "unchanged-desktop-bytes" } as DesktopProfile;
  const desktopModels = structuredClone(appliedModels);
  await mount();
  const family = container.querySelector("#claude-lane-opus button") as unknown as HTMLButtonElement;
  if (family.getAttribute("aria-expanded") === "false") await act(async () => { family.click(); });
  const radio = container.querySelector('input[type="radio"][name="default-opus"]') as unknown as HTMLInputElement;
  expect(radio).not.toBeNull();
  // The first model is already the default; open a second model and choose it instead.
  const summary = Array.from(container.querySelectorAll("button.claude-model-summary"))
    .find(node => node.textContent?.includes("Opus Model 1")) as unknown as HTMLButtonElement;
  await act(async () => { summary.click(); });
  const secondDefault = container.querySelectorAll('input[type="radio"][name="default-opus"]')[1] as unknown as HTMLInputElement;
  await act(async () => { secondDefault.click(); });
  expect(button("Save").disabled).toBe(false);
  await act(async () => { button("Save").click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(puts).toHaveLength(1);
  expect(savedProfile!.defaults.opus).toBe("prov/opus-1");
  expect(savedProfile!.appliedFingerprint).toBeUndefined();
  expect(appliedModels).toEqual(desktopModels);
  expect(container.querySelector(".claude-dirty")?.textContent).toBe("All changes saved");
  expect(container.querySelector(".claude-status-bar")?.textContent)
    .toContain("Desktop configuration is out of date — re-apply");
});

test("bulk labels disclose that matching rows beyond Show more are included", async () => {
  await mount();
  const actions = container.querySelectorAll<HTMLButtonElement>(".claude-visibility-filters button");
  expect(container.querySelectorAll(".claude-desktop-list-row")).toHaveLength(6);
  await act(async () => { actions[1]!.click(); });
  expect(container.querySelector(".claude-visibility-counts")?.textContent).toContain("0 selected");
  await act(async () => { actions[0]!.click(); });
  expect(container.querySelector(".claude-visibility-counts")?.textContent).toContain("8 selected");
  expect(actions[0]!.textContent).toBe("Select all matching");
  expect(actions[1]!.textContent).toBe("Deselect all matching models");
});

test("an equal preview asks to apply profile changes before restarting Desktop", async () => {
  await mount();
  expect(container.querySelector(".claude-visibility-preview")?.textContent)
    .toContain("The profile contains the same model IDs. Apply profile changes before restarting Desktop.");
});
