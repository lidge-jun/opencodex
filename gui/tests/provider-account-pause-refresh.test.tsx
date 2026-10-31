import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useProviderAccountPools, type OAuthAccount } from "../src/hooks/useProviderAccountPools";
import { clearAffinityResetRetry, rememberAffinityResetRetry } from "../src/provider-affinity-reset-retries";
import * as dialogs from "../src/action-dialogs";

// A pause is persisted by the PUT alone. Everything after it is a follow-up read, and its
// failure must never be reported as a failed pause (the operator would retry a saved change).

const globals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let root: Root | null = null;
let pools: ReturnType<typeof useProviderAccountPools>;
let notices: Array<{ key: string; ok: boolean }>;
let respond: (url: string, init?: RequestInit) => Promise<Response>;
let fetchOauth: () => Promise<void>;

const row = (id: string, active: boolean, paused = false): OAuthAccount => ({ id, email: `${id}@example.test`, active, paused });

function Harness({ apiBase = "/pause-hook" }: { apiBase?: string }) {
  const aliveRef = useRef(true);
  const current = useProviderAccountPools({ apiBase, config: null, aliveRef, t: key => key,
    oauthStatus: {}, notify: (key: string, ok: boolean) => { notices.push({ key, ok }); },
    fetchConfig: async () => {}, fetchOauth: () => fetchOauth(), fetchProviderQuotas: async () => {},
    codexActiveNeedsReauth: false });
  useLayoutEffect(() => { pools = current; }, [current]);
  return null;
}

beforeEach(async () => {
  clearAffinityResetRetry("/pause-hook", "fixture");
  clearAffinityResetRetry("/other-server", "fixture");
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  const win = new Window({ url: "http://localhost" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    fetch: { configurable: true, value: (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init) },
  });
  notices = [];
  fetchOauth = async () => {};
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  await act(async () => { root = createRoot(host as unknown as HTMLElement); root.render(<Harness />); });
  respond = async () => Response.json({ activeAccountId: "a", accounts: [row("a", true), row("b", false)] });
  await act(async () => { await pools.fetchAccountSets(["fixture"]); });
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  clearAffinityResetRetry("/pause-hook", "fixture");
  clearAffinityResetRetry("/other-server", "fixture");
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("confirmed threshold persists in UI when follow-up read fails; failed writes preserve prior state", async () => {
  let fail = false; const bodies: unknown[] = [];
  respond = async (_url, init) => {
    if (init?.method !== "PUT") return new Response(null, { status: 503 });
    bodies.push(JSON.parse(String(init.body)));
    return fail ? new Response(null, { status: 500 }) : Response.json({ autoSwitchThresholdOverride: 0, autoSwitchThreshold: 70, effectiveAutoSwitchThreshold: 0 });
  };
  await act(async () => { expect(await pools.setAccountThreshold("fixture", row("b", false), 0)).toBe(true); });
  expect(pools.accountSets.fixture.accounts[1]?.autoSwitchThresholdOverride).toBe(0);
  expect(bodies[0]).toEqual({ provider: "fixture", accountId: "b", threshold: 0 });
  fail = true;
  await act(async () => { expect(await pools.setAccountThreshold("fixture", row("b", false), null)).toBe(false); });
  expect(pools.accountSets.fixture.accounts[1]?.autoSwitchThresholdOverride).toBe(0);
  expect(notices.some(notice => notice.key === "accountPool.autoSwitchUpdateFailed")).toBe(true);
});

test.each(["active", "pause"] as const)("committed %s failure retains an exact retry after roster refresh", async action => {
  const writes: unknown[] = [];
  let confirmed = false;
  respond = async (_url, init) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(String(init.body)));
      return confirmed ? Response.json({ ok: true, activeAccountId: "b", activeAccountChanged: false })
        : Response.json({ code: "affinity_reset_not_persisted", retryable: true, activeAccountId: "b",
          ...(action === "active" ? { selectionCommitted: true } : { pauseCommitted: true }) }, { status: 503 });
    }
    return Response.json({ activeAccountId: "b", accounts: [row("a", false, action === "pause"), row("b", true)] });
  };
  await act(async () => {
    if (action === "active") await pools.switchAccount("fixture", row("b", false));
    else await pools.pauseAccount("fixture", row("a", true), true);
  });
  expect(pools.accountSets.fixture.activeAccountId).toBe("b");
  expect(pools.pendingAffinityResets.fixture).toBeDefined();
  await act(async () => { await pools.fetchAccountSets(["fixture"]); });
  expect(pools.pendingAffinityResets.fixture).toBeDefined();
  // An unsuccessful retry keeps the actionable error, even after the row became active/paused.
  await act(async () => { await pools.retryAffinityReset("fixture"); });
  expect(pools.pendingAffinityResets.fixture).toBeDefined();
  confirmed = true;
  await act(async () => { await pools.retryAffinityReset("fixture"); });
  expect(writes).toEqual(Array.from({ length: 3 }, (_, index) => action === "active"
    ? { provider: "fixture", accountId: "b" }
    : { provider: "fixture", accountId: "a", paused: true, ...(index ? { retryAffinityReset: true } : {}) }));
  expect(pools.pendingAffinityResets.fixture).toBeUndefined();
  expect(notices).toContainEqual({ key: "prov.affinityResetPending", ok: false });
});

