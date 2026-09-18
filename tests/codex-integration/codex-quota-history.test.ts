import { describe, expect, test } from "bun:test";
import { CodexQuotaHistory, QUOTA_HISTORY_LIMITS, type QuotaHistorySample } from "../../src/codex/quota-history";
import type { PoolQuotaWriter } from "../../src/codex/quota-types";

const now = 1_800_000_000_000;
const identity = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const replacement = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const writer: PoolQuotaWriter = { accountId: "pool-a", credentialGeneration: 1, historyIdentity: identity };
function sample(at = now, usedPercent = 10): QuotaHistorySample {
  return { observedAt: at, source: "wham", credentialGeneration: 1,
    windows: [{ family: "account", window: "weekly", usedPercent, resetAtMs: now + 100_000 }] };
}

describe("bounded quota observation history", () => {
  test("keeps the newest observations by time and returns independent copies", () => {
    const history = new CodexQuotaHistory();
    for (let index = 200; index >= 0; index--) history.append(writer, sample(now - index), now);
    const result = history.read(writer.accountId, identity, now);
    expect(result.samples).toHaveLength(200);
    expect(result.samples[0].observedAt).toBe(now - 199);
    expect(result.samples[199].observedAt).toBe(now);
    result.samples[0].windows[0].usedPercent = 99;
    expect(history.read(writer.accountId, identity, now).samples[0].windows[0].usedPercent).toBe(10);
    expect(history.read(writer.accountId, identity, now, 1)).toMatchObject({ truncated: true, samples: [sample(now)] });
  });

  test("refresh retains history but replacement and roster removal retire it", () => {
    const history = new CodexQuotaHistory();
    history.append(writer, sample(), now);
    history.append({ ...writer, credentialGeneration: 2 }, { ...sample(now + 1), credentialGeneration: 2 }, now + 1);
    expect(history.read(writer.accountId, undefined, now + 1).samples).toEqual([]);
    expect(history.read(writer.accountId, identity, now + 1).samples).toHaveLength(2);
    expect(history.read(writer.accountId, replacement, now + 1).samples).toEqual([]);
    history.append({ ...writer, historyIdentity: replacement }, sample(now + 2), now + 2);
    expect(history.reconcile(new Set())).toBe(1);
    expect(history.serialize(now + 2).accounts).toEqual({});
  });

  test("rejects invalid observations and never admits native-main identity", () => {
    const history = new CodexQuotaHistory();
    for (const used of [-1, 101, Number.NaN, Infinity]) history.append(writer, sample(now, used), now);
    history.append(writer, sample(now + 1), now);
    history.append({ ...writer, accountId: "__main__" }, sample(), now);
    history.append(writer, { ...sample(), windows: [] }, now);
    history.append(writer, { ...sample(), windows: [sample().windows[0], sample().windows[0]] }, now);
    expect(history.serialize(now).accounts).toEqual({});
  });

  test("disk hydration rejects overflow rather than losing a newer 65th account", () => {
    const history = new CodexQuotaHistory();
    const accounts = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`pool-${i}`, { identity, samples: [sample(now - 65 + i)] }]));
    history.hydrate({ version: 1, accounts }, now);
    expect(history.serialize(now).accounts).toEqual({});
    history.hydrate({ version: 1, accounts: { "pool-a": { identity, samples: Array.from({ length: 201 }, () => sample()) } } }, now);
    expect(history.serialize(now).accounts).toEqual({});
    history.hydrate({ version: 1, accounts: { "pool-a": { identity, samples: [sample()] } }, extra: "x".repeat(QUOTA_HISTORY_LIMITS.bytes) }, now);
    expect(history.serialize(now).accounts).toEqual({});
  });

  test("valid unordered disk rows are sorted and arbitrary payload fields are discarded", () => {
    const history = new CodexQuotaHistory();
    history.hydrate({ version: 1, accounts: { "pool-a": { identity, secret: "private-token", samples: [
      { ...sample(now), secret: "private-token" }, sample(now - 2), sample(now - 1),
    ] } } }, now);
    expect(history.read("pool-a", identity, now).samples.map(row => row.observedAt)).toEqual([now - 2, now - 1, now]);
    expect(JSON.stringify(history.serialize(now))).not.toContain("private-token");
    expect(history.read("pool-a", identity, now + QUOTA_HISTORY_LIMITS.ageMs + 1).samples).toEqual([]);
  });

  test("global retention evicts oldest samples and stays below the serialized byte bound", () => {
    const history = new CodexQuotaHistory();
    for (let account = 0; account < 65; account++) {
      for (let i = 0; i < 100; i++) history.append({ ...writer, accountId: `pool-${account}` }, sample(now - 6500 + account * 100 + i), now);
    }
    const disk = history.serialize(now);
    expect(Object.keys(disk.accounts).length).toBeLessThanOrEqual(QUOTA_HISTORY_LIMITS.accounts);
    expect(Object.values(disk.accounts).reduce((n, row) => n + row.samples.length, 0)).toBeLessThanOrEqual(QUOTA_HISTORY_LIMITS.samples);
    expect(new TextEncoder().encode(JSON.stringify(disk)).byteLength).toBeLessThanOrEqual(QUOTA_HISTORY_LIMITS.bytes);
    expect(disk.accounts["pool-64"].samples.at(-1)?.observedAt).toBe(now - 1);
  });
});


test("append byte budget evicts samples before any row or account count limit", () => {
  const history = new CodexQuotaHistory();
  const windows = ([
    ["account", "short"], ["account", "weekly"], ["account", "monthly"], ["spark", "short"], ["spark", "weekly"],
  ] as const).map(([family, window]) => ({ family, window, usedPercent: 12.345678901234567,
    resetAtMs: 1_800_000_123_456.789, windowSeconds: 123_456_789.12345678,
    ...(window === "monthly" ? { monthlyIsPrimaryWindow: true } : {}),
  }));
  for (let account = 0; account < 32; account++) for (let index = 0; index < 128; index++) {
    history.append({ ...writer, accountId: `long-account-${account}` }, { ...sample(now - 4096 + account * 128 + index), windows }, now);
  }
  const persisted = history.serialize(now);
  const retained = Object.values(persisted.accounts).reduce((count, row) => count + row.samples.length, 0);
  expect(retained).toBeGreaterThan(0);
  expect(retained).toBeLessThan(4096);
  expect(new TextEncoder().encode(JSON.stringify(persisted)).byteLength).toBeLessThanOrEqual(QUOTA_HISTORY_LIMITS.bytes);
});
