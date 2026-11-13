import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oauthAccountLogLabel } from "../../src/codex/account-label";
import { clearGenericFailoverHealth, genericAccountRoster, rotateGenericOAuthAccountOn429 } from "../../src/oauth/generic-account-failover";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../src/providers/quota";
import { addFinalRequestLog, clearRequestLogsForTests, getRequestLogEntries, type RequestLogEntry } from "../../src/server/request-log";
import { resetUsageReadCacheForTests, readUsageEntries } from "../../src/usage/log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-account-roster-"));
  process.env.OPENCODEX_HOME = home;
  clearGenericFailoverHealth();
  clearRequestLogsForTests();
  resetUsageReadCacheForTests();
});

afterEach(() => {
  clearGenericFailoverHealth();
  clearAccountQuotaCache("xai");
  clearRequestLogsForTests();
  resetUsageReadCacheForTests();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

const config = {
  providers: { xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" } as unknown as OcxProviderConfig },
} as unknown as OcxConfig;

interface SeedFlags { paused?: boolean; needsReauth?: boolean }

/** Writes auth.json directly: the store's own writers harden ACLs per call, which is slow on Windows. */
function seed(count: number, provider = "xai", flags: Record<number, SeedFlags> = {}): string[] {
  const accounts = Array.from({ length: count }, (_, i) => ({
    id: `${provider}-acct-${i}`,
    credential: { access: `access-${i}`, refresh: `refresh-${i}`, expires: 9999999999999, accountId: `uuid-${i}`, source: "oauth" },
    ...flags[i],
  }));
  const path = join(home, "auth.json");
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  writeFileSync(path, JSON.stringify({ ...existing, [provider]: { activeAccountId: accounts[0]!.id, accounts } }), { mode: 0o600 });
  return accounts.map(account => account.id);
}

const label = (id: string) => oauthAccountLogLabel(id, "xai");

function finalRow(provider: string, accountId: string | undefined, extra: Record<string, unknown> = {}): RequestLogEntry {
  const rows: RequestLogEntry[] = [];
  addFinalRequestLog("roster-row", Date.now(), {
    model: "grok-4.7", provider, ...(accountId ? { accountLogLabel: label(accountId) } : {}), ...extra,
  }, 200, undefined, row => rows.push(row));
  return rows[0]!;
}

describe("account roster classification", () => {
  test("every account is available when nothing is wrong", () => {
    const ids = seed(3);
    expect(genericAccountRoster("xai", "grok-4.7")).toEqual({
      provider: "xai",
      accounts: ids.map(id => ({ label: label(id), state: "available" })),
    });
  });

  test("paused, needs-reauth, quota-exhausted and cooldown are told apart", () => {
    const [paused, reauth, exhausted, cooled, ok] = seed(5, "xai", { 0: { paused: true }, 1: { needsReauth: true } });
    setCachedProviderAccountQuotaForTests("xai", exhausted!, { weeklyPercent: 100, updatedAt: Date.now() });
    rotateGenericOAuthAccountOn429(config, "xai", cooled!, null);
    const states = Object.fromEntries(genericAccountRoster("xai", "grok-4.7")!.accounts.map(a => [a.label, a.state]));
    expect(states).toEqual({
      [label(paused!)]: "paused",
      [label(reauth!)]: "needs-reauth",
      [label(exhausted!)]: "quota-exhausted",
      [label(cooled!)]: "cooldown",
      [label(ok!)]: "available",
    });
  });

  test("precedence is paused, needs-reauth, quota-exhausted, then cooldown", () => {
    const [both, exhaustedAndCooled, ok] = seed(3, "xai", { 0: { paused: true, needsReauth: true } });
    setCachedProviderAccountQuotaForTests("xai", exhaustedAndCooled!, { weeklyPercent: 100, updatedAt: Date.now() });
    rotateGenericOAuthAccountOn429(config, "xai", exhaustedAndCooled!, null);
    const states = genericAccountRoster("xai", "grok-4.7")!.accounts.map(a => a.state);
    expect(states[0]).toBe("paused");
    expect(states[1]).toBe("quota-exhausted");
    expect(states[2]).toBe("available");
    expect(ok).toBeDefined();
  });

  test("a pool of 17 reports 16 accounts and says it was cut", () => {
    seed(17);
    const roster = genericAccountRoster("xai", "grok-4.7")!;
    expect(roster.accounts).toHaveLength(16);
    expect(roster.truncated).toBe(true);
  });

  test("one account, no account, and the Codex or Anthropic pools have no roster", () => {
    seed(1);
    expect(genericAccountRoster("xai", "grok-4.7")).toBeUndefined();
    expect(genericAccountRoster("cursor", "composer")).toBeUndefined();
    seed(2, "openai");
    seed(2, "anthropic");
    expect(genericAccountRoster("openai", "gpt")).toBeUndefined();
    expect(genericAccountRoster("anthropic", "claude")).toBeUndefined();
  });
});

describe("accountRoster on the final request row", () => {
  test("the served row carries the roster and the served label is one of its accounts", () => {
    const ids = seed(2, "xai", { 1: { paused: true } });
    const row = finalRow("xai", ids[0]!);
    expect(row.accountRoster).toEqual({
      provider: "xai",
      accounts: [{ label: label(ids[0]!), state: "available" }, { label: label(ids[1]!), state: "paused" }],
    });
    expect(row.accountRoster!.accounts.some(a => a.label === row.accountLogLabel)).toBe(true);
  });

  test("a combo row takes the roster from the last attempt's provider and label", () => {
    const ids = seed(2);
    const attempt = {
      ordinal: 1, provider: "xai", model: "grok-4.7", adapter: "openai-chat", status: 200, durationMs: 5, sendCount: 1,
      recoveryKinds: [], usageStatus: "unreported", accountLogLabel: label(ids[0]!),
    };
    const row = finalRow("combo-owner", undefined, { comboId: "c", requestedModel: "my-combo", attempts: [attempt] });
    expect(row.provider).toBe("combo");
    expect(row.accountRoster?.accounts.map(a => a.label)).toEqual(ids.map(label));
  });

  test("single-account and non-OAuth rows have no roster field", () => {
    const [only] = seed(1);
    expect("accountRoster" in finalRow("xai", only!)).toBe(false);
    expect("accountRoster" in finalRow("openrouter", undefined)).toBe(false);
  });

  test("the roster stays in memory and never reaches usage.jsonl", () => {
    const ids = seed(2);
    expect(finalRow("xai", ids[0]!).accountRoster).toBeDefined();
    addFinalRequestLog("roster-persisted", Date.now(), { model: "grok-4.7", provider: "xai", accountLogLabel: label(ids[0]!) }, 200);
    expect(getRequestLogEntries()[0]?.accountRoster).toBeDefined();
    const persisted = readUsageEntries();
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain("accountRoster");
  });
});
