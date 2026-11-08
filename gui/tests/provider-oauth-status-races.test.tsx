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

test.each(["success", "partial", "failure", "network"] as const)("account deletion %s fences status and recovers after settlement", async outcome => {
  const dialogs = await import("../src/action-dialogs");
  const { spyOn } = await import("bun:test");
  const { useProviderAccountPools } = await import("../src/hooks/useProviderAccountPools");
  const consent = spyOn(dialogs, "confirmAction").mockResolvedValue(true);
  let loader!: ReturnType<typeof useProvidersFetch>;
  let pools!: ReturnType<typeof useProviderAccountPools>;
  let statuses: Record<string, OAuthStatus> = {};
  let releaseDelete!: (r: Response) => void;
  let rejectDelete!: (e: Error) => void;
  let releaseOld!: (r: Response) => void;
  let releaseDuring!: (r: Response) => void;
  let started!: () => void;
  let duringStarted!: () => void;
  const oldStarted = new Promise<void>(resolve => { started = resolve; });
  const duringReady = new Promise<void>(resolve => { duringStarted = resolve; });
  let held = 0;
  let phase: "initial" | "during" | "failed" | "recovered" = "initial";
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "DELETE") return new Promise<Response>((resolve, reject) => { releaseDelete = resolve; rejectDelete = reject; });
    if (url.pathname === "/api/oauth/providers") return Response.json({ providers: ["anthropic", "kimi"] });
    if (url.pathname === "/api/oauth/accounts") return Response.json({ activeAccountId: null, accounts: [] });
    if (url.searchParams.get("provider") === "kimi") return Response.json({ loggedIn: true, email: "kimi@example.test" });
    if (phase === "during") return new Promise<Response>(resolve => {
      if (held++ === 0) { releaseOld = resolve; started(); }
      else { releaseDuring = resolve; duringStarted(); }
    });
    if (phase === "failed") return new Response(null, { status: 503 });
    return Response.json({ loggedIn: true, email: phase === "initial" ? "first@example.test" : "remaining@example.test" });
  } });
  function Harness() {
    const [state, setOauthStatus] = useState<Record<string, OAuthStatus>>({});
    statuses = state;
    const aliveRef = useRef(true);
    loader = useProvidersFetch({ apiBase: "", t: key => key, setConfig: () => {}, setOauthProviders: () => {}, setOauthStatus,
      notify: () => {}, invalidateProviderQuotas: () => {} });
    pools = useProviderAccountPools({ apiBase: "", config: null, aliveRef, t: key => key, oauthStatus: state, notify: () => {},
      fetchConfig: async () => {}, fetchOauth: loader.fetchOauth, fetchProviderQuotas: async () => {}, codexActiveNeedsReauth: false,
      invalidateOauthStatusReads: loader.invalidateOauthStatusReads, setOauthStatus });
    return null;
  }
  try {
    await render(<Harness />);
    await act(async () => { await loader.fetchOauth(); });
    let old!: Promise<void>;
    phase = "during";
    await act(async () => { old = loader.fetchOauth(); await oldStarted; });
    let deletion!: Promise<void>;
    await act(async () => { deletion = pools.removeAccount("anthropic", { id: "a", active: true }); await Promise.resolve(); });
    expect(statuses.anthropic).toBeUndefined();
    expect(statuses.kimi?.email).toBe("kimi@example.test");
    let during!: Promise<void>;
    await act(async () => { during = loader.fetchOauth(); await duringReady; });
    if (outcome === "success") {
      await act(async () => { releaseDuring(Response.json({ loggedIn: true, email: "first@example.test" })); await during; });
      expect(statuses.anthropic).toBeUndefined();
    }
    phase = "failed";
    await act(async () => {
      if (outcome === "network") rejectDelete(new Error("offline"));
      else releaseDelete(outcome === "success" ? Response.json({}) : outcome === "partial"
        ? Response.json({ code: "affinity_reset_not_persisted", retryable: true, deletionCommitted: true }, { status: 503 })
        : new Response(null, { status: 500 }));
      await deletion;
      releaseOld(Response.json({ loggedIn: true, email: "first@example.test" })); await old;
      if (outcome !== "success") { releaseDuring(Response.json({ loggedIn: true, email: "first@example.test" })); await during; }
    });
    expect(statuses.anthropic).toBeUndefined();
    phase = "recovered";
    await act(async () => { await loader.fetchOauth(); });
    expect(statuses.anthropic?.email).toBe("remaining@example.test");
    expect(statuses.kimi?.email).toBe("kimi@example.test");
  } finally { consent.mockRestore(); }
});

test("a deletion settling after a target change cannot clear or refresh the new target", async () => {
  const dialogs = await import("../src/action-dialogs");
  const { spyOn } = await import("bun:test");
  const { useProviderAccountPools } = await import("../src/hooks/useProviderAccountPools");
  const consent = spyOn(dialogs, "confirmAction").mockResolvedValue(true);
  let loader!: ReturnType<typeof useProvidersFetch>;
  let pools!: ReturnType<typeof useProviderAccountPools>;
  let statuses: Record<string, OAuthStatus> = {};
  let release!: (response: Response) => void;
  const requests: string[] = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    requests.push(url.pathname);
    if (init?.method === "DELETE") return new Promise<Response>(resolve => { release = resolve; });
    if (url.pathname.endsWith("/api/oauth/providers")) return Response.json({ providers: ["anthropic"] });
    if (url.pathname.endsWith("/api/oauth/status")) return Response.json({ loggedIn: true, email: url.pathname.startsWith("/new") ? "new@example.test" : "old@example.test" });
    return Response.json({ activeAccountId: null, accounts: [] });
  } });
  function Harness({ base }: { base: string }) {
    const [state, setOauthStatus] = useState<Record<string, OAuthStatus>>({});
    statuses = state;
    const aliveRef = useRef(true);
    loader = useProvidersFetch({ apiBase: base, t: key => key, setConfig: () => {}, setOauthProviders: () => {}, setOauthStatus,
      notify: () => {}, invalidateProviderQuotas: () => {} });
    pools = useProviderAccountPools({ apiBase: base, config: null, aliveRef, t: key => key, oauthStatus: state, notify: () => {},
      fetchConfig: async () => {}, fetchOauth: loader.fetchOauth, fetchProviderQuotas: async () => {}, codexActiveNeedsReauth: false,
      invalidateOauthStatusReads: loader.invalidateOauthStatusReads, setOauthStatus });
    return null;
  }
  try {
    await render(<Harness base="/old" />);
    await act(async () => { await loader.fetchOauth(); });
    let deletion!: Promise<void>;
    await act(async () => { deletion = pools.removeAccount("anthropic", { id: "a", active: true }); await Promise.resolve(); });
    await render(<Harness base="/new" />);
    await act(async () => { await loader.fetchOauth(); });
    expect(statuses.anthropic?.email).toBe("new@example.test");
    const oldReads = requests.filter(path => path === "/old/api/oauth/providers").length;
    await act(async () => { release(Response.json({})); await deletion; });
    expect(statuses.anthropic?.email).toBe("new@example.test");
    expect(requests.filter(path => path === "/old/api/oauth/providers")).toHaveLength(oldReads);
  } finally { consent.mockRestore(); }
});
