import { sameHomeRestartIo, absentHomeRestartIo } from "../helpers/update-home-fixtures";
/**
 * Dashboard update worker: manager-first recovery after a failed service refresh (#7043), the
 * src/update/job.ts port of what #7074 did for `ocx update`. Every manager call is injected.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finishGuiUpdateRestart, readUpdateJob, restartAfterUpdateForTests, updateJobPath, type RestartIo, type UpdateJobState,
} from "../../src/update/job";
import * as managerRestart from "../../src/update/job-supervised-restart";
import { restartServiceManagerAfterUpdate, type ManagerRestartDeps } from "../../src/update/job-supervised-restart";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const prevHome = process.env.OPENCODEX_HOME;
let dir: string;
beforeEach(() => {
  dir = join(tmpdir(), `ocx-update-job-supervised-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  process.env.OPENCODEX_HOME = dir;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = prevHome;
  removeTreeWithRetry(dir);
});

function freshJob(id: string): UpdateJobState {
  const job: UpdateJobState = {
    id, status: "restarting", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    currentVersion: "2.40.0", latestVersion: "2.40.1", channel: "latest", installer: "bun", restart: true,
    command: "bun add -g @bitkyc08/opencodex", releaseNotesUrl: "https://example.invalid", log: [],
  };
  writeFileSync(updateJobPath(), JSON.stringify(job));
  return job;
}

describe("restartServiceManagerAfterUpdate", () => {
  const target = { port: 10100, hostname: "127.0.0.1" };
  function deps(over: ManagerRestartDeps = {}): ManagerRestartDeps {
    let now = 0;
    return {
      serviceHomeAuthorityFn: () => ({ kind: "same" }),
      hasManager: () => true,
      restartJob: () => ({ ok: true }),
      managerPid: () => 50,
      parentPid: () => null,
      now: () => now,
      sleepMs: async ms => { now += Math.max(ms, 1); },
      deadlineMs: 1_000,
      probeServing: async () => true,
      ...over,
    };
  }

  test("a fresh serving record that is the manager's job (or its child) is supervised", async () => {
    const records = [{ pid: 40, port: 10100 }, { pid: 51, port: 10100 }];
    const lines: string[] = [];
    const outcome = await restartServiceManagerAfterUpdate(target, line => lines.push(line), deps({
      readRecord: () => records.shift() ?? { pid: 51, port: 10100 },
      parentPid: pid => (pid === 51 ? 50 : null),
    }));
    expect(outcome).toBe("supervised");
    expect(lines.at(-1)).toContain("under the service manager (pid 50)");
  });

  test("a record still naming the pre-restart process never counts as the restarted proxy", async () => {
    const outcome = await restartServiceManagerAfterUpdate(target, () => {}, deps({
      readRecord: () => ({ pid: 50, port: 10100 }),
    }));
    expect(outcome).toBe("failed");
  });

  test("a detached proxy the manager does not own is a failure", async () => {
    let reads = 0;
    const lines: string[] = [];
    const outcome = await restartServiceManagerAfterUpdate(target, line => lines.push(line), deps({
      readRecord: () => (reads++ === 0 ? null : { pid: 900, port: 10100 }),
      parentPid: () => 1,
    }));
    expect(outcome).toBe("failed");
    expect(lines.at(-1)).toContain("not the manager's job");
  });

  test("no manager, or a refused restart, fails without polling", async () => {
    let probes = 0;
    const probeServing = async () => { probes++; return true; };
    const lines: string[] = [];
    expect(await restartServiceManagerAfterUpdate(target, () => {}, deps({ hasManager: () => false, probeServing }))).toBe("failed");
    expect(await restartServiceManagerAfterUpdate(target, line => lines.push(line), deps({
      restartJob: () => ({ ok: false, reason: "token=abc123 Could not find service" }), probeServing, readRecord: () => null,
    }))).toBe("failed");
    expect(probes).toBe(0);
    expect(lines.at(-1)).toContain("refused the restart");
    expect(lines.join("\n")).not.toContain("abc123");
  });

  test("the update lease is released before the manager restart, and kept when there is no manager", async () => {
    const order: string[] = [];
    const release = () => { order.push("release"); };
    await restartServiceManagerAfterUpdate({ ...target, release }, () => {}, deps({
      restartJob: () => { order.push("restart"); return { ok: false, reason: "refused" }; },
    }));
    expect(order).toEqual(["release", "restart"]);
    order.length = 0;
    await restartServiceManagerAfterUpdate({ ...target, release }, () => {}, deps({ hasManager: () => false }));
    expect(order).toEqual([]);
  });

  test("a client timeout with no proven supervision is unsettled", async () => {
    const outcome = await restartServiceManagerAfterUpdate(target, () => {}, deps({
      restartJob: () => ({ ok: false, reason: "timed out", unsettled: true }),
      readRecord: () => null,
    }));
    expect(outcome).toBe("unsettled");
  });
});

describe("dashboard restart after a failed service refresh", () => {
  test("the same-home fallback fixture releases its lease without consulting the host manager", async () => {
    const events: string[] = [];
    expect(sameHomeRestartIo.restartServiceManagerFn).toBeFunction();
    const outcome = await sameHomeRestartIo.restartServiceManagerFn!(
      { port: 19100, hostname: "127.0.0.1", release: () => { events.push("release"); } },
      line => events.push(line),
    );
    expect(outcome).toBe("failed");
    expect(events).toEqual(["release"]);
    const hostManager = spyOn(managerRestart, "restartServiceManagerAfterUpdate").mockImplementation(async () => {
      throw new Error("fallback fixture reached the host manager");
    });
    try {
      const spawned = { count: 0 };
      const job = freshJob("fixture-manager-isolated");
      const result = await restartAfterUpdateForTests(job, { port: 19100, hostname: "127.0.0.1" }, {
        ...managedIo("failed", spawned), ...sameHomeRestartIo,
      });
      expect(result).toBe("unsupervised");
      expect(spawned.count).toBe(1);
      expect(hostManager).not.toHaveBeenCalled();
    } finally { hostManager.mockRestore(); }
  });

  function managedIo(manager: "supervised" | "failed" | "unsettled", spawned: { count: number }): RestartIo {
    return {
      ...sameHomeRestartIo,
      serviceInstalledFn: () => true,
      serviceViableFn: () => false,
      listListenPidsFn: () => [],
      waitForPort: async () => true,
      runService: () => ({ status: 1 }),
      restartServiceManagerFn: async () => manager,
      reacquireForDirectStartFn: () => null,
      spawnStart: () => { spawned.count++; },
    };
  }

  test("a supervised manager restart replaces the direct start", async () => {
    const job = freshJob("svc-managed-ok");
    const spawned = { count: 0 };
    const result = await restartAfterUpdateForTests(job, { port: 19100, hostname: "127.0.0.1" }, managedIo("supervised", spawned));
    expect(result).toBeUndefined();
    expect(spawned.count).toBe(0);
  });

  test("an unsettled manager restart starts no competing proxy and fails the job", async () => {
    const job = freshJob("svc-managed-unsettled");
    const spawned = { count: 0 };
    const result = await restartAfterUpdateForTests(job, { port: 19101, hostname: "127.0.0.1" }, managedIo("unsettled", spawned));
    expect(result).toBe(false);
    expect(spawned.count).toBe(0);
    const stored = readUpdateJob(job.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.log.some(line => line.includes("no second proxy was started"))).toBe(true);
  });

  test("a failed manager restart falls back to a direct start reported as unsupervised", async () => {
    const job = freshJob("svc-managed-failed");
    const spawned = { count: 0 };
    const result = await restartAfterUpdateForTests(job, { port: 19102, hostname: "127.0.0.1" }, managedIo("failed", spawned));
    expect(result).toBe("unsupervised");
    expect(spawned.count).toBe(1);
  });

  test("a listener left in place after a failed manager restart is still unproven ownership", async () => {
    const job = freshJob("svc-managed-holder");
    const spawned = { count: 0 };
    const result = await restartAfterUpdateForTests(job, { port: 19106, hostname: "127.0.0.1" }, {
      ...managedIo("failed", spawned),
      waitForPort: async () => false,
      listListenPidsFn: () => [4242],
      isAliveFn: () => true,
      verifyOcxFn: () => null,
    });
    expect(result).toBe("unsupervised");
    expect(spawned.count).toBe(0);
  });

  test("an install without a service starts directly and asks no manager", async () => {
    const job = freshJob("no-service-direct");
    let managerCalls = 0;
    const spawned = { count: 0 };
    const result = await restartAfterUpdateForTests(job, { port: 19103, hostname: "127.0.0.1" }, {
      ...managedIo("failed", spawned),
      ...absentHomeRestartIo,
      serviceInstalledFn: () => false,
      restartServiceManagerFn: async () => { managerCalls++; return "failed"; },
    });
    expect(result).toBeUndefined();
    expect(managerCalls).toBe(0);
    expect(spawned.count).toBe(1);
  });

  test("a healthy UNSUPERVISED fallback fails the job with the warning", async () => {
    const job = freshJob("gui-unsupervised");
    let now = 0;
    const ok = await finishGuiUpdateRestart(job, { port: 19104, hostname: "127.0.0.1" }, "bun", {
      restartAfterUpdateFn: async () => "unsupervised",
      probeProxy: async () => true,
      now: () => now,
      sleepMs: async ms => { now += ms; },
    });
    expect(ok).toBe(false);
    const stored = readUpdateJob(job.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.restarted).toBe(false);
    expect(stored?.error).toContain("UNSUPERVISED");
    expect(stored?.log.some(line => line.includes("ocx service repair"))).toBe(true);
  });

  test("a supervised or unmanaged restart that stays healthy still succeeds", async () => {
    const job = freshJob("gui-supervised");
    let now = 0;
    const ok = await finishGuiUpdateRestart(job, { port: 19105, hostname: "127.0.0.1" }, "bun", {
      restartAfterUpdateFn: async () => {},
      probeProxy: async () => true,
      now: () => now,
      sleepMs: async ms => { now += ms; },
    });
    expect(ok).toBe(true);
    expect(readUpdateJob(job.id)?.status).not.toBe("failed");
  });
});
