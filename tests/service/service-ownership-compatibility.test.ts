import { describe, expect, test } from "bun:test";
import {
  assessServiceTakeoverCompatibility,
  registeredManagingCliInvocation,
  type ManagingCliObservation,
} from "../../src/service/ownership-compatibility";
import type { ServiceInstallState, ServiceOwnershipSubject } from "../../src/service/state";
import {
  inspectGuardedManagerTarget,
  managerOwnsApprovedPid,
  observeGuardedManagerStopped,
} from "../../src/service/guarded-manager-target";
import { probeSystemdUnitInactive, unitPath } from "../../src/service/systemd";

const SUBJECT: ServiceOwnershipSubject = { kind: "none", revision: 7 };
const OWNERSHIP_AWARE_STATE: ServiceInstallState = {
  version: 2,
  codexHome: "/codex",
  opencodexHome: "/opencodex",
  backend: "scheduler",
  revision: 7,
  ownershipProtocolVersion: 1,
};

const absent: ManagingCliObservation = { status: "absent" };
const observed = (version: string, identity = `manager-${version}`): ManagingCliObservation => ({
  status: "observed", version, identity,
});

function assess(options: {
  state?: ServiceInstallState | null;
  service?: ManagingCliObservation;
  path?: ManagingCliObservation;
} = {}) {
  return assessServiceTakeoverCompatibility({
    state: options.state === undefined ? OWNERSHIP_AWARE_STATE : options.state,
    subject: SUBJECT,
    managers: {
      "service-registration": options.service ?? observed("2.61.0", "registered-manager"),
      path: options.path ?? observed("2.61.0", "path-manager"),
    },
  });
}

describe("permanent takeover compatibility", () => {
  test("the preserved registration resolves to the exact baked invocation", () => {
    expect(registeredManagingCliInvocation({
      ...OWNERSHIP_AWARE_STATE,
      bunPath: "/runtime/bun",
      cliPath: "/package/src/cli/index.ts",
    })).toEqual({
      status: "resolved", executable: "/runtime/bun", args: ["/package/src/cli/index.ts"],
    });
    expect(registeredManagingCliInvocation({
      ...OWNERSHIP_AWARE_STATE,
      launcherPath: "/bin/ocx",
    })).toEqual({ status: "resolved", executable: "/bin/ocx", args: [] });
  });

  test("every managing CLI must be ownership-aware", () => {
    expect(assess({ path: observed("2.60.0") })).toMatchObject({
      kind: "blocked", reason: "managing-cli-unsupported",
    });
    expect(assess({ service: observed("2.61.0"), path: observed("2.62.0") })).toMatchObject({
      kind: "supported", protocolVersion: 1,
    });
  });

  test("unknown, malformed and prerelease observations do not authorize takeover", () => {
    expect(assess({ path: { status: "unknown", reason: "probe timed out" } })).toMatchObject({
      kind: "blocked", reason: "managing-cli-unknown",
    });
    for (const version of ["garbage", "2.61.0-preview.1", "2.60.99"]) {
      expect(assess({ path: observed(version) })).toMatchObject({
        kind: "blocked", reason: "managing-cli-unsupported",
      });
    }
  });

  test("a preserved service registration needs the state protocol marker too", () => {
    expect(assess({ state: { ...OWNERSHIP_AWARE_STATE, ownershipProtocolVersion: undefined } }))
      .toMatchObject({ kind: "blocked", reason: "service-protocol-unsupported" });
    expect(assess({ state: null, service: absent, path: observed("2.61.0") }))
      .toMatchObject({ kind: "supported" });
  });

  test("an unobserved manager set cannot retroactively protect an older CLI", () => {
    expect(assess({ state: null, service: absent, path: absent })).toMatchObject({
      kind: "blocked", reason: "managing-cli-unobserved",
    });
  });

  test("the compatibility token binds both manager identities and the approved subject", () => {
    const original = assess();
    const replacedPath = assess({ path: observed("2.61.0", "different-path-manager") });
    const differentSubject = assessServiceTakeoverCompatibility({
      state: OWNERSHIP_AWARE_STATE,
      subject: { kind: "none", revision: 8 },
      managers: {
        "service-registration": observed("2.61.0", "registered-manager"),
        path: observed("2.61.0", "path-manager"),
      },
    });
    expect(original.kind).toBe("supported");
    expect(replacedPath.kind).toBe("supported");
    expect(differentSubject.kind).toBe("supported");
    if (original.kind === "supported" && replacedPath.kind === "supported" && differentSubject.kind === "supported") {
      expect(replacedPath.token).not.toBe(original.token);
      expect(differentSubject.token).not.toBe(original.token);
    }
  });
});

