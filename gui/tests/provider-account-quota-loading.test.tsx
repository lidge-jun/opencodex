import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useProviderAccountPools, type OAuthAccount, type ApiKeyEntry } from "../src/hooks/useProviderAccountPools";

const globals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let root: Root | null;
let host: HTMLElement;
let pools: ReturnType<typeof useProviderAccountPools>;
let requests: Array<{ url: string; signal?: AbortSignal | null }>;
let respond: (url: string, signal?: AbortSignal | null, init?: RequestInit) => Promise<Response>;
const noop = async () => {};
const reading = { fiveHourPercent: 21, weeklyPercent: 34, updatedAt: 1_700_000_000_000 };

for (const kind of ["oauth", "api-key"] as const) {
  for (const quotaMode of ["probe", "passive"] as const) {
    test(`${kind} ${quotaMode} newer quota failure cannot be cleared by a pre-selection probe`, async () => {
      let selected = "a";
      const oldQuota = deferred<Response>();
      const oldStarted = deferred<void>();
      let probes = 0;
      const rows = () => ["a", "b"].map(id => ({ id, masked: id, active: id === selected, quotaMode }));
      respond = async (url, _signal, init) => {
        if (init?.method === "PUT") { selected = "b"; return Response.json({ ok: true, activeAccountId: "b", activeId: "b" }); }
        if (url.includes("quota=1")) {
          if (++probes === 1) { oldStarted.resolve(); return oldQuota.promise; }
          return new Response(null, { status: 503 });
        }
        return Response.json({ activeAccountId: selected, activeId: selected, accounts: rows(), keys: rows() });
      };
      const load = () => kind === "oauth" ? pools.fetchAccountSets(["fixture"], true) : pools.fetchKeyPools(["fixture"], true);
      let old!: Promise<boolean>;
      await act(async () => { old = load(); await oldStarted.promise; });
      const before = rows();
      await act(async () => {
        if (kind === "oauth") await pools.switchAccount("fixture", before[1]);
        else await pools.switchApiKey("fixture", before[1]);
      });
      await act(async () => { expect(await load()).toBe(false); });
      await act(async () => {
        const enriched = before.map(row => ({ ...row, quota: reading }));
        oldQuota.resolve(Response.json({ activeAccountId: "a", activeId: "a", accounts: enriched, keys: enriched }));
        expect(await old).toBe(false);
      });
      const current = kind === "oauth" ? pools.accountSets.fixture.accounts : pools.keyPools.fixture;
      expect(current.find(row => row.active)?.id).toBe("b");
      expect(current[0]).toMatchObject({ quotaPending: false, quotaUnavailable: true });
      expect(current[0].quota).toBeUndefined();
    });

    for (const outcome of ["success", "unavailable", "null", "http-error"] as const) {
      test(`${kind} ${quotaMode} manual selection preserves initial quota ownership (${outcome})`, async () => {
        let selected = "a";
        let ids = ["a", "b", "removed"];
        const quota = deferred<Response>();
        const started = deferred<void>();
        const roster = () => ids.map(id => ({ id, masked: id, active: id === selected, quotaMode }));
        respond = async (url, _signal, init) => {
          if (init?.method === "PUT") {
            selected = "b";
            ids = ["a", "b", "new"];
            return Response.json({ ok: true, activeAccountId: selected, activeId: selected });
          }
          if (url.includes("quota=1")) { started.resolve(); return quota.promise; }
          return Response.json({ activeAccountId: selected, activeId: selected, accounts: roster(), keys: roster() });
        };
        let full!: Promise<boolean>;
        await act(async () => {
          full = kind === "oauth" ? pools.fetchAccountSets(["fixture"], true) : pools.fetchKeyPools(["fixture"], true);
          await started.promise;
        });
        const before = roster();
        const current = () => kind === "oauth" ? pools.accountSets.fixture.accounts : pools.keyPools.fixture;
        expect(current()[0].quotaPending).toBe(quotaMode === "probe");
        await act(async () => {
          if (kind === "oauth") await pools.switchAccount("fixture", before[1]);
          else await pools.switchApiKey("fixture", before[1]);
        });
        expect(current().find(row => row.active)?.id).toBe("b");
        expect(current()[0].quotaPending).toBe(quotaMode === "probe");
        const enriched = before.map(row => ({ ...row,
          quota: outcome === "null" ? null : reading,
          quotaUnavailable: outcome === "unavailable" || outcome === "null",
        }));
        await act(async () => {
          quota.resolve(outcome === "http-error" ? new Response(null, { status: 503 })
            : Response.json({ activeAccountId: "a", activeId: "a", accounts: enriched, keys: enriched }));
          expect(await full).toBe(outcome === "success");
        });
        expect(current().map(row => row.id)).toEqual(["a", "b", "new"]);
        expect(current().find(row => row.active)?.id).toBe("b");
        expect(current()[0]).toMatchObject({ quotaPending: false, quotaUnavailable: outcome !== "success" });
        expect(current()[0].quota).toEqual(outcome === "null" ? null : outcome === "http-error" ? undefined : reading);
        expect(current()[2].quota).toBeUndefined();
        expect(current()[2].quotaUnavailable).toBe(false);
        expect(requests.filter(request => request.url.includes("quota=1"))).toHaveLength(1);
      });
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function Harness({ apiBase = "/quota-hook" }: { apiBase?: string }) {
  const aliveRef = useRef(true);
  const currentPools = useProviderAccountPools({ apiBase, config: null, aliveRef, t: key => key,
    oauthStatus: {}, notify: () => {}, fetchConfig: noop, fetchOauth: noop,
    fetchProviderQuotas: noop, codexActiveNeedsReauth: false });
  useLayoutEffect(() => { pools = currentPools; }, [currentPools]);
  return null;
}
beforeEach(async () => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  requests = [];
  respond = async () => Response.json({ accounts: [], keys: [] });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), signal: init?.signal });
    return respond(String(input), init?.signal, init);
  } });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  await act(async () => { root = createRoot(host); root.render(<Harness />); });
});

