import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import MainAccountHardLockSetting from "../src/components/MainAccountHardLockSetting";
import { CodexAccountPoolMainCard } from "../src/components/codex-account-pool-main-card";
import CodexSetMultiauth from "../src/pages/codex-set-multiauth";
import type { CodexAccountEntry, MainAccountHardLockStatus } from "../src/hooks/useCodexAccountPool";
import { LanguageProvider } from "../src/i18n/provider";
import { useT } from "../src/i18n/shared";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | null;
let poll: (() => void) | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function settings(enabled: boolean, state: MainAccountHardLockStatus["state"] = enabled ? "ready" : "off") {
  return { codexMainAccountHardLock: enabled, mainAccountHardLock: { enabled, state } };
}
async function flush() {
  await Promise.resolve();
  await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}
function button(host: ParentNode, selector: string): HTMLButtonElement {
  const element = host.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`Missing button: ${selector}`);
  return element;
}
const toggle = (host: ParentNode) => button(host, "#codex-main-hard-lock-setting > .toggle");
const confirm = (host: ParentNode) => button(host, "dialog .btn-primary");
async function click(target: HTMLButtonElement) {
  await act(async () => { target.click(); await flush(); });
}
async function mount(fetchMock: typeof fetch, content: ReactNode = <MainAccountHardLockSetting apiBase="http://proxy" onSaved={async () => true} />) {
  globalThis.fetch = fetchMock;
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider>{content}</LanguageProvider>);
    await flush();
  });
  await act(async () => { await flush(); });
  return host;
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  testWindow = new Window({ url: "http://localhost/#codex-set" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  for (const key of ["document", "window", "navigator", "localStorage"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? testWindow : testWindow[key] });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const original = testWindow.setInterval.bind(testWindow);
  testWindow.setInterval = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (typeof callback === "function") poll = callback as () => void;
    return original(callback, ms, ...args);
  }) as typeof testWindow.setInterval;
  root = null;
  poll = undefined;
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  await testWindow.happyDOM.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});

