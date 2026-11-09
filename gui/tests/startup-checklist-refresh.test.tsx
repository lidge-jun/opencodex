import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Home from "../src/pages/Home";
import SetupHub from "../src/pages/SetupHub";

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

const stale = { status: "at-risk", diagnosticStale: true, routingKind: "opencodex-local", desktop: { owned: true }, protection: "none" };
const protectedHealth = { ...stale, status: "protected", diagnosticStale: false, protection: "service" };
const disabledHealth = { ...stale, diagnosticStale: false, desktop: { owned: true, loginState: "disabled" } };

async function render(apiBase: string): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><Home apiBase={apiBase} navigate={() => {}} onReloadCodex={() => {}} reloadingCodex={false} /><SetupHub apiBase={apiBase} navigate={() => {}} /></LanguageProvider>);
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  return host;
}

function pages(apiBase: string) {
  return <LanguageProvider><Home apiBase={apiBase} navigate={() => {}} onReloadCodex={() => {}} reloadingCodex={false} /><SetupHub apiBase={apiBase} navigate={() => {}} /></LanguageProvider>;
}

function rows(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll("li")].filter(row => row.textContent?.includes("Start automatically"));
}

test("a failed stale refresh stops polling", async () => {
  let reads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/api/startup-health")) {
      reads++;
      if (reads === 1) return Response.json(stale);
      throw new Error("offline");
    }
    return Response.json({});
  }) as typeof fetch;
  await render("http://checklist-failure");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2200)); });
  expect(reads).toBe(2);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2200)); });
  expect(reads).toBe(2);
});

test("switching targets cancels the old stale retry", async () => {
  const reads: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/startup-health")) {
      reads.push(url);
      return Response.json(url.includes("old-target") ? stale : disabledHealth);
    }
    return Response.json({});
  }) as typeof fetch;
  const host = await render("http://old-target");
  await act(async () => {
    root!.render(pages("http://new-target"));
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  expect(rows(host)[1].textContent).toContain("To do");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2200)); });
  expect(reads).toEqual(["http://old-target/api/startup-health", "http://new-target/api/startup-health"]);
});

test("shared consumers do not overlap refreshes and unmount aborts the request", async () => {
  let reads = 0;
  let refreshSignal: AbortSignal | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/startup-health")) {
      if (++reads === 1) return Response.json(stale);
      refreshSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }
    return Response.json({});
  }) as typeof fetch;
  await render("http://checklist-inflight");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 4300)); });
  expect(reads).toBe(2);
  expect(refreshSignal?.aborted).toBe(false);
  await act(async () => { root!.unmount(); });
  root = undefined;
  expect(refreshSignal?.aborted).toBe(true);
});

for (const [label, fresh, expected] of [["protected", protectedHealth, "done"], ["disabled", disabledHealth, "todo"]] as const) {
  test(`both checklists refresh stale startup health to ${label}`, async () => {
    let reads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/startup-health")) return Response.json(++reads === 1 ? stale : fresh);
      return Response.json({});
    }) as typeof fetch;
    const host = await render(`http://checklist-${label}`);
    expect(rows(host)).toHaveLength(2);
    expect(rows(host)[0].textContent).not.toContain("Keep opencodex");
    expect(rows(host)[1].textContent).not.toContain("To do");
    expect(reads).toBe(1);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2200)); });
    expect(reads).toBe(2);
    if (expected === "done") {
      expect(rows(host)[0].textContent).toContain("✓");
      expect(rows(host)[1].textContent).toContain("Done");
    } else {
      expect(rows(host)[0].textContent).toContain("Keep opencodex");
      expect(rows(host)[1].textContent).toContain("To do");
    }
  });
}
