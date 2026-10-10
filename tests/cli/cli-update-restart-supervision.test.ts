import { expect, test } from "bun:test";
import { probeUpdateRestartSupervision, runBoundedUpdateRestartSupervisor, resolveUpdateRestartSupervisor, type UpdateRestartSupervisionDeps } from "../../src/cli/update-restart-supervision";

const stat = () => ({ isFile: () => true, mode: 0o100755 });
const reply = (status: number | null, stdout = "") => ({ status, stdout, stderr: "" });
test("launchd probes both domains regardless of registration presence", () => {
  const calls: string[][] = [];
  const deps: UpdateRestartSupervisionDeps = { stat, platform: "darwin", uid: 42, now: () => 100,
    run: (_command, args, budget) => { calls.push(args); expect(budget).toBe(1900); return reply(args[1]!.startsWith("gui/") ? 112 : 113); } };
  expect(probeUpdateRestartSupervision(2000, deps)).toBe("inactive");
  expect(calls).toEqual([["print", "gui/42/com.opencodex.proxy"], ["print", "user/42/com.opencodex.proxy"]]);
});
test("launchd loaded, uncertain, signalled and non-absence exits block", () => {
  for (const status of [0, 1, 3, 5, null]) {
    let calls = 0;
    expect(probeUpdateRestartSupervision(2000, { stat, platform: "darwin", now: () => 100,
      run: () => reply(++calls === 1 ? status : 113) })).toBe(status === 0 ? "active" : "unknown");
    expect(calls).toBe(2);
  }
});
test("supervision honors remaining deadline before and after every command", () => {
  let now = 100; const budgets: number[] = [];
  const deps: UpdateRestartSupervisionDeps = { stat, platform: "darwin", now: () => now,
    run: (_command, _args, budget) => { budgets.push(budget); now += 50; return reply(113); } };
  expect(probeUpdateRestartSupervision(5000, deps)).toBe("inactive"); expect(budgets).toEqual([2000, 2000]);
  now = 100; budgets.length = 0;
  expect(probeUpdateRestartSupervision(180, deps)).toBe("unknown"); expect(budgets).toEqual([80, 30]);
  expect(() => runBoundedUpdateRestartSupervisor("manager", [], 200, { now: () => 200, run: () => { throw new Error("must not run"); } })).toThrow();
  expect(probeUpdateRestartSupervision(1000, { stat, platform: "darwin", now: () => 100, run: () => { throw new Error("timeout"); } })).toBe("unknown");
});
test("systemd requires explicit inactive state and MainPID zero", () => {
  for (const load of ["loaded", "not-found"]) {
    expect(probeUpdateRestartSupervision(2000, { stat, platform: "linux", now: () => 100,
      run: () => reply(0, `LoadState=${load}\nActiveState=inactive\nMainPID=0\n`) })).toBe("inactive");
  }
  for (const [output, expected] of [
    ["LoadState=loaded\nActiveState=active\nMainPID=23", "active"],
    ["LoadState=loaded\nActiveState=inactive\nMainPID=23", "active"],
    ["LoadState=loaded\nActiveState=activating\nMainPID=0", "unknown"],
    ["LoadState=loaded\nActiveState=failed\nMainPID=0", "unknown"],
    ["LoadState=loaded\nActiveState=inactive", "unknown"],
    ["LoadState=loaded\nActiveState=inactive\nMainPID=0\nMainPID=0", "unknown"],
    ["LoadState=error\nActiveState=inactive\nMainPID=0", "unknown"],
    ["garbage", "unknown"],
  ]) expect(probeUpdateRestartSupervision(2000, { stat, platform: "linux", now: () => 100, run: () => reply(0, output) })).toBe(expected!);
  expect(probeUpdateRestartSupervision(2000, { stat, platform: "linux", now: () => 100, run: () => reply(1) })).toBe("unknown");
});
test("Windows and unsupported platforms never infer inactivity", () => {
  for (const platform of ["win32", "freebsd"] as const) expect(probeUpdateRestartSupervision(2000, { platform, run: () => { throw new Error("must not probe"); } })).toBe("unknown");
});


test("manager resolution uses only usable trusted locations in preference order", () => {
  const attempts: string[] = [];
  expect(resolveUpdateRestartSupervisor({ platform: "linux", stat: path => {
    attempts.push(path); return { isFile: () => true, mode: path === "/usr/bin/systemctl" ? 0o100777 : 0o100755 };
  } })).toBe("/bin/systemctl");
  expect(attempts).toEqual(["/usr/bin/systemctl", "/bin/systemctl"]);
  for (const platform of ["darwin", "linux"] as const) for (const invalid of ["missing", "directory", "world-writable", "not-executable"]) {
    let runs = 0;
    expect(probeUpdateRestartSupervision(2000, { platform, now: () => 100,
      stat: () => {
        if (invalid === "missing") throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { isFile: () => invalid !== "directory", mode: invalid === "world-writable" ? 0o100777 : invalid === "not-executable" ? 0o100644 : 0o100755 };
      }, run: () => { runs++; return reply(113); },
    })).toBe("unknown");
    expect(runs).toBe(0);
  }
});

test("systemd probes discover missing SSH runtime dir and preserve explicit bus environment", () => {
  for (const environment of [{ PATH: "/shim" }, { XDG_RUNTIME_DIR: "/explicit", DBUS_SESSION_BUS_ADDRESS: "unix:path=/explicit/bus" }]) {
    const before = { ...environment }; let calls = 0;
    expect(probeUpdateRestartSupervision(2000, { stat, platform: "linux", uid: 42, now: () => 100, environment,
      exists: path => path === "/run/user/42", run: (command, _args, _budget, env) => {
        calls++; expect(command).toBe("/usr/bin/systemctl");
        expect(env).toEqual({ ...before, XDG_RUNTIME_DIR: before.XDG_RUNTIME_DIR ?? "/run/user/42" });
        return reply(0, "LoadState=loaded\nActiveState=inactive\nMainPID=0");
      },
    })).toBe("inactive");
    expect(environment).toEqual(before); expect(calls).toBe(1);
  }
  const environment = { PATH: "/fixture" };
  expect(probeUpdateRestartSupervision(2000, { stat, platform: "linux", environment, uid: 42, now: () => 100,
    exists: () => false, run: (_command, _args, _budget, env) => { expect(env).toEqual(environment); return reply(1); },
  })).toBe("unknown");
});
