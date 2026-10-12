/**
 * What an update may do to a runtime it does not own.
 *
 * Two updaters reach the same situation: the Bun path in src/update/index.ts and the npm
 * and pnpm path in bin/ocx.mjs. Both stop the proxy and then run `ocx service repair`, and
 * under a desktop owner both halves are wrong — the running server is the app's bundled
 * sidecar, and the repair re-enables the npm launcher the takeover superseded. The rule is
 * one plain-ESM module for the reason #3008 recorded: two lanes deciding separately is how
 * a fix ships on one side only.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import {
  inspectPackageRuntimeLiveness,
  planStoppedRuntimeRecovery,
  planUpdateRuntimeHandling,
} from "../../src/update/runtime-ownership.mjs";
import { createSupervisionLatch, type SupervisionEvidence } from "../../src/service/desktop-supervision.mjs";
import { parseInstallStateRecord, selectAuthoritativeServiceState } from "../../src/service/install-state-contract.mjs";

describe("the runtime-ownership veto", () => {
  test("a desktop owner stops both the stop and the service refresh, and says so", () => {
    const plan = planUpdateRuntimeHandling({
      ownership: { owner: "desktop", installId: "app-install-a", consentGeneration: 3 },
      serviceInstalled: true,
    });
    expect(plan.mayReplacePackage).toBe(false);
    expect(plan.mayStopRuntime).toBe(false);
    expect(plan.mayRestoreService).toBe(false);
    expect(plan.notice).toContain("app-install-a");
    expect(plan.notice).toContain("consent generation 3");
    expect(plan.notice).toContain("neither re-enabled nor restarted");
  });

  test("a CLI owner and an unowned runtime both take the ordinary path", () => {
    for (const ownership of [null, { owner: "cli", installId: "npm-install", consentGeneration: 1 }]) {
      expect(planUpdateRuntimeHandling({ ownership, serviceInstalled: true }))
        .toEqual({ mayReplacePackage: true, mayStopRuntime: true, mayRestoreService: true, notice: null });
      expect(planUpdateRuntimeHandling({ ownership, serviceInstalled: false }))
        .toEqual({ mayReplacePackage: true, mayStopRuntime: true, mayRestoreService: false, notice: null });
    }
  });

  test("an owner this version does not recognise is treated as foreign, not as our own", () => {
    const plan = planUpdateRuntimeHandling({
      ownership: { owner: "something-newer", installId: "x", consentGeneration: 1 },
      serviceInstalled: true,
    });
    expect(plan.mayReplacePackage).toBe(false);
    expect(plan.mayStopRuntime).toBe(false);
  });
});

describe("stopped runtime recovery authority", () => {
  const base = {
    stopAttempted: true,
    ownership: null,
    ownershipUnknown: false,
    sameOwner: true,
    liveness: "dead" as const,
    serviceInstalled: false,
    launcherUsable: true,
    hadRuntimeState: true,
  };

  test("only the same readable CLI owner with dead endpoints can restart", () => {
    expect(planStoppedRuntimeRecovery(base)).toEqual({ action: "direct", reason: "same-cli-owner" });
    expect(planStoppedRuntimeRecovery({ ...base, serviceInstalled: true })).toEqual({
      action: "service", reason: "same-cli-owner",
    });
  });

  test("foreign, unknown and live outcomes never revive the stopped runtime", () => {
    expect(planStoppedRuntimeRecovery({ ...base, sameOwner: false })).toEqual({
      action: "none", reason: "ownership-transferred",
    });
    expect(planStoppedRuntimeRecovery({ ...base, ownershipUnknown: true })).toEqual({
      action: "manual", reason: "ownership-unknown",
    });
    for (const liveness of ["live", "unknown"] as const) {
      expect(planStoppedRuntimeRecovery({ ...base, liveness })).toEqual({
        action: "manual", reason: `runtime-${liveness}`,
      });
    }
  });
});

describe("replacement runtime inspection", () => {
  const capturedTarget = { hostname: "127.0.0.1", port: 10100 };

  test("the fresh runtime record is read and probed before the captured stop target", () => {
    const currentTarget = { hostname: "127.0.0.1", port: 10200 };
    const events: string[] = [];
    const result = inspectPackageRuntimeLiveness({
      capturedTarget,
      readCurrentTarget: () => { events.push("read-current"); return { kind: "target", target: currentTarget }; },
      probe: target => {
        events.push(`probe:${target.port}`);
        return target === currentTarget ? "live" : "dead";
      },
    });
    expect(events).toEqual(["read-current", `probe:${currentTarget.port}`, `probe:${capturedTarget.port}`]);
    expect(result).toEqual({ current: "live", captured: "dead", overall: "live" });
  });

  test("an absent current record stays distinct from a dead captured endpoint", () => {
    const events: string[] = [];
    const result = inspectPackageRuntimeLiveness({
      capturedTarget,
      readCurrentTarget: () => { events.push("read-current"); return { kind: "absent" }; },
      probe: target => { events.push(`probe:${target.port}`); return "dead"; },
    });
    expect(events).toEqual(["read-current", `probe:${capturedTarget.port}`]);
    expect(result).toEqual({ current: "absent", captured: "dead", overall: "dead" });
  });

  test("an unreadable current record fails closed even when the captured endpoint is dead", () => {
    const events: string[] = [];
    const result = inspectPackageRuntimeLiveness({
      capturedTarget,
      readCurrentTarget: () => { events.push("read-current"); return { kind: "unknown" }; },
      probe: target => { events.push(`probe:${target.port}`); return "dead"; },
    });
    expect(events).toEqual(["read-current", `probe:${capturedTarget.port}`]);
    expect(result).toEqual({ current: "unknown", captured: "dead", overall: "unknown" });
  });
});

describe("the Node and Bun paths share one full-record authority", () => {
  const state = (revision: number, installId = "desktop-a") => ({
    version: 2, codexHome: "/codex", opencodexHome: "/opencodex", backend: "scheduler",
    revision, ownership: { owner: "desktop" as const, installId, consentGeneration: 1 },
  });

  test("a complete record is required before ownership is projected", () => {
    expect(parseInstallStateRecord(state(1))?.ownership?.installId).toBe("desktop-a");
    expect(parseInstallStateRecord({ ownership: state(1).ownership })).toBeNull();
  });

  test("the default-home authority wins over an older active-home mirror", () => {
    const selected = selectAuthoritativeServiceState([
      { path: "active", kind: "valid", state: state(4, "old-owner") },
      { path: "default", kind: "valid", state: { ...state(5), ownership: undefined } },
    ]);
    expect(selected).toMatchObject({ kind: "state", revision: 5, needsRepair: true });
    if (selected.kind === "state") expect(selected.state.ownership).toBeUndefined();
  });

  test("same-or-newer mirror disagreement is unknown rather than a vote", () => {
    expect(selectAuthoritativeServiceState([
      { path: "active", kind: "valid", state: state(5, "other-owner") },
      { path: "default", kind: "valid", state: state(5) },
    ])).toMatchObject({ kind: "unknown" });
  });

  test("an absent authority imports one valid legacy record, while unreadable authority refuses", () => {
    expect(selectAuthoritativeServiceState([
      { path: "active", kind: "valid", state: state(3) },
      { path: "default", kind: "absent" },
    ])).toMatchObject({ kind: "state", revision: 3, needsRepair: true });
    expect(selectAuthoritativeServiceState([
      { path: "active", kind: "valid", state: state(3) },
      { path: "default", kind: "unreadable", reason: "EACCES" },
    ])).toMatchObject({ kind: "unknown" });
  });
});

describe("both updaters consult the shared rule", () => {
  const bunPath = readFileSync(repoPath("src", "update", "index.ts"), "utf8");
  const launcher = readFileSync(repoPath("bin", "ocx.mjs"), "utf8");

  test("the Bun updater gates its stop, its refresh and its restart hint", () => {
    expect(bunPath).toContain("from \"./runtime-ownership.mjs\"");
    expect(bunPath).toContain("if (runtimePlan.mayStopRuntime && (serviceWasInstalled || readPid() || readRuntimePort() || pendingTeardownOutstanding()))");
    expect(bunPath).toContain("if (!runtimePlan.mayReplacePackage)");
    expect(bunPath).toContain("if (postInstallPlan.mayRestoreService) {");
  });

  test("the npm launcher gates its stop, its refresh and its failure recovery", () => {
    expect(launcher).toContain("from \"../src/update/runtime-ownership.mjs\"");
    expect(launcher).toContain("if (stopNeeded && !runtimePlan.mayStopRuntime)");
    expect(launcher).toContain("if (stopNeeded) {");
    expect(launcher).toContain("if (!runtimePlan.mayReplacePackage)");
    expect(launcher).toContain("planStoppedRuntimeRecovery({");
    expect(launcher).toContain("if (postInstallPlan.mayRestoreService) {");
  });

  test("neither updater reimplements the decision", () => {
    for (const source of [bunPath, launcher]) {
      expect(source).toContain("planUpdateRuntimeHandling({");
      expect(source).not.toMatch(/owner\s*!==\s*"cli"/);
    }
  });

  /**
   * The launcher's own reader is what made the two lanes disagree, so its absence is the
   * property worth pinning: no JSON.parse of the state record, no claim validation, and the
   * contract module imported instead.
   */
  test("the launcher reads the record only through the shared contract", () => {
    expect(launcher).toContain('from "../src/service/install-state-contract.mjs"');
    expect(launcher).toContain("selectAuthoritativeServiceState(");
    expect(launcher).toContain("serviceStateFilesFor(");
    expect(launcher).not.toContain("parsed.ownership");
    const reader = launcher.slice(launcher.indexOf("const readOwnership = () =>"), launcher.indexOf("const ownershipIdentity ="));
    expect(reader).not.toContain("consentGeneration");
    // The authoritative reader delegates to the same module rather than keeping a twin.
    const state = readFileSync(repoPath("src", "service", "state.ts"), "utf8");
    expect(state).toContain('from "./install-state-contract.mjs"');
    expect(state).toContain("return parseInstallStateRecord(value)");
    expect(state).toContain("selectAuthoritativeServiceState(");
  });
});