test("unrelated successful pause preserves reset retry after server state may have restarted", async () => {
  respond = async (url, init) => {
    if (init?.method !== "PUT") return Response.json({ activeAccountId: "b", accounts: [row("a", false), row("b", true)] });
    return url.endsWith("/active")
      ? Response.json({ code: "affinity_reset_not_persisted", retryable: true,
        selectionCommitted: true, activeAccountId: "b" }, { status: 503 })
      : Response.json({ ok: true, activeAccountId: "b", activeAccountChanged: false });
  };
  await act(async () => { await pools.switchAccount("fixture", row("b", false)); });
  await act(async () => { await pools.pauseAccount("fixture", row("a", false), true); });
  expect(pools.pendingAffinityResets.fixture).toMatchObject({ kind: "active", accountId: "b" });
});

test.each(["active", "pause"] as const)("%s retry survives unavailable rosters and requires global reset confirmation after absence", async action => {
  let writes = 0;
  respond = async (_url, init) => {
    if (init?.method !== "PUT") return Response.json({ activeAccountId: "b", accounts: [row("a", false, action === "pause"), row("b", true)] });
    writes++;
    return Response.json({ code: "affinity_reset_not_persisted", retryable: true, activeAccountId: "b",
      ...(action === "active" ? { selectionCommitted: true } : { pauseCommitted: true }) }, { status: 503 });
  };
  await act(async () => {
    if (action === "active") await pools.switchAccount("fixture", row("b", false));
    else await pools.pauseAccount("fixture", row("a", true), true);
  });
  await act(async () => { root!.render(null); });
  await act(async () => { root!.render(<Harness />); });
  notices = [];
  const expectRetained = () => {
    expect(pools.pendingAffinityResets.fixture).toMatchObject({ kind: action, accountId: action === "active" ? "b" : "a" });
    expect(notices.at(-1)).toEqual({ key: "prov.affinityResetRetryUnavailable", ok: false });
    expect(writes).toBe(1);
  };
  await act(async () => { await pools.retryAffinityReset("fixture"); });
  expectRetained(); // Not fetched yet is not proof the account was deleted.
  let settle!: (response: Response) => void;
  let loading!: Promise<boolean>;
  respond = async (_url, init) => {
    if (init?.method === "PUT") { writes++; return Response.json({ ok: true }); }
    return new Promise(resolve => { settle = resolve; });
  };
  try {
    await act(async () => { loading = pools.fetchAccountSets(["fixture"]); });
    expect(pools.accountLoadStates.fixture).toBe("loading");
    await act(async () => { await pools.retryAffinityReset("fixture"); });
    expectRetained();
  } finally {
    await act(async () => { settle(new Response(null, { status: 500 })); await loading; });
  }
  expect(pools.accountLoadStates.fixture).toBe("error");
  await act(async () => { await pools.retryAffinityReset("fixture"); });
  expectRetained();
  const resets: unknown[] = [];
  respond = async (url, init) => {
    if (init?.method === "PUT") {
      writes++;
      expect(url).toBe("/pause-hook/api/oauth/accounts/affinity-reset");
      resets.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true }); // An ordinary 2xx is not a publication receipt.
    }
    return Response.json({ activeAccountId: null, accounts: [] });
  };
  await act(async () => { await pools.fetchAccountSets(["fixture"]); });
  expect(pools.accountLoadStates.fixture).toBe("ready");
  await act(async () => { await pools.retryAffinityReset("fixture"); });
  expect(pools.pendingAffinityResets.fixture).toMatchObject({ kind: "reset", accountId: action === "active" ? "b" : "a" });
  expect(notices.slice(0, 3)).toEqual(Array.from({ length: 3 }, () => ({ key: "prov.affinityResetRetryUnavailable", ok: false })));
  expect(notices.at(-1)).toEqual({ key: "prov.affinityResetPending", ok: false });
  expect(writes).toBe(2);
  expect(resets).toEqual([{ provider: "fixture" }]);
  respond = async (_url, init) => {
    if (init?.method === "PUT") resets.push(JSON.parse(String(init.body)));
    return Response.json({ ok: true, affinityResetConfirmed: true });
  };
  await act(async () => { await pools.retryAffinityReset("fixture"); });
  expect(resets).toEqual([{ provider: "fixture" }, { provider: "fixture" }]);
  expect(pools.pendingAffinityResets.fixture).toBeUndefined();
  expect(notices.at(-1)).toEqual({ key: "prov.affinityResetComplete", ok: true });
});

