import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import CodexAccountPool from "../src/components/CodexAccountPool";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { useCodexAccountPool, type CodexAccountEntry, type CodexAccountPoolController } from "../src/hooks/useCodexAccountPool";
import { en } from "../src/i18n/en";
import { LanguageProvider } from "../src/i18n/provider";

/**
 * #5261: a failed account refresh used to leave the roster looking current.
 *
 * Keeping the rows is deliberate — blanking a populated pool on a soft poll miss is its own
 * defect — but the controller also went on reporting `ready`, so nothing distinguished a list
 * the server had just confirmed from one that predated a failure. The case that surfaced it:
 * add an account, the read that would bring it over fails, and the dashboard shows the older
 * accounts with the new one simply absent.
 *
 * Both halves are held here because either alone is satisfiable without the other: a flag the
 * surface never reads changes nothing a user sees, and a banner with no flag behind it never
 * appears.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let accountsOk = true;
let serverAccounts: unknown[] = [];
let baseCounter = 0;
let activeResponseGate: Promise<void> | null = null;

function row(id: string, email: string, isMain = false) {
  return { id, email, isMain, paused: false, priority: 0, hasCredential: true, quota: null };
}

const mainAccount: CodexAccountEntry = {
  id: "main",
  email: "main@example.test",
  isMain: true,
  paused: false,
  priority: 0,
  hasCredential: true,
  quota: null,
  quotaAutoRefresh: {
    fiveHourAvailable: false,
    weeklyAvailable: false,
    fiveHourEnabled: false,
    weeklyEnabled: false,
  },
};

function makeController(overrides: Partial<CodexAccountPoolController> = {}): CodexAccountPoolController {
  return {
    accounts: [mainAccount],
    activeId: null,
    loadState: "ready",
    refreshing: false,
    refreshFailed: false,
    initialLoading: false,
    switchingId: null,
    pauseUpdatingId: null,
    priorityUpdatingId: null,
    pausingExhausted: false,
    activeNeedsReauth: false,
    activePinnedId: null,
    load: async () => true,
    switchAccount: async () => ({ ok: true, activeId: null }),
    setAccountPaused: async () => ({ ok: true }),
    setAccountPriority: async () => ({ ok: true }),
    pauseExhaustedAccounts: async () => ({ ok: true, pausedCount: 0 }),
    saveAlias: async () => ({ ok: true }),
    removeAccount: async () => ({ ok: true }),
    syncAfterAccountAdded: async () => ({ ok: true }),
    pauseRefresh: () => ({ __brand: "codex-pool-pause" }) as never,
    resumeRefresh: () => {},
    subscribeLoadObserver: () => () => {},
    readLastThreshold: () => undefined,
    readLastActive: () => undefined,
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
  accountsOk = true;
  activeResponseGate = null;
  serverAccounts = [row("a1", "account-one", true)];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      const path = String(url).split("/api/")[1] ?? String(url);
      if (path.startsWith("usage?")) {
        return { ok: true, json: async () => ({ accounts: [] }) } as unknown as Response;
      }
      if (path.startsWith("codex-auth/accounts")) {
        if (!accountsOk) return { ok: false, status: 503 } as unknown as Response;
        return { ok: true, json: async () => ({ accounts: serverAccounts }) } as unknown as Response;
      }
      if (path.startsWith("codex-auth/active")) {
        const gate = activeResponseGate;
        activeResponseGate = null;
        if (gate) await gate;
        return {
          ok: true,
          json: async () => ({ activeCodexAccountId: null, autoSwitchThreshold: 80 }),
        } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
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
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  clearClientResourceStoresForTests();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

/** A fresh apiBase each time: the controller's last-good snapshot is keyed by it. */
async function mountController() {
  baseCounter += 1;
  const apiBase = `stale-${Date.now()}-${baseCounter}`;
  const seen: { current: CodexAccountPoolController | null } = { current: null };
  function Probe() {
    seen.current = useCodexAccountPool(apiBase, true);
    return null;
  }
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<Probe />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return seen;
}

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

