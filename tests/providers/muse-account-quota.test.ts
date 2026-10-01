import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountCredential, getAccountSet, saveCredential, setAccountPaused } from "../../src/oauth/store";
import { clearAccountQuotaCache, clearProviderQuotaCache, fetchProviderAccountQuotas, providerOAuthAccountQuotaMode, recordPassiveAccountQuota } from "../../src/providers/quota";
import { fetchMuseKeyQuotaOutcome, resetMuseKeyQuotaBackoff } from "../../src/providers/muse-key-quota";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
let fixtureHome: string;
const apiKey = `LLM|${"1".repeat(16)}|${"c".repeat(27)}`;
const accountToken = (name: string) => `meta-account-${name}-${"z".repeat(48)}`;
const usage = (percent: number) => ({ is_subs_active: true, subs_usage: {
  window: { used_percent: percent, window_duration_mins: 300 }, weekly: { used_percent: 34 },
} });
async function seed(name: string, withToken = true) {
  await saveCredential("meta-muse", { access: apiKey, refresh: apiKey, expires: Number.MAX_SAFE_INTEGER,
    email: `${name}@example.com`, ...(withToken ? { muse: { oauthAccessToken: accountToken(name) } } : {}) });
  return getAccountSet("meta-muse")!.activeAccountId;
}
beforeEach(() => {
  fixtureHome = mkdtempSync(join(tmpdir(), "ocx-muse-account-"));
  process.env.OPENCODEX_HOME = fixtureHome;
  clearAccountQuotaCache(); clearProviderQuotaCache(); resetMuseKeyQuotaBackoff();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAccountQuotaCache(); clearProviderQuotaCache(); resetMuseKeyQuotaBackoff();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(fixtureHome);
});

test("each Muse account probes with its account token and API-key-only rows remain passive", async () => {
  const first = await seed("first"); const second = await seed("second"); const manual = await seed("manual", false);
  const sent: string[] = [];
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://api.meta.ai/muse-code/key");
    expect(init?.body).toBe("{}");
    const bearer = new Headers(init?.headers).get("authorization")!;
    sent.push(bearer);
    return Response.json(usage(bearer.includes("first") ? 0 : 62));
  }) as typeof fetch;
  const rows = await fetchProviderAccountQuotas("meta-muse", true);
  expect(rows.find(row => row.accountId === first)?.quota?.fiveHourPercent).toBe(0);
  expect(rows.find(row => row.accountId === second)?.quota?.fiveHourPercent).toBe(62);
  expect(rows.find(row => row.accountId === first)?.quotaObserved).toBe(false);
  expect(rows.find(row => row.accountId === manual)?.quota).toBeNull();
  expect(providerOAuthAccountQuotaMode("meta-muse", first)).toBe("probe");
  expect(providerOAuthAccountQuotaMode("meta-muse", manual)).toBe("passive");
  expect(sent.sort()).toEqual([`Bearer ${accountToken("first")}`, `Bearer ${accountToken("second")}`].sort());
  const repeated = await fetchProviderAccountQuotas("meta-muse", true);
  expect(repeated.find(row => row.accountId === first)?.quota?.updatedAt).toBe(rows.find(row => row.accountId === first)?.quota?.updatedAt);
  expect(sent).toHaveLength(2);
  clearAccountQuotaCache("meta-muse");
  const afterAccountChange = await fetchProviderAccountQuotas("meta-muse", true);
  expect(afterAccountChange.find(row => row.accountId === first)?.quota?.fiveHourPercent).toBe(0);
  expect(afterAccountChange.find(row => row.accountId === first)?.quota?.updatedAt).toBe(rows.find(row => row.accountId === first)?.quota?.updatedAt);
  expect(sent).toHaveLength(2);
  expect(getAccountCredential("meta-muse", first)?.access).toBe(apiKey);
});