test.each(["partial", "legacy", "empty", "confirmed"] as const)("delete %s acknowledges account removal separately from global reset", async outcome => {
  const consent = spyOn(dialogs, "confirmAction").mockResolvedValue(true);
  let deleted = false; let resetSucceeds = false;
  const writes: Array<{ method: string; url: string; body?: unknown }> = [];
  respond = async (url, init) => {
    if (init?.method === "DELETE") {
      writes.push({ method: "DELETE", url }); deleted = true;
      return outcome === "empty" ? Response.json(null) : outcome === "partial" ? Response.json({ code: "affinity_reset_not_persisted", retryable: true, deletionCommitted: true }, { status: 503 })
        : Response.json({ ok: true, ...(outcome === "confirmed" ? { affinityResetConfirmed: true } : {}) });
    }
    if (init?.method === "PUT") {
      writes.push({ method: "PUT", url, body: JSON.parse(String(init.body)) });
      if (url.endsWith("/affinity-reset")) return resetSucceeds ? Response.json({ ok: true, affinityResetConfirmed: true })
        : Response.json({ code: "affinity_reset_not_persisted", retryable: true }, { status: 503 });
      return Response.json({ code: "affinity_reset_not_persisted", retryable: true, pauseCommitted: true, activeAccountId: "b" }, { status: 503 });
    }
    return Response.json({ activeAccountId: "b", accounts: deleted ? [row("b", true)] : [row("a", false, true), row("b", true)] });
  };
  try {
    await act(async () => { await pools.pauseAccount("fixture", row("a", true), true); });
    await act(async () => { await pools.removeAccount("fixture", row("a", false, true)); });
    expect(writes[1]).toEqual({ method: "DELETE", url: "/pause-hook/api/oauth/accounts?provider=fixture&id=a&retryAffinityReset=true" });
    expect(pools.accountSets.fixture.accounts.map(account => account.id)).toEqual(["b"]);
    expect(notices.some(notice => notice.key === "prov.accountRemoveFail")).toBe(false);
    if (outcome === "confirmed") {
      expect(pools.pendingAffinityResets.fixture).toBeUndefined();
      expect(writes).toHaveLength(2);
    } else {
      expect(pools.pendingAffinityResets.fixture).toBeDefined();
      await act(async () => { await pools.retryAffinityReset("fixture"); });
      expect(pools.pendingAffinityResets.fixture).toMatchObject({ kind: "reset", accountId: "a" });
      resetSucceeds = true;
      await act(async () => { await pools.retryAffinityReset("fixture"); });
      expect(writes.slice(2)).toEqual(Array.from({ length: 2 }, () => ({ method: "PUT", url: "/pause-hook/api/oauth/accounts/affinity-reset", body: { provider: "fixture" } })));
      expect(pools.pendingAffinityResets.fixture).toBeUndefined();
      expect(notices.at(-1)).toEqual({ key: "prov.affinityResetComplete", ok: true });
    }
  } finally { consent.mockRestore(); }
});

test("late global reset confirmation cannot clear a newer pending intent", async () => {
  await act(async () => { rememberAffinityResetRetry("/pause-hook", "fixture", { kind: "reset", accountId: "gone" }); });
  let settle!: (response: Response) => void;
  respond = async () => new Promise(resolve => { settle = resolve; });
  let pending!: Promise<void>;
  try {
    await act(async () => { pending = pools.retryAffinityReset("fixture"); });
    await act(async () => { rememberAffinityResetRetry("/pause-hook", "fixture", { kind: "pause", accountId: "a", paused: true }); });
  } finally {
    await act(async () => { settle(Response.json({ ok: true, affinityResetConfirmed: true })); await pending; });
  }
  expect(pools.pendingAffinityResets.fixture).toEqual({ kind: "pause", accountId: "a", paused: true });
  expect(pools.switchingAccounts).toEqual({});
  expect(notices.some(notice => notice.key === "prov.affinityResetComplete")).toBe(false);
});

