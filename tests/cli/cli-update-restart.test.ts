import { describe, expect, spyOn, test } from "bun:test";
import { describeUpdateRestartFailure, runUpdateRestart, UpdateRestartEligibilityError, type UpdateRestartIo } from "../../src/cli/update-restart";
import type { UpdateRestartCandidate } from "../../src/cli/update-restart-candidate";
import { reportRestartFailure } from "../../src/cli/restart-failure";
import type { LiveProxy } from "../../src/server/proxy-liveness";

const candidate: UpdateRestartCandidate = {
  home: { config: { path: "/test/ocx", dev: 1, ino: 2 }, codex: { path: "/test/codex", dev: 1, ino: 3 }, revision: 0 },
  target: { pid: 123, port: 10100, hostname: "127.0.0.1", source: "runtime", version: "2.76.0" },
  runtime: { pid: 123, port: 10100, hostname: "127.0.0.1", attestationSecret: "a".repeat(43) },
  cliVersion: "2.77.0",
};
function setup() {
  const calls: string[] = [];
  let now = 1000;
  const home = { config: { path: "/test/ocx", dev: 1, ino: 2 }, codex: { path: "/test/codex", dev: 1, ino: 3 }, revision: 0 };
  const live: LiveProxy = { ...candidate.target, pid: 456, version: "2.77.0" };
  const io: UpdateRestartIo = {
    now: () => now, acquire: () => { calls.push("acquire"); return { release: () => { calls.push("release"); } }; },
    home: () => home, checkHome: () => {}, runtime: () => candidate.runtime,
    standalone: () => true, runtimeReady: () => true,
    stop: async (_target, _deadline, revalidate) => { revalidate(); calls.push("stop"); },
    stopped: async () => { calls.push("settle"); return true; },
    start: marker => { expect(marker).toEqual({ home, version: "2.77.0", port: 10100, hostname: "127.0.0.1", deadlineAt: 5000 }); calls.push("start"); return { pid: 456, exitCode: null, signalCode: null }; },
    observe: async (_deadline, pid) => { expect(pid).toBe(456); calls.push("observe"); return live; },
    wait: async ms => { now += ms; },
  };
  return { calls, io, live, expire: () => { now = 5000; } };
}
describe("CLI update restart transaction", () => {
  test("stops only the captured target, settles, launches once and verifies expected child/version", async () => {
    const s = setup();
    expect(await runUpdateRestart(candidate, 5000, s.io)).toEqual({ ok: true, live: s.live });
    expect(s.calls).toEqual(["acquire", "stop", "settle", "start", "release", "observe"]);
  });
  test("rejects unknown, missing, incomparable and newer proxy versions without stopping", async () => {
    for (const [cliVersion, version] of [["unknown", "2.76.0"], ["0.0.0", "2.76.0"], ["test", "2.76.0"], ["2.77.0", undefined], ["2.77.0", "2.78.0"], ["2.77.0", "test"]]) {
      const s = setup();
      expect((await runUpdateRestart({ ...candidate, cliVersion: cliVersion!, target: { ...candidate.target, version } }, 5000, s.io)).ok).toBe(false);
      expect(s.calls).toEqual([]);
    }
  });
  test("refuses PID, port, hostname, secret and sibling replacement before stop", async () => {
    for (const change of [{ pid: 124 }, { port: 10101 }, { hostname: "::1" }, { attestationSecret: "b".repeat(43) }, { siblingOfPort: 10101 }]) {
      const s = setup(); s.io.runtime = () => ({ ...candidate.runtime, ...change });
      expect((await runUpdateRestart(candidate, 5000, s.io)).ok).toBe(false);
      expect(s.calls).toEqual(["acquire", "release"]);
    }
  });
  test("refuses ambiguous ownership, home, supervisor and lease acquisition", async () => {
    for (const seam of ["home", "checkHome", "standalone", "acquire"] as const) {
      const s = setup();
      if (seam === "standalone") s.io.standalone = () => false;
      else s.io[seam] = () => { throw new Error("uncertain"); };
      expect((await runUpdateRestart(candidate, 5000, s.io)).ok).toBe(false);
      expect(s.calls).not.toContain("stop"); expect(s.calls).not.toContain("start");
    }
  });
  test("revalidates immediately before stop after asynchronous proof", async () => {
    const s = setup();
    s.io.stop = async (_target, _deadline, revalidate) => {
      s.io.runtime = () => ({ ...candidate.runtime, pid: 999 });
      revalidate(); s.calls.push("stop");
    };
    expect((await runUpdateRestart(candidate, 5000, s.io)).ok).toBe(false);
    expect(s.calls).toEqual(["acquire", "release"]);
  });
  test("failed/refused/ambiguous stop and drain timeout never launch", async () => {
    for (const seam of ["stop", "settle", "deadline"] as const) {
      const s = setup();
      if (seam === "stop") s.io.stop = async () => { throw new Error("uncertain response"); };
      if (seam === "settle") s.io.stopped = async () => false;
      if (seam === "deadline") s.io.stop = async () => { s.expire(); };
      expect((await runUpdateRestart(candidate, 5000, s.io)).ok).toBe(false);
      expect(s.calls).not.toContain("start"); expect(s.calls.at(-1)).toBe("release");
    }
  });
  test("ownership change after settlement never launches", async () => {
    const s = setup(); s.io.stopped = async () => { s.io.checkHome = () => { throw new Error("foreign claim"); }; return true; };
    expect((await runUpdateRestart(candidate, 5000, s.io)).ok).toBe(false);
    expect(s.calls).not.toContain("start");
  });
  test("failed and ambiguous child launches are terminal with no retry", async () => {
    for (const mode of ["throw", "no-pid", "exited", "old-pid"] as const) {
      const s = setup(); s.io.start = () => { s.calls.push("start"); if (mode === "throw") throw new Error("spawn"); return { pid: mode === "no-pid" ? undefined : mode === "old-pid" ? 123 : 456, exitCode: mode === "exited" ? 1 : null, signalCode: null }; };
      expect((await runUpdateRestart(candidate, 5000, s.io)).ok).toBe(false);
      expect(s.calls.filter(call => call === "start")).toHaveLength(1);
    }
  });
  test("unrelated PID, port, hostname, missing/wrong version and non-runtime replacement fail", async () => {
    for (const change of [{ pid: 999 }, { port: 10101 }, { hostname: "::1" }, { version: undefined }, { version: "2.76.0" }, { source: "config" as const }, { role: "client" }, { packageTreeFenced: true as const }]) {
      const s = setup(); s.io.observe = async () => ({ ...s.live, ...change });
      expect((await runUpdateRestart(candidate, 5000, s.io)).ok).toBe(false);
      expect(s.calls.filter(call => call === "start")).toHaveLength(1);
      expect(s.calls.filter(call => call === "stop")).toHaveLength(1);
    }
  });
  test("no health and deadline crossed by health never report success or retry", async () => {
    for (const late of [false, true]) {
      const s = setup(); s.io.observe = async () => { if (late) { s.expire(); return s.live; } return null; };
      expect((await runUpdateRestart(candidate, 5000, s.io)).ok).toBe(false);
      expect(s.calls.filter(call => call === "start")).toHaveLength(1);
    }
  });
  test("an incomplete runtime refuses before any stop, even through a transport that sanitizes beforeStop errors", async () => {
    const early = setup(); early.io.runtimeReady = () => false;
    expect(await runUpdateRestart(candidate, 5000, early.io)).toEqual({ ok: false, code: "update_restart_runtime_incomplete" });
    expect(early.calls).toEqual(["acquire", "release"]);
    // The runtime turns into the npm placeholder between eligibility and the stop exchange.
    const late = setup(); let checks = 0;
    late.io.runtimeReady = () => ++checks === 1;
    late.io.stop = async (_target, _deadline, beforeStop) => {
      try { beforeStop(); } catch { throw new Error("update_restart_stop_failed"); }
      late.calls.push("stop");
    };
    expect(await runUpdateRestart(candidate, 5000, late.io)).toEqual({ ok: false, code: "update_restart_runtime_incomplete" });
    expect(late.calls).toEqual(["acquire", "release"]);
  });
  test("after a confirmed stop, waits for the runtime and launches once it is complete", async () => {
    const s = setup(); let stopped = false;
    s.io.stopped = async () => { s.calls.push("settle"); stopped = true; return true; };
    let polls = 0;
    s.io.runtimeReady = () => !stopped || ++polls > 3;
    expect(await runUpdateRestart(candidate, 5000, s.io)).toEqual({ ok: true, live: s.live });
    expect(s.calls).toEqual(["acquire", "stop", "settle", "start", "release", "observe"]);
  });
  test("runtime timeout, late readiness and home change during the wait never launch", async () => {
    for (const mode of ["never", "at-deadline", "home"] as const) {
      const s = setup(); let stopped = false;
      s.io.stopped = async () => { s.calls.push("settle"); stopped = true; return true; };
      s.io.runtimeReady = () => !stopped;
      if (mode === "at-deadline") s.io.wait = async () => { s.expire(); s.io.runtimeReady = () => true; };
      if (mode === "home") s.io.wait = async () => { s.io.runtimeReady = () => true; s.io.checkHome = () => { throw new Error("foreign claim"); }; };
      const result = await runUpdateRestart(candidate, 5000, s.io);
      expect(result).toEqual({ ok: false, code: mode === "never" ? "update_restart_runtime_failed" : "update_restart_prelaunch_failed" });
      expect(s.calls).not.toContain("start"); expect(s.calls.at(-1)).toBe("release");
    }
  });
  test("failure text claims only what each phase proved", () => {
    for (const code of ["update_restart_runtime_incomplete", "update_restart_eligibility_failed"]) {
      expect(describeUpdateRestartFailure(code)).toContain("nothing was stopped");
    }
    for (const code of ["update_restart_stop_failed", "update_restart_settle_failed", "update_restart_replacement_failed", "update_restart_unknown"]) {
      expect(describeUpdateRestartFailure(code)).toContain("inspect `ocx status` before retrying");
      expect(describeUpdateRestartFailure(code)).not.toContain("run `ocx start`");
    }
    expect(describeUpdateRestartFailure("update_restart_runtime_failed")).toContain("nothing was launched");
    expect(describeUpdateRestartFailure("update_restart_prelaunch_failed")).toContain("nothing was launched");
    expect(describeUpdateRestartFailure("update_restart_start_failed")).toContain("launch could not be confirmed");
  });
});


