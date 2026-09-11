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
      return Response.json({ connected: url.pathname.endsWith("/connect"), activation: url.pathname.endsWith("/connect") ? "ready" : "disconnected", providerName: "zcode", runtimes: ["/installed/ZCode"], runtime: "/installed/ZCode", workspace: "/project", models: [{ id: "builtin:zai/model", label: "Model" }] });
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
  expect(closeCalls).toBe(1);
  expect(host.textContent).not.toContain("Use this provider");
  expect(requests.some(r => r.path === "/api/providers")).toBe(false);
});
test("one-request test is a separate explicit quota-spending action", async () => {
  await mountPane(); await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button("Connect Desktop"));
  expect(host.textContent).toContain("consumes account quota");
  await click(button("Test with one request"));
  expect(requests.find(r => r.path.endsWith("/test"))?.body).toEqual({ model: "builtin:zai/model", consent: true });
  expect(host.textContent).toContain("ZCode answered successfully.");
});

test("a successful HTTP response with a failed inference shows the actionable error", async () => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path.endsWith("/test")) return Response.json({ ok: false, error: "inference_failed" });
    return Response.json({ connected: true, activation: "ready", providerName: "zcode", runtimes: ["/installed/ZCode"],
      runtime: "/installed/ZCode", workspace: "/project", models: [{ id: "builtin:zai/model", label: "Model" }] });
  } });
  await mountPane();
  await click(button("Test with one request"));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("did not complete the test");
  expect(host.textContent).not.toContain("ZCode answered successfully.");
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

test("partial activation remains visible and retries without a second protocol connection", async () => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    requests.push({ path, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    return Response.json({ connected: true, activation: path.endsWith("/activate") ? "ready" : "catalog_pending",
      ...(path.endsWith("/activate") ? {} : { error: "catalog_update_failed" }), providerName: "zcode",
      runtimes: ["/installed/ZCode"], runtime: "/installed/ZCode", workspace: "/project", models: [] });
  } });
  await mountPane();
  expect(host.textContent).toContain("catalog is not ready");
  expect(closeCalls).toBe(0);
  expect(button("Retry activation").disabled).toBe(true);
  await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button("Retry activation"));
  expect(closeCalls).toBe(1);
  expect(requests.filter(r => r.path.endsWith("/connect") || r.path.endsWith("/test"))).toHaveLength(0);
  expect(host.textContent).toContain("No processes will be restarted automatically");
});

test("admin-token setup refusal shows browser-session guidance, not success", async () => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (_input: RequestInfo | URL, options?: RequestInit) =>
    options?.method === "POST" ? Response.json({ error: "dashboard_required" }, { status: 403 }) :
      Response.json({ connected: false, activation: "disconnected", runtimes: ["/installed/ZCode"], runtime: "/installed/ZCode", workspace: "/project", models: [] })
  });
  await mountPane();
  await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button("Connect Desktop"));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("browser session");
  expect(closeCalls).toBe(0);
  expect(host.textContent).not.toContain("ZCode ready");
});

test("sandbox denial explains server policy and never reports complete success", async () => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => Response.json({
    connected: false, issue: "sandbox_unavailable", runtimes: [], runtime: "", workspace: "/project", models: [],
  }) });
  await mountPane();
  const alert = host.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("AppArmor");
  expect(alert.textContent).toContain("server");
  expect(alert.textContent).not.toContain("Permission denied");
  expect(button("Connect Desktop").disabled).toBe(true);
  expect(closeCalls).toBe(0);
});

test("default host access is disclosed before connection consent", async () => {
  await mountPane();
  expect(host.querySelector('[role="note"]')?.textContent).toContain("without an OpenCodex sandbox");
  expect(host.querySelector('[role="note"]')?.textContent).toContain("existing connections");
  expect(host.querySelector('[role="note"]')?.textContent).toContain("OCX_ZCODE_SANDBOX=1");
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
});

test("explicit sandbox mode shows its filesystem boundary", async () => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => Response.json({
    connected: false, sandbox: true, runtimes: [], runtime: "", workspace: "/project", models: [],
  }) });
  await mountPane();
  expect(host.querySelector('[role="note"]')?.textContent).toContain("Selected system and runtime paths");
  expect(host.querySelector('[role="note"]')?.textContent).not.toContain("without an OpenCodex sandbox");
});

test("saved accounts offer separate manual login and never start OAuth without consent", async () => {
  await mountPane();
  expect(host.textContent).toContain("Saved ZCode accounts");
  expect(host.textContent).toContain("no pool or automatic account switch");
  expect(button("Add account").disabled).toBe(true);
  expect(requests.some(r => r.path.endsWith("/zcode-accounts/login"))).toBe(false);
});

test("account activation failure stays partial and separate account labels remain visible", async () => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/zcode-accounts") return Response.json({ accounts: [
      { id: "a", label: "Personal fixture", activation: "ready", busy: false },
      { id: "b", label: "Work fixture", activation: "catalog_pending", busy: false },
    ] });
    return Response.json({ connected: false, runtimes: [], runtime: "", workspace: "/project", models: [] });
  } });
  await mountPane();
  expect(host.textContent).toContain("Personal fixture");
  expect(host.textContent).toContain("Work fixture");
  expect(host.textContent).toContain("Account setup incomplete");
  expect(button("Add account").disabled).toBe(true);
});

test("saved account UI completes official login then shows provider/catalog readiness", async () => {
  let complete = 0;
  const prior = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (!url.pathname.startsWith("/api/zcode-accounts")) return prior(input, options);
    requests.push({ path: url.pathname, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (url.pathname.endsWith("/login")) return Response.json({jobId:"fixture-job",accountId:"fixture-account",phase:options?.method === "POST" ? "waiting" : "authenticated"});
    if (url.pathname.endsWith("/complete")) { complete++; return Response.json({activation:"ready"}); }
    return Response.json({accounts:complete ? [{id:"fixture-account",label:"Personal fixture",activation:"ready",providerName:"zcode-fixture",busy:false}] : []});
  } });
  await mountPane();
  const section = host.querySelector("h3")!.closest("section")!;
  const input = section.querySelector('input:not([type="checkbox"])') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "Personal fixture"); input.dispatchEvent(new win.Event("input", {bubbles:true}) as unknown as Event);
    (section.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
  });
  expect(button("Add account").disabled).toBe(false);
  await act(async () => { button("Add account").click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2200)); });
  expect(complete).toBe(1);
  expect(section.textContent).toContain("Personal fixture");
  expect(section.textContent).toContain("provider enabled · models published");
  expect(section.textContent).toContain("No processes will be restarted automatically");
  expect(requests.some(r => r.path.endsWith("/test"))).toBe(false);
  expect(requests.filter(r => r.body).every(r => r.body!.consent === true)).toBe(true);
});
