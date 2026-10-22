import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { handleCodexCliUpdateCommand, parseCodexCliUpdateArgs } from "../../src/cli/codex-cli-update";
import { admitCodexCliUpdateJob, finishCodexCliUpdateJob, projectCodexCliUpdateJobLifecycle, readCodexCliUpdateJob, runCodexCliUpdateJob } from "../../src/codex/cli-update-job";
import {
  initializeNodeLauncherContext,
  NODE_LAUNCH_CONTEXT_ENV,
  NODE_LAUNCH_PROOF_PREFIX,
} from "../../src/cli/launcher-context";
import type { CodexCliInstallProvenanceDeps, CodexCliInstallReport } from "../../src/codex/cli-install-provenance";
import type { CodexCliInstallationIdentityInput, CodexCliInstallationIdentityReport } from "../../src/codex/cli-installation-identity";

const report: CodexCliInstallReport = {
  schemaVersion: 1,
  candidateAvailable: false,
  candidateVersion: null,
  candidateSource: null,
  selectionAttested: false,
  versionEvidence: { kind: "unavailable" },
  provenance: "unknown", managed: false, reason: "candidate_unavailable", location: null,
  installDigest: null,
  installContentDigest: null,
  packageVersion: null,
  shim: { status: "not-tracked", backingKind: null }, evidence: [],
};

const identityInput: CodexCliInstallationIdentityInput = {
  candidate: "C:\\explicit install\\codex.cmd",
  npmPrefix: "C:\\explicit install",
  npmCli: "C:\\tools\\node_modules\\npm\\bin\\npm-cli.js",
  node: "C:\\tools\\node.exe",
};
const attestArgs = [
  "attest", "--candidate", identityInput.candidate, "--npm-prefix", identityInput.npmPrefix,
  "--npm-cli", identityInput.npmCli, "--node", identityInput.node,
];
const identityReport: CodexCliInstallationIdentityReport = {
  schemaVersion: 1, candidateSource: "explicit-cli", status: "observed", reason: "identity_observed",
  installationIdentityObserved: true, selectionAttested: false, managed: false, applyAllowed: false,
  packageVersion: "1.2.3", npmVersion: "11.0.0", identityDigest: "a".repeat(64),
  proof: "windows-handle-bound", toolchain: "observed-only",
};

function privateStoreParent(prefix: string): { outer: string; parent: string } {
  const outer = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  try {
    chmodSync(outer, 0o700);
    const parentPath = join(outer, "private-parent");
    mkdirSync(parentPath, { mode: 0o700 });
    chmodSync(parentPath, 0o700);
    const parent = realpathSync.native(parentPath);
    const stat = lstatSync(parent);
    const diagnostic = {
      canonicalEqual: realpathSync.native(parent) === parent,
      modeSafe: (stat.mode & 0o022) === 0,
      isDirectory: stat.isDirectory(),
      notSymlink: !stat.isSymbolicLink(),
      ownerMatches: process.geteuid?.() !== undefined && stat.uid === process.geteuid(),
    };
    if (!Object.values(diagnostic).every(Boolean)) {
      throw new Error(`private job-store fixture parent failed safe checks: ${JSON.stringify(diagnostic)}`);
    }
    return { outer, parent };
  } catch (error) {
    rmSync(outer, { recursive: true });
    throw error;
  }
}

function privateStoreRoot(prefix: string): { outer: string; parent: string; configDir: string } {
  const fixture = privateStoreParent(prefix);
  try {
    const configPath = join(fixture.parent, "ocx");
    mkdirSync(configPath, { mode: 0o700 });
    chmodSync(configPath, 0o700);
    const configDir = realpathSync.native(configPath);
    const stat = lstatSync(configDir);
    const diagnostic = {
      canonicalEqual: realpathSync.native(configDir) === configDir,
      modePrivate: (stat.mode & 0o077) === 0,
      isDirectory: stat.isDirectory(),
      notSymlink: !stat.isSymbolicLink(),
      ownerMatches: process.geteuid?.() !== undefined && stat.uid === process.geteuid(),
    };
    if (!Object.values(diagnostic).every(Boolean)) {
      throw new Error(`private job-store config root failed safe checks: ${JSON.stringify(diagnostic)}`);
    }
    return { ...fixture, configDir };
  } catch (error) {
    rmSync(fixture.outer, { recursive: true });
    throw error;
  }
}

function hasTrustedStickyTmp(): boolean {
  if (process.platform === "win32" || process.geteuid?.() === undefined) return false;
  try {
    const canonical = realpathSync.native("/tmp");
    const stat = lstatSync(canonical);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
  } catch { return false; }
}

