import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
  createDailyTelemetryAccumulator,
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
import { buildTelemetryPayloadV1, normalizeTelemetryVersion, resolveInstallChannel } from "../../src/telemetry/payload";
import { buildTelemetryStatusSnapshot } from "../../src/telemetry/routes";
import {
  computeTelemetryIntervalDelayMs,
  computeTelemetryStartupDelayMs,
  nudgeTelemetryScheduler,
  endTelemetryEnvOptOut,
  readTelemetryState,
  readTelemetryStateFile,
  recordPendingTelemetryDecision,
  recordTelemetryEnvOptOut,
  runTelemetryTick,
  startTelemetryScheduler,
  stopTelemetryScheduler,
  telemetryStatePath,
  writeTelemetryState,
} from "../../src/telemetry/scheduler";
import {
  parseRetryAfterMs,
  sendTelemetryPayload,
  setTelemetrySenderOverridesForTests,
} from "../../src/telemetry/sender";
import { acquireServerBackgroundLifecycle, setTelemetryEnvOptOutRefreshMsForTests } from "../../src/server/background-lifecycle";
import { clearPendingTelemetryDecision } from "../../src/telemetry/state";
import type { OcxConfig } from "../../src/types";
import type { PersistedUsageEntry } from "../../src/usage/log";
import { REQUEST_OUTCOME_CLASSES } from "../../src/usage/request-outcome";
import { REQUEST_FAILURE_CAUSES } from "../../src/usage/telemetry-contract";
import { usageDisplayTotalTokens } from "../../src/usage/totals";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");

