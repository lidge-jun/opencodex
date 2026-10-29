import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../../src/config/schema/config-schema";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { codexAccountNamespaceForModel } from "../../src/codex/account-namespace-match";
import { CodexPoolAccountCreditsOffError, materializeCodexUpstreamAuth, resolveCodexAuthContext } from "../../src/codex/auth-context";
import { isCodexAccountHeldForCredits } from "../../src/codex/account-credit-use";
import { clearAccountNeedsReauth, markAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearCodexQuotaPrimeState, primeCodexPoolQuotas, registerCodexCooldownRecoveryProbeWorker } from "../../src/codex/auth-api/pool-mode-gate";
import { clearAccountQuota, getAccountQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/quota";
import { resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import { settleBackgroundWork } from "../../src/lib/background-work";
import * as sweeper from "../../src/lib/state-store-sweeper";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Real storage, config schema, primer, credential resolution, quota query and parser;
// only the upstream HTTP boundary and wall clock are replaced. No inference is permitted.
describe("Direct explicit-account credit renewal", () => {
  let home: string;
  let priorHome: string | undefined;
  let codexHome: IsolatedCodexHome;
  let clock: ReturnType<typeof spyOn>;
  let originalFetch: typeof fetch;
  let config: OcxConfig;
  let now: number;
  let calls: string[];
  let unexpected: string[];
  let reply: (accountId: string) => Response | Promise<Response>;
  let nativeReads: number;

  function saveCredential(id: string, suffix = "") {
    saveCodexAccountCredential(id, {
      accessToken: `fixture-access-${id}${suffix}`, refreshToken: `fixture-refresh-${id}${suffix}`,
      chatgptAccountId: `fixture-account-${id}`, expiresAt: now + 3_600_000,
    });
  }
  function seed(id: string, age = 360_000, percent = 100) {
    config.codexAccounts!.push({ id, isMain: false, plan: "plus", email: `${id}@example.test` });
    saveCredential(id);
    setAccountQuotaFromParsed(id, {
      weeklyPercent: percent, weeklyResetAt: now + 604_800_000,
      credits: { hasCredits: true, balance: 5, allowed: true, observedAt: now - age },
    });
  }
  function wham(credits: unknown = { has_credits: true, balance: 7 }, spendControl: unknown = { reached: false }) {
    return Response.json({ plan_type: "plus", rate_limit: {
      secondary_window: { used_percent: 100, reset_at: (now + 604_800_000) / 1000 },
    }, ...(credits === undefined ? {} : { credits }), spend_control: spendControl });
  }
  function held(id = "stored-a") {
    return isCodexAccountHeldForCredits(config, id, getAccountQuota(id), "plus", now);
  }
  function prime(reason = "credit-renewal") {
    const noMain = () => { nativeReads++; throw new Error("renewal must not access native main"); };
    return primeCodexPoolQuotas(config, reason, {
      reconcileMainAccount: noMain, readMainTokens: noMain, fetchMainInfo: noMain,
    });
  }
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }
  function registeredTick() {
    let tick!: () => void;
    const registration = spyOn(sweeper, "registerStateSweepAfterTick").mockImplementation(entry => {
      expect(entry.name).toBe("codex-cooldown-recovery"); tick = entry.afterTick;
      return () => {};
    });
    try { registerCodexCooldownRecoveryProbeWorker(config); }
    finally { registration.mockRestore(); }
    expect(tick).toBeFunction();
    return tick;
  }

  beforeEach(() => {
    priorHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-direct-credit-"));
    process.env.OPENCODEX_HOME = home;
    codexHome = installIsolatedCodexHome("ocx-direct-credit-native-");
    writeFileSync(join(codexHome.path, "auth.json"), JSON.stringify({
      tokens: { access_token: "fixture-native-main", account_id: "fixture-native-account" },
    }));
    now = Date.now();
    clock = spyOn(Date, "now").mockReturnValue(now);
    clearCodexQuotaPrimeState(); clearAccountQuota(); resetQuotaQueryBackoffForTests();
    calls = []; unexpected = []; nativeReads = 0;
    config = {
      port: 10100, defaultProvider: "openai", providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward", codexAccountMode: "direct" },
      },
      codexAccounts: [], codexAccountNamespaces: { subAlias: "stored-a", mainAlias: "@main" },
      creditCodexAccountIds: ["stored-a", "stored-b"],
    } as OcxConfig;
    seed("stored-a"); seed("stored-b");
    // Prevent the old source-slice fixture's namespace/account-id collision from recurring.
    expect(configSchema.safeParse(config).success).toBe(true);
    originalFetch = globalThis.fetch;
    reply = () => wham();
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(init?.headers);
      const account = headers.get("chatgpt-account-id") ?? "";
      const id = account.replace(/^fixture-account-/, "");
      if (url !== "https://chatgpt.com/backend-api/wham/usage" || (init?.method ?? "GET") !== "GET"
        || !account.startsWith("fixture-account-")) {
        unexpected.push("non-fixture metadata request");
        throw new Error("only fixture WHAM requests are permitted");
      }
      expect(headers.get("authorization")).toBe(`Bearer ${readCodexAccountRecord(id)!.credential!.accessToken}`);
      calls.push(id);
      return reply(id);
    }) as typeof fetch;
  });

  afterEach(async () => {
    const drained = await settleBackgroundWork({ timeoutMs: 1000 });
    globalThis.fetch = originalFetch;
    clock.mockRestore();
    clearAccountNeedsReauth("stored-a");
    clearCodexQuotaPrimeState(); clearAccountQuota(); resetQuotaQueryBackoffForTests();
    await flushConfigDirHardeningForTests();
    if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = priorHome;
    codexHome.restoreEnvironment();
    if (drained.settled) { removeTreeWithRetry(home); codexHome.removeAfterDrain(); }
    expect(drained.settled).toBe(true);
    expect(unexpected).toEqual([]);
    expect(nativeReads).toBe(0);
  });

  test.each([180_000, 360_000])("renews at %d ms through real WHAM parsing despite fresh usage", async age => {
    setAccountQuotaFromParsed("stored-a", { credits: {
      hasCredits: true, balance: 5, allowed: true, observedAt: now - age,
    } });
    updateAccountQuota("stored-a", 100);
    expect(getAccountQuota("stored-a")!.updatedAt).toBe(now);
    expect(getAccountQuota("stored-a")!.credits!.observedAt).toBe(now - age);
    expect(held()).toBe(age > 300_000);
    expect(codexAccountNamespaceForModel(config.codexAccountNamespaces, "subAlias/gpt-5.5")).toBe("subAlias");
    const before = structuredClone(config);
    await prime();
    expect(calls).toEqual(["stored-a"]);
    expect(getAccountQuota("stored-a")!.credits).toMatchObject({ balance: 7, observedAt: now, allowed: true });
    expect(held()).toBe(false);
    expect(getAccountQuota("stored-b")!.credits!.observedAt).toBe(now - 360_000);
    expect(config).toEqual(before);
  });

  test("deduplicates aliases and coalesces concurrent renewals", async () => {
    config.codexAccountNamespaces!.anotherAlias = "stored-a";
    expect(configSchema.safeParse(config).success).toBe(true);
    const entered = deferred<void>(), release = deferred<void>();
    reply = async () => { entered.resolve(); await release.promise; return wham(); };
    const first = prime(), second = prime();
    try { await Promise.race([entered.promise, first]); expect(calls).toEqual(["stored-a"]); }
    finally { release.resolve(); await Promise.all([first, second]); }
    await prime();
    expect(calls).toEqual(["stored-a"]);
    expect(held()).toBe(false);
  });

  test("the registered sweep releases real Direct auth only for the namespace's stored credential", async () => {
    const namespace = codexAccountNamespaceForModel(config.codexAccountNamespaces, "subAlias/gpt-5.5")!;
    const caller = new Headers({ authorization: "Bearer fixture-caller-main", "chatgpt-account-id": "fixture-caller-account" });
    const resolve = () => resolveCodexAuthContext(caller, config, "direct", {
      accountId: config.codexAccountNamespaces![namespace], modelId: "gpt-5.5",
    });
    await expect(resolve()).rejects.toBeInstanceOf(CodexPoolAccountCreditsOffError);
    expect(calls).toEqual([]);
    registeredTick()();
    // Join the work started by the actual registered callback, rather than sleeping for a timer.
    expect((await settleBackgroundWork({ timeoutMs: 1000 })).settled).toBe(true);
    expect(calls).toEqual(["stored-a"]);
    const context = await resolve();
    expect(context.kind).toBe("pool"); expect(context.accountId).toBe("stored-a");
    const auth = materializeCodexUpstreamAuth(caller, context);
    expect(auth.get("authorization")).toBe("Bearer fixture-access-stored-a");
    expect(auth.get("chatgpt-account-id")).toBe("fixture-account-stored-a");
    expect(caller.get("authorization")).toBe("Bearer fixture-caller-main");
  });

  test("renewal joining a pending startup prime is retried by the next sweep", async () => {
    config.providers.openai!.codexAccountMode = "pool";
    clock.mockReturnValue(now + 360_000);
    // Startup has only B to refresh: A's usage is fresh but its credit evidence is not.
    updateAccountQuota("stored-a", 100);
    const entered = deferred<void>(), release = deferred<void>();
    reply = async () => { entered.resolve(); await release.promise; return wham(); };
    const running = primeCodexPoolQuotas(config, "startup", {
      reconcileMainAccount: () => false, readMainTokens: () => null,
    });
    const tick = registeredTick();
    try {
      await Promise.race([entered.promise, running]); expect(calls).toEqual(["stored-b"]);
      config.providers.openai!.codexAccountMode = "direct";
      tick(); expect(calls).toEqual(["stored-b"]);
    } finally { release.resolve(); await running; }
    expect(getAccountQuota("stored-a")!.credits!.observedAt).toBe(now - 360_000);
    reply = () => wham(); tick();
    expect((await settleBackgroundWork({ timeoutMs: 1000 })).settled).toBe(true);
    expect(calls).toEqual(["stored-b", "stored-a"]);
  });

  test.each(["binding", "consent", "pause", "reauth", "provider", "removal"])("rechecks queued %s revocation", async revoked => {
    const ids = ["stored-a", "stored-b", "stored-c", "stored-d", "queued-account"];
    for (const id of ids.slice(2)) seed(id);
    config.creditCodexAccountIds = ids;
    config.codexAccountNamespaces = Object.fromEntries(ids.map((id, i) => [`alias${i}`, id]));
    expect(configSchema.safeParse(config).success).toBe(true);
    const entered = deferred<void>(), release = deferred<void>();
    reply = async () => { if (calls.length === 4) entered.resolve(); await release.promise; return wham(); };
    const running = prime();
    try {
      await Promise.race([entered.promise, running]);
      expect(calls).toHaveLength(4);
      if (revoked === "binding") delete config.codexAccountNamespaces.alias4;
      if (revoked === "consent") config.creditCodexAccountIds = ids.slice(0, 4);
      if (revoked === "pause") config.pausedCodexAccountIds = ["queued-account"];
      if (revoked === "reauth") markAccountNeedsReauth("queued-account");
      if (revoked === "provider") config.providers.openai!.disabled = true;
      if (revoked === "removal") config.codexAccounts = config.codexAccounts!.filter(a => a.id !== "queued-account");
    } finally { release.resolve(); await running; clearAccountNeedsReauth("queued-account"); }
    expect(calls).toEqual(ids.slice(0, 4));
  });

  test("a replaced credential rejects late credit publication and does not inherit attempt backoff", async () => {
    const entered = deferred<void>(), release = deferred<void>();
    reply = async () => { entered.resolve(); await release.promise; return wham(); };
    const running = prime();
    try {
      await Promise.race([entered.promise, running]); expect(calls).toEqual(["stored-a"]);
      saveCredential("stored-a", "-replacement");
      setAccountQuotaFromParsed("stored-a", { credits: {
        hasCredits: true, balance: 9, allowed: true, observedAt: now - 360_000,
      } });
    } finally { release.resolve(); await running; }
    expect(getAccountQuota("stored-a")!.credits).toMatchObject({ balance: 9, observedAt: now - 360_000 });
    expect(held()).toBe(true);
    reply = () => wham();
    await prime();
    expect(calls).toEqual(["stored-a", "stored-a"]);
    expect(held()).toBe(false);
  });

  test("in-flight rebinding cannot publish the old account's credits onto its new target or authorize opted-out spend", async () => {
    const entered = deferred<void>(), release = deferred<void>();
    reply = async () => { entered.resolve(); await release.promise; return wham(); };
    const running = prime();
    try {
      await Promise.race([entered.promise, running]); expect(calls).toEqual(["stored-a"]);
      config.codexAccountNamespaces!.subAlias = "stored-b";
      config.creditCodexAccountIds = ["stored-b"];
    } finally { release.resolve(); await running; }
    expect(getAccountQuota("stored-b")!.credits!.observedAt).toBe(now - 360_000);
    expect(held()).toBe(true);
    reply = () => wham(); await prime();
    expect(calls).toEqual(["stored-a", "stored-b"]);
  });

  test.each([503, 429])("failed WHAM %d is paced without renewing the credit clock", async status => {
    reply = () => new Response(null, { status, headers: { "Retry-After": "600" } });
    await prime(); await prime();
    expect(calls).toEqual(["stored-a"]);
    expect(getAccountQuota("stored-a")!.credits!.observedAt).toBe(now - 360_000);
    clock.mockReturnValue(now + 180_000);
    await prime(); expect(calls).toEqual(["stored-a"]); // query reader's backoff still wins
    expect(held()).toBe(true);
  });

  test.each([
    { has_credits: true, balance: 0 }, { has_credits: false, balance: 7 },
    { has_credits: true, balance: 7, overage_limit_reached: true }, null, "invalid",
  ])("negative WHAM credits %j never release admission", async credits => {
    reply = () => wham(credits);
    await prime(); expect(calls).toEqual(["stored-a"]); expect(held()).toBe(true);
  });
  test("spend-control denial overrides positive funds", async () => {
    reply = () => wham({ has_credits: true, balance: 7 }, { reached: true });
    await prime(); expect(calls).toEqual(["stored-a"]); expect(held()).toBe(true);
  });
  test("passive renewal does not validate a pending credential or send inference", async () => {
    saveCodexAccountCredential("stored-a", readCodexAccountRecord("stored-a")!.credential!, { validationPending: true });
    await prime(); expect(calls).toEqual(["stored-a"]);
    expect(readCodexAccountRecord("stored-a")!.codexValidationPending).toBe(true);
  });
  test("Pool keeps renewal of all eligible stored accounts", async () => {
    config.providers.openai!.codexAccountMode = "pool";
    await prime(); expect(calls).toEqual(["stored-a", "stored-b"]);
  });
  test.each(["startup", "pre-route", "priority-failback"])("Direct %s still does not prime", async reason => {
    await prime(reason); expect(calls).toEqual([]);
  });
  test.each(["plain", "disabled", "api", "below-limit", "young", "paused", "opt-out", "reauth"])("skips %s", async condition => {
    if (condition === "plain") config.codexAccountNamespaces = {};
    if (condition === "disabled") config.providers.openai!.disabled = true;
    if (condition === "api") {
      config.providers = { "openai-apikey": { adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1", authMode: "key", apiKey: "fixture-api-key" } };
      config.defaultProvider = "openai-apikey";
      expect(configSchema.safeParse(config).success).toBe(true);
    }
    if (condition === "below-limit") updateAccountQuota("stored-a", 2);
    if (condition === "young") setAccountQuotaFromParsed("stored-a", { credits: {
      hasCredits: true, balance: 5, allowed: true, observedAt: now - 179_999,
    } });
    if (condition === "paused") config.pausedCodexAccountIds = ["stored-a"];
    if (condition === "opt-out") config.creditCodexAccountIds = [];
    if (condition === "reauth") markAccountNeedsReauth("stored-a");
    await prime(); expect(calls).toEqual([]);
  });
});
