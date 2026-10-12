import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Claude from "../src/pages/Claude";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { CLAUDE_ACCOUNT_REDIRECT, readPageFromHash, resolveAppHashChange } from "../src/app-routing";
import { readProviderDeepLinkTab, readProviderSettingsTarget } from "../src/protocol-deep-links";
const globals = ["window", "document", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
// Same shape as claudecode-fetch-errors.test.tsx's CLAUDE_OK: a valid GET /api/claude-code body.
const CLAUDE_CODE_OK = {
  enabled: true, cliFirstParty: false, cliFirstPartyApplied: false, desktopFirstParty: false,
  interceptRunning: false, interceptEligible: true, sharedProxy: "none", authMode: "proxy",
  autoConnectSupported: false, systemEnv: false, fastMode: null, maxContextTokens: null,
  autoContext: true, autoCompactWindow: null, injectAgents: true, smallFastModel: "",
  effectiveModelEnv: {}, available: ["mock/model"], aliases: [], port: 10100, modelMap: {},
};
let previous: Record<string, unknown>;
let win: Window;
let root: Root | undefined;
const originalFetch = globalThis.fetch;
let reads: string[];
let configured = false;
let logins: unknown[];
beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/#claude/code" });
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  clearClientResourceStoresForTests();
  reads = [];
  logins = [];
  configured = false;
  globalThis.fetch = (async (input, init) => {
    const url = String(input); reads.push(url);
    if (url.endsWith("/api/oauth/login") && init?.method === "POST") logins.push(JSON.parse(String(init.body)));
    const body = url.endsWith("/api/oauth/login") ? { url: "https://claude.example.invalid/oauth/authorize" }
      : url.endsWith("/api/oauth/providers") ? { providers: ["anthropic"] }
      : url.endsWith("/api/native-integrations") ? { clients: [{ clientId: "claude", desiredEnabled: false, disableBlocked: null }] }
      : url.endsWith("/api/config") ? { providers: configured ? { anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" } } : {}, port: 10100 }
      : url.includes("/api/oauth/accounts?") ? { accounts: [{ id: "test-account", email: "test@example.test", active: true, quotaMode: "probe" }], activeAccountId: "test-account" }
      : url.endsWith("/api/claude-desktop/status") ? { firstParty: { interceptRunning: false, interceptEnabled: false, proxyPort: 10102 } }
      // Claude renders the Code content directly, so every mount reads this: answer like the server.
      : url.endsWith("/api/claude-code") ? CLAUDE_CODE_OK : {};
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  clearClientResourceStoresForTests(); globalThis.fetch = originalFetch;
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
  await win.happyDOM.close();
});
test("Claude hashes are terminal; Account and old integration hashes redirect", () => {
  for (const path of ["claude", "claude/code", "claude/desktop"]) {
    expect(readPageFromHash(path)).toBe("claude");
    expect(resolveAppHashChange(path)).toEqual({ page: "claude", replaceTo: null });
  }
  // The read-only Settings view folded into Code; its bookmark opens Code.
  expect(resolveAppHashChange("claude/settings")).toEqual({ page: "claude", replaceTo: "claude/code" });
  expect(resolveAppHashChange("integrations/claude")).toEqual({ page: "claude", replaceTo: "claude/code" });
  expect(resolveAppHashChange("integrations/claude/desktop")).toEqual({ page: "claude", replaceTo: "claude/desktop" });

  // Claude accounts live on Providers; the old Account bookmark lands on Anthropic's Accounts tab,
  // and the Providers deep link reads that destination even before the passive rewrite.
  expect(readPageFromHash("claude/account")).toBe("providers");
  expect(resolveAppHashChange("claude/account")).toEqual({ page: "providers", replaceTo: CLAUDE_ACCOUNT_REDIRECT });
  expect(resolveAppHashChange(CLAUDE_ACCOUNT_REDIRECT)).toEqual({ page: "providers", replaceTo: null });
  expect(readProviderSettingsTarget("#claude/account")).toBe("anthropic");
  expect(readProviderDeepLinkTab("#claude/account")).toBe("accounts");
});

test("embedded in Connect: no second title and no sub-tab strip, just the Code content", async () => {
  const container = win.document.createElement("div"); win.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(<LanguageProvider><Claude apiBase="" embedded active={false} /></LanguageProvider>); });
  expect(container.querySelector(".claude-page--embedded")).not.toBeNull();
  expect(container.querySelector(".page-head")).toBeNull();
  // One view, so no tab strip: a lone tab would be a control with nothing to switch to.
  expect(container.querySelector('[role="tablist"], [role="tab"], [role="tabpanel"]')).toBeNull();
  expect(container.querySelector(".claude-page > .page-sub")).not.toBeNull();
  // No account roster and no config probe anywhere on this page.
  expect(reads.some(url => url.includes("/api/oauth/accounts?"))).toBe(false);
  expect(reads.some(url => url.includes("/api/config"))).toBe(false);
});


test("Code starts stopped interception in place and re-reads status", async () => {
  // Start interception used to sit on the Settings sub-tab too; the Code content is now its only home here.
  let running = false;
  const starts: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/claude-intercept/start") && init?.method === "POST") {
      starts.push(url); running = true;
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/claude-code")) {
      return new Response(JSON.stringify({ ...CLAUDE_CODE_OK, interceptRunning: running, interceptReason: running ? null : "port_in_use", interceptFailurePort: running ? undefined : 10102 }), { headers: { "Content-Type": "application/json" } });
    }
    return previousFetch(input, init);
  }) as typeof fetch;
  const container = win.document.createElement("div"); win.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(<LanguageProvider><Claude apiBase="" /></LanguageProvider>); });
  const panel = container.querySelector(".claude-page")!;
  const findStart = () => [...panel.querySelectorAll("button")].find(button => button.textContent === "Start interception") as HTMLButtonElement | undefined;
  for (let tick = 0; tick < 50 && !findStart(); tick++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  const start = findStart();
  expect(start).toBeDefined();
  expect(start!.closest('[role="status"]')?.textContent).toContain("Port 10102 is in use.");
  await act(async () => { start!.click(); });
  for (let tick = 0; tick < 50 && findStart(); tick++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  expect(starts.length).toBe(1);
  expect(findStart()).toBeUndefined();
});
