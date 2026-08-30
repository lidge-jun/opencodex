import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getValidMainAccountToken } from "../src/codex/main-account";

let home = "";
let previousCodexHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-native-main-flight-"));
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  writeFileSync(join(home, "auth.json"), JSON.stringify({
    tokens: { refresh_token: "refresh-grant", account_id: "account-main" },
  }));
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(home, { recursive: true, force: true });
});

describe("native-main refresh process coordination", () => {
  test("same-home callers join exactly one refresh flight", async () => {
    let attempts = 0;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let finish!: () => void;
    const completed = new Promise<void>(resolve => { finish = resolve; });
    const refreshToken = async () => {
      attempts += 1;
      entered();
      await completed;
      return { access: "fresh-access", refresh: "rotated-grant", expires: Date.now() + 3_600_000, accountId: "account-main" };
    };
    const first = getValidMainAccountToken({ refreshToken });
    await started;
    const second = getValidMainAccountToken({ refreshToken });
    finish();

    await expect(first).resolves.toEqual({ accessToken: "fresh-access", chatgptAccountId: "account-main" });
    await expect(second).resolves.toEqual({ accessToken: "fresh-access", chatgptAccountId: "account-main" });
    expect(attempts).toBe(1);
  });
});
