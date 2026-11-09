import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import type { ProviderAuthHandlers } from "../src/components/provider-workspace/types";
import { captureApiTarget, configureApiTargets } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
const originalFetch = globalThis.fetch;

const handlers: ProviderAuthHandlers = {
  onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {},
  onRemoveAccount: () => {}, onAddApiKey: async () => true, onSwitchApiKey: () => {},
  onRemoveApiKey: () => {}, onEditAlias: () => {}, onRetryAccounts: async () => {},
};

function item(name = "claude"): WorkspaceItem {
  return { name, adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" };
}

function relayTargets(origin: string) {
  const base = standaloneApiTargets("");
  return {
    ...base,
    connected: true,
    shared: { ...base.shared, baseUrl: "", serverOrigin: origin, transport: "relay" as const },
    apiKeyId: "fixture-key",
    relayTargetCheck: "expected-target-v1" as const,
  };
}

async function mountPanel(props: {
  item?: WorkspaceItem;
  loginCapture?: ReturnType<typeof captureApiTarget>;
  hint?: { provider: string; instructions?: string };
}) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root ??= createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={props.item ?? item()}
          apiBase=""
          busy
          accounts={[]}
          accountLoadState="ready"
          loginCapture={props.loginCapture}
          loginHint={props.hint ?? { provider: (props.item ?? item()).name, instructions: "Complete manual login" }}
          authHandlers={handlers}
        />
      </LanguageProvider>,
    );
  });
}

async function submitCode(code: string) {
  const input = host.querySelector<HTMLInputElement>(".login-hint-paste-input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, code);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  const submit = host.querySelector<HTMLButtonElement>(".login-hint-paste-row button")!;
  await act(async () => { submit.click(); await Promise.resolve(); });
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://127.0.0.1:4800/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  for (const [key, value] of Object.entries({ document: win.document, window: win, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  host = win.document.createElement("div");
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  globalThis.fetch = originalFetch;
  win.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
});

test("manual code uses the original login capture", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => { calls.push(String(input)); return Response.json({ ok: true }); }) as typeof fetch;
  configureApiTargets(standaloneApiTargets(""));
  const capture = captureApiTarget("shared");
  await mountPanel({ loginCapture: capture });
  await submitCode("code-1");
  expect(calls).toEqual(["/api/oauth/login/code"]);
});

test("manual code without a login capture refuses instead of using the current target", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return Response.json({ ok: true }); }) as typeof fetch;
  configureApiTargets(standaloneApiTargets(""));
  await mountPanel({});
  await submitCode("code-1");
  expect(calls).toBe(0);
  expect(host.textContent).toContain("The dashboard target changed");
});

test("an A code cannot be posted to B after a same-base target change", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return Response.json({ ok: true }); }) as typeof fetch;
  configureApiTargets(standaloneApiTargets(""));
  const capture = captureApiTarget("shared");
  await mountPanel({ loginCapture: capture });
  configureApiTargets(relayTargets("https://hub-b.example"));
  await submitCode("A-code");
  expect(calls).toBe(0);
});

test("a cockpit import opened on A cannot post its document to B", async () => {
  let posts = 0;
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") posts += 1;
    return Response.json({ importedCount: 1, updatedCount: 0, failedCount: 0, unsupportedCount: 0 });
  }) as typeof fetch;
  configureApiTargets(standaloneApiTargets(""));
  await mountPanel({ item: item("google-antigravity") });
  let releaseText!: (text: string) => void;
  const file = {
    name: "cockpit.json",
    size: 16,
    text: () => new Promise<string>(resolve => { releaseText = resolve; }),
  } as unknown as File;
  const input = host.querySelector<HTMLInputElement>("#cockpit-import-file")!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new win.Event("change", { bubbles: true })); });
  configureApiTargets(relayTargets("https://hub-b.example"));
  await act(async () => { releaseText(JSON.stringify({ accounts: [] })); await Promise.resolve(); });
  expect(posts).toBe(0);
});
