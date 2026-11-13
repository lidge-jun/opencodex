import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageVersion } from "../lib/package-version";
import { getConfigDir } from "../config/paths";
import { readConfigDiagnostics } from "../config";
import { resolveServiceOwnership } from "../service/state";
import type { ServiceOwnershipResolution } from "../service/state";
import { inspectDesktopSupervision, type SupervisionEvidence } from "../service/desktop-supervision.mjs";
import { diagnoseService } from "../service/diagnostics";
import { detectInstallOwnership, defaultUpdateTag, latestVersion } from "./index";
import { parseOrchestratedUpdateArgs, type OrchestratedUpdateArgs } from "./orchestrated-arguments.mjs";
import { buildOrchestratedPlan, type PlanInputs } from "./orchestrated-plan";
import { inspectLiveOrchestratedIdentity } from "./orchestrated-live-identity";
import type { ServingIdentity } from "./orchestrated-identity";
import { planUpdateRuntimeHandling } from "./runtime-ownership.mjs";
import { isUpdateInFlight } from "./sync-update-mutex";
import { createOrchestratedResultChannel, encodeOrchestratedExpect, type OrchestratedExpect } from "./orchestrated-session.mjs";
import { waitForOrchestratedChild } from "./orchestrated-child.mjs";
import { classifyOrchestratedOutcome, type Outcome } from "./orchestrated-outcome.mjs";
import { verifyOrchestratedInstall } from "./orchestrated-tree.mjs";
import { decideOrchestratedApply } from "./orchestrated-admission.mjs";
import { createUpdatePlanToken } from "./orchestrated-token.mjs";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { proxyIdentityAt } from "../server/proxy-liveness";
import { probeSpawn, probeSpawnSync } from "./mutation-guard.mjs";

type Request = Extract<OrchestratedUpdateArgs, { ok: true }>;
type DetectedInstaller = PlanInputs["installer"] | "standalone";
export interface OrchestratedPlanDeps {
  install(): { installer: DetectedInstaller; cliRoot: string; desktopPath: boolean };
  currentVersion(): string;
  identity(): Promise<ServingIdentity>;
  ownership(identity: ServingIdentity): { runtimeOwner: PlanInputs["runtimeOwner"]; permits: boolean };
  target(selector: string, installer: PlanInputs["installer"]): string | null;
  inFlight(): boolean;
}

export function classifyPlanRuntimeOwner(identity: ServingIdentity, owner: ServiceOwnershipResolution,
  supervision: SupervisionEvidence, serviceInstalled: boolean | null): { runtimeOwner: PlanInputs["runtimeOwner"]; permits: boolean } {
  const policy = planUpdateRuntimeHandling({ ownership: owner.kind === "owned" ? owner.ownership : null,
    ownershipUnknown: owner.kind === "unknown", serviceInstalled: serviceInstalled === true, supervision });
  const desktop = supervision.kind === "desktop" || (owner.kind === "owned" && owner.ownership.owner !== "cli");
  const uncertain = owner.kind === "unknown" || supervision.kind === "unknown" || supervision.kind === "unsupported" || serviceInstalled === null;
  const identityUnknown = identity.kind !== "live" && identity.kind !== "absent";
  const runtimeOwner = uncertain ? "unknown" : desktop ? "desktop-app" : identityUnknown ? "unknown" : identity.kind === "absent" ? "none"
    : serviceInstalled && owner.kind === "owned" && owner.ownership.owner === "cli" ? "service" : "unmanaged";
  return { runtimeOwner, permits: !uncertain && !identityUnknown && policy.mayReplacePackage };
}

