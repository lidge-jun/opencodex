import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAgentOsDbForTests } from "../src/agent-os/db";
import { registerAgent } from "../src/agent-os/registry";
import { claimNextTask, enqueueTask, getTask } from "../src/agent-os/tasks";
import { issueWritePermit, requestWritePermit, type PermitScope } from "../src/agent-os/gateway";
import { runGuardedTask } from "../src/agent-os/executor";

const tempHomes: string[] = [];

function openFreshDb(): void {
  const dir = mkdtempSync(join(tmpdir(), "agent-os-exec-"));
  tempHomes.push(dir);
  closeAgentOsDbForTests();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../src/agent-os/db").openAgentOsDb(dir);
  // tasks.agent_id has a FK to agents; register the test subject up front.
  registerAgent({ id: "agent_x", name: "Test agent", provider: "test" });
}

afterEach(() => {
  closeAgentOsDbForTests();
  while (tempHomes.length) {
    const dir = tempHomes.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows AV/WAL lock: leave for OS cleanup */ }
  }
});

async function grantedPermit(capability: "fs.write" | "shell.exec", scope: PermitScope): Promise<{ permitId: string; token: string }> {
  const { approvalId } = requestWritePermit({ capability, scope, reason: "test" });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../src/agent-os/db").openAgentOsDb()
    .query("UPDATE approvals SET status = 'granted', decided_ms = ? WHERE id = ?")
    .run(Date.now(), approvalId);
  const issued = issueWritePermit(approvalId, scope);
  if (!("token" in issued)) throw new Error("expected issue");
  return { permitId: issued.permit.id, token: issued.token };
}

describe("phase 16 — safe execution (guarded runner)", () => {
  test("valid permit: work runs, task completes with output", async () => {
    openFreshDb();
    const scope: PermitScope = { kind: "file", path: "out.txt" };
    const policy = require("../src/agent-os/policy");
    policy.addPolicy({ subjectType: "agent", subjectId: "agent_x", capability: "fs.write", effect: "allow" });
    const task = enqueueTask({ kind: "write_file", title: "W", agentId: "agent_x", maxAttempts: 1 });
    claimNextTask();
    const permit = await grantedPermit("fs.write", scope);

    const result = await runGuardedTask({
      taskId: task.id, permitId: permit.permitId, token: permit.token, scope,
      subjectType: "agent", subjectId: "agent_x",
      work: () => ({ bytes: 42 }),
    });
    expect(result.redemption.ok).toBe(true);
    expect(result.output).toEqual({ bytes: 42 });
    expect(getTask(task.id)?.status).toBe("succeeded");
  });

  test("invalid permit: work NEVER runs, task fails closed", async () => {
    openFreshDb();
    const scope: PermitScope = { kind: "file", path: "out.txt" };
    const policy = require("../src/agent-os/policy");
    policy.addPolicy({ subjectType: "agent", subjectId: "agent_x", capability: "fs.write", effect: "allow" });
    const task = enqueueTask({ kind: "write_file", title: "W", agentId: "agent_x", maxAttempts: 1 });
    claimNextTask();
    const permit = await grantedPermit("fs.write", scope);

    let workRan = false;
    const result = await runGuardedTask({
      taskId: task.id, permitId: permit.permitId, token: "wp_forged", scope,
      subjectType: "agent", subjectId: "agent_x",
      work: () => { workRan = true; return {}; },
    });
    expect(result.redemption.ok).toBe(false);
    expect(workRan).toBe(false);
    expect(getTask(task.id)?.status).toBe("failed");
    expect(getTask(task.id)?.error?.code).toBe("bad_token");
  });

  test("work throwing an error fails the task with the message", async () => {
    openFreshDb();
    const scope: PermitScope = { kind: "file", path: "out.txt" };
    const policy = require("../src/agent-os/policy");
    policy.addPolicy({ subjectType: "agent", subjectId: "agent_x", capability: "fs.write", effect: "allow" });
    const task = enqueueTask({ kind: "write_file", title: "W", agentId: "agent_x", maxAttempts: 1 });
    claimNextTask();
    const permit = await grantedPermit("fs.write", scope);

    const result = await runGuardedTask({
      taskId: task.id, permitId: permit.permitId, token: permit.token, scope,
      subjectType: "agent", subjectId: "agent_x",
      work: () => { throw new Error("disk full"); },
    });
    expect(result.redemption.ok).toBe(true);
    expect(getTask(task.id)?.status).toBe("failed");
    expect(getTask(task.id)?.error?.message).toBe("disk full");
  });
});
