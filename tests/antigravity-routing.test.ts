import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  antigravitySessionKeyFromParts,
  bindAntigravitySessionAffinity,
  clearAntigravityRoutingState,
  getAntigravityAccountHealthSnapshot,
  recordAntigravityCooldown,
  resolveAntigravityAccountForSession,
  retryableAntigravity429DelayMs,
} from "../src/oauth/antigravity-routing";
import { getAccountSet, saveCredential, setActiveAccount } from "../src/oauth/store";

let home: string;

beforeEach(async () => {
  home = join(tmpdir(), `ocx-antigravity-routing-${crypto.randomUUID()}`);
  mkdirSync(home, { recursive: true });
  process.env.OPENCODEX_HOME = home;
  clearAntigravityRoutingState();
  await saveCredential("google-antigravity", { access: "a", refresh: "ra", expires: Date.now() + 3600000, accountId: "account-a", email: "a@example.com" });
  await saveCredential("google-antigravity", { access: "b", refresh: "rb", expires: Date.now() + 3600000, accountId: "account-b", email: "b@example.com" });
});

afterEach(() => {
  clearAntigravityRoutingState();
  rmSync(home, { recursive: true, force: true });
  delete process.env.OPENCODEX_HOME;
});

function accountIds(): { a: string; b: string } {
  const set = getAccountSet("google-antigravity");
  expect(set).toBeDefined();
  return { a: set!.accounts.find(a => a.credential.accountId === "account-a")!.id, b: set!.accounts.find(a => a.credential.accountId === "account-b")!.id };
}

describe("google antigravity strict account affinity", () => {
  test("blank higher-priority session candidates fall through", () => {
    expect(antigravitySessionKeyFromParts({ clientThreadId: " ", sessionIdHeader: "session-a", threadIdHeader: "thread-a" })).toBe("session-a");
    expect(antigravitySessionKeyFromParts({ clientThreadId: "", sessionIdHeader: "", threadIdHeader: "thread-a" })).toBe("thread-a");
    expect(antigravitySessionKeyFromParts({ clientThreadId: " ", sessionIdHeader: " ", threadIdHeader: " " })).toBeNull();
  });

  test("established sessions stay on their account after active-account changes and cooldowns", async () => {
    const ids = accountIds();
    await setActiveAccount("google-antigravity", ids.a);
    bindAntigravitySessionAffinity("conversation-1", ids.a, 1000);
    await setActiveAccount("google-antigravity", ids.b);
    recordAntigravityCooldown(ids.a, "2", 1000);

    expect(resolveAntigravityAccountForSession("conversation-1", 2000)).toMatchObject({ accountId: ids.a, reason: "affinity" });
    expect(getAntigravityAccountHealthSnapshot(ids.a, 2000)?.cooldownUntil).toBe(3000);
    expect(resolveAntigravityAccountForSession("conversation-2", 2000)).toMatchObject({ accountId: ids.b, reason: "active" });
  });

  test("a cooled active account is surfaced as bounded unavailable instead of rotating", async () => {
    const ids = accountIds();
    await setActiveAccount("google-antigravity", ids.a);
    recordAntigravityCooldown(ids.a, "60", 1000);
    expect(resolveAntigravityAccountForSession("new-conversation", 2000)).toMatchObject({ accountId: ids.a, reason: "active-cooled" });
  });

  test("short retry-after is retryable once and longer cooldowns are not", () => {
    expect(retryableAntigravity429DelayMs("5", 1000)).toBe(5000);
    expect(retryableAntigravity429DelayMs("5.1", 1000)).toBeNull();
    expect(retryableAntigravity429DelayMs("60", 1000)).toBeNull();
    expect(retryableAntigravity429DelayMs(null, 1000)).toBeNull();
  });
});
