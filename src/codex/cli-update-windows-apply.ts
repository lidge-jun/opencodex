import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import type { CodexCliApplyDeps, CodexCliApplyResult, CodexCliApplyCleanupError } from "./cli-update-apply";
import { createCodexCliUpdatePlan, createNpmConfigIsolation } from "./cli-update-plan";
import { inspectCodexCliInstall, observeCodexCliSelectedCommand } from "./cli-install-provenance";
import { holdWindowsCodexCliPlanToolchain, windowsCodexCliPlanEvidence, windowsCodexCliSelectionMatches } from "./cli-windows-plan-provenance";
import { openWindowsCliApplyAuthority, WindowsCliToolchainCleanupError, type WindowsApplyAcquisition } from "./cli-update-job-store-windows";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../lib/windows-secret-acl";
import { verifyWindowsCodexCliLayout, matchesWindowsCodexCliLayout } from "./cli-update-windows-layout";
import { observeWindowsInstall, sameWindowsInstall, sameWindowsPreservedEntries, windowsCodexOwnedPath,
  type WindowsInstallSnapshot } from "./cli-update-windows-observation";
import { scanCodexSessionProcesses } from "./app-server-processes";
import { startWindowsCliChild, cleanupUnstartedWindowsChild, type WindowsCliChild,
  type WindowsCliChildInvocation, type WindowsCliChildResult } from "./windows-cli-child";
import { windowsNpmExecutionArgs } from "./windows-npm-execution";

type Authority = Awaited<ReturnType<typeof openWindowsCliApplyAuthority>>;
type Toolchain = NonNullable<Awaited<ReturnType<typeof holdWindowsCodexCliPlanToolchain>>>;
interface Owner { retention?: { release(): void }; authority: Authority; staging: string; toolchain: Toolchain | null; child?: WindowsCliChild;
  recover?: () => Promise<boolean> }
// Strong owners survive an uncertain native wait and the HTTP/CLI caller returning.
// Never collect these as ordinary cleanup, infer terminal from a PID, or start a retry.
const retained = new Set<Owner>();
/** Explicit same-process reconciliation, using only the retained original native
 * process/Job handles. Never retry installation or infer termination from a PID.
 */
export async function recoverWindowsCodexCliInstallations(): Promise<number> {
  let recovered = 0;
  for (const owner of retained) if (await owner.recover?.()) recovered++;
  return recovered;
}

function npmArgs(args: readonly string[], isolation: ReturnType<typeof createNpmConfigIsolation>) {
  return [...args, "--registry=https://registry.npmjs.org", `--userconfig=${isolation.npmrc}`,
    `--globalconfig=${isolation.globalNpmrc}`, `--cache=${isolation.cache}`];
}
function expectedDirectories(files: readonly { relativePath: string }[], snapshot: WindowsInstallSnapshot): boolean {
  const expected = new Set<string>();
  for (const file of files) {
    const parts = file.relativePath.split("/");
    for (let i = 3; i < parts.length; i++) expected.add(parts.slice(0, i).join("/"));
  }
  const directories = snapshot.directories.filter(dir => windowsCodexOwnedPath(dir.split(":")[0]!));
  return directories.length === expected.size && [...expected].every(path =>
    directories.some(directory => directory.startsWith(path + ":")));
}

/** Explicit apply only. Shared prefix entries are bounded preservation obligations; ARM64 refuses.
 * Outcomes describe the scoped installation's observed state, never filesystem-wide no-I/O.
 * The existing admission layer owns confirmed/planId and durable result persistence.
 */
