import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { describeUpdateRestartFailure, observeUpdateRestartReplacement, reportUpdateRestartFailure, runUpdateRestart, UpdateRestartEligibilityError, type UpdateRestartIo } from "../../src/cli/update-restart";
import { repoPath } from "../helpers/repo-root";
import type { UpdateRestartCandidate } from "../../src/cli/update-restart-candidate";
import { reportRestartFailure } from "../../src/cli/restart-failure";
import { updateRestartVeto } from "../../src/update/restart-ownership";
import type { LiveProxy } from "../../src/server/proxy-liveness";
import { findLiveProxy } from "../../src/server/proxy-liveness";
import { isValidRuntimePortState } from "../../src/config/process-state";
import { runDesktopAwareProxyRestart } from "../../src/cli/desktop-runtime-guidance";
import { UpdateRestartRequired } from "../../src/cli/update-restart-candidate";
import { requestBoundSystemRestart } from "../../src/cli/system-restart-client";
import { LOCAL_ATTESTATION_CHALLENGE_HEADER, LOCAL_ATTESTATION_PROOF_HEADER, createLocalAttestationProof } from "../../src/lib/local-management-attestation";
import { SYSTEM_RESTART_CAPABILITY_VERSION } from "../../src/lib/system-restart-contract";
import { discoverStableProxyForRestart } from "../../src/cli/tray-proxy";

