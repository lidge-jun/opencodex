import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  codexAccountUnusableReason,
  isCodexAccountUsable,
  type CodexAccountUnusableReason,
} from "../../src/codex/account-usability";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth, markAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { MAIN_CODEX_ACCOUNT_ID, MainAccountTokenRefreshError } from "../../src/codex/main-account";
import { nativeMainRefreshFailureResponse } from "../../src/server/responses/codex-auth-error";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const STORE_DIR = join(import.meta.dir, ".tmp-unusable-reason-store");
const CODEX_DIR = join(import.meta.dir, ".tmp-unusable-reason-codex");
let prevOpencodexHome: string | undefined;
let prevCodexHome: string | undefined;

function writeMainAuth(): void {
  mkdirSync(CODEX_DIR, { recursive: true });
  writeFileSync(
    join(CODEX_DIR, "auth.json"),
    JSON.stringify({ tokens: { access_token: "main_access", account_id: "main_acct" } }),
  );
}

function saveCred(id: string): void {
  saveCodexAccountCredential(id, {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: `acct-${id}`,
  });
}

function makeConfig(): OcxConfig {
  return {
    providers: {},
    codexAccounts: [
      { id: "paid", email: "paid@test", isMain: false },
      { id: "stuck", email: "stuck@test", isMain: false },
      { id: "uncredentialed", email: "none@test", isMain: false },
    ],
    activeCodexAccountId: "paid",
  } as OcxConfig;
}

const ACCOUNT_IDS = ["paid", "stuck", "uncredentialed", MAIN_CODEX_ACCOUNT_ID];

describe("codex account unusable reason", () => {
  beforeEach(() => {
    prevOpencodexHome = process.env.OPENCODEX_HOME;
    prevCodexHome = process.env.CODEX_HOME;
    for (const dir of [STORE_DIR, CODEX_DIR]) if (existsSync(dir)) removeTreeWithRetry(dir);
    mkdirSync(STORE_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = STORE_DIR;
    process.env.CODEX_HOME = CODEX_DIR;
    for (const id of ACCOUNT_IDS) clearAccountNeedsReauth(id);
    saveCred("paid");
    saveCred("stuck");
    writeMainAuth();
  });

  afterEach(() => {
    for (const id of ACCOUNT_IDS) clearAccountNeedsReauth(id);
    for (const dir of [STORE_DIR, CODEX_DIR]) if (existsSync(dir)) removeTreeWithRetry(dir);
    if (prevOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prevOpencodexHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
  });

  test("a healthy pool account reports no reason", () => {
    expect(codexAccountUnusableReason(makeConfig(), "paid")).toBeUndefined();
  });

  test("an account stuck on a failed credential refresh names itself", () => {
    // The #4212 case: routing drops the account and, before this, said nothing about why.
    markAccountNeedsReauth("stuck");
    expect(codexAccountUnusableReason(makeConfig(), "stuck")).toBe("needs_reauth");
  });

  test("a pool row without a stored credential is distinguishable from a failed refresh", () => {
    expect(codexAccountUnusableReason(makeConfig(), "uncredentialed")).toBe("missing_credential");
  });

  test("an id that is not a pool row reports not_in_pool", () => {
    expect(codexAccountUnusableReason(makeConfig(), "never-added")).toBe("not_in_pool");
  });

  test("an account outside a gated model's entitled set reports model_not_entitled", () => {
    const reason = codexAccountUnusableReason(makeConfig(), "paid", {
      modelEligibleAccountIds: new Set(["stuck"]),
    });
    expect(reason).toBe("model_not_entitled");
  });

  test("the main account without a native credential reports main_credential_unavailable", () => {
    rmSync(join(CODEX_DIR, "auth.json"));
    expect(codexAccountUnusableReason(makeConfig(), MAIN_CODEX_ACCOUNT_ID))
      .toBe("main_credential_unavailable");
  });

  test("the boolean projection never disagrees with the reason", () => {
    // isCodexAccountUsable() is defined as this function's projection rather than a second copy of
    // the same branches, so an account can never be refused for a cause no surface can name.
    markAccountNeedsReauth("stuck");
    const config = makeConfig();
    const cases: { id: string; expected: CodexAccountUnusableReason | undefined }[] = [
      { id: "paid", expected: undefined },
      { id: "stuck", expected: "needs_reauth" },
      { id: "uncredentialed", expected: "missing_credential" },
      { id: "never-added", expected: "not_in_pool" },
      { id: MAIN_CODEX_ACCOUNT_ID, expected: undefined },
    ];
    for (const { id, expected } of cases) {
      const reason = codexAccountUnusableReason(config, id);
      expect(reason).toBe(expected as CodexAccountUnusableReason);
      expect(isCodexAccountUsable(config, id)).toBe(reason === undefined);
    }
  });
});

describe("native main refresh refusal", () => {
  test("a retryable refresh failure stays a 503 but names the account and the action", async () => {
    const response = nativeMainRefreshFailureResponse(new MainAccountTokenRefreshError("transient"));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    const message = ((await response.json()) as { error: { message: string } }).error.message;
    expect(message).toContain("Codex main credential refresh did not complete");
    expect(message).toContain("sign in to the main Codex account again");
  });

  // The regression this pins is not the sentence, it is the CLASSIFICATION the sentence causes.
  // `classifyError` runs `isAuthenticationMessage` before the `status === 503` arm, and that check
  // is status-blind on the bare substring "authentication" -- which "reauthentication" contains.
  // A retryable refusal that says that word is served as `authentication_error` /
  // `invalid_api_key` while still returning 503, and Codex keys its retry-after backoff on
  // `server_is_overloaded`, so the client reads a transient refresh as a bad API key and stops
  // retrying. The previous version of the test above asserted only the status and the word, which
  // is exactly why the reclassification shipped unnoticed.
  test("the retryable refusal is served as an overload, not as a bad key", async () => {
    const response = nativeMainRefreshFailureResponse(new MainAccountTokenRefreshError("transient"));
    const error = ((await response.json()) as { error: { type: string; code: string; message: string } }).error;
    expect(response.status).toBe(503);
    expect(error.type).toBe("server_error");
    expect(error.code).toBe("server_is_overloaded");
    // Load-bearing: the substring, not the phrasing, is what reclassifies the body.
    expect(error.message.toLowerCase()).not.toContain("authentication");
  });

  test("a terminal reauth failure still refuses with 401 rather than a retry promise", async () => {
    const response = nativeMainRefreshFailureResponse(new MainAccountTokenRefreshError("reauth"));
    expect(response.status).toBe(401);
    const message = ((await response.json()) as { error: { message: string } }).error.message;
    expect(message).toBe("Codex main account needs reauthentication");
  });
});
