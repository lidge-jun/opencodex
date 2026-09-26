import { beforeEach, describe, expect, test } from "bun:test";
import {
  MAIN_CODEX_ACCOUNT_ID,
} from "../../src/codex/main-account";
import {
  resolveCodexModelEntitlements,
  resetCodexModelEntitlementCacheForTests,
  type CodexModelEntitlementCredentialSnapshot,
} from "../../src/codex/model-entitlements";
import { applyNativeAccessPrograms } from "../../src/codex/catalog/access-programs";
import { deriveEntry } from "../../src/codex/catalog/sync";
import type { RawEntry } from "../../src/codex/catalog/parsing";

const TEST_CLIENT_VERSION = "0.146.0";
const SOL = "gpt-5.6-sol";

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
  test("a routed row never inherits native access programs from its template", () => {
    const template: RawEntry = {
      slug: SOL,
      available_access_programs: { cyber: ["standard", "daybreak_blue"] },
    };
    const routed = deriveEntry(template, "other/model", "Other provider", 5, {
      provider: "other", id: "model",
    });
    expect(routed).not.toHaveProperty("available_access_programs");
    expect(template.available_access_programs).toEqual({ cyber: ["standard", "daybreak_blue"] });
    const codexForward = deriveEntry(template, "openai/gpt-6-sol", "Codex forward", 5, {
      provider: "openai", id: "gpt-6-sol", codexForwardNativeCapabilityAlias: true,
    });
    expect(codexForward).toHaveProperty("available_access_programs", { cyber: ["standard"] });
  });
  test("keeps access programs from each authenticated roster separate", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential(MAIN_CODEX_ACCOUNT_ID), credential("secondary")],
      fetcher: (async (_input, init) => Response.json({ models: [{
        slug: SOL, supported_in_api: true, visibility: "list",
        available_access_programs: { cyber: new Headers(init?.headers).get("chatgpt-account-id") === `chatgpt-${MAIN_CODEX_ACCOUNT_ID}`
          ? ["standard", "daybreak_blue"] : ["standard"] },
      }] })) as typeof fetch,
      now: 1_000,
      clientVersion: TEST_CLIENT_VERSION,
    });
    expect(snapshot.accessProgramsByAccount?.get(MAIN_CODEX_ACCOUNT_ID)?.get(SOL)).toEqual({ cyber: ["standard", "daybreak_blue"] });
    expect(snapshot.accessProgramsByAccount?.get("secondary")?.get(SOL)).toEqual({ cyber: ["standard"] });

    const rows: RawEntry[] = [
      { slug: SOL, available_access_programs: null },
      { slug: `main/${SOL}`, opencodex_catalog_kind: "account-selector-v1", available_access_programs: null },
      { slug: `secondary/${SOL}`, opencodex_catalog_kind: "account-selector-v1", available_access_programs: null },
      { slug: `other/${SOL}`, opencodex_catalog_kind: "account-selector-v1", available_access_programs: { cyber: ["daybreak_blue"] } },
      { slug: `other/${SOL}`, opencodex_catalog_kind: "routed-provider", available_access_programs: { cyber: ["daybreak_blue"] } },
    ];
    applyNativeAccessPrograms(rows, snapshot, new Map([
      ["main", MAIN_CODEX_ACCOUNT_ID], ["secondary", "secondary"], ["other", "missing"],
    ]));
    expect(rows[0]?.available_access_programs).toEqual({ cyber: ["standard", "daybreak_blue"] });
    expect(rows[1]?.available_access_programs).toEqual({ cyber: ["standard", "daybreak_blue"] });
    expect(rows[2]?.available_access_programs).toEqual({ cyber: ["standard"] });
    expect(rows[3]).not.toHaveProperty("available_access_programs");
    expect(rows[4]?.available_access_programs).toEqual({ cyber: ["daybreak_blue"] });
  });

  test("preserves explicit null and removes stale metadata when a roster omits the field", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential(MAIN_CODEX_ACCOUNT_ID)],
      fetcher: (async () => Response.json({ models: [
        { slug: SOL, supported_in_api: true, visibility: "list", available_access_programs: null },
        { slug: "gpt-6-sol", supported_in_api: true, visibility: "list" },
      ] })) as typeof fetch,
      now: 1_000,
      clientVersion: TEST_CLIENT_VERSION,
    });
    expect(snapshot.accessProgramsByAccount?.get(MAIN_CODEX_ACCOUNT_ID)?.has(SOL)).toBe(true);
    expect(snapshot.accessProgramsByAccount?.get(MAIN_CODEX_ACCOUNT_ID)?.get(SOL)).toBeNull();
    expect(snapshot.accessProgramsByAccount?.get(MAIN_CODEX_ACCOUNT_ID)?.has("gpt-6-sol")).toBe(false);
    const rows: RawEntry[] = [
      { slug: SOL, available_access_programs: { cyber: ["daybreak_blue"] } },
      { slug: "gpt-6-sol", available_access_programs: { cyber: ["daybreak_blue"] } },
    ];
    applyNativeAccessPrograms(rows, snapshot, new Map());
    expect(rows[0]?.available_access_programs).toBeNull();
    expect(rows[1]).not.toHaveProperty("available_access_programs");
  });
  test("keeps model slugs but drops malformed access programs without a cyber array", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential(MAIN_CODEX_ACCOUNT_ID)],
      fetcher: (async () => Response.json({ models: [
        { slug: "model-empty-programs", supported_in_api: true, visibility: "list", available_access_programs: {} },
        { slug: "model-invalid-cyber", supported_in_api: true, visibility: "list", available_access_programs: { cyber: "standard" } },
        { slug: "model-valid-programs", supported_in_api: true, visibility: "list", available_access_programs: { cyber: ["standard"] } },
        { slug: "gpt-5.6-sol", supported_in_api: true, visibility: "list", available_access_programs: { cyber: ["standard"] } },
      ] })) as typeof fetch,
      now: 1_000,
      clientVersion: TEST_CLIENT_VERSION,
    });

    const models = snapshot.modelsByAccount.get(MAIN_CODEX_ACCOUNT_ID);
    const programs = snapshot.accessProgramsByAccount?.get(MAIN_CODEX_ACCOUNT_ID);
    expect(models).toEqual(new Set(["model-empty-programs", "model-invalid-cyber", "model-valid-programs", "gpt-5.6-sol"]));
    expect(programs?.has("model-empty-programs")).toBe(false);
    expect(programs?.has("model-invalid-cyber")).toBe(false);
    expect(programs?.get("model-valid-programs")).toEqual({ cyber: ["standard"] });

    const comboAlias = { slug: "gpt-5.6-sol", owned_by: "combo", available_access_programs: { cyber: ["daybreak_blue"] } };
    applyNativeAccessPrograms([comboAlias], snapshot, new Map());
    expect(comboAlias).not.toHaveProperty("available_access_programs");
  });
});
