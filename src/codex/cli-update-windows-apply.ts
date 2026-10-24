import { writeFileSync } from "node:fs";
import { win32 } from "node:path";
import type { CodexCliApplyDeps, CodexCliApplyResult, CodexCliApplyCleanupError } from "./cli-update-apply";
import { createCodexCliUpdatePlan, createNpmConfigIsolation } from "./cli-update-plan";
import { inspectCodexCliInstall, observeCodexCliSelectedCommand } from "./cli-install-provenance";
import { holdWindowsCodexCliPlanToolchain, windowsCodexCliPlanEvidence, windowsCodexCliSelectionMatches } from "./cli-windows-plan-provenance";
import { openWindowsCliApplyAuthority } from "./cli-update-job-store-windows";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../lib/windows-secret-acl";
import { verifyWindowsCodexCliLayout, matchesWindowsCodexCliLayout } from "./cli-update-windows-layout";
import { observeWindowsInstall, sameWindowsInstall, sameWindowsPreservedEntries, windowsCodexOwnedPath,
  type WindowsInstallSnapshot } from "./cli-update-windows-observation";
import { scanCodexSessionProcesses } from "./app-server-processes";
import { startWindowsCliChild, cleanupUnstartedWindowsChild, type WindowsCliChild,
  type WindowsCliChildInvocation, type WindowsCliChildResult } from "./windows-cli-child";

