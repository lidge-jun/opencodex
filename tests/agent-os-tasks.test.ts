import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAgentOsDbForTests } from "../src/agent-os/db";
import {
  cancelTask,
  claimNextTask,
  completeTask,
  enqueueTask,
  failTask,
  getTask,
  heartbeatTask,
} from "../src/agent-os/tasks";
import { listEventsForTask } from "../src/agent-os/events";

const tempHomes: string[] = [];

function openFreshDb(): void {
  const dir = mkdtempSync(join(tmpdir(), "agent-os-tasks-"));
  tempHomes.push(dir);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  closeAgentOsDbForTests();
  require("../src/agent-os/db").openAgentOsDb(dir);
}

afterEach(() => {
  closeAgentOsDbForTests();
  while (tempHomes.length) rmSync(tempHomes.pop()!, { recursive: true, force: true });
});

describe("phase 04 — persistent task queue", () => {
  test("enqueue then claim in FIFO order", () => {
    openFreshDb();
    const a = enqueueTask({ kind: "scan", title: "A" });
    const b = enqueueTask({ kind: "scan", title: "B" });
    const first = claimNextTask();
    expect(first?.id).toBe(a.id);
    expect(first?.status).toBe("running");
    expect(first?.attempts).toBe(1);
    expect(getTask(b.id)?.status).toBe("queued");
  });

  test("complete marks success and records the result", () => {
    openFreshDb();
    const task = enqueueTask({ kind: "scan", title: "T" });
    claimNextTask();
    expect(heartbeatTask(task.id)).toBe(true);
    expect(completeTask(task.id, { files: 42 })).toBe(true);
    const done = getTask(task.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.result).toEqual({ files: 42 });
    const kinds = listEventsForTask(task.id).map((e) => e.kind);
    expect(kinds).toContain("task.succeeded");
  });

  test("failure retries with backoff until max attempts, then fails permanently", () => {
    openFreshDb();
    const task = enqueueTask({ kind: "flaky", title: "R", maxAttempts: 2 });
    claimNextTask();
    expect(failTask(task.id, { message: "boom" })).toBe(true);
    expect(getTask(task.id)?.status).toBe("queued");
    // Not yet runnable: backoff window.
    expect(claimNextTask({ now: Date.now() })).toBeNull();
    const ready = claimNextTask({ now: Date.now() + 10_000 });
    expect(ready?.id).toBe(task.id);
    expect(failTask(task.id, { message: "boom again" })).toBe(true);
    expect(getTask(task.id)?.status).toBe("failed");
    expect(getTask(task.id)?.error?.message).toBe("boom again");
  });

  test("stale running tasks are recovered after the stale window (crash recovery)", () => {
    openFreshDb();
    const task = enqueueTask({ kind: "long", title: "L" });
    claimNextTask({ now: 1_000 });
    // No heartbeat: after the stale window the task is claimable again.
    const recovered = claimNextTask({ now: 1_000 + 120_000 + 1 });
    expect(recovered?.id).toBe(task.id);
    expect(recovered?.status).toBe("running");
  });

  test("heartbeat keeps a running task alive against recovery", () => {
    openFreshDb();
    const task = enqueueTask({ kind: "long", title: "H" });
    claimNextTask({ now: 1_000 });
    heartbeatTask(task.id);
    // Even well past the stale window, a fresh heartbeat protects the claim.
    const stolen = claimNextTask({ now: 1_000 + 1_000_000, staleRunningMs: 0 });
    expect(stolen).toBeNull();
    expect(getTask(task.id)?.status).toBe("running");
  });

  test("cancel removes a queued task from the runnable set", () => {
    openFreshDb();
    const task = enqueueTask({ kind: "x", title: "C" });
    expect(cancelTask(task.id)).toBe(true);
    expect(claimNextTask()).toBeNull();
    expect(getTask(task.id)?.status).toBe("cancelled");
  });
});
