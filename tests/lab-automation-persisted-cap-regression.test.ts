import { describe, expect, test } from "bun:test";
import { LAB_AUTOMATION_HARD_MAX } from "../src/lab/automation/constants";
import { defaultLabAutomationStateV1 } from "../src/lab/automation/persistence";
import { trimTerminalRuns } from "../src/lab/automation/queue";
import type { LabAutomationRunRecordV1 } from "../src/lab/automation/types";

function cancelledScheduledRun(index: number, now: number): LabAutomationRunRecordV1 {
  return {
    runId: `cancelled-${index}`,
    runKey: `cancelled-key-${index}`,
    state: "cancelled",
    evidenceLayer: "protocol_conformance",
    suiteId: "suite",
    suiteVersion: "1",
    suiteManifestDigest: "a".repeat(64),
    scenarioId: `scenario-${index}`,
    scenarioVersion: "1",
    scenarioManifestDigest: "b".repeat(64),
    subjectId: `subject-${index}`,
    reason: "missing",
    priority: 0,
    eligibleAt: now - 1,
    trigger: "scheduled",
    createdAt: now - 1,
    updatedAt: now,
    completedAt: now,
    terminalCode: "cancelled",
  };
}

describe("CL-08 persisted run ceiling regressions", () => {
  test("cancellation backoff history never makes trimTerminalRuns exceed maxPersistedRuns", () => {
    const now = Date.now();
    const state = {
      ...defaultLabAutomationStateV1(now),
      runs: Array.from(
        { length: LAB_AUTOMATION_HARD_MAX.maxPersistedRuns + 1 },
        (_, index) => cancelledScheduledRun(index, now),
      ),
    };

    const trimmed = trimTerminalRuns(state, now);

    expect(trimmed.runs).toHaveLength(LAB_AUTOMATION_HARD_MAX.maxPersistedRuns);
  });
});