type Authority = Awaited<ReturnType<typeof openWindowsCliApplyAuthority>>;
type Toolchain = NonNullable<Awaited<ReturnType<typeof holdWindowsCodexCliPlanToolchain>>>;
interface Owner { authority: Authority; staging: string; toolchain: Toolchain | null; child?: WindowsCliChild }
// Strong owners survive an uncertain native wait and the HTTP/CLI caller returning.
// Never collect these as ordinary cleanup, infer terminal from a PID, or start a retry.
const retained = new Set<Owner>();

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
  let owner: Owner | undefined, uncertain = false, cleanupPending = false, installerStarted = false;
  let installedVersion: string | null = null, targetVersion: string | null = null, exitCode: number | null = null;
  let verificationPid: number | null = null, output: CodexCliApplyResult | undefined;
  const finish = (outcome: CodexCliApplyResult["outcome"], reason: string): CodexCliApplyResult => output = {
    outcome, reason, planId, installedVersion, targetVersion, installerExitCode: exitCode,
    leaseRetained: uncertain || cleanupPending, verificationPid, cleanupErrors: cleanupPending ? ["child_cleanup_failed"] : [],
  };
  const inspection = () => {
    const input = { ...deps.inspectionDeps, platform: "win32" as const, observeInstallContent: true };
    return { ...input, selectedCommand: observeCodexCliSelectedCommand(input) };
  };
  const inspect = () => (deps.inspect ?? inspectCodexCliInstall)(inspection());
  const plan = () => createCodexCliUpdatePlan({ ...deps, platform: "win32", inspectionDeps: inspection() });
  const run = async (invocation: WindowsCliChildInvocation, beforeStart?: () => void): Promise<WindowsCliChildResult> => {
    if (!owner) throw new Error("ownership_required");
    if (owner.child) throw new Error("child_cleanup_pending");
    await owner.authority.verify();
    beforeStart?.();
    uncertain = true; // Adopt every resource before even a suspended child is created.
    const child = owner.child = (deps.startWindowsChild ?? startWindowsCliChild)(invocation);
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
  try {
    if (!/^[0-9a-f]{32}$/.test(planId)) return finish("refused", "invalid_plan_id");
    if (process.platform !== "win32" || process.arch !== "x64") return finish("refused", "windows_inspection_deferred");
    if (deps.signal?.aborted) return finish("refused", "cancelled");
    const first = await inspect(), evidence = windowsCodexCliPlanEvidence(first);
    installedVersion = first.packageVersion;
    if (!first.managed || !evidence || evidence.arch !== "x64") return finish("refused", "mutation_evidence_unverified");
    const initialPlan = await plan(); targetVersion = initialPlan.targetVersion;
    if (!initialPlan.applicable) return finish("refused", initialPlan.refusal ?? "plan_refused");
    if (initialPlan.planId !== planId) return finish("refused", "plan_changed");
    const artifacts = initialPlan.targetArtifacts;
    if (!artifacts || artifacts.platform !== "win32" || artifacts.arch !== "x64") return finish("refused", "target_artifacts_unverified");
    let authority: Authority;
    try { authority = await openWindowsCliApplyAuthority(evidence.prefix, true); }
    catch (error) { return finish("refused", error instanceof Error && error.message === "job_store_busy"
      ? "installation_busy" : "installation_prefix_unsupported"); }
    owner = { authority, staging: win32.join(authority.lock, "stage"), toolchain: null };
    retained.add(owner);
    await authority.createStaging();
    owner.toolchain = await holdWindowsCodexCliPlanToolchain(first);
    if (!owner.toolchain) return finish("refused", "npm_unavailable");
    const isolation = createNpmConfigIsolation(owner.staging, deps.inspectionDeps?.env);
    // Include Windows temp/profile names: no npm or version cache may fall back to a live home.
    const env = { ...isolation.env, HOME: owner.staging, USERPROFILE: owner.staging, TEMP: owner.staging,
      TMP: owner.staging, TMPDIR: owner.staging, APPDATA: owner.staging, LOCALAPPDATA: owner.staging, CODEX_HOME: owner.staging };
    const invoke = (args: readonly string[], policy: WindowsCliChildInvocation["policy"], beforeStart?: () => void) => run({
      executable: evidence.node, args: [evidence.npmCli, ...npmArgs(args, isolation)], cwd: isolation.dir, env, policy,
    }, beforeStart);
    const archives: string[] = [];
    for (const [index, artifact] of [artifacts.main, artifacts.backing].entries()) {
      if (deps.signal?.aborted) return finish("refused", "cancelled");
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
      archives.push(path);
    }
    const layout = await verifyWindowsCodexCliLayout(artifacts, archives[0]!, archives[1]!);
    const original = await observeWindowsInstall(evidence.prefix);
    const fresh = await plan();
    if (!fresh.applicable) return finish("refused", fresh.refusal ?? "plan_refused");
    if (fresh.planId !== planId) return finish("refused", "plan_changed");
    const before = await inspect(), selected = windowsCodexCliPlanEvidence(before);
    if (!selected || JSON.stringify(selected) !== JSON.stringify(evidence)
      || before.installContentDigest !== initialPlan.installContentDigest
      || !sameWindowsInstall(original, await observeWindowsInstall(evidence.prefix))) return finish("refused", "installation_changed");
    await owner.authority.verify();
    if (deps.signal?.aborted) return finish("refused", "cancelled");
    const beforeStart = () => {
      if (deps.signal?.aborted) throw new Error("cancelled");
      if (!windowsCodexCliSelectionMatches(before, inspection())) throw new Error("installation_changed");
      const scan = (deps.scanProcesses ?? scanCodexSessionProcesses)(deps.processIo ?? {});
      if (scan.kind !== "observed") throw new Error("blocked_process_state_unknown");
      if (scan.processes.length) throw new Error("blocked_active_session");
      installerStarted = true;
    };
    const args = ["install", "-g", "--prefix", evidence.prefix, "--offline", "--ignore-scripts", "--omit=optional",
      "--no-audit", "--no-fund", "--package-lock=false", "--update-notifier=false",
      `${artifacts.main.installName}@file:${archives[0]}`, `${artifacts.backing.installName}@file:${archives[1]}`];
    // The injectable installer seam is the existing trusted test dependency, never an HTTP input.
    const installed = deps.install ? await (async () => {
      await owner!.authority.verify(); beforeStart(); uncertain = true;
      return deps.install!({ bin: evidence.node, args: [evidence.npmCli, ...npmArgs(args, isolation)], cwd: isolation.dir, env });
    })() : await invoke(args, "installer", beforeStart);
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
    if (!installerStarted && !uncertain && error instanceof Error
      && ["cancelled", "installation_changed", "blocked_process_state_unknown", "blocked_active_session"].includes(error.message)) {
      return finish("refused", error.message);
    }
    return finish(installerStarted || uncertain ? "ambiguous" : "refused", installerStarted || uncertain ? "installer_or_readback_error" : "preparation_failed");
  } finally {
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
      if (!errors.length) retained.delete(owner);
      if (output) Object.assign(output, { cleanupErrors: errors, leaseRetained: errors.length > 0 });
    }
    if (output) { Object.freeze(output.cleanupErrors); Object.freeze(output); }
  }
}
