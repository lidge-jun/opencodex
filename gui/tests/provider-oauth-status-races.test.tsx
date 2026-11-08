import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useRef, useState, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { useProvidersFetch } from "../src/pages/use-providers-fetch";
import { useProvidersOAuth } from "../src/pages/use-providers-oauth";
import type { OAuthStatus } from "../src/pages/providers-shared";

const keys = ["window", "document", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let saved: Record<string, unknown>;
let win: Window;
let root: Root | undefined;
let host: HTMLElement;
beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "localStorage", "sessionStorage"] as const)
    Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? win : win[key] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = undefined;
  await win.happyDOM.close();
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: saved[key] });
});
async function render(node: ReactNode) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => { root ??= createRoot(host); root.render(node); });
}

test.each(["failed refresh", "late read", "read during logout"] as const)("logout %s fences old status, preserves other providers and recovers a remaining account", async mode => {
  let loader!: ReturnType<typeof useProvidersFetch>;
  let actions!: ReturnType<typeof useProvidersOAuth>;
  let statuses: Record<string, OAuthStatus> = {};
  let releaseLogout!: (r: Response) => void;
  let releaseOld!: (r: Response) => void;
  let started!: () => void;
  const oldStarted = new Promise<void>(resolve => { started = resolve; });
  let phase: "initial" | "during" | "failed" | "recovered" = "initial";
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/oauth/logout") return new Promise<Response>(resolve => { releaseLogout = resolve; });
    if (url.pathname === "/api/oauth/providers") return Response.json({ providers: ["anthropic", "kimi"] });
    if (url.searchParams.get("provider") === "kimi") return Response.json({ loggedIn: true, email: "kimi@example.test" });
    if (phase === "during") { started(); return new Promise<Response>(resolve => { releaseOld = resolve; }); }
    if (phase === "failed") return new Response(null, { status: 503 });
    return Response.json({ loggedIn: true, email: phase === "initial" ? "first@example.test" : "remaining@example.test" });
  } });
  function Harness() {
    const [state, setOauthStatus] = useState<Record<string, OAuthStatus>>({});
    statuses = state;
    const aliveRef = useRef(true);
    loader = useProvidersFetch({ apiBase: "", t: key => key, setConfig: () => {}, setOauthProviders: () => {}, setOauthStatus,
      notify: () => {}, invalidateProviderQuotas: () => {} });
    actions = useProvidersOAuth({ apiBase: "", t: key => key, aliveRef, accountSets: {}, setAccountSets: () => {},
      setBusy: () => {}, setStatus: () => {}, setLoginInfo: () => {}, setOauthStatus,
      invalidateOauthStatusReads: loader.invalidateOauthStatusReads, beginAccountLogout: () => () => {}, notify: () => {},
      fetchConfig: async () => {}, fetchOauth: loader.fetchOauth, fetchAccountSets: async () => {},
      fetchProviderQuotas: async () => {}, bumpModelsRefresh: () => {} });
    return null;
  }
  await render(<Harness />);
  await act(async () => { await loader.fetchOauth(); });
  expect(statuses.anthropic?.email).toBe("first@example.test");
  let logout!: Promise<void>;
  await act(async () => { logout = actions.logoutOAuth("anthropic"); });
  if (mode !== "failed refresh") expect(statuses.anthropic).toBeUndefined();
  expect(statuses.kimi?.email).toBe("kimi@example.test");
  phase = "during";
  let old!: Promise<void>;
  await act(async () => { old = loader.fetchOauth(); await oldStarted; });
  if (mode === "read during logout") {
    expect(loader.invalidateOauthStatusReads("anthropic")).toBe(false);
    await act(async () => { releaseOld(Response.json({ loggedIn: true, email: "first@example.test" })); await old; });
    expect(statuses.anthropic).toBeUndefined();
  }
  phase = "failed";
  await act(async () => { releaseLogout(new Response(null, { status: 200 })); await logout; });
  if (mode === "failed refresh") expect(statuses.anthropic).toBeUndefined();
  if (mode !== "read during logout") await act(async () => { releaseOld(Response.json({ loggedIn: true, email: "first@example.test" })); await old; });
  expect(statuses.anthropic).toBeUndefined();
  expect(statuses.kimi?.email).toBe("kimi@example.test");
  phase = "recovered";
  await act(async () => { await loader.fetchOauth(); });
  expect(statuses.anthropic).toEqual({ loggedIn: true, email: "remaining@example.test" });
});
