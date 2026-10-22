import { spawn } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync,
  realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCodexCliInstall, observeCodexCliSelectedCommand, codexCliMutationEvidence, codexCliMutationSelectionMatches,
  type CodexCliInstallProvenanceDeps, type CodexCliInstallReport } from "./cli-install-provenance";
import { createCodexCliUpdatePlan, createNpmConfigIsolation, isolatedNpmTarget,
  type CodexCliUpdatePlanDeps } from "./cli-update-plan";
import { codexCliPlatformBacking } from "./cli-install-provenance";
import { verifyCodexCliArchive,
  verifiedCodexCliContent, type CodexCliArtifact } from "./cli-update-artifacts";
import { acquireCodexCliApplyLease } from "./cli-update-lease";
import { scanCodexSessionProcesses } from "./app-server-processes";
import { observeCodexCliFileSet, observeCodexCliPreimage, sameCodexCliPreimage, codexCliExpectedFiles, sameCodexCliFiles } from "./cli-update-files";

export interface CodexCliApplyResult {
  readonly outcome: "refused" | "applied" | "not_applied" | "ambiguous";
  readonly reason: string;
  readonly planId: string;
  readonly installedVersion: string | null;
  readonly targetVersion: string | null;
  readonly installerExitCode: number | null;
  readonly leaseRetained: boolean;
  readonly verificationPid: number | null;
  readonly cleanupErrors: readonly CodexCliApplyCleanupError[];
}
export type CodexCliApplyCleanupError = "lease_release_unverified" | "lease_release_exception" | "staging_cleanup_failed";
/** Every cleanup phase is attempted even if another fails. Preserve the
 * computed readback outcome and expose path-free cleanup uncertainty separately.
 */