function staleBanner(): Element | null {
  return host.querySelector(".pwi-auth-state--stale");
}

test("a failed refresh keeps the rows and stops reporting them as current", async () => {
  const seen = await mountController();
  expect(seen.current!.loadState).toBe("ready");
  expect(seen.current!.refreshFailed).toBe(false);
  expect(seen.current!.accounts.map(a => a.id)).toEqual(["a1"]);

  // The server now has an account this client has never seen, and the read that would have
  // brought it over fails. This is the reported shape of the defect, not a synthetic one.
  serverAccounts = [row("a1", "account-one", true), row("a2", "account-two")];
  accountsOk = false;
  await act(async () => { await seen.current!.load(); });

  expect(seen.current!.refreshFailed).toBe(true);
  // Still ready, and still holding the rows: blanking a populated pool on a miss is its own
  // defect, so the fix is that the surface now has something to say, not that it shows less.
  expect(seen.current!.loadState).toBe("ready");
  expect(seen.current!.accounts.map(a => a.id)).toEqual(["a1"]);

  accountsOk = true;
  await act(async () => { await seen.current!.load(); });

  expect(seen.current!.refreshFailed).toBe(false);
  expect(seen.current!.accounts.map(a => a.id)).toEqual(["a1", "a2"]);
});

test("the banner clears with the rows it qualifies, not with the whole load", async () => {
  // The rows are painted the moment /accounts returns, while /active can still be running on
  // its own much longer budget. Clearing the flag at the settle instead would leave the rows
  // that just replaced the stale ones labelled as the stale ones for that whole window.
  const seen = await mountController();

  accountsOk = false;
  await act(async () => { await seen.current!.load(); });
  expect(seen.current!.refreshFailed).toBe(true);

  accountsOk = true;
  serverAccounts = [row("a1", "account-one", true), row("a2", "account-two")];
  let releaseActive!: () => void;
  activeResponseGate = new Promise<void>(resolve => { releaseActive = resolve; });

  let pending: Promise<boolean>;
  await act(async () => {
    pending = seen.current!.load();
    await new Promise((r) => setTimeout(r, 10));
  });

  // /accounts has landed; /active has not.
  expect(seen.current!.accounts.map(a => a.id)).toEqual(["a1", "a2"]);
  expect(seen.current!.refreshFailed).toBe(false);

  await act(async () => { releaseActive(); await pending!; });
  expect(seen.current!.refreshFailed).toBe(false);
});

test("a cold failure still replaces the surface rather than annotating an empty one", async () => {
  // Non-regression: the cold path is unchanged, and this holds it there now that a second
  // failure signal exists that must not take it over.
  accountsOk = false;
  const seen = await mountController();

  expect(seen.current!.loadState).toBe("error");
  expect(seen.current!.accounts).toEqual([]);
});

test("the roster says so on screen when the rows it shows are the pre-refresh ones", async () => {
  await mountPool(makeController({ refreshFailed: true }));

  const banner = staleBanner();
  expect(banner).not.toBeNull();
  expect(banner!.textContent).toContain(en["codexAuth.accountsRefreshFailed"]);
  // Non-destructive: the accounts it is qualifying are still rendered underneath it.
  expect(host.textContent).toContain("main@example.test");
});

test("a roster whose refresh succeeded carries no banner", async () => {
  // Non-regression: passes before this change too, and is here so the new banner cannot start
  // appearing over a roster the server has just confirmed.
  await mountPool(makeController({ refreshFailed: false }));

  expect(staleBanner()).toBeNull();
});

test("a cold failure shows its own error instead of the stale banner", async () => {
  // Precedence, not regression: nothing survived to qualify, so the banner would be describing
  // an empty list. The cold error has to win even though both conditions hold.
  await mountPool(makeController({ accounts: [], loadState: "error", refreshFailed: true }));

  expect(staleBanner()).toBeNull();
  expect(host.textContent).toContain(en["codexAuth.loadFailed"]);
});
