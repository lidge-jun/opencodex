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

/** A hub's management ingress: no unauthenticated /healthz, an authenticated health route. */
async function renderOnManagementIngress(health: Response): Promise<HTMLElement> {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/healthz")) return Response.json({ error: "Unknown endpoint: GET /healthz" }, { status: 404 });
    if (url.endsWith("/api/system/health")) return health.clone();
    if (url.includes("/api/logs")) return Response.json({ logs: [] });
    return Response.json({});
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><Home apiBase="http://hub-management" navigate={() => {}} onReloadCodex={() => {}} reloadingCodex={false} /></LanguageProvider>);
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  return host;
}

test("a healthy hub behind its management ingress is not reported as down (#8506)", async () => {
  const host = await renderOnManagementIngress(Response.json({ status: "ok", service: "opencodex", version: "2.100.2", uptime: 7260, pid: 4 }));
  expect(host.textContent).not.toContain("The proxy is not answering");
  expect(host.textContent).toContain("2h 1m");
});

test("a health route that refuses the session still means the proxy answered", async () => {
  const host = await renderOnManagementIngress(Response.json({ error: "unauthorized" }, { status: 401 }));
  expect(host.textContent).not.toContain("The proxy is not answering");
});

test("a health route that is gone still reports the proxy as down", async () => {
  const host = await renderOnManagementIngress(Response.json({ error: "unavailable" }, { status: 503 }));
  expect(host.textContent).toContain("The proxy is not answering");
});
