import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  applyNativeMain, canApplyNativeMain, canRegisterNativeMain, NativeMainError,
  nativeMainErrorCode, nativeMainUnavailableCode, parseNativeMainDoctor, parseNativeMainList,
  readNativeMainSnapshot, registerNativeMain, sameNativeMainScope, type NativeMainSnapshot,
} from "../src/native-main-profiles";

const home = "/srv/codex-fixture";
const personal = { id: "00000000-0000-4000-8000-000000000001", label: "personal", identityHint: "native:11111111", state: "active" as const };
const work = { id: "00000000-0000-4000-8000-000000000002", label: "work", identityHint: "native:22222222", state: "inactive" as const };
function snapshot(): NativeMainSnapshot {
  return {
    list: { effectiveCodexHome: home, activeProfileId: personal.id, profiles: [personal, work] },
    doctor: { effectiveCodexHome: home, activeProfileId: personal.id, supported: true,
      authStatus: "ok", keyStore: "available", vaultStatus: "ok", recoveryPending: false },
  };
}
const target = { kind: "switch" as const, target: work.id, label: work.label };
const signal = () => new AbortController().signal;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init ?? {}))) as typeof fetch;
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
function errorIs(code: string) { return (e: unknown) => e instanceof NativeMainError && e.code === code; }

