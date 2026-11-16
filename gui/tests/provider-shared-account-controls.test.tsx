import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useProviderAccountPools, type OAuthAccount } from "../src/hooks/useProviderAccountPools";
import { useProvidersOAuth } from "../src/pages/use-providers-oauth";
import * as dialogs from "../src/action-dialogs";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import ProviderDetails from "../src/components/provider-workspace/ProviderDetails";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

// #8087 owner condition: Kimi (Responses) account controls act on the shared Kimi account, say
// so, and destructive actions name the Kimi Chat row in their confirmation.

const globals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let roots: Root[] = [];
let pools: ReturnType<typeof useProviderAccountPools>;
let win: Window;
let puts: unknown[];
let logout: (provider: string) => Promise<void>;
let notices: string[];
let refetchedSets: string[];
let login: ReturnType<typeof useProvidersOAuth>["loginOAuth"];
let invalidated: string[];
let loginInfoUpdates: unknown[];
let settled: string[];

const row = (id: string, active: boolean, paused = false): OAuthAccount => ({ id, email: `${id}@example.test`, active, paused });
const t = (key: string, vars?: unknown) => vars === undefined ? key : `${key}|${JSON.stringify(vars)}`;

function Harness() {
  const aliveRef = useRef(true);
  const current = useProviderAccountPools({ apiBase: "/shared-hook", config: null, aliveRef, t: t as never,
    oauthStatus: {}, notify: () => {}, fetchConfig: async () => {}, fetchOauth: async () => {},
    fetchProviderQuotas: async () => {}, codexActiveNeedsReauth: false });
  useLayoutEffect(() => { pools = current; }, [current]);
  return null;
}

function LogoutHarness() {
  const aliveRef = useRef(true);
  const oauth = useProvidersOAuth({ apiBase: "/shared-hook", t: t as never, aliveRef, accountSets: {}, setAccountSets: () => {},
    setBusy: () => {}, setStatus: () => {}, setLoginInfo: update => { loginInfoUpdates.push(update); }, setOauthStatus: () => {},
    invalidateOauthStatusReads: provider => { invalidated.push(provider); return true; },
    onLoginSettled: provider => { settled.push(provider); },
    notify: message => { notices.push(message); }, fetchConfig: async () => {}, fetchOauth: async () => {},
    fetchAccountSets: async providers => { refetchedSets.push(...providers); }, fetchProviderQuotas: async () => {}, bumpModelsRefresh: () => {} });
  useLayoutEffect(() => { logout = oauth.logoutOAuth; login = oauth.loginOAuth; }, [oauth.logoutOAuth, oauth.loginOAuth]);
  return null;
}

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  await act(async () => { const root = createRoot(host as unknown as HTMLElement); roots.push(root); root.render(node); });
  await act(async () => { await new Promise<void>(resolve => win.setTimeout(resolve, 0)); });
  return host as unknown as HTMLElement;
}

beforeEach(async () => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  puts = [];
  notices = [];
  refetchedSets = [];
  invalidated = [];
  loginInfoUpdates = [];
  settled = [];
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    fetch: { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") puts.push({ method: init.method, url: String(input), body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (String(input).includes("/api/oauth/logout")) return Response.json({ success: true });
      if (String(input).includes("/api/oauth/status")) return Response.json({ loggedIn: true, activeAccountId: "a", accounts: [row("a", true)] });
      return Response.json({ activeAccountId: "a", accounts: [row("a", true), row("b", false)] });
    } },
  });
  roots = [];
});

