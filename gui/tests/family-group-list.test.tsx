import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { FamilyGroupList } from "../src/components/FamilyGroupList";
import { LanguageProvider } from "../src/i18n/provider";
import { FAMILY_COLLAPSED_KEY, familyGroupKey, readCollapsedFamilies, toggleCollapsedFamily } from "../src/model-family-groups";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Map<string, PropertyDescriptor | undefined>;
let win: Window, host: HTMLElement, root: Root | null;

beforeEach(() => {
  previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  win = new Window({ url: "http://localhost/#models" });
  win.localStorage.setItem("ocx-lang", "en");
  const values = { document: win.document, window: win, navigator: win.navigator,
    localStorage: win.localStorage, sessionStorage: win.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  host = document.createElement("div"); document.body.append(host); root = null;
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  win.close();
  for (const key of globals) {
    const descriptor = previous.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function render(items: string[], scope = "agy") {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root ??= createRoot(host);
    root.render(<LanguageProvider><FamilyGroupList items={items} slugOf={slug => slug} scope={scope}
      renderItem={slug => <div key={slug} className="row-probe">{slug}</div>} /></LanguageProvider>);
  });
}
const heads = () => [...host.querySelectorAll<HTMLButtonElement>(".model-family-head")];
const rows = () => [...host.querySelectorAll(".row-probe")].map(row => row.textContent);

test("groups by family in registry order with a count and aria-expanded", async () => {
  await render(["a/claude-opus", "a/gpt-6", "a/gemini-3", "a/gpt-5", "a/mystery"]);
  expect(heads().map(head => head.textContent)).toEqual(["GPT2", "Gemini1", "Claude1", "Other1"]);
  expect(heads().every(head => head.getAttribute("aria-expanded") === "true")).toBe(true);
  expect(rows()).toEqual(["a/gpt-6", "a/gpt-5", "a/gemini-3", "a/claude-opus", "a/mystery"]);
  expect(heads()[0]!.getAttribute("aria-label")).toBe("GPT: 2 models");
});

test("collapsing hides the rows and is remembered across a remount", async () => {
  await render(["a/gpt-6", "a/gemini-3"]);
  await act(async () => { heads()[0]!.click(); });
  expect(heads()[0]!.getAttribute("aria-expanded")).toBe("false");
  expect(rows()).toEqual(["a/gemini-3"]);
  expect(JSON.parse(localStorage.getItem(FAMILY_COLLAPSED_KEY)!)).toEqual([familyGroupKey("agy", "gpt")]);
  await act(async () => { root!.unmount(); });
  root = null;
  await render(["a/gpt-6", "a/gemini-3"]);
  expect(rows()).toEqual(["a/gemini-3"]);
  await render(["a/gpt-6", "a/gemini-3"], "other-provider");
  expect(rows()).toEqual(["a/gpt-6", "a/gemini-3"]);
});

test("one family renders flat without a header", async () => {
  await render(["a/gpt-6", "a/gpt-5"]);
  expect(heads()).toHaveLength(0);
  expect(rows()).toEqual(["a/gpt-6", "a/gpt-5"]);
});

test("a toggle keeps keys a sibling list stored and survives unreadable storage", () => {
  const store = new Map<string, string>([[FAMILY_COLLAPSED_KEY, JSON.stringify(["x"])]]);
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  expect([...toggleCollapsedFamily("y", storage)]).toEqual(["x", "y"]);
  expect([...toggleCollapsedFamily("x", storage)]).toEqual(["y"]);
  expect([...readCollapsedFamilies({ getItem: () => "{not json", setItem: () => {} })]).toEqual([]);
});
