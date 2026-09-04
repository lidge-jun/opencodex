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

const account: CodexAccountEntry = {
  id: "pool-1",
  email: "pool@example.test",
  isMain: false,
  paused: false,
  priority: 0,
  hasCredential: true,
  quota: { resetCredits: 2, updatedAt: 1 },
};

function makeController(overrides: Partial<CodexAccountPoolController> = {}): CodexAccountPoolController {
  return {
    accounts: [
      { id: "main", email: "main@example.test", isMain: true, paused: false, priority: 0, hasCredential: true, quota: null },
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

test("a saved selection order reports in the ok tone", async () => {
  const saved: { id: string; priority: number | null }[] = [];
  await mountPool(makeController({
    setAccountPriority: async (id, priority) => {
      saved.push({ id, priority });
      return { ok: true };
    },
  }));

  await chooseOrder("codex-account-priority-pool-1", "2");

  expect(saved).toEqual([{ id: "pool-1", priority: 2 }]);
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
