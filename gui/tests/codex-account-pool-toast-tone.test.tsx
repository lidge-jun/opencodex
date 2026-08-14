import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { formatAccountPriority } from "../src/account-priority";
import CodexAccountPool from "../src/components/CodexAccountPool";
import type { CodexAccountEntry, CodexAccountPoolController } from "../src/hooks/useCodexAccountPool";
import { LanguageProvider } from "../src/i18n/provider";

/**
 * Stale toastError must not paint a successful redeem as notice-err (PR #475).
 */

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let originalConfirm: typeof window.confirm;
let consumeAttempts = 0;
let consumedOperationIds: string[] = [];

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
    sessionStorage: { configurable: true, value: win.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  originalFetch = globalThis.fetch;
  originalConfirm = window.confirm;
  window.confirm = () => true;
  consumeAttempts = 0;
  consumedOperationIds = [];

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/codex-auth/reset-credits" && !url.pathname.endsWith("/consume")) {
        return Response.json({ credits: [], guiConsumeAllowed: true });
      }
      if (url.pathname === "/api/codex-auth/reset-credits/consume" && (init?.method ?? "GET") === "POST") {
        consumeAttempts += 1;
        consumedOperationIds.push(
          (JSON.parse(String(init?.body)) as { operationId: string }).operationId,
        );
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

async function mountPool(
  controller: CodexAccountPoolController,
  strictMode = false,
  requestOwnerToken: () => Promise<string | null> = async () => "admin-secret",
) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    const element = (
      <LanguageProvider>
        <CodexAccountPool
          apiBase=""
          controller={controller}
          requestOwnerToken={requestOwnerToken}
        />
      </LanguageProvider>
    );
    root.render(strictMode ? <StrictMode>{element}</StrictMode> : element);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

test("a remote dashboard disables reset-credit consumption and points to the local CLI", async () => {
  const baseFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/codex-auth/reset-credits" && !url.pathname.endsWith("/consume")) {
        return Response.json({ credits: [], guiConsumeAllowed: false });
      }
      return baseFetch(input, init);
    },
  });

  await mountPool(makeController());
  const reset = host.querySelector('button[aria-label="2 reset credit(s)"]') as HTMLButtonElement;
  await act(async () => { reset.click(); await new Promise(resolve => setTimeout(resolve, 40)); });

  const useCredit = [...host.querySelectorAll("button")].find(button =>
    (button.textContent ?? "").includes("Use 1 Credit"),
  ) as HTMLButtonElement | undefined;
  expect(useCredit).toBeTruthy();
  expect(useCredit?.disabled).toBe(true);
  expect(host.textContent).toContain("Reset-credit consumption is available only from the loopback dashboard");
  expect(consumeAttempts).toBe(0);
  expect([...host.querySelectorAll("button")].some(button =>
    (button.textContent ?? "").trim() === "Use Credit",
  )).toBe(false);
});

test("a stalled reset-credit detail request leaves loading after the GUI budget", async () => {
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  const timeoutController = new AbortController();
  let timeoutMs = 0;
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: (ms: number) => {
      timeoutMs = ms;
      queueMicrotask(() => timeoutController.abort(new DOMException("timed out", "TimeoutError")));
      return timeoutController.signal;
    },
  });
  Object.defineProperty(AbortSignal, "any", {
    configurable: true,
    value: (signals: AbortSignal[]) => signals[1],
  });
  const baseFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/codex-auth/reset-credits" && !url.pathname.endsWith("/consume")) {
        const signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          const rejectAbort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
          if (signal?.aborted) rejectAbort();
          else signal?.addEventListener("abort", rejectAbort, { once: true });
        });
      }
      return baseFetch(input, init);
    },
  });

  try {
    await mountPool(makeController());
    const reset = host.querySelector('button[aria-label="2 reset credit(s)"]') as HTMLButtonElement;
    await act(async () => {
      reset.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(timeoutMs).toBe(15_000);
    const resetDialog = host.querySelector('dialog[aria-labelledby="codex-reset-title"]');
    expect(resetDialog?.textContent).not.toContain("Loading…");
    expect(resetDialog?.textContent).toContain("Reset-credit consumption is available only from the loopback dashboard");
    expect(consumeAttempts).toBe(0);
  } finally {
    if (timeoutDescriptor) Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor);
    if (anyDescriptor) Object.defineProperty(AbortSignal, "any", anyDescriptor);
  }
});

