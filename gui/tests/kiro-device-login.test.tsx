import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createRef, useEffect, useRef } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import KiroDeviceLoginDialog from "../src/components/KiroDeviceLoginDialog";
import { useKiroDeviceLogin } from "../src/components/use-kiro-device-login";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import type { ProviderAuthHandlers } from "../src/components/provider-workspace/types";
import { en } from "../src/i18n/en";
import { interpolate, type TFn } from "../src/i18n/shared";
import { useProvidersOAuth } from "../src/pages/use-providers-oauth";
import { finalizeKiroDeviceFlow } from "../src/kiro-device-login-finalizer";
import { subscribeKiroDeviceFinal } from "../src/kiro-device-login-finalizer";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null;
let requests: { url: string; init?: RequestInit }[];
let responder: (url: string, init?: RequestInit) => Promise<Response>;
let ticks: (() => void)[];
let settled: string[];
let closed: number;
let flowCounter = 0;
let flowId = "";
const view = (state: string, extra: Record<string, unknown> = {}) => ({ flowId, method: "builder-id", state, expiresAt: Date.now() + 60_000, userCode: "ABCD-1234", verificationUri: "https://kiro.dev/verify", ...extra });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const pollDelay = () => new Promise<void>(resolve => { ticks.push(resolve); });
const flush = async () => { await act(async () => { await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); }); };

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, localStorage: { configurable: true, value: win.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  Object.defineProperty(win.HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
  Object.defineProperty(win.HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
  requests = []; ticks = []; settled = []; closed = 0; root = null; flowId = `flow-${++flowCounter}`;
  responder = async (url, init) => {
    if (url.endsWith("/api/oauth/login") && init?.method === "POST") return json(view("pending"));
    if (url.includes("/api/oauth/status?")) return json(view("done"));
    if (url.endsWith("/api/oauth/login/cancel")) return json(view("cancelled"));
    return json({});
  };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init?: RequestInit) => {
    requests.push({ url, init }); return responder(url, init);
  } });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); root = null; });
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  await win.happyDOM.close();
});

