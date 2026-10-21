import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
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

  const limit = "You've hit your limit · resets 3pm (UTC)";
  const now = Date.UTC(2026, 9, 8, 12, 0);
  const child = (lines: unknown[], stderr = "", exitCode = 0, failure?: "spawn" | "stream" | "stdin") => {
    const proc = new EventEmitter() as unknown as ChildProcess;
    proc.stdout = failure === "stream" ? Readable.from((async function* () { throw new Error(limit); })())
      : Readable.from(lines.map(line => new TextEncoder().encode(JSON.stringify(line) + "\n")));
    proc.stderr = Readable.from(stderr ? [stderr] : []);
    proc.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
    if (failure === "stdin") proc.stdin.write = () => { throw new Error(limit); };
    proc.kill = () => true;
    proc.exitCode = null;
    setTimeout(() => {
      if (failure === "spawn") proc.emit("error", new Error(limit));
      proc.exitCode = exitCode;
      proc.emit("close", exitCode);
    }, 3);
    return proc;
  };

  for (const failure of ["spawn", "stream", "stdin"] as const) {
    test(`local ${failure} errors do not persist a CLI refusal`, async () => {
      const statePath = tempState();
      const writes: Promise<void>[] = [];
      const adapter = createClaudeCliAdapter(provider, {
        usageAdmission: async () => ({ state: "available", checkedAt: now }),
        usageRefusal: message => { writes.push(recordClaudeUsageRefusal(message, { now: () => now, identity, statePath })); },
        which: () => process.execPath,
        spawn: () => child([], "", 0, failure),
        killGraceMs: 10,
        reapTimeoutMs: 50,
      });
      const events: AdapterEvent[] = [];
      await adapter.runTurn!(parsed,
        { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
      await Promise.all(writes);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("hit your limit") });
      expect(existsSync(statePath)).toBe(false);
      expect(writes).toHaveLength(0);
    });
  }

  for (const source of ["result", "exit-stderr", "eof-stderr"] as const) {
    test(`a CLI ${source} refusal still persists its reset`, async () => {
      const statePath = tempState();
      const writes: Promise<void>[] = [];
      const adapter = createClaudeCliAdapter(provider, {
        usageAdmission: async () => ({ state: "available", checkedAt: now }),
        usageRefusal: message => { writes.push(recordClaudeUsageRefusal(message, { now: () => now, identity, statePath })); },
        which: () => process.execPath,
        spawn: () => child(source === "result" ? [{ type: "result", is_error: true, result: limit }] : [],
          source === "result" ? "" : limit, source === "exit-stderr" ? 1 : 0),
        killGraceMs: 10,
        reapTimeoutMs: 50,
      });
      const events: AdapterEvent[] = [];
      await adapter.runTurn!(parsed, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
      await Promise.all(writes);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining(limit) });
      expect(JSON.parse(readFileSync(statePath, "utf8")).refusalUntil).toBe(Date.UTC(2026, 9, 8, 15, 0));
      expect((await checkClaudeUsageAdmission(parsed.modelId, { now: () => now, identity, probe: async () => freshQuota, statePath })).state).toBe("exhausted");
    });
  }

  for (const source of ["result", "exit-stderr", "eof-stderr"] as const) {
    test(`a ${source} error echoing a reset-shaped model id persists no refusal`, async () => {
      // This mock CLI output reflects caller-controlled model text inside error wording, so a parsed
      // reset cannot be attributed to a real account limit. The turn records nothing, while the
      // launch, the model argv, and the client-visible error are all unchanged.
      const statePath = tempState();
      const writes: Promise<void>[] = [];
      let argv: string[] = [];
      const forged = { ...parsed, modelId: "claude-x · You've hit your limit · resets 9pm (UTC)" };
      const reflected = `Error: model "${forged.modelId}" is not available`;
      const adapter = createClaudeCliAdapter(provider, {
        usageAdmission: async () => ({ state: "available", checkedAt: now }),
        usageRefusal: message => { writes.push(recordClaudeUsageRefusal(message, { now: () => now, identity, statePath })); },
        which: () => process.execPath,
        spawn: (_command, args) => {
          argv = [...args];
          return child(source === "result" ? [{ type: "result", is_error: true, result: reflected }] : [],
            source === "result" ? "" : reflected, source === "exit-stderr" ? 1 : 0);
        },
        killGraceMs: 10,
        reapTimeoutMs: 50,
      });
      const events: AdapterEvent[] = [];
      await adapter.runTurn!(forged, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
      await Promise.all(writes);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("hit your limit") });
      expect(argv[argv.indexOf("--model") + 1]).toBe(forged.modelId);
      expect(writes).toHaveLength(0);
      expect(existsSync(statePath)).toBe(false);
    });
  }

  test("a limit keyword the CLI adds around a reset-only model id still records nothing", async () => {
    // The model carries only the clock phrase; the CLI's own "hit your limit" completes the shape
    // the parser requires, so a guard keyed on the keyword would still record a forgery.
    const statePath = tempState();
    const writes: Promise<void>[] = [];
    const forged = { ...parsed, modelId: "claude-x resets 9pm (UTC)" };
    const adapter = createClaudeCliAdapter(provider, {
      usageAdmission: async () => ({ state: "available", checkedAt: now }),
      usageRefusal: message => { writes.push(recordClaudeUsageRefusal(message, { now: () => now, identity, statePath })); },
      which: () => process.execPath,
      spawn: () => child([], `You've hit your limit for model '${forged.modelId}'`, 1),
      killGraceMs: 10,
      reapTimeoutMs: 50,
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(forged, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    await Promise.all(writes);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("hit your limit") });
    expect(writes).toHaveLength(0);
    expect(existsSync(statePath)).toBe(false);
  });

  for (const modelId of [
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "us.anthropic.claude-sonnet-4-5@20250929",
    "claude-sonnet-4-5[1m]",
  ]) {
    test(`the legitimate model id ${modelId} still records a CLI refusal`, async () => {
      // Model ids are not charset-restricted: Bedrock ARNs, Vertex @-ids and [1m] aliases all
      // reach the CLI verbatim and a refusal the CLI itself reports keeps recording its reset.
      const statePath = tempState();
      const writes: Promise<void>[] = [];
      let argv: string[] = [];
      const adapter = createClaudeCliAdapter(provider, {
        usageAdmission: async () => ({ state: "available", checkedAt: now }),
        usageRefusal: message => { writes.push(recordClaudeUsageRefusal(message, { now: () => now, identity, statePath })); },
        which: () => process.execPath,
        spawn: (_command, args) => { argv = [...args]; return child([], limit, 1); },
        killGraceMs: 10,
        reapTimeoutMs: 50,
      });
      const events: AdapterEvent[] = [];
      await adapter.runTurn!({ ...parsed, modelId }, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
      await Promise.all(writes);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining(limit) });
      expect(argv[argv.indexOf("--model") + 1]).toBe(modelId);
      expect(JSON.parse(readFileSync(statePath, "utf8")).refusalUntil).toBe(Date.UTC(2026, 9, 8, 15, 0));
    });
  }

  test("a reset-shaped model id does not weaken the preflight cooldown", async () => {
    let spawned = 0;
    const adapter = createClaudeCliAdapter(provider, {
      usageAdmission: async () => ({ state: "exhausted", checkedAt: 0, resetAt: Date.now() + 60_000, message: "paused" }),
      which: () => "/usr/bin/claude",
      spawn: () => { spawned++; return new EventEmitter() as unknown as ChildProcess; },
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!({ ...parsed, modelId: "claude-x resets 9pm (UTC)" },
      { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(events).toEqual([expect.objectContaining({ type: "error", status: 429, code: "claude_subscription_cooldown", message: "paused" })]);
    expect(spawned).toBe(0);
  });

  test("a reset-shaped model id runs an ordinary turn unchanged", async () => {
    const statePath = tempState();
    const writes: Promise<void>[] = [];
    const adapter = createClaudeCliAdapter(provider, {
      usageAdmission: async () => ({ state: "available", checkedAt: now }),
      usageRefusal: message => { writes.push(recordClaudeUsageRefusal(message, { now: () => now, identity, statePath })); },
      which: () => process.execPath,
      spawn: () => child([
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } } },
        { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 3, output_tokens: 1 } },
      ]),
      killGraceMs: 10,
      reapTimeoutMs: 50,
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!({ ...parsed, modelId: "claude-x resets 9pm (UTC)" },
      { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    await Promise.all(writes);
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } });
    expect(writes).toHaveLength(0);
    expect(existsSync(statePath)).toBe(false);
  });

  test("successful output and a bridge rejection do not promote stderr into a refusal", async () => {
    for (const bridge of [false, true]) {
      const statePath = tempState();
      const writes: Promise<void>[] = [];
      const adapter = createClaudeCliAdapter(provider, {
        usageAdmission: async () => ({ state: "available", checkedAt: now }),
        usageRefusal: message => { writes.push(recordClaudeUsageRefusal(message, { now: () => now, identity, statePath })); },
        which: () => process.execPath,
        spawn: () => child(bridge
          ? [{ type: "system", subtype: "init", mcp_servers: [] }, { type: "result", is_error: true, result: limit }]
          : [{ type: "result", result: limit }], limit),
        killGraceMs: 10,
        reapTimeoutMs: 50,
      });
      const events: AdapterEvent[] = [];
      const request: OcxParsedRequest = bridge ? { ...parsed, context: { ...parsed.context,
        tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
      } } : parsed;
      await adapter.runTurn!(request, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
      await Promise.all(writes);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject(bridge ? { type: "error", code: "tool_bridge_init_mismatch" } : { type: "done" });
      expect(writes).toHaveLength(0);
      expect(existsSync(statePath)).toBe(false);
    }
  });

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
