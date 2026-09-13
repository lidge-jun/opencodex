import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ZcodeDesktopPane from "../src/components/ZcodeDesktopPane";
import AddProviderModal from "../src/components/AddProviderModal";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";



const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let closeCalls: number;
let mutationCalls: number;
let additions: Array<{ name: string; adapter?: string }>;
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

  closeCalls = 0; mutationCalls = 0; additions = []; requests = [];
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

async function mountPane(withConnectionCallback = true) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><ZcodeDesktopPane apiBase=""
      onProviderStateMutation={() => { mutationCalls++; }}
      onConnected={withConnectionCallback ? (name, metadata) => {
        closeCalls++; additions.push({ name, adapter: metadata?.adapter });
      } : undefined} /></LanguageProvider>);
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
async function waitUntil(condition: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the UI condition");
    await act(async () => { await Bun.sleep(20); });
  }
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
  expect(mutationCalls).toBe(1);
  expect(additions).toEqual([{ name: "zcode", adapter: "zcode" }]);
  expect(host.textContent).not.toContain("Use this provider");
  expect(requests.some(r => r.path === "/api/providers")).toBe(false);
});
test("protocol recheck is a separate tool-free action that does not claim quota use", async () => {
  await mountPane(); await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button("Connect Desktop"));
  expect(host.textContent).toContain("without starting a model turn, running native tools, or consuming quota");
  await click(button("Verify protocol again"));
  expect(requests.find(r => r.path.endsWith("/test"))?.body).toEqual({ model: "builtin:zai/model", consent: true });
  expect(host.textContent).toContain("ZCode protocol verification passed.");
});

test("a successful HTTP response with a failed protocol recheck shows the actionable error", async () => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path.endsWith("/test")) return Response.json({ ok: false });
    return Response.json({ connected: true, activation: "ready", providerName: "zcode", runtimes: ["/installed/ZCode"],
      runtime: "/installed/ZCode", workspace: "/project", models: [{ id: "builtin:zai/model", label: "Model" }] });
  } });
  await mountPane();
  await click(button("Verify protocol again"));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("protocol verification did not complete");
  expect(host.textContent).not.toContain("ZCode protocol verification passed.");
});

test("incompatible Node preflight shows safe actionable guidance without connecting", async () => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    requests.push({ path });
    return Response.json({ configured: true, connected: false, issue: "node_incompatible", runtimes: [],
      runtime: "/installed/ZCode", workspace: "/project", models: [] });
  } });
  await mountPane();
  const alert = host.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("Node.js 24");
  expect(alert.textContent).toContain("PATH");
  expect(alert.textContent).toContain("restart");
  expect(alert.textContent).not.toContain("runtime_failed");
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
  expect(button("Connect Desktop").disabled).toBe(true);
  expect(button("Disconnect").disabled).toBe(false);
  await click(button("Disconnect"));
  expect(requests.some(request => request.path.endsWith("/disconnect"))).toBe(true);
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

test("the Add Provider ZCode flow refreshes parent state after partial activation", async () => {
  let modalMutations = 0;
  let modalAdditions = 0;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path.endsWith("/api/provider-presets")) return Response.json({ providers: [{
      id: "zcode", label: "ZCode (local agent)", adapter: "zcode", baseUrl: "https://zcode.z.ai", auth: "local",
    }] });
    if (path.endsWith("/api/oauth/providers")) return Response.json({ providers: [] });
    if (path.endsWith("/api/usage")) return Response.json({ providers: [] });
    if (path.endsWith("/api/zcode-accounts")) return Response.json({ accounts: [] });
    if (path.endsWith("/api/zcode-desktop/connect")) return Response.json({ connected: true,
      activation: "catalog_pending", error: "catalog_update_failed", providerName: "zcode",
      runtimes: ["/installed/ZCode"], runtime: "/installed/ZCode", workspace: "/project", models: [] });
    return Response.json({ connected: false, activation: "disconnected", runtimes: ["/installed/ZCode"],
      runtime: "/installed/ZCode", workspace: "/project", models: [] });
  } });
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><AddProviderModal apiBase="/partial-modal" existingNames={[]}
      onClose={() => {}} onAdded={() => { modalAdditions++; }}
      onProviderStateMutation={() => { modalMutations++; }} /></LanguageProvider>);
  });
  await waitUntil(() => !!host.querySelector(".provider-catalog-search"));
  const search = host.querySelector<HTMLInputElement>(".provider-catalog-search")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(search, "zcode");
    search.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  await click(host.querySelector<HTMLElement>(".provider-catalog-row-wrap .list-row")!);
  await waitUntil(() => !!host.querySelector('[aria-label="ZCode Desktop"]'));
  const pane = host.querySelector<HTMLElement>('[aria-label="ZCode Desktop"]')!;
  await click(pane.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button("Connect Desktop"));

  expect(modalMutations).toBe(1);
  expect(modalAdditions).toBe(0);
  expect(host.querySelector(".modal-overlay")).toBeTruthy();
  expect(host.textContent).toContain("catalog is not ready");
});

