import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useRef } from "react";
import type { Root } from "react-dom/client";
import { configureApiTargets } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";
import { useProviderAccountPools } from "../src/hooks/useProviderAccountPools";
import * as dialogs from "../src/action-dialogs";
import { useProvidersOAuth } from "../src/pages/use-providers-oauth";
import { useAddProviderOAuth } from "../src/components/use-add-provider-oauth";
import { useKiroDeviceLogin } from "../src/components/use-kiro-device-login";
import { useCodexAutoSwitch } from "../src/hooks/useCodexAutoSwitch";
import { useCodexAccountPool } from "../src/hooks/useCodexAccountPool";
import AnthropicAccountPoolSettings from "../src/components/provider-workspace/AnthropicAccountPoolSettings";
import { LanguageProvider } from "../src/i18n/provider";

/**
 * A module target change that has not re-rendered a surface must not retarget its next
 * action. Every capture owner is exercised here with the same shape: render on A,
 * configure B without a re-render, invoke, and require zero requests.
 */

const globals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let root: Root | null = null;
let pools: ReturnType<typeof useProviderAccountPools>;
let calls: string[];

function relay(apiBase: string, origin: string) {
  const base = standaloneApiTargets(apiBase);
  return {
    ...base,
    connected: true,
    shared: { ...base.shared, baseUrl: apiBase, serverOrigin: origin, transport: "relay" as const },
    apiKeyId: "fixture-key",
    relayTargetCheck: "expected-target-v1" as const,
  };
}

function Harness({ base, target }: { base: string; target: string }) {
  const aliveRef = useRef(true);
  const controller = useProviderAccountPools({
    apiBase: base, targetKey: target, config: null, aliveRef, t: key => key, oauthStatus: {},
    notify: () => {}, fetchConfig: async () => {}, fetchOauth: async () => {}, fetchProviderQuotas: async () => {},
    codexActiveNeedsReauth: false,
  });
  // Publish after commit: writing a hook result into a module binding during render is
  // what the compiler rejects, and the test body only reads it after act().
  useLayoutEffect(() => { pools = controller; });
  return null;
}

async function render(base: string, target: string): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  if (!root) {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => { root!.render(<Harness base={base} target={target} />); });
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  const win = new Window({ url: "http://localhost" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    fetch: { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return Response.json({});
    } },
  });
  calls = [];
  spyOn(dialogs, "confirmAction").mockResolvedValue(true);
  spyOn(dialogs, "requestTextValue").mockResolvedValue("alias");
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

type Action = { name: string; run: (p: ReturnType<typeof useProviderAccountPools>) => Promise<unknown> };

const actions: Action[] = [
  { name: "removeApiKey", run: p => p.removeApiKey("p", { id: "k1", masked: "sk-1", active: false } as never) },
  { name: "addApiKeyValue", run: p => p.addApiKeyValue("p", "sk-new") },
  { name: "editCredentialAlias", run: p => p.editCredentialAlias("p", "api-key", "k1") },
  { name: "switchAccount", run: p => p.switchAccount("p", { id: "a1", active: false, paused: false } as never) },
  { name: "setAccountThreshold", run: p => p.setAccountThreshold("p", { id: "a1", active: false, paused: false } as never, 80) },
  { name: "pauseAccount", run: p => p.pauseAccount("p", { id: "a1", active: false, paused: false } as never, true) },
  { name: "switchApiKey", run: p => p.switchApiKey("p", { id: "k1", masked: "sk-1", active: false } as never) },
  { name: "removeAccount", run: p => p.removeAccount("p", { id: "a1", active: false, paused: false } as never) },
];

describe("provider account pool capture owners", () => {
  for (const action of actions) {
    test(`${action.name} sends on the current target`, async () => {
      configureApiTargets(relay("/same", "hub-a"));
      await render("/same", "hub-a");
      await act(async () => { await action.run(pools); });
      expect(calls.length).toBeGreaterThan(0);
    });

    test(`${action.name} is refused before fetch after a render gap`, async () => {
      configureApiTargets(relay("/same", "hub-a"));
      await render("/same", "hub-a");
      configureApiTargets(relay("/same", "hub-b"));
      await act(async () => { await action.run(pools); });
      expect(calls).toEqual([]);
    });
  }
});

