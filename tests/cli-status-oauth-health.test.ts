import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatOAuthHealthForStatus } from "../src/cli/status-oauth";
import { collectOAuthHealthEntries } from "../src/oauth/health";
import { getAccountSet, markAccountNeedsReauth, saveCredential } from "../src/oauth/store";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const origHome = process.env.HOME;
const origOcxHome = process.env.OPENCODEX_HOME;
let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `cli-status-oauth-health-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  process.env.HOME = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "ocx");
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = origOcxHome;
  removeTreeWithRetry(tmp);
});

describe("formatOAuthHealthForStatus", () => {
  test("formats reauthentication required", () => {
    const text = formatOAuthHealthForStatus([{
      provider: "openai",
      accountId: "acct_abcdefghijklmnopqrstuvwxyz",
      health: { status: "reauth_required", reason: "refresh_failed" },
      action: "run `ocx login openai`",
    }]);
    expect(text).toContain("OAuth health: warning");
    expect(text).toContain("account-…wxyz");
    expect(text).not.toContain("acct_abcdefghijklmnopqrstuvwxyz");
    expect(text).toContain("reauthentication required");
  });

  test("formats rate limited cooldown", () => {
    const text = formatOAuthHealthForStatus([{
      provider: "codex",
      accountId: "acct_rate_limit_account_17",
      health: {
        status: "cooldown",
        until: "2026-07-23T14:30:00.000Z",
        reason: "rate_limit",
      },
      action: "wait until local or start a new session with another eligible account",
    }]);
    expect(text).toContain("OAuth health: warning");
    expect(text).toContain("account-…t_17");
    expect(text).not.toContain("acct_rate_limit_account_17");
    expect(text).toContain("rate limited");
    expect(text).toContain("2026-07-23T14:30:00.000Z");
  });

  test("all healthy reports ok without listing accounts", () => {
    const text = formatOAuthHealthForStatus([{
      provider: "xai",
      accountId: "acct_healthy_zzzz",
      health: { status: "healthy" },
    }]);
    expect(text).toBe("OAuth health: ok");
    expect(text).not.toContain("acct_healthy_zzzz");
    expect(text).not.toContain("account-…");
  });

  test("labels Codex health unavailable when proxy is down", () => {
    const text = formatOAuthHealthForStatus({
      entries: [],
      codexHealthSource: "unavailable",
    });
    expect(text).toContain("Codex health: unavailable");
    expect(text).toContain("management API");
  });

  test("does not call an authentication failure a stopped proxy", () => {
    const text = formatOAuthHealthForStatus({
      entries: [],
      codexHealthSource: "management-auth-failed",
    });
    expect(text).toContain("proxy running");
    expect(text).toContain("management authentication failed");
    expect(text).not.toContain("proxy not running");
  });
});

describe("collectOAuthHealthEntries via status formatter", () => {
  test("redacts account id for needsReauth store fixture", async () => {
    await saveCredential("xai", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      email: "person@example.test",
      accountId: "acct_abcdefghijklmnopqrstuvwxyz",
      source: "oauth",
    });
    const set = getAccountSet("xai");
    expect(set).toBeTruthy();
    await markAccountNeedsReauth("xai", set!.activeAccountId, true);

    const text = formatOAuthHealthForStatus(collectOAuthHealthEntries());
    expect(text).toContain("OAuth health: warning");
    expect(text).toContain("reauthentication required");
    expect(text).toContain("account-…");
    expect(text).not.toContain(set!.activeAccountId);
    expect(text).not.toContain("access-token");
    expect(text).not.toContain("refresh-token");
    expect(text).not.toContain("person@example.test");
  });
});