const defaultDeps: OrchestratedPlanDeps = {
  install() {
    const installer = detectInstallOwnership().installer;
    const path = installer === "standalone" ? process.execPath : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    return { installer, cliRoot: realpathSync.native(path), desktopPath: /(?:[\\/]\.opencodex-desktop[\\/]|\.app[\\/]Contents[\\/])/i.test(path) };
  },
  currentVersion: packageVersion,
  async identity() {
    const config = readConfigDiagnostics({ passive: true });
    if (config.source === "fallback") return { kind: "unknown" };
    return inspectLiveOrchestratedIdentity(getConfigDir(), { port: config.config.port ?? 10100, hostname: config.config.hostname });
  },
  ownership(identity) {
    const owner = resolveServiceOwnership();
    const supervision = identity.kind === "live" ? inspectDesktopSupervision({ targetPid: identity.runtime.pid }) : { kind: "none" as const };
    let serviceInstalled: boolean | null = false;
    if (identity.kind === "live" && owner.kind === "owned" && owner.ownership.owner === "cli") {
      const service = diagnoseService();
      serviceInstalled = service.supported && !service.conflict ? service.installed : null;
    }
    return classifyPlanRuntimeOwner(identity, owner, supervision, serviceInstalled);
  },
  target: (selector, installer) => {
    if (!["npm", "pnpm", "bun"].includes(installer)) return null;
    const cache = mkdtempSync(join(tmpdir(), "ocx-registry-probe-"));
    const overrides = { npm_config_cache: cache, npm_config_logs_dir: join(cache, "logs"), npm_config_logs_max: "0",
      npm_config_update_notifier: "false", pnpm_config_cache_dir: join(cache, "pnpm-cache"),
      npm_config_cache_dir: join(cache, "pnpm-cache"), npm_config_store_dir: join(cache, "pnpm-store"),
      pnpm_config_store_dir: join(cache, "pnpm-store"), pnpm_config_state_dir: join(cache, "pnpm-state"),
      BUN_INSTALL_CACHE_DIR: join(cache, "bun-cache"), XDG_CACHE_HOME: join(cache, "xdg-cache"), XDG_STATE_HOME: join(cache, "xdg-state") };
    const keys = new Set(Object.keys(overrides).map(key => key.toLowerCase()));
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !keys.has(key.toLowerCase()))), ...overrides };
    try { return latestVersion(selector, installer as "npm" | "pnpm" | "bun", undefined, probeSpawnSync, env); }
    finally { rmSync(cache, { recursive: true, force: true }); }
  },
  inFlight: () => isUpdateInFlight(getConfigDir()),
};

/** Passive identity and plan-bound fields for a Node update child. */
export async function inspectNodeOrchestratedIdentity(cliRoot: string, targetVersion?: string, installer?: "npm" | "pnpm") {
  const root = realpathSync.native(cliRoot);
  const identity = await defaultDeps.identity();
  if (!targetVersion || !installer) return { ...identity, cliRoot: root };
  const ownership = defaultDeps.ownership(identity);
  const live = identity.kind === "live" ? identity : null;
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error("invalid package version");
  return { ...identity, cliRoot: root, permits: ownership.permits, planToken: createUpdatePlanToken({
    currentVersion: manifest.version, targetVersion, installer, cliRoot: root,
    servingRoot: live?.servingRoot ?? null, runtimeOwner: ownership.runtimeOwner, runtime: live?.runtime ?? null,
  }) };
}

export async function verifyOrchestratedChildIdentity(expected: OrchestratedExpect, targetVersion: string): Promise<boolean> {
  if (getConfigDir() !== expected.home || expected.pnpmOwner !== undefined) return false;
  const install = defaultDeps.install();
  const identity = await defaultDeps.identity();
  if (install.installer !== "bun" || install.cliRoot !== expected.cliRoot || (identity.kind !== "live" && identity.kind !== "absent")) return false;
  const live = identity.kind === "live" ? identity : null;
  if ((live?.servingRoot ?? null) !== expected.servingRoot || (live?.runtime.pid ?? null) !== expected.runtimePid) return false;
  const ownership = defaultDeps.ownership(identity);
  return ownership.permits && createUpdatePlanToken({ currentVersion: defaultDeps.currentVersion(), targetVersion,
    installer: install.installer, cliRoot: install.cliRoot, servingRoot: live?.servingRoot ?? null,
    runtimeOwner: ownership.runtimeOwner, runtime: live?.runtime ?? null }) === expected.planToken;
}

