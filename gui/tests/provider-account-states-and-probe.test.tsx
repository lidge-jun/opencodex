/**
 * Account table states on the Antigravity Accounts panel: an upstream-banned row (with and without
 * quota readings), the "Verification needed" flag, and the Test / Test all probe controls.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import type { ProviderAuthHandlers } from "../src/components/provider-workspace/types";
import type { OAuthAccount } from "../src/hooks/useProviderAccountPools";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let probeBodies: unknown[];

const item = { name: "google-antigravity", adapter: "openai-responses", authMode: "oauth", hasApiKey: false } as unknown as WorkspaceItem;
const handlers: ProviderAuthHandlers = {
  onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {}, onRemoveAccount: () => {},
  onAddApiKey: async () => true, onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
};
const PAUSED_AT = Date.parse("2026-11-13T12:00:00Z");
const bannedDetails = { reason: "account_permission_denied", pausedAt: PAUSED_AT, message: "This account was disabled upstream.", statusCode: 403 };

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  probeBodies = [];
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    sessionStorage: { configurable: true, value: win.sessionStorage },
    fetch: { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/oauth/accounts/probe")) {
        const body = JSON.parse(String(init?.body)) as { accountId?: string };
        probeBodies.push(body);
        const ids = body.accountId ? [body.accountId] : ["a", "b"];
        return Response.json({ results: ids.map(accountId => ({ accountId, status: "ok", httpStatus: 200, reason: null, message: null, latencyMs: 120 })) });
      }
      return Response.json({});
    } },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});

async function render(accounts: OAuthAccount[]) {
  await act(async () => {
    root ??= createRoot(host);
    root.render(<LanguageProvider><ProviderAuthPanel item={item} apiBase="" accounts={accounts} authHandlers={handlers} /></LanguageProvider>);
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return (Array.from(host.querySelectorAll("button")) as unknown as HTMLButtonElement[])
    .find(candidate => (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").trim().startsWith(label));
}

const banned = (extra: Partial<OAuthAccount> = {}): OAuthAccount =>
  ({ id: "a", active: false, paused: true, pauseDetails: bannedDetails, ...extra });

test("a banned account with no quota reading shows the ban notice and its reason once", async () => {
  await render([banned()]);
  expect(host.querySelector('[data-flag="banned"]')).not.toBeNull();
  expect(host.querySelectorAll(".aqt-banned").length).toBe(1);
  expect(host.querySelector(".aqt-banned-text")?.textContent).toContain("Upstream refused this account");
  expect(host.textContent).toContain("This account was disabled upstream.");
  expect(host.textContent).toContain("HTTP 403");
  // The generic paused hint would repeat the same fact, so a banned row leaves it out.
  expect(host.textContent).not.toContain("Excluded from automatic selection");
  // Control: an ordinary pause still shows the hint, so the absence above is not vacuous.
  await render([{ id: "a", active: false, paused: true }]);
  expect(host.textContent).toContain("Excluded from automatic selection");
});

test("a banned account that still has quota readings shows the notice in the pool cell, not twice", async () => {
  const quota = { customWindows: [{ label: "Gem", percent: 10 }] };
  await render([banned({ quota })]);
  expect(host.querySelectorAll(".aqt-banned").length).toBe(1);
  expect(host.querySelector(".aqt-pool--banned .aqt-banned")).not.toBeNull();
  expect(host.querySelector(".aqt-detail .aqt-banned")).toBeNull();
  expect(host.textContent).toContain("HTTP 403");
});

test("an account the upstream asked to verify reads Verification needed", async () => {
  await render([{ id: "a", active: false, needsReauth: true, needsReauthReason: "verify_account" }]);
  expect(host.querySelector('[data-flag="verify"]')).not.toBeNull();
  expect(host.querySelector(".aqt-flag")?.textContent).toBe("Verification needed");
});

test("Test probes one account and Test all probes the provider; results land under the rows", async () => {
  await render([{ id: "a", active: true }, { id: "b", active: false }]);
  await act(async () => { button("Test —")!.click(); });
  expect(probeBodies).toEqual([{ provider: "google-antigravity", accountId: "a" }]);
  expect(host.querySelector('[data-probe-status="ok"]')).not.toBeNull();

  await act(async () => { button("Test all")!.click(); });
  expect(probeBodies.at(-1)).toEqual({ provider: "google-antigravity" });
  expect(host.querySelectorAll('[data-probe-status="ok"]').length).toBe(2);
});