for (const kind of ["oauth", "api-key"] as const) {
  test(`${kind} stale base failure cannot mark a newer successful selection read unavailable`, async () => {
    const rows = ["a", "b"].map(id => ({ id, masked: id, active: id === "a", quotaMode: "probe" as const,
      quota: reading, quotaPending: false, quotaUnavailable: false }));
    await act(async () => {
      if (kind === "oauth") pools.setAccountSets({ fixture: { activeAccountId: "a", accounts: rows } });
      else pools.setKeyPools({ fixture: rows });
    });
    const old = deferred<Response>();
    respond = async () => old.promise;
    let full!: Promise<boolean>;
    await act(async () => { full = kind === "oauth" ? pools.fetchAccountSets(["fixture"]) : pools.fetchKeyPools(["fixture"]); });
    respond = async () => Response.json({ activeAccountId: "b", activeId: "b", accounts: rows, keys: rows });
    await act(async () => { await pools.refreshAccountRosters({ provider: "fixture", kind }); });
    await act(async () => { old.resolve(new Response(null, { status: 503 })); expect(await full).toBe(false); });
    const result = kind === "oauth" ? pools.accountSets.fixture.accounts : pools.keyPools.fixture;
    expect(result.find(row => row.active)?.id).toBe("b");
    expect(result[0]).toMatchObject({ quota: reading, quotaUnavailable: false, quotaPending: false });
  });

  test(`${kind} selection reads preserve settled quota flags without enrichment`, async () => {
    const rows = ["a", "b"].map(id => ({ id, active: id === "a", masked: id,
      quotaMode: "probe" as const, quota: reading, quotaPending: false, quotaUnavailable: true }));
    await act(async () => {
      if (kind === "oauth") pools.setAccountSets({ fixture: { activeAccountId: "a", accounts: rows } });
      else pools.setKeyPools({ fixture: rows });
    });
    respond = async () => Response.json({ activeAccountId: "b", activeId: "b",
      accounts: rows.map(row => ({ id: row.id, active: row.id === "b", quotaMode: "probe" })),
      keys: rows.map(row => ({ id: row.id, masked: row.id, active: row.id === "b", quotaMode: "probe" })),
    });
    await act(async () => { await pools.refreshAccountRosters({ provider: "fixture", kind }); });
    const result = kind === "oauth" ? pools.accountSets.fixture.accounts : pools.keyPools.fixture;
    expect(result.find(row => row.active)?.id).toBe("b");
    expect(result[0]).toMatchObject({ quota: reading, quotaPending: false, quotaUnavailable: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).not.toContain("quota=");
  });

  test(`${kind} PUT invalidates old reads at start and settle and publishes the accepted selection immediately`, async () => {
    const rows = ["a", "b"].map(id => ({ id, active: id === "a", masked: id, quotaMode: "unsupported" as const }));
    await act(async () => {
      if (kind === "oauth") pools.setAccountSets({ fixture: { activeAccountId: "a", accounts: rows } });
      else pools.setKeyPools({ fixture: rows });
    });
    const beforePut = deferred<Response>();
    const duringPut = deferred<Response>();
    const afterPut = deferred<Response>();
    const put = deferred<Response>();
    let reads = 0;
    respond = async (_url, _signal, init) => init?.method === "PUT" ? put.promise
      : ++reads === 1 ? beforePut.promise : reads === 2 ? duringPut.promise : afterPut.promise;
    const read = () => kind === "oauth" ? pools.fetchAccountSets(["fixture"]) : pools.fetchKeyPools(["fixture"]);
    let old!: Promise<boolean>;
    let during!: Promise<boolean>;
    let switched!: Promise<unknown>;
    await act(async () => { old = read(); });
    await act(async () => { switched = kind === "oauth" ? pools.switchAccount("fixture", rows[1]) : pools.switchApiKey("fixture", rows[1]); });
    const roster = (id: string) => Response.json({ activeAccountId: id, activeId: id,
      accounts: rows.map(row => ({ ...row, active: row.id === id })), keys: rows.map(row => ({ ...row, active: row.id === id })) });
    await act(async () => { beforePut.resolve(roster("b")); expect(await old).toBe(false); });
    expect((kind === "oauth" ? pools.accountSets.fixture.accounts : pools.keyPools.fixture).find(row => row.active)?.id).toBe("a");
    await act(async () => { during = read(); });
    await act(async () => { put.resolve(Response.json({ ok: true, activeAccountId: "b", activeId: "b" })); });
    expect((kind === "oauth" ? pools.accountSets.fixture.accounts : pools.keyPools.fixture).find(row => row.active)?.id).toBe("b");
    await act(async () => { duringPut.resolve(roster("a")); expect(await during).toBe(false); });
    expect((kind === "oauth" ? pools.accountSets.fixture.accounts : pools.keyPools.fixture).find(row => row.active)?.id).toBe("b");
    await act(async () => { afterPut.resolve(roster("b")); await switched; });
  });
}
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); root = null; });
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM.close();
});

