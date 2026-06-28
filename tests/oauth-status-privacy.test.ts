import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLoginStatus, getValidAccessToken, UnsupportedOAuthProviderError } from "../src/oauth/index";
import { saveCredential } from "../src/oauth/store";

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

  test("getLoginStatus returns a masked provider email", () => {
    saveCredential("xai", {
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

  test("saveCredential persists only the credential allowlist", () => {
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

    saveCredential("xai", {
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

  test("getLoginStatus ignores invalid legacy source metadata", () => {
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

  test("stale credentials for removed OAuth providers fail as unsupported provider config", async () => {
    saveCredential("removed-provider", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });

    await expect(getValidAccessToken("removed-provider")).rejects.toBeInstanceOf(UnsupportedOAuthProviderError);
  });

  test("malformed oauth token store is backed up before a new credential save overwrites it", () => {
    const authPath = join(TEST_DIR, "auth.json");
    writeFileSync(authPath, "{not valid json", "utf8");

    saveCredential("xai", {
      access: "new-access",
      refresh: "new-refresh",
      expires: Date.now() + 60_000,
    });

    const backups = readdirSync(TEST_DIR).filter(name => name.startsWith("auth.json.invalid-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(TEST_DIR, backups[0]), "utf8")).toBe("{not valid json");
  });
});
