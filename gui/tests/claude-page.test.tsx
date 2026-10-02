import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Claude from "../src/pages/Claude";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { readClaudeTab, CLAUDE_TABS } from "../src/pages/claude-tab";
import { readPageFromHash, resolveAppHashChange } from "../src/app-routing";
const globals = ["window", "document", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>;
let win: Window;
let root: Root | undefined;
const originalFetch = globalThis.fetch;
let reads: string[];
let configured = false;
let logins: unknown[];
beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/#claude/settings" });
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
      : url.endsWith("/api/claude-desktop/status") ? { firstParty: { interceptRunning: false, interceptEnabled: false, proxyPort: 10102 } } : {};
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  clearClientResourceStoresForTests(); globalThis.fetch = originalFetch;
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
  await win.happyDOM.close();
});
test("Claude hashes are terminal and old integration hashes redirect", () => {
  for (const path of ["claude", ...CLAUDE_TABS.map(tab => `claude/${tab}`)]) {
    expect(readPageFromHash(path)).toBe("claude");
    expect(resolveAppHashChange(path)).toEqual({ page: "claude", replaceTo: null });
  }
  expect(readClaudeTab("#claude")).toBe("code");
  expect(readClaudeTab("#claude", true)).toBe("account");
  expect(resolveAppHashChange("integrations/claude")).toEqual({ page: "claude", replaceTo: "claude/code" });
  expect(resolveAppHashChange("integrations/claude/desktop")).toEqual({ page: "claude", replaceTo: "claude/desktop" });
});
test("Settings lazy-mounts; keyboard and history latch exclusive panels", async () => {
  const container = win.document.createElement("div"); win.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(<LanguageProvider><Claude apiBase="" /></LanguageProvider>); });
  expect(container.querySelectorAll('[role="tabpanel"]').length).toBe(1);
  expect(reads.some(url => url.includes("/api/config"))).toBe(false);
  const settings = container.querySelector('#claude-tab-settings')!;
  const key = async (id: string, value: string) => {
    await act(async () => {
      container.querySelector(id)!.dispatchEvent(new win.KeyboardEvent("keydown", { key: value, bubbles: true }));
      win.dispatchEvent(new win.HashChangeEvent("hashchange"));
    });
  };
  await key('#claude-tab-settings', 'ArrowRight');
  expect(win.location.hash).toBe("#claude/account");
  expect(win.document.activeElement?.id).toBe("claude-tab-account");
  expect(container.querySelectorAll('[role="tabpanel"]').length).toBe(2);
  expect(container.querySelectorAll('[role="tabpanel"]:not([hidden])').length).toBe(1);
  // No Anthropic provider: the Account tab offers the ordinary Add provider flow.
  const empty = container.querySelector("#claude-panel-account .claude-account-empty");
  expect(empty?.textContent).toContain("Anthropic is not set up yet");
  expect(empty?.querySelector("button")?.textContent).toBe("Add Anthropic");
  await key('#claude-tab-account', 'End');
  expect(win.location.hash).toBe("#claude/settings");
  expect(win.document.activeElement?.id).toBe("claude-tab-settings");
  // Account unmounts with its tab, so the provider roster poll stops with it.
  expect(container.querySelector("#claude-panel-account")).toBeNull();
  await key('#claude-tab-settings', 'Home');
  expect(win.location.hash).toBe("#claude/account");
  await key('#claude-tab-account', 'ArrowLeft');
  expect(win.location.hash).toBe("#claude/settings");
  await act(async () => { win.location.hash = "claude/account"; win.dispatchEvent(new win.PopStateEvent("popstate")); });
  expect(settings.getAttribute("aria-selected")).toBe("false");
});

