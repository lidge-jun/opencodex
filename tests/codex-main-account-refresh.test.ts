import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forceRefreshMainAccountToken,
  getValidMainAccountToken,
  MainAccountRefreshCancelledError,
  MainAccountTokenRefreshError,
  setMainAuthJsonBeforeRenameHookForTests,
} from "../src/codex/main-account";
import { recoverNativeMainRefreshPublication } from "../src/codex/native-main-refresh-publication";
import { resolveNativeProfileContext } from "../src/codex/native-profile-store";

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

  test("does not classify an unstructured invalid_grant description as terminal", async () => {
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      tokens: {
        access_token: expiredJwt(),
        refresh_token: "old-refresh",
        account_id: "account-main",
      },
    }));

    const failure = await getValidMainAccountToken({
      refreshToken: async () => { throw new Error("invalid_grant"); },
    }).catch(error => error);

    expect(failure).toBeInstanceOf(MainAccountTokenRefreshError);
    expect((failure as MainAccountTokenRefreshError).reason).toBe("transient");
  });

  test("rejects a recovery journal whose basenames do not belong to its transaction", async () => {
    const authPath = join(home, "auth.json");
    const original = JSON.stringify({ tokens: { refresh_token: "old-refresh", account_id: "account-main" } });
    const replacement = JSON.stringify({ tokens: { access_token: "new-access", refresh_token: "new-refresh" } });
    const fileTransactionId = "11111111-1111-4111-8111-111111111111";
    const stagedBasename = `.opencodex-native-main-refresh.${fileTransactionId}.new`;
    const journalPath = join(home, ".opencodex-native-main-refresh.json");
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    writeFileSync(authPath, original);
    writeFileSync(join(home, stagedBasename), replacement);
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      transactionId: "22222222-2222-4222-8222-222222222222",
      stagedBasename,
      previousBasename: `.opencodex-native-main-refresh.${fileTransactionId}.previous`,
      phase: "prepared",
      expectedSha256: digest(original),
      replacementSha256: digest(replacement),
    }));
    let attempts = 0;

    const failure = await getValidMainAccountToken({
      refreshToken: async () => {
        attempts += 1;
        throw new Error("must not refresh through malformed recovery state");
      },
    }).catch(error => error);

    expect(failure).toBeInstanceOf(MainAccountTokenRefreshError);
    expect((failure as MainAccountTokenRefreshError).reason).toBe("transient");
    expect(attempts).toBe(0);
    expect(readFileSync(authPath, "utf8")).toBe(original);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("rejects hash-ambiguous recovery state without consuming it", async () => {
    const authPath = join(home, "auth.json");
    const original = JSON.stringify({ tokens: { refresh_token: "old-refresh", account_id: "account-main" } });
    const transactionId = "11111111-1111-4111-8111-111111111111";
    const stagedBasename = `.opencodex-native-main-refresh.${transactionId}.new`;
    const journalPath = join(home, ".opencodex-native-main-refresh.json");
    const hash = createHash("sha256").update(original).digest("hex");
    writeFileSync(authPath, original);
    writeFileSync(join(home, stagedBasename), original);
    writeFileSync(journalPath, JSON.stringify({
      version: 1,
      transactionId,
      stagedBasename,
      previousBasename: `.opencodex-native-main-refresh.${transactionId}.previous`,
      phase: "prepared",
      expectedSha256: hash,
      replacementSha256: hash,
    }));

    const failure = await getValidMainAccountToken().catch(error => error);

    expect(failure).toBeInstanceOf(MainAccountTokenRefreshError);
    expect((failure as MainAccountTokenRefreshError).reason).toBe("transient");
    expect(readFileSync(authPath, "utf8")).toBe(original);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("keeps a joiner alive when the refresh owner cancels", async () => {
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      tokens: {
        access_token: expiredJwt(),
        refresh_token: "old-refresh",
        account_id: "account-main",
      },
    }));
    const owner = new AbortController();
    let attempts = 0;
    let entered!: () => void;
    const enteredRefresh = new Promise<void>(resolve => { entered = resolve; });
    let complete!: (value: { access: string; refresh: string; expires: number; accountId: string }) => void;
    const remoteResult = new Promise<{ access: string; refresh: string; expires: number; accountId: string }>(resolve => {
      complete = resolve;
    });
    const refreshToken = async (_refresh: string, options: { signal: AbortSignal }) => {
      attempts += 1;
      entered();
      return await Promise.race([
        remoteResult,
        new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        }),
      ]);
    };
    const cancelled = getValidMainAccountToken({ signal: owner.signal, refreshToken });
    await enteredRefresh;
    const joined = getValidMainAccountToken({ refreshToken });
    owner.abort(new Error("caller cancelled"));
    complete({ access: "new-access", refresh: "new-refresh", expires: Date.now() + 3_600_000, accountId: "account-main" });

    await expect(cancelled).rejects.toBeDefined();
    await expect(joined).resolves.toEqual({ accessToken: "new-access", chatgptAccountId: "account-main" });
    expect(attempts).toBe(1);
  });

  test("persists a returned rotation after the only caller cancels", async () => {
    const authPath = join(home, "auth.json");
    writeFileSync(authPath, JSON.stringify({
      tokens: {
        access_token: expiredJwt(),
        refresh_token: "old-refresh",
        account_id: "account-main",
      },
    }));
    const caller = new AbortController();
    let entered!: () => void;
    const enteredRefresh = new Promise<void>(resolve => { entered = resolve; });
    let complete!: (value: { access: string; refresh: string; expires: number; accountId: string }) => void;
    const remoteResult = new Promise<{ access: string; refresh: string; expires: number; accountId: string }>(resolve => {
      complete = resolve;
    });
    let attempts = 0;
    const refreshToken = async () => {
      attempts += 1;
      entered();
      return await remoteResult;
    };

    const cancelled = getValidMainAccountToken({ signal: caller.signal, refreshToken });
    await enteredRefresh;
    complete({ access: "access-b", refresh: "refresh-b", expires: Date.now() + 3_600_000, accountId: "account-main" });
    caller.abort();

    await expect(cancelled).rejects.toBeInstanceOf(MainAccountRefreshCancelledError);
    await expect(getValidMainAccountToken({ refreshToken })).resolves.toEqual({ accessToken: "access-b", chatgptAccountId: "account-main" });
    expect(JSON.parse(readFileSync(authPath, "utf8")).tokens).toMatchObject({
      access_token: "access-b",
      refresh_token: "refresh-b",
    });
    expect(attempts).toBe(1);
  });

  test("reflights a joined rejected bearer once and coalesces force-refresh joiners", async () => {
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      tokens: {
        access_token: expiredJwt(),
        refresh_token: "old-refresh",
        account_id: "account-main",
      },
    }));
    let attempts = 0;
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>(resolve => { firstEntered = resolve; });
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
    let secondEntered!: () => void;
    const secondStarted = new Promise<void>(resolve => { secondEntered = resolve; });
    let releaseSecond!: () => void;
    const secondReleased = new Promise<void>(resolve => { releaseSecond = resolve; });
    const refreshToken = async () => {
      attempts += 1;
      if (attempts === 1) {
        firstEntered();
        await firstReleased;
        return { access: "rejected-bearer", refresh: "refresh-b", expires: Date.now() + 3_600_000, accountId: "account-main" };
      }
      secondEntered();
      await secondReleased;
      return { access: "fresh-bearer", refresh: "refresh-c", expires: Date.now() + 3_600_000, accountId: "account-main" };
    };

    const ordinary = getValidMainAccountToken({ refreshToken });
    await firstStarted;
    const forceOne = forceRefreshMainAccountToken("rejected-bearer", { refreshToken });
    const forceTwo = forceRefreshMainAccountToken("rejected-bearer", { refreshToken });
    releaseFirst();
    await secondStarted;
    releaseSecond();

    await expect(ordinary).resolves.toEqual({ accessToken: "rejected-bearer", chatgptAccountId: "account-main" });
    await expect(forceOne).resolves.toEqual({ accessToken: "fresh-bearer", chatgptAccountId: "account-main" });
    await expect(forceTwo).resolves.toEqual({ accessToken: "fresh-bearer", chatgptAccountId: "account-main" });
    expect(attempts).toBe(2);
  });

  test("fails transiently when the bounded replacement returns the rejected bearer again", async () => {
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      tokens: {
        access_token: expiredJwt(),
        refresh_token: "old-refresh",
        account_id: "account-main",
      },
    }));
    let attempts = 0;
    const refreshToken = async () => {
      attempts += 1;
      return {
        access: "rejected-bearer",
        refresh: attempts === 1 ? "refresh-b" : "refresh-c",
        expires: Date.now() + 3_600_000,
        accountId: "account-main",
      };
    };

    const failure = await forceRefreshMainAccountToken("rejected-bearer", { refreshToken }).catch(error => error);

    expect(failure).toBeInstanceOf(MainAccountTokenRefreshError);
    expect((failure as MainAccountTokenRefreshError).reason).toBe("transient");
    expect(attempts).toBe(2);
  });

  test("cleans committed recovery journals with zero, one, and multiple exact remnants", () => {
    const original = JSON.stringify({ tokens: { refresh_token: "old-refresh", account_id: "account-main" } });
    const replacement = JSON.stringify({ tokens: { access_token: "access-b", refresh_token: "refresh-b", account_id: "account-main" } });
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const cases = [
      { transactionId: "11111111-1111-4111-8111-111111111111", remnants: [] as string[] },
      { transactionId: "22222222-2222-4222-8222-222222222222", remnants: ["staged"] },
      { transactionId: "33333333-3333-4333-8333-333333333333", remnants: ["staged", "previous"] },
    ];
    for (const testCase of cases) {
      const staged = `.opencodex-native-main-refresh.${testCase.transactionId}.new`;
      const previous = `.opencodex-native-main-refresh.${testCase.transactionId}.previous`;
      const journalPath = join(home, ".opencodex-native-main-refresh.json");
      writeFileSync(join(home, "auth.json"), replacement);
      writeFileSync(journalPath, JSON.stringify({
        version: 1,
        transactionId: testCase.transactionId,
        stagedBasename: staged,
        previousBasename: previous,
        phase: "replaced",
        expectedSha256: digest(original),
        replacementSha256: digest(replacement),
      }));
      if (testCase.remnants.includes("staged")) writeFileSync(join(home, staged), original);
      if (testCase.remnants.includes("previous")) writeFileSync(join(home, previous), original);

      recoverNativeMainRefreshPublication(resolveNativeProfileContext());

      expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(replacement);
      expect(existsSync(journalPath)).toBe(false);
      expect(existsSync(join(home, staged))).toBe(false);
      expect(existsSync(join(home, previous))).toBe(false);
    }
  });

  test("retains malformed recovery state while preserving its parse cause", async () => {
    const journalPath = join(home, ".opencodex-native-main-refresh.json");
    writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { refresh_token: "old-refresh", account_id: "account-main" } }));
    writeFileSync(journalPath, "{");

    const failure = await getValidMainAccountToken().catch(error => error);

    expect(failure).toBeInstanceOf(MainAccountTokenRefreshError);
    expect((failure as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(((failure as Error & { cause?: Error }).cause as Error & { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
    expect(existsSync(journalPath)).toBe(true);
  });
});
