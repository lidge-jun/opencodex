import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigDiagnostics, telemetryConfigError } from "../../src/config/diagnostics";
import { adoptPersistedTelemetry, armClaudeCodeBaseline } from "../../src/config/live-reconcile";
import { malformedTelemetryWarning } from "../../src/config/load-degrade";
import {
  aggregateTelemetryEntriesForDay,
  aggregateTelemetryForDay,
  classifyModelFamily,
  classifyProviderKind,
  disjointTelemetryTokens,
} from "../../src/telemetry/aggregate";
import { resolveTelemetryStatus } from "../../src/telemetry/consent";
import {
  ARCH_VALUES,
  INSTALL_CHANNELS,
  MODEL_FAMILIES,
  OS_VALUES,
  PROVIDER_KINDS,
  RELEASE_CHANNELS,
  REQUEST_FAILURE_CAUSES as TELEMETRY_FAILURE_CAUSES,
  REQUEST_OUTCOME_CLASSES as TELEMETRY_OUTCOME_CLASSES,
  TELEMETRY_SCHEMA_VERSION,
  validateTelemetryPayloadV1,
  type TelemetryPayloadV1,
} from "../../src/telemetry/contract";
import {
  computeInstallDayHash,
  deleteTelemetryInstallId,
  ensureTelemetryInstallId,
  readTelemetryInstallId,
  resetTelemetryInstallIdMemoForTests,
  telemetryIdPath,
} from "../../src/telemetry/install-id";
import { buildTelemetryPayloadV1, resolveInstallChannel } from "../../src/telemetry/payload";
import {
  nudgeTelemetryScheduler,
  readTelemetryState,
  runTelemetryTick,
  startTelemetryScheduler,
  stopTelemetryScheduler,
  telemetryStatePath,
  writeTelemetryState,
} from "../../src/telemetry/scheduler";
import { sendTelemetryPayload, setTelemetrySenderOverridesForTests } from "../../src/telemetry/sender";
import type { OcxConfig } from "../../src/types";
import type { PersistedUsageEntry } from "../../src/usage/log";
import { REQUEST_OUTCOME_CLASSES } from "../../src/usage/request-outcome";
import { REQUEST_FAILURE_CAUSES } from "../../src/usage/telemetry-contract";
import { usageDisplayTotalTokens } from "../../src/usage/totals";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");

