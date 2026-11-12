import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useProviderAccountPools, type OAuthAccount } from "../src/hooks/useProviderAccountPools";
import { affinityResetRetries, beginAffinityResetOperation, clearAffinityResetRetry, rememberAffinityResetRetry } from "../src/provider-affinity-reset-retries";
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
let fetchConfig: () => Promise<void>;
let fetchProviderQuotas: (refresh?: boolean) => Promise<void>;

const row = (id: string, active: boolean, paused = false): OAuthAccount => ({ id, email: `${id}@example.test`, active, paused });
function clearFixtureRetry(server: string) {
  clearAffinityResetRetry(server, "fixture");
  beginAffinityResetOperation(server, "fixture")(() => undefined, true, { kind: "confirmed" });
}

function Harness({ apiBase = "/pause-hook" }: { apiBase?: string }) {
  const aliveRef = useRef(true);
  const current = useProviderAccountPools({ apiBase, config: null, aliveRef, t: key => key,
    oauthStatus: {}, notify: (key: string, ok: boolean) => { notices.push({ key, ok }); },
    fetchConfig: () => fetchConfig(), fetchOauth: () => fetchOauth(), fetchProviderQuotas: refresh => fetchProviderQuotas(refresh),
    codexActiveNeedsReauth: false });
  useLayoutEffect(() => { pools = current; }, [current]);
  return null;
}