test.each(["paused", "needsReauth"] as const)("active retry reports %s and succeeds after the account recovers", async blocked => {
  const writes: unknown[] = [];
  let confirmed = false;
  let unavailable = false;
  respond = async (_url, init) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(String(init.body)));
      return confirmed ? Response.json({ ok: true, activeAccountId: "b" })
        : Response.json({ code: "affinity_reset_not_persisted", retryable: true, selectionCommitted: true, activeAccountId: "b" }, { status: 503 });
    }
    return Response.json({ activeAccountId: "b", accounts: [row("a", false), { ...row("b", true), [blocked]: unavailable }] });
  };
  await act(async () => { await pools.switchAccount("fixture", row("b", false)); });
  unavailable = true;
  await act(async () => { await pools.fetchAccountSets(["fixture"]); });
  notices = [];
  await act(async () => { await pools.retryAffinityReset("fixture"); });
  expect(writes).toHaveLength(1);
  expect(pools.pendingAffinityResets.fixture).toMatchObject({ kind: "active", accountId: "b" });
  expect(notices).toEqual([{ key: "prov.affinityResetRetryUnavailable", ok: false }]);
  unavailable = false;
  confirmed = true;
  await act(async () => { await pools.fetchAccountSets(["fixture"]); });
  await act(async () => { await pools.retryAffinityReset("fixture"); });
  expect(writes).toEqual(Array.from({ length: 2 }, () => ({ provider: "fixture", accountId: "b" })));
  expect(pools.pendingAffinityResets.fixture).toBeUndefined();
});

test("pending reset survives page navigation and remains scoped to its server", async () => {
  let confirmed = false;
  const writes: string[] = [];
  respond = async (url, init) => {
    if (init?.method === "PUT") {
      writes.push(url);
      return confirmed ? Response.json({ ok: true, activeAccountId: "b" })
        : Response.json({ code: "affinity_reset_not_persisted", retryable: true,
          selectionCommitted: true, activeAccountId: "b" }, { status: 503 });
    }
    return Response.json({ activeAccountId: "b", accounts: [row("a", false), row("b", true)] });
  };
  await act(async () => { await pools.switchAccount("fixture", row("b", false)); });
  await act(async () => { root!.render(null); });
  await act(async () => { root!.render(<Harness apiBase="/other-server" />); });
  expect(pools.pendingAffinityResets.fixture).toBeUndefined();
  await act(async () => { await pools.fetchAccountSets(["fixture"]); await pools.retryAffinityReset("fixture"); });
  expect(writes).toHaveLength(1);
  await act(async () => { root!.render(null); });
  await act(async () => { root!.render(<Harness />); });
  expect(pools.pendingAffinityResets.fixture).toMatchObject({ kind: "active", accountId: "b" });
  await act(async () => { await pools.fetchAccountSets(["fixture"]); });
  confirmed = true;
  await act(async () => { await pools.retryAffinityReset("fixture"); });
  expect(writes).toEqual(["/pause-hook/api/oauth/accounts/active", "/pause-hook/api/oauth/accounts/active"]);
  expect(pools.pendingAffinityResets.fixture).toBeUndefined();
});

test("equal account IDs in two pools have independent pending mutation ownership", async () => {
  const mutations: Array<{ provider: string; accountId: string }> = [];
  const releases: Array<() => void> = [];
  respond = async (_url, init) => {
    if (init?.method === "PUT") {
      mutations.push(JSON.parse(String(init.body)));
      await new Promise<void>(resolve => { releases.push(resolve); });
    }
    return Response.json({ activeAccountId: "a", accounts: [row("a", true), row("b", false)] });
  };
  await act(async () => { await pools.fetchAccountSets(["anthropic", "anthropic2"]); });
  let primary!: Promise<void>;
  let secondary!: Promise<void>;
  try {
    await act(async () => {
      secondary = pools.pauseAccount("anthropic2", row("b", false), true);
      primary = pools.switchAccount("anthropic", row("b", false));
      await Promise.resolve();
    });
    expect(mutations.map(entry => entry.provider).sort()).toEqual(["anthropic", "anthropic2"]);
    expect(pools.pausingAccounts.anthropic2?.accountId).toBe("b");
    expect(pools.switchingAccounts.anthropic?.accountId).toBe("b");
    expect(pools.pausingAccounts.anthropic).toBeUndefined();
    expect(pools.switchingAccounts.anthropic2).toBeUndefined();
  } finally {
    await act(async () => {
      releases.forEach(release => release());
      await Promise.all([primary, secondary]);
    });
  }
  expect(pools.pausingAccounts).toEqual({});
  expect(pools.switchingAccounts).toEqual({});
});

