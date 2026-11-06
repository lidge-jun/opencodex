import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import Usage from "../src/pages/Usage";
import { matchesFacetWindow } from "../src/components/v2-usage/usage-source";
import { configureApiTargets, installApiAuthFetch, installApiSessionFromHtml, logoutApiSession, resetApiAuthFetchForTests, usageSessionSnapshot } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";

const names = ["document", "window", "navigator", "localStorage", "sessionStorage", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
let old: Map<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root;
let host: HTMLElement;
let calls: { url: string; init?: RequestInit }[];
const originalFetch = globalThis.fetch;
let serial = 0;
const counts = { all: 90, codex: 30, claude_code: 20, claude_desktop: 10, grok: 3, opencode: 4, aside: 5, other: 6, unknown: 12 };
function echo(url: string) {
  const query = new URL(url).searchParams;
  return { client: query.get("client"), device: query.get("device") === "key" ? { kind: "key", id: query.get("apiKeyId") } : { kind: query.get("device") } };
}
function report(url: string) {
  return { sourceFilter: echo(url), legacyUnclassifiedRequests: 2, range: "30d", surface: "all", since: null, generatedAt: Date.now(), historyTruncated: false, truncatedPrefixBytes: 0, entriesTruncated: false, entriesDropped: 0,
    summary: { requests: 0, measuredRequests: 0, reportedRequests: 0, unreportedRequests: 0, unsupportedRequests: 0, estimatedRequests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, coverageRatio: 0 }, days: [], models: [], providers: [] };
}
function facets(url: string) {
  return { sourceFilter: echo(url), window: { since: Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 29), until: Date.now(), timeZone: "UTC" }, apps: counts,
    devices: [{ device: { kind: "all" }, requests: 30 }, { device: { kind: "no-key" }, requests: 10 },
      { device: { kind: "key", id: "key-a" }, requests: 12 }, { device: { kind: "unconfigured" }, requests: 8 }],
    legacyUnclassifiedRequests: 2, usageIncomplete: false };
}
const response = (body: unknown) => Response.json(body, { headers: { "cache-control": "no-store" } });
beforeEach(() => {
  old = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  win = new Window({ url: "http://localhost/" });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "window" ? win : (win as unknown as Record<string, unknown>)[name] });
  resetApiAuthFetchForTests();
  win.localStorage.setItem("ocx-lang", "en");
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes("source-facets")) return response(facets(url));
    if (url.includes("/devices")) return response({ devices: [{ apiKeyId: "key-a", alias: "Laptop" }] });
    return response(report(url));
  }) as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  globalThis.fetch = originalFetch;
  resetApiAuthFetchForTests();
  win.close();
  for (const name of names) { const descriptor = old.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
});
async function mount(props: { connected?: boolean; apiKeyId?: string; topology?: "home" | "hub" | "link" | "unknown" } = {}) {
  host = document.createElement("div"); document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => { root = createRoot(host); root.render(<LanguageProvider><Usage apiBase={`http://picker-${++serial}`} {...props} /></LanguageProvider>); });
}
async function click(button: HTMLButtonElement) { await act(async () => button.click()); }
function trigger() { return host.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!; }
function radio(name: string) { return [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(button => button.textContent?.includes(name))!; }

test("selects app and device independently, searches, and restores focus on Escape", async () => {
  await mount();
  expect(calls[0]!.url).toContain("client=codex&device=all");
  expect(host.textContent).toContain("2 older requests");
  await click(trigger());
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Search apps and devices");
  expect(document.querySelectorAll('[role="radiogroup"]')).toHaveLength(2);
  expect(radio("Codex").getAttribute("aria-checked")).toBe("true");
  expect(radio("Laptop").textContent).toContain("12");
  await click(radio("Grok"));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(calls.some(call => call.url.includes("/api/usage?") && call.url.includes("client=grok&device=all"))).toBe(true);
  await click(radio("Laptop"));
  expect(calls.some(call => call.url.includes("/api/usage?") && call.url.includes("client=grok&device=key&apiKeyId=key-a"))).toBe(true);
  expect(radio("Grok").getAttribute("aria-checked")).toBe("true");
  expect(radio("Laptop").getAttribute("aria-checked")).toBe("true");
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, "grok"); input.dispatchEvent(new win.Event("input", { bubbles: true })); });
  expect(radio("Grok")).toBeTruthy();
  expect(radio("Laptop")).toBeUndefined();
  await act(async () => input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger());
  expect(trigger().textContent).toContain("Laptop");
  expect(calls.filter(call => call.url.includes("source-facets")).every(call => { const params = new URL(call.url).searchParams; return !params.has("surface") && call.init?.cache === "no-store"; })).toBe(true);
});

