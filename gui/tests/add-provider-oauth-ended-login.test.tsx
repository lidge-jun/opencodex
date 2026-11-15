import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useRef } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { useT } from "../src/i18n/shared";
import { en } from "../src/i18n/en";
import { OAUTH_LOGIN_POLL_INTERVAL_MS, useAddProviderOAuth } from "../src/components/use-add-provider-oauth";
import { BROWSER_LOGIN_POLL_ATTEMPTS } from "../src/oauth-login-budget";
import { configureApiTargets } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";

/**
 * #8618: a pasted code whose login already ended (poll budget spent, cancelled) must say the
 * login ended, not that the dashboard target changed. A real target change keeps its own
 * message, and no path posts an old login's code anywhere.
 */

const AUTH_URL = "https://windsurf.test/signin?state=one";
const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let timeoutSpy: ReturnType<typeof spyOn> | undefined;
let statusPolls = 0;
let holdStatus = false;
let heldStatus: Array<() => void> = [];
let heldLogins: Array<() => void> = [];
let holdNextLogin = false;
let cancelled: string[] = [];
let codePosts: Array<{ provider?: string; input?: string }> = [];
let api: ReturnType<typeof useAddProviderOAuth>;
const ui = { manualCodeMsg: "", manualCodeOk: true };

const setters = {
  setOauthBusy: () => {},
  setOauthMsg: () => {},
  setOauthMsgTone: () => {},
  setOauthUrl: () => {},
  setManualCode: () => {},
  setManualCodeMsg: (msg: string) => { ui.manualCodeMsg = msg; },
  setManualCodeOk: (ok: boolean) => { ui.manualCodeOk = ok; },
};
const codeSetters = {
  setManualCodeBusy: () => {},
  setManualCode: () => {},
  setManualCodeOk: (ok: boolean) => { ui.manualCodeOk = ok; },
  setManualCodeMsg: (msg: string) => { ui.manualCodeMsg = msg; },
};

function Harness({ targetKey }: { targetKey?: string }) {
  const t = useT();
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);
  api = useAddProviderOAuth({ apiBase: "", targetKey, t, aliveRef, onAdded: () => {} });
  return null;
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  statusPolls = 0;
  holdStatus = false;
  heldStatus = [];
  heldLogins = [];
  holdNextLogin = false;
  cancelled = [];
  codePosts = [];
  ui.manualCodeMsg = "";
  ui.manualCodeOk = true;
  // The poll interval elapses at once, so a spent budget is reached without waiting minutes.
  const realSetTimeout = globalThis.setTimeout;
  timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === OAUTH_LOGIN_POLL_INTERVAL_MS) {
      queueMicrotask(() => callback(...args));
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/oauth/login" && method === "POST") {
        if (holdNextLogin) {
          holdNextLogin = false;
          await new Promise<void>((resolve) => { heldLogins.push(resolve); });
        }
        return Response.json({ url: AUTH_URL });
      }
      if (url.pathname === "/api/oauth/login/cancel" && method === "POST") {
        cancelled.push(String((JSON.parse(String(init?.body ?? "{}")) as { provider?: string }).provider));
        return Response.json({ ok: true, cancelled: true });
      }
      if (url.pathname === "/api/oauth/login/code" && method === "POST") {
        codePosts.push(JSON.parse(String(init?.body ?? "{}")) as { provider?: string; input?: string });
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/oauth/status") {
        statusPolls++;
        if (holdStatus) await new Promise<void>((resolve) => { heldStatus.push(resolve); });
        return Response.json({ loggedIn: false });
      }
      return Response.json({});
    },
  });
});

afterEach(async () => {
  holdStatus = false;
  for (const release of heldStatus.splice(0)) release();
  for (const release of heldLogins.splice(0)) release();
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  timeoutSpy?.mockRestore();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

async function render(targetKey?: string) {
  configureApiTargets(standaloneApiTargets(""));
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root ??= createRoot(win.document.body as unknown as HTMLElement);
    root.render(<LanguageProvider><Harness targetKey={targetKey} /></LanguageProvider>);
  });
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const submit = () => act(async () => { await api.submitManualCode("devin", "pasted-code", false, codeSetters); });

test("a browser login whose poll budget ran out reports an ended login and posts nothing", async () => {
  await render();
  await act(async () => { await api.loginOAuth("devin", setters); });
  // The add-provider surface keeps the same browser budget as the providers page.
  expect(statusPolls).toBe(BROWSER_LOGIN_POLL_ATTEMPTS);
  expect(cancelled).toEqual(["devin"]);
  await submit();
  expect(ui).toEqual({ manualCodeMsg: en["prov.loginExpired"], manualCodeOk: false });
  expect(codePosts).toEqual([]);
});

test("a cancelled login reports an ended login and posts nothing", async () => {
  holdStatus = true;
  await render();
  void api.loginOAuth("devin", setters);
  await settle();
  await act(async () => { await api.cancelLoginOAuth("devin", setters); });
  await submit();
  expect(ui).toEqual({ manualCodeMsg: en["prov.loginExpired"], manualCodeOk: false });
  expect(codePosts).toEqual([]);
});

test("a login still inside its lifetime accepts the pasted code", async () => {
  holdStatus = true;
  await render();
  void api.loginOAuth("devin", setters);
  await settle();
  await submit();
  expect(codePosts).toEqual([{ provider: "devin", input: "pasted-code" }]);
  expect(ui).toEqual({ manualCodeMsg: en["prov.pasteOk"], manualCodeOk: true });
});

test("a superseded login ending late neither clears nor expires its replacement", async () => {
  holdStatus = true;
  await render();
  holdNextLogin = true;
  void api.loginOAuth("devin", setters);
  await settle();
  void api.loginOAuth("devin", setters);
  await settle();
  // The first login's start answer lands after the replacement took over.
  for (const release of heldLogins.splice(0)) release();
  await settle();
  await submit();
  expect(codePosts).toEqual([{ provider: "devin", input: "pasted-code" }]);
  expect(ui.manualCodeMsg).toBe(en["prov.pasteOk"]);
});

test("a real target change still reports the target change and posts nothing", async () => {
  holdStatus = true;
  await render("hub-a");
  void api.loginOAuth("devin", setters);
  await settle();
  await render("hub-b");
  await submit();
  expect(ui).toEqual({ manualCodeMsg: en["prov.targetChanged"], manualCodeOk: false });
  expect(codePosts).toEqual([]);
});

test("a login that ended before a target change reports the target change", async () => {
  await render("hub-a");
  await act(async () => { await api.loginOAuth("devin", setters); });
  await render("hub-b");
  await submit();
  expect(ui).toEqual({ manualCodeMsg: en["prov.targetChanged"], manualCodeOk: false });
  expect(codePosts).toEqual([]);
});

