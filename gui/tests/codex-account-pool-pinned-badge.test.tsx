import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import CodexAccountPool from "../src/components/CodexAccountPool";
import { useCodexAccountPool } from "../src/hooks/useCodexAccountPool";
import type {
  CodexAccountEntry,
  CodexAccountLoadObserver,
  CodexAccountPoolController,
} from "../src/hooks/useCodexAccountPool";
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
  autoSwitchThresholdOverride: null,
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
  autoSwitchThresholdOverride: null,
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
    autoSwitchUpdatingId: null,
    pausingExhausted: false,
    activeNeedsReauth: false,
    activePinnedId: null,
    load: async () => true,
    switchAccount: async () => ({ ok: true, activeId: null }),
    setAccountPaused: async () => ({ ok: true }),
    setAccountPriority: async () => ({ ok: true }),
    setAccountAutoSwitchThreshold: async () => ({ ok: true }),
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

test("account cards show custom threshold controls only when enabled", async () => {
  const inherited = {
    ...account,
    autoSwitchThresholdOverride: null,
  };
  const overridden = {
    ...account,
    id: "pool-2",
    email: "override@example.test",
    autoSwitchThresholdOverride: 70,
  };
  await mountPool(makeController({
    accounts: [
      { ...mainAccount, autoSwitchThresholdOverride: null },
      inherited,
      overridden,
    ],
    readLastThreshold: () => 95,
  }));

  const inheritedCard = cardFor("pool@example.test");
  expect(inheritedCard.textContent).toContain("Custom account threshold");
  expect(inheritedCard.textContent).not.toContain("Global 95%");
  expect(inheritedCard.querySelector('input[type="number"]')).toBeNull();
  const inheritedToggle = inheritedCard.querySelector<HTMLButtonElement>('button[aria-pressed="false"]');
  expect(inheritedToggle).not.toBeNull();
  expect(inheritedToggle!.disabled).toBe(false);

  const overrideCard = cardFor("override@example.test");
  expect(overrideCard.textContent).toContain("Custom account threshold");
  const input = overrideCard.querySelector<HTMLInputElement>(
    'input[aria-label="Usage threshold for override@example.test"]',
  );
  expect(input?.value).toBe("70");
  expect(overrideCard.querySelector('button[aria-pressed="true"]')).not.toBeNull();
});

test("custom account threshold uses only the custom number stepper", async () => {
  const style = win.document.createElement("style");
  style.textContent = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  win.document.head.appendChild(style);
  await mountPool(makeController({
    accounts: [{ ...account, autoSwitchThresholdOverride: 70 }],
    readLastThreshold: () => 95,
  }));

  const card = cardFor("pool@example.test");
  const input = card.querySelector<HTMLInputElement>('input[type="number"]');
  expect(input).not.toBeNull();
  expect(win.getComputedStyle(input!).appearance).toBe("textfield");
  expect(card.querySelectorAll(".ocx-stepper__btn")).toHaveLength(2);
});

test("a global threshold refresh preserves an in-progress custom account draft", async () => {
  const overridden = { ...account, autoSwitchThresholdOverride: 70 };
  let observer: CodexAccountLoadObserver | null = null;
  await mountPool(makeController({
    accounts: [overridden],
    readLastThreshold: () => 95,
    subscribeLoadObserver: (next) => {
      observer = next;
      return () => {};
    },
  }));
  const input = cardFor("pool@example.test").querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!
      .set!.call(input, "75");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });

  const startedRevision = observer!.beginActiveRead();
  await act(async () => {
    observer!.acceptActiveRead({ autoSwitchThreshold: 80 }, startedRevision);
  });

  expect(cardFor("pool@example.test").querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("75");
});

