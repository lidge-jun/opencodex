import { describe, expect, test } from "bun:test";
import {
  normalizeUsageEntryForTest,
  type PersistedUsageEntry,
} from "../src/usage/log";

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

    const normalized = normalizeUsageEntryForTest(usageEntryWithAttempt({
      labRouteSubjectId: subjectId,
    }));

    expect(normalized.attempts?.[0]).toMatchObject({
      ordinal: 1,
      labRouteSubjectId: subjectId,
    });
  });

  test("omits malformed route subject linkage without dropping the attempt", () => {
    const normalized = normalizeUsageEntryForTest(usageEntryWithAttempt({
      labRouteSubjectId: "not-a-subject-id",
    }));

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
});
