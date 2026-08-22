import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { STORE_BUDGET_MS } from "./helpers/test-budget";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsageEntry,
  currentUsageLogRevision,
  normalizeUsageEntryForTest,
  readRecentUsageEntries,
  readUsageEntries,
  readUsageEntriesForManagement,
  readUsageSnapshotForManagement,
  resetUsageReadCacheForTests,
  usageForFinalLog,
  usageLogPath,
  usageStatusForFinalLog,
  usageTotalTokens,
  usageReadCacheStatsForTests,
  usageLogRevisionKey,
  type PersistedUsageEntry,
} from "../src/usage/log";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("usage log", () => {
  test("preserves explicitly empty attempts through normalization", () => {
    const normalized = normalizeUsageEntryForTest({
      requestId: "ocx-empty-attempts",
      timestamp: 1,
      provider: "openai",
      model: "gpt-test",
      status: 200,
      durationMs: 1,
      usageStatus: "unreported",
      attempts: [],
    });

    expect(normalized.attempts).toEqual([]);
  });

  test("preserves only valid non-PII Codex account log labels", () => {
    const normalized = normalizeUsageEntryForTest({
      requestId: "ocx-account-label",
      timestamp: 1,
      provider: "openai-pabc123",
      model: "gpt-test",
      accountLogLabel: "pabc123",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      attempts: [{
        ordinal: 1,
        provider: "openai-pabc123",
        model: "gpt-test",
        adapter: "openai-responses",
        accountLogLabel: "pabc123",
        status: 200,
        durationMs: 1,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "reported",
      }],
    });
    expect(normalized.accountLogLabel).toBe("pabc123");
    expect(normalized.attempts?.[0]?.accountLogLabel).toBe("pabc123");

    const rejected = normalizeUsageEntryForTest({
      ...normalized,
      accountLogLabel: "raw-account-id",
      attempts: [{ ...normalized.attempts![0]!, accountLogLabel: "person@example.test" }],
    });
    expect(rejected.accountLogLabel).toBeUndefined();
    expect(rejected.attempts?.[0]?.accountLogLabel).toBeUndefined();
  });

  test("persists the rate-limit-429 recovery kind on attempts", () => {
    const entry: PersistedUsageEntry = {
      requestId: "ocx-ratelimit-kind",
      timestamp: 1,
      provider: "blsc",
      model: "blsc/DeepSeek-V4-Flash",
      status: 429,
      durationMs: 4,
      usageStatus: "reported",
      attempts: [{
        ordinal: 1,
        provider: "blsc",
        model: "blsc/DeepSeek-V4-Flash",
        adapter: "openai-chat",
        status: 429,
        durationMs: 4,
        sendCount: 2,
        recoveryKinds: ["rate-limit-429", "rate-limit-429"],
        usageStatus: "reported",
      }],
    };
    appendUsageEntry(entry);
    expect(readUsageEntries()[0]?.attempts?.[0]?.recoveryKinds).toEqual(["rate-limit-429"]);
  });

  test("persists the empty-completion recovery kind on attempts", () => {
    const entry: PersistedUsageEntry = {
      requestId: "ocx-empty-completion-kind",
      timestamp: 1,
      provider: "fixture",
      model: "fixture/model",
      status: 200,
      durationMs: 4,
      usageStatus: "reported",
      attempts: [{
        ordinal: 1,
        provider: "fixture",
        model: "fixture/model",
        adapter: "openai-chat",
        status: 200,
        durationMs: 4,
        sendCount: 2,
        recoveryKinds: ["empty-completion", "empty-completion"],
        usageStatus: "reported",
      }],
    };
    appendUsageEntry(entry);
    expect(readUsageEntries()[0]?.attempts?.[0]?.recoveryKinds).toEqual(["empty-completion"]);
  });

  test("persists the opaque-blob rejection recovery kind on attempts", () => {
    const entry: PersistedUsageEntry = {
      requestId: "ocx-opaque-blob-kind",
      timestamp: 1,
      provider: "openai",
      model: "gpt-5.6-sol",
      status: 200,
      durationMs: 4,
      usageStatus: "reported",
      attempts: [{
        ordinal: 1,
        provider: "openai",
        model: "gpt-5.6-sol",
        adapter: "openai-responses",
        status: 200,
        durationMs: 4,
        sendCount: 2,
        recoveryKinds: ["opaque-blob-rejection", "opaque-blob-rejection"],
        usageStatus: "reported",
      }],
    };
    appendUsageEntry(entry);
    expect(readUsageEntries()[0]?.attempts?.[0]?.recoveryKinds).toEqual(["opaque-blob-rejection"]);
  });

  /** Build one minimal persisted-usage JSONL line for the given request id. */
  const persistedLine = (requestId: string) => JSON.stringify({
    requestId,
    timestamp: 1,
    provider: "openai",
    model: "gpt-5.5",
    status: 200,
    durationMs: 1,
    usageStatus: "reported",
    usage: { inputTokens: 1, outputTokens: 1 },
    totalTokens: 2,
  });

  test("file revisions change after append and in-place rewrite", () => {
    writeFileSync(usageLogPath(), `${persistedLine("a")}\n${persistedLine("b")}\n`);
    const first = usageLogRevisionKey(currentUsageLogRevision());
    writeFileSync(usageLogPath(), `${persistedLine("new")}\n`);
    expect(usageLogRevisionKey(currentUsageLogRevision())).not.toBe(first);
    expect(readUsageEntries().map(entry => entry.requestId)).toEqual(["new"]);
  });

  test("management full reads yield while parsing a large existing log", async () => {
    writeFileSync(
      usageLogPath(),
      `${Array.from({ length: 2_100 }, (_, index) => persistedLine(`row-${index}`)).join("\n")}\n`,
    );
    let timerRan = false;
    setTimeout(() => { timerRan = true; }, 0);
    const entries = await readUsageEntriesForManagement();
    expect(entries).toHaveLength(2_100);
    expect(timerRan).toBe(true);
    expect(usageReadCacheStatsForTests()).toEqual({ fullReads: 1, tailReads: 0, parsedLines: 2_100 });
  });

  test("usage reader never requests more than 64 MiB from an oversized log", async () => {
    const path = usageLogPath();
    const fd = openSync(path, "w");
    try {
      truncateSync(fd, 64 * 1024 * 1024 + 1024);
      const tail = Buffer.from(`${persistedLine("tail")}\n`);
      const tailPosition = 64 * 1024 * 1024 + 1024 - tail.byteLength;
      writeSync(fd, Buffer.from("\n"), 0, 1, tailPosition - 1);
      writeSync(fd, tail, 0, tail.byteLength, tailPosition);
    } finally {
      closeSync(fd);
    }
    const snapshot = await readUsageSnapshotForManagement();
    expect(snapshot.truncatedPrefixBytes).toBeGreaterThan(0);
    expect(snapshot.entries.map(entry => entry.requestId)).toEqual(["tail"]);
  }, STORE_BUDGET_MS); // sparse >64 MiB fixture IO is intrinsic; Windows self-hosted measured 7.193s against Bun's 5s default.

  test("usage tail exact row boundary keeps the complete newest row", async () => {
    const newest = Buffer.from(`${persistedLine("newest")}\n`);
    writeFileSync(usageLogPath(), `${persistedLine("older")}\n${newest.toString("utf-8")}`);

    const snapshot = await readUsageSnapshotForManagement(newest.byteLength);

    expect(snapshot.entries.map(entry => entry.requestId)).toEqual(["newest"]);
  });

  test("usage byte-prefix truncation and entry-count truncation report independent metadata", async () => {
    writeFileSync(
      usageLogPath(),
      `${Array.from({ length: 500_001 }, (_, index) => JSON.stringify({ requestId: String(index) })).join("\n")}\n`,
    );
    const snapshot = await readUsageSnapshotForManagement();
    expect(snapshot.entries).toHaveLength(500_000);
    expect(snapshot.entries[0]?.requestId).toBe("1");
    expect(snapshot.entries.at(-1)?.requestId).toBe("500000");
    expect(snapshot.truncatedPrefixBytes).toBe(0);
    expect(snapshot.entriesTruncated).toBe(true);
    expect(snapshot.entriesDropped).toBe(1);
  }, STORE_BUDGET_MS); // parsing 500,001 rows IS the entry-cap assertion; the 200k-row variant measured ~5.05s on windows-latest against Bun's 5s default.

  test("stale usage-read flight is replaced and old completion cannot clear new owner", async () => {
    writeFileSync(
      usageLogPath(),
      `${Array.from({ length: 5_000 }, (_, index) => persistedLine(`stale-${index}`)).join("\n")}\n`,
    );
    const first = readUsageSnapshotForManagement();
    await Promise.resolve();
    const originalNow = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(originalNow + 30_001);
    try {
      const replacement = readUsageSnapshotForManagement();
      const joiner = readUsageSnapshotForManagement();
      await expect(first).rejects.toThrow("management usage read superseded");
      const [second, third] = await Promise.all([replacement, joiner]);
      expect(third.entries).toEqual(second.entries);
      expect(usageReadCacheStatsForTests().fullReads).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  test("a replacement does not join an in-flight read for the previous file revision", async () => {
    writeFileSync(
      usageLogPath(),
      `${Array.from({ length: 2_100 }, (_, index) => persistedLine(`old-${index}`)).join("\n")}\n`,
    );
    const oldRead = readUsageSnapshotForManagement();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    writeFileSync(usageLogPath(), `${persistedLine("replacement")}\n`);
    const newRead = readUsageSnapshotForManagement();
    await expect(oldRead).rejects.toThrow("management usage read superseded");
    const newSnapshot = await newRead;
    expect(newSnapshot.entries.map(entry => entry.requestId)).toEqual(["replacement"]);
  });

  test("persists conversationId for Logs session correlation", () => {
    appendUsageEntry({
      requestId: "ocx-conversation",
      timestamp: 1,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      conversationId: "thread-abc",
      usage: { inputTokens: 1, outputTokens: 1 },
      totalTokens: 2,
    });
    expect(readUsageEntries()).toEqual([expect.objectContaining({
      requestId: "ocx-conversation",
      conversationId: "thread-abc",
    })]);
  });

  test("persists an absolute context checkpoint for stateful providers", () => {
    // Kiro reports per-attempt usage only, so contextTotalTokens is the sole carrier of the
    // cumulative context figure once the log stores raw adapter usage (usageFromBridge).
    // Dropping it here erased Kiro context growth from every persisted row.
    appendUsageEntry({
      requestId: "ocx-context-checkpoint",
      timestamp: 1,
      provider: "kiro",
      model: "claude-opus-5",
      status: 200,
      durationMs: 10,
      usageStatus: "estimated",
      usage: { inputTokens: 220, outputTokens: 252, contextTotalTokens: 127_000, estimated: true },
      totalTokens: 472,
    });
    expect(readUsageEntries()).toEqual([expect.objectContaining({
      requestId: "ocx-context-checkpoint",
      usage: expect.objectContaining({
        inputTokens: 220,
        outputTokens: 252,
        contextTotalTokens: 127_000,
        estimated: true,
      }),
      // The checkpoint must NOT be folded into the per-request total.
      totalTokens: 472,
    })]);
  });

  test("never invents a context checkpoint when the adapter reported none", () => {
    appendUsageEntry({
      requestId: "ocx-no-checkpoint",
      timestamp: 1,
      provider: "kiro",
      model: "claude-opus-5",
      status: 200,
      durationMs: 10,
      usageStatus: "estimated",
      usage: { inputTokens: 61, outputTokens: 48, estimated: true },
      totalTokens: 109,
    });
    const [entry] = readUsageEntries();
    expect(entry?.usage).toBeDefined();
    expect(entry?.usage && "contextTotalTokens" in entry.usage).toBe(false);
  });

  test("persists only canonical ordered attempt fields", () => {
    appendUsageEntry({
      requestId: "ocx-attempts",
      timestamp: 1,
      provider: "combo",
      model: "combo/free",
      requestedModel: "combo/free",
      resolvedModel: "m2",
      status: 200,
      durationMs: 20,
      usageStatus: "estimated",
      usage: { inputTokens: 15, outputTokens: 2, estimated: true },
      totalTokens: 17,
      attempts: [{
        ordinal: 1,
        provider: "a",
        model: "m1",
        adapter: "openai-chat",
        status: 503,
        durationMs: 4,
        sendCount: 2,
        recoveryKinds: ["transient-5xx", "transient-5xx", "oauth-401"],
        usageStatus: "estimated",
        inputTokenEstimate: 5,
        usage: { inputTokens: 5, outputTokens: 0, estimated: true },
        totalTokens: 5,
        requestedEffort: "max",
        effectiveEffort: "high",
        reasoningWireField: "reasoning_effort",
        reasoningWireValue: "high",
        headers: { authorization: "Bearer attempt-token" },
        body: "attempt body secret",
        messages: ["attempt message secret"],
        accessToken: "attempt-access",
        refreshToken: "attempt-refresh",
        error: "raw attempt error",
      } as never],
      headers: { authorization: "Bearer parent-token" },
      body: "parent body secret",
      messages: ["parent message secret"],
    } as unknown as Parameters<typeof appendUsageEntry>[0]);

    const raw = readFileSync(usageLogPath(), "utf-8");
    for (const forbidden of [
      "attempt-token", "attempt body secret", "attempt message secret",
      "attempt-access", "attempt-refresh", "raw attempt error",
      "parent-token", "parent body secret", "parent message secret",
      "authorization", "headers", "messages", "refreshToken",
    ]) expect(raw).not.toContain(forbidden);
    expect(readUsageEntries()[0]?.attempts).toEqual([{
      ordinal: 1,
      provider: "a",
      model: "m1",
      adapter: "openai-chat",
      status: 503,
      durationMs: 4,
      sendCount: 2,
      recoveryKinds: ["transient-5xx", "oauth-401"],
      usageStatus: "estimated",
      inputTokenEstimate: 5,
      usage: { inputTokens: 5, outputTokens: 0, estimated: true },
      totalTokens: 5,
      requestedEffort: "max",
      effectiveEffort: "high",
      reasoningWireField: "reasoning_effort",
      reasoningWireValue: "high",
    }]);
  });

  test("omits malformed optional attempt reasoning metadata without dropping the attempt", () => {
    appendUsageEntry({
      requestId: "ocx-attempt-reasoning",
      timestamp: 1,
      provider: "combo",
      model: "combo/free",
      status: 200,
      durationMs: 4,
      usageStatus: "unreported",
      attempts: [{
        ordinal: 1,
        provider: "a",
        model: "m1",
        adapter: "openai-chat",
        status: 200,
        durationMs: 3,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "unreported",
        requestedEffort: 123,
        effectiveEffort: null,
        reasoningWireField: {},
        reasoningWireValue: -1,
      } as never],
    });

    const attempt = readUsageEntries()[0]?.attempts?.[0];
    expect(attempt?.ordinal).toBe(1);
    expect(attempt).not.toHaveProperty("requestedEffort");
    expect(attempt).not.toHaveProperty("effectiveEffort");
    expect(attempt).not.toHaveProperty("reasoningWireField");
    expect(attempt).not.toHaveProperty("reasoningWireValue");
  });

  test("keeps boolean reasoning values only for reasoning.enabled", () => {
    const base = {
      requestId: "ocx-boolean-reasoning",
      timestamp: 1,
      provider: "combo",
      model: "combo/free",
      status: 200,
      durationMs: 4,
      usageStatus: "unreported",
      attempts: [{
        ordinal: 1,
        provider: "a",
        model: "m1",
        adapter: "openai-chat",
        status: 200,
        durationMs: 3,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "unreported",
      }],
    } as const;
    const mismatched = normalizeUsageEntryForTest({
      ...base,
      reasoningWireField: "reasoning_effort",
      reasoningWireValue: true,
      attempts: [{
        ...base.attempts[0],
        reasoningWireField: "reasoning_effort",
        reasoningWireValue: true,
      }],
    });
    const valid = normalizeUsageEntryForTest({
      ...base,
      reasoningWireField: "reasoning.enabled",
      reasoningWireValue: false,
      attempts: [{
        ...base.attempts[0],
        reasoningWireField: "reasoning.enabled",
        reasoningWireValue: false,
      }],
    });

    expect(mismatched).not.toHaveProperty("reasoningWireValue");
    expect(mismatched.attempts?.[0]).not.toHaveProperty("reasoningWireValue");
    expect(valid.reasoningWireValue).toBe(false);
    expect(valid.attempts?.[0]?.reasoningWireValue).toBe(false);
  });

  test("drops only malformed persisted attempts while preserving valid siblings", () => {
    const valid = (ordinal: number) => ({
      ordinal,
      provider: ordinal === 1 ? "a" : "c",
      model: `m${ordinal}`,
      adapter: "openai-chat",
      status: 200,
      durationMs: 1,
      sendCount: 1,
      recoveryKinds: [],
      usageStatus: "reported",
      usage: { inputTokens: ordinal, outputTokens: 1 },
      totalTokens: ordinal + 1,
    });
    const malformed: Array<Record<string, unknown>> = [
      { ...valid(2), status: 99 },
      { ...valid(2), status: 600 },
      { ...valid(2), status: 200.5 },
      { ...valid(2), inputTokenEstimate: -1 },
      { ...valid(2), totalTokens: -1 },
      { ...valid(2), firstOutputMs: -1 },
      { ...valid(2), firstOutputMs: null },
      { ...valid(2), firstOutputMs: "3" },
      { ...valid(2), usage: { inputTokens: "2", outputTokens: 1 } },
      { ...valid(2), usage: { inputTokens: 2, outputTokens: "1" } },
    ];
    for (const middle of malformed) {
      writeFileSync(usageLogPath(), `${JSON.stringify({
        requestId: "parent",
        timestamp: 1,
        provider: "combo",
        model: "combo/free",
        status: 200,
        durationMs: 3,
        usageStatus: "reported",
        usage: { inputTokens: 4, outputTokens: 2 },
        totalTokens: 6,
        attempts: [valid(1), middle, valid(3)],
      })}\n`);
      const [entry] = readUsageEntries();
      expect(entry?.requestId).toBe("parent");
      expect(entry?.attempts?.map(attempt => attempt.ordinal)).toEqual([1, 3]);
    }
  });

  test("persists parent and attempt firstOutputMs roundtrip (WP4 TTFT)", () => {
    appendUsageEntry({
      requestId: "ocx-ttft",
      timestamp: 1,
      provider: "a",
      model: "m1",
      status: 200,
      durationMs: 20,
      firstOutputMs: 7,
      usageStatus: "reported",
      usage: { inputTokens: 10, outputTokens: 5 },
      totalTokens: 15,
      attempts: [{
        ordinal: 1,
        provider: "a",
        model: "m1",
        adapter: "openai-chat",
        status: 200,
        durationMs: 18,
        firstOutputMs: 3,
        sendCount: 1,
        recoveryKinds: [],
        usageStatus: "reported",
        usage: { inputTokens: 10, outputTokens: 5 },
        totalTokens: 15,
      }],
    });
    const [entry] = readUsageEntries();
    expect(entry?.firstOutputMs).toBe(7);
    expect(entry?.attempts?.[0]?.firstOutputMs).toBe(3);
  });

  test("omits malformed parent firstOutputMs without dropping the entry (direct input)", () => {
    // JSON.stringify turns Infinity/NaN into null, so exercise appendUsageEntry directly
    // (audit blocker #3): the normalizer must omit non-finite values at write time.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      rmSync(usageLogPath(), { force: true });
      appendUsageEntry({
        requestId: "ocx-ttft-bad",
        timestamp: 1,
        provider: "a",
        model: "m1",
        status: 200,
        durationMs: 20,
        firstOutputMs: bad,
        usageStatus: "reported",
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      const [entry] = readUsageEntries();
      expect(entry?.requestId).toBe("ocx-ttft-bad");
      expect(entry).not.toHaveProperty("firstOutputMs");
    }
  });

  test("legacy lines without firstOutputMs stay readable and unset", () => {
    writeFileSync(usageLogPath(), `${JSON.stringify({
      requestId: "legacy",
      timestamp: 1,
      provider: "a",
      model: "m1",
      status: 200,
      durationMs: 5,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 1 },
    })}\n`);
    const [entry] = readUsageEntries();
    expect(entry?.requestId).toBe("legacy");
    expect(entry).not.toHaveProperty("firstOutputMs");
  });

  test("ignores malformed attempt arrays and keeps legacy parents readable", () => {
    writeFileSync(usageLogPath(), [
      JSON.stringify({
        requestId: "bad-attempt-array",
        timestamp: 1,
        provider: "combo",
        model: "combo/free",
        status: 200,
        durationMs: 1,
        usageStatus: "unreported",
        attempts: { ordinal: 1 },
      }),
      JSON.stringify({
        requestId: "legacy",
        timestamp: 2,
        provider: "openai",
        model: "gpt-5.5",
        status: 200,
        durationMs: 1,
        usageStatus: "reported",
        usage: { inputTokens: 1, outputTokens: 2 },
        totalTokens: 3,
      }),
    ].join("\n"));
    const entries = readUsageEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).not.toHaveProperty("attempts");
    expect(entries[1]).toEqual({
      requestId: "legacy",
      timestamp: 2,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 1,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 2 },
      totalTokens: 3,
    });
  });

  test("uses OPENCODEX_HOME for the append-only JSONL path", () => {
    expect(usageLogPath()).toBe(join(testDir, "usage.jsonl"));
  });

  test("appends secret-safe usage entries and reads them back", () => {
    appendUsageEntry({
      requestId: "ocx-1",
      timestamp: 1,
      provider: "openai",
      model: "gpt-5.5",
      surface: "claude",
      requestedModel: "openai-apikey/gpt-5.5",
      resolvedModel: "gpt-5.5",
      status: 200,
      durationMs: 42,
      usageStatus: "reported",
      usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2 },
      totalTokens: 13,
    });

    expect(existsSync(usageLogPath())).toBe(true);
    const raw = readFileSync(usageLogPath(), "utf-8");
    expect(raw).toContain("\"requestId\":\"ocx-1\"");
    expect(raw).not.toContain("prompt");
    expect(raw).not.toContain("authorization");
    expect(readUsageEntries()).toEqual([{
      requestId: "ocx-1",
      timestamp: 1,
      provider: "openai",
      model: "gpt-5.5",
      surface: "claude",
      requestedModel: "openai-apikey/gpt-5.5",
      resolvedModel: "gpt-5.5",
      status: 200,
      durationMs: 42,
      usageStatus: "reported",
      usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2 },
      totalTokens: 13,
    }]);
    if (process.platform !== "win32") {
      expect((statSync(usageLogPath()).mode & 0o777).toString(8)).toBe("600");
    }
  });

  test("drops runtime extra fields before persisting usage JSONL", () => {
    appendUsageEntry({
      requestId: "ocx-extra",
      timestamp: 2,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 12,
      usageStatus: "reported",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        estimated: true,
        prompt: "secret prompt text",
      },
      totalTokens: 3,
      prompt: "secret prompt text",
      messages: [{ role: "user", content: "secret message" }],
      headers: { authorization: "Bearer usage-log-token" },
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/demo",
      surface: "codex",
    } as unknown as Parameters<typeof appendUsageEntry>[0]);

    const raw = readFileSync(usageLogPath(), "utf-8");
    for (const leaked of [
      "secret prompt text",
      "secret message",
      "usage-log-token",
      "access-secret",
      "refresh-secret",
      "arn:aws:codewhisperer",
      "headers",
      "messages",
      "profileArn",
      "\"surface\"",
    ]) {
      expect(raw).not.toContain(leaked);
    }
    expect(readUsageEntries()).toEqual([{
      requestId: "ocx-extra",
      timestamp: 2,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 12,
      usageStatus: "reported",
      usage: { inputTokens: 1, outputTokens: 2, estimated: true },
      totalTokens: 3,
    }]);
  });

  test("skips malformed JSONL lines while keeping valid entries", () => {
    writeFileSync(usageLogPath(), [
      "{\"requestId\":\"a\",\"timestamp\":1,\"provider\":\"p\",\"model\":\"m\",\"status\":200,\"durationMs\":1,\"usageStatus\":\"unreported\"}",
      "{not-json",
      "{\"requestId\":\"b\",\"timestamp\":2,\"provider\":\"p\",\"model\":\"m\",\"status\":200,\"durationMs\":1,\"usageStatus\":\"reported\",\"usage\":{\"inputTokens\":1,\"outputTokens\":2},\"totalTokens\":3}",
    ].join("\n"));

    expect(readUsageEntries().map(entry => entry.requestId)).toEqual(["a", "b"]);
  });

  test("keeps missing usage distinct from zero usage", () => {
    expect(usageStatusForFinalLog(undefined)).toBe("unreported");
    expect(usageStatusForFinalLog({ inputTokens: 0, outputTokens: 0 })).toBe("reported");
    expect(usageStatusForFinalLog({ inputTokens: 0, outputTokens: 0, estimated: true })).toBe("estimated");
    expect(usageTotalTokens(undefined)).toBeUndefined();
    expect(usageTotalTokens({ inputTokens: 4, outputTokens: 6, cachedInputTokens: 2 })).toBe(10);
    // inputTokens is inclusive of cache detail — the total never re-adds it
    expect(usageTotalTokens({ inputTokens: 4, outputTokens: 6, cachedInputTokens: 2, cacheReadInputTokens: 1, cacheCreationInputTokens: 1 })).toBe(10);
    expect(usageTotalTokens({ inputTokens: 4, outputTokens: 6, totalTokens: 50_000 })).toBe(50_000);
  });

  test("marks Kiro final log usage as estimated without changing other providers", () => {
    const usage = { inputTokens: 4, outputTokens: 6 };
    expect(usageForFinalLog("kiro", usage)).toEqual({ ...usage, estimated: true });
    expect(usageForFinalLog("kiro-p9d8524", usage)).toEqual({ ...usage, estimated: true });
    // cursor: adapter name AND configured-provider-name prefixes both count (devlog 130 B2 —
    // "cursor-pb51d9b" rows previously logged as accurately "reported").
    expect(usageForFinalLog("cursor", usage)).toEqual({ ...usage, estimated: true });
    expect(usageForFinalLog("cursor-pb51d9b", usage)).toEqual({ ...usage, estimated: true });
    expect(usageForFinalLog("openai", usage)).toEqual(usage);
    expect(usageForFinalLog("openai", { ...usage, estimated: true })).toEqual({ ...usage, estimated: true });
  });

  test("preserves cached token counts alongside estimated status", () => {
    appendUsageEntry({
      requestId: "ocx-cache",
      timestamp: 3,
      provider: "kiro",
      model: "claude-opus-4.8",
      status: 200,
      durationMs: 21,
      usageStatus: "estimated",
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 80,
        cacheReadInputTokens: 60,
        cacheCreationInputTokens: 20,
        estimated: true,
      },
      totalTokens: 110,
    });

    expect(readUsageEntries()[0]).toEqual({
      requestId: "ocx-cache",
      timestamp: 3,
      provider: "kiro",
      model: "claude-opus-4.8",
      status: 200,
      durationMs: 21,
      usageStatus: "estimated",
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 80,
        cacheReadInputTokens: 60,
        cacheCreationInputTokens: 20,
        estimated: true,
      },
      totalTokens: 110,
    });
  });

  test("persists and reads back effort / service-tier GUI metadata", () => {
    appendUsageEntry({
      requestId: "ocx-effort",
      timestamp: 9,
      provider: "openai",
      model: "gpt-5.6-sol",
      requestedModel: "gpt-5.6-sol",
      requestedEffort: "xhigh",
      effectiveEffort: "high",
      reasoningWireField: "reasoning_effort",
      reasoningWireValue: "high",
      requestedServiceTier: "priority",
      requestedSpeedLabel: "fast",
      configuredServiceTier: "auto",
      modelSupportsServiceTier: true,
      responseServiceTier: "priority",
      status: 200,
      durationMs: 5,
      usageStatus: "unreported",
    });
    expect(readUsageEntries()[0]).toMatchObject({
      requestId: "ocx-effort",
      requestedEffort: "xhigh",
      effectiveEffort: "high",
      reasoningWireField: "reasoning_effort",
      reasoningWireValue: "high",
      requestedServiceTier: "priority",
      requestedSpeedLabel: "fast",
      configuredServiceTier: "auto",
      modelSupportsServiceTier: true,
      responseServiceTier: "priority",
    });
  });

  test("readRecentUsageEntries returns only the newest N rows", () => {
    for (let i = 0; i < 12; i++) {
      appendUsageEntry({
        requestId: `ocx-tail-${i}`,
        timestamp: i,
        provider: "openai",
        model: "gpt",
        status: 200,
        durationMs: 1,
        usageStatus: "unreported",
      });
    }
    expect(readRecentUsageEntries(5).map(e => e.requestId)).toEqual([
      "ocx-tail-7",
      "ocx-tail-8",
      "ocx-tail-9",
      "ocx-tail-10",
      "ocx-tail-11",
    ]);
    expect(readRecentUsageEntries(0)).toEqual([]);
    expect(readRecentUsageEntries(-1)).toEqual([]);
  });

  test("readRecentUsageEntries does not expand beyond its bounded tail window", () => {
    const path = usageLogPath();
    const fd = openSync(path, "w");
    try {
      const older = Buffer.from(`${persistedLine("outside-tail")}\n`);
      writeSync(fd, older, 0, older.byteLength, 0);
      truncateSync(fd, 64 * 1024 * 1024 + older.byteLength + 1);
    } finally {
      closeSync(fd);
    }

    expect(readRecentUsageEntries(1)).toEqual([]);
  }, STORE_BUDGET_MS);
});