for (const kind of ["oauth", "api-key"] as const) {
  test(`${kind} push refresh overtakes a slow quota probe while late quota cannot change selection or resurrect rows`, async () => {
    const quota = deferred<Response>();
    const started = deferred<void>();
    const original = ["a", "b", "removed"].map(id => ({ id, masked: id, active: id === "a", quotaMode: "probe" as const }));
    respond = async url => {
      if (url.includes("quota=1")) { started.resolve(); return quota.promise; }
      return Response.json({ activeAccountId: "a", activeId: "a", accounts: original, keys: original });
    };
    let full!: Promise<boolean>;
    await act(async () => {
      full = kind === "oauth" ? pools.fetchAccountSets(["fixture"], true) : pools.fetchKeyPools(["fixture"], true);
      await started.promise;
    });
    const latest = original.filter(row => row.id !== "removed").map(row => ({ ...row, active: row.id === "b" }));
    respond = async () => Response.json({ activeAccountId: "b", activeId: "b", accounts: latest, keys: latest });
    await act(async () => { expect(await pools.refreshAccountRosters({ provider: "fixture", kind })).toBe(true); });
    const current = () => kind === "oauth" ? pools.accountSets.fixture.accounts : pools.keyPools.fixture;
    expect(current().find(row => row.active)?.id).toBe("b");
    expect(current()[0].quotaPending).toBe(true);
    const enriched = original.map(row => ({ ...row, quota: reading }));
    await act(async () => {
      quota.resolve(Response.json({ activeAccountId: "a", activeId: "a", accounts: enriched, keys: enriched }));
      expect(await full).toBe(true);
    });
    expect(current().map(row => row.id)).toEqual(["a", "b"]);
    expect(current().find(row => row.active)?.id).toBe("b");
    expect(current()[0]).toMatchObject({ quota: reading, quotaPending: false });
    expect(requests.filter(request => request.url.includes("quota=1"))).toHaveLength(1);
  });

  test(`${kind} rejected manual PUT retires reads begun during the write and reconciles without changing quota health`, async () => {
    const rows = ["a", "b"].map(id => ({ id, masked: id, active: id === "a", quotaMode: "probe" as const,
      quota: reading, quotaUnavailable: true, quotaPending: false }));
    await act(async () => {
      if (kind === "oauth") pools.setAccountSets({ fixture: { activeAccountId: "a", accounts: rows } });
      else pools.setKeyPools({ fixture: rows });
    });
    const put = deferred<Response>();
    const during = deferred<Response>();
    let reads = 0;
    respond = async (_url, _signal, init) => init?.method === "PUT" ? put.promise : ++reads === 1 ? during.promise
      : Response.json({ activeAccountId: "a", activeId: "a", accounts: rows, keys: rows });
    let changed!: Promise<unknown>;
    let old!: Promise<boolean>;
    await act(async () => { changed = kind === "oauth" ? pools.switchAccount("fixture", rows[1]) : pools.switchApiKey("fixture", rows[1]); });
    await act(async () => { old = kind === "oauth" ? pools.fetchAccountSets(["fixture"]) : pools.fetchKeyPools(["fixture"]); });
    await act(async () => { put.resolve(new Response(null, { status: 409 })); await changed; });
    await act(async () => { during.resolve(Response.json({ activeAccountId: "b", activeId: "b", accounts: [], keys: [] })); expect(await old).toBe(false); });
    const current = kind === "oauth" ? pools.accountSets.fixture.accounts : pools.keyPools.fixture;
    expect(current.find(row => row.active)?.id).toBe("a");
    expect(current[0]).toMatchObject({ quota: reading, quotaUnavailable: true, quotaPending: false });
  });
}