async function chooseOrder(selectId: string, value: string): Promise<void> {
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

test("an owner-token failure reports an error and preserves the retry identity", async () => {
  const operationId = "00000000-0000-4000-8000-000000000901";
  const storageKey = "ocx.codexResetCreditOperation.v2.pool-1";
  localStorage.setItem(storageKey, operationId);
  let ownerTokenCalls = 0;

  await mountPool(makeController(), false, async () => {
    ownerTokenCalls += 1;
    if (ownerTokenCalls === 1) throw new Error("owner token unavailable");
    return "admin-secret";
  });

  const reset = host.querySelector('button[aria-label="2 reset credit(s)"]') as HTMLButtonElement;
  await act(async () => { reset.click(); await new Promise(resolve => setTimeout(resolve, 40)); });
  const useCredit = [...host.querySelectorAll("button")].find(button =>
    (button.textContent ?? "").includes("Use 1 Credit"),
  ) as HTMLButtonElement;
  await act(async () => { useCredit.click(); });
  const redeem = () => [...host.querySelectorAll("button")].find(button =>
    (button.textContent ?? "").trim() === "Use Credit",
  ) as HTMLButtonElement;

  await act(async () => { redeem().click(); await new Promise(resolve => setTimeout(resolve, 40)); });

  expect(host.querySelector(".codex-auth-page-head__feedback.is-err")?.textContent)
    .toContain("Failed to redeem reset credit");
  expect(consumeAttempts).toBe(0);
  expect(localStorage.getItem(storageKey)).toBe(operationId);
  expect(host.querySelector("dialog")).toBeTruthy();
  expect(redeem().disabled).toBe(false);

  await act(async () => { redeem().click(); await new Promise(resolve => setTimeout(resolve, 40)); });

  expect(ownerTokenCalls).toBe(2);
  expect(consumedOperationIds).toEqual([operationId]);
  expect(localStorage.getItem(storageKey)).toBeNull();
  expect(host.querySelector("dialog")).toBeNull();
});

test("LAN fallback UUID remains stable across a failed redeem retry", async () => {
  const cryptoObject = globalThis.crypto;
  const originalRandomUUID = cryptoObject.randomUUID;
  Object.defineProperty(cryptoObject, "randomUUID", {
    configurable: true,
    value: () => { throw new Error("randomUUID requires a secure context"); },
  });
  const baseFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/codex-auth/reset-credits/consume") {
        consumeAttempts += 1;
        consumedOperationIds.push(
          (JSON.parse(String(init?.body)) as { operationId: string }).operationId,
        );
        if (consumeAttempts === 1) return Response.json({ error: "lost" }, { status: 502 });
        return Response.json({ code: "already_redeemed", remaining: 2 });
      }
      return baseFetch(input, init);
    },
  });
  try {
    await mountPool(makeController());
    const resetBtn = host.querySelector('button[aria-label="2 reset credit(s)"]') as HTMLButtonElement;
    await act(async () => { resetBtn.click(); await new Promise(resolve => setTimeout(resolve, 40)); });
    const useCredit = [...host.querySelectorAll("button")].find(button =>
      (button.textContent ?? "").includes("Use 1 Credit"),
    )!;
    await act(async () => { useCredit.click(); });
    const redeem = () => [...host.querySelectorAll("button")].find(button => {
      const text = (button.textContent ?? "").trim();
      return text === "Use Credit" || text.startsWith("Resetting");
    })!;
    await act(async () => { redeem().click(); await new Promise(resolve => setTimeout(resolve, 40)); });
    await act(async () => { redeem().click(); await new Promise(resolve => setTimeout(resolve, 40)); });
    expect(consumeAttempts).toBe(2);
    expect(new Set(consumedOperationIds).size).toBe(1);
    expect(consumedOperationIds[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  } finally {
    Object.defineProperty(cryptoObject, "randomUUID", {
      configurable: true,
      value: originalRandomUUID,
    });
  }
});

