import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import CodexAuth from "../src/pages/CodexAuth";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let previousFetch: typeof globalThis.fetch;
let testWindow: Window;
let root: Root | null = null;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  previousFetch = globalThis.fetch;
  testWindow = new Window({ url: "http://localhost/#codex-auth" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => { mounted.unmount(); });
    root = null;
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch });
  await testWindow.happyDOM?.close?.();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("rapid account-picker clicks serialize to one settings mutation", async () => {
  let settingsPuts = 0;
  let finishSettingsPut: (() => void) | undefined;
  globalThis.fetch = (async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "http://localhost");
    if (url.pathname === "/api/config") {
      return jsonResponse({
        codexAccountPickerEnabled: false,
        providers: { openai: { codexAccountMode: "pool" } },
      });
    }
    if (url.pathname === "/api/codex-auth/accounts") return jsonResponse({ accounts: [] });
    if (url.pathname === "/api/codex-auth/active") {
      return jsonResponse({ activeCodexAccountId: null, autoSwitchThreshold: 80 });
    }
    if (url.pathname === "/api/settings" && init?.method === "PUT") {
      settingsPuts += 1;
      return new Promise<Response>(resolve => {
        finishSettingsPut = () => resolve(jsonResponse({ codexAccountPickerEnabled: true }));
      });
    }
    return jsonResponse({});
  }) as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <CodexAuth apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });

  const toggle = host.querySelector('button[aria-pressed="false"]') as HTMLButtonElement | null;
  expect(toggle).not.toBeNull();
  act(() => {
    toggle!.click();
    toggle!.click();
  });

  expect(settingsPuts).toBe(1);
  expect(finishSettingsPut).toBeFunction();
  await act(async () => {
    finishSettingsPut!();
    await Promise.resolve();
    await Promise.resolve();
  });
});