test("passive usage keeps its source and paused accounts spend no mint", async () => {
  const passive = await seed("manual", false);
  recordPassiveAccountQuota("meta-muse", passive, { weeklyPercent: 42, updatedAt: Date.now() }, 0);
  const paused = await seed("paused"); await setAccountPaused("meta-muse", paused, true);
  globalThis.fetch = (async () => { throw new Error("unexpected upstream request"); }) as typeof fetch;
  const rows = await fetchProviderAccountQuotas("meta-muse", true);
  expect(rows.find(row => row.accountId === passive)?.quotaObserved).toBe(true);
  expect(rows.find(row => row.accountId === passive)?.quota?.weeklyPercent).toBe(42);
  expect(rows.find(row => row.accountId === paused)?.quota).toBeNull();
});

test("a replaced login cannot join or publish the old token's response", async () => {
  const id = await seed("same");
  let resolveOld!: (response: Response) => void;
  let started!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  globalThis.fetch = (async (_input, init) => {
    if (new Headers(init?.headers).get("authorization") === `Bearer ${accountToken("same")}`) {
      started(); return new Promise<Response>(resolve => { resolveOld = resolve; });
    }
    return Response.json(usage(18));
  }) as typeof fetch;
  const old = fetchProviderAccountQuotas("meta-muse", true); await dispatched;
  await saveCredential("meta-muse", { access: apiKey, refresh: apiKey, expires: Number.MAX_SAFE_INTEGER,
    email: "same@example.com", muse: { oauthAccessToken: accountToken("replacement") } });
  const current = await fetchProviderAccountQuotas("meta-muse", true);
  expect(current.find(row => row.accountId === id)?.quota?.fiveHourPercent).toBe(18);
  resolveOld(Response.json(usage(91)));
  expect((await old)[0].quota).toBeNull();
  expect((await fetchProviderAccountQuotas("meta-muse"))[0].quota?.fiveHourPercent).toBe(18);
});

test("closed outcomes preserve terminal auth and distinguish empty from unusable responses", async () => {
  let now = Date.now(); let calls = 0;
  const deps = { now: () => now, fetchImpl: (async () => { calls++; return new Response("{}", { status: 401 }); }) as typeof fetch };
  expect(await fetchMuseKeyQuotaOutcome("auth", accountToken("auth"), deps)).toEqual({ kind: "terminal", failure: "access_denied" });
  expect(await fetchMuseKeyQuotaOutcome("auth", accountToken("auth"), deps)).toEqual({ kind: "terminal", failure: "access_denied" });
  expect(calls).toBe(1);
  now += 300_001;
  const empty = { ...deps, fetchImpl: (async () => Response.json({ is_subs_active: false })) as typeof fetch };
  expect(await fetchMuseKeyQuotaOutcome("empty", accountToken("empty"), empty)).toEqual({ kind: "empty" });
  const unusable = { ...deps, fetchImpl: (async () => Response.json({ is_subs_active: true })) as typeof fetch };
  expect(await fetchMuseKeyQuotaOutcome("bad", accountToken("bad"), unusable)).toEqual({ kind: "transient", failure: "response_unusable" });
});

test("Muse transient refresh retains the original reading and terminal auth clears it", async () => {
  const id = await seed("diagnostics");
  const nativeNow = Date.now;
  let now = nativeNow();
  let status = 200;
  Date.now = () => now;
  globalThis.fetch = (async () => status === 200 ? Response.json(usage(27))
    : new Response("{}", { status })) as typeof fetch;
  try {
    const original = (await fetchProviderAccountQuotas("meta-muse", true)).find(row => row.accountId === id)!;
    now += 300_001; status = 503;
    const transient = (await fetchProviderAccountQuotas("meta-muse", true))[0];
    expect(transient.quota).toEqual(original.quota);
    expect(transient.quotaFailure).toBe("upstream_error");
    expect(transient.unavailable).toBe(true);
    now += 300_001; status = 401;
    const terminal = (await fetchProviderAccountQuotas("meta-muse", true))[0];
    expect(terminal.quota).toBeNull();
    expect(terminal.quotaFailure).toBe("access_denied");
    now += 300_001; status = 200;
    const recovered = (await fetchProviderAccountQuotas("meta-muse", true))[0];
    expect(recovered.quota?.fiveHourPercent).toBe(27);
    expect(recovered.quotaFailure).toBeUndefined();
    expect(recovered.unavailable).toBeUndefined();
  } finally {
    Date.now = nativeNow;
  }
});
