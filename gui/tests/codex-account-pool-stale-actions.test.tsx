import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import CodexAccountPool from "../src/components/CodexAccountPool";
import { configureApiTargets } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";
import { LanguageProvider } from "../src/i18n/provider";
import * as dialogs from "../src/action-dialogs";

/**
 * An alias write or a removal that the server accepted on A must not report failure on B.
 * The controller returns { ok: false, reason: "stale" } once the capture moved, and the
 * surface must drop it silently, the way it already drops a stale pause or order write.
 * It must also not reload the new target's rows on the old write's behalf.
 */

const globals = ["document", "window", "navigator", "localStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let reads = 0;
let aliasWrites = 0;
let deleteWrites = 0;
let releaseAlias: (() => void) | null = null;
let releaseDelete: (() => void) | null = null;
let aliasGate: Promise<void> | null = null;
let deleteGate: Promise<void> | null = null;

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

function entry(id: string) {
  return {
    id,
    email: `${id}@example.test`,
    isMain: false,
    paused: false,
    priority: 0,
    autoSwitchThresholdOverride: null,
    hasCredential: true,
    // A quota keeps the pool's quota-fill timers quiet, so the read count is only the loads.
    quota: { weeklyPercent: 10, weeklyResetAt: Date.now() + 3_600_000 },
    quotaAutoRefresh: { fiveHourAvailable: false, weeklyAvailable: true, fiveHourEnabled: false, weeklyEnabled: false },
  };
}

async function mount(targetKey: string) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root ??= createRoot(host);
    root.render(
      <LanguageProvider>
        <CodexAccountPool apiBase="/same" targetKey={targetKey} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
}

const aliasButton = () => [...host.querySelectorAll("button")]
  .find(button => button.textContent?.trim() === "Edit alias");
const removeButton = () => host.querySelector<HTMLButtonElement>("button.acc-danger-btn");

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    HTMLElement: { configurable: true, value: win.HTMLElement },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  originalFetch = globalThis.fetch;
  reads = 0;
  aliasWrites = 0;
  deleteWrites = 0;
  releaseAlias = null;
  releaseDelete = null;
  aliasGate = null;
  deleteGate = null;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT" && url.includes("/api/codex-auth/accounts/alias")) {
        aliasWrites += 1;
        if (aliasGate) await aliasGate;
        return Response.json({});
      }
      if (method === "DELETE" && url.includes("/api/codex-auth/accounts")) {
        deleteWrites += 1;
        if (deleteGate) await deleteGate;
        return Response.json({});
      }
      if (method === "GET" && url.includes("/api/codex-auth/accounts")) {
        reads += 1;
        return Response.json({ accounts: [entry("a1")], activeAccountId: "a1" });
      }
      if (url.includes("/api/codex-auth/active")) {
        return Response.json({ activeCodexAccountId: "a1", pinnedAccountId: null });
      }
      if (url.includes("/api/usage")) return Response.json({ providers: [], models: [] });
      return Response.json({});
    },
  });
  spyOn(dialogs, "requestTextValue").mockResolvedValue("alias");
  spyOn(dialogs, "confirmAction").mockResolvedValue(true);
});

afterEach(async () => {
  if (root) {
    const current = root;
    root = null;
    await act(async () => { current.unmount(); });
  }
  configureApiTargets(standaloneApiTargets(""));
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM?.close?.();
});

test("an alias accepted on the old target does not toast a failure on the new one", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");

  aliasGate = new Promise<void>(resolve => { releaseAlias = resolve; });
  await act(async () => {
    aliasButton()?.click();
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  expect(aliasWrites).toBe(1);

  configureApiTargets(relay("/same", "hub-b"));
  await mount("hub-b");
  const readsBefore = reads;

  await act(async () => {
    releaseAlias?.();
    await new Promise(resolve => setTimeout(resolve, 40));
  });

  expect(host.textContent).not.toContain("Could not save alias");
  expect(host.textContent).not.toContain("Alias saved");
  expect(reads).toBe(readsBefore);
});

test("a removal accepted on the old target does not toast a failure on the new one", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await mount("hub-a");

  deleteGate = new Promise<void>(resolve => { releaseDelete = resolve; });
  await act(async () => {
    removeButton()?.click();
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  expect(deleteWrites).toBe(1);

  configureApiTargets(relay("/same", "hub-b"));
  await mount("hub-b");
  const readsBefore = reads;

  await act(async () => {
    releaseDelete?.();
    await new Promise(resolve => setTimeout(resolve, 40));
  });

  expect(host.textContent).not.toContain("could not be removed");
  expect(reads).toBe(readsBefore);
});
