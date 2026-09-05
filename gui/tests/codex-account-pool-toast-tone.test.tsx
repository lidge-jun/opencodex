import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { formatAccountPriority } from "../src/account-priority";
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
let legacyApiPayload: unknown = null;
let priorityWrites: { id: string; priority: number | null }[] = [];

type LegacyCodexAccountEntry = Omit<CodexAccountEntry, "quotaAutoRefresh">;
const legacyAccount: LegacyCodexAccountEntry = {
  id: "pool-1",
  email: "pool@example.test",
  isMain: false,
  paused: false,
  priority: 0,
  hasCredential: true,
  quota: { resetCredits: 2, updatedAt: 1 },
};
const account: CodexAccountEntry = {
  ...legacyAccount,
  quotaAutoRefresh: {
    fiveHourAvailable: false,
    weeklyAvailable: false,
    fiveHourEnabled: false,
    weeklyEnabled: false,
  },
};

function makeController(overrides: Partial<CodexAccountPoolController> = {}): CodexAccountPoolController {
  return {
    accounts: [
      {
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
      },
      account,
    ],
    activeId: null,
    loadState: "ready",
    switchingId: null,
    pauseUpdatingId: null,
    priorityUpdatingId: null,
    pausingExhausted: false,
    activeNeedsReauth: false,
    activePinnedId: null,
    refreshing: false,
    initialLoading: false,
    load: async () => true,
    switchAccount: async () => ({ ok: true, activeId: null }),
    setAccountPaused: async () => ({ ok: true }),
    setAccountPriority: async () => ({ ok: true }),
    pauseExhaustedAccounts: async () => ({ ok: true, pausedCount: 0 }),
    saveAlias: async () => ({ ok: true }),
    removeAccount: async () => ({ ok: false, reason: "request" }),
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
  legacyApiPayload = null;
  priorityWrites = [];
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
      if (url.pathname === "/api/codex-auth/accounts" && legacyApiPayload !== null) {
        return Response.json(legacyApiPayload);
      }
      if (url.pathname === "/api/codex-auth/active") {
        return Response.json({ activeCodexAccountId: null, pinnedAccountId: null });
      }
      if (url.pathname === "/api/codex-auth/accounts/priority") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { id?: string; priority?: number | null };
        priorityWrites.push({ id: body.id ?? "", priority: body.priority ?? null });
        return Response.json({ priority: 2 });
      }
      if (url.pathname.startsWith("/api/codex-auth/")) {
        return Response.json({ accounts: [], activeCodexAccountId: null, autoSwitchThreshold: 80 });
      }
      if (url.pathname === "/api/settings") return Response.json({ codexQuotaAutoRefresh: {} });
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

async function mountPool(controller?: CodexAccountPoolController, apiBase = "") {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <CodexAccountPool apiBase={apiBase} {...(controller ? { controller } : {})} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

test("quota activation is one advanced control, never a row on each account card", async () => {
  const controller = makeController();
  controller.accounts = controller.accounts.map(entry => ({ ...entry,
    quotaAutoRefresh: { fiveHourAvailable: true, weeklyAvailable: true, fiveHourEnabled: false, weeklyEnabled: false },
  }));
  await mountPool(controller);
  expect(host.querySelectorAll('.codex-quota-auto-refresh').length).toBe(0);
  expect(host.querySelectorAll('#codex-quota-activation').length).toBe(0);
  await act(async () => { host.querySelector<HTMLButtonElement>('.codex-auth-advanced__toggle')!.click(); });
  expect(host.querySelectorAll('#codex-quota-activation .toggle').length).toBe(1);
});

async function chooseOrder(selectId: string, value: string): Promise<void> {
  // A default-priority account renders its order select only once its ⋯ disclosure is
  // open (050): the control is on demand, not wallpaper on every card.
  const accountId = selectId.replace(/^codex-account-priority-/, "");
  const more = [...host.querySelectorAll<HTMLDetailsElement>("details.codex-account-more")]
    .find(d => d.querySelector("summary")?.getAttribute("aria-label")?.includes("—") && d.closest(".card")?.textContent?.includes(accountId.replace("pool-", "")));
  if (more && !host.querySelector(`#${selectId}`)) {
    await act(async () => { more.querySelector("summary")!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  const trigger = host.querySelector(`#${selectId}`) as HTMLButtonElement | null;
  expect(trigger).toBeTruthy();
  await act(async () => { trigger!.click(); });

  // The menu is portaled to document.body, so the options are not under the mount node.
  // Every label ends in the signed number, which is what identifies the order being picked.
  const wanted = `(${formatAccountPriority(Number(value))})`;
  const option = [...win.document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((candidate) => candidate.textContent?.endsWith(wanted));
  expect(option).toBeTruthy();
  await act(async () => {
    option!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

type ActivationWrite = { id: string; window: "fiveHour" | "weekly"; enabled: boolean };
type ActivationSettings = Record<string, { fiveHour?: boolean; weekly?: boolean }>;
function activationController() {
  const entry = (id: string, fiveHour: boolean, weekly: boolean): CodexAccountEntry => ({
    ...account, id, isMain: id === "__main__", email: `${id}@example.test`,
    quotaAutoRefresh: { fiveHourAvailable: fiveHour, weeklyAvailable: weekly, fiveHourEnabled: false, weeklyEnabled: false },
  });
  return makeController({ accounts: [entry("__main__", false, true), entry("both", true, true), entry("none", false, false)] });
}
function activationApi(initial: ActivationSettings = {}) {
  const fallback = globalThis.fetch;
  const state = { settings: structuredClone(initial), writes: [] as ActivationWrite[],
    fail: (_write: ActivationWrite) => false,
    read: null as null | (() => Promise<Response>),
    beforeWrite: null as null | (() => Promise<void>),
  };
  globalThis.fetch = (async (input, init) => {
    if (!String(input).endsWith("/api/settings")) return fallback(input, init);
    if (init?.method !== "PUT") return state.read ? state.read() : Response.json({ codexQuotaAutoRefresh: state.settings });
    const write = JSON.parse(String(init.body)).codexQuotaAutoRefresh as ActivationWrite;
    state.writes.push(write);
    await state.beforeWrite?.();
    if (state.fail(write)) return Response.json({ error: "private server detail" }, { status: 503 });
    state.settings[write.id] = { ...state.settings[write.id], [write.window]: write.enabled };
    return Response.json({ codexQuotaAutoRefresh: state.settings });
  }) as typeof fetch;
  return state;
}
async function activationClick(selector: string) {
  await act(async () => { host.querySelector<HTMLButtonElement>(selector)!.click(); });
}
const activationToggle = () => host.querySelector<HTMLButtonElement>('#codex-quota-activation .toggle')!;
const activationRetry = '#codex-quota-activation .btn';
const activationOpen = () => activationClick('.codex-auth-advanced__toggle');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("bulk activation enables and disables all supported current account windows, not unavailable windows", async () => {
  const api = activationApi();
  await mountPool(activationController());
  await activationOpen();
  expect(activationToggle().getAttribute("aria-pressed")).toBe("false");
  await activationClick('#codex-quota-activation .toggle');
  expect(api.writes).toEqual([
    { id: "__main__", window: "weekly", enabled: true },
    { id: "both", window: "fiveHour", enabled: true },
    { id: "both", window: "weekly", enabled: true },
  ]);
  expect(activationToggle().getAttribute("aria-pressed")).toBe("true");
  api.writes.length = 0;
  await activationClick('#codex-quota-activation .toggle');
  expect(api.writes).toEqual([
    { id: "__main__", window: "weekly", enabled: false },
    { id: "both", window: "fiveHour", enabled: false },
    { id: "both", window: "weekly", enabled: false },
  ]);
  expect(activationToggle().getAttribute("aria-pressed")).toBe("false");
});

test("mixed activation enables remaining windows without revoking temporarily unavailable opt-ins", async () => {
  const api = activationApi({ __main__: { weekly: true }, none: { fiveHour: true } });
  await mountPool(activationController()); await activationOpen();
  expect(activationToggle().getAttribute("aria-pressed")).toBe("mixed");
  await activationClick('#codex-quota-activation .toggle');
  expect(api.writes).toEqual([
    { id: "both", window: "fiveHour", enabled: true },
    { id: "both", window: "weekly", enabled: true },
  ]);
  expect(api.settings.none.fiveHour).toBe(true);
  expect(activationToggle().getAttribute("aria-pressed")).toBe("true");
  expect(host.textContent).toContain("Automatic window activation updated");
  api.writes.length = 0;
  await activationClick('#codex-quota-activation .toggle');
  expect(api.writes).toContainEqual({ id: "none", window: "fiveHour", enabled: false });
  expect(api.writes.every(write => !write.enabled)).toBe(true);
});

test("partial OFF retry preserves OFF intent and never re-enables a saved disable", async () => {
  const api = activationApi({ __main__: { weekly: true }, both: { fiveHour: true, weekly: true } });
  api.fail = write => write.window === "fiveHour";
  await mountPool(activationController()); await activationOpen();
  await activationClick('#codex-quota-activation .toggle');
  expect(activationToggle().getAttribute("aria-pressed")).toBe("mixed");
  expect(host.textContent).toContain("Some settings could not be saved");
  expect(host.textContent).not.toContain("private server detail");
  api.fail = () => false; api.writes.length = 0;
  await activationClick(activationRetry);
  expect(api.writes).toEqual([{ id: "both", window: "fiveHour", enabled: false }]);
  expect(activationToggle().getAttribute("aria-pressed")).toBe("false");
});

test("settings read failure is unknown and retryable; malformed acknowledgments never imply off", async () => {
  const api = activationApi(); api.read = async () => Response.json({ codexQuotaAutoRefresh: { both: { weekly: "false" } } });
  await mountPool(activationController()); await activationOpen();
  expect(activationToggle().disabled).toBe(true);
  expect(activationToggle().hasAttribute("aria-pressed")).toBe(false);
  expect(host.textContent).toContain("Could not load activation settings");
  api.read = null;
  await activationClick(activationRetry);
  expect(activationToggle().disabled).toBe(false);
});

test("delayed settings and duplicate clicks stay blocked through final reconciliation", async () => {
  const api = activationApi(); const initial = deferred<Response>(); api.read = () => initial.promise;
  await mountPool(activationController()); await activationOpen();
  expect(activationToggle().disabled).toBe(true);
  expect(activationToggle().hasAttribute("aria-pressed")).toBe(false);
  await act(async () => { initial.resolve(Response.json({ codexQuotaAutoRefresh: {} })); });
  const write = deferred<void>(); api.beforeWrite = () => write.promise;
  const final = deferred<Response>(); api.read = () => final.promise;
  await act(async () => { activationToggle().click(); activationToggle().click(); });
  expect(api.writes.length).toBe(1);
  expect(activationToggle().disabled).toBe(true);
  await act(async () => { write.resolve(); });
  expect(api.writes.length).toBe(3);
  expect(activationToggle().disabled).toBe(true);
  await act(async () => { final.resolve(Response.json({ codexQuotaAutoRefresh: api.settings })); });
  expect(activationToggle().disabled).toBe(false);
  expect(activationToggle().getAttribute("aria-pressed")).toBe("true");
});

test("lost reconciliation stays unknown and reloads without repeating already saved writes", async () => {
  const api = activationApi(); await mountPool(activationController()); await activationOpen();
  api.read = async () => Response.json({}, { status: 503 });
  await activationClick('#codex-quota-activation .toggle');
  expect(activationToggle().disabled).toBe(true);
  expect(activationToggle().hasAttribute("aria-pressed")).toBe(false);
  const writes = api.writes.length; api.read = null;
  await activationClick(activationRetry);
  expect(api.writes.length).toBe(writes);
  expect(activationToggle().getAttribute("aria-pressed")).toBe("true");
  await activationClick(activationRetry);
  expect(api.writes.length).toBe(writes);
  expect(host.textContent).toContain("Automatic window activation updated");
});

test("no-window accounts cannot enable, but stale enabled windows can always be disabled", async () => {
  const api = activationApi(); const controller = activationController(); controller.accounts = [controller.accounts[2]];
  await mountPool(controller); await activationOpen();
  expect(activationToggle().disabled).toBe(true);
  expect(host.textContent).toContain("No supported quota windows");
  // Reloading the same surface with persisted stale settings keeps OFF reachable.
  await act(async () => { root!.unmount(); root = null; });
  api.settings = { none: { weekly: true } };
  await mountPool(controller); await activationOpen();
  expect(activationToggle().getAttribute("aria-pressed")).toBe("true");
  await activationClick('#codex-quota-activation .toggle');
  expect(api.writes).toEqual([{ id: "none", window: "weekly", enabled: false }]);
});

test("switching apiBase stops remaining old-proxy writes and ignores the old completion", async () => {
  const api = activationApi(); const controller = activationController();
  await mountPool(controller, "http://old"); await activationOpen();
  const pending = deferred<void>(); api.beforeWrite = () => pending.promise;
  await activationClick('#codex-quota-activation .toggle');
  expect(api.writes.length).toBe(1);
  await act(async () => { root!.render(<LanguageProvider><CodexAccountPool apiBase="http://new" controller={controller} /></LanguageProvider>); });
  await act(async () => { pending.resolve(); });
  expect(api.writes.length).toBe(1);
  expect(activationToggle().getAttribute("aria-pressed")).toBe("false");
  expect(host.textContent).not.toContain("Automatic window activation updated");
});

test("A to B to A never revives the old A snapshot while its new read is pending or fails", async () => {
  const api = activationApi({ __main__: { weekly: true }, both: { fiveHour: true, weekly: true } });
  const controller = activationController();
  await mountPool(controller, "http://a"); await activationOpen();
  expect(activationToggle().getAttribute("aria-pressed")).toBe("true");
  const pendingB = deferred<Response>(); api.read = () => pendingB.promise;
  await act(async () => { root!.render(<LanguageProvider><CodexAccountPool apiBase="http://b" controller={controller} /></LanguageProvider>); });
  const pendingA = deferred<Response>(); api.read = () => pendingA.promise;
  await act(async () => { root!.render(<LanguageProvider><CodexAccountPool apiBase="http://a" controller={controller} /></LanguageProvider>); });
  expect(activationToggle().disabled).toBe(true);
  expect(activationToggle().hasAttribute("aria-pressed")).toBe(false);
  await activationClick('#codex-quota-activation .toggle');
  expect(api.writes.length).toBe(0);
  await act(async () => { pendingA.resolve(Response.json({}, { status: 503 })); pendingB.resolve(Response.json({ codexQuotaAutoRefresh: {} })); });
  expect(activationToggle().disabled).toBe(true);
  expect(activationToggle().hasAttribute("aria-pressed")).toBe(false);
  api.read = null;
  await activationClick(activationRetry);
  const off = deferred<void>(); api.beforeWrite = () => off.promise;
  await activationClick('#codex-quota-activation .toggle');
  expect(activationToggle().disabled).toBe(true);
  await act(async () => { off.resolve(); });
  expect(api.writes.length).toBe(3);
  expect(api.writes.every(write => !write.enabled)).toBe(true);
  expect(activationToggle().getAttribute("aria-pressed")).toBe("false");
});

test("a legacy account without quota activation data keeps selection order usable", async () => {
  expect("quotaAutoRefresh" in legacyAccount).toBe(false);
  legacyApiPayload = { accounts: [legacyAccount] };
  await mountPool();

  await chooseOrder("codex-account-priority-pool-1", "2");

  expect(priorityWrites).toEqual([{ id: "pool-1", priority: 2 }]);
  expect(host.querySelector(".codex-auth-page-head__feedback.is-ok")?.textContent).toContain("pool@example.test");
  expect(host.querySelector(".codex-auth-page-head__feedback.is-err")).toBeNull();
});

test("a rejected selection order reports in the error tone", async () => {
  await mountPool(makeController({
    setAccountPriority: async () => ({ ok: false, reason: "request" }),
  }));

  await chooseOrder("codex-account-priority-__main__", "-1");

  const error = host.querySelector(".codex-auth-page-head__feedback.is-err");
  expect(error).toBeTruthy();
  expect(error?.textContent).toContain("main@example.test");
  expect(host.querySelector(".codex-auth-page-head__feedback.is-ok")).toBeNull();
});

test("a saved removal with pending catalog refresh renders a warning tone", async () => {
  await mountPool(makeController({
    removeAccount: async () => ({ ok: true, catalogRefreshPending: true }),
  }));

  const removeButton = [...host.querySelectorAll("button")].find(button =>
    (button.getAttribute("aria-label") ?? "").includes("pool@example.test")
    && (button.getAttribute("aria-label") ?? "").toLowerCase().includes("remove"),
  );
  expect(removeButton).toBeTruthy();
  await act(async () => {
    removeButton!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
  });

  const warning = host.querySelector(".codex-auth-page-head__feedback.is-warn");
  expect(warning?.textContent).toContain("ocx sync");
  expect(warning?.textContent).not.toContain("pool@example.test");
  expect(host.querySelector(".codex-auth-page-head__feedback.is-err")).toBeNull();
});

test("a busy selection order write shows no toast at all", async () => {
  await mountPool(makeController({
    setAccountPriority: async () => ({ ok: false, reason: "busy" }),
  }));

  await chooseOrder("codex-account-priority-pool-1", "-2");

  expect(host.querySelector(".codex-auth-page-head__feedback.is-err")).toBeNull();
  expect(host.querySelector(".codex-auth-page-head__feedback.is-ok")).toBeNull();
});

test("picking the order an account already has writes nothing", async () => {
  const saved: { id: string; priority: number | null }[] = [];
  await mountPool(makeController({
    setAccountPriority: async (id, priority) => {
      saved.push({ id, priority });
      return { ok: true };
    },
  }));

  // pool-1 is already Normal (0). Select fires onChange for the clicked option whether or
  // not it was the selected one, and commits the highlighted option on Tab-out of an open
  // menu, so this is reachable by an ordinary mis-click. It must not reach the server: the
  // route releases the pin on every accepted write, so a no-op order pick would silently
  // unpin the account the operator chose, reporting success while doing it.
  await chooseOrder("codex-account-priority-pool-1", "0");

  expect(saved).toEqual([]);
  expect(host.querySelector(".codex-auth-page-head__feedback.is-ok")).toBeNull();
  expect(host.querySelector(".codex-auth-page-head__feedback.is-err")).toBeNull();
});

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

/*
 * devlog/_plan/260904_dashboard_minimal/050_codex_set.md: a pool card shows only its daily
 * actions inline; alias, account id + copy, and remove sit behind a labelled ⋯ disclosure,
 * and the order select renders on demand (inside the disclosure) unless the account already
 * carries a non-default order.
 */
test("a pool card folds alias/id/remove behind a ⋯ disclosure and shows the order select on demand", async () => {
  const removed: string[] = [];
  await mountPool(makeController({
    removeAccount: async (id) => { removed.push(id); return { ok: true }; },
  }));
  const card = [...host.querySelectorAll<HTMLElement>(".card")].find(c => c.textContent?.includes("pool@example.test"))!;
  expect(card).toBeDefined();
  const more = card.querySelector<HTMLDetailsElement>("details.codex-account-more")!;
  expect(more).not.toBeNull();
  expect(more.open).toBe(false);
  // Closed: the alias/id/remove controls live INSIDE the (closed) details — a native details
  // keeps its body in the DOM but not in the accessibility tree or the tab order — and the
  // order select is not rendered at all until the disclosure opens.
  const inline = [...card.querySelectorAll<HTMLButtonElement>("button")].filter(b => !b.closest("details"));
  expect(inline.map(b => b.textContent?.trim())).not.toContain("Edit alias");
  expect(card.querySelector("#codex-account-priority-pool-1")).toBeNull();
  expect(more.querySelector(".codex-account-more-body")!.textContent).toContain("ID:");
  const summary = more.querySelector("summary")!;
  expect(summary.getAttribute("aria-label")).toContain("Show more actions");

  await act(async () => { summary.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(more.open).toBe(true);
  expect([...more.querySelectorAll("button")].map(b => b.textContent?.trim())).toContain("Edit alias");
  expect(card.querySelector("#codex-account-priority-pool-1")).not.toBeNull();
  const copy = [...card.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Copy account ID")!;
  expect(copy).toBeDefined();
  // Clicking writes the FULL id (the visible text is masked) and flips only this card's label.
  const written: string[] = [];
  Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { written.push(text); } } });
  await act(async () => { copy.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(written).toEqual(["pool-1"]);
  expect(copy.textContent?.trim()).toBe("Copied");
  const remove = card.querySelector<HTMLButtonElement>('button[aria-label^="Remove"]')!;
  expect(remove).not.toBeNull();
  await act(async () => { remove.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(removed).toEqual(["pool-1"]);
});

test("a pool card with a non-default order keeps its order select inline", async () => {
  await mountPool(makeController({
    accounts: [
      { id: "main", email: "main@example.test", isMain: true, paused: false, priority: 0, hasCredential: true, quota: null },
      { ...account, priority: 2 },
    ],
  }));
  const card = [...host.querySelectorAll<HTMLElement>(".card")].find(c => c.textContent?.includes("pool@example.test"))!;
  expect(card.querySelector<HTMLDetailsElement>("details.codex-account-more")!.open).toBe(false);
  expect(card.querySelector("#codex-account-priority-pool-1")).not.toBeNull();
});