test("unverified clients explain that traffic may remain unknown", async () => {
  await mount();
  await click(trigger());
  await click(radio("Aside"));
  expect(host.textContent).toContain("This app is not identified automatically yet; its traffic may appear as unknown.");
});

test.each([undefined, { client: "all", device: { kind: "all" } }, { client: "codex", device: { kind: "all", id: "unexpected" } }, { client: "codex", device: { kind: "all" }, scope: "unexpected" }])("refuses missing or mismatched report echoes", async sourceFilter => {
  globalThis.fetch = (async (input: RequestInfo | URL) => response({ ...report(String(input)), sourceFilter, summary: { requests: 1 }, models: [{ model: "WRONG" }], providers: [], days: [] })) as typeof fetch;
  await mount();
  expect(host.textContent).toContain("Could not load usage data");
  expect(host.textContent).not.toContain("WRONG");
});

test("link and unknown connections never request inventory or broad data; missing key fails closed", async () => {
  await mount({ connected: true, apiKeyId: "key-a", topology: "link" });
  expect(calls[0]!.url).toContain("client=codex&device=key&apiKeyId=key-a");
  await click(trigger());
  expect(calls.some(call => call.url.includes("source-facets") || call.url.includes("/devices"))).toBe(false);
  expect(host.textContent).not.toContain("Hub-wide");
  await act(async () => root.unmount());
  calls.length = 0;
  await mount({ connected: true, topology: "unknown" });
  expect(calls).toHaveLength(0);
  expect(host.textContent).toContain("Could not load usage data");
});

test("discards old facet responses after selection and rejects mismatched facet echoes", async () => {
  const waiting: { url: string; resolve: (value: Response) => void }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes("source-facets")) return new Promise<Response>(resolve => waiting.push({ url, resolve }));
    if (url.includes("/devices")) return Promise.resolve(response({ devices: [] }));
    return Promise.resolve(response(report(url)));
  }) as typeof fetch;
  await mount(); await click(trigger());
  expect(waiting).toHaveLength(1);
  await click(radio("Grok"));
  expect(waiting).toHaveLength(2);
  await act(async () => waiting[0]!.resolve(response(facets(waiting[0]!.url))));
  expect(radio("Codex").textContent).not.toContain("30");
  await act(async () => waiting[1]!.resolve(response({ ...facets(waiting[1]!.url), sourceFilter: echo(waiting[0]!.url) })));
  expect(document.body.textContent).toContain("Counts unavailable or incomplete");
  expect(radio("Codex").textContent).not.toContain("30");
});

test("unconfigured reports require no-store, clear on focus, and reject late responses", async () => {
  const waiting: { url: string; resolve: (value: Response) => void }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes("source-facets")) return Promise.resolve(response(facets(url)));
    if (url.includes("/devices")) return Promise.resolve(response({ devices: [] }));
    if (url.includes("device=unconfigured")) return new Promise<Response>(resolve => waiting.push({ url, resolve }));
    return Promise.resolve(response(report(url)));
  }) as typeof fetch;
  await mount(); await click(trigger()); await click(radio("Unconfigured keys"));
  expect(waiting).toHaveLength(1);
  expect(calls.find(call => call.url.includes("/api/usage?") && call.url.includes("device=unconfigured"))?.init?.cache).toBe("no-store");
  await act(async () => waiting[0]!.resolve(Response.json(report(waiting[0]!.url))));
  expect(host.textContent).toContain("Could not load usage data");
  const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry")!;
  await click(retry);
  expect(waiting).toHaveLength(2);
  await act(async () => win.dispatchEvent(new win.Event("focus")));
  expect(waiting).toHaveLength(3);
  await act(async () => waiting[1]!.resolve(response(report(waiting[1]!.url))));
  expect(host.textContent).toContain("Loading usage data");
  await act(async () => waiting[2]!.resolve(response(report(waiting[2]!.url))));
  expect(host.textContent).toContain("2 older requests");
  expect([...Array(sessionStorage.length)].map((_, i) => sessionStorage.key(i)).some(key => key?.includes("unconfigured"))).toBe(false);
});

