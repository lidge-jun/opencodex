import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Subagents from "../src/pages/Subagents";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";

/**
 * Featured roster edits save themselves. Writes are serialized: while one PUT is in flight,
 * edits stay enabled and only the newest list waits. The server's applied list wins, and a
 * failed final write restores the last list the server accepted.
 */

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let available: string[] = [];
let chosen: string[] = [];
let putBodies: string[][] = [];
let gates: Array<() => void> = [];
let outcomes: Array<"ok" | "fail"> = [];
let appliedOverride: string[] | null = null;

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

  available = ["a-1", "a-2", "a-3", "a-4"];
  chosen = ["a-1", "a-2"];
  putBodies = [];
  gates = [];
  outcomes = [];
  appliedOverride = null;
  // The roster resource store is module state; a cached roster would skip the load under test.
  clearClientResourceStoresForTests();

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const models = (JSON.parse(String(init.body)) as { models: string[] }).models;
        putBodies.push(models);
        await new Promise<void>((resolve) => { gates.push(resolve); });
        if (outcomes.shift() === "fail") {
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: "disk full" }),
            text: async () => JSON.stringify({ error: "disk full" }),
          } as unknown as Response;
        }
        const applied = appliedOverride ?? models;
        return {
          ok: true,
          status: 200,
          json: async () => ({ applied }),
          text: async () => JSON.stringify({ applied }),
        } as unknown as Response;
      }
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
  for (const release of gates.splice(0)) release();
  if (root) {
    const current = root;
    await act(async () => {
      current.unmount();
    });
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
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

/** Lets the oldest outstanding PUT answer, then lets the page react. */
async function releaseNextPut() {
  const release = gates.shift();
  if (!release) throw new Error("no PUT is waiting");
  await act(async () => {
    release();
    await new Promise((r) => setTimeout(r, 20));
  });
}

function addToggle(id: string): HTMLButtonElement {
  const row = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.getAttribute("aria-label") ?? "").includes(`Add ${id} to featured`),
  );
  if (!row) throw new Error(`add toggle not found: ${id}`);
  return row as unknown as HTMLButtonElement;
}

/** Featured-list remove only (rail also has "Remove … from featured"). */
function removeButton(id: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll(".swi-featured-actions button")).find(
    (b) => b.getAttribute("aria-label") === `Remove ${id}`,
  );
  if (!btn) throw new Error(`remove not found: ${id}`);
  return btn as unknown as HTMLButtonElement;
}

function featured(): string[] {
  return Array.from(container.querySelectorAll(".swi-featured-actions button"))
    .map((b) => b.getAttribute("aria-label") ?? "")
    .filter((label) => /^Remove /.test(label))
    .map((label) => label.slice("Remove ".length));
}

async function click(button: HTMLButtonElement) {
  expect(button.disabled).toBe(false);
  await act(async () => {
    button.click();
  });
}

test("edits stay enabled while a save is in flight and only the newest list is sent next", async () => {
  await mount();
  expect(featured()).toEqual(["a-1", "a-2"]);

  await click(addToggle("a-3"));
  expect(putBodies).toEqual([["a-1", "a-2", "a-3"]]);

  // Two more edits while the first write is outstanding: both apply locally, neither is sent yet.
  await click(addToggle("a-4"));
  await click(removeButton("a-1"));
  expect(featured()).toEqual(["a-2", "a-3", "a-4"]);
  expect(putBodies.length).toBe(1);

  await releaseNextPut();
  // The intermediate list is skipped; the queued write carries the latest roster.
  expect(putBodies).toEqual([["a-1", "a-2", "a-3"], ["a-2", "a-3", "a-4"]]);
  expect(featured()).toEqual(["a-2", "a-3", "a-4"]);

  await releaseNextPut();
  expect(putBodies.length).toBe(2);
  expect(featured()).toEqual(["a-2", "a-3", "a-4"]);
  expect(container.textContent).toContain("Saved 3 models");
});

test("the server's applied list replaces the local roster", async () => {
  appliedOverride = ["a-1"];
  await mount();

  await click(addToggle("a-3"));
  expect(featured()).toEqual(["a-1", "a-2", "a-3"]);
  await releaseNextPut();

  expect(featured()).toEqual(["a-1"]);
  expect(container.textContent).toContain("1/5");
});

test("a failed save restores the last saved roster and reports the error", async () => {
  outcomes = ["fail"];
  await mount();

  await click(addToggle("a-3"));
  expect(featured()).toEqual(["a-1", "a-2", "a-3"]);
  await releaseNextPut();
  await settle();

  expect(featured()).toEqual(["a-1", "a-2"]);
  expect(container.textContent).toContain("disk full");
});

test("a failed write that a newer edit supersedes does not roll the roster back", async () => {
  outcomes = ["fail", "ok"];
  await mount();

  await click(addToggle("a-3"));
  await click(addToggle("a-4"));
  await releaseNextPut();
  expect(putBodies).toEqual([["a-1", "a-2", "a-3"], ["a-1", "a-2", "a-3", "a-4"]]);

  await releaseNextPut();
  expect(featured()).toEqual(["a-1", "a-2", "a-3", "a-4"]);
  expect(container.textContent).not.toContain("disk full");
});

