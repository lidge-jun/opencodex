import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OcxConfig } from "../src/types";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest } from "./helpers/management-auth";
import {
  defaultLabAutomationStateV1,
  saveLabAutomationState,
} from "../src/lab/automation/persistence";
import {
  requestLabAutomationShutdown,
  resetLabAutomationSchedulerStateForTests,
  stopLabAutomationScheduler,
} from "../src/lab/automation/orchestrator";
import type { LabAutomationRunRecordV1 } from "../src/lab/automation/types";

const HOMES: string[] = [];

function tempHome(): string {
  const dir = join(tmpdir(), `ocx-lab-http-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  process.env.OPENCODEX_HOME = dir;
  return dir;
}

function config(): OcxConfig {
  return { providers: {} } as OcxConfig;
}

function queuedRun(runId: string, runKey: string, createdAt: number): LabAutomationRunRecordV1 {
  return {
    runId,
    runKey,
    state: "queued",
    evidenceLayer: "protocol_conformance",
    suiteId: "responses-core",
    suiteVersion: "1",
    suiteManifestDigest: "suite-digest",
    scenarioId: `responses-core.protocol.${runId}`,
    scenarioVersion: "1",
    scenarioManifestDigest: `scenario-digest-${runId}`,
    subjectId: `subject-${runId}`,
    reason: "missing",
    priority: 0,
    eligibleAt: createdAt,
    trigger: "scheduled",
    createdAt,
    updatedAt: createdAt,
  };
}

afterEach(() => {
  requestLabAutomationShutdown();
  stopLabAutomationScheduler();
  resetLabAutomationSchedulerStateForTests();
  for (const dir of HOMES.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.OPENCODEX_HOME;
});

describe("CL-08 automation management HTTP", () => {
  test("cancel returns 200 for a queued run and 404 for an unknown run", async () => {
    const home = tempHome();
    const now = Date.now();
    saveLabAutomationState({
      ...defaultLabAutomationStateV1(now),
      runs: [queuedRun("queued-1", "key-1", now)],
    }, home);

    const cancel = new ManagementRequest("http://127.0.0.1/api/lab/automation/runs/queued-1/cancel", {
      method: "POST",
    });
    const cancelRes = await handleManagementAPI(cancel, new URL(cancel.url), config());
    expect(cancelRes).not.toBeNull();
    expect(cancelRes?.status).toBe(200);
    expect(await cancelRes?.json()).toMatchObject({ cancelled: true, runId: "queued-1" });

    const unknown = new ManagementRequest("http://127.0.0.1/api/lab/automation/runs/missing/cancel", {
      method: "POST",
    });
    const unknownRes = await handleManagementAPI(unknown, new URL(unknown.url), config());
    expect(unknownRes).not.toBeNull();
    expect(unknownRes?.status).toBe(404);
    expect((await unknownRes?.json())?.error?.code).toBe("not_found");
  });

  test("run pagination returns a stable nextCursor", async () => {
    const home = tempHome();
    const now = Date.now();
    saveLabAutomationState({
      ...defaultLabAutomationStateV1(now),
      runs: [
        queuedRun("newer", "key-newer", now),
        queuedRun("older", "key-older", now - 1),
      ],
    }, home);

    const first = new ManagementRequest("http://127.0.0.1/api/lab/automation/runs?limit=1");
    const firstRes = await handleManagementAPI(first, new URL(first.url), config());
    expect(firstRes).not.toBeNull();
    expect(firstRes?.status).toBe(200);
    const firstBody = await firstRes?.json();
    expect(firstBody?.runs).toHaveLength(1);
    expect(firstBody?.runs[0]?.runId).toBe("newer");
    expect(firstBody?.hasMore).toBe(true);
    expect(firstBody?.nextCursor).toBe("newer");

    const second = new ManagementRequest(
      `http://127.0.0.1/api/lab/automation/runs?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    );
    const secondRes = await handleManagementAPI(second, new URL(second.url), config());
    expect(secondRes).not.toBeNull();
    expect(secondRes?.status).toBe(200);
    const secondBody = await secondRes?.json();
    expect(secondBody?.runs).toHaveLength(1);
    expect(secondBody?.runs[0]?.runId).toBe("older");
    expect(secondBody?.hasMore).toBe(false);
  });
});
