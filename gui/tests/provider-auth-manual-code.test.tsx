import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import type { ProviderAuthHandlers } from "../src/components/provider-workspace/types";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import type { TFn } from "../src/i18n/shared";
import { SafeManualCodeError, mapManualCodeApiErrorToKey, useProvidersOAuth } from "../src/pages/use-providers-oauth";
import type { OAuthHook } from "../src/pages/use-providers-oauth";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let submit: (provider: string, input: string) => Promise<"submitted" | "cancelled">;
let rejection: unknown;
let originalFetch: typeof globalThis.fetch;

const item: WorkspaceItem = {
  name: "command-code",
  adapter: "command-code",
  baseUrl: "https://api.commandcode.ai",
  authMode: "oauth",
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  rejection = new Error("invalid authorization code");
  submit = mock(async () => {
    if (rejection) throw rejection;
    return "submitted" as const;
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
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: originalFetch });
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
  const aliasedItem: WorkspaceItem = { ...item, name: "command-code-work" };
  const { createRoot } = await import("react-dom/client");
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
  let resolveSubmit!: () => void;
  const deferredSubmit = mock(() => new Promise<void>(resolve => { resolveSubmit = resolve; }));
  const handlers: ProviderAuthHandlers = {
    onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {}, onRemoveAccount: () => {},
    onAddApiKey: async () => true, onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
    onSubmitManualCode: deferredSubmit,
  };

  const { createRoot } = await import("react-dom/client");
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
test("instructions-only change resets manual-auth input and feedback", async () => {
  const handlers: ProviderAuthHandlers = {
    onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {}, onRemoveAccount: () => {},
    onAddApiKey: async () => true, onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
    onSubmitManualCode: submit,
  };
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={item}
          apiBase=""
          busy
          loginHint={{ provider: item.name, url: "https://example.test/login", instructions: "first" }}
          authHandlers={handlers}
        />
      </LanguageProvider>,
    );
  });
  const input = host.querySelector('input[type="password"]') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "user_secret_prev");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    (host.querySelector(".pwi-auth-paste button") as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 0));
  });
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  // Same URL/deviceCode, but instructions differ -> flow key must rotate and clear input + feedback.
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={item}
          apiBase=""
          busy
          loginHint={{ provider: item.name, url: "https://example.test/login", instructions: "second" }}
          authHandlers={handlers}
        />
      </LanguageProvider>,
    );
  });
  expect((host.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[role="status"]')).toBeNull();
});

test("attemptId rotation resets manual-auth input and ignores stale completion", async () => {
  let resolveSubmit!: () => void;
  const deferredSubmit = mock(() => new Promise<void>(r => { resolveSubmit = r; }));
  const handlers: ProviderAuthHandlers = {
    onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {}, onRemoveAccount: () => {},
    onAddApiKey: async () => true, onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
    onSubmitManualCode: deferredSubmit,
  };
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={item}
          apiBase=""
          busy
          loginHint={{ provider: item.name, url: "https://example.test/login", attemptId: "attempt-1" }}
          authHandlers={handlers}
        />
      </LanguageProvider>,
    );
  });
  const input = host.querySelector('input[type="password"]') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "user_secret_a");
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
          loginHint={{ provider: item.name, url: "https://example.test/login", attemptId: "attempt-2" }}
          authHandlers={handlers}
        />
      </LanguageProvider>,
    );
  });
  expect((host.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
  await act(async () => {
    resolveSubmit();
    await new Promise(r => setTimeout(r, 0));
  });
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
test("cancelled manual submit does not render success on same flow", async () => {
  const submitCancelled = mock(async () => "cancelled" as const);
  const handlers: ProviderAuthHandlers = {
    onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {}, onRemoveAccount: () => {},
    onAddApiKey: async () => true, onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
    onSubmitManualCode: submitCancelled,
  };

  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={item}
          apiBase=""
          busy
          loginHint={{ provider: item.name, url: "https://example.test/login-same", attemptId: "attempt-same" }}
          authHandlers={handlers}
        />
      </LanguageProvider>,
    );
  });

  const input = host.querySelector('input[type="password"]') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "user_secret_cancelled");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    (host.querySelector(".pwi-auth-paste button") as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 0));
  });
  // Hook returned "cancelled" (e.g. AbortError): panel must not show success nor busy lock.
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect((host.querySelector(".pwi-auth-paste button") as HTMLButtonElement).disabled).toBe(false);
  // Ensure a plain undefined/void outcome also does not trigger success (legacy compat: panel treats non-cancelled as success only when submitted).
  // Covered by earlier stale-completion test.
});
test("undefined/non-submitted outcome does not render success", async () => {
  const submitUndefined = async () => undefined as unknown as "submitted" | "cancelled";
  const handlers: ProviderAuthHandlers = {
    onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {}, onRemoveAccount: () => {},
    onAddApiKey: async () => true, onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
    onSubmitManualCode: submitUndefined as unknown as ProviderAuthHandlers["onSubmitManualCode"],
  };
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={item}
          apiBase=""
          busy
          loginHint={{ provider: item.name, url: "https://example.test/login-undef", attemptId: "attempt-undef" }}
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
    await new Promise(r => setTimeout(r, 0));
  });
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
test("cause-carrying fetch rejection is mapped to networkError — literal never reaches UI", async () => {
  // Simulate what useProvidersOAuth now does: a fetch rejection with cause must NOT leak its message.
  // The real hook would catch `new Error("ETIMEDOUT 1.2.3.4:443", { cause: new Error("ECONNREFUSED") })`
  // and rethrow as `prov.networkError` with the original as `cause`. The panel only sees the localized message.
  // We simulate the post-hook throw: it must be the localized network error, never the ETIMEDOUT literal.
  const rawFetchError = new Error("ETIMEDOUT 1.2.3.4:443", { cause: new Error("ECONNREFUSED inner") });
  // What the fixed hook throws for this raw error:
  const mapped = new Error("Network error. Check that the proxy is running and try again.", { cause: rawFetchError });
  const submitFromHook = mock(async () => {
    throw mapped;
  });
  const handlers: ProviderAuthHandlers = {
    onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {}, onRemoveAccount: () => {},
    onAddApiKey: async () => true, onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
    onSubmitManualCode: submitFromHook as unknown as ProviderAuthHandlers["onSubmitManualCode"],
  };
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={item}
          apiBase=""
          busy
          loginHint={{ provider: item.name, url: "https://example.test/login" }}
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
    await new Promise(r => setTimeout(r, 0));
  });
  const alert = host.querySelector('[role="alert"]')?.textContent ?? "";
  expect(alert).toContain("Network error");
  expect(alert).not.toContain("ETIMEDOUT");
  expect(alert).not.toContain("1.2.3.4");
  expect(alert).not.toContain("ECONNREFUSED");
});
function HookHarness({ apiBase, onReady }: { apiBase: string; onReady: (api: OAuthHook) => void }) {
  const aliveRef = { current: true } as React.MutableRefObject<boolean>;
  const t = ((key: string) => key) as unknown as TFn;
  const api = useProvidersOAuth({
    apiBase,
    t,
    aliveRef,
    accountSets: {},
    setAccountSets: () => {},
    setBusy: () => {},
    setStatus: () => {},
    setLoginInfo: () => {},
    setOauthStatus: () => {},
    notify: () => {},
    fetchConfig: async () => {},
    fetchOauth: async () => {},
    fetchAccountSets: async () => {},
    fetchProviderQuotas: async () => {},
    bumpModelsRefresh: () => {},
  });
  onReady(api);
  return null;
}

