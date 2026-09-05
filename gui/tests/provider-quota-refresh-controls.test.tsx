/**
 * The operator-facing quota refresh controls.
 *
 * The interesting property is not that a button exists; it is that the button does not
 * LIE. `fetchProviderQuotas(true)` is a synchronous state bump, not a request — the shell
 * owns the only `/api/provider-quotas` read — so a control that resolved on its own would
 * report "Quotas refreshed" while the previous numbers were still on screen. These tests
 * pin the busy state and the reported outcome to a handler that settles independently.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ProviderUsage from "../src/components/provider-workspace/ProviderUsage";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import type { ProviderAuthHandlers } from "../src/components/provider-workspace/types";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    sessionStorage: { configurable: true, value: win.sessionStorage },
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

function findButton(label: string): HTMLButtonElement | null {
  const buttons = Array.from(host.querySelectorAll("button")) as unknown as HTMLButtonElement[];
  return buttons.find(button => (button.textContent ?? "").includes(label)) ?? null;
}

/** A handler the test settles by hand, standing in for the shell's forced read. */
function deferredHandler() {
  let settle!: (ok: boolean) => void;
  const calls: number[] = [];
  const handler = async () => {
    calls.push(Date.now());
    return await new Promise<boolean>(resolve => { settle = resolve; });
  };
  return { handler, calls, settle: (ok: boolean) => settle(ok) };
}

async function render(node: React.ReactNode) {
  await act(async () => {
    root ??= createRoot(host);
    root.render(<LanguageProvider>{node}</LanguageProvider>);
  });
}

const usageItem = { name: "meta-muse", adapter: "openai-responses", authMode: "oauth" } as unknown as WorkspaceItem;

test("the usage tab reports the real outcome, not the click", async () => {
  const { handler, calls, settle } = deferredHandler();
  await render(<ProviderUsage item={usageItem} onRefreshQuota={handler} />);

  const button = findButton("Refresh quotas");
  expect(button).not.toBeNull();

  await act(async () => { button!.click(); });
  expect(calls.length).toBe(1);
  // Still in flight: the copy says so and the control cannot be double-fired.
  expect(host.textContent).toContain("Refreshing...");
  expect(findButton("Refreshing...")?.disabled).toBe(true);
  expect(host.textContent).not.toContain("Quota check completed");

  await act(async () => { settle(true); await Promise.resolve(); });
  expect(host.textContent).toContain("Quota check completed");
});

test("a failed read is reported as a failure", async () => {
  const { handler, settle } = deferredHandler();
  await render(<ProviderUsage item={usageItem} onRefreshQuota={handler} />);

  await act(async () => { findButton("Refresh quotas")!.click(); });
  await act(async () => { settle(false); await Promise.resolve(); });

  expect(host.textContent).toContain("Failed to refresh quotas");
  expect(host.textContent).not.toContain("Quota check completed");
});

test("the usage control is offered even when there is no quota to show", async () => {
  // "Nothing here" is exactly when an operator wants to retry.
  await render(<ProviderUsage item={usageItem} onRefreshQuota={async () => true} />);
  expect(host.textContent).toContain("Current account usage");
  expect(findButton("Refresh quotas")).not.toBeNull();
});

test("no handler means no button rather than one that does nothing", async () => {
  await render(<ProviderUsage item={usageItem} />);
  expect(findButton("Refresh quotas")).toBeNull();
});

const oauthItem = {
  name: "meta-muse",
  adapter: "openai-responses",
  authMode: "oauth",
  hasApiKey: false,
} as unknown as WorkspaceItem;

function authHandlers(extra: Partial<ProviderAuthHandlers> = {}): ProviderAuthHandlers {
  return {
    onLogin: () => {},
    onLogout: () => {},
    onReauth: () => {},
    onSwitchAccount: () => {},
    onRemoveAccount: () => {},
    onAddApiKey: async () => true,
    onSwitchApiKey: () => {},
    onRemoveApiKey: () => {},
    onEditAlias: () => {},
    ...extra,
  };
}

const account = {
  id: "acct-1",
  email: "muse@example.test",
  active: true,
} as unknown as Parameters<typeof ProviderAuthPanel>[0]["accounts"] extends (infer T)[] | undefined ? T : never;