test("radio groups respond to arrow keys and keep independent selections", async () => {
  await mount(); await click(trigger());
  const codex = radio("Codex");
  codex.focus();
  await act(async () => codex.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(document.activeElement?.textContent).toContain("Claude Code");
  expect(radio("Claude Code").getAttribute("aria-checked")).toBe("true");
  expect(radio("All devices").getAttribute("aria-checked")).toBe("true");
  expect(calls.some(call => call.url.includes("client=claude_code&device=all"))).toBe(true);
});

test("source popup describes apps and ambiguous linked devices without disclosing key ids", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push({ url });
    if (url.includes("source-facets")) return response(facets(url));
    if (url.includes("/devices")) return response({ devices: [{ apiKeyId: "key-a", alias: null }] });
    return response(report(url));
  }) as typeof fetch;
  await mount(); await click(trigger());
  expect(radio("Codex").textContent).toContain("CLI · Desktop · IDE");
  expect(radio("Other").textContent).toContain("Chat API");
  expect(document.body.textContent).toContain("Unknown linked device");
  expect(document.body.textContent).toContain("Remote Link");
  expect(document.body.textContent).not.toContain("key-a");
  expect([...document.querySelectorAll('[role="radiogroup"]')].every(group => group.textContent?.includes("Last 30 days"))).toBe(true);
});

test("a successful local key mutation immediately fences active unconfigured reports and facets", async () => {
  await mount(); await click(trigger()); await click(radio("Unconfigured keys"));
  const reportCalls = () => calls.filter(call => call.url.includes("/api/usage?") && call.url.includes("unconfigured")).length;
  const facetCalls = () => calls.filter(call => call.url.includes("source-facets")).length;
  const beforeReport = reportCalls(), beforeFacets = facetCalls();
  const apiBase = new URL(calls[0]!.url).origin;
  await act(async () => win.dispatchEvent(new win.CustomEvent("opencodex:usage-source-inventory-changed", { detail: { apiBase } })));
  expect(reportCalls()).toBe(beforeReport + 1);
  expect(facetCalls()).toBe(beforeFacets + 1);
});

test("invalid or mismatched facet windows never display counts", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push({ url });
    if (url.includes("source-facets")) return response({ ...facets(url), window: { since: 1, until: Date.now(), timeZone: "UTC" } });
    if (url.includes("/devices")) return response({ devices: [] });
    return response(report(url));
  }) as typeof fetch;
  await mount(); await click(trigger());
  expect(document.body.textContent).toContain("Counts unavailable or incomplete");
  expect(radio("Codex").textContent).not.toContain("30");
});

test("mismatched report range or surface is not displayed", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => response({ ...report(String(input)), range: "all", surface: "all", summary: { requests: 1 }, models: [{ model: "WRONG WINDOW" }], providers: [], days: [] })) as typeof fetch;
  await mount();
  expect(host.textContent).toContain("Could not load usage data");
  expect(host.textContent).not.toContain("WRONG WINDOW");
});

