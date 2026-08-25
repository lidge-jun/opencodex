import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import CodexAccountPool from "../src/components/CodexAccountPool";
import type { CodexAccountEntry, CodexAccountPoolController } from "../src/hooks/useCodexAccountPool";
import { en } from "../src/i18n/en";
import { LanguageProvider } from "../src/i18n/provider";

/**
 * The PINNED badge is a rendering rule, not a string: it belongs to the one card carrying
 * the pin — the account the operator chose — which is not always the card routing currently
 * sits on. Under round-robin and fill-first the pin caps selection at its own tier while the
 * cursor moves inside that tier, so keying the badge off the active card made it blink out
 * on a sibling's turn while the pin was still suppressing every higher tier. The sibling
 * .ts suite greps the JSX for it, which a markup refactor breaks and a logic inversion
 * survives, so the rule is pinned here against the mounted DOM instead.
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
  usage30d: {
    totalTokens: 1_500,
    estimatedCostUsd: 0.125,
    usageCoverageRatio: 0.75,
  },
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

function hasPinnedBadge(scope: ParentNode): boolean {
  return [...scope.querySelectorAll(".badge")].some((el) => (el.textContent ?? "").trim() === en["codexAuth.pinned"]);
}

function hasPinnedHint(scope: ParentNode): boolean {
  return [...scope.querySelectorAll(".card-sub")].some((el) => (el.textContent ?? "").trim() === en["codexAuth.pinnedHint"]);
}

function switchAction(scope: ParentNode): HTMLButtonElement | null {
  return scope.querySelector<HTMLButtonElement>("button.codex-account-switch");
}

test("a pinned pool account says so, and only on its own card", async () => {
  await mountPool(makeController({ activeId: "pool-1", activePinnedId: "pool-1" }));

  const pooled = cardFor("pool@example.test");
  expect(hasPinnedBadge(pooled)).toBe(true);
  expect(hasPinnedHint(pooled)).toBe(false);
  expect(switchAction(pooled)).toBeNull();

  const main = cardFor("main@example.test");
  expect(hasPinnedBadge(main)).toBe(false);
  expect(hasPinnedHint(main)).toBe(false);
});

test("a pinned app login says so, and only on its own card", async () => {
  await mountPool(makeController({ activeId: null, activePinnedId: "__main__" }));

  const main = cardFor("main@example.test");
  expect(hasPinnedBadge(main)).toBe(true);
  expect(hasPinnedHint(main)).toBe(false);
  expect(switchAction(main)).toBeNull();

  const pooled = cardFor("pool@example.test");
  expect(hasPinnedBadge(pooled)).toBe(false);
  expect(hasPinnedHint(pooled)).toBe(false);
});

// The case that made the badge worth keying off the pinned id: the pin caps the tier, the
// strategy cursor moves to a same-tier sibling, and the operator's choice is still the
// reason every higher tier is being skipped. A badge that followed the active card would
// vanish here and give no clue why the higher-order account is idle.
test("the badge stays on the pinned account when rotation moves off it", async () => {
  const sibling: CodexAccountEntry = { ...account, id: "pool-2", email: "sibling@example.test" };
  await mountPool(makeController({
    accounts: [mainAccount, account, sibling],
    activeId: "pool-2",
    activePinnedId: "pool-1",
  }));

  const pinned = cardFor("pool@example.test");
  expect(hasPinnedBadge(pinned)).toBe(true);
  expect(hasPinnedHint(pinned)).toBe(false);

  const active = cardFor("sibling@example.test");
  expect(hasPinnedBadge(active)).toBe(false);
  expect(hasPinnedHint(active)).toBe(false);
});

test("an account rotation picked carries no pin", async () => {
  await mountPool(makeController({ activeId: "pool-1", activePinnedId: null }));

  expect(hasPinnedBadge(host)).toBe(false);
  expect(hasPinnedHint(host)).toBe(false);
});

test("an active unpinned pool account keeps the manual pin action", async () => {
  await mountPool(makeController({ activeId: "pool-1", activePinnedId: null }));

  const action = switchAction(cardFor("pool@example.test"));
  expect(action).toBeTruthy();
  expect(action!.textContent).toContain(en["codexAuth.setAsNext"]);

  await act(async () => { action!.click(); });
  expect(host.querySelector("dialog")?.textContent).toContain("pool@example.test");
});

test("an active unpinned app login keeps the manual pin action", async () => {
  await mountPool(makeController({ activeId: null, activePinnedId: null }));

  const action = switchAction(cardFor("main@example.test"));
  expect(action).toBeTruthy();
  expect(action!.textContent).toContain(en["codexAuth.setAsNext"]);
});

test("an active account that already owns the pin hides the redundant action", async () => {
  await mountPool(makeController({ activeId: "pool-1", activePinnedId: "pool-1" }));

  expect(switchAction(cardFor("pool@example.test"))).toBeNull();
});

test("an active account can replace a sibling's pin", async () => {
  const sibling: CodexAccountEntry = { ...account, id: "pool-2", email: "sibling@example.test" };
  await mountPool(makeController({
    accounts: [mainAccount, account, sibling],
    activeId: "pool-2",
    activePinnedId: "pool-1",
  }));

  expect(switchAction(cardFor("sibling@example.test"))).toBeTruthy();
});

test("a paused account is never shown as pinned", async () => {
  // Pausing releases the pin server-side, so a pin that still names an excluded account is
  // a stale read. Routing cannot be sitting on it, so the card must not claim otherwise.
  await mountPool(makeController({
    accounts: [mainAccount, { ...account, paused: true }],
    activeId: "pool-1",
    activePinnedId: "pool-1",
  }));

  expect(hasPinnedBadge(host)).toBe(false);
  expect(hasPinnedHint(host)).toBe(false);
  expect(switchAction(cardFor("pool@example.test"))).toBeNull();
});

test("reauth and cooldown guards still hide the pin action", async () => {
  const needsReauth: CodexAccountEntry = { ...account, needsReauth: true };
  const coolingDown: CodexAccountEntry = {
    ...account,
    id: "pool-2",
    email: "cooldown@example.test",
    health: { status: "cooldown", reason: "rate_limit", until: "2099-01-01T00:00:00.000Z" },
  };
  await mountPool(makeController({
    accounts: [mainAccount, needsReauth, coolingDown],
    activeId: "pool-1",
    activePinnedId: null,
  }));

  expect(switchAction(cardFor("pool@example.test"))).toBeNull();
  expect(switchAction(cardFor("cooldown@example.test"))).toBeNull();
});

test("healthy account cards omit log-label and 30-day usage copy", async () => {
  await mountPool(makeController());

  const pooled = cardFor("pool@example.test");
  expect(pooled.textContent).not.toContain("Log label: pabc123");
  expect(pooled.textContent).not.toContain("Total tokens: 1.5k");
  expect(pooled.textContent).not.toContain("Estimated cost: ~$0.1250");
  expect(pooled.textContent).not.toContain("Measured: 75%");

  const main = cardFor("main@example.test");
  expect(main.textContent).not.toContain("Log label: main");
  expect(hasPinnedHint(main)).toBe(false);
});
