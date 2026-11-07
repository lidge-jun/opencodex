import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Usage from "../src/pages/Usage";
import { LanguageProvider } from "../src/i18n/provider";
import { usageV2Copy } from "../src/i18n/v2-pages/usage-copy";
import { isUsageReport } from "../src/components/v2-usage/usage-validation";
import { SOURCE_CLIENTS } from "../src/components/v2-usage/usage-source";
import { USAGE_APPS } from "../../src/usage/app-breakdown";
import { resetApiAuthFetchForTests } from "../src/api";
import { clearClientResourceStoresForTests } from "../src/client-resource";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
let previous: Map<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root | undefined;
let host: HTMLElement;
let calls: string[];
let serial = 0;
const app = (client = "codex") => ({ client, requests: 2, measuredRequests: 1, totalTokens: 100, estimatedCostUsd: 0, pricedRequests: 1, unpricedRequests: 1, shareRatio: 0.5 });
test("source picker app roster matches the backend report roster", () => {
  expect([...SOURCE_CLIENTS.filter(client => client !== "all"), "unclassified"].sort()).toEqual([...USAGE_APPS].sort());
  expect(isUsageReport({ ...report(), apps: USAGE_APPS.map(client => app(client)) })).toBe(true);
});
function report(url = "http://usage/api/usage?client=all&device=all&range=30d") {
  const q = new URL(url).searchParams;
  return {
    sourceFilter: { client: q.get("client"), device: { kind: q.get("device") } },
    legacyUnclassifiedRequests: 1, range: q.get("range"), surface: "all", since: null, generatedAt: Date.now(),
    summary: { requests: 4, measuredRequests: 2, reportedRequests: 2, unreportedRequests: 2, unsupportedRequests: 0, estimatedRequests: 0, inputTokens: 100, outputTokens: 100, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 200, coverageRatio: 0.5 },
    days: [], models: [], providers: [], historyTruncated: false, truncatedPrefixBytes: 0, entriesTruncated: false, entriesDropped: 0,
  };
}
beforeEach(() => {
  previous = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  win = new Window({ url: "http://localhost/" });
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : name === "window" ? win : (win as unknown as Record<string, unknown>)[name] });
  win.localStorage.setItem("ocx-lang", "en");
  resetApiAuthFetchForTests(); clearClientResourceStoresForTests(); calls = [];
  serve([app(), { ...app("unclassified"), totalTokens: 200, shareRatio: 1 }]);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; globalThis.fetch = originalFetch;
  resetApiAuthFetchForTests(); clearClientResourceStoresForTests(); win.close();
  for (const name of globals) { const descriptor = previous.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
});
function serve(apps: unknown, include = true) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.includes("source-facets")) return new Response(null, { status: 503 });
    return Response.json({ ...report(url), ...(include ? { apps } : {}) });
  }) as typeof fetch;
}
async function render(apiBase = `http://usage-apps-${++serial}`) {
  if (!root) { host = document.createElement("div"); document.body.append(host); const { createRoot } = await import("react-dom/client"); root = createRoot(host); }
  await act(async () => root!.render(<LanguageProvider><Usage apiBase={apiBase} /></LanguageProvider>));
}
async function click(button: HTMLButtonElement) { await act(async () => button.click()); }
const radio = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(b => b.textContent?.includes(label))!;
const section = () => host.querySelector("#usage-section-apps");

test("defaults to last 30 days, all apps and all devices without persisting selections", async () => {
  await render();
  expect(calls[0]).toContain("client=all&device=all&range=30d&surface=all");
  expect(host.querySelector('[aria-pressed="true"]')?.textContent).toBe("30d");
  await click(host.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!);
  expect(radio("All apps").getAttribute("aria-checked")).toBe("true");
  expect(radio("All devices").getAttribute("aria-checked")).toBe("true");
  expect(win.localStorage.length).toBe(1);
  expect(win.sessionStorage.length).toBe(0);
});

test("places Apps after Models and Providers, labels unclassified, and renders pricing coverage", async () => {
  await render();
  expect([...host.querySelectorAll('[id^="usage-section-"]')].map(node => node.id)).toEqual([
    "usage-section-overview", "usage-section-models", "usage-section-providers", "usage-section-apps", "usage-section-coverage",
  ]);
  expect(section()?.querySelector("h3")?.textContent).toBe("Apps");
  const rows = section()?.querySelectorAll("tbody tr");
  expect(rows).toHaveLength(2);
  expect(rows![0]!.textContent).toContain("Unclassified");
  expect(rows![1]!.textContent).toContain("Codex");
  expect(rows![1]!.textContent).toContain("$0.00");
  expect(rows![1]!.textContent).toContain("1 request excluded");
});

