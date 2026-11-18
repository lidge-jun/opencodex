import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import CodexAccountPool from "../src/components/CodexAccountPool";
import type { CodexAccountEntry, CodexAccountPoolController } from "../src/hooks/useCodexAccountPool";
import { LanguageProvider } from "../src/i18n/provider";
import { configureApiTargets } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";

/**
 * The pool's quota-activation writes belong to the logical target that read the
 * settings. A relay keeps the same apiBase across a re-pair, so the render capture
 * must fence the PUT and the read-back, and a late answer must not apply to B.
 */

const globals = ["document", "window", "navigator", "localStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let writes: unknown[];
let putGate: Promise<void> | null;
let releasePut: (() => void) | null;

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

function entry(id: string, fiveHour: boolean, weekly: boolean): CodexAccountEntry {
  return {
    id,
    email: `${id}@example.test`,
    isMain: id === "__main__",
    paused: false,
    priority: 0,
    hasCredential: true,
    quota: null,
    quotaAutoRefresh: { fiveHourAvailable: fiveHour, weeklyAvailable: weekly, fiveHourEnabled: false, weeklyEnabled: false },
  } as CodexAccountEntry;
}

function controller(): CodexAccountPoolController {
  return {
    accounts: [entry("__main__", false, true), entry("both", true, true)],
    activeId: null,
    loadState: "ready",
    switchingId: null,
    pauseUpdatingId: null,
    priorityUpdatingId: null,
    autoSwitchUpdatingId: null,
    creditsAfterLimitUpdatingId: null,
    pausingExhausted: false,
    activeNeedsReauth: false,
    activePinnedId: null,
    refreshing: false,
    refreshFailed: false,
    initialLoading: false,
    load: async () => true,
    switchAccount: async () => ({ ok: true, activeId: null }),
    setAccountPaused: async () => ({ ok: true }),
    setAccountPriority: async () => ({ ok: true }),
    setAccountAutoSwitchThreshold: async () => ({ ok: true }),
    setAccountCreditsAfterLimit: async () => ({ ok: true }),
    setAllCreditsAfterLimit: async () => ({ ok: true }),
    pauseExhaustedAccounts: async () => ({ ok: true, pausedCount: 0 }),
    saveAlias: async () => ({ ok: true }),
    removeAccount: async () => ({ ok: false, reason: "request" }),
    syncAfterAccountAdded: async () => ({ ok: true }),
    pauseRefresh: () => ({ __brand: "codex-pool-pause" }) as never,
    resumeRefresh: () => {},
    subscribeLoadObserver: () => () => {},
    readLastThreshold: () => undefined,
    readLastActive: () => undefined,
  };
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    HTMLElement: { configurable: true, value: win.HTMLElement },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });
  writes = [];
  putGate = null;
  releasePut = null;
  originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/api/settings")) {
        if (init?.method === "PUT") {
          writes.push(JSON.parse(String(init.body)));
          if (putGate) await putGate;
          return Response.json({ codexQuotaAutoRefresh: {} });
        }
        return Response.json({ codexQuotaAutoRefresh: {} });
      }
      if (url.pathname.endsWith("/api/codex-auth/active")) {
        return Response.json({ activeCodexAccountId: null, pinnedAccountId: null });
      }
      if (url.pathname.startsWith("/same/api/codex-auth/")) {
        return Response.json({ accounts: [], activeCodexAccountId: null, autoSwitchThreshold: 80 });
      }
      return Response.json({});
    },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    root = null;
    await act(async () => { current.unmount(); });
  }
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  configureApiTargets(standaloneApiTargets(""));
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM?.close?.();
});

async function mount(targetKey: string): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    if (!root) root = createRoot(host);
    root.render(
      <LanguageProvider>
        <CodexAccountPool apiBase="/same" targetKey={targetKey} controller={controller()} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
}

async function openAdvanced(): Promise<void> {
  if (host.querySelector("#codex-quota-activation .toggle")) return;
  await act(async () => {
    host.querySelector<HTMLButtonElement>(".codex-auth-advanced__toggle")!.click();
    await new Promise(resolve => setTimeout(resolve, 20));
  });
}

const activationToggle = () => host.querySelector<HTMLButtonElement>("#codex-quota-activation .toggle")!;

test("a render gap refuses the quota activation PUT before fetch", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  await openAdvanced();
  expect(activationToggle().disabled).toBe(false);

  configureApiTargets(relay("/same", "hub-b"));
  await act(async () => {
    activationToggle().click();
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  expect(writes).toEqual([]);
});

test("a PUT answered after a target change is not applied to the new target", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");
  await openAdvanced();
  expect(activationToggle().disabled).toBe(false);

  putGate = new Promise<void>(resolve => { releasePut = resolve; });
  await act(async () => {
    activationToggle().click();
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  expect(writes).toHaveLength(1);

  configureApiTargets(relay("/same", "hub-b"));
  await mount("hub-b");
  await openAdvanced();
  await act(async () => {
    releasePut?.();
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  expect(writes).toHaveLength(1);
  expect(activationToggle().getAttribute("aria-pressed")).toBe("false");
  expect(host.textContent).not.toContain("Automatic window activation updated");
});
