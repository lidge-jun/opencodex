import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import { act } from "react";
import { RemoteLinkDiagnostics } from "../src/pages/RemoteLinkDiagnostics";
import { parseLinkDiagnostics } from "../src/remote-link-diagnostics-api";
import { LanguageProvider } from "../src/i18n/provider";

let win: Window;
let root: Root | null = null;
let previous: Record<string, unknown>;
const globals = ["window", "document", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/#remote" });
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: win }, document: { configurable: true, value: win.document }, navigator: { configurable: true, value: win.navigator }, localStorage: { configurable: true, value: win.localStorage }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
});

afterEach(async () => {
  try {
    if (root) await act(async () => { root?.unmount(); });
  } finally {
    root = null;
    try { await win.happyDOM.close(); } finally {
      for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
    }
  }
});

function response(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
async function settle(): Promise<void> { for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }

async function mount(): Promise<HTMLDivElement> {
  const host = win.document.createElement("div");
  win.document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
  await act(async () => { root?.render(<LanguageProvider><RemoteLinkDiagnostics apiBase="http://fixture" /></LanguageProvider>); });
  return host;
}

const document_ = {
  schema: "ocx.link.diagnostics/1",
  files: [{ name: "diagnostics.jsonl.1", state: "absent", truncated: false }, { name: "diagnostics.jsonl", state: "read", truncated: false }],
  matched: 3,
  skipped: 1,
  records: [
    { event: "tunnel_transition", outcome: "network", previousState: "connected", state: "reconnecting", attempt: 2, tunnelPort: 43110, timestamp: Date.UTC(2026, 10, 11, 1, 2, 3), suppressed: 4 },
    { event: "<img src=x onerror=alert(1)>", outcome: "match", timestamp: 1 },
    { event: "owner_lookup", outcome: "match", state: "\u001b[31mforged", alias: "private-host" },
  ],
};

test("the dashboard re-validates records and drops anything outside the allowlist", () => {
  const parsed = parseLinkDiagnostics(document_);
  expect(parsed.records.map(({ rowKey: _rowKey, ...record }) => record)).toEqual([
    { event: "tunnel_transition", outcome: "network", previousState: "connected", state: "reconnecting", attempt: 2, tunnelPort: 43110, timestamp: Date.UTC(2026, 10, 11, 1, 2, 3), suppressed: 4 },
    { event: "owner_lookup", outcome: "match" },
  ]);
  expect(parsed.matched).toBe(3);
  expect(parsed.skipped).toBe(1);
  expect(() => parseLinkDiagnostics({ records: "nope" })).toThrow();
});

test("loads only when opened, then lists records with a read-only GET", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return response(document_);
  }) as typeof fetch;
  const host = await mount();
  expect(calls).toEqual([]);
  const toggle = host.querySelector<HTMLButtonElement>("[data-action='link-diagnostics-toggle']");
  expect(toggle).not.toBeNull();
  await act(async () => { toggle!.click(); });
  await settle();
  expect(calls).toEqual([{ url: "http://fixture/api/link/diagnostics?limit=100", method: "GET" }]);
  const rows = [...host.querySelectorAll("tbody tr")].map(row => row.textContent ?? "");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("tunnel_transition");
  expect(rows[0]).toContain("connected → reconnecting");
  expect(rows[0]).toContain("43110");
  expect(rows[0]).toContain("+4");
  expect(host.innerHTML).not.toContain("onerror");
  expect(host.textContent).not.toContain("forged");
  expect(host.textContent).not.toContain("private-host");
});

test("an empty file and a failed read each say so", async () => {
  globalThis.fetch = (async () => response({ ...document_, matched: 0, skipped: 0, records: [] })) as typeof fetch;
  const host = await mount();
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-action='link-diagnostics-toggle']")!.click(); });
  await settle();
  expect(host.querySelector("[data-state='empty']")).not.toBeNull();
  expect(host.querySelector("table")).toBeNull();

  globalThis.fetch = (async () => response({ error: { code: "forbidden", message: "no" } }, 403)) as typeof fetch;
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-action='link-diagnostics-refresh']")!.click(); });
  await settle();
  expect(host.querySelector("[data-state='error']")).not.toBeNull();
});

test("a timestamp outside the Date range renders as missing instead of breaking the page", async () => {
  expect(parseLinkDiagnostics({ ...document_, records: [{ event: "owner_lookup", outcome: "match", timestamp: 9_000_000_000_000_000 }] }).records)
    .toEqual([{ rowKey: "r0", event: "owner_lookup", outcome: "match" }]);
  globalThis.fetch = (async () => response({ ...document_, matched: 1, skipped: 0, records: [{ event: "owner_lookup", outcome: "match", timestamp: 9_000_000_000_000_000 }] })) as typeof fetch;
  const host = await mount();
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-action='link-diagnostics-toggle']")!.click(); });
  await settle();
  const rows = [...host.querySelectorAll("tbody tr")].map(row => row.textContent ?? "");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("owner_lookup");
});