describe("telemetry contract parity and validation", () => {
  test("contract module is import-free and pins outcome and failure-cause rosters", () => {
    const src = readFileSync(repoPath("src", "telemetry", "contract.ts"), "utf8");
    expect(src).not.toMatch(/^\s*(?:import|export\s+.*from)\s+/m);
    expect([...TELEMETRY_OUTCOME_CLASSES]).toEqual([...REQUEST_OUTCOME_CLASSES]);
    expect([...TELEMETRY_FAILURE_CAUSES]).toEqual([...REQUEST_FAILURE_CAUSES]);
    expect(PROVIDER_KINDS).toContain("anthropic");
    expect(MODEL_FAMILIES).toContain("claude-opus");
    expect(INSTALL_CHANNELS).toContain("npm-global");
    expect(RELEASE_CHANNELS).toEqual(["latest", "preview"]);
    expect(OS_VALUES).toEqual(["darwin", "linux", "win32", "other"]);
    expect(ARCH_VALUES).toEqual(["x64", "arm64", "other"]);
  });

  test("validateTelemetryPayloadV1 accepts a canonical payload and rejects extra keys, unknown roster values, semver metadata, and bad dates", () => {
    const base: TelemetryPayloadV1 = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      batchId: "11111111-2222-4333-8444-555555555555",
      day: "2026-11-06",
      installDayHash: "a".repeat(64),
      newInstall: false,
      env: {
        version: "2.40.1",
        releaseChannel: "latest",
        os: "darwin",
        arch: "arm64",
        installChannel: "npm-global",
      },
      activeMinutes: 312,
      requests: { completed: 840, failed: 12, incomplete: 3, aborted: 5 },
      models: [
        {
          providerKind: "anthropic",
          modelFamily: "claude-opus",
          requests: 400,
          inputTokens: 1000,
          cacheReadTokens: 2000,
          cacheWriteTokens: 500,
          outputTokens: 300,
          reasoningTokens: 100,
        },
      ],
      errors: { "rate-limit": 7 },
    };

    expect(validateTelemetryPayloadV1(base, NOW)).toEqual({ ok: true, payload: base });
    expect(validateTelemetryPayloadV1({ ...base, env: { ...base.env, version: "2.40.1-preview.3", releaseChannel: "preview" } }, NOW).ok).toBe(true);

    expect(validateTelemetryPayloadV1({ ...base, extra: 1 }, NOW).ok).toBe(false);
    expect(validateTelemetryPayloadV1({ ...base, env: { ...base.env, extra: 1 } }, NOW).ok).toBe(false);
    expect(validateTelemetryPayloadV1({ ...base, env: { ...base.env, version: "2.40.1+build.9" } }, NOW).ok).toBe(false);
    expect(validateTelemetryPayloadV1({ ...base, env: { ...base.env, installChannel: "brew" as never } }, NOW).ok).toBe(false);
    expect(validateTelemetryPayloadV1({ ...base, day: "2026-02-30" }, NOW).ok).toBe(false);
    expect(validateTelemetryPayloadV1({ ...base, day: "2026-10-20" }, NOW).ok).toBe(false);
    expect(validateTelemetryPayloadV1({ ...base, day: "2026-11-09" }, NOW).ok).toBe(false);
    expect(validateTelemetryPayloadV1({ ...base, errors: { "unknown-cause": 1 } as never }, NOW).ok).toBe(false);
    expect(
      validateTelemetryPayloadV1(
        { ...base, models: [{ ...base.models[0]!, providerKind: "custom-vendor" as never }] },
        NOW,
      ).ok,
    ).toBe(false);
    expect(
      validateTelemetryPayloadV1(
        { ...base, models: [base.models[0]!, base.models[0]!] },
        NOW,
      ).ok,
    ).toBe(false);
  });
});

describe("consent status matrix and config schema wiring", () => {
  test("resolveTelemetryStatus follows the precedence table", () => {
    expect(resolveTelemetryStatus(undefined, {})).toEqual({
      effective: false,
      reason: "awaiting-notice",
      decision: null,
      decidedAt: null,
      noticeShownAt: null,
      envOverride: null,
    });

    expect(resolveTelemetryStatus({ noticeShownAt: "2026-11-06T00:00:00.000Z" }, {})).toMatchObject({
      effective: true,
      reason: "default-on",
      decision: null,
    });

    expect(resolveTelemetryStatus({ decision: "accepted", decidedAt: "2026-11-06T00:00:00.000Z" }, {})).toMatchObject({
      effective: true,
      reason: "accepted",
      decision: "accepted",
    });

    expect(
      resolveTelemetryStatus(
        { decision: "declined", decidedAt: "2026-11-06T00:00:00.000Z", noticeShownAt: "2026-11-05T00:00:00.000Z" },
        {},
      ),
    ).toMatchObject({
      effective: false,
      reason: "declined",
      decision: "declined",
    });

    for (const val of ["0", "false", "off", "no", " FALSE "]) {
      expect(
        resolveTelemetryStatus({ decision: "accepted" }, { OCX_TELEMETRY: val, DO_NOT_TRACK: "1" }),
      ).toMatchObject({
        effective: false,
        reason: "env-ocx-telemetry",
        envOverride: "OCX_TELEMETRY",
      });
    }

    for (const val of ["1", "true", "yes", " TRUE "]) {
      expect(resolveTelemetryStatus({ decision: "accepted" }, { DO_NOT_TRACK: val })).toMatchObject({
        effective: false,
        reason: "env-do-not-track",
        envOverride: "DO_NOT_TRACK",
      });
    }
  });

  test("config diagnostics, load-degrade, and live-reconcile handle telemetry config", () => {
    expect(telemetryConfigError({ telemetry: { decision: "accepted" } })).toBeNull();
    expect(telemetryConfigError({ telemetry: { endpoint: "https://evil.example" } })).toContain("schema_invalid: telemetry");
    expect(malformedTelemetryWarning({ telemetry: { decision: "maybe" } })).toContain("telemetry.decision ignored");

    const live = { port: 10100, defaultProvider: "openai", providers: {} } as OcxConfig;
    armClaudeCodeBaseline(live);
    adoptPersistedTelemetry(live, { decision: "accepted", decidedAt: "2026-11-06T00:00:00.000Z" });
    expect(live.telemetry).toEqual({ decision: "accepted", decidedAt: "2026-11-06T00:00:00.000Z" });
    adoptPersistedTelemetry(live, undefined);
    expect(live.telemetry).toBeUndefined();
  });
});