test("toggle-off wins over a pending edited-threshold blur", async () => {
  const writes: Array<number | null> = [];
  await mountPool(makeController({
    accounts: [{ ...account, autoSwitchThresholdOverride: 70 }],
    readLastThreshold: () => 95,
    setAccountAutoSwitchThreshold: async (_id, threshold) => {
      if (writes.length > 0) return { ok: false, reason: "busy" };
      writes.push(threshold);
      return await new Promise(() => {});
    },
  }));

  const card = cardFor("pool@example.test");
  const input = card.querySelector<HTMLInputElement>('input[type="number"]')!;
  const toggle = card.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')!;

  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!
      .set!.call(input, "75");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    toggle.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
    input.dispatchEvent(new win.FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    toggle.dispatchEvent(new win.Event("pointerup", { bubbles: true }));
    toggle.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });

  expect(writes).toEqual([null]);
});

test("account threshold override cannot persist the seed before global threshold hydration", async () => {
  let writes = 0;
  await mountPool(makeController({
    readLastThreshold: () => undefined,
    setAccountAutoSwitchThreshold: async () => {
      writes += 1;
      return { ok: true };
    },
  }));

  const inheritedCard = cardFor("pool@example.test");
  const toggle = inheritedCard.querySelector<HTMLButtonElement>('button[aria-pressed="false"]');
  expect(toggle).not.toBeNull();
  expect(toggle!.disabled).toBe(true);

  await act(async () => {
    toggle!.click();
    await Promise.resolve();
  });
  expect(writes).toBe(0);
});

// Keep the cards, pool and controller real. Only the HTTP boundary is replaced: writes
// remain pending until the test answers them, and subsequent reads return persisted data.
let thresholdHarnessId = 0;
async function mountThresholdPool(entry = account, initial: number | null = 50) {
  const apiBase = `/threshold-focus-${++thresholdHarnessId}`;
  let persisted = initial;
  let globalThreshold = 95;
  let controller: CodexAccountPoolController;
  const writes: Array<{ id: string; threshold: number | null }> = [];
  let respond: ((response: Response) => void) | undefined;
  let nextAccountsGate: Promise<void> | undefined;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      const path = String(url).split("/api/")[1];
      if (path === "codex-auth/auto-switch" && init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)));
        return new Promise<Response>((resolve) => { respond = resolve; });
      }
      if (path?.startsWith("codex-auth/accounts")) {
        // Capture when the request starts, not when its delayed response is released.
        const response = Response.json({ accounts: [{ ...entry, autoSwitchThresholdOverride: persisted }] });
        const gate = nextAccountsGate;
        nextAccountsGate = undefined;
        if (gate) await gate;
        return response;
      }
      if (path === "codex-auth/active") {
        return Response.json({ activeCodexAccountId: null, autoSwitchThreshold: globalThreshold, pinnedAccountId: null });
      }
      if (path?.startsWith("usage?")) return Response.json({ accounts: [] });
      if (path === "settings") return Response.json({ showCodexSparkQuota: false, codexQuotaAutoRefresh: {} });
      throw new Error(`Unexpected threshold test request: ${url}`);
    },
  });
  function Pool() {
    controller = useCodexAccountPool(apiBase);
    return <CodexAccountPool apiBase={apiBase} controller={controller} />;
  }
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><Pool /></LanguageProvider>);
  });
  const control = () => cardFor(entry.email).querySelector<HTMLElement>(".codex-account-auto-switch")!;
  return {
    writes,
    control,
    input: () => control().querySelector<HTMLInputElement>("input")!,
    toggle: () => control().querySelector<HTMLButtonElement>(".toggle")!,
    steppers: () => [...control().querySelectorAll<HTMLButtonElement>(".ocx-stepper__btn")],
    storedOverride: () => controller!.accounts.find(row => row.id === entry.id)!.autoSwitchThresholdOverride,
    async startSlowRefresh() {
      let release!: () => void;
      nextAccountsGate = new Promise<void>(resolve => { release = resolve; });
      let refresh!: Promise<boolean>;
      await act(async () => { refresh = controller!.load(); });
      expect(nextAccountsGate).toBeUndefined();
      return async () => {
        await act(async () => { release(); await refresh; });
      };
    },
    async settle(ok = true, stored = writes.at(-1)!.threshold) {
      expect(respond).toBeDefined();
      await act(async () => {
        if (ok) persisted = stored;
        respond!(ok
          ? Response.json({ ok: true, autoSwitchThresholdOverride: stored })
          : new Response(null, { status: 500 }));
        respond = undefined;
      });
    },
    async refresh(nextGlobal: number, nextOverride = persisted) {
      globalThreshold = nextGlobal;
      persisted = nextOverride;
      await act(async () => { await controller!.load(); });
    },
  };
}

