import { describe, expect, test } from "bun:test";
import {
  normalizeUsageEntryForTest,
  type PersistedUsageEntry,
} from "../src/usage/log";
import { inboundProtocolForWire } from "../src/routing/compatibility/subject";
import {
  PASSIVE_PRODUCTION_MAX_LIMIT,
  PASSIVE_PRODUCTION_MAX_SCAN_ROWS,
  derivePassiveProductionSignals,
} from "../src/lab/query/passive-production";

function usageEntryWithAttempt(attempt: Record<string, unknown>): PersistedUsageEntry {
  return {
    requestId: "ocx-cl09-passive",
    timestamp: 1,
    provider: "combo",
    model: "combo/test",
    status: 200,
    durationMs: 5,
    usageStatus: "unreported",
    attempts: [{
      ordinal: 1,
      provider: "provider-a",
      model: "model-a",
      adapter: "openai-chat",
      status: 200,
      durationMs: 4,
      sendCount: 1,
      recoveryKinds: [],
      usageStatus: "unreported",
      ...attempt,
    } as never],
  };
}

describe("CL-09 passive production attempt linkage", () => {
  test("preserves an exact local Lab route subject id on a persisted attempt", () => {
    const subjectId = "a".repeat(64);
    const normalized = normalizeUsageEntryForTest(usageEntryWithAttempt({ labRouteSubjectId: subjectId }));
    expect(normalized.attempts?.[0]).toMatchObject({ ordinal: 1, labRouteSubjectId: subjectId });
  });

  test("omits malformed route subject linkage without dropping the attempt", () => {
    const normalized = normalizeUsageEntryForTest(usageEntryWithAttempt({ labRouteSubjectId: "not-a-subject-id" }));
    expect(normalized.attempts?.[0]?.ordinal).toBe(1);
    expect(normalized.attempts?.[0]).not.toHaveProperty("labRouteSubjectId");
  });

  test("keeps legacy attempts without CL-09 linkage unchanged", () => {
    const normalized = normalizeUsageEntryForTest(usageEntryWithAttempt({}));
    expect(normalized.attempts).toEqual([{
      ordinal: 1,
      provider: "provider-a",
      model: "model-a",
      adapter: "openai-chat",
      status: 200,
      durationMs: 4,
      sendCount: 1,
      recoveryKinds: [],
      usageStatus: "unreported",
    }]);
  });

  test("maps each production inbound wire to its canonical Lab protocol identity", () => {
    expect(inboundProtocolForWire("responses")).toBe("openai-responses");
    expect(inboundProtocolForWire("chat")).toBe("openai-chat");
    expect(inboundProtocolForWire("anthropic")).toBe("anthropic-messages");
  });
});

describe("CL-09 bounded passive production projection", () => {
  test("projects only the strict passive allowlist and labels it not verification", () => {
    const subjectId = "b".repeat(64);
    const secret = "CL09-PROMPT-SECRET-CANARY";
    const entry = usageEntryWithAttempt({ labRouteSubjectId: subjectId });
    entry.timestamp = 1234;
    entry.apiKeyId = `account-${secret}`;
    entry.conversationId = `conversation-${secret}`;
    entry.upstreamError = `raw-error-${secret}`;
    entry.requestedEffort = secret;

    const result = derivePassiveProductionSignals([entry], subjectId, 10);

    expect(result.verificationStatus).toBe("not_verification");
    expect(result.summary.verificationStatus).toBe("not_verification");
    expect(result.summary.recentProductionAttempts).toBe(1);
    expect(result.summary.recentSuccessfulAttempts).toBe(1);
    expect(result.signals[0]).toEqual({
      schemaVersion: 1,
      subjectId,
      source: "production_usage_v1",
      requestRef: "ocx-cl09-passive",
      attemptOrdinal: 1,
      observedAt: 1234,
      outcome: "success",
      httpStatus: 200,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("does not treat generic HTTP failure as a compatibility-style route error", () => {
    const subjectId = "c".repeat(64);
    const entry = usageEntryWithAttempt({ labRouteSubjectId: subjectId, status: 500 });
    entry.status = 500;

    const result = derivePassiveProductionSignals([entry], subjectId);

    expect(result.signals[0]?.outcome).toBe("unknown");
    expect(result.summary.recentRouteErrorSignals).toBe(0);
  });

  test("bounds result count and scanned source rows", () => {
    const subjectId = "d".repeat(64);
    const entries = Array.from({ length: PASSIVE_PRODUCTION_MAX_SCAN_ROWS + 25 }, (_, index) => {
      const entry = usageEntryWithAttempt({ labRouteSubjectId: subjectId });
      entry.requestId = `request-${index}`;
      entry.timestamp = index;
      return entry;
    });

    const result = derivePassiveProductionSignals(entries, subjectId, PASSIVE_PRODUCTION_MAX_LIMIT + 100);

    expect(result.signals).toHaveLength(PASSIVE_PRODUCTION_MAX_LIMIT);
    expect(result.scannedRows).toBe(PASSIVE_PRODUCTION_MAX_SCAN_ROWS);
    expect(result.truncated).toBe(true);
    expect(result.signals[0]?.observedAt).toBe(entries.length - 1);
  });

  test("keeps signals isolated by exact subject id", () => {
    const subjectA = "e".repeat(64);
    const subjectB = "f".repeat(64);
    const first = usageEntryWithAttempt({ labRouteSubjectId: subjectA });
    const second = usageEntryWithAttempt({ labRouteSubjectId: subjectB });
    second.requestId = "other-request";

    const result = derivePassiveProductionSignals([first, second], subjectA);

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.subjectId).toBe(subjectA);
    expect(result.signals[0]?.requestRef).toBe("ocx-cl09-passive");
  });
});