test("no-key uses Mac, device, and connected Home context labels", async () => {
  Object.defineProperty(win.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" });
  await mount(); await click(trigger());
  expect(radio("This Mac")).toBeTruthy();
  await click(radio("This Mac"));
  expect(calls.some(call => call.url.includes("client=codex&device=no-key"))).toBe(true);
  expect(document.body.textContent).toContain("does not prove the originating device");
  await act(async () => root.unmount());
  Object.defineProperty(win.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (X11; Linux x86_64)" });
  await mount(); await click(trigger());
  expect(radio("This device")).toBeTruthy();
  await act(async () => root.unmount());
  await mount({ connected: true, apiKeyId: "key-a", topology: "hub" });
  const hub = [...host.querySelectorAll<HTMLButtonElement>(".usage-scope-control button")].find(button => button.textContent === "Hub-wide")!;
  await click(hub); await click(trigger());
  expect(radio("Home device")).toBeTruthy();
});

test("shared popup has a valid dialog relationship and releases focus outside", async () => {
  await mount(); await click(trigger());
  const popup = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(trigger().getAttribute("aria-controls")).toBe(popup.id);
  expect(popup.classList.contains("select-dropdown-portal")).toBe(true);
  expect(popup.style.zIndex).toBe("var(--z-popover)");
  const outside = document.createElement("button"); outside.textContent = "Outside"; document.body.append(outside);
  await act(async () => outside.focus());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(outside);
});

test("30-day facet windows follow the returned time zone through DST", () => {
  const until = Date.parse("2026-03-30T16:00:00Z");
  const since = Date.parse("2026-03-01T05:00:00Z");
  expect(matchesFacetWindow({ since, until, timeZone: "America/New_York" })).toBe(true);
  expect(matchesFacetWindow({ since: since + 3_600_000, until, timeZone: "America/New_York" })).toBe(false);
  expect(matchesFacetWindow({ since, until, timeZone: "not-a-zone" })).toBe(false);
  expect(matchesFacetWindow({ since, until, timeZone: "UTC" })).toBe(false);
});

test("unrelated target mutations do not invalidate active usage", async () => {
  await mount(); await click(trigger()); await click(radio("Unconfigured keys"));
  const before = calls.length;
  await act(async () => win.dispatchEvent(new win.CustomEvent("opencodex:usage-source-inventory-changed", { detail: { apiBase: "http://another-target" } })));
  expect(calls).toHaveLength(before);
});

test("a mutation fences in-flight facets and unconfigured report before they can settle", async () => {
  const gates: { url: string; resolve: (value: Response) => void }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes("/devices")) return Promise.resolve(response({ devices: [] }));
    if (url.includes("unconfigured")) return new Promise<Response>(resolve => gates.push({ url, resolve }));
    if (url.includes("source-facets")) return Promise.resolve(response(facets(url)));
    return Promise.resolve(response(report(url)));
  }) as typeof fetch;
  await mount(); await click(trigger()); await click(radio("Unconfigured keys"));
  expect(gates).toHaveLength(2);
  const apiBase = new URL(calls[0]!.url).origin;
  await act(async () => win.dispatchEvent(new win.CustomEvent("opencodex:usage-source-inventory-changed", { detail: { apiBase } })));
  expect(gates).toHaveLength(4);
  await act(async () => { for (const gate of gates.slice(0, 2)) gate.resolve(response(gate.url.includes("source-facets") ? facets(gate.url) : report(gate.url))); });
  expect(host.textContent).toContain("Loading usage data");
  expect(radio("Codex").textContent).not.toContain("30");
  await act(async () => { for (const gate of gates.slice(2)) gate.resolve(response(gate.url.includes("source-facets") ? facets(gate.url) : report(gate.url))); });
  expect(host.textContent).toContain("2 older requests");
  expect(radio("Codex").textContent).toContain("30");
});

test("ambiguous linked device labels remain distinct after selecting and closing", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push({ url });
    if (url.includes("source-facets")) {
      const body = facets(url);
      body.devices.push({ device: { kind: "key", id: "key-b" }, requests: 7 });
      return response(body);
    }
    if (url.includes("/devices")) return response({ devices: [{ apiKeyId: "key-a", alias: null }, { apiKeyId: "key-b", alias: null }] });
    return response(report(url));
  }) as typeof fetch;
  await mount(); await click(trigger());
  expect(radio("Unknown linked device 1")).toBeTruthy();
  expect(radio("Unknown linked device 2")).toBeTruthy();
  await click(radio("Unknown linked device 2"));
  await click(trigger());
  expect(trigger().textContent).toContain("Unknown linked device 2");
  expect(trigger().textContent).not.toContain("key-b");
});

test.each([
  ["missing summary", (value: ReturnType<typeof report>) => ({ ...value, summary: undefined })],
  ["invalid days", (value: ReturnType<typeof report>) => ({ ...value, days: {} })],
  ["invalid models", (value: ReturnType<typeof report>) => ({ ...value, models: [{ model: "BAD" }] })],
  ["unsafe count", (value: ReturnType<typeof report>) => ({ ...value, summary: { ...value.summary, requests: Number.MAX_SAFE_INTEGER + 1 } })],
  ["nonfinite tokens", (value: ReturnType<typeof report>) => ({ ...value, summary: { ...value.summary, totalTokens: Infinity } })],
])("rejects a correctly echoed malformed report: %s", async (_name, mutate) => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const body = mutate(report(String(input)));
    const result = response(body);
    result.json = async () => body;
    return result;
  }) as typeof fetch;
  await mount();
  expect(host.textContent).toContain("Could not load usage data");
  expect(host.textContent).not.toContain("2 older requests");
  expect(sessionStorage.length).toBe(0);
});

