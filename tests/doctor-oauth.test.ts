import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectOAuthDoctorChecks } from "../src/cli/doctor";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { CODEX_REAUTH_ACTION } from "../src/oauth/health";
import { getAccountSet, getAuthStorePath, markAccountNeedsReauth, saveCredential } from "../src/oauth/store";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const origHome = process.env.HOME;
const origOcxHome = process.env.OPENCODEX_HOME;
let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `doctor-oauth-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

describe("collectOAuthDoctorChecks", () => {
  test("needsReauth account yields WARN with action and redacted id", async () => {
    await saveCredential("openai", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      accountId: "acct_abcdefghijklmnopqrstuvwxyz",
      source: "oauth",
    });
    const set = getAccountSet("openai");
    expect(set).toBeTruthy();
    const accountId = set!.activeAccountId;
    await markAccountNeedsReauth("openai", accountId, true);

    const checks = await collectOAuthDoctorChecks(Date.now(), {
      findLiveProxyImpl: async () => null,
    });
    const warn = checks.find(
      (c) => c.level === "WARN" && c.message.includes("requires reauthentication"),
    );
    expect(warn).toBeTruthy();
    expect(warn!.message).toContain("Action:");
    expect(warn!.message).toContain("ocx login openai");
    expect(warn!.message).toContain("account-…");
    expect(warn!.message).not.toContain(accountId);
    expect(warn!.message).not.toContain("access-token");
    expect(warn!.message).not.toContain("refresh-token");
  });

  test("emits storage, single-flight, and pass-through metadata notes", async () => {
    const checks = await collectOAuthDoctorChecks(Date.now(), {
      findLiveProxyImpl: async () => null,
    });
    expect(checks.some((c) => c.level === "OK" && c.message.includes("atomic auth.json updates"))).toBe(true);
    expect(checks.some((c) => c.level === "OK" && c.message.includes("Token refresh single-flight is active"))).toBe(true);
    expect(checks.some((c) => c.level === "OK" && c.message.includes("pass-through client metadata"))).toBe(true);
    expect(checks.some((c) => c.message.includes("No fabricated official-client metadata detected"))).toBe(false);
  });

  test("labels Codex health unavailable when proxy is down", async () => {
    const checks = await collectOAuthDoctorChecks(Date.now(), {
      findLiveProxyImpl: async () => null,
    });
    const warn = checks.find((c) => c.level === "WARN" && c.message.includes("Codex account health unavailable"));
    expect(warn).toBeTruthy();
    expect(warn!.message).toContain("Action:");
    expect(warn!.message).toContain("start the proxy");
  });

  test("labels management auth failure without claiming the proxy is down", async () => {
    const attestationSecret = "A".repeat(43);
    const checks = await collectOAuthDoctorChecks(Date.now(), {
      findLiveProxyImpl: async () => ({ hostname: "127.0.0.1", port: 19191, pid: 4242, source: "runtime" }),
      readRuntimePortImpl: () => ({ pid: 4242, port: 19191, attestationSecret }),
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    });
    const warn = checks.find((c) => c.level === "WARN" && c.message.includes("Codex account health unavailable"));
    expect(warn).toBeTruthy();
    expect(warn!.message).toContain("proxy running");
    expect(warn!.message).toContain("management authentication failed");
    expect(warn!.message).not.toContain("proxy not running");
    expect(warn!.message).toContain("Action:");
  });

  test("Codex needsReauth WARN comes from management API, not CLI process maps", async () => {
    const attestationSecret = "A".repeat(43);
    const checks = await collectOAuthDoctorChecks(Date.now(), {
      findLiveProxyImpl: async () => ({ hostname: "127.0.0.1", port: 19191, pid: 4242, source: "runtime" }),
      readRuntimePortImpl: () => ({ pid: 4242, port: 19191, attestationSecret }),
      fetchImpl: async () =>
        new Response(JSON.stringify({
          accounts: [{
            id: MAIN_CODEX_ACCOUNT_ID,
            health: { status: "reauth_required", reason: "refresh_failed" },
          }],
        }), { status: 200 }),
    });
    const warn = checks.find(
      (c) => c.level === "WARN" && c.message.includes("requires reauthentication"),
    );
    expect(warn).toBeTruthy();
    expect(warn!.message).toContain(`Action: ${CODEX_REAUTH_ACTION}`);
    expect(warn!.message).not.toContain("ocx login codex");
    expect(checks.some((c) => c.message.includes("Codex account health unavailable"))).toBe(false);
  });

  test("every WARN includes a recovery Action", async () => {
    await saveCredential("xai", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      accountId: "acct_needs_reauth_suffix_42",
      source: "oauth",
    });
    const set = getAccountSet("xai")!;
    await markAccountNeedsReauth("xai", set.activeAccountId, true);

    const warns = (await collectOAuthDoctorChecks(Date.now(), {
      findLiveProxyImpl: async () => null,
    })).filter((c) => c.level === "WARN");
    expect(warns.length).toBeGreaterThan(0);
    for (const warn of warns) {
      expect(warn.message).toMatch(/Action:/);
    }
  });

  test("doctor health path does not mutate auth.json", async () => {
    await saveCredential("xai", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      accountId: "acct_readonly_doctor",
      source: "oauth",
    });
    const path = getAuthStorePath();
    const before = readFileSync(path);
    const beforeStat = statSync(path);

    await collectOAuthDoctorChecks(Date.now(), { findLiveProxyImpl: async () => null });

    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(statSync(path).mode).toBe(beforeStat.mode);
  });

  test("doctor does not backup corrupt auth.json", async () => {
    mkdirSync(join(tmp, "ocx"), { recursive: true });
    const path = getAuthStorePath();
    writeFileSync(path, "{not-json", { mode: 0o600 });

    await collectOAuthDoctorChecks(Date.now(), { findLiveProxyImpl: async () => null });

    expect(readFileSync(path, "utf8")).toBe("{not-json");
    // loadAuthStore would create auth.json.bak*; peek must not.
    const dirEntries = readdirSync(join(tmp, "ocx"));
    expect(dirEntries.some((name) => name.includes(".bak"))).toBe(false);
  });
});
