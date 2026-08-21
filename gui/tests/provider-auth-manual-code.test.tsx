import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import type { ProviderAuthHandlers } from "../src/components/provider-workspace/types";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let submit: (provider: string, input: string) => Promise<void>;
let rejection: unknown;

const item: WorkspaceItem = {
  name: "command-code",
  adapter: "command-code",
  baseUrl: "https://api.commandcode.ai",
  authMode: "oauth",
};

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  rejection = new Error("invalid authorization code");
  submit = mock(async () => {
    if (rejection) throw rejection;
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) { const current = root; await act(async () => { current.unmount(); }); root = null; }
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  await win.happyDOM?.close?.();
});

test("masks pasted Command Code credentials and preserves rejection feedback", async () => {
  // React DOM must bind to the happy-dom globals installed in beforeEach.
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={item}
          apiBase=""
          busy
          loginHint={{ provider: "command-code", url: "https://example.test/login" }}
          authHandlers={{
            onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {}, onRemoveAccount: () => {},
            onAddApiKey: async () => true, onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
            onSubmitManualCode: submit,
          }}
        />
      </LanguageProvider>,
    );
  });

  const input = host.querySelector('input[type="password"]') as HTMLInputElement;
  expect(input).toBeTruthy();
  expect(input.type).toBe("password");
  expect(input.maxLength).toBe(4096);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "user_secret");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  expect(input.value).toBe("user_secret");
  expect((host.querySelector(".pwi-auth-paste button") as HTMLButtonElement).disabled).toBe(false);
  await act(async () => {
    (host.querySelector(".pwi-auth-paste button") as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(submit).toHaveBeenCalledWith("command-code", "user_secret");
  expect(host.textContent).toContain("invalid authorization code");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("invalid authorization code");

  rejection = {};
  await act(async () => {
    (host.querySelector(".pwi-auth-paste button") as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(host.textContent).toContain("Could not submit code: Network error. Check that the proxy is running and try again.");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Network error");

  rejection = null;
  await act(async () => {
    (host.querySelector(".pwi-auth-paste button") as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Code submitted — finishing login…");

  // Ending the flow must clear the credential and its feedback even when the
  // provider panel remains mounted for the next Add account attempt.
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={item}
          apiBase=""
          busy={false}
          loginHint={null}
          authHandlers={{
            onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {}, onRemoveAccount: () => {},
            onAddApiKey: async () => true, onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
            onSubmitManualCode: submit,
          }}
        />
      </LanguageProvider>,
    );
  });
  expect(host.querySelector('input[type="password"]')).toBeNull();
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={item}
          apiBase=""
          busy
          loginHint={{ provider: "command-code", url: "https://example.test/login-2" }}
          authHandlers={{
            onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {}, onRemoveAccount: () => {},
            onAddApiKey: async () => true, onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
            onSubmitManualCode: submit,
          }}
        />
      </LanguageProvider>,
    );
  });
  expect((host.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
  expect(host.querySelector('[role="status"]')).toBeNull();
});

test("identifies Command Code manual auth from the provider contract", async () => {
  const { createRoot } = await import("react-dom/client");
  const aliasedItem: WorkspaceItem = { ...item, name: "command-code-work" };
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={aliasedItem}
          apiBase=""
          busy
          loginHint={{ provider: aliasedItem.name, url: "https://example.test/login" }}
          authHandlers={{
            onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {}, onRemoveAccount: () => {},
            onAddApiKey: async () => true, onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
            onSubmitManualCode: submit,
          }}
        />
      </LanguageProvider>,
    );
  });

  const input = host.querySelector('input[type="password"]') as HTMLInputElement;
  expect(input).toBeTruthy();
  expect(input.getAttribute("aria-label")).toContain("Command Code API key");
});

test("ignores completion from a stale manual-auth flow", async () => {
  const { createRoot } = await import("react-dom/client");
  let resolveSubmit!: () => void;
  const deferredSubmit = mock(() => new Promise<void>(resolve => { resolveSubmit = resolve; }));
  const handlers: ProviderAuthHandlers = {
    onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {}, onRemoveAccount: () => {},
    onAddApiKey: async () => true, onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
    onSubmitManualCode: deferredSubmit,
  };

  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={item}
          apiBase=""
          busy
          loginHint={{ provider: item.name, url: "https://example.test/login-a" }}
          authHandlers={handlers}
        />
      </LanguageProvider>,
    );
  });
  const input = host.querySelector('input[type="password"]') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "user_secret");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    (host.querySelector(".pwi-auth-paste button") as HTMLButtonElement).click();
  });
  expect(deferredSubmit).toHaveBeenCalledTimes(1);

  await act(async () => {
    root!.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={item}
          apiBase=""
          busy
          loginHint={{ provider: item.name, url: "https://example.test/login-b" }}
          authHandlers={handlers}
        />
      </LanguageProvider>,
    );
  });
  expect((host.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");

  await act(async () => {
    resolveSubmit();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect((host.querySelector(".pwi-auth-paste button") as HTMLButtonElement).disabled).toBe(true);
});
