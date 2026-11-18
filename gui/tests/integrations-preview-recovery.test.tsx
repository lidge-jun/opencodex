import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";

/**
 * Two ways a reported-conflict action could not produce a plan.
 *
 * 1. The Overview's Replace button for Aside sent an aggregate
 *    `/api/client-integrations/preview` with no profile, which the server must
 *    refuse: a plan describes one independently changing file. The Aside
 *    surface already owns per-profile conflicts, so the card's action belongs
 *    there rather than in a dead dialog.
 * 2. A preview answers 409 `integration_preview_unavailable` when no export
 *    roster has been retained yet, or when a provider cache revision retired
 *    it. The Overview used to close the dialog and leave the user with a
 *    button that appeared to do nothing. Recovery has to be explicit: an
 *    ordinary collection read gathers the roster (the same load the page
 *    already performs), and only then is the preview asked again. The preview
 *    itself stays side-effect free.
 */

const globals = [
  "document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let apiBase = "";
type RecordedRequest = { path: string; method: string; body: unknown };
let requests: RecordedRequest[];
let clients: Record<string, unknown>[];
let preview: (body: Record<string, unknown>) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fileStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: "hermes", state: "current", installed: true,
    configPath: "/tmp/home/.hermes/config.yaml", snapshotCount: 1, retentionDegraded: false,
    ...overrides,
  };
}

function asideStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return fileStatus({ clientId: "aside", configPath: "/tmp/aside/u/1/models.json", ...overrides });
}

function plan(clientId: string, operation: string, extra: Record<string, unknown> = {}) {
  // The client parser accepts only a p<version>:<32 lowercase hex> fingerprint.
  const digit = ({ apply: "1", overwrite: "2", disable: "3", restore: "4" } as Record<string, string>)[operation] ?? "9";
  return {
    version: 1, clientId, operation,
    state: operation === "apply" ? "absent" : "current", foreignEdit: "none",
    changes: [
      { kind: operation === "disable" ? "remove" : "replace", path: "providers.opencodex" },
      { kind: "snapshot", path: "$snapshot" }, { kind: "ownership", path: "$ownership" },
      { kind: "journal", path: "$journal" },
    ],
    fingerprint: `p1:${digit.repeat(32)}`,
    canApply: true, willChange: true,
    ...extra,
  };
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#integrations" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });
  requests = [];
  apiBase = `http://ocx-preview-recovery-${Math.random().toString(36).slice(2)}.invalid`;
  clients = [fileStatus()];
  preview = body => json(plan(String(body.clientId), String(body.operation)));
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const request = {
      path: url.pathname + url.search,
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(request);
    if (request.method === "POST" && /\/preview$/.test(url.pathname)) return preview(request.body as Record<string, unknown>);
    if (url.pathname.includes("/journal")) return json({ operations: [] });
    if (url.pathname === "/api/client-integrations") return json({ clients });
    const profileState = url.pathname.match(/^\/api\/client-integrations\/aside\/profiles\/(\d+)$/);
    if (profileState) {
      const profileId = Number(profileState[1]);
      return json(clients.find(row => row.profileId === profileId) ?? asideStatus({ profileId, current: false, enabled: true }));
    }
    if (url.pathname === "/api/startup-health") return json({ routingInjected: false, status: "native", recommendedCommand: null });
    if (url.pathname === "/api/keys") return json({ keys: [] });
    if (url.pathname === "/api/claude-desktop/status") {
      return json({ desiredEnabled: true, installed: true, observedKind: "standard", applied: false, stale: false, activeProfile: null, appliedAt: null });
    }
    if (url.pathname === "/api/native-integrations") return json({ clients: [] });
    if (url.pathname === "/api/claude-code") return json({ enabled: false });
    if (url.pathname === "/api/grok") return json({ present: false, models: [] });
    if (url.pathname === "/api/codex-agent-roles") return json({ lazycodex: { detected: false }, omoJsonc: null, roles: [] });
    if (url.pathname === "/api/subagent-models") return json({ available: [] });
    if (request.method === "PUT") {
      const scoped = url.pathname.match(/^\/api\/client-integrations\/aside\/profiles\/(\d+)$/);
      return scoped
        ? json({ ok: true, clientId: "aside", profileId: Number(scoped[1]), changed: true, state: "current", message: "updated" })
        : json({ ok: true, clientId: "hermes", changed: true, state: "current", message: "updated" });
    }
    return json({ error: `Unexpected request: ${request.path}` }, 404);
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: mockFetch });
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => { mounted.unmount(); });
    root = null;
  }
  testWindow.close();
  for (const key of globals) {
    const descriptor = previousGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function settle(ms = 40): Promise<void> {
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, ms)); });
}

