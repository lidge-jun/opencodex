import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkForUpdate,
  restartCommand,
  startUpdateJob,
  updateExecutionCommand,
  updateJobPath,
  type UpdateJobState,
} from "../src/update/job";

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
});