export function cleanupCodexCliApply(lease: ReturnType<typeof acquireCodexCliApplyLease>, staging?: string) {
  const cleanupErrors: CodexCliApplyCleanupError[] = [];
  let leaseRetained = false;
  try { if (lease && !lease.release()) { leaseRetained = true; cleanupErrors.push("lease_release_unverified"); } }
  catch { leaseRetained = true; cleanupErrors.push("lease_release_exception"); }
  try { if (staging) rmSync(staging, { recursive: true }); }
  catch { cleanupErrors.push("staging_cleanup_failed"); }
  return Object.freeze({ leaseRetained, cleanupErrors: Object.freeze(cleanupErrors) });
}
interface VersionResult { readonly terminal: boolean; readonly ok: boolean; readonly pid: number | null }
export interface CodexCliApplyDeps extends CodexCliUpdatePlanDeps {
  readonly signal?: AbortSignal;
  readonly temporaryRoot?: string;
  readonly fetchArtifact?: (artifact: CodexCliArtifact, signal?: AbortSignal) => Promise<Buffer>;
  readonly install?: (invocation: { bin: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }) => Promise<{ terminal: boolean; exitCode: number | null }>;
  readonly acquireLease?: typeof acquireCodexCliApplyLease;
  readonly verifyVersion?: (command: string, version: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<VersionResult>;
}
/** Only this owned verification child may be stopped. A deadline/kill request
 * is not terminal evidence: without close the installation lease stays held.
 * A new POSIX process group contains the launcher and its native child.
 * CODEX_HOME/HOME/TMPDIR isolate even --version's state writes in staging.
 */
export function verifyInstalledCodexVersion(command: string, version: string, cwd: string, env: NodeJS.ProcessEnv): Promise<VersionResult> {
  const home = join(cwd, "version-home");
  mkdirSync(home, { mode: 0o700 });
  return new Promise(resolve => {
    let terminal = false, failed = false, stopping = false, output = "";
    let deadline: ReturnType<typeof setTimeout> | undefined, reap: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command, ["--version"], { cwd, env: { ...env, CODEX_HOME: home, HOME: home, TMPDIR: home,
      XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home },
      stdio: ["ignore", "pipe", "ignore"], windowsHide: true, detached: process.platform !== "win32" });
    const groupGone = () => {
      if (process.platform === "win32" || !child.pid) return true;
      try { process.kill(-child.pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    };
    const finish = (closed: boolean, code: number | null) => {
      if (terminal) return;
      terminal = true; clearTimeout(deadline); clearTimeout(reap);
      const gone = closed && groupGone();
      if (!gone) child.unref(); // bounded caller; retained lease/staging and PID fence the unresolved child
      resolve({ terminal: gone, ok: gone && !failed && code === 0 && output.trim() === `codex-cli ${version}`,
        pid: gone ? null : child.pid ?? null });
    };
    const stop = () => {
      if (stopping) return;
      stopping = true; failed = true;
      // Kill only this invocation's new group, never an existing Codex session.
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch { /* close/group observation remains the exit proof */ }
      child.stdout?.destroy();
      reap = setTimeout(() => finish(false, null), 1_000);
    };
    child.stdout?.on("data", bytes => {
      if (Buffer.byteLength(output) + bytes.length > 16 * 1024) stop();
      else if (!failed) output += bytes.toString();
    });
    child.once("error", () => { failed = true; });
    child.once("close", code => finish(true, code));
    deadline = setTimeout(stop, 8_000);
  });
}
/** A close event, not a timeout/error alone, settles a spawned npm child's
 * lifetime. Abort during a running child is intentionally deferred: do not
 * kill it or release its lease/staging before terminal readback.
 */
function runNpm(invocation: { bin: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }, capture = false) {
  return new Promise<{ terminal: boolean; exitCode: number | null; stdout: string }>(resolve => {
    try {
      const child = spawn(invocation.bin, [...invocation.args], { cwd: invocation.cwd, env: invocation.env,
        stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"], windowsHide: true });
      let stdout = "";
      let overflow = false;
      child.stdout?.on("data", chunk => {
        if (stdout.length + chunk.length > 1024 * 1024) overflow = true;
        else if (!overflow) stdout += chunk.toString();
      });
      child.on("error", () => { /* close follows even when spawning failed */ });
      child.once("close", code => resolve({ terminal: true, exitCode: overflow ? null : code, stdout }));
    } catch { resolve({ terminal: true, exitCode: null, stdout: "" }); }
  });
}
async function packArtifact(artifact: CodexCliArtifact, dir: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const isolation = createNpmConfigIsolation(dir, env);
  const invocation = isolatedNpmTarget(["pack", `${artifact.name}@${artifact.version}`, "--json", "--ignore-scripts",
    "--pack-destination", dir, "--fetch-retries=0", "--fetch-timeout=120000"], isolation);
  if (!invocation) throw new Error("npm_unavailable");
  const packed = await runNpm({ bin: invocation.bin, args: invocation.args, cwd: isolation.dir, env: isolation.env }, true);
  if (packed.exitCode !== 0) throw new Error("artifact_pack_failed");
  const files = JSON.parse(packed.stdout);
  if (!Array.isArray(files) || files.length !== 1 || typeof files[0]?.filename !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(files[0].filename)) throw new Error("artifact_pack_unverified");
  const path = join(dir, files[0].filename);
  if (realpathSync.native(path) !== path) throw new Error("artifact_pack_unverified");
  return path;
}
function freshInspection(deps: CodexCliApplyDeps): CodexCliInstallProvenanceDeps {
  const inspection = { ...(deps.inspectionDeps ?? {}), platform: deps.platform ?? deps.inspectionDeps?.platform,
    observeInstallContent: true };
  return { ...inspection, selectedCommand: observeCodexCliSelectedCommand(inspection) };
}

/** POSIX non-shim only. No restart, kill, automatic retry or rollback. */
export async function applyCodexCliUpdate(planId: string, deps: CodexCliApplyDeps = {}): Promise<CodexCliApplyResult> {
  let installedVersion: string | null = null;
  let targetVersion: string | null = null;
  let exitCode: number | null = null;
  let lease: ReturnType<typeof acquireCodexCliApplyLease> = null;
  let keepLease = false;
  let staging: string | undefined;
  let started = false;
  let verificationPid: number | null = null;
  let output: CodexCliApplyResult | undefined;
  const result = (outcome: CodexCliApplyResult["outcome"], reason: string): CodexCliApplyResult =>
    output = { outcome, reason, planId, installedVersion, targetVersion, installerExitCode: exitCode, leaseRetained: keepLease, verificationPid, cleanupErrors: [] };
  try {
    if (!/^[0-9a-f]{32}$/.test(planId)) return result("refused", "invalid_plan_id");
    if ((deps.platform ?? process.platform) === "win32") return result("refused", "windows_inspection_deferred");
    if (deps.signal?.aborted) return result("refused", "cancelled");
    const inspect = deps.inspect ?? inspectCodexCliInstall;
    const first = await inspect(freshInspection(deps));
    installedVersion = first.packageVersion;
    const evidence = codexCliMutationEvidence(first);
    if (!first.managed || !evidence || first.shim.status !== "not-tracked") return result("refused", "mutation_evidence_unverified");
    const prefix = realpathSync.native(evidence.prefix);
    if (prefix !== evidence.prefix) return result("refused", "installation_prefix_changed");
    const prefixIdentity = lstatSync(prefix);
    lease = (deps.acquireLease ?? acquireCodexCliApplyLease)(prefix);
    if (!lease) return result("refused", "installation_busy");
    const freshPlan = () => createCodexCliUpdatePlan({ ...deps, inspectionDeps: freshInspection(deps) });
    const plan = await freshPlan();
    targetVersion = plan.targetVersion;
    if (!plan.applicable) return result("refused", plan.refusal ?? "plan_refused");
    if (plan.planId !== planId) return result("refused", "plan_changed");
    const artifacts = plan.targetArtifacts;
    if (!artifacts || artifacts.platform !== (deps.platform ?? process.platform)
      || artifacts.arch !== (deps.inspectionDeps?.arch ?? process.arch)) return result("refused", "target_artifacts_unverified");
    staging = mkdtempSync(join(deps.temporaryRoot ?? tmpdir(), "ocx-codex-cli-apply-"));
    staging = realpathSync.native(staging);
    const paths: string[] = [];
    for (const [index, artifact] of [artifacts.main, artifacts.backing].entries()) {
      let path: string;
      if (deps.fetchArtifact) {
        const bytes = await deps.fetchArtifact(artifact, deps.signal);
        path = join(staging, `${index}.tgz`);
        writeFileSync(path, bytes, { flag: "wx", mode: 0o400 });
      } else path = await packArtifact(artifact, staging, deps.inspectionDeps?.env);
      await verifyCodexCliArchive(path, artifact);
      paths.push(path);
    }
    if (deps.signal?.aborted) return result("refused", "cancelled");
    const main = await verifyCodexCliArchive(paths[0]!, artifacts.main);
    const backing = await verifyCodexCliArchive(paths[1]!, artifacts.backing);
    const expectedContent = verifiedCodexCliContent(artifacts, main, backing);
    const targetMainRoot = join(prefix, "lib", "node_modules", ...artifacts.main.installName.split("/"));
    const backingRoot = join(prefix, "lib", "node_modules", ...artifacts.backing.installName.split("/"));
    const originalRoots = [evidence.packageRoot, ...(evidence.backingRoot ? [evidence.backingRoot] : []), targetMainRoot, backingRoot];
    const original = observeCodexCliPreimage(originalRoots);
    // Metadata, content, selection and process observation are renewed after
    // potentially slow downloads; a final synchronous process check precedes spawn.
    const finalPlan = await freshPlan();
    if (!finalPlan.applicable) return result("refused", finalPlan.refusal ?? "plan_refused");
    if (finalPlan.planId !== planId) return result("refused", "plan_changed");
    const beforeInstall = await inspect(freshInspection(deps));
    const selected = codexCliMutationEvidence(beforeInstall);
    const currentPrefix = lstatSync(prefix);
    if (!selected || selected.prefix !== prefix || selected.launcher !== evidence.launcher
      || selected.canonicalLauncher !== evidence.canonicalLauncher || selected.packageRoot !== evidence.packageRoot
      || beforeInstall.installContentDigest !== plan.installContentDigest || !beforeInstall.managed
      || realpathSync.native(prefix) !== prefix || currentPrefix.dev !== prefixIdentity.dev
      || currentPrefix.ino !== prefixIdentity.ino) return result("refused", "installation_changed");
    if (deps.signal?.aborted) return result("refused", "cancelled");
    const isolation = createNpmConfigIsolation(staging, deps.inspectionDeps?.env);
    const args = ["install", "-g", "--prefix", prefix, "--offline", "--ignore-scripts", "--omit=optional",
      "--no-audit", "--no-fund", "--package-lock=false", "--update-notifier=false",
      `${artifacts.main.installName}@file:${paths[0]}`, `${artifacts.backing.installName}@file:${paths[1]}`];
    const invocation = isolatedNpmTarget(args, isolation);
    if (!invocation) return result("refused", "npm_unavailable");
    const lastScan = (deps.scanProcesses ?? scanCodexSessionProcesses)(deps.processIo ?? {});
    if (lastScan.kind !== "observed") return result("refused", "blocked_process_state_unknown");
    if (lastScan.processes.length) return result("refused", "blocked_active_session");
    started = true;
    keepLease = true;
    const installed = await (deps.install ?? runNpm)({ bin: invocation.bin, args: invocation.args,
      cwd: isolation.dir, env: isolation.env });
    exitCode = installed.exitCode;
    if (!installed.terminal) return result("ambiguous", "installer_state_unknown");
    keepLease = false;
    // Readback outranks exit code. Partial or unreadable installs are never retried.
    const after: CodexCliInstallReport = await inspect(freshInspection(deps));
    const afterEvidence = codexCliMutationEvidence(after);
    installedVersion = after.packageVersion;
    const prefixAfter = lstatSync(prefix);
    if (realpathSync.native(prefix) !== prefix || prefixAfter.dev !== prefixIdentity.dev || prefixAfter.ino !== prefixIdentity.ino) {
      return result("ambiguous", "installation_prefix_changed");
    }
    if (after.managed && afterEvidence?.prefix === prefix && afterEvidence.launcher === evidence.launcher
      && after.packageVersion === targetVersion && after.installContentDigest === expectedContent
      && sameCodexCliFiles(codexCliExpectedFiles([[afterEvidence.packageRoot, main], [backingRoot, backing]]),
        observeCodexCliFileSet([afterEvidence.packageRoot, backingRoot]))
      && codexCliMutationSelectionMatches(afterEvidence, freshInspection(deps))) {
      const layout = codexCliPlatformBacking(artifacts.platform, artifacts.arch)!;
      accessSync(afterEvidence.launcher, constants.X_OK);
      accessSync(join(backingRoot, "vendor", layout.triple, "bin", "codex"), constants.X_OK);
      keepLease = true;
      const version = await (deps.verifyVersion ?? verifyInstalledCodexVersion)(afterEvidence.launcher, targetVersion!, staging, isolation.env);
      verificationPid = version.pid;
      if (!version.terminal) return result("ambiguous", "version_process_state_unknown");
      keepLease = false;
      if (!version.ok || !codexCliMutationSelectionMatches(afterEvidence, freshInspection(deps))) return result("ambiguous", "version_readback_unverified");
      return result("applied", "verified_target");
    }
    if (afterEvidence?.prefix === prefix && after.managed && after.packageVersion === first.packageVersion
      && after.installContentDigest === plan.installContentDigest
      && sameCodexCliPreimage(original, observeCodexCliPreimage(originalRoots))
      && codexCliMutationSelectionMatches(afterEvidence, freshInspection(deps))) return result("not_applied", "original_install_unchanged");
    return result("ambiguous", "installation_readback_unverified");
  } catch {
    return result(started ? "ambiguous" : "refused", started ? "installer_or_readback_error" : "preparation_failed");
  } finally {
    if (!keepLease) {
      const cleanup = cleanupCodexCliApply(lease, staging);
      if (output) Object.assign(output, cleanup);
    }
    if (output) { Object.freeze(output.cleanupErrors); Object.freeze(output); }
  }
}
