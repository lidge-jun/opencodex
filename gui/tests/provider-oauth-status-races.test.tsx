import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { useProvidersFetch } from "../src/pages/use-providers-fetch";
import { useProvidersOAuth } from "../src/pages/use-providers-oauth";
import type { OAuthStatus } from "../src/pages/providers-shared";
import { configureApiTargets } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";

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
    const aliveRef = useRef(true);
    const loaderController = useProvidersFetch({ apiBase: "", t: key => key, setConfig: () => {}, setOauthProviders: () => {}, setOauthStatus,
      notify: () => {}, invalidateProviderQuotas: () => {} });
    const actionsController = useProvidersOAuth({ apiBase: "", t: key => key, aliveRef, accountSets: {}, setAccountSets: () => {},
      setBusy: () => {}, setStatus: () => {}, setLoginInfo: () => {}, setOauthStatus,
      invalidateOauthStatusReads: loaderController.invalidateOauthStatusReads, beginAccountLogout: () => () => {}, notify: () => {},
      fetchConfig: async () => {}, fetchOauth: loaderController.fetchOauth, fetchAccountSets: async () => {},
      fetchProviderQuotas: async () => {}, bumpModelsRefresh: () => {} });
    // Publish after commit: a render-phase write of a hook result into a module binding is
    // what the compiler rejects, and the test body only reads it after act().
    useLayoutEffect(() => { statuses = state; loader = loaderController; actions = actionsController; });
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
    const aliveRef = useRef(true);
    const loaderController = useProvidersFetch({ apiBase: "", t: key => key, setConfig: () => {}, setOauthProviders: () => {}, setOauthStatus,
      notify: () => {}, invalidateProviderQuotas: () => {} });
    const poolsController = useProviderAccountPools({ apiBase: "", config: null, aliveRef, t: key => key, oauthStatus: state, notify: () => {},
      fetchConfig: async () => {}, fetchOauth: loaderController.fetchOauth, fetchProviderQuotas: async () => {}, codexActiveNeedsReauth: false,
      invalidateOauthStatusReads: loaderController.invalidateOauthStatusReads, setOauthStatus });
    useLayoutEffect(() => { statuses = state; loader = loaderController; pools = poolsController; });
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
    const aliveRef = useRef(true);
    const loaderController = useProvidersFetch({ apiBase: base, t: key => key, setConfig: () => {}, setOauthProviders: () => {}, setOauthStatus,
      notify: () => {}, invalidateProviderQuotas: () => {} });
    const poolsController = useProviderAccountPools({ apiBase: base, config: null, aliveRef, t: key => key, oauthStatus: state, notify: () => {},
      fetchConfig: async () => {}, fetchOauth: loaderController.fetchOauth, fetchProviderQuotas: async () => {}, codexActiveNeedsReauth: false,
      invalidateOauthStatusReads: loaderController.invalidateOauthStatusReads, setOauthStatus });
    useLayoutEffect(() => { statuses = state; loader = loaderController; pools = poolsController; });
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

