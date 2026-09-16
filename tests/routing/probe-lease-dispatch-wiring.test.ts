import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canAcquireTransientProbe,
  classifyPoolRecoveryDispatch,
  clearPoolRecoveryState,
  createPoolBackpressureLimiter,
  transientProbeDiagnostics,
  tryAcquireTransientProbe,
  TRANSIENT_PROBE_INTERVAL_MS,
  TRANSIENT_PROBE_LEASE_MS,
} from "../../src/routing/probe-lease";
import {
  CodexRecoveryWithheldError,
  cooldownErrorMessage,
  cooldownErrorResponse,
  releaseCodexAuthContextProbeLease,
} from "../../src/codex/auth-context";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  recordCodexUpstreamOutcome,
  resolveCodexAccountForThread,
  resolveCodexAccountForThreadDetailed,
} from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

/**
 * The pool-wide recovery limiter, wired to the dispatch that actually sends (#4701).
 *
 * The primitives in `src/routing/probe-lease.ts` were complete and unit-tested before this, and
 * bounded nothing: no file under `src/` imported the module, so every hit for
 * `resolveHeldAccountDispatch` was its own definition or a direct unit test. An implementation
 * nothing calls is indistinguishable from an absent one at runtime, which is the whole of the
 * issue -- and it is why the first case here is a source oracle rather than a behaviour.
 *
 * The defect that reached production lived at the end of both transient-hold branches of
 * `resolveCodexAccountForThreadDetailed`: when no sibling could take the request they returned
 * the HELD account as `selected`, and the caller sent it at an account already known to be
 * failing. Under a provider-wide 503 that is every bound request at once -- the amplification
 * the hold exists to prevent rather than cause.
 */

const TEST_DIR = join(import.meta.dir, ".tmp-probe-lease-dispatch-wiring");
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function makeThreeAccountConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  const ids = ["a", "b", "c"];
  for (const id of ids) {
    saveCodexAccountCredential(id, {
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: `acct-${id}`,
    });
  }
  return {
    providers: {},
    activeCodexAccountId: "a",
    autoSwitchThreshold: 80,
    accountPoolStrategy: "quota",
    upstreamFailoverThreshold: 3,
    codexAccounts: ids.map(id => ({ id, email: `${id}@example.test`, isMain: false })),
    ...overrides,
  } as OcxConfig;
}

/** Drive one account to the failover threshold this config declares. */
function streakTransientFailures(config: OcxConfig, accountId: string, now: number): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    recordCodexUpstreamOutcome(config, accountId, 503, { now });
  }
}

describe("recovery limiter wiring is reachable from production (#4701)", () => {
  test("the transient-hold module is imported by the selector and the dispatch boundary", () => {
    // Not a style assertion. Before this change the module had complete unit coverage and zero
    // production callers, so the suite was green while nothing in a running proxy was bounded.
    // If a refactor ever detaches it again, that is the symptom to catch -- the behaviour tests
    // below would keep passing against primitives nobody calls.
    const holdDispatch = readFileSync(
      repoPath("src", "codex", "routing", "transient-hold-dispatch.ts"), "utf8",
    );
    expect(holdDispatch).toContain('from "../../routing/probe-lease"');
    expect(holdDispatch).toContain("resolveHeldAccountDispatch");

    // The selector reaches the bound through that seam, on the production path.
    const routing = readFileSync(repoPath("src", "codex", "routing.ts"), "utf8");
    expect(routing).toContain('from "./routing/transient-hold-dispatch"');
    expect(routing).toContain("resolveTransientHoldDispatch");

    // The physical-send boundary itself owns no routing policy -- `responses-fetch-helpers-
    // boundary.test.ts` pins its runtime imports to three transport modules -- so the dispatch
    // call sites name their own class instead.
    const passthrough = readFileSync(repoPath("src", "server", "responses", "passthrough-dispatch.ts"), "utf8");
    expect(passthrough).toContain('from "../../routing/probe-lease"');
    expect(passthrough).toContain('classifyPoolRecoveryDispatch("initial")');

    // Two modules are named probe-lease, one directory apart, and they are different domains.
    // The selector keeps importing the QUOTA one; merging them would make one settle the
    // other's probe.
    expect(routing).toContain('from "./routing/probe-lease"');
  });
});

/**
 * Module-scoped, not per-describe. Several cases below read the credential store -- the
 * settle's generation fence does, through `isCodexAccountGenerationLive` -- and a test that
 * reads the operator's real `~/.opencodex` is both non-deterministic and wrong.
 */
beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  process.env.CODEX_HOME = TEST_DIR;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  clearPoolRotationState();
  clearPoolRecoveryState();
});

