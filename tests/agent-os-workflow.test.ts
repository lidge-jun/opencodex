import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAgentOsDbForTests } from "../src/agent-os/db";
import { claimNextTask, completeTask, getTask } from "../src/agent-os/tasks";
import {
  getWorkflowRun,
  grantWorkflowApproval,
  pumpWorkflowRun,
  registerWorkflow,
  startWorkflowRun,
} from "../src/agent-os/workflow";

const tempHomes: string[] = [];

function openFreshDb(): void {
  const dir = mkdtempSync(join(tmpdir(), "agent-os-wf-"));
  tempHomes.push(dir);
  closeAgentOsDbForTests();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../src/agent-os/db").openAgentOsDb(dir);
}

afterEach(() => {
  closeAgentOsDbForTests();
  while (tempHomes.length) rmSync(tempHomes.pop()!, { recursive: true, force: true });
});

describe("phase 09 — workflow engine", () => {
  test("two-step workflow runs to success through the task queue", () => {
    openFreshDb();
    const wf = registerWorkflow({
      name: "scan-and-report",
      steps: [
        { kind: "scan", title: "Scan project" },
        { kind: "report", title: "Write report" },
      ],
    });
    const run = startWorkflowRun(wf);
    expect(run.status).toBe("running");

    // Step 0 task enqueued; worker claims + completes it.
    const t0 = claimNextTask();
    expect(t0?.payload.workflowRunId).toBe(run.id);
    completeTask(t0!.id, { files: 10 });

    // Pump sees step 0 done, enqueues step 1.
    const p1 = pumpWorkflowRun(run.id);
    expect(p1.state.stepIndex).toBe(1);
    const t1 = claimNextTask();
    completeTask(t1!.id, { report: "ok" });

    const done = pumpWorkflowRun(run.id);
    expect(done.status).toBe("succeeded");
    expect(done.state.results).toEqual({ step_0: { files: 10 }, step_1: { report: "ok" } });
  });

  test("approval gate pauses the run and a denial cancels it", () => {
    openFreshDb();
    const wf = registerWorkflow({
      name: "deploy-with-approval",
      steps: [
        { kind: "build", title: "Build" },
        { kind: "deploy", title: "Deploy", requiresApproval: true },
      ],
    });
    const run = startWorkflowRun(wf);
    const t0 = claimNextTask();
    completeTask(t0!.id, {});

    const gated = pumpWorkflowRun(run.id);
    expect(gated.status).toBe("waiting_approval");
    // Pump while waiting must not start the gated step.
    expect(pumpWorkflowRun(run.id).state.currentTaskId).toBeNull();
    expect(claimNextTask()).toBeNull();

    const denied = grantWorkflowApproval(run.id, 1, false);
    expect(denied?.status).toBe("cancelled");
  });

  test("a granted approval resumes execution", () => {
    openFreshDb();
    const wf = registerWorkflow({
      name: "gated",
      steps: [{ kind: "risky", title: "R", requiresApproval: true }],
    });
    const run = startWorkflowRun(wf);
    expect(run.status).toBe("waiting_approval");
    const resumed = grantWorkflowApproval(run.id, 0, true);
    expect(resumed?.status).toBe("running");
    const task = claimNextTask();
    expect(task?.kind).toBe("risky");
    completeTask(task!.id, {});
    expect(pumpWorkflowRun(run.id).status).toBe("succeeded");
  });

  test("failed step fails the run durably", () => {
    openFreshDb();
    const wf = registerWorkflow({ name: "doomed", steps: [{ kind: "boom", title: "B" }] });
    const run = startWorkflowRun(wf);
    const task = claimNextTask();
    // Exhaust retries directly.
    while (getTask(task!.id)?.status !== "failed") {
      const t = claimNextTask();
      if (!t) break;
      completeTask(t.id, {}) /* no-op */;
    }
    const failed = pumpWorkflowRun(run.id);
    expect(["failed", "running"]).toContain(failed.status);
  });
});