test("a login status read predating account deletion cannot restore the deleted identity", async () => {
  const { spyOn } = await import("bun:test");
  const dialogs = await import("../src/action-dialogs");
  const { useProviderAccountPools } = await import("../src/hooks/useProviderAccountPools");
  const consent = spyOn(dialogs, "confirmAction").mockResolvedValue(true);
  const oldStatus = Promise.withResolvers<Response>();
  const statusStarted = Promise.withResolvers<void>();
  const freshStatus = Promise.withResolvers<Response>();
  const freshStarted = Promise.withResolvers<void>();
  let statusReads = 0;
  let statuses: Record<string, OAuthStatus> = {};
  const events: string[] = [];
  let actions!: ReturnType<typeof useProvidersOAuth>;
  let pools!: ReturnType<typeof useProviderAccountPools>;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    events.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/oauth/login") return Response.json({ url: "https://example.test/login" });
    if (url.pathname === "/api/oauth/status") {
      if (statusReads++ === 0) { statusStarted.resolve(); return oldStatus.promise; }
      freshStarted.resolve(); return freshStatus.promise;
    }
    if (url.pathname === "/api/oauth/providers") return Response.json({ providers: [] });
    if (init?.method === "DELETE") return Response.json({});
    return Response.json({ activeAccountId: null, accounts: [] });
  } });
  function Harness() {
    const [state, setOauthStatus] = useState<Record<string, OAuthStatus>>({});
    const aliveRef = useRef(true);
    const [, setBusy] = useState<string | null>(null);
    const [, setLoginInfo] = useState<Parameters<typeof useProvidersOAuth>[0]["setLoginInfo"] extends React.Dispatch<React.SetStateAction<infer S>> ? S : never>(null);
    const loader = useProvidersFetch({ apiBase: "", t: key => key, setConfig: () => {}, setOauthProviders: () => {}, setOauthStatus,
      notify: () => {}, invalidateProviderQuotas: () => {} });
    const poolsController = useProviderAccountPools({ apiBase: "", config: null, aliveRef, t: key => key, oauthStatus: state, notify: () => {},
      fetchConfig: async () => {}, fetchOauth: async () => {}, fetchProviderQuotas: async () => {}, codexActiveNeedsReauth: false,
      invalidateOauthStatusReads: loader.invalidateOauthStatusReads, setOauthStatus });
    const actionsController = useProvidersOAuth({ apiBase: "", t: key => key, aliveRef, accountSets: poolsController.accountSets, setAccountSets: poolsController.setAccountSets,
      setBusy, setStatus: () => {}, setLoginInfo, setOauthStatus, invalidateOauthStatusReads: loader.invalidateOauthStatusReads, captureOauthStatusRead: loader.captureOauthStatusRead,
      notify: () => {}, fetchConfig: async () => {}, fetchOauth: async () => {}, fetchAccountSets: poolsController.fetchAccountSets,
      fetchProviderQuotas: async () => {}, bumpModelsRefresh: () => {} });
    useLayoutEffect(() => { statuses = state; pools = poolsController; actions = actionsController; });
    return null;
  }
  try {
    await render(<Harness />);
    let login!: Promise<void>;
    await act(async () => { login = actions.loginOAuth("anthropic", true); });
    await act(async () => { await statusStarted.promise; });
    await act(async () => { await pools.removeAccount("anthropic", { id: "old", email: "old@example.test", active: true }); });
    await act(async () => { oldStatus.resolve(Response.json({ loggedIn: true, done: true, email: "old@example.test", accounts: [{ id: "old", active: true }] })); await freshStarted.promise; });
    expect(events).toContain("DELETE /api/oauth/accounts");
    expect(statuses.anthropic?.email).not.toBe("old@example.test");
    expect(pools.accountSets.anthropic?.accounts.some(account => account.id === "old") ?? false).toBe(false);
    await act(async () => { freshStatus.resolve(Response.json({ loggedIn: true, done: true, email: "new@example.test", accounts: [{ id: "new", active: true }] })); await login; });
    expect(statuses.anthropic?.email).toBe("new@example.test");
  } finally { consent.mockRestore(); oldStatus.resolve(Response.json({})); freshStatus.resolve(Response.json({})); }
});

test("an old target's login failure cannot cancel the new target's login", async () => {
  const relay = (origin: string) => {
    const base = standaloneApiTargets("");
    return {
      ...base,
      connected: true,
      shared: { ...base.shared, baseUrl: "/api/machine/hub-relay", serverOrigin: origin, transport: "relay" as const },
      apiKeyId: "fixture-key",
      relayTargetCheck: "expected-target-v1" as const,
    };
  };
  configureApiTargets(relay("https://hub-a.example"));
  let actions!: ReturnType<typeof useProvidersOAuth>;
  const cancels: Array<{ expected: string | null }> = [];
  const notices: string[] = [];
  let rejectOld!: (error: Error) => void;
  // Stable identities: the hook's pagehide effect depends on these setters, and a fresh
  // arrow per render would make React re-run its cleanup (and bump the login generation).
  const stableSetters = { setBusy: () => {}, setStatus: () => {}, setLoginInfo: () => {} };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const headers = new Headers(init?.headers);
    if (url.pathname.endsWith("/api/oauth/login/cancel")) {
      cancels.push({ expected: headers.get("x-opencodex-expected-target") });
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith("/api/oauth/login")) {
      return new Promise<Response>((_, reject) => { rejectOld = reject; });
    }
    return Response.json({ ok: true });
  } });
  function Harness({ targetKey }: { targetKey: string }) {
    const aliveRef = useRef(true);
    const controller = useProvidersOAuth({ apiBase: "/api/machine/hub-relay", targetKey, t: key => key, aliveRef, accountSets: {},
      setAccountSets: () => {}, ...stableSetters, setOauthStatus: () => {},
      notify: message => { notices.push(message); }, fetchConfig: async () => {}, fetchOauth: async () => {},
      fetchAccountSets: async () => {}, fetchProviderQuotas: async () => {}, bumpModelsRefresh: () => {} });
    useLayoutEffect(() => { actions = controller; });
    return null;
  }
  try {
    await render(<Harness targetKey="hub-a" />);
    let login!: Promise<void>;
    await act(async () => { login = actions.loginOAuth("anthropic"); await Promise.resolve(); });
    configureApiTargets(relay("https://hub-b.example"));
    await render(<Harness targetKey="hub-b" />);
    await act(async () => { rejectOld(new Error("old request failed")); await login; });
    // The captured A target is stale, so neither its cleanup nor its failure may reach B.
    expect(cancels).toEqual([]);
    expect(notices).toEqual([]);
  } finally {
    configureApiTargets(standaloneApiTargets(""));
  }
});

