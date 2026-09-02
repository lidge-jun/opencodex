import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { buildOverviewRows, type OverviewSources } from "../src/pages/integrations/overview-clients";
import type { CursorIntegrationStatus } from "../src/pages/integrations/cursor-api";

/**
 * The Cursor page is a read-only projection of one status route. These tests drive the
 * real component against a fetch mock for each state the route can report and assert
 * what the user sees; the overview-row cases pin the "applied means seen" semantics
 * that distinguish Cursor from every switch-backed client.
 */

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let requests: string[] = [];
let mountCount = 0;
let apiBase = "";
let statusResponse: () => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function payload(overrides: Partial<CursorIntegrationStatus> = {}): CursorIntegrationStatus {
  return {
    privateInference: { installed: true, path: "/Applications/Cursor Private Inference.app", version: "3.18.25" },
    regularCursor: { installed: true, path: "/Applications/Cursor.app" },
    gateway: { baseUrl: "http://127.0.0.1:10100/v1", apiKeyMode: "placeholder", placeholder: "opencodex" },
    lastSeen: null,
    effortTable: { source: "bundle", version: "3.18.25", families: 16 },
    models: [
      { id: "gpt-5.6-sol", reasoning: ["low", "medium", "high", "xhigh"], family: "gpt-5.6", tableLess: false, effortRows: [], context: { defaultWindow: 272_000, longWindow: 922_000 } },
      { id: "kimi/k3", reasoning: null, family: null, tableLess: true, effortRows: [], context: null },
    ],
    guideUrl: "https://example.invalid/guides/cursor-private-inference/",
    ...overrides,
  };
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#integrations/cursor" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  requests = [];
  mountCount += 1;
  apiBase = `http://ocx-cursor-${mountCount}.invalid`;
  statusResponse = () => json(payload());
  const mockFetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input instanceof Request ? input.url : input));
    return statusResponse();
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: mockFetch });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function mount(active = true): Promise<void> {
  const [{ createRoot }, { LanguageProvider }, { default: CursorIntegrationPage }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/pages/integrations/CursorIntegrationPage"),
  ]);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <CursorIntegrationPage apiBase={apiBase} active={active} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
}

function textOf(): string {
  return container.textContent ?? "";
}

test("reads its own status route and renders the gateway values with copy buttons", async () => {
  await mount();
  expect(requests.some(url => url === `${apiBase}/api/native-integrations/cursor`)).toBe(true);
  const text = textOf();
  expect(text).toContain("http://127.0.0.1:10100/v1");
  expect(text).toContain("opencodex");
  expect(text).toContain("3.18.25");
  expect(text).toContain("/Applications/Cursor Private Inference.app");
  const copies = Array.from(container.querySelectorAll("button")).filter(button => (button.textContent ?? "").trim() === "Copy");
  expect(copies.length).toBe(2);
});

test("a never-seen install tells the user to press Refresh model list", async () => {
  await mount();
  expect(textOf()).toContain("Refresh model list in Cursor");
  expect(container.querySelector("[data-seen='false']")).not.toBeNull();
});

test("a recent request renders the relative time and the user agent", async () => {
  statusResponse = () => json(payload({ lastSeen: { at: Date.now() - 3 * 60_000, userAgent: "Cursor/3.18.25" } }));
  await mount();
  const text = textOf();
  expect(text).toContain("Cursor/3.18.25");
  expect(text).toContain("3m ago");
  expect(container.querySelector("[data-seen='true'] .badge-green")).not.toBeNull();
});

test("a stale request keeps the timestamp but drops the green badge", async () => {
  statusResponse = () => json(payload({ lastSeen: { at: Date.now() - 3 * 86_400_000, userAgent: "Cursor/3.18.25" } }));
  await mount();
  expect(textOf()).toContain("3d ago");
  expect(container.querySelector("[data-seen='true'] .badge-green")).toBeNull();
  expect(container.querySelector("[data-seen='true'] .badge-muted")).not.toBeNull();
});