test("an ambiguous redeem survives modal close and remount with the same operation identity", async () => {
  const baseFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/codex-auth/reset-credits/consume") {
        consumeAttempts += 1;
        consumedOperationIds.push(
          (JSON.parse(String(init?.body)) as { operationId: string }).operationId,
        );
        if (consumeAttempts === 1) return Response.json({ error: "lost" }, { status: 502 });
        return Response.json({ code: "already_redeemed", remaining: 1 });
      }
      return baseFetch(input, init);
    },
  });

  const redeemOnce = async () => {
    const reset = host.querySelector('button[aria-label="2 reset credit(s)"]') as HTMLButtonElement;
    await act(async () => { reset.click(); await new Promise(resolve => setTimeout(resolve, 40)); });
    const useCredit = [...host.querySelectorAll("button")].find(button =>
      (button.textContent ?? "").includes("Use 1 Credit"),
    )!;
    await act(async () => { useCredit.click(); });
    const redeem = [...host.querySelectorAll("button")].find(button =>
      (button.textContent ?? "").trim() === "Use Credit",
    )!;
    await act(async () => { redeem.click(); await new Promise(resolve => setTimeout(resolve, 40)); });
  };

  await mountPool(makeController());
  await redeemOnce();
  expect(consumeAttempts).toBe(1);
  expect(localStorage.getItem("ocx.codexResetCreditOperation.v2.pool-1")).not.toBeNull();
  const backdrop = host.querySelector(".modal-backdrop-dismiss") as HTMLButtonElement;
  await act(async () => { backdrop.click(); });
  expect(host.querySelector("dialog")).toBeNull();

  const current = root!;
  await act(async () => { current.unmount(); });
  root = null;
  sessionStorage.clear();
  host.remove();
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  await mountPool(makeController());
  await redeemOnce();

  expect(consumeAttempts).toBe(2);
  expect(new Set(consumedOperationIds).size).toBe(1);
  expect(localStorage.getItem("ocx.codexResetCreditOperation.v2.pool-1")).toBeNull();
});

test("a terminal identity conflict stays recoverable when durable retry cleanup fails", async () => {
  const staleOperationId = "00000000-0000-4000-8000-000000000779";
  const storageKey = "ocx.codexResetCreditOperation.v2.pool-1";
  localStorage.setItem(storageKey, staleOperationId);
  const baseFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/codex-auth/reset-credits/consume") {
        consumeAttempts += 1;
        consumedOperationIds.push(
          (JSON.parse(String(init?.body)) as { operationId: string }).operationId,
        );
        return Response.json({
          error: "The Codex account identity changed. Confirm a new reset-credit request.",
          code: "reset_credit_operation_identity_changed",
        }, { status: 409 });
      }
      return baseFetch(input, init);
    },
  });
  const storage = localStorage;
  const originalRemoveItem = storage.removeItem.bind(storage);
  Object.defineProperty(storage, "removeItem", {
    configurable: true,
    value: (key: string) => {
      if (key === storageKey) throw new Error("storage unavailable");
      return originalRemoveItem(key);
    },
  });
  try {
    await mountPool(makeController());
    const reset = host.querySelector('button[aria-label="2 reset credit(s)"]') as HTMLButtonElement;
    await act(async () => { reset.click(); await new Promise(resolve => setTimeout(resolve, 40)); });
    const useCredit = [...host.querySelectorAll("button")].find(button =>
      (button.textContent ?? "").includes("Use 1 Credit"),
    ) as HTMLButtonElement;
    await act(async () => { useCredit.click(); });
    const redeem = [...host.querySelectorAll("button")].find(button =>
      (button.textContent ?? "").trim() === "Use Credit",
    ) as HTMLButtonElement;
    await act(async () => { redeem.click(); await new Promise(resolve => setTimeout(resolve, 40)); });

    expect(consumedOperationIds).toEqual([staleOperationId]);
    expect(localStorage.getItem(storageKey)).toBe(staleOperationId);
    expect(host.querySelector("dialog")).toBeTruthy();
    expect(host.textContent).toContain("The Codex account identity changed");
    expect(host.textContent).toContain("local retry state could not be cleared");
  } finally {
    Object.defineProperty(storage, "removeItem", {
      configurable: true,
      value: originalRemoveItem,
    });
  }
});