beforeEach(async () => {
  clearFixtureRetry("/pause-hook");
  clearFixtureRetry("/other-server");
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  const win = new Window({ url: "http://localhost" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    fetch: { configurable: true, value: (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init) },
  });
  notices = [];
  fetchOauth = async () => {};
  fetchConfig = async () => {};
  fetchProviderQuotas = async () => {};
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  await act(async () => { root = createRoot(host as unknown as HTMLElement); root.render(<Harness />); });
  respond = async () => Response.json({ activeAccountId: "a", accounts: [row("a", true), row("b", false)] });
  await act(async () => { await pools.fetchAccountSets(["fixture"]); });
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  clearFixtureRetry("/pause-hook");
  clearFixtureRetry("/other-server");
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

test.each(["active", "pause", "delete"] as const)("late committed %s receipt survives unmount without notifying the old screen", async action => {
  const consent = spyOn(dialogs, "confirmAction").mockResolvedValue(true);
  let settle!: (response: Response) => void;
  let started!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  respond = async () => { started(); return new Promise(resolve => { settle = resolve; }); };
  let operation!: Promise<unknown>;
  try {
    await act(async () => {
      operation = action === "active" ? pools.switchAccount("fixture", row("b", false))
        : action === "pause" ? pools.pauseAccount("fixture", row("b", false), true)
        : pools.removeAccount("fixture", row("b", false));
      await dispatched;
    });
    await act(async () => { root!.unmount(); root = null; });
    await act(async () => {
      settle(Response.json({ code: "affinity_reset_not_persisted", retryable: true,
        [action === "active" ? "selectionCommitted" : action === "pause" ? "pauseCommitted" : "deletionCommitted"]: true }, { status: 503 }));
      await operation;
    });
    expect(affinityResetRetries("/pause-hook").fixture).toEqual(action === "active" ? { kind: "active", accountId: "b" }
      : action === "pause" ? { kind: "pause", accountId: "b", paused: true } : { kind: "reset", accountId: "b" });
    expect(notices).toEqual([]);
  } finally { consent.mockRestore(); }
});

test.each(["selection", "resume", "other-server"] as const)("late pause receipt follows a newer %s after remount", async newer => {
  let settle!: (response: Response) => void;
  let old!: Promise<void>;
  respond = async () => new Promise(resolve => { settle = resolve; });
  await act(async () => { old = pools.pauseAccount("fixture", row("b", false), true); });
  await act(async () => { root!.render(null); });
  await act(async () => { root!.render(<Harness apiBase={newer === "other-server" ? "/other-server" : "/pause-hook"} />); });
  respond = async (_url, init) => init?.method === "PUT"
    ? Response.json({ ok: true, activeAccountId: "a", activeAccountChanged: false })
    : Response.json({ activeAccountId: "a", accounts: [row("a", true), row("b", false)] });
  await act(async () => {
    if (newer === "resume") await pools.pauseAccount("fixture", row("b", false, true), false);
    else await pools.switchAccount("fixture", row("a", false));
  });
  const noticesBefore = [...notices];
  await act(async () => {
    settle(Response.json({ code: "affinity_reset_not_persisted", retryable: true, pauseCommitted: true }, { status: 503 }));
    await old;
  });
  expect(notices).toEqual(noticesBefore);
  expect(affinityResetRetries("/pause-hook").fixture).toEqual(newer === "selection" ? { kind: "reset", accountId: "b" }
    : { kind: "pause", accountId: "b", paused: newer !== "resume" });
  if (newer === "other-server") expect(pools.pendingAffinityResets.fixture).toBeUndefined();
});

test.each(["active", "delete", "reset"] as const)("late %s debt remains reset-only after a newer successful selection", async action => {
  const consent = spyOn(dialogs, "confirmAction").mockResolvedValue(true);
  let settle!: (response: Response) => void;
  let started!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  let old!: Promise<void>;
  respond = async () => { started(); return new Promise(resolve => { settle = resolve; }); };
  const resets: unknown[] = [];
  try {
    await act(async () => { if (action === "reset") rememberAffinityResetRetry("/pause-hook", "fixture", { kind: "reset", accountId: "b" }); });
    await act(async () => {
      old = action === "active" ? pools.switchAccount("fixture", row("b", false))
        : action === "delete" ? pools.removeAccount("fixture", row("b", false)) : pools.retryAffinityReset("fixture");
      await dispatched;
    });
    await act(async () => { root!.render(null); });
    await act(async () => { root!.render(<Harness />); });
    respond = async (url, init) => {
      if (url.endsWith("/affinity-reset")) { resets.push(JSON.parse(String(init?.body))); return Response.json({ affinityResetConfirmed: true }); }
      return init?.method === "PUT" ? Response.json({ ok: true, activeAccountId: "a" })
        : Response.json({ activeAccountId: "a", accounts: [row("a", true)] });
    };
    await act(async () => { await pools.switchAccount("fixture", row("a", false)); });
    await act(async () => {
      settle(Response.json({ code: "affinity_reset_not_persisted", retryable: true,
        ...(action === "active" ? { selectionCommitted: true } : action === "delete" ? { deletionCommitted: true } : {}) }, { status: 503 }));
      await old;
    });
    expect(pools.pendingAffinityResets.fixture).toEqual({ kind: "reset", accountId: "b" });
    await act(async () => { await pools.retryAffinityReset("fixture"); });
    expect(resets).toEqual([{ provider: "fixture" }]);
    expect(pools.pendingAffinityResets.fixture).toBeUndefined();
  } finally { consent.mockRestore(); }
});

test("reset success does not announce completion for debt discovered after it started", async () => {
  await act(async () => { rememberAffinityResetRetry("/pause-hook", "fixture", { kind: "reset", accountId: "b" }); });
  const late = beginAffinityResetOperation("/pause-hook", "fixture");
  let settle!: (response: Response) => void;
  let pending!: Promise<void>;
  respond = async () => new Promise(resolve => { settle = resolve; });
  await act(async () => { pending = pools.retryAffinityReset("fixture"); });
  await act(async () => { late(undefined, false, { kind: "unpersisted", accountId: "gone" }); });
  await act(async () => { settle(Response.json({ affinityResetConfirmed: true })); await pending; });
  expect(pools.pendingAffinityResets.fixture).toEqual({ kind: "reset", accountId: "gone" });
  expect(notices.at(-1)).toEqual({ key: "prov.affinityResetPending", ok: false });
  respond = async () => Response.json({ affinityResetConfirmed: true });
  await act(async () => { await pools.retryAffinityReset("fixture"); });
  expect(pools.pendingAffinityResets.fixture).toBeUndefined();
  expect(notices.at(-1)).toEqual({ key: "prov.affinityResetComplete", ok: true });
});

test("reset confirmation after unmount clears its receipt without notifying the old screen", async () => {
  await act(async () => { rememberAffinityResetRetry("/pause-hook", "fixture", { kind: "reset", accountId: "gone" }); });
  let settle!: (response: Response) => void;
  let old!: Promise<void>;
  respond = async () => new Promise(resolve => { settle = resolve; });
  await act(async () => { old = pools.retryAffinityReset("fixture"); });
  await act(async () => { root!.unmount(); root = null; });
  await act(async () => { settle(Response.json({ affinityResetConfirmed: true })); await old; });
  expect(affinityResetRetries("/pause-hook").fixture).toBeUndefined();
  expect(notices).toEqual([]);
});

test("an affinity-reset retry reconciles an overtaken roster read when it settles", async () => {
  let finishRead!: (response: Response) => void;
  let finishRetry!: (response: Response) => void;
  let reads = 0;
  await act(async () => { rememberAffinityResetRetry("/pause-hook", "fixture", { kind: "reset", accountId: "b" }); });
  respond = async (url, init) => {
    if (init?.method === "PUT" && url.includes("affinity-reset")) return new Promise<Response>(resolve => { finishRetry = resolve; });
    if (++reads === 1) return new Promise<Response>(resolve => { finishRead = resolve; });
    return Response.json({ activeAccountId: "b", accounts: [row("a", false), row("b", true)] });
  };
  let read!: Promise<boolean>;
  let retry!: Promise<void>;
  await act(async () => { read = pools.refreshAccountRosters({ provider: "fixture", kind: "oauth" }); });
  await act(async () => { retry = pools.retryAffinityReset("fixture"); });
  await act(async () => { finishRead(Response.json({ activeAccountId: "a", accounts: [row("a", true)] })); expect(await read).toBe(false); });
  expect(pools.accountLoadStates.fixture).toBe("loading");
  await act(async () => { finishRetry(Response.json({ affinityResetConfirmed: true })); await retry; });
  await act(async () => { await Promise.resolve(); });
  expect(pools.accountLoadStates.fixture).toBe("ready");
  expect(pools.accountSets.fixture.accounts.find(account => account.active)?.id).toBe("b");
});

test("a successful inactive pause cannot replay a retained active selection into the paused account", async () => {
  let writes = 0;
  await act(async () => { rememberAffinityResetRetry("/pause-hook", "fixture", { kind: "active", accountId: "b" }); });
  respond = async (_url, init) => {
    if (init?.method === "PUT") { writes++; return Response.json({ ok: true, activeAccountId: "a", activeAccountChanged: false }); }
    return Response.json({ activeAccountId: "a", accounts: [row("a", true), row("b", false, true)] });
  };
  await act(async () => { await pools.pauseAccount("fixture", row("b", false), true); });
  await act(async () => { await pools.retryAffinityReset("fixture"); });
  expect(writes).toBe(1);
  expect(pools.pendingAffinityResets.fixture).toEqual({ kind: "active", accountId: "b" });
  expect(notices.at(-1)).toEqual({ key: "prov.affinityResetRetryUnavailable", ok: false });
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

test.each([true, false])("successful same-account changes update an owed pause retry from %s", async initialPaused => {
  const writes: unknown[] = [];
  let paused = !initialPaused;
  respond = async (_url, init) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      paused = body.paused;
      return writes.length === 1
        ? Response.json({ code: "affinity_reset_not_persisted", retryable: true,
          pauseCommitted: true, activeAccountId: "a" }, { status: 503 })
        : Response.json({ ok: true, activeAccountId: "a", activeAccountChanged: false });
    }
    return Response.json({ activeAccountId: "a", accounts: [row("a", true), row("b", false, paused)] });
  };
  await act(async () => { await pools.pauseAccount("fixture", row("b", false, !initialPaused), initialPaused); });
  expect(pools.pendingAffinityResets.fixture).toMatchObject({ kind: "pause", accountId: "b", paused: initialPaused });
  await act(async () => { await pools.pauseAccount("fixture", row("b", false, initialPaused), !initialPaused); });
  expect(pools.pendingAffinityResets.fixture).toMatchObject({ kind: "pause", accountId: "b", paused: !initialPaused });
  await act(async () => { await pools.retryAffinityReset("fixture"); });
  expect(writes).toEqual([
    { provider: "fixture", accountId: "b", paused: initialPaused },
    { provider: "fixture", accountId: "b", paused: !initialPaused },
    { provider: "fixture", accountId: "b", paused: !initialPaused, retryAffinityReset: true },
  ]);
  expect(pools.accountSets.fixture.accounts.find(account => account.id === "b")?.paused).toBe(!initialPaused);
  expect(pools.pendingAffinityResets.fixture).toBeUndefined();
});

test("successful pause of another account preserves the pending pause target", async () => {
  respond = async (_url, init) => init?.method === "PUT"
    ? Response.json({ ok: true, activeAccountId: "a", activeAccountChanged: false })
    : Response.json({ activeAccountId: "a", accounts: [row("a", true), row("b", false), row("c", false)] });
  await act(async () => {
    await pools.fetchAccountSets(["fixture"]);
    rememberAffinityResetRetry("/pause-hook", "fixture", { kind: "pause", accountId: "b", paused: true });
  });
  await act(async () => { await pools.pauseAccount("fixture", row("c", false), true); });
  expect(pools.pendingAffinityResets.fixture).toMatchObject({ kind: "pause", accountId: "b", paused: true });
});

test("successful pause does not overwrite a newer reset-only retry", async () => {
  let settle!: (response: Response) => void;
  let mutation!: Promise<void>;
  respond = async (_url, init) => init?.method === "PUT"
    ? new Promise(resolve => { settle = resolve; })
    : Response.json({ activeAccountId: "a", accounts: [row("a", true), row("b", false)] });
  await act(async () => {
    rememberAffinityResetRetry("/pause-hook", "fixture", { kind: "pause", accountId: "b", paused: true });
  });
  await act(async () => { mutation = pools.pauseAccount("fixture", row("b", false, true), false); });
  try {
    await act(async () => {
      rememberAffinityResetRetry("/pause-hook", "fixture", { kind: "reset", accountId: "b" });
    });
  } finally {
    await act(async () => {
      settle(Response.json({ ok: true, activeAccountId: "a", activeAccountChanged: false }));
      await mutation;
    });
  }
  expect(pools.pendingAffinityResets.fixture).toMatchObject({ kind: "reset", accountId: "b" });
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

test.each(["selection", "pause", "reset", "threshold"] as const)("deletion waits for an in-flight %s mutation", async action => {
  const consent = spyOn(dialogs, "confirmAction").mockResolvedValue(true);
  let settle!: (response: Response) => void;
  let pending!: Promise<unknown>;
  let deletes = 0;
  respond = async (_url, init) => {
    if (init?.method === "PUT") return new Promise(resolve => { settle = resolve; });
    if (init?.method === "DELETE") { deletes++; return Response.json({ ok: true }); }
    return Response.json({ activeAccountId: "a", accounts: [row("a", true), row("b", false)] });
  };
  try {
    await act(async () => {
      if (action === "reset") rememberAffinityResetRetry("/pause-hook", "fixture", { kind: "reset", accountId: "b" });
    });
    await act(async () => {
      pending = action === "selection" ? pools.switchAccount("fixture", row("b", false))
        : action === "pause" ? pools.pauseAccount("fixture", row("b", false), true)
        : action === "reset" ? pools.retryAffinityReset("fixture")
        : pools.setAccountThreshold("fixture", row("b", false), 50);
    });
    await act(async () => { await pools.removeAccount("fixture", row("b", false)); });
    expect(deletes).toBe(0);
  } finally {
    await act(async () => {
      settle(Response.json({ ok: true, activeAccountId: "a", activeAccountChanged: false, affinityResetConfirmed: true,
        autoSwitchThresholdOverride: 50, autoSwitchThreshold: 70, effectiveAutoSwitchThreshold: 50 }));
      await pending;
    });
    consent.mockRestore();
  }
});

test("in-flight deletion owns its provider until the committed receipt is retained", async () => {
  const consent = spyOn(dialogs, "confirmAction").mockResolvedValue(true);
  let settle!: (response: Response) => void;
  let started!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  let pending!: Promise<void>;
  const writes: string[] = [];
  await act(async () => { rememberAffinityResetRetry("/pause-hook", "fixture", { kind: "reset", accountId: "b" }); });
  respond = async (_url, init) => {
    if (init?.method === "DELETE") {
      writes.push("DELETE");
      if (writes.filter(value => value === "DELETE").length === 1) { started(); return new Promise(resolve => { settle = resolve; }); }
      return new Response(null, { status: 500 });
    }
    if (init?.method === "PUT") {
      const provider = JSON.parse(String(init.body)).provider;
      writes.push(`PUT:${provider}`);
      return Response.json({ ok: true, activeAccountId: "a", activeAccountChanged: false, affinityResetConfirmed: true });
    }
    return Response.json({ activeAccountId: "a", accounts: [row("a", true)] });
  };
  try {
    await act(async () => { pending = pools.removeAccount("fixture", row("b", false)); await dispatched; });
    await act(async () => {
      await pools.switchAccount("fixture", row("b", false));
      await pools.pauseAccount("fixture", row("b", false), true);
      await pools.retryAffinityReset("fixture");
      expect(await pools.setAccountThreshold("fixture", row("b", false), 50)).toBe(false);
      await pools.removeAccount("fixture", row("b", false));
      await pools.pauseAccount("other-provider", row("b", false), true);
    });
    expect(writes).toEqual(["DELETE", "PUT:other-provider"]);
  } finally {
    await act(async () => {
      settle(Response.json({ code: "affinity_reset_not_persisted", deletionCommitted: true, retryable: true }, { status: 503 }));
      await pending;
    });
    consent.mockRestore();
  }
  expect(pools.pendingAffinityResets.fixture).toEqual({ kind: "reset", accountId: "b" });
  await act(async () => { await pools.retryAffinityReset("fixture"); });
  expect(pools.pendingAffinityResets.fixture).toBeUndefined();
});

test("a stalled unrelated OAuth status does not hold a completed deletion", async () => {
  const consent = spyOn(dialogs, "confirmAction").mockResolvedValue(true);
  let releaseStatus!: () => void;
  let statusStarted!: () => void;
  const started = new Promise<void>(resolve => { statusStarted = resolve; });
  fetchOauth = () => { statusStarted(); return new Promise<void>(resolve => { releaseStatus = resolve; }); };
  let switches = 0;
  respond = async (_url, init) => init?.method === "DELETE" ? Response.json({ ok: true })
    : init?.method === "PUT" ? (switches++, Response.json({ activeAccountId: "b" }))
    : Response.json({ activeAccountId: "a", accounts: [row("a", true), row("b", false)] });
  let deletion!: Promise<void>;
  try {
    await act(async () => { deletion = pools.removeAccount("fixture", row("b", false)); await started; });
    await act(async () => { void pools.switchAccount("fixture", row("b", false)); await Promise.resolve(); });
    expect(switches).toBe(1);
  } finally { await act(async () => { releaseStatus(); await deletion; }); consent.mockRestore(); }
});

test("deletion rechecks ownership after the confirmation dialog settles", async () => {
  let confirm!: (value: boolean) => void;
  const consent = spyOn(dialogs, "confirmAction").mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
  let settle!: (response: Response) => void;
  let deletion!: Promise<void>;
  let pause!: Promise<void>;
  let deletes = 0;
  respond = async (_url, init) => {
    if (init?.method === "PUT") return new Promise(resolve => { settle = resolve; });
    if (init?.method === "DELETE") { deletes++; return Response.json({ ok: true }); }
    return Response.json({ activeAccountId: "a", accounts: [row("a", true), row("b", false)] });
  };
  try {
    await act(async () => { deletion = pools.removeAccount("fixture", row("b", false)); });
    await act(async () => { pause = pools.pauseAccount("fixture", row("b", false), true); });
    await act(async () => { confirm(true); await deletion; });
    expect(deletes).toBe(0);
  } finally {
    await act(async () => { settle(Response.json({ ok: true, activeAccountId: "a", activeAccountChanged: false })); await pause; });
    consent.mockRestore();
  }
});

test.each([true, false])("failed deletion reconciles identity (roster succeeds: %s)", async succeeds => {
  const consent = spyOn(dialogs, "confirmAction").mockResolvedValue(true);
  let reads = 0;
  respond = async (_url, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 503 });
    reads++;
    return succeeds ? Response.json({ activeAccountId: "b", accounts: [row("a", false), row("b", true)] })
      : new Response(null, { status: 503 });
  };
  try {
    await act(async () => { await pools.removeAccount("fixture", row("b", false)); });
    await act(async () => { await Promise.resolve(); });
    expect(reads).toBe(1);
    expect(pools.accountLoadStates.fixture).toBe(succeeds ? "ready" : "error");
    if (succeeds) expect(pools.accountSets.fixture.accounts.find(account => account.active)?.id).toBe("b");
  } finally { consent.mockRestore(); }
});

test.each(["http", "transport"] as const)("failed deletion releases its mutation owner after %s failure", async failure => {
  const consent = spyOn(dialogs, "confirmAction").mockResolvedValue(true);
  let pauses = 0;
  respond = async (_url, init) => {
    if (init?.method === "DELETE") {
      if (failure === "transport") throw new Error("synthetic disconnect");
      return new Response(null, { status: 500 });
    }
    if (init?.method === "PUT") { pauses++; return Response.json({ ok: true, activeAccountId: "a", activeAccountChanged: false }); }
    return Response.json({ activeAccountId: "a", accounts: [row("a", true), row("b", false)] });
  };
  try {
    await act(async () => { await pools.removeAccount("fixture", row("b", false)); });
    await act(async () => { await pools.pauseAccount("fixture", row("b", false), true); });
    expect(pauses).toBe(1);
  } finally { consent.mockRestore(); }
});

test("a rejected deletion without a committed receipt preserves the roster and retry", async () => {
  const consent = spyOn(dialogs, "confirmAction").mockResolvedValue(true);
  await act(async () => { rememberAffinityResetRetry("/pause-hook", "fixture", { kind: "active", accountId: "b" }); });
  const requests: string[] = [];
  respond = async (url, init) => {
    requests.push(`${init?.method ?? "GET"} ${url}`);
    return Response.json({ code: "affinity_reset_not_persisted", retryable: true, deletionCommitted: false }, { status: 503 });
  };
  try {
    await act(async () => { await pools.removeAccount("fixture", row("a", true)); });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toStartWith("DELETE ");
    expect(requests[1]).toStartWith("GET ");
    expect(pools.accountLoadStates.fixture).toBe("error");
    expect(pools.accountSets.fixture.accounts.map(account => account.id)).toEqual(["a", "b"]);
    expect(pools.pendingAffinityResets.fixture).toEqual({ kind: "active", accountId: "b" });
    expect(notices).toEqual([{ key: "prov.accountRemoveFail", ok: false }]);
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

test("pauseApiKey pauses active key with ring-order fallback and refreshes roster", async () => {
  const k1 = { id: "k1", label: "Key 1", masked: "****1", active: false, disabled: false };
  const k2 = { id: "k2", label: "Key 2", masked: "****2", active: true, disabled: false };
  const k3 = { id: "k3", label: "Key 3", masked: "****3", active: false, disabled: false };
  const writes: Array<{ path: string; body: unknown }> = [];
  let configRefreshes = 0;
  const quotaRefreshes: boolean[] = [];
  fetchConfig = async () => { configRefreshes++; };
  fetchProviderQuotas = async refresh => { quotaRefreshes.push(refresh === true); };
  respond = async (url, init) => {
    if (init?.method === "PUT") {
      writes.push({ path: url, body: JSON.parse(String(init.body)) });
      return Response.json({ ok: true });
    }
    return Response.json({ activeId: "k3", keys: [k1, { ...k2, active: false, disabled: true }, { ...k3, active: true }] });
  };
  await act(async () => { pools.setKeyPools({ fixture: [k1, k2, k3] }); });
  await act(async () => { await pools.pauseApiKey("fixture", k2, true); });
  expect(writes).toEqual([{ path: "/pause-hook/api/providers/keys/pause", body: { name: "fixture", id: "k2", paused: true } }]);
  expect(pools.keyPools.fixture.find(r => r.id === "k2")?.disabled).toBe(true);
  expect(pools.keyPools.fixture.find(r => r.id === "k3")?.active).toBe(true);
  expect(notices).toContainEqual({ key: "codexAuth.pauseSucceeded", ok: true });
  expect(configRefreshes).toBe(1);
  expect(quotaRefreshes).toEqual([true]);
});