async function mount(node: () => Promise<{ element: ReactElement; name: string }>): Promise<void> {
  const [{ createRoot }, { LanguageProvider }, loaded] = await Promise.all([
    import("react-dom/client"), import("../src/i18n/provider"), node(),
  ]);
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider>{loaded.element}</LanguageProvider>);
  });
  await settle();
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button"));
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return buttons().find(button => (button.textContent ?? "").trim() === text);
}

test("a conflicted Aside card routes to the per-profile surface instead of an unprofiled preview", async () => {
  clients = [asideStatus({ state: "conflict", reason: "unowned-key" })];
  const { default: IntegrationsOverview } = await import("../src/pages/integrations/IntegrationsOverview");
  await mount(async () => ({ name: "overview", element: <IntegrationsOverview apiBase={apiBase} active /> }));

  // The aggregate preview cannot describe one profile; the card must not try.
  const action = buttonByText("Choose profile");
  expect(action).toBeDefined();
  expect(buttonByText("Replace")).toBeUndefined();

  await act(async () => { action!.click(); });
  expect(testWindow.location.hash).toBe("#integrations/aside");
  expect(requests.filter(request => request.path.endsWith("/api/client-integrations/preview"))).toHaveLength(0);
  expect(container.querySelector("dialog[open]")).toBeNull();
});

test("an unavailable preview keeps the dialog open and retries after an ordinary catalog load", async () => {
  clients = [fileStatus({ state: "conflict", reason: "unowned-key" })];
  let previews = 0;
  let collections = 0;
  let collectionsAtFirstPreview = -1;
  preview = body => {
    previews += 1;
    if (previews === 1) {
      collectionsAtFirstPreview = collections;
      return json({ error: "no model roster is cached yet", code: "integration_preview_unavailable" }, 409);
    }
    if (collections <= collectionsAtFirstPreview) {
      return json({ error: "no model roster is cached yet", code: "integration_preview_unavailable" }, 409);
    }
    return json(plan(String(body.clientId), String(body.operation)));
  };
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if ((init?.method ?? "GET").toUpperCase() === "GET" && url.endsWith("/api/client-integrations")) collections += 1;
      return originalFetch(input, init);
    }) as typeof fetch,
  });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: globalThis.fetch });

  const { default: IntegrationsOverview } = await import("../src/pages/integrations/IntegrationsOverview");
  await mount(async () => ({ name: "overview", element: <IntegrationsOverview apiBase={apiBase} active /> }));

  await act(async () => { buttonByText("Replace")!.click(); });
  await settle();

  const dialog = container.querySelector("dialog[open]");
  expect(dialog).not.toBeNull();
  const retry = Array.from(dialog!.querySelectorAll("button")).find(button => (button.textContent ?? "").trim() === "Load catalog and retry") as HTMLButtonElement | undefined;
  expect(retry).toBeDefined();
  expect(dialog!.textContent).toContain("model catalog is not loaded");
  // No plan exists yet, so confirming must not look available.
  const refusedConfirm = Array.from(dialog!.querySelectorAll("button")).find(button => (button.textContent ?? "").trim() === "Replace") as HTMLButtonElement;
  expect(refusedConfirm.disabled).toBe(true);

  await act(async () => { retry!.click(); });
  await settle();

  expect(collections).toBeGreaterThan(collectionsAtFirstPreview);
  const confirmed = container.querySelector("dialog[open]")!;
  expect(confirmed.textContent).toContain("Operation: Replace");
  const confirm = Array.from(confirmed.querySelectorAll("button")).find(button => (button.textContent ?? "").trim() === "Replace") as HTMLButtonElement;
  expect(confirm.disabled).toBe(false);
  await act(async () => { confirm.click(); });
  await settle();
  expect(requests.find(request => request.method === "PUT")?.body).toEqual({
    enabled: true, overwriteConflict: true, operation: "overwrite", planFingerprint: plan("hermes", "overwrite").fingerprint,
  });
});