test("configured Account renders only Anthropic's Accounts content under one stable page head", async () => {
  configured = true;
  win.location.hash = "claude/account";
  const container = win.document.createElement("div"); win.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(<LanguageProvider><Claude apiBase="configured" /></LanguageProvider>); });
  const panel = container.querySelector("#claude-panel-account")!;
  expect([...container.querySelectorAll(".page-head h2")].map(h => h.textContent)).toEqual(["Claude"]);
  // The provider's Accounts content alone: no rail, provider header, actions, or second tab bar.
  expect(panel.querySelector(".pwi-auth-body")).not.toBeNull();
  for (const chrome of [".page-head", ".pws-rail", ".pws-detail-head-main", ".pws-detail-tabs", ".pws-detail-back-link"]) {
    expect(panel.querySelector(chrome)).toBeNull();
  }
  expect(panel.querySelectorAll('[role="tab"]').length).toBe(0);
  const refresh = [...panel.querySelectorAll("button")].find(button => button.textContent?.includes("Refresh quota"));
  expect(refresh).toBeDefined();
  await act(async () => { refresh!.click(); });
  for (let tick = 0; tick < 50 && refresh!.disabled; tick++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  // With no workspace shell, the forced account read alone settles the refresh.
  expect(refresh!.disabled).toBe(false);
  expect(reads.some(url => url.includes("provider=anthropic") && url.includes("refresh=1"))).toBe(true);
  expect(reads.some(url => url.includes("/api/codex-auth"))).toBe(false);
});

test("Add Anthropic starts Anthropic sign-in directly and shows its login link in place", async () => {
  win.location.hash = "claude/account";
  const container = win.document.createElement("div"); win.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(<LanguageProvider><Claude apiBase="" /></LanguageProvider>); });
  const add = container.querySelector(".claude-account-empty button") as HTMLButtonElement;
  expect(add.textContent).toBe("Add Anthropic");
  await act(async () => { add.click(); });
  // The same path as the Add provider Accounts row: the terms warning, then the login. No catalog.
  expect(win.document.body.textContent).not.toContain("Search providers");
  const dialog = win.document.querySelector("dialog")!;
  expect(dialog.textContent).toContain("Anthropic");
  await act(async () => { (dialog.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  const proceed = [...dialog.querySelectorAll("button")].find(button => button.textContent === "Continue with Claude subscription") as HTMLButtonElement;
  await act(async () => { proceed.click(); });
  for (let tick = 0; tick < 20 && logins.length === 0; tick++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  expect(logins).toEqual([{ provider: "anthropic" }]);
  const hint = container.querySelector(".claude-account-empty-hint");
  expect(hint?.textContent).toContain("https://claude.example.invalid/oauth/authorize");
  expect(container.querySelector(".claude-account-empty-actions")?.textContent).toContain("Cancel");
});

test("bare Claude selects Account only after Anthropic configuration is loaded", async () => {
  configured = true;
  win.location.hash = "claude";
  const container = win.document.createElement("div"); win.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(<LanguageProvider><Claude apiBase="" /></LanguageProvider>); });
  expect(container.querySelector('#claude-tab-account')?.getAttribute('aria-selected')).toBe('true');
});

test("Settings shows the Claude connection read-only; the switch lives on Code", async () => {
  const container = win.document.createElement("div"); win.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(<LanguageProvider><Claude apiBase="" /></LanguageProvider>); });
  const panel = container.querySelector("#claude-panel-settings")!;
  expect(panel.querySelector('button[aria-pressed], [role="switch"], .switch')).toBeNull();
  expect(panel.querySelector("[data-claude-connection-status]")?.textContent).toBe("Off");
  expect(panel.textContent).toContain("Claude connection");
  expect(panel.textContent).toContain("Stopped");
  expect(panel.querySelector("code")?.textContent).toBe("10102");
  expect([...panel.querySelectorAll("button")].some(button => button.textContent === "Change on Code tab")).toBe(true);
  expect(reads.some(url => url.endsWith("/api/native-integrations/claude"))).toBe(false);
});

