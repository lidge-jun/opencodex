import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import type { ProviderAuthHandlers } from "../src/components/provider-workspace/types";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "fetch"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let fetchMock: ReturnType<typeof mock>;

const ITEM: WorkspaceItem = {
  name: "google-antigravity",
  adapter: "google",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  authMode: "oauth",
};

function handlers(): ProviderAuthHandlers {
  return {
    onLogin: () => {},
    onLogout: () => {},
    onReauth: () => {},
    onSwitchAccount: () => {},
    onRemoveAccount: () => {},
    onAddApiKey: async () => true,
    onSwitchApiKey: async () => {},
    onRemoveApiKey: async () => {},
    onEditAlias: () => {},
  };
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  fetchMock = mock(async () => Response.json({
    provider: "google-antigravity",
    enabled: false,
    autoSwitchThreshold: 80,
    strategy: "quota",
    stickyLimit: 1,
  }));
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    fetch: { configurable: true, value: fetchMock },
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
  await win.happyDOM?.close?.();
});

async function mount(accountIds = ["acct-a", "acct-b"]): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={ITEM}
          apiBase="/proxy"
          accounts={accountIds.map((id, index) => ({ id, active: index === 0 }))}
          authHandlers={handlers()}
        />
      </LanguageProvider>,
    );
    await Promise.resolve();
    await new Promise(resolve => win.setTimeout(resolve, 0));
  });
}

test("Google Antigravity settings load the provider pool contract in the auth panel", async () => {
  await mount();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/proxy/api/oauth/accounts/pool?provider=google-antigravity");
  expect(host.textContent).toContain("Google Antigravity account pool");
  expect(host.textContent).toContain("Uses only the active Google Antigravity account.");
  expect(host.textContent).not.toContain("Experimental and not battle-tested.");
});

test("enabling the Google Antigravity pool sends the exact provider policy and updates accessible state", async () => {
  await mount();

  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Google Antigravity account pool"]');
  expect(toggle?.getAttribute("aria-pressed")).toBe("false");

  await act(async () => {
    toggle?.click();
    await Promise.resolve();
    await new Promise(resolve => win.setTimeout(resolve, 0));
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [url, init] = fetchMock.mock.calls[1] ?? [];
  expect(url).toBe("/proxy/api/oauth/accounts/pool");
  expect(init).toMatchObject({
    method: "PUT",
    headers: { "content-type": "application/json" },
  });
  expect(JSON.parse(String(init?.body))).toEqual({
    provider: "google-antigravity",
    enabled: true,
    autoSwitchThreshold: 80,
    strategy: "quota",
    stickyLimit: 1,
  });
  expect(toggle?.getAttribute("aria-pressed")).toBe("true");
  expect(host.textContent).toContain(
    "Fails over on upstream HTTP 429 or surfaced HTTP 402. New sessions prefer accounts below 80% usage.",
  );
});

test("fewer than two Google OAuth accounts disables enabling", async () => {
  await mount(["acct-a"]);

  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Google Antigravity account pool"]');
  expect(toggle?.disabled).toBe(true);
  expect(host.textContent).toContain("Add at least two Google OAuth accounts before enabling the pool.");
});

test("an already-enabled Google pool can be disabled with only one account", async () => {
  fetchMock.mockImplementation(async (_url, init) => Response.json({
    provider: "google-antigravity",
    enabled: init?.method === "PUT" ? false : true,
    autoSwitchThreshold: 80,
    strategy: "quota",
    stickyLimit: 1,
  }));
  await mount(["acct-a"]);

  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Google Antigravity account pool"]');
  expect(toggle?.disabled).toBe(false);
  expect(toggle?.getAttribute("aria-pressed")).toBe("true");

  await act(async () => {
    toggle?.click();
    await Promise.resolve();
    await new Promise(resolve => win.setTimeout(resolve, 0));
  });

  expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
    provider: "google-antigravity",
    enabled: false,
  });
  expect(toggle?.getAttribute("aria-pressed")).toBe("false");
});

test("Google threshold validation restores the confirmed value and valid input sends the exact policy", async () => {
  fetchMock.mockImplementation(async (_url, init) => Response.json({
    provider: "google-antigravity",
    enabled: true,
    autoSwitchThreshold: init?.method === "PUT"
      ? JSON.parse(String(init.body)).autoSwitchThreshold
      : 80,
    strategy: "quota",
    stickyLimit: 1,
  }));
  await mount();

  const input = host.querySelector<HTMLInputElement>('input[type="number"][min="0"]');
  expect(input?.value).toBe("80");
  const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;

  await act(async () => {
    setValue?.call(input, "101");
    input?.dispatchEvent(new win.Event("input", { bubbles: true }));
    input?.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    await Promise.resolve();
  });

  expect(input?.value).toBe("80");
  expect(host.textContent).toContain("Enter a whole-number percentage from 0 to 100");
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await act(async () => {
    setValue?.call(input, "65");
    input?.dispatchEvent(new win.Event("input", { bubbles: true }));
    input?.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    await Promise.resolve();
    await new Promise(resolve => win.setTimeout(resolve, 0));
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
    provider: "google-antigravity",
    enabled: true,
    autoSwitchThreshold: 65,
    strategy: "quota",
    stickyLimit: 1,
  });
  expect(input?.value).toBe("65");
});

test("an empty Google threshold draft is invalid and never saves zero", async () => {
  fetchMock.mockImplementation(async () => Response.json({
    provider: "google-antigravity",
    enabled: true,
    autoSwitchThreshold: 80,
    strategy: "quota",
    stickyLimit: 1,
  }));
  await mount();

  const input = host.querySelector<HTMLInputElement>('input[type="number"][min="0"]');
  const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(input, "");
    input?.dispatchEvent(new win.Event("input", { bubbles: true }));
    input?.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    await Promise.resolve();
  });

  expect(input?.value).toBe("80");
  expect(host.textContent).toContain("Enter a whole-number percentage from 0 to 100");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a failed Google save rolls back confirmed state without rendering the backend body", async () => {
  let resolveSave: ((response: Response) => void) | undefined;
  fetchMock.mockImplementation(async (_url, init) => {
    if (init?.method === "PUT") {
      return await new Promise<Response>(resolve => { resolveSave = resolve; });
    }
    return Response.json({
      provider: "google-antigravity",
      enabled: false,
      autoSwitchThreshold: 80,
      strategy: "quota",
      stickyLimit: 1,
    });
  });
  await mount();

  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Google Antigravity account pool"]');
  await act(async () => {
    toggle?.click();
    await Promise.resolve();
  });
  expect(toggle?.getAttribute("aria-pressed")).toBe("true");

  await act(async () => {
    resolveSave?.(Response.json({ error: "BACKEND_BODY_CANARY" }, { status: 500 }));
    await Promise.resolve();
    await new Promise(resolve => win.setTimeout(resolve, 0));
  });

  expect(toggle?.getAttribute("aria-pressed")).toBe("false");
  expect(host.textContent).toContain("Google Antigravity pool settings could not be saved.");
  expect(host.textContent).not.toContain("BACKEND_BODY_CANARY");
});
