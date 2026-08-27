import { beforeEach, describe, expect, test } from "bun:test";
import { clearAccountNeedsReauth } from "../src/codex/account-runtime-state";
import {
  observeSuccessfulCodexManagedMainRequest,
  observeSuccessfulCodexManagedMainUsage,
} from "../src/codex/main-account-observation";
import {
  clearMainAccountInfoCache,
  getMainAccountInfoCache,
} from "../src/codex/main-account-cache";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { clearAccountQuota, getAccountQuota } from "../src/codex/quota";

function chatgptPlanJwt(plan: string, accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: plan,
    },
  })).toString("base64url");
  return `${header}.${body}.sig`;
}

function managedHeaders(accountId: string, plan = "pro"): Headers {
  return new Headers({
    authorization: `Bearer ${chatgptPlanJwt(plan, accountId)}`,
    "chatgpt-account-id": accountId,
  });
}

beforeEach(() => {
  clearMainAccountInfoCache();
  clearAccountQuota(MAIN_CODEX_ACCOUNT_ID);
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
});

describe("Codex-managed main usage observation", () => {
  test("retains parsed plan/quota fields without retaining the request bearer", async () => {
    let authorization = "";
    let chatgptAccountId = "";
    const observed = await observeSuccessfulCodexManagedMainUsage(
      managedHeaders("managed-pro"),
      {
        now: 1_000,
        fetcher: (async (_input, init) => {
          const headers = new Headers(init?.headers);
          authorization = headers.get("authorization") ?? "";
          chatgptAccountId = headers.get("chatgpt-account-id") ?? "";
          return Response.json({
            plan_type: "pro",
            rate_limit: {
              primary_window: {
                used_percent: 5,
                reset_at: 1_783_000_000,
                limit_window_seconds: 604_800,
              },
            },
            rate_limit_reset_credits: { available_count: 2 },
          });
        }) as typeof fetch,
      },
    );

    expect(observed).toBe(true);
    expect(authorization).toStartWith("Bearer ");
    expect(chatgptAccountId).toBe("managed-pro");
    expect(getMainAccountInfoCache()).toMatchObject({ plan: "pro" });
    expect(getMainAccountInfoCache()).not.toHaveProperty("accessToken");
    expect(getAccountQuota(MAIN_CODEX_ACCOUNT_ID)).toMatchObject({
      weeklyPercent: 5,
      weeklyResetAt: 1_783_000_000,
      resetCredits: 2,
    });
  });

  test("coalesces the managed WHAM observation behind its five-minute success cache", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return Response.json({ rate_limit_reset_credits: { available_count: 0 } });
    }) as typeof fetch;
    const headers = managedHeaders("managed-cache");

    expect(await observeSuccessfulCodexManagedMainUsage(headers, { fetcher, now: 2_000 })).toBe(true);
    expect(await observeSuccessfulCodexManagedMainUsage(headers, { fetcher, now: 2_001 })).toBe(false);
    expect(calls).toBe(1);
    expect(getAccountQuota(MAIN_CODEX_ACCOUNT_ID)?.resetCredits).toBe(0);
  });

  test("drops a late usage response after Codex switches its keyring account", async () => {
    let release!: (response: Response) => void;
    const pendingResponse = new Promise<Response>(resolve => { release = resolve; });
    const oldProbe = observeSuccessfulCodexManagedMainUsage(managedHeaders("managed-old"), {
      now: 3_000,
      fetcher: (async () => pendingResponse) as typeof fetch,
    });

    expect(observeSuccessfulCodexManagedMainRequest(managedHeaders("managed-new", "plus"))).toBe(true);
    release(Response.json({
      plan_type: "pro",
      rate_limit_reset_credits: { available_count: 9 },
    }));

    expect(await oldProbe).toBe(false);
    expect(getMainAccountInfoCache()).toMatchObject({ plan: "plus" });
    expect(getAccountQuota(MAIN_CODEX_ACCOUNT_ID)).toBeNull();
  });
});
