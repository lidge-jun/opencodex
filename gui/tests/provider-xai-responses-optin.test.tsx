import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import type {
  ProviderAuthHandlers,
  ProviderUpdatePatch,
  ProviderUpdateResult,
} from "../src/components/provider-workspace/types";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | null = null;
let container: HTMLElement;

const handlers: ProviderAuthHandlers = {
  onLogin: () => {},
  onLogout: () => {},
  onReauth: () => {},
  onSwitchAccount: () => {},
  onRemoveAccount: () => {},
  onAddApiKey: async () => true,
  onSwitchApiKey: () => {},
  onRemoveApiKey: () => {},
  onEditAlias: () => {},
};

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers/workspace" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

function xaiItem(
  authMode: "oauth" | "key",
  state: boolean | "mixed",
): WorkspaceItem {
  return {
    name: "xai",
    adapter: "openai-chat",
    baseUrl: "https://api.x.ai/v1",
    authMode,
    hasApiKey: authMode === "key",
    xaiResponsesOptInState: state,
  };
}

async function mount(
  item: WorkspaceItem,
  onUpdateProvider: (name: string, patch: ProviderUpdatePatch) => Promise<ProviderUpdateResult>,
) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={item}
          apiBase=""
          authHandlers={handlers}
          onUpdateProvider={onUpdateProvider}
        />
      </LanguageProvider>,
    );
  });
}

function optInSwitch(): HTMLButtonElement {
  const switches = container.querySelectorAll<HTMLButtonElement>(".pwi-auth-optin-row .switch");
  expect(switches).toHaveLength(1);
  return switches[0]!;
}

test("OAuth xAI renders one mixed switch and applies the PATCH echoed effective state", async () => {
  const patches: Array<{ name: string; patch: ProviderUpdatePatch }> = [];
  await mount(xaiItem("oauth", "mixed"), async (name, patch) => {
    patches.push({ name, patch });
    return { ok: true, xaiResponsesOptInState: true };
  });

  expect(container.textContent).toContain("Available accounts");
  expect(container.textContent).toContain("Use Responses API for Grok 4.5 and 4.6");
  expect(container.textContent).toContain("Partially enabled.");
  expect(optInSwitch().getAttribute("aria-pressed")).toBe("mixed");
  expect(optInSwitch().classList.contains("mixed")).toBe(true);

  await act(async () => { optInSwitch().click(); });

  expect(patches).toEqual([{ name: "xai", patch: { xaiResponsesOptIn: true } }]);
  expect(optInSwitch().getAttribute("aria-pressed")).toBe("true");
  expect(optInSwitch().classList.contains("mixed")).toBe(false);
});

test("API-key xAI renders the same single Responses opt-in switch", async () => {
  await mount(xaiItem("key", false), async () => ({
    ok: true,
    xaiResponsesOptInState: true,
  }));

  expect(container.textContent).toContain("API Keys");
  expect(container.textContent).toContain("Use Responses API for Grok 4.5 and 4.6");
  expect(optInSwitch().getAttribute("aria-pressed")).toBe("false");
});
