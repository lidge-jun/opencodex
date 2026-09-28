import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPoolAccountQuota } from "../../src/codex/auth-api/pool-quota-probe";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota } from "../../src/codex/quota";
import { fetchCodexUsage, nextCodexUsageQueryAt, resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";

let home: string;
let previousHome: string | undefined;
let originalFetch: typeof fetch;
let now: number;
let clock: ReturnType<typeof spyOn>;
function save(token = "fixture-access") {
  saveCodexAccountCredential("backoff-pool", { accessToken: token,
    refreshToken: "fixture-refresh", chatgptAccountId: "fixture-workspace", expiresAt: now + 86_400_000 });
}
function good() {
  return Response.json({ plan_type: "plus", rate_limit: { primary_window: {
    used_percent: 10, limit_window_seconds: 18_000, reset_at: Math.floor(now / 1000) + 18_000,
  } } });
}
beforeEach(() => {
  now = Date.now();
  clock = spyOn(Date, "now").mockImplementation(() => now);
  previousHome = process.env.OPENCODEX_HOME;
  originalFetch = globalThis.fetch;
  home = mkdtempSync(join(tmpdir(), "quota-query-backoff-"));
  process.env.OPENCODEX_HOME = home;
  clearAccountQuota(); resetQuotaQueryBackoffForTests(); save();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clock.mockRestore(); clearAccountQuota(); resetQuotaQueryBackoffForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

test.each(["900", "date"])("pool reads honor Retry-After %s even when forced", async header => {
  let calls = 0;
  globalThis.fetch = Object.assign(async () => {
    calls++;
    return new Response("{}", { status: 429, headers: { "Retry-After": header === "date"
      ? new Date(now + 900_000).toUTCString() : header } });
  }, { preconnect: originalFetch.preconnect });
  const initial = now;
  await fetchPoolAccountQuota("backoff-pool");
  for (let tick = 0; tick < 29; tick++) {
    now += 30_000;
    const result = await fetchPoolAccountQuota("backoff-pool", true);
    expect(result.quotaProbeSkipped).toBe(true);
    expect(result.quotaProbeAttempted).toBeUndefined();
    expect(result.freshQuota).toBeUndefined();
  }
  expect(calls).toBe(1);
  now = initial + 900_000;
  await fetchPoolAccountQuota("backoff-pool", true);
  expect(calls).toBe(2);
});

test("transport failures back off, success clears failures, and replacement credentials retry immediately", async () => {
  let calls = 0;
  let success = false;
  globalThis.fetch = Object.assign(async () => {
    calls++;
    if (!success) throw new Error("fixture transport failure");
    return good();
  }, { preconnect: originalFetch.preconnect });
  await fetchPoolAccountQuota("backoff-pool");
  now += 300_000;
  await fetchPoolAccountQuota("backoff-pool");
  now += 300_000;
  await fetchPoolAccountQuota("backoff-pool", true);
  expect(calls).toBe(2); // Second failure requires ten minutes.
  save("fixture-replacement");
  success = true;
  expect((await fetchPoolAccountQuota("backoff-pool", true)).freshQuota).toBeDefined();
  expect(calls).toBe(3);
  success = false;
  await fetchPoolAccountQuota("backoff-pool", true);
  now += 300_000;
  await fetchPoolAccountQuota("backoff-pool", true);
  expect(calls).toBe(5); // Successful query reset the exponential delay.
});

test("same-key callers join the settled result while different keys dispatch independently", async () => {
  let finish!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = Object.assign(async () => {
    calls++;
    if (calls === 1) return new Promise<Response>(resolve => { finish = resolve; });
    return good();
  }, { preconnect: originalFetch.preconnect });
  const first = fetchCodexUsage<{ proof: string }>("race-fixture", {});
  const joined = fetchCodexUsage<{ proof: string }>("race-fixture", {});
  expect(calls).toBe(1);
  const other = await fetchCodexUsage<{ proof: string }>("other-credential", {});
  if (other?.kind !== "owner") throw new Error("different key did not dispatch");
  other.settle(true, { proof: "other" });
  finish(good());
  const owner = await first;
  if (owner?.kind !== "owner") throw new Error("first call did not own dispatch");
  const whileParsing = fetchCodexUsage<{ proof: string }>("race-fixture", {});
  expect(calls).toBe(2);
  owner.settle(true, { proof: "fresh" });
  expect(await joined).toEqual({ kind: "joined", result: { proof: "fresh" } });
  expect(await whileParsing).toEqual({ kind: "joined", result: { proof: "fresh" } });
  expect(calls).toBe(2);
});

test("malformed pool 200 keeps pacing until its due time", async () => {
  let calls = 0;
  globalThis.fetch = Object.assign(async () => {
    calls++;
    return calls === 1 ? Response.json({}) : good();
  }, { preconnect: originalFetch.preconnect });
  expect((await fetchPoolAccountQuota("backoff-pool", true)).freshQuota).toBeUndefined();
  expect((await fetchPoolAccountQuota("backoff-pool", true)).quotaProbeSkipped).toBe(true);
  now += 300_000;
  expect((await fetchPoolAccountQuota("backoff-pool", true)).freshQuota).toBeDefined();
  expect(calls).toBe(2);
});

test("oversized Retry-After is bounded by the existing 24-hour ceiling", async () => {
  let calls = 0;
  globalThis.fetch = Object.assign(async () => {
    calls++;
    return new Response("{}", { status: 429, headers: { "Retry-After": "999999999" } });
  }, { preconnect: originalFetch.preconnect });
  const first = await fetchCodexUsage("bounded", {});
  if (first?.kind !== "owner") throw new Error("first call did not dispatch");
  first.settle(false);
  now += 86_400_000 - 1;
  expect(await fetchCodexUsage("bounded", {})).toBeNull();
  now++;
  const due = await fetchCodexUsage("bounded", {});
  expect(due?.kind).toBe("owner");
  expect(calls).toBe(2);
});

test("a later short recovery failure preserves an earlier epoch Retry-After", async () => {
  let calls = 0;
  globalThis.fetch = Object.assign(async () => ++calls === 1
    ? new Response("{}", { status: 429, headers: { "Retry-After": "900" } })
    : new Response("{}", { status: 503 }), { preconnect: originalFetch.preconnect });
  const base = "main:fixture-generation";
  const long = await fetchCodexUsage(`${base}:post-reset:1`, {}, undefined, { pacingKey: base });
  const short = await fetchCodexUsage(`${base}:post-reset:2`, {}, undefined,
    { pacingKey: base, recoveryProbe: true });
  if (long?.kind !== "owner" || short?.kind !== "owner") throw new Error("epochs must dispatch independently");
  long.settle(false);
  short.settle(false);
  expect(nextCodexUsageQueryAt(`${base}:post-reset:2`)).toBe(now + 900_000);
  now += 300_000;
  expect(await fetchCodexUsage(base, {})).toBeNull();
  now += 600_000;
  expect((await fetchCodexUsage(base, {}))?.kind).toBe("owner");
  expect(calls).toBe(3);
});

test("a full cache never evicts an active read", async () => {
  let finish!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = Object.assign(async () => {
    calls++;
    if (calls === 1) return new Promise<Response>(resolve => { finish = resolve; });
    if (calls === 258) return good();
    return new Response("{}", { status: 503 });
  }, { preconnect: originalFetch.preconnect });
  const active = fetchCodexUsage<{ proof: string }>("active", {});
  for (let i = 0; i < 256; i++) {
    const read = await fetchCodexUsage(`key-${i}`, {});
    if (read?.kind !== "owner") throw new Error("capacity test did not dispatch");
    read.settle(false);
  }
  const joined = fetchCodexUsage<{ proof: string }>("active", {});
  expect(calls).toBe(257);
  finish(good());
  const owner = await active;
  if (owner?.kind !== "owner") throw new Error("active read lost ownership");
  owner.settle(true, { proof: "active" });
  expect(await joined).toEqual({ kind: "joined", result: { proof: "active" } });
  expect((await fetchCodexUsage("active", {}))?.kind).toBe("owner");
  expect(calls).toBe(258);
});