test("cheap probe rows paint with same-ID last-good; forced enrichment awaits and HTTP failure clears pending", async () => {
  const account: OAuthAccount = { id: "same", active: true, quotaMode: "probe", quota: reading };
  await act(async () => { pools.setAccountSets({ oauth: { activeAccountId: "same", accounts: [account, { ...account, id: "removed" }] } }); });
  const quota = deferred<Response>();
  const started = deferred<void>();
  respond = async url => {
    if (url.includes("quota=1")) { started.resolve(); return quota.promise; }
    return Response.json({ activeAccountId: "new", accounts: [
      { id: "same", active: false, quotaMode: "probe" }, { id: "new", active: true, quotaMode: "probe" },
    ] });
  };
  let result!: Promise<boolean>;
  let settled = false;
  await act(async () => { result = pools.fetchAccountSets(["oauth"], true); void result.then(() => { settled = true; }); await started.promise; });
  expect(pools.accountLoadStates.oauth).toBe("ready");
  expect(pools.accountSets.oauth.accounts.map(row => row.id)).toEqual(["same", "new"]);
  expect(pools.accountSets.oauth.accounts[0]).toMatchObject({ quota: reading, quotaPending: true });
  expect(pools.accountSets.oauth.accounts[1].quota).toBeUndefined();
  expect(settled).toBe(false);
  expect(requests[1].url).toContain("&quota=1&refresh=1");
  expect(requests.every(request => request.signal instanceof AbortSignal)).toBe(true);
  await act(async () => { quota.resolve(new Response(null, { status: 503 })); expect(await result).toBe(false); });
  expect(pools.accountSets.oauth.accounts[0]).toMatchObject({ quota: reading, quotaPending: false, quotaUnavailable: true });
  expect(pools.accountSets.oauth.accounts[1]).toMatchObject({ quotaPending: false, quotaUnavailable: true });
});