test("keeps explicit app, device and range selections while mounted and hides Apps for a single app", async () => {
  await render();
  await click(host.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!);
  await click(radio("Codex")); await click(radio("This device"));
  await act(async () => document.querySelector('input[type="search"]')!.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await click([...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "7d")!);
  await render();
  expect(calls.at(-1)).toContain("client=codex&device=no-key&range=7d");
  expect(section()).toBeNull();
  await click(host.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!);
  await click(radio("All apps"));
  expect(section()).not.toBeNull();
  expect(calls.at(-1)).toContain("client=all&device=no-key&range=7d");
  await act(async () => root!.unmount()); root = undefined;
  await render();
  expect(calls.at(-1)).toContain("client=all&device=all&range=30d");
});

test("an older daemon leaves the App breakdown unavailable rather than showing zero", async () => {
  serve(undefined, false); await render();
  expect(section()?.textContent).toContain("App breakdown is unavailable from this proxy.");
  expect(section()?.querySelector("table")).toBeNull();
  expect(host.textContent).not.toContain("Could not load usage data");
});

test("an explicitly empty app list has its own empty state", async () => {
  serve([]); await render();
  expect(section()?.textContent).toContain("No app usage in this report.");
  expect(section()?.textContent).not.toContain("unavailable");
});

test("unpriced apps show an unavailable amount and the full exclusion count", async () => {
  serve([{ ...app(), estimatedCostUsd: undefined, pricedRequests: 0, unpricedRequests: 2 }]); await render();
  const cells = section()?.querySelectorAll("tbody td");
  expect(cells?.[3]?.textContent).toContain("—");
  expect(cells?.[3]?.textContent).toContain("2 requests excluded");
  expect(section()?.textContent).not.toContain("$0.00");
});

const clients = ["codex", "claude_code", "claude_desktop", "grok", "opencode", "aside", "other", "unknown", "unclassified"];
test("accepts all nine bounded app identities and finite fractional or large token/cost values", async () => {
  const apps = clients.map((client, index) => ({ ...app(client), totalTokens: index === 0 ? 0.5 : 1e18, estimatedCostUsd: 0.125 }));
  expect(isUsageReport({ ...report(), apps })).toBe(true);
  serve(apps); await render();
  expect(section()?.querySelectorAll("tbody tr")).toHaveLength(9);
  for (const label of ["Claude Code", "Claude Desktop", "Grok", "OpenCode", "Aside", "Other", "Unknown", "Unclassified"]) expect(section()?.textContent).toContain(label);
});

test("accepts zero metrics and does not render untrusted labels on valid identities", async () => {
  const apps = [{ client: "unknown", label: "UNSAFE_LABEL", requests: 0, measuredRequests: 0, totalTokens: 0,
    pricedRequests: 0, unpricedRequests: 0, shareRatio: 0 }];
  expect(isUsageReport({ ...report(), apps })).toBe(true);
  serve(apps); await render();
  expect(section()?.querySelector("tbody tr")?.textContent).toContain("Unknown");
  expect(section()?.textContent).not.toContain("UNSAFE_LABEL");
  expect(section()?.textContent).not.toContain("$0.00");
});

const invalidApps: [string, unknown][] = [
  ["null", null], ["object", {}], ["invalid row", [null]], ["unknown identity", [app("UNSAFE_APP")]],
  ["all identity", [app("all")]], ["duplicate", [app(), app()]], ["too many", Array.from({ length: 10 }, () => app())],
  ["share over one", [{ ...app(), shareRatio: 1.01 }]],
  ...["requests", "measuredRequests", "pricedRequests", "unpricedRequests"].flatMap(field => [
    [`fractional ${field}`, [{ ...app(), [field]: 0.5 }]], [`unsafe ${field}`, [{ ...app(), [field]: Number.MAX_SAFE_INTEGER + 1 }]],
  ] as [string, unknown][]),
  ...["requests", "measuredRequests", "totalTokens", "estimatedCostUsd", "pricedRequests", "unpricedRequests", "shareRatio"].flatMap(field => [
    [`missing ${field}`, [{ ...app(), [field]: undefined }]], [`negative ${field}`, [{ ...app(), [field]: -1 }]],
    [`string ${field}`, [{ ...app(), [field]: "UNSAFE_VALUE" }]], [`nonfinite ${field}`, [{ ...app(), [field]: Infinity }]],
    [`nan ${field}`, [{ ...app(), [field]: NaN }]],
  ] as [string, unknown][]),
];
test.each(invalidApps)("rejects invalid optional app data: %s", async (_name, apps) => {
  expect(isUsageReport({ ...report(), apps })).toBe(false);
  serve(apps); await render();
  expect(host.textContent).toContain("Could not load usage data");
  expect(host.textContent).not.toContain("UNSAFE"); expect(section()).toBeNull();
});

test("App breakdown copy is present in all eleven locales", () => {
  for (const locale of ["en", "ko", "de", "fr", "zh", "zh-TW", "ru", "ja", "tr", "vi", "pt"] as const) {
    const copy = usageV2Copy(locale) as Record<string, string>;
    for (const key of ["apps", "app", "unclassified", "appsUnavailable", "appsEmpty"]) expect(copy[`usageV2.${key}`]?.trim().length).toBeGreaterThan(0);
  }
});
