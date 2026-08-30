import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAgentOsDbForTests } from "../src/agent-os/db";
import { getTeamRun, startTeamRun, teamDispatchPlan } from "../src/agent-os/teams";
import { claimNextTask, completeTask, enqueueTask, failTask, getTask, listTasks } from "../src/agent-os/tasks";
import { planReplay, taskTimeline } from "../src/agent-os/observability";
import { heartbeatNode, nodesForCapability, registerNode } from "../src/agent-os/remote";
import { askPaoBrain } from "../src/agent-os/ask";
import { recordReview, summarizeCouncil } from "../src/agent-os/reviews";

const tempHomes: string[] = [];

function openFreshDb(): void {
  const dir = mkdtempSync(join(tmpdir(), "agent-os-obs-"));
  tempHomes.push(dir);
  closeAgentOsDbForTests();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../src/agent-os/db").openAgentOsDb(dir);
}

afterEach(() => {
  closeAgentOsDbForTests();
  while (tempHomes.length) rmSync(tempHomes.pop()!, { recursive: true, force: true });
});

describe("phase 10 — multi-agent teams (bounded parallelism)", () => {
  test("dispatch respects maxParallel and keeps the deferred plan", () => {
    openFreshDb();
    const run = startTeamRun({
      name: "scan-fleet",
      maxParallel: 2,
      childAgentIds: [],
      childKinds: [
        { kind: "scan", title: "P1" },
        { kind: "scan", title: "P2" },
        { kind: "scan", title: "P3" },
      ],
    });
    const plan = teamDispatchPlan(run.id);
    expect(plan.dispatched).toHaveLength(2);
    expect(plan.deferred).toHaveLength(1);
    expect(getTeamRun(run.id)?.status).toBe("running");
  });

  test("rejects unbounded or empty team specs", () => {
    openFreshDb();
    expect(() => startTeamRun({ name: "bad", maxParallel: 0, childAgentIds: [], childKinds: [{ kind: "x", title: "x" }] })).toThrow();
    expect(() => startTeamRun({ name: "bad", maxParallel: 4, childAgentIds: [], childKinds: [] })).toThrow();
  });
});

describe("phase 11 — observability & replay", () => {
  test("timeline shows full event trail for a task", () => {
    openFreshDb();
    const task = enqueueTask({ kind: "scan", title: "T" });
    claimNextTask();
    completeTask(task.id, { ok: 1 });
    const timeline = taskTimeline(task.id);
    const kinds = timeline!.events.map((e) => e.kind);
    expect(kinds).toEqual(["task.queued", "task.claimed", "task.succeeded"]);
  });

  test("replay is safe only for side-effect-free kinds", () => {
    openFreshDb();
    // Exhaust retries so the task lands in a terminal failed state.
    const scan = enqueueTask({ kind: "scan", title: "S", maxAttempts: 1 });
    claimNextTask();
    failTask(scan.id, { message: "boom" });
    expect(planReplay(scan.id).decision).toBe("safe");

    const deploy = enqueueTask({ kind: "deploy", title: "D", maxAttempts: 1 });
    claimNextTask();
    failTask(deploy.id, { message: "nope" });
    expect(planReplay(deploy.id).decision).toBe("unsafe_side_effects");
    expect(planReplay("task_missing").decision).toBe("missing_task");
  });
});

describe("phase 12 — remote nodes", () => {
  test("register, heartbeat, capability routing with liveness", () => {
    openFreshDb();
    const node = registerNode({ name: "vps-1", capabilities: ["gpu.render"], maxParallel: 2 });
    expect(nodesForCapability("gpu.render")).toHaveLength(1);
    expect(heartbeatNode(node.id)).toBe(true);
    expect(nodesForCapability("missing.cap")).toHaveLength(0);
    // A node with an old heartbeat is not routable.
    const stale = registerNode({ name: "old-node", capabilities: ["gpu.render"] });
    // simulate staleness by backdating
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../src/agent-os/db").openAgentOsDb()
      .query("UPDATE remote_nodes SET last_heartbeat_ms = ? WHERE id = ?")
      .run(Date.now() - 400_000, stale.id);
    const routable = nodesForCapability("gpu.render");
    expect(routable.map((n) => n.id)).toEqual([node.id]);
  });
});

describe("phase 16 slice — reviewer council (read/aggregation only)", () => {
  test("deterministic aggregation: fail dominates, warn needs review", () => {
    openFreshDb();
    recordReview({ subjectKind: "task", subjectId: "t1", reviewer: "code", verdict: "pass", score: 94 });
    recordReview({ subjectKind: "task", subjectId: "t1", reviewer: "security", verdict: "pass", score: 91 });
    expect(summarizeCouncil("task", "t1")?.final).toBe("pass");
    recordReview({ subjectKind: "task", subjectId: "t2", reviewer: "arch", verdict: "warn", score: 72 });
    recordReview({ subjectKind: "task", subjectId: "t2", reviewer: "qa", verdict: "pass", score: 97 });
    expect(summarizeCouncil("task", "t2")?.final).toBe("needs_review");
    recordReview({ subjectKind: "task", subjectId: "t3", reviewer: "sec", verdict: "fail" });
    expect(summarizeCouncil("task", "t3")?.final).toBe("fail");
    expect(summarizeCouncil("task", "t_missing")).toBeNull();
  });
});

describe("ask pao brain — deterministic local answers", () => {
  test("answers errors intent from failed tasks with sources", () => {
    openFreshDb();
    const task = enqueueTask({ kind: "deploy", title: "Deploy v1", maxAttempts: 1 });
    claimNextTask();
    failTask(task.id, { message: "port busy" });
    const answer = askPaoBrain("ตอนนี้มี error อะไรอยู่?");
    expect(answer.intent).toBe("errors");
    expect(answer.answer).toContain("port busy");
    expect(answer.sources).toContain(`task:${task.id}`);
  });

  test("unmatched question falls back to honest search, never fabrication", () => {
    openFreshDb();
    const answer = askPaoBrain("อะไรคือความหมายของชีวิต");
    expect(answer.intent).toBe("search_fallback");
    expect(answer.answer).toContain("No local match");
  });
});