async function mountDialog(delay: (ms: number, signal: AbortSignal) => Promise<void> = pollDelay) {
  const { createRoot } = await import("react-dom/client");
  const triggerRef = createRef<HTMLButtonElement>();
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><button ref={triggerRef}>Trigger</button><KiroDeviceLoginDialog
      apiBase="" triggerRef={triggerRef} addAccount={false} busy={false} onCli={() => {}}
      onClose={() => { closed++; }} onSettled={(_, outcome) => { settled.push(outcome); }} pollDelay={delay} /></LanguageProvider>);
  });
}
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
  expect(button).toBeTruthy();
  await act(async () => { button!.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  await flush();
}
async function start() { await click("Builder ID"); expect(requests.find(r => r.url.endsWith("/api/oauth/login"))?.init?.body).toBe(JSON.stringify({ provider: "kiro", method: "builder-id" })); }
async function tick() { expect(ticks.length).toBeGreaterThan(0); await act(async () => { ticks.shift()!(); }); await flush(); }
function expectCancelBeforeStatus() {
  const cancelIndex = requests.findIndex(r => r.url.endsWith("/api/oauth/login/cancel")
    && JSON.parse(String(r.init?.body)).flowId === flowId);
  const statusIndex = requests.findIndex(r => r.url.includes(`/api/oauth/status?provider=kiro&flowId=${flowId}`));
  expect(cancelIndex).toBeGreaterThanOrEqual(0);
  expect(statusIndex).toBeGreaterThan(cancelIndex);
}

test("chooser starts native login, shows code and safe link, then confirms done", async () => {
  await mountDialog(); await start();
  expect(host.textContent).toContain("ABCD-1234");
  expect(host.querySelector('a[href="https://kiro.dev/verify"]')?.getAttribute("target")).toBe("_blank");
  await tick();
  expect(settled).toEqual(["added"]);
  expect(host.textContent).toContain("Kiro account added");
});

test("unknown verification host is copyable text, not a link; warning is visible", async () => {
  responder = async url => url.endsWith("/api/oauth/login") ? json(view("pending", { verificationUri: "https://x.awsapps.com/", warning: "duplicate_profile_arn" })) : json(view("cancelled"));
  await mountDialog(); await start();
  expect(host.querySelector('a[href*="awsapps"]')).toBeNull();
  expect(host.textContent).toContain("https://x.awsapps.com/");
  expect(host.textContent).toContain("already in the account list");
});

test("lost terminal reply becomes neutral and refreshes roster", async () => {
  responder = async url => url.includes("/api/oauth/status?") ? json({ error: "unknown login flow" }, 404) : json(view("pending"));
  await mountDialog(); await start(); await tick();
  expect(settled).toEqual(["ended"]);
  expect(host.textContent).toContain("Check the account list");
});

test("cancel posts flowId and provisional done is finalized by status", async () => {
  responder = async url => url.endsWith("/api/oauth/login/cancel") ? json(view("done")) : url.includes("/api/oauth/status?") ? json(view("done")) : json(view("pending"));
  const received: string[] = [];
  const unsubscribe = subscribeKiroDeviceFinal("", outcome => received.push(outcome));
  await mountDialog(); await start(); await click("Cancel");
  expect(JSON.parse(String(requests.find(r => r.url.endsWith("/api/oauth/login/cancel"))?.init?.body))).toEqual({ provider: "kiro", flowId });
  await flush();
  expect(received).toEqual(["added"]);
  unsubscribe();
});

test("provisional cancel done followed by failed status reports failure", async () => {
  responder = async url => url.endsWith("/api/oauth/login/cancel") ? json(view("done")) : url.includes("/api/oauth/status?") ? json(view("failed")) : json(view("pending"));
  const received: string[] = [];
  const unsubscribe = subscribeKiroDeviceFinal("", outcome => received.push(outcome));
  await mountDialog(); await start(); await click("Cancel"); await flush();
  expect(received).toEqual(["failed"]);
  unsubscribe();
});

test("close during unresolved start cancels returned flow", async () => {
  const pending = deferred<Response>();
  responder = async url => url.endsWith("/api/oauth/login") ? pending.promise : json(view("cancelled"));
  await mountDialog(); await click("Builder ID"); await click("Cancel");
  await act(async () => { pending.resolve(json(view("pending"))); }); await flush();
  expect(requests.some(r => r.url.endsWith("/api/oauth/login/cancel"))).toBe(true);
});

test("rapid starts create one request; Escape cancels", async () => {
  const pending = deferred<Response>();
  responder = async url => url.endsWith("/api/oauth/login") ? pending.promise : json(view("cancelled"));
  await mountDialog(); await click("Builder ID");
  const dialog = host.querySelector("dialog")!;
  await act(async () => { dialog.dispatchEvent(new win.Event("cancel", { cancelable: true, bubbles: true })); });
  await act(async () => { pending.resolve(json(view("pending"))); }); await flush();
  expect(closed).toBe(1);
  expect(requests.filter(r => r.url.endsWith("/api/oauth/login"))).toHaveLength(1);
});

test("panel Kiro Login offers CLI method, while other providers keep old login", async () => {
  const { createRoot } = await import("react-dom/client");
  const calls: string[] = [];
  const handlers: ProviderAuthHandlers = {
    onLogin: (provider, add) => { calls.push(`${provider}:${Boolean(add)}`); }, onLogout: () => {}, onReauth: () => {},
    onSwitchAccount: () => {}, onRemoveAccount: () => {}, onAddApiKey: async () => true,
    onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
  };
  const item = (name: string): WorkspaceItem => ({ name, adapter: name, baseUrl: "https://example.com", authMode: "oauth" });
  await act(async () => { root = createRoot(host); root.render(<LanguageProvider><ProviderAuthPanel item={item("kiro")} apiBase="" authHandlers={handlers} /></LanguageProvider>); });
  await click("Login"); expect(host.textContent).toContain("Builder ID"); await click("Kiro CLI");
  expect(calls).toEqual(["kiro:false"]);
  await act(async () => { root!.render(<LanguageProvider><ProviderAuthPanel item={item("claude")} apiBase="" authHandlers={handlers} /></LanguageProvider>); });
  await click("Login"); expect(calls).toEqual(["kiro:false", "claude:false"]);
});

test("unmount during an unresolved start cancels the returned flow", async () => {
  const pending = deferred<Response>();
  responder = async url => url.endsWith("/api/oauth/login") ? pending.promise : json(view("cancelled"));
  await mountDialog(); await click("Builder ID");
  await act(async () => { root!.unmount(); root = null; });
  await act(async () => { pending.resolve(json(view("pending"))); }); await flush();
  expect(requests.some(r => r.url.endsWith("/api/oauth/login/cancel") && String(r.init?.body).includes(flowId))).toBe(true);
});

test("a pending status reply arriving after cancel cannot reopen the dialog", async () => {
  const pending = deferred<Response>();
  responder = async url => url.includes("/api/oauth/status?") ? pending.promise : url.endsWith("/api/oauth/login/cancel") ? json(view("cancelled")) : json(view("pending"));
  await mountDialog(); await start();
  await act(async () => { ticks.shift()!(); });
  await click("Cancel");
  await act(async () => { pending.resolve(json(view("pending"))); }); await flush();
  expect(host.textContent).not.toContain("Enter this code on the verification page");
  expect(settled).toEqual([]);
});

test("closing chooser returns focus to the trigger", async () => {
  const { createRoot } = await import("react-dom/client");
  const handlers: ProviderAuthHandlers = {
    onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {}, onRemoveAccount: () => {},
    onAddApiKey: async () => true, onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
  };
  await act(async () => { root = createRoot(host); root.render(<LanguageProvider><ProviderAuthPanel
    item={{ name: "kiro", adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth" }}
    apiBase="" authHandlers={handlers} /></LanguageProvider>); });
  await click("Login"); await click("Cancel");
  expect((win.document.activeElement as HTMLElement).textContent?.trim()).toBe("Login");
});

test("finalizer failed subscriber reloads accounts and shows failure without success reveal", async () => {
  const { createRoot } = await import("react-dom/client");
  const notices: { text: string; ok: boolean }[] = [];
  let reloads = 0;
  let reveals = 0;
  let handler: ((provider: string, outcome: "added" | "ended" | "failed") => Promise<void>) | undefined;
  const t: TFn = (key, vars) => interpolate(en[key], vars);
  function Harness() {
    const aliveRef = useRef(true);
    const oauth = useProvidersOAuth({
      apiBase: "", t, aliveRef, accountSets: {}, setAccountSets: () => {}, setBusy: () => {}, setStatus: () => {},
      setLoginInfo: () => {}, setOauthStatus: () => {}, notify: (text, ok) => { notices.push({ text, ok }); },
      fetchConfig: async () => {}, fetchOauth: async () => {}, fetchAccountSets: async () => { reloads++; },
      fetchProviderQuotas: async () => {}, bumpModelsRefresh: () => {}, onLoginSettled: () => { reveals++; },
    });
    useEffect(() => { handler = oauth.onNativeLoginSettled; });
    return null;
  }
  await act(async () => { root = createRoot(host); root.render(<Harness />); });
  const unsubscribe = subscribeKiroDeviceFinal("", outcome => { void handler?.("kiro", outcome); });
  responder = async url => url.includes("/api/oauth/status?") ? json(view("failed")) : json({});
  await act(async () => { await finalizeKiroDeviceFlow("", flowId, Date.now() + 10_000); });
  await flush();
  expect(reloads).toBe(1);
  expect(reveals).toBe(0);
  expect(notices).toHaveLength(1);
  expect(notices[0]?.ok).toBe(false);
  expect(notices[0]?.text).toContain("login error");
  unsubscribe();
});

test("Kiro row chips render only exclusions not already shown by health", async () => {
  const { createRoot } = await import("react-dom/client");
  const handlers: ProviderAuthHandlers = {
    onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {}, onRemoveAccount: () => {},
    onAddApiKey: async () => true, onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
  };
  const accounts = [
    { id: "suspended", active: true, autoSelectable: false, skipReason: "suspended" as const },
    { id: "quota", active: false, autoSelectable: false, skipReason: "quota_exhausted" as const },
    { id: "reauth", active: false, autoSelectable: false, skipReason: "needs_reauth" as const, needsReauth: true },
    { id: "cooldown", active: false, autoSelectable: false, skipReason: "cooldown" as const, health: { status: "cooldown" as const } },
  ];
  await act(async () => { root = createRoot(host); root.render(<LanguageProvider><ProviderAuthPanel
    item={{ name: "kiro", adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth" }}
    apiBase="" authHandlers={handlers} accounts={accounts} /></LanguageProvider>); });
  expect(host.textContent).toContain("Not auto-selected: suspended");
  expect(host.textContent).toContain("Not auto-selected: quota exhausted");
  expect(host.textContent).not.toContain("Not auto-selected: cooling down");
  expect(host.querySelectorAll(".badge-amber").length).toBeGreaterThan(0);
});

test("start errors stay visible without exposing server error data", async () => {
  responder = async url => url.endsWith("/api/oauth/login") ? json({ error: "internal detail" }, 409) : json(view("cancelled"));
  await mountDialog(); await click("Builder ID");
  expect(host.textContent).toContain("Could not start Kiro sign-in");
  expect(host.textContent).not.toContain("internal detail");
});

test("manual review warning is shown without retaining unknown response fields", async () => {
  responder = async url => url.endsWith("/api/oauth/login") ? json(view("pending", { warning: "manual_review_required", token: "private" })) : json(view("cancelled"));
  await mountDialog(); await start();
  expect(host.textContent).toContain("Manual review may be needed");
  expect(host.textContent).not.toContain("private");
});

test("cancel 404 produces neutral ended outcome", async () => {
  responder = async url => url.endsWith("/api/oauth/login/cancel") || url.includes("/api/oauth/status?")
    ? json({ error: "unknown login flow" }, 404) : json(view("pending"));
  const received: string[] = [];
  const unsubscribe = subscribeKiroDeviceFinal("", outcome => received.push(outcome));
  await mountDialog(); await start(); await click("Cancel"); await flush();
  expect(received).toEqual(["ended"]);
  unsubscribe();
});

test("a terminal status already in flight wins after cancel", async () => {
  const pending = deferred<Response>();
  responder = async url => url.includes("/api/oauth/status?") ? pending.promise
    : url.endsWith("/api/oauth/login/cancel") ? json(view("done")) : json(view("pending"));
  const received: string[] = [];
  const unsubscribe = subscribeKiroDeviceFinal("", outcome => received.push(outcome));
  await mountDialog(); await start();
  await act(async () => { ticks.shift()!(); });
  await click("Cancel");
  await act(async () => { pending.resolve(json(view("done"))); }); await flush();
  expect(received).toEqual(["added"]);
  unsubscribe();
});

test("two rapid native starts dispatch only one POST", async () => {
  const { createRoot } = await import("react-dom/client");
  const pending = deferred<Response>();
  responder = async url => url.endsWith("/api/oauth/login") ? pending.promise : json(view("cancelled"));
  let startLogin: ((method: "builder-id" | "google" | "github") => Promise<void>) | undefined;
  function Harness() {
    const login = useKiroDeviceLogin("", undefined, pollDelay);
    useEffect(() => { startLogin = login.start; });
    return null;
  }
  await act(async () => { root = createRoot(host); root.render(<Harness />); });
  await act(async () => { void startLogin?.("builder-id"); void startLogin?.("github"); });
  expect(requests.filter(r => r.url.endsWith("/api/oauth/login"))).toHaveLength(1);
  await act(async () => { root!.unmount(); root = null; pending.resolve(json(view("pending"))); });
  await flush();
});

test("a hung cancel cannot block detached status reconciliation", async () => {
  const never = deferred<Response>();
  responder = async url => url.endsWith("/api/oauth/login/cancel") ? never.promise
    : url.includes("/api/oauth/status?") ? json(view("done")) : json(view("pending"));
  const received: string[] = [];
  const unsubscribe = subscribeKiroDeviceFinal("", outcome => received.push(outcome));
  await mountDialog(); await start(); await click("Cancel"); await flush();
  expectCancelBeforeStatus();
  expect(received).toEqual(["added"]);
  unsubscribe();
});

test("close during start dispatches cancel before detached status", async () => {
  const pendingStart = deferred<Response>();
  const neverCancel = deferred<Response>();
  responder = async url => url.endsWith("/api/oauth/login") ? pendingStart.promise
    : url.endsWith("/api/oauth/login/cancel") ? neverCancel.promise
      : url.includes("/api/oauth/status?") ? json(view("done")) : json({});
  const received: string[] = [];
  const unsubscribe = subscribeKiroDeviceFinal("", outcome => received.push(outcome));
  await mountDialog(); await click("Builder ID"); await click("Cancel");
  await act(async () => { pendingStart.resolve(json(view("pending"))); }); await flush();
  expectCancelBeforeStatus();
  expect(received).toEqual(["added"]);
  unsubscribe();
});

test("close during status body parsing leaves finalizer as sole outcome owner", async () => {
  const body = deferred<unknown>();
  let readingBody = false;
  responder = async url => {
    if (url.includes("/api/oauth/status?")) {
      const response = json(view("done"));
      Object.defineProperty(response, "json", { value: () => { readingBody = true; return body.promise; } });
      return response;
    }
    return url.endsWith("/api/oauth/login/cancel") ? json(view("cancelled")) : json(view("pending"));
  };
  const received: string[] = [];
  const unsubscribe = subscribeKiroDeviceFinal("", outcome => received.push(outcome));
  await mountDialog(); await start();
  await act(async () => { ticks.shift()!(); }); await flush();
  expect(readingBody).toBe(true);
  await act(async () => { root!.unmount(); root = null; });
  await flush();
  expect(received).toEqual(["added"]);
  await act(async () => { body.resolve(view("done")); }); await flush();
  expect(settled).toEqual([]);
  expect(received).toEqual(["added"]);
  unsubscribe();
});

test("closing aborts the pending timer and never dispatches a hook status fetch", async () => {
  let waitSignal: AbortSignal | undefined;
  const cancellableDelay = (_ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    waitSignal = signal;
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  responder = async url => url.includes("/api/oauth/status?") ? json(view("done"))
    : url.endsWith("/api/oauth/login/cancel") ? json(view("cancelled")) : json(view("pending"));
  await mountDialog(cancellableDelay); await start();
  expect(waitSignal?.aborted).toBe(false);
  await click("Cancel"); await flush();
  expect(waitSignal?.aborted).toBe(true);
  // The one status GET belongs to the detached finalizer. The cancelled hook
  // delay cannot send a second GET after close.
  expect(requests.filter(r => r.url.includes("/api/oauth/status?"))).toHaveLength(1);
});

test("native outcomes remain visible when roster reload rejects", async () => {
  const { createRoot } = await import("react-dom/client");
  const notices: { text: string; ok: boolean }[] = [];
  let reloads = 0;
  let reveals = 0;
  let configReads = 0;
  let quotaReads = 0;
  let modelRefreshes = 0;
  let handler: ((provider: string, outcome: "added" | "ended" | "failed") => Promise<void>) | undefined;
  const t: TFn = (key, vars) => interpolate(en[key], vars);
  function Harness() {
    const aliveRef = useRef(true);
    const oauth = useProvidersOAuth({
      apiBase: "", t, aliveRef, accountSets: {}, setAccountSets: () => {}, setBusy: () => {}, setStatus: () => {},
      setLoginInfo: () => {}, setOauthStatus: () => {}, notify: (text, ok) => { notices.push({ text, ok }); },
      fetchConfig: async () => { configReads++; }, fetchOauth: async () => {},
      fetchAccountSets: async () => { reloads++; throw new Error("roster unavailable"); },
      fetchProviderQuotas: async () => { quotaReads++; }, bumpModelsRefresh: () => { modelRefreshes++; },
      onLoginSettled: () => { reveals++; },
    });
    useEffect(() => { handler = oauth.onNativeLoginSettled; });
    return null;
  }
  await act(async () => { root = createRoot(host); root.render(<Harness />); });
  await act(async () => { await handler?.("kiro", "added"); });
  await flush();
  expect(notices.at(-1)).toMatchObject({ ok: true });
  expect(notices.at(-1)?.text).toContain("Logged in to kiro");
  expect(reveals).toBe(1);
  await act(async () => { await handler?.("kiro", "failed"); });
  await flush();
  expect(notices.at(-1)).toMatchObject({ ok: false });
  expect(notices.at(-1)?.text).toContain("login error");
  expect(reveals).toBe(1);
  expect(reloads).toBe(2);
  expect(configReads).toBe(2);
  expect(quotaReads).toBe(2);
  expect(modelRefreshes).toBe(2);
});
