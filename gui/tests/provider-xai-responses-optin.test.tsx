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
    return { ok: true, xaiResponsesOptInState: false };
  });

  expect(container.textContent).toContain("Available accounts");
  expect(container.textContent).toContain("Use Chat Completions for Grok 4.5 and 4.6");
  expect(container.textContent).toContain("Only one model uses Chat.");
  expect(optInSwitch().getAttribute("aria-pressed")).toBe("mixed");
  expect(optInSwitch().classList.contains("mixed")).toBe(true);

  await act(async () => { optInSwitch().click(); });

  expect(patches).toEqual([{ name: "xai", patch: { xaiResponsesOptIn: false } }]);
  expect(optInSwitch().getAttribute("aria-pressed")).toBe("true");
  expect(optInSwitch().classList.contains("mixed")).toBe(false);
});

test("API-key xAI shows the effective Chat default as checked", async () => {
  await mount(xaiItem("key", false), async () => ({
    ok: true,
    xaiResponsesOptInState: true,
  }));

  expect(container.textContent).toContain("API Keys");
  expect(container.textContent).toContain("Use Chat Completions for Grok 4.5 and 4.6");
  expect(optInSwitch().getAttribute("aria-pressed")).toBe("true");
});

test("OAuth default is unchecked and Chat can be enabled and disabled", async () => {
  const patches: ProviderUpdatePatch[] = [];
  await mount(xaiItem("oauth", true), async (_name, patch) => {
    patches.push(patch);
    return { ok: true, xaiResponsesOptInState: patch.xaiResponsesOptIn };
  });
  expect(optInSwitch().getAttribute("aria-pressed")).toBe("false");
  await act(async () => { optInSwitch().click(); });
  expect(optInSwitch().getAttribute("aria-pressed")).toBe("true");
  await act(async () => { optInSwitch().click(); });
  expect(optInSwitch().getAttribute("aria-pressed")).toBe("false");
  expect(patches).toEqual([{ xaiResponsesOptIn: false }, { xaiResponsesOptIn: true }]);
});

test("failed Chat selection keeps the previous wire and displays the error", async () => {
  await mount(xaiItem("oauth", true), async () => ({ ok: false, error: "Save rejected" }));
  await act(async () => { optInSwitch().click(); });
  expect(optInSwitch().getAttribute("aria-pressed")).toBe("false");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Save rejected");
  expect(optInSwitch().disabled).toBe(false);
});

test("pending selection disables repeat writes and uses the server echo", async () => {
  let settle!: (value: ProviderUpdateResult) => void;
  let calls = 0;
  await mount(xaiItem("oauth", true), () => {
    calls++;
    return new Promise(resolve => { settle = resolve; });
  });
  await act(async () => { optInSwitch().click(); });
  expect(optInSwitch().disabled).toBe(true);
  await act(async () => { optInSwitch().click(); });
  expect(calls).toBe(1);
  await act(async () => { settle({ ok: true, xaiResponsesOptInState: "mixed" }); });
  expect(optInSwitch().getAttribute("aria-pressed")).toBe("mixed");
  expect(optInSwitch().disabled).toBe(false);
});
