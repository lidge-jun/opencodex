import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { clearAccountNeedsReauth, markAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { getValidCodexToken, readCodexAccountRecord, removeCodexAccountCredential, saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearCodexQuotaPrimeState, primeCodexPoolQuotas, setCodexPoolQuotaTokenResolverForTests } from "../../src/codex/auth-api/pool-mode-gate";
import { fetchPoolAccountQuota } from "../../src/codex/auth-api/pool-quota-probe";
import { clearAccountQuota, getAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import { settleBackgroundWork } from "../../src/lib/background-work";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Real primer, store, WHAM reader and parser. Only token timing and external HTTP
// are controlled; every unexpected HTTP request fails closed inside the fixture.
describe("credit renewal rechecks authority after token preparation", () => {
  const id = "renewal-fixture";
  let home: string, priorHome: string | undefined, nativeHome: IsolatedCodexHome;
  let config: OcxConfig, observedAt: number;
  let originalFetch: typeof fetch;
  let calls: { account: string | null; bearer: string | null }[];
  let unexpected: string[];
  let reply: () => Response | Promise<Response>;
  let refreshReply: () => Response | Promise<Response>;

  function save(suffix = "") {
    saveCodexAccountCredential(id, {
      accessToken: `fixture-access${suffix}`, refreshToken: `fixture-refresh${suffix}`,
      chatgptAccountId: "fixture-workspace", expiresAt: Date.now() + 3_600_000,
    });
  }
  function wham() {
    return Response.json({ plan_type: "plus", rate_limit: {
      secondary_window: { used_percent: 100, reset_at: (Date.now() + 604_800_000) / 1000 },
    }, credits: { has_credits: true, balance: 7 } });
  }
  function revoke(kind: string) {
    if (kind === "binding") config.codexAccountNamespaces = {};
    if (kind === "rebind") config.codexAccountNamespaces = { subAlias: "other-fixture" };
    if (kind === "consent") config.creditCodexAccountIds = [];
    if (kind === "pause") config.pausedCodexAccountIds = [id];
    if (kind === "provider") config.providers.openai!.disabled = true;
    if (kind === "provider-replacement") config.providers.openai!.baseUrl = "https://example.test/v1";
    if (kind === "reauth") markAccountNeedsReauth(id);
    if (kind === "removal") config.codexAccounts = [];
    if (kind === "replacement") save("-replacement");
    if (kind === "deletion") removeCodexAccountCredential(id);
  }
  function prime() { return primeCodexPoolQuotas(config, "credit-renewal"); }
  function delayedToken() {
    const entered = deferred(), release = deferred();
    const resolver: typeof getValidCodexToken = async accountId => {
      const token = await getValidCodexToken(accountId);
      entered.resolve();
      await release.promise;
      return token;
    };
    return { entered, release, resolver };
  }

  beforeEach(() => {
    priorHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-renewal-revocation-"));
    process.env.OPENCODEX_HOME = home;
    nativeHome = installIsolatedCodexHome("ocx-renewal-revocation-native-");
    clearCodexQuotaPrimeState(); clearAccountQuota(); resetQuotaQueryBackoffForTests();
    config = {
      port: 10100, defaultProvider: "openai", providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward", codexAccountMode: "direct" },
      },
      codexAccounts: [{ id, isMain: false, plan: "plus", email: "fixture@example.test" }],
      codexAccountNamespaces: { subAlias: id }, creditCodexAccountIds: [id],
    } as OcxConfig;
    save(); observedAt = Date.now() - 360_000;
    setAccountQuotaFromParsed(id, { weeklyPercent: 100, weeklyResetAt: Date.now() + 604_800_000,
      credits: { hasCredits: true, balance: 5, observedAt } });
    calls = []; unexpected = []; reply = wham;
    refreshReply = () => { throw new Error("unexpected fixture token refresh"); };
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://auth.openai.com/oauth/token") return refreshReply();
      if (url !== "https://chatgpt.com/backend-api/wham/usage" || (init?.method ?? "GET") !== "GET") {
        unexpected.push(url); throw new Error("non-fixture HTTP is forbidden");
      }
      const headers = new Headers(init?.headers);
      calls.push({ account: headers.get("chatgpt-account-id"), bearer: headers.get("authorization") });
      return reply();
    }) as typeof fetch;
  });

  afterEach(async () => {
    const drained = await settleBackgroundWork({ timeoutMs: 1000 });
    clearAccountNeedsReauth(id);
    clearCodexQuotaPrimeState(); clearAccountQuota(); resetQuotaQueryBackoffForTests();
    await flushConfigDirHardeningForTests();
    globalThis.fetch = originalFetch;
    if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = priorHome;
    nativeHome.restoreEnvironment();
    if (drained.settled) { removeTreeWithRetry(home); nativeHome.removeAfterDrain(); }
    expect(drained.settled).toBe(true); expect(unexpected).toEqual([]);
  });

  test.each(["binding", "rebind", "consent", "pause", "provider", "provider-replacement", "reauth", "removal", "replacement", "deletion"])(
    "does not dispatch a prepared token after %s", async kind => {
      const delay = delayedToken();
      const restore = setCodexPoolQuotaTokenResolverForTests(delay.resolver);
      const running = prime();
      try {
        await Promise.race([delay.entered.promise, running]);
        expect(calls).toEqual([]);
        revoke(kind);
      } finally { delay.release.resolve(); await running; restore(); }
      expect(calls).toEqual([]);
      expect(getAccountQuota(id)?.credits?.observedAt).not.toBeGreaterThan(observedAt);
    },
  );

  test.each(["consent", "pause", "provider", "removal"])("Pool renewal also rechecks %s after token preparation", async kind => {
    config.providers.openai!.codexAccountMode = "pool";
    const delay = delayedToken();
    const restore = setCodexPoolQuotaTokenResolverForTests(delay.resolver);
    const running = prime();
    try {
      await Promise.race([delay.entered.promise, running]); expect(calls).toEqual([]); revoke(kind);
    } finally { delay.release.resolve(); await running; restore(); }
    expect(calls).toEqual([]);
  });

  test("a skipped read does not consume the next eligible renewal's attempt budget", async () => {
    const delay = delayedToken();
    const restore = setCodexPoolQuotaTokenResolverForTests(delay.resolver);
    const running = prime();
    try {
      await Promise.race([delay.entered.promise, running]); expect(calls).toEqual([]); revoke("binding");
    } finally { delay.release.resolve(); await running; restore(); }
    expect(calls).toEqual([]);
    config.codexAccountNamespaces = { subAlias: id };
    await prime();
    expect(calls).toEqual([{ account: "fixture-workspace", bearer: "Bearer fixture-access" }]);
    expect(getAccountQuota(id)?.credits?.balance).toBe(7);
  });

  test("accepts the current generation returned by token preparation", async () => {
    const entered = deferred(), release = deferred();
    const before = readCodexAccountRecord(id)!.generation;
    const restore = setCodexPoolQuotaTokenResolverForTests(async accountId => {
      entered.resolve(); await release.promise;
      return getValidCodexToken(accountId);
    });
    const running = prime();
    try {
      await Promise.race([entered.promise, running]); expect(calls).toEqual([]); save("-rotated");
    } finally { release.resolve(); await running; restore(); }
    expect(readCodexAccountRecord(id)!.generation).toBeGreaterThan(before);
    expect(calls).toEqual([{ account: "fixture-workspace", bearer: "Bearer fixture-access-rotated" }]);
    expect(getAccountQuota(id)?.credits?.balance).toBe(7);
  });

  test.each(["binding", "consent", "pause", "provider"])("401 replay rechecks %s after real token refresh", async kind => {
    const entered = deferred(), release = deferred();
    const before = readCodexAccountRecord(id)!.generation;
    reply = () => calls.length === 1 ? Response.json({ error: { code: "transient_edge_rejection" } }, { status: 401 }) : wham();
    refreshReply = async () => {
      entered.resolve(); await release.promise;
      return Response.json({ access_token: "fixture-rotated", refresh_token: "fixture-refresh-rotated", expires_in: 3600 });
    };
    const running = prime();
    try {
      await Promise.race([entered.promise, running]); expect(calls).toHaveLength(1); revoke(kind);
    } finally { release.resolve(); await running; }
    expect(readCodexAccountRecord(id)!.generation).toBeGreaterThan(before);
    expect(calls).toEqual([{ account: "fixture-workspace", bearer: "Bearer fixture-access" }]);
    expect(getAccountQuota(id)?.credits?.observedAt).toBe(observedAt);
  });

  test("ordinary metadata reads keep their independent authority", async () => {
    const delay = delayedToken();
    const running = fetchPoolAccountQuota(id, true, "plus", delay.resolver);
    try {
      await Promise.race([delay.entered.promise, running]); expect(calls).toEqual([]);
      for (const kind of ["binding", "consent", "pause", "provider"]) revoke(kind);
    } finally { delay.release.resolve(); await running; }
    expect(calls).toEqual([{ account: "fixture-workspace", bearer: "Bearer fixture-access" }]);
    expect(getAccountQuota(id)?.credits?.balance).toBe(7);
  });

  test("ordinary metadata reads do not inherit a pending renewal's revocable authority", async () => {
    const delay = delayedToken();
    const restore = setCodexPoolQuotaTokenResolverForTests(delay.resolver);
    const running = prime();
    let ordinary: ReturnType<typeof fetchPoolAccountQuota> | undefined;
    try {
      await Promise.race([delay.entered.promise, running]); expect(calls).toEqual([]);
      ordinary = fetchPoolAccountQuota(id, true, "plus");
      revoke("consent");
    } finally { delay.release.resolve(); await Promise.all([running, ordinary]); restore(); }
    expect(calls).toEqual([{ account: "fixture-workspace", bearer: "Bearer fixture-access" }]);
    expect((await ordinary)?.freshQuota?.credits?.balance).toBe(7);
  });
});