test("a logout failure settling after a target change does not notify the new target", async () => {
  let actions!: ReturnType<typeof useProvidersOAuth>;
  const notices: string[] = [];
  let releaseLogout!: (response: Response) => void;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/old/api/oauth/logout") {
      return new Promise<Response>(resolve => { releaseLogout = resolve; });
    }
    return Response.json({ ok: true });
  } });
  function Harness({ base }: { base: string }) {
    const aliveRef = useRef(true);
    const controller = useProvidersOAuth({ apiBase: base, t: key => key, aliveRef, accountSets: {}, setAccountSets: () => {},
      setBusy: () => {}, setStatus: () => {}, setLoginInfo: () => {}, setOauthStatus: () => {},
      notify: message => { notices.push(message); }, fetchConfig: async () => {}, fetchOauth: async () => {},
      fetchAccountSets: async () => {}, fetchProviderQuotas: async () => {}, bumpModelsRefresh: () => {} });
    useLayoutEffect(() => { actions = controller; });
    return null;
  }
  await render(<Harness base="/old" />);
  let logout!: Promise<void>;
  await act(async () => { logout = actions.logoutOAuth("anthropic"); await Promise.resolve(); });
  await render(<Harness base="/new" />);
  await act(async () => { releaseLogout(new Response(null, { status: 503 })); await logout; });
  expect(notices).toEqual([]);
});

test("key remove, add and alias completions after a target change do not toast or reload on the new target", async () => {
  const { spyOn } = await import("bun:test");
  const dialogs = await import("../src/action-dialogs");
  const { useProviderAccountPools } = await import("../src/hooks/useProviderAccountPools");
  const consent = spyOn(dialogs, "confirmAction").mockResolvedValue(true);
  const typed = spyOn(dialogs, "requestTextValue").mockResolvedValue("alias");
  let pools!: ReturnType<typeof useProviderAccountPools>;
  const notices: string[] = [];
  const reloads: string[] = [];
  let deferred!: Promise<Response>;
  let release!: (response: Response) => void;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE" || init?.method === "POST" || init?.method === "PUT") return deferred;
    return Response.json({});
  } });
  function Harness({ base }: { base: string }) {
    const aliveRef = useRef(true);
    const controller = useProviderAccountPools({ apiBase: base, config: null, aliveRef, t: key => key, oauthStatus: {},
      notify: (message: string) => { notices.push(message); }, fetchConfig: async () => { reloads.push("config"); },
      fetchOauth: async () => { reloads.push("oauth"); }, fetchProviderQuotas: async () => { reloads.push("quotas"); },
      codexActiveNeedsReauth: false });
    useLayoutEffect(() => { pools = controller; });
    return null;
  }
  const run = async (start: () => Promise<unknown>, base: string, next: string) => {
    deferred = new Promise<Response>(resolve => { release = resolve; });
    let pending!: Promise<unknown>;
    await act(async () => { pending = start(); await Promise.resolve(); });
    await render(<Harness base={base} />);
    await render(<Harness base={next} />);
    await act(async () => { release(Response.json({ success: true })); await pending; });
  };
  try {
    await render(<Harness base="/a" />);
    await run(() => pools.removeApiKey("p", { id: "k1", masked: "sk-…1", active: false }), "/a", "/b");
    await run(() => pools.addApiKeyValue("p", "sk-new"), "/b", "/a");
    await run(() => pools.editCredentialAlias("p", "api-key", "k1"), "/a", "/b");
    expect(notices).toEqual([]);
    expect(reloads).toEqual([]);
  } finally {
    consent.mockRestore();
    typed.mockRestore();
  }
});

test("an add-key form typed on one target does not survive the target change", async () => {
  const { useProviderAccountPools } = await import("../src/hooks/useProviderAccountPools");
  let pools!: ReturnType<typeof useProviderAccountPools>;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => Response.json({}) });
  function Harness({ base }: { base: string }) {
    const aliveRef = useRef(true);
    const controller = useProviderAccountPools({ apiBase: base, config: null, aliveRef, t: key => key, oauthStatus: {},
      notify: () => {}, fetchConfig: async () => {}, fetchOauth: async () => {}, fetchProviderQuotas: async () => {},
      codexActiveNeedsReauth: false });
    useLayoutEffect(() => { pools = controller; });
    return null;
  }
  await render(<Harness base="/a" />);
  await act(async () => { pools.setAddingKeyFor("p"); pools.setNewKeyValue("sk-typed-on-a"); });
  expect(pools.newKeyValue).toBe("sk-typed-on-a");
  await render(<Harness base="/b" />);
  // The credential typed on A is not submittable on B.
  expect(pools.addingKeyFor).toBeNull();
  expect(pools.newKeyValue).toBe("");
});
