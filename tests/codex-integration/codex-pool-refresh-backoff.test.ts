import { describe, expect, test, beforeEach } from "bun:test";
import {
  CODEX_POOL_REFRESH_FAILURE_BACKOFF_MS,
  CodexPoolRefreshCooldownError,
  clearCodexPoolRefreshFailure,
  getCodexPoolRefreshCooldownUntil,
  isCodexPoolRefreshCooling,
  noteCodexPoolRefreshFailure,
  resetCodexPoolRefreshFailureBackoffForTests,
  setCodexPoolRefreshFailureNowForTests,
} from "../../src/codex/pool-refresh-backoff";
import {
  CodexCredentialGenerationConflictError,
  CodexCredentialUnavailableError,
  TokenRefreshError,
  isTerminalCodexPoolRefreshFailure,
} from "../../src/codex/account-store";

/**
 * #4546: a pool account whose forced refresh failed answered every subsequent request with a
 * retryable 503 whose body asked the client to retry, so the loop sustained the very condition
 * it was waiting out while six healthy siblings sat idle. Reproduced live: five sequential
 * probes, five 503s, and not one line in the service log.
 */
describe("codex pool refresh failure backoff", () => {
  beforeEach(() => {
    resetCodexPoolRefreshFailureBackoffForTests();
  });

  test("consecutive failures open a bounded, growing cooldown", () => {
    const now = 1_000_000;
    setCodexPoolRefreshFailureNowForTests(now);

    const first = noteCodexPoolRefreshFailure("acct-a", "unknown");
    expect(first.openedWindow).toBe(true);
    expect(first.consecutiveFailures).toBe(1);
    expect(first.cooldownUntil).toBe(now + CODEX_POOL_REFRESH_FAILURE_BACKOFF_MS[0]!);
    expect(isCodexPoolRefreshCooling("acct-a")).toBe(true);

    // A second failure INSIDE the window does not grow it. Growth requires another real
    // attempt, otherwise a burst of concurrent requests would race the account to the ceiling.
    const during = noteCodexPoolRefreshFailure("acct-a", "unknown");
    expect(during.openedWindow).toBe(false);
    expect(during.consecutiveFailures).toBe(1);
    expect(during.cooldownUntil).toBe(first.cooldownUntil);

    setCodexPoolRefreshFailureNowForTests(first.cooldownUntil + 1);
    expect(isCodexPoolRefreshCooling("acct-a")).toBe(false);

    const second = noteCodexPoolRefreshFailure("acct-a", "unknown");
    expect(second.consecutiveFailures).toBe(2);
    expect(second.cooldownUntil - (first.cooldownUntil + 1))
      .toBe(CODEX_POOL_REFRESH_FAILURE_BACKOFF_MS[1]!);
  });

  test("the cooldown is bounded by the last configured step", () => {
    let now = 0;
    setCodexPoolRefreshFailureNowForTests(now);
    const ceiling = CODEX_POOL_REFRESH_FAILURE_BACKOFF_MS[CODEX_POOL_REFRESH_FAILURE_BACKOFF_MS.length - 1]!;
    for (let attempt = 0; attempt < CODEX_POOL_REFRESH_FAILURE_BACKOFF_MS.length + 3; attempt += 1) {
      const opened = noteCodexPoolRefreshFailure("acct-ceiling", "unknown", now);
      expect(opened.cooldownUntil - now).toBeLessThanOrEqual(ceiling);
      now = opened.cooldownUntil + 1;
      setCodexPoolRefreshFailureNowForTests(now);
    }
  });

  test("a success clears the cooldown so recovery is automatic", () => {
    const now = 5_000;
    setCodexPoolRefreshFailureNowForTests(now);
    noteCodexPoolRefreshFailure("acct-b", "generation_conflict");
    expect(isCodexPoolRefreshCooling("acct-b")).toBe(true);

    clearCodexPoolRefreshFailure("acct-b");
    expect(isCodexPoolRefreshCooling("acct-b")).toBe(false);
    expect(getCodexPoolRefreshCooldownUntil("acct-b")).toBeNull();
  });

  test("one account cooling never cools a sibling", () => {
    setCodexPoolRefreshFailureNowForTests(10_000);
    noteCodexPoolRefreshFailure("acct-broken", "unknown");
    expect(isCodexPoolRefreshCooling("acct-broken")).toBe(true);
    // The whole point of the cooldown is that selection moves to a healthy sibling.
    expect(isCodexPoolRefreshCooling("acct-healthy")).toBe(false);
  });

  test("the cooldown error is retryable and does not claim reauthentication", () => {
    const error = new CodexPoolRefreshCooldownError();
    expect(error.retryable).toBe(true);
    // A body carrying "reauthentication" is reclassified away from server_is_overloaded, which
    // would disable the retry-after backoff this refusal exists to ask for.
    expect(error.message.toLowerCase()).not.toContain("reauthentication");
    expect(isTerminalCodexPoolRefreshFailure(error)).toBe(false);
  });
});

describe("terminal has one definition", () => {
  test("a missing credential or grant fingerprint is terminal, not retryable", () => {
    // This is the case that made the live incident unrecoverable: it was thrown as a bare
    // Error, classified transient, and answered with a 503 asking the client to keep retrying
    // a request that could never succeed.
    expect(isTerminalCodexPoolRefreshFailure(new CodexCredentialUnavailableError())).toBe(true);
  });

  test("a dead grant is terminal", () => {
    expect(isTerminalCodexPoolRefreshFailure(new TokenRefreshError("revoked", "x"))).toBe(true);
    expect(isTerminalCodexPoolRefreshFailure(new TokenRefreshError("expired", "x"))).toBe(true);
  });

  test("a token-endpoint 5xx and a CAS loss stay transient", () => {
    // #2887: a token-endpoint failure must not retire a healthy account.
    expect(isTerminalCodexPoolRefreshFailure(new TokenRefreshError("unknown", "x"))).toBe(false);
    expect(isTerminalCodexPoolRefreshFailure(new CodexCredentialGenerationConflictError())).toBe(false);
  });
});