test("Desktop disconnect refreshes parent provider state", async () => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/zcode-accounts") return Response.json({ accounts: [] });
    return Response.json({ connected: !path.endsWith("/disconnect"), activation: path.endsWith("/disconnect") ? "disconnected" : "ready",
      providerName: "zcode", runtimes: ["/installed/ZCode"], runtime: "/installed/ZCode", workspace: "/project",
      models: [{ id: "builtin:zai/model", label: "Model" }] });
  } });
  await mountPane(false);
  await click(button("Disconnect"));
  expect(mutationCalls).toBe(1);
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

test("account-bound provider settings do not expose controls for the global Desktop connection", async () => {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><ProviderSettings apiBase="" item={{
      name: "zcode-personal", adapter: "zcode", authMode: "local", baseUrl: "https://zcode.z.ai",
      zcodeAccountId: "00000000-0000-4000-8000-000000000001",
    } satisfies WorkspaceItem} /></LanguageProvider>);
  });
  expect(host.querySelector('[aria-label="ZCode Desktop"]')).toBeNull();
  expect(requests.some(request => request.path.startsWith("/api/zcode-desktop"))).toBe(false);
});

test("existing provider settings refresh parent provider state after Desktop mutation", async () => {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><ProviderSettings apiBase="" item={{
      name: "zcode", adapter: "zcode", authMode: "local", baseUrl: "https://zcode.z.ai",
    } satisfies WorkspaceItem} onProviderStateMutation={() => { mutationCalls++; }} /></LanguageProvider>);
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const pane = host.querySelector<HTMLElement>('[aria-label="ZCode Desktop"]')!;
  await click(pane.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button("Connect Desktop"));
  expect(mutationCalls).toBe(1);
});

test("saved accounts offer separate manual login and never start OAuth without consent", async () => {
  await mountPane();
  expect(host.textContent).toContain("Saved ZCode accounts");
  expect(host.textContent).toContain("no pool or automatic account switch");
  expect(button("Add account").disabled).toBe(true);
  expect(requests.some(r => r.path.endsWith("/zcode-accounts/login"))).toBe(false);
});

test("a failed saved-account OAuth job keeps cancellation available", async () => {
  let cancelled = false;
  const prior = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (!url.pathname.startsWith("/api/zcode-accounts")) return prior(input, options);
    requests.push({ path: url.pathname, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (url.pathname.endsWith("/login")) return Response.json({ jobId: "failed-job", accountId: "failed-account",
      phase: options?.method === "POST" ? "waiting" : "failed", error: "native_oauth_failed" });
    if (url.pathname.endsWith("/cancel")) { cancelled = true; return Response.json({ ok: true }); }
    return Response.json({ accounts: [] });
  } });
  await mountPane();
  const section = host.querySelector("h3")!.closest("section")!;
  const input = section.querySelector('input:not([type="checkbox"])') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, "Failed fixture");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  await click(section.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button("Add account"));
  await waitUntil(() => host.textContent?.includes("native_oauth_failed") === true
    && [...section.querySelectorAll("button")].some(item => item.textContent === "Cancel"));
  await click(button("Cancel"));

  expect(cancelled).toBe(true);
  expect(requests.find(request => request.path.endsWith("/cancel"))?.body).toMatchObject({ jobId: "failed-job" });
  expect(button("Add account").disabled).toBe(false);
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
    if (url.pathname.endsWith("/complete")) { complete++; return Response.json({activation:"ready",providerName:"zcode-fixture"}); }
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
  await waitUntil(() => complete === 1 && section.textContent?.includes("Personal fixture") === true);
  expect(complete).toBe(1);
  expect(section.textContent).toContain("Personal fixture");
  expect(section.textContent).toContain("provider enabled · models published");
  expect(section.textContent).toContain("No processes will be restarted automatically");
  expect(requests.some(r => r.path.endsWith("/test"))).toBe(false);
  expect(requests.filter(r => r.body).every(r => r.body!.consent === true)).toBe(true);
  expect(closeCalls).toBe(1);
  expect(mutationCalls).toBe(1);
  expect(additions).toEqual([{ name: "zcode-fixture", adapter: "zcode" }]);
});

