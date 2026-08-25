import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import CodexAccountPool from "../src/components/CodexAccountPool";
import type { CodexAccountEntry, CodexAccountPoolController } from "../src/hooks/useCodexAccountPool";
import { en } from "../src/i18n/en";
import { LanguageProvider } from "../src/i18n/provider";

/**
 * Being routed to and being pinned are different states, and only the second one is
 * something the operator chose. The pin action was hidden on whichever card routing had
 * landed on, so once pool routing made an account effective-active with no pin, the one
 * card that could turn that transient choice into a pin was the one card that no longer
 * offered it (#2554). The rule is asserted against the mounted DOM: a JSX grep survives a
 * condition inversion, which is exactly the failure being fixed.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

const account: CodexAccountEntry = {
  id: "pool-1",
  email: "pool@example.test",
  logLabel: "pabc123",
  isMain: false,
  paused: false,
  priority: 0,
  hasCredential: true,
  quota: null,
};

const mainAccount: CodexAccountEntry = {
  id: "main",
  email: "main@example.test",
  isMain: true,
  paused: false,
  priority: 0,
  hasCredential: true,
  quota: null,
};

function makeController(overrides: Partial<CodexAccountPoolController> = {}): CodexAccountPoolController {
  return {
    accounts: [mainAccount, account],
    activeId: null,
    loadState: "ready",
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
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => Response.json({ accounts: [], activeCodexAccountId: null, autoSwitchThreshold: 80 }),
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

/** Each card is found by the email it prints, so neither card needs a test-only hook. */
function cardFor(email: string): Element {
  const card = [...host.querySelectorAll(".card")].find((el) => (el.textContent ?? "").includes(email));
  expect(card).toBeTruthy();
  return card!;
}

function hasPinAction(scope: ParentNode): boolean {
  return [...scope.querySelectorAll("button")].some(
    (el) => (el.textContent ?? "").trim() === en["codexAuth.setAsNext"],
  );
}

test("an active pool account with no pin can still be pinned (#2554)", async () => {
  await mountPool(makeController({ activeId: "pool-1", activePinnedId: null }));

  expect(hasPinAction(cardFor("pool@example.test"))).toBe(true);
});

test("an active app login with no pin can still be pinned (#2554)", async () => {
  await mountPool(makeController({ activeId: null, activePinnedId: null }));

  expect(hasPinAction(cardFor("main@example.test"))).toBe(true);
});

// Routing sits on this account while the operator's pin is on another one. Pinning here is
// exactly the correction the operator would want to make, so the action must be offered.
test("an active account whose sibling owns the pin can still be pinned", async () => {
  await mountPool(makeController({ activeId: "pool-1", activePinnedId: "__main__" }));

  expect(hasPinAction(cardFor("pool@example.test"))).toBe(true);
});

test("the account that already owns the pin is not offered the action again", async () => {
  await mountPool(makeController({ activeId: "pool-1", activePinnedId: "pool-1" }));

  expect(hasPinAction(cardFor("pool@example.test"))).toBe(false);
  // The sibling is neither active nor pinned, so it keeps the action.
  expect(hasPinAction(cardFor("main@example.test"))).toBe(true);
});

test("the app login that already owns the pin is not offered the action again", async () => {
  await mountPool(makeController({ activeId: null, activePinnedId: "__main__" }));

  expect(hasPinAction(cardFor("main@example.test"))).toBe(false);
});

// Pausing is the one state that genuinely rules the action out: a paused account is not a
// candidate to route to, so offering to pin it would promise something the pool cannot keep.
test("a paused account is not offered the action, pinned or not", async () => {
  const paused: CodexAccountEntry = { ...account, paused: true };
  await mountPool(makeController({ accounts: [mainAccount, paused], activeId: null, activePinnedId: null }));

  expect(hasPinAction(cardFor("pool@example.test"))).toBe(false);
});
