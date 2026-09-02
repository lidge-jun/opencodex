import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  queryPassiveProductionSignals,
} from "../src/lab/query/passive-production";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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
    const entry = usageEntryWithAttempt({ labRouteSubjectId: subjectId, errorCode: `opaque-${secret}` });
    entry.timestamp = 1234;
    entry.apiKeyId = `account-${secret}`;
    entry.conversationId = `conversation-${secret}`;
    entry.upstreamError = `raw-error-${secret}`;
    entry.requestedEffort = secret;
    entry.terminalStatus = `terminal-${secret}`;
    (entry as unknown as Record<string, unknown>).prompt = `prompt-${secret}`;
    (entry as unknown as Record<string, unknown>).responseText = `response-${secret}`;
    (entry.attempts?.[0] as unknown as Record<string, unknown>).toolArguments = `tool-${secret}`;
    (entry.attempts?.[0] as unknown as Record<string, unknown>).credential = `credential-${secret}`;

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

  test("classifies cancellation, environmental failures, and route errors independently", () => {
    const subjectId = "4".repeat(64);
    const cancelled = usageEntryWithAttempt({ labRouteSubjectId: subjectId, status: 499 });
    cancelled.status = 499;
    cancelled.closeReason = "client_cancel";

    const environmental = usageEntryWithAttempt({
      labRouteSubjectId: subjectId,
      status: 429,
      errorCode: "rate_limit_error",
    });
    environmental.requestId = "ocx-cl09-environmental";
    environmental.status = 429;

    const routeError = usageEntryWithAttempt({
      labRouteSubjectId: subjectId,
      status: 502,
      errorCode: "upstream_error",
    });
    routeError.requestId = "ocx-cl09-route-error";
    routeError.status = 502;

    const result = derivePassiveProductionSignals([cancelled, environmental, routeError], subjectId);

    expect(result.signals.map(signal => signal.outcome).sort()).toEqual([
      "client_cancel",
      "environmental",
      "route_error",
    ]);
    expect(result.summary.recentRouteErrorSignals).toBe(1);
  });

  test("reports result truncation only when another matching signal exists", () => {
    const subjectId = "5".repeat(64);
    const entries = Array.from({ length: 3 }, (_, index) => {
      const entry = usageEntryWithAttempt({ labRouteSubjectId: subjectId });
      entry.requestId = `ocx-cl09-limit-${index}`;
      entry.timestamp = index;
      return entry;
    });

    expect(derivePassiveProductionSignals(entries.slice(0, 2), subjectId, 2).truncated).toBe(false);
    expect(derivePassiveProductionSignals(entries, subjectId, 2).truncated).toBe(true);
  });

  test("uses the selected config directory and detects scan overflow", () => {
    const configDir = mkdtempSync(join(tmpdir(), "ocx-cl09-passive-"));
    try {
      const subjectId = "6".repeat(64);
      const otherSubjectId = "7".repeat(64);
      const entries = Array.from({ length: PASSIVE_PRODUCTION_MAX_SCAN_ROWS + 1 }, (_, index) => {
        const entry = usageEntryWithAttempt({
          labRouteSubjectId: index === PASSIVE_PRODUCTION_MAX_SCAN_ROWS ? subjectId : otherSubjectId,
        });
        entry.requestId = `ocx-cl09-config-${index}`;
        entry.timestamp = index;
        return entry;
      });
      writeFileSync(join(configDir, "usage.jsonl"), `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);

      const result = queryPassiveProductionSignals(subjectId, 10, configDir);

      expect(result.signals).toHaveLength(1);
      expect(result.scannedRows).toBe(PASSIVE_PRODUCTION_MAX_SCAN_ROWS);
      expect(result.truncated).toBe(true);
      expect(result.signals[0]?.requestRef).toBe(`ocx-cl09-config-${PASSIVE_PRODUCTION_MAX_SCAN_ROWS}`);
    } finally {
      removeTreeWithRetry(configDir);
    }
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

  test("keeps fallback attempts attributable to the exact route that executed them", () => {
    const subjectA = "2".repeat(64);
    const subjectB = "3".repeat(64);
    const entry = usageEntryWithAttempt({ labRouteSubjectId: subjectA, status: 503 });
    entry.status = 200;
    entry.attempts!.push({
      ordinal: 2,
      provider: "provider-b",
      model: "model-b",
      adapter: "openai-responses",
      status: 200,
      durationMs: 3,
      sendCount: 1,
      recoveryKinds: [],
      usageStatus: "unreported",
      labRouteSubjectId: subjectB,
    });

    const firstRoute = derivePassiveProductionSignals([entry], subjectA);
    const fallbackRoute = derivePassiveProductionSignals([entry], subjectB);

    expect(firstRoute.signals).toHaveLength(1);
    expect(firstRoute.signals[0]).toMatchObject({ attemptOrdinal: 1, subjectId: subjectA, httpStatus: 503 });
    expect(fallbackRoute.signals).toHaveLength(1);
    expect(fallbackRoute.signals[0]).toMatchObject({ attemptOrdinal: 2, subjectId: subjectB, httpStatus: 200 });
  });

  test("passive visibility disappears with its existing usage-history source", () => {
    const subjectId = "1".repeat(64);
    const entry = usageEntryWithAttempt({ labRouteSubjectId: subjectId });
    expect(derivePassiveProductionSignals([entry], subjectId).signals).toHaveLength(1);
    expect(derivePassiveProductionSignals([], subjectId).signals).toHaveLength(0);
  });
});

describe("CL-09 no-feedback architecture guards", () => {
  test("routing and CL-08 planning do not consume passive production queries", () => {
    for (const path of [
      "src/routing/evaluator.ts",
      "src/lab/automation/planner.ts",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toContain("queryPassiveProductionSignals");
      expect(source).not.toContain("passive-production");
      expect(source).not.toContain("production-signals");
    }
  });

  test("production request path only links the exact subject and never reads passive history", () => {
    const source = readFileSync("src/server/responses/core.ts", "utf8");
    // Inverted by devlog/_fin/260814_lab_core_decoupling: subject construction moved OUT of
    // the per-request path into a core-owned slot, so an install with no routing profile
    // executes no Lab code. Core must now name only the slot, never Lab.
    expect(source).toContain("resolvePassiveRouteSubjectId");
    expect(source).not.toContain("resolveProductionRouteSubject");
    expect(source).not.toContain("routing/compatibility");
    expect(source).not.toContain("queryPassiveProductionSignals");
    expect(source).not.toContain("readRecentUsageEntries");
    // The positive assertion moves to the Lab-side registration that fills the slot.
    const registration = readFileSync("src/lib/lab-passive-linker-registration.ts", "utf8");
    expect(registration).toContain("resolveProductionRouteSubject");
    const cliSource = readFileSync("src/cli/lab.ts", "utf8");
    expect(cliSource).toContain("queryPassiveProductionSignals(subjectId, limit, configDir)");
  });

  test("passive query remains read-side and cannot create Lab execution or evidence", () => {
    const source = readFileSync("src/lab/query/passive-production.ts", "utf8");
    expect(source).toContain("readRecentUsageEntries");
    expect(source).not.toContain("ObservationEvent");
    expect(source).not.toContain("appendLab");
    expect(source).not.toContain("compatibility.jsonl");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("executeLive");
  });
});
