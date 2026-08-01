import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ClaudeDesktop from "../src/pages/ClaudeDesktop";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";

/**
 * The family stack is vertical and collapsible. These are mounted rather than
 * source-shape tests because the interesting failures are interactive: a folded family
 * must still accept a drop, the header must keep reporting the TRUE total while a
 * search narrows the body, and a collapse must never be re-derived out from under the
 * user when a move changes the family counts.
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
        ? { applied: true, appliedAt: null, stale: false, health: { lastRequestAt: null, requestCount: 0, errorCount: 0 } }
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

function familyToggle(name: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button.ocx-group-toggle"))
    .find(button => (button.textContent ?? "").includes(name));
  if (!found) throw new Error(`family toggle not found: ${name}`);
  return found as unknown as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
}

test("families render as a vertical stack, Opus first", async () => {
  await mount();
  expect(container.querySelector(".ocx-group-stack")).not.toBeNull();
  // The old 4-column kanban container is gone.
  expect(container.querySelector(".claude-lanes")).toBeNull();
  const names = Array.from(container.querySelectorAll(".ocx-group-name")).map(n => n.textContent);
  expect(names).toEqual(["Opus", "Fable", "Sonnet", "Haiku"]);
});

test("all families fold on first load", async () => {
  await mount();
  expect(familyToggle("Opus").getAttribute("aria-expanded")).toBe("false");
  expect(familyToggle("Sonnet").getAttribute("aria-expanded")).toBe("false");
  expect(familyToggle("Fable").getAttribute("aria-expanded")).toBe("false");
  expect(familyToggle("Haiku").getAttribute("aria-expanded")).toBe("false");
});

test("toggling a family hides its body and persists the preference", async () => {
  await mount();
  expect(container.querySelector("#claude-lane-body-opus")).toBeNull();
  await click(familyToggle("Opus"));
  expect(familyToggle("Opus").getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector("#claude-lane-body-opus")).not.toBeNull();

  await click(familyToggle("Opus"));
  expect(familyToggle("Opus").getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector("#claude-lane-body-opus")).toBeNull();

  const stored = testWindow.localStorage.getItem("ocx.claudeDesktop.collapsedFamilies.v2");
  expect(stored).not.toBeNull();
  expect(JSON.parse(stored!)).toContain("opus");
});

// The drop handler lives on the <section>, so folding a family must not remove it as a
// drop target — otherwise collapse would silently break drag-and-drop assignment.
test("a collapsed family still accepts a dropped model", async () => {
  await mount();
  // Fable is empty, so it is already folded by the load-time default.
  expect(familyToggle("Fable").getAttribute("aria-expanded")).toBe("false");

  const fableSection = Array.from(container.querySelectorAll("section.ocx-group"))
    .find(section => (section.querySelector(".ocx-group-name")?.textContent ?? "") === "Fable")!;

  await act(async () => {
    const event = new testWindow.Event("drop", { bubbles: true }) as unknown as Event & { dataTransfer: unknown };
    Object.defineProperty(event, "dataTransfer", { value: { getData: () => "prov/opus-0" } });
    fableSection.dispatchEvent(event as never);
  });

  // Fable's header count proves the move landed even though the family is folded.
  const fableCount = fableSection.querySelector(".ocx-group-count")?.textContent ?? "";
  expect(fableCount).toContain("1");
});

// Search narrows the RENDERED list only. If the header count followed the filter, a user
// typing in the box would believe models had been unassigned.
test("the header count ignores the search", async () => {
  await mount();
  await click(familyToggle("Opus"));
  const opusSection = Array.from(container.querySelectorAll("section.ocx-group"))
    .find(section => (section.querySelector(".ocx-group-name")?.textContent ?? "") === "Opus")!;
  expect(opusSection.querySelector(".ocx-group-count")?.textContent).toContain("7");

  const search = opusSection.querySelector("input.claude-lane-search") as unknown as HTMLInputElement;
  await act(async () => {
    search.value = "Opus Model 3";
    search.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
  });

  expect(opusSection.querySelector(".ocx-group-count")?.textContent).toContain("7");
});

// Regression for the WP1 focused audit: an earlier design derived collapse from the
// live family counts, so moving the last model out of a family folded it mid-gesture.
test("moving a model does not re-fold the family the user is working in", async () => {
  await mount();
  await click(familyToggle("Sonnet"));
  const sonnetSection = Array.from(container.querySelectorAll("section.ocx-group"))
    .find(section => (section.querySelector(".ocx-group-name")?.textContent ?? "") === "Sonnet")!;
  expect(sonnetSection.querySelector("button.ocx-group-toggle")!.getAttribute("aria-expanded")).toBe("true");

  // Move Sonnet's only model to Opus by dropping it there.
  const opusSection = Array.from(container.querySelectorAll("section.ocx-group"))
    .find(section => (section.querySelector(".ocx-group-name")?.textContent ?? "") === "Opus")!;
  await act(async () => {
    const event = new testWindow.Event("drop", { bubbles: true });
    Object.defineProperty(event, "dataTransfer", { value: { getData: () => "prov/only-sonnet" } });
    opusSection.dispatchEvent(event as never);
  });

  // Sonnet is now empty, but it must stay OPEN: the user never asked to fold it.
  const sonnetAfter = Array.from(container.querySelectorAll("section.ocx-group"))
    .find(section => (section.querySelector(".ocx-group-name")?.textContent ?? "") === "Sonnet")!;
  expect(sonnetAfter.querySelector("button.ocx-group-toggle")!.getAttribute("aria-expanded")).toBe("true");
});

test("a stored preference wins over the load-time default", async () => {
  // Only Opus folded — every other family stays open despite the all-collapsed default.
  testWindow.localStorage.setItem("ocx.claudeDesktop.collapsedFamilies.v2", JSON.stringify(["opus"]));
  await mount();
  expect(familyToggle("Opus").getAttribute("aria-expanded")).toBe("false");
  expect(familyToggle("Fable").getAttribute("aria-expanded")).toBe("true");
});
