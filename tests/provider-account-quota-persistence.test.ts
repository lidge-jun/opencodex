import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelPendingAccountQuotaPersist,
  readPersistedAccountQuotas,
  schedulePersistAccountQuotas,
} from "../src/providers/account-quota-disk";
import type { ProviderQuota } from "../src/providers/quota-types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
let home: string;
const FILE = "provider-account-quota-cache.json";
const KEY = "kiro\u0000acct-a";

const settle = () => new Promise(resolve => setTimeout(resolve, 400));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-quota-persist-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  cancelPendingAccountQuotaPersist();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

const quota = (percent: number, updatedAt = Date.now()): ProviderQuota => ({
  monthlyPercent: percent,
  updatedAt,
});

describe("provider account quota persistence", () => {
  test("rows survive a restart", async () => {
    schedulePersistAccountQuotas(() => [[KEY, quota(15)]]);
    await settle();
    expect(readPersistedAccountQuotas().get(KEY)?.monthlyPercent).toBe(15);
  });

  test("a stale snapshot is discarded rather than ordering the pool on old data", async () => {
    schedulePersistAccountQuotas(() => [[KEY, quota(15, Date.now() - 7 * 60 * 60_000)]]);
    await settle();
    expect(readPersistedAccountQuotas().size).toBe(0);
  });

  test("a corrupt file is ignored instead of breaking startup", () => {
    writeFileSync(join(home, FILE), "{ not json");
    expect(readPersistedAccountQuotas().size).toBe(0);
  });

  test("a file from a future schema version is ignored", () => {
    writeFileSync(join(home, FILE), JSON.stringify({ version: 2, rows: { [KEY]: quota(5) } }));
    expect(readPersistedAccountQuotas().size).toBe(0);
  });

  test("a missing file is not an error", () => {
    expect(existsSync(join(home, FILE))).toBe(false);
    expect(readPersistedAccountQuotas().size).toBe(0);
  });

  test("the snapshot carries percentages only, never credentials or identities", async () => {
    schedulePersistAccountQuotas(() => [[KEY, quota(15)]]);
    await settle();
    const raw = readFileSync(join(home, FILE), "utf8");
    expect(raw).toContain("monthlyPercent");
    for (const forbidden of ["access", "refresh", "Bearer", "@", "profileArn", "clientSecret"]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  test("writes are debounced so a burst costs one file write", async () => {
    for (let i = 0; i < 5; i++) schedulePersistAccountQuotas(() => [[KEY, quota(i)]]);
    await settle();
    expect(readPersistedAccountQuotas().get(KEY)?.monthlyPercent).toBe(4);
  });

  test("a cancelled write leaves no file behind", async () => {
    schedulePersistAccountQuotas(() => [[KEY, quota(15)]]);
    cancelPendingAccountQuotaPersist();
    await settle();
    expect(existsSync(join(home, FILE))).toBe(false);
  });
});