async function editThreshold(input: HTMLInputElement, draft: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, draft);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}

async function pressEnter(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    // happy-dom does not synthesize native keyboard button activation.
    if (element.tagName === "BUTTON") element.click();
  });
}

async function tabWithinThreshold(from: HTMLElement, to: HTMLElement) {
  await act(async () => {
    from.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    to.focus(); // Native focus()/focusout, including relatedTarget; no fabricated blur.
  });
  expect(win.document.activeElement === to).toBe(true);
}

for (const entry of [account, mainAccount]) {
  test(`${entry.id}: Enter save preserves input identity and focus after controller acceptance`, async () => {
    const pool = await mountThresholdPool(entry);
    const input = pool.input();
    await editThreshold(input, "60");
    await pressEnter(input);
    expect(pool.writes).toEqual([{ id: entry.isMain ? "__main__" : entry.id, threshold: 60 }]);
    await pool.settle();
    expect(pool.input() === input).toBe(true);
    expect(win.document.activeElement === input).toBe(true);
    expect(input.value).toBe("60");
  });

  test(`${entry.id}: pending Enter write keeps focusable read-only input and blocks duplicate writes`, async () => {
    const pool = await mountThresholdPool(entry);
    const input = pool.input();
    await editThreshold(input, "60");
    await pressEnter(input);
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(true);
    expect(win.document.activeElement === input).toBe(true);
    await pressEnter(input);
    await act(async () => { pool.steppers()[0]!.click(); });
    expect(input.value).toBe("60");
    expect(pool.writes).toHaveLength(1);
    await pool.settle();
    expect(input.readOnly).toBe(false);
    expect(win.document.activeElement === input).toBe(true);
    await editThreshold(input, "61");
    await pressEnter(input);
    await pool.settle();
    expect(pool.writes.map(write => write.threshold)).toEqual([60, 61]);
  });
}

test("dirty input can Tab through both steppers to toggle off without blur-saving", async () => {
  const pool = await mountThresholdPool();
  const input = pool.input();
  const [up, down] = pool.steppers();
  const toggle = pool.toggle();
  await editThreshold(input, "60");
  for (const button of [up!, down!, toggle]) expect(button.tabIndex).toBe(0);
  await tabWithinThreshold(input, up!);
  expect(pool.writes).toEqual([]);
  await tabWithinThreshold(up!, down!);
  await tabWithinThreshold(down!, toggle);
  expect(pool.writes).toEqual([]);
  await pressEnter(toggle);
  expect(pool.writes.map(write => write.threshold)).toEqual([null]);
  expect(toggle.disabled).toBe(false);
  expect(win.document.activeElement === toggle).toBe(true);
  await pool.settle();
  expect(pool.input()).toBeNull();
  expect(pool.toggle() === toggle).toBe(true);
  expect(win.document.activeElement === toggle).toBe(true);
});

test("keyboard stepper retains focus across pending and repeated accepted writes", async () => {
  const pool = await mountThresholdPool();
  const input = pool.input();
  const up = pool.steppers()[0]!;
  await editThreshold(input, "60");
  await tabWithinThreshold(input, up);
  await pressEnter(up);
  expect(pool.writes.map(write => write.threshold)).toEqual([61]);
  expect(up.disabled).toBe(false);
  expect(win.document.activeElement === up).toBe(true);
  await pressEnter(up);
  expect(pool.writes).toHaveLength(1);
  await pool.settle();
  expect(pool.steppers()[0] === up).toBe(true);
  expect(win.document.activeElement === up).toBe(true);
  await pressEnter(up);
  await pool.settle();
  expect(pool.writes.map(write => write.threshold)).toEqual([61, 62]);
  expect(pool.input() === input).toBe(true);
  expect(input.value).toBe("62");
  expect(win.document.activeElement === up).toBe(true);
});