describe("main account protection setting", () => {
  test("does not guess off while loading; failed reads stay disabled and retryable", async () => {
    const initial = deferred<Response>();
    let reads = 0;
    const host = await mount((async () => ++reads === 1 ? initial.promise : response(settings(true))) as typeof fetch);
    expect(toggle(host).disabled).toBe(true);
    expect(toggle(host).hasAttribute("aria-pressed")).toBe(false);
    await act(async () => { initial.resolve(response({}, 503)); await flush(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
    await click(button(host, '.codex-main-hard-lock-feedback button'));
    expect(toggle(host).disabled).toBe(false);
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
  });

  test.each(["cancel", "escape", "backdrop"])("%s dismisses confirmation without a write and restores focus", async kind => {
    let puts = 0;
    let reloads = 0;
    const host = await mount((async (_input, init) => {
      if (init?.method === "PUT") puts++;
      return response(settings(false));
    }) as typeof fetch, <MainAccountHardLockSetting apiBase="http://proxy" onSaved={async () => { reloads++; return true; }} />);
    toggle(host).focus();
    await click(toggle(host));
    expect(host.querySelector("dialog")?.open).toBe(true);
    expect(host.querySelector("dialog")?.textContent).toContain("Luna Reserve");
    if (kind === "escape") {
      await act(async () => {
        host.querySelector("dialog")!.dispatchEvent(new testWindow.Event("cancel", { cancelable: true }));
      });
    } else await click(button(host, kind === "cancel" ? "dialog .btn-ghost" : ".modal-backdrop-dismiss"));
    expect(host.querySelector("dialog")).toBeNull();
    expect(testWindow.document.activeElement).toBe(toggle(host));
    expect(puts).toBe(0);
    expect(reloads).toBe(0);
  });

  test("Tab and Shift-Tab wrap between confirmation actions without reaching background controls", async () => {
    const host = await mount((async () => response(settings(false))) as typeof fetch);
    await click(toggle(host));
    const cancel = button(host, "dialog .btn-ghost");
    expect(testWindow.document.activeElement).toBe(cancel);
    await act(async () => {
      cancel.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(testWindow.document.activeElement).toBe(confirm(host));
    await act(async () => {
      confirm(host).dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(testWindow.document.activeElement).toBe(cancel);
  });

  test("pending enable cannot be dismissed or duplicated, and is not optimistic", async () => {
    const put = deferred<Response>();
    const bodies: unknown[] = [];
    let reloads = 0;
    const host = await mount((async (_input, init) => {
      if (init?.method === "PUT") { bodies.push(JSON.parse(String(init.body))); return put.promise; }
      return response(settings(false));
    }) as typeof fetch, <MainAccountHardLockSetting apiBase="http://proxy" onSaved={async () => { reloads++; return true; }} />);
    await click(toggle(host));
    act(() => { confirm(host).click(); confirm(host).click(); });
    await act(async () => { host.querySelector("dialog")!.dispatchEvent(new testWindow.Event("cancel", { cancelable: true })); });
    expect(host.querySelector("dialog")?.open).toBe(true);
    expect(toggle(host).getAttribute("aria-pressed")).toBe("false");
    expect(confirm(host).disabled).toBe(true);
    expect(bodies).toEqual([{ codexMainAccountHardLock: true }]);
    expect(reloads).toBe(0);
    await act(async () => { put.resolve(response({ ok: true, ...settings(true, "blocked") })); await flush(); });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector("dialog")).toBeNull();
    expect(testWindow.document.activeElement).toBe(toggle(host));
    expect(reloads).toBe(1);
  });

  test.each([
    { ok: true },
    { ...settings(false) },
    { ok: false, ...settings(false) },
    { ok: true, codexMainAccountHardLock: "false" },
  ])("rejects incomplete acknowledgment %j and re-reads without assuming rollback", async payload => {
    let reads = 0;
    let reloads = 0;
    const host = await mount((async (_input, init) => {
      if (init?.method === "PUT") return response(payload);
      reads++;
      return response(settings(reads === 1));
    }) as typeof fetch, <MainAccountHardLockSetting apiBase="http://proxy" onSaved={async () => { reloads++; return true; }} />);
    await click(toggle(host));
    expect(host.querySelector("dialog")).toBeNull();
    expect(reads).toBe(2);
    expect(toggle(host).getAttribute("aria-pressed")).toBe("false");
    expect(host.textContent).toContain("Could not confirm the save");
    expect(reloads).toBe(0);
  });

  test("a failed PUT never exposes private server detail and preserves a retry path", async () => {
    const reload = deferred<Response>();
    let reads = 0;
    let retry = false;
    const host = await mount((async (_input, init) => {
      if (init?.method === "PUT") return response({ error: "private account detail" }, 500);
      return ++reads === 1 || retry ? response(settings(true)) : reload.promise;
    }) as typeof fetch);
    toggle(host).focus();
    await click(toggle(host));
    expect(toggle(host).disabled).toBe(true);
    expect(testWindow.document.activeElement?.id).toBe("codex-main-hard-lock-setting");
    await act(async () => { reload.resolve(response({}, 503)); await flush(); });
    expect(toggle(host).disabled).toBe(true);
    expect(testWindow.document.activeElement?.id).toBe("codex-main-hard-lock-setting");
    retry = true;
    await click(button(host, '.codex-main-hard-lock-feedback button'));
    expect(testWindow.document.activeElement).toBe(toggle(host));
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
    expect(toggle(host).disabled).toBe(false);
    expect(host.textContent).toContain("Could not confirm the save");
    expect(host.textContent).not.toContain("private account detail");
    expect(button(host, '.codex-main-hard-lock-feedback button').disabled).toBe(false);
  });

  test("a poll failure while confirmation is open does not silently discard confirmation", async () => {
    let reads = 0;
    let puts = 0;
    const host = await mount((async (_input, init) => {
      if (init?.method === "PUT") { puts++; return response({ ok: true, ...settings(true) }); }
      return ++reads === 1 ? response(settings(false)) : response({}, 503);
    }) as typeof fetch);
    await click(toggle(host));
    await act(async () => { poll?.(); await flush(); });
    await click(confirm(host));
    expect(puts).toBe(1);
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector("dialog")).toBeNull();
  });

  test("a fresh zero usage status unlocks without disabling the policy", async () => {
    let reads = 0;
    const host = await mount((async () => response(settings(true, ++reads === 1 ? "blocked" : "ready"))) as typeof fetch);
    await act(async () => { poll?.(); await flush(); });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
    expect(toggle(host).disabled).toBe(false);
  });

  test("successful disable refresh failure is retryable without another PUT", async () => {
    let puts = 0;
    let reloads = 0;
    const host = await mount((async (_input, init) => {
      if (init?.method === "PUT") { puts++; return response({ ok: true, ...settings(false) }); }
      return response(settings(true));
    }) as typeof fetch, <MainAccountHardLockSetting apiBase="http://proxy" onSaved={async () => ++reloads > 1} />);
    await click(toggle(host));
    expect(host.querySelector("dialog")).toBeNull();
    expect(toggle(host).getAttribute("aria-pressed")).toBe("false");
    expect(host.textContent).toContain("Setting saved, but account status");
    expect(host.textContent).not.toContain("Could not confirm the save");
    await click(button(host, '.codex-main-hard-lock-feedback button'));
    expect(puts).toBe(1);
    expect(reloads).toBe(2);
    expect(host.textContent).not.toContain("could not be refreshed");
  });

  test.each(["during", "after"])("stale GET arriving %s PUT cannot restore the old state", async timing => {
    const stale = deferred<Response>();
    const put = deferred<Response>();
    let reads = 0;
    const host = await mount((async (_input, init) => {
      if (init?.method === "PUT") return put.promise;
      return ++reads === 1 ? response(settings(true)) : stale.promise;
    }) as typeof fetch);
    await act(async () => { poll?.(); await flush(); });
    toggle(host).focus();
    await click(toggle(host));
    // Disabled native controls can lose focus; require restoration, not accidental retention.
    host.querySelector<HTMLElement>("#codex-main-hard-lock-setting")!.focus();
    if (timing === "during") await act(async () => { stale.resolve(response(settings(true))); await flush(); });
    await act(async () => { put.resolve(response({ ok: true, ...settings(false) })); await flush(); });
    if (timing === "after") await act(async () => { stale.resolve(response(settings(true))); await flush(); });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("false");
    expect(testWindow.document.activeElement).toBe(toggle(host));
  });
});

function mainAccount(state: MainAccountHardLockStatus["state"]): CodexAccountEntry {
  return { id: "__main__", email: "fixture@example.test", isMain: true, paused: false,
    priority: 0, hasCredential: true, plan: "plus",
    quota: { weeklyPercent: 100, shortPercent: 0, updatedAt: Date.now() },
    quotaAutoRefresh: { fiveHourAvailable: false, weeklyAvailable: false, fiveHourEnabled: false, weeklyEnabled: false },
    mainAccountHardLock: { enabled: state !== "off", state } };
}
function MainCard({ state }: { state: MainAccountHardLockStatus["state"] }) {
  return <CodexAccountPoolMainCard t={useT()} main={mainAccount(state)} isMainActive={false}
    accountModeState="pool" threshold={80} switchActionLabel="Use main" onSwitch={() => {}}
    onTogglePause={() => {}} pauseUpdatingId={null} pauseBusy={false} onPriorityChange={() => {}}
    priorityUpdatingId={null} switchingId={null} onOpenReset={() => {}} />;
}
test.each([
  ["blocked", "Blocked by 99% protection", false],
  ["unknown", "Protection on · usage unknown", true],
  ["ready", "Protection on · monitoring", true],
] as const)("main card uses server %s state, not rounded weekly usage", async (state, label, canSwitch) => {
  const host = await mount((async () => response({})) as typeof fetch, <MainCard state={state} />);
  expect(host.querySelector(".codex-main-hard-lock-status")?.textContent).toContain(label);
  expect(Boolean(host.querySelector(".codex-account-switch"))).toBe(canSwitch);
  testWindow.location.hash = "#providers";
  await click(button(host, ".codex-main-hard-lock-status button"));
  expect(testWindow.location.hash).toBe("#codex-set");
});

test("same-page manage opens Advanced; save refreshes the one injected account controller", async () => {
  let enabled = true;
  let accountReads = 0;
  let forcedReads = 0;
  const host = await mount((async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/settings") {
      if (init?.method === "PUT") enabled = JSON.parse(String(init.body)).codexMainAccountHardLock;
      return response({ ok: true, ...settings(enabled, enabled ? "blocked" : "off"), showCodexSparkQuota: false, codexAccountPickerEnabled: false });
    }
    if (url.pathname === "/api/codex-auth/accounts") {
      accountReads++;
      if (url.searchParams.has("refresh")) forcedReads++;
      return response({ accounts: [mainAccount(enabled ? "blocked" : "off")] });
    }
    if (url.pathname === "/api/codex-auth/active") return response({ activeCodexAccountId: "__main__", autoSwitchThreshold: 80, accountPoolStrategy: "quota", accountPoolStickyLimit: 1 });
    if (url.pathname === "/api/config") return response({ providers: {} });
    return response({});
  }) as typeof fetch, <CodexSetMultiauth apiBase="http://hard-lock-integration" />);
  expect(accountReads).toBe(1);
  expect(host.querySelector("#codex-main-hard-lock-setting")).toBeNull();
  await click(button(host, ".codex-main-hard-lock-status button"));
  expect(button(host, ".codex-auth-advanced__toggle").getAttribute("aria-expanded")).toBe("true");
  expect(testWindow.document.activeElement?.id).toBe("codex-main-hard-lock-setting");
  await click(toggle(host));
  expect(accountReads).toBe(2);
  expect(forcedReads).toBe(0);
  expect(host.querySelector(".codex-main-hard-lock-status")).toBeNull();
  expect(toggle(host).getAttribute("aria-pressed")).toBe("false");
});

test("late proxy A PUT cannot reload A or replace proxy B's parent-owned account status", async () => {
  const pendingPut = deferred<Response>();
  const proxyA = "http://hard-lock-lifetime-a";
  const proxyB = "http://hard-lock-lifetime-b";
  const requests: string[] = [];
  let aEnabled = true;
  const host = await mount((async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    const isA = url.origin === proxyA;
    const enabled = isA ? aEnabled : true;
    const state = isA ? (aEnabled ? "blocked" : "off") : "unknown";
    if (url.pathname === "/api/settings") {
      if (init?.method === "PUT") {
        expect(url.origin).toBe(proxyA);
        expect(JSON.parse(String(init.body))).toEqual({ codexMainAccountHardLock: false });
        return pendingPut.promise;
      }
      return response({ ...settings(enabled, state), showCodexSparkQuota: false, codexAccountPickerEnabled: false });
    }
    if (url.pathname === "/api/codex-auth/accounts") return response({
      accounts: [{ ...mainAccount(state), email: isA ? "proxy-a@example.test" : "proxy-b@example.test" }],
    });
    if (url.pathname === "/api/codex-auth/active") return response({ activeCodexAccountId: "__main__", autoSwitchThreshold: 80, accountPoolStrategy: "quota", accountPoolStickyLimit: 1 });
    if (url.pathname === "/api/config") return response({ providers: {} });
    return response({});
  }) as typeof fetch, <CodexSetMultiauth apiBase={proxyA} />);
  await click(button(host, ".codex-main-hard-lock-status button"));
  await click(toggle(host));
  expect(toggle(host).disabled).toBe(true);
  expect(requests.filter(request => request.startsWith("PUT "))).toHaveLength(1);

  await act(async () => {
    root!.render(<LanguageProvider><CodexSetMultiauth apiBase={proxyB} /></LanguageProvider>);
    await flush();
  });
  await act(async () => { await flush(); });
  expect(host.textContent).toContain("proxy-b@example.test");
  expect(host.textContent).not.toContain("proxy-a@example.test");
  expect(host.querySelector(".codex-main-hard-lock-status")?.textContent).toContain("Protection on · usage unknown");
  const requestsBeforeAck = [...requests];
  aEnabled = false;
  await act(async () => { pendingPut.resolve(response({ ok: true, ...settings(false) })); await flush(); });
  expect(requests).toEqual(requestsBeforeAck);
  expect(host.textContent).toContain("proxy-b@example.test");
  expect(host.textContent).not.toContain("proxy-a@example.test");
  expect(host.querySelector(".codex-main-hard-lock-status")?.textContent).toContain("Protection on · usage unknown");
});

test("collapsing Advanced within the same proxy still refreshes the owner after a delayed save", async () => {
  const pendingPut = deferred<Response>();
  let enabled = true;
  let accountReads = 0;
  const host = await mount((async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/settings") {
      if (init?.method === "PUT") return pendingPut.promise;
      return response({ ...settings(enabled, enabled ? "blocked" : "off"), showCodexSparkQuota: false, codexAccountPickerEnabled: false });
    }
    if (url.pathname === "/api/codex-auth/accounts") {
      accountReads++;
      expect(url.searchParams.has("refresh")).toBe(false);
      return response({ accounts: [mainAccount(enabled ? "blocked" : "off")] });
    }
    if (url.pathname === "/api/codex-auth/active") return response({ activeCodexAccountId: "__main__", autoSwitchThreshold: 80, accountPoolStrategy: "quota", accountPoolStickyLimit: 1 });
    if (url.pathname === "/api/config") return response({ providers: {} });
    return response({});
  }) as typeof fetch, <CodexSetMultiauth apiBase="http://hard-lock-collapsed-owner" />);
  await click(button(host, ".codex-main-hard-lock-status button"));
  await click(toggle(host));
  expect(toggle(host).disabled).toBe(true);
  await click(button(host, ".codex-auth-advanced__toggle"));
  expect(host.querySelector("#codex-main-hard-lock-setting")).toBeNull();
  expect(accountReads).toBe(1);
  enabled = false;
  await act(async () => { pendingPut.resolve(response({ ok: true, ...settings(false) })); await flush(); });
  expect(accountReads).toBe(2);
  expect(host.querySelector(".codex-main-hard-lock-status")).toBeNull();
});
