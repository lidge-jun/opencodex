import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderDetails from "../src/components/provider-workspace/ProviderDetails";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

/**
 * Regression: accountsFocusToken is a global counter. After a reveal for provider A,
 * selecting provider B must not open B's Accounts tab from the leftover token.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const WINDOW_EVENT_STUB: { event: undefined } = { event: undefined };
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

function oauthItem(name: string): WorkspaceItem {
  return {
    name,
    adapter: "openai-chat",
    baseUrl: `https://${name}.invalid/v1`,
    authMode: "oauth",
    hasApiKey: false,
  };
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperty(win, "event", { configurable: true, writable: true, value: undefined });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => ({ ok: true, json: async () => ({}) }) as unknown as Response,
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      await Promise.resolve();
    }
  });
  for (const key of globals) {
    let value = previous[key];
    if (key === "window") {
      if (value == null || typeof value !== "object") {
        value = WINDOW_EVENT_STUB;
      } else if (!Object.prototype.hasOwnProperty.call(value, "event")) {
        try {
          Object.defineProperty(value, "event", {
            configurable: true,
            writable: true,
            value: undefined,
          });
        } catch {
          value = WINDOW_EVENT_STUB;
        }
      }
    }
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

async function mountDetails(item: WorkspaceItem, focus: { token: number; provider: string | null }) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderDetails
          key={item.name}
          item={item}
          availableModels={[]}
          hasLiveModels={false}
          selectedModels={[]}
          onDeselect={() => {}}
          apiBase=""
          accounts={[]}
          accountLoadState="ready"
          accountsFocusToken={focus.token}
          accountsFocusProvider={focus.provider}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

function selectedTabId(): string | null {
  const selected = host.querySelector('[role="tab"][aria-selected="true"]');
  return selected?.id ?? null;
}

test("selecting provider B after A's focus request does not open B Accounts", async () => {
  // Leftover global token from a reveal for alpha — beta must ignore it.
  await mountDetails(oauthItem("beta"), { token: 3, provider: "alpha" });
  expect(selectedTabId()).toBe("pws-tab-overview");
});

test("the reveal target still opens Accounts on mount-time token", async () => {
  await mountDetails(oauthItem("alpha"), { token: 3, provider: "alpha" });
  expect(selectedTabId()).toBe("pws-tab-accounts");
});
