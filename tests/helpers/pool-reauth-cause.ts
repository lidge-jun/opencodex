import { expect, test } from "bun:test";
import {
  clearAccountNeedsReauth,
  handleCodexAuthAPI,
  setAccountQuotaFromParsed,
} from "../../src/codex/auth-api";
import { readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import type { OcxConfig } from "../../src/types";

/**
 * #4212 follow-up: `poolAccountDto` used to infer the reauthentication cause from overlapping
 * booleans, so a WHAM 401 and a dead refresh grant both reported `refresh_failed`. These cases
 * pin the observed cause through `handleCodexAuthAPI`, one per failure source.
 *
 * They live here rather than in `codex-auth-api.test.ts` because that file sits against its
 * `file-size-baseline.json` cap, which only ever moves downward.
 */
export function registerPoolReauthCauseCases(
  makeConfig: () => OcxConfig,
  seedPoolAccount: (
    config: OcxConfig,
    account: { id: string; email: string; expiresAt?: number },
  ) => void,
): void {
  test("pool quota rejection reports quota authorization as the reauthentication cause", async () => {
    const config = makeConfig();
    seedPoolAccount(config, { id: "pool-quota-rejected", email: "pool-quota-rejected@example.com" });
    globalThis.fetch = (async () => Response.json(
      { detail: { code: "invalid_refresh_token" } },
      { status: 401 },
    )) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts?refresh=1");
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as {
      accounts: Array<{ id: string; reauthReason?: string; health?: { status: string; reason?: string } }>;
    };

    expect(data.accounts.find(account => account.id === "pool-quota-rejected"))
      .toMatchObject({
        reauthReason: "quota_unauthorized",
        health: { status: "reauth_required", reason: "unauthorized" },
      });
  });

  test("pool token refresh rejection reports refresh failure as the reauthentication cause", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "pool-refresh-rejected",
      email: "pool-refresh-rejected@example.com",
      expiresAt: Date.now() - 1,
    });
    setAccountQuotaFromParsed("pool-refresh-rejected", { weeklyPercent: 12 }, captureConfigGeneration());
    const urls: string[] = [];
    globalThis.fetch = (async input => {
      urls.push(String(input));
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts/refresh", { method: "POST" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as {
      accounts: Array<{ id: string; needsReauth?: boolean; reauthReason?: string }>;
    };

    expect(urls).toEqual(["https://auth.openai.com/oauth/token"]);
    expect(data.accounts.find(account => account.id === "pool-refresh-rejected"))
      .toMatchObject({ reauthReason: "refresh_failed" });

    // A dead grant stays dead: the cached-quota listing performs no refresh at all, so only
    // the recorded marks keep the cause visible instead of flipping back to healthy.
    const cachedReq = new Request("http://localhost/api/codex-auth/accounts");
    const cachedResp = await handleCodexAuthAPI(cachedReq, new URL(cachedReq.url), config);
    const cachedData = await cachedResp!.json() as {
      accounts: Array<{ id: string; needsReauth?: boolean; reauthReason?: string }>;
    };
    expect(urls).toEqual(["https://auth.openai.com/oauth/token"]);
    expect(cachedData.accounts.find(account => account.id === "pool-refresh-rejected"))
      .toMatchObject({ needsReauth: true, reauthReason: "refresh_failed" });

    // The terminal verdict is also persisted like the token guardian's, so losing the
    // in-memory mark on restart cannot flip the dead grant back to healthy.
    expect(readCodexAccountRecord("pool-refresh-rejected")).toMatchObject({
      lastCodexValidationStatus: "failed",
      lastCodexValidationError: "refresh_revoked",
      lastCodexValidationTerminal: true,
    });
    clearAccountNeedsReauth("pool-refresh-rejected");
    const restartedReq = new Request("http://localhost/api/codex-auth/accounts");
    const restartedResp = await handleCodexAuthAPI(restartedReq, new URL(restartedReq.url), config);
    const restartedData = await restartedResp!.json() as {
      accounts: Array<{
        id: string;
        needsReauth?: boolean;
        reauthReason?: string;
        health?: { status: string; reason?: string };
      }>;
    };
    expect(urls).toEqual(["https://auth.openai.com/oauth/token"]);
    expect(restartedData.accounts.find(account => account.id === "pool-refresh-rejected"))
      .toMatchObject({
        needsReauth: true,
        reauthReason: "refresh_failed",
        health: { status: "reauth_required", reason: "refresh_failed" },
      });
  });

  test("passive listings stop refreshing a pool grant the token endpoint already declared dead", async () => {
    const config = makeConfig();
    // The credits switch forces a cache bypass for an account that never reported credits, and a
    // dead grant never does, so this is the configuration where every poll used to refresh again.
    config.showCodexCredits = true;
    seedPoolAccount(config, {
      id: "pool-dead-grant",
      email: "pool-dead-grant@example.com",
      expiresAt: Date.now() - 1,
    });
    const urls: string[] = [];
    globalThis.fetch = (async input => {
      urls.push(String(input));
      return Response.json({ error: { code: "refresh_token_reused" } }, { status: 401 });
    }) as typeof fetch;

    const list = async (path: string) => {
      const req = new Request(`http://localhost${path}`);
      const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
      const data = await resp!.json() as {
        accounts: Array<{ id: string; needsReauth?: boolean; reauthReason?: string }>;
      };
      return data.accounts.find(account => account.id === "pool-dead-grant");
    };

    expect(await list("/api/codex-auth/accounts")).toMatchObject({ needsReauth: true, reauthReason: "refresh_failed" });
    expect(urls).toEqual(["https://auth.openai.com/oauth/token"]);
    expect(readCodexAccountRecord("pool-dead-grant")).toMatchObject({ lastCodexValidationTerminal: true });

    // Later polls, a forced listing, and a restart that lost the in-memory mark all report the
    // stored verdict without another token request.
    expect(await list("/api/codex-auth/accounts")).toMatchObject({ needsReauth: true, reauthReason: "refresh_failed" });
    expect(await list("/api/codex-auth/accounts?refresh=1")).toMatchObject({ needsReauth: true, reauthReason: "refresh_failed" });
    clearAccountNeedsReauth("pool-dead-grant");
    expect(await list("/api/codex-auth/accounts")).toMatchObject({ needsReauth: true, reauthReason: "refresh_failed" });
    expect(urls).toEqual(["https://auth.openai.com/oauth/token"]);
  });

  test("a dead pool grant is probed again after an explicit refresh command or a new credential", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "pool-dead-grant-recovery",
      email: "pool-dead-grant-recovery@example.com",
      expiresAt: Date.now() - 1,
    });
    const urls: string[] = [];
    globalThis.fetch = (async input => {
      urls.push(String(input));
      return Response.json({ error: { code: "refresh_token_reused" } }, { status: 401 });
    }) as typeof fetch;
    const listReq = new Request("http://localhost/api/codex-auth/accounts?refresh=1");
    await handleCodexAuthAPI(listReq, new URL(listReq.url), config);
    expect(urls).toHaveLength(1);

    // An explicit refresh command retries the grant once per command, whichever principal sends it:
    // `ocx account refresh` arrives as a raw-admin POST, the dashboard button as a GUI session.
    const adminRefreshReq = new Request("http://localhost/api/codex-auth/accounts/refresh", { method: "POST" });
    await handleCodexAuthAPI(adminRefreshReq, new URL(adminRefreshReq.url), config);
    expect(urls).toHaveLength(2);
    const refreshReq = new Request("http://localhost/api/codex-auth/accounts/refresh", { method: "POST" });
    await handleCodexAuthAPI(refreshReq, new URL(refreshReq.url), config, undefined, "gui-session");
    expect(urls).toHaveLength(3);
    // Passive listings stay held between those commands.
    const passiveReq = new Request("http://localhost/api/codex-auth/accounts?refresh=1");
    await handleCodexAuthAPI(passiveReq, new URL(passiveReq.url), config);
    expect(urls).toHaveLength(3);

    // A re-login writes a new credential generation, which drops the terminal verdict.
    saveCodexAccountCredential("pool-dead-grant-recovery", {
      accessToken: "access-pool-dead-grant-recovery-2",
      refreshToken: "refresh-pool-dead-grant-recovery-2",
      expiresAt: Date.now() - 1,
      chatgptAccountId: "acct-pool-dead-grant-recovery",
    });
    expect(readCodexAccountRecord("pool-dead-grant-recovery")?.lastCodexValidationTerminal).toBeUndefined();
    const relistReq = new Request("http://localhost/api/codex-auth/accounts?refresh=1");
    await handleCodexAuthAPI(relistReq, new URL(relistReq.url), config);
    expect(urls).toHaveLength(4);
  });

  test("a transient pool token refresh failure does not raise reauthentication", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "pool-refresh-transient",
      email: "pool-refresh-transient@example.com",
      expiresAt: Date.now() - 1,
    });
    // A token-endpoint 5xx classifies as `unknown`, which the account store treats as
    // transient: the credential may still be fine, so no reauth cause may surface (#2887).
    globalThis.fetch = (async () => Response.json({ error: "server_error" }, { status: 500 })) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts/refresh", { method: "POST" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as {
      accounts: Array<{
        id: string;
        needsReauth?: boolean;
        reauthReason?: string;
        health?: { status: string; reason?: string };
      }>;
    };

    const account = data.accounts.find(row => row.id === "pool-refresh-transient");
    expect(account?.needsReauth).toBe(false);
    expect(account?.reauthReason).toBeUndefined();
    expect(account?.health?.status).not.toBe("reauth_required");
  });
}