test("a successful redeem remains visible when durable retry cleanup fails", async () => {
  const operationId = "00000000-0000-4000-8000-000000000780";
  const storageKey = "ocx.codexResetCreditOperation.v2.pool-1";
  localStorage.setItem(storageKey, operationId);
  const baseFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/codex-auth/reset-credits/consume") {
        consumeAttempts += 1;
        consumedOperationIds.push(
          (JSON.parse(String(init?.body)) as { operationId: string }).operationId,
        );
        return Response.json({ code: "reset" });
      }
      return baseFetch(input, init);
    },
  });
  const storage = localStorage;
  const originalRemoveItem = storage.removeItem.bind(storage);
  Object.defineProperty(storage, "removeItem", {
    configurable: true,
    value: (key: string) => {
      if (key === storageKey) throw new Error("storage unavailable");
      return originalRemoveItem(key);
    },
  });
  try {
    await mountPool(makeController());
    const reset = host.querySelector('button[aria-label="2 reset credit(s)"]') as HTMLButtonElement;
    await act(async () => { reset.click(); await new Promise(resolve => setTimeout(resolve, 40)); });
    const useCredit = [...host.querySelectorAll("button")].find(button =>
      (button.textContent ?? "").includes("Use 1 Credit"),
    ) as HTMLButtonElement;
    await act(async () => { useCredit.click(); });
    const redeem = [...host.querySelectorAll("button")].find(button =>
      (button.textContent ?? "").trim() === "Use Credit",
    ) as HTMLButtonElement;
    await act(async () => { redeem.click(); await new Promise(resolve => setTimeout(resolve, 40)); });

    expect(consumeAttempts).toBe(1);
    expect(consumedOperationIds).toEqual([operationId]);
    expect(localStorage.getItem(storageKey)).toBe(operationId);
    expect(host.querySelector("dialog")).toBeTruthy();
    expect(host.textContent).toContain("Rate limits reset!");
    expect(host.textContent).toContain("local retry state could not be cleared");
  } finally {
    Object.defineProperty(storage, "removeItem", {
      configurable: true,
      value: originalRemoveItem,
    });
  }
});

test("a pre-upgrade session retry id is durably migrated before redemption", async () => {
  const legacyOperationId = "00000000-0000-4000-8000-000000000777";
  sessionStorage.setItem(
    "ocx.codexResetCreditOperation.v1",
    JSON.stringify({ "pool-1": legacyOperationId }),
  );

  await mountPool(makeController());
  expect(localStorage.getItem("ocx.codexResetCreditOperation.v2.pool-1"))
    .toBe(legacyOperationId);
  expect(sessionStorage.getItem("ocx.codexResetCreditOperation.v1")).toBeNull();

  const reset = host.querySelector('button[aria-label="2 reset credit(s)"]') as HTMLButtonElement;
  await act(async () => { reset.click(); await new Promise(resolve => setTimeout(resolve, 40)); });
  const useCredit = [...host.querySelectorAll("button")].find(button =>
    (button.textContent ?? "").includes("Use 1 Credit"),
  )!;
  await act(async () => { useCredit.click(); });
  const redeem = [...host.querySelectorAll("button")].find(button =>
    (button.textContent ?? "").trim() === "Use Credit",
  )!;
  await act(async () => { redeem.click(); await new Promise(resolve => setTimeout(resolve, 40)); });

  expect(consumeAttempts).toBe(1);
  expect(consumedOperationIds).toEqual([legacyOperationId]);
  expect(localStorage.getItem("ocx.codexResetCreditOperation.v2.pool-1")).toBeNull();
});