afterEach(() => {
  clearAccountQuota();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  clearPoolRecoveryState();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

describe("a held binding with nowhere to detour is bounded, not sent", () => {
  test("exactly one request probes the held account; the next is withheld with a future retry time", () => {
    const config = makeThreeAccountConfig();
    const threadId = "held-dispatch-thread";
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    const start = Date.now();
    expect(resolveCodexAccountForThread(threadId, config, start)).toBe("a");

    // A provider-wide 503 hits every account, so every sibling is soft-avoided and there is
    // nowhere to detour. This is the exact state in which the old code returned the failing
    // account to every caller.
    for (const id of ["a", "b", "c"]) streakTransientFailures(config, id, start);

    const probe = resolveCodexAccountForThreadDetailed(threadId, config, start);
    expect(probe.status).toBe("selected");
    if (probe.status !== "selected") throw new Error("unreachable");
    // Somebody has to find out whether the account is back, and the lease guarantees it is
    // exactly one somebody.
    expect(probe.accountId).toBe("a");
    expect(probe.transientProbe?.lease.accountId).toBe("a");

    // The second request in the same instant is NOT a second send at the failing account.
    const withheld = resolveCodexAccountForThreadDetailed(threadId, config, start);
    expect(withheld.status).toBe("withheld");
    if (withheld.status !== "withheld") throw new Error("unreachable");
    expect(withheld.accountId).toBe("a");
    // Strictly in the future: a refusal that answered `now` would busy-loop the caller into the
    // same load it just declined, which is the defect L1 fixed in the resolver itself.
    expect(withheld.retryAt).toBeGreaterThan(start);
    // The binding is REMEMBERED, not released. "Cannot send right now" and "forget which
    // account owns this conversation" are different answers.
    expect(withheld.affinity).toMatchObject({ move: "held", reason: "transient" });

    // The simple wrapper has nowhere to carry a retry time, so it fails closed rather than
    // handing back the held account.
    expect(resolveCodexAccountForThread(threadId, config, start)).toBeNull();

    // Once the outage clears the thread is still on its own warm account: a refusal costs the
    // conversation nothing, which is the whole point of holding the binding.
    expect(resolveCodexAccountForThread(threadId, config, start + 6 * 60_000)).toBe("a");
  });

  test("a usable sibling still wins over the trial", () => {
    const config = makeThreeAccountConfig();
    const threadId = "detour-preferred-thread";
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    const start = Date.now();
    expect(resolveCodexAccountForThread(threadId, config, start)).toBe("a");

    // Only the bound account is failing, so a healthy sibling exists.
    streakTransientFailures(config, "a", start);

    const detoured = resolveCodexAccountForThreadDetailed(threadId, config, start);
    expect(detoured.status).toBe("selected");
    if (detoured.status !== "selected") throw new Error("unreachable");
    expect(detoured.accountId).not.toBe("a");
    expect(detoured.affinity).toMatchObject({ move: "detour", reason: "transient" });
    // A live request is never spent on the trial while something healthy can serve it, so no
    // lease is taken and the recovery budget is untouched.
    expect(detoured.transientProbe).toBeUndefined();
    expect(transientProbeDiagnostics("a", start).lastProbeAt).toBeUndefined();
  });

  test("a quota refusal never becomes a transient trial, so no request pays two permits", () => {
    const config = makeThreeAccountConfig();
    const threadId = "quota-domain-thread";
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    const start = Date.now();
    expect(resolveCodexAccountForThread(threadId, config, start)).toBe("a");

    // Transient evidence on every account would normally reach the held branch...
    for (const id of ["a", "b", "c"]) streakTransientFailures(config, id, start);
    // ...but a quota refusal outranks it. `isTransientOnlyAffinityBlock` refuses to recognise a
    // transient hold on an account carrying quota health, which is why the quota-cooldown probe
    // and this one can never both describe an account, and why nothing is charged twice.
    recordCodexUpstreamOutcome(config, "a", 429, { now: start });

    const resolved = resolveCodexAccountForThreadDetailed(threadId, config, start);
    expect(resolved.status).not.toBe("withheld");
    expect(transientProbeDiagnostics("a", start).held).toBe(false);
    expect(transientProbeDiagnostics("a", start).lastProbeAt).toBeUndefined();
  });
});

describe("the trial is handed back on every path that does not send", () => {
  test("releasing an auth context frees the account for the next trial", () => {
    const now = 4_000_000;
    const lease = tryAcquireTransientProbe("release-acct", now)!;
    expect(lease.accountId).toBe("release-acct");
    // Held: nobody else may probe while the trial is out.
    expect(canAcquireTransientProbe("release-acct", now + TRANSIENT_PROBE_INTERVAL_MS)).toBe(false);

    // This is the single function the ~30 existing "resolved a context, never sent" sites
    // already call. Teaching it the second lease is what makes all of them correct at once.
    releaseCodexAuthContextProbeLease({
      kind: "pool",
      accountId: "release-acct",
      writerGeneration: 0,
      generation: 1,
      accessToken: "token",
      chatgptAccountId: "chatgpt-acct",
      transientProbe: { lease, affinityGeneration: 1 },
    });

    // Paced by the interval now, not stranded behind the lease deadline.
    expect(canAcquireTransientProbe("release-acct", now + TRANSIENT_PROBE_INTERVAL_MS)).toBe(true);
  });

  test("an unreleased trial still cannot block recovery for longer than its deadline", () => {
    const now = 5_000_000;
    const lease = tryAcquireTransientProbe("leaked-acct", now)!;
    expect(lease.accountId).toBe("leaked-acct");

    // Nothing settles it and nothing releases it -- the request simply vanished. This is the
    // worst case, and it is bounded by construction: a leaked lease delays the next trial, it
    // can never cancel it. Permanent blockage would be strictly worse than the unlimited
    // behaviour this change replaces, so the deadline is the floor under every release path.
    expect(canAcquireTransientProbe("leaked-acct", now + TRANSIENT_PROBE_LEASE_MS - 1)).toBe(false);
    expect(canAcquireTransientProbe("leaked-acct", now + TRANSIENT_PROBE_LEASE_MS)).toBe(true);
  });

  test("a settle for a credential the binding no longer has is burned, not applied", () => {
    const now = 6_000_000;
    // No stored credential exists for this id, so ANY captured generation is already dead --
    // the same shape as a credential replaced while its probe was in flight.
    const lease = tryAcquireTransientProbe("rotated-acct", now)!;
    const grantedGeneration = transientProbeDiagnostics("rotated-acct", now).generation;

    recordCodexUpstreamOutcome(makeThreeAccountConfig(), "rotated-acct", 200, {
      transientProbe: { lease, affinityGeneration: 7 },
      now,
    });

    const after = transientProbeDiagnostics("rotated-acct", now);
    // Not recorded as a recovery: the probe answered about an identity this binding lost.
    expect(after.lastOutcome).toBeUndefined();
    // The epoch moved instead, which makes every outstanding lease on this account stale at
    // once rather than waiting for each deadline.
    expect(after.generation).toBeGreaterThan(grantedGeneration);
    expect(after.held).toBe(false);
  });
});

describe("a withheld dispatch reaches the client as a bounded refusal", () => {
  test("it answers 429 with Retry-After and never borrows the quota-cooldown wording", () => {
    const now = 7_000_000;
    const error = new CodexRecoveryWithheldError("acct-held", now + 30_000, "acct-detour");
    expect(error.detourAccountId).toBe("acct-detour");

    const response = cooldownErrorResponse(error, now);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");

    // Subclassing the cooldown error buys the transport mapping above. It must not also buy the
    // quota advice: there is no cooldown to lift and no account to switch to, so following it
    // would waste the operator's time on a fix for a different problem.
    expect(cooldownErrorMessage(error)).toBe(error.message);
    expect(error.message).not.toContain("cooling down");
    expect(error.message).not.toContain("clear-cooldown");
    expect(error.message).toContain("nothing was sent");
  });
});

describe("the pool-wide window classifies one physical send", () => {
  test("demand is counted, a retry is gated, and a probe is never charged twice", () => {
    const now = 8_000_000;
    const limiter = createPoolBackpressureLimiter({
      windowMs: 10_000,
      maxRetryRatio: 0.2,
      minRecoveryAllowance: 1,
    });

    // The denominator. Refusing a new request's first send would make this a throughput cap
    // rather than a recovery bound.
    expect(classifyPoolRecoveryDispatch("initial", now, limiter).admitted).toBe(true);
    expect(limiter.state(now).initialSends).toBe(1);
    expect(limiter.state(now).recoveryDispatches).toBe(0);

    // A probe already paid at selection, inside `resolveHeldAccountDispatch`. Charging it again
    // here would bill one send twice and shrink the budget it was admitted from.
    expect(classifyPoolRecoveryDispatch("probe", now, limiter).admitted).toBe(true);
    expect(limiter.state(now).recoveryDispatches).toBe(0);

    // One recovery dispatch fits the allowance; the next does not.
    expect(classifyPoolRecoveryDispatch("retry", now, limiter).admitted).toBe(true);
    expect(limiter.state(now).recoveryDispatches).toBe(1);

    const refused = classifyPoolRecoveryDispatch("retry", now, limiter);
    expect(refused.admitted).toBe(false);
    // A refusal has to hand back a time, or the caller busy-loops against a pool that is
    // already failing -- which is the load this window exists to remove.
    expect(refused.retryAt).toBeGreaterThan(now);
    expect(limiter.state(now).refusedTotal).toBe(1);
  });

  test("two independent requests draw on one window, not one allowance each", () => {
    const now = 9_000_000;
    const limiter = createPoolBackpressureLimiter({
      windowMs: 10_000,
      maxRetryRatio: 0.2,
      minRecoveryAllowance: 1,
    });
    // Per-request budgets cannot see a storm: each request staying inside its own allowance
    // still composes into an unbounded rate against one failing upstream. Distinct requests
    // share this window by construction.
    expect(classifyPoolRecoveryDispatch("retry", now, limiter).admitted).toBe(true);
    expect(classifyPoolRecoveryDispatch("retry", now, limiter).admitted).toBe(false);
  });
});
