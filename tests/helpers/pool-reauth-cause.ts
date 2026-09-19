import { expect, test } from "bun:test";
import { handleCodexAuthAPI } from "../../src/codex/auth-api";
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
    const data = await resp!.json() as { accounts: Array<{ id: string; reauthReason?: string }> };

    expect(data.accounts.find(account => account.id === "pool-quota-rejected"))
      .toMatchObject({ reauthReason: "quota_unauthorized" });
  });

  test("pool token refresh rejection reports refresh failure as the reauthentication cause", async () => {
    const config = makeConfig();
    seedPoolAccount(config, {
      id: "pool-refresh-rejected",
      email: "pool-refresh-rejected@example.com",
      expiresAt: Date.now() - 1,
    });
    const urls: string[] = [];
    globalThis.fetch = (async input => {
      urls.push(String(input));
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }) as typeof fetch;

    const req = new Request("http://localhost/api/codex-auth/accounts/refresh", { method: "POST" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    const data = await resp!.json() as { accounts: Array<{ id: string; reauthReason?: string }> };

    expect(urls).toEqual(["https://auth.openai.com/oauth/token"]);
    expect(data.accounts.find(account => account.id === "pool-refresh-rejected"))
      .toMatchObject({ reauthReason: "refresh_failed" });
  });
}