test("saved account completion preserves an HTTP-200 partial activation", async () => {
  let completed = false;
  const prior = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (!url.pathname.startsWith("/api/zcode-accounts")) return prior(input, options);
    if (url.pathname.endsWith("/login")) return Response.json({ jobId: "partial-job", accountId: "partial-account",
      phase: options?.method === "POST" ? "waiting" : "authenticated" });
    if (url.pathname.endsWith("/complete")) {
      completed = true;
      return Response.json({ activation: "catalog_pending", error: "catalog_update_failed" });
    }
    return Response.json({ accounts: completed ? [{ id: "partial-account", label: "Partial fixture",
      activation: "catalog_pending", busy: false }] : [] });
  } });
  await mountPane();
  const section = host.querySelector("h3")!.closest("section")!;
  const input = section.querySelector('input:not([type="checkbox"])') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, "Partial fixture");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  await click(section.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button("Add account"));
  await waitUntil(() => completed && host.textContent?.includes("Partial fixture") === true);
  expect(host.textContent).toContain("Partial fixture");
  expect(host.textContent).toContain("catalog_update_failed");
  expect(host.textContent).not.toContain("native_oauth_failed");
  expect(closeCalls).toBe(0);
  expect(mutationCalls).toBe(1);
});

test("partial completion keeps its finished job recoverable when the account refresh fails", async () => {
  let completions = 0;
  let failNextRefresh = false;
  const prior = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (!url.pathname.startsWith("/api/zcode-accounts")) return prior(input, options);
    requests.push({ path: url.pathname, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (url.pathname.endsWith("/login")) return Response.json({ jobId: "recovery-job", accountId: "recovery-account",
      phase: options?.method === "POST" ? "waiting" : "authenticated" });
    if (url.pathname.endsWith("/complete")) {
      completions++;
      if (completions === 1) {
        failNextRefresh = true;
        return Response.json({ activation: "catalog_pending", error: "catalog_update_failed" });
      }
      return Response.json({ activation: "ready", providerName: "zcode-recovered" });
    }
    if (failNextRefresh) {
      failNextRefresh = false;
      return Response.json({ error: "refresh_failed" }, { status: 500 });
    }
    return Response.json({ accounts: completions > 1 ? [{ id: "recovery-account", label: "Recovery fixture",
      activation: "ready", providerName: "zcode-recovered", busy: false }] : [] });
  } });
  await mountPane();
  const section = host.querySelector("h3")!.closest("section")!;
  const input = section.querySelector('input:not([type="checkbox"])') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, "Recovery fixture");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  await click(section.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button("Add account"));
  await waitUntil(() => completions === 1 && host.textContent?.includes("catalog_update_failed") === true
    && [...section.querySelectorAll("button")].some(item => item.textContent === "Retry activation"));
  expect(requests.filter(request => request.path.endsWith("/login") && request.body)).toHaveLength(1);
  await click(button("Retry activation"));
  await waitUntil(() => completions === 2 && host.textContent?.includes("Recovery fixture") === true);
  expect(requests.filter(request => request.path.endsWith("/login") && request.body)).toHaveLength(1);
  expect(host.textContent).toContain("provider enabled · models published");
  expect(mutationCalls).toBe(2);
  expect(additions).toEqual([{ name: "zcode-recovered", adapter: "zcode" }]);
});

