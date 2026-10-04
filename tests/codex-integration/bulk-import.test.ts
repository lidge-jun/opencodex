import { describe, expect, test } from "bun:test";
import {
  extractCodexAccountsFromRaw,
  normalizeSingleCodexAccountCandidate,
  importCodexAccounts,
} from "../../src/codex/bulk-import";
import type { OcxConfig } from "../../src/types";

// Helper to create a dummy JWT with claims
function createDummyJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = Buffer.from("dummy-signature").toString("base64url");
  return `${header}.${payload}.${sig}`;
}

describe("Codex Bulk Import Parser", () => {
  test("parses 9router bulk import account format", () => {
    const raw = {
      accessToken: "ey-access-token-123",
      refreshToken: "rt-refresh-token-456",
      idToken: "id-token-789",
      email: "user@9router.com",
      chatgptAccountId: "acc-9router-1",
      chatgptPlanType: "pro",
      expiresAt: "2026-12-31T23:59:59.000Z",
    };

    const normalized = normalizeSingleCodexAccountCandidate(raw);
    expect(normalized).not.toBeNull();
    expect(normalized?.accessToken).toBe("ey-access-token-123");
    expect(normalized?.refreshToken).toBe("rt-refresh-token-456");
    expect(normalized?.email).toBe("user@9router.com");
    expect(normalized?.chatgptAccountId).toBe("acc-9router-1");
    expect(normalized?.plan).toBe("pro");
    expect(normalized?.expiresAt).toBe(Date.parse("2026-12-31T23:59:59.000Z"));
  });

  test("parses Cockpit CodexAccount export format", () => {
    const cockpitAccount = {
      id: "cockpit-user-1",
      email: "pilot@cockpit.dev",
      tokens: {
        access_token: "ey-cockpit-access",
        refresh_token: "rt-cockpit-refresh",
        id_token: "ey-cockpit-id",
      },
      auth_file_plan_type: "team",
      account_name: "Pilot Team Account",
    };

    const normalized = normalizeSingleCodexAccountCandidate(cockpitAccount);
    expect(normalized).not.toBeNull();
    expect(normalized?.id).toBe("cockpit-user-1");
    expect(normalized?.email).toBe("pilot@cockpit.dev");
    expect(normalized?.accessToken).toBe("ey-cockpit-access");
    expect(normalized?.refreshToken).toBe("rt-cockpit-refresh");
    expect(normalized?.plan).toBe("team");
    expect(normalized?.alias).toBe("Pilot Team Account");
  });

  test("parses Codex CLI auth.json format", () => {
    const authJson = {
      auth_mode: "oauth",
      tokens: {
        access_token: "ey-cli-access",
        refresh_token: "rt-cli-refresh",
        id_token: "ey-cli-id",
        account_id: "org-cli-123",
      },
    };

    const normalized = normalizeSingleCodexAccountCandidate(authJson);
    expect(normalized).not.toBeNull();
    expect(normalized?.accessToken).toBe("ey-cli-access");
    expect(normalized?.refreshToken).toBe("rt-cli-refresh");
    expect(normalized?.chatgptAccountId).toBe("org-cli-123");
  });

  test("parses Sub2API export format with platform filter", () => {
    const sub2api = {
      exported_at: "2026-10-01",
      accounts: [
        {
          platform: "openai",
          type: "oauth",
          email: "sub2@openai.com",
          credentials: {
            access_token: "ey-sub2-access",
            refresh_token: "rt-sub2-refresh",
          },
          plan_type: "plus",
        },
        {
          platform: "anthropic",
          credentials: {
            api_key: "sk-ant-test",
          },
        },
      ],
    };

    const extracted = extractCodexAccountsFromRaw(sub2api);
    expect(extracted.length).toBe(1);
    expect(extracted[0]?.email).toBe("sub2@openai.com");
    expect(extracted[0]?.accessToken).toBe("ey-sub2-access");
    expect(extracted[0]?.refreshToken).toBe("rt-sub2-refresh");
    expect(extracted[0]?.plan).toBe("plus");
  });

  test("decodes JWT claims for email, accountId, and plan if missing", () => {
    const jwt = createDummyJwt({
      email: "jwt-user@example.com",
      chatgpt_account_id: "jwt-account-999",
      chatgpt_plan_type: "plus",
      exp: 1893456000, // Year 2030
    });

    const candidate = {
      accessToken: jwt,
    };

    const normalized = normalizeSingleCodexAccountCandidate(candidate);
    expect(normalized).not.toBeNull();
    expect(normalized?.email).toBe("jwt-user@example.com");
    expect(normalized?.chatgptAccountId).toBe("jwt-account-999");
    expect(normalized?.plan).toBe("plus");
    expect(normalized?.expiresAt).toBe(1893456000 * 1000);
  });

  test("parses line-delimited raw JWTs", () => {
    const jwt1 = createDummyJwt({ email: "user1@example.com", chatgpt_account_id: "acc-1" });
    const jwt2 = createDummyJwt({ email: "user2@example.com", chatgpt_account_id: "acc-2" });
    const content = `${jwt1}\n${jwt2}\n`;

    const extracted = extractCodexAccountsFromRaw(content);
    expect(extracted.length).toBe(2);
    expect(extracted[0]?.email).toBe("user1@example.com");
    expect(extracted[1]?.email).toBe("user2@example.com");
  });

  test("importCodexAccounts saves accounts and sets openai provider to pool mode", async () => {
    const testConfig: OcxConfig = {
      providers: {},
      codexAccounts: [],
    };

    const accountsToImport = [
      {
        id: "test-acc-1",
        email: "import1@test.com",
        plan: "plus",
        accessToken: "ey-test-token-1",
        refreshToken: "rt-test-token-1",
        chatgptAccountId: "chatgpt-acc-1",
      },
    ];

    const result = await importCodexAccounts(accountsToImport, { config: testConfig, overwrite: true });
    expect(result.success).toBe(true);
    expect(result.imported.length).toBe(1);
    expect(result.imported[0]).toBe("test-acc-1");

    expect(testConfig.codexAccounts?.length).toBe(1);
    expect(testConfig.codexAccounts?.[0]?.email).toBe("import1@test.com");
    expect(testConfig.providers.openai?.codexAccountMode).toBe("pool");
    expect(testConfig.providers.openai?.adapter).toBe("openai-responses");
  });
});