describe("Codex CLI update CLI", () => {
  test.skipIf(process.platform === "win32" || process.geteuid?.() === undefined)("confirmed admission creates one missing config root without making reads write", () => {
    const { outer, parent } = privateStoreParent("ocx-cli-update-missing-parent-");
    const configDir = join(parent, "ocx");
    try {
      expect(readCodexCliUpdateJob("12345678-1234-1234-1234-123456789012", configDir)).toBeNull();
      expect(existsSync(configDir)).toBe(false);
      const missingParent = join(parent, "not-created");
      expect(() => admitCodexCliUpdateJob({ requestId: "no-recursive-root-001", planId: "c".repeat(32), confirmed: true,
        configDir: join(missingParent, "ocx") })).toThrow();
      expect(existsSync(missingParent)).toBe(false);
      const accepted = admitCodexCliUpdateJob({ requestId: "missing-root-admission-01", planId: "a".repeat(32), confirmed: true, configDir });
      const stat = lstatSync(configDir);
      expect({
        canonicalEqual: realpathSync.native(configDir) === configDir,
        modePrivate: (stat.mode & 0o077) === 0,
        isDirectory: stat.isDirectory(),
        isSymlink: stat.isSymbolicLink(),
        ownerMatches: process.geteuid?.() !== undefined && stat.uid === process.geteuid?.(),
        accepted: accepted.kind === "accepted",
      }).toEqual({ canonicalEqual: true, modePrivate: true, isDirectory: true, isSymlink: false, ownerMatches: true, accepted: true });
    } finally { rmSync(outer, { recursive: true }); }
  });

  test.skipIf(process.platform === "win32" || process.geteuid?.() === undefined)("confirmed admission reuses an existing canonical config root", () => {
    const { outer, configDir } = privateStoreRoot("ocx-cli-update-existing-root-");
    try {
      const before = lstatSync(configDir);
      const accepted = admitCodexCliUpdateJob({ requestId: "existing-root-admission-01", planId: "b".repeat(32), confirmed: true, configDir });
      const after = lstatSync(configDir);
      expect(accepted.kind).toBe("accepted");
      expect(after.dev).toBe(before.dev);
      expect(after.ino).toBe(before.ino);
      expect(realpathSync.native(configDir)).toBe(configDir);
    } finally { rmSync(outer, { recursive: true }); }
  });

  test.skipIf(!hasTrustedStickyTmp())("missing config root admission allows a root-owned sticky temporary ancestor", () => {
    const stickyTmp = realpathSync.native("/tmp");
    const directConfig = join(stickyTmp, `ocx-cli-update-direct-sticky-${randomUUID()}`);
    expect(() => admitCodexCliUpdateJob({ requestId: "direct-sticky-parent-001", planId: "d".repeat(32),
      confirmed: true, configDir: directConfig })).toThrow("unsafe_store");
    expect(existsSync(directConfig)).toBe(false);
    const outer = realpathSync.native(mkdtempSync(join(stickyTmp, "ocx-cli-update-sticky-parent-")));
    try {
      chmodSync(outer, 0o700);
      const parent = join(outer, "private-parent");
      mkdirSync(parent, { mode: 0o700 });
      chmodSync(parent, 0o700);
      const configDir = join(parent, "ocx");
      const accepted = admitCodexCliUpdateJob({ requestId: "sticky-parent-admission-001", planId: "d".repeat(32), confirmed: true, configDir });
      const stat = lstatSync(configDir);
      expect(accepted.kind).toBe("accepted");
      expect((stat.mode & 0o077) === 0 && stat.isDirectory() && !stat.isSymbolicLink()
        && process.geteuid?.() !== undefined && stat.uid === process.geteuid?.()
        && realpathSync.native(configDir) === configDir).toBe(true);
    } finally { rmSync(outer, { recursive: true }); }
  });

  test.skipIf(process.platform === "win32" || process.geteuid?.() === undefined)("missing config root admission refuses a non-sticky shared ancestor before mkdir", () => {
    const { outer, parent } = privateStoreParent("ocx-cli-update-shared-ancestor-");
    const configDir = join(parent, "ocx");
    try {
      chmodSync(outer, 0o777);
      expect(() => admitCodexCliUpdateJob({ requestId: "shared-ancestor-admission-01", planId: "e".repeat(32),
        confirmed: true, configDir })).toThrow("unsafe_store");
      expect(existsSync(configDir)).toBe(false);
    } finally {
      chmodSync(outer, 0o700);
      rmSync(outer, { recursive: true });
    }
  });

  test.skipIf(process.platform === "win32" || process.geteuid?.() === undefined)("existing config root refuses unsafe ancestry before admission or completion writes", async () => {
    const { outer, parent, configDir } = privateStoreRoot("ocx-cli-update-existing-shared-ancestor-");
    let release: (() => void) | undefined;
    let pending: Promise<unknown> | undefined;
    try {
      const accepted = admitCodexCliUpdateJob({ requestId: "existing-shared-admission-001", planId: "f".repeat(32),
        confirmed: true, configDir });
      pending = runCodexCliUpdateJob(accepted.job.jobId, accepted.generation, () => new Promise(resolve => {
        release = () => resolve({ outcome: "applied", reason: "verified_target", planId: "f".repeat(32),
          installedVersion: "1.0.0", targetVersion: "1.1.0", installerExitCode: 0, leaseRetained: false,
          verificationPid: null, cleanupErrors: [] });
      }), configDir);
      if (!release) throw new Error("fixture job owner did not enter its awaited operation");
      const ledger = join(configDir, "codex-cli-update-jobs", "jobs.json");
      const before = readFileSync(ledger);
      chmodSync(outer, 0o777);
      expect(() => admitCodexCliUpdateJob({ requestId: "blocked-existing-admission-001", planId: "1".repeat(32),
        confirmed: true, configDir })).toThrow("unsafe_store");
      expect(() => readCodexCliUpdateJob(accepted.job.jobId, configDir)).toThrow("unsafe_store");
      expect(() => finishCodexCliUpdateJob(accepted.job.jobId, accepted.generation, 1, {
        outcome: "applied", reason: "verified_target", planId: "f".repeat(32), installedVersion: "1.0.0",
        targetVersion: "1.1.0", installerExitCode: 0, leaseRetained: false, verificationPid: null, cleanupErrors: [],
      }, configDir)).toThrow("unsafe_store");
      await expect(runCodexCliUpdateJob(accepted.job.jobId, accepted.generation,
        async () => { throw new Error("unsafe ancestry must reject before running"); }, configDir)).rejects.toThrow("unsafe_store");
      expect(readFileSync(ledger)).toEqual(before);
    } finally {
      chmodSync(outer, 0o700);
      release?.();
      if (pending) await pending.catch(() => undefined);
      rmSync(outer, { recursive: true });
    }
  });

  test("job lifecycle projection keeps lease and child uncertainty distinct from the outcome", () => {
    const project = (input: Parameters<typeof projectCodexCliUpdateJobLifecycle>[0]) => projectCodexCliUpdateJobLifecycle(input);
    const base = { active: false, status: "ambiguous" as const, outcome: "ambiguous" as const,
      reason: "job_result_unknown", leaseRetained: true, cleanupErrors: [] as readonly string[] };
    expect(project(base)).toMatchObject({ childState: "unknown", leaseState: "unknown", outcome: "ambiguous" });
    expect(project({ ...base, reason: "installer_or_readback_error" })).toMatchObject({
      childState: "unknown", leaseState: "retained", outcome: "ambiguous",
    });
    expect(project({ ...base, status: "applied", outcome: "applied", reason: "verified_target",
      cleanupErrors: ["lease_release_exception"] })).toMatchObject({
      childState: "terminal", leaseState: "unknown", status: "applied", outcome: "applied",
    });
    expect(project({ ...base, status: "applied", outcome: "applied", reason: "verified_target",
      cleanupErrors: ["lease_release_unverified"] })).toMatchObject({ leaseState: "unknown", outcome: "applied" });
    expect(project({ ...base, reason: "installation_readback_unverified" })).toMatchObject({
      leaseState: "unknown",
    });
    expect(project({ ...base, reason: "version_process_state_unknown" })).toMatchObject({
      childState: "unknown", leaseState: "retained",
    });
  });

  test.skipIf(process.platform === "win32" || process.geteuid?.() === undefined)("apply retry keys deduplicate durable jobs and status exposes only the shared public DTO", async () => {
    const { outer, configDir } = privateStoreRoot("ocx-cli-update-job-test-");
    try {
      const requestId = "retry-key-0000001";
      const planId = "a".repeat(32);
      const accepted = admitCodexCliUpdateJob({ requestId, planId, confirmed: true, configDir });
      const replay = admitCodexCliUpdateJob({ requestId, planId, confirmed: true, configDir });
      expect(accepted.kind).toBe("accepted");
      expect(replay.kind).toBe("duplicate");
      expect(replay.job.jobId).toBe(accepted.job.jobId);
      expect(() => admitCodexCliUpdateJob({ requestId, planId: "b".repeat(32), confirmed: true, configDir })).toThrow("idempotency_conflict");
      const previousHome = process.env.OPENCODEX_HOME;
      process.env.OPENCODEX_HOME = configDir;
      const statusLogs: string[] = [];
      const oldLog = console.log;
      try {
        console.log = (...values: unknown[]) => statusLogs.push(values.map(String).join(" "));
        expect(await handleCodexCliUpdateCommand(["status", accepted.job.jobId, "--json"])).toBe(0);
        expect(JSON.parse(statusLogs[0]!)).toMatchObject({ jobId: accepted.job.jobId, ownerState: "active" });
      } finally {
        console.log = oldLog;
        if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
      }

      let installerRuns = 0;
      const terminal = await runCodexCliUpdateJob(accepted.job.jobId, accepted.generation, async () => {
        expect(readCodexCliUpdateJob(accepted.job.jobId, configDir)).toMatchObject({ status: "running", ownerState: "active" });
        installerRuns += 1;
        return { outcome: "applied", reason: "verified_target", planId, installedVersion: "1.0.0", targetVersion: "1.1.0",
          installerExitCode: 0, leaseRetained: false, verificationPid: null, cleanupErrors: [] };
      }, configDir);
      expect(installerRuns).toBe(1);
      expect(terminal).toMatchObject({ status: "applied", outcome: "applied", ownerState: "finished" });
      expect(JSON.stringify(terminal)).not.toMatch(/ownerPid|generation|payloadHash|requestKey|token|path/i);
      const stale = finishCodexCliUpdateJob(accepted.job.jobId, accepted.generation, 1,
        { outcome: "refused", reason: "late_result", planId, installedVersion: null, targetVersion: null,
          installerExitCode: null, leaseRetained: false, verificationPid: null, cleanupErrors: [] }, configDir);
      expect(stale?.status).toBe("applied");
      expect(readCodexCliUpdateJob(accepted.job.jobId, configDir)?.status).toBe("applied");
    } finally { rmSync(outer, { recursive: true }); }
  });

  test.skipIf(process.platform === "win32" || process.geteuid?.() === undefined)("a new owner reports a live owner's job unknown; the original generation can finish without stale overwrite", async () => {
    const { outer, configDir } = privateStoreRoot("ocx-cli-update-restart-test-");
    let release: () => void = () => {};
    let pending: Promise<unknown> | undefined;
    try {
      const accepted = admitCodexCliUpdateJob({ requestId: "restart-key-00001", planId: "c".repeat(32), confirmed: true, configDir });
      pending = runCodexCliUpdateJob(accepted.job.jobId, accepted.generation, () => new Promise(resolve => {
        release = () => resolve({ outcome: "applied", reason: "verified_target", planId: "c".repeat(32),
          installedVersion: "1.0.0", targetVersion: "1.1.0", installerExitCode: 0, leaseRetained: false,
          verificationPid: null, cleanupErrors: [] });
      }), configDir);
      expect(readCodexCliUpdateJob(accepted.job.jobId, configDir)).toMatchObject({ status: "running", ownerState: "active" });
      const modulePath = new URL("../../src/codex/cli-update-job.ts", import.meta.url).href;
      const script = `import { readCodexCliUpdateJob } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(readCodexCliUpdateJob(${JSON.stringify(accepted.job.jobId)})));`;
      const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 5_000,
        env: { ...process.env, OPENCODEX_HOME: configDir } });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      const dto = JSON.parse(child.stdout.trim());
      expect(dto).toMatchObject({ status: "ambiguous", outcome: "ambiguous", ownerState: "unknown", lifetimeUncertain: true,
        reason: "owner_state_unknown" });
      release();
      const completed = await pending;
      expect(completed).toMatchObject({ status: "applied", ownerState: "finished" });
      expect(finishCodexCliUpdateJob(accepted.job.jobId, accepted.generation, 1,
        { outcome: "refused", reason: "late_result", planId: "c".repeat(32), installedVersion: null,
          targetVersion: null, installerExitCode: null, leaseRetained: false, verificationPid: null,
          cleanupErrors: [] }, configDir)?.status).toBe("applied");
    } finally {
      release();
      if (pending) await pending.catch(() => undefined);
      rmSync(outer, { recursive: true });
    }
  });

  test.skipIf(process.platform === "win32" || process.geteuid?.() === undefined)("an exception without close evidence preserves child and lease uncertainty", async () => {
    const { outer, configDir } = privateStoreRoot("ocx-cli-update-unknown-child-test-");
    try {
      const accepted = admitCodexCliUpdateJob({ requestId: "unknown-child-0001", planId: "f".repeat(32), confirmed: true, configDir });
      const result = await runCodexCliUpdateJob(accepted.job.jobId, accepted.generation,
        async () => { throw new Error("unobservable child exception"); }, configDir);
      expect(result).toMatchObject({ status: "ambiguous", outcome: "ambiguous", ownerState: "finished",
        childState: "unknown", leaseState: "unknown", lifetimeUncertain: true, reason: "job_result_unknown" });
    } finally { rmSync(outer, { recursive: true }); }
  });

  test.skipIf(process.platform === "win32" || process.geteuid?.() === undefined)("an engine exception while its fixture child is live reports unknown child state", async () => {
    const { outer, configDir } = privateStoreRoot("ocx-cli-update-live-child-test-");
    let child: ChildProcess | undefined;
    try {
      const accepted = admitCodexCliUpdateJob({ requestId: "live-child-exception-001", planId: "9".repeat(32), confirmed: true, configDir });
      const result = await runCodexCliUpdateJob(accepted.job.jobId, accepted.generation, async () => {
        child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
        await new Promise<void>((resolve, reject) => {
          child!.once("spawn", resolve);
          child!.once("error", reject);
          child!.once("exit", () => reject(new Error("fixture child exited before the engine exception")));
        });
        if (!child?.pid) throw new Error("fixture child did not expose its process id");
        process.kill(child.pid, 0);
        throw new Error("simulated engine error after fixture child started");
      }, configDir);
      if (!child?.pid) throw new Error("fixture child process identity was lost");
      process.kill(child.pid, 0);
      expect(result).toMatchObject({ status: "ambiguous", outcome: "ambiguous", ownerState: "finished",
        childState: "unknown", leaseState: "unknown", lifetimeUncertain: true, reason: "job_result_unknown" });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>(resolve => child!.once("exit", () => resolve()));
        child.kill("SIGTERM");
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); })]);
        if (timer) clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await closed;
        }
      }
      rmSync(outer, { recursive: true });
    }
  });

  test("parses job status and stable apply request IDs", () => {
    const planId = "d".repeat(32);
    const jobId = "12345678-1234-1234-1234-123456789012";
    expect(parseCodexCliUpdateArgs(["apply", "--plan-id", planId, "--yes", "--request-id", "retry-key-123456"])).toMatchObject({
      action: "apply", planId, requestId: "retry-key-123456",
    });
    expect(parseCodexCliUpdateArgs(["status", jobId])).toEqual({ action: "status", json: false, jobId });
    expect(() => parseCodexCliUpdateArgs(["apply", "--plan-id", planId, "--yes", "--request-id", "short"])).toThrow();
  });

  test("bare attest selects the proof-bound candidate and forwards the derived input", async () => {
    expect(parseCodexCliUpdateArgs(["attest"])).toEqual({ json: false, attest: "selected" });
    expect(parseCodexCliUpdateArgs(["attest", "--json"])).toEqual({ json: true, attest: "selected" });
    expect(parseCodexCliUpdateArgs(["--json", "attest"])).toEqual({ json: true, attest: "selected" });
    const proof = "M".repeat(43);
    const env: NodeJS.ProcessEnv = {
      [NODE_LAUNCH_CONTEXT_ENV]: JSON.stringify({
        version: 1,
        proof,
        anthropicEnvSlots: [],
        codexCliInspectionEnv: {
          codexCliPath: "C:\\managed\\codex.cmd",
          path: "C:\\managed",
          pathExt: ".CMD",
          managerRoots: {},
          configDir: "C:\\opencodex",
        },
      }),
    };
    initializeNodeLauncherContext(["bun", "cli", `${NODE_LAUNCH_PROOF_PREFIX}${proof}`], env);
    const logs: string[] = [];
    const oldLog = console.log;
    let snapshot: unknown;
    let received: unknown;
    try {
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      expect(await handleCodexCliUpdateCommand(["attest", "--json"], {
        deriveInstallationInput: async input => {
          snapshot = input;
          return { kind: "derived", input: { ...identityInput, candidateSource: "selected" as const } };
        },
        inspectIdentity: async input => { received = input; return identityReport; },
      })).toBe(0);
      expect(snapshot).toEqual({
        codexCliPath: "C:\\managed\\codex.cmd",
        path: "C:\\managed",
        pathExt: ".CMD",
      });
      expect(received).toEqual({ ...identityInput, candidateSource: "selected" });
      expect(JSON.parse(logs[0]!)).toEqual(identityReport);
    } finally {
      console.log = oldLog;
      initializeNodeLauncherContext(["bun", "cli"], {});
    }
  });

  test("bare attest without a launch proof reports an unavailable selected candidate", async () => {
    initializeNodeLauncherContext(["bun", "cli"], {});
    const logs: string[] = [];
    const oldLog = console.log;
    let inspectCalls = 0;
    try {
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      expect(await handleCodexCliUpdateCommand(["attest", "--json"], {
        deriveInstallationInput: async () => ({ kind: "unavailable", reason: "candidate_unavailable" }),
        inspectIdentity: async () => { inspectCalls += 1; return identityReport; },
      })).toBe(0);
      expect(inspectCalls).toBe(0);
      expect(JSON.parse(logs[0]!)).toMatchObject({
        status: "refused",
        reason: "candidate_unavailable",
        candidateSource: "selected",
        installationIdentityObserved: false,
        selectionAttested: false,
        managed: false,
        applyAllowed: false,
      });
    } finally {
      console.log = oldLog;
    }
  });

  test("attest requires all explicit paths and accepts the shared JSON flag positions", () => {
    expect(parseCodexCliUpdateArgs(attestArgs)).toEqual({ json: false, attest: identityInput });
    for (const flag of ["--json", "--json=true", "-json", "—json"]) {
      expect(parseCodexCliUpdateArgs([flag, ...attestArgs])).toEqual({ json: true, attest: identityInput });
      expect(parseCodexCliUpdateArgs([...attestArgs, flag])).toEqual({ json: true, attest: identityInput });
    }
  });

  test("malformed attest paths and options fail before either inspector is called", async () => {
    const invalid = [
      attestArgs.slice(0, -2), attestArgs.slice(0, -1),
      [...attestArgs, "--node", identityInput.node], [...attestArgs, "--unknown", "/hidden"],
      [...attestArgs, "extra"], [...attestArgs, "--json", "--json=true"],
      ...["", " ", "relative/codex", "C:codex.cmd", "\\codex.cmd", "--node", "C:\\bad\npath"].map(
        candidate => ["attest", "--candidate", candidate, ...attestArgs.slice(3)],
      ),
    ];
    const oldError = console.error;
    let calls = 0;
    try {
      console.error = () => {};
      for (const args of invalid) {
        expect(await handleCodexCliUpdateCommand(args, {
          inspectInstall: async () => { calls += 1; return report; },
          inspectIdentity: async () => { calls += 1; return identityReport; },
        })).toBe(2);
      }
      expect(calls).toBe(0);
    } finally { console.error = oldError; }
  });

  test("attest passes only explicit input and publishes a redacted observation, not update authority", async () => {
    const logs: string[] = [];
    const oldLog = console.log;
    let received: CodexCliInstallationIdentityInput | undefined;
    let checkCalls = 0;
    try {
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      expect(await handleCodexCliUpdateCommand([...attestArgs, "--json"], {
        inspectInstall: async () => { checkCalls += 1; return report; },
        inspectIdentity: async input => { received = input; return identityReport; },
      })).toBe(0);
      expect(received).toEqual(identityInput);
      expect(checkCalls).toBe(0);
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toEqual(identityReport);
      expect(JSON.parse(logs[0]!)).toMatchObject({
        installationIdentityObserved: true, selectionAttested: false, managed: false, applyAllowed: false,
      });
      for (const path of Object.values(identityInput)) expect(logs[0]).not.toContain(path);
    } finally { console.log = oldLog; }
  });

  test("attest text states observation limits and preserves refusal without leaking paths", async () => {
    const logs: string[] = [];
    const oldLog = console.log;
    try {
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      expect(await handleCodexCliUpdateCommand(attestArgs, { inspectIdentity: async () => identityReport })).toBe(0);
      expect(logs).toContain("selection-attested: no");
      expect(logs).toContain("managed: no");
      expect(logs).toContain("apply-allowed: no");
      expect(logs).toContain("toolchain: observed-only");
      expect(logs).toContain("scope: installation identity only; runtime selection and update ownership are not attested");
      logs.length = 0;
      const refused: CodexCliInstallationIdentityReport = {
        ...identityReport, status: "refused", reason: "package_mismatch", installationIdentityObserved: false,
        packageVersion: null, npmVersion: null, identityDigest: null, proof: null,
      };
      expect(await handleCodexCliUpdateCommand([...attestArgs, "--json"], { inspectIdentity: async () => refused })).toBe(0);
      expect(JSON.parse(logs[0]!)).toEqual(refused);
    } finally { console.log = oldLog; }
  });

  test("unexpected attest errors do not publish native errors containing explicit paths", async () => {
    const errors: string[] = [];
    const oldError = console.error;
    try {
      console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
      expect(await handleCodexCliUpdateCommand(attestArgs, {
        inspectIdentity: async () => { throw new Error(`Cannot read ${identityInput.node}`); },
      })).toBe(1);
      expect(errors.join("\n")).toContain("Installation identity inspection failed");
      expect(errors.join("\n")).not.toContain(identityInput.node);
    } finally { console.error = oldError; }
  });

  test("parses the shared JSON flag spellings within the exact check grammar", () => {
    expect(parseCodexCliUpdateArgs(["check"])).toEqual({ action: "check", json: false });
    for (const flag of ["--json", "--json=true", "-json", "—json"]) {
      expect(parseCodexCliUpdateArgs(["check", flag])).toEqual({ action: "check", json: true });
    }
    for (const args of [
      ["check", "--channel", "latest"],
      ["dry-run"],
      ["apply"],
      ["check", "--json", "--json"],
      ["check", "-json", "--json=true"],
    ]) expect(() => parseCodexCliUpdateArgs(args)).toThrow();
  });

  /**
   * `--json` is accepted in any argv position CLI-wide, so automation that puts output
   * flags ahead of the subcommand must not get a usage error.
   */
  test("the JSON flag is accepted before the check action", () => {
    for (const flag of ["--json", "--json=true", "-json", "—json"]) {
      expect(parseCodexCliUpdateArgs([flag, "check"])).toEqual({ action: "check", json: true });
    }
    // Duplicate detection and positional validation still hold in that order.
    expect(() => parseCodexCliUpdateArgs(["--json", "check", "--json"])).toThrow();
    expect(() => parseCodexCliUpdateArgs(["--json"])).toThrow();
    expect(() => parseCodexCliUpdateArgs(["--json", "apply"])).toThrow();
    expect(() => parseCodexCliUpdateArgs(["--json", "check", "extra"])).toThrow();
  });

  test("malformed input performs no inspection", async () => {
    let inspectedCalls = 0;
    const code = await handleCodexCliUpdateCommand(["apply"], {
      inspectInstall: async () => { inspectedCalls += 1; return report; },
    });
    expect(code).toBe(2);
    expect(inspectedCalls).toBe(0);
  });

  test("check inspects exactly once", async () => {
    let inspectedCalls = 0;
    let received: CodexCliInstallProvenanceDeps | null = null;
    expect(await handleCodexCliUpdateCommand(["check", "--json"], {
      inspectInstall: async deps => { inspectedCalls += 1; received = deps; return report; },
    })).toBe(0);
    expect(inspectedCalls).toBe(1);
    // A bare check answers ownership only; the bounded content read is reserved
    // for the plan path whose planId binds the digest.
    expect(received?.observeInstallContent).not.toBe(true);
  });

  test("passes only proof-bound manager roots into production provenance inspection", async () => {
    const proof = "M".repeat(43);
    const configDir = process.platform === "win32" ? "C:\\opencodex" : "/opencodex";
    const env: NodeJS.ProcessEnv = {
      [NODE_LAUNCH_CONTEXT_ENV]: JSON.stringify({
        version: 1,
        proof,
        anthropicEnvSlots: [],
        codexCliInspectionEnv: {
          codexCliPath: "C:\\managed\\codex.cmd",
          path: "C:\\managed",
          pathExt: ".CMD",
          home: "C:\\managed-home",
          nodePath: "C:\\managed-modules",
          managerRoots: { FNM_DIR: "C:\\custom-manager" },
          configDir,
        },
      }),
    };
    initializeNodeLauncherContext(["bun", "cli", `${NODE_LAUNCH_PROOF_PREFIX}${proof}`], env);
    let received: CodexCliInstallProvenanceDeps | null = null;
    try {
      expect(await handleCodexCliUpdateCommand(["check", "--json"], {
        inspectInstall: async deps => {
          received = deps;
          return report;
        },
        // The command asks the resolver which executable it would select; the
        // inspector then requires it to match the attested candidate.
        resolveSelectedRuntime: () => ({
          runtime: { command: "C:\\managed\\codex.cmd", version: null, source: "environment" },
          failures: [],
        }),
      })).toBe(0);
      expect(received?.env).toEqual({
        FNM_DIR: "C:\\custom-manager",
        CODEX_CLI_PATH: "C:\\managed\\codex.cmd",
        PATH: "C:\\managed",
        PATHEXT: ".CMD",
        HOME: "C:\\managed-home",
        NODE_PATH: "C:\\managed-modules",
      });
      expect(received?.configDir).toBe(configDir);
      expect(received?.selectedCommand).toBe(process.platform === "win32" ? null : "C:\\managed\\codex.cmd");
    } finally {
      initializeNodeLauncherContext(["bun", "cli"], {});
    }
  });

  test("a launch without proof passes only sealed inspection dependencies", async () => {
    initializeNodeLauncherContext(["bun", "cli"], {});
    let received: CodexCliInstallProvenanceDeps | null = null;
    try {
      expect(await handleCodexCliUpdateCommand(["check", "--json"], {
        inspectInstall: async deps => {
          received = deps;
          return report;
        },
      })).toBe(0);
      expect(received?.env).toEqual({ PATH: "" });
      expect(received?.configDir).toBe(".");
    } finally {
      initializeNodeLauncherContext(["bun", "cli"], {});
    }
  });

  test("JSON output serializes only the public report once", async () => {
    const logs: string[] = [];
    const oldLog = console.log;
    try {
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      const code = await handleCodexCliUpdateCommand(["check", "--json"], {
        inspectInstall: async () => report,
      });
      expect(code).toBe(0);
      expect(logs).toHaveLength(1);
      const output = JSON.parse(logs[0]!) as Record<string, unknown>;
      expect(output).toEqual(report);
      expect(output).toMatchObject({
        candidateAvailable: false,
        candidateVersion: null,
        candidateSource: null,
        selectionAttested: false,
      });
      for (const stale of ["selected", "selectedVersion", "selectionSource", "selectionEvidence"]) {
        expect(stale in output).toBe(false);
      }
      expect(logs[0]).not.toContain("authority");
    } finally {
      console.log = oldLog;
    }
  });

  test("human output uses command-specific scalar lines", async () => {
    const logs: string[] = [];
    const oldLog = console.log;
    try {
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      expect(await handleCodexCliUpdateCommand(["check"], {
        inspectInstall: async () => report,
      })).toBe(0);
      expect(logs.join("\n")).not.toContain("[object Object]");
      expect(logs).toContain("candidate: no");
      expect(logs).toContain("candidate-source: unavailable");
      expect(logs).toContain("selection-attested: no");
      expect(logs).toContain("candidate-version: unavailable");
      expect(logs).toContain("package-version: unavailable");
      expect(logs).toContain("version-evidence: unavailable");
      expect(logs).toContain("location: unavailable");
      expect(logs).toContain("shim: not-tracked");
    } finally {
      console.log = oldLog;
    }
  });

  test("human output keeps mismatched candidate and package versions distinct", async () => {
    const logs: string[] = [];
    const oldLog = console.log;
    const mismatchReport: CodexCliInstallReport = {
      ...report,
      candidateAvailable: true,
      candidateVersion: "1.2.3",
      candidateSource: "persisted",
      versionEvidence: { kind: "advisory-runtime" },
      provenance: "npm-global",
      reason: "version_mismatch",
      location: "<path>/codex",
      packageVersion: "1.2.4",
    };
    try {
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      expect(await handleCodexCliUpdateCommand(["check"], {
        inspectInstall: async () => mismatchReport,
      })).toBe(0);
      expect(logs).toContain("candidate-source: persisted");
      expect(logs).toContain("candidate-version: 1.2.3");
      expect(logs).toContain("package-version: 1.2.4");
      expect(logs).toContain("version-evidence: advisory-runtime");
      expect(logs).toContain("location: <path>/codex");
      expect(logs.some(line => line.startsWith("version: "))).toBe(false);
    } finally {
      console.log = oldLog;
    }
  });
});

