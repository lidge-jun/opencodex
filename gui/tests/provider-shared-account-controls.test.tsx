import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useProviderAccountPools, type OAuthAccount } from "../src/hooks/useProviderAccountPools";
import * as dialogs from "../src/action-dialogs";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
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
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    fetch: { configurable: true, value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") puts.push({ method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined });
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
