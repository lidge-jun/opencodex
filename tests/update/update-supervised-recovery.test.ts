/**
 * Manager-mediated update recovery (#7043): launchd/systemd restart the job they hold, and a
 * recovery counts only when the serving proxy is that job. Every manager call is injected; an
 * armed test process must never reach the developer's real service.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  LAUNCHD_SERVICE_LABEL,
  freshServingPid,
  unsettledManagerWarning,
  SYSTEMD_SERVICE_UNIT,
  parseLaunchdJobPid,
  parseSystemdMainPid,
  readParentPid,
  readServiceManagerPid,
  restartServiceManagerJob,
  supervisionVerdict,
  unsupervisedRuntimeWarning,
} from "../../src/update/supervised-recovery.mjs";
import { LABEL, TASK } from "../../src/service/state";
import { repoPath } from "../helpers/repo-root";

type Call = { file: string; args: string[] };
function recorder(reply: { ok: boolean; stdout?: string; stderr?: string }) {
  const calls: Call[] = [];
  const run = (file: string, args: string[]) => {
    calls.push({ file, args });
    return { ok: reply.ok, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  };
  return { calls, run };
}

describe("service manager commands", () => {
  test("a final authority refusal is returned without a manager dispatch", () => {
    const { calls, run } = recorder({ ok: true });
    expect(restartServiceManagerJob({ platform: "linux", run }, () => false)).toMatchObject({ ok: false, refused: true });
    expect(calls).toEqual([]);
  });
  test("the shared names match the service layer's label and unit", () => {
    expect(LAUNCHD_SERVICE_LABEL).toBe(LABEL);
    expect(SYSTEMD_SERVICE_UNIT).toBe(TASK);
  });

  test("macOS restarts the loaded job in place with kickstart -k", () => {
    const { calls, run } = recorder({ ok: true });
    expect(restartServiceManagerJob({ platform: "darwin", uid: 501, run }, () => true)).toEqual({ ok: true });
    expect(calls).toEqual([{ file: "/bin/launchctl", args: ["kickstart", "-k", `gui/501/${LABEL}`] }]);
  });

  test("Linux restarts the user unit through systemctl", () => {
    const { calls, run } = recorder({ ok: true });
    expect(restartServiceManagerJob({ platform: "linux", uid: 1000, run }, () => true)).toEqual({ ok: true });
    expect(calls).toEqual([{ file: "systemctl", args: ["--user", "restart", TASK] }]);
  });

  test("a refused restart and an unsupported platform are failures, never thrown", () => {
    const { run } = recorder({ ok: false, stderr: "Could not find service\nmore" });
    expect(restartServiceManagerJob({ platform: "darwin", uid: 501, run }, () => true)).toEqual({ ok: false, reason: "Could not find service" });
    expect(restartServiceManagerJob({ platform: "win32", run }, () => true).ok).toBe(false);
  });

  test("manager PIDs are parsed from launchctl print and systemctl show", () => {
    expect(parseLaunchdJobPid("gui/501/x = {\n\tstate = running\n\tpid = 4242\n}")).toBe(4242);
    expect(parseLaunchdJobPid("\tstate = not running\n")).toBeNull();
    expect(parseSystemdMainPid("MainPID=777\n")).toBe(777);
    expect(parseSystemdMainPid("MainPID=0\n")).toBeNull();
    const launchd = recorder({ ok: true, stdout: "\tpid = 99\n" });
    expect(readServiceManagerPid({ platform: "darwin", uid: 501, run: launchd.run })).toBe(99);
    expect(launchd.calls[0]).toEqual({ file: "/bin/launchctl", args: ["print", `gui/501/${LABEL}`] });
    const systemd = recorder({ ok: true, stdout: "MainPID=31\n" });
    expect(readServiceManagerPid({ platform: "linux", run: systemd.run })).toBe(31);
    expect(readParentPid(31, { run: recorder({ ok: true, stdout: "  12\n" }).run })).toBe(12);
  });
});

describe("a restart the manager may still finish", () => {
  test("a client timeout is unsettled, never a plain failure", () => {
    const run = () => ({ ok: false, stdout: "", stderr: "spawnSync systemctl ETIMEDOUT", timedOut: true });
    const result = restartServiceManagerJob({ platform: "linux", run }, () => true);
    expect(result).toMatchObject({ ok: false, unsettled: true });
    expect(unsettledManagerWarning(10100)).toContain("no second proxy was started");
  });
  test("a runtime record still naming the pre-restart process is not the restarted proxy", () => {
    expect(freshServingPid(40, 40)).toBeNull();
    expect(freshServingPid(41, 40)).toBe(41);
    expect(freshServingPid(41, null)).toBe(41);
  });
});

describe("supervision verdict: manager PID against serving PID", () => {
  const noParent = () => null;
  test("the serving proxy is the manager's job or its launcher's direct child", () => {
    expect(supervisionVerdict({ servingPid: 50, managerPid: 50, parentPid: noParent }))
      .toEqual({ kind: "supervised", managerPid: 50, servingPid: 50 });
    expect(supervisionVerdict({ servingPid: 51, managerPid: 50, parentPid: pid => (pid === 51 ? 50 : null) }))
      .toEqual({ kind: "supervised", managerPid: 50, servingPid: 51 });
  });

  test("a detached proxy that the manager does not own is not a recovery", () => {
    const verdict = supervisionVerdict({ servingPid: 900, managerPid: 50, parentPid: () => 1 });
    expect(verdict.kind).toBe("failed");
    if (verdict.kind === "failed") expect(verdict.reason).toContain("not the manager's job");
  });

  test("no answering proxy, or no manager process, is not a recovery", () => {
    expect(supervisionVerdict({ servingPid: null, managerPid: 50, parentPid: noParent }).kind).toBe("failed");
    expect(supervisionVerdict({ servingPid: 50, managerPid: null, parentPid: noParent }).kind).toBe("failed");
  });

  test("the unsupervised warning names the port and the repair command", () => {
    const warning = unsupervisedRuntimeWarning(10100);
    expect(warning).toContain("10100");
    expect(warning).toContain("UNSUPERVISED");
    expect(warning).toContain("ocx service repair");
  });
});

describe("armed test processes never reach the live manager", () => {
  const previous = process.env.OCX_TEST_HOME_GUARD;
  afterEach(() => {
    if (previous === undefined) delete process.env.OCX_TEST_HOME_GUARD;
    else process.env.OCX_TEST_HOME_GUARD = previous;
  });
  test("the default runner refuses launchctl and systemctl", () => {
    process.env.OCX_TEST_HOME_GUARD = "1";
    for (const platform of ["darwin", "linux"] as const) {
      const result = restartServiceManagerJob({ platform, uid: 501 }, () => true);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("armed test process");
    }
  });
});

describe("the Bun updater tries the manager before any detached start", () => {
  const source = readFileSync(repoPath("src/update/index.ts"), "utf8");
  test("manager restart precedes the post-install direct fallback, which exits non-zero", () => {
    const managerAt = source.indexOf("const managed = await restartThroughServiceManager();");
    const fallbackAt = source.indexOf("starting the proxy directly instead");
    expect(managerAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(managerAt);
    const tail = source.slice(fallbackAt, source.indexOf("} finally {", fallbackAt));
    expect(tail).toContain('if (await startUnsupervisedFallback() === "vetoed") return homePolicy.authorizeMutation("publish") ? undefined : 1;');
    expect(tail).toContain("return 1;");
    expect(tail).not.toContain("startProxyDirectly()");
  });
  test("failed-update recovery of a managed install also asks the manager first", () => {
    const start = source.indexOf("const recoverStoppedRuntime = async");
    const recovery = source.slice(start, source.indexOf("  try {\n  // Never replace package files", start));
    const replanAt = recovery.indexOf('if ((await planRecovery()).action === "service") {');
    const managerAt = recovery.indexOf("await restartThroughServiceManager()");
    expect(replanAt).toBeGreaterThan(-1);
    expect(managerAt).toBeGreaterThan(replanAt);
    expect(managerAt).toBeGreaterThan(-1);
    expect(recovery.indexOf("await startUnsupervisedFallback()", managerAt)).toBeGreaterThan(managerAt);
  });
});
