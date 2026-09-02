import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync} from "node:fs";
import { join } from "node:path";
import {
  clearCodexCooldownRecoveryProbeState,
  clearAccountQuota,
  runCodexCooldownRecoveryProbes,
  seedCodexAuthAdmissionForTests,
} from "../src/codex/auth-api";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import {
  codexQuotaWindowForPlan,
  getAccountQuota,
  isCompleteCodexQuotaRecoverySnapshot,
  parseUsageQuota,
  setAccountQuotaFromParsed,
  updateAccountQuota,
} from "../src/codex/quota";
import upstreamModels from "../src/codex/data/upstream-models.json";
import {
  CODEX_QUOTA_PROBE_INTERVAL_MS,
  clearCodexUpstreamHealth,
  getCodexQuotaHealthSnapshot,
  recordCodexUpstreamOutcome,
  resolveCodexAccountForThread,
} from "../src/codex/routing";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-cooldown-recovery-test");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
const START = 1_800_000_000_000;
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;
let previousFetch: typeof fetch;

function makeConfig(ids = ["a", "b"]): OcxConfig {
  return {
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    defaultProvider: "openai",
    activeCodexAccountId: ids[0],
    accountPoolStrategy: "fill-first",
    codexAccounts: ids.map(id => ({ id, email: `${id}@example.test`, plan: "team", isMain: false })),
  } as OcxConfig;
}

function saveCredential(id: string, suffix = ""): void {
  saveCodexAccountCredential(id, {
    accessToken: `access-${id}${suffix}`,
    refreshToken: `refresh-${id}${suffix}`,
    expiresAt: Date.now() + 60 * 60_000,
    chatgptAccountId: `acct-${id}${suffix}`,
  });
}

function cool(config: OcxConfig, id: string, scope: "shared" | "spark" = "shared", now = START): void {
  recordCodexUpstreamOutcome(config, id, 429, {
    now,
    resetAt: now + 60 * 60_000,
    modelId: scope === "spark" ? "gpt-5.3-codex-spark" : "gpt-5.6-sol",
  });
}