test("pending threshold owns its roster generation and blocks conflicting pause", async () => {
  let settle!: (response: Response) => void; let writes = 0;
  respond = async (_url, init) => {
    if (init?.method !== "PUT") return new Response(null, { status: 503 });
    writes++; return new Promise(resolve => { settle = resolve; });
  };
  let pending!: Promise<boolean>;
  await act(async () => { pending = pools.setAccountThreshold("fixture", row("b", false), 40); });
  await act(async () => { await pools.pauseAccount("fixture", row("b", false), true); });
  expect(writes).toBe(1);
  await act(async () => { settle(Response.json({ autoSwitchThresholdOverride: 40, autoSwitchThreshold: 70, effectiveAutoSwitchThreshold: 40 })); await pending; });
  expect(pools.accountSets.fixture.accounts[1]?.autoSwitchThresholdOverride).toBe(40);
});

test("a confirmed pool threshold invalidates an older roster while later external changes still win", async () => {
  let settleStale!: (response: Response) => void;
  let reads = 0;
  const urls: string[] = [];
  respond = async (url, init) => {
    if (init?.method === "PUT") return new Response(null, { status: 500 });
    urls.push(url);
    reads++;
    if (reads === 1) return new Promise(resolve => { settleStale = resolve; });
    const threshold = reads <= 3 ? 70 : 55;
    return Response.json({ activeAccountId: "a", accounts: [
      { ...row("a", true), quotaMode: "probe", autoSwitchThresholdOverride: null, autoSwitchThreshold: threshold, effectiveAutoSwitchThreshold: threshold },
      { ...row("b", false), quotaMode: "probe", autoSwitchThresholdOverride: 40, autoSwitchThreshold: threshold, effectiveAutoSwitchThreshold: 40 },
    ] });
  };

  let stale!: Promise<boolean>;
  await act(async () => { stale = pools.refreshAccountRosters({ provider: "fixture", kind: "oauth" }); });
  await act(async () => { expect(await pools.setAccountPoolThreshold("fixture", 70)).toBe(true); });
  await act(async () => { await Promise.resolve(); });
  expect(urls.some(url => url.includes("quota=1"))).toBe(true);
  expect(pools.accountSets.fixture.accounts[0]?.autoSwitchThreshold).toBe(70);
  expect(pools.accountSets.fixture.accounts[1]?.effectiveAutoSwitchThreshold).toBe(40);

  await act(async () => {
    settleStale(Response.json({ activeAccountId: "a", accounts: [
      { ...row("a", true), quotaMode: "probe", autoSwitchThresholdOverride: null, autoSwitchThreshold: 65, effectiveAutoSwitchThreshold: 65 },
      { ...row("b", false), quotaMode: "probe", autoSwitchThresholdOverride: 40, autoSwitchThreshold: 65, effectiveAutoSwitchThreshold: 40 },
    ] }));
    await stale;
  });
  expect(pools.accountSets.fixture.accounts[0]?.autoSwitchThreshold).toBe(70);

  await act(async () => { expect(await pools.refreshAccountRosters({ provider: "fixture", kind: "oauth" })).toBe(true); });
  expect(pools.accountSets.fixture.accounts[0]?.autoSwitchThreshold).toBe(55);
});

test("a stalled account threshold write is aborted when the hook unmounts", async () => {
  let aborted = false;
  respond = async (_url, init) => new Promise((_resolve, reject) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    init?.signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted"));
    }, { once: true });
  });
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = pools.setAccountThreshold("fixture", row("b", false), 40);
    await Promise.resolve();
  });
  await act(async () => { root?.unmount(); root = null; });
  expect(await pending).toBe(false);
  expect(aborted).toBe(true);
});

