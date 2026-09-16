import { describe, expect, test } from "bun:test";
import { poolCredentialRefreshIncompleteResponse } from "../../src/server/responses/core";
import type { CodexAuthContext } from "../../src/codex/auth-context";
import type { OcxConfig } from "../../src/types";

/**
 * #4212: a pool credential whose forced refresh does not complete used to refuse with
 * "Codex credential refresh did not complete; retry this request" and nothing else. That reads
 * as a fault in the proxy, so the reporter went looking for a bug in OpenCodex while one of
 * their own accounts was the thing that needed them.
 *
 * These cases pin the two halves of the fix that can regress independently: the refusal names
 * an account and states that reauthentication is the exit, and the name it uses is never an
 * identifier this codebase treats as private.
 */

const ACCOUNT_ID = "sensitive-pool-account-id";
const ACCOUNT_EMAIL = "operator@example.test";
const LOG_LABEL = "pa1b2c3";

function poolAuthCtx(): CodexAuthContext {
  return {
    kind: "pool",
    accountId: ACCOUNT_ID,
    writerGeneration: 1,
    generation: 1,
    accessToken: "access-token",
    chatgptAccountId: "chatgpt-account-id",
  };
}

function configWithAccount(): Pick<OcxConfig, "codexAccounts"> {
  return {
    codexAccounts: [{ id: ACCOUNT_ID, email: ACCOUNT_EMAIL, logLabel: LOG_LABEL, isMain: false }],
  };
}

async function errorPayload(response: Response): Promise<{ message: string; type: string; code: string }> {
  const body = await response.json() as { error: { message: string; type: string; code: string } };
  return body.error;
}

describe("pool credential refresh refusal attribution", () => {
  test("names the selector the request actually used", async () => {
    const response = poolCredentialRefreshIncompleteResponse({
      authCtx: poolAuthCtx(),
      config: configWithAccount(),
      accountSelector: "team",
    });
    const error = await errorPayload(response);
    expect(error.message).toContain("Codex pool account team");
    expect(error.message).toContain("sign in to that account again");
    // The selector the operator typed wins over the derived label: it is the name they can act on.
    expect(error.message).not.toContain(LOG_LABEL);
  });

  test("falls back to the durable log label when the request carried no selector", async () => {
    const response = poolCredentialRefreshIncompleteResponse({
      authCtx: poolAuthCtx(),
      config: configWithAccount(),
    });
    const error = await errorPayload(response);
    expect(error.message).toContain(`Codex pool account ${LOG_LABEL}`);
    expect(error.message).toContain("sign in to that account again");
  });

  test("never puts the raw pool id or the account email in the refusal", async () => {
    for (const accountSelector of [undefined, "team"]) {
      const response = poolCredentialRefreshIncompleteResponse({
        authCtx: poolAuthCtx(),
        config: configWithAccount(),
        accountSelector,
      });
      const error = await errorPayload(response);
      expect(error.message).not.toContain(ACCOUNT_ID);
      expect(error.message).not.toContain(ACCOUNT_EMAIL);
    }
  });

  test("says nothing specific rather than naming something opaque", async () => {
    const response = poolCredentialRefreshIncompleteResponse({
      authCtx: poolAuthCtx(),
      config: { codexAccounts: [] },
    });
    const error = await errorPayload(response);
    // An unresolvable account still gets the actionable half of the sentence.
    expect(error.message).toContain("the selected Codex pool account");
    expect(error.message).toContain("sign in to that account again");
    expect(error.message).not.toContain(ACCOUNT_ID);
  });

  test("stays the retryable 503 contract it replaced", async () => {
    const response = poolCredentialRefreshIncompleteResponse({
      authCtx: poolAuthCtx(),
      config: configWithAccount(),
      accountSelector: "team",
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    // Naming the account must not reclassify the refusal. Codex applies retry-after backoff only
    // for server_is_overloaded, so a message-driven remap here would silently drop the retry.
    const error = await errorPayload(response);
    expect(error.type).toBe("server_error");
    expect(error.code).toBe("server_is_overloaded");
    expect(error.message).toContain("retry this request");
  });

  test("keeps the word that would reclassify it out of the body", async () => {
    // classifyError runs isAuthenticationMessage before it reaches the status === 503 arm, and
    // that check is status-blind on the bare substring "authentication" — which "reauthentication"
    // contains. Saying the friendlier word here turns a retryable overload into
    // authentication_error / invalid_api_key and drops Codex's retry-after backoff, so this
    // guards the wording rather than only the resulting code.
    const response = poolCredentialRefreshIncompleteResponse({
      authCtx: poolAuthCtx(),
      config: configWithAccount(),
      accountSelector: "team",
    });
    expect(response.status).toBe(503);
    const error = await errorPayload(response);
    expect(error.message.toLowerCase()).not.toContain("authentication");
    expect(error.message.toLowerCase()).not.toContain("unauthorized");
  });
});
