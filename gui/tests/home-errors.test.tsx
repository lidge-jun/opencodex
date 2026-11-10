import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Home from "../src/pages/Home";

const names = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let saved: Record<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root | undefined;

beforeEach(() => {
  saved = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  win = new Window({ url: "http://localhost/" });
  win.localStorage.setItem("ocx-lang", "en");
  for (const name of names.filter(value => value !== "fetch")) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(win, name) });
  }
  clearClientResourceStoresForTests();
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  clearClientResourceStoresForTests();
  win.close();
  for (const name of names) {
    if (saved[name]) Object.defineProperty(globalThis, name, saved[name]!);
    else Reflect.deleteProperty(globalThis, name);
  }
});

async function renderWithLogs(logsResponse: Response): Promise<HTMLElement> {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/logs")) return logsResponse.clone();
    if (url.includes("/healthz")) return Response.json({ version: "test", uptime: 1 });
    return Response.json({});
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><Home apiBase="http://home-errors-test" navigate={() => {}} onReloadCodex={() => {}} reloadingCodex={false} /></LanguageProvider>);
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  return host;
}

test("a failed logs read does not claim there were no errors", async () => {
  const host = await renderWithLogs(Response.json({ error: "unavailable" }, { status: 503 }));
  expect(host.textContent).toContain("Recent errors unavailable");
  expect(host.textContent).not.toContain("No failed requests in the last 24 hours.");
  expect(host.textContent).not.toContain("Everything is running");
});

test("a malformed logs response is unknown while a valid empty list is healthy", async () => {
  const host = await renderWithLogs(Response.json({}));
  expect(host.textContent).toContain("Recent errors unavailable");
  await act(async () => { root!.unmount(); });
  root = undefined;
  clearClientResourceStoresForTests();
  const valid = await renderWithLogs(Response.json({ logs: [] }));
  expect(valid.textContent).toContain("No failed requests in the last 24 hours.");
  expect(valid.textContent).toContain("Everything is running");
});