export async function applyWindowsCodexCliUpdate(planId: string, deps: CodexCliApplyDeps): Promise<CodexCliApplyResult> {
  const cancelled = () => deps.signal?.aborted === true || deps.isCancelled?.() === true;
  let owner: Owner | undefined, uncertain = false, cleanupPending = false, installerStarted = false;
  let ownerRegistrationPending = false;
  let installationWindowHeld = false;
  let recoveryAllowed = false;
  let installedVersion: string | null = null, targetVersion: string | null = null, exitCode: number | null = null;
  let verificationPid: number | null = null, output: CodexCliApplyResult | undefined;
  const finish = (outcome: CodexCliApplyResult["outcome"], reason: string): CodexCliApplyResult => output = {
    outcome, reason, planId, installedVersion, targetVersion, installerExitCode: exitCode,
    leaseRetained: uncertain || cleanupPending || ownerRegistrationPending, verificationPid, cleanupErrors: cleanupPending ? ["child_cleanup_failed"] : [],
  };
  const inspection = () => {
    const input = { ...deps.inspectionDeps, platform: "win32" as const, observeInstallContent: true };
    return { ...input, selectedCommand: observeCodexCliSelectedCommand(input) };
  };
  const inspect = () => (deps.inspect ?? inspectCodexCliInstall)(inspection());
  const plan = () => createCodexCliUpdatePlan({ ...deps, platform: "win32", inspectionDeps: inspection() });
  const settle = async (child: WindowsCliChild): Promise<WindowsCliChildResult> => {
    if (!owner) throw new Error("ownership_required");

    if (!child.process) {
      const cleaned = await cleanupUnstartedWindowsChild(child);
      uncertain = false; cleanupPending = !cleaned;
      if (cleaned) owner.child = undefined;
      return { terminal: true, cleanupComplete: cleaned, exitCode: null, stdout: "", failed: true, overflow: false, reason: child.setupFailure };
    }
    const result = await child.wait();
    uncertain = !result.terminal;
    cleanupPending = result.terminal && !result.cleanupComplete;
    if (result.terminal && result.cleanupComplete) owner.child = undefined;
    return result;
  };
  const startOwned = (invocation: WindowsCliChildInvocation): WindowsCliChild => {
    if (!owner || owner.child) throw new Error("child_cleanup_pending");
    uncertain = true; // A throwing start may already have created native resources.
    const jobName = installerStarted ? `Global\\ocx-cli-${randomUUID()}` : undefined;
    const proof = jobName ? deps.commitWindow?.childStarting?.(jobName) : undefined;
    const child = owner.child = (deps.startWindowsChild ?? startWindowsCliChild)({ ...invocation,
      recoveryJobName: jobName, recoveryProof: proof || undefined });
    if (jobName && child.pid && child.creationTime) deps.commitWindow?.childStarted?.(child.pid,
      { jobName, creationTime: child.creationTime });
    return child;
  };
  const run = async (invocation: WindowsCliChildInvocation): Promise<WindowsCliChildResult> => {
    if (!owner) throw new Error("ownership_required");
    await owner.authority.verify();
    if (!installerStarted && cancelled()) throw new Error("cancelled");
    return settle(startOwned(invocation));
  };
  try {
    if (!/^[0-9a-f]{32}$/.test(planId)) return finish("refused", "invalid_plan_id");
    if (process.platform !== "win32" || process.arch !== "x64") return finish("refused", "windows_inspection_deferred");
    if (cancelled()) return finish("refused", "cancelled");
    const first = await inspect(), evidence = windowsCodexCliPlanEvidence(first);
    installedVersion = first.packageVersion;
    if (!first.managed || !evidence || evidence.arch !== "x64") return finish("refused", "mutation_evidence_unverified");
    if (cancelled()) return finish("refused", "cancelled");
    const initialPlan = await plan(); targetVersion = initialPlan.targetVersion;
    if (cancelled()) return finish("refused", "cancelled");
    if (!initialPlan.applicable) return finish("refused", initialPlan.refusal ?? "plan_refused");
    if (initialPlan.planId !== planId) return finish("refused", "plan_changed");
    const artifacts = initialPlan.targetArtifacts;
    if (!artifacts || artifacts.platform !== "win32" || artifacts.arch !== "x64") return finish("refused", "target_artifacts_unverified");
    // Root the acquisition anchor before await/Owner registration. If registration
    // throws, the Worker token still owns any acquired authority through this anchor.
    const anchor: { acquisition?: WindowsApplyAcquisition; authority?: Authority; owner?: Owner } = {};
    const retention = deps.retainExecution?.(anchor);
    let authority: Authority;
    try {
      authority = anchor.authority = await openWindowsCliApplyAuthority(evidence.prefix, true,
        acquisition => { anchor.acquisition = acquisition; });
    } catch (error) {
      // Authority's finally has already attempted cleanup, without retrying failed pins.
      // A rejected acquisition can still own handles even though no Authority was returned.
      if (anchor.acquisition && !anchor.acquisition.releaseIfClean(retention)) {
        ownerRegistrationPending = true;
        return finish("ambiguous", "installer_or_readback_error");
      }
      if (!anchor.acquisition) retention?.release(); // Native load/validation failed before any ctx existed.
      return finish("refused", error instanceof Error && error.message === "job_store_busy"
        ? "installation_busy" : "installation_prefix_unsupported");
    }
    ownerRegistrationPending = true;
    owner = anchor.owner = { retention, authority, staging: win32.join(authority.lock, "stage"), toolchain: null };
    retained.add(owner);
    ownerRegistrationPending = false;
    let recovering = false, recoveryTerminal = false;
    owner.recover = async () => {
      if (!recoveryAllowed || recovering || !owner || (!recoveryTerminal
        && (!uncertain || !owner.child || !owner.child.process || !owner.child.observe().terminal))) return false;
      recovering = true;
      try {
        if (!recoveryTerminal) {
          const settled = await settle(owner.child!);
          if (!settled.terminal || !settled.cleanupComplete) return false;
          recoveryTerminal = true; // Survives transient authority/readback failure.
        }
        // Readback is required before reopening the shared installation, even
        // though this recovery never upgrades the earlier ambiguous job result.
        await owner.authority.verify();
        await observeWindowsInstall(evidence.prefix); await inspect();
        if (installationWindowHeld) { deps.commitWindow!.exit(); installationWindowHeld = false; }
        await flushWindowsSecretAclReapsBeforeRemoval(owner.staging);
        await owner.authority.removeStaging();
        if (owner.toolchain && !await owner.toolchain.release()) return false;
        if (!await owner.authority.release()) return false;
        retained.delete(owner); owner.retention?.release(); return true;
      } catch { return false; } finally { recovering = false; }
    };
    await authority.createStaging();
    if (cancelled()) return finish("refused", "cancelled");
    owner.toolchain = await holdWindowsCodexCliPlanToolchain(first);
    if (cancelled()) return finish("refused", "cancelled");
    if (!owner.toolchain) return finish("refused", "npm_unavailable");
    const isolation = createNpmConfigIsolation(owner.staging, deps.inspectionDeps?.env);
    // Include Windows temp/profile names: no npm or version cache may fall back to a live home.
    const env = { ...isolation.env, HOME: owner.staging, USERPROFILE: owner.staging, TEMP: owner.staging,
      TMP: owner.staging, TMPDIR: owner.staging, APPDATA: owner.staging, LOCALAPPDATA: owner.staging, CODEX_HOME: owner.staging };
    const invoke = (args: readonly string[], policy: WindowsCliChildInvocation["policy"]) => run({
      executable: evidence.node, args: windowsNpmExecutionArgs(evidence.npmCli, npmArgs(args, isolation)), cwd: isolation.dir, env, policy,
    });
    const archives: string[] = [];
    for (const [index, artifact] of [artifacts.main, artifacts.backing].entries()) {
      if (cancelled()) return finish("refused", "cancelled");
      let path: string;
      if (deps.fetchArtifact) {
        path = win32.join(owner.staging, `${index}.tgz`);
        writeFileSync(path, await deps.fetchArtifact(artifact, deps.signal), { flag: "wx" });
      } else {
        const packed = await invoke(["pack", `${artifact.name}@${artifact.version}`, "--json", "--ignore-scripts",
          "--pack-destination", owner.staging, "--fetch-retries=0", "--fetch-timeout=120000"], "pack");
        if (!packed.terminal) return finish("ambiguous", "installer_state_unknown");
        if (cleanupPending) return finish("ambiguous", "child_cleanup_unverified");
        if (packed.failed || packed.overflow || packed.exitCode !== 0) throw new Error("pack_failed");
        const names = JSON.parse(packed.stdout);
        if (!Array.isArray(names) || names.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(names[0]?.filename)) throw new Error("pack_unverified");
        path = win32.join(owner.staging, names[0].filename);
      }
      if (cancelled()) return finish("refused", "cancelled");
      archives.push(path);
    }
    const layout = await verifyWindowsCodexCliLayout(artifacts, archives[0]!, archives[1]!);
    if (cancelled()) return finish("refused", "cancelled");
    const original = await observeWindowsInstall(evidence.prefix);
    const fresh = await plan();
    if (!fresh.applicable) return finish("refused", fresh.refusal ?? "plan_refused");
    if (fresh.planId !== planId) return finish("refused", "plan_changed");
    if (cancelled()) return finish("refused", "cancelled");
    const args = ["install", "-g", "--prefix", evidence.prefix, "--offline", "--ignore-scripts", "--omit=optional",
      "--no-audit", "--no-fund", "--package-lock=false", "--update-notifier=false",
      `${artifacts.main.installName}@file:${archives[0]}`, `${artifacts.backing.installName}@file:${archives[1]}`];
    const invocation: WindowsCliChildInvocation = { executable: evidence.node,
      args: windowsNpmExecutionArgs(evidence.npmCli, npmArgs(args, isolation)), cwd: isolation.dir, env, policy: "installer" };
    const window = deps.commitWindow;
    let nativeChild: WindowsCliChild | undefined;
    let injectedInstall: Promise<{ terminal: boolean; exitCode: number | null }> | undefined;
    if (window) {
      installationWindowHeld = window.tryEnter() || await window.waitEnter();
      if (!installationWindowHeld) return finish("refused", cancelled() ? "cancelled" : "installation_busy");
    }
    // Renew all observations after gate acquisition, including asynchronous ACLs.
    // Acquisition is bounded; the Windows observation window is not short by guarantee.
    if (cancelled()) return finish("refused", "cancelled");
    await owner.authority.verify();
    const before = await inspect(), selected = windowsCodexCliPlanEvidence(before);
    if (!selected || JSON.stringify(selected) !== JSON.stringify(evidence)
      || before.installContentDigest !== initialPlan.installContentDigest
      || !sameWindowsInstall(original, await observeWindowsInstall(evidence.prefix))) return finish("refused", "installation_changed");
    const scan = (deps.scanProcesses ?? scanCodexSessionProcesses)(deps.processIo ?? {});
    if (scan.kind !== "observed") return finish("refused", "blocked_process_state_unknown");
    if (scan.processes.length) return finish("refused", "blocked_active_session");
    // No await from these held-identity/selection checks through CAS and native start.
    owner.authority.verifyIdentitySync();
    if (!windowsCodexCliSelectionMatches(before, inspection())) return finish("refused", "installation_changed");
    if (cancelled() || (window && !window.commit())) return finish("refused", "cancelled");
    installerStarted = true; // CAS is the irrevocable start decision, not spawn success.
    uncertain = true;
    // Trusted injection must begin its start synchronously, like native Create/Assign/Resume.
    if (deps.install) injectedInstall = deps.install({ bin: invocation.executable,
      args: invocation.args, cwd: invocation.cwd, env: invocation.env });
    else nativeChild = startOwned(invocation);
    const installed = nativeChild ? await settle(nativeChild) : await injectedInstall!;
    uncertain = !installed.terminal; exitCode = installed.exitCode;
    if (uncertain) return finish("ambiguous", "installer_state_unknown");
    if (cleanupPending) return finish("ambiguous", "child_cleanup_unverified");
    await owner.authority.verify();
    const observed = await observeWindowsInstall(evidence.prefix);
    const after = await inspect(), afterEvidence = windowsCodexCliPlanEvidence(after);
    installedVersion = after.packageVersion;
    const selectedAfter = after.managed && afterEvidence && afterEvidence.prefix === evidence.prefix
      && windowsCodexCliSelectionMatches(first, inspection())
      && afterEvidence.launcher === evidence.launcher && afterEvidence.nodeEvidence === evidence.nodeEvidence
      && afterEvidence.npmEvidence === evidence.npmEvidence;
    if (!selectedAfter) return finish("ambiguous", "installation_readback_unverified");
    if (after.packageVersion === targetVersion && sameWindowsPreservedEntries(original, observed)
      && expectedDirectories(layout.files, observed)
      && afterEvidence.backingRoot === win32.join(evidence.prefix, layout.backingRoot)
      && matchesWindowsCodexCliLayout(layout, observed.files.filter(file => windowsCodexOwnedPath(file.relativePath)))) {
      const version = await run({ executable: evidence.node, args: [win32.join(evidence.prefix, layout.mainRoot, "bin/codex.js"), "--version"],
        cwd: owner.staging, env, policy: "version" });
      verificationPid = version.terminal ? null : owner.child?.pid ?? null;
      if (!version.terminal) return finish("ambiguous", "version_process_state_unknown");
      if (cleanupPending) return finish("ambiguous", "child_cleanup_unverified");
      if (version.failed || version.overflow || version.exitCode !== 0 || version.stdout.trim() !== `codex-cli ${targetVersion}`) {
        return finish("ambiguous", "version_readback_unverified");
      }
      const final = await inspect(); await owner.authority.verify();
      if (!windowsCodexCliSelectionMatches(after, inspection()) || final.installContentDigest !== after.installContentDigest
        || !sameWindowsInstall(observed, await observeWindowsInstall(evidence.prefix))) {
        return finish("ambiguous", "version_readback_unverified");
      }
      return finish("applied", "verified_target");
    }
    if (after.packageVersion === first.packageVersion && after.installContentDigest === first.installContentDigest
      && sameWindowsInstall(original, observed)) return finish("not_applied", "original_install_unchanged");
    return finish("ambiguous", "installation_readback_unverified");
  } catch (error) {
    if (error instanceof WindowsCliToolchainCleanupError) {
      deps.retainExecution?.(error.acquisition);
      ownerRegistrationPending = true; cleanupPending = true;
      return finish("ambiguous", "installer_or_readback_error");
    }
    if (!installerStarted && !uncertain && !ownerRegistrationPending && cancelled()) return finish("refused", "cancelled");
    if (!installerStarted && !uncertain && !ownerRegistrationPending && error instanceof Error
      && ["cancelled", "installation_changed", "blocked_process_state_unknown", "blocked_active_session"].includes(error.message)) {
      return finish("refused", error.message);
    }
    return finish(installerStarted || uncertain || ownerRegistrationPending ? "ambiguous" : "refused",
      installerStarted || uncertain || ownerRegistrationPending ? "installer_or_readback_error" : "preparation_failed");
  } finally {
    recoveryAllowed = true;
    // Readback (including the version child's descendants) is inside exclusion.
    // Unknown lifetime retains the exact window instead of reopening parent paths.
    if (installationWindowHeld && !uncertain && !cleanupPending) deps.commitWindow!.exit();
    if (owner && !uncertain && !cleanupPending) {
      const errors: CodexCliApplyCleanupError[] = [];
      try {
        await flushWindowsSecretAclReapsBeforeRemoval(owner.staging);
        await owner.authority.removeStaging();
      } catch { errors.push("staging_cleanup_failed"); }
      try { if (owner.toolchain && !await owner.toolchain.release()) errors.push("lease_release_unverified"); }
      catch { errors.push("lease_release_exception"); }
      try { if (!await owner.authority.release()) errors.push("lease_release_unverified"); }
      catch { errors.push("lease_release_exception"); }
      if (!errors.length) { retained.delete(owner); ownerRegistrationPending = false; owner.retention?.release(); }
      if (output) Object.assign(output, { cleanupErrors: errors, leaseRetained: errors.length > 0 });
    }
    if (output) { Object.freeze(output.cleanupErrors); Object.freeze(output); }
  }
}