/** Observe first, then classify; failures never become permission to update. */
export async function observeOrchestratedPlan(request: Request, deps: OrchestratedPlanDeps = defaultDeps) {
  let install: ReturnType<OrchestratedPlanDeps["install"]> = { installer: "unknown", cliRoot: process.execPath, desktopPath: false };
  let currentVersion = "unknown", targetVersion: string | null = null, identity: ServingIdentity = { kind: "unknown" };
  let runtimeOwner: PlanInputs["runtimeOwner"] = "unknown", permits = false, unavailable = false, updateInFlight = true;
  try { install = deps.install(); currentVersion = deps.currentVersion(); } catch { unavailable = true; }
  try { updateInFlight = deps.inFlight(); } catch { /* indeterminate means in flight */ }
  try { identity = await deps.identity(); } catch { unavailable = true; }
  try { const owner = deps.ownership(identity); runtimeOwner = owner.runtimeOwner; permits = owner.permits; } catch { runtimeOwner = "unknown"; }
  const installer = install.installer === "standalone" ? (install.desktopPath || runtimeOwner === "desktop-app" ? "desktop-app" : "unknown") : install.installer;
  try {
    const selector = request.version ?? request.tag ?? defaultUpdateTag(currentVersion);
    const resolved = deps.target(selector, installer);
    targetVersion = request.version && resolved !== request.version ? null : resolved;
  } catch { targetVersion = null; }
  const plan = buildOrchestratedPlan({ currentVersion, targetVersion, installer, runtimeOwner, cliRoot: install.cliRoot,
    identity, ownershipPermits: permits, updateInFlight });
  return unavailable ? { ...plan, canApply: false, reason: "plan-unavailable" as const } : plan;
}

export { decideOrchestratedApply } from "./orchestrated-admission.mjs";

type Plan = Awaited<ReturnType<typeof observeOrchestratedPlan>>;
type BunDriverDeps = {
  home: string;
  identity: () => Promise<ServingIdentity>;
  now: () => number;
  spawn: (exe: string, args: string[], options: { env: Record<string, string | undefined>; stdio: ["ignore", number, number] }) => ChildProcess;
};

