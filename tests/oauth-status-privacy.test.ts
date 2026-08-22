import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearLoginState,
  getLoginStatus,
  getValidAccessToken,
  OAuthLoginRequiredError,
  OAuthProviderPublicationError,
  OAuthReauthIdentityMismatchError,
  OAuthReauthIdentityUnverifiedError,
  OAuthTokenRefreshBusyError,
  OAuthTokenRefreshStaleError,
  OAUTH_PROVIDERS,
  publicOAuthAuthenticationErrorMessage,
  UnsupportedOAuthProviderError,
} from "../src/oauth";
import { OAuthMutationBusyError, saveCredential } from "../src/oauth/store";
import { handleManagementAPI } from "../src/server/management-api";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";
import { ManagementRequest } from "./helpers/management-auth";

const TEST_DIR = join(import.meta.dir, `.tmp-oauth-status-privacy-test-${process.pid}`);
const PUBLIC_OAUTH_ERROR = "OAuth authentication failed. Check the OpenCodex account status and retry.";
const PUBLIC_ERROR_CANARY = "C:\\Users\\Alice\\.opencodex\\auth.json.ocx-tmp \\\\server\\share\\auth.json /home/alice/.opencodex/auth.json";
let previousOpencodexHome: string | undefined;

describe("OAuth status privacy", () => {
  beforeEach(() => {
    clearLoginState("xai");
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
  });

  afterEach(() => {
    clearLoginState("xai");
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("getLoginStatus returns a masked provider email", async () => {
    await saveCredential("xai", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      email: "person@example.test",
      accountId: "acct-xai",
      source: "local-cli",
    });

    const status = getLoginStatus("xai");

    expect(status.loggedIn).toBe(true);
    expect(status.email).toBe("p***n@example.test");
    expect(status.source).toBe("local-cli");
    expect(JSON.stringify(status)).not.toContain("person@example.test");
    expect(JSON.stringify(status)).not.toContain("access-token");
    expect(JSON.stringify(status)).not.toContain("refresh-token");
  });

  test("saveCredential persists only the credential allowlist", async () => {
    writeFileSync(join(TEST_DIR, "auth.json"), JSON.stringify({
      legacy: {
        access: "legacy-access",
        refresh: "legacy-refresh",
        expires: Date.now() + 60_000,
        source: "attacker-controlled-source",
        prompt: "legacy prompt",
        headers: { authorization: "Bearer legacy" },
      },
    }), "utf8");

    await saveCredential("xai", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      email: "person@example.test",
      accountId: "acct-xai",
      source: "credential-file",
      prompt: "secret prompt",
      headers: { authorization: "Bearer leaked" },
      idToken: "jwt-secret",
    } as never);

    const stored = readFileSync(join(TEST_DIR, "auth.json"), "utf8");

    expect(stored).toContain("access-token");
    expect(stored).toContain("refresh-token");
    expect(stored).toContain("legacy-access");
    expect(stored).toContain("\"source\": \"credential-file\"");
    expect(stored).not.toContain("attacker-controlled-source");
    expect(stored).not.toContain("legacy prompt");
    expect(stored).not.toContain("Bearer legacy");
    expect(stored).not.toContain("secret prompt");
    expect(stored).not.toContain("Bearer leaked");
    expect(stored).not.toContain("jwt-secret");
  });

  test("getLoginStatus ignores invalid legacy source metadata", async () => {
    writeFileSync(join(TEST_DIR, "auth.json"), JSON.stringify({
      xai: {
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
        source: "oauth<script>",
      },
    }), "utf8");

    const status = getLoginStatus("xai");

    expect(status.loggedIn).toBe(true);
    expect(status.source).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("oauth<script>");
  });

  test("getLoginStatus stays logged in for an expired-but-refreshable credential", async () => {
    await saveCredential("xai", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() - 60_000,
      email: "person@example.test",
      accountId: "acct-xai",
      source: "local-cli",
    });

    // Expired access token with a valid refresh token is still a logged-in account:
    // request resolution refreshes it lazily. Only needsReauth is authoritative.
    const status = getLoginStatus("xai");
    expect(status.loggedIn).toBe(true);
    expect(status.accounts?.[0]?.needsReauth).toBeUndefined();
  });

  test("getLoginStatus stays logged in for an unknown (0) credential expiry", async () => {
    writeFileSync(join(TEST_DIR, "auth.json"), JSON.stringify({
      xai: {
        access: "access-token",
        refresh: "refresh-token",
        expires: 0,
      },
    }), "utf8");

    expect(getLoginStatus("xai").loggedIn).toBe(true);
  });

  test("getLoginStatus stays logged in for a non-finite credential expiry", async () => {
    // JSON.stringify cannot carry NaN/Infinity, but a hand-written auth.json with an
    // out-of-range numeric expiry parses to Infinity — the realistic corrupt shape.
    writeFileSync(join(TEST_DIR, "auth.json"), '{"xai":{"access":"access-token","refresh":"refresh-token","expires":1e999}}', "utf8");

    expect(getLoginStatus("xai").loggedIn).toBe(true);
  });

  test("getLoginStatus reports not logged in for a needsReauth account", async () => {
    await saveCredential("xai", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 3600_000,
      accountId: "acct-xai",
      source: "local-cli",
    });
    const { markAccountNeedsReauth, getAccountSet } = await import("../src/oauth/store");
    await markAccountNeedsReauth("xai", getAccountSet("xai")!.activeAccountId, true);

    expect(getLoginStatus("xai").loggedIn).toBe(false);
    expect(getLoginStatus("xai").accounts?.[0]?.needsReauth).toBe(true);
  });

  test("stale credentials for removed OAuth providers fail as unsupported provider config", async () => {
    await saveCredential("removed-provider", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });

    await expect(getValidAccessToken("removed-provider")).rejects.toBeInstanceOf(UnsupportedOAuthProviderError);
  });

  test("stale OAuth provider responses do not disclose the config path", async () => {
    await saveCredential("removed-provider", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });
    const config = {
      defaultProvider: "removed-provider",
      providers: {
        "removed-provider": {
          adapter: "openai-responses",
          authMode: "oauth",
          baseUrl: "https://provider.example/v1",
        },
      },
    } as OcxConfig;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", input: "hello", stream: false }),
    }), config, { model: "", provider: "" });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("Unsupported OAuth provider");
    expect(body).toContain("Remove or reconfigure provider 'removed-provider'");
    expect(body).not.toContain(TEST_DIR);
    expect(body).not.toContain("config.json");
  });

  test("OAuth responses redact token-shaped custom provider names", async () => {
    const providerName = "sk-secret-provider-key";
    const config = {
      defaultProvider: providerName,
      providers: {
        [providerName]: {
          adapter: "openai-responses",
          authMode: "oauth",
          baseUrl: "https://provider.example/v1",
        },
      },
    } as OcxConfig;

    const request = () => new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", input: "hello", stream: false }),
    });
    const missingCredential = await handleResponses(request(), config, { model: "", provider: "" });
    const missingCredentialBody = await missingCredential.text();

    expect(missingCredential.status).toBe(401);
    expect(missingCredentialBody).toContain(PUBLIC_OAUTH_ERROR);
    expect(missingCredentialBody).not.toContain(providerName);

    await saveCredential(providerName, {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });
    const unsupportedProvider = await handleResponses(request(), config, { model: "", provider: "" });
    const unsupportedProviderBody = await unsupportedProvider.text();

    expect(unsupportedProvider.status).toBe(400);
    expect(unsupportedProviderBody).toContain("Unsupported OAuth provider");
    expect(unsupportedProviderBody).not.toContain(providerName);
  });

  test("public OAuth errors preserve only the fixed operational allowlist", () => {
    expect(publicOAuthAuthenticationErrorMessage(new Error(PUBLIC_ERROR_CANARY))).toBe(PUBLIC_OAUTH_ERROR);
    expect(publicOAuthAuthenticationErrorMessage(new OAuthLoginRequiredError("xai"))).toBe(
      "Not logged in to xai. Run: ocx login xai",
    );
    expect(publicOAuthAuthenticationErrorMessage(new OAuthLoginRequiredError(PUBLIC_ERROR_CANARY)))
      .toBe(PUBLIC_OAUTH_ERROR);
    expect(publicOAuthAuthenticationErrorMessage(new OAuthProviderPublicationError())).toBe(
      "OAuth credential was saved, but the provider entry was not written. Resolve the account namespace collision, then retry login.",
    );
    expect(publicOAuthAuthenticationErrorMessage(new OAuthReauthIdentityMismatchError())).toBe(
      "Signed-in account does not match the selected account. Sign in with the same account.",
    );
    expect(publicOAuthAuthenticationErrorMessage(new OAuthReauthIdentityUnverifiedError())).toBe(
      "Could not verify signed-in account identity for reauth.",
    );
    expect(publicOAuthAuthenticationErrorMessage(new OAuthTokenRefreshBusyError())).toBe(
      "OAuth token refresh capacity reached",
    );
    expect(publicOAuthAuthenticationErrorMessage(new OAuthTokenRefreshStaleError())).toBe(
      "OAuth token refresh owner became stale",
    );
    expect(publicOAuthAuthenticationErrorMessage(new OAuthMutationBusyError())).toBe(
      "OAuth mutation queue is busy",
    );
    expect(publicOAuthAuthenticationErrorMessage(new OAuthMutationBusyError("OAuth mutation queue wait timed out"))).toBe(
      "OAuth mutation queue wait timed out",
    );
    expect(publicOAuthAuthenticationErrorMessage(new OAuthMutationBusyError(PUBLIC_ERROR_CANARY))).toBe(
      "OAuth mutation queue is busy",
    );
  });

  test("management OAuth login does not return raw provider or filesystem errors", async () => {
    const originalLogin = OAUTH_PROVIDERS.xai.login;
    OAUTH_PROVIDERS.xai.login = async () => {
      throw new Error(`provider login failed at ${PUBLIC_ERROR_CANARY}`);
    };
    try {
      const config = { port: 0, defaultProvider: "xai", providers: {} } as OcxConfig;
      const request = new ManagementRequest("http://localhost/api/oauth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "xai" }),
      });
      const response = await handleManagementAPI(request, new URL(request.url), config);
      const body = await response?.json() as { error?: string };

      expect(response?.status).toBe(409);
      expect(body.error).toBe(PUBLIC_OAUTH_ERROR);
      expect(JSON.stringify(body)).not.toContain(PUBLIC_ERROR_CANARY);
    } finally {
      OAUTH_PROVIDERS.xai.login = originalLogin;
      clearLoginState("xai");
    }
  });

  test("management OAuth login preserves the exact duplicate-flow response", async () => {
    const originalLogin = OAUTH_PROVIDERS.xai.login;
    OAUTH_PROVIDERS.xai.login = async (controller) => {
      controller.onAuth({ url: "" });
      await new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
      });
    };
    const config = { port: 0, defaultProvider: "xai", providers: {} } as OcxConfig;
    const request = () => new ManagementRequest("http://localhost/api/oauth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "xai" }),
    });
    try {
      const firstResponse = await handleManagementAPI(request(), new URL("http://localhost/api/oauth/login"), config);
      expect(firstResponse?.status).toBe(200);

      const duplicateResponse = await handleManagementAPI(request(), new URL("http://localhost/api/oauth/login"), config);
      const duplicateBody = await duplicateResponse?.json() as { error?: string };

      expect(duplicateResponse?.status).toBe(409);
      expect(duplicateBody.error).toBe("A login for xai is already in progress");
    } finally {
      clearLoginState("xai");
      await Bun.sleep(0);
      clearLoginState("xai");
      OAUTH_PROVIDERS.xai.login = originalLogin;
    }
  });

  test("management OAuth status does not return late provider or filesystem errors", async () => {
    const originalLogin = OAUTH_PROVIDERS.xai.login;
    OAUTH_PROVIDERS.xai.login = async (controller) => {
      controller.onAuth({ url: "" });
      throw new Error(`late provider login failure at ${PUBLIC_ERROR_CANARY}`);
    };
    try {
      const config = { port: 0, defaultProvider: "xai", providers: {} } as OcxConfig;
      const startRequest = new ManagementRequest("http://localhost/api/oauth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "xai" }),
      });
      const startResponse = await handleManagementAPI(startRequest, new URL(startRequest.url), config);
      expect(startResponse?.status).toBe(200);

      const deadline = Date.now() + 2_000;
      let statusBody: { done?: boolean; error?: string } = {};
      do {
        const statusRequest = new ManagementRequest("http://localhost/api/oauth/status?provider=xai");
        const statusResponse = await handleManagementAPI(statusRequest, new URL(statusRequest.url), config);
        expect(statusResponse?.status).toBe(200);
        statusBody = await statusResponse?.json() as typeof statusBody;
        if (!statusBody.done) await Bun.sleep(10);
      } while (!statusBody.done && Date.now() < deadline);

      expect(statusBody.done).toBe(true);
      expect(statusBody.error).toBe(PUBLIC_OAUTH_ERROR);
      expect(JSON.stringify(statusBody)).not.toContain(PUBLIC_ERROR_CANARY);
    } finally {
      OAUTH_PROVIDERS.xai.login = originalLogin;
      clearLoginState("xai");
    }
  });

  test("management OAuth status preserves actionable late OAuth errors", async () => {
    const originalLogin = OAUTH_PROVIDERS.xai.login;
    const cases: Array<{ error: Error; expected: string }> = [
      {
        error: new OAuthLoginRequiredError("xai"),
        expected: "Not logged in to xai. Run: ocx login xai",
      },
      {
        error: new OAuthReauthIdentityMismatchError(),
        expected: "Signed-in account does not match the selected account. Sign in with the same account.",
      },
      {
        error: new OAuthReauthIdentityUnverifiedError(),
        expected: "Could not verify signed-in account identity for reauth.",
      },
      {
        error: new OAuthTokenRefreshBusyError(),
        expected: "OAuth token refresh capacity reached",
      },
      {
        error: new OAuthTokenRefreshStaleError(),
        expected: "OAuth token refresh owner became stale",
      },
      {
        error: new OAuthMutationBusyError(),
        expected: "OAuth mutation queue is busy",
      },
    ];
    const config = { port: 0, defaultProvider: "xai", providers: {} } as OcxConfig;
    try {
      for (const { error, expected } of cases) {
        OAUTH_PROVIDERS.xai.login = async (controller) => {
          controller.onAuth({ url: "" });
          throw error;
        };
        const startRequest = new ManagementRequest("http://localhost/api/oauth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "xai" }),
        });
        const startResponse = await handleManagementAPI(startRequest, new URL(startRequest.url), config);
        expect(startResponse?.status).toBe(200);

        const deadline = Date.now() + 2_000;
        let statusBody: { done?: boolean; error?: string } = {};
        do {
          const statusRequest = new ManagementRequest("http://localhost/api/oauth/status?provider=xai");
          const statusResponse = await handleManagementAPI(statusRequest, new URL(statusRequest.url), config);
          statusBody = await statusResponse?.json() as typeof statusBody;
          if (!statusBody.done) await Bun.sleep(10);
        } while (!statusBody.done && Date.now() < deadline);

        expect(statusBody).toMatchObject({ done: true, error: expected });
        clearLoginState("xai");
      }
    } finally {
      OAUTH_PROVIDERS.xai.login = originalLogin;
      clearLoginState("xai");
    }
  });

  test("malformed oauth token store is backed up before a new credential save overwrites it", async () => {
    const authPath = join(TEST_DIR, "auth.json");
    writeFileSync(authPath, "{not valid json", "utf8");

    await saveCredential("xai", {
      access: "new-access",
      refresh: "new-refresh",
      expires: Date.now() + 60_000,
    });

    const backups = readdirSync(TEST_DIR).filter(name => name.startsWith("auth.json.invalid-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(TEST_DIR, backups[0]), "utf8")).toBe("{not valid json");
  });
});
