import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Subagents from "../src/pages/Subagents";
import { LanguageProvider } from "../src/i18n/provider";

/**
 * Behavioural contract for the denser Subagents workspace: five-slot cap,
 * add/remove via the rail, and the exact autosave request.
 */

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let requests: { url: string; init?: RequestInit }[] = [];
let available: string[] = [];
let chosen: string[] = [];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  requests = [];
  available = ["a-1", "a-2", "a-3", "a-4", "a-5", "a-6"];
  chosen = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      const body = JSON.stringify({ available, chosen });
      return {
        ok: true,
        status: 200,
        text: async () => body,
        json: async () => ({ available, chosen }),
      } as unknown as Response;
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
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount() {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Subagents apiBase="" />
      </LanguageProvider>,
    );
  });
  // Subagents defers its initial load through setTimeout(0), so a macrotask flush is required.
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
}

/** Rail add/remove toggles are labelled from sub.workspace.addToFeatured / removeFromFeatured. */
function addToggle(id: string): HTMLButtonElement {
  const row = Array.from(container.querySelectorAll("button"))
    .find((b) => (b.getAttribute("aria-label") ?? "").includes(`Add ${id} to featured`));
  if (!row) throw new Error(`add toggle not found: ${id}`);
  return row as unknown as HTMLButtonElement;
}

/** Featured-list remove only (rail also has "Remove … from featured"). */
function removeButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll(".swi-featured-actions button")).filter((b) =>
    /^Remove /.test(b.getAttribute("aria-label") ?? "")) as unknown as HTMLButtonElement[];
}

test("renders one featured list and one picker, never the same list twice", async () => {
  await mount();
  expect(container.querySelector(".subagents-workspace-shell")).toBeTruthy();
  // Three stacked sections: the featured roster, the model picker, then delegation settings.
  expect(container.querySelectorAll(".subagents-workspace-section").length).toBe(3);
  // The rail listed the featured models a second time, which read as a rendering bug.
  expect(container.querySelector(".subagents-workspace-rail")).toBeNull();
  const featuredHeadings = Array.from(container.querySelectorAll(".swi-featured-title"))
    .map(node => node.textContent?.trim());
  expect(featuredHeadings.filter(text => text === "Featured").length).toBe(1);
});

test("caps featured selections at five", async () => {
  await mount();

  // Six models available, six clicks — only five may land.
  for (const id of available) {
    const toggle = addToggle(id);
    if (!toggle.disabled) {
      await act(async () => { toggle.click(); });
    }
  }

  expect(removeButtons().length).toBe(5);
  expect(container.textContent).toContain("5/5");
  // The sixth add toggle is disabled rather than silently appended.
  expect(addToggle(available[5]!).disabled).toBe(true);

  // The cap lives in TWO places: the disabled attribute above (presentation) and the
  // state guard in toggle(). Force a click past the disabled attribute so a weakened
  // state guard cannot hide behind the UI check.
  await act(async () => { addToggle(available[5]!).dispatchEvent(new (globalThis as any).window.MouseEvent("click", { bubbles: true })); });
  expect(removeButtons().length).toBe(5);

  // Every edit saved itself, and no autosave ever shipped more than five.
  const puts = requests.filter((r) => r.init?.method === "PUT");
  expect(puts.length).toBe(5);
  expect(puts.every((r) => JSON.parse(String(r.init!.body)).models.length <= 5)).toBe(true);
  expect(JSON.parse(String(puts.at(-1)!.init!.body)).models).toEqual(available.slice(0, 5));
});

test("adding a model saves the featured order without a Save button", async () => {
  await mount();
  const featuredSection = container.querySelector(".subagents-workspace-section")!;
  expect(Array.from(featuredSection.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Save")).toBe(false);

  await act(async () => { addToggle("a-1").click(); });
  await act(async () => { addToggle("a-2").click(); });

  const puts = requests.filter((r) => r.init?.method === "PUT");
  expect(puts.map((r) => r.url)).toEqual(["/api/subagent-models", "/api/subagent-models"]);
  expect(puts.map((r) => r.init?.body)).toEqual([
    JSON.stringify({ models: ["a-1"] }),
    JSON.stringify({ models: ["a-1", "a-2"] }),
  ]);
});