test("key subset refresh preserves other providers, clears old failure on success, and never calls OAuth", async () => {
  const key: ApiKeyEntry = { id: "key-a", masked: "masked", active: true, quotaMode: "probe", quota: reading, quotaUnavailable: true };
  await act(async () => { pools.setKeyPools({ first: [key], untouched: [{ ...key, id: "other" }] }); });
  const quota = deferred<Response>();
  const started = deferred<void>();
  respond = async url => {
    if (url.includes("quota=1")) { started.resolve(); return quota.promise; }
    return Response.json({ keys: [{ id: "key-a", masked: "masked", active: true, quotaMode: "probe" }] });
  };
  let result!: Promise<boolean>;
  await act(async () => { result = pools.fetchKeyPools(["first"], true); await started.promise; });
  expect(pools.keyPools.untouched[0].id).toBe("other");
  expect(pools.keyPools.first[0]).toMatchObject({ quota: reading, quotaPending: true, quotaUnavailable: false });
  await act(async () => {
    quota.resolve(Response.json({ keys: [{ id: "key-a", masked: "masked", active: true, quotaMode: "probe", quota: { ...reading, fiveHourPercent: 55 } }] }));
    expect(await result).toBe(true);
  });
  expect(pools.keyPools.first[0]).toMatchObject({ quotaPending: false, quotaUnavailable: false, quota: { fiveHourPercent: 55 } });
  expect(requests.every(request => request.url.includes("/api/providers/keys"))).toBe(true);
});

test("unsupported and unknown-mode rows do not enrich; passive missing observations never spin", async () => {
  for (const quotaMode of ["unsupported", undefined, "future-mode"]) {
    requests = [];
    respond = async () => Response.json({ keys: [{ id: "key", masked: "masked", active: true, quotaMode }] });
    await act(async () => { expect(await pools.fetchKeyPools(["keys"], true)).toBe(true); });
    expect(requests).toHaveLength(1);
    expect(pools.keyPools.keys[0].quotaPending).not.toBe(true);
    if (quotaMode !== "unsupported") {
      expect(pools.keyPools.keys[0].quotaPending).toBeUndefined();
      expect(pools.keyPools.keys[0].quotaUnavailable).toBeUndefined();
    }
  }
  const started = deferred<void>();
  const quota = deferred<Response>();
  respond = async url => {
    if (url.includes("quota=1")) { started.resolve(); return quota.promise; }
    return Response.json({ accounts: [{ id: "passive", active: true, quotaMode: "passive" }] });
  };
  await act(async () => { expect(await pools.fetchAccountSets(["passive"])).toBe(true); await started.promise; });
  expect(pools.accountSets.passive.accounts[0]).toMatchObject({ quotaMode: "passive", quotaPending: false });
  await act(async () => { quota.resolve(Response.json({ accounts: [{ id: "passive", active: true, quotaMode: "passive", quota: null }] })); });
  expect(pools.accountSets.passive.accounts[0].quota).toBeNull();
});

