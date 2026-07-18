import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsageEntry,
  readUsageEntries,
  usageForFinalLog,
  usageLogPath,
  usageStatusForFinalLog,
  usageTotalTokens,
} from "../src/usage/log";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("usage log", () => {
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
    }]);
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
});
