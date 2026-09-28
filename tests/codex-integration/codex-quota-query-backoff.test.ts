import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPoolAccountQuota } from "../../src/codex/auth-api/pool-quota-probe";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota } from "../../src/codex/quota";
import { fetchCodexUsage, resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";

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

test("same-key dispatch stays single-flight until body validation; another key can proceed", async () => {
  let finish!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = Object.assign(async () => {
    calls++;
    if (calls === 1) return new Promise<Response>(resolve => { finish = resolve; });
    return good();
  }, { preconnect: originalFetch.preconnect });
  const first = fetchCodexUsage("race-fixture", {});
  expect(await fetchCodexUsage("race-fixture", {})).toBeNull();
  finish(good());
  const read = await first;
  expect(read?.response.ok).toBe(true);
  expect(await fetchCodexUsage("race-fixture", {})).toBeNull();
  const other = await fetchCodexUsage("other-credential", {});
  other?.settle(true);
  expect(calls).toBe(2);
  read?.settle(false); // An unusable 200 keeps failure pacing.
  expect(await fetchCodexUsage("race-fixture", {})).toBeNull();
  now += 300_000;
  (await fetchCodexUsage("race-fixture", {}))?.settle(true);
  expect(calls).toBe(3);
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
  await fetchCodexUsage("bounded", {});
  now += 86_400_000 - 1;
  expect(await fetchCodexUsage("bounded", {})).toBeNull();
  now++;
  await fetchCodexUsage("bounded", {});
  expect(calls).toBe(2);
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
  const active = fetchCodexUsage("active", {});
  for (let i = 0; i < 256; i++) await fetchCodexUsage(`key-${i}`, {});
  expect(await fetchCodexUsage("active", {})).toBeNull();
  finish(good());
  (await active)?.settle(true);
  expect((await fetchCodexUsage("active", {}))?.response.ok).toBe(true);
  expect(calls).toBe(258);
});