test("leaving the group from a stepper commits the unsaved draft once", async () => {
  const pool = await mountThresholdPool();
  const input = pool.input();
  const up = pool.steppers()[0]!;
  await editThreshold(input, "60");
  await tabWithinThreshold(input, up);
  expect(pool.writes).toEqual([]);
  const outside = win.document.createElement("button");
  win.document.body.appendChild(outside);
  await act(async () => { outside.focus(); });
  expect(pool.writes.map(write => write.threshold)).toEqual([60]);
  await pool.settle();
  expect(win.document.activeElement === outside).toBe(true);
  expect(pool.writes).toHaveLength(1);
});

for (const initial of [50, 0]) {
  test(`failed pointer toggle-off restores persisted ${initial}, not dirty draft or global 95`, async () => {
    const pool = await mountThresholdPool(account, initial);
    const input = pool.input();
    const toggle = pool.toggle();
    await editThreshold(input, "60");
    await act(async () => {
      toggle.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
      toggle.focus();
      toggle.dispatchEvent(new win.Event("pointerup", { bubbles: true }));
      toggle.click();
    });
    expect(pool.writes.map(write => write.threshold)).toEqual([null]);
    await pool.settle(false);
    expect(pool.toggle().getAttribute("aria-pressed")).toBe("true");
    expect(pool.input().value).toBe(String(initial));
    expect(pool.input() === input).toBe(true);
    expect(win.document.activeElement === toggle).toBe(true);
    expect(host.textContent).toContain(en["accountPool.autoSwitchUpdateFailed"].split("{")[0]!);
  });
}

test("global refresh preserves dirty draft; changed override syncs without replacing focused input", async () => {
  const pool = await mountThresholdPool();
  const input = pool.input();
  await editThreshold(input, "60");
  await pool.refresh(80);
  expect(pool.input() === input).toBe(true);
  expect(input.value).toBe("60");
  await pool.refresh(80, 0);
  expect(pool.input() === input).toBe(true);
  expect(input.value).toBe("0");
  expect(win.document.activeElement === input).toBe(true);
  expect(pool.writes).toEqual([]);
});

test("accepted server-normalized override replaces the draft without remounting", async () => {
  const pool = await mountThresholdPool();
  const input = pool.input();
  await editThreshold(input, "60");
  await pressEnter(input);
  await pool.settle(true, 55);
  expect(pool.input() === input).toBe(true);
  expect(input.value).toBe("55");
  expect(win.document.activeElement === input).toBe(true);
});

test("pointer steppers keep input focus and commit each accepted step once", async () => {
  const pool = await mountThresholdPool();
  const input = pool.input();
  await editThreshold(input, "60");
  for (const index of [0, 0, 1]) {
    const button = pool.steppers()[index]!;
    await act(async () => {
      button.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
      const mouseDown = new win.MouseEvent("mousedown", { bubbles: true, cancelable: true });
      if (button.dispatchEvent(mouseDown)) button.focus();
      button.dispatchEvent(new win.Event("pointerup", { bubbles: true }));
      button.click();
    });
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(true);
    expect(win.document.activeElement === input).toBe(true);
    await pool.settle();
    expect(pool.input() === input).toBe(true);
    expect(win.document.activeElement === input).toBe(true);
  }
  expect(pool.writes.map(write => write.threshold)).toEqual([61, 62, 61]);
  expect(input.value).toBe("61");
});

test("failed Enter restores persisted value and permits another edit without duplicate blur write", async () => {
  const pool = await mountThresholdPool();
  const input = pool.input();
  await editThreshold(input, "60");
  await pressEnter(input);
  await pool.settle(false);
  expect(pool.input() === input).toBe(true);
  expect(win.document.activeElement === input).toBe(true);
  expect(input.value).toBe("50");
  expect(input.readOnly).toBe(false);
  await editThreshold(input, "65");
  await pressEnter(input);
  await act(async () => { input.blur(); });
  await pool.settle();
  expect(pool.writes.map(write => write.threshold)).toEqual([60, 65]);
  expect(input.value).toBe("65");
  expect(win.document.activeElement === input).toBe(false);
});