test.each(["missing", "duplicate", "duplicate-key", "long-key", "too-many"])("rejects invalid facet device roster: %s", async scenario => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("source-facets")) {
      const body = facets(url);
      if (scenario === "missing") body.devices = body.devices.filter(row => row.device.kind !== "unconfigured");
      if (scenario === "duplicate") body.devices.push({ device: { kind: "all" }, requests: 0 });
      if (scenario === "duplicate-key") body.devices.push({ device: { kind: "key", id: "key-a" }, requests: 0 });
      if (scenario === "long-key") body.devices.push({ device: { kind: "key", id: "x".repeat(257) }, requests: 0 });
      if (scenario === "too-many") for (let i = 0; i < 1025; i++) body.devices.push({ device: { kind: "key", id: `extra-${i}` }, requests: 0 });
      return response(body);
    }
    if (url.includes("/devices")) return response({ devices: [] });
    return response(report(url));
  }) as typeof fetch;
  await mount(); await click(trigger());
  expect(document.body.textContent).toContain("Counts unavailable or incomplete");
  expect(radio("Codex").textContent).not.toContain("30");
});

test.each(["no-store missing", "duplicate", "invalid", "failed"])("rejects invalid inventory: %s", async scenario => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("source-facets")) return response(facets(url));
    if (url.includes("/devices")) {
      if (scenario === "failed") return new Response(null, { status: 500 });
      if (scenario === "no-store missing") return Response.json({ devices: [] });
      if (scenario === "duplicate") return response({ devices: [{ apiKeyId: "key-a", alias: "a" }, { apiKeyId: "key-a", alias: "b" }] });
      return response({ devices: [{ apiKeyId: "key-a", alias: 42 }] });
    }
    return response(report(url));
  }) as typeof fetch;
  await mount(); await click(trigger());
  expect(document.body.textContent).toContain("Counts unavailable or incomplete");
  expect(radio("Codex").textContent).not.toContain("30");
});

test("selecting a key retains the focused radio while new counts load or fail", async () => {
  let pending: ((value: Response) => void) | undefined;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("source-facets") && url.includes("device=key")) return new Promise<Response>(resolve => { pending = resolve; });
    if (url.includes("source-facets")) return Promise.resolve(response(facets(url)));
    if (url.includes("/devices")) return Promise.resolve(response({ devices: [{ apiKeyId: "key-a", alias: "Laptop" }] }));
    return Promise.resolve(response(report(url)));
  }) as typeof fetch;
  await mount(); await click(trigger());
  const device = radio("Laptop"); device.focus(); await click(device);
  expect(document.activeElement).toBe(device);
  expect(radio("Laptop")).toBe(device);
  expect(device.getAttribute("aria-checked")).toBe("true");
  expect(device.textContent).not.toContain("12");
  await act(async () => pending!(new Response(null, { status: 500 })));
  expect(document.activeElement).toBe(device);
  expect(radio("Laptop")).toBe(device);
  expect(device.textContent).not.toContain("12");
});

function installSharedSession(token: string) {
  configureApiTargets(standaloneApiTargets(""));
  const html = `<meta name="opencodex-session-token" content="${token}"><meta name="opencodex-session-csrf" content="csrf"><meta name="opencodex-session-origin" content="http://localhost"><meta name="opencodex-session-server-origin" content="http://localhost">`;
  expect(installApiSessionFromHtml("shared", html)).toBe(true);
}

