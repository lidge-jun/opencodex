import { describe, expect, test } from "bun:test";
import {
  createFailureProjectionAccumulator,
  failureProviderClass,
} from "../../src/usage/failure-projection";
import { FAILURE_FINGERPRINT_VERSION } from "../../src/usage/failure-fingerprint";
import { REQUEST_FAILURE_CAUSES } from "../../src/lib/request-failure-model";
import type { PersistedUsageEntry } from "../../src/usage/log";

function row(overrides: Partial<PersistedUsageEntry>): PersistedUsageEntry {
  return {
    requestId: "req",
    timestamp: 1_000,
    provider: "openai",
    model: "gpt-x",
    status: 502,
    durationMs: 1,
    usageStatus: "unreported",
    failureCause: "upstream-fault",
    ...overrides,
  };
}

describe("failure projection", () => {
  test("it groups failures that share every closed fact and separates the rest", () => {
    const accumulator = createFailureProjectionAccumulator();
    accumulator.add(row({ timestamp: 30 }));
    accumulator.add(row({ timestamp: 10, requestId: "req2", model: "another-model" }));
    accumulator.add(row({ timestamp: 20, requestId: "req3", failureCause: "rate-limit", status: 429 }));
    const snapshot = accumulator.snapshot();

    expect(snapshot.groups.length).toBe(2);
    const fault = snapshot.groups.find(group => group.cause === "upstream-fault")!;
    // Two rows that differ only in fields the fingerprint cannot read are one group.
    expect(fault.count).toBe(2);
    expect(fault.firstSeen).toBe(10);
    expect(fault.lastSeen).toBe(30);
    expect(snapshot.fingerprintVersion).toBe(FAILURE_FINGERPRINT_VERSION);
  });

  test("first and last seen are a minimum and a maximum, not a scan order", () => {
    const accumulator = createFailureProjectionAccumulator();
    for (const timestamp of [50, 10, 90, 30]) accumulator.add(row({ timestamp }));
    const [group] = accumulator.snapshot().groups;
    expect(group!.firstSeen).toBe(10);
    expect(group!.lastSeen).toBe(90);
    expect(group!.count).toBe(4);
  });

  test("a snapshot holds a count and two timestamps, never an occurrence list", () => {
    const accumulator = createFailureProjectionAccumulator();
    for (const timestamp of [1, 2, 3]) accumulator.add(row({ timestamp }));
    const [group] = accumulator.snapshot().groups;
    expect(Object.keys(group!).toSorted()).toEqual([
      "cause", "closeReason", "count", "fingerprint", "firstSeen", "inboundProtocol",
      "lastSeen", "providerClass", "statusClass", "terminalSource", "terminalStatus", "transportPhase",
    ]);
  });

  test("a request that delivered its answer is not a failure", () => {
    const accumulator = createFailureProjectionAccumulator();
    accumulator.add(row({ status: 200, terminalStatus: "completed", failureCause: undefined }));
    accumulator.add(row({ status: 200, terminalStatus: "incomplete", failureCause: undefined }));
    const snapshot = accumulator.snapshot();
    expect(snapshot.groups).toEqual([]);
    expect(snapshot.unattributedFailures).toBe(0);
  });

  test("a failed row written before the cause existed is counted, not bucketed", () => {
    const accumulator = createFailureProjectionAccumulator();
    accumulator.add(row({ failureCause: undefined }));
    const snapshot = accumulator.snapshot();
    expect(snapshot.groups).toEqual([]);
    expect(snapshot.unattributedFailures).toBe(1);
  });

  test("a row that cannot be dated does not invent a timestamp", () => {
    const accumulator = createFailureProjectionAccumulator();
    accumulator.add(row({ timestamp: Number.NaN }));
    const snapshot = accumulator.snapshot();
    expect(snapshot.groups).toEqual([]);
    expect(snapshot.invalidTimestampFailures).toBe(1);
  });

  test("an upstream-supplied terminal status cannot reach a grouping key", () => {
    const accumulator = createFailureProjectionAccumulator();
    accumulator.add(row({ terminalStatus: "prompt text from upstream" as never }));
    const [group] = accumulator.snapshot().groups;
    expect(group!.terminalStatus).toBeNull();
    expect(JSON.stringify(accumulator.snapshot())).not.toContain("prompt text");
  });

  test("a provider the user named themselves does not enter the key", () => {
    expect(failureProviderClass("openai")).toBe("openai");
    expect(failureProviderClass("my-private-endpoint")).toBeNull();
    const accumulator = createFailureProjectionAccumulator();
    accumulator.add(row({ provider: "alice-personal-key" }));
    expect(JSON.stringify(accumulator.snapshot())).not.toContain("alice");
  });

  test("a clone folds new rows without touching the accumulator it came from", () => {
    const original = createFailureProjectionAccumulator();
    original.add(row({ timestamp: 10 }));
    const candidate = original.clone();
    candidate.add(row({ timestamp: 20 }));
    expect(original.snapshot().groups[0]!.count).toBe(1);
    expect(candidate.snapshot().groups[0]!.count).toBe(2);
    expect(original.snapshot().groups[0]!.lastSeen).toBe(10);
  });

  test("ordering is by recency then fingerprint, so two runs agree", () => {
    const build = () => {
      const accumulator = createFailureProjectionAccumulator();
      for (const [index, cause] of REQUEST_FAILURE_CAUSES.entries()) {
        accumulator.add(row({ timestamp: 1_000 - (index % 3), failureCause: cause }));
      }
      return accumulator.snapshot().groups.map(group => group.fingerprint);
    };
    expect(build()).toEqual(build());
    const accumulator = createFailureProjectionAccumulator();
    accumulator.add(row({ timestamp: 10, failureCause: "rate-limit" }));
    accumulator.add(row({ timestamp: 90, failureCause: "upstream-fault" }));
    expect(accumulator.snapshot().groups[0]!.cause).toBe("upstream-fault");
  });
});
