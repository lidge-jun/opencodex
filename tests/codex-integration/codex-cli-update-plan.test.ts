import { describe, expect, test } from "bun:test";

import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanCodexAppServerProcesses } from "../../src/codex/app-server-processes";
import type { CodexCliInstallReport } from "../../src/codex/cli-install-provenance";
import {
  acquireCodexCliUpdateLease,
  observeCodexCliUpdateLease,
  releaseCodexCliUpdateLease,
  type CodexCliUpdateLeaseIo,
} from "../../src/codex/cli-update-lease";
import {
  applyCodexCliUpdatePlan,
  CODEX_CLI_REGISTRY,
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

  test("a resolved target lower than the install is refused, not applied as a downgrade", async () => {
    const plan = await createCodexCliUpdatePlan(planDeps({
      resolveTarget: () => ({ kind: "resolved", version: "0.9.0", integrity: "sha512-AAAA" }),
    }));
    expect(plan.refusal).toBe("target_not_newer");
    expect(plan.planId).toBeNull();
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
    };
    expect(codexCliUpdatePlanId(bound)).toBe(codexCliUpdatePlanId(bound));
  });
});

function applyDeps(
  overrides: Partial<CodexCliUpdateApplyDeps> = {},
  installs: string[] = [],
): CodexCliUpdateApplyDeps {
  return {
    ...planDeps(),
    runInstaller: version => { installs.push(version); return { exitCode: 0 }; },
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

  test("an artifact digest mismatch fails closed before install", async () => {
    const installs: string[] = [];
    const plan = await applicablePlan();
    let seenIntegrity: string | null | undefined;
    const result = await applyCodexCliUpdatePlan(plan.planId!, applyDeps({
      runInstaller: (version, expectedIntegrity) => {
        installs.push(version);
        seenIntegrity = expectedIntegrity;
        return { exitCode: null, integrityMismatch: true };
      },
    }, installs));
    // The plan-bound sha512 reaches the installer seam, and a mismatch refuses
    // rather than reporting an ambiguous post-install state.
    expect(seenIntegrity).toBe(plan.targetIntegrity);
    expect(result.status).toBe("refused");
    expect(result.refusal).toBe("integrity_mismatch");
    expect(result.installerExitCode).toBeNull();
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
      // A different npm-global candidate at the target version is not the planned install.
      [{ inspect: async () => report({ location: "<npm-global>/other/@openai/codex", packageVersion: "1.1.0" }) }, null],
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
      { status: 0, stdout: "https://registry.npmjs.org/@openai/codex/-/codex-1.4.2.tgz\n" },
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

  test("a tarball outside the pinned registry origin is refused even with a valid digest", () => {
    const target = resolveCodexCliUpdateTarget("latest", spawnStub([
      { status: 0, stdout: "1.4.2\n" },
      { status: 0, stdout: "sha512-abc/DEF+123=\n" },
      { status: 0, stdout: "https://evil.invalid/@openai/codex/-/codex-1.4.2.tgz\n" },
    ]));
    expect(target.kind).toBe("unresolved");
  });

  test("a tarball answer that is not a URL at all is refused", () => {
    const target = resolveCodexCliUpdateTarget("latest", spawnStub([
      { status: 0, stdout: "1.4.2\n" },
      { status: 0, stdout: "sha512-abc/DEF+123=\n" },
      { status: 0, stdout: "not-a-url\n" },
    ]));
    expect(target.kind).toBe("unresolved");
  });
});

describe("registry configuration isolation", () => {
  interface CapturedCall {
    bin: string;
    args: string[];
    options: Record<string, unknown>;
    /** Snapshot taken while the call was live; the isolation dir is gone by return. */
    cwdHadSentinel: boolean;
    cwdHadNpmrc: boolean;
  }

  /** The npm argv, whether it reached spawn bare (POSIX) or inside a cmd /c line (Windows). */
  function argvLine(call: CapturedCall): string {
    return call.args.join(" ");
  }

  /** Which registry field this invocation queried, read off the argv line. */
  function queriedField(call: CapturedCall): string {
    const line = argvLine(call);
    if (line.includes("dist.tarball")) return "dist.tarball";
    if (line.includes("dist.integrity")) return "dist.integrity";
    return "version";
  }

  function capturingSpawn(outputs: Record<string, string>): { calls: CapturedCall[]; spawn: never } {
    const calls: CapturedCall[] = [];
    const spawn = ((bin: string, args: string[], options: Record<string, unknown>) => {
      const cwd = options.cwd as string;
      const call: CapturedCall = {
        bin,
        args,
        options,
        cwdHadSentinel: existsSync(join(cwd, "package.json")),
        cwdHadNpmrc: existsSync(join(cwd, "ocx-update.npmrc")),
      };
      calls.push(call);
      const field = queriedField(call);
      return { status: 0, stdout: outputs[field] ?? "", stderr: "" };
    }) as never;
    return { calls, spawn };
  }

  const RESOLVE_OUTPUTS = {
    version: "1.4.2\n",
    "dist.integrity": "sha512-abc/DEF+123=\n",
    "dist.tarball": "https://registry.npmjs.org/@openai/codex/-/codex-1.4.2.tgz\n",
  };

  test("every query pins the official registry and substitutes a controlled npmrc", () => {
    const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
    const target = resolveCodexCliUpdateTarget("latest", spawn);
    expect(target.kind).toBe("resolved");
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(argvLine(call)).toContain("--registry=" + CODEX_CLI_REGISTRY);
      // Both file configs are substituted with the controlled empty npmrc inside the
      // isolation dir — a user ~/.npmrc or a global $PREFIX/etc/npmrc cannot answer.
      expect(argvLine(call)).toContain("--userconfig=");
      expect(argvLine(call)).toContain("--globalconfig=");
      expect(argvLine(call)).toContain("ocx-update.npmrc");
      expect(call.cwdHadSentinel).toBe(true);
      expect(call.cwdHadNpmrc).toBe(true);
    }
    // The isolation directory is cleaned up after the resolve.
    expect(existsSync(calls[0]!.options.cwd as string)).toBe(false);
  });

  test("a hostile npm_config_* env cannot reach the spawned npm", () => {
    const prior = process.env.npm_config_registry;
    const priorScoped = process.env["npm_config_@openai:registry"];
    process.env.npm_config_registry = "https://evil.invalid";
    process.env["npm_config_@openai:registry"] = "https://evil.invalid/";
    try {
      const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
      const target = resolveCodexCliUpdateTarget("latest", spawn);
      expect(target.kind).toBe("resolved");
      for (const call of calls) {
        const env = call.options.env as NodeJS.ProcessEnv;
        expect(Object.keys(env).filter(key => key.toLowerCase().startsWith("npm_config_"))).toEqual([]);
      }
    } finally {
      if (prior === undefined) delete process.env.npm_config_registry;
      else process.env.npm_config_registry = prior;
      if (priorScoped === undefined) delete process.env["npm_config_@openai:registry"];
      else process.env["npm_config_@openai:registry"] = priorScoped;
    }
  });

  test("the controlled cwd never is the operator's project directory", () => {
    // A project .npmrc in the launch directory would otherwise redirect the scope;
    // the query must run from the sentinel-anchored isolation dir instead.
    const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
    resolveCodexCliUpdateTarget("latest", spawn);
    for (const call of calls) {
      const cwd = call.options.cwd as string;
      expect(cwd).not.toBe(process.cwd());
      expect(cwd.startsWith(tmpdir())).toBe(true);
    }
  });
});

describe("Codex CLI update lease", () => {
  function leaseIo(dir: string, pid: number, alive: ReadonlySet<number>): CodexCliUpdateLeaseIo {
    return {
      lockPath: join(dir, "codex-cli-update.lock"),
      pid,
      isAlive: candidate => alive.has(candidate),
    };
  }

  function heldLease(dir: string, holderPid: number): CodexCliUpdateLeaseIo {
    const io = leaseIo(dir, holderPid, new Set([holderPid]));
    const acquisition = acquireCodexCliUpdateLease({ ...io, planId: "a".repeat(32) });
    expect(acquisition.acquired).toBe(true);
    return io;
  }

  test("a live holder refuses a second apply before any evidence is gathered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-update-lease-"));
    const holder = heldLease(dir, 4_242);
    const installs: string[] = [];
    let inspected = 0;
    const result = await applyCodexCliUpdatePlan("b".repeat(32), applyDeps({
      leaseIo: { lockPath: holder.lockPath, isAlive: pid => pid === 4_242 },
      inspect: async () => { inspected += 1; return report(); },
    }, installs));
    expect(result.status).toBe("refused");
    expect(result.refusal).toBe("update_in_progress");
    // The refusal happens before the plan is recomputed: no inspection, no install.
    expect(inspected).toBe(0);
    expect(installs).toEqual([]);
  });

  test("two concurrent applies cannot pass the same plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-update-lease-"));
    const lockPath = join(dir, "codex-cli-update.lock");
    const installs: string[] = [];
    const plan = await applicablePlan();

    // The first apply holds the lease while its inspection is still in flight.
    let releaseInspection: (value: CodexCliInstallReport) => void = () => {};
    const gate = new Promise<CodexCliInstallReport>(done => { releaseInspection = done; });
    let firstCalls = 0;
    const first = applyCodexCliUpdatePlan(plan.planId!, applyDeps({
      leaseIo: { lockPath },
      inspect: async () => {
        firstCalls += 1;
        return firstCalls === 1 ? await gate : report({ packageVersion: "1.1.0" });
      },
    }, installs));
    // Let the first apply reach its gated inspection while holding the lease.
    await new Promise(done => setTimeout(done, 10));

    const second = await applyCodexCliUpdatePlan(plan.planId!, applyDeps({
      leaseIo: { lockPath },
    }, installs));
    expect(second.status).toBe("refused");
    expect(second.refusal).toBe("update_in_progress");

    releaseInspection(report());
    const firstResult = await first;
    expect(firstResult.status).toBe("applied");
    expect(installs).toEqual(["1.1.0"]);
    // The holder released the lease when it finished.
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a dead holder's lease is reclaimed instead of blocking forever", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-update-lease-"));
    const lockPath = join(dir, "codex-cli-update.lock");
    // A holder that died without releasing: dead pid, stale or not.
    const stale = acquireCodexCliUpdateLease({ lockPath, pid: 9_999, planId: "c".repeat(32) });
    expect(stale.acquired).toBe(true);

    const installs: string[] = [];
    const plan = await applicablePlan();
    let inspections = 0;
    const result = await applyCodexCliUpdatePlan(plan.planId!, applyDeps({
      leaseIo: { lockPath, isAlive: () => false },
      inspect: async () => {
        inspections += 1;
        return inspections === 1 ? report() : report({ packageVersion: "1.1.0" });
      },
    }, installs));
    expect(result.status).toBe("applied");
    expect(installs).toEqual(["1.1.0"]);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a refused apply still releases the lease it took", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-update-lease-"));
    const lockPath = join(dir, "codex-cli-update.lock");
    const plan = await applicablePlan();
    const result = await applyCodexCliUpdatePlan(plan.planId!, applyDeps({
      leaseIo: { lockPath },
      // Drift the target so the recomputed plan is refused as stale.
      resolveTarget: () => Object.freeze({ kind: "resolved" as const, version: "9.9.9", integrity: "sha512-ZZZZ" }),
    }));
    expect(result.status).toBe("refused");
    expect(result.refusal).toBe("plan_stale");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a corrupt leftover lease cannot wedge every future update", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-update-lease-"));
    const lockPath = join(dir, "codex-cli-update.lock");
    writeFileSync(lockPath, "{not json");
    // Backdate it past the publish grace: a fresh unparseable file is a contender's
    // in-flight write, not debris, and must not be cleared under it.
    utimesSync(lockPath, 0, 0);
    const installs: string[] = [];
    const plan = await applicablePlan();
    let inspections = 0;
    const result = await applyCodexCliUpdatePlan(plan.planId!, applyDeps({
      leaseIo: { lockPath },
      inspect: async () => {
        inspections += 1;
        return inspections === 1 ? report() : report({ packageVersion: "1.1.0" });
      },
    }, installs));
    expect(result.status).toBe("applied");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a fresh unparseable record is a publish in flight, not debris", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-update-lease-"));
    const lockPath = join(dir, "codex-cli-update.lock");
    // The O_EXCL fallback leaves a create-before-record window: a contender that
    // sees it must report contention/unavailable, never unlink the publisher's file.
    writeFileSync(lockPath, "");
    const attempt = acquireCodexCliUpdateLease({ lockPath, pid: 7_777 });
    expect(attempt.acquired).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    // Once the file is old it is genuinely dead debris and reclaims.
    utimesSync(lockPath, 0, 0);
    const retry = acquireCodexCliUpdateLease({ lockPath, pid: 7_777 });
    expect(retry.acquired).toBe(true);
  });

  test("a contender that observed a stale record cannot delete the successor's lease", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-update-lease-"));
    const lockPath = join(dir, "codex-cli-update.lock");
    // A holds a dead-pid lease; B observes it stale and takes over. The record A
    // published must never let a slower contender (or A's own late release) delete B's.
    const a = acquireCodexCliUpdateLease({ lockPath, pid: 1_111, planId: "a".repeat(32) });
    expect(a.acquired).toBe(true);
    if (!a.acquired) return;
    const b = acquireCodexCliUpdateLease({ lockPath, pid: 2_222, isAlive: () => false });
    expect(b.acquired).toBe(true);
    if (!b.acquired) return;
    // The late release names the superseded token: B's live lease survives.
    releaseCodexCliUpdateLease({ lockPath, pid: 1_111, token: a.record.token });
    const surviving = readFileSync(lockPath, "utf-8");
    expect(JSON.parse(surviving).token).toBe(b.record.token);
    // A release naming only the pid still cannot touch a successor's record either:
    // the token the caller never had is required inside compare-and-delete.
    releaseCodexCliUpdateLease({ lockPath, pid: 1_111 });
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).token).toBe(b.record.token);
  });

  test("a live owner is never reaped by age while its heartbeat is fresh", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-update-lease-"));
    const lockPath = join(dir, "codex-cli-update.lock");
    const held = acquireCodexCliUpdateLease({ lockPath, pid: 3_333 });
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;
    // Age the record far past the bound but keep the heartbeat fresh: a long install
    // must stay held, not be deliberately broken.
    writeFileSync(lockPath, JSON.stringify({
      ...held.record,
      createdAtMs: 0,
      heartbeatAtMs: Date.now(),
    }));
    const contender = acquireCodexCliUpdateLease({ lockPath, pid: 4_444, isAlive: () => true });
    expect(contender.acquired).toBe(false);
    if (!contender.acquired) {
      expect(contender.reason).toBe("held");
    }
    // The same live pid with a heartbeat that stopped is a wedged holder: reclaimable.
    writeFileSync(lockPath, JSON.stringify({
      ...held.record,
      createdAtMs: 0,
      heartbeatAtMs: 0,
    }));
    const reaper = acquireCodexCliUpdateLease({ lockPath, pid: 4_444, isAlive: () => true });
    expect(reaper.acquired).toBe(true);
  });

  test("startup observation reads a held lease and ignores a stale one", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-update-lease-"));
    const lockPath = join(dir, "codex-cli-update.lock");
    const held = acquireCodexCliUpdateLease({ lockPath, pid: 5_555 });
    expect(held.acquired).toBe(true);
    // Observation is read-only and liveness-bound: the same file is "held" while the
    // owner lives and "free" once it is gone, without the observer mutating anything.
    expect(observeCodexCliUpdateLease({ lockPath, isAlive: () => true }).held).toBe(true);
    expect(observeCodexCliUpdateLease({ lockPath, isAlive: () => false }).held).toBe(false);
  });
});
