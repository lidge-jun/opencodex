import { afterEach, expect, spyOn, test } from "bun:test";
import { stopWindowsServiceChecked, type WindowsCheckedStopDeps } from "../../src/service/windows-checked-stop";
import { windowsCheckedStopLiveDeps } from "../../src/service/windows-checked-stop-live";
import { parseWindowsProcessSnapshot, windowsProcessSnapshot } from "../../src/service/windows-process-evidence";
import { setWindowsProcessNativeForTests } from "../../src/service/windows-process-native";
import { runWindowsServiceStopPartA, setWindowsServiceStopHooksForTests } from "../../src/service/windows-service-stop";
import { windowsLauncherVbsPath } from "../../src/service/state";
import { verifyWindowsTaskStopProof } from "../../src/service/windows-task-instance-stop";
import { buildWindowsTaskXml, windowsTaskRegistrationHealthy } from "../../src/service/windows-taskxml";
import { PATHS, SCHEDULE_PID, supervisedTree } from "../helpers/windows-checked-stop-fixtures";
import { partAResult } from "../helpers/windows-stop-caller-fixtures";

afterEach(() => {
  setWindowsServiceStopHooksForTests(null);
  setWindowsProcessNativeForTests(undefined);
});

const SID = "S-1-5-21-100-200-300-1001";
const FOREIGN = "S-1-5-21-100-200-300-1002";
const launcher = windowsLauncherVbsPath();
const ownedXml = buildWindowsTaskXml(undefined, launcher, undefined, SID)
  .replace('<Principal id="Author">', `<Principal id="Author"><UserId>${SID}</UserId>`);
const proof = (xml: string) => Buffer.from(JSON.stringify({ xml, sid: SID })).toString("base64");
const legacy = (xml: string) => xml.replace(/<SessionStateChangeTrigger>[\s\S]*?<\/SessionStateChangeTrigger>/g, "");

function machine(overrides: Partial<WindowsCheckedStopDeps> = {}) {
  const terminated: number[] = [];
  const dead = new Set<number>();
  const deps: WindowsCheckedStopDeps = {
    canonicalPaths: PATHS, childPid: 42, selfPid: 1,
    probeScheduler: () => ({ status: "present" }), probeWinsw: () => "nonexistent",
    enumerate: () => supervisedTree(), scheduleServicePid: () => SCHEDULE_PID,
    endTask: () => "ended", taskState: () => "not-running", winswStop: () => "sent",
    winswState: () => "stopped", proxyAlive: () => false,
    openWatch: pid => ({ status: "open", exited: () => dead.has(pid), close() {} }),
    terminate: pid => { terminated.push(pid); dead.add(pid); return { status: "terminated", exited: true }; },
    ...overrides,
  };
  return { deps, terminated };
}

for (const oldShape of [false, true]) {
  test(`Scheduler stop refuses a foreign logon scope in the ${oldShape ? "legacy" : "recovery"} shape`, () => {
    const xml = (oldShape ? legacy(ownedXml) : ownedXml).replace(/(<LogonTrigger>[\s\S]*?<UserId>)[^<]+/, `$1${FOREIGN}`);
    expect(verifyWindowsTaskStopProof(proof(xml), launcher)).toBe(false);
    expect(windowsTaskRegistrationHealthy(xml, undefined, launcher, SID)).toBe(false);
  });
}

for (const scope of [FOREIGN, "", "prefixed", "self-closing"]) {
  test(`Scheduler stop and installation health refuse an additional ${scope || "unscoped"} recovery trigger`, () => {
    const extra = scope === "self-closing" ? "<SessionStateChangeTrigger />"
      : scope === "prefixed" ? `<t:SessionStateChangeTrigger><t:UserId>${FOREIGN}</t:UserId></t:SessionStateChangeTrigger>`
      : `<SessionStateChangeTrigger><StateChange>ConsoleConnect</StateChange>${scope ? `<UserId>${scope}</UserId>` : ""}</SessionStateChangeTrigger>`;
    const xml = ownedXml.replace("</Triggers>", extra + "</Triggers>");
    expect(verifyWindowsTaskStopProof(proof(xml), launcher)).toBe(false);
    expect(windowsTaskRegistrationHealthy(xml, undefined, launcher, SID)).toBe(false);
  });
}

test("owned trigger scopes and the recognized unscoped legacy logon remain valid", () => {
  expect(verifyWindowsTaskStopProof(proof(ownedXml), launcher)).toBe(true);
  expect(windowsTaskRegistrationHealthy(ownedXml, undefined, launcher, SID)).toBe(true);
  const unscopedLegacy = legacy(ownedXml).replace(/(<LogonTrigger>[\s\S]*?)<UserId>[^<]+<\/UserId>/, "$1");
  expect(verifyWindowsTaskStopProof(proof(unscopedLegacy), launcher)).toBe(true);
  const unscopedCurrent = ownedXml.replace(/(<LogonTrigger>[\s\S]*?)<UserId>[^<]+<\/UserId>/, "$1");
  expect(verifyWindowsTaskStopProof(proof(unscopedCurrent), launcher)).toBe(false);
});