describe("CLI restart recovery guidance", () => {
  test.each([
    ["windows", "owning service or desktop app"], ["service", "ocx service restart"],
    ["foreground", "restart it in that terminal"], ["shared_or_client", "ocx status"],
    ["package_tree_fenced", "troubleshooting/update-failed"], ["unverifiable_ancestry", "ocx status"],
    ["configuration_changed", "ocx status"], ["target_changed", "ocx status"],
  ] as const)("preserves %s eligibility without stopping and gives its next action", async (reason, action) => {
    const s = setup(); s.io.standalone = () => { throw new UpdateRestartEligibilityError(reason); };
    const result = await runUpdateRestart(candidate, 5000, s.io);
    expect(result).toEqual({ ok: false, code: "update_restart_eligibility_failed", reason });
    expect(s.calls).toEqual(["acquire", "release"]);
    if (!result.ok) expect(describeUpdateRestartFailure(result.code, result.reason)).toContain(action);
  });

  test("before-stop eligibility reason survives transport error sanitization", async () => {
    const s = setup(); let checks = 0;
    s.io.standalone = () => { if (++checks > 1) throw new UpdateRestartEligibilityError("service"); return true; };
    s.io.stop = async (_candidate, _deadline, revalidate) => {
      try { revalidate(); } catch { throw new Error("sanitized_transport_error"); }
      s.calls.push("stop");
    };
    expect(await runUpdateRestart(candidate, 5000, s.io)).toEqual({ ok: false, code: "update_restart_stop_failed", reason: "service" });
    expect(s.calls).toEqual(["acquire", "release"]);
  });

  test("unexpected eligibility exceptions never become a rendered reason", async () => {
    const s = setup(); s.io.standalone = () => { throw new Error("PRIVATE_CANARY\u001b"); };
    const result = await runUpdateRestart(candidate, 5000, s.io);
    expect(result).toEqual({ ok: false, code: "update_restart_eligibility_failed" });
    if (!result.ok) expect(describeUpdateRestartFailure(result.code, result.reason)).not.toContain("PRIVATE_CANARY");
  });

  test("older or incomparable CLI directs restart to the newer installation without downgrade commands", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      reportRestartFailure({ ok: false, phase: "request", error: new Error("restart_version_skew") });
      const text = errors.mock.calls.flat().join(" ");
      expect(text).toContain("older than the running proxy"); expect(text).toContain("newer installation's ocx");
      expect(text).toContain("which -a ocx"); expect(text).toContain("ocx status"); expect(text).toContain("No changes were made");
      expect(text).not.toContain("ocx stop"); expect(text).not.toContain("ocx start");
    } finally { errors.mockRestore(); }
  });

  test.each(["identity", "replacement", "request", "start"] as const)("%s restart failure names status without echoing an arbitrary error", phase => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      reportRestartFailure({ ok: false, phase, error: new Error("PRIVATE_CANARY") });
      expect(errors.mock.calls.flat().join(" ")).toContain("ocx status");
      expect(errors.mock.calls.flat().join(" ")).not.toContain("PRIVATE_CANARY");
    } finally { errors.mockRestore(); }
  });

  test("unsettled-package refusals offer repair when the installer is no longer running", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      reportRestartFailure({ ok: false, phase: "request", error: new Error("restart_package_tree_unsettled") });
      const lines = [errors.mock.calls.flat().join(" "), describeUpdateRestartFailure("update_restart_runtime_incomplete"),
        describeUpdateRestartFailure("update_restart_runtime_failed")];
      for (const text of lines) {
        expect(text).toContain("installer already exited or failed"); expect(text).toContain("stop any running proxy through its owner"); expect(text).toContain("reinstall with the same package manager");
        expect(text).toContain("https://opencodex.me/troubleshooting/update-failed");
      }
    } finally { errors.mockRestore(); }
  });
});


test("an unverified update home names status and the owning service recovery", () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    reportRestartFailure({ ok: false, phase: "request", error: new Error("update_restart_home_unverified") });
    const text = errors.mock.calls.flat().join(" ");
    expect(text).toContain("ocx status"); expect(text).toContain("ocx service restart"); expect(text).toContain("No changes were made");
  } finally { errors.mockRestore(); }
});