test("external input blur commits zero and leaves override enabled", async () => {
  const pool = await mountThresholdPool();
  await editThreshold(pool.input(), "0");
  await act(async () => { pool.input().blur(); });
  expect(pool.writes.map(write => write.threshold)).toEqual([0]);
  await pool.settle();
  expect(pool.input().value).toBe("0");
  expect(pool.toggle().getAttribute("aria-pressed")).toBe("true");
});

test("inherited override follows latest global seed including zero and preserves toggle identity", async () => {
  const pool = await mountThresholdPool(account, null);
  const toggle = pool.toggle();
  expect(pool.input()).toBeNull();
  await pool.refresh(0);
  await act(async () => { toggle.focus(); });
  await pressEnter(toggle);
  expect(pool.writes.map(write => write.threshold)).toEqual([0]);
  await pool.settle();
  expect(pool.input().value).toBe("0");
  expect(pool.toggle() === toggle).toBe(true);
  expect(win.document.activeElement === toggle).toBe(true);
  await pressEnter(toggle);
  await pool.settle();
  expect(pool.writes.map(write => write.threshold)).toEqual([0, null]);
  expect(pool.input()).toBeNull();
  expect(pool.toggle().getAttribute("aria-pressed")).toBe("false");
  expect(win.document.activeElement === toggle).toBe(true);
});

test("invalid draft and Escape restore persisted override without a write", async () => {
  const pool = await mountThresholdPool(account, 0);
  const input = pool.input();
  for (const invalid of ["", "-1", "101", "50.5"]) {
    await editThreshold(input, invalid);
    await pressEnter(input);
    expect(input.value).toBe("0");
  }
  await editThreshold(input, "60");
  await act(async () => {
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(input.value).toBe("0");
  expect(pool.writes).toEqual([]);
});

for (const timing of ["during", "after"] as const) {
  for (const outcome of ["accepted Enter", "rejected Enter", "rejected toggle"] as const) {
    test(`pre-write accounts snapshot resolving ${timing} ${outcome} preserves draft, stored override and focus`, async () => {
      const pool = await mountThresholdPool();
      const input = pool.input();
      const toggle = pool.toggle();
      const finishRefresh = await pool.startSlowRefresh(); // Snapshot contains persisted 50.
      await editThreshold(input, "60");
      const toggling = outcome === "rejected toggle";
      if (toggling) {
        await tabWithinThreshold(input, pool.steppers()[0]!);
        await tabWithinThreshold(pool.steppers()[0]!, pool.steppers()[1]!);
        await tabWithinThreshold(pool.steppers()[1]!, toggle);
        await pressEnter(toggle);
      } else {
        await pressEnter(input);
      }
      const focused = toggling ? toggle : input;
      expect(pool.writes.map(write => write.threshold)).toEqual([toggling ? null : 60]);
      if (timing === "during") await finishRefresh();
      expect(pool.input() === input).toBe(true);
      expect(input.value).toBe("60");
      expect(input.readOnly).toBe(true);
      expect(pool.storedOverride()).toBe(50);
      expect(win.document.activeElement === focused).toBe(true);

      const accepted = outcome === "accepted Enter";
      await pool.settle(accepted);
      expect(pool.input() === input).toBe(true);
      expect(input.value).toBe(accepted ? "60" : "50");
      expect(input.readOnly).toBe(false);
      expect(pool.storedOverride()).toBe(accepted ? 60 : 50);
      expect(pool.toggle().getAttribute("aria-pressed")).toBe("true");
      expect(win.document.activeElement === focused).toBe(true);

      if (timing === "after") {
        // A late pre-write snapshot must neither roll back acceptance nor erase a
        // fresh unsaved edit made after the success/error response was handled.
        await editThreshold(input, "65");
        await finishRefresh();
        expect(pool.input() === input).toBe(true);
        expect(input.value).toBe("65");
        expect(pool.storedOverride()).toBe(accepted ? 60 : 50);
        expect(win.document.activeElement === input).toBe(true);
      }
      expect(pool.writes).toHaveLength(1);
    });
  }
}