/** The parent owns stdout and verifies the child-reported outcome independently. */
export async function applyOrchestratedBun(plan: Plan, request: Request, deps: BunDriverDeps) {
  const base = { fromVersion: plan.currentVersion, toVersion: plan.targetVersion, installer: plan.installer,
    childExited: false, childExitCode: null, outcome: null, previousVerified: false, targetVerified: false, runtimeHealthy: false, restarted: false } as const;
  const uncertain = () => classifyOrchestratedOutcome(base);
  let channel: ReturnType<typeof createOrchestratedResultChannel> | undefined;
  let childStarted = false, childEverStarted = false;
  try {
    const before = await deps.identity();
    const live = before.kind === "live" ? before : null;
    const token = createUpdatePlanToken({ currentVersion: plan.currentVersion, targetVersion: plan.targetVersion,
      installer: plan.installer, cliRoot: plan.cliPath, servingRoot: live?.servingRoot ?? null,
      runtimeOwner: plan.runtimeOwner, runtime: live?.runtime ?? null });
    if ((before.kind !== "live" && before.kind !== "absent") || token !== plan.planToken || !plan.targetVersion) {
      return { exitCode: 10 as const, result: { ...uncertain().result, error: "plan-changed" } };
    }
    const started = deps.now();
    channel = createOrchestratedResultChannel();
    const expect = encodeOrchestratedExpect({ home: deps.home, cliRoot: plan.cliPath, servingRoot: live?.servingRoot ?? null,
      runtimePid: live?.runtime.pid ?? null, planToken: plan.planToken });
    const args = ["update", "--version", plan.targetVersion, "--orchestrated-expect", expect, "--orchestrated-result", channel.resultPath,
      ...(request.notAfter === undefined ? [] : ["--not-after", String(request.notAfter)])];
    const child = deps.spawn(process.execPath, selfLaunchArgv(args), { env: { ...process.env, OCX_UPDATE_ORCHESTRATED_CHILD: "1", OCX_UPDATE_RESULT_CAPABILITY: channel.capability }, stdio: ["ignore", 2, 2] });
    childStarted = true; childEverStarted = true;
    const waited = await waitForOrchestratedChild(child, { overrunMs: (request.notAfter ?? started) + plan.mutationBoundMs - deps.now() });
    if (!waited.confirmed) {
      child.unref();
      if (waited.reason === "overrun") return { exitCode: 12 as const, result: { ...uncertain().result, error: "overrun" } };
      return uncertain();
    }
    childStarted = false;
    const outcome = channel.read() as Outcome | null;
    const activeRoot = outcome?.phase === "installed" ? outcome.activeRoot : plan.cliPath;
    const targetVerified = outcome?.phase === "installed" && activeRoot === plan.cliPath
      && verifyOrchestratedInstall(activeRoot, plan.targetVersion, "bun");
    const previousVerified = verifyOrchestratedInstall(plan.cliPath, plan.currentVersion, "bun");
    let runtimeHealthy = !plan.restartRequired, restarted = false;
    if (plan.restartRequired) {
      try {
      const after = await deps.identity();
      if (after.kind === "live" && after.servingRoot === activeRoot) {
        const health = await proxyIdentityAt(after.runtime.port, { hostname: after.runtime.hostname, expectedPid: after.runtime.pid });
        runtimeHealthy = health?.version === (outcome?.phase === "installed" ? plan.targetVersion : plan.currentVersion);
        restarted = after.runtime.pid !== live?.runtime.pid;
      }
      } catch {
        return { exitCode: 12 as const, result: { ...uncertain().result, applied: targetVerified, error: "runtime-unverified" } };
      }
    }
    return classifyOrchestratedOutcome({ ...base, childExited: true, childExitCode: waited.code, outcome,
      previousVerified, targetVerified, runtimeHealthy, restarted });
  } catch {
    if (childEverStarted) return uncertain();
    return { exitCode: 10 as const, result: { ...uncertain().result, error: "plan-unavailable" } };
  } finally {
    if (channel && !childStarted) channel.dispose();
  }
}

export async function runOrchestratedUpdate(argv: string[]): Promise<number> {
  const parsed = parseOrchestratedUpdateArgs(argv);
  if (!parsed.ok) {
    console.log(JSON.stringify({ error: "usage" }));
    console.error("Usage: ocx update (--plan | --yes) --json [--tag latest|preview | --version <version>]");
    return 64;
  }
  const plan = await observeOrchestratedPlan(parsed);
  if (parsed.mode === "plan") {
    console.log(JSON.stringify(plan));
    return 0;
  }
  const admission = decideOrchestratedApply(plan, parsed, Date.now());
  if (admission.kind === "done") {
    console.log(JSON.stringify(admission.result));
    return admission.exitCode;
  }
  if (plan.installer === "bun") {
    const result = await applyOrchestratedBun(plan, parsed, { home: getConfigDir(), identity: defaultDeps.identity,
      now: Date.now, spawn: (exe, args, options) => probeSpawn(exe, args, options) });
    console.log(JSON.stringify(result.result));
    return result.exitCode;
  }
  console.log(JSON.stringify({ schema: "ocx.update.result/1", applied: false, fromVersion: plan.currentVersion,
    toVersion: null, installer: plan.installer, restarted: false, healthy: false, rolledBack: false, error: plan.reason ?? "plan-unavailable" }));
  return 10;
}