/**
 * Phase 2 verb. The dry-run plan is the entire surface added here: it resolves an exact
 * registry target and reports the decision, and this slice deliberately adds no apply.
 */
describe("Codex CLI update plan grammar", () => {
  test("plan defaults to the stable channel and accepts both option spellings", () => {
    expect(parseCodexCliUpdateArgs(["plan"])).toEqual({ action: "plan", json: false, channel: "latest" });
    expect(parseCodexCliUpdateArgs(["plan", "--channel", "latest"])).toEqual({ action: "plan", json: false, channel: "latest" });
    expect(parseCodexCliUpdateArgs(["plan", "--channel=latest", "--json"])).toEqual({ action: "plan", json: true, channel: "latest" });
  });

  test("unsupported actions and plan arguments are rejected", () => {
    for (const args of [
      ["apply", "--plan", "0".repeat(32)],
      ["plan", "--plan", "0".repeat(32)],
      ["plan", "--channel", "preview"],
      ["plan", "extra"],
    ]) expect(() => parseCodexCliUpdateArgs(args)).toThrow();
  });

  test("a refused dry-run is a normal answer and still exits 0", async () => {
    let inspected = 0;
    const code = await handleCodexCliUpdateCommand(["plan", "--json"], {
      inspectInstall: async () => { inspected += 1; return report; },
      createPlan: async () => ({
        schemaVersion: 1, package: "@openai/codex", channel: "latest",
        applicable: false, refusal: "not_managed", planId: null,
        provenance: "app-bundle", managed: false, installedVersion: null,
        versionEvidence: "unavailable", location: null,
        targetVersion: null, targetIntegrity: null,
        session: { state: "not-evaluated", matches: null }, command: null,
      }),
    });
    expect(code).toBe(0);
    // The plan engine owns inspection; the command must not run a second one.
    expect(inspected).toBe(0);
  });
});