test("a failed recovery retry stays recoverable without restarting OAuth polling", async () => {
  let completions = 0;
  let failNextRefresh = false;
  const prior = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (!url.pathname.startsWith("/api/zcode-accounts")) return prior(input, options);
    requests.push({ path: url.pathname, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (url.pathname.endsWith("/login")) return Response.json({ jobId: "retry-job", accountId: "retry-account",
      phase: options?.method === "POST" ? "waiting" : "authenticated" });
    if (url.pathname.endsWith("/complete")) {
      completions++;
      if (completions === 1) {
        failNextRefresh = true;
        return Response.json({ activation: "catalog_pending", error: "catalog_update_failed" });
      }
      if (completions === 2) return Response.json({ error: "native_oauth_failed" }, { status: 503 });
      return Response.json({ activation: "ready", providerName: "zcode-retry" });
    }
    if (failNextRefresh) {
      failNextRefresh = false;
      return Response.json({ error: "refresh_failed" }, { status: 500 });
    }
    return Response.json({ accounts: completions > 2 ? [{ id: "retry-account", label: "Retry fixture",
      activation: "ready", providerName: "zcode-retry", busy: false }] : [] });
  } });
  await mountPane();
  const section = host.querySelector("h3")!.closest("section")!;
  const input = section.querySelector('input:not([type="checkbox"])') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, "Retry fixture");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  await click(section.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button("Add account"));
  await waitUntil(() => completions === 1 && [...section.querySelectorAll("button")]
    .some(item => item.textContent === "Retry activation"));
  const loginPollsBeforeRetry = requests.filter(request => request.path.endsWith("/login") && !request.body).length;

  await click(button("Retry activation"));
  await waitUntil(() => completions === 2 && host.textContent?.includes("native_oauth_failed") === true);
  await act(async () => { await Bun.sleep(50); });
  expect(button("Retry activation").disabled).toBe(false);
  expect(requests.filter(request => request.path.endsWith("/login") && !request.body)).toHaveLength(loginPollsBeforeRetry);

  await click(button("Retry activation"));
  await waitUntil(() => completions === 3 && host.textContent?.includes("Retry fixture") === true);
  expect(host.textContent).toContain("provider enabled · models published");
  expect(requests.filter(request => request.path.endsWith("/login") && request.body)).toHaveLength(1);
});

test("saved account activation refreshes the parent only after provider and catalog readiness", async () => {
  let activation = "catalog_pending";
  let attempts = 0;
  let failNextRefresh = false;
  const prior = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (!url.pathname.startsWith("/api/zcode-accounts")) return prior(input, options);
    if (url.pathname.endsWith("/activate")) {
      attempts++;
      activation = attempts === 1 ? "catalog_pending" : "ready";
      failNextRefresh = activation === "ready";
      return Response.json({ activation, providerName: "zcode-saved", ...(activation === "ready" ? {} : { error: "catalog_update_failed" }) });
    }
    if (failNextRefresh) { failNextRefresh = false; return Response.json({ error: "refresh_failed" }, { status: 500 }); }
    return Response.json({ accounts: [{ id: "saved", label: "Saved fixture", activation, providerName: "zcode-saved", busy: false }] });
  } });
  await mountPane();
  const section = host.querySelector("h3")!.closest("section")!;
  await click(section.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button("Retry activation"));
  expect(closeCalls).toBe(0);
  expect(host.textContent).toContain("catalog_update_failed");
  await click(button("Retry activation"));
  expect(closeCalls).toBe(1);
  expect(mutationCalls).toBe(2);
  expect(additions).toEqual([{ name: "zcode-saved", adapter: "zcode" }]);
});

test("ready account activation treats its local refresh as best effort without a parent callback", async () => {
  let failNextRefresh = false;
  let activations = 0;
  const prior = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (!url.pathname.startsWith("/api/zcode-accounts")) return prior(input, options);
    if (url.pathname.endsWith("/activate")) {
      activations++;
      failNextRefresh = true;
      return Response.json({ activation: "ready", providerName: "zcode-saved" });
    }
    if (failNextRefresh) return Response.json({ error: "refresh_failed" }, { status: 500 });
    return Response.json({ accounts: [{ id: "saved", label: "Saved fixture", activation: "catalog_pending",
      providerName: "zcode-saved", busy: false }] });
  } });
  await mountPane(false);
  const section = host.querySelector("h3")!.closest("section")!;
  await click(section.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button("Retry activation"));
  expect(activations).toBe(1);
  expect(host.textContent).not.toContain("native_oauth_failed");
  expect(host.textContent).not.toContain("refresh_failed");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(mutationCalls).toBe(1);
});

