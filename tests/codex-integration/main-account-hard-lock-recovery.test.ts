import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchMainAccountInfo, fetchMainAccountInfoSnapshot, listCodexAuthAccounts,
  registerCodexCooldownRecoveryProbeWorker, runMainAccountHardLockRecovery,
} from "../../src/codex/auth-api";
import { fetchMainAccountInfoAttempt } from "../../src/codex/auth-api/main-account-probe";
import { MAIN_CODEX_ACCOUNT_ID as MAIN } from "../../src/codex/account-id";
import { reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { clearAccountNeedsReauth, isAccountNeedsReauth, markAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { captureMainQuotaWriter, clearMainAccountInfoCache, getMainAccountInfoCache, setMainAccountInfoCache } from "../../src/codex/main-account-cache";
import { getMainAccountHardLockStatus } from "../../src/codex/main-account-hard-lock";
import { setMainAccountPlan } from "../../src/codex/main-account";
import { clearAccountQuota, getAccountQuota, getMainPolicyQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, getCodexQuotaHealthSnapshot, recordCodexUpstreamOutcome } from "../../src/codex/routing";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import * as sweeper from "../../src/lib/state-store-sweeper";
import {
  acquireNativeMainProfileDrain, getNativeMainProfileRequestCount, resetLifecycleDrainStateForTests,
} from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const accountId = "fixture-recovery-main";
const whamUrl = "https://chatgpt.com/backend-api/wham/usage";
const tokenUrl = "https://auth.openai.com/oauth/token";
let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let previousFetch: typeof fetch;

/** Build the minimal proxy configuration with main-account hard-lock recovery enabled. */
function config(): OcxConfig {
  return { port: 10100, defaultProvider: "openai", providers: { openai: {
    adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
    authMode: "forward", codexAccountMode: "pool",
  } }, codexMainAccountHardLock: true };
}

/** Encode synthetic account and expiry claims for the fixture; this is not a signed credential. */
function bearer(expired = false): string {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + (expired ? -120 : 86_400),
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

/** Write fixture credentials into the isolated home and reconcile the active main identity. */
function writeMain(expired = false): void {
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: {
    access_token: bearer(expired), refresh_token: "fixture-refresh", account_id: accountId,
  } }));
  reconcileMainCodexAccountRuntimeState();
}

/** Seed a 99% short-window block for the observed fixture identity, even though its reset elapsed. */
function block(): void {
  const writer = captureMainQuotaWriter(accountId);
  if (!writer) throw new Error("Fixture identity must be observed");
  setAccountQuotaFromParsed(MAIN, { shortPercent: 99, shortWindowSeconds: 18_000, shortResetAt: 1 }, undefined, writer);
}

function usage(percent = 0): Response {
  return Response.json({ plan_type: "plus", rate_limit: {
    primary_window: { used_percent: percent, limit_window_seconds: 18_000, reset_at: 1 },
  } });
}

/**
 * Stub recovery HTTP calls, requiring a known metadata/token URL and an active native-main drain.
 * Return the captured URL list so tests can verify the requests made by background recovery.
 */
function fetchWith(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: string[] = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect([whamUrl, tokenUrl]).toContain(url);
    expect(getNativeMainProfileRequestCount()).toBe(1);
    return handler(url, init);
  }, { preconnect: previousFetch.preconnect });
  return calls;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  previousFetch = globalThis.fetch;
  home = mkdtempSync(join(tmpdir(), "ocx-main-recovery-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  const aclOk = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => aclOk);
  setAsyncIcaclsRunnerForTests(async () => aclOk);
  clearAccountQuota();
  clearAccountNeedsReauth(MAIN);
  clearCodexUpstreamHealth();
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  setMainAccountPlan(null);
  writeMain();
  block();
});

afterEach(async () => {
  globalThis.fetch = previousFetch;
  clearAccountQuota();
  clearAccountNeedsReauth(MAIN);
  clearCodexUpstreamHealth();
  clearMainAccountInfoCache();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  setMainAccountPlan(null);
  try {
    await flushConfigDirHardeningForTests();
  } finally {
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    removeTreeWithRetry(home);
  }
});