test("the accounts surface offers the same control for a non-Codex provider", async () => {
  const { handler, calls, settle } = deferredHandler();
  await render(
    <ProviderAuthPanel
      item={oauthItem}
      apiBase=""
      accounts={[account]}
      authHandlers={authHandlers({ onRefreshQuota: async () => await handler() })}
    />,
  );

  const button = findButton("Refresh quotas");
  expect(button).not.toBeNull();

  await act(async () => { button!.click(); });
  expect(calls.length).toBe(1);
  expect(findButton("Refreshing...")?.disabled).toBe(true);

  await act(async () => { settle(true); await Promise.resolve(); });
  expect(host.textContent).toContain("Quota check completed");
});

test("the accounts surface omits the control when the page cannot force a read", async () => {
  await render(
    <ProviderAuthPanel item={oauthItem} apiBase="" accounts={[account]} authHandlers={authHandlers()} />,
  );
  expect(findButton("Refresh quotas")).toBeNull();
});

test("API-key rows use independent shared credit readings and the same awaited refresh control", async () => {
  const { handler, settle } = deferredHandler();
  const credits = (remaining: number) => ({ updatedAt: Date.now() - 60_000,
    creditsUsd: { used: 50 - remaining, limit: 50, remaining, percent: (50 - remaining) * 2 },
  });
  await render(<ProviderAuthPanel item={{ ...oauthItem, name: "key-provider", authMode: "key", hasApiKey: true }} apiBase=""
    keys={[
      { id: "first", masked: "first-masked", active: true, quotaMode: "probe", quota: credits(37.5) },
      { id: "second", masked: "second-masked", active: false, quotaMode: "probe", quota: credits(12.5), quotaUnavailable: true },
    ]} authHandlers={authHandlers({ onRefreshQuota: handler })} />);
  const rows = Array.from(host.querySelectorAll(".pwi-auth-acct"));
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("US$37.50");
  expect(rows[0].textContent).not.toContain("US$12.50");
  expect(rows[1].textContent).toContain("US$12.50");
  expect(rows[1].querySelector('[data-quota-state="unavailable"]')).not.toBeNull();
  await act(async () => { findButton("Refresh quotas")!.click(); });
  expect(findButton("Refreshing...")?.disabled).toBe(true);
  expect(host.textContent).not.toContain("Quota check completed");
  await act(async () => { settle(false); });
  expect(host.textContent).toContain("Failed to refresh quotas");
});

test("unsupported credentials omit refresh; passive absence is unobserved and only explicit probes are pending", async () => {
  await render(<ProviderAuthPanel item={{ ...oauthItem, authMode: "key", hasApiKey: true }} apiBase=""
    keys={[{ id: "unsupported", masked: "masked", active: true, quotaMode: "unsupported" }]}
    authHandlers={authHandlers({ onRefreshQuota: async () => true })} />);
  expect(findButton("Refresh quotas")).toBeNull();
  expect(host.querySelector('[data-quota-state="unsupported"]')).not.toBeNull();
  await render(<ProviderAuthPanel item={oauthItem} apiBase="" accounts={[
    { id: "passive", active: true, quotaMode: "passive" },
    { id: "probe", active: false, quotaMode: "probe", quotaPending: true },
  ]} authHandlers={authHandlers()} />);
  expect(host.querySelectorAll('[data-quota-state="unobserved"]')).toHaveLength(1);
  expect(host.querySelectorAll('[data-quota-state="pending"]')).toHaveLength(1);
});

test("changing active account discards the previous refresh feedback", async () => {
  const { handler, settle } = deferredHandler();
  const handlers = authHandlers({ onRefreshQuota: handler });
  await render(<ProviderAuthPanel item={oauthItem} apiBase="" accounts={[{ id: "first", active: true, quotaMode: "passive" }]} authHandlers={handlers} />);
  await act(async () => { findButton("Refresh quotas")!.click(); });
  await render(<ProviderAuthPanel item={oauthItem} apiBase="" accounts={[{ id: "second", active: true, quotaMode: "passive" }]} authHandlers={handlers} />);
  await act(async () => { settle(true); });
  expect(host.textContent).not.toContain("Quota check completed");
  expect(findButton("Refresh quotas")?.disabled).toBe(false);
});
