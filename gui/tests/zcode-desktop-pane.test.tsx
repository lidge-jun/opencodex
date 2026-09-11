import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ZcodeDesktopPane from "../src/components/ZcodeDesktopPane";



const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let closeCalls: number;
let requests: Array<{ path: string; body?: Record<string, unknown> }>;

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  closeCalls = 0; requests = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      requests.push({ path: url.pathname, body: options?.body ? JSON.parse(String(options.body)) : undefined });
      if (url.pathname.endsWith("/test")) return Response.json({ ok: true });
      return Response.json({ connected: url.pathname.endsWith("/connect"), runtimes: ["/installed/ZCode"], runtime: "/installed/ZCode", workspace: "/project", models: [{ id: "builtin:zai/model", label: "Model" }] });
    },
  });

  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

async function mountPane() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><ZcodeDesktopPane apiBase="" onConnected={() => { closeCalls++; }} /></LanguageProvider>);
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text);
  expect(found).toBeTruthy(); return found!;
}
async function click(element: HTMLElement) {
  await act(async () => { element.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
}
test("Desktop connect requires explicit consent and does not automatically spend model quota", async () => {
  await mountPane();
  expect(button("Connect Desktop").disabled).toBe(true);
  const consent = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await click(consent);
  expect(button("Connect Desktop").disabled).toBe(false);
  await click(button("Connect Desktop"));
  expect(requests.find(r => r.path.endsWith("/connect"))?.body).toEqual({ runtime: "/installed/ZCode", workspace: "/project", consent: true });
  expect(requests.some(r => r.path.endsWith("/test"))).toBe(false);
  expect(closeCalls).toBe(0);
  await click(button("Use this provider"));
  expect(closeCalls).toBe(1);
});
test("one-request test is a separate explicit quota-spending action", async () => {
  await mountPane(); await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button("Connect Desktop"));
  expect(host.textContent).toContain("consumes account quota");
  await click(button("Test with one request"));
  expect(requests.find(r => r.path.endsWith("/test"))?.body).toEqual({ model: "builtin:zai/model", consent: true });
  expect(host.textContent).toContain("ZCode answered successfully.");
});

test("incompatible Node preflight shows safe actionable guidance without connecting", async () => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => Response.json({
    connected: false, issue: "node_incompatible", runtimes: [], runtime: "", workspace: "/project", models: [],
  }) });
  await mountPane();
  const alert = host.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("Node.js 24");
  expect(alert.textContent).toContain("PATH");
  expect(alert.textContent).toContain("restart");
  expect(alert.textContent).not.toContain("runtime_failed");
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
  expect(button("Connect Desktop").disabled).toBe(true);
});
