import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { NativeMainProfileSession } from "../src/native-main-profile-session";
import type { NativeMainAction, NativeMainDoctor, NativeMainList } from "../src/native-main-profiles";

const originalFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); globalThis.fetch = originalFetch; });
const a = { id: "00000000-0000-4000-8000-000000000001", label: "personal", identityHint: "native:11111111" };
const b = { id: "00000000-0000-4000-8000-000000000002", label: "work", identityHint: "native:22222222" };
const target: NativeMainAction = { kind: "switch", target: b.id, label: b.label };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(accountRefreshTimeoutMs?: number, injectFetch = false) {
  let home = "/srv/codex-fixture";
  let active = a.id;
  let recovery = false;
  let failRead = false;
  let failList = false;
  const labels: Record<string, string> = { [a.id]: a.label, [b.id]: b.label };
  const calls: { url: string; method: string; body: unknown; signal: AbortSignal | null | undefined }[] = [];
  const list = (): NativeMainList => ({ effectiveCodexHome: home, activeProfileId: active,
    profiles: [a, b].map(p => ({ ...p, label: labels[p.id], state: p.id === active ? "active" : "inactive" })) });
  const doctor = (): NativeMainDoctor => ({ effectiveCodexHome: home, activeProfileId: active,
    supported: true, authStatus: "ok", keyStore: "available", vaultStatus: failList ? "invalid" : "ok", recoveryPending: recovery });
  let intercept: ((url: string, init: RequestInit) => Promise<Response> | Response | undefined) | undefined;
  const fakeFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body, signal: init.signal });
    const intercepted = intercept?.(url, init);
    if (intercepted !== undefined) return intercepted;
    if (method === "GET") {
      if (failRead || failList && !url.endsWith("/doctor")) return json({ code: "VAULT_INVALID" }, 409);
      return json(url.endsWith("/doctor") ? doctor() : list());
    }
    if (url.endsWith("/register")) {
      labels[active] = body.label;
      return json({ effectiveCodexHome: home, profile: list().profiles.find(p => p.id === active) });
    }
    if (url.endsWith("/switch")) {
      active = body.target;
      return json({ ok: true, effectiveCodexHome: home, activeProfile: list().profiles.find(p => p.id === active), restartRequired: true });
    }
    if (url.endsWith("/recover")) {
      recovery = false; failList = false;
      return json({ ok: true, effectiveCodexHome: home, recovered: true, restartRequired: false });
    }
    throw new Error("unexpected route");
  };
  globalThis.fetch = injectFetch
    ? (() => { throw new Error("fixture: the session bypassed its injected fetch boundary"); }) as typeof fetch
    : fakeFetch as typeof fetch;
  const session = new NativeMainProfileSession("/proxy-a", accountRefreshTimeoutMs,
    injectFetch ? fakeFetch : undefined);
  let refreshes = 0;
  let accountReadOk = true;
  let accountReadHangs = false;
  const accountSignals: (AbortSignal | undefined)[] = [];
  session.updateOptions(false, signal => {
    refreshes++;
    accountSignals.push(signal);
    if (accountReadHangs) return new Promise(() => {});
    return accountReadOk;
  });
  const stop = session.attach(() => {});
  cleanups.push(stop);
  return { session, calls, list, doctor, stop,
    posts: () => calls.filter(c => c.method === "POST"), refreshes: () => refreshes,
    setHome: (value: string) => { home = value; }, setActive: (value: string) => { active = value; },
    setRecovery: (value: boolean) => { recovery = value; }, failRead: (value: boolean) => { failRead = value; },
    failList: (value: boolean) => { failList = value; }, accountReadOk: (value: boolean) => { accountReadOk = value; },
    accountReadHangs: (value: boolean) => { accountReadHangs = value; }, accountSignals: () => accountSignals,
    intercept: (value: typeof intercept) => { intercept = value; },
  };
}
async function select(f: ReturnType<typeof fixture>) {
  await f.session.toggle();
  f.session.select(target);
  f.session.setStopped(true);
}

