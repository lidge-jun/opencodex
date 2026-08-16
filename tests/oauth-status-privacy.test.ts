import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLoginStatus, getValidAccessToken, UnsupportedOAuthProviderError } from "../src/oauth";
import { saveCredential } from "../src/oauth/store";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-oauth-status-privacy-test");
let previousOpencodexHome: string | undefined;

describe("OAuth status privacy", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
  });

  afterEach(() => {
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
