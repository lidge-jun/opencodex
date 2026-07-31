import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Grok from "../src/pages/Grok";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";

/**
 * The Grok switch surface. Mounted because the failures worth catching are stateful:
 * dirty tracking, the save/apply sequence, and the policy-skip path that must NOT read
 * as success.
 */

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

let selectionPuts: string[] = [];
let applyPosts = 0;
let applyResponse: Record<string, unknown> = { ok: true, changed: true };
let present = true;

const STATUS = () => ({
  configPath: "/home/u/.grok/config.toml",
  present,
  baseUrl: "http://127.0.0.1:10100/v1",
  models: [{ alias: "ocx-gpt-5-6-sol", id: "gpt-5.6-sol", contextWindow: 372_000 }],
  candidates: [
    { id: "gpt-5.6-sol", contextWindow: 372_000, native: true },
    { id: "cursor/grok-4.5", contextWindow: 500_000, native: false },
  ],
  excluded: [] as string[],
});

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  // The page reads through the shared resource layer, whose cache is module-level: without this
  // the previous case's payload seeds the next mount and hides the state under test.
  clearClientResourceStoresForTests();
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  testWindow.localStorage.setItem("ocx.grok.collapsedGroups.v2", JSON.stringify([]));
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  selectionPuts = [];
  applyPosts = 0;
  applyResponse = { ok: true, changed: true };
  present = true;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/grok/selection") && init?.method === "PUT") {
        selectionPuts.push(String(init.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, excluded: JSON.parse(String(init.body)).excluded }) } as unknown as Response;
      }
      if (u.endsWith("/api/grok/apply") && init?.method === "POST") {
        applyPosts += 1;
        return { ok: true, status: 200, json: async () => applyResponse } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => STATUS() } as unknown as Response;
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
    root.render(<LanguageProvider><Grok apiBase="" /></LanguageProvider>);
  });
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });
}

function switchFor(id: string): HTMLButtonElement {
  const row = Array.from(container.querySelectorAll(".grok-model-row"))
    .find(el => (el.textContent ?? "").includes(id));
  const sw = row?.querySelector("button.switch");
  if (!sw) throw new Error(`switch not found for ${id}`);
  return sw as unknown as HTMLButtonElement;
}

function saveApplyButton(): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button.btn-primary"))
    .find(b => (b.textContent ?? "").length > 0);
  if (!btn) throw new Error("save-apply button not found");
  return btn as unknown as HTMLButtonElement;
}

function saveOnlyButton(): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button.btn-ghost"))
    .find(b => (b.textContent ?? "").includes("Save"));
  if (!btn) throw new Error("save-only button not found");
  return btn as unknown as HTMLButtonElement;
}

test("each candidate renders a switch reflecting the exclusion state", async () => {
  await mount();
  expect(switchFor("gpt-5.6-sol").className).toContain("on");
  expect(switchFor("cursor/grok-4.5").className).toContain("on");
});

test("flipping a switch marks the page dirty and Save & apply writes both endpoints in order", async () => {
  await mount();
  expect(saveApplyButton().disabled).toBe(true);

  await act(async () => { switchFor("cursor/grok-4.5").click(); });
  expect(saveApplyButton().disabled).toBe(false);

  await act(async () => { saveApplyButton().click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });

  expect(selectionPuts).toEqual([JSON.stringify({ excluded: ["cursor/grok-4.5"] })]);
  expect(applyPosts).toBe(1);
  // After a successful apply the page reloads and is clean again.
  expect(saveApplyButton().disabled).toBe(true);
});

// Save-only does NOT reload, so the acknowledged selection has to be published into the
// resource store before the draft is dropped. Otherwise clearing the draft falls back to
// the pre-save snapshot: the switch silently springs back to registered while the bar
// claims the selection is up to date.
test("save without apply keeps the flipped switch off and reports up to date", async () => {
  await mount();
  await act(async () => { switchFor("cursor/grok-4.5").click(); });
  expect(switchFor("cursor/grok-4.5").className).not.toContain("on");

  await act(async () => { saveOnlyButton().click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });

  expect(selectionPuts).toEqual([JSON.stringify({ excluded: ["cursor/grok-4.5"] })]);
  expect(applyPosts).toBe(0);
  expect(switchFor("cursor/grok-4.5").className).not.toContain("on");
  expect(switchFor("gpt-5.6-sol").className).toContain("on");
  expect(container.textContent).toContain("Selection is up to date");
  expect(saveOnlyButton().disabled).toBe(true);
});

// The policy-skip path is the one that must never read as success: the user's Grok
// config did NOT change.
test("a skipped apply renders the not-changed message, not success", async () => {
  applyResponse = { ok: true, changed: false, skippedReason: "no-grok-home", message: "Grok home not found; config injection skipped." };
  await mount();
  await act(async () => { switchFor("cursor/grok-4.5").click(); });
  await act(async () => { saveApplyButton().click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });

  const notice = container.querySelector(".notice-err");
  expect(notice?.textContent).toContain("Grok home not found");
  expect(container.querySelector(".notice-ok")).toBeNull();
});

test("a failed selection PUT surfaces an error and stays dirty", async () => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/grok/selection")) {
        return { ok: false, status: 500, json: async () => ({ error: "boom" }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => STATUS() } as unknown as Response;
    },
  });
  await mount();
  await act(async () => { switchFor("cursor/grok-4.5").click(); });
  await act(async () => { saveApplyButton().click(); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });

  expect(container.querySelector(".notice-err")?.textContent).toContain("boom");
  expect(saveApplyButton().disabled).toBe(false);
});

// Absent Grok is a state, not an error: switches still render so the user can pick
// models before Grok exists.
test("with Grok absent, the empty state names the next action and switches still render", async () => {
  present = false;
  await mount();
  expect(container.textContent).toContain("Grok Build is not wired up");
  expect(switchFor("gpt-5.6-sol")).toBeDefined();
});