describe("native main management boundary", () => {
  test("projects only public fields, excluding unknown credential-shaped data", () => {
    const source = snapshot().list!;
    const safe = parseNativeMainList({ ...source, key: "fixture-secret", profiles: source.profiles.map(p => ({
      ...p, accountId: "fixture-account", payload: { ciphertext: "fixture-secret" }, access_token: "fixture-secret",
    })) });
    assert.deepEqual(safe, source);
    assert.doesNotMatch(JSON.stringify(safe), /fixture-secret|fixture-account|payload|token/);
  });

  test("rejects ambiguous IDs, invalid ownership, unknown states and excessive entries", () => {
    const s = snapshot().list!;
    for (const value of [null, { ...s, profiles: [personal, personal] }, { ...s, activeProfileId: work.id },
      { ...s, activeProfileId: null }, { ...s, profiles: [personal, { ...work, state: "unknown" }] },
      { ...s, profiles: Array.from({ length: 33 }, () => personal) }]) {
      assert.throws(() => parseNativeMainList(value), errorIs("INVALID_RESPONSE"));
    }
    assert.deepEqual(parseNativeMainList({ effectiveCodexHome: home, activeProfileId: null, profiles: [] }).profiles, []);
  });

  test("doctor projection excludes internals and rejects incomplete diagnostics", () => {
    const d = snapshot().doctor;
    assert.deepEqual(parseNativeMainDoctor({ ...d, writerToken: "fixture-secret", rawAccountId: "fixture-account" }), d);
    assert.throws(() => parseNativeMainDoctor({ ...d, supported: "yes" }), errorIs("INVALID_RESPONSE"));
    assert.throws(() => parseNativeMainDoctor({ ...d, authStatus: "unknown" }), errorIs("INVALID_RESPONSE"));
  });

  test("uses existing GET paths, the supplied signal and no persistent cache", async () => {
    const calls: string[] = [];
    const s = snapshot(); const abort = signal();
    mockFetch((url, init) => {
      calls.push(url);
      assert.equal(init.method, "GET"); assert.equal(init.signal, abort); assert.equal(init.cache, "no-store");
      assert.equal(init.body, undefined); assert.equal(init.headers, undefined);
      return json(url.endsWith("/doctor") ? s.doctor : s.list);
    });
    assert.deepEqual(await readNativeMainSnapshot("/proxy-a", abort), s);
    assert.deepEqual(calls.sort(), ["/proxy-a/api/native-main-profiles", "/proxy-a/api/native-main-profiles/doctor"]);
  });

  test("keeps recovery reachable when a broken vault prevents listing", async () => {
    const d = { ...snapshot().doctor, vaultStatus: "invalid", recoveryPending: true };
    mockFetch(url => url.endsWith("/doctor") ? json(d) : json({ code: "VAULT_INVALID" }, 409));
    const s = await readNativeMainSnapshot("", signal());
    assert.equal(s.list, null);
    assert.equal(canApplyNativeMain(s, { kind: "recover", rollback: true }), true);
    assert.equal(canRegisterNativeMain(s), false);
  });

  test("does not hide a failed list when no recovery is pending", async () => {
    mockFetch(url => url.endsWith("/doctor") ? json(snapshot().doctor) : json({ code: "VAULT_INVALID" }, 409));
    await assert.rejects(readNativeMainSnapshot("", signal()), errorIs("VAULT_INVALID"));
  });

  test("rejects inconsistent homes or owners between reads", async () => {
    for (const patch of [{ effectiveCodexHome: "/other-home" }, { activeProfileId: work.id }]) {
      mockFetch(url => json(url.endsWith("/doctor") ? { ...snapshot().doctor, ...patch } : snapshot().list));
      await assert.rejects(readNativeMainSnapshot("", signal()), errorIs("STATE_CHANGED"));
    }
  });

  test("refuses an already-aborted scope before any request", async () => {
    const controller = new AbortController(); let calls = 0;
    mockFetch(() => { calls++; return json({}); });
    controller.abort();
    await assert.rejects(readNativeMainSnapshot("", controller.signal));
    assert.equal(calls, 0);
  });

  test("registration submits only the trimmed label and validates the returned profile", async () => {
    mockFetch((url, init) => {
      assert.equal(url, "/api/native-main-profiles/register");
      assert.equal(init.method, "POST"); assert.deepEqual(JSON.parse(String(init.body)), { label: "personal" });
      return json({ effectiveCodexHome: home, profile: personal, ignored: "fixture-secret" });
    });
    assert.equal(await registerNativeMain("", "  personal  ", signal()), home);
    mockFetch(() => json({ effectiveCodexHome: home, profile: work }));
    await assert.rejects(registerNativeMain("", "work", signal()), errorIs("INVALID_RESPONSE"));
  });

  test("refuses an unconfirmed mutation before sending a request", async () => {
    let calls = 0;
    mockFetch(() => { calls++; return json({}); });
    await assert.rejects(applyNativeMain("", target, false, signal()), errorIs("INVALID_REQUEST"));
    assert.equal(calls, 0);
  });

  test("switch sends only the safe profile ID and explicit stopped consent", async () => {
    mockFetch((url, init) => {
      assert.equal(url, "/api/native-main-profiles/switch");
      assert.deepEqual(JSON.parse(String(init.body)), { target: work.id, confirmedStopped: true });
      return json({ ok: true, effectiveCodexHome: home, restartRequired: true, activeProfile: { ...work, state: "active" }, key: "fixture-secret" });
    });
    assert.deepEqual(await applyNativeMain("", target, true, signal()), { effectiveCodexHome: home, restartRequired: true });
  });

  test("does not treat an unrelated profile or malformed success as a switch", async () => {
    for (const outcome of [
      { ok: true, effectiveCodexHome: home, restartRequired: true, activeProfile: personal },
      { ok: true, effectiveCodexHome: home, recovered: false },
      { ok: false, effectiveCodexHome: home, restartRequired: true },
    ]) {
      mockFetch(() => json(outcome));
      await assert.rejects(applyNativeMain("", target, true, signal()), errorIs("INVALID_RESPONSE"));
    }
  });

  test("recovery distinguishes rollback, no-op and restart-required outcomes", async () => {
    for (const rollback of [false, true]) {
      mockFetch((url, init) => {
        assert.equal(url, "/api/native-main-profiles/recover");
        assert.deepEqual(JSON.parse(String(init.body)), { rollback, confirmedStopped: true });
        return json({ ok: true, effectiveCodexHome: home, recovered: false });
      });
      assert.deepEqual(await applyNativeMain("", { kind: "recover", rollback }, true, signal()),
        { effectiveCodexHome: home, recovered: false, restartRequired: false });
    }
    mockFetch(() => json({ ok: true, effectiveCodexHome: home, recovered: true, restartRequired: true }));
    assert.equal((await applyNativeMain("", { kind: "recover", rollback: true }, true, signal())).restartRequired, true);
  });

  test("exposes allowlisted codes, never raw error messages or token-shaped fields", async () => {
    for (const [code, expected] of [["CODEX_BUSY", "CODEX_BUSY"], ["fixture-secret", "INTERNAL_ERROR"]]) {
      mockFetch(() => json({ code, error: "fixture-secret", access_token: "fixture-secret" }, 409));
      await assert.rejects(applyNativeMain("", target, true, signal()), e => {
        assert.equal(nativeMainErrorCode(e), expected);
        assert.doesNotMatch(String(e), /fixture-secret/);
        return true;
      });
    }
    assert.equal(nativeMainErrorCode(new Error("fixture-secret")), "NETWORK_ERROR");
    mockFetch(() => new Response("fixture-secret", { status: 500 }));
    await assert.rejects(applyNativeMain("", target, true, signal()), errorIs("INVALID_RESPONSE"));
  });

  test("blocks unsafe stores, unavailable keys, invalid auth and pending recovery", () => {
    const s = snapshot();
    assert.equal(canRegisterNativeMain(s), true); assert.equal(canApplyNativeMain(s, target), true);
    for (const patch of [{ supported: false }, { keyStore: "missing-key" as const }, { authStatus: "missing" as const },
      { vaultStatus: "invalid" as const }, { recoveryPending: true }]) {
      const unavailable = { ...s, doctor: { ...s.doctor, ...patch } };
      assert.equal(canRegisterNativeMain(unavailable), false);
      assert.equal(canApplyNativeMain(unavailable, target), false);
      assert.notEqual(nativeMainUnavailableCode(unavailable), null);
    }
    assert.equal(canApplyNativeMain(s, { ...target, label: "renamed" }), false);
    assert.equal(canApplyNativeMain(s, { kind: "recover", rollback: false }), false);
  });

  test("confirmation scope includes the home, active owner and recovery state", () => {
    const s = snapshot();
    assert.equal(sameNativeMainScope(s, snapshot()), true);
    for (const patch of [{ effectiveCodexHome: "/other-home" }, { activeProfileId: work.id }, { recoveryPending: true }]) {
      assert.equal(sameNativeMainScope(s, { ...s, doctor: { ...s.doctor, ...patch } }), false);
    }
  });
});
