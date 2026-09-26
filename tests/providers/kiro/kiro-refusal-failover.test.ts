import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchKiroWithRetry, resetKiroThrottleStateForTests } from "../../../src/adapters/kiro-retry";
import type { AdapterRequest } from "../../../src/adapters/base";
import { getAccountSet, saveCredential, setActiveAccount, credentialGeneration } from "../../../src/oauth/store";
import { clearGenericFailoverHealth, eligibleFailoverAccounts, refusalAwareInitialKiroAccount,
  rotateGenericOAuthAccountOnRefusal, isGenericOAuthFailoverEnabled, quarantineKiroSuspendedAccount }
  from "../../../src/oauth/generic-account-failover";
import { clearAccountQuotaCache } from "../../../src/providers/quota";
import { cancelPendingAccountQuotaPersist, readPersistedKiroVerdicts } from "../../../src/providers/account-quota-disk";
import { hydrateKiroAccountState, persistKiroAccountState } from "../../../src/providers/kiro-account-state-disk";
import { kiroAccountEvidence, noteKiroMonthlyRefusal, noteKiroServedSuccess } from "../../../src/providers/kiro-usage";
import type { OcxConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const oldHome = process.env.OPENCODEX_HOME;
const realFetch = globalThis.fetch;
let home: string;
const cfg = (global?: boolean, provider?: boolean) => ({
  providers: { kiro: { adapter: "kiro", authMode: "oauth",
    ...(provider === undefined ? {} : { oauthAccountFailover: { enabled: provider } }) } },
  ...(global === undefined ? {} : { oauthAccountFailover: { enabled: global } }),
}) as OcxConfig;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-kiro-refusal-"));
  process.env.OPENCODEX_HOME = home;
  clearAccountQuotaCache();
  clearGenericFailoverHealth();
  resetKiroThrottleStateForTests();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  clearAccountQuotaCache();
  clearGenericFailoverHealth();
  resetKiroThrottleStateForTests();
  cancelPendingAccountQuotaPersist();
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = oldHome;
  removeTreeWithRetry(home);
});

async function seed(n = 2) {
  for (let i = 0; i < n; i++) await saveCredential("kiro", {
    access: `access-${i}`, refresh: `refresh-${i}`, expires: Date.now() + 3_600_000,
    accountId: `account-${i}`,
  }, { addAccount: true });
  const rows = getAccountSet("kiro")!.accounts;
  await setActiveAccount("kiro", rows[0]!.id);
  return rows;
}