describe("an unreadable record is not an unowned runtime", () => {
  test("unknown ownership vetoes both halves and points at the way back", () => {
    const plan = planUpdateRuntimeHandling({ ownership: null, ownershipUnknown: true, serviceInstalled: true });
    expect(plan.mayReplacePackage).toBe(false);
    expect(plan.mayStopRuntime).toBe(false);
    expect(plan.mayRestoreService).toBe(false);
    expect(plan.notice).toContain("could not be determined");
    expect(plan.notice).toContain("ocx service install");
  });

  test("the desktop notice also says how to clear a stale marker", () => {
    const plan = planUpdateRuntimeHandling({
      ownership: { owner: "desktop", installId: "a", consentGeneration: 1 },
      serviceInstalled: true,
    });
    expect(plan.notice).toContain("ocx service install");
  });
});

describe("every updater re-reads ownership before it starts a proxy directly", () => {
  const bunPath = readFileSync(repoPath("src", "update", "index.ts"), "utf8");
  const launcher = readFileSync(repoPath("bin", "ocx.mjs"), "utf8");
  const worker = readFileSync(repoPath("src", "update", "job.ts"), "utf8");

  /**
   * Ownership is sampled before a package install that can take minutes. If the app claims
   * the runtime during it, the post-update repair refuses — and both callers used to read
   * that refusal as a generic failure and start an npm proxy beside the app's sidecar.
   */
  test("the two package updaters re-resolve before the direct-start fallback", () => {
    for (const source of [bunPath, launcher]) {
      const fallbackAt = source.indexOf("starting the proxy directly instead");
      expect(fallbackAt).toBeGreaterThan(-1);
      const recheckAt = source.lastIndexOf("planUpdateRuntimeHandling({", fallbackAt);
      expect(recheckAt).toBeGreaterThan(-1);
      expect(source.slice(recheckAt, fallbackAt)).toContain("nowOwned.mayStopRuntime");
    }
  });

  /**
   * The dashboard is a third lane. It defaults to restarting, and after the package updater
   * correctly left a foreign-owned runtime alone it would reclaim the port, run the repair
   * that now refuses, and fall through to a direct start.
   */
  test("the dashboard worker checks before it restarts anything", () => {
    const restartAt = worker.indexOf("if (restart) {");
    const handoffAt = worker.indexOf("finishGuiUpdateRestart(", restartAt);
    const gateAt = worker.indexOf("runUpdateRestartWithOwnershipLease(", restartAt);
    expect(gateAt).toBeGreaterThan(restartAt);
    expect(gateAt).toBeLessThan(handoffAt);
    expect(worker.slice(gateAt)).toContain("outcome.kind === \"veto\"");
    expect(worker.slice(gateAt)).toContain("restarted: false");
    // The veto is the shared rule, not a second opinion about ownership.
    const veto = readFileSync(repoPath("src", "update", "restart-ownership.ts"), "utf8");
    expect(veto).toContain("planUpdateRuntimeHandling({");
    expect(veto).toContain("resolveServiceOwnership");
    expect(veto).toContain("acquireOwnershipMutationLease");
  });
});


