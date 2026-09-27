import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import CodexDesktopCompatibility from "../src/pages/codex-desktop-compatibility";
import { clearClientResourceStoresForTests } from "../src/client-resource";

const keys = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>, page: Window, root: Root | undefined;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  clearClientResourceStoresForTests();
  previous = Object.fromEntries(keys.map(key => [key, Reflect.get(globalThis, key)]));
  page = new Window({ url: "http://localhost/#codex-set/desktop" });
  page.localStorage.setItem("ocx-lang", "en");
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(page, key) });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = undefined;
  globalThis.fetch = originalFetch; page.close();
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});
const requests: { url: string; method: string; body?: unknown }[] = [];
function server(uncertain = false) {
  requests.length = 0; let trusted = false;
  globalThis.fetch = (async (input, init) => {
    const url = String(input), method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "POST") { trusted = true; if (uncertain) throw new TypeError("uncertain response"); return Response.json({ ok: true }); }
    return Response.json(url.endsWith("/certificate") ? { ok: true, certificate: { supported: true, state: trusted ? "trusted" : "prepared", busy: null,
      fingerprint: (url.startsWith("/second") ? "B" : "A").repeat(64) } } : { ok: true, runtime: { supported: true, phase: "off", running: false } });
  }) as typeof fetch;
}
async function mount(apiBase = "") {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await render(apiBase); return container;
}
async function render(apiBase: string, connected = false) {
  await act(async () => { root!.render(<StrictMode><LanguageProvider><CodexDesktopCompatibility apiBase={apiBase} active connected={connected} /></LanguageProvider></StrictMode>); });
}
function button(container: HTMLElement, text: string): HTMLButtonElement {
  const value = [...container.querySelectorAll("button")].find(node => node.textContent === text);
  if (!value) throw new Error("Missing button: " + text); return value;
}
async function chooseAndConfirm(container: HTMLElement) {
  await act(async () => button(container, "Register trust").click());
  expect(requests.filter(req => req.method === "POST")).toHaveLength(0);
  expect(button(container, "Confirm action").disabled).toBe(true);
  await act(async () => (container.querySelector("input[type=checkbox]") as HTMLInputElement).click());
  await act(async () => button(container, "Confirm action").click());
}
test("StrictMode status reads are inert and a fingerprint-bound action needs explicit consent", async () => {
  server(); const container = await mount();
  expect(button(container, "Register trust").disabled).toBe(false);
  expect(requests.every(req => req.method === "GET")).toBe(true);
  await chooseAndConfirm(container);
  const posts = requests.filter(req => req.method === "POST"); expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toEqual({ action: "trust", confirmed: true, fingerprint: "A".repeat(64) });
  expect(button(container, "Start observation").disabled).toBe(false);
  await act(async () => button(container, "Start observation").click());
  expect(requests.filter(req => req.method === "POST").at(-1)?.body).toEqual({ action: "start", confirmed: true });
  expect(container.querySelector("fieldset")).toBeNull();
});
test("a lost write response disables replay until a fresh read proves the actual state", async () => {
  server(true); const container = await mount(); await chooseAndConfirm(container);
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(button(container, "Register trust").disabled).toBe(true);
  expect(requests.filter(req => req.method === "POST")).toHaveLength(1);
  await act(async () => button(container, "Refresh status").click());
  expect(button(container, "Start observation").disabled).toBe(false);
  expect(requests.filter(req => req.method === "POST")).toHaveLength(1);
});
test("changing target drops an outstanding certificate confirmation", async () => {
  server(); const container = await mount();
  await act(async () => button(container, "Register trust").click());
  await act(async () => (container.querySelector("input[type=checkbox]") as HTMLInputElement).click());
  await render("/second");
  expect(container.querySelector("fieldset")).toBeNull(); expect(container.textContent).toContain("B".repeat(64));
  expect(requests.filter(req => req.method === "POST")).toHaveLength(0);
});
test("managed client mode never falls back to mutating the shared hub", async () => {
  server(); const container = await mount(); requests.length = 0;
  await render("/machine", true);
  expect(container.textContent).toContain("unavailable in OpenCodex managed client mode");
  expect(requests).toHaveLength(0); expect(container.querySelector("button")).toBeNull();
});