const candidate: UpdateRestartCandidate = {
  home: { config: { path: "/test/ocx", dev: 1, ino: 2, fileId: "1:2" }, codex: { path: "/test/codex", dev: 1, ino: 3, fileId: "1:3" }, revision: 0, serviceRecord: { schema: 1 as const, digest: "a".repeat(64) }, diagnosedHostname: "127.0.0.1" },
  target: { pid: 123, port: 10100, hostname: "127.0.0.1", source: "runtime", version: "2.76.0" },
  runtime: { pid: 123, port: 10100, hostname: "127.0.0.1", attestationSecret: "a".repeat(43) },
  cliVersion: "2.77.0",
};
test("production replacement verification binds the new record and rejects drift", async () => {
  const legacy = { ...candidate, runtime: { ...candidate.runtime, hostname: undefined } };
  const live = { ...candidate.target, pid: 456 };
  const fresh = { pid: 456, port: 10100, hostname: "127.0.0.1", attestationSecret: "b".repeat(43) };
  for (const mode of ["valid", "missing", "wildcard", "ipv6", "pid", "port", "sibling", "drift"] as const) {
    let reads = 0, proofs = 0;
    const first = mode === "missing" ? { ...fresh, hostname: undefined }
      : mode === "wildcard" ? { ...fresh, hostname: "0.0.0.0" }
      : mode === "ipv6" ? { ...fresh, hostname: "::1" }
      : mode === "pid" ? { ...fresh, pid: 999 }
      : mode === "port" ? { ...fresh, port: 9999 }
      : mode === "sibling" ? { ...fresh, siblingOfPort: 10101 } : fresh;
    const io = {
      findLive: async () => live,
      readRuntime: () => { reads++; return mode === "drift" && reads > 1 ? { ...first, attestationSecret: "c".repeat(43) } : first; },
      attest: async (options: { secret: string }) => { proofs++; expect(options.secret).toBe(fresh.attestationSecret); return { ...live, version: "2.77.0" }; },
    };
    if (mode === "valid") {
      expect(await observeUpdateRestartReplacement(legacy, 5000, 456, io)).toMatchObject({ pid: 456, version: "2.77.0" });
      expect(reads).toBe(2); expect(proofs).toBe(1);
    } else {
      await expect(observeUpdateRestartReplacement(legacy, 5000, 456, io)).rejects.toThrow();
      expect(proofs).toBe(mode === "drift" ? 1 : 0);
    }
  }
});
function setup() {
  const calls: string[] = [];
  let now = 1000;
  const home = { config: { path: "/test/ocx", dev: 1, ino: 2, fileId: "1:2" }, codex: { path: "/test/codex", dev: 1, ino: 3, fileId: "1:3" }, revision: 0, serviceRecord: { schema: 1 as const, digest: "a".repeat(64) }, diagnosedHostname: "127.0.0.1" };
  const live: LiveProxy = { ...candidate.target, pid: 456, version: "2.77.0" };
  const io: UpdateRestartIo = {
    inspectSupervision: () => ({ kind: "none" }),
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

test.each(["", " \t "])("composed restart reports blank record %j without a stop or start", async hostname => {
  const runtime = { ...candidate.runtime, hostname, attestationSecret: Buffer.alloc(32, 7).toString("base64url") };
  expect(isValidRuntimePortState(runtime)).toBe(true);
  const calls: string[] = [];
  const challenge = Buffer.alloc(32, 8).toString("base64url");
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    expect(new URL(String(input)).pathname).toBe("/healthz");
    const nonce = new Headers(init?.headers).get(LOCAL_ATTESTATION_CHALLENGE_HEADER);
    const proof = nonce ? createLocalAttestationProof(runtime.attestationSecret, nonce, runtime.pid, runtime.port) : null;
    return Response.json({ service: "opencodex", pid: runtime.pid, version: "2.76.0", restartCapability: SYSTEM_RESTART_CAPABILITY_VERSION },
      { headers: proof ? { [LOCAL_ATTESTATION_PROOF_HEADER]: proof } : {} });
  }) as typeof fetch;
  const discover = () => findLiveProxy({ readPidFn: () => runtime.pid, readRuntimeFn: () => runtime,
    verifyPidFn: pid => pid, configFn: () => ({ port: runtime.port }), fetchFn: fetchImpl, nowFn: () => 1000 });
  const s = setup();
  const result = await runDesktopAwareProxyRestart({
    findLive: () => discoverStableProxyForRestart({ findLive: discover, waitBetweenChecks: async () => {} }),
    requestInPlaceRestart: previous => requestBoundSystemRestart(previous, 5000, {
      fetchImpl, readRuntime: () => runtime, findLive: discover, createChallenge: () => challenge,
      now: () => 1000, cliVersion: candidate.cliVersion, readUpdateHome: () => candidate.home,
    }),
    startWhenStopped: () => { calls.push("fallback start"); return { status: "started" }; },
    waitForReplacement: async () => { calls.push("replacement wait"); return null; },
  }, () => ({ kind: "none" }));
  expect(result.ok).toBe(false);
  if (result.ok || result.phase !== "request" || !(result.error instanceof UpdateRestartRequired)) throw new Error("candidate not produced");
  s.io.runtime = () => runtime;
  const update = await runUpdateRestart(result.error.candidate(), 5000, s.io);
  expect(update).toEqual({ ok: false, code: "update_restart_eligibility_failed", reason: "blank_runtime_hostname" });
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    if (!update.ok) reportUpdateRestartFailure(update);
    expect(errors.mock.calls).toEqual([["❌ The running proxy's runtime record has a blank hostname, so its bind address cannot be verified. Use `ocx status` and `ocx service status` as clues, not proof of ownership or bind address. Once ownership is verified, for a service use the owning installation's `ocx service restart`; for Desktop, use the app; for a foreground proxy, use its terminal. For a detached standalone proxy, independently verify its process, home, supervisor and actual bind. If verified and forced termination is acceptable, the owner can run `ocx stop` from that installation and home; it may refuse or force termination if graceful shutdown fails. Independently confirm the process has exited, its supervisor will not restart it, and the intended address and port are free before running `ocx start` with the intended settings. If any step is uncertain or fails, stop and ask the owner or administrator; do not edit the runtime record or kill unrelated processes. Nothing was stopped by this restart attempt. (update_restart_eligibility_failed)"]]);
  } finally { errors.mockRestore(); }
  expect(calls).toEqual(["GET /healthz", "GET /healthz", "GET /healthz"]);
  expect(s.calls).toEqual(["acquire", "release"]);

  // A record changed after proof cannot become an update candidate.
  let reads = 0;
  const drift = await requestBoundSystemRestart(candidate.target, 5000, {
    fetchImpl, readRuntime: () => ++reads === 1 ? runtime : { ...runtime, hostname: "127.0.0.1" },
    findLive: discover, createChallenge: () => challenge, now: () => 1000,
    cliVersion: candidate.cliVersion, readUpdateHome: () => candidate.home,
  });
  expect(drift.accepted).toBe(false);
  if (drift.accepted) throw new Error("drift accepted");
  expect(drift.uncertain).toBe(false);
  expect((drift.error as Error).message).toBe("restart_target_changed");
  const badProof = await requestBoundSystemRestart(candidate.target, 5000, {
    fetchImpl: (async () => Response.json({ service: "opencodex", pid: runtime.pid },
      { headers: { [LOCAL_ATTESTATION_PROOF_HEADER]: "A".repeat(43) } })) as typeof fetch,
    readRuntime: () => runtime, findLive: discover, createChallenge: () => challenge,
    now: () => 1000, cliVersion: candidate.cliVersion, readUpdateHome: () => candidate.home,
  });
  expect(badProof.accepted).toBe(false);
  if (badProof.accepted) throw new Error("bad proof accepted");
  expect((badProof.error as Error).message).toBe("restart_attestation_failed");
  expect(s.calls).toEqual(["acquire", "release"]);
});
describe("CLI update restart transaction", () => {
  test("an oversized child handoff refuses before stopping", async () => {
    const s = setup();
    const bad = { ...candidate, home: { ...candidate.home, config: { ...candidate.home.config, path: "x".repeat(8192) } } };
    s.io.home = () => bad.home;
    expect((await runUpdateRestart(bad, 5000, s.io)).ok).toBe(false);
    expect(s.calls).not.toContain("stop");
  });
  test("a malformed or unsupported bind handoff refuses before stopping", async () => {
    for (const hostname of ["localhost", "invalid host", "a".repeat(256)]) {
      const s = setup();
      const bad = { ...candidate, home: { ...candidate.home, diagnosedHostname: hostname } };
      s.io.home = () => bad.home;
      expect((await runUpdateRestart(bad, 5000, s.io)).ok).toBe(false);
      expect(s.calls).not.toContain("stop");
    }
  });
  test("malformed IP bind spellings never reach stop", async () => {
    for (const hostname of ["[::1", "::1]", ":::", "[:::]"]) {
      const s = setup();
      const bad = { ...candidate, target: { ...candidate.target, hostname }, runtime: { ...candidate.runtime, hostname } };
      s.io.runtime = () => bad.runtime;
      expect((await runUpdateRestart(bad, 5000, s.io)).ok).toBe(false);
      expect(s.calls).not.toContain("stop");
    }
  });
  test("a legacy absent hostname hands the verified default bind to the replacement", async () => {
    const s = setup();
    const legacy = { ...candidate, runtime: { ...candidate.runtime, hostname: undefined } };
    s.io.runtime = () => legacy.runtime;
    expect(await runUpdateRestart(legacy, 5000, s.io)).toEqual({ ok: true, live: s.live });
    expect(s.calls.filter(call => call === "stop")).toHaveLength(1);
  });
  test.each(["", " \t "])("a present blank runtime hostname %j refuses before stop", async hostname => {
    const s = setup();
    const bad = { ...candidate, runtime: { ...candidate.runtime, hostname, attestationSecret: "PRIVATE_CANARY\u001b" } };
    s.io.runtime = () => bad.runtime;
    const result = await runUpdateRestart(bad, 5000, s.io);
    expect(s.calls).toEqual(["acquire", "release"]);
    expect(result).toEqual({ ok: false, code: "update_restart_eligibility_failed", reason: "blank_runtime_hostname" });
    if (result.ok) throw new Error("blank hostname accepted");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      reportUpdateRestartFailure(result);
      expect(errors.mock.calls).toEqual([[`❌ ${describeUpdateRestartFailure(result.code, result.reason)} (update_restart_eligibility_failed)`]]);
    } finally { errors.mockRestore(); }
  });
  test("the CLI sends update restart failures to the reporting function", () => {
    const source = readFileSync(repoPath("src", "cli", "index.ts"), "utf8");
    expect(source).toContain("else reportUpdateRestartFailure(update);");
  });
  test.each([["127.0.0.1", "127.0.0.1"], ["localhost", "127.0.0.1"], ["::1", "::1"], ["0.0.0.0", "0.0.0.0"], ["::", "::"], ["[::]", "[::]"], ["*", "*"]])("preserves bind %s in the transaction with injected eligibility", async (hostname, expectedHost) => {
    const s = setup();
    const bound = { ...candidate, target: { ...candidate.target, hostname }, runtime: { ...candidate.runtime, hostname } };
    const live = { ...s.live, hostname };
    s.io.runtime = () => bound.runtime;
    s.io.start = marker => { expect(marker.hostname).toBe(expectedHost); s.calls.push("start"); return { pid: 456, exitCode: null, signalCode: null }; };
    s.io.observe = async () => live;
    expect(await runUpdateRestart(bound, 5000, s.io)).toEqual({ ok: true, live });
    expect(s.calls.filter(call => call === "stop")).toHaveLength(1);
  });
  test.each(["0.0.0.0", "::", "*"])("refuses a wildcard target %s with a default runtime bind", async hostname => {
    for (const runtimeHost of [undefined, "127.0.0.1"]) {
      const s = setup();
      const bad = { ...candidate, target: { ...candidate.target, hostname }, runtime: { ...candidate.runtime, hostname: runtimeHost } };
      s.io.runtime = () => bad.runtime;
      expect(await runUpdateRestart(bad, 5000, s.io)).toEqual({ ok: false, code: "update_restart_eligibility_failed" });
      expect(s.calls).toEqual(["acquire", "release"]);
    }
  });
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


test("dashboard update restart veto gives Desktop update guidance with injected supervision", () => {
  const resolve = () => ({ kind: "none" as const, revision: 0 });
  expect(updateRestartVeto(resolve, () => ({
    kind: "desktop", runtimePid: 321, supervisorPid: 123, app: "/fixture/opencodex-desktop", proxy: "/fixture/ocx",
  }))).toContain("use the app's updater (tray → Check for Updates)");
  expect(updateRestartVeto(resolve, () => ({ kind: "unknown", reason: "probe-failed", desktopSeen: true })))
    .toContain("quit OpenCodex first");
  expect(updateRestartVeto(resolve, () => ({ kind: "unknown", reason: "probe-failed", desktopSeen: false }))).toBeNull();
});