test("mapManualCodeApiErrorToKey covers all branches", () => {
  expect(mapManualCodeApiErrorToKey("empty code", 400)).toBe("prov.manualErrorEmpty");
  expect(mapManualCodeApiErrorToKey("code too large", 400)).toBe("prov.manualErrorTooLarge");
  expect(mapManualCodeApiErrorToKey("input too long", 400)).toBe("prov.manualErrorTooLarge");
  expect(mapManualCodeApiErrorToKey("", 413)).toBe("prov.manualErrorTooLarge");
  expect(mapManualCodeApiErrorToKey("no login in progress", 409)).toBe("prov.manualErrorNoLogin");
  expect(mapManualCodeApiErrorToKey("stale login attempt", 409)).toBe("prov.manualErrorStale");
  expect(mapManualCodeApiErrorToKey("no authorization code found in input", 409)).toBe("prov.manualErrorNoCode");
  expect(mapManualCodeApiErrorToKey("redirect URL is missing the state parameter", 409)).toBe(
    "prov.manualErrorMissingState",
  );
  expect(mapManualCodeApiErrorToKey("state mismatch \u2014 paste the redirect URL from THIS login attempt", 409)).toBe(
    "prov.manualErrorStateMismatch",
  );
  expect(mapManualCodeApiErrorToKey("unknown diagnostic", 500)).toBe("prov.networkError");
  expect(mapManualCodeApiErrorToKey("unknown diagnostic", 400)).toBe("prov.manualErrorInvalid");
});

test("hook: cause-carrying transport via real submitManualCode maps to networkError only", async () => {
  let hook: OAuthHook | null = null;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "stale login attempt" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <HookHarness apiBase="" onReady={api => { hook = api; }} />
      </LanguageProvider>,
    );
  });
  expect(hook).not.toBeNull();
  let threw: unknown = null;
  try {
    await hook!.submitManualCode("xai", "badcode");
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeInstanceOf(SafeManualCodeError);
  expect((threw as Error).message).toBe("prov.manualErrorStale");
  await act(async () => {
    root!.unmount();
  });
  root = null;

  const raw = new Error("ETIMEDOUT 1.2.3.4:443", { cause: new Error("ECONNREFUSED inner") });
  globalThis.fetch = (async () => {
    throw raw;
  }) as unknown as typeof fetch;
  hook = null;
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <HookHarness apiBase="" onReady={api => { hook = api; }} />
      </LanguageProvider>,
    );
  });
  threw = null;
  try {
    await hook!.submitManualCode("xai", "anything");
  } catch (e) {
    threw = e;
  }
  expect(threw).not.toBeInstanceOf(SafeManualCodeError);
  expect(threw instanceof Error && (threw as Error).message).toBe("prov.networkError");
  expect((threw as Error & { cause?: unknown }).cause).toBe(raw);
  expect((threw as Error).message).not.toContain("ETIMEDOUT");
  expect((threw as Error).message).not.toContain("1.2.3.4");
});
