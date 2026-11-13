import { realpathSync } from "node:fs";
import { decideOrchestratedApply } from "./orchestrated-admission.mjs";
import { createOrchestratedResultChannel, encodeOrchestratedExpect } from "./orchestrated-session.mjs";
import { createUpdatePlanToken } from "./orchestrated-token.mjs";
import { waitForOrchestratedChild } from "./orchestrated-child.mjs";
import { classifyOrchestratedOutcome } from "./orchestrated-outcome.mjs";
import { verifyOrchestratedInstall } from "./orchestrated-tree.mjs";
import { canonicalOrchestratedPnpmOwner, verifyOrchestratedPnpmInstall } from "./orchestrated-pnpm.mjs";
import { resolvePnpmGlobalOwner } from "./pnpm-global-install.mjs";
import { parseOrchestratedUpdateArgs } from "./orchestrated-arguments.mjs";

const BOUND = 900_000;

/** Parent retains stdout and independently verifies all child-reported effects. */
export async function applyNodeOrchestratedUpdate(request, deps) {
  let started = false, exited = false, channel;
  let plan;
  const base = () => ({ fromVersion: plan?.currentVersion ?? deps.currentVersion, toVersion: plan?.targetVersion ?? null,
    installer: deps.installer, childExited: false, childExitCode: null, outcome: null, previousVerified: false,
    targetVerified: false, runtimeHealthy: false, restarted: false });
  const uncertain = () => classifyOrchestratedOutcome(base());
  const fail = error => ({ exitCode: 10, result: { ...uncertain().result, error } });
  try {
    const bun = deps.resolveBun();
    if (!bun) return fail("plan-unavailable");
    const p = deps.plan(bun, request.version, request.tag);
    if (p.status !== 0 || p.error || p.signal || typeof p.stdout !== "string" || Buffer.byteLength(p.stdout) > 65536) return fail("plan-unavailable");
    plan = JSON.parse(p.stdout);
    const validVersion = version => typeof version === "string"
      && parseOrchestratedUpdateArgs(["--plan", "--json", "--version", version]).ok;
    if (!plan || plan.schema !== "ocx.update.plan/1" || !validVersion(plan.currentVersion)
      || !(typeof plan.targetVersion === "string" || plan.targetVersion === null) || plan.installer !== deps.installer
      || typeof plan.cliPath !== "string" || realpathSync.native(plan.cliPath) !== realpathSync.native(deps.cliRoot)
      || typeof plan.canApply !== "boolean" || typeof plan.restartRequired !== "boolean"
      || (plan.targetVersion !== null && !validVersion(plan.targetVersion))
      || (plan.canApply && (!plan.targetVersion || plan.reason !== undefined))
      || (!plan.canApply && (typeof plan.reason !== "string" || !plan.reason))
      || !["service", "desktop-app", "unmanaged", "none", "unknown"].includes(plan.runtimeOwner)
      || !(plan.servingPath === null || typeof plan.servingPath === "string") || typeof plan.updateInFlight !== "boolean"
      || typeof plan.planToken !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(plan.planToken)
      || plan.mutationBoundMs !== BOUND) throw Error("invalid plan");
    const admission = decideOrchestratedApply(plan, request, Date.now());
    if (admission.kind === "done") return admission;
    const before = deps.identity(bun);
    const live = before.kind === "live" ? before : null;
    if ((before.kind !== "live" && before.kind !== "absent") || !plan.targetVersion
      || Boolean(live) !== plan.restartRequired || (live?.servingRoot ?? null) !== plan.servingPath
      || createUpdatePlanToken({ currentVersion: plan.currentVersion, targetVersion: plan.targetVersion,
        installer: plan.installer, cliRoot: plan.cliPath, servingRoot: live?.servingRoot ?? null,
        runtimeOwner: plan.runtimeOwner, runtime: live?.runtime ?? null }) !== plan.planToken) return fail("plan-changed");
    let owner;
    if (deps.installer === "pnpm") {
      const resolved = resolvePnpmGlobalOwner({ packageName: "@bitkyc08/opencodex", packagePath: plan.cliPath,
        commandPaths: deps.pnpmCommands, runningShimPath: deps.runningShimPath, runPnpm: deps.runPnpm });
      if (!resolved.ok) return fail("plan-unavailable");
      owner = resolved.owner;
    }
    const start = Date.now();
    channel = createOrchestratedResultChannel();
    const expect = encodeOrchestratedExpect({ home: deps.home, cliRoot: plan.cliPath, servingRoot: live?.servingRoot ?? null,
      runtimePid: live?.runtime.pid ?? null, planToken: plan.planToken,
      ...(owner ? { pnpmOwner: canonicalOrchestratedPnpmOwner(owner) } : {}) });
    const args = [deps.launcher, "update", "--version", plan.targetVersion, "--orchestrated-expect", expect,
      "--orchestrated-result", channel.resultPath, ...(request.notAfter === undefined ? [] : ["--not-after", String(request.notAfter)])];
    const child = deps.spawn(process.execPath, args, { env: { ...process.env, OCX_UPDATE_ORCHESTRATED_CHILD: "1", OCX_UPDATE_RESULT_CAPABILITY: channel.capability }, stdio: ["ignore", 2, 2] });
    started = true;
    const waited = await waitForOrchestratedChild(child, { overrunMs: (request.notAfter ?? start) + BOUND - Date.now() });
    if (!waited.confirmed) {
      child.unref();
      return waited.reason === "overrun" ? { exitCode: 12, result: { ...uncertain().result, error: "overrun" } } : uncertain();
    }
    exited = true;
    const outcome = channel.read();
    const activeRoot = outcome?.phase === "installed" ? outcome.activeRoot : plan.cliPath;
    const verify = (root, version) => deps.installer === "npm"
      ? root === plan.cliPath && verifyOrchestratedInstall(root, version, "npm")
      : verifyOrchestratedPnpmInstall({ owner, activeRoot: root, version, runPnpm: deps.runPnpm });
    const targetVerified = outcome?.phase === "installed" && verify(activeRoot, plan.targetVersion);
    const previousVerified = verify(plan.cliPath, plan.currentVersion);
    let runtimeHealthy = !plan.restartRequired, restarted = false;
    if (plan.restartRequired) {
      try {
      const afterBun = deps.resolveBun();
      const after = afterBun ? deps.identity(afterBun) : null;
      if (after?.kind === "live" && after.servingRoot === activeRoot) {
        runtimeHealthy = after.healthVersion === (outcome?.phase === "installed" ? plan.targetVersion : plan.currentVersion);
        restarted = after.runtime.pid !== live?.runtime.pid;
      }
      } catch {
        return { exitCode: 12, result: { ...uncertain().result, applied: targetVerified, error: "runtime-unverified" } };
      }
    }
    return classifyOrchestratedOutcome({ ...base(), childExited: true, childExitCode: waited.code, outcome,
      previousVerified, targetVerified, runtimeHealthy, restarted });
  } catch {
    return started ? uncertain() : fail("plan-unavailable");
  } finally {
    if (channel && (!started || exited)) channel.dispose();
  }
}
