/**
 * The Accounts refresh control, rendered.
 *
 * The placement test asserts where it sits in the source; this one proves it actually
 * appears above the account rows and reports the settled result. The control existed
 * before, but only after every account's rate-limit bars, which is why an operator
 * looking straight at stale numbers could not see it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const domGlobals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let mountedRoots: Root[];

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

const ITEM: WorkspaceItem = {
  name: "anthropic",
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com",
  authMode: "oauth",
};

const ACCOUNTS = [
  { id: "account-1", label: "a@example.com", email: "a@example.com", active: false },
  { id: "account-2", label: "b@example.com", email: "b@example.com", active: true },
];

async function mountPanel(onRefreshQuota?: (name: string) => Promise<boolean>): Promise<HTMLElement> {
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  const handlers = {
    onLogin: async () => {},
    onLogout: async () => {},
    onReauth: async () => {},
    onSwitchAccount: async () => {},
    onSwitchApiKey: async () => {},
    onRemoveAccount: async () => {},
    onRemoveApiKey: async () => {},
    onAddApiKey: async () => {},
    onEditAlias: async () => {},
    ...(onRefreshQuota ? { onRefreshQuota } : {}),
  } as unknown as Parameters<typeof ProviderAuthPanel>[0]["authHandlers"];
  await act(async () => {
    const root = createRoot(host);
    mountedRoots.push(root);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={ITEM}
          apiBase="http://proxy"
          oauth={{ loggedIn: true, email: "b@example.com" }}
          accounts={ACCOUNTS as never}
          authHandlers={handlers}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await flush(); });
  return host as unknown as HTMLElement;
}

function headButton(host: ParentNode): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>(".pwi-auth-head-actions button");
  if (!el) throw new Error("refresh control missing from the accounts section head");
  return el;
}

beforeEach(() => {
  previousDomGlobals = Object.fromEntries(
    domGlobals.map((key) => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousDomGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mountedRoots = [];
});

afterEach(async () => {
  for (const root of mountedRoots) {
    await act(async () => { root.unmount(); });
  }
  mountedRoots = [];
  for (const key of domGlobals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
  }
  await testWindow.happyDOM?.close?.();
});

test("the refresh control renders above the account list", async () => {
  const host = await mountPanel(async () => true);
  const button = headButton(host);
  const list = host.querySelector(".pwi-auth-list") ?? host.querySelector(".pwi-auth-body");
  expect(list).not.toBeNull();
  // The whole point of the move: it must precede the bars it refreshes in document
  // order, instead of sitting after every account's stacked windows.
  const position = button.compareDocumentPosition(list!);
  expect(position & 0x04 /* DOCUMENT_POSITION_FOLLOWING */).toBeTruthy();
});

test("it is hidden when the page cannot drive a refresh", async () => {
  const host = await mountPanel();
  expect(host.querySelector(".pwi-auth-head-actions button")).toBeNull();
});

test("it disables while in flight and reports the settled result once", async () => {
  let release!: (ok: boolean) => void;
  const settled = new Promise<boolean>(resolve => { release = resolve; });
  let calls = 0;
  const host = await mountPanel(() => { calls += 1; return settled; });

  await act(async () => { headButton(host).click(); await flush(); });
  expect(calls).toBe(1);
  expect(headButton(host).disabled).toBe(true);

  // A second click while disabled must not issue another forced read.
  await act(async () => { headButton(host).click(); await flush(); });
  expect(calls).toBe(1);

  await act(async () => { release(true); await flush(); });
  expect(headButton(host).disabled).toBe(false);
  // Exactly one refresh live region, so one refresh is announced once. Scoped to the
  // head: this panel has other unrelated status regions (cockpit import, load state).
  const announced = [...host.querySelectorAll('[role="status"]')]
    .filter(el => el.className.includes("pws-status-"));
  expect(announced.length).toBe(1);
});

test("a failed refresh is reported, not swallowed", async () => {
  const host = await mountPanel(async () => false);
  await act(async () => { headButton(host).click(); await flush(); });
  expect(host.querySelector('[role="status"]')?.className).toContain("pws-status-warn");
});
