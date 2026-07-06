import { describe, expect, test } from "bun:test";
import { decodeJwtPayload, extractAccountId, extractEmail } from "../src/oauth/chatgpt";

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

describe("ChatGPT OAuth JWT helpers", () => {
  test("decodeJwtPayload extracts payload from valid JWT", () => {
    const jwt = fakeJwt({ sub: "user123", email: "a@b.com" });
    const payload = decodeJwtPayload(jwt);
    expect(payload).toBeTruthy();
    expect(payload!.sub).toBe("user123");
    expect(payload!.email).toBe("a@b.com");
  });

  test("decodeJwtPayload returns undefined for non-JWT string", () => {
    expect(decodeJwtPayload("not-a-jwt")).toBeUndefined();
    expect(decodeJwtPayload("")).toBeUndefined();
    expect(decodeJwtPayload("a.b")).toBeUndefined();
  });

  test("decodeJwtPayload returns undefined for invalid base64 payload", () => {
    expect(decodeJwtPayload("header.!!!invalid!!!.sig")).toBeUndefined();
  });

  test("extractAccountId level 1: top-level chatgpt_account_id", () => {
    const jwt = fakeJwt({ chatgpt_account_id: "acct_123" });
    expect(extractAccountId(jwt)).toBe("acct_123");
  });

  test("extractAccountId level 2: namespaced claim", () => {
    const jwt = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_ns_456" },
    });
    expect(extractAccountId(jwt)).toBe("acct_ns_456");
  });

  test("extractAccountId level 3: organizations[0].id", () => {
    const jwt = fakeJwt({
      organizations: [{ id: "org_789" }],
    });
    expect(extractAccountId(jwt)).toBe("org_789");
  });

  test("extractAccountId prefers id_token over access_token", () => {
    const idToken = fakeJwt({ chatgpt_account_id: "from_id" });
    const accessToken = fakeJwt({ chatgpt_account_id: "from_access" });
    expect(extractAccountId(idToken, accessToken)).toBe("from_id");
  });

  test("extractAccountId falls back to access_token if id_token has no account", () => {
    const idToken = fakeJwt({ sub: "no-account-here" });
    const accessToken = fakeJwt({ chatgpt_account_id: "from_access" });
    expect(extractAccountId(idToken, accessToken)).toBe("from_access");
  });

  test("extractAccountId returns undefined when no account found", () => {
    const jwt = fakeJwt({ sub: "user", email: "a@b.com" });
    expect(extractAccountId(jwt)).toBeUndefined();
    expect(extractAccountId(undefined, undefined)).toBeUndefined();
  });

  test("extractEmail extracts and lowercases email", () => {
    const jwt = fakeJwt({ email: "User@Example.COM" });
    expect(extractEmail(jwt)).toBe("user@example.com");
  });

  test("extractEmail returns undefined when no email", () => {
    const jwt = fakeJwt({ sub: "user123" });
    expect(extractEmail(jwt)).toBeUndefined();
  });

  test("extractEmail prefers id_token over access_token", () => {
    const id = fakeJwt({ email: "id@test.com" });
    const access = fakeJwt({ email: "access@test.com" });
    expect(extractEmail(id, access)).toBe("id@test.com");
  });
});

describe("ChatGPT OAuth constants", () => {
  test("uses auth.openai.com endpoints (not auth0.openai.com)", async () => {
    const source = await Bun.file("src/oauth/chatgpt.ts").text();
    expect(source).toContain('auth.openai.com/oauth/authorize');
    expect(source).toContain('auth.openai.com/oauth/token');
    expect(source).not.toContain("auth0.openai.com");
  });

  test("uses official Codex client_id", async () => {
    const source = await Bun.file("src/oauth/chatgpt.ts").text();
    expect(source).toContain("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(source).not.toContain("DRivsnm2Mu42T3KOpqdtwB3NYviHYzwD");
  });

  test("uses form-urlencoded content-type (not JSON)", async () => {
    const source = await Bun.file("src/oauth/chatgpt.ts").text();
    expect(source).toContain("application/x-www-form-urlencoded");
    expect(source).not.toContain('"Content-Type": "application/json"');
  });

  test("includes codex_cli_simplified_flow parameter", async () => {
    const source = await Bun.file("src/oauth/chatgpt.ts").text();
    expect(source).toContain("codex_cli_simplified_flow");
  });
});

describe("codex-account-store constants sync", () => {
  test("uses same auth.openai.com endpoint as chatgpt.ts", async () => {
    const source = await Bun.file("src/codex/account-store.ts").text();
    expect(source).toContain("auth.openai.com/oauth/token");
    expect(source).not.toContain("auth0.openai.com");
  });

  test("uses same client_id as chatgpt.ts", async () => {
    const source = await Bun.file("src/codex/account-store.ts").text();
    expect(source).toContain("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(source).not.toContain("DRivsnm2Mu42T3KOpqdtwB3NYviHYzwD");
  });

  test("uses form-urlencoded for refresh", async () => {
    const source = await Bun.file("src/codex/account-store.ts").text();
    expect(source).toContain("application/x-www-form-urlencoded");
  });
});