describe("native-main disclosure session", () => {
  test("stays inert until opened and never writes before explicit confirmation", async () => {
    const f = fixture();
    assert.equal(f.calls.length, 0);
    await f.session.toggle();
    assert.equal(f.calls.length, 2);
    f.session.select(target);
    assert.equal(f.session.state.confirmedStopped, false);
    await f.session.confirm();
    assert.equal(f.posts().length, 0);
    f.session.setStopped(true);
    f.session.select(null);
    await f.session.confirm();
    assert.equal(f.posts().length, 0);
    assert.equal(f.session.state.confirmedStopped, false);
  });

  test("switches exactly once, reconciles the active card and requires restart", async () => {
    const f = fixture(); await select(f); await f.session.confirm();
    assert.deepEqual(f.posts().map(p => p.body), [{ target: b.id, confirmedStopped: true }]);
    assert.equal(f.posts()[0].url, "/proxy-a/api/native-main-profiles/switch");
    assert.equal(f.session.state.snapshot?.doctor.activeProfileId, b.id);
    assert.equal(f.session.state.result, "restart");
    assert.equal(f.session.state.previous?.id, a.id);
    assert.equal(f.session.state.confirmedStopped, false);
    assert.equal(f.session.state.action, null);
    assert.equal(f.refreshes(), 1);
    assert.equal(f.session.state.busy, false);
  });

  test("previous-profile return is an ordinary confirmed switch, not recovery", async () => {
    const f = fixture(); await select(f); await f.session.confirm();
    f.session.select({ kind: "switch", target: a.id, label: a.label });
    await f.session.confirm(); assert.equal(f.posts().length, 1);
    f.session.setStopped(true); await f.session.confirm();
    assert.equal(f.session.state.snapshot?.doctor.activeProfileId, a.id);
    assert.equal(f.posts().length, 2);
    assert.ok(f.posts().every(p => p.url.endsWith("/switch")));
  });

  test("duplicate clicks and refreshes cannot overlap an in-flight write", async () => {
    const f = fixture(); await select(f);
    const gate = deferred<Response>(); const entered = deferred<void>();
    f.intercept((url, init) => {
      if (init.method === "POST") { entered.resolve(); return gate.promise; }
    });
    const first = f.session.confirm(); await entered.promise;
    await f.session.confirm(); await f.session.refresh(); await f.session.toggle();
    assert.equal(f.posts().length, 1);
    f.setActive(b.id);
    gate.resolve(json({ ok: true, effectiveCodexHome: f.doctor().effectiveCodexHome,
      activeProfile: f.list().profiles.find(p => p.id === b.id), restartRequired: true }));
    await first;
    assert.equal(f.refreshes(), 1);
  });

  test("fresh preflight rejects a different home and resets stopped consent", async () => {
    const f = fixture(); await select(f); f.setHome("/other-home"); await f.session.confirm();
    assert.equal(f.posts().length, 0);
    assert.equal(f.session.state.error, "STATE_CHANGED");
    assert.equal(f.session.state.snapshot?.doctor.effectiveCodexHome, "/other-home");
    assert.equal(f.session.state.action, null);
    assert.equal(f.session.state.confirmedStopped, false);
  });

  test("fresh preflight rejects a changed active owner or recovery state", async () => {
    for (const kind of ["owner", "recovery"]) {
      const f = fixture(); await select(f);
      if (kind === "owner") f.setActive(b.id); else f.setRecovery(true);
      await f.session.confirm();
      assert.equal(f.posts().length, 0);
      assert.equal(f.session.state.error, "STATE_CHANGED");
      f.stop();
    }
  });

  test("blocking for another native operation cancels old consent and sends no write", async () => {
    const f = fixture(); await select(f);
    f.session.updateOptions(true, () => {});
    await f.session.confirm(); await f.session.register(); await f.session.refresh();
    assert.equal(f.posts().length, 0);
    assert.equal(f.session.state.action, null);
    f.session.updateOptions(false, () => {});
    f.session.select(target);
    assert.equal(f.session.state.confirmedStopped, false);
  });

  test("a block that arrives during preflight also prevents dispatch", async () => {
    const f = fixture(); await select(f);
    const gate = deferred<Response>(); const entered = deferred<void>();
    f.intercept((url, init) => {
      if (init.method === "GET" && url.endsWith("/doctor")) { entered.resolve(); return gate.promise; }
    });
    const pending = f.session.confirm(); await entered.promise;
    f.session.updateOptions(true, () => {});
    gate.resolve(json(f.doctor())); await pending;
    assert.equal(f.posts().length, 0);
    assert.equal(f.session.state.confirmedStopped, false);
  });

  test("unmount during preflight aborts and cannot dispatch after resolution", async () => {
    const f = fixture(); await select(f);
    const gate = deferred<Response>(); const entered = deferred<void>();
    f.intercept((url, init) => {
      if (init.method === "GET" && url.endsWith("/doctor")) { entered.resolve(); return gate.promise; }
    });
    const pending = f.session.confirm(); await entered.promise;
    f.stop(); gate.resolve(json(f.doctor())); await pending;
    assert.equal(f.posts().length, 0);
    assert.ok(f.calls.at(-1)?.signal?.aborted);
    assert.equal(f.refreshes(), 0);
  });

  test("unmount after dispatch suppresses reconciliation and old success publication", async () => {
    const f = fixture(); await select(f);
    const gate = deferred<Response>(); const entered = deferred<void>();
    f.intercept((_url, init) => {
      if (init.method === "POST") { entered.resolve(); return gate.promise; }
    });
    const pending = f.session.confirm(); await entered.promise;
    const callCount = f.calls.length;
    f.stop(); f.setActive(b.id);
    gate.resolve(json({ ok: true, effectiveCodexHome: f.doctor().effectiveCodexHome,
      activeProfile: f.list().profiles.find(p => p.id === b.id), restartRequired: true }));
    await pending;
    assert.equal(f.calls.length, callCount);
    assert.equal(f.session.state.result, null);
    assert.equal(f.refreshes(), 0);
  });

  test("StrictMode-style detach/reattach does not revive an old async operation", async () => {
    const f = fixture();
    const gate = deferred<Response>();
    f.intercept((url, init) => init.method === "GET" && url.endsWith("/doctor") ? gate.promise : undefined);
    const pending = f.session.toggle();
    f.stop(); let observed = 0;
    cleanups.push(f.session.attach(() => { observed++; }));
    const count = observed;
    gate.resolve(json(f.doctor())); await pending;
    assert.equal(observed, count);
    assert.equal(f.session.state.snapshot, null);
    assert.equal(f.session.state.busy, false);
    f.intercept(undefined); await f.session.refresh();
    assert.equal(f.session.state.snapshot?.doctor.activeProfileId, a.id);
  });

  test("a lost POST response rereads committed state without claiming rollback or retrying", async () => {
    const f = fixture(); await select(f);
    f.intercept((_url, init) => {
      if (init.method === "POST") { f.setActive(b.id); throw new Error("fixture-secret"); }
    });
    await f.session.confirm();
    assert.equal(f.posts().length, 1);
    assert.equal(f.session.state.snapshot?.doctor.activeProfileId, b.id);
    assert.equal(f.session.state.error, "NETWORK_ERROR");
    assert.equal(f.session.state.result, null);
    assert.equal(f.session.state.previous, null);
    assert.equal(f.refreshes(), 1);
    assert.doesNotMatch(JSON.stringify(f.session.state), /fixture-secret/);
  });

  test("failed profile read after success still refreshes the main account and blocks another mutation", async () => {
    const f = fixture(); await select(f);
    f.intercept((_url, init) => {
      if (init.method === "POST") f.failRead(true);
    });
    await f.session.confirm();
    assert.equal(f.session.state.result, "restart");
    assert.equal(f.session.state.snapshot, null);
    assert.equal(f.session.state.refreshFailed, true);
    assert.equal(f.refreshes(), 1);
    f.session.setLabel("renamed"); await f.session.register();
    assert.equal(f.posts().length, 1);
    f.failRead(false); await f.session.refresh();
    assert.equal(f.session.state.refreshFailed, false);
    assert.equal(f.refreshes(), 2);
  });

  test("account-refresh failure blocks writes until a successful explicit readback", async () => {
    const f = fixture(); await select(f); f.accountReadOk(false); await f.session.confirm();
    assert.equal(f.session.state.refreshFailed, true);
    f.session.select({ kind: "switch", target: a.id, label: a.label });
    assert.equal(f.session.state.action, null);
    f.accountReadOk(true); await f.session.refresh();
    assert.equal(f.session.state.refreshFailed, false);
    assert.equal(f.posts().length, 1);
  });

  test("an account refresh that never settles is cancelled and releases the session", async () => {
    const f = fixture(25);
    await select(f);
    f.accountReadHangs(true);
    await f.session.confirm();
    assert.equal(f.session.state.busy, false);
    assert.equal(f.session.state.refreshFailed, true);
    assert.equal(f.accountSignals().at(-1)?.aborted, true);
    // The session still accepts work: an unsettled callback must not strand `pending`.
    f.accountReadHangs(false);
    await f.session.refresh();
    assert.equal(f.session.state.refreshFailed, false);
    assert.equal(f.session.state.busy, false);
  });

  test("pending recovery remains available without a readable list and sends exact rollback consent", async () => {
    const f = fixture(); f.setRecovery(true); f.failList(true); await f.session.toggle();
    assert.equal(f.session.state.snapshot?.list, null);
    f.session.select({ kind: "recover", rollback: true });
    await f.session.confirm(); assert.equal(f.posts().length, 0);
    f.session.setStopped(true); await f.session.confirm();
    assert.deepEqual(f.posts().map(p => p.body), [{ rollback: true, confirmedStopped: true }]);
    assert.equal(f.session.state.snapshot?.doctor.recoveryPending, false);
    assert.equal(f.session.state.result, "done");
  });

  test("rename uses only the registration endpoint and cannot dismiss a prior restart requirement", async () => {
    const f = fixture(); await select(f); await f.session.confirm();
    f.session.setLabel("  renamed  "); await f.session.register();
    assert.equal(f.posts()[1].url, "/proxy-a/api/native-main-profiles/register");
    assert.deepEqual(f.posts()[1].body, { label: "renamed" });
    assert.equal(f.session.state.snapshot?.doctor.activeProfileId, b.id);
    assert.equal(f.session.state.result, "restart");
    assert.equal(f.session.state.label, "");
  });

  test("an external owner or home change invalidates the previous-profile shortcut", async () => {
    const f = fixture(); await select(f); await f.session.confirm();
    f.setHome("/different"); await f.session.refresh();
    assert.equal(f.session.state.previous, null);
    assert.equal(f.session.state.result, null);
  });

  test("another apiBase gets no confirmation, return hint or response from the old instance", async () => {
    const f = fixture(); await select(f); await f.session.confirm(); f.stop();
    const next = new NativeMainProfileSession("/proxy-b"); cleanups.push(next.attach(() => {}));
    assert.equal(next.state.snapshot, null); assert.equal(next.state.previous, null);
    assert.equal(next.state.confirmedStopped, false);
    await next.toggle();
    assert.ok(f.calls.slice(-2).every(c => c.url.startsWith("/proxy-b/")));
  });

  test("an injected fetch carries the read and the confirmed write on one boundary", async () => {
    const f = fixture(undefined, true);
    await select(f); await f.session.confirm();
    assert.deepEqual(f.posts().map(p => p.body), [{ target: b.id, confirmedStopped: true }]);
    assert.equal(f.posts()[0].url, "/proxy-a/api/native-main-profiles/switch");
    assert.equal(f.session.state.snapshot?.doctor.activeProfileId, b.id);
    assert.equal(f.session.state.result, "restart");
  });

  test("an injected fetch carries registration on the same boundary", async () => {
    const f = fixture(undefined, true);
    await f.session.toggle();
    f.session.setLabel("  renamed  ");
    await f.session.register();
    assert.deepEqual(f.posts().map(p => p.body), [{ label: "renamed" }]);
    assert.equal(f.session.state.result, "saved");
  });
});
