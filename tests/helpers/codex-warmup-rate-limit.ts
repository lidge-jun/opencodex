import { expect, test } from "bun:test";
import type { OcxConfig } from "../../src/types";
import { getCodexAccountCredential, readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";

interface WarmupOAuthOptions {
  config: OcxConfig;
  requestBody: { id: string; reauth?: boolean };
  oauthAccountId: string;
  email: string;
  onWarmup: () => void;
  warmupResponse?: () => Response;
}

/** Registers under the calling suite's isolated home and OAuth cleanup hooks. */
export function registerWarmupRateLimitCases(
  makeConfig: (overrides?: Partial<OcxConfig>) => OcxConfig,
  completeMockCodexOAuth: (options: WarmupOAuthOptions) => Promise<{
    startStatus: number;
    state: { status: string; error?: string; code?: string };
  }>,
): void {
  test("OAuth creation reports a rate-limited warmup without persisting the account", async () => {
    const accountId = "warmup-rate-limited";
    const config = makeConfig();
    let warmupRequests = 0;

    const result = await completeMockCodexOAuth({
      config,
      requestBody: { id: accountId },
      oauthAccountId: "acct-warmup-rate-limited",
      email: "warmup-rate-limited@example.test",
      onWarmup: () => { warmupRequests += 1; },
      warmupResponse: () => new Response("private upstream quota details", { status: 429 }),
    });

    expect(result.startStatus).toBe(200);
    expect(result.state).toMatchObject({
      status: "error",
      code: "codex_warmup_rate_limited",
    });
    expect(result.state.error).toContain("usage limit");
    expect(result.state.error).toContain("Retry");
    expect(JSON.stringify(result.state)).not.toContain("private upstream quota details");
    expect(warmupRequests).toBe(1);
    expect(config.codexAccounts).toEqual([]);
    expect(getCodexAccountCredential(accountId)).toBeNull();
    expect(readCodexAccountRecord(accountId)).toBeNull();
  });

  test.each([401, 403])("OAuth creation keeps HTTP %s warmup failures on the authentication path", async status => {
    const accountId = `warmup-auth-${status}`;
    const config = makeConfig();

    const result = await completeMockCodexOAuth({
      config,
      requestBody: { id: accountId },
      oauthAccountId: `acct-warmup-auth-${status}`,
      email: `warmup-auth-${status}@example.test`,
      onWarmup: () => {},
      warmupResponse: () => new Response("private upstream auth details", { status }),
    });

    expect(result.state).toMatchObject({
      status: "error",
      code: "codex_warmup_failed",
    });
    expect(result.state.error).toContain("Reauthenticate");
    expect(JSON.stringify(result.state)).not.toContain("private upstream auth details");
    expect(config.codexAccounts).toEqual([]);
    expect(getCodexAccountCredential(accountId)).toBeNull();
  });

  test("OAuth reauth keeps the existing credential when warmup is rate limited", async () => {
    const accountId = "warmup-rate-limited-reauth";
    const config = makeConfig({
      codexAccounts: [{ id: accountId, email: "existing@example.test", isMain: false }],
    });
    const existingCredential = {
      accessToken: "existing-access",
      refreshToken: "existing-refresh",
      expiresAt: Date.now() + 60_000,
      chatgptAccountId: "acct-warmup-rate-limited-reauth",
    };
    saveCodexAccountCredential(accountId, existingCredential);

    const result = await completeMockCodexOAuth({
      config,
      requestBody: { id: accountId, reauth: true },
      oauthAccountId: existingCredential.chatgptAccountId,
      email: "existing@example.test",
      onWarmup: () => {},
      warmupResponse: () => new Response("private upstream quota details", { status: 429 }),
    });

    expect(result.state).toMatchObject({
      status: "error",
      code: "codex_warmup_rate_limited",
    });
    expect(getCodexAccountCredential(accountId)).toEqual(existingCredential);
    expect(config.codexAccounts).toEqual([
      { id: accountId, email: "existing@example.test", isMain: false },
    ]);
  });

  test("OAuth creation rejects a namespace claimed during warmup without persisting", async () => {
    const config = makeConfig();
    const result = await completeMockCodexOAuth({
      config,
      requestBody: { id: "oauth-race" },
      oauthAccountId: "acct-oauth-race",
      email: "oauth-race@example.test",
      onWarmup: () => {
        config.codexAccountNamespaces = { "oauth-race": "pool-a" };
      },
    });

    expect(result.startStatus).toBe(200);
    expect(result.state).toMatchObject({
      status: "error",
      error: "account id must not collide with a configured Codex account namespace",
    });
    expect(config.codexAccounts).toEqual([]);
    expect(config.codexAccountNamespaces).toEqual({ "oauth-race": "pool-a" });
    expect(getCodexAccountCredential("oauth-race")).toBeNull();
  });
}
