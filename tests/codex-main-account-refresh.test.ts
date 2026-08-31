import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getValidMainAccountToken,
  setMainAuthJsonBeforeRenameHookForTests,
} from "../src/codex/main-account";
import { codexCredentialMutationEpoch } from "../src/codex/credential-mutation-epoch";

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

    const epochBefore = codexCredentialMutationEpoch();
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
    expect(codexCredentialMutationEpoch()).toBe(epochBefore + 1);
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

    const epochBefore = codexCredentialMutationEpoch();
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
    expect(codexCredentialMutationEpoch()).toBe(epochBefore);
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

  /**
   * #2999: the refresh lock is keyed on the grant fingerprint and lives under
   * OPENCODEX_HOME, but the file it protects is `auth.json` under CODEX_HOME, which
   * every install on the machine shares. Two proxies with different OPENCODEX_HOMEs
   * therefore took two unrelated locks and refreshed the one credential at once, so
   * the loser's rotated grant was published over the winner's and then rejected by
   * the provider.
   *
   * The claim this now takes lives in CODEX_HOME, so it is the same lock for both.
   * Driven through the real `getValidMainAccountToken` with OPENCODEX_HOME actually
   * swapped between the two calls: asserting on the claim primitive directly would
   * pass even if `main-account.ts` never took it.
   */
  test("two OPENCODEX_HOMEs serialize on the one CODEX_HOME credential", async () => {
    const authPath = join(home, "auth.json");
    writeFileSync(authPath, JSON.stringify({
      tokens: { access_token: expiredJwt(), refresh_token: "old-refresh", account_id: "account-main" },
    }));

    const homeA = mkdtempSync(join(tmpdir(), "ocx-home-a-"));
    const homeB = mkdtempSync(join(tmpdir(), "ocx-home-b-"));
    const previousOcxHome = process.env.OPENCODEX_HOME;
    // Overlap is observed, not assumed: each refresh records when it entered and
    // left, so a serialized pair reads enter/leave/enter and a concurrent one
    // reads enter/enter.
    const order: string[] = [];
    let release: (() => void) | undefined;
    const firstEntered = Promise.withResolvers<void>();

    const refreshFor = (label: string, gate: boolean) => async () => {
      order.push(`enter:${label}`);
      if (gate) {
        firstEntered.resolve();
        await new Promise<void>(resolve => { release = resolve; });
      }
      order.push(`leave:${label}`);
      return {
        accessToken: `fresh-${label}`,
        refreshToken: `rotated-${label}`,
        expires: Date.now() + 3_600_000,
        accountId: "account-main",
      };
    };

    try {
      process.env.OPENCODEX_HOME = homeA;
      const first = getValidMainAccountToken({ refreshToken: refreshFor("a", true) });
      await firstEntered.promise;

      // Second install, different OPENCODEX_HOME, same CODEX_HOME. Before the fix
      // this entered immediately; now it waits on the shared claim.
      process.env.OPENCODEX_HOME = homeB;
      const second = getValidMainAccountToken({ refreshToken: refreshFor("b", false) });
      await Bun.sleep(50);
      expect(order).toEqual(["enter:a"]);

      release?.();
      await first;
      await second.catch(() => null);
      expect(order.slice(0, 3)).toEqual(["enter:a", "leave:a", "enter:b"]);
    } finally {
      release?.();
      if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOcxHome;
      rmSync(homeA, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
    }
  });
});