describe("install identity, aggregation, disjoint tokens, and scheduler", () => {
  let home: string;
  const prevHome = process.env.OPENCODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-telemetry-unit-"));
    process.env.OPENCODEX_HOME = home;
    resetTelemetryInstallIdMemoForTests();
    setTelemetrySenderOverridesForTests(null);
  });

  afterEach(() => {
    resetTelemetryInstallIdMemoForTests();
    setTelemetrySenderOverridesForTests(null);
    if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prevHome;
    removeTreeWithRetry(home);
  });

  test("telemetry-id.json is created with 0o600 mode and deleted on decline", () => {
    expect(readTelemetryInstallId(home)).toBeNull();
    const first = ensureTelemetryInstallId(home);
    expect(first.freshlyCreated).toBe(true);
    const idFile = telemetryIdPath(home);
    expect(existsSync(idFile)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(idFile).mode & 0o777).toBe(0o600);
    }
    const second = ensureTelemetryInstallId(home);
    expect(second.freshlyCreated).toBe(false);
    expect(second.identity.installId).toBe(first.identity.installId);

    const hashA = computeInstallDayHash(first.identity.installId, "2026-11-05");
    const hashB = computeInstallDayHash(first.identity.installId, "2026-11-06");
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
    expect(hashA).not.toBe(hashB);

    expect(deleteTelemetryInstallId(home)).toBe(true);
    expect(existsSync(idFile)).toBe(false);
    expect(readTelemetryInstallId(home)).toBeNull();
  });

  test("aggregates a fixture ledger and preserves the disjoint token bucket identity", async () => {
    const day = "2026-11-06";
    const baseTs = Date.parse("2026-11-06T10:00:00.000Z");
    const fixtureEntries: PersistedUsageEntry[] = [
      {
        requestId: "req-1",
        timestamp: baseTs + 5_000,
        provider: "anthropic-p123456",
        model: "claude-opus-4-6",
        status: 200,
        terminalStatus: "completed",
        durationMs: 1200,
        usageStatus: "reported",
        usage: {
          inputTokens: 1000,
          cacheReadInputTokens: 600,
          cacheCreationInputTokens: 150,
          outputTokens: 400,
          reasoningOutputTokens: 120,
        },
      },
      {
        requestId: "req-2",
        timestamp: baseTs + 25_000,
        provider: "my-custom-secret-provider",
        model: "gpt-5.3-codex",
        status: 429,
        terminalStatus: "failed",
        failureCause: "rate-limit",
        durationMs: 300,
        usageStatus: "reported",
        usage: {
          inputTokens: 500,
          outputTokens: 50,
        },
      },
      {
        requestId: "req-3",
        timestamp: baseTs + 90_000,
        provider: "openai",
        model: "o3-mini",
        status: 499,
        closeReason: "client_cancel",
        failureCause: "client-cancelled",
        durationMs: 100,
        usageStatus: "unreported",
      },
      {
        requestId: "req-other-day",
        timestamp: Date.parse("2026-11-05T23:59:59.000Z"),
        provider: "openai",
        model: "gpt-5",
        status: 200,
        durationMs: 100,
        usageStatus: "reported",
        usage: { inputTokens: 9999, outputTokens: 9999 },
      },
    ];

    writeFileSync(
      join(home, "usage.jsonl"),
      fixtureEntries.map(row => JSON.stringify(row)).join("\n") + "\n",
      "utf8",
    );

    for (const entry of fixtureEntries) {
      if (!entry.usage) continue;
      const buckets = disjointTelemetryTokens(entry.usage);
      const sum =
        buckets.inputTokens
        + buckets.cacheReadTokens
        + buckets.cacheWriteTokens
        + buckets.outputTokens
        + buckets.reasoningTokens;
      expect(sum).toBe(usageDisplayTotalTokens(entry.usage)!);
    }

    const agg = await aggregateTelemetryForDay(day);
    expect(agg.activeMinutes).toBe(2);
    expect(agg.requests).toEqual({ completed: 1, failed: 1, incomplete: 0, aborted: 1 });
    expect(agg.errors).toEqual({ "rate-limit": 1, "client-cancelled": 1 });
    expect(agg.models).toEqual([
      {
        providerKind: "anthropic",
        modelFamily: "claude-opus",
        requests: 1,
        inputTokens: 250,
        cacheReadTokens: 600,
        cacheWriteTokens: 150,
        outputTokens: 280,
        reasoningTokens: 120,
      },
      {
        providerKind: "other",
        modelFamily: "gpt-5",
        requests: 1,
        inputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 50,
        reasoningTokens: 0,
      },
      {
        providerKind: "openai",
        modelFamily: "o-series",
        requests: 1,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
    ]);
    expect(JSON.stringify(agg)).not.toContain("my-custom-secret-provider");
    expect(classifyProviderKind("google-vertex")).toBe("vertex");
    expect(classifyModelFamily("deepseek/deepseek-r1")).toBe("deepseek");
    expect(aggregateTelemetryEntriesForDay(day, []).activeMinutes).toBe(0);
  });

  test("disjointTelemetryTokens legacy fallback keeps 5-bucket sum equal to usageDisplayTotalTokens and ACCOUNT_SUFFIX_RE matches k + 32 hex", () => {
    const legacyUsage = {
      inputTokens: 250,
      cacheReadInputTokens: 600,
      cacheCreationInputTokens: 150,
      outputTokens: 400,
      reasoningOutputTokens: 120,
      totalTokens: 1400,
    };
    const buckets = disjointTelemetryTokens(legacyUsage);
    const sum =
      buckets.inputTokens
      + buckets.cacheReadTokens
      + buckets.cacheWriteTokens
      + buckets.outputTokens
      + buckets.reasoningTokens;
    expect(sum).toBe(usageDisplayTotalTokens(legacyUsage)!);
    expect(buckets.inputTokens).toBe(750);
    expect(buckets.cacheReadTokens).toBe(100);
    expect(buckets.cacheWriteTokens).toBe(150);
    expect(buckets.outputTokens).toBe(280);
    expect(buckets.reasoningTokens).toBe(120);

    expect(classifyProviderKind(`openai-k${"a1b2c3d4".repeat(4)}`)).toBe("openai");
    expect(classifyProviderKind("openai-p123456")).toBe("openai");
    expect(classifyProviderKind("openai-o123456")).toBe("openai");
    expect(classifyProviderKind("openai-k123456")).toBe("other");
  });

  test("installChannel mapping covers desktop, docker, and package managers", () => {
    expect(resolveInstallChannel({ env: { OCX_DESKTOP_SUPERVISED: "1" } })).toBe("desktop");
    expect(resolveInstallChannel({ env: {}, exists: p => p === "/.dockerenv" })).toBe("docker");
    expect(resolveInstallChannel({ env: {}, exists: () => false, detectOwnership: () => ({ installer: "npm" }) })).toBe("npm-global");
    expect(resolveInstallChannel({ env: {}, exists: () => false, detectOwnership: () => ({ installer: "pnpm" }) })).toBe("pnpm-global");
    expect(resolveInstallChannel({ env: {}, exists: () => false, detectOwnership: () => ({ installer: "bun" }) })).toBe("bun-global");
    expect(resolveInstallChannel({ env: {}, exists: () => false, detectOwnership: () => ({ installer: "mise" }) })).toBe("mise");
    expect(resolveInstallChannel({ env: {}, exists: () => false, detectOwnership: () => ({ installer: "standalone" }) })).toBe("standalone");
    expect(resolveInstallChannel({ env: {}, exists: () => false, detectOwnership: () => ({ installer: "source" }) })).toBe("source");
    expect(resolveInstallChannel({ env: {}, exists: () => false, detectOwnership: () => ({ installer: "mystery" }) })).toBe("unknown");
  });

  test("scheduler sends nothing when not effective, skips pre-consent days, and sends at most one day per tick oldest first", async () => {
    const sentPayloads: TelemetryPayloadV1[] = [];
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentPayloads.push(JSON.parse(String(init?.body)) as TelemetryPayloadV1);
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }) as unknown as typeof fetch;

    // 1. Undecided without notice -> nothing sent, no id created.
    const resAwaiting = await runTelemetryTick({
      configDir: home,
      config: {},
      env: {},
      now: NOW,
      fetch: mockFetch,
    });
    expect(resAwaiting.sent).toBe(false);
    expect(resAwaiting.reason).toBe("awaiting-notice");
    expect(readTelemetryInstallId(home)).toBeNull();
    expect(sentPayloads).toHaveLength(0);

    // 2. Consent given on 2026-11-05 -> 2026-11-04 and earlier are never backfilled;
    // first tick sends 2026-11-05 (oldest post-consent day) with newInstall=true,
    // second tick sends 2026-11-06 with newInstall=false,
    // third tick finds nothing left.
    const config = {
      telemetry: {
        decision: "accepted" as const,
        decidedAt: "2026-11-05T15:30:00.000Z",
        noticeShownAt: "2026-11-05T15:30:00.000Z",
      },
    };
    const tick1 = await runTelemetryTick({
      configDir: home,
      config,
      env: {},
      now: NOW,
      fetch: mockFetch,
    });
    expect(tick1).toMatchObject({ sent: true, day: "2026-11-05" });
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]!.day).toBe("2026-11-05");
    expect(sentPayloads[0]!.newInstall).toBe(true);

    const tick2 = await runTelemetryTick({
      configDir: home,
      config,
      env: {},
      now: NOW,
      fetch: mockFetch,
    });
    expect(tick2).toMatchObject({ sent: true, day: "2026-11-06" });
    expect(sentPayloads).toHaveLength(2);
    expect(sentPayloads[1]!.day).toBe("2026-11-06");
    expect(sentPayloads[1]!.newInstall).toBe(false);

    const tick3 = await runTelemetryTick({
      configDir: home,
      config,
      env: {},
      now: NOW,
      fetch: mockFetch,
    });
    expect(tick3).toEqual({ sent: false, reason: "up-to-date" });
    expect(readTelemetryState(home).lastSentDay).toBe("2026-11-06");

    // Deleting the install id after a successful tick leaves no trace of the raw installId in configDir.
    const rawInstallId = readTelemetryInstallId(home)!.installId;
    expect(deleteTelemetryInstallId(home)).toBe(true);
    for (const entry of readdirSync(home)) {
      const full = join(home, entry);
      if (lstatSync(full).isFile()) {
        expect(readFileSync(full, "utf8")).not.toContain(rawInstallId);
      }
    }
  });

  test("writeTelemetryState replaces a symlinked telemetry-state.json without following it", () => {
    const victim = join(home, "victim.txt");
    writeFileSync(victim, "preserve-me", "utf8");
    const stateFile = telemetryStatePath(home);
    symlinkSync(victim, stateFile);
    expect(lstatSync(stateFile).isSymbolicLink()).toBe(true);

    writeTelemetryState(
      {
        version: 1,
        sentDays: { "2026-11-06": "2026-11-07T00:00:00.000Z" },
        lastSentDay: "2026-11-06",
        lastSentAt: "2026-11-07T00:00:00.000Z",
      } as never,
      home,
      NOW,
    );

    expect(readFileSync(victim, "utf8")).toBe("preserve-me");
    expect(lstatSync(stateFile).isSymbolicLink()).toBe(false);
    expect(readTelemetryState(home).lastSentDay).toBe("2026-11-06");
  });

  test("nudgeTelemetryScheduler clears previous nudge timer and runtime env opt-out stops the scheduler in both nudge and tick", async () => {
    const prevEnv = process.env.OCX_TELEMETRY;
    const prevDnt = process.env.DO_NOT_TRACK;
    delete process.env.OCX_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    const clearSpy = spyOn(globalThis, "clearTimeout");
    try {
      startTelemetryScheduler({ startupDelayMs: 60_000, intervalMs: 60_000 });
      clearSpy.mockClear();
      // First nudge clears startupTimer (1 call); second and third nudges clear the prior nudgeTimer.
      nudgeTelemetryScheduler();
      nudgeTelemetryScheduler();
      nudgeTelemetryScheduler();
      expect(clearSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

      // Setting OCX_TELEMETRY=0 at runtime stops the scheduler when nudged.
      process.env.OCX_TELEMETRY = "0";
      nudgeTelemetryScheduler();
      delete process.env.OCX_TELEMETRY;

      // Because the scheduler stopped, a subsequent nudge is a no-op and sets no new timer.
      clearSpy.mockClear();
      nudgeTelemetryScheduler();
      expect(clearSpy.mock.calls.length).toBe(0);

      // Restart and set DO_NOT_TRACK=1 before startupTimer fires triggerBackgroundTick:
      startTelemetryScheduler({ startupDelayMs: 5, intervalMs: 60_000 });
      process.env.DO_NOT_TRACK = "1";
      await new Promise(resolve => setTimeout(resolve, 25));
      delete process.env.DO_NOT_TRACK;
      clearSpy.mockClear();
      nudgeTelemetryScheduler();
      expect(clearSpy.mock.calls.length).toBe(0);
    } finally {
      stopTelemetryScheduler();
      clearSpy.mockRestore();
      if (prevEnv === undefined) delete process.env.OCX_TELEMETRY;
      else process.env.OCX_TELEMETRY = prevEnv;
      if (prevDnt === undefined) delete process.env.DO_NOT_TRACK;
      else process.env.DO_NOT_TRACK = prevDnt;
    }
  });

  test("sendTelemetryPayload enforces its timeout and does not retry", async () => {
    const agg = aggregateTelemetryEntriesForDay("2026-11-06", []);
    const payload = buildTelemetryPayloadV1({
      aggregate: agg,
      installDayHash: "b".repeat(64),
      newInstall: false,
      now: NOW,
    });
    let calls = 0;
    const slowFetch = ((_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted by timeout"));
        });
      });
    }) as unknown as typeof fetch;
    const result = await sendTelemetryPayload(payload, {
      fetch: slowFetch,
      timeoutMs: 25,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  test("readConfigDiagnostics passively reads persisted telemetry config", () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        port: 10100,
        defaultProvider: "openai",
        providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
        telemetry: { decision: "accepted", decidedAt: "2026-11-06T00:00:00.000Z" },
      }),
      "utf8",
    );
    const diag = readConfigDiagnostics({ passive: true });
    expect(diag.error).toBeNull();
    expect(diag.config.telemetry?.decision).toBe("accepted");
  });
});
