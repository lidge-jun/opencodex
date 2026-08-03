import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkForUpdate,
  confirmRestartAfterUpdateForTests,
  finishGuiUpdateRestart,
  npmSelfUpdateRestartEvidence,
  readUpdateJob,
  restartCommand,
  restartAfterUpdateForTests,
  staleActiveUpdateJobReason,
  startUpdateJob,
  UPDATE_JOB_LEGACY_STALE_MS,
  updateExecutionCommand,
  updateJobPath,
  type UpdateJobState,
} from "../src/update/job";
import { checkUpdatePackageIntegrity, updateCommand, updateCommandStr } from "../src/update/index";

type SpawnResult = { status: number | null; stdout: string };
function fakeSpawn(result: SpawnResult): typeof import("node:child_process").spawnSync {
  return (() => ({ ...result, stderr: "", pid: 1, output: [], signal: null })) as never;
}

const prevHome = process.env.OPENCODEX_HOME;
let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `ocx-update-job-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  process.env.OPENCODEX_HOME = dir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("GUI update check", () => {
  test("surfaces an npm update with the launcher-safe command", () => {
    const result = checkForUpdate("latest", {
      currentVersion: () => "2.6.17",
      detectInstall: () => "npm",
      latestVersion: () => "2.6.18",
    });

    expect(result.canUpdate).toBe(true);
    expect(result.updateAvailable).toBe(true);
    expect(result.command).toContain("ocx.mjs update --tag latest");
  });

  test("reports source checkouts as manual-only", () => {
    const result = checkForUpdate("latest", {
      currentVersion: () => "2.6.17",
      detectInstall: () => "source",
      latestVersion: () => "2.6.18",
    });

    expect(result.canUpdate).toBe(false);
    expect(result.reason).toBe("source_checkout");
    expect(result.command).toBe("git pull && bun install && bun run build:gui");
  });

  test("handles registry lookup failures without claiming an update", () => {
    const result = checkForUpdate("latest", {
      currentVersion: () => "2.6.17",
      detectInstall: () => "npm",
      latestVersion: () => null,
    });

    expect(result.canUpdate).toBe(false);
    expect(result.reason).toBe("latest_unavailable");
  });

  test("treats equal versions as already current", () => {
    const result = checkForUpdate("latest", {
      currentVersion: () => "2.6.17",
      detectInstall: () => "npm",
      latestVersion: () => "2.6.17",
    });

    expect(result.canUpdate).toBe(false);
    expect(result.reason).toBe("already_latest");
  });

  test("offers a stable update from an older preview but not the same base", () => {
    const olderPreview = checkForUpdate("latest", {
      currentVersion: () => "2.8.2-preview.20260731",
      detectInstall: () => "npm",
      latestVersion: () => "2.9.1",
    });
    expect(olderPreview.updateAvailable).toBe(true);
    expect(olderPreview.canUpdate).toBe(true);

    const sameBasePreview = checkForUpdate("latest", {
      currentVersion: () => "2.9.1-preview.20260731",
      detectInstall: () => "npm",
      latestVersion: () => "2.9.1",
    });
    expect(sameBasePreview.updateAvailable).toBe(false);
    expect(sameBasePreview.canUpdate).toBe(false);
  });
});

describe("GUI update execution decisions", () => {
  test("npm worker uses the Node launcher update path", () => {
    const cmd = updateExecutionCommand("npm", "preview", "/pkg/bin/ocx.mjs");
    expect(cmd.bin).toMatch(/^node/);
    expect(cmd.args).toEqual(["/pkg/bin/ocx.mjs", "update", "--tag", "preview"]);
  });

  test("restart command separates service and direct proxy modes", () => {
    expect(restartCommand(true, "npm", "/pkg/bin/ocx.mjs")).toMatchObject({
      mode: "service",
      args: ["/pkg/bin/ocx.mjs", "service", "install"],
    });
    expect(restartCommand(false, "npm", "/pkg/bin/ocx.mjs")).toMatchObject({
      mode: "proxy",
      args: ["/pkg/bin/ocx.mjs", "start"],
    });
  });

  test("proxy restart pins --port so post-update start does not hop to an ephemeral port", () => {
    const proxy = restartCommand(false, "npm", "/pkg/bin/ocx.mjs", 10100);
    expect(proxy.mode).toBe("proxy");
    expect(proxy.args).toEqual(["/pkg/bin/ocx.mjs", "start", "--port", "10100"]);
    expect(proxy.display).toContain("start --port 10100");
    // Service reinstall stays install-only at the argv level; wrappers bake --port via OCX_BAKE_PORT.
    expect(restartCommand(true, "npm", "/pkg/bin/ocx.mjs", 10100).args).toEqual([
      "/pkg/bin/ocx.mjs", "service", "install",
    ]);
  });

  test("restart waits on the captured pre-update port unconditionally and pins the spawn to it", async () => {
    // The stop-first update flow clears pid/runtime state before restartAfterUpdate runs,
    // so the wait must fire even with no readable pid — driven here via the io seam.
    const waited: Array<{ port: number; hostname: string; opts?: { killOcxHolders?: boolean; onlyKillPids?: number[]; killAllOcxOnPort?: boolean } }> = [];
    const spawned: Array<{ port?: number }> = [];
    const job: UpdateJobState = {
      id: "restart-io",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.6.17",
      latestVersion: "2.6.18",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    await restartAfterUpdateForTests(job, { port: 12345, hostname: "127.0.0.1" }, {
      serviceInstalledFn: () => false, // drive the proxy-mode branch regardless of host state
      listListenPidsFn: () => [],
      waitForPort: async (port, hostname, opts) => {
        waited.push({
          port,
          hostname: hostname ?? "",
          opts: {
            killOcxHolders: opts?.killOcxHolders,
            onlyKillPids: opts?.onlyKillPids,
            killAllOcxOnPort: (opts as { killAllOcxOnPort?: boolean } | undefined)?.killAllOcxOnPort,
          },
        });
        return true;
      },
      spawnStart: (_job, _installer, port) => {
        spawned.push({ port });
      },
    });
    expect(waited).toEqual([{
      port: 12345,
      hostname: "127.0.0.1",
      opts: { killOcxHolders: true, onlyKillPids: [], killAllOcxOnPort: true },
    }]);
    expect(spawned).toEqual([{ port: 12345 }]);
  });

  test("restart reclaim allowlists the trusted oldPid and kills any ocx on the port", async () => {
    const optsSeen: Array<{ killOcxHolders?: boolean; onlyKillPids?: number[]; killAllOcxOnPort?: boolean }> = [];
    const job: UpdateJobState = {
      id: "restart-oldpid",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.39",
      latestVersion: "2.7.40",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    await restartAfterUpdateForTests(job, { port: 10100, hostname: "127.0.0.1", oldPid: 4242 }, {
      serviceInstalledFn: () => false,
      listListenPidsFn: () => [],
      waitForPort: async (_port, _hostname, opts) => {
        optsSeen.push({
          killOcxHolders: opts?.killOcxHolders,
          onlyKillPids: opts?.onlyKillPids,
          killAllOcxOnPort: (opts as { killAllOcxOnPort?: boolean } | undefined)?.killAllOcxOnPort,
        });
        return true;
      },
      spawnStart: () => {},
    });
    expect(optsSeen).toEqual([{ killOcxHolders: true, onlyKillPids: [4242], killAllOcxOnPort: true }]);
  });

  test("restart reclaim also allowlists leftover ocx listeners on the captured port", async () => {
    const optsSeen: number[][] = [];
    const job: UpdateJobState = {
      id: "restart-leftover-ocx",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.39",
      latestVersion: "2.7.40",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    await restartAfterUpdateForTests(job, { port: 19111, hostname: "127.0.0.1", oldPid: 100 }, {
      serviceInstalledFn: () => false,
      // Simulate a respawned bun child that is not the pre-update PID.
      listListenPidsFn: () => [100, 200],
      verifyOcxFn: (pid) => (pid === 100 || pid === 200 ? pid : null),
      waitForPort: async (_port, _hostname, opts) => {
        optsSeen.push([...(opts?.onlyKillPids ?? [])].sort((a, b) => a - b));
        return true;
      },
      spawnStart: () => {},
    });
    expect(optsSeen).toEqual([[100, 200]]);
  });

  test("restart refuses to spawn when a live holder still owns the captured port", async () => {
    const spawned: Array<{ port?: number }> = [];
    const job: UpdateJobState = {
      id: "restart-busy",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.39",
      latestVersion: "2.7.40",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    await restartAfterUpdateForTests(job, { port: 10100, hostname: "127.0.0.1", oldPid: 100 }, {
      serviceInstalledFn: () => false,
      waitForPort: async () => false,
      listListenPidsFn: () => [555],
      isAliveFn: pid => pid === 555,
      spawnStart: (_job, _installer, port) => {
        spawned.push({ port });
      },
    });
    expect(spawned).toEqual([]);
    const saved = readUpdateJob(job.id);
    expect(saved?.log.some(line => line.includes("Live holder(s) remain"))).toBe(true);
  });

  test("restart attempts pinned start when reclaim times out with only dead holders", async () => {
    const spawned: Array<{ port?: number }> = [];
    const job: UpdateJobState = {
      id: "restart-busy-dead",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.39",
      latestVersion: "2.7.40",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    await restartAfterUpdateForTests(job, { port: 10100, hostname: "127.0.0.1", oldPid: 100 }, {
      serviceInstalledFn: () => false,
      waitForPort: async () => false,
      listListenPidsFn: () => [100],
      isAliveFn: () => false,
      spawnStart: (_job, _installer, port) => {
        spawned.push({ port });
      },
    });
    expect(spawned).toEqual([{ port: 10100 }]);
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("waiting for ghost LISTEN rows to clear before pinned start"))).toBe(true);
  });

  test("service restart waits on the captured port and clears OCX_BAKE_PORT after install", async () => {
    const waited: Array<{ port: number; hostname: string }> = [];
    const bakeDuringInstall: string[] = [];
    const job: UpdateJobState = {
      id: "restart-svc",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.26",
      latestVersion: "2.7.28",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    const prev = process.env.OCX_BAKE_PORT;
    delete process.env.OCX_BAKE_PORT;
    try {
      await restartAfterUpdateForTests(job, { port: 18765, hostname: "127.0.0.1" }, {
        serviceInstalledFn: () => true,
        serviceViableFn: () => true,
        // The service-recovery gate now asks the port before skipping the direct-start
        // fallback. This test is about the OCX_BAKE_PORT lifecycle, not the recovery
        // decision, so answer the probe rather than letting it reach a real socket:
        // without it the run falls through to the direct-start path, calls waitFn a
        // second time, and times out on the ghost-LISTEN wait.
        probeProxy: async () => true,
        waitForPort: async (port, hostname) => {
          waited.push({ port, hostname: hostname ?? "" });
          expect(process.env.OCX_BAKE_PORT).toBeUndefined();
          return true;
        },
        runService: () => {
          bakeDuringInstall.push(process.env.OCX_BAKE_PORT ?? "");
          return { status: 0 };
        },
      });
      expect(waited).toEqual([{ port: 18765, hostname: "127.0.0.1" }]);
      expect(bakeDuringInstall).toEqual(["18765"]);
      expect(process.env.OCX_BAKE_PORT).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.OCX_BAKE_PORT;
      else process.env.OCX_BAKE_PORT = prev;
    }
  });

  test("service reinstall failure falls back to a direct proxy start", async () => {
    const spawned: Array<{ port: number }> = [];
    const job: UpdateJobState = {
      id: "svc-fallback",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.26",
      latestVersion: "2.7.28",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    const prevService = process.env.OCX_SERVICE;
    delete process.env.OCX_SERVICE;
    try {
      await restartAfterUpdateForTests(job, { port: 19999, hostname: "127.0.0.1" }, {
        serviceInstalledFn: () => true,
        serviceViableFn: () => false,
        waitForPort: async () => true,
        runService: () => ({ status: 1 }),
        spawnStart: (_job, _installer, port) => {
          spawned.push({ port: port ?? 0 });
        },
      });
      // The fallback must fire: direct proxy start instead of throwing.
      expect(spawned).toEqual([{ port: 19999 }]);
    } finally {
      if (prevService === undefined) delete process.env.OCX_SERVICE;
      else process.env.OCX_SERVICE = prevService;
    }
  });

  test("service reinstall exit 0 with non-viable assets falls back to direct start", async () => {
    const spawned: Array<{ port: number }> = [];
    const job: UpdateJobState = {
      id: "svc-stale-fallback",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.42",
      latestVersion: "2.7.43",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    const prevService = process.env.OCX_SERVICE;
    delete process.env.OCX_SERVICE;
    try {
      await restartAfterUpdateForTests(job, { port: 19100, hostname: "127.0.0.1" }, {
        serviceInstalledFn: () => true,
        // Installed but stale/missing assets — the status line users see after a dead update.
        serviceViableFn: () => false,
        waitForPort: async () => true,
        runService: () => ({ status: 0 }),
        spawnStart: (_job, _installer, port) => {
          spawned.push({ port: port ?? 0 });
        },
      });
      expect(spawned).toEqual([{ port: 19100 }]);
      expect(readUpdateJob(job.id)?.log.some(line =>
        line.includes("not viable") && line.includes("direct proxy start"),
      )).toBe(true);
    } finally {
      if (prevService === undefined) delete process.env.OCX_SERVICE;
      else process.env.OCX_SERVICE = prevService;
    }
  });

  test("dashboard update recovery does not require a Background Service", async () => {
    let now = 0;
    let restartCalls = 0;
    const job: UpdateJobState = {
      id: "no-bg-service-recovery",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.42",
      latestVersion: "2.7.43",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    const ok = await finishGuiUpdateRestart(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 501 },
      "npm",
      {
        // No Background Service installed — interactive dashboard update must still recover.
        serviceInstalledFn: () => false,
        serviceViableFn: () => false,
        waitForPort: async () => true,
        spawnStart: () => { restartCalls += 1; },
        probeProxy: async () => restartCalls > 0,
        probeProxyIdentity: async () => (
          restartCalls > 0 ? { pid: 777, version: "2.7.43" } : null
        ),
        now: () => now,
        sleepMs: async (ms) => { now += ms; },
      },
    );
    expect(ok).toBe(true);
    expect(restartCalls).toBe(1);
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("skipping redundant restart"))).toBe(false);
  });

  test("restart confirmation fails when the proxy never becomes healthy", async () => {
    let now = 0;
    const job: UpdateJobState = {
      id: "restart-health-timeout",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.32",
      latestVersion: "2.7.33",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    const ok = await confirmRestartAfterUpdateForTests(job, { port: 10100, hostname: "127.0.0.1" }, {
      probeProxy: async () => false,
      now: () => now,
      sleepMs: async (ms) => { now += ms; },
    });
    expect(ok).toBe(false);
    expect(readUpdateJob(job.id)).toMatchObject({
      status: "failed",
      restarted: false,
      error: "proxy restart never became healthy on 127.0.0.1:10100",
    });
  });

  test("restart confirmation fails when the proxy dies during the stability window", async () => {
    let now = 0;
    const job: UpdateJobState = {
      id: "restart-health-flap",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.32",
      latestVersion: "2.7.33",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    const ok = await confirmRestartAfterUpdateForTests(job, { port: 10100, hostname: "127.0.0.1" }, {
      probeProxy: async () => now < 12_000,
      now: () => now,
      sleepMs: async (ms) => { now += ms; },
    });
    expect(ok).toBe(false);
    expect(readUpdateJob(job.id)).toMatchObject({
      status: "failed",
      restarted: false,
      error: "proxy restart became unhealthy on 127.0.0.1:10100",
    });
  });

  test("restart confirmation succeeds only after the proxy stays healthy through the stability window", async () => {
    let now = 0;
    const job: UpdateJobState = {
      id: "restart-health-ok",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.32",
      latestVersion: "2.7.33",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    const ok = await confirmRestartAfterUpdateForTests(job, { port: 10100, hostname: "127.0.0.1" }, {
      probeProxy: async () => now >= 1_000,
      now: () => now,
      sleepMs: async (ms) => { now += ms; },
    });
    expect(ok).toBe(true);
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("stayed healthy for 15s after restart"))).toBe(true);
  });

  test("restart confirmation makes a final health probe at the arrival deadline", async () => {
    let now = 0;
    const job: UpdateJobState = {
      id: "restart-health-deadline",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.42",
      latestVersion: "2.7.43",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));

    const ok = await confirmRestartAfterUpdateForTests(
      job,
      { port: 10100, hostname: "127.0.0.1" },
      {
        probeProxy: async () => now >= 30_000,
        now: () => now,
        sleepMs: async (ms) => { now += ms; },
      },
    );

    expect(ok).toBe(true);
    expect(now).toBe(45_000);
  });

  test("npm finish accepts a replacement that becomes healthy after the old cutoff", async () => {
    let now = 0;
    let restartCalls = 0;
    const job: UpdateJobState = {
      id: "npm-late-self-restart",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.42",
      latestVersion: "2.7.43",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));

    const ok = await finishGuiUpdateRestart(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      "npm",
      {
        serviceInstalledFn: () => true,
        // Soft-probe path only runs when a live listen owner exists.
        listListenPidsFn: () => [222],
        isAliveFn: () => true,
        probeProxy: async () => now >= 15_250,
        probeProxyIdentity: async () => (
          now >= 15_250 ? { pid: 222, version: "2.7.43" } : null
        ),
        now: () => now,
        sleepMs: async (ms) => { now += ms; },
        restartAfterUpdateFn: async () => { restartCalls += 1; },
      },
    );

    expect(ok).toBe(true);
    expect(restartCalls).toBe(0);
    expect(now).toBe(30_250);
    expect(readUpdateJob(job.id)?.log.some(line =>
      line.includes("stayed healthy for 15s after restart"),
    )).toBe(true);
    expect(readUpdateJob(job.id)?.log.some(line =>
      line.includes("skipping redundant restart") && line.includes("pid changed"),
    )).toBe(true);
  });

  test("npm finish skips redundant restart when service self-update left a replaced healthy proxy", async () => {
    let now = 0;
    let restartCalls = 0;
    const job: UpdateJobState = {
      id: "npm-skip-redundant",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    const ok = await finishGuiUpdateRestart(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      "npm",
      {
        serviceInstalledFn: () => true,
        listListenPidsFn: () => [222],
        isAliveFn: () => true,
        probeProxy: async () => true,
        probeProxyIdentity: async () => ({ pid: 222, version: "2.7.41" }),
        now: () => now,
        sleepMs: async (ms) => { now += ms; },
        restartAfterUpdateFn: async () => { restartCalls += 1; },
      },
    );
    expect(ok).toBe(true);
    expect(restartCalls).toBe(0);
    expect(readUpdateJob(job.id)?.log.some(line =>
      line.includes("skipping redundant restart") && line.includes("10100") && line.includes("pid changed"),
    )).toBe(true);
  });

  test("npm finish fails when stale PID survives a no-op explicit restart", async () => {
    let now = 0;
    let restartCalls = 0;
    const job: UpdateJobState = {
      id: "npm-stale-healthy",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    const ok = await finishGuiUpdateRestart(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      "npm",
      {
        serviceInstalledFn: () => true,
        listListenPidsFn: () => [111],
        isAliveFn: pid => pid === 111,
        // Soft probe stays healthy (old process). Explicit restart is a no-op.
        probeProxy: async () => true,
        probeProxyIdentity: async () => ({ pid: 111, version: "2.7.40" }),
        now: () => now,
        sleepMs: async (ms) => { now += ms; },
        restartAfterUpdateFn: async () => {
          restartCalls += 1;
          now = 0;
        },
      },
    );
    expect(ok).toBe(false);
    expect(restartCalls).toBe(1);
    expect(readUpdateJob(job.id)).toMatchObject({
      status: "failed",
      restarted: false,
    });
    expect(readUpdateJob(job.id)?.error).toContain("still the pre-update PID");
    expect(readUpdateJob(job.id)?.log.some(line =>
      line.includes("still the pre-update PID") && line.includes("performing explicit restart"),
    )).toBe(true);
  });

  test("npm finish succeeds when explicit restart yields a new PID at the target version", async () => {
    let now = 0;
    let restartCalls = 0;
    let livePid = 111;
    let liveVersion = "2.7.40";
    const job: UpdateJobState = {
      id: "npm-explicit-replaced",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    const ok = await finishGuiUpdateRestart(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      "npm",
      {
        serviceInstalledFn: () => true,
        listListenPidsFn: () => [livePid],
        isAliveFn: () => true,
        probeProxy: async () => true,
        probeProxyIdentity: async () => ({ pid: livePid, version: liveVersion }),
        now: () => now,
        sleepMs: async (ms) => { now += ms; },
        restartAfterUpdateFn: async () => {
          restartCalls += 1;
          livePid = 222;
          liveVersion = "2.7.41";
          now = 0;
        },
      },
    );
    expect(ok).toBe(true);
    expect(restartCalls).toBe(1);
    expect(readUpdateJob(job.id)?.status).not.toBe("failed");
    expect(readUpdateJob(job.id)?.log.some(line =>
      line.includes("Proxy restart confirmed") && line.includes("pid changed"),
    )).toBe(true);
  });

  test("npm finish fails when port reclaim leaves a live pre-update holder", async () => {
    let now = 0;
    const job: UpdateJobState = {
      id: "npm-reclaim-stale",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    const ok = await finishGuiUpdateRestart(
      job,
      { port: 10100, hostname: "127.0.0.1", oldPid: 111 },
      "npm",
      {
        // Live holder after reclaim timeout — must not spawn a second listener.
        serviceInstalledFn: () => false,
        waitForPort: async () => false,
        listListenPidsFn: () => [111],
        isAliveFn: pid => pid === 111,
        spawnStart: () => {
          throw new Error("must not spawn when a live holder remains");
        },
        probeProxy: async () => true,
        probeProxyIdentity: async () => ({ pid: 111, version: "2.7.40" }),
        now: () => now,
        sleepMs: async (ms) => { now += ms; },
      },
    );
    expect(ok).toBe(false);
    expect(readUpdateJob(job.id)).toMatchObject({
      status: "failed",
      restarted: false,
    });
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("Live holder(s) remain"))).toBe(true);
  });

  test("npm finish skips the soft probe for direct installs and restarts immediately", async () => {
    let now = 0;
    let restartCalls = 0;
    let nowBeforeRestart = -1;
    const job: UpdateJobState = {
      id: "npm-direct-immediate",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    const ok = await finishGuiUpdateRestart(job, { port: 10100, hostname: "127.0.0.1" }, "npm", {
      serviceInstalledFn: () => false,
      probeProxy: async () => {
        // Only becomes healthy after the explicit restart (launcher printed `ocx start` only).
        return restartCalls > 0;
      },
      probeProxyIdentity: async () => (
        restartCalls > 0 ? { pid: 333, version: "2.7.41" } : null
      ),
      now: () => now,
      sleepMs: async (ms) => { now += ms; },
      restartAfterUpdateFn: async () => {
        nowBeforeRestart = now;
        restartCalls += 1;
        now = 0;
      },
    });
    expect(ok).toBe(true);
    expect(restartCalls).toBe(1);
    // Soft probe-first must not run — otherwise the clock would advance before restart.
    expect(nowBeforeRestart).toBe(0);
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("skipping redundant restart"))).toBe(false);
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("npm self-update did not leave"))).toBe(false);
  });

  test("npm finish falls back to explicit restart when self-update left the proxy down", async () => {
    let now = 0;
    let restartCalls = 0;
    const job: UpdateJobState = {
      id: "npm-fallback-restart",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    const ok = await finishGuiUpdateRestart(job, { port: 10100, hostname: "127.0.0.1" }, "npm", {
      serviceInstalledFn: () => true,
      listListenPidsFn: () => [],
      // Soft probe times out (proxy down after npm update); confirm after explicit restart succeeds.
      probeProxy: async () => restartCalls > 0,
      probeProxyIdentity: async () => (
        restartCalls > 0 ? { pid: 444, version: "2.7.41" } : null
      ),
      now: () => now,
      sleepMs: async (ms) => { now += ms; },
      restartAfterUpdateFn: async () => {
        restartCalls += 1;
        now = 0; // reset clock so post-restart health wait has a fresh window
      },
    });
    expect(ok).toBe(true);
    expect(restartCalls).toBe(1);
    expect(readUpdateJob(job.id)?.log.some(line =>
      line.includes("performing explicit restart"),
    )).toBe(true);
  });

  test("npm finish probes /healthz when listener scan fails instead of assuming no listener", async () => {
    let now = 0;
    let restartCalls = 0;
    const job: UpdateJobState = {
      id: "npm-scan-fail-probe",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    const ok = await finishGuiUpdateRestart(job, { port: 10100, hostname: "127.0.0.1", oldPid: 111 }, "npm", {
      serviceInstalledFn: () => true,
      scanListenPidsFn: () => ({ ok: false, error: "lsof/netstat unavailable" }),
      probeProxy: async () => true,
      probeProxyIdentity: async () => ({ pid: 222, version: "2.7.41" }),
      now: () => now,
      sleepMs: async (ms) => { now += ms; },
      restartAfterUpdateFn: async () => { restartCalls += 1; },
    });
    expect(ok).toBe(true);
    expect(restartCalls).toBe(0);
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("Listener scan inconclusive"))).toBe(true);
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("skipping redundant restart"))).toBe(true);
  });

  test("bun finish always runs explicit restart even if a proxy is already healthy", async () => {
    let now = 0;
    let restartCalls = 0;
    const job: UpdateJobState = {
      id: "bun-always-restart",
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "bun",
      restart: true,
      command: "",
      releaseNotesUrl: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    const ok = await finishGuiUpdateRestart(job, { port: 10100, hostname: "127.0.0.1" }, "bun", {
      probeProxy: async () => true,
      now: () => now,
      sleepMs: async (ms) => { now += ms; },
      restartAfterUpdateFn: async () => { restartCalls += 1; },
    });
    expect(ok).toBe(true);
    expect(restartCalls).toBe(1);
    expect(readUpdateJob(job.id)?.log.some(line => line.includes("skipping redundant restart"))).toBe(false);
  });

  test("npmSelfUpdateRestartEvidence requires a PID change or target version", () => {
    expect(npmSelfUpdateRestartEvidence(
      { latestVersion: "2.7.41" },
      { oldPid: 111 },
      { pid: 111, version: "2.7.41" },
    )).toMatchObject({ ok: false, reason: "still the pre-update PID" });

    expect(npmSelfUpdateRestartEvidence(
      { latestVersion: "2.7.41" },
      { oldPid: 111 },
      { pid: 222, version: "2.7.41" },
    )).toMatchObject({ ok: true });

    expect(npmSelfUpdateRestartEvidence(
      { latestVersion: "2.7.41" },
      {},
      { pid: null, version: "2.7.41" },
    )).toMatchObject({ ok: true });

    expect(npmSelfUpdateRestartEvidence(
      { latestVersion: "2.7.41" },
      {},
      { pid: 222, version: "2.7.40" },
    )).toMatchObject({ ok: false });
  });

  test("a running job prevents a second update job", () => {
    const now = new Date().toISOString();
    const job: UpdateJobState = {
      id: "running",
      status: "running",
      startedAt: now,
      updatedAt: now,
      currentVersion: "2.6.17",
      latestVersion: "2.6.18",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "node /pkg/bin/ocx.mjs update --tag latest",
      releaseNotesUrl: "https://github.com/lidge-jun/opencodex/releases/latest",
      log: [],
    };
    writeFileSync(updateJobPath(), `${JSON.stringify(job)}\n`);

    expect(() => startUpdateJob("latest", true)).toThrow("already running");
  });

  test("stale detection trusts a live PID and recovers dead or legacy workers", () => {
    const now = Date.now();
    const active = { status: "running" as const, pid: 321, updatedAt: new Date(0).toISOString() };
    expect(staleActiveUpdateJobReason(active, now, () => true)).toBeNull();
    expect(staleActiveUpdateJobReason(active, now, () => false)).toContain("PID 321");
    expect(staleActiveUpdateJobReason({
      status: "restarting",
      updatedAt: new Date(now - UPDATE_JOB_LEGACY_STALE_MS).toISOString(),
    }, now)).toContain("no worker PID");
    expect(staleActiveUpdateJobReason({
      status: "running",
      updatedAt: new Date(now - UPDATE_JOB_LEGACY_STALE_MS + 1).toISOString(),
    }, now)).toBeNull();
  });

  test("recovers a dead worker and persists the replacement worker PID", () => {
    const now = Date.now();
    const oldJob: UpdateJobState = {
      id: "dead-worker",
      status: "running",
      startedAt: new Date(now - 60_000).toISOString(),
      updatedAt: new Date(now - 60_000).toISOString(),
      currentVersion: "2.7.40",
      latestVersion: "2.7.41",
      channel: "latest",
      installer: "bun",
      restart: true,
      command: "bun add -g @bitkyc08/opencodex@2.7.41",
      releaseNotesUrl: "https://github.com/lidge-jun/opencodex/releases/latest",
      log: [],
      pid: 777,
    };
    writeFileSync(updateJobPath(), `${JSON.stringify(oldJob)}\n`);
    let unrefCalled = false;

    const started = startUpdateJob("latest", true, {
      nowMs: () => now,
      isProcessAliveFn: () => false,
      checkForUpdateFn: () => ({
        currentVersion: "2.7.40",
        latestVersion: "2.7.41",
        channel: "latest",
        installer: "bun",
        updateAvailable: true,
        canUpdate: true,
        command: "bun add -g @bitkyc08/opencodex@2.7.41",
        releaseNotesUrl: "https://github.com/lidge-jun/opencodex/releases/latest",
      }),
      spawnWorkerFn: () => ({
        pid: 888,
        unref: () => { unrefCalled = true; },
        once: () => undefined,
      }),
    });

    expect(started.pid).toBe(888);
    expect(readUpdateJob(started.id)?.pid).toBe(888);
    expect(readUpdateJob(started.id)?.log.at(-1)).toContain("PID 888");
    expect(unrefCalled).toBe(true);
  });

  test("records a failed job when spawning the worker throws", () => {
    expect(() => startUpdateJob("latest", false, {
      checkForUpdateFn: () => ({
        currentVersion: "2.7.40",
        latestVersion: "2.7.41",
        channel: "latest",
        installer: "bun",
        updateAvailable: true,
        canUpdate: true,
        command: "bun add -g @bitkyc08/opencodex@2.7.41",
        releaseNotesUrl: "https://github.com/lidge-jun/opencodex/releases/latest",
      }),
      spawnWorkerFn: () => { throw new Error("spawn denied"); },
    })).toThrow("Could not start update worker");
    expect(readUpdateJob()?.status).toBe("failed");
    expect(readUpdateJob()?.error).toContain("spawn denied");
  });
});

describe("immutable update target (WP160)", () => {
  test("a resolved version pins the install target instead of the movable tag", () => {
    expect(updateCommand("bun", "latest", "2.7.24").args).toEqual(["add", "-g", "@bitkyc08/opencodex@2.7.24"]);
    expect(updateCommand("npm", "latest", "2.7.24").args).toEqual(["install", "-g", "@bitkyc08/opencodex@2.7.24"]);
    expect(updateCommandStr("bun", "latest", "2.7.24")).toContain("@bitkyc08/opencodex@2.7.24");
    // Unknown version falls back to the tag (best-effort lane).
    expect(updateCommand("bun", "latest").args).toEqual(["add", "-g", "@bitkyc08/opencodex@latest"]);
    expect(updateCommand("bun", "latest", null).args).toEqual(["add", "-g", "@bitkyc08/opencodex@latest"]);
  });

  test("bun worker execution pins the resolved version through updateExecutionCommand", () => {
    const cmd = updateExecutionCommand("bun", "latest", "/pkg/bin/ocx.mjs", "2.7.24");
    expect(cmd.bin).toBe(process.platform === "win32" ? process.execPath : "bun");
    expect(cmd.args).toEqual(["add", "-g", "@bitkyc08/opencodex@2.7.24"]);
    expect(cmd.display).toContain("@2.7.24");
  });

  test("integrity pre-flight passes on a valid sha512 SRI and on multi-token metadata", () => {
    const single = checkUpdatePackageIntegrity("2.7.24", fakeSpawn({ status: 0, stdout: "sha512-AbC123+/=\n" }));
    expect(single).toEqual({ ok: true, integrity: "sha512-AbC123+/=" });

    const multi = checkUpdatePackageIntegrity("2.7.24", fakeSpawn({
      status: 0,
      stdout: '"sha1-old sha512-GoodToken+/= sha256-other"\n',
    }));
    expect(multi).toEqual({ ok: true, integrity: "sha512-GoodToken+/=" });
  });

  test("transient registry failure skips the gate; anomalous metadata fails closed", () => {
    // Unknown version — registry unavailable lane.
    expect(checkUpdatePackageIntegrity(null).ok).toBe("skipped");

    // Nonzero exit and timeout (status null) are transient — skip, never abort.
    expect(checkUpdatePackageIntegrity("2.7.24", fakeSpawn({ status: 1, stdout: "" })).ok).toBe("skipped");
    expect(checkUpdatePackageIntegrity("2.7.24", fakeSpawn({ status: null, stdout: "" })).ok).toBe("skipped");

    // Successful query with missing or non-sha512 metadata is the fail-closed lane.
    expect(checkUpdatePackageIntegrity("2.7.24", fakeSpawn({ status: 0, stdout: "" })).ok).toBe(false);
    expect(checkUpdatePackageIntegrity("2.7.24", fakeSpawn({ status: 0, stdout: "sha1-only" })).ok).toBe(false);
    expect(checkUpdatePackageIntegrity("2.7.24", fakeSpawn({ status: 0, stdout: "garbage!!" })).ok).toBe(false);
  });

  test("GUI worker gates integrity before spawning and fails the job on anomalous metadata", async () => {
    const source = await Bun.file(new URL("../src/update/job.ts", import.meta.url)).text();

    const gateAt = source.indexOf("const integrity = checkUpdatePackageIntegrity(check.latestVersion);");
    const failAt = source.indexOf('updateJob(job, { status: "failed", error: integrity.reason });');
    const spawnAt = source.indexOf("const result = runLoggedCommand(job, cmd.bin, cmd.args, UPDATE_TIMEOUT_MS);");
    expect(gateAt).toBeGreaterThan(-1);
    expect(failAt).toBeGreaterThan(-1);
    expect(spawnAt).toBeGreaterThan(-1);
    // Gate and its failure return both precede the installer spawn.
    expect(gateAt).toBeLessThan(spawnAt);
    expect(failAt).toBeLessThan(spawnAt);
    // The job log records the verified-or-skipped integrity line at handoff.
    expect(source).toContain("integrity metadata ${integrity.integrity.slice(0, 24)}");
    expect(source).toContain("Integrity pre-flight skipped");
    // The bun lane pins the resolved version through updateExecutionCommand.
    expect(source).toContain("updateExecutionCommand(check.installer, channel, undefined, check.latestVersion)");
  });
});

/**
 * `isServiceViable()` answers registration, not service: `launchctl list` reports a
 * job that bound nothing, and `schtasks` reports a task whose child exited at once.
 * Returning early on it skipped the direct-start fallback that exists so a dashboard
 * update never leaves the proxy dead.
 */
describe("service recovery is health-gated, not viability-gated", () => {
  function healthGateJob(id: string): UpdateJobState {
    const job: UpdateJobState = {
      id,
      status: "restarting",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentVersion: "2.7.26",
      latestVersion: "2.7.28",
      channel: "latest",
      installer: "npm",
      restart: true,
      command: "",
      log: [],
    };
    writeFileSync(updateJobPath(job.id), JSON.stringify(job));
    return job;
  }

  async function runGate(
    id: string,
    io: Parameters<typeof restartAfterUpdateForTests>[2],
  ): Promise<number[]> {
    const spawned: number[] = [];
    let now = 0;
    const prevService = process.env.OCX_SERVICE;
    delete process.env.OCX_SERVICE;
    try {
      await restartAfterUpdateForTests(healthGateJob(id), { port: 18765, hostname: "127.0.0.1" }, {
        serviceInstalledFn: () => true,
        runService: () => ({ status: 0 }),
        waitForPort: async () => true,
        spawnStart: (_job, _installer, port) => { spawned.push(port ?? 0); },
        sleepMs: async ms => { now += ms; },
        now: () => now,
        ...io,
      });
    } finally {
      if (prevService === undefined) delete process.env.OCX_SERVICE;
      else process.env.OCX_SERVICE = prevService;
    }
    return spawned;
  }

  // The regression: viable=true, service registered, nothing listening.
  test("falls through to a direct start when a viable service never serves", async () => {
    const spawned = await runGate("svc-health-dead", {
      serviceViableFn: () => true,
      probeProxy: async () => false,
      serviceHealthTimeoutMs: 1_000,
    });
    expect(spawned).toEqual([18765]);
  });

  test("returns without a direct start when the service does serve", async () => {
    const spawned = await runGate("svc-health-live", {
      serviceViableFn: () => true,
      probeProxy: async () => true,
    });
    expect(spawned).toEqual([]);
  });

  test("still falls back when the service is not viable at all", async () => {
    const spawned = await runGate("svc-health-nonviable", {
      serviceViableFn: () => false,
      probeProxy: async () => false,
      serviceHealthTimeoutMs: 1_000,
    });
    expect(spawned).toEqual([18765]);
  });
});
