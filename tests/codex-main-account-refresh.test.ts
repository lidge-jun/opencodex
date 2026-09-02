import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getValidMainAccountToken,
  setMainAuthJsonBeforeRenameHookForTests,
} from "../src/codex/main-account";
import { codexCredentialMutationEpoch } from "../src/codex/credential-mutation-epoch";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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
  removeTreeWithRetry(home);
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
    // The first refresh records its entry and exit. A concurrent second refresh would
    // add enter:b before the first release; the serialized follower instead rereads
    // fresh credentials and does not refresh the now-rotated grant itself.
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
        access: `fresh-${label}`,
        refresh: `rotated-${label}`,
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
      expect(order).toEqual(["enter:a"]);

      release?.();
      await first;
      await second;
      expect(order).toEqual(["enter:a", "leave:a"]);
    } finally {
      release?.();
      if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOcxHome;
      removeTreeWithRetry(homeA);
      removeTreeWithRetry(homeB);
    }
  });

  test("aborts a contended native-main refresh before it retries", async () => {
    const authPath = join(home, "auth.json");
    writeFileSync(authPath, JSON.stringify({
      tokens: { access_token: expiredJwt(), refresh_token: "old-refresh", account_id: "account-main" },
    }));

    const homeA = mkdtempSync(join(tmpdir(), "ocx-home-a-"));
    const homeB = mkdtempSync(join(tmpdir(), "ocx-home-b-"));
    const previousOcxHome = process.env.OPENCODEX_HOME;
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const abort = new AbortController();
    const abortReason = new Error("refresh cancelled while native-main claim was busy");
    let secondRefreshStarted = false;

    try {
      process.env.OPENCODEX_HOME = homeA;
      const first = getValidMainAccountToken({
        refreshToken: async () => {
          firstEntered.resolve();
          await releaseFirst.promise;
          return {
            access: "fresh-a",
            refresh: "rotated-a",
            expires: Date.now() + 3_600_000,
            accountId: "account-main",
          };
        },
      });
      await firstEntered.promise;

      // The first refresh holds the CODEX_HOME claim. Cancellation must release the
      // second caller from that wait instead of letting it refresh after the holder exits.
      process.env.OPENCODEX_HOME = homeB;
      const second = getValidMainAccountToken({
        signal: abort.signal,
        refreshToken: async () => {
          secondRefreshStarted = true;
          throw new Error("must not refresh after cancellation");
        },
      });
      abort.abort(abortReason);
      releaseFirst.resolve();

      await expect(second).rejects.toBe(abortReason);
      await expect(first).resolves.toEqual({ accessToken: "fresh-a", chatgptAccountId: "account-main" });
      expect(secondRefreshStarted).toBe(false);
    } finally {
      releaseFirst.resolve();
      if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousOcxHome;
      removeTreeWithRetry(homeA);
      removeTreeWithRetry(homeB);
    }
  });
});

describe("publication never overwrites an external Codex writer (#2999)", () => {
  const refreshOk = async () => ({
    access: "ocx-staged-access",
    refresh: "ocx-staged-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "account-main",
  });

  function seedExpired(authPath: string): void {
    writeFileSync(authPath, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: expiredJwt(), refresh_token: "old-refresh", account_id: "account-main" },
    }));
  }

  test("a writer landing at the rename boundary is preserved byte-for-byte", async () => {
    // Issue reproduction step 5: replace auth.json from a simulated Codex writer at the
    // final pre-rename hook, then let the publisher resume. Before this guard the staged
    // credential won and the user's own `codex login` result was silently replaced.
    const authPath = join(home, "auth.json");
    seedExpired(authPath);
    const external = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "codex-cli-wrote-this", refresh_token: "codex-refresh", account_id: "account-main" },
    });
    setMainAuthJsonBeforeRenameHookForTests(() => { writeFileSync(authPath, external); });

    // Refusal surfaces as MainAuthJsonChangedDuringRefreshError, the existing signal for
    // "the file moved under us" - the caller retries against the new state rather than
    // proceeding with a credential it no longer owns.
    await expect(getValidMainAccountToken({ refreshToken: refreshOk })).rejects.toThrow();

    expect(readFileSync(authPath, "utf8")).toBe(external);
    expect(readFileSync(authPath, "utf8")).not.toContain("ocx-staged-access");
  });

  test("a same-bytes replacement with a new inode is still refused", async () => {
    // The case a content hash cannot see. rename(2) replaces unconditionally, so the
    // question that matters at the boundary is "is this the same FILE", not "does it hash
    // the same" - an external writer that rewrote identical bytes still owns the target.
    const authPath = join(home, "auth.json");
    seedExpired(authPath);
    const identical = readFileSync(authPath, "utf8");
    setMainAuthJsonBeforeRenameHookForTests(() => {
      // Replace via a distinct file so the inode changes while the bytes do not.
      const swap = join(home, "swap.json");
      writeFileSync(swap, identical);
      renameSync(swap, authPath);
    });

    await expect(getValidMainAccountToken({ refreshToken: refreshOk })).rejects.toThrow();

    expect(readFileSync(authPath, "utf8")).toBe(identical);
    expect(readFileSync(authPath, "utf8")).not.toContain("ocx-staged-access");
  });

  test("the canonical target survives a refused publication", async () => {
    // A refusal must never leave the credential missing: losing auth.json is worse than
    // losing the refresh, because Codex CLI then has nothing to authenticate with.
    const authPath = join(home, "auth.json");
    seedExpired(authPath);
    setMainAuthJsonBeforeRenameHookForTests(() => {
      writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "other" } }));
    });

    await expect(getValidMainAccountToken({ refreshToken: refreshOk })).rejects.toThrow();

    expect(existsSync(authPath)).toBe(true);
    expect(readdirSync(home).filter(name => name.startsWith("auth.json.")).length).toBe(0);
  });

  test("an uncontested publication still succeeds", async () => {
    // The guard must not make the ordinary path fail closed.
    const authPath = join(home, "auth.json");
    seedExpired(authPath);
    const token = await getValidMainAccountToken({ refreshToken: refreshOk });
    expect(token?.accessToken).toBe("ocx-staged-access");
    expect(readFileSync(authPath, "utf8")).toContain("ocx-staged-access");
  });
});
