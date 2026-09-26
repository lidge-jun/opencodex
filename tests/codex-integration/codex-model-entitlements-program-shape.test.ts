import { beforeEach, describe, expect, test } from "bun:test";
import {
  MAIN_CODEX_ACCOUNT_ID,
} from "../../src/codex/main-account";
import {
  resolveCodexModelEntitlements,
  resetCodexModelEntitlementCacheForTests,
  type CodexModelEntitlementCredentialSnapshot,
} from "../../src/codex/model-entitlements";

const TEST_CLIENT_VERSION = "0.146.0";

function credential(accountId: string): CodexModelEntitlementCredentialSnapshot {
  return {
    accountId,
    accessToken: `token-${accountId}`,
    chatgptAccountId: `chatgpt-${accountId}`,
    credentialIdentity: `test:${accountId}`,
  };
}

beforeEach(() => resetCodexModelEntitlementCacheForTests());

describe("Codex roster access program metadata", () => {
  test("keeps model slugs but drops malformed access programs without a cyber array", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential(MAIN_CODEX_ACCOUNT_ID)],
      fetcher: (async () => Response.json({ models: [
        { slug: "model-empty-programs", supported_in_api: true, visibility: "list", available_access_programs: {} },
        { slug: "model-invalid-cyber", supported_in_api: true, visibility: "list", available_access_programs: { cyber: "standard" } },
        { slug: "model-valid-programs", supported_in_api: true, visibility: "list", available_access_programs: { cyber: ["standard"] } },
      ] })) as typeof fetch,
      now: 1_000,
      clientVersion: TEST_CLIENT_VERSION,
    });

    const models = snapshot.modelsByAccount.get(MAIN_CODEX_ACCOUNT_ID);
    const programs = snapshot.accessProgramsByAccount?.get(MAIN_CODEX_ACCOUNT_ID);
    expect(models).toEqual(new Set(["model-empty-programs", "model-invalid-cyber", "model-valid-programs"]));
    expect(programs?.has("model-empty-programs")).toBe(false);
    expect(programs?.has("model-invalid-cyber")).toBe(false);
    expect(programs?.get("model-valid-programs")).toEqual({ cyber: ["standard"] });
  });
});
