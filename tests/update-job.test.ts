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
    // Service reinstall keeps its own port contract — do not append --port.
    expect(restartCommand(true, "npm", "/pkg/bin/ocx.mjs", 10100).args).toEqual([
      "/pkg/bin/ocx.mjs", "service", "install",
    ]);
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
