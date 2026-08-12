import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Providers from "../src/pages/Providers";

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "fetch",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

const API_BASE = "/providers-codex-completion";
const CANONICAL_OPENAI = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
  codexAccountMode: "pool",
};

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let host: HTMLElement;
let root: Root | null;
let requests: Array<{ path: string; method: string }>;
let catalogRefreshPending: boolean;

function pathCount(path: string): number {
  return requests.filter(request => request.path.startsWith(`${API_BASE}${path}`)).length;
}

async function flush(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  clearClientResourceStoresForTests();
  jest.useFakeTimers({ now: 1_700_000_000_000 });
  testWindow = new Window({ url: "http://localhost/#providers" });
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
  catalogRefreshPending = true;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      requests.push({ path: `${url.pathname}${url.search}`, method });

      if (url.pathname === `${API_BASE}/api/config`) {
        return Response.json({
          port: 10100,
          defaultProvider: "openai",
          providers: { openai: CANONICAL_OPENAI },
        });
      }
      if (url.pathname === `${API_BASE}/api/oauth/providers`) return Response.json({ providers: [] });
      if (url.pathname === `${API_BASE}/api/provider-presets`) return Response.json({ providers: [] });
      if (url.pathname === `${API_BASE}/api/provider-quotas`) return Response.json({ reports: [] });
      if (url.pathname === `${API_BASE}/api/usage`) return Response.json({ providers: [], models: [] });
      if (url.pathname === `${API_BASE}/api/selected-models`) return Response.json({ models: {} });
      if (url.pathname === `${API_BASE}/api/codex-auth/accounts`) {
        return Response.json({
          accounts: [{
            id: "main",
            email: "main@example.test",
            isMain: true,
            paused: false,
            priority: 0,
            hasCredential: true,
            quota: null,
          }],
        });
      }
      if (url.pathname === `${API_BASE}/api/codex-auth/active`) {
        return Response.json({
          activeCodexAccountId: null,
          autoSwitchThreshold: 80,
          accountPoolStrategy: "round-robin",
          accountPoolStickyLimit: 1,
        });
      }
      if (url.pathname === `${API_BASE}/api/codex-auth/login` && method === "POST") {
        return Response.json({ url: "https://auth.example.test/login", flowId: "flow-toast" });
      }
      if (url.pathname === `${API_BASE}/api/codex-auth/login-status`) {
        return Response.json({
          status: "done",
          catalogRefreshPending,
          privateDetail: "private-account-detail",
        });
      }
      return Response.json({});
    },
  });

  host = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(host as never);
  root = null;
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  jest.useRealTimers();
  clearClientResourceStoresForTests();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
  await testWindow.happyDOM?.close?.();
});

async function mountProviders(): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><Providers apiBase={API_BASE} /></LanguageProvider>);
  });
  await flush();
  await flush();
}

function buttonWithText(scope: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll("button")).find(candidate =>
    candidate.textContent?.trim() === text
  );
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

async function completeCodexLogin(): Promise<{
  config: number;
  oauth: number;
  quota: number;
  models: number;
}> {
  await mountProviders();

  await act(async () => { buttonWithText(host, "Add Provider").click(); });
  await flush();
  await act(async () => { buttonWithText(testWindow.document, "Accounts").click(); });
  await flush();

  const accountRow = testWindow.document.querySelector(".provider-catalog-account-row");
  expect(accountRow).toBeTruthy();
  const openCodexLogin = Array.from(accountRow!.querySelectorAll("button")).find(button =>
    button.textContent?.trim() === "Add account" || button.textContent?.trim() === "Log in"
  );
  expect(openCodexLogin).toBeTruthy();
  await act(async () => { openCodexLogin!.click(); });
  await flush();

  const codexDialog = testWindow.document.querySelector('dialog[aria-label="Add Codex Account"]');
  expect(codexDialog).toBeTruthy();
  const before = {
    config: pathCount("/api/config"),
    oauth: pathCount("/api/oauth/providers"),
    quota: pathCount("/api/provider-quotas"),
    models: pathCount("/api/selected-models"),
  };

  const oauthButton = codexDialog!.querySelector<HTMLButtonElement>("button.list-row");
  expect(oauthButton).toBeTruthy();
  await act(async () => { oauthButton!.click(); });
  await flush();
  await act(async () => {
    jest.advanceTimersByTime(2_000);
    await Promise.resolve();
    await Promise.resolve();
  });
  await flush();
  return before;
}

test("pending Codex completion stays amber, private, dismissible, and refreshes Providers", async () => {
  const before = await completeCodexLogin();

  const warning = testWindow.document.querySelector<HTMLElement>(".toast-notice.notice-warn");
  expect(warning).toBeTruthy();
  expect(warning!.textContent).toContain("The change was saved");
  expect(warning!.textContent).toContain("ocx sync");
  expect(testWindow.document.body.textContent).not.toContain("private-account-detail");
  expect(pathCount("/api/config")).toBeGreaterThan(before.config);
  expect(pathCount("/api/oauth/providers")).toBeGreaterThan(before.oauth);
  expect(pathCount("/api/provider-quotas")).toBeGreaterThan(before.quota);
  expect(pathCount("/api/selected-models")).toBeGreaterThan(before.models);

  await act(async () => {
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
  });
  expect(testWindow.document.querySelector(".toast-notice.notice-warn")).toBeTruthy();

  const dismiss = warning!.querySelector<HTMLButtonElement>(".toast-notice-dismiss");
  expect(dismiss?.getAttribute("aria-label")).toBe("Close");
  await act(async () => { dismiss!.click(); });
  expect(testWindow.document.querySelector(".toast-notice")).toBeNull();
});

test("completed Codex catalog convergence reports clean success without sync advice", async () => {
  catalogRefreshPending = false;
  await completeCodexLogin();

  const success = testWindow.document.querySelector<HTMLElement>(".toast-notice.notice-ok");
  expect(success).toBeTruthy();
  expect(success!.textContent).toContain("Account added");
  expect(success!.textContent).not.toContain("ocx sync");
  expect(testWindow.document.querySelector(".toast-notice.notice-warn")).toBeNull();
});
