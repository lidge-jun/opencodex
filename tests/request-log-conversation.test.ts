import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  conversationIdFromClaudeCacheKey,
  conversationIdFromClaudeMetadata,
  conversationIdFromResponsesRequest,
  matchesLogConversationId,
  normalizeLogConversationId,
  reasoningReplayConversationIdFromResponsesRequest,
  sessionIdHeaderFromRequest,
  summarizeConversationLogs,
} from "../src/server/request-log-conversation";
import {
  filterRequestLogs,
  requestLogEntryFromPersistedUsage,
  type RequestLogEntry,
} from "../src/server/request-log";
import type { PersistedUsageEntry } from "../src/usage/log";

function log(overrides: Partial<RequestLogEntry>): RequestLogEntry {
  return {
    requestId: "ocx-test",
    timestamp: 1,
    model: "gpt-test",
    provider: "openai",
    status: 200,
    durationMs: 10,
    usageStatus: "reported",
    ...overrides,
  };
}

function digest32(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

describe("normalizeLogConversationId", () => {
  test("trims and rejects empty / control characters", () => {
    expect(normalizeLogConversationId("")).toBeUndefined();
    expect(normalizeLogConversationId("   ")).toBeUndefined();
    expect(normalizeLogConversationId("bad\nid")).toBeUndefined();
    expect(normalizeLogConversationId(null)).toBeUndefined();
  });

  test("always hashes to a stable 32-char digest (including short header values)", () => {
    expect(normalizeLogConversationId("  user@example.com  ")).toBe(digest32("user@example.com"));
    expect(normalizeLogConversationId("session-abc")).toBe(digest32("session-abc"));
    const long = "x".repeat(200);
    expect(normalizeLogConversationId(long)).toBe(digest32(long));
    expect(normalizeLogConversationId(long)).toBe(normalizeLogConversationId(long));
  });
});

describe("matchesLogConversationId", () => {
  test("matches persisted digest or original preimage", () => {
    const raw = "cursor-conversation-uuid";
    const stored = digest32(raw);
    expect(matchesLogConversationId(stored, stored)).toBe(true);
    expect(matchesLogConversationId(stored, raw)).toBe(true);
    expect(matchesLogConversationId(stored, "other")).toBe(false);
    expect(matchesLogConversationId(undefined, raw)).toBe(false);
  });
});

describe("sessionIdHeaderFromRequest", () => {
  test("accepts session_id and hyphenated session-id with underscore preferred", () => {
    expect(sessionIdHeaderFromRequest(new Headers({ "session-id": "hyphen" }))).toBe("hyphen");
    expect(sessionIdHeaderFromRequest(new Headers({
      session_id: "underscore",
      "session-id": "hyphen",
    }))).toBe("underscore");
  });
});

describe("conversationIdFromResponsesRequest", () => {
  test("prefers parent thread header over session / thread / cursor", () => {
    expect(conversationIdFromResponsesRequest({
      clientThreadId: "parent-thread",
      sessionIdHeader: "session",
      threadIdHeader: "thread",
      cursorConversationId: "cursor",
    })).toBe(digest32("parent-thread"));
    expect(conversationIdFromResponsesRequest({
      sessionIdHeader: "session",
      threadIdHeader: "thread",
      cursorConversationId: "cursor",
    })).toBe(digest32("session"));
    expect(conversationIdFromResponsesRequest({
      threadIdHeader: "thread",
      cursorConversationId: "cursor",
    })).toBe(digest32("thread"));
    expect(conversationIdFromResponsesRequest({
      cursorConversationId: "cursor",
    })).toBe(digest32("cursor"));
  });
});

describe("reasoningReplayConversationIdFromResponsesRequest", () => {
  test("keeps the raw identity instead of the hashed log id", () => {
    expect(reasoningReplayConversationIdFromResponsesRequest({
      clientThreadId: "parent-thread",
    })).toBe("parent-thread");
    expect(reasoningReplayConversationIdFromResponsesRequest({
      sessionIdHeader: "session",
    })).not.toBe(digest32("session"));
  });

  test("prefers parent thread, then thread-id, then cursor, then session_id", () => {
    expect(reasoningReplayConversationIdFromResponsesRequest({
      clientThreadId: "parent-thread",
      threadIdHeader: "thread",
      cursorConversationId: "cursor",
      sessionIdHeader: "session",
    })).toBe("parent-thread");
    expect(reasoningReplayConversationIdFromResponsesRequest({
      threadIdHeader: "thread",
      cursorConversationId: "cursor",
      sessionIdHeader: "session",
    })).toBe("thread");
    expect(reasoningReplayConversationIdFromResponsesRequest({
      cursorConversationId: "cursor",
      sessionIdHeader: "session",
    })).toBe("cursor");
    expect(reasoningReplayConversationIdFromResponsesRequest({
      sessionIdHeader: "session",
    })).toBe("session");
  });

  test("skips empty, control-bearing, and overlong fallbacks", () => {
    expect(reasoningReplayConversationIdFromResponsesRequest({
      threadIdHeader: "  ",
      cursorConversationId: "cursor",
    })).toBe("cursor");
    expect(reasoningReplayConversationIdFromResponsesRequest({
      sessionIdHeader: "bad\nid",
    })).toBeUndefined();
    expect(reasoningReplayConversationIdFromResponsesRequest({
      sessionIdHeader: "x".repeat(4097),
    })).toBeUndefined();
  });
});

describe("conversationIdFromClaudeMetadata", () => {
  test("hashes metadata.user_id and ignores Desktop system-hash keys", () => {
    expect(conversationIdFromClaudeMetadata({ user_id: "session-user" })).toBe(digest32("session-user"));
    expect(conversationIdFromClaudeMetadata({})).toBeUndefined();
    expect(conversationIdFromClaudeCacheKey("system", "system-hash")).toBeUndefined();
    expect(conversationIdFromClaudeCacheKey("metadata", digest32("session-user"))).toBe(digest32("session-user"));
  });
});

describe("summarizeConversationLogs", () => {
  test("sums tokens and priced cost while counting exclusions", () => {
    const totals = summarizeConversationLogs([
      {
        totalTokens: 100,
        usageStatus: "reported",
        displayMetrics: { cost: { kind: "value", estimate: { cost: { total: 0.01 } } } },
      },
      {
        usage: { inputTokens: 10, outputTokens: 5 },
        usageStatus: "reported",
        displayMetrics: { cost: { kind: "unavailable", reason: "price_unmatched" } },
      },
      {
        totalTokens: 50,
        usageStatus: "unsupported",
      },
    ]);
    expect(totals).toEqual({
      requests: 3,
      totalTokens: 165,
      estimatedCostUsd: 0.01,
      pricedRequests: 1,
      unpricedRequests: 1,
      unmeteredRequests: 1,
    });
  });
});

describe("request log conversation persistence / filter", () => {
  test("filterRequestLogs matches conversationId preimage and digest aliases", () => {
    const raw = "conv-raw-1";
    const logs = [
      log({ requestId: "a", conversationId: digest32(raw) }),
      log({ requestId: "b", conversationId: digest32("conv-2") }),
      log({ requestId: "c" }),
    ];
    expect(filterRequestLogs(logs, new URLSearchParams(`conversationId=${raw}`)).map(e => e.requestId))
      .toEqual(["a"]);
    expect(filterRequestLogs(logs, new URLSearchParams(`conversation=${digest32("conv-2")}`)).map(e => e.requestId))
      .toEqual(["b"]);
  });

  test("hydrated usage rows keep conversationId", () => {
    const persisted: PersistedUsageEntry = {
      requestId: "round",
      timestamp: 1,
      provider: "openai",
      model: "gpt-test",
      status: 200,
      durationMs: 10,
      usageStatus: "reported",
      conversationId: digest32("thread-xyz"),
    };
    expect(requestLogEntryFromPersistedUsage(persisted).conversationId).toBe(digest32("thread-xyz"));
  });
});