test("a saved pause stays visible and only the failed roster refresh is reported", async () => {
  respond = async (_url, init) => init?.method === "PUT"
    ? Response.json({ ok: true, activeAccountId: "a", activeAccountChanged: false })
    : new Response(null, { status: 503 });
  await act(async () => { await pools.pauseAccount("fixture", row("b", false), true); });
  expect(pools.accountSets.fixture.accounts.find(account => account.id === "b")?.paused).toBe(true);
  expect(notices).toEqual([
    { key: "codexAuth.pauseSucceeded", ok: true },
    { key: "pws.accountsLoadFailed", ok: false },
  ]);
  expect(pools.pausingAccount).toBeNull();
});

test("a follow-up read that throws after an active-account change is not a pause failure", async () => {
  respond = async (_url, init) => init?.method === "PUT"
    ? Response.json({ ok: true, activeAccountId: "b", activeAccountChanged: true })
    : Response.json({ activeAccountId: "b", accounts: [row("a", false, true), row("b", true)] });
  fetchOauth = async () => { throw new Error("status read failed"); };
  await act(async () => { await pools.pauseAccount("fixture", row("a", true), true); });
  expect(pools.accountSets.fixture.activeAccountId).toBe("b");
  expect(notices.map(notice => notice.key)).toEqual(["codexAuth.pauseSucceeded", "pws.accountsLoadFailed"]);
  expect(notices.some(notice => notice.key === "codexAuth.pauseFailed")).toBe(false);
});

test("a rejected save reports the pause failure and leaves the row unpaused", async () => {
  respond = async (_url, init) => init?.method === "PUT"
    ? Response.json({ error: "account not found" }, { status: 404 })
    : Response.json({ activeAccountId: "a", accounts: [row("a", true), row("b", false)] });
  await act(async () => { await pools.pauseAccount("fixture", row("b", false), true); });
  expect(pools.accountSets.fixture.accounts.find(account => account.id === "b")?.paused).toBe(false);
  expect(notices).toEqual([{ key: "codexAuth.pauseFailed", ok: false }]);
});

test("paused key selection resumes before activation and refreshes the roster", async () => {
  const entry = { id: "key-fixture", masked: "****", active: false, disabled: true, pauseDetails: { reason: "subscription_expired", pausedAt: 1 } };
  const writes: Array<{ path: string; body: unknown }> = [];
  respond = async (url, init) => {
    if (init?.method === "PUT") { writes.push({ path: url, body: JSON.parse(String(init.body)) }); return Response.json({ activeId: entry.id }); }
    return Response.json({ activeId: entry.id, keys: [{ ...entry, disabled: false, active: true, pauseDetails: undefined }] });
  };
  await act(async () => { pools.setKeyPools({ fixture: [entry] }); });
  await act(async () => { await pools.switchApiKey("fixture", entry); });
  expect(writes.map(row => row.path)).toEqual(["/pause-hook/api/providers/keys/pause", "/pause-hook/api/providers/keys/active"]);
  expect(writes[0]!.body).toEqual({ name: "fixture", id: entry.id, paused: false });
});

test("a failed key resume never attempts activation", async () => {
  const writes: string[] = [];
  respond = async (url, init) => {
    if (init?.method === "PUT") { writes.push(url); return new Response(null, { status: 503 }); }
    return Response.json({ keys: [] });
  };
  await act(async () => { await pools.switchApiKey("fixture", { id: "key-fixture", masked: "****", active: false, disabled: true }); });
  expect(writes).toEqual(["/pause-hook/api/providers/keys/pause"]);
  expect(notices).toContainEqual({ key: "prov.keySwitchFail", ok: false });
});

test.each(["http", "transport"])("a resumed key reports partial success when activation fails via %s", async failure => {
  const entry = { id: "key-fixture", masked: "****", active: false, disabled: true };
  respond = async (url, init) => {
    if (init?.method === "PUT" && url.endsWith("/active")) {
      if (failure === "transport") throw new Error("fixture offline");
      return Response.json({ error: "fixture activation refused" }, { status: 503 });
    }
    if (init?.method === "PUT") return Response.json({ ok: true });
    return Response.json({ keys: [{ ...entry, disabled: false }] });
  };
  await act(async () => { pools.setKeyPools({ fixture: [entry] }); });
  await act(async () => { await pools.switchApiKey("fixture", entry); });
  expect(notices).toContainEqual({ key: "prov.keyResumedSwitchFailed", ok: false });
  expect(notices.some(notice => notice.key === "prov.keySwitchFail")).toBe(false);
  expect(pools.keyPools.fixture[0]?.disabled).toBe(false);
});