describe("Kiro refusal account evidence", () => {
  test("kiro monthly refusal persists and skips only the refused account until reset or TTL", async () => {
    const [a, b] = await seed();
    const now = Date.now();
    expect(noteKiroMonthlyRefusal(a!.id, credentialGeneration(a!.credential), now)).toBeGreaterThan(0);
    persistKiroAccountState();
    expect(kiroAccountEvidence(a!).exhausted).toBe(true);
    expect(eligibleFailoverAccounts("kiro")).toEqual([b!.id]);
    await Bun.sleep(350);
    clearAccountQuotaCache();
    hydrateKiroAccountState();
    expect(kiroAccountEvidence(a!).exhausted).toBe(true);
  });

  test("kiro monthly refusal persists with one account", async () => {
    const [a] = await seed(1);
    noteKiroMonthlyRefusal(a!.id, credentialGeneration(a!.credential));
    persistKiroAccountState();
    expect(kiroAccountEvidence(a!).exhausted).toBe(true);
    await Bun.sleep(350);
    expect(readPersistedKiroVerdicts().size).toBe(1);
  });

  test("kiro rate uses short cooldown while other OAuth 429 retains its prior delay", async () => {
    const [a, b] = await seed();
    expect(rotateGenericOAuthAccountOnRefusal(cfg(false), "kiro", a!.id, "rate", null)).toBe(b!.id);
    expect(eligibleFailoverAccounts("kiro")).toEqual([b!.id]);
  });

  test("kiro suspension records without alternate and ordinary 403 does not", async () => {
    const [a] = await seed(1);
    quarantineKiroSuspendedAccount(a!.id);
    expect(eligibleFailoverAccounts("kiro")).toEqual([]);
    expect(rotateGenericOAuthAccountOnRefusal(cfg(), "kiro", a!.id, "other", null)).toBeNull();
  });

  test("kiro suspended account rotates before output", async () => {
    const [a, b] = await seed();
    quarantineKiroSuspendedAccount(a!.id);
    expect(rotateGenericOAuthAccountOnRefusal(cfg(), "kiro", a!.id, "suspended", null)).toBe(b!.id);
  });

  test("a stale suspension cannot quarantine a replacement login in the same slot", async () => {
    const [a, b] = await seed();
    const oldGeneration = credentialGeneration(a!.credential);
    await saveCredential("kiro", { access: "replacement", refresh: "replacement-refresh",
      expires: Date.now() + 3_600_000, accountId: "account-0" });
    quarantineKiroSuspendedAccount(a!.id, oldGeneration);
    expect(eligibleFailoverAccounts("kiro")).toEqual([a!.id, b!.id]);
    quarantineKiroSuspendedAccount(a!.id);
    expect(eligibleFailoverAccounts("kiro")).toEqual([b!.id]);
    await saveCredential("kiro", { access: "another-login", refresh: "another-refresh",
      expires: Date.now() + 3_600_000, accountId: "account-0" });
    expect(eligibleFailoverAccounts("kiro")).toEqual([a!.id, b!.id]);
  });

  test("a restart followed by a successful turn clears the persisted exhaustion verdict", async () => {
    const [a] = await seed(1);
    noteKiroMonthlyRefusal(a!.id, credentialGeneration(a!.credential));
    persistKiroAccountState();
    await Bun.sleep(350);
    clearAccountQuotaCache();
    expect(noteKiroServedSuccess(a!.id, credentialGeneration(a!.credential), Date.now() + 1)).toBe(true);
    persistKiroAccountState();
    await Bun.sleep(350);
    clearAccountQuotaCache();
    expect(kiroAccountEvidence(a!).exhausted).toBe(false);
  });

  test("kiro later served completion clears older exhaustion but not a newer refusal or different identity", async () => {
    const [a] = await seed(1);
    const generation = credentialGeneration(a!.credential);
    const now = Date.now() - 5;
    noteKiroMonthlyRefusal(a!.id, generation, now);
    expect(noteKiroServedSuccess(a!.id, generation, now - 1)).toBe(false);
    expect(noteKiroServedSuccess(a!.id, "wrong-generation", now + 1)).toBe(false);
    expect(noteKiroServedSuccess(a!.id, generation, now + 2)).toBe(true);
    expect(kiroAccountEvidence(a!).exhausted).toBe(false);
  });

  test("kiro initial admission skips suspended active only when proactive preference is enabled", async () => {
    const [a, b] = await seed();
    quarantineKiroSuspendedAccount(a!.id);
    expect(refusalAwareInitialKiroAccount(cfg(true), a!.id)).toBe(b!.id);
    expect(refusalAwareInitialKiroAccount(cfg(false), a!.id)).toBeNull();
    expect(refusalAwareInitialKiroAccount(cfg(true, false), a!.id)).toBeNull();
    expect(refusalAwareInitialKiroAccount(cfg(false, true), a!.id)).toBe(b!.id);
    expect(isGenericOAuthFailoverEnabled(cfg(false), "kiro")).toBe(true);
  });

  test("kiro initial admission skips monthly exhausted active with proactive preference", async () => {
    const [a, b] = await seed();
    noteKiroMonthlyRefusal(a!.id, credentialGeneration(a!.credential));
    expect(refusalAwareInitialKiroAccount(cfg(true), a!.id)).toBe(b!.id);
    expect(refusalAwareInitialKiroAccount(cfg(false), a!.id)).toBeNull();
  });

  test("kiro singleton or all-excluded pool still sends active", async () => {
    const [a, b] = await seed();
    quarantineKiroSuspendedAccount(a!.id);
    quarantineKiroSuspendedAccount(b!.id);
    expect(refusalAwareInitialKiroAccount(cfg(true), a!.id)).toBeNull();
  });

  test("kiro pooled 429 bypasses same-account retry while one-account Kiro keeps it", async () => {
    const request: AdapterRequest = { url: "https://runtime.us-east-1.kiro.dev/", method: "POST",
      headers: { authorization: "Bearer synthetic", accept: "application/vnd.amazon.eventstream" }, body: "{}" };
    const responses = () => [new Response(JSON.stringify({ __type: "ThrottlingException",
      message: "USER_REQUEST_RATE_EXCEEDED" }), { status: 429, headers: { "Retry-After": "0" } }),
      new Response("ok", { status: 200 })];
    let calls = 0;
    let sequence = responses();
    globalThis.fetch = (async () => { calls++; return sequence.shift()!; }) as typeof fetch;
    const pooled = await fetchKiroWithRetry(request, { kiroPreferAccountFailover: true, returnRawErrors: true });
    expect(pooled.status).toBe(429);
    expect(calls).toBe(1);
    resetKiroThrottleStateForTests();
    calls = 0; sequence = responses();
    const single = await fetchKiroWithRetry(request, { returnRawErrors: true });
    expect(single.status).toBe(200);
    expect(calls).toBe(2);
  });
});