test("regular Cursor alone gets the tunnel explanation, not a gateway promise", async () => {
  statusResponse = () => json(payload({ privateInference: { installed: false, path: null, version: null } }));
  await mount();
  const text = textOf();
  expect(text).toContain("Only regular Cursor was found");
  expect(text).toContain("public tunnel");
  expect(container.querySelectorAll("[data-installed='false']").length).toBe(1);
  // The remediation is a link inside the warning itself, not a footer the user must scroll to.
  const notice = container.querySelector("a[data-cursor-guide='notice']");
  expect(notice?.getAttribute("href")).toBe("https://example.invalid/guides/cursor-private-inference/");
});

test("no Cursor at all still hands over the gateway values", async () => {
  statusResponse = () => json(payload({
    privateInference: { installed: false, path: null, version: null },
    regularCursor: { installed: false, path: null },
  }));
  await mount();
  const text = textOf();
  expect(text).toContain("No Cursor install was found");
  expect(text).toContain("http://127.0.0.1:10100/v1");
});

test("credential mode links to the API Keys tab instead of inventing a key", async () => {
  statusResponse = () => json(payload({ gateway: { baseUrl: "http://127.0.0.1:10100/v1", apiKeyMode: "credential", placeholder: "opencodex" } }));
  await mount();
  const text = textOf();
  expect(text).toContain("One of your opencodex API keys");
  const copies = Array.from(container.querySelectorAll("button")).filter(button => (button.textContent ?? "").trim() === "Copy");
  expect(copies.length).toBe(1);
  const keysButton = Array.from(container.querySelectorAll("button")).find(button => (button.textContent ?? "").trim() === "API Keys");
  expect(keysButton).toBeDefined();
  await act(async () => { keysButton!.click(); });
  expect(testWindow.location.hash).toBe("#integrations/keys");
});

test("Copy writes the value to the clipboard and flips the label", async () => {
  const written: string[] = [];
  Object.defineProperty(testWindow.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => { written.push(value); } },
  });
  await mount();
  const copies = Array.from(container.querySelectorAll("button")).filter(button => (button.textContent ?? "").trim() === "Copy");
  await act(async () => { copies[0]!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10)); });
  expect(written).toEqual(["http://127.0.0.1:10100/v1"]);
  expect((copies[0]!.textContent ?? "").trim()).toBe("Copied");
  await act(async () => { copies[1]!.click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10)); });
  expect(written).toEqual(["http://127.0.0.1:10100/v1", "opencodex"]);
});

/**
 * The 15 s timer itself belongs to the shared store (tests/client-resource-poll.test.tsx). What
 * this page owns is polling membership: while mounted and active it must be a polling
 * subscriber, and after unmount it must not be. A visibility flip makes every polling store
 * do one make-up fetch, so it is the cheapest observable proof of membership.
 */
async function flipVisibility(): Promise<void> {
  for (const state of ["hidden", "visible"] as const) {
    Object.defineProperty(testWindow.document, "visibilityState", { configurable: true, get: () => state });
    await act(async () => {
      testWindow.document.dispatchEvent(new testWindow.Event("visibilitychange"));
      await Promise.resolve();
    });
  }
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 20)); });
}

test("an active tab is a polling subscriber and stops after unmount", async () => {
  await mount();
  const before = requests.length;
  expect(before).toBeGreaterThan(0);
  await flipVisibility();
  expect(requests.length).toBeGreaterThan(before);
  const afterPoll = requests.length;
  const current = root!;
  await act(async () => { current.unmount(); });
  root = null;
  await flipVisibility();
  expect(requests.length).toBe(afterPoll);
});

test("the model table shows the reasoning ladder and both context windows", async () => {
  await mount();
  const rows = Array.from(container.querySelectorAll(".cursor-model-table tbody tr")).map(row => row.textContent ?? "");
  expect(rows.length).toBe(2);
  expect(rows[0]).toContain("gpt-5.6-sol");
  expect(rows[0]).toContain("low · medium · high · xhigh");
  expect(rows[0]).toContain("272K");
  expect(rows[0]).toContain("922K");
  expect(rows[1]).toContain("kimi/k3");
  expect(rows[1]).toContain("—");
  expect(rows[1]).toContain("single window");
});

