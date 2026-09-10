import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { CodexAccountPoolMainCard } from "../src/components/codex-account-pool-main-card";
import { useMainDeviceReauth, type MainDeviceReauthState } from "../src/components/use-main-device-reauth";
import type { CodexAccountEntry } from "../src/components/codex-account-pool-types";

/**
 * #3898 L3: the main card gets a device-code Re-login that drives ONLY the
 * dedicated native-main namespace. Pool Add/Re-login and the native profile
 * picker stay on their own paths.
 */

const DEVICE_URL = "https://auth.openai.com/codex/device";
const DEVICE_CODE = "ABCD-1234";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let requests: Array<{ method: string; url: string }>;

const t = ((key: string) => key) as never;

function reauthMain(): CodexAccountEntry {
  return { id: "__main__", isMain: true, needsReauth: true } as unknown as CodexAccountEntry;
}

function cardProps(state: MainDeviceReauthState, calls: { starts: number; cancels: number }) {
  return {
    t,
    main: reauthMain(),
    isMainActive: false,
    accountModeState: null,
    threshold: 80,
    switchActionLabel: "Switch",
    onSwitch: () => {},
    onTogglePause: () => {},
    pauseUpdatingId: null,
    pauseBusy: false,
    onPriorityChange: () => {},
    priorityUpdatingId: null,
    switchingId: null,
    mainReauth: {
      state,
      start: async () => { calls.starts += 1; },
      cancel: async () => { calls.cancels += 1; },
    },
  } as never;
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  originalFetch = globalThis.fetch;
  requests = [];
  host = win.document.createElement("div");
  win.document.body.appendChild(host);
});

afterEach(async () => {
  if (root) { const r = root; root = null; await act(async () => r.unmount()); }
  host.remove();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  for (const k of globals) Object.defineProperty(globalThis, k, { configurable: true, value: previous[k] });
});

async function mount(ui: Parameters<typeof cardProps>[1], state: MainDeviceReauthState): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  const { createElement } = await import("react");
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(LanguageProvider, null, createElement(CodexAccountPoolMainCard, cardProps(state, ui))));
  });
}

test("expired main card shows the device Re-login CTA and starts the flow", async () => {
  const calls = { starts: 0, cancels: 0 };
  await mount(calls, { phase: "idle" });
  // The pause control ships the same class and renders first, so select the CTA by its
  // label the way the cancel test below already does.
  const actions = Array.from(host.querySelectorAll("button.codex-auth-action-btn"));
  const button = actions.find(b => b.textContent?.includes("mainReauthDevice"));
  expect(button).toBeDefined();
  expect(host.textContent).toContain("codexAuth.mainTokenExpired");
  expect(host.textContent).toContain("codexAuth.mainReauthDevice");
  await act(async () => { (button as HTMLButtonElement).click(); });
  expect(calls.starts).toBe(1);
  expect(calls.cancels).toBe(0);
});

test("a pending flow shows the URL and human code and cancel owns the flow", async () => {
  const calls = { starts: 0, cancels: 0 };
  await mount(calls, { phase: "pending", flowId: "f1", verificationUrl: DEVICE_URL, deviceCode: DEVICE_CODE });
  expect(host.textContent).toContain(DEVICE_URL);
  expect(host.textContent).toContain(DEVICE_CODE);
  const buttons = Array.from(host.querySelectorAll("button.codex-auth-action-btn"));
  const cancel = buttons.find(b => b.textContent?.includes("mainReauthCancel"));
  expect(cancel).toBeDefined();
  await act(async () => { (cancel as HTMLButtonElement).click(); });
  expect(calls.cancels).toBe(1);
});

test("the hook POSTs an empty body to the dedicated route and polls to success", async () => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ method: init?.method ?? "GET", url });
      if (url.endsWith("/api/codex-auth/main/reauth-device") && init?.method === "POST") {
        expect(init?.body).toBeUndefined();
        return Response.json({ flowId: "f1", status: "pending", verificationUrl: "", deviceCode: "" });
      }
      if (url.includes("/api/codex-auth/main/reauth-device?flowId=") && init?.method !== "DELETE") {
        return Response.json({ flowId: "f1", status: "pending", verificationUrl: DEVICE_URL, deviceCode: DEVICE_CODE });
      }
      return Response.json({ flowId: "f1", status: "cancelled" });
    },
  });
  let completed = 0;
  let captured: { state: MainDeviceReauthState; start: () => Promise<void>; cancel: () => Promise<void> } | null = null;
  const Probe = () => {
    const value = useMainDeviceReauth("", () => { completed += 1; });
    // Publish from an effect, not during render: assigning an outer binding while
    // rendering is exactly what the React compiler rejects. act() flushes effects,
    // so every assertion below still reads the latest committed value.
    useEffect(() => { captured = value; });
    return null;
  };
  const { createRoot } = await import("react-dom/client");
  const { createElement } = await import("react");
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(LanguageProvider, null, createElement(Probe)));
  });
  expect(captured).not.toBeNull();
  // start() owns the flow until a terminal status, and this mock stays pending forever,
  // so drive it and wait for the first poll to land instead of awaiting completion.
  await act(async () => {
    void captured!.start();
    const deadline = Date.now() + 2000;
    while (captured!.state.phase !== "pending" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  });
  expect(requests[0]).toEqual({ method: "POST", url: "/api/codex-auth/main/reauth-device" });
  expect(JSON.stringify(requests)).not.toContain("/api/codex-auth/login");
  const state = captured!.state;
  expect(state.phase).toBe("pending");
  if (state.phase === "pending") {
    expect(state.verificationUrl).toBe(DEVICE_URL);
    expect(state.deviceCode).toBe(DEVICE_CODE);
  }
  await act(async () => { await captured!.cancel(); });
  expect(captured!.state.phase).toBe("cancelled");
  expect(requests.some(r => r.method === "DELETE")).toBe(true);
});