test("logout immediately clears reports and aliases and fences a late successful report", async () => {
  installSharedSession("ocx_session_test_logout");
  let release: ((response: Response) => void) | undefined;
  let pendingUrl = "";
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("source-facets")) return Promise.resolve(response(facets(url)));
    if (url.includes("/devices")) return Promise.resolve(response({ devices: [{ apiKeyId: "key-a", alias: "Private laptop" }] }));
    if (url.includes("client=grok")) { pendingUrl = url; return new Promise<Response>(resolve => { release = resolve; }); }
    return Promise.resolve(response(report(url)));
  }) as typeof fetch;
  Object.defineProperty(win, "fetch", { configurable: true, value: async () => new Response(null, { status: 200 }) });
  await mount(); await click(trigger());
  expect(document.body.textContent).toContain("Private laptop");
  await click(radio("Grok"));
  expect(release).toBeDefined();
  sessionStorage.setItem("ocx.usage.v2:old", "private historical usage");
  await act(async () => { expect(await logoutApiSession("shared")).toBe(true); });
  expect(document.body.textContent).not.toContain("Private laptop");
  expect(sessionStorage.getItem("ocx.usage.v2:old")).toBeNull();
  await act(async () => release!(response(report(pendingUrl))));
  expect(host.textContent).not.toContain("2 older requests");
  expect(host.textContent).toContain("Could not load usage data");
});

test.each([401, 403])("a %s report response revokes previously shown usage and source inventory", async status => {
  installSharedSession(`ocx_session_test_${status}`);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("source-facets")) return response(facets(url));
    if (url.includes("/devices")) return response({ devices: [{ apiKeyId: "key-a", alias: "Private laptop" }] });
    if (url.includes("client=grok")) return new Response(null, { status });
    return response(report(url));
  }) as typeof fetch;
  await mount(); await click(trigger());
  expect(document.body.textContent).toContain("Private laptop");
  await click(radio("Grok"));
  expect(document.body.textContent).not.toContain("Private laptop");
  expect(host.textContent).not.toContain("2 older requests");
  expect(host.textContent).toContain("Could not load usage data");
});

test.each([401, 403])("a %s facet denial clears active report, counts, and inventory immediately", async status => {
  installSharedSession(`ocx_session_facet_${status}`);
  let rejectFacets = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("source-facets")) return rejectFacets ? new Response(null, { status }) : response(facets(url));
    if (url.includes("/devices")) return response({ devices: [{ apiKeyId: "key-a", alias: "Private laptop" }] });
    return response(report(url));
  }) as typeof fetch;
  await mount(); await click(trigger());
  expect(host.textContent).toContain("2 older requests");
  expect(document.body.textContent).toContain("Private laptop");
  rejectFacets = true;
  await act(async () => win.dispatchEvent(new win.Event("focus")));
  expect(host.textContent).not.toContain("2 older requests");
  expect(document.body.textContent).not.toContain("Private laptop");
  expect(radio("Codex").textContent).not.toContain("30");
});

test("a new shared session rejects a previous session's late success", async () => {
  installSharedSession("ocx_session_old");
  let release: ((response: Response) => void) | undefined;
  let initialUrl = "";
  let first = true;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (first) { first = false; initialUrl = url; return new Promise<Response>(resolve => { release = resolve; }); }
    return Promise.resolve(response(report(url)));
  }) as typeof fetch;
  await mount();
  expect(release).toBeDefined();
  await act(async () => installSharedSession("ocx_session_new"));
  expect(host.textContent).toContain("2 older requests");
  await act(async () => release!(response({ ...report(initialUrl), legacyUnclassifiedRequests: 17 })));
  expect(host.textContent).toContain("2 older requests");
  expect(host.textContent).not.toContain("17 older requests");
});


test("an unrelated policy 403 does not revoke Usage, but a Usage 403 does", async () => {
  installSharedSession("ocx_session_policy");
  Object.defineProperty(win, "fetch", { configurable: true, writable: true, value: async () => new Response(null, { status: 403 }) });
  installApiAuthFetch();
  await win.fetch("http://localhost/api/link/candidates");
  expect(usageSessionSnapshot().blocked).toBe(false);
  await win.fetch("http://localhost/api/usage?client=codex&device=all");
  expect(usageSessionSnapshot().blocked).toBe(true);
});

test("a stale 403 cannot revoke a replacement shared session", async () => {
  installSharedSession("ocx_session_stale");
  let release: ((response: Response) => void) | undefined;
  Object.defineProperty(win, "fetch", { configurable: true, writable: true, value: () => new Promise<Response>(resolve => { release = resolve; }) });
  installApiAuthFetch();
  const old = win.fetch("http://localhost/api/usage?client=codex&device=all");
  installSharedSession("ocx_session_replacement");
  release!(new Response(null, { status: 403 }));
  expect((await old).status).toBe(403);
  expect(usageSessionSnapshot().blocked).toBe(false);
});
