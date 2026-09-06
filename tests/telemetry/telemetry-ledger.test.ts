import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryLedger } from "../../src/telemetry/ledger";
import type { FailureEvent } from "../../src/telemetry/types";

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) {
    try {
      rmSync(path, { force: true, recursive: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe("TelemetryLedger", () => {
  test("counts only failures in the rolling window and tracks status", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-telemetry-"));
    paths.push(dir);
    const ledger = new TelemetryLedger(join(dir, "telemetry.sqlite"));
    const event: FailureEvent = { failureKind: "upstream_wire_error", provider: "openai", model: "gpt-5", signature: "broken", timestamp: 1000 };
    const fingerprint = ledger.recordFailure(event, 1000).fingerprint;
    ledger.recordFailure({ ...event, timestamp: 1500 }, 1000);
    ledger.recordFailure({ ...event, timestamp: 2600 }, 1000);
    expect(ledger.getRecord(fingerprint)?.count).toBe(1);
    expect(ledger.shouldDispatch(fingerprint, 2, 1000)).toBe(false);
    ledger.recordFailure({ ...event, timestamp: 3000 }, 1000);
    expect(ledger.shouldDispatch(fingerprint, 2, 1000)).toBe(true);
    ledger.updateStatus(fingerprint, "dispatched", { issueNumber: 7 });
    expect(ledger.getRecord(fingerprint)).toMatchObject({ status: "dispatched", details: { issueNumber: 7 } });
    ledger.close();
  });

  test("supports in-memory database and explicit paths", () => {
    const memLedger = new TelemetryLedger(":memory:");
    const event: FailureEvent = { failureKind: "test_error", signature: "in-memory test", timestamp: 5000 };
    const record = memLedger.recordFailure(event, 60000);
    expect(record.count).toBe(1);
    expect(memLedger.getRecord(record.fingerprint)?.status).toBe("monitoring");
    memLedger.close();
  });

  test("sanitizes details by stripping sensitive keys", () => {
    const sampleKey = ["sk", "secret", "fixture", "123"].join("-");
    const ledger = new TelemetryLedger(":memory:");
    const event: FailureEvent = { failureKind: "sanitized_error", signature: "sensitive details test", timestamp: 1000 };
    const details = {
      issueNumber: 42,
      prompt: "secret prompt",
      response: "secret response",
      body: "secret body",
      apiKey: sampleKey,
      safeNote: "connection timeout on leg 1",
    };
    const record = ledger.recordFailure(event, 10000, details);
    expect(record.details).toBeDefined();
    expect(record.details?.issueNumber).toBe(42);
    expect(record.details?.safeNote).toBe("connection timeout on leg 1");
    expect(record.details?.prompt).toBeUndefined();
    expect(record.details?.response).toBeUndefined();
    expect(record.details?.body).toBeUndefined();
    expect(record.details?.apiKey).toBeUndefined();
    ledger.close();
  });

  test("bounds stored occurrences and prunes excess records", () => {
    const ledger = new TelemetryLedger(":memory:", { maxRecords: 2, maxOccurrences: 3 });
    const event1: FailureEvent = { failureKind: "error_1", signature: "sig 1" };
    const event2: FailureEvent = { failureKind: "error_2", signature: "sig 2" };
    const event3: FailureEvent = { failureKind: "error_3", signature: "sig 3" };

    const r1 = ledger.recordFailure({ ...event1, timestamp: 100 }, 10000);
    ledger.recordFailure({ ...event1, timestamp: 200 }, 10000);
    ledger.recordFailure({ ...event1, timestamp: 300 }, 10000);
    ledger.recordFailure({ ...event1, timestamp: 400 }, 10000); // 4th occurrence
    expect(ledger.getRecord(r1.fingerprint)?.count).toBeLessThanOrEqual(3);

    ledger.recordFailure({ ...event2, timestamp: 500 }, 10000);
    ledger.recordFailure({ ...event3, timestamp: 600 }, 10000); // Exceeds maxRecords (2)

    const records = ledger.listRecords();
    expect(records.length).toBeLessThanOrEqual(2);
    ledger.close();
  });

  test("shouldDispatch ignores records not in monitoring status", () => {
    const ledger = new TelemetryLedger(":memory:");
    const event: FailureEvent = { failureKind: "status_check", signature: "check dispatch" };
    const r = ledger.recordFailure({ ...event, timestamp: 100 }, 10000);
    ledger.recordFailure({ ...event, timestamp: 200 }, 10000);
    expect(ledger.shouldDispatch(r.fingerprint, 2, 10000)).toBe(true);

    ledger.updateStatus(r.fingerprint, "fixed");
    expect(ledger.shouldDispatch(r.fingerprint, 2, 10000)).toBe(false);
    ledger.close();
  });

  test("status-only updates preserve existing sanitized details", () => {
    const ledger = new TelemetryLedger(":memory:");
    const record = ledger.recordFailure(
      { failureKind: "status_details", signature: "preserve details", timestamp: 100 },
      10000,
      { issueNumber: 9, prompt: "must not persist" },
    );
    ledger.updateStatus(record.fingerprint, "fixed");
    expect(ledger.getRecord(record.fingerprint)).toMatchObject({
      status: "fixed",
      details: { issueNumber: 9 },
    });
    ledger.close();
  });

  test("status updates merge sanitized details instead of replacing diagnostics", () => {
    const ledger = new TelemetryLedger(":memory:");
    const record = ledger.recordFailure(
      { failureKind: "status_details_merge", signature: "preserve diagnostics", timestamp: 100 },
      10000,
      { issueNumber: 9, safeNote: "original" },
    );
    ledger.updateStatus(record.fingerprint, "fixed", { resolution: "patched", prompt: "must not persist" });
    expect(ledger.getRecord(record.fingerprint)).toMatchObject({
      status: "fixed",
      details: { issueNumber: 9, safeNote: "original", resolution: "patched" },
    });
    ledger.close();
  });

  test("keeps lastSeen monotonic and excludes delayed events outside the active window", () => {
    const ledger = new TelemetryLedger(":memory:");
    const event: FailureEvent = { failureKind: "delayed_event", signature: "arrived late", timestamp: 10000 };
    const fingerprint = ledger.recordFailure(event, 1000).fingerprint;
    const record = ledger.recordFailure({ ...event, timestamp: 1000 }, 1000);
    expect(record).toMatchObject({ firstSeen: 1000, lastSeen: 10000, count: 1 });
    expect(ledger.shouldDispatch(fingerprint, 2, 1000)).toBe(false);
    ledger.close();
  });

  test("prunes terminal records before active monitoring records", () => {
    const ledger = new TelemetryLedger(":memory:", { maxRecords: 2 });
    const fixed = ledger.recordFailure({ failureKind: "fixed_old", signature: "fixed", timestamp: 100 }, 10000);
    ledger.updateStatus(fixed.fingerprint, "fixed");
    const monitoring = ledger.recordFailure({ failureKind: "monitoring_old", signature: "active", timestamp: 200 }, 10000);
    ledger.recordFailure({ failureKind: "new_record", signature: "new", timestamp: 300 }, 10000);
    expect(ledger.getRecord(fixed.fingerprint)).toBeNull();
    expect(ledger.getRecord(monitoring.fingerprint)).not.toBeNull();
    ledger.close();
  });

  test("malformed stored details fail closed without breaking reads or records", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-telemetry-"));
    paths.push(dir);
    const databasePath = join(dir, "telemetry.sqlite");
    const ledger = new TelemetryLedger(databasePath);
    const event: FailureEvent = { failureKind: "malformed_details", signature: "safe", timestamp: 100 };
    const record = ledger.recordFailure(event, 10000, { issueNumber: 1 });
    const db = new Database(databasePath);
    db.run("UPDATE failure_events SET details = ? WHERE fingerprint = ?", "{bad", record.fingerprint);
    db.close();
    expect(ledger.getRecord(record.fingerprint)?.details).toBeUndefined();
    expect(ledger.listRecords()[0]?.details).toBeUndefined();
    expect(() => ledger.recordFailure({ ...event, timestamp: 200 }, 10000)).not.toThrow();
    ledger.close();
  });
});
