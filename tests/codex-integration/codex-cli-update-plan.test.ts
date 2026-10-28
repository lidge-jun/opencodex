import { createCodexCliTestRoot } from "../helpers/codex-cli-fixture-root";
import { describe, expect, spyOn, test } from "bun:test";

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { npmInvocation } from "../../src/update/npm-invocation.mjs";

import { scanCodexAppServerProcesses } from "../../src/codex/app-server-processes";
import {
  inspectCodexCliInstall,
  type CodexCliInstallProvenanceDeps,
  type CodexCliInstallReport,
} from "../../src/codex/cli-install-provenance";
import {
  CODEX_CLI_REGISTRY,
  codexCliUpdatePlanId,
  createCodexCliUpdatePlan,
  resolveCodexCliUpdateArtifactTarget,
  spawnCodexCliUpdateMetadata,
  type CodexCliUpdatePlan,
  type CodexCliUpdatePlanDeps,
  type CodexCliUpdateSpawn,
  type CodexCliUpdateTarget,
} from "../../src/codex/cli-update-plan";
import {
  VIRTUAL_BACKING_BINARY,
  VIRTUAL_BACKING_MANIFEST,
  VIRTUAL_ENTRYPOINT,
  VIRTUAL_MANIFEST,
  VIRTUAL_MANIFEST_TEXT,
  virtualInspectionDeps,
  virtualManagedNpmGlobal,
} from "../helpers/codex-cli-content-fs";