test("the ladder provenance names the installed bundle, and table-less rows get the hint", async () => {
  await mount();
  const text = textOf();
  expect(text).toContain("installed Cursor Private Inference 3.18.25 bundle");
  expect(text).toContain("no effort rows");
  expect(container.querySelector("[data-cursor-tableless-hint]")).not.toBeNull();
  const marker = container.querySelector(".cursor-no-control");
  expect(marker?.getAttribute("aria-label")).toContain("not in Cursor's built-in effort table");
});

test("the static mirror is named when no bundle was read, and effort rows are counted", async () => {
  statusResponse = () => json(payload({
    effortTable: { source: "static", version: null, families: null },
    models: [
      { id: "gpt-5.6-sol", reasoning: ["low", "medium", "high", "xhigh"], family: null, tableLess: false, effortRows: [], context: null },
      { id: "anthropic/claude-fable-5-1", reasoning: null, family: null, tableLess: true, effortRows: ["anthropic/claude-fable-5-1--low", "anthropic/claude-fable-5-1--high"], context: null },
      { id: "cursor/kimi-k3", reasoning: null, family: null, tableLess: true, effortRows: ["cursor/kimi-k3--max"], context: null },
    ],
  }));
  await mount();
  const text = textOf();
  expect(text).toContain("static mirror of Cursor 3.18.25");
  expect(text).toContain("2 effort rows published");
  expect(text).toContain("1 effort row published");
});

test("without a table-less row the hint paragraph is absent", async () => {
  statusResponse = () => json(payload({
    models: [{ id: "gpt-5.6-sol", reasoning: ["low", "medium", "high", "xhigh"], family: "gpt-5.6", tableLess: false, effortRows: [], context: null }],
  }));
  await mount();
  expect(container.querySelector("[data-cursor-tableless-hint]")).toBeNull();
  expect(textOf()).not.toContain("no effort rows");
});

test("a failed read is an error notice, never a fake 'not installed'", async () => {
  statusResponse = () => json({ error: "nope" }, 500);
  await mount();
  const text = textOf();
  expect(text).toContain("Could not read the Cursor status");
  expect(text).not.toContain("Not found");
});

test("an inactive tab does not poll", async () => {
  await mount(false);
  expect(requests.length).toBe(0);
});

function sources(cursor: CursorIntegrationStatus | null): OverviewSources {
  return {
    clients: [],
    clientsSettled: true,
    codex: null,
    keyCount: 0,
    keyPhase: "settled",
    claude: null,
    claudeDesktop: null,
    grok: null,
    cursor,
    native: null,
    nativeSettled: true,
  } as unknown as OverviewSources;
}

function cursorRow(cursor: CursorIntegrationStatus | null) {
  const row = buildOverviewRows(sources(cursor)).rows.find(candidate => candidate.id === "cursor");
  if (!row) throw new Error("cursor row missing from the overview");
  return row;
}

test("overview: an unreadable source is unknown, not 'not installed'", () => {
  const row = cursorRow(null);
  expect(row.state).toBe("unknown");
  expect(row.toggle).toBeNull();
});

test("overview: installed but never seen is absent; a recent request is current and applied", () => {
  const idle = cursorRow(payload());
  expect(idle.state).toBe("absent");
  expect(idle.installed).toBe(true);
  expect(idle.applied).toBe(false);
  expect(idle.detailKey).toBe("integrations.detail.cursorNeverSeen");

  const seen = cursorRow(payload({ lastSeen: { at: Date.now() - 60_000, userAgent: "Cursor/3.18.25" } }));
  expect(seen.state).toBe("current");
  expect(seen.applied).toBe(true);
  expect(seen.detailKey).toBe("integrations.detail.cursorSeen");

  const missing = cursorRow(payload({ privateInference: { installed: false, path: null, version: null } }));
  expect(missing.state).toBe("not-installed");
  expect(missing.detailKey).toBe("integrations.detail.cursorAbsent");
});
