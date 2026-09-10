import { describe, expect, test } from "bun:test";

import { scanCodexAppServerProcesses } from "../../src/codex/app-server-processes";
import type { CodexCliInstallReport } from "../../src/codex/cli-install-provenance";
import {
  applyCodexCliUpdatePlan,
  codexCliUpdatePlanId,
  createCodexCliUpdatePlan,
  resolveCodexCliUpdateTarget,
  type CodexCliUpdateApplyDeps,
  type CodexCliUpdatePlan,
  type CodexCliUpdatePlanDeps,
  type CodexCliUpdateTarget,
} from "../../src/codex/cli-update-plan";

/**
 * Phase 2 of the Codex CLI update manager.
 *
 * Every case here is about one of three refusals to be casual: adopting an installation
 * we do not own, installing a target the registry did not pin, and reading an unreadable
 * process table as "nothing is running".
 */

const MANAGED: CodexCliInstallReport = Object.freeze({
  schemaVersion: 1,
  candidateAvailable: true,
  candidateVersion: "1.0.0",
  candidateSource: "environment",
  selectionAttested: true,
  versionEvidence: { kind: "package-manifest" },
  provenance: "npm-global",
  managed: true,
  reason: "npm_global_unverified",
  location: "<npm-global>/@openai/codex",
  packageVersion: "1.0.0",
  shim: { status: "not-tracked", backingKind: null },
  evidence: ["package_manifest", "global_npm_layout"],
});

function report(overrides: Partial<CodexCliInstallReport> = {}): CodexCliInstallReport {
  return { ...MANAGED, ...overrides } as CodexCliInstallReport;
}

const RESOLVED: CodexCliUpdateTarget = Object.freeze({
  kind: "resolved",
  version: "1.1.0",
  integrity: "sha512-AAAA",
});

function planDeps(overrides: Partial<CodexCliUpdatePlanDeps> = {}): CodexCliUpdatePlanDeps {
  return {
    platform: "linux",
    inspect: async () => report(),
    resolveTarget: () => RESOLVED,
    scanProcesses: () => ({ kind: "observed", processes: [] }),
    ...overrides,
  };
}

async function applicablePlan(overrides: Partial<CodexCliUpdatePlanDeps> = {}): Promise<CodexCliUpdatePlan> {
  const plan = await createCodexCliUpdatePlan(planDeps(overrides));
  expect(plan.applicable).toBe(true);
  return plan;
}

