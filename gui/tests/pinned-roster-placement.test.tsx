import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import { modelLabel } from "../src/model-display";
import Models from "../src/pages/Models";
import Subagents from "../src/pages/Subagents";
import { CLIENT_PICKER_ANCHOR } from "../src/pages/client-picker-jump";
import { readSettingsOpen } from "../src/pages/models-settings-summary";

/**
 * Where the pinned roster (config `subagentModels`) lives: one "Client model picker" section on
 * the Models page. The Subagents page only points at it and jumps there.
 */

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
const modelRows = ["a", "b"].map(id => ({ provider: "p", id, namespaced: `p/${id}`, disabled: false }));
let previous: Map<string, PropertyDescriptor | undefined>;
let win: Window;
let host: HTMLElement;
let root: Root | null;
let chosen: string[];
let scrolled: Element[];

function install(hash: string) {
  win = new Window({ url: `http://localhost/#${hash}` });
  win.localStorage.setItem("ocx-lang", "en");
  const values = {
    document: win.document, window: win, navigator: win.navigator,
    localStorage: win.localStorage, sessionStorage: win.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  scrolled = [];
  (win.HTMLElement.prototype as unknown as { scrollIntoView: (this: Element) => void }).scrollIntoView = function () { scrolled.push(this); };
  host = document.createElement("div");
  document.body.append(host);
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  chosen = ["p/a"];
  root = null;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost/").pathname;
      const payload = path === "/api/subagent-models"
        ? { available: ["p/a", "p/b"], chosen, pickerAvailable: ["p/a", "p/b"], pickerOrder: [], pickerOrderMode: null }
        : path === "/api/subagent-model-fallback" ? { models: [], pollMs: 60_000, available: ["p/a", "p/b"] }
        : path === "/api/injection-model" ? { model: null, effort: null, available: [], efforts: [] }
        : path === "/api/v2" ? { enabled: false, multiAgentMode: "default" }
        : path === "/api/models" ? modelRows
        : path === "/api/providers" ? [{ name: "p" }]
        : path === "/api/provider-context-caps" ? { caps: {} }
        : path === "/api/selected-models" ? { selected: {} }
        : path === "/api/aliases" ? { providers: {}, models: {}, defaults: { global: false, providers: {} } }
        : undefined;
      return Promise.resolve(payload === undefined ? new Response(null, { status: 404 }) : Response.json(payload));
    },
  });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  clearClientResourceStoresForTests();
  win.close();
  for (const key of globals) {
    const descriptor = previous.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount(page: "models" | "subagents") {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider>{page === "models" ? <Models apiBase="" /> : <Subagents apiBase="" />}</LanguageProvider>);
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
}

const pinnedPointer = () => host.querySelector(".subagents-pinned-pointer");
const pinnedModels = () => Array.from(host.querySelectorAll(".subagents-pinned-model"), node => node.textContent?.trim());

test("Models renders the pinned roster once, inside the client model picker section", async () => {
  install("models");
  await mount("models");

  const section = host.querySelector<HTMLElement>(`#${CLIENT_PICKER_ANCHOR}`);
  expect(section).toBeTruthy();
  expect(section!.querySelector("h3")?.textContent).toBe("Client model picker");
  const rosters = host.querySelectorAll(".picker-pinned-roster");
  expect(rosters).toHaveLength(1);
  expect(section!.contains(rosters[0]!)).toBe(true);
  expect(Array.from(section!.querySelectorAll(".swi-featured-name"), node => node.textContent?.trim())).toEqual([modelLabel("p/a")]);
  // The order and Fast rows controls belong to the same section.
  expect(section!.textContent).toContain("Pinned in picker");
  expect(section!.querySelector(".models-cap-row")).toBeTruthy();
});

test("Subagents shows the pinned models as a pointer, with no roster editor", async () => {
  install("subagents");
  await mount("subagents");

  expect(pinnedPointer()).toBeTruthy();
  expect(pinnedModels()).toEqual([modelLabel("p/a")]);
  expect(host.querySelector(".picker-pinned-roster")).toBeNull();
  expect(host.querySelector(".swi-featured-row")).toBeNull();
  expect(Array.from(pinnedPointer()!.querySelectorAll("button"), node => node.textContent?.trim())).toEqual(["Edit on Models"]);
});

test("Subagents says so when nothing is pinned", async () => {
  chosen = [];
  install("subagents");
  await mount("subagents");

  expect(pinnedModels()).toEqual([]);
  expect(pinnedPointer()!.textContent).toContain("nothing pinned yet");
});

test("the Subagents jump opens Models settings and the section scrolls itself into view once", async () => {
  install("subagents");
  await mount("subagents");
  expect(readSettingsOpen()).toBe(false);

  const jump = pinnedPointer()!.querySelector<HTMLButtonElement>("button")!;
  await act(async () => { jump.click(); });
  expect(win.location.hash).toBe("#models");
  expect(readSettingsOpen()).toBe(true);

  // The router swaps the page; the section consumes the one-shot jump when it mounts.
  await act(async () => { root!.unmount(); });
  root = null;
  host.replaceChildren();
  await mount("models");
  const section = host.querySelector(`#${CLIENT_PICKER_ANCHOR}`)!;
  expect(scrolled).toHaveLength(1);
  expect(scrolled[0]).toBe(section);

  // A later visit to Models does not scroll again.
  await act(async () => { root!.unmount(); });
  root = null;
  host.replaceChildren();
  await mount("models");
  expect(scrolled).toHaveLength(1);
});