afterEach(async () => {
  for (const root of roots) await act(async () => { root.unmount(); });
  roots = [];
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("pausing a shared Kimi account from Kimi (Responses) confirms that the Kimi Chat row stops using it", async () => {
  await mount(<Harness />);
  const consent = spyOn(dialogs, "confirmAction").mockResolvedValue(false);
  try {
    await act(async () => { await pools.pauseAccount("kimi-responses", row("a", true), true); });
    expect(consent).toHaveBeenCalledTimes(1);
    const message = String(consent.mock.calls[0]![0].message);
    expect(message).toStartWith("prov.accountPauseConfirmShared|");
    expect(message).toContain("Kimi (Moonshot)");
    expect(puts).toEqual([]);

    consent.mockClear();
    // Resuming is not destructive, and the owner's own row keeps its existing behavior.
    await act(async () => { await pools.pauseAccount("kimi-responses", row("a", true, true), false); });
    await act(async () => { await pools.pauseAccount("kimi", row("b", false), true); });
    expect(consent).not.toHaveBeenCalled();
  } finally {
    consent.mockRestore();
  }
});

test("removing a shared Kimi account from Kimi (Responses) names the Kimi Chat row in the confirmation", async () => {
  await mount(<Harness />);
  const consent = spyOn(dialogs, "confirmAction").mockResolvedValue(false);
  try {
    await act(async () => { await pools.removeAccount("kimi-responses", row("b", false)); });
    await act(async () => { await pools.removeAccount("kimi", row("b", false)); });
    const messages = consent.mock.calls.map(call => String(call[0].message));
    expect(messages[0]).toStartWith("prov.accountRemoveConfirmShared|");
    expect(messages[0]).toContain("Kimi (Moonshot)");
    expect(messages[1]).toStartWith("prov.accountRemoveConfirm|");
    expect(puts).toEqual([]);
  } finally {
    consent.mockRestore();
  }
});

test("the Kimi (Responses) Accounts panel says its controls act on the shared Kimi accounts", async () => {
  const accounts = [{ id: "a", email: "a@example.test", active: true }];
  const handlers = { onLogin: async () => {}, onLogout: async () => {}, onReauth: async () => {}, onSwitchAccount: async () => {},
    onSwitchApiKey: async () => {}, onRemoveAccount: async () => {}, onRemoveApiKey: async () => {}, onAddApiKey: async () => {},
    onEditAlias: async () => {} } as unknown as Parameters<typeof ProviderAuthPanel>[0]["authHandlers"];
  const panel = (name: string) => (
    <LanguageProvider>
      <ProviderAuthPanel item={{ name, adapter: "openai-responses", baseUrl: "https://api.kimi.com/coding/v1", authMode: "oauth" } as WorkspaceItem}
        apiBase="http://proxy" oauth={{ loggedIn: true, email: "a@example.test" }} accounts={accounts as never} authHandlers={handlers} />
    </LanguageProvider>
  );
  const shared = await mount(panel("kimi-responses"));
  const note = shared.querySelector('[role="note"]');
  expect(note?.textContent).toContain("shared Kimi (Moonshot) accounts");
  expect(note?.textContent).toContain("Kimi (Moonshot) Chat row");
  const owner = await mount(panel("kimi"));
  expect(owner.querySelector('[role="note"]')).toBeNull();
});

test("logging out from Kimi (Responses) confirms that the Kimi Chat row is signed out too, and refreshes both rows", async () => {
  await mount(<LogoutHarness />);
  const consent = spyOn(dialogs, "confirmAction").mockResolvedValue(false);
  try {
    await act(async () => { await logout("kimi-responses"); });
    expect(consent).toHaveBeenCalledTimes(1);
    const message = String(consent.mock.calls[0]![0].message);
    expect(message).toStartWith("prov.logoutConfirmShared|");
    expect(message).toContain("Kimi (Moonshot)");
    expect(puts).toEqual([]);

    consent.mockResolvedValue(true);
    await act(async () => { await logout("kimi-responses"); });
    expect(puts).toEqual([{ method: "POST", url: "/shared-hook/api/oauth/logout?provider=kimi-responses", body: undefined }]);
    expect(refetchedSets).toEqual(expect.arrayContaining(["kimi-responses", "kimi"]));
    expect(notices.at(-1)).toStartWith("prov.logoutOkShared|");
    expect(notices.at(-1)).toContain("Kimi (Moonshot)");
  } finally {
    consent.mockRestore();
  }
});

test("a sibling logout also fences the owner's status reads and login hint", async () => {
  await mount(<LogoutHarness />);
  const consent = spyOn(dialogs, "confirmAction").mockResolvedValue(true);
  try {
    await act(async () => { await logout("kimi-responses"); });
    expect(invalidated).toContain("kimi");
    const ownerHint = { provider: "kimi", deviceCode: "ABCD-1234" };
    const afterLogout = loginInfoUpdates.reduce<unknown>((current, update) =>
      typeof update === "function" ? (update as (value: unknown) => unknown)(current) : update, ownerHint);
    expect(afterLogout).toBeNull();
  } finally {
    consent.mockRestore();
  }
});

test("a login started from Kimi (Responses) selects the Kimi (Responses) row when it settles", async () => {
  await mount(<LogoutHarness />);
  const realSetTimeout = globalThis.setTimeout;
  // The status poll waits 2 s between reads; run it at once so the test needs no sleep.
  globalThis.setTimeout = ((callback: () => void) => { queueMicrotask(callback); return 0; }) as unknown as typeof setTimeout;
  try {
    await act(async () => { await login("kimi", false, undefined, false, "kimi-responses"); });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  expect(puts).toContainEqual(expect.objectContaining({ url: "/shared-hook/api/oauth/login", body: expect.objectContaining({ provider: "kimi", row: "kimi-responses" }) }));
  expect(settled).toEqual(["kimi-responses"]);
});

test("the Kimi (Responses) panel shows the Kimi device login it started, and cancels it under Kimi", async () => {
  const cancels: string[] = [];
  const handlers = { onLogin: async () => {}, onLogout: async () => {}, onReauth: async () => {}, onSwitchAccount: async () => {},
    onSwitchApiKey: async () => {}, onRemoveAccount: async () => {}, onRemoveApiKey: async () => {}, onAddApiKey: async () => {},
    onEditAlias: async () => {}, onCancelLogin: async (provider: string) => { cancels.push(provider); } } as unknown as Parameters<typeof ProviderAuthPanel>[0]["authHandlers"];
  const item = { name: "kimi-responses", adapter: "openai-responses", baseUrl: "https://api.kimi.com/coding/v1", authMode: "oauth" } as WorkspaceItem;
  const host = await mount(
    <LanguageProvider>
      <ProviderDetails item={item} availableModels={[]} hasLiveModels={false} selectedModels={[]} modelRows={[]}
        modelRevision="shared-login-1" modelRowsReady onOpenModels={() => {}} onDeselect={() => {}} apiBase=""
        oauth={{ loggedIn: false }} accounts={[]} accountLoadState="ready" accountsFocusToken={1} accountsFocusProvider="kimi-responses"
        busyProvider="kimi" loginHint={{ provider: "kimi", url: "https://www.kimi.com/device", deviceCode: "ABCD-1234" }}
        authHandlers={handlers} />
    </LanguageProvider>,
  );
  expect(host.textContent).toContain("ABCD-1234");
  const cancel = [...host.querySelectorAll("button")].find(button => button.textContent === "Cancel");
  expect(cancel).toBeDefined();
  await act(async () => { (cancel as HTMLButtonElement).click(); });
  expect(cancels).toEqual(["kimi"]);
});