describe("other capture owners", () => {
  test("OAuth login and logout are refused before fetch after a render gap", async () => {
    let actions!: ReturnType<typeof useProvidersOAuth>;
    function OAuthHarness() {
      const aliveRef = useRef(true);
      const controller = useProvidersOAuth({
        apiBase: "/same", targetKey: "hub-a", t: key => key, aliveRef, accountSets: {}, setAccountSets: () => {},
        setBusy: () => {}, setStatus: () => {}, setLoginInfo: () => {}, setOauthStatus: () => {},
        notify: () => {}, fetchConfig: async () => {}, fetchOauth: async () => {}, fetchAccountSets: async () => {},
        fetchProviderQuotas: async () => {}, bumpModelsRefresh: () => {},
      });
      useLayoutEffect(() => { actions = controller; });
      return null;
    }
    configureApiTargets(relay("/same", "hub-a"));
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root!.render(<OAuthHarness />); });
    configureApiTargets(relay("/same", "hub-b"));
    await act(async () => { await actions.loginOAuth("anthropic"); });
    await act(async () => { await actions.logoutOAuth("anthropic"); });
    expect(calls).toEqual([]);
  });

  test("Add Provider OAuth login is refused before fetch after a render gap", async () => {
    let actions!: ReturnType<typeof useAddProviderOAuth>;
    function AddOAuthHarness() {
      const aliveRef = useRef(true);
      const controller = useAddProviderOAuth({
        apiBase: "/same", targetKey: "hub-a", t: key => key, aliveRef, onAdded: () => {},
      });
      useLayoutEffect(() => { actions = controller; });
      return null;
    }
    configureApiTargets(relay("/same", "hub-a"));
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root!.render(<AddOAuthHarness />); });
    configureApiTargets(relay("/same", "hub-b"));
    await act(async () => {
      await actions.loginOAuth("anthropic", {
        setOauthBusy: () => {}, setOauthMsg: () => {}, setOauthMsgTone: () => {}, setOauthUrl: () => {},
        setManualCode: () => {}, setManualCodeMsg: () => {}, setManualCodeOk: () => {},
      });
    });
    expect(calls).toEqual([]);
  });

  test("Kiro start is refused before fetch after a render gap", async () => {
    let login!: ReturnType<typeof useKiroDeviceLogin>;
    function KiroHarness() {
      const controller = useKiroDeviceLogin("/same", () => {}, undefined, "hub-a");
      useLayoutEffect(() => { login = controller; });
      return null;
    }
    configureApiTargets(relay("/same", "hub-a"));
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root!.render(<KiroHarness />); });
    configureApiTargets(relay("/same", "hub-b"));
    await act(async () => { await login.start("builder-id"); });
    expect(calls).toEqual([]);
  });

  test("the auto-switch save is refused before fetch after a render gap", async () => {
    let controller!: ReturnType<typeof useCodexAutoSwitch>;
    function AutoSwitchHarness() {
      const current = useCodexAutoSwitch("/same", { updated: "u", updateFailed: "f", invalid: "i" }, "hub-a");
      useLayoutEffect(() => { controller = current; });
      return null;
    }
    configureApiTargets(relay("/same", "hub-a"));
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root!.render(<AutoSwitchHarness />); });
    await act(async () => { controller.hydrateServerValue(80); });
    configureApiTargets(relay("/same", "hub-b"));
    await act(async () => { await controller.toggle(); });
    expect(calls).toEqual([]);
  });

  test("a Codex pool action is refused before fetch after a render gap", async () => {
    let controller!: ReturnType<typeof useCodexAccountPool>;
    function CodexHarness() {
      const current = useCodexAccountPool("/same", true, "hub-a");
      useLayoutEffect(() => { controller = current; });
      return null;
    }
    configureApiTargets(relay("/same", "hub-a"));
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root!.render(<CodexHarness />); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    calls = [];
    configureApiTargets(relay("/same", "hub-b"));
    await act(async () => { await controller.switchAccount("a2"); });
    expect(calls).toEqual([]);
  });

  test("the Anthropic pool save is refused before fetch after a render gap", async () => {
    configureApiTargets(relay("/same", "hub-a"));
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <LanguageProvider>
          <AnthropicAccountPoolSettings apiBase="/same" targetKey="hub-a" accountCount={2} />
        </LanguageProvider>,
      );
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    calls = [];
    configureApiTargets(relay("/same", "hub-b"));
    const toggle = host.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
    await act(async () => { toggle.click(); await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(calls).toEqual([]);
  });
});