test("Settings starts stopped interception in place and re-reads status", async () => {
  let running = false;
  const starts: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/claude-intercept/start") && init?.method === "POST") {
      starts.push(url); running = true;
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/claude-desktop/status")) {
      return new Response(JSON.stringify({ firstParty: { interceptRunning: running, interceptEnabled: true, proxyPort: running ? 10102 : 10200, interceptReason: running ? null : "port_in_use", interceptFailurePort: running ? undefined : 10102 } }), { headers: { "Content-Type": "application/json" } });
    }
    return previousFetch(input, init);
  }) as typeof fetch;
  const container = win.document.createElement("div"); win.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(<LanguageProvider><Claude apiBase="" /></LanguageProvider>); });
  const panel = container.querySelector("#claude-panel-settings")!;
  const slot = panel.querySelector("[data-claude-intercept-start-slot]")!;
  expect(slot.textContent).toContain("Port 10102 is in use.");
  // The port row names the port the failed start tried, not the settings-env fallback.
  expect(panel.querySelector("code")?.textContent).toBe("10102");
  expect(slot.textContent?.toLowerCase()).not.toContain("restart");
  const start = [...slot.querySelectorAll("button")].find(button => button.textContent === "Start interception") as HTMLButtonElement;
  await act(async () => { start.click(); });
  for (let tick = 0; tick < 50 && panel.querySelector("[data-claude-intercept-start-slot]"); tick++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  expect(starts.length).toBe(1);
  expect(panel.querySelector("[data-claude-intercept-start-slot]")).toBeNull();
  expect(panel.textContent).toContain("Running");
});

test("Add Anthropic does not wait on OAuth provider discovery (cold mount, discovery fails)", async () => {
  const previousFetch = globalThis.fetch;
  let releaseDiscovery!: () => void;
  const discovery = new Promise<void>(resolve => { releaseDiscovery = resolve; });
  globalThis.fetch = (async (input, init) => {
    // /api/oauth/providers loses the race with /api/config and then fails outright.
    if (String(input).endsWith("/api/oauth/providers")) {
      await discovery;
      return new Response("unavailable", { status: 503 });
    }
    return previousFetch(input, init);
  }) as typeof fetch;
  win.location.hash = "claude/account";
  const container = win.document.createElement("div"); win.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(<LanguageProvider><Claude apiBase="" /></LanguageProvider>); });
  const add = container.querySelector(".claude-account-empty button") as HTMLButtonElement;
  expect(add.disabled).toBe(false);
  // Discovery is still pending: the click must start the Anthropic flow, not no-op.
  await act(async () => { add.click(); });
  const dialog = win.document.querySelector("dialog")!;
  expect(dialog.textContent).toContain("Anthropic");
  await act(async () => { releaseDiscovery(); await discovery; });
  await act(async () => { (dialog.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
  const proceed = [...dialog.querySelectorAll("button")].find(button => button.textContent === "Continue with Claude subscription") as HTMLButtonElement;
  await act(async () => { proceed.click(); });
  for (let tick = 0; tick < 20 && logins.length === 0; tick++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  expect(logins).toEqual([{ provider: "anthropic" }]);
});

test("scoped Account reads rosters, keys and quota for Anthropic only", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/config")) {
      reads.push(url);
      return new Response(JSON.stringify({ port: 10100, providers: {
        anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
        "google-antigravity": { adapter: "gemini", baseUrl: "https://example.test", authMode: "oauth" },
        deepseek: { adapter: "openai", baseUrl: "https://example.test", hasApiKey: true },
      } }), { headers: { "Content-Type": "application/json" } });
    }
    return previousFetch(input, init);
  }) as typeof fetch;
  win.location.hash = "claude/account";
  const container = win.document.createElement("div"); win.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root!.render(<LanguageProvider><Claude apiBase="" /></LanguageProvider>); });
  for (let tick = 0; tick < 10; tick++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  const refresh = [...container.querySelectorAll("#claude-panel-account button")].find(button => button.textContent?.includes("Refresh quota"));
  if (refresh) await act(async () => { (refresh as HTMLButtonElement).click(); });
  for (let tick = 0; tick < 10; tick++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  const rosterReads = reads.filter(url => url.includes("/api/oauth/accounts?") || url.includes("/api/providers/keys?"));
  expect(rosterReads.some(url => url.includes("provider=anthropic"))).toBe(true);
  expect(rosterReads.some(url => url.includes("quota=1") && url.includes("provider=anthropic"))).toBe(true);
  expect(rosterReads.filter(url => !url.includes("provider=anthropic"))).toEqual([]);
});