const desktopEvidence: SupervisionEvidence = {
  kind: "desktop", runtimePid: 321, supervisorPid: 123, app: "/fixture/opencodex-desktop", proxy: "/fixture/ocx",
};
const desktopNotice = "OpenCodex Desktop runs this proxy from its own bundle; use the app's updater (tray → Check for Updates). "
  + "This npm/Bun install was left unchanged; quit OpenCodex first to update it.";

describe("live Desktop update authority", () => {
  test("supervision takes precedence over missing, CLI and unreadable durable ownership", () => {
    for (const ownership of [null, { owner: "cli", installId: "fixture", consentGeneration: 1 }]) {
      for (const supervision of [desktopEvidence, { kind: "unknown", reason: "probe-failed", desktopSeen: true } as const, true]) {
        expect(planUpdateRuntimeHandling({ ownership, ownershipUnknown: true, serviceInstalled: true, supervision }))
          .toEqual({ mayReplacePackage: false, mayStopRuntime: false, mayRestoreService: false, notice: desktopNotice });
      }
    }
  });

  test("none, unsupported and unknown without Desktop evidence preserve the ordinary policy", () => {
    for (const supervision of [{ kind: "none" }, { kind: "unsupported" },
      { kind: "unknown", reason: "probe-failed", desktopSeen: false }] as const) {
      expect(planUpdateRuntimeHandling({ ownership: null, serviceInstalled: true, supervision }))
        .toEqual({ mayReplacePackage: true, mayStopRuntime: true, mayRestoreService: true, notice: null });
      expect(planUpdateRuntimeHandling({ ownership: null, ownershipUnknown: true, serviceInstalled: true, supervision }).mayReplacePackage).toBe(false);
    }
  });

  test("one latch retains Desktop through inconclusive reads, and only none clears recovery and refresh", () => {
    const latch = createSupervisionLatch();
    for (const [evidence, blocked] of [
      [desktopEvidence, true],
      [{ kind: "unknown", reason: "probe-failed", desktopSeen: false }, true],
      [{ kind: "unsupported" }, true],
      [{ kind: "none" }, false],
    ] as const) {
      const supervision = latch.observe(evidence);
      expect(supervision).toBe(blocked);
      const plan = planUpdateRuntimeHandling({ ownership: null, serviceInstalled: true, supervision });
      expect(plan.mayReplacePackage).toBe(!blocked);
      expect(plan.mayStopRuntime).toBe(!blocked);
      expect(plan.mayRestoreService).toBe(!blocked);
      for (const serviceInstalled of [false, true]) {
        const recovery = planStoppedRuntimeRecovery({
          stopAttempted: true, ownership: null, sameOwner: true, liveness: "dead", serviceInstalled,
          launcherUsable: true, hadRuntimeState: true, supervision,
        });
        expect(recovery.action).toBe(blocked ? "none" : serviceInstalled ? "service" : "direct");
        if (blocked) expect(recovery.reason).toBe("desktop-supervised");
      }
    }
  });

  // Evaluate the actual pre-stop production blocks with injected inspectors and inert spawns.
  // The launcher module cannot be imported without executing its top-level dispatch.
  for (const lane of ["Bun", "Node"] as const) {
    test(`${lane}: none → Desktop at pre-stop performs zero stop/package/service mutations`, async () => {
      expect(await exercisePreStop(lane, desktopEvidence)).toEqual([0, 0, 0]);
    });
    test(`${lane}: desktopSeen at pre-stop activates the same refusal`, async () => {
      expect(await exercisePreStop(lane, { kind: "unknown", reason: "probe-failed", desktopSeen: true })).toEqual([0, 0, 0]);
    });
    test(`${lane}: plain unknown and unsupported keep stop/package/service activation`, async () => {
      for (const evidence of [{ kind: "none" }, { kind: "unsupported" },
        { kind: "unknown", reason: "probe-failed", desktopSeen: false }] as const) {
        expect(await exercisePreStop(lane, evidence)).toEqual([1, 1, 1]);
      }
    });
  }
});