test("a per-profile Aside overwrite offers the same catalog retry and keeps its scope", async () => {
  clients = [asideStatus({ profileId: 4, current: false, enabled: true, state: "conflict", reason: "foreign-edit" })];
  let previews = 0;
  preview = body => {
    previews += 1;
    if (previews === 1) return json({ error: "no model roster is cached yet", code: "integration_preview_unavailable" }, 409);
    return json(plan("aside", String(body.operation), { profileId: 4 }));
  };

  const { default: FileIntegrationPage } = await import("../src/pages/integrations/FileIntegrationPage");
  await mount(async () => ({ name: "aside profile", element: <FileIntegrationPage apiBase={apiBase} client="aside" profileId={4} active /> }));

  const replace = buttonByText("Replace");
  expect(replace).toBeDefined();
  await act(async () => { replace!.click(); });
  await settle();

  const dialog = container.querySelector("dialog[open]");
  expect(dialog).not.toBeNull();
  const retry = Array.from(dialog!.querySelectorAll("button")).find(button => (button.textContent ?? "").trim() === "Load catalog and retry") as HTMLButtonElement | undefined;
  expect(retry).toBeDefined();
  await act(async () => { retry!.click(); });
  await settle();

  expect(container.querySelector("dialog[open]")?.textContent).toContain("Operation: Replace");
  const confirm = Array.from(container.querySelector("dialog[open]")!.querySelectorAll("button")).find(button => (button.textContent ?? "").trim() === "Replace") as HTMLButtonElement;
  await act(async () => { confirm.click(); });
  await settle();
  expect(requests.find(request => request.method === "PUT")?.path).toBe("/api/client-integrations/aside/profiles/4");
  expect(requests.find(request => request.method === "PUT")?.body).toEqual({
    enabled: true, overwriteConflict: true, operation: "overwrite", planFingerprint: plan("aside", "overwrite", { profileId: 4 }).fingerprint,
  });
});

test("a recovery read still pending when the dialog closes does not reopen it, and the retry waits for the read", async () => {
  clients = [fileStatus({ state: "conflict", reason: "unowned-key" })];
  let previews = 0;
  preview = body => {
    previews += 1;
    return previews === 1
      ? json({ error: "no model roster is cached yet", code: "integration_preview_unavailable" }, 409)
      : json(plan(String(body.clientId), String(body.operation)));
  };
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (gate && (init?.method ?? "GET").toUpperCase() === "GET" && url.endsWith("/api/client-integrations")) await gate;
      return originalFetch(input, init);
    }) as typeof fetch,
  });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: globalThis.fetch });

  const { default: IntegrationsOverview } = await import("../src/pages/integrations/IntegrationsOverview");
  await mount(async () => ({ name: "overview", element: <IntegrationsOverview apiBase={apiBase} active /> }));
  await act(async () => { buttonByText("Replace")!.click(); });
  await settle();
  expect(container.querySelector("dialog[open]")).not.toBeNull();

  gate = new Promise<void>(resolve => { release = resolve; });
  await act(async () => { buttonByText("Load catalog and retry")!.click(); });
  await settle();
  // The retry may not ask again before the roster-retaining read has answered.
  expect(previews).toBe(1);
  await act(async () => { buttonByText("Close")!.click(); });
  await settle();
  expect(container.querySelector("dialog[open]")).toBeNull();
  await act(async () => { release!(); gate = null; });
  await settle(80);
  // A dismissed action stays dismissed: no second preview, no reopened dialog.
  expect(previews).toBe(1);
  expect(container.querySelector("dialog[open]")).toBeNull();
});

