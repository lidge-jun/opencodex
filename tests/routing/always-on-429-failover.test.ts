import { rotateAnthropicAccountOn429 } from "../helpers/anthropic-shared-quota";
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
import { clearComboTargetCooldowns, coolComboTarget, isComboTargetInCooldown } from "../../src/combos/failover";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { executeComboResponses, isAnthropicPoolLocalRefusal } from "../../src/server/responses/core-combo";
import type { ResponsesDispatchers } from "../../src/server/responses/core-options";
import {
  clearAnthropicAccountPoolState,
  getAnthropicPoolRetryAfterSeconds,
  getEligibleAnthropicAccounts,
  hasAnthropicFailoverQuorum,
  isAnthropicAccountPoolEnabled,
  resolveAnthropicAccountForSession,
} from "../../src/oauth/anthropic-routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../src/providers/quota";
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

  test("a disabled pool does not apply its dormant proactive strategy to reactive recovery", async () => {
    // The pool flag buys PROACTIVE routing: affinity, quota ranking, and the declared strategy.
    // Leaving `strategy: "round-robin"` in a config whose pool is off is not an opt-in to
    // round-robin -- it is dormant configuration. Reactive recovery must therefore fall back to
    // the neutral quota picker rather than reactivating the strategy the operator switched off.
    const ids = await seedAccounts(3);
    setCachedProviderAccountQuotaForTests("anthropic", ids[1]!, { fiveHourPercent: 90 });
    setCachedProviderAccountQuotaForTests("anthropic", ids[2]!, { fiveHourPercent: 10 });
    const disabledRoundRobin = {
      ...poolAbsent(),
      anthropicAccountPool: { enabled: false, strategy: "round-robin" },
    } as OcxConfig;

    // Round-robin would hand back ids[1] (the next account in order); quota ordering picks the
    // account with the most headroom instead.
    expect(rotateAnthropicAccountOn429(disabledRoundRobin, ids[0]!, null)).toBe(ids[2]);
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

  // The combo layer keys its target cooldown off this. While the pool holds the wait, its 429
  // Retry-After is only its own earliest account cooldown restated, so the combo must not also
  // park the target on it -- otherwise an account added a minute later sits ignored until the
  // target cooldown expires, which for a weekly window is the 24h server-delay ceiling.
  test("only the OAuth pool's own all-cooled 429 is a local refusal", async () => {
    const ids = await seedAccounts(2);
    const oauth = poolAbsent();
    const refusal = (config = oauth, account?: string) =>
      isAnthropicPoolLocalRefusal(config, "anthropic", 429, account);
    expect(refusal()).toBe(false);
    const weekly = String(4 * 86_400);
    expect(rotateAnthropicAccountOn429(oauth, ids[0]!, weekly)).toBe(ids[1]);
    // One account still eligible: an upstream 429 here is about THAT account, not the pool.
    expect(refusal()).toBe(false);
    expect(rotateAnthropicAccountOn429(oauth, ids[1]!, weekly)).toBeNull();
    expect(getAnthropicPoolRetryAfterSeconds()).toBeGreaterThan(86_400);
    expect(refusal()).toBe(true);
    // Provenance, not just pool state: an identified account or an API-key provider is upstream
    // speaking, so its Retry-After must still park the target in full.
    expect(refusal(oauth, "anthropic-p0000000")).toBe(false);
    const apiKey = { ...oauth, providers: { anthropic: { ...oauth.providers.anthropic!, authMode: "key" } } } as OcxConfig;
    expect(refusal(apiKey)).toBe(false);
    expect(isAnthropicPoolLocalRefusal(oauth, "anthropic", 503, undefined)).toBe(false);
    // A fresh account makes the pool usable again at once, which a parked target would ignore.
    await saveCredential("anthropic", {
      access: "access-new", refresh: "refresh-new", expires: Date.now() + 3_600_000,
      accountId: "uuid-new", email: "new@example.test",
    } as never);
    expect(refusal()).toBe(false);
  });

  // The combo-layer half, mirroring core-combo's call site: the target still cools (the
  // anti-hammer guard), but for the local fallback rather than the pool's multi-day Retry-After.
  // A single account is deliberately never cooled by rotation (see the no-op test above), so the
  // pool cannot hold the wait there and an upstream Retry-After keeps parking the target as before.
  test("a pool-held 429 cools the combo target for minutes, not for the pool's Retry-After", async () => {
    const ids = await seedAccounts(2);
    const weekly = String(4 * 86_400);
    rotateAnthropicAccountOn429(poolAbsent(), ids[0]!, weekly);
    rotateAnthropicAccountOn429(poolAbsent(), ids[1]!, weekly);
    const now = Date.now();
    const local = isAnthropicPoolLocalRefusal(poolAbsent(), "anthropic", 429, undefined, now);
    expect(local).toBe(true);
    const target = { provider: "anthropic", model: "claude-opus-5" };
    clearComboTargetCooldowns("pool-held");
    coolComboTarget("pool-held", target, { now, retryAfter: local ? undefined : weekly, status: 429 });
    expect(isComboTargetInCooldown("pool-held", target, now + 1)).toBe(true);
    expect(isComboTargetInCooldown("pool-held", target, now + 10 * 60_000)).toBe(false);
    clearComboTargetCooldowns("pool-held");
  });

  // Production wiring, not a mirror of it: drive the real combo failure path with a child that
  // answers exactly what the pool answers when every account is cooled -- a 429 carrying the
  // earliest account reset as Retry-After. The control sends the SAME 429 while an account is
  // still eligible, so the only difference between the two runs is who is holding the wait.
  test("the combo failure path withholds only the pool's own Retry-After from the target", async () => {
    const weekly = String(4 * 86_400);
    const target = { provider: "anthropic", model: "claude-opus-5" };
    const config = {
      ...poolAbsent(),
      combos: { waterfall: { strategy: "failover", targets: [{ ...target }] } },
    } as OcxConfig;
    const poolRefusal: ResponsesDispatchers = {
      async handleResponses() {
        return new Response(
          JSON.stringify({ error: { type: "rate_limit_error", message: "All Anthropic OAuth accounts are temporarily rate-limited" } }),
          { status: 429, headers: { "content-type": "application/json", "retry-after": weekly } },
        );
      },
      async handleComboResponses() { throw new Error("nested combo dispatch is not expected"); },
    };
    const run = async () => {
      const body = { model: "combo/waterfall", input: "hi", stream: false };
      const budget = createTranslatorBudget();
      try {
        return await executeComboResponses(
          new Request("http://127.0.0.1/v1/responses", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
          }),
          body, "waterfall", config, { model: "", provider: "" }, { translatorBudget: budget }, poolRefusal,
        );
      } finally {
        budget.dispose();
      }
    };

    // Control: one account is still eligible, so this 429 is upstream speaking and parks in full.
    const ids = await seedAccounts(2);
    rotateAnthropicAccountOn429(config, ids[0]!, weekly);
    clearComboTargetCooldowns("waterfall");
    const controlAt = Date.now();
    expect((await run()).status).toBe(429);
    expect(isComboTargetInCooldown("waterfall", target, controlAt + 10 * 60_000 + 1_000)).toBe(true);

    // Pool-held: every account cooled. The target still cools, but only for the local fallback.
    rotateAnthropicAccountOn429(config, ids[1]!, weekly);
    clearComboTargetCooldowns("waterfall");
    const heldAt = Date.now();
    expect((await run()).status).toBe(429);
    expect(isComboTargetInCooldown("waterfall", target, heldAt + 1)).toBe(true);
    expect(isComboTargetInCooldown("waterfall", target, heldAt + 10 * 60_000 + 1_000)).toBe(false);
    clearComboTargetCooldowns("waterfall");
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
    // Pin the activation gate in the recorder, which the rotator now calls before
    // choosing a replacement. The rotator may use the flag separately to select its
    // proactive strategy, but must not reject a pool-off request before recording.
    // #6340 folded the 429 and proven-403 paths into rotateAnthropicAccountOnRefusal and
    // recordAnthropicAccountRefusal; the 429 entry points delegate to them.
    const source = await Bun.file("src/oauth/anthropic-routing.ts").text();
    const start = source.indexOf("export function rotateAnthropicAccountOnRefusal");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));
    const recordCall = body.indexOf("if (!recordAnthropicAccountRefusal(");
    expect(recordCall, "the rotator no longer uses the recorder's quorum gate").toBeGreaterThan(-1);
    expect(body.slice(0, recordCall), "the rotator added a pool-only gate before recording")
      .not.toContain("isAnthropicAccountPoolEnabled");

    const recordStart = source.indexOf("export function recordAnthropicAccountRefusal");
    expect(recordStart).toBeGreaterThan(-1);
    const recordBody = source.slice(recordStart, source.indexOf("\n}", recordStart));
    const gate = recordBody.split("\n").find(line =>
      line.trimStart().startsWith("if (") && line.includes("isAnthropicAccountPoolEnabled"));
    expect(gate, "the recorder no longer checks the pool flag").toBeDefined();
    expect(gate, "the pool flag became a gate of its own again").toContain("hasAnthropicFailoverQuorum");
  });
});