describe("Codex CLI update dry-run plan", () => {
  test("an applicable plan pins the exact resolved version and quotes the command it would run", async () => {
    const plan = await applicablePlan();
    expect(plan.refusal).toBeNull();
    expect(plan.targetVersion).toBe("1.1.0");
    expect(plan.targetIntegrity).toBe("sha512-AAAA");
    expect(plan.installedVersion).toBe("1.0.0");
    expect(plan.session).toEqual({ state: "none", matches: 0 });
    // The dist-tag is resolved once and bound; the install can never widen back to it.
    expect(plan.command).toEqual(["npm", "install", "-g", "@openai/codex@1.1.0"]);
    expect(plan.planId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("Windows defers without querying the registry or the process table", async () => {
    let queries = 0;
    let scans = 0;
    const plan = await createCodexCliUpdatePlan(planDeps({
      platform: "win32",
      inspect: async () => report({ reason: "windows_inspection_deferred", managed: false, provenance: "unknown" }),
      resolveTarget: () => { queries += 1; return RESOLVED; },
      scanProcesses: () => { scans += 1; return { kind: "observed", processes: [] }; },
    }));
    expect(plan.applicable).toBe(false);
    expect(plan.refusal).toBe("windows_inspection_deferred");
    // Phase 1 reads nothing on Windows, so there is no ownership evidence to spend a
    // registry request or a process enumeration on.
    expect(queries).toBe(0);
    expect(scans).toBe(0);
    expect(plan.session.state).toBe("not-evaluated");
  });

  test("an installation we do not own is never adopted", async () => {
    for (const owned of [
      report({ managed: false, provenance: "app-bundle", reason: "app_bundle" }),
      report({ managed: false, provenance: "version-manager", reason: "version_manager_owned" }),
      report({ managed: false, provenance: "standalone-unverified", reason: "unverified_standalone" }),
      report({ managed: true, provenance: "version-manager", reason: "version_manager_owned" }),
    ]) {
      const plan = await createCodexCliUpdatePlan(planDeps({ inspect: async () => owned }));
      expect(plan.refusal).toBe("not_managed");
      expect(plan.planId).toBeNull();
      expect(plan.command).toBeNull();
    }
  });

  test("an advisory runtime version is not evidence of what is installed", async () => {
    // A candidate binary reporting its own version cannot be compared with a registry
    // version or read back after an install; only the package manifest can.
    const plan = await createCodexCliUpdatePlan(planDeps({
      inspect: async () => report({ versionEvidence: { kind: "advisory-runtime" } }),
    }));
    expect(plan.refusal).toBe("installed_version_unverified");
  });

  test("a version the registry did not pin with integrity is refused, not installed best-effort", async () => {
    const plan = await createCodexCliUpdatePlan(planDeps({
      resolveTarget: () => ({ kind: "unresolved", reason: "registry integrity query failed (status timeout)" }),
    }));
    expect(plan.refusal).toBe("target_unresolved");
    expect(plan.targetVersion).toBeNull();
    expect(plan.command).toBeNull();
  });

  test("an already current installation has nothing to apply", async () => {
    const plan = await createCodexCliUpdatePlan(planDeps({
      resolveTarget: () => ({ kind: "resolved", version: "1.0.0", integrity: "sha512-AAAA" }),
    }));
    expect(plan.refusal).toBe("already_current");
  });

  test("an unreadable process table defers instead of reading as no live session", async () => {
    const plan = await createCodexCliUpdatePlan(planDeps({ scanProcesses: () => ({ kind: "unavailable" }) }));
    expect(plan.refusal).toBe("blocked_process_state_unknown");
    expect(plan.session).toEqual({ state: "unknown", matches: null });
  });

  test("a live Codex session refuses the plan and is never signalled", async () => {
    const plan = await createCodexCliUpdatePlan(planDeps({
      scanProcesses: () => ({ kind: "observed", processes: [{ pid: 4242, commandLine: "node app-server --secret" }] }),
    }));
    expect(plan.refusal).toBe("blocked_active_session");
    expect(plan.session).toEqual({ state: "active", matches: 1 });
    // Only the count crosses the boundary. Command lines carry paths and arguments.
    expect(JSON.stringify(plan)).not.toContain("secret");
    expect(JSON.stringify(plan)).not.toContain("4242");
  });
});

describe("Codex CLI update plan identity", () => {
  test("every bound field changes the id", async () => {
    const base = await applicablePlan();
    const variants: Partial<CodexCliUpdatePlanDeps>[] = [
      { resolveTarget: () => ({ kind: "resolved", version: "1.2.0", integrity: "sha512-AAAA" }) },
      { resolveTarget: () => ({ kind: "resolved", version: "1.1.0", integrity: "sha512-BBBB" }) },
      { inspect: async () => report({ packageVersion: "1.0.1", candidateVersion: "1.0.1" }) },
      { inspect: async () => report({ location: "<npm-global>/other/@openai/codex" }) },
      { inspect: async () => report({ shim: { status: "matched", backingKind: "backup" } }) },
    ];
    for (const variant of variants) {
      const plan = await applicablePlan(variant);
      expect(plan.planId).not.toBe(base.planId);
    }
  });

  test("a session starting or ending between dry-run and apply does not invalidate the plan", async () => {
    // Blockers are re-read at apply time where they can only refuse. Binding them into
    // the id would expire a plan the operator read correctly, for a reason that cannot
    // make the install wrong.
    const first = await applicablePlan();
    const second = await applicablePlan({
      scanProcesses: () => ({ kind: "observed", processes: [] }),
    });
    expect(second.planId).toBe(first.planId);
  });

  test("the id is a digest of the bound evidence, not a random handle", () => {
    const bound = {
      platform: "linux" as NodeJS.Platform,
      provenance: "npm-global" as const,
      installedVersion: "1.0.0",
      location: "<npm-global>/@openai/codex",
      channel: "latest" as const,
      targetVersion: "1.1.0",
      targetIntegrity: "sha512-AAAA",
      shimEligible: false,
    };
    expect(codexCliUpdatePlanId(bound)).toBe(codexCliUpdatePlanId(bound));
    expect(codexCliUpdatePlanId({ ...bound, shimEligible: true })).not.toBe(codexCliUpdatePlanId(bound));
  });
});

function applyDeps(
  overrides: Partial<CodexCliUpdateApplyDeps> = {},
  installs: string[] = [],
): CodexCliUpdateApplyDeps {
  return {
    ...planDeps(),
    runInstaller: version => { installs.push(version); return { exitCode: 0 }; },
    restoreShim: async () => ({ status: "restored" }),
    ...overrides,
  };
}

describe("Codex CLI update apply", () => {
  test("a stale or unknown plan id installs nothing", async () => {
    const installs: string[] = [];
    const plan = await applicablePlan();

    const unknown = await applyCodexCliUpdatePlan("not-a-plan-id", applyDeps({}, installs));
    expect(unknown.status).toBe("refused");
    expect(unknown.refusal).toBe("plan_unknown");

    const stale = await applyCodexCliUpdatePlan("0".repeat(32), applyDeps({}, installs));
    expect(stale.status).toBe("refused");
    expect(stale.refusal).toBe("plan_stale");
    expect(stale.planId).toBe(plan.planId);

    expect(installs).toEqual([]);
  });

  test("drift between dry-run and apply refuses rather than regenerating the plan", async () => {
    const installs: string[] = [];
    const plan = await applicablePlan();
    // The operator read a plan for 1.1.0; the registry has since moved on.
    const drifted = await applyCodexCliUpdatePlan(plan.planId!, applyDeps({
      resolveTarget: () => ({ kind: "resolved", version: "1.3.0", integrity: "sha512-CCCC" }),
    }, installs));
    expect(drifted.status).toBe("refused");
    expect(drifted.refusal).toBe("plan_stale");
    expect(installs).toEqual([]);
  });

  test("a session that appeared after the dry-run refuses the apply", async () => {
    const installs: string[] = [];
    const plan = await applicablePlan();
    const blocked = await applyCodexCliUpdatePlan(plan.planId!, applyDeps({
      scanProcesses: () => ({ kind: "observed", processes: [{ pid: 7, commandLine: "codex app-server" }] }),
    }, installs));
    expect(blocked.status).toBe("refused");
    expect(blocked.refusal).toBe("blocked_active_session");
    expect(installs).toEqual([]);
  });

  test("the readback classifies the result, and installs exactly the pinned version", async () => {
    const installs: string[] = [];
    const plan = await applicablePlan();
    let inspections = 0;
    const result = await applyCodexCliUpdatePlan(plan.planId!, applyDeps({
      inspect: async () => {
        inspections += 1;
        return inspections === 1 ? report() : report({ packageVersion: "1.1.0", candidateVersion: "1.1.0" });
      },
    }, installs));
    expect(installs).toEqual(["1.1.0"]);
    expect(result.status).toBe("applied");
    expect(result.installedVersionBefore).toBe("1.0.0");
    expect(result.installedVersionAfter).toBe("1.1.0");
    expect(result.shim).toEqual({ attempted: false, restored: false, status: null });
  });

  test("a nonzero installer exit never overrides a readback that shows the target", async () => {
    const plan = await applicablePlan();
    let inspections = 0;
    const result = await applyCodexCliUpdatePlan(plan.planId!, applyDeps({
      runInstaller: () => ({ exitCode: 1 }),
      inspect: async () => {
        inspections += 1;
        return inspections === 1 ? report() : report({ packageVersion: "1.1.0" });
      },
    }));
    expect(result.status).toBe("applied");
    expect(result.installerExitCode).toBe(1);
  });

  test("an unchanged version is not applied, and is not retried", async () => {
    const installs: string[] = [];
    const plan = await applicablePlan();
    const result = await applyCodexCliUpdatePlan(plan.planId!, applyDeps({
      runInstaller: version => { installs.push(version); return { exitCode: 1 }; },
    }, installs));
    expect(result.status).toBe("not_applied");
    expect(result.installedVersionAfter).toBe("1.0.0");
    expect(installs).toEqual(["1.1.0"]);
  });

  test("a failed readback, a third version or changed provenance is ambiguous", async () => {
    const plan = await applicablePlan();
    const cases: [Partial<CodexCliUpdateApplyDeps>, string | null][] = [
      [{ inspect: async () => { throw new Error("readback failed"); } }, null],
      [{ inspect: async () => report({ packageVersion: "9.9.9" }) }, "9.9.9"],
      [{ inspect: async () => report({ provenance: "version-manager" }) }, null],
      [{ inspect: async () => report({ versionEvidence: { kind: "advisory-runtime" } }) }, null],
    ];
    for (const [override, after] of cases) {
      // The first inspection builds the plan, so these must still produce a plan id;
      // drive them through a plan whose deps differ only in the readback.
      const first = { ...applyDeps(), ...override } as CodexCliUpdateApplyDeps;
      let calls = 0;
      const result = await applyCodexCliUpdatePlan(plan.planId!, {
        ...first,
        inspect: async deps => {
          calls += 1;
          if (calls === 1) return report();
          return await (override.inspect ?? (async () => report()))(deps);
        },
      });
      expect(result.status).toBe("ambiguous");
      expect(result.installedVersionAfter).toBe(after);
    }
  });
});

describe("Codex CLI update shim repair", () => {
  async function applyWithShim(
    preShim: CodexCliInstallReport["shim"],
    postShim: CodexCliInstallReport["shim"],
    restore: () => Promise<{ status: string }>,
  ) {
    const deps = planDeps({ inspect: async () => report({ shim: preShim }) });
    const plan = await createCodexCliUpdatePlan(deps);
    let calls = 0;
    return await applyCodexCliUpdatePlan(plan.planId!, {
      ...deps,
      runInstaller: () => ({ exitCode: 0 }),
      restoreShim: restore,
      inspect: async () => {
        calls += 1;
        return calls === 1
          ? report({ shim: preShim })
          : report({ packageVersion: "1.1.0", shim: postShim });
      },
    });
  }

  test("an untracked shim is left alone", async () => {
    let restores = 0;
    const result = await applyWithShim(
      { status: "not-tracked", backingKind: null },
      { status: "not-tracked", backingKind: null },
      async () => { restores += 1; return { status: "restored" }; },
    );
    expect(result.status).toBe("applied");
    expect(restores).toBe(0);
    expect(result.shim.attempted).toBe(false);
  });

  test("a shim that was matched before the update is restored after it", async () => {
    const result = await applyWithShim(
      { status: "matched", backingKind: "backup" },
      { status: "not-tracked", backingKind: null },
      async () => ({ status: "restored" }),
    );
    expect(result.status).toBe("applied");
    expect(result.shim).toEqual({ attempted: true, restored: true, status: "restored" });
  });

  test("a shim that cannot be restored is reported, not silently swallowed", async () => {
    for (const status of ["ineligible", "deferred", "disabled"]) {
      const result = await applyWithShim(
        { status: "matched", backingKind: "backup" },
        { status: "unknown", backingKind: null },
        async () => ({ status }),
      );
      // The update itself succeeded; the operator still has a broken launcher to fix.
      expect(result.status).toBe("applied_shim_repair_required");
      expect(result.installedVersionAfter).toBe("1.1.0");
      expect(result.shim.status).toBe(status);
    }
  });

  test("a throwing restore does not turn a completed update into a crash", async () => {
    const result = await applyWithShim(
      { status: "matched", backingKind: "backup" },
      { status: "unknown", backingKind: null },
      async () => { throw new Error("lock held"); },
    );
    expect(result.status).toBe("applied_shim_repair_required");
    expect(result.shim).toEqual({ attempted: true, restored: false, status: "failed" });
  });

  test("a shim that survived the update needs no repair", async () => {
    let restores = 0;
    const result = await applyWithShim(
      { status: "matched", backingKind: "backup" },
      { status: "matched", backingKind: "backup" },
      async () => { restores += 1; return { status: "restored" }; },
    );
    expect(result.status).toBe("applied");
    expect(restores).toBe(0);
  });
});

describe("strict Codex app-server process scan", () => {
  test("an enumeration failure is unavailable, not an empty list", () => {
    const scan = scanCodexAppServerProcesses({
      platform: "linux",
      listSnapshots: () => { throw new Error("procfs unreadable"); },
    });
    expect(scan).toEqual({ kind: "unavailable" });
  });

  test("a readable but empty process table is observed with no matches", () => {
    const scan = scanCodexAppServerProcesses({ platform: "linux", listSnapshots: () => [] });
    expect(scan).toEqual({ kind: "observed", processes: [] });
  });

  test("the same matcher and de-duplication as the kill-path lister", () => {
    const snapshot = { pid: 11, commandLine: "codex app-server" };
    const scan = scanCodexAppServerProcesses({
      platform: "linux",
      listSnapshots: () => [snapshot, { ...snapshot }, { pid: 12, commandLine: "vim notes.txt" }],
    });
    expect(scan.kind).toBe("observed");
    if (scan.kind !== "observed") return;
    expect(scan.processes.map(p => p.pid)).toEqual([11]);
  });
});

describe("registry target resolution", () => {
  function spawnStub(outputs: { status: number | null; stdout: string }[]) {
    let call = 0;
    return (() => {
      const next = outputs[call++] ?? { status: 1, stdout: "" };
      return { status: next.status, stdout: next.stdout, stderr: "" };
    }) as never;
  }

  test("an exact version with a sha512 token resolves", () => {
    const target = resolveCodexCliUpdateTarget("latest", spawnStub([
      { status: 0, stdout: "1.4.2\n" },
      { status: 0, stdout: "'sha512-abc/DEF+123=' sha1-old\n" },
    ]));
    expect(target).toEqual({ kind: "resolved", version: "1.4.2", integrity: "sha512-abc/DEF+123=" });
  });

  test("a missing integrity token refuses instead of proceeding best-effort", () => {
    const target = resolveCodexCliUpdateTarget("latest", spawnStub([
      { status: 0, stdout: "1.4.2\n" },
      { status: 0, stdout: "sha1-onlythis\n" },
    ]));
    expect(target.kind).toBe("unresolved");
  });

  test("a registry timeout refuses", () => {
    const target = resolveCodexCliUpdateTarget("latest", spawnStub([{ status: null, stdout: "" }]));
    expect(target.kind).toBe("unresolved");
  });

  test("a non-version answer is not treated as a version", () => {
    const target = resolveCodexCliUpdateTarget("latest", spawnStub([
      { status: 0, stdout: "latest\n" },
    ]));
    expect(target.kind).toBe("unresolved");
  });
});