test("stale generations settle false and cannot overwrite a newer roster", async () => {
  const old = deferred<Response>();
  let call = 0;
  respond = async () => ++call === 1 ? old.promise : Response.json({ keys: [{ id: "new", active: true, masked: "new", quotaMode: "unsupported" }] });
  let first!: Promise<boolean>;
  await act(async () => { first = pools.fetchKeyPools(["keys"], true); });
  await act(async () => { expect(await pools.fetchKeyPools(["keys"], true)).toBe(true); });
  await act(async () => { old.resolve(Response.json({ keys: [{ id: "old", masked: "old", active: true, quotaMode: "unsupported" }] })); expect(await first).toBe(false); });
  expect(pools.keyPools.keys.map(row => row.id)).toEqual(["new"]);
});

test("one unavailable enriched account fails forced refresh and preserves its own last-good quota", async () => {
  respond = async url => Response.json({ accounts: [{ id: "account", active: true, quotaMode: "probe",
    ...(url.includes("quota=1") ? { quotaUnavailable: true } : { quota: reading }),
  }] });
  await act(async () => { expect(await pools.fetchAccountSets(["oauth"], true)).toBe(false); });
  expect(pools.accountSets.oauth.accounts[0]).toMatchObject({ quota: reading, quotaPending: false, quotaUnavailable: true });
});

test("explicit null in a failed enriched reading invalidates last-good for OAuth and keys", async () => {
  await act(async () => {
    pools.setAccountSets({ oauth: { activeAccountId: "account", accounts: [
      { id: "account", active: true, quotaMode: "probe", quota: reading },
    ] } });
    pools.setKeyPools({ keys: [
      { id: "key", active: true, masked: "masked", quotaMode: "probe", quota: reading },
    ] });
  });
  respond = async url => {
    const invalidation = url.includes("quota=1") ? { quota: null, quotaUnavailable: true } : {};
    return Response.json(url.includes("/api/oauth/accounts")
      ? { activeAccountId: "account", accounts: [{ id: "account", active: true, quotaMode: "probe", ...invalidation }] }
      : { keys: [{ id: "key", active: true, masked: "masked", quotaMode: "probe", ...invalidation }] });
  };
  await act(async () => {
    expect(await pools.fetchAccountSets(["oauth"], true)).toBe(false);
    expect(await pools.fetchKeyPools(["keys"], true)).toBe(false);
  });
  expect(pools.accountSets.oauth.accounts[0]).toMatchObject({ quota: null, quotaUnavailable: true, quotaPending: false });
  expect(pools.keyPools.keys[0]).toMatchObject({ quota: null, quotaUnavailable: true, quotaPending: false });
});

test("unmount aborts bounded roster reads and returns false", async () => {
  const started = deferred<void>();
  respond = async (_url, signal) => new Promise<Response>((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    started.resolve();
  });
  let result!: Promise<boolean>;
  await act(async () => { result = pools.fetchAccountSets(["oauth"], true); await started.promise; });
  await act(async () => { root!.unmount(); root = null; expect(await result).toBe(false); });
});

test("a hanging fetch reaches its deadline, preserves last-good and clears probe pending", async () => {
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  jest.useFakeTimers();
  Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
  try {
    await act(async () => { pools.setKeyPools({ keys: [{ id: "key", active: true, masked: "masked", quotaMode: "probe", quota: reading }] }); });
    const started = deferred<void>();
    respond = async (url, signal) => {
      if (!url.includes("quota=1")) return Response.json({ keys: [{ id: "key", active: true, masked: "masked", quotaMode: "probe" }] });
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
        started.resolve();
      });
    };
    let result!: Promise<boolean>;
    await act(async () => { result = pools.fetchKeyPools(["keys"], true); await started.promise; });
    expect(pools.keyPools.keys[0].quotaPending).toBe(true);
    await act(async () => { jest.advanceTimersByTime(20_000); expect(await result).toBe(false); });
    expect(pools.keyPools.keys[0]).toMatchObject({ quota: reading, quotaPending: false, quotaUnavailable: true });
  } finally {
    jest.useRealTimers();
    if (timeoutDescriptor) Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor);
    else Reflect.deleteProperty(AbortSignal, "timeout");
  }
});