describe("guarded service-manager binding", () => {
  test("only the approved process or its bounded ancestor owns the runtime", () => {
    const parents = new Map([[42, 17], [17, 7], [99, 88]]);
    const parentOf = (pid: number) => parents.get(pid) ?? null;
    expect(managerOwnsApprovedPid(42, 42, parentOf)).toBe(true);
    expect(managerOwnsApprovedPid(7, 42, parentOf)).toBe(true);
    expect(managerOwnsApprovedPid(88, 42, parentOf)).toBe(false);
    parents.set(17, 42);
    expect(managerOwnsApprovedPid(7, 42, parentOf)).toBe(false);
    parents.delete(42);
    expect(managerOwnsApprovedPid(7, 42, parentOf)).toBe(false);
  });

  test("launchd binds exactly one current loaded job to the approved PID", () => {
    const response = (status: number, stdout = "") => ({
      ok: status === 0, status, stdout, stderr: "",
    });
    const current = "arguments = command-marker\n pid = 7\n";
    const deps = {
      platform: "darwin" as const,
      verifyPid: (pid: number) => pid,
      parentOf: (pid: number) => pid === 42 ? 7 : null,
      expectedCommand: () => "command-marker",
    };
    const one = inspectGuardedManagerTarget(42, 10100, {
      ...deps,
      launchctl: ((args: string[]) => args[1]?.startsWith("gui/")
        ? response(0, current) : response(113)) as typeof import("../../src/service/launchd").runLaunchctl,
    });
    expect(one).toMatchObject({ kind: "bound", pid: 42, managerPid: 7 });
    const two = inspectGuardedManagerTarget(42, 10100, {
      ...deps,
      launchctl: (() => response(0, current)) as typeof import("../../src/service/launchd").runLaunchctl,
    });
    expect(two.kind).toBe("unknown");
  });

  test("post-stop manager status refuses loaded and unreadable jobs", async () => {
    const manager = { kind: "bound" as const, pid: 42, managerPid: 7, backend: "launchd" as const };
    for (const [state, expected] of [
      ["not-loaded", "inactive"],
      ["loaded-current", "active"],
      ["loaded-stale", "active"],
      ["unknown", "unknown"],
    ] as const) {
      expect(await observeGuardedManagerStopped(manager, {
        platform: "darwin",
        launchd: () => ({ state }),
      })).toBe(expected);
    }
    expect(probeSystemdUnitInactive({ show: () => "ActiveState=inactive\nMainPID=0" })).toBe("inactive");
    expect(probeSystemdUnitInactive({ show: () => "ActiveState=failed\nMainPID=0" })).toBe("unknown");
    expect(probeSystemdUnitInactive({ show: () => "ActiveState=failed\nMainPID=42" })).toBe("active");
    expect(probeSystemdUnitInactive({ show: () => "ActiveState=active\nMainPID=42" })).toBe("active");
    for (const state of ["activating", "deactivating", "reloading"]) {
      expect(probeSystemdUnitInactive({ show: () => `ActiveState=${state}\nMainPID=0` })).toBe("active");
    }
    expect(probeSystemdUnitInactive({ show: () => "ActiveState=broken\nMainPID=0" })).toBe("unknown");
    expect(probeSystemdUnitInactive({ show: () => "ActiveState=failed\nMainPID=oops" })).toBe("unknown");
    expect(probeSystemdUnitInactive({ show: () => { throw new Error("unreadable"); } })).toBe("unknown");
  });

  test("systemd binds the current unit ancestry; present Windows managers fail closed", () => {
    const output = ["LoadState=loaded", "ActiveState=active", "MainPID=7",
      `FragmentPath=${unitPath()}`, "NeedDaemonReload=no"].join("\n");
    const bound = inspectGuardedManagerTarget(42, 10100, {
      platform: "linux", verifyPid: pid => pid,
      parentOf: pid => pid === 42 ? 7 : null,
      systemdShow: () => output,
    });
    expect(bound).toMatchObject({ kind: "bound", pid: 42, managerPid: 7 });
    const stale = inspectGuardedManagerTarget(42, 10100, {
      platform: "linux", verifyPid: pid => pid,
      parentOf: pid => pid === 42 ? 7 : null,
      systemdShow: () => output.replace("NeedDaemonReload=no", "NeedDaemonReload=yes"),
    });
    expect(stale.kind).toBe("unknown");
    const windows = inspectGuardedManagerTarget(42, 10100, {
      platform: "win32", verifyPid: pid => pid,
      scheduler: () => ({ status: "present" }),
      winsw: () => "nonexistent",
    });
    expect(windows.kind).toBe("unknown");
  });

  test("a failed systemd unit with or without a PID blocks takeover", () => {
    const failed = ["LoadState=loaded", "ActiveState=failed", "MainPID=0"].join("\n");
    const deps = { platform: "linux" as const, verifyPid: (pid: number) => pid };
    expect(inspectGuardedManagerTarget(42, 10100, {
      ...deps, systemdShow: () => failed,
    }).kind).toBe("unknown");
    expect(inspectGuardedManagerTarget(42, 10100, {
      ...deps, systemdShow: () => failed.replace("MainPID=0", "MainPID=7"),
    }).kind).toBe("unknown");
  });
});
