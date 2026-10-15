import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { buildChildEnv, createClaudeCliAdapter } from "../../src/adapters/claude-cli/adapter";
import { CLAUDE_CLI_PROFILE } from "../../src/adapters/claude-cli/profiles";
import {
  checkClaudeUsageAdmission,
  formatClaudeReset,
  parseClaudeReset,
  recordClaudeUsageRefusal,
  setClaudeUsagePreflightForTests,
} from "../../src/adapters/claude-cli/usage-admission";
import { getAdapterDefinition } from "../../src/adapters/registry";
import { getConfigDir } from "../../src/config/paths";
import { handleResponses } from "../../src/server/responses";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const identity = () => ({ key: "test-identity", access: "test-access" });
const freshQuota = { updatedAt: Date.now(), fiveHourPercent: 10, fiveHourResetAt: Date.now() + 3_600_000, weeklyPercent: 10, weeklyResetAt: Date.now() + 86_400_000 };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempState = () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-claude-admission-"));
  dirs.push(dir);
  return join(dir, "claude-usage-admission.json");
};
const seed = (quota: unknown, now: number) => {
  const statePath = tempState();
  writeFileSync(statePath, JSON.stringify({ identity: "test-identity", checkedAt: now - 10_000, quota }));
  return statePath;
};

describe("Claude usage admission cache", () => {
  test("an expired window scoped to another model family does not force a re-read", async () => {
    const now = Date.now();
    const statePath = seed({ ...freshQuota, customWindows: [{ label: "Opus", percent: 100, resetAt: now - 1000, scope: "model" }] }, now);
    let probes = 0;
    const probe = async () => { probes++; return freshQuota; };
    expect((await checkClaudeUsageAdmission("claude-sonnet-5-5", { now: () => now, identity, probe, statePath })).state).toBe("available");
    expect(probes).toBe(0);
    expect((await checkClaudeUsageAdmission("claude-opus-5-5", { now: () => now, identity, probe, statePath })).state).toBe("available");
    expect(probes).toBe(1);
  });

  test("a cached window above 100% whose reset passed is re-read like one at exactly 100%", async () => {
    const now = Date.now();
    const statePath = seed({ ...freshQuota, fiveHourPercent: 104, fiveHourResetAt: now - 1000 }, now);
    let probes = 0;
    const status = await checkClaudeUsageAdmission("claude-sonnet-5-5", { now: () => now, identity, probe: async () => { probes++; return freshQuota; }, statePath });
    expect(status.state).toBe("available");
    expect(probes).toBe(1);
  });

  test("the exhausted message names the reset in the host time zone, not a fixed one", async () => {
    const now = Date.now();
    const resetAt = now + 2 * 3_600_000;
    const statePath = seed({ ...freshQuota, weeklyPercent: 100, weeklyResetAt: resetAt }, now);
    const status = await checkClaudeUsageAdmission("claude-sonnet-5-5", { now: () => now, identity, probe: async () => null, statePath });
    expect(status.state).toBe("exhausted");
    expect(status.resetAt).toBe(resetAt);
    expect(status.message).toContain(`paused until ${formatClaudeReset(resetAt)},`);
    expect(status.message).not.toContain("America/New_York");
    // ICU versions differ in spacing (a narrow no-break space before "PM") and in joining the date
    // and time with "at": compare the words.
    const utc = formatClaudeReset(Date.UTC(2026, 9, 8, 15, 30), "UTC").replace(/[\s,]+/g, " ").trim();
    expect(utc).toMatch(/^Oct 8 (at )?3:30 PM (UTC|GMT)$/);
  });

  test("the cache lives under OPENCODEX_HOME and stores no token", async () => {
    // A home this case creates, so cleanup never removes a path inside a home it did not create.
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-claude-admission-home-"));
    dirs.push(home);
    process.env.OPENCODEX_HOME = home;
    try {
      const statePath = join(getConfigDir(), "claude-usage-admission.json");
      expect(existsSync(statePath)).toBe(false);
      const status = await checkClaudeUsageAdmission("claude-sonnet-5-5", { identity, probe: async () => freshQuota });
      expect(status.state).toBe("available");
      expect(existsSync(join(home, "claude-usage-admission.json"))).toBe(true);
      const saved = readFileSync(statePath, "utf8");
      expect(saved).toContain("test-identity");
      expect(saved).not.toContain("test-access");
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
    }
  });

  test("a throwing identity or probe fails open as unknown", async () => {
    const statePath = tempState();
    const broken = await checkClaudeUsageAdmission("claude-sonnet-5-5", { identity: () => { throw new TypeError("bad credential"); }, statePath });
    expect(broken.state).toBe("unknown");
    const rejected = await checkClaudeUsageAdmission("claude-sonnet-5-5", { identity: async () => { throw new TypeError("bad credential"); }, statePath });
    expect(rejected.state).toBe("unknown");
    const unreachable = await checkClaudeUsageAdmission("claude-sonnet-5-5", { identity, probe: async () => { throw new Error("offline"); }, statePath });
    expect(unreachable.state).toBe("unknown");
  });

  test("a test process never reads the real Claude sign-in or probes with it", async () => {
    let probes = 0;
    const status = await checkClaudeUsageAdmission("claude-sonnet-5-5", { probe: async () => { probes++; return freshQuota; }, statePath: tempState() });
    expect(status.state).toBe("unknown");
    expect(probes).toBe(0);
  });

  test("a refusal the CLI reports while a probe is in flight survives the probe's write", async () => {
    const now = Date.UTC(2026, 9, 8, 12, 0);
    const statePath = tempState();
    // The refusal lands in the last await before the probe commits: its account re-check.
    let recorded = false;
    const racing = async (fresh?: boolean) => {
      if (fresh && !recorded) {
        recorded = true;
        await recordClaudeUsageRefusal("You've hit your limit · resets 3pm (UTC)", { now: () => now, identity, statePath });
      }
      return identity();
    };
    const status = await checkClaudeUsageAdmission("claude-sonnet-5-5", { now: () => now, identity: racing, probe: async () => freshQuota, statePath });
    expect(recorded).toBe(true);
    expect(status).toMatchObject({ state: "exhausted", resetAt: Date.UTC(2026, 9, 8, 15, 0) });
    expect(JSON.parse(readFileSync(statePath, "utf8")).refusalUntil).toBe(Date.UTC(2026, 9, 8, 15, 0));
  });

  test("an account switch during a probe neither persists nor applies the old account's answer", async () => {
    const now = Date.now();
    const statePath = tempState();
    const exhausted = { ...freshQuota, weeklyPercent: 100, weeklyResetAt: now + 3_600_000 };
    const switching = (fresh?: boolean) => fresh ? { key: "account-b", access: "b" } : { key: "account-a", access: "a" };
    const status = await checkClaudeUsageAdmission("claude-sonnet-5-5", { now: () => now, identity: switching, probe: async () => exhausted, statePath });
    expect(status.state).toBe("unknown");
    expect(existsSync(statePath)).toBe(false);
  });
});

