import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import CodexAccountPool from "../src/components/CodexAccountPool";
import type { CodexAccountEntry, CodexAccountPoolController } from "../src/hooks/useCodexAccountPool";
import { LanguageProvider } from "../src/i18n/provider";

/**
 * Stale toastError must not paint a successful redeem as notice-err (PR #475).
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let originalConfirm: typeof window.confirm;

const account: CodexAccountEntry = {
  id: "pool-1",
  email: "pool@example.test",
  isMain: false,
  paused: false,
  hasCredential: true,
  quota: { resetCredits: 2, updatedAt: 1 },
};

function makeController(overrides: Partial<CodexAccountPoolController> = {}): CodexAccountPoolController {
  return {
    accounts: [
      { id: "main", email: "main@example.test", isMain: true, paused: false, hasCredential: true, quota: null },
      account,
    ],
    activeId: null,
    loadState: "ready",
    switchingId: null,
    pauseUpdatingId: null,
    pausingExhausted: false,
    activeNeedsReauth: false,
    load: async () => true,
    switchAccount: async () => ({ ok: true, activeId: null }),
    setAccountPaused: async () => ({ ok: true }),
    pauseExhaustedAccounts: async () => ({ ok: true, pausedCount: 0 }),
    saveAlias: async () => ({ ok: true }),
    removeAccount: async () => ({ ok: false, reason: "request" }),
    syncAfterAccountAdded: async () => ({ ok: true }),
    pauseRefresh: () => ({ __brand: "codex-pool-pause" }) as never,
    resumeRefresh: () => {},
    subscribeLoadObserver: () => () => {},
    readLastThreshold: () => undefined,
    ...overrides,
  };
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
  originalConfirm = window.confirm;
  window.confirm = () => true;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/codex-auth/reset-credits" && !url.pathname.endsWith("/consume")) {
        return Response.json({ credits: [] });
      }
      if (url.pathname === "/api/codex-auth/reset-credits/consume" && (init?.method ?? "GET") === "POST") {
        return Response.json({ code: "already_redeemed", remaining: 2 });
      }
      if (url.pathname.startsWith("/api/codex-auth/")) {
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
    await act(async () => { current.unmount(); });
    root = null;
  }
  window.confirm = originalConfirm;
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

async function mountPool(controller: CodexAccountPoolController) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <CodexAccountPool apiBase="" controller={controller} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

test("successful redeem clears a stale error toast tone", async () => {
  await mountPool(makeController());

  // Seed toastError=true via a failed remove.
  const removeBtn = [...host.querySelectorAll("button")].find((btn) =>
    (btn.getAttribute("aria-label") ?? "").includes("pool@example.test")
    && (btn.getAttribute("aria-label") ?? "").toLowerCase().includes("remove"),
  );
  expect(removeBtn).toBeTruthy();
  await act(async () => { removeBtn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  const errNotice = host.querySelector(".codex-auth-page-head__feedback.is-err");
  expect(errNotice).toBeTruthy();

  const resetBtn = host.querySelector('button[aria-label="2 reset credit(s)"]') as HTMLButtonElement | null;
  expect(resetBtn).toBeTruthy();
  await act(async () => { resetBtn!.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

  const useCredit = [...host.querySelectorAll("button")].find((btn) =>
    (btn.textContent ?? "").includes("Use 1 Credit"),
  );
  expect(useCredit).toBeTruthy();
  await act(async () => { useCredit!.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  const confirmReset = [...host.querySelectorAll("button")].find((btn) => {
    const text = (btn.textContent ?? "").trim();
    return text === "Use Credit" || text.startsWith("Resetting");
  });
  expect(confirmReset).toBeTruthy();
  await act(async () => { confirmReset!.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

  expect(host.querySelector(".codex-auth-page-head__feedback.is-err")).toBeNull();
  expect(host.querySelector(".codex-auth-page-head__feedback.is-ok")).toBeTruthy();
});