function usageResponse(percent = 10, body?: unknown): Response {
  return new Response(JSON.stringify(body ?? {
    plan_type: "team",
    rate_limit: { secondary_window: { used_percent: percent, reset_at: 1_900_000_000 } },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function due(at = START): number {
  return at + CODEX_QUOTA_PROBE_INTERVAL_MS + 1;
}

describe("Codex cooldown recovery worker", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    previousFetch = globalThis.fetch;
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
    mkdirSync(TEST_CODEX_HOME, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.CODEX_HOME = TEST_CODEX_HOME;
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearCodexCooldownRecoveryProbeState();
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearCodexCooldownRecoveryProbeState();
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  });

  test("recovers cooled A independently while ordinary routing only selects B", async () => {
    const config = makeConfig();
    saveCredential("a");
    saveCredential("b");
    cool(config, "a");
    const routed = [resolveCodexAccountForThread("before", config, due())];
    const authorizations: string[] = [];
    globalThis.fetch = async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
      return usageResponse(12);
    };

    await runCodexCooldownRecoveryProbes(config, due());
    routed.push(resolveCodexAccountForThread("after", config, due() + 1));

    expect(authorizations).toEqual(["Bearer access-a"]);
    expect(getCodexQuotaHealthSnapshot("a", "shared", due() + 1)).toBeNull();
    expect(routed).toEqual(["b", "b"]);
  });

  test("recovers a Team account from a duration-classified monthly snapshot", async () => {
    // WHAM can legitimately return only an explicitly monthly primary window for a Team
    // plan (30.4-day window, no secondary). parseUsageQuota then writes monthlyPercent only,
    // so recovery must accept the window the parser actually classified instead of demanding
    // a weekly reading because the plan name is not "go"/"free".
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a");
    globalThis.fetch = async () => usageResponse(0, {
      plan_type: "team",
      rate_limit: {
        primary_window: { used_percent: 6, reset_at: 1_900_000_000, limit_window_seconds: 2_628_000 },
        secondary_window: null,
        tertiary_window: null,
      },
      rate_limit_reset_credits: { available_count: 0 },
    });
    await runCodexCooldownRecoveryProbes(config, due());
    expect(getCodexQuotaHealthSnapshot("a", "shared", due() + 1)).toBeNull();
  });

  test("does NOT recover a Team account from a tertiary-only monthly snapshot", async () => {
    // The mirror image of the case above, and the reason accepting "whatever the parser
    // wrote" is too permissive. A tertiary window also lands in monthlyPercent, but it
    // describes a different period and says nothing about the WEEKLY quota that actually
    // gates a Team account — clearing the cooldown on it would restore traffic to an
    // account whose governing window was never read. Only an explicitly-monthly PRIMARY
    // window is that reading, which is what monthlyIsPrimaryWindow records.
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a");
    globalThis.fetch = async () => usageResponse(0, {
      plan_type: "team",
      rate_limit: {
        primary_window: null,
        secondary_window: null,
        tertiary_window: { used_percent: 7, reset_at: 1_900_000_000 },
      },
      rate_limit_reset_credits: { available_count: 0 },
    });
    await runCodexCooldownRecoveryProbes(config, due());
    expect(getCodexQuotaHealthSnapshot("a", "shared", due() + 1)).not.toBeNull();
  });

  test("recovers when the probe's own token refresh advances the credential generation", async () => {
    // A near-expiry access token makes getValidCodexToken() refresh it inside the probe
    // fetch, bumping the credential generation from 1 to 2 before WHAM completes. The fresh
    // quota is proven under the new live generation, so settling against the claim-time
    // generation must accept this probe's own refresh, not treat it as a replacement.
    const config = makeConfig(["a"]);
    saveCodexAccountCredential("a", {
      accessToken: "access-a",
      refreshToken: "refresh-a",
      expiresAt: Date.now() + 30_000,
      chatgptAccountId: "acct-a",
    });
    cool(config, "a");
    globalThis.fetch = async input => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/oauth/token")) {
        return new Response(JSON.stringify({
          access_token: "access-a-2",
          refresh_token: "refresh-a-2",
          expires_in: 3600,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return usageResponse(12);
    };
    await runCodexCooldownRecoveryProbes(config, due());
    expect(getCodexQuotaHealthSnapshot("a", "shared", due() + 1)).toBeNull();
  });

  test.each([
    ["still exhausted", () => usageResponse(100)],
    ["credits only", () => usageResponse(0, { plan_type: "team", rate_limit_reset_credits: { available_count: 1 } })],
    ["non-2xx", () => new Response("busy", { status: 503 })],
    ["parse failure", () => new Response("not-json", { status: 200 })],
  ])("retains the cooldown for %s", async (_name, response) => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a");
    globalThis.fetch = async () => response();
    await runCodexCooldownRecoveryProbes(config, due());
    expect(getCodexQuotaHealthSnapshot("a", "shared", due() + 1)).not.toBeNull();
  });

  test("retains the cooldown after transport timeout", async () => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a");
    globalThis.fetch = async () => { throw new DOMException("timed out", "TimeoutError"); };
    await runCodexCooldownRecoveryProbes(config, due());
    expect(getCodexQuotaHealthSnapshot("a", "shared", due() + 1)).not.toBeNull();
    // Same reasoning as the admission case: prove the timed-out claim released its lease by
    // requiring a later pass to succeed.
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return usageResponse(); };
    const later = due() + CODEX_QUOTA_PROBE_INTERVAL_MS + 1;
    await runCodexCooldownRecoveryProbes(config, later);
    expect(calls).toBe(1);
    expect(getCodexQuotaHealthSnapshot("a", "shared", later + 1)).toBeNull();
  });

  test("retains and releases a claim when quota admission is busy", async () => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a");
    const cleanup = seedCodexAuthAdmissionForTests({ quotaFlights: 16 });
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return usageResponse(); };
    try {
      await runCodexCooldownRecoveryProbes(config, due());
    } finally {
      cleanup();
    }
    expect(calls).toBe(0);
    expect(getCodexQuotaHealthSnapshot("a", "shared", due() + 1)).not.toBeNull();

    // "Releases" has to be proven, not asserted by the test name. A stranded lease is worse
    // than the bug being fixed: that account would never be probed again. So lift the admission
    // pressure, advance past the probe interval, and require the NEXT pass to reach WHAM and
    // actually clear the cooldown — which is only possible if the failed claim released.
    const later = due() + CODEX_QUOTA_PROBE_INTERVAL_MS + 1;
    await runCodexCooldownRecoveryProbes(config, later);
    expect(calls).toBe(1);
    expect(getCodexQuotaHealthSnapshot("a", "shared", later + 1)).toBeNull();
  });

  test("credential replacement during WHAM cannot clear the old cooldown", async () => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = async () => { await gate; return usageResponse(); };
    const run = runCodexCooldownRecoveryProbes(config, due());
    await Promise.resolve();
    saveCredential("a", "-new");
    release();
    await run;
    expect(getCodexQuotaHealthSnapshot("a", "shared", due() + 1)).not.toBeNull();
  });

  test("a newer 429 during WHAM cannot be erased by the older probe", async () => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = async () => { await gate; return usageResponse(); };
    const run = runCodexCooldownRecoveryProbes(config, due());
    await Promise.resolve();
    recordCodexUpstreamOutcome(config, "a", 429, {
      now: due() + 1,
      resetAt: due() + 60 * 60_000,
      modelId: "gpt-5.6-sol",
    });
    release();
    await run;
    expect(getCodexQuotaHealthSnapshot("a", "shared", due() + 2)).not.toBeNull();
  });

  test("concurrent worker passes coalesce into one WHAM request", async () => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a");
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; await Promise.resolve(); return usageResponse(); };
    await Promise.all([
      runCodexCooldownRecoveryProbes(config, due()),
      runCodexCooldownRecoveryProbes(config, due()),
    ]);
    expect(calls).toBe(1);
  });

  test("shared recovery leaves Spark cooled", async () => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a", "shared", START);
    cool(config, "a", "spark", START + 1);
    globalThis.fetch = async () => usageResponse();
    await runCodexCooldownRecoveryProbes(config, due(START + 1));
    expect(getCodexQuotaHealthSnapshot("a", "shared", due(START + 1) + 1)).toBeNull();
    expect(getCodexQuotaHealthSnapshot("a", "spark", due(START + 1) + 1)).not.toBeNull();
  });

  test("an older Spark cooldown never starves the shared scope that can recover", async () => {
    // Spark is skipped at the claim site: generic WHAM carries no scope and can never prove a
    // spark recovery. Claiming it would spend the account's one claim per pass to settle false,
    // leaving the shared scope — which this evidence CAN clear — cooled behind it.
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a", "spark", START);
    cool(config, "a", "shared", START + 1);
    globalThis.fetch = async () => usageResponse();
    await runCodexCooldownRecoveryProbes(config, due(START + 1));
    expect(getCodexQuotaHealthSnapshot("a", "spark", due(START + 1) + 1)).not.toBeNull();
    expect(getCodexQuotaHealthSnapshot("a", "shared", due(START + 1) + 1)).toBeNull();
  });

  test("a Spark-only cooldown makes no upstream call at all", async () => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a", "spark", START);
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return usageResponse(); };
    await runCodexCooldownRecoveryProbes(config, due(START));
    expect(calls).toBe(0);
    expect(getCodexQuotaHealthSnapshot("a", "spark", due(START) + 1)).not.toBeNull();
  });

  test("recovery reads the same window the parser wrote, for EVERY plan", () => {
    // Derived from the upstream snapshot, not hand-listed. An allowlist was tried here and was
    // wrong: 21 distinct plan strings appear in this file alone, and `CodexAccount.plan` is an
    // unrestricted string, so any list is a list of the plans someone remembered — and every
    // omission means an account cooled forever, which is the defect this unit exists to fix.
    const snapshotPlans = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "available_in_plans" && Array.isArray(value)) {
          for (const plan of value) if (typeof plan === "string") snapshotPlans.add(plan);
        } else walk(value);
      }
    };
    walk(upstreamModels);
    expect(snapshotPlans.size).toBeGreaterThan(9);

    // Pin the rule INDEPENDENTLY first. Deriving the expectation from
    // codexQuotaWindowForPlan() below would only prove the loop agrees with itself, so state
    // the contract in literals: Go and Free bill on the 30-day window, everything else weekly.
    expect(codexQuotaWindowForPlan("go")).toBe("monthly");
    expect(codexQuotaWindowForPlan("free")).toBe("monthly");
    expect(codexQuotaWindowForPlan(" GO ")).toBe("monthly");
    for (const plan of ["plus", "pro", "prolite", "team", "business", "enterprise", "edu", "finserv", "k12"]) {
      expect(codexQuotaWindowForPlan(plan)).toBe("weekly");
    }
    expect(codexQuotaWindowForPlan(undefined)).toBe("weekly");
    expect(codexQuotaWindowForPlan("")).toBe("weekly");
    for (const malformed of [{ tier: "go" }, 1, true]) {
      expect(codexQuotaWindowForPlan(malformed)).toBe("weekly");
    }
    // "free_workspace" is not "free": only the exact names take the monthly window.
    expect(codexQuotaWindowForPlan("free_workspace")).toBe("weekly");

    for (const plan of snapshotPlans) {
      const monthly = codexQuotaWindowForPlan(plan) === "monthly";
      // The parser classifies windows by duration, so a weekly-billed plan CAN carry a
      // monthly-only reading (30-day primary, no secondary) — but only when that reading is
      // the primary window. A bare monthlyPercent could equally be a tertiary window, which
      // is a different period and no evidence for the weekly quota that gates the account.
      expect(isCompleteCodexQuotaRecoverySnapshot({ weeklyPercent: 12 }, plan)).toBe(!monthly);
      expect(isCompleteCodexQuotaRecoverySnapshot({ monthlyPercent: 12 }, plan)).toBe(monthly);
      expect(isCompleteCodexQuotaRecoverySnapshot({ monthlyPercent: 12, monthlyIsPrimaryWindow: true }, plan)).toBe(true);
    }

    // Monthly-billed Go/Free parse to monthlyPercent only; a weekly-only reading is not
    // evidence for them.
    expect(isCompleteCodexQuotaRecoverySnapshot({ weeklyPercent: 12 }, "go")).toBe(false);
    expect(isCompleteCodexQuotaRecoverySnapshot({ weeklyPercent: 12 }, "free")).toBe(false);

    // Absent plan follows the parser's weekly default.
    expect(isCompleteCodexQuotaRecoverySnapshot({ weeklyPercent: 12 }, undefined)).toBe(true);
    // Provenance, not just presence: monthlyPercent alone is evidence for a weekly-quota plan
    // ONLY when it came from an explicitly-monthly primary window.
    expect(isCompleteCodexQuotaRecoverySnapshot({ monthlyPercent: 12 }, "team")).toBe(false);
    expect(isCompleteCodexQuotaRecoverySnapshot({ monthlyPercent: 12, monthlyIsPrimaryWindow: true }, "team")).toBe(true);
    // Go/Free are governed by the monthly window either way, so the flag is not required.
    expect(isCompleteCodexQuotaRecoverySnapshot({ monthlyPercent: 12 }, "go")).toBe(true);

    // The flag has to survive the cache, or the guard is decorative: a snapshot that keeps
    // monthlyPercent while dropping its provenance looks exactly like tertiary-only data.
    // setAccountQuotaFromParsed() rebuilds the record field by field, so this is a real
    // drop risk rather than a theoretical one.
    const parsedMonthly = parseUsageQuota({
      plan_type: "team",
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 2_628_000, reset_at: 1_900_000_000 },
      },
    } as never);
    expect(parsedMonthly?.monthlyIsPrimaryWindow).toBe(true);
    setAccountQuotaFromParsed("provenance-probe", parsedMonthly);
    expect(getAccountQuota("provenance-probe")?.monthlyIsPrimaryWindow).toBe(true);

    // updateAccountQuota() rebuilds the record too. An unrelated weekly update must not
    // downgrade a proven reading to unproven, and a caller-supplied monthly value — which
    // arrives with no window information at all — must not inherit the proof.
    updateAccountQuota("provenance-probe", 20, 111);
    expect(getAccountQuota("provenance-probe")?.monthlyIsPrimaryWindow).toBe(true);
    updateAccountQuota("provenance-probe", undefined, undefined, 44, 222);
    expect(getAccountQuota("provenance-probe")?.monthlyIsPrimaryWindow).toBeUndefined();
    // Missing EVIDENCE still fails closed — that is the guard that matters.
    expect(isCompleteCodexQuotaRecoverySnapshot({}, "plus")).toBe(false);
    expect(isCompleteCodexQuotaRecoverySnapshot(null, "plus")).toBe(false);
    // An exhausted snapshot is not a recovery no matter how complete it is.
    expect(isCompleteCodexQuotaRecoverySnapshot({ weeklyPercent: 100 }, "plus")).toBe(false);
  });

  test.each([
    ["retry-after", { retryAfter: "900" }],
    ["default", {}],
  ])("never claims %s cooldowns", async (_name, meta) => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    recordCodexUpstreamOutcome(config, "a", 429, { ...meta, now: START });
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return usageResponse(); };
    await runCodexCooldownRecoveryProbes(config, due());
    expect(calls).toBe(0);
  });

  test("non-pool OpenAI configurations never run recovery probes", async () => {
    const config = makeConfig(["a"]);
    saveCredential("a");
    cool(config, "a");
    config.providers.openai!.codexAccountMode = "direct";
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return usageResponse(); };
    await runCodexCooldownRecoveryProbes(config, due());
    expect(calls).toBe(0);
    expect(getCodexQuotaHealthSnapshot("a", "shared", due() + 1)).not.toBeNull();
  });

  test("oldest-first fairness: an already-probed account never jumps the queue", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const config = makeConfig(ids);
    for (const id of ids) {
      saveCredential(id);
      cool(config, id);
    }
    const seen: string[] = [];
    globalThis.fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers).get("Authorization")?.replace("Bearer access-", "") ?? "");
      return new Response("busy", { status: 503 });
    };
    // Six accounts, four claims per pass. Pass one takes four; the second pass is spaced PAST
    // the probe interval so those four are eligible again and genuinely compete with the two
    // that were never reached. That competition is the whole test: under stable config-order
    // claims the same four would win again and the tail would starve. Tighter spacing would
    // pass on any ordering, because a just-probed account is ineligible for five minutes and
    // drops out without the sort doing any work.
    await runCodexCooldownRecoveryProbes(config, due());
    const firstPass = [...seen];
    expect(firstPass).toHaveLength(4);

    await runCodexCooldownRecoveryProbes(config, due() + CODEX_QUOTA_PROBE_INTERVAL_MS + 1);
    const secondPass = seen.slice(4);
    const starved = ids.filter(id => !firstPass.includes(id));
    expect(starved).toHaveLength(2);
    // The two that waited must be served before any account gets a second turn.
    expect(secondPass.slice(0, 2).sort()).toEqual(starved.sort());
    expect(new Set(seen)).toEqual(new Set(ids));
  });
});
