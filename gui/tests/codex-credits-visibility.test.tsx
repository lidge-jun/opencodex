import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { useCodexCreditsVisibility } from "../src/hooks/useCodexCreditsVisibility";
import { CodexAccountPoolPageHead } from "../src/components/codex-account-pool-main-card";
import CodexAccountPool from "../src/components/CodexAccountPool";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { en } from "../src/i18n/en";
import { I18nContext, interpolate, type TFn } from "../src/i18n/shared";

const t: TFn = (key, vars) => interpolate(en[key], vars);
const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>;
let win: Window;
let host: HTMLElement;
let root: Root;
let unmounted: boolean;
let current: ReturnType<typeof useCodexCreditsVisibility>;
let feedback: Array<[string, string | undefined]>;
let reloads: Array<boolean | undefined>;
let reload: (refresh?: boolean) => Promise<boolean>;
let requests: Array<{ url: string; init?: RequestInit }>;
let respond: (url: string, init?: RequestInit) => Promise<Response>;
function response(payload: unknown, status = 200) { return Response.json(payload, { status }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function Harness({ apiBase, revision = 0 }: { apiBase: string; revision?: number }) {
  current = useCodexCreditsVisibility(apiBase, reload, (message, tone) => { feedback.push([message, tone]); }, t, { revision, onRead: () => {} });
  return <CodexAccountPoolPageHead t={t} embedded={false} refreshingQuota={false} pausingExhausted={false}
    onRefresh={() => {}} onPauseExhausted={() => {}} creditsVisible={current.visible} creditsBusy={current.busy}
    onToggleCredits={() => { void current.toggle(); }} />;
}
async function paint(node: ReactNode) {
  await act(async () => {
    root.render(<I18nContext.Provider value={{ locale: "en", t, setLocale: () => {} }}>{node}</I18nContext.Provider>);
  });
}
async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
function button() { return host.querySelector<HTMLButtonElement>(".codex-auth-credits-toggle button"); }
function writes() { return requests.filter(r => r.init?.method === "PUT"); }

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, localStorage: { configurable: true, value: win.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  requests = []; feedback = []; reloads = []; unmounted = false;
  reload = async refresh => { reloads.push(refresh); return true; };
  respond = async (_url, init) => response({ showCodexCredits: init?.method === "PUT" ? true : false });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    requests.push({ url: String(input), init }); return respond(String(input), init);
  } });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  root = createRoot(host);
});
afterEach(async () => {
  if (!unmounted) await act(async () => { root.unmount(); });
  clearClientResourceStoresForTests();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  await win.happyDOM.close();
});

test("settings stays undefined and switch absent until GET resolves; cleanup aborts the read", async () => {
  const read = deferred<Response>(); respond = () => read.promise;
  await paint(<Harness apiBase="/fixture" />);
  expect(current.visible).toBeUndefined(); expect(button()).toBeNull();
  const signal = requests[0]!.init!.signal!;
  await act(async () => { root.unmount(); }); unmounted = true;
  expect(signal.aborted).toBe(true);
  read.resolve(response({ showCodexCredits: true })); await flush();
  expect(current.visible).toBeUndefined();
});

test.each([response({}, 503), response({}), response({ showCodexCredits: "yes" })])("failed or malformed settings read never guesses a position", async res => {
  respond = async () => res;
  await paint(<Harness apiBase="/fixture" />);
  expect(current.visible).toBeUndefined(); expect(button()).toBeNull();
});

test("labelled toggle is optimistic, serializes writes, reconciles server state, and reloads", async () => {
  const write = deferred<Response>();
  respond = async (_url, init) => init?.method === "PUT" ? write.promise : response({ showCodexCredits: false });
  await paint(<Harness apiBase="/fixture" />);
  expect(button()?.getAttribute("aria-label")).toBe(en["codexAuth.creditsToggle"]);
  expect(button()?.getAttribute("title")).toBe(en["codexAuth.creditsToggleHint"]);
  let pending!: Promise<void>;
  await act(async () => { pending = current.toggle(); void current.toggle(); });
  expect(button()?.getAttribute("aria-pressed")).toBe("true"); expect(button()?.disabled).toBe(true);
  expect(writes()).toHaveLength(1);
  expect(JSON.parse(writes()[0]!.init!.body as string)).toEqual({ showCodexCredits: true });
  await act(async () => { write.resolve(response({ showCodexCredits: false })); await pending; });
  expect(current.visible).toBe(false); expect(current.busy).toBe(false);
  expect(reloads).toEqual([true]); expect(feedback).toEqual([[en["codexAuth.creditsHidden"], "ok"]]);
});

test.each([response({}, 500), response({}), response({ showCodexCredits: "true" })])("rejected or malformed PUT reverts with error feedback", async res => {
  respond = async (_url, init) => init?.method === "PUT" ? res : response({ showCodexCredits: false });
  await paint(<Harness apiBase="/fixture" />);
  await act(async () => { await current.toggle(); });
  expect(current.visible).toBe(false); expect(current.busy).toBe(false);
  expect(reloads).toHaveLength(0); expect(feedback).toEqual([[en["codexAuth.creditsToggleFailed"], "err"]]);
});

