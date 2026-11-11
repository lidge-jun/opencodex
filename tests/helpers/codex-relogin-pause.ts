import { expect, test } from "bun:test";
import type { OcxConfig } from "../../src/types";
import { saveCodexAccountCredential } from "../../src/codex/account-store";

interface ReloginOAuthOptions {
  config: OcxConfig;
  requestBody: { id: string; reauth?: boolean };
  oauthAccountId: string;
  email: string;
  onWarmup: () => void;
}

/**
 * #8398: a successful Codex reauthentication clears an automatic pause (one that recorded
 * details) and keeps an operator pause. Registered by codex-auth-api.test.ts through the warmup
 * helper so that file stays at its size cap.
 */
export function registerReloginPauseCases(
  makeConfig: (overrides?: Partial<OcxConfig>) => OcxConfig,
  completeMockCodexOAuth: (options: ReloginOAuthOptions) => Promise<{ startStatus: number; state: { status: string } }>,
): void {
  test.each([
    ["an automatic pause is cleared", { reason: "subscription_expired", pausedAt: 1 } as const, false],
    ["an operator pause stays", undefined, true],
  ] as const)("OAuth reauth: %s (#8398)", async (_label, details, stillPaused) => {
    const accountId = stillPaused ? "relogin-operator-paused" : "relogin-auto-paused";
    const chatgptAccountId = `acct-${accountId}`;
    const config = makeConfig({
      codexAccounts: [{ id: accountId, email: `${accountId}@example.test`, isMain: false }],
      pausedCodexAccountIds: [accountId],
      codexAccountPauseState: { [accountId]: { revision: "before-login", ...(details ? { details } : {}) } },
    });
    saveCodexAccountCredential(accountId, {
      accessToken: "old-access", refreshToken: "old-refresh", expiresAt: Date.now() + 60_000, chatgptAccountId,
    });

    const result = await completeMockCodexOAuth({
      config, requestBody: { id: accountId, reauth: true }, oauthAccountId: chatgptAccountId,
      email: `${accountId}@example.test`, onWarmup: () => {},
    });

    expect(result.state.status).toBe("done");
    expect((config.pausedCodexAccountIds ?? []).includes(accountId)).toBe(stillPaused);
    if (stillPaused) expect(config.codexAccountPauseState?.[accountId]).toEqual({ revision: "before-login" });
    else expect(config.codexAccountPauseState?.[accountId]).toMatchObject({ revision: expect.any(String) });
    if (!stillPaused) expect(config.codexAccountPauseState?.[accountId]?.details).toBeUndefined();
  });
}