describe("main hard-lock background recovery", () => {
  test("known reset waits locally, then verifies recovery instead of unlocking by time", async () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      const deadline = now + 3_600_000;
      setAccountQuotaFromParsed(MAIN, { shortPercent: 99, shortWindowSeconds: 18_000,
        shortResetAt: deadline }, undefined, captureMainQuotaWriter(accountId));
      const calls = fetchWith(async () => usage(99));
      for (let tick = 0; tick < 60; tick++, now += 60_000) await runMainAccountHardLockRecovery(config());
      expect(calls).toEqual([]);
      expect(getMainAccountHardLockStatus(config()).state).toBe("blocked");
      await runMainAccountHardLockRecovery(config());
      expect(calls).toEqual([whamUrl]);
      now += 60_000;
      await runMainAccountHardLockRecovery(config());
      expect(calls).toHaveLength(1);
      now += 240_000;
      const recovery = fetchWith(async () => usage(0));
      await runMainAccountHardLockRecovery(config());
      expect(recovery).toEqual([whamUrl]);
      expect(getMainAccountHardLockStatus(config()).state).toBe("ready");
    } finally { clock.mockRestore(); }
  });

  test("manual reads and hard-lock recovery share Retry-After without claiming fresh evidence", async () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const calls = fetchWith(async () => new Response("{}", { status: 429, headers: { "Retry-After": "900" } }));
    try {
      await runMainAccountHardLockRecovery(config());
      for (let tick = 0; tick < 14; tick++) {
        now += 60_000;
        const skipped = await fetchMainAccountInfoAttempt(true, 0);
        expect(skipped.freshQuota).toBeUndefined();
        expect(skipped.resetRecoveryProof).toBeUndefined();
        expect(skipped.quotaRefresh).toBeUndefined();
        await runMainAccountHardLockRecovery(config());
      }
      expect(calls).toEqual([whamUrl]);
      expect(getMainAccountHardLockStatus(config()).state).toBe("blocked");
      now += 60_000;
      await fetchMainAccountInfo(true);
      expect(calls).toHaveLength(2);
    } finally { clock.mockRestore(); }
  });

  test("post-reset Retry-After paces ordinary main reads and hard-lock sweeps", async () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    let reads = 0;
    const calls = fetchWith(async () => ++reads === 1
      ? new Response("{}", { status: 429, headers: { "Retry-After": "900" } })
      : usage(0));
    try {
      await fetchMainAccountInfoAttempt(true, 1, undefined, false, true, true, config());
      for (let tick = 0; tick < 14; tick++) {
        now += 60_000;
        await fetchMainAccountInfo(true, config());
        await runMainAccountHardLockRecovery(config());
      }
      expect(calls).toEqual([whamUrl]);
      now += 60_000;
      await runMainAccountHardLockRecovery(config());
      expect(calls).toEqual([whamUrl, whamUrl]);
      expect(getMainAccountHardLockStatus(config()).state).toBe("ready");
    } finally { clock.mockRestore(); }
  });

  test("an ordinary Retry-After prevents recovery token preparation until credential replacement", async () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      writeMain(true);
      block();
      const calls = fetchWith(async url => url === tokenUrl
        ? Response.json({ access_token: bearer(), refresh_token: "fixture-rotated", expires_in: 86_400 })
        : new Response("{}", { status: 429, headers: { "Retry-After": "900" } }));
      await fetchMainAccountInfo(true);
      for (let tick = 0; tick < 14; tick++) {
        now += 60_000;
        await runMainAccountHardLockRecovery(config());
      }
      // An expired physical token would require token-endpoint work if the lease were entered.
      expect(calls).toEqual([whamUrl]);
      writeMain();
      block();
      globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
        calls.push(String(input));
        expect(getNativeMainProfileRequestCount()).toBe(1);
        return usage(0);
      }, { preconnect: previousFetch.preconnect });
      await runMainAccountHardLockRecovery(config());
      expect(calls).toEqual([whamUrl, whamUrl]);
      expect(getMainAccountHardLockStatus(config()).state).toBe("ready");
    } finally { clock.mockRestore(); }
  });

  test.each(["900", "999999999"])("Retry-After %s prevents recovery preparation before the deadline", async header => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const calls = fetchWith(async url => url === tokenUrl
      ? Response.json({ access_token: bearer(), refresh_token: "fixture-rotated", expires_in: 86_400 })
      : new Response("{}", { status: 429, headers: { "Retry-After": header } }));
    try {
      await runMainAccountHardLockRecovery(config());
      const delay = header === "900" ? 900_000 : 86_400_000;
      now += delay - 1;
      await runMainAccountHardLockRecovery(config());
      expect(calls).toEqual([whamUrl]);
      now++;
      await runMainAccountHardLockRecovery(config());
      expect(calls.filter(url => url === whamUrl)).toHaveLength(2);
    } finally { clock.mockRestore(); }
  });

  test("malformed main 200 keeps failed-read pacing", async () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    let count = 0;
    const calls = fetchWith(async () => ++count === 1 ? Response.json({}) : usage(0));
    try {
      await fetchMainAccountInfo(true);
      await fetchMainAccountInfo(true);
      expect(calls).toHaveLength(1);
      expect(getMainAccountHardLockStatus(config()).state).toBe("blocked");
      now += 300_000;
      await fetchMainAccountInfo(true);
      expect(calls).toHaveLength(2);
      expect(getMainAccountHardLockStatus(config()).state).toBe("ready");
    } finally { clock.mockRestore(); }
  });

  test.each([401, 403])("nonterminal HTTP %s retries on the next hard-lock sweep", async status => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const calls = fetchWith(async () => Response.json({}, { status }));
    try {
      await runMainAccountHardLockRecovery(config());
      now += 60_000;
      await runMainAccountHardLockRecovery(config());
      expect(calls).toEqual([whamUrl, whamUrl]);
      expect(isAccountNeedsReauth(MAIN)).toBe(false);
      expect(getMainAccountHardLockStatus(config()).state).toBe("blocked");
    } finally { clock.mockRestore(); }
  });

  test.each([401, 403])("terminal HTTP %s keeps reauth quarantine", async status => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const calls = fetchWith(async () => Response.json({ detail: { code: "invalid_workspace_selected" } }, { status }));
    try {
      await runMainAccountHardLockRecovery(config());
      now += 60_000;
      await runMainAccountHardLockRecovery(config());
      expect(calls).toEqual([whamUrl]);
      expect(isAccountNeedsReauth(MAIN)).toBe(true);
    } finally { clock.mockRestore(); }
  });

  test("a published post-reset quota clears an older same-credential failure", async () => {
    const entered = deferred<void>();
    const releaseBody = deferred<void>();
    let reads = 0;
    const calls: string[] = [];
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      expect(getNativeMainProfileRequestCount()).toBeGreaterThan(0);
      if (++reads === 1) return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          entered.resolve();
          await releaseBody.promise;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ plan_type: "plus", rate_limit: {
            primary_window: { used_percent: 99, limit_window_seconds: 18_000, reset_at: 1 },
          } })));
          controller.close();
        },
      }), { headers: { "Content-Type": "application/json" } });
      return reads === 2 ? new Response(null, { status: 503 }) : usage(0);
    }, { preconnect: previousFetch.preconnect });
    const first = fetchMainAccountInfoAttempt(true, 1, undefined, false, false, true, config());
    try {
      await entered.promise;
      await fetchMainAccountInfoAttempt(true, 1, undefined, false, false, true, config());
      releaseBody.resolve();
      expect((await first).freshQuota?.shortPercent).toBe(99);
      await fetchMainAccountInfo(true, config());
      expect(calls).toEqual([whamUrl, whamUrl, whamUrl]);
      expect(getMainAccountHardLockStatus(config()).state).toBe("ready");
    } finally { releaseBody.resolve(); await first; }
  });

  test("successful but blocked recovery uses capped backoff without extending it on skipped ticks", async () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const calls = fetchWith(async () => usage(99));
    try {
      await runMainAccountHardLockRecovery(config());
      for (const minutes of [5, 10, 20, 40, 60, 60]) {
        const count = calls.length;
        now += minutes * 60_000 - 1;
        await runMainAccountHardLockRecovery(config());
        expect(calls).toHaveLength(count);
        now++;
        await runMainAccountHardLockRecovery(config());
        expect(calls).toHaveLength(count + 1);
      }
      expect(getMainAccountHardLockStatus(config()).state).toBe("blocked");
    } finally { clock.mockRestore(); }
  });

  test("a replacement main credential does not inherit recovery backoff", async () => {
    const calls = fetchWith(async () => usage(99));
    await runMainAccountHardLockRecovery(config());
    writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: {
      access_token: bearer() + "replacement", refresh_token: "fixture-new", account_id: accountId,
    } }));
    reconcileMainCodexAccountRuntimeState();
    block();
    await runMainAccountHardLockRecovery(config());
    expect(calls).toHaveLength(2);
  });
  test("a replaced credential's delayed malformed body returns current cached info", async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    const authPath = join(home, "auth.json");
    const replacement = JSON.parse(readFileSync(authPath, "utf8"));
    replacement.tokens.access_token += "-rotated";
    setMainAccountInfoCache({ email: null, plan: "plus", quota: { shortPercent: 99 }, ts: 1 });
    let reads = 0;
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toBe(whamUrl);
      if (++reads > 1) return new Response(null, { status: 503 });
      const response = Response.json({});
      response.json = async () => {
        started.resolve();
        await finish.promise;
        throw new SyntaxError("malformed fixture");
      };
      return response;
    }, { preconnect: previousFetch.preconnect });
    const pending = fetchMainAccountInfoAttempt(true, 0);
    try {
      await started.promise;
      writeFileSync(authPath, JSON.stringify(replacement));
      expect((await fetchMainAccountInfoAttempt(true, 0)).quotaRefresh?.status).toBe("http_error");
      const info = structuredClone(getMainAccountInfoCache());
      finish.resolve();
      const result = await pending;
      expect(result.info).toEqual(info);
      expect(result.quotaRefresh).toBeUndefined();
      expect(result.freshQuota).toBeUndefined();
    } finally {
      finish.resolve();
      await pending;
    }
  });

  for (const phase of ["request", "body"] as const) {
    test.each(["unchanged", "replaced", "restored"] as const)(`delayed ${phase} response respects %s same-account credentials`, async transition => {
      const started = deferred<void>();
      const finish = deferred<void>();
      const authPath = join(home, "auth.json");
      const originalAuth = readFileSync(authPath, "utf8");
      const replacement = JSON.parse(originalAuth);
      replacement.tokens.access_token += "-rotated";
      const data = { plan_type: "prolite", rate_limit: {
        primary_window: { used_percent: 64, limit_window_seconds: 604_800 }, secondary_window: null, tertiary_window: null,
      }, rate_limit_reset_credits: { available_count: 2 } };
      let reads = 0;
      globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
        expect(String(input)).toBe(whamUrl);
        if (++reads > 1) return new Response(null, { status: 503 });
        if (phase === "request") {
          started.resolve();
          await finish.promise;
        }
        const response = Response.json(data);
        if (phase === "body") response.json = async () => {
          started.resolve();
          await finish.promise;
          return data;
        };
        return response;
      }, { preconnect: previousFetch.preconnect });
      markAccountNeedsReauth(MAIN);
      const pending = fetchMainAccountInfoAttempt(true, 0);
      try {
        await started.promise;
        if (transition !== "unchanged") {
          writeFileSync(authPath, JSON.stringify(replacement));
          // A newer read observes the bearer but fails, so it cannot advance the publication fence.
          expect((await fetchMainAccountInfoAttempt(true, 0)).quotaRefresh?.status).toBe("http_error");
          if (transition === "restored") {
            writeFileSync(authPath, originalAuth);
            expect((await fetchMainAccountInfoAttempt(true, 0)).quotaRefresh?.status).toBe("http_error");
          }
        }
        const policy = getMainPolicyQuota();
        const display = structuredClone(getAccountQuota(MAIN));
        const info = structuredClone(getMainAccountInfoCache());
        finish.resolve();
        const result = await pending;
        if (transition === "unchanged") {
          expect(reads).toBe(1);
          expect(getMainAccountHardLockStatus(config()).state).toBe("ready");
          expect(result.freshQuota?.weeklyPercent).toBe(64);
          expect(result.resetRecoveryProof).toBeDefined();
          expect(isAccountNeedsReauth(MAIN)).toBe(false);
        } else {
          // Ordinary callers retain the parsed result; only authoritative publication is fenced.
          expect(result.info.quota?.weeklyPercent).toBe(64);
          expect(getMainPolicyQuota()).toEqual(policy);
          expect(getMainAccountHardLockStatus(config()).state).toBe("blocked");
          expect(getAccountQuota(MAIN)).toEqual(display);
          expect(getMainAccountInfoCache()).toEqual(info);
          expect(isAccountNeedsReauth(MAIN)).toBe(true);
          expect(result.freshQuota).toBeUndefined();
          expect(result.freshResetCredits).toBeUndefined();
          expect(result.resetRecoveryProof).toBeUndefined();
          expect(result.quotaRefresh).toBeUndefined();
        }
      } finally {
        finish.resolve();
        await pending;
      }
    });
  }

  test("account list shows cached quota when a replaced token's result is unpublished", async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    const authPath = join(home, "auth.json");
    const replacement = JSON.parse(readFileSync(authPath, "utf8"));
    replacement.tokens.access_token += "-rotated";
    setMainAccountInfoCache({ email: null, plan: "plus", quota: { shortPercent: 99 }, ts: 1 });
    const data = { plan_type: "prolite", rate_limit: {
      primary_window: { used_percent: 64, limit_window_seconds: 604_800 },
      secondary_window: null, tertiary_window: null,
    } };
    let reads = 0;
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      expect(String(input)).toBe(whamUrl);
      if (++reads > 1) return new Response(null, { status: 503 });
      const response = Response.json(data);
      response.json = async () => {
        started.resolve();
        await finish.promise;
        return data;
      };
      return response;
    }, { preconnect: previousFetch.preconnect });
    const pending = listCodexAuthAccounts(config(), true);
    try {
      await started.promise;
      writeFileSync(authPath, JSON.stringify(replacement));
      expect((await fetchMainAccountInfoAttempt(true, 0)).quotaRefresh?.status).toBe("http_error");
      const cached = structuredClone(getMainAccountInfoCache());
      finish.resolve();
      const main = (await pending).find(account => account.isMain);
      expect(main?.plan).toBe("plus");
      expect(main?.quota?.shortPercent).toBe(99);
      expect(main?.quota?.weeklyPercent).toBeUndefined();
      expect(main?.mainAccountHardLock?.state).toBe("blocked");
      expect(getMainAccountInfoCache()).toEqual(cached);
    } finally {
      finish.resolve();
      await pending;
    }
  });

  for (const status of [200, 401, 403]) {
    test.each(["unchanged", "replaced", "unreadable"] as const)(
      `single delayed ${status} checks the stored credential: %s`, async transition => {
        const started = deferred<void>();
        const finish = deferred<void>();
        const authPath = join(home, "auth.json");
        const replacement = JSON.parse(readFileSync(authPath, "utf8"));
        replacement.tokens.access_token += "-rotated";
        setMainAccountInfoCache({ email: null, plan: "plus", quota: { shortPercent: 99 }, ts: 1 });
        if (status === 200) markAccountNeedsReauth(MAIN);
        let reads = 0;
        globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
          expect(String(input)).toBe(whamUrl);
          reads++;
          started.resolve();
          await finish.promise;
          return status === 200 ? Response.json({ plan_type: "prolite", rate_limit: {
            primary_window: { used_percent: 64, limit_window_seconds: 604_800 },
            secondary_window: null, tertiary_window: null,
          } }) : Response.json({ error: { code: "invalid_workspace_selected" } }, { status });
        }, { preconnect: previousFetch.preconnect });
        const pending = fetchMainAccountInfoSnapshot(true, config());
        try {
          await started.promise;
          if (transition === "replaced") writeFileSync(authPath, JSON.stringify(replacement));
          if (transition === "unreadable") writeFileSync(authPath, "{");
          const cached = structuredClone(getMainAccountInfoCache());
          const policy = getMainPolicyQuota();
          finish.resolve();
          const snapshot = await pending;
          expect(reads).toBe(1);
          if (transition === "unchanged") {
            if (status === 200) {
              expect(getMainAccountInfoCache()?.quota?.weeklyPercent).toBe(64);
              expect(getMainAccountHardLockStatus(config()).state).toBe("ready");
              expect(isAccountNeedsReauth(MAIN)).toBe(false);
              expect(snapshot.infoUnpublished).toBeUndefined();
              expect(snapshot.quotaRefresh?.status).toBe("ok");
            } else {
              expect(getMainAccountInfoCache()).toBeNull();
              expect(isAccountNeedsReauth(MAIN)).toBe(true);
              expect(snapshot.quotaRefresh).toEqual({ status: "http_error", httpStatus: status });
            }
          } else {
            expect(getMainAccountInfoCache()).toEqual(cached);
            expect(getMainPolicyQuota()).toEqual(policy);
            expect(getMainAccountHardLockStatus(config()).state).toBe("blocked");
            expect(isAccountNeedsReauth(MAIN)).toBe(status === 200);
            expect(snapshot.quotaRefresh).toBeUndefined();
            if (status === 200) expect(snapshot.infoUnpublished).toBe(true);
          }
        } finally {
          finish.resolve();
          await pending;
        }
      });
  }

  for (const status of [401, 403]) {
    for (const phase of ["request", "error-body"] as const) {
      test.each(["unchanged", "replaced", "restored"] as const)(`terminal ${status} delayed ${phase} respects %s credentials`, async transition => {
        const started = deferred<void>();
        const finish = deferred<void>();
        const authPath = join(home, "auth.json");
        const originalAuth = readFileSync(authPath, "utf8");
        const replacement = JSON.parse(originalAuth);
        replacement.tokens.access_token += "-rotated";
        setMainAccountInfoCache({ email: null, plan: "plus", quota: { shortPercent: 99 }, ts: 1 });
        let reads = 0;
        globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
          expect(String(input)).toBe(whamUrl);
          if (++reads > 1) return new Response(null, { status: 503 });
          const body = JSON.stringify({ error: { code: "invalid_workspace_selected" } });
          if (phase === "request") {
            started.resolve();
            await finish.promise;
            return new Response(body, { status });
          }
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              started.resolve();
              void finish.promise.then(() => { controller.enqueue(new TextEncoder().encode(body)); controller.close(); });
            },
          }), { status });
        }, { preconnect: previousFetch.preconnect });
        const pending = fetchMainAccountInfoAttempt(true, 0);
        try {
          await Promise.race([started.promise, pending.then(() => { throw new Error("Terminal WHAM never started"); })]);
          if (transition !== "unchanged") {
            writeFileSync(authPath, JSON.stringify(replacement));
            expect((await fetchMainAccountInfoAttempt(true, 0)).quotaRefresh?.status).toBe("http_error");
            if (transition === "restored") {
              writeFileSync(authPath, originalAuth);
              expect((await fetchMainAccountInfoAttempt(true, 0)).quotaRefresh?.status).toBe("http_error");
            }
          }
          const info = structuredClone(getMainAccountInfoCache());
          const policy = getMainPolicyQuota();
          finish.resolve();
          const result = await pending;
          if (transition === "unchanged") {
            expect(reads).toBe(1);
            expect(getMainAccountInfoCache()).toBeNull();
            expect(isAccountNeedsReauth(MAIN)).toBe(true);
            expect(result.quotaRefresh).toEqual({ status: "http_error", httpStatus: status });
          } else {
            expect(getMainAccountInfoCache()).toEqual(info);
            expect(getMainPolicyQuota()).toEqual(policy);
            expect(getMainAccountHardLockStatus(config()).state).toBe("blocked");
            expect(isAccountNeedsReauth(MAIN)).toBe(false);
            expect(result.info).toEqual(info);
            expect(result.quotaRefresh).toBeUndefined();
            expect(result.resetRecoveryProof).toBeUndefined();
          }
        } finally {
          finish.resolve();
          await pending;
        }
      });
    }
  }

  for (const status of [200, 401, 403]) {
    test.each([false, true])(`conflicting main tuple cannot publish ${status}, replacement=%s`, async replaced => {
      const authPath = join(home, "auth.json");
      const valid = JSON.parse(readFileSync(authPath, "utf8"));
      writeFileSync(authPath, JSON.stringify({ tokens: { ...valid.tokens, account_id: "fixture-other-header" } }));
      setMainAccountInfoCache({ email: null, plan: "plus", quota: { shortPercent: 99 }, ts: 1 });
      if (status === 200) markAccountNeedsReauth(MAIN);
      const started = deferred<void>();
      const finish = deferred<void>();
      let reads = 0;
      globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
        expect(String(input)).toBe(whamUrl);
        if (++reads > 1) return new Response(null, { status: 503 });
        started.resolve();
        await finish.promise;
        return status === 200 ? usage(0)
          : Response.json({ error: { code: "invalid_workspace_selected" } }, { status });
      }, { preconnect: previousFetch.preconnect });
      const pending = fetchMainAccountInfoAttempt(true, 0);
      try {
        await Promise.race([started.promise, pending.then(() => { throw new Error("Conflicting WHAM never started"); })]);
        if (replaced) {
          valid.tokens.access_token += "-rotated";
          writeFileSync(authPath, JSON.stringify(valid));
          expect((await fetchMainAccountInfoAttempt(true, 0)).quotaRefresh?.status).toBe("http_error");
        }
        const info = structuredClone(getMainAccountInfoCache());
        const policy = getMainPolicyQuota();
        const display = structuredClone(getAccountQuota(MAIN));
        finish.resolve();
        const result = await pending;
        expect(getMainAccountInfoCache()).toEqual(info);
        expect(getMainPolicyQuota()).toEqual(policy);
        expect(getAccountQuota(MAIN)).toEqual(display);
        expect(isAccountNeedsReauth(MAIN)).toBe(status === 200);
        expect(result.info).toEqual(info);
        expect(result.freshQuota).toBeUndefined();
        expect(result.freshResetCredits).toBeUndefined();
        expect(result.resetRecoveryProof).toBeUndefined();
        expect(result.quotaRefresh).toBeUndefined();
      } finally {
        finish.resolve();
        await pending;
      }
    });
  }

  test("owned metadata recovery replaces an obsolete short block with the current weekly window", async () => {
    const calls = fetchWith(async () => Response.json({ plan_type: "pro", rate_limit: {
      primary_window: { used_percent: 35, limit_window_seconds: 604_800 }, secondary_window: null, tertiary_window: null,
    } }));
    await runMainAccountHardLockRecovery(config());
    expect(calls).toEqual([whamUrl]);
    expect(getMainAccountHardLockStatus(config())).toEqual({ enabled: true, state: "ready" });
    expect(getMainPolicyQuota()?.shortPercent).toBeUndefined();
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(35);
    expect(getNativeMainProfileRequestCount()).toBe(0);
  });

  test("existing sweep hook forces fresh WHAM past cache/reset without adding a timer", async () => {
    let percent = 99;
    const calls = fetchWith(async () => usage(percent));
    const cfg = config();
    await fetchMainAccountInfo(true);
    expect(getMainAccountHardLockStatus(cfg)).toEqual({ enabled: true, state: "blocked" });
    percent = 0;
    let afterTick: (() => void) | undefined;
    const registration = spyOn(sweeper, "registerStateSweepAfterTick").mockImplementation(entry => {
      afterTick = entry.afterTick;
      return () => {};
    });
    const timer = spyOn(globalThis, "setInterval");
    try {
      registerCodexCooldownRecoveryProbeWorker(cfg);
      expect(afterTick).toBeDefined();
      afterTick!();
      await runMainAccountHardLockRecovery(cfg);
      expect(timer).not.toHaveBeenCalled();
      expect(calls).toEqual([whamUrl, whamUrl]);
      expect(getMainAccountHardLockStatus(cfg)).toEqual({ enabled: true, state: "ready" });
      expect(getNativeMainProfileRequestCount()).toBe(0);
    } finally {
      registration.mockRestore();
      timer.mockRestore();
    }
  });

  test.each(["disabled", "unknown", "ready", "reauth", "draining"] as const)("%s main makes no network request", async state => {
    const cfg = config();
    if (state === "disabled") cfg.codexMainAccountHardLock = false;
    if (state === "unknown") clearAccountQuota();
    if (state === "ready") {
      setAccountQuotaFromParsed(MAIN, { shortPercent: 0 }, undefined, captureMainQuotaWriter(accountId));
    }
    if (state === "reauth") markAccountNeedsReauth(MAIN);
    const drain = state === "draining" ? acquireNativeMainProfileDrain("fixture") : null;
    const calls = fetchWith(async () => usage());
    try {
      await runMainAccountHardLockRecovery(cfg);
      expect(calls).toEqual([]);
      expect(getNativeMainProfileRequestCount()).toBe(0);
      if (state === "reauth") expect(isAccountNeedsReauth(MAIN)).toBe(true);
    } finally { drain?.release(); }
  });

  test("overlapping ticks share one flight and release its runtime lease", async () => {
    const entered = deferred<void>();
    const response = deferred<Response>();
    const calls = fetchWith(async () => { entered.resolve(); return response.promise; });
    const first = runMainAccountHardLockRecovery(config());
    try {
      await entered.promise;
      const second = runMainAccountHardLockRecovery(config());
      expect(calls).toEqual([whamUrl]);
      expect(getNativeMainProfileRequestCount()).toBe(1);
      response.resolve(usage());
      await Promise.all([first, second]);
      expect(calls).toEqual([whamUrl]);
      expect(getMainAccountHardLockStatus(config()).state).toBe("ready");
    } finally { response.resolve(usage()); await first; }
    expect(getNativeMainProfileRequestCount()).toBe(0);
    block();
    await runMainAccountHardLockRecovery(config());
    expect(calls).toEqual([whamUrl, whamUrl]);
  });

  test("expired stored token refresh completes before WHAM shared ownership", async () => {
    writeMain(true);
    const fresh = bearer();
    const calls = fetchWith(async (url, init) => {
      if (url === tokenUrl) return Response.json({ access_token: fresh, refresh_token: "fixture-rotated", expires_in: 86_400 });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${fresh}`);
      expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe(accountId);
      expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).tokens.access_token).toBe(fresh);
      return usage();
    });
    await runMainAccountHardLockRecovery(config());
    expect(calls).toEqual([tokenUrl, whamUrl]);
    expect(getMainAccountHardLockStatus(config()).state).toBe("ready");
    expect(getNativeMainProfileRequestCount()).toBe(0);
  });

  test("reauth arriving during token refresh survives success and skips WHAM", async () => {
    writeMain(true);
    const retained = getMainPolicyQuota();
    const entered = deferred<void>();
    const response = deferred<Response>();
    const refreshed = { access_token: bearer(), refresh_token: "fixture-rotated", expires_in: 86_400 };
    const calls = fetchWith(async url => {
      if (url !== tokenUrl) return usage();
      entered.resolve();
      return response.promise;
    });
    const recovery = runMainAccountHardLockRecovery(config());
    try {
      await Promise.race([entered.promise, recovery.then(() => {
        throw new Error("Recovery ended before reaching the token endpoint");
      })]);
      expect(getNativeMainProfileRequestCount()).toBe(1);
      markAccountNeedsReauth(MAIN);
      response.resolve(Response.json(refreshed));
      await recovery;
      expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).tokens.access_token).toBe(refreshed.access_token);
      expect(isAccountNeedsReauth(MAIN)).toBe(true);
      expect(calls).toEqual([tokenUrl]);
      expect(getMainPolicyQuota()).toEqual(retained);
      expect(getMainAccountHardLockStatus(config())).toEqual({ enabled: true, state: "blocked" });
      expect(getNativeMainProfileRequestCount()).toBe(0);
    } finally {
      response.resolve(Response.json(refreshed));
      await recovery;
    }
  });

  test.each(["terminal", "transient"] as const)("%s refresh failure retains block and only terminal quarantines", async kind => {
    writeMain(true);
    const retained = getMainPolicyQuota();
    const calls = fetchWith(async () => Response.json({ error: kind === "terminal" ? "invalid_grant" : "server_error" },
      { status: kind === "terminal" ? 400 : 503 }));
    await runMainAccountHardLockRecovery(config());
    expect(calls).toEqual([tokenUrl]);
    expect(getMainPolicyQuota()).toEqual(retained);
    expect(isAccountNeedsReauth(MAIN)).toBe(kind === "terminal");
    expect(getNativeMainProfileRequestCount()).toBe(0);
    if (kind === "terminal") {
      await runMainAccountHardLockRecovery(config());
      expect(calls).toEqual([tokenUrl]);
    }
  });

  test.each(["http", "transport", "metadata", "negative", "missing-token"] as const)("%s failure retains policy evidence", async kind => {
    const retained = getMainPolicyQuota();
    if (kind === "missing-token") unlinkSync(join(home, "auth.json"));
    const calls = fetchWith(async () => {
      if (kind === "transport") throw new Error("fixture network failure");
      if (kind === "http") return new Response(null, { status: 503 });
      if (kind === "metadata") return Response.json({ plan_type: "plus" });
      return usage(-1);
    });
    await runMainAccountHardLockRecovery(config());
    expect(calls).toEqual(kind === "missing-token" ? [] : [whamUrl]);
    expect(getMainPolicyQuota()).toEqual(retained);
    expect(getMainAccountHardLockStatus(config()).state).toBe("blocked");
    expect(isAccountNeedsReauth(MAIN)).toBe(false);
    expect(getNativeMainProfileRequestCount()).toBe(0);
  });

  test("fresh zero releases policy without unpausing or clearing unrelated cooldown", async () => {
    const cfg = config();
    cfg.pausedCodexAccountIds = [MAIN];
    const now = Date.now();
    recordCodexUpstreamOutcome(cfg, MAIN, 429, { now, retryAfter: "3600" });
    const cooldown = getCodexQuotaHealthSnapshot(MAIN, "shared", now);
    expect(cooldown).not.toBeNull();
    fetchWith(async () => usage());
    await runMainAccountHardLockRecovery(cfg);
    expect(getMainAccountHardLockStatus(cfg)).toEqual({ enabled: true, state: "ready" });
    expect(cfg.pausedCodexAccountIds).toEqual([MAIN]);
    expect(getCodexQuotaHealthSnapshot(MAIN, "shared", now)).toEqual(cooldown);
  });

  test("a reauth mark arriving during metadata read is not cleared by its 200", async () => {
    fetchWith(async () => { markAccountNeedsReauth(MAIN); return usage(); });
    await runMainAccountHardLockRecovery(config());
    expect(isAccountNeedsReauth(MAIN)).toBe(true);
    expect(getMainAccountHardLockStatus(config()).state).toBe("ready");
    expect(getNativeMainProfileRequestCount()).toBe(0);
  });
});
