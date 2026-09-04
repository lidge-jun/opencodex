/**
 * 429 credential failover is a safety net, not a routing policy.
 *
 * Three rotators existed with three different activation rules: `apiKeyPool` rotated on presence,
 * generic OAuth rotated on presence but could be switched off, and Anthropic rotated only behind
 * `anthropicAccountPool.enabled` -- which defaults absent. So an operator with two Claude accounts
 * logged in and a stock config got a hard 429 with the second account sitting idle.
 *
 * These tests pin the separation that resolves it: REACTIVE rotation (after upstream refused)
 * activates on presence and cannot be disabled, while PROACTIVE routing (affinity, quota-ranked
 * new-session selection, strategy, autoSwitchThreshold) stays behind the opt-in flag.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAnthropicAccountPoolState,
  getEligibleAnthropicAccounts,
  hasAnthropicFailoverQuorum,
  isAnthropicAccountPoolEnabled,
  resolveAnthropicAccountForSession,
  rotateAnthropicAccountOn429,
} from "../../src/oauth/anthropic-routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { clearAccountQuotaCache } from "../../src/providers/quota";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-always-on-429-"));
  process.env.OPENCODEX_HOME = home;
  clearAnthropicAccountPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache("anthropic");
});

afterEach(() => {
  clearAnthropicAccountPoolState();
  clearPoolRotationState();
  clearAccountQuotaCache("anthropic");
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

/** No `anthropicAccountPool` key at all: what a stock install that never opted in looks like. */
function poolAbsent(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "anthropic",
    providers: {
      anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
    },
  } as OcxConfig;
}

/** An operator who explicitly wrote `false` -- the strongest form of "I did not opt in". */
function poolDisabled(): OcxConfig {
  return { ...poolAbsent(), anthropicAccountPool: { enabled: false } } as OcxConfig;
}

async function seedAccounts(count: number): Promise<string[]> {
  for (let i = 0; i < count; i++) {
    await saveCredential("anthropic", {
      access: `access-${i}`,
      refresh: `refresh-${i}`,
      expires: Date.now() + 3_600_000,
      accountId: `uuid-${i}`,
      email: `user${i}@example.test`,
    } as never);
  }
  const set = getAccountSet("anthropic")!;
  const ids = set.accounts.map(account => account.id);
  // saveCredential activates the last account appended; pin the first for a predictable active.
  if (ids[0]) await setActiveAccount("anthropic", ids[0]);
  return ids;
}

describe("Anthropic reactive 429 failover without the pool flag", () => {
  test("a 429 rotates to the second account with the pool key absent", async () => {
    const ids = await seedAccounts(2);
    expect(isAnthropicAccountPoolEnabled(poolAbsent())).toBe(false);
    expect(hasAnthropicFailoverQuorum()).toBe(true);

    expect(rotateAnthropicAccountOn429(poolAbsent(), ids[0]!, null)).toBe(ids[1]);
    // The account that actually 429'd is the one cooled -- not whichever is active later.
    expect(getEligibleAnthropicAccounts()).toEqual([ids[1]!]);
  });

  test("an explicit enabled:false does not strand the 429 either", async () => {
    // The flag buys proactive routing. Refusing that is a real choice; refusing to retry a
    // rate-limited request on an account the operator deliberately logged in is not.
    const ids = await seedAccounts(2);
    expect(rotateAnthropicAccountOn429(poolDisabled(), ids[0]!, null)).toBe(ids[1]);
  });

  test("a single account is still a strict no-op", async () => {
    // Rotating to itself would replay the same 429 on the same credential, and cooling the only
    // account would take the provider out of service for nothing.
    const ids = await seedAccounts(1);
    expect(hasAnthropicFailoverQuorum()).toBe(false);
    expect(rotateAnthropicAccountOn429(poolAbsent(), ids[0]!, null)).toBeNull();
  });

  test("Retry-After from upstream still drives the cooldown", async () => {
    const ids = await seedAccounts(2);
    expect(rotateAnthropicAccountOn429(poolAbsent(), ids[0]!, "600")).toBe(ids[1]);
    expect(getEligibleAnthropicAccounts()).not.toContain(ids[0]!);
  });

  test("when every account is cooled the 429 is surfaced rather than looped", async () => {
    const ids = await seedAccounts(2);
    expect(rotateAnthropicAccountOn429(poolAbsent(), ids[0]!, null)).toBe(ids[1]);
    expect(rotateAnthropicAccountOn429(poolAbsent(), ids[1]!, null)).toBeNull();
  });
});

describe("proactive Anthropic routing stays opt-in", () => {
  test("with the pool off, selection still returns the active account and reports pool-disabled", async () => {
    // The whole point of the split: reactive rotation turning on must not drag session affinity
    // or quota-ranked selection on with it. An operator who never opted in still gets exactly
    // one account per session -- they just stop getting a hard 429 when it is spent.
    const ids = await seedAccounts(2);
    const selection = resolveAnthropicAccountForSession("session-1", poolAbsent());
    expect(selection.accountId).toBe(ids[0]!);
    expect(selection.reason).toBe("pool-disabled");
  });

  test("repeated resolves never drift to the second account", async () => {
    const ids = await seedAccounts(2);
    const picks = Array.from(
      { length: 5 },
      () => resolveAnthropicAccountForSession(null, poolDisabled()).accountId,
    );
    expect(picks.every(id => id === ids[0]!)).toBe(true);
  });
  test("the rotator cannot be re-gated behind the pool flag", async () => {
    // The original defect was ONE line at the top of rotateAnthropicAccountOn429:
    //   if (!isAnthropicAccountPoolEnabled(config)) return null;
    // Restoring it would strand every stock install again, and nothing else in this file would
    // fail -- every behavioural test seeds two accounts, which satisfies the quorum either way,
    // so they would keep passing while the feature was dead for the users who never opted in.
    //
    // Pin the shape instead: the flag may still appear in the rotator, but only alongside the
    // presence check, never as a gate of its own.
    const source = await Bun.file("src/oauth/anthropic-routing.ts").text();
    const start = source.indexOf("export function rotateAnthropicAccountOn429");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));
    const gate = body.split("\n").find(line => line.includes("isAnthropicAccountPoolEnabled"));
    expect(gate, "the rotator no longer references the pool flag at all").toBeDefined();
    expect(gate, "the pool flag became a gate of its own again").toContain("hasAnthropicFailoverQuorum");
  });
});