async function exercisePreStop(lane: "Bun" | "Node", evidence: SupervisionEvidence, runtimeTrusted = true): Promise<number[]> {
  const source = readFileSync(repoPath(lane === "Bun" ? "src/update/index.ts" : "bin/ocx.mjs"), "utf8");
  const start = source.indexOf(lane === "Bun" ? "  if (runtimePlan.mayStopRuntime &&" : "    if (stopNeeded) {");
  const end = source.indexOf(lane === "Bun" ? '    if (stopStdio === "pipe")' : "      const stillHasRuntimeState", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const counts = [0, 0, 0];
  const latch = createSupervisionLatch();
  const owner = { ownership: null, ownershipUnknown: false };
  const runtimePlan = planUpdateRuntimeHandling({ ...owner, serviceInstalled: true, supervision: latch.observe({ kind: "none" }) });
  const exit = new Error("fixture exit");
  const inspect = (deps?: { targetPid?: number }) => {
    if (lane === "Bun") expect(deps).toEqual({ targetPid: runtimeTrusted ? 321 : undefined });
    else expect(deps).toBeUndefined();
    return evidence;
  };
  const run = new Function("deps", `with (deps) { return (async () => {
    let stopAttempted = false;
    ${source.slice(start, end)}
    }
    packageMutation(); serviceMutation();
  })(); }`);
  try {
    await run({
      runtimePlan, serviceWasInstalled: true, readPid: () => 321, readRuntimePort: () => ({}),
      pendingTeardownOutstanding: () => false, stopNeeded: true,
      resolvedRuntimeOwnership: async () => owner, readOwnership: () => owner,
      planUpdateRuntimeHandling, supervisionLatch: latch, inspectDesktopSupervision: inspect,
      observeSupervision: () => latch.observe(inspect()), runtimeTrusted, livePid: 321,
      console: { log() {}, error(notice: string) { expect(notice).toBe(desktopNotice); } },
      process: { execPath: "fixture", exit() { throw exit; } },
      selfLaunchArgv: () => [], launcher: "fixture", mutation: { controlEnvironment: () => ({}) },
      mutationChildEnvironment: () => ({}), releaseUpdateLease() {}, updateChildStdio: () => "ignore",
      spawnSync: () => { counts[0]++; return { status: 0 }; },
      packageMutation: () => { counts[1]++; }, serviceMutation: () => { counts[2]++; },
    });
  } catch (error) { if (error !== exit) throw error; }
  return counts;
}


test("Bun pre-stop uses inspector correlation when runtime identity is untrusted", async () => {
  expect(await exercisePreStop("Bun", desktopEvidence, false)).toEqual([0, 0, 0]);
  expect(await exercisePreStop("Bun", { kind: "none" }, false)).toEqual([1, 1, 1]);
});

describe("Node service refresh mutation boundaries", () => {
  // The same function handles normal restoration and stopped-runtime failure recovery.
  const source = readFileSync(repoPath("bin/ocx.mjs"), "utf8");
  const start = source.indexOf("  function refreshBackgroundServiceOrStartDirect() {");
  const end = source.indexOf("  const updateLease =", start);
  const run = new Function("deps", `with (deps) {
    ${source.slice(start, end)}
    refreshBackgroundServiceOrStartDirect();
  }`);
  function refresh(evidence: SupervisionEvidence[], prior?: SupervisionEvidence): number[] {
    const latch = createSupervisionLatch();
    if (prior) latch.observe(prior);
    const mutations = [0, 0, 0]; // repair, absent-service install, direct fallback
    run({
      observeSupervision: () => latch.observe(evidence.shift() ?? { kind: "none" }),
      planUpdateRuntimeHandling, readOwnership: () => ({ ownership: null }),
      process: { env: {}, execPath: "fixture" }, bakePort: 12345, postUpdateLauncher: "fixture",
      console: { log() {}, warn() {} }, mutationChildEnvironment: () => ({}),
      serviceRefreshArgs: () => ["repair"], serviceInstallArgs: () => ["install"],
      readServiceInstalledFromStatus: () => false,
      spawnSync: (_bin: string, args: string[]) => {
        if (args[0] === "repair") { mutations[0]++; return { status: 1 }; }
        if (args[0] === "install") { mutations[1]++; return { status: 1 }; }
        throw new Error("unexpected spawn");
      },
      startProxyDirectly: () => { mutations[2]++; },
    });
    return mutations;
  }
  test("a prior Desktop followed by plain unknown cannot refresh the service", () => {
    expect(refresh([{ kind: "unknown", reason: "probe-failed", desktopSeen: false }], desktopEvidence)).toEqual([0, 0, 0]);
  });
  test("Desktop appearing after repair prevents the absent-service install", () => {
    expect(refresh([{ kind: "none" }, desktopEvidence])).toEqual([1, 0, 0]);
  });
  test("Desktop appearing after install prevents direct fallback", () => {
    expect(refresh([{ kind: "none" }, { kind: "none" }, desktopEvidence])).toEqual([1, 1, 0]);
  });
  test("positive none clears the previous veto and activates repair, install and direct fallback", () => {
    expect(refresh([{ kind: "none" }], desktopEvidence)).toEqual([1, 1, 1]);
  });
});

test("Bun and Node replacement, recovery and refresh plans all receive fresh latch verdicts", () => {
  for (const file of ["src/update/index.ts", "bin/ocx.mjs"]) {
    const source = readFileSync(repoPath(file), "utf8");
    expect(source.match(/createSupervisionLatch\(\)/g)).toHaveLength(1);
    for (const call of source.matchAll(/plan(?:UpdateRuntimeHandling|StoppedRuntimeRecovery)\(\{([\s\S]*?)\}\)/g)) {
      expect(call[1]).toMatch(/\bsupervision\b/);
    }
    expect(source).toContain("supervisionLatch.observe(inspectDesktopSupervision(");
  }
});


test("Bun refresh gate vetoes retained Desktop and activates only after positive none", async () => {
  const source = readFileSync(repoPath("src/update/index.ts"), "utf8");
  const start = source.indexOf("      const mayRefresh = async () => {");
  const end = source.indexOf("      if (!await mayRefresh())", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const run = new Function("deps", `with (deps) { return (async () => {
    ${source.slice(start, end)}
    return await mayRefresh();
  })(); }`);
  const latch = createSupervisionLatch(); latch.observe(desktopEvidence);
  for (const [evidence, allowed] of [
    [{ kind: "unknown", reason: "probe-failed", desktopSeen: false }, false],
    [{ kind: "unsupported" }, false], [{ kind: "none" }, true],
  ] as const) {
    expect(await run({
      resolvedRuntimeOwnership: async () => ({ ownership: null }),
      observeSupervision: () => latch.observe(evidence), planUpdateRuntimeHandling,
      console: { warn() {} },
    })).toBe(allowed);
  }
});
