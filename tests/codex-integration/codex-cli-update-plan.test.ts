import { describe, expect, test } from "bun:test";

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { scanCodexAppServerProcesses } from "../../src/codex/app-server-processes";
import type { CodexCliInstallReport } from "../../src/codex/cli-install-provenance";
import {
  CODEX_CLI_REGISTRY,
  codexCliUpdatePlanId,
  createCodexCliUpdatePlan,
  resolveCodexCliUpdateTarget,
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
  reason: "managed_npm_global",
  location: "<npm-global>/@openai/codex",
  installDigest: "a".repeat(64),
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
    // The quoted command pins the same registry the plan resolved its evidence
    // from; a bare spec would let the operator's npmrc answer with a different
    // artifact for the same version string.
    expect(plan.command).toEqual([
      "npm", "install", "-g",
      "--registry=" + CODEX_CLI_REGISTRY,
      "@openai/codex@1.1.0",
    ]);
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

  test("a plain interactive Codex session blocks the plan, not just an app-server", async () => {
    // The default session scan must see a TUI the app-server matcher deliberately
    // rejects: a missed "codex" TUI is what half-wrote a managed install.
    const plan = await createCodexCliUpdatePlan(planDeps({
      scanProcesses: undefined,
      processIo: {
        platform: "linux",
        listSnapshots: () => [{ pid: 9, commandLine: "codex" }],
      },
    }));
    expect(plan.refusal).toBe("blocked_active_session");
    expect(plan.session).toEqual({ state: "active", matches: 1 });
  });
});

