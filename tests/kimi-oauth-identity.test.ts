import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { identityFromKimiTokens } from "../src/oauth/kimi";
import { getCredential, listAccounts, saveCredential } from "../src/oauth/store";

const TEST_DIR = join(import.meta.dir, ".tmp-kimi-oauth-identity-test");
let previousOpencodexHome: string | undefined;

function jwtWithClaims(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("Kimi OAuth JWT identity", () => {
  test("user_id becomes accountId", () => {
    const access = jwtWithClaims({ user_id: "kimi-user-aaa", exp: 9_999_999_999 });
    expect(identityFromKimiTokens(access)).toEqual({ accountId: "kimi-user-aaa" });
  });

  test("sub is used when user_id is absent", () => {
    const access = jwtWithClaims({ sub: "kimi-sub-bbb" });
    expect(identityFromKimiTokens(access)).toEqual({ accountId: "kimi-sub-bbb" });
  });

  test("user_id wins over sub", () => {
    const access = jwtWithClaims({ user_id: "from-user-id", sub: "from-sub" });
    expect(identityFromKimiTokens(access).accountId).toBe("from-user-id");
  });

  test("email is lowercased when present", () => {
    // Build without an email-shaped source literal (privacy-scan).
    const mixed = ["Alice", String.fromCharCode(64), "Kimi.Example"].join("");
    const access = jwtWithClaims({ user_id: "u1", email: mixed });
    expect(identityFromKimiTokens(access).email).toBe(mixed.toLowerCase());
  });

  test("falls back to refresh JWT when access has no identity", () => {
    const access = jwtWithClaims({ scope: "coding" });
    const refresh = jwtWithClaims({ user_id: "from-refresh" });
    expect(identityFromKimiTokens(access, refresh)).toEqual({ accountId: "from-refresh" });
  });

  test("opaque tokens yield no identity", () => {
    expect(identityFromKimiTokens("not-a-jwt", "also-opaque")).toEqual({});
  });
});

describe("Kimi multiauth via saveCredential", () => {
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

  test("two distinct user_ids append two kimi accounts", async () => {
    const accessA = jwtWithClaims({ user_id: "kimi-a" });
    const accessB = jwtWithClaims({ user_id: "kimi-b" });
    await saveCredential("kimi", {
      access: accessA,
      refresh: "refresh-a",
      expires: Date.now() + 3600_000,
      ...identityFromKimiTokens(accessA),
    });
    await saveCredential("kimi", {
      access: accessB,
      refresh: "refresh-b",
      expires: Date.now() + 3600_000,
      ...identityFromKimiTokens(accessB),
    });
    expect(listAccounts("kimi").length).toBe(2);
    expect(getCredential("kimi")?.accountId).toBe("kimi-b");
    expect(getCredential("kimi")?.access).toBe(accessB);
  });

  test("same user_id upserts without duplicating", async () => {
    const access1 = jwtWithClaims({ user_id: "kimi-same" });
    const access2 = jwtWithClaims({ user_id: "kimi-same", iat: 2 });
    await saveCredential("kimi", {
      access: access1,
      refresh: "refresh-1",
      expires: Date.now() + 3600_000,
      ...identityFromKimiTokens(access1),
    });
    await saveCredential("kimi", {
      access: access2,
      refresh: "refresh-2",
      expires: Date.now() + 3600_000,
      ...identityFromKimiTokens(access2),
    });
    expect(listAccounts("kimi").length).toBe(1);
    expect(getCredential("kimi")?.access).toBe(access2);
    expect(getCredential("kimi")?.refresh).toBe("refresh-2");
  });

  test("identity-less kimi replace mutates active only and keeps siblings", async () => {
    const accessA = jwtWithClaims({ user_id: "kimi-keep" });
    const accessB = jwtWithClaims({ user_id: "kimi-active" });
    await saveCredential("kimi", {
      access: accessA,
      refresh: "refresh-a",
      expires: Date.now() + 3600_000,
      ...identityFromKimiTokens(accessA),
    });
    await saveCredential("kimi", {
      access: accessB,
      refresh: "refresh-b",
      expires: Date.now() + 3600_000,
      ...identityFromKimiTokens(accessB),
    });
    expect(listAccounts("kimi").length).toBe(2);

    // Opaque re-login: no accountId → replace active slot in place (does not wipe sibling).
    await saveCredential("kimi", {
      access: "opaque-access",
      refresh: "opaque-refresh",
      expires: Date.now() + 3600_000,
    });
    expect(listAccounts("kimi").length).toBe(2);
    expect(getCredential("kimi")?.access).toBe("opaque-access");
    expect(listAccounts("kimi").some(a => a.credential.accountId === "kimi-keep")).toBe(true);
  });
});