test("saved account rename and removal refresh parent provider state", async () => {
  let removed = false;
  const prior = globalThis.fetch;
  Object.defineProperty(win, "prompt", { configurable: true, value: () => "Renamed fixture" });
  Object.defineProperty(win, "confirm", { configurable: true, value: () => true });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (!url.pathname.startsWith("/api/zcode-accounts")) return prior(input, options);
    if (url.pathname.endsWith("/rename")) return Response.json({ activation: "ready", providerName: "zcode-saved" });
    if (url.pathname.endsWith("/remove")) { removed = true; return Response.json({ ok: true }); }
    return Response.json({ accounts: removed ? [] : [{ id: "saved", label: "Saved fixture",
      activation: "ready", providerName: "zcode-saved", busy: false }] });
  } });
  await mountPane(false);
  const section = host.querySelector("h3")!.closest("section")!;
  await click(section.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click([...section.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "Rename")!);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(mutationCalls).toBe(1);
  await click(button("Remove account"));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(mutationCalls).toBe(2);
});

for (const removalError of ["catalog_update_failed", "account_removal_partial"]) {
  test(`partial account removal refreshes parent state after ${removalError}`, async () => {
    let partialRemoval = false;
    const prior = globalThis.fetch;
    Object.defineProperty(win, "confirm", { configurable: true, value: () => true });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (!url.pathname.startsWith("/api/zcode-accounts")) return prior(input, options);
      if (url.pathname.endsWith("/remove")) {
        partialRemoval = true;
        return Response.json({ error: removalError }, { status: 400 });
      }
      return Response.json({ accounts: [{ id: "saved", label: "Saved fixture",
        activation: partialRemoval ? "provider_pending" : "ready",
        ...(partialRemoval ? {} : { providerName: "zcode-saved" }), busy: false }] });
    } });
    await mountPane(false);
    const section = host.querySelector("h3")!.closest("section")!;
    await click(section.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(button("Remove account"));
    await waitUntil(() => mutationCalls === 1 && host.textContent?.includes(removalError) === true);
    expect(partialRemoval).toBe(true);
    expect(section.textContent).toContain("Account setup incomplete");
  });
}

test("ready completion keeps a refresh failure recoverable without repeating OAuth", async () => {
  let completions = 0;
  let failNextRefresh = false;
  const prior = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (!url.pathname.startsWith("/api/zcode-accounts")) return prior(input, options);
    requests.push({ path: url.pathname, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (url.pathname.endsWith("/login")) return Response.json({ jobId: "fixture-job", accountId: "fixture-account",
      phase: options?.method === "POST" ? "waiting" : "authenticated" });
    if (url.pathname.endsWith("/complete")) {
      completions++;
      if (completions === 1) return Response.json({ error: "busy" }, { status: 400 });
      failNextRefresh = completions === 2;
      return Response.json({ activation: "ready", providerName: "zcode-saved" });
    }
    if (failNextRefresh) { failNextRefresh = false; return Response.json({ error: "refresh_failed" }, { status: 500 }); }
    return Response.json({ accounts: completions > 2 ? [{ id: "fixture-account", label: "No callback fixture",
      activation: "ready", providerName: "zcode-saved", busy: false }] : [] });
  } });
  await mountPane(false);
  const section = host.querySelector("h3")!.closest("section")!;
  const input = section.querySelector('input:not([type="checkbox"])') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, "No callback fixture");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  await click(section.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  await click(button("Add account"));
  await waitUntil(() => completions === 2 && host.textContent?.includes("account_refresh_failed") === true
    && [...section.querySelectorAll("button")].some(item => item.textContent === "Retry activation"));
  expect(completions).toBe(2);
  expect(button("Add account").disabled).toBe(false);
  expect(host.querySelector('[role="alert"] code')?.textContent).toBe("account_refresh_failed");
  expect(requests.filter(request => request.path.endsWith("/login") && request.body)).toHaveLength(1);
  await click(button("Retry activation"));
  await waitUntil(() => completions === 3 && host.textContent?.includes("No callback fixture") === true);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(requests.filter(request => request.path.endsWith("/login") && request.body)).toHaveLength(1);
  expect(mutationCalls).toBe(2);
});
