import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ClaudeDesktop from "../src/pages/ClaudeDesktop";
import { LanguageProvider } from "../src/i18n/provider";

/**
 * Second disclosure tier: a model row is a one-line summary until opened.
 *
 * Mounted rather than source-shape, because the failures worth catching are stateful —
 * most importantly that collapsing a row must not discard a pending move destination.
 * `destinations` is page-level state keyed by route, and this test is the only thing
 * proving nobody moves it into the row component later.
 */

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

const MODELS = [
  { route: "prov/first", label: "First Model", available: true, contextWindow: 200_000, effortSupported: true, supports1m: false, assignment: { family: "opus", alias: "claude-opus-first" } },
  { route: "prov/second", label: "Second Model", available: true, contextWindow: 1_000_000, effortSupported: false, supports1m: true, assignment: { family: "opus", alias: "claude-opus-second" } },
];

function payload() {
  return {
    profile: {
      version: 1,
      assignments: Object.fromEntries(MODELS.map(m => [m.route, m.assignment])),
      defaults: { opus: "prov/first", fable: null, sonnet: null, haiku: null },
    },
    models: MODELS,
    rendered: [],
    port: 10100,
  };
}

beforeEach(() => {
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
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount() {
  // Row-disclosure tests need the Opus family open; family fold is covered elsewhere.
  testWindow.localStorage.setItem("ocx.claudeDesktop.collapsedFamilies.v2", JSON.stringify([]));
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><ClaudeDesktop apiBase="" /></LanguageProvider>);
  });
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });
}

function row(label: string): HTMLElement {
  const found = Array.from(container.querySelectorAll("article.claude-model-card"))
    .find(article => (article.querySelector(".claude-model-names strong")?.textContent ?? "") === label);
  if (!found) throw new Error(`row not found: ${label}`);
  return found as unknown as HTMLElement;
}

function summary(label: string): HTMLButtonElement {
  return row(label).querySelector("button.claude-model-summary") as unknown as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
}

test("a non-default row starts collapsed with no edit controls in the DOM", async () => {
  await mount();
  const second = row("Second Model");
  expect(summary("Second Model").getAttribute("aria-expanded")).toBe("false");
  expect(second.querySelector(".claude-model-body")).toBeNull();
  expect(second.querySelector(".claude-alias")).toBeNull();
  expect(second.querySelector("input[type=radio]")).toBeNull();
  expect(second.querySelector("select")).toBeNull();
});

// The row a user came to change should not need a second click to reach.
test("the family's resolved default starts open", async () => {
  await mount();
  expect(summary("First Model").getAttribute("aria-expanded")).toBe("true");
  expect(row("First Model").querySelector(".claude-alias")?.textContent).toBe("claude-opus-first");
});

test("opening a row reveals alias, default radio and the move control", async () => {
  await mount();
  await click(summary("Second Model"));

  const second = row("Second Model");
  expect(summary("Second Model").getAttribute("aria-expanded")).toBe("true");
  expect(second.querySelector(".claude-alias")?.textContent).toBe("claude-opus-second");
  expect(second.querySelector("input[type=radio]")).not.toBeNull();
  expect(second.querySelector("select")).not.toBeNull();
});

// Triage information must never go behind the fold: availability, context and effort
// are what you scan to decide which model becomes the family default.
test("availability, context and effort stay readable while collapsed", async () => {
  await mount();
  const second = row("Second Model");
  expect(second.querySelector(".badge")?.textContent).toBe("Available");
  expect(second.querySelector(".claude-model-context")?.textContent).toContain("1M");
  expect(second.querySelector(".claude-effort-badge")).not.toBeNull();
});

test("the family default is marked in the collapsed summary", async () => {
  await mount();
  expect(row("First Model").querySelector(".claude-row-default")?.textContent).toBe("Default");
  expect(row("Second Model").querySelector(".claude-row-default")).toBeNull();
});

// The regression the design predicts but does not guarantee: `destinations` is page
// state keyed by route, so unmounting the row must not lose a pending selection. If
// someone later moves that state into the row, this fails.
test("a pending move destination survives collapsing and reopening the row", async () => {
  await mount();
  await click(summary("Second Model"));

  const select = row("Second Model").querySelector("select") as unknown as HTMLSelectElement;
  await act(async () => {
    select.value = "sonnet";
    select.dispatchEvent(new testWindow.Event("change", { bubbles: true }) as never);
  });

  await click(summary("Second Model"));
  expect(summary("Second Model").getAttribute("aria-expanded")).toBe("false");
  await click(summary("Second Model"));

  const reopened = row("Second Model").querySelector("select") as unknown as HTMLSelectElement;
  expect(reopened.value).toBe("sonnet");
});

test("a collapsed row is still draggable", async () => {
  await mount();
  const second = row("Second Model");
  expect(summary("Second Model").getAttribute("aria-expanded")).toBe("false");
  expect(second.getAttribute("draggable")).toBe("true");
});

test("a 1M-capable row shows the 1M chip; a below-threshold row does not", async () => {
  await mount();
  // Second Model is 1_000_000 (supports1m) — the chip shows in the collapsed summary.
  // First Model is 200_000 — a context number alone is not eligibility, so no chip.
  expect(row("Second Model").querySelector(".claude-1m-chip")?.textContent).toBe("1M");
  expect(row("First Model").querySelector(".claude-1m-chip")).toBeNull();
});
