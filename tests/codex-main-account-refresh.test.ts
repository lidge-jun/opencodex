import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getValidMainAccountToken,
  setMainAuthJsonBeforeRenameHookForTests,
} from "../src/codex/main-account";

let home: string;
let previousCodexHome: string | undefined;

function expiredJwt(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 })).toString("base64url");
  return `header.${payload}.signature`;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-main-refresh-"));
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
});

afterEach(() => {
  setMainAuthJsonBeforeRenameHookForTests(null);
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(home, { recursive: true, force: true });
});

describe("native main token refresh", () => {
  test("refreshes a refresh-only auth file and atomically preserves unrelated fields", async () => {
    const authPath = join(home, "auth.json");
    const original = {
      auth_mode: "chatgpt",
      tokens: {
        refresh_token: "old-refresh",
        account_id: "account-main",
        future_token_field: "preserve-token",
      },
      future_root_field: { preserve: true },
    };
    writeFileSync(authPath, JSON.stringify(original));
    let targetDuringPublish = "";
    setMainAuthJsonBeforeRenameHookForTests(() => {
      targetDuringPublish = readFileSync(authPath, "utf8");
    });

    const token = await getValidMainAccountToken({
      refreshToken: async refreshToken => {
        expect(refreshToken).toBe("old-refresh");
        return {
          access: "new-access",
          refresh: "rotated-refresh",
          expires: Date.now() + 3_600_000,
          accountId: "account-main",
        };
      },
    });

    expect(token).toEqual({ accessToken: "new-access", chatgptAccountId: "account-main" });
    expect(targetDuringPublish).toBe(JSON.stringify(original));
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      ...original,
      tokens: {
        ...original.tokens,
        access_token: "new-access",
        refresh_token: "rotated-refresh",
        account_id: "account-main",
      },
    });
    expect(readdirSync(home).filter(name => name.includes(".tmp"))).toEqual([]);
  });

  test("refuses to overwrite an external auth writer after refresh", async () => {
    const authPath = join(home, "auth.json");
    writeFileSync(authPath, JSON.stringify({
      tokens: {
        access_token: expiredJwt(),
        refresh_token: "old-refresh",
        account_id: "account-main",
      },
    }));
    const external = JSON.stringify({
      tokens: {
        access_token: "external-access",
        refresh_token: "external-refresh",
        account_id: "account-external",
      },
    });
    setMainAuthJsonBeforeRenameHookForTests(() => writeFileSync(authPath, external));

    await expect(getValidMainAccountToken({
      refreshToken: async () => ({
        access: "new-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 3_600_000,
        accountId: "account-main",
      }),
    })).rejects.toThrow("changed while its token was refreshing");

    expect(readFileSync(authPath, "utf8")).toBe(external);
    expect(readdirSync(home).filter(name => name.includes(".tmp"))).toEqual([]);
  });

  test("refresh failure leaves the original auth file byte-identical", async () => {
    const authPath = join(home, "auth.json");
    const original = Buffer.from(`{\n  "tokens": {\n    "access_token": "${expiredJwt()}",\n    "refresh_token": "old-refresh",\n    "account_id": "account-main"\n  },\n  "preserve": "spacing"\n}\n`);
    writeFileSync(authPath, original);

    await expect(getValidMainAccountToken({
      refreshToken: async () => {
        throw new Error("simulated refresh transport failure");
      },
    })).rejects.toThrow("did not complete");

    expect(readFileSync(authPath)).toEqual(original);
    expect(readdirSync(home).filter(name => name.includes(".tmp"))).toEqual([]);
  });
});