test("network failure reverts and allows retry", async () => {
  respond = async (_url, init) => { if (init?.method === "PUT") throw new Error("offline"); return response({ showCodexCredits: false }); };
  await paint(<Harness apiBase="/fixture" />);
  await act(async () => { await current.toggle(); });
  expect(current.visible).toBe(false); expect(current.busy).toBe(false);
  respond = async () => response({ showCodexCredits: true });
  await act(async () => { await current.toggle(); });
  expect(current.visible).toBe(true); expect(reloads).toEqual([true]);
});

test.each([false, "throw"])("successful disable survives account reload failure: %s", async outcome => {
  respond = async (_url, init) => response({ showCodexCredits: init?.method !== "PUT" });
  reload = async () => { if (outcome === "throw") throw new Error("reload"); return false; };
  await paint(<Harness apiBase="/fixture" />);
  await act(async () => { await current.toggle(); });
  expect(current.visible).toBe(false); expect(current.busy).toBe(false);
  expect(feedback).toContainEqual([en["codexAuth.creditsHidden"], "ok"]);
  expect(feedback).toContainEqual([en["codexAuth.quotaRefreshFailed"], "err"]);
});

test("proxy change aborts pending PUT and ignores its stale response", async () => {
  const write = deferred<Response>();
  respond = async (_url, init) => init?.method === "PUT" ? write.promise : response({ showCodexCredits: false });
  await paint(<Harness apiBase="/a" />);
  let pending!: Promise<void>;
  await act(async () => { pending = current.toggle(); });
  const signal = writes()[0]!.init!.signal!;
  await paint(<Harness apiBase="/b" />);
  expect(signal.aborted).toBe(true);
  await act(async () => { write.resolve(response({ showCodexCredits: true })); await pending; });
  expect(current.visible).toBe(false); expect(reloads).toHaveLength(0); expect(feedback).toHaveLength(0);
});

test("returning to a prior proxy still waits for a fresh GET; old reads cannot revive state", async () => {
  const read = deferred<Response>();
  const stale = deferred<Response>();
  await paint(<Harness apiBase="/a" />);
  respond = url => url.startsWith("/a/") ? read.promise : stale.promise;
  await paint(<Harness apiBase="/b" />);
  await paint(<Harness apiBase="/a" />);
  expect(current.visible).toBeUndefined(); expect(button()).toBeNull();
  stale.resolve(response({ showCodexCredits: false }));
  read.resolve(response({ showCodexCredits: true })); await flush();
  expect(current.visible).toBe(true);
});

test("CodexAccountPool hides main and pool rows after disable even when account refresh fails", async () => {
  let accountsOk = true;
  let setting = true;
  const fixture = { email: "fixture@example.test", paused: false, priority: 0, hasCredential: true, quota: null, credits: { balance: "62500" } };
  respond = async (url, init) => {
    if (url.endsWith("/api/settings")) {
      if (init?.method === "PUT") { setting = JSON.parse(init.body as string).showCodexCredits; accountsOk = false; }
      return response({ showCodexCredits: setting, codexQuotaAutoRefresh: {} });
    }
    if (url.includes("/api/codex-auth/accounts")) return accountsOk
      ? response({ accounts: [{ ...fixture, id: "__main__", isMain: true }, { ...fixture, id: "fixture", isMain: false }] })
      : response({}, 503);
    if (url.includes("/api/codex-auth/active")) return response({ activeCodexAccountId: null, autoSwitchThreshold: 80, accountPoolStrategy: "quota-first" });
    return response({ accounts: [], profiles: [] });
  };
  await paint(<CodexAccountPool apiBase="/credits-integration-fixture" />); await flush();
  expect(host.querySelectorAll(".quota-row--codex-credits")).toHaveLength(2);
  await act(async () => { button()!.click(); }); await flush();
  expect(button()?.getAttribute("aria-pressed")).toBe("false");
  expect(host.querySelectorAll(".quota-row--codex-credits")).toHaveLength(0);
  expect(host.textContent).toContain(en["codexAuth.quotaRefreshFailed"]);
});


test("a quota-settings retry cannot cancel a credits write or let its GET overwrite the mutation", async () => {
  const write = deferred<Response>();
  const read = deferred<Response>();
  respond = async (_url, init) => init?.method === "PUT" ? write.promise : response({ showCodexCredits: false });
  await paint(<Harness apiBase="/fixture" />);
  let pending!: Promise<void>;
  await act(async () => { pending = current.toggle(); });
  const signal = writes()[0]!.init!.signal!;
  respond = async (_url, init) => init?.method === "PUT" ? write.promise : read.promise;
  await paint(<Harness apiBase="/fixture" revision={1} />);
  expect(signal.aborted).toBe(false);
  read.resolve(response({ showCodexCredits: false })); await flush();
  expect(current.visible).toBe(true); expect(current.busy).toBe(true);
  await act(async () => { write.resolve(response({ showCodexCredits: true })); await pending; });
  expect(current.visible).toBe(true); expect(current.busy).toBe(false);
});