describe("Claude-reported limits", () => {
  test("a parsed CLI reset pauses later launches until that time", async () => {
    const now = Date.UTC(2026, 9, 8, 12, 0);
    const statePath = tempState();
    expect(parseClaudeReset("Claude AI usage limit reached", now)).toBeUndefined();
    expect(parseClaudeReset("You've hit your limit · resets 3:30pm (UTC)", now)).toBe(Date.UTC(2026, 9, 8, 15, 30));
    expect(parseClaudeReset("You've hit your limit · resets 9am (Asia/Seoul)", now)).toBe(Date.UTC(2026, 9, 9, 0, 0));
    expect(parseClaudeReset("You've hit your limit · resets 3pm (Not/AZone)", now)).toBeUndefined();
    await recordClaudeUsageRefusal("Request failed: network error", { now: () => now, identity, statePath });
    expect(existsSync(statePath)).toBe(false);
    await recordClaudeUsageRefusal("You've hit your limit · resets 3pm (UTC)", { now: () => now, identity, statePath });
    const status = await checkClaudeUsageAdmission("claude-sonnet-5-5", { now: () => now, identity, probe: async () => freshQuota, statePath });
    expect(status).toMatchObject({ state: "exhausted", resetAt: Date.UTC(2026, 9, 8, 15, 0) });
  });
});

describe("claude-cli adapter admission", () => {
  const provider = { adapter: "claude-cli", baseUrl: CLAUDE_CLI_PROFILE.canonicalBaseUrl } as OcxProviderConfig;
  const parsed = { modelId: "claude-sonnet-5-5", stream: true, options: {}, context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] } } as OcxParsedRequest;

  test("an exhausted subscription is refused with a 429 cooldown before any spawn", async () => {
    let spawned = 0;
    const adapter = createClaudeCliAdapter(provider, {
      usageAdmission: async () => ({ state: "exhausted", checkedAt: 0, resetAt: Date.now() + 60_000, message: "paused" }),
      which: () => "/usr/bin/claude",
      spawn: () => { spawned++; return new EventEmitter() as unknown as ChildProcess; },
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(events).toEqual([expect.objectContaining({ type: "error", status: 429, code: "claude_subscription_cooldown", message: "paused" })]);
    expect(spawned).toBe(0);
  });

  test("the child env keeps CLAUDE_CONFIG_DIR so the CLI and the preflight read one profile", () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = "/tmp/ocx-claude-profile";
      expect(buildChildEnv(CLAUDE_CLI_PROFILE, "").CLAUDE_CONFIG_DIR).toBe("/tmp/ocx-claude-profile");
      delete process.env.CLAUDE_CONFIG_DIR;
      expect("CLAUDE_CONFIG_DIR" in buildChildEnv(CLAUDE_CLI_PROFILE, "")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
});

test("an exhausted Claude subscription is refused before dispatch with 429 and Retry-After; no CLI is spawned", async () => {
  const definition = getAdapterDefinition("claude-cli")! as any;
  const originalCreate = definition.create;
  const releaseSpend = acquireOwnedSpendHome();
  let spawned = 0;
  const resetAt = Date.now() + 90_000;
  setClaudeUsagePreflightForTests(async () => ({ state: "exhausted", checkedAt: Date.now(), resetAt, message: "Claude subscription limits are exhausted." }));
  definition.create = (provider: any) => createClaudeCliAdapter(provider, {
    usageAdmission: async () => ({ state: "available", checkedAt: 0 }),
    usageRefusal: () => {},
    which: () => process.execPath,
    spawn: () => { spawned++; throw new Error("the CLI must not start"); },
  });
  const config = { port: 0, defaultProvider: "claude-cli", providers: {
    "claude-cli": { adapter: "claude-cli", baseUrl: "https://api.anthropic.com", authMode: "key", selectedModels: ["claude-sonnet-5-5"] },
  } } as OcxConfig;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => handleResponses(req, config, { model: "", provider: "" }) });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-cli/claude-sonnet-5-5", stream: false, input: "hello" }) });
    const body = await res.json() as any;
    expect(res.status).toBe(429);
    expect(body.error.code).toBe("claude_subscription_cooldown");
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(60);
    expect(retryAfter).toBeLessThanOrEqual(90);
    expect(spawned).toBe(0);
  } finally {
    await server.stop(true);
    definition.create = originalCreate;
    setClaudeUsagePreflightForTests();
    releaseSpend();
  }
}, 20000);