const REGISTRY_INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
function resolveArtifact(channel: "latest", spawn: CodexCliUpdateSpawn = spawnCodexCliUpdateMetadata, env?: NodeJS.ProcessEnv) {
  return resolveCodexCliUpdateArtifactTarget(channel, spawn, env, "linux", "x64");
}

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
  installContentDigest: "c".repeat(64),
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

  test("an install whose observed content could not be bound is refused before the registry query", async () => {
    // The plan id promises the observed file set; a managed install whose
    // manifest, entrypoint or backing could not be read under held identity
    // cannot produce one, and no registry request should be spent finding out.
    let queries = 0;
    const plan = await createCodexCliUpdatePlan(planDeps({
      inspect: async () => report({ installContentDigest: null }),
      resolveTarget: () => { queries += 1; return RESOLVED; },
    }));
    expect(plan.applicable).toBe(false);
    expect(plan.refusal).toBe("install_content_unverified");
    expect(plan.planId).toBeNull();
    expect(queries).toBe(0);
    expect(plan.session.state).toBe("not-evaluated");
  });

  test("a real inspection reports the content digest the plan binds", async () => {
    // The real provenance inspection runs against a virtual POSIX npm-global
    // install; only the registry target and the process scan are stubbed.
    const target: CodexCliUpdateTarget = { kind: "resolved", version: "2.0.0", integrity: "sha512-AAAA" };
    const baselineFs = virtualManagedNpmGlobal();
    let requested: CodexCliInstallProvenanceDeps | null = null;
    const baseline = await applicablePlan({
      resolveTarget: () => target,
      inspect: (d) => { requested = d; return inspectCodexCliInstall({ ...d, ...virtualInspectionDeps(baselineFs) }); },
    });
    // The plan is the one caller that pays the bounded content read.
    expect(requested?.observeInstallContent).toBe(true);
    for (const [path, replacement] of [
      // Same-length byte changes only: the installed version stays "1.2.3" so
      // every mutation leaves the plan applicable and only the bound bytes differ.
      [VIRTUAL_MANIFEST, VIRTUAL_MANIFEST_TEXT.replace("synthetic", "synthetiC")],
      [VIRTUAL_ENTRYPOINT, "#!/usr/bin/env node\n// synthetic fixture altered!!!\n"],
      [VIRTUAL_BACKING_BINARY, "synthetic-native-backing-v2\n"],
    ] as const) {
      const mutated = virtualManagedNpmGlobal();
      const sizeBefore = mutated.readFile(path).length;
      mutated.setBytes(path, replacement);
      expect(mutated.readFile(path).length).toBe(sizeBefore);
      const plan = await createCodexCliUpdatePlan(planDeps({
        resolveTarget: () => target,
        inspect: (d) => inspectCodexCliInstall({ ...d, ...virtualInspectionDeps(mutated) }),
      }));
      expect(plan.applicable).toBe(true);
      expect(plan.planId).not.toBe(baseline.planId);
    }
    // A missing backing must never produce the same plan: it refuses outright.
    const broken = virtualManagedNpmGlobal();
    broken.remove(VIRTUAL_BACKING_MANIFEST);
    broken.remove(VIRTUAL_BACKING_BINARY);
    const refused = await createCodexCliUpdatePlan(planDeps({
      resolveTarget: () => target,
      inspect: (d) => inspectCodexCliInstall({ ...d, ...virtualInspectionDeps(broken) }),
    }));
    expect(refused.refusal).toBe("install_content_unverified");
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
      // Same install root and version, different observed content.
      { inspect: async () => report({ installContentDigest: "d".repeat(64) }) },
    ];
    for (const variant of variants) {
      const plan = await applicablePlan(variant);
      expect(plan.planId).not.toBe(base.planId);
    }
  });

  test("an applicable plan binds only the declared evidence, excluding session state", async () => {
    // Independently computed SHA-256 vector for MANAGED + RESOLVED, schema 1.
    // Binding session state (or any undeclared field) changes this fixed oracle.
    expect((await applicablePlan()).planId).toBe("b569dd23df14dd7ef69b11ab95692d98");
  });

  test("the id contains only the explicitly bound evidence", () => {
    const bound = {
      platform: "linux" as NodeJS.Platform,
      provenance: "npm-global" as const,
      installedVersion: "1.0.0",
      installDigest: "a".repeat(64),
      installContentDigest: "c".repeat(64),
      channel: "latest" as const,
      targetVersion: "1.1.0",
      targetIntegrity: "sha512-AAAA",
    };
    const expected = "b569dd23df14dd7ef69b11ab95692d98";
    expect(codexCliUpdatePlanId(bound)).toBe(expected);
    const withSession = { ...bound, session: { state: "active", matches: 1 } };
    expect(codexCliUpdatePlanId(withSession)).toBe(expected);
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
    return ((_bin: string, args: string[]) => {
      const index = call++, version = outputs[0]?.stdout.trim();
      const name = index === 2 ? "@openai/codex-linux-x64" : "@openai/codex";
      return { status: outputs[index === 0 ? 0 : 1]?.status ?? 1,
        stdout: JSON.stringify({ name, version, optionalDependencies: { "@openai/codex-linux-x64": version },
          dist: { integrity: outputs[1]?.stdout.trim(), tarball: outputs[2]?.stdout.trim() } }), stderr: "" };
    }) as never;
  }

  test("an exact version with a sha512 token resolves", async () => {
    const target = await resolveArtifact("latest", spawnStub([
      { status: 0, stdout: "1.4.2\n" },
      { status: 0, stdout: `${REGISTRY_INTEGRITY}\n` },
      { status: 0, stdout: "https://registry.npmjs.org/@openai/codex/-/codex-1.4.2.tgz\n" },
    ]));
    expect(target).toMatchObject({ kind: "resolved", version: "1.4.2", integrity: REGISTRY_INTEGRITY,
      artifacts: { platform: "linux", arch: "x64", backing: { name: "@openai/codex-linux-x64" } } });
  });

  test("a missing integrity token refuses instead of proceeding best-effort", async () => {
    const target = await resolveArtifact("latest", spawnStub([
      { status: 0, stdout: "1.4.2\n" },
      { status: 0, stdout: "sha1-onlythis\n" },
    ]));
    expect(target.kind).toBe("unresolved");
  });

  test("a registry timeout refuses", async () => {
    const target = await resolveArtifact("latest", spawnStub([{ status: null, stdout: "" }]));
    expect(target.kind).toBe("unresolved");
  });

  test("a non-version answer is not treated as a version", async () => {
    const target = await resolveArtifact("latest", spawnStub([
      { status: 0, stdout: "latest\n" },
    ]));
    expect(target.kind).toBe("unresolved");
  });

  test("a tarball outside the pinned registry origin is refused even with a valid digest", async () => {
    const target = await resolveArtifact("latest", spawnStub([
      { status: 0, stdout: "1.4.2\n" },
      { status: 0, stdout: `${REGISTRY_INTEGRITY}\n` },
      { status: 0, stdout: "https://evil.invalid/@openai/codex/-/codex-1.4.2.tgz\n" },
    ]));
    expect(target.kind).toBe("unresolved");
  });

  test("a tarball answer that is not a URL at all is refused", async () => {
    const target = await resolveArtifact("latest", spawnStub([
      { status: 0, stdout: "1.4.2\n" },
      { status: 0, stdout: `${REGISTRY_INTEGRITY}\n` },
      { status: 0, stdout: "not-a-url\n" },
    ]));
    expect(target.kind).toBe("unresolved");
  });

  const GATED_MAIN_JSON = JSON.stringify({
    name: "@openai/codex", version: "1.4.2",
    optionalDependencies: { "@openai/codex-linux-x64": "1.4.2" },
    dist: { integrity: REGISTRY_INTEGRITY, tarball: "https://registry.npmjs.org/@openai/codex/-/codex-1.4.2.tgz" },
  });
  const GATED_BACKING_JSON = JSON.stringify({
    name: "@openai/codex-linux-x64", version: "1.4.2",
    dist: { integrity: REGISTRY_INTEGRITY, tarball: "https://registry.npmjs.org/@openai/codex-linux-x64/-/codex-linux-x64-1.4.2.tgz" },
  });

  /**
   * A REAL child that answers like npm view --json but only after the gate file
   * appears — or after its own cap, so a failed assertion can never hang the suite.
   * Runs through the production async spawn runner, not a mocked event loop.
   */
  const gatedNpmSpawn = (gateFile: string, capMs: number): CodexCliUpdateSpawn =>
    (_bin, args, options) => spawnCodexCliUpdateMetadata(process.execPath, [
      "-e",
      'const fs=require("node:fs"),g=process.env.OCX_GATE_FILE,a=process.env.OCX_GATE_ANSWER,d=Date.now()+Number(process.env.OCX_GATE_CAP_MS);'
      + 'const t=setInterval(()=>{if(!fs.existsSync(g)&&Date.now()<=d)return;clearInterval(t);process.stdout.write(a+"\\n",()=>process.exit(0))},15)',
    ], {
      ...options,
      // The resolver's Windows verbatim flag must not leak onto our own child argv.
      windowsVerbatimArguments: false,
      env: { ...options.env, OCX_GATE_FILE: gateFile, OCX_GATE_CAP_MS: String(capMs),
        OCX_GATE_ANSWER: args.join(" ").includes("@openai/codex-linux-x64@") ? GATED_BACKING_JSON : GATED_MAIN_JSON },
    });

  test("a gated registry child keeps the event loop responsive while planning waits", async () => {
    const dir = createCodexCliTestRoot("ocx-update-gated-npm-");
    const gateFile = join(dir, "release");
    try {
      // The real resolver wiring: registry queries spawn the gated child through the
      // production async runner. Under the old spawnSync this parked the event loop
      // for the whole per-query deadline.
      const pending = createCodexCliUpdatePlan(planDeps({
        resolveTarget: undefined,
        inspectionDeps: { arch: "x64" },
        spawnProcess: gatedNpmSpawn(gateFile, 4_000),
      }));
      const firedAt = Date.now();
      await new Promise(resolve => setTimeout(resolve, 150));
      await new Promise(resolve => setTimeout(resolve, 40));
      // A parked event loop defers the probe until the gated child self-caps, so the
      // wall clock from the plan call is the discriminator — not probe latency alone.
      expect(Date.now() - firedAt).toBeLessThan(2_000);
      writeFileSync(gateFile, "release");
      const plan = await pending;
      expect(plan).toMatchObject({ applicable: true, targetVersion: "1.4.2" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("registry metadata runner terminal lanes", () => {
  const OPTS = { encoding: "utf8" as const, timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true as const };
  test("a non-zero exit keeps its code", async () => {
    const result = await spawnCodexCliUpdateMetadata(process.execPath, ["-e", "process.exit(3)"], OPTS);
    expect(result.status).toBe(3);
  });
  test("a child past the per-query deadline settles null on its terminal event", async () => {
    const startedAt = Date.now();
    const result = await spawnCodexCliUpdateMetadata(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"],
      { ...OPTS, timeout: 250 });
    expect(result.status).toBeNull();
    // The deadline kill is followed by the child's real close, not a reap guess
    // long enough to matter; a 30 s sleeper proves settlement came from the kill.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
  test("stdout past maxBuffer refuses instead of truncating", async () => {
    const result = await spawnCodexCliUpdateMetadata(process.execPath,
      ["-e", 'process.stdout.write("x".repeat(2 * 1024 * 1024))'],
      { ...OPTS, maxBuffer: 64 * 1024 });
    expect(result.status).toBeNull();
  });
  test("multibyte output split across OS pipe chunks decodes intact", async () => {
    const result = await spawnCodexCliUpdateMetadata(process.execPath,
      ["-e", 'process.stdout.write("\uac00".repeat(200_000))'], { ...OPTS, maxBuffer: 4 * 1024 * 1024 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("가".repeat(200_000));
    expect(result.stdout).not.toContain("�");
  });
  test("a binary that cannot be spawned settles null like spawnSync", async () => {
    const dir = createCodexCliTestRoot("ocx-meta-spawn-");
    try {
      const result = await spawnCodexCliUpdateMetadata(join(dir, "no-such-npm"), ["view"], OPTS);
      expect(result.status).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("the result waits for the child's real terminal event before settling", async () => {
    const dir = createCodexCliTestRoot("ocx-meta-terminal-");
    const marker = join(dir, "terminal");
    try {
      const startedAt = Date.now();
      const result = await spawnCodexCliUpdateMetadata(process.execPath,
        ["-e", "setTimeout(() => require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'x'), 300)"], OPTS);
      expect(result.status).toBe(0);
      // The child's final write is on disk when the runner settles: the resolve
      // followed the terminal event, so the caller's isolation cleanup in its
      // finally can never run underneath a still-live child.
      expect(existsSync(marker)).toBe(true);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
    cwdHadGlobalNpmrc: boolean;
  }

  /** The npm argv, whether it reached spawn bare (POSIX) or inside a cmd /c line (Windows). */
  function argvLine(call: CapturedCall): string {
    return call.args.join(" ");
  }

  function cachePath(call: Pick<CapturedCall, "args" | "options">): string | undefined {
    if (!call.options.windowsVerbatimArguments) {
      return call.args.find(arg => arg.startsWith("--cache="))?.slice("--cache=".length);
    }
    expect(call.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    // Decode one cmd escape layer, retaining spaces and literal carets in the
    // quoted argument. Splitting on whitespace truncates Windows profile paths.
    const line = call.args[3]?.replace(/\^([\s\S])/g, "$1");
    return line?.match(/"--cache=([^"]*)"/)?.[1];
  }

  test.each(["plain", "profile with spaces", "profile^with&metacharacters"])(
    "the Windows cache argument preserves the entire %s path", profile => {
      const cache = `C:\\Users\\${profile}\\Temp\\owned\\npm-cache`;
      const invocation = npmInvocation(["view", "pkg@latest", "version", `--cache=${cache}`], "win32", {
        PATH: "C:\\Program Files\\nodejs", PATHEXT: ".CMD", SystemRoot: "C:\\Windows",
      }, { cwd: "C:\\project", exists: path => path === "C:\\Program Files\\nodejs\\npm.cmd" });
      expect(invocation).not.toBeNull();
      expect(cachePath(invocation!)).toBe(cache);
    },
  );

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
        cwdHadGlobalNpmrc: existsSync(join(cwd, "ocx-update-global.npmrc")),
      };
      calls.push(call);
      const field = queriedField(call);
      if (argvLine(call).includes("--json")) {
        const version = (outputs.version ?? "").trim();
        const backing = argvLine(call).match(/@openai\/codex-(?:linux|darwin)-(?:x64|arm64)(?=@)/)?.[0];
        return { status: 0, stdout: JSON.stringify({ name: backing ?? "@openai/codex", version,
          optionalDependencies: backing ? undefined : Object.fromEntries(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]
            .map(suffix => [`@openai/codex-${suffix}`, version])),
          dist: { integrity: (outputs["dist.integrity"] ?? "").trim(), tarball: (outputs["dist.tarball"] ?? "").trim() } }), stderr: "" };
      }
      return { status: 0, stdout: outputs[field] ?? "", stderr: "" };
    }) as never;
    return { calls, spawn };
  }

  const RESOLVE_OUTPUTS = {
    version: "1.4.2\n",
    "dist.integrity": `${REGISTRY_INTEGRITY}\n`,
    "dist.tarball": "https://registry.npmjs.org/@openai/codex/-/codex-1.4.2.tgz\n",
  };

  test.each(["resolved", "unresolved"] as const)("cleanup failure preserves the %s resolver outcome", async kind => {
    let ownedRoot = "";
    let cleanupAttempts = 0;
    const originalRemove = fs.rmSync;
    const removal = spyOn(fs, "rmSync").mockImplementation((path, options) => {
      if (ownedRoot && path === ownedRoot) {
        cleanupAttempts += 1;
        throw Object.assign(new Error("synthetic cleanup denial"), { code: "EACCES" });
      }
      return originalRemove(path, options);
    });
    try {
      const capture = capturingSpawn(kind === "resolved" ? RESOLVE_OUTPUTS : { version: "invalid-version" });
      const spawn = ((bin: string, args: string[], options: Record<string, unknown>) => {
        ownedRoot = options.cwd as string;
        return (capture.spawn as typeof spawnSync)(bin, args, options);
      }) as never;
      expect((await resolveArtifact("latest", spawn)).kind).toBe(kind);
      expect(cleanupAttempts).toBe(1);
      expect(existsSync(ownedRoot)).toBe(true);
    } finally {
      removal.mockRestore();
      if (ownedRoot) rmSync(ownedRoot, { recursive: true, force: true });
    }
  });

  test("every query pins the official registry and substitutes a controlled npmrc", async () => {
    const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
    const target = await resolveArtifact("latest", spawn);
    expect(target.kind).toBe("resolved");
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(argvLine(call)).toContain("--registry=" + CODEX_CLI_REGISTRY);
      expect(argvLine(call)).toContain("--json"); expect(call.options.maxBuffer).toBe(1024 * 1024);
      // Both file configs use distinct controlled empty files inside the
      // isolation dir — a user ~/.npmrc or a global $PREFIX/etc/npmrc cannot answer.
      expect(argvLine(call)).toContain("--userconfig=");
      expect(argvLine(call)).toContain("--globalconfig=");
      expect(argvLine(call)).toContain("ocx-update.npmrc");
      expect(argvLine(call)).toContain("ocx-update-global.npmrc");
      expect(call.cwdHadSentinel).toBe(true);
      expect(call.cwdHadNpmrc).toBe(true);
      expect(call.cwdHadGlobalNpmrc).toBe(true);
    }
    // The isolation directory is cleaned up after the resolve.
    expect(existsSync(calls[0]!.options.cwd as string)).toBe(false);
  });

  test("a hostile npm_config_* env cannot reach the spawned npm", async () => {
    const prior = process.env.npm_config_registry;
    const priorScoped = process.env["npm_config_@openai:registry"];
    process.env.npm_config_registry = "https://evil.invalid";
    process.env["npm_config_@openai:registry"] = "https://evil.invalid/";
    try {
      const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
      const target = await resolveArtifact("latest", spawn);
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

  test("the controlled cwd never is the operator's project directory", async () => {
    // A project .npmrc in the launch directory would otherwise redirect the scope;
    // the query must run from the sentinel-anchored isolation dir instead.
    const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
    expect((await resolveArtifact("latest", spawn)).kind).toBe("resolved");
    expect(calls.length).toBe(3);
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

  test("the bound launcher snapshot supplies executable and transport trust inputs", async () => {
    const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
    const boundEnv = { ...markerBoundEnv(), HTTPS_PROXY: "http://trusted-proxy", NODE_EXTRA_CA_CERTS: "/trusted/ca.pem" };
    const previous = { HTTPS_PROXY: process.env.HTTPS_PROXY, ALL_PROXY: process.env.ALL_PROXY,
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS };
    try {
      process.env.HTTPS_PROXY = "http://project-dotenv-proxy";
      process.env.ALL_PROXY = "http://project-dotenv-fallback";
      process.env.NODE_EXTRA_CA_CERTS = "/project/dotenv-ca.pem";
      expect((await resolveArtifact("latest", spawn, boundEnv)).kind).toBe("resolved");
      for (const call of calls) {
        const env = call.options.env as NodeJS.ProcessEnv;
        expect(env.PATH).toBe(boundEnv.PATH);
        expect(env.PATHEXT).toBe(boundEnv.PATHEXT);
        expect(env.HTTPS_PROXY).toBe(boundEnv.HTTPS_PROXY);
        expect(env.ALL_PROXY).toBeUndefined();
        expect(env.NODE_EXTRA_CA_CERTS).toBe(boundEnv.NODE_EXTRA_CA_CERTS);
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test.each(["x64", "arm64"] as const)("the plan resolves registry evidence through the attested %s launcher environment", async arch => {
    const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
    const boundEnv = markerBoundEnv();
    const plan = await applicablePlan({
      // Dropping the resolveTarget stub exercises the real resolver wiring: the
      // provenance snapshot env must reach npm's spawn options.
      resolveTarget: undefined,
      inspectionDeps: { env: boundEnv, arch },
      spawnProcess: spawn,
    });
    expect(plan.targetVersion).toBe("1.4.2");
    expect(calls.length).toBe(3);
    for (const call of calls) {
      const env = call.options.env as NodeJS.ProcessEnv;
      expect(env.PATH).toBe(boundEnv.PATH);
    }
  });

  test.each([
    "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH", "LD_DEBUG_OUTPUT",
    "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
    "ld_preload", "dyld_insert_libraries",
  ])("ambient loader control %s cannot reach the spawned npm", async key => {
    const previous = process.env[key];
    process.env[key] = "/synthetic/nonexistent-loader-fixture";
    try {
      // Capture only: no loader, native child process or network is invoked.
      const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
      expect((await resolveArtifact("latest", spawn)).kind).toBe("resolved");
      expect(calls.length).toBe(3);
      for (const call of calls) {
        const env = call.options.env as NodeJS.ProcessEnv;
        expect(Object.keys(env).some(name => name.toLowerCase() === key.toLowerCase())).toBe(false);
      }
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  test("hostile Node startup channels cannot reach the spawned npm", async () => {
    const priorOptions = process.env.NODE_OPTIONS;
    const priorPath = process.env.NODE_PATH;
    const priorTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const priorCoverage = process.env.NODE_V8_COVERAGE;
    const priorWarnings = process.env.NODE_REDIRECT_WARNINGS;
    process.env.NODE_OPTIONS = "--require=evil";
    process.env.NODE_PATH = "C:\\evil-modules";
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    process.env.NODE_V8_COVERAGE = "C:\\evil-coverage";
    process.env.NODE_REDIRECT_WARNINGS = "C:\\evil-warnings.log";
    try {
      const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
      const target = await resolveArtifact("latest", spawn);
      expect(target.kind).toBe("resolved");
      for (const call of calls) {
        const env = call.options.env as NodeJS.ProcessEnv;
        const lower = new Set(Object.keys(env).map(key => key.toLowerCase()));
        expect(lower.has("node_options")).toBe(false);
        expect(lower.has("node_path")).toBe(false);
        expect(lower.has("node_tls_reject_unauthorized")).toBe(false);
        expect(lower.has("node_v8_coverage")).toBe(false);
        expect(lower.has("node_redirect_warnings")).toBe(false);
      }
    } finally {
      if (priorOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = priorOptions;
      if (priorPath === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = priorPath;
      if (priorTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = priorTls;
      if (priorCoverage === undefined) delete process.env.NODE_V8_COVERAGE;
      else process.env.NODE_V8_COVERAGE = priorCoverage;
      if (priorWarnings === undefined) delete process.env.NODE_REDIRECT_WARNINGS;
      else process.env.NODE_REDIRECT_WARNINGS = priorWarnings;
    }
  });

  test.each([
    "OPENSSL_CONF", "OPENSSL_CONF_INCLUDE", "OPENSSL_MODULES", "OPENSSL_ENGINES",
    "openssl_conf", "openssl_modules",
  ])("ambient OpenSSL startup control %s cannot reach the spawned npm", async key => {
    const previous = process.env[key];
    process.env[key] = join(tmpdir(), "ocx-ambient-openssl.cnf");
    try {
      // Capture only: no child process, native provider or network is invoked.
      const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
      expect((await resolveArtifact("latest", spawn)).kind).toBe("resolved");
      expect(calls.length).toBe(3);
      for (const call of calls) {
        const env = call.options.env as NodeJS.ProcessEnv;
        expect(Object.keys(env).some(name => name.toLowerCase() === key.toLowerCase())).toBe(false);
      }
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  test("supported proxy and CA channels still reach the spawned npm", async () => {
    const sentinels = {
      HTTP_PROXY: "http://127.0.0.1:9/ocx-proxy-sentinel",
      NO_PROXY: "registry.npmjs.org.invalid,127.0.0.1",
      NODE_EXTRA_CA_CERTS: join(tmpdir(), "ocx-corporate-ca.pem"),
    };
    const previous = Object.fromEntries(Object.keys(sentinels).map(key => [key, process.env[key]]));
    try {
      Object.assign(process.env, sentinels);
      const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
      expect((await resolveArtifact("latest", spawn)).kind).toBe("resolved");
      for (const call of calls) {
        const env = call.options.env as NodeJS.ProcessEnv;
        for (const [key, value] of Object.entries(sentinels)) {
          // Match case-insensitively: the child env is a plain object, so a
          // Windows-normalized casing must not make a supported channel look absent.
          const entry = env[key] ?? Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
          expect(entry).toBe(value);
        }
      }
    } finally {
      for (const key of Object.keys(sentinels)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  test("real Node cannot write output sentinels outside the owned npm root", async () => {
    const fixture = createCodexCliTestRoot("ocx-update-node-output-");
    const sentinels = {
      NODE_V8_COVERAGE: join(fixture, "escaped-coverage"),
      NODE_REDIRECT_WARNINGS: join(fixture, "escaped-warnings.log"),
    };
    const previous = Object.fromEntries(Object.keys(sentinels).map(key => [key, process.env[key]]));
    const makeTemp = fs.mkdtempSync;
    // Both the owned npm root and its external sentinels stay inside this fixture.
    const ownedTemp = spyOn(fs, "mkdtempSync").mockImplementation(prefix => {
      expect(String(prefix)).toBe(join(tmpdir(), "ocx-codex-cli-meta-"));
      return makeTemp(join(fixture, "owned-"));
    });
    let ownedRoot = "";
    let checked = false;
    try {
      Object.assign(process.env, sentinels);
      const node = Bun.which("node");
      expect(node).not.toBeNull();
      const spawn = ((bin: string, args: string[], options: Record<string, unknown>) => {
        ownedRoot = options.cwd as string;
        expect(dirname(ownedRoot)).toBe(fixture);
        if (!checked) {
          const childEnv = options.env as NodeJS.ProcessEnv;
          const runNode = (env: NodeJS.ProcessEnv) => {
            const result = spawnSync(node!, ["-e",
              "process.emitWarning('ocx-output-sentinel'); console.log('ocx-runtime:' + process.release.name)",
            ], { cwd: ownedRoot, env, encoding: "utf8", timeout: 5_000, windowsHide: true });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            expect(result.stdout.trim()).toBe("ocx-runtime:node");
          };
          // Positive control: this actual Node supports both output channels. It
          // writes to separate fixture paths, so missing Node/output cannot pass.
          const controlCoverage = join(fixture, "control-coverage");
          const controlWarnings = join(fixture, "control-warnings.log");
          runNode({ ...childEnv, NODE_V8_COVERAGE: controlCoverage, NODE_REDIRECT_WARNINGS: controlWarnings });
          expect(readdirSync(controlCoverage).some(name => name.endsWith(".json"))).toBe(true);
          expect(fs.readFileSync(controlWarnings, "utf8")).toContain("ocx-output-sentinel");
          // Exercise the exact environment supplied by the real resolver, with
          // no registry access. Observe absence before its finally removes cwd.
          runNode(childEnv);
          expect(existsSync(ownedRoot)).toBe(true);
          expect(existsSync(sentinels.NODE_V8_COVERAGE)).toBe(false);
          expect(existsSync(sentinels.NODE_REDIRECT_WARNINGS)).toBe(false);
          checked = true;
        }
        const field = queriedField({ bin, args, options } as CapturedCall);
        return (capturingSpawn(RESOLVE_OUTPUTS).spawn as typeof spawnSync)(bin, args, options);
      }) as never;
      expect((await resolveArtifact("latest", spawn)).kind).toBe("resolved");
      expect(checked).toBe(true);
      expect(existsSync(ownedRoot)).toBe(false);
    } finally {
      ownedTemp.mockRestore();
      for (const key of Object.keys(sentinels)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("a trusted snapshot without PATH installs an explicit empty PATH and fails closed", async () => {
    const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
    await resolveArtifact("latest", spawn, { PATHEXT: ".COM;.EXE;.BAT;.CMD" });
    // With no trusted PATH the ambient PATH must never reach the child: Windows
    // resolves the binary itself and spawns nothing, while POSIX spawns the bare
    // npm name whose execvp lookup then fails under the explicit empty PATH.
    for (const call of calls) {
      expect((call.options.env as NodeJS.ProcessEnv).PATH).toBe("");
    }
    // The fail-closed contract is the resolution outcome, not a stub answer: a
    // spawn that honours the empty PATH fails and the target stays unresolved.
    const enoent = { status: null as number | null, stdout: "", stderr: "spawnSync npm ENOENT", error: new Error("spawnSync npm ENOENT") };
    const failingSpawn = (() => ({ ...enoent })) as never;
    const refused = await resolveArtifact("latest", failingSpawn, { PATHEXT: ".COM;.EXE;.BAT;.CMD" });
    expect(refused.kind).toBe("unresolved");
  });

  test("npm and Node caches and logs stay inside the owned temporary root", async () => {
    const { calls, spawn } = capturingSpawn(RESOLVE_OUTPUTS);
    const target = await resolveArtifact("latest", spawn);
    expect(target.kind).toBe("resolved");
    expect(calls.length).toBe(3);
    for (const call of calls) {
      const cwd = call.options.cwd as string;
      // The cache root (and therefore npm's _logs directory beneath it) must live
      // inside the owned isolation dir, not under an ambient ~/.npm.
      expect(cachePath(call)).toBe(join(cwd, "npm-cache"));
      expect((call.options.env as NodeJS.ProcessEnv).NODE_COMPILE_CACHE).toBe(join(cwd, "node-compile-cache"));
    }
  });

  test("real npm startup through the resolver seam cannot recreate an ambient Node compile cache", async () => {
    const root = createCodexCliTestRoot("ocx-update-node-cache-");
    const home = join(root, "home"), temporaryRoot = join(root, "temp"), ambientCache = join(root, "ambient-cache");
    const previous = process.env.NODE_COMPILE_CACHE;
    let isolatedDir = "", observedCache: string | undefined, calls = 0;
    try {
      fs.mkdirSync(home); fs.mkdirSync(temporaryRoot);
      process.env.NODE_COMPILE_CACHE = ambientCache;
      const spawn = ((bin: string, args: string[], options: Record<string, unknown>) => {
        const field = queriedField({ args } as CapturedCall);
        if (calls++ === 0) {
          isolatedDir = options.cwd as string;
          const env = { ...(options.env as NodeJS.ProcessEnv), HOME: home, USERPROFILE: home,
            TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot };
          // Keep production argv/env/cwd; --version exercises npm startup without a registry call.
          // cmd's last argument is one outer-quoted command, so append inside that quote.
          const probeArgs = options.windowsVerbatimArguments
            ? [...args.slice(0, 3), args[3]!.slice(0, -1) + ' --version --offline"']
            : [...args, "--version", "--offline"];
          for (const key of Object.keys(env)) if (key.toLowerCase() === "node_disable_compile_cache") delete env[key];
          const result = spawnSync(bin, probeArgs, { ...options, env,
            timeout: 15_000, windowsHide: true, encoding: "utf8" });
          expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
          expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
          observedCache = env.NODE_COMPILE_CACHE;
        }
        // Only registry evidence is synthetic; npm startup above is real.
        return (capturingSpawn(RESOLVE_OUTPUTS).spawn as typeof spawnSync)(bin, args, options);
      }) as never;
      expect((await resolveArtifact("latest", spawn)).kind).toBe("resolved");
      expect(calls).toBe(3);
      expect(existsSync(isolatedDir)).toBe(false);
      expect(readdirSync(temporaryRoot)).toEqual([]);
      expect(existsSync(ambientCache)).toBe(false);
      expect(readdirSync(home)).toEqual([]);
      expect(observedCache).toBe(join(isolatedDir, "node-compile-cache"));
    } finally {
      if (previous === undefined) delete process.env.NODE_COMPILE_CACHE;
      else process.env.NODE_COMPILE_CACHE = previous;
      rmSync(root, { recursive: true });
    }
  });

  test.skipIf(process.platform === "win32")("real npm accepts both isolated config paths without any registry access", async () => {
    // POSIX uses a flat argv. Windows planning remains deferred; its quoted command
    // and file isolation are covered above without treating a shell line as argv.
    const fakeHome = createCodexCliTestRoot("ocx-update-config-test-");
    let configReads = 0;
    let isolatedDir = "";
    try {
      const spawn = ((bin: string, args: string[], options: Record<string, unknown>) => {
        const field = queriedField({ args } as CapturedCall);
        isolatedDir = options.cwd as string;
        if (configReads === 0) {
          const flags = args.filter(arg => arg.startsWith("--"));
          const user = flags.find(arg => arg.startsWith("--userconfig="));
          const global = flags.find(arg => arg.startsWith("--globalconfig="));
          expect(user?.slice("--userconfig=".length)).not.toBe(global?.slice("--globalconfig=".length));
          const result = spawnSync(bin, ["config", "get", "registry", ...flags], {
            ...options,
            env: { ...(options.env as NodeJS.ProcessEnv), HOME: fakeHome, USERPROFILE: fakeHome },
            timeout: 10_000, windowsHide: true, encoding: "utf8",
          });
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(0);
          expect(new URL(result.stdout.trim()).href).toBe(new URL(CODEX_CLI_REGISTRY).href);
          expect(result.stderr).not.toContain("double-loading config");
          configReads++;
        }
        return (capturingSpawn(RESOLVE_OUTPUTS).spawn as typeof spawnSync)(bin, args, options);
      }) as never;
      expect((await resolveArtifact("latest", spawn)).kind).toBe("resolved");
      expect(configReads).toBe(1);
      expect(existsSync(isolatedDir)).toBe(false);
      expect(readdirSync(fakeHome)).toEqual([]);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("a real npm call under the isolated argv leaves the operator HOME untouched", async () => {
    // Runs real npm exactly once: the first captured query executes for real with a
    // disposable HOME while the rest stay stubbed. npm_config_offline makes the
    // registry leg fail fast without network; the residue assertions hold either way.
    const fakeHome = createCodexCliTestRoot("ocx-update-test-home-");
    try {
      const calls: CapturedCall[] = [];
      const ownedDuringRun: string[] = [];
      let realRan = false;
      const spawn = ((bin: string, args: string[], options: Record<string, unknown>) => {
        const cwd = options.cwd as string;
        const call: CapturedCall = {
          bin, args, options,
          cwdHadSentinel: existsSync(join(cwd, "package.json")),
          cwdHadNpmrc: existsSync(join(cwd, "ocx-update.npmrc")),
          cwdHadGlobalNpmrc: existsSync(join(cwd, "ocx-update-global.npmrc")),
        };
        calls.push(call);
        const field = queriedField(call);
        if (realRan) return (capturingSpawn(RESOLVE_OUTPUTS).spawn as typeof spawnSync)(bin, args, options);
        const env = { ...(options.env as NodeJS.ProcessEnv), HOME: fakeHome, USERPROFILE: fakeHome, npm_config_offline: "true" };
        const offlineArgs = options.windowsVerbatimArguments
          ? [...args.slice(0, 3), args[3]!.slice(0, -1) + ' --offline --fetch-retries=0 --fetch-timeout=1000"']
          : [...args, "--offline", "--fetch-retries=0", "--fetch-timeout=1000"];
        const result = spawnSync(bin, offlineArgs, { ...options, env, timeout: 10_000, windowsHide: true, encoding: "utf8" });
        realRan = true;
        // A spawn that never started (ENOENT, timeout kill) proves nothing; require
        // a real process exit so the residue assertions actually bound npm's writes.
        expect(result.error).toBeUndefined();
        expect(result.status === 0 || result.status === 1).toBe(true);
        expect(result.stderr).not.toContain("double-loading config");
        // The owned root is still live here, so residue inside it is observable
        // before the resolver's finally removes it.
        for (const name of readdirSync(cwd)) ownedDuringRun.push(name);
        return (capturingSpawn(RESOLVE_OUTPUTS).spawn as typeof spawnSync)(bin, args, options);
      }) as never;
      await resolveArtifact("latest", spawn);
      expect(realRan).toBe(true);
      const cwd = calls[0]!.options.cwd as string;
      // Anything npm persisted was inside the owned root and is removed with it;
      // the disposable HOME stays completely empty (no ~/.npm, no ~/.npmrc, no _logs).
      for (const name of ownedDuringRun) {
        expect(["package.json", "ocx-update.npmrc", "ocx-update-global.npmrc", "npm-cache", "node-compile-cache"].includes(name)).toBe(true);
      }
      expect(existsSync(cwd)).toBe(false);
      expect(readdirSync(fakeHome)).toEqual([]);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 15_000);
});