describe("Codex CLI update plan identity", () => {
  test("every bound field changes the id", async () => {
    const base = await applicablePlan();
    const variants: Partial<CodexCliUpdatePlanDeps>[] = [
      { resolveTarget: () => ({ kind: "resolved", version: "1.2.0", integrity: "sha512-AAAA" }) },
      { resolveTarget: () => ({ kind: "resolved", version: "1.1.0", integrity: "sha512-BBBB" }) },
      { inspect: async () => report({ packageVersion: "1.0.1", candidateVersion: "1.0.1" }) },
      // Two install roots sharing the redacted "<path>/codex" display location
      // must still produce different plans.
      { inspect: async () => report({ installDigest: "b".repeat(64) }) },
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

  test("the id contains only the explicitly bound evidence", () => {
    const bound = {
      platform: "linux" as NodeJS.Platform,
      provenance: "npm-global" as const,
      installedVersion: "1.0.0",
      installDigest: "a".repeat(64),
      channel: "latest" as const,
      targetVersion: "1.1.0",
      targetIntegrity: "sha512-AAAA",
    };
    expect(codexCliUpdatePlanId(bound)).toBe(codexCliUpdatePlanId(bound));
    expect(codexCliUpdatePlanId(bound)).toMatch(/^[0-9a-f]{32}$/);
    // A digest of the same evidence recomputed by a different build agrees.
    expect(codexCliUpdatePlanId({ ...bound })).toBe(codexCliUpdatePlanId(bound));
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

  // A bound PATH must still resolve a real npm: the marker prefix makes the value
  // observably bound while the ambient entries appended after it keep npm reachable
  // on Windows, where the resolver walks PATH on disk.
  function markerBoundEnv(): NodeJS.ProcessEnv {
    return {
      PATH: "D:\\attested-marker" + delimiter + (process.env.PATH ?? ""),
      PATHEXT: (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD") + ";.XYZ",
    };
  }

  test("the bound launcher snapshot supplies npm's PATH and PATHEXT, not the ambient ones", () => {
    const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
    const boundEnv = markerBoundEnv();
    const target = resolveCodexCliUpdateTarget("latest", spawn, boundEnv);
    expect(target.kind).toBe("resolved");
    for (const call of calls) {
      const env = call.options.env as NodeJS.ProcessEnv;
      expect(env.PATH).toBe(boundEnv.PATH);
      expect(env.PATHEXT).toBe(boundEnv.PATHEXT);
    }
  });

  test("the plan resolves registry evidence through the attested launcher environment", async () => {
    const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
    const boundEnv = markerBoundEnv();
    const plan = await applicablePlan({
      // Dropping the resolveTarget stub exercises the real resolver wiring: the
      // provenance snapshot env must reach npm's spawn options.
      resolveTarget: undefined,
      inspectionDeps: { env: boundEnv },
      spawnProcess: spawn,
    });
    expect(plan.targetVersion).toBe("1.4.2");
    expect(calls.length).toBe(3);
    for (const call of calls) {
      const env = call.options.env as NodeJS.ProcessEnv;
      expect(env.PATH).toBe(boundEnv.PATH);
    }
  });

  test("hostile Node startup channels cannot reach the spawned npm", () => {
    const priorOptions = process.env.NODE_OPTIONS;
    const priorPath = process.env.NODE_PATH;
    const priorTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_OPTIONS = "--require=evil";
    process.env.NODE_PATH = "C:\\evil-modules";
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
      const target = resolveCodexCliUpdateTarget("latest", spawn);
      expect(target.kind).toBe("resolved");
      for (const call of calls) {
        const env = call.options.env as NodeJS.ProcessEnv;
        const lower = new Set(Object.keys(env).map(key => key.toLowerCase()));
        expect(lower.has("node_options")).toBe(false);
        expect(lower.has("node_path")).toBe(false);
        expect(lower.has("node_tls_reject_unauthorized")).toBe(false);
      }
    } finally {
      if (priorOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = priorOptions;
      if (priorPath === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = priorPath;
      if (priorTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = priorTls;
    }
  });

  test("a trusted snapshot without PATH installs an explicit empty PATH and fails closed", () => {
    const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
    resolveCodexCliUpdateTarget("latest", spawn, { PATHEXT: ".COM;.EXE;.BAT;.CMD" });
    // With no trusted PATH the ambient PATH must never reach the child: Windows
    // resolves the binary itself and spawns nothing, while POSIX spawns the bare
    // npm name whose execvp lookup then fails under the explicit empty PATH.
    for (const call of calls) {
      expect((call.options.env as NodeJS.ProcessEnv).PATH).toBe("");
    }
  });

  test("npm cache and log state stay inside the owned temporary root", () => {
    const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
    const target = resolveCodexCliUpdateTarget("latest", spawn);
    expect(target.kind).toBe("resolved");
    for (const call of calls) {
      const cwd = call.options.cwd as string;
      const line = argvLine(call);
      expect(line).toContain("--cache=");
      const cacheFlag = line.match(/--cache=(\S+)/);
      expect(cacheFlag).not.toBeNull();
      // The cache root (and therefore npm's _logs directory beneath it) must live
      // inside the owned isolation dir, not under an ambient ~/.npm.
      expect(cacheFlag![1]!.startsWith(cwd)).toBe(true);
    }
  });

  test("a real npm call under the isolated argv leaves the operator HOME untouched", () => {
    // Runs real npm exactly once: the first captured query executes for real with a
    // disposable HOME while the rest stay stubbed. npm_config_offline makes the
    // registry leg fail fast without network; the residue assertions hold either way.
    const fakeHome = mkdtempSync(join(tmpdir(), "ocx-update-test-home-"));
    try {
      const calls: CapturedCall[] = [];
      let realRan = false;
      const spawn = ((bin: string, args: string[], options: Record<string, unknown>) => {
        const cwd = options.cwd as string;
        const call: CapturedCall = {
          bin, args, options,
          cwdHadSentinel: existsSync(join(cwd, "package.json")),
          cwdHadNpmrc: existsSync(join(cwd, "ocx-update.npmrc")),
        };
        calls.push(call);
        const field = queriedField(call);
        if (realRan) return { status: 0, stdout: RESOLVE_OUTPUTS[field as keyof typeof RESOLVE_OUTPUTS] ?? "", stderr: "" };
        realRan = true;
        const env = { ...(options.env as NodeJS.ProcessEnv), HOME: fakeHome, USERPROFILE: fakeHome, npm_config_offline: "true" };
        return spawnSync(bin, args, { ...options, env, timeout: 30_000, windowsHide: true, encoding: "utf8" });
      }) as never;
      resolveCodexCliUpdateTarget("latest", spawn);
      expect(realRan).toBe(true);
      const cwd = calls[0]!.options.cwd as string;
      // Anything npm persisted must be inside the owned root; the ambient HOME must
      // stay completely empty (no ~/.npm, no ~/.npmrc, no _logs).
      const collect = (root: string, base: string, out: string[]): void => {
        let names: string[];
        try { names = readdirSync(root); } catch { return; }
        for (const name of names) out.push(join(base, name));
      };
      const homeEntries: string[] = [];
      collect(fakeHome, ".", homeEntries);
      expect(homeEntries).toEqual([]);
      const leaked: string[] = [];
      collect(cwd, ".", leaked);
      for (const entry of leaked) {
        const normalized = entry.replace(/\\/g, "/");
        expect(normalized.startsWith("./package.json") || normalized.startsWith("./ocx-update.npmrc") || normalized.startsWith("./npm-cache")).toBe(true);
      }
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
