import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const globals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | null = null;

const ITEM: WorkspaceItem = {
  name: "mirasim",
  adapter: "mirasim",
  baseUrl: "https://relay.mirasim.ai",
  authMode: "oauth",
};

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
} as unknown as Parameters<typeof ProviderAuthPanel>[0]["authHandlers"];

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "zh-TW" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    await act(async () => { root?.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  await testWindow.happyDOM?.close?.();
});

test("Mirasim account card renders one canonical row per quota window with human labels", async () => {
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  const account = {
    id: "account-example-5523",
    email: "masked-mirasim-account",
    active: false,
    quotaMode: "probe",
    quota: {
      fiveHourPercent: 0.4,
      fiveHourResetAt: 1_800_000_000_000,
      weeklyPercent: 0.1,
      weeklyResetAt: 1_900_000_000_000,
      customWindows: [
        { label: "Model · 7d_claude", percent: 0.5, resetAt: 1_900_000_000_000 },
        { label: "Model · 7d_fable", percent: 0, resetAt: 1_900_000_000_000 },
      ],
      updatedAt: Date.now(),
    },
  };

  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={ITEM}
          apiBase=""
          oauth={{ loggedIn: true, email: account.email }}
          accounts={[account] as never}
          authHandlers={handlers}
        />
      </LanguageProvider>,
    );
  });

  expect(host.querySelector(".pwi-auth-row-label")?.textContent).toBe("masked-mirasim-account");
  const secondary = host.querySelector(".pwi-auth-row-secondary")?.textContent ?? "";
  expect(secondary).not.toContain("masked-mirasim-account");
  expect(secondary).toContain("ID:");

  const quotaLabels = Array.from(host.querySelectorAll(".quota-stacked-limit"))
    .map(node => node.textContent);
  expect(quotaLabels).toEqual([
    "5 小時限額",
    "每週限額",
    "Claude · 每週限額",
    "Fable · 每週限額",
  ]);
  expect(host.textContent).not.toContain("Model · 7d_");
});