test("an asynchronous authorizer cannot dispatch a wrapper terminate after the outer cap", async () => {
  let elapsed = 0, approvals = 0;
  const now = spyOn(performance, "now").mockImplementation(() => elapsed);
  const fake = machine();
  setWindowsServiceStopHooksForTests({ liveDeps: () => fake.deps });
  try {
    await runWindowsServiceStopPartA({ capMs: 50, authorize: async () => {
      await Promise.resolve();
      if (++approvals === 3) elapsed = 50;
    } }).catch(() => undefined);
    expect(approvals).toBe(3);
    expect(fake.terminated).toEqual([]);
  } finally { now.mockRestore(); }
});

test("an authorizer that completes inside the cap preserves ordinary wrapper termination", async () => {
  const fake = machine();
  setWindowsServiceStopHooksForTests({ liveDeps: () => fake.deps });
  const result = await runWindowsServiceStopPartA({ capMs: 500, authorize: async () => { await Promise.resolve(); } });
  expect(result.outcome).toBe("stopped");
  expect(fake.terminated).toEqual([30, 20]);
});

test("the live terminate checks the cap immediately before entering the native primitive", async () => {
  let terminated = 0;
  setWindowsProcessNativeForTests({ creationTime: () => 5_000, scheduleServicePid: () => null,
    openWatch: () => ({ status: "unavailable" }),
    terminate: () => { terminated++; return { status: "terminated" }; },
  });
  const deps = windowsCheckedStopLiveDeps({ gate: () => false });
  expect(await deps.terminate(20, 5_000, 1_000)).toEqual({ status: "unavailable" });
  expect(terminated).toBe(0);
});

test("a late Part A result preserves known mutation and termination evidence while refusing success", async () => {
  let elapsed = 0;
  const now = spyOn(performance, "now").mockImplementation(() => elapsed);
  const known = { ...partAResult("stopped"), changed: true, terminated: [30, 20] };
  setWindowsServiceStopHooksForTests({ partA: async () => { elapsed = 50; return known; } });
  try {
    const result = await runWindowsServiceStopPartA({ capMs: 50 });
    expect(result).toMatchObject({ outcome: "unknown", reason: "evidence-unreadable", changed: true, terminated: [30, 20] });
    expect(result.detail).toBe("the checked stop did not finish within its cap");
  } finally { now.mockRestore(); }
});

for (const outcome of ["failed-before-dispatch", "unverified", "budget-before-stop", "partial-stop", "denied-after-stop", "lost-after-approval", "lost-successful-result"] as const) {
  test(`Scheduler mutation evidence survives ${outcome}`, async () => {
    const live = windowsCheckedStopLiveDeps({ run: async (_program, _args, _timeout, authorizeProof) => {
      if (outcome === "failed-before-dispatch") return { status: null, stdout: "", stderr: "PowerShell not found", timedOut: false };
      if (outcome === "unverified") return { status: 0, stdout: "unverified-registration", stderr: "", timedOut: false };
      expect(await authorizeProof?.(proof(ownedXml))).toBe(true);
      if (outcome === "budget-before-stop" || outcome === "lost-successful-result") return {
        status: 0, stdout: outcome === "budget-before-stop" ? "failed" : "", stderr: "", timedOut: false,
      };
      return { status: outcome === "lost-after-approval" ? null : 0,
        stdout: outcome === "lost-after-approval" ? "" : `stop-attempted\n${outcome === "denied-after-stop" ? "denied" : "failed"}`,
        stderr: "", timedOut: outcome === "lost-after-approval" };
    } });
    const fake = machine({ enumerate: () => [], endTask: live.endTask });
    const result = await stopWindowsServiceChecked(fake.deps);
    expect(result.outcome).toBe(outcome === "denied-after-stop" ? "denied" : "unknown");
    expect(result.changed).toBe(!["failed-before-dispatch", "unverified", "budget-before-stop"].includes(outcome));
    expect(fake.terminated).toEqual([]);
  });
}

test("a complete process table survives interrupted owner enrichment with ownership left unknown", async () => {
  const rows = [{ ProcessId: 20, ParentProcessId: 4, Name: "cmd.exe", CommandLine: "cmd.exe", CreationDate: "2026-11-12T01:02:03Z", CurrentUserSid: SID }];
  const baseline = "OCX_PROCESS_SNAPSHOT " + JSON.stringify(rows) + "\n";
  const result = await windowsProcessSnapshot({ timeoutMs: 5_000, run: async command => {
    expect(command).toMatchObject({ allowPartialOutput: true });
    return baseline + "OCX_PROCESS_SNAPSHOT [{\"ProcessId\":";
  } });
  expect(result).toEqual([{ pid: 20, parentPid: 4, name: "cmd.exe", commandLine: "cmd.exe",
    startTime: Date.parse(rows[0]!.CreationDate), foreignOwner: null }]);
  expect(parseWindowsProcessSnapshot("OCX_PROCESS_SNAPSHOT [{")).toBeNull();
});

test("completed owner enrichment supersedes the baseline only with a complete snapshot", () => {
  const row = { ProcessId: 20, ParentProcessId: 4, Name: "cmd.exe", CommandLine: "cmd.exe",
    CreationDate: "2026-11-12T01:02:03Z", CurrentUserSid: SID };
  const final = { ...row, Owner: { Sid: FOREIGN, ReturnValue: 0, CreationDate: row.CreationDate } };
  const output = `OCX_PROCESS_SNAPSHOT ${JSON.stringify([row])}\nOCX_PROCESS_SNAPSHOT ${JSON.stringify([final])}\n`;
  expect(parseWindowsProcessSnapshot(output)?.[0]?.foreignOwner).toBe(true);
});