test("an identity-changed retry is cleared and the next confirmation mints a fresh id", async () => {
  const staleOperationId = "00000000-0000-4000-8000-000000000778";
  localStorage.setItem("ocx.codexResetCreditOperation.v2.pool-1", staleOperationId);
  const baseFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/codex-auth/reset-credits/consume") {
        consumeAttempts += 1;
        consumedOperationIds.push(
          (JSON.parse(String(init?.body)) as { operationId: string }).operationId,
        );
        return consumeAttempts === 1
          ? Response.json({
              error: "The Codex account identity changed. Confirm a new reset-credit request.",
              code: "reset_credit_operation_identity_changed",
            }, { status: 409 })
          : Response.json({ code: "no_credit" });
      }
      return baseFetch(input, init);
    },
  });
  const redeemOnce = async () => {
    const reset = host.querySelector('button[aria-label="2 reset credit(s)"]') as HTMLButtonElement;
    await act(async () => { reset.click(); await new Promise(resolve => setTimeout(resolve, 40)); });
    const useCredit = [...host.querySelectorAll("button")].find(button =>
      (button.textContent ?? "").includes("Use 1 Credit"),
    ) as HTMLButtonElement;
    await act(async () => { useCredit.click(); });
    const redeem = [...host.querySelectorAll("button")].find(button =>
      (button.textContent ?? "").trim() === "Use Credit",
    ) as HTMLButtonElement;
    await act(async () => { redeem.click(); await new Promise(resolve => setTimeout(resolve, 40)); });
  };

  await mountPool(makeController(), true);
  await redeemOnce();
  expect(consumedOperationIds).toEqual([staleOperationId]);
  expect(localStorage.getItem("ocx.codexResetCreditOperation.v2.pool-1")).toBeNull();
  expect(host.textContent).toContain("Codex account identity changed");

  await redeemOnce();
  expect(consumeAttempts).toBe(2);
  expect(consumedOperationIds[1]).not.toBe(staleOperationId);
  expect(localStorage.getItem("ocx.codexResetCreditOperation.v2.pool-1")).toBeNull();
});

test("a reset-credit consume is refused when its retry identity cannot be stored durably", async () => {
  const storage = localStorage;
  const originalSetItem = storage.setItem.bind(storage);
  Object.defineProperty(storage, "setItem", {
    configurable: true,
    value: () => { throw new Error("storage unavailable"); },
  });
  try {
    await mountPool(makeController());
    const reset = host.querySelector('button[aria-label="2 reset credit(s)"]') as HTMLButtonElement;
    await act(async () => { reset.click(); await new Promise(resolve => setTimeout(resolve, 40)); });
    const useCredit = [...host.querySelectorAll("button")].find(button =>
      (button.textContent ?? "").includes("Use 1 Credit"),
    )!;
    await act(async () => { useCredit.click(); });
    const redeem = [...host.querySelectorAll("button")].find(button =>
      (button.textContent ?? "").trim() === "Use Credit",
    )!;
    await act(async () => { redeem.click(); await new Promise(resolve => setTimeout(resolve, 40)); });

    expect(consumeAttempts).toBe(0);
    expect(host.textContent).toContain("Failed to redeem reset credit");
  } finally {
    Object.defineProperty(storage, "setItem", {
      configurable: true,
      value: originalSetItem,
    });
  }
});