function rmIfExists(path: string): void {
  try {
    if (lstatSync(path)) {
      unlinkSync(path);
    }
  } catch { /* ignore */ }
}

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
    for (const validPreview of [
      "2.6.15-preview.20260701",
      "2.6.15-preview.20260701.1",
      "2.7.9-preview.20260712.2",
    ]) {
      expect(
        validateTelemetryPayloadV1(
          { ...base, env: { ...base.env, version: validPreview, releaseChannel: "preview" } },
          NOW,
        ).ok,
      ).toBe(true);
      expect(normalizeTelemetryVersion(validPreview)).toEqual({
        version: validPreview,
        releaseChannel: "preview",
      });
    }
    expect(normalizeTelemetryVersion("2.40.1")).toEqual({
      version: "2.40.1",
      releaseChannel: "latest",
    });

    expect(validateTelemetryPayloadV1({ ...base, extra: 1 }, NOW).ok).toBe(false);
    expect(validateTelemetryPayloadV1({ ...base, env: { ...base.env, extra: 1 } }, NOW).ok).toBe(false);
    expect(validateTelemetryPayloadV1({ ...base, env: { ...base.env, version: "2.40.1+build.9" } }, NOW).ok).toBe(false);
    expect(validateTelemetryPayloadV1({ ...base, env: { ...base.env, version: "2.6.15-preview.20260701+build.1", releaseChannel: "preview" } }, NOW).ok).toBe(false);
    expect(validateTelemetryPayloadV1({ ...base, env: { ...base.env, version: "2.40.1-preview.3", releaseChannel: "preview" } }, NOW).ok).toBe(false);
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

    expect(resolveTelemetryStatus({ telemetry: { noticeShownAt: "2026-11-06T00:00:00.000Z" } }, {})).toMatchObject({
      effective: true,
      reason: "default-on",
      decision: null,
    });

    expect(resolveTelemetryStatus({ telemetry: { decision: "accepted", decidedAt: "2026-11-06T00:00:00.000Z" } }, {})).toMatchObject({
      effective: true,
      reason: "accepted",
      decision: "accepted",
    });

    expect(
      resolveTelemetryStatus(
        { telemetry: { decision: "declined", decidedAt: "2026-11-06T00:00:00.000Z", noticeShownAt: "2026-11-05T00:00:00.000Z" } },
        {},
      ),
    ).toMatchObject({
      effective: false,
      reason: "declined",
      decision: "declined",
    });

    for (const val of ["0", "false", "off", "no", " FALSE "]) {
      expect(
        resolveTelemetryStatus({ telemetry: { decision: "accepted" } }, { OCX_TELEMETRY: val, DO_NOT_TRACK: "1" }),
      ).toMatchObject({
        effective: false,
        reason: "env-ocx-telemetry",
        envOverride: "OCX_TELEMETRY",
      });
    }

    for (const val of ["1", "true", "yes", " TRUE "]) {
      expect(resolveTelemetryStatus({ telemetry: { decision: "accepted" } }, { DO_NOT_TRACK: val })).toMatchObject({
        effective: false,
        reason: "env-do-not-track",
        envOverride: "DO_NOT_TRACK",
      });
    }
  });

  test("consent is read only from the telemetry block, never from top-level config keys", async () => {
    // `ocx config set noticeShownAt …` writes a top-level key; it must not count as the notice.
    const topLevel = { noticeShownAt: "2026-01-01T00:00:00.000Z", decision: "accepted", decidedAt: "2026-01-01T00:00:00.000Z" };
    expect(resolveTelemetryStatus(topLevel as never, {})).toMatchObject({ effective: false, reason: "awaiting-notice", decision: null });
    const home = mkdtempSync(join(tmpdir(), "ocx-telemetry-toplevel-"));
    try {
      let fetchCalls = 0;
      const result = await runTelemetryTick({
        configDir: home,
        readConfig: () => topLevel as never,
        env: {},
        now: Date.parse("2026-11-07T12:00:00.000Z"),
        fetch: (async () => {
          fetchCalls += 1;
          return new Response("{}", { status: 202 });
        }) as unknown as typeof fetch,
      });
      expect(result).toMatchObject({ sent: false, reason: "awaiting-notice" });
      expect(fetchCalls).toBe(0);
    } finally {
      removeTreeWithRetry(home);
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

    // D8: createDailyTelemetryAccumulator accumulates inside onEntry for target day only and retains no rows.
    const acc = createDailyTelemetryAccumulator(day);
    expect(Object.keys(acc).sort()).toEqual(["finalize", "onEntry"]);
    for (const row of fixtureEntries) acc.onEntry(row);
    expect(acc.finalize()).toEqual(agg);
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

  test("nothing is ever sent before noticeShownAt, however long the proxy runs undecided", async () => {
    let fetchCalls = 0;
    const sentDays: string[] = [];
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCalls += 1;
      sentDays.push((JSON.parse(String(init?.body)) as TelemetryPayloadV1).day);
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }) as unknown as typeof fetch;
    // Undecided installs with no recorded notice: an absent block, an empty block, and explicit nulls.
    const undisclosed: Array<Pick<OcxConfig, "telemetry">> = [
      {},
      { telemetry: {} },
      { telemetry: { decision: null, decidedAt: null, noticeShownAt: null } },
    ] as Array<Pick<OcxConfig, "telemetry">>;
    for (const config of undisclosed) {
      for (let day = 0; day < 10; day++) {
        for (const hour of ["00:30", "06:30", "12:30", "18:30"]) {
          const now = Date.parse(`2026-11-${String(day + 1).padStart(2, "0")}T${hour}:00.000Z`);
          const result = await runTelemetryTick({ configDir: home, config, env: {}, now, fetch: mockFetch });
          expect(result).toEqual({ sent: false, reason: "awaiting-notice" });
        }
      }
    }
    expect(fetchCalls).toBe(0);
    expect(readTelemetryInstallId(home)).toBeNull();
    expect(readTelemetryState(home).sentDays).toEqual({});

    // The notice is shown on 2026-11-10; only completed days after it are ever sent.
    const disclosed = { telemetry: { decision: null, decidedAt: null, noticeShownAt: "2026-11-10T09:00:00.000Z" } } as Pick<OcxConfig, "telemetry">;
    expect((await runTelemetryTick({ configDir: home, config: disclosed, env: {}, now: Date.parse("2026-11-11T12:00:00.000Z"), fetch: mockFetch })).sent).toBe(false);
    expect(await runTelemetryTick({ configDir: home, config: disclosed, env: {}, now: Date.parse("2026-11-12T12:00:00.000Z"), fetch: mockFetch })).toMatchObject({ sent: true, day: "2026-11-11" });
    expect(sentDays).toEqual(["2026-11-11"]);
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
    // 2. D1: Consent given on 2026-11-04 -> 2026-11-04 (the consent day itself) and earlier are NEVER sent;
    // only UTC days strictly AFTER 2026-11-04 (i.e. 2026-11-05, 2026-11-06) are eligible.
    const config = {
      telemetry: {
        decision: "accepted" as const,
        decidedAt: "2026-11-04T15:30:00.000Z",
        noticeShownAt: "2026-11-04T15:30:00.000Z",
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

    // Consent given on 2026-11-06 (yesterday) when today is 2026-11-07 -> 2026-11-06 is the consent day itself,
    // so no completed UTC day is strictly after 2026-11-06 yet.
    const sameDayHome = mkdtempSync(join(tmpdir(), "ocx-telemetry-sameday-"));
    try {
      const resSameDay = await runTelemetryTick({
        configDir: sameDayHome,
        config: {
          telemetry: {
            decision: "accepted",
            decidedAt: "2026-11-06T23:59:00.000Z",
            noticeShownAt: "2026-11-06T23:59:00.000Z",
          },
        },
        env: {},
        now: NOW,
        fetch: mockFetch,
      });
      expect(resSameDay).toEqual({ sent: false, reason: "up-to-date" });
    } finally {
      removeTreeWithRetry(sameDayHome);
    }
  });

  test("D2: env opt-out at startup or tick persists ineligibleThroughDay, deletes the install id, never backfills opt-out days, and mints a fresh id later", async () => {
    const sentPayloads: TelemetryPayloadV1[] = [];
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentPayloads.push(JSON.parse(String(init?.body)) as TelemetryPayloadV1);
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }) as unknown as typeof fetch;

    const config = {
      telemetry: {
        decision: "accepted" as const,
        decidedAt: "2026-11-01T10:00:00.000Z",
        noticeShownAt: "2026-11-01T10:00:00.000Z",
      },
    };

    // Day 2026-11-03: sends 2026-11-02 and mints initial installId
    const day3Now = Date.parse("2026-11-03T12:00:00.000Z");
    const firstTick = await runTelemetryTick({
      configDir: home,
      config,
      env: {},
      now: day3Now,
      fetch: mockFetch,
    });
    expect(firstTick).toMatchObject({ sent: true, day: "2026-11-02" });
    const originalInstallId = readTelemetryInstallId(home)!.installId;
    expect(typeof originalInstallId).toBe("string");

    // User starts proxy in background-lifecycle with OCX_TELEMETRY=0 on 2026-11-03:
    const prevTelemetry = process.env.OCX_TELEMETRY;
    process.env.OCX_TELEMETRY = "0";
    try {
      const lease = acquireServerBackgroundLifecycle(() => {}, {
        port: 0,
        defaultProvider: "openai",
        providers: {},
      } as unknown as OcxConfig);
      await lease.release();
    } finally {
      if (prevTelemetry === undefined) delete process.env.OCX_TELEMETRY;
      else process.env.OCX_TELEMETRY = prevTelemetry;
    }
    expect(readTelemetryInstallId(home)).toBeNull();
    expect(existsSync(telemetryIdPath(home))).toBe(false);
    expect(readTelemetryState(home).ineligibleThroughDay).not.toBeNull();

    // Reset state to simulate consecutive opt-out days 2026-11-03, 2026-11-04, 2026-11-05:
    writeTelemetryState(
      {
        version: 1,
        sentDays: { "2026-11-02": "2026-11-03T12:00:00.000Z" },
        lastSentDay: "2026-11-02",
        lastSentAt: "2026-11-03T12:00:00.000Z",
        ineligibleThroughDay: null,
        retryAfterUntil: null,
      },
      home,
      day3Now,
    );
    ensureTelemetryInstallId(home);
    expect(readTelemetryInstallId(home)).not.toBeNull();

    for (const [dayIso, env] of [
      ["2026-11-03T18:00:00.000Z", { OCX_TELEMETRY: "0" }],
      ["2026-11-04T18:00:00.000Z", { DO_NOT_TRACK: "1" }],
      ["2026-11-05T18:00:00.000Z", { OCX_TELEMETRY: "false" }],
    ] as const) {
      const optOutTick = await runTelemetryTick({
        configDir: home,
        config,
        env,
        now: Date.parse(dayIso),
        fetch: mockFetch,
      });
      expect(optOutTick.sent).toBe(false);
      expect(readTelemetryInstallId(home)).toBeNull();
    }
    expect(readTelemetryState(home).ineligibleThroughDay).toBe("2026-11-05");

    // User removes OCX_TELEMETRY=0 on 2026-11-06. Nothing marked the end of the opt-out, so the first
    // tick without it ends the period on its own day: 2026-11-03..2026-11-06 are never sent.
    const day6Tick = await runTelemetryTick({
      configDir: home,
      config,
      env: {},
      now: Date.parse("2026-11-06T12:00:00.000Z"),
      fetch: mockFetch,
    });
    expect(day6Tick).toEqual({ sent: false, reason: "up-to-date" });
    expect(readTelemetryState(home)).toMatchObject({ ineligibleThroughDay: "2026-11-06", envOptOutActiveSince: null });
    expect(sentPayloads).toHaveLength(1);

    const day7Tick = await runTelemetryTick({
      configDir: home,
      config,
      env: {},
      now: NOW,
      fetch: mockFetch,
    });
    expect(day7Tick).toEqual({ sent: false, reason: "up-to-date" });

    // On 2026-11-08, day 2026-11-07 (strictly after ineligibleThroughDay 2026-11-06) is sent with a fresh installId and newInstall=true:
    const day8Tick = await runTelemetryTick({
      configDir: home,
      config,
      env: {},
      now: Date.parse("2026-11-08T12:00:00.000Z"),
      fetch: mockFetch,
    });
    expect(day8Tick).toMatchObject({ sent: true, day: "2026-11-07" });
    expect(sentPayloads).toHaveLength(2);
    expect(sentPayloads[1]!.day).toBe("2026-11-07");
    expect(sentPayloads[1]!.newInstall).toBe(true);
    const rotatedInstallId = readTelemetryInstallId(home)!.installId;
    expect(rotatedInstallId).not.toBe(originalInstallId);

    // Also verify recordTelemetryEnvOptOut replaces a symlinked telemetry-state.json without following it:
    const victim = join(home, "optout-victim.txt");
    writeFileSync(victim, "keep-safe", "utf8");
    const stateFile = telemetryStatePath(home);
    rmIfExists(stateFile);
    symlinkSync(victim, stateFile);
    recordTelemetryEnvOptOut(home, NOW);
    expect(readFileSync(victim, "utf8")).toBe("keep-safe");
    expect(lstatSync(stateFile).isSymbolicLink()).toBe(false);
    expect(readTelemetryState(home).ineligibleThroughDay).toBe("2026-11-07");
  });

  describe("D2: a proxy running under an env opt-out for several days", () => {
    const config = {
      telemetry: {
        decision: "accepted" as const,
        decidedAt: "2026-10-30T10:00:00.000Z",
        noticeShownAt: "2026-10-30T10:00:00.000Z",
      },
    };
    const proxyConfig = { port: 0, defaultProvider: "openai", providers: {} } as unknown as OcxConfig;
    let sentDays: string[];
    let prevTelemetry: string | undefined;
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentDays.push((JSON.parse(String(init?.body)) as TelemetryPayloadV1).day);
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }) as unknown as typeof fetch;
    const tickAt = (iso: string) =>
      runTelemetryTick({ configDir: home, config, env: {}, now: Date.parse(iso), fetch: mockFetch });
    // The proxy reads the env once, when its background lifecycle starts; it runs no ticks while opted out.
    const startOptedOutProxy = (iso: string) => {
      setSystemTime(new Date(iso));
      process.env.OCX_TELEMETRY = "0";
      try {
        return acquireServerBackgroundLifecycle(() => {}, proxyConfig);
      } finally {
        delete process.env.OCX_TELEMETRY;
      }
    };

    beforeEach(() => {
      sentDays = [];
      prevTelemetry = process.env.OCX_TELEMETRY;
    });

    afterEach(() => {
      setSystemTime();
      if (prevTelemetry === undefined) delete process.env.OCX_TELEMETRY;
      else process.env.OCX_TELEMETRY = prevTelemetry;
    });

    test("never sends its opt-out days when it did not stop cleanly before a normal proxy ticks", async () => {
      const lease = startOptedOutProxy("2026-11-02T09:00:00.000Z");
      try {
        // Monday through Thursday ran opted out, then the proxy crashed: its recorded pid is gone.
        const crashed = readTelemetryState(home);
        expect(crashed.envOptOutOwners?.map(owner => owner.pid)).toEqual([process.pid]);
        writeTelemetryState({ ...crashed, envOptOutOwners: [{ pid: 2_000_000_000, since: crashed.envOptOutOwners![0]!.since }] }, home);
        // A normal proxy takes over on Friday.
        setSystemTime(new Date("2026-11-06T12:00:00.000Z"));
        expect((await tickAt("2026-11-06T12:00:00.000Z")).sent).toBe(false);
        expect((await tickAt("2026-11-07T12:00:00.000Z")).sent).toBe(false);
        expect(await tickAt("2026-11-08T12:00:00.000Z")).toMatchObject({ sent: true, day: "2026-11-07" });
        expect(sentDays).toEqual(["2026-11-07"]);
      } finally {
        await lease.release();
      }
    });

    test("never sends its opt-out days after it stops cleanly", async () => {
      const lease = startOptedOutProxy("2026-11-02T09:00:00.000Z");
      setSystemTime(new Date("2026-11-05T20:00:00.000Z"));
      await lease.release();
      setSystemTime(new Date("2026-11-06T12:00:00.000Z"));
      expect(await tickAt("2026-11-06T12:00:00.000Z")).toEqual({ sent: false, reason: "up-to-date" });
      expect(await tickAt("2026-11-07T12:00:00.000Z")).toMatchObject({ sent: true, day: "2026-11-06" });
      expect(sentDays).toEqual(["2026-11-06"]);
    });
  });

  test("an unreachable or undeployed collector fails the tick quietly and leaves the day for a later retry", async () => {
    const config = {
      telemetry: {
        decision: "accepted" as const,
        decidedAt: "2026-11-01T10:00:00.000Z",
        noticeShownAt: "2026-11-01T10:00:00.000Z",
      },
    };
    const consoleSpies = [spyOn(console, "error"), spyOn(console, "warn"), spyOn(console, "log")];
    try {
      const dnsFailure = (async () => {
        throw new TypeError("getaddrinfo ENOTFOUND telemetry.opencodex.me");
      }) as unknown as typeof fetch;
      const notDeployed = (async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
      for (const fetchImpl of [dnsFailure, notDeployed]) {
        const result = await runTelemetryTick({ configDir: home, config, env: {}, now: NOW, fetch: fetchImpl });
        expect(result).toMatchObject({ sent: false, day: "2026-11-02", reason: "send-failed" });
        expect(readTelemetryState(home).sentDays).toEqual({});
        expect(readTelemetryState(home).retryAfterUntil).toBeNull();
      }
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  test("an id minted after an opt-out reports as a returning install, not a new one", async () => {
    const sent: TelemetryPayloadV1[] = [];
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as TelemetryPayloadV1);
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }) as unknown as typeof fetch;
    const config = {
      telemetry: { decision: "accepted" as const, decidedAt: "2026-11-01T10:00:00.000Z", noticeShownAt: "2026-11-01T10:00:00.000Z" },
    };
    expect(await runTelemetryTick({ configDir: home, config, env: {}, now: Date.parse("2026-11-03T12:00:00.000Z"), fetch: mockFetch })).toMatchObject({ sent: true });
    expect(sent[0]!.newInstall).toBe(true);
    // A decline or env opt-out deletes the id; the next accepted send mints a fresh one.
    deleteTelemetryInstallId(home);
    expect(await runTelemetryTick({ configDir: home, config, env: {}, now: Date.parse("2026-11-04T12:00:00.000Z"), fetch: mockFetch })).toMatchObject({ sent: true });
    expect(sent[1]!.newInstall).toBe(false);
    expect(readTelemetryState(home).everReported).toBe(true);
  });

  test("D2: a proxy without the opt-out never ends the period of an opted-out proxy that is still running", async () => {
    const sentDays: string[] = [];
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentDays.push((JSON.parse(String(init?.body)) as TelemetryPayloadV1).day);
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }) as unknown as typeof fetch;
    const config = {
      telemetry: { decision: "accepted" as const, decidedAt: "2026-10-30T10:00:00.000Z", noticeShownAt: "2026-10-30T10:00:00.000Z" },
    };
    const tickAt = (iso: string) => runTelemetryTick({ configDir: home, config, env: {}, now: Date.parse(iso), fetch: mockFetch });

    // Process B (this test process, so it is alive) starts opted out on 2026-11-02 and keeps running.
    recordTelemetryEnvOptOut(home, Date.parse("2026-11-02T09:00:00.000Z"), process.pid);
    // Process A, sharing the home without the opt-out, ticks on the same and later days.
    expect((await tickAt("2026-11-02T12:00:00.000Z")).sent).toBe(false);
    expect((await tickAt("2026-11-04T12:00:00.000Z")).sent).toBe(false);
    expect(sentDays).toEqual([]);
    expect(readTelemetryState(home).ineligibleThroughDay).toBe("2026-11-04");

    // B stops cleanly on 2026-11-05: every day through its stop day stays unsent.
    endTelemetryEnvOptOut(home, Date.parse("2026-11-05T08:00:00.000Z"), process.pid);
    expect((await tickAt("2026-11-06T12:00:00.000Z")).sent).toBe(false);
    expect(await tickAt("2026-11-07T12:00:00.000Z")).toMatchObject({ sent: true, day: "2026-11-06" });
    expect(sentDays).toEqual(["2026-11-06"]);
  });

  test("D2: an opted-out proxy that died is closed by the next tick", async () => {
    const config = {
      telemetry: { decision: "accepted" as const, decidedAt: "2026-10-30T10:00:00.000Z", noticeShownAt: "2026-10-30T10:00:00.000Z" },
    };
    // A pid far above any real one stands for a process that has exited.
    recordTelemetryEnvOptOut(home, Date.parse("2026-11-02T09:00:00.000Z"), 2_000_000_000);
    const result = await runTelemetryTick({ configDir: home, config, env: {}, now: Date.parse("2026-11-04T12:00:00.000Z"), fetch: (async () => new Response("{}", { status: 202 })) as unknown as typeof fetch });
    expect(result.sent).toBe(false);
    expect(readTelemetryState(home)).toMatchObject({ ineligibleThroughDay: "2026-11-04", envOptOutActiveSince: null });
    expect(readTelemetryState(home).envOptOutOwners ?? []).toEqual([]);
  });

  test("an unreadable telemetry-state.json blocks sending instead of forgetting opt-out days", async () => {
    let fetchCalls = 0;
    const mockFetch = (async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const config = {
      telemetry: { decision: "accepted" as const, decidedAt: "2026-10-30T10:00:00.000Z", noticeShownAt: "2026-10-30T10:00:00.000Z" },
    };
    writeFileSync(telemetryStatePath(home), "{ not json", "utf8");
    expect(await runTelemetryTick({ configDir: home, config, env: {}, now: NOW, fetch: mockFetch })).toEqual({ sent: false, reason: "state-unreadable" });
    expect(fetchCalls).toBe(0);
    // The status shows nothing eligible while every tick refuses to send.
    expect((await buildTelemetryStatusSnapshot(config, { configDir: home, env: {}, now: NOW })).previewEligible).toBe(false);
    // A writer that replaces the unreadable file keeps every day through today unsent.
    recordTelemetryEnvOptOut(home, NOW);
    expect(readTelemetryState(home).ineligibleThroughDay).toBe("2026-11-07");
    writeFileSync(telemetryStatePath(home), "{ not json", "utf8");
    recordPendingTelemetryDecision({ decision: "declined", decidedAt: "2026-11-07T10:00:00.000Z", noticeShownAt: "2026-11-07T10:00:00.000Z" }, home, NOW);
    expect(readTelemetryState(home).ineligibleThroughDay).toBe("2026-11-07");
  });

  test("a state file that becomes unreadable during a send keeps its protection, so opt-out days are never sent", async () => {
    const statePath = telemetryStatePath(home);
    const sentDays: string[] = [];
    let corruptOnSend = false;
    let reply = () => new Response("{}", { status: 202 });
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentDays.push((JSON.parse(String(init?.body)) as TelemetryPayloadV1).day);
      if (corruptOnSend) writeFileSync(statePath, "{ not json", "utf8");
      return reply();
    }) as unknown as typeof fetch;
    const config = {
      telemetry: { decision: "accepted" as const, decidedAt: "2026-10-30T10:00:00.000Z", noticeShownAt: "2026-10-30T10:00:00.000Z" },
    };
    const tickAt = (iso: string) => runTelemetryTick({ configDir: home, config, env: {}, now: Date.parse(iso), fetch: mockFetch });

    // An env opt-out covers every day through 2026-11-05.
    recordTelemetryEnvOptOut(home, Date.parse("2026-11-03T09:00:00.000Z"));
    expect((await tickAt("2026-11-05T12:00:00.000Z")).sent).toBe(false);
    expect(readTelemetryState(home).ineligibleThroughDay).toBe("2026-11-05");

    // A 429 arrives while the file is being corrupted: the backoff write must not replace it.
    corruptOnSend = true;
    reply = () => new Response("{}", { status: 429, headers: { "retry-after": "60" } });
    expect(await tickAt("2026-11-07T12:00:00.000Z")).toMatchObject({ sent: false, reason: "retry-after-backoff" });
    expect(readTelemetryStateFile(home).unreadable).toBe(true);

    // A send that succeeds while the file is corrupted must not replace it either.
    writeFileSync(statePath, JSON.stringify({ version: 1, sentDays: {}, ineligibleThroughDay: "2026-11-05" }), "utf8");
    reply = () => new Response("{}", { status: 202 });
    expect(await tickAt("2026-11-07T13:00:00.000Z")).toMatchObject({ sent: true, day: "2026-11-06" });
    expect(readTelemetryStateFile(home).unreadable).toBe(true);
    // Every later tick refuses, so no day through 2026-11-05 is ever sent.
    corruptOnSend = false;
    expect(await tickAt("2026-11-09T12:00:00.000Z")).toEqual({ sent: false, reason: "state-unreadable" });
    expect(sentDays.every(day => day > "2026-11-05")).toBe(true);
    // The status says why nothing is sent.
    const status = await buildTelemetryStatusSnapshot(config, { configDir: home, env: {}, now: Date.parse("2026-11-09T12:00:00.000Z") });
    expect(status.stateUnreadable).toBe(true);
    expect(status.previewEligible).toBe(false);
  });

  test("a state file that becomes unreadable before the pre-send check blocks the send", async () => {
    let fetchCalls = 0;
    const config = {
      telemetry: { decision: "accepted" as const, decidedAt: "2026-10-30T10:00:00.000Z", noticeShownAt: "2026-10-30T10:00:00.000Z" },
    };
    const result = await runTelemetryTick({
      configDir: home,
      config,
      env: {},
      now: Date.parse("2026-11-07T12:00:00.000Z"),
      aggregateDay: async (day, opts) => {
        writeFileSync(telemetryStatePath(home), "{ not json", "utf8");
        return aggregateTelemetryForDay(day, opts);
      },
      fetch: (async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 202 });
      }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ sent: false, reason: "state-unreadable" });
    expect(fetchCalls).toBe(0);
  });

  test("a person's decision rebuilds an unreadable state file, keeping every day through the next owner refresh unsent", async () => {
    const statePath = telemetryStatePath(home);
    writeFileSync(statePath, "{ broken", "utf8");
    // Recorded late in the day: an opted-out proxy forgotten by the rebuild records itself again
    // within 6 hours, so the rebuild covers the next UTC day too.
    clearPendingTelemetryDecision(home, Date.parse("2026-11-07T21:00:00.000Z"));
    expect(readTelemetryStateFile(home).unreadable).toBe(false);
    expect(readTelemetryState(home).ineligibleThroughDay).toBe("2026-11-08");
    // Sending resumes for later days instead of staying paused forever.
    const sentDays: string[] = [];
    const config = {
      telemetry: { decision: "accepted" as const, decidedAt: "2026-10-30T10:00:00.000Z", noticeShownAt: "2026-10-30T10:00:00.000Z" },
    };
    const result = await runTelemetryTick({
      configDir: home,
      config,
      env: {},
      now: Date.parse("2026-11-10T12:00:00.000Z"),
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        sentDays.push((JSON.parse(String(init?.body)) as TelemetryPayloadV1).day);
        return new Response("{}", { status: 202 });
      }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ sent: true, day: "2026-11-09" });
    expect(sentDays).toEqual(["2026-11-09"]);
  });

  test("D2: an opted-out proxy records itself again, so a state file rebuilt after corruption keeps it", async () => {
    const proxyConfig = { port: 0, defaultProvider: "openai", providers: {} } as unknown as OcxConfig;
    const prevTelemetry = process.env.OCX_TELEMETRY;
    setTelemetryEnvOptOutRefreshMsForTests(25);
    process.env.OCX_TELEMETRY = "0";
    let lease: Awaited<ReturnType<typeof acquireServerBackgroundLifecycle>> | undefined;
    try {
      lease = acquireServerBackgroundLifecycle(() => {}, proxyConfig);
      expect(readTelemetryState(home).envOptOutOwners?.map(owner => owner.pid)).toEqual([process.pid]);
      // The file is corrupted and rebuilt by a one-off observation that does not know the owner.
      writeFileSync(telemetryStatePath(home), "{ not json", "utf8");
      recordTelemetryEnvOptOut(home);
      expect(readTelemetryState(home).envOptOutOwners ?? []).toEqual([]);
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(readTelemetryState(home).envOptOutOwners?.map(owner => owner.pid)).toEqual([process.pid]);
    } finally {
      await lease?.release();
      setTelemetryEnvOptOutRefreshMsForTests(null);
      if (prevTelemetry === undefined) delete process.env.OCX_TELEMETRY;
      else process.env.OCX_TELEMETRY = prevTelemetry;
    }
  });

  test("a state file that cannot be inspected, or holds malformed opt-out fields or a malformed held decision, blocks sending", () => {
    const statePath = telemetryStatePath(home);
    const base = { version: 1, sentDays: {} };
    for (const bad of [
      { ...base, ineligibleThroughDay: "not-a-day" },
      { ...base, envOptOutActiveSince: "not-a-time" },
      { ...base, envOptOutOwners: "not-a-list" },
      { ...base, envOptOutOwners: [{ pid: "1", since: "2026-11-01T00:00:00.000Z" }] },
      { ...base, pendingDecision: "declined" },
      { ...base, pendingDecision: { decision: "no", decidedAt: "2026-11-01T00:00:00.000Z" } },
      { ...base, pendingDecision: { decision: "accepted", decidedAt: "not-a-time" } },
    ]) {
      writeFileSync(statePath, JSON.stringify(bad), "utf8");
      expect(readTelemetryStateFile(home).unreadable, JSON.stringify(bad)).toBe(true);
    }
    // Absent or null fields are legitimate.
    writeFileSync(statePath, JSON.stringify({ ...base, ineligibleThroughDay: null, envOptOutActiveSince: null, envOptOutOwners: [] }), "utf8");
    expect(readTelemetryStateFile(home).unreadable).toBe(false);
    // A held decline with a damaged timestamp still applies.
    writeFileSync(statePath, JSON.stringify({ ...base, pendingDecision: { decision: "declined", decidedAt: "not-a-time" } }), "utf8");
    expect(readTelemetryStateFile(home)).toMatchObject({ unreadable: false, state: { pendingDecision: { decision: "declined" } } });
    // An lstat failure other than "not found" is not read as a missing file.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      chmodSync(home, 0o000);
      try {
        expect(readTelemetryStateFile(home).unreadable).toBe(true);
      } finally {
        chmodSync(home, 0o700);
      }
    }
  });

  test("recording an opted-out owner drops dead pids and keeps the list within the readable limit", () => {
    const since = "2026-11-01T00:00:00.000Z";
    const dead = Array.from({ length: 64 }, (_, i) => ({ pid: 2_000_000_000 + i, since }));
    writeTelemetryState({ ...readTelemetryState(home), envOptOutOwners: dead }, home);
    recordTelemetryEnvOptOut(home, NOW, process.pid);
    expect(readTelemetryStateFile(home).unreadable).toBe(false);
    expect(readTelemetryState(home).envOptOutOwners?.map(owner => owner.pid)).toEqual([process.pid]);
  });

  test("a decision over a state path that cannot be rewritten still completes", () => {
    const statePath = telemetryStatePath(home);
    mkdirSync(statePath);
    expect(() => clearPendingTelemetryDecision(home, NOW)).not.toThrow();
  });

  test("a telemetry-id.json deleted by another process is not served from memory", () => {
    const { identity } = ensureTelemetryInstallId(home);
    expect(readTelemetryInstallId(home)?.installId).toBe(identity.installId);
    unlinkSync(telemetryIdPath(home));
    expect(readTelemetryInstallId(home)).toBeNull();
  });

  test("D7: re-reads consent and env before transmission and aborts in-flight ticks on stop or nudge", async () => {
    let fetchCalls = 0;
    const mockFetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }) as unknown as typeof fetch;

    // 1. Consent changes to declined while aggregateDay is running -> aborts before sending or minting an id.
    let liveDecision: "accepted" | "declined" = "accepted";
    const abortedByDecline = await runTelemetryTick({
      configDir: home,
      readConfig: () => ({
        telemetry: {
          decision: liveDecision,
          decidedAt: "2026-11-04T00:00:00.000Z",
          noticeShownAt: "2026-11-04T00:00:00.000Z",
        },
      }),
      env: {},
      now: NOW,
      aggregateDay: async day => {
        liveDecision = "declined";
        return aggregateTelemetryEntriesForDay(day, []);
      },
      fetch: mockFetch,
    });
    expect(abortedByDecline).toEqual({ sent: false, day: "2026-11-05", reason: "declined" });
    expect(fetchCalls).toBe(0);
    expect(readTelemetryInstallId(home)).toBeNull();

    // 2. Env opt-out set while aggregateDay is running -> aborts before sending and records ineligibleThroughDay.
    const envBag: Record<string, string | undefined> = {};
    const abortedByEnv = await runTelemetryTick({
      configDir: home,
      config: {
        telemetry: {
          decision: "accepted",
          decidedAt: "2026-11-04T00:00:00.000Z",
          noticeShownAt: "2026-11-04T00:00:00.000Z",
        },
      },
      env: envBag,
      now: NOW,
      aggregateDay: async day => {
        envBag.OCX_TELEMETRY = "0";
        return aggregateTelemetryEntriesForDay(day, []);
      },
      fetch: mockFetch,
    });
    expect(abortedByEnv).toEqual({ sent: false, day: "2026-11-05", reason: "env-ocx-telemetry" });
    expect(fetchCalls).toBe(0);
    expect(readTelemetryState(home).ineligibleThroughDay).toBe("2026-11-07");

    // Reset state for signal cancellation checks:
    writeTelemetryState(
      {
        version: 1,
        sentDays: {},
        lastSentDay: null,
        lastSentAt: null,
        ineligibleThroughDay: null,
        retryAfterUntil: null,
      },
      home,
      NOW,
    );

    // 3. nudgeTelemetryScheduler() cancels an in-flight tick's AbortSignal.
    let observedSignalAborted = false;
    const abortedByNudge = await runTelemetryTick({
      configDir: home,
      config: {
        telemetry: {
          decision: "accepted",
          decidedAt: "2026-11-04T00:00:00.000Z",
          noticeShownAt: "2026-11-04T00:00:00.000Z",
        },
      },
      env: {},
      now: NOW,
      aggregateDay: async (day, opts) => {
        nudgeTelemetryScheduler();
        observedSignalAborted = opts?.signal?.aborted === true;
        return aggregateTelemetryEntriesForDay(day, []);
      },
      fetch: mockFetch,
    });
    expect(observedSignalAborted).toBe(true);
    expect(abortedByNudge).toEqual({ sent: false, day: "2026-11-05", reason: "aborted" });
    expect(fetchCalls).toBe(0);
  });

  test("D11: honors HTTP 429 and 503 Retry-After, persists retryAfterUntil, skips ticks until elapsed, and applies jitter", async () => {
    expect(parseRetryAfterMs("120", NOW)).toBe(120_000);
    expect(parseRetryAfterMs(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90_000);
    expect(parseRetryAfterMs("invalid", NOW)).toBeNull();
    expect(computeTelemetryStartupDelayMs(() => 0.5)).toBe(60_000);
    expect(computeTelemetryIntervalDelayMs(1000, () => 0.5)).toBe(1000 + 7.5 * 60 * 1000);

    const config = {
      telemetry: {
        decision: "accepted" as const,
        decidedAt: "2026-11-04T00:00:00.000Z",
        noticeShownAt: "2026-11-04T00:00:00.000Z",
      },
    };
    let calls = 0;
    const rateLimitedTick = await runTelemetryTick({
      configDir: home,
      config,
      env: {},
      now: NOW,
      fetch: (async () => {
        calls += 1;
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "120" },
        });
      }) as unknown as typeof fetch,
    });
    expect(rateLimitedTick.sent).toBe(false);
    expect(rateLimitedTick.reason).toBe("retry-after-backoff");
    expect(calls).toBe(1);
    const stateAfter429 = readTelemetryState(home);
    expect(stateAfter429.retryAfterUntil).toBe(new Date(NOW + 120_000).toISOString());

    // Tick before retryAfterUntil is skipped without calling fetch:
    const skippedTick = await runTelemetryTick({
      configDir: home,
      config,
      env: {},
      now: NOW + 60_000,
      fetch: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }) as unknown as typeof fetch,
    });
    expect(skippedTick).toEqual({ sent: false, reason: "retry-after-backoff" });
    expect(calls).toBe(1);

    // Tick after retryAfterUntil succeeds and clears retryAfterUntil:
    const recoveredTick = await runTelemetryTick({
      configDir: home,
      config,
      env: {},
      now: NOW + 121_000,
      fetch: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }) as unknown as typeof fetch,
    });
    expect(recoveredTick).toMatchObject({ sent: true, day: "2026-11-05" });
    expect(calls).toBe(2);
    expect(readTelemetryState(home).retryAfterUntil).toBeNull();
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

  test("sendTelemetryPayload refuses redirects, so a report never goes to another host", async () => {
    const payload = buildTelemetryPayloadV1({
      aggregate: aggregateTelemetryEntriesForDay("2026-11-06", []),
      installDayHash: "c".repeat(64),
      newInstall: false,
      now: NOW,
    });
    let redirect: RequestRedirect | undefined;
    await sendTelemetryPayload(payload, {
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        redirect = init?.redirect;
        return new Response("{}", { status: 202 });
      }) as unknown as typeof fetch,
      now: NOW,
    });
    expect(redirect).toBe("error");
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
