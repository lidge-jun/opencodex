import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageVersion } from "../lib/package-version";
import { getConfigDir } from "../config/paths";
import { readConfigDiagnostics } from "../config";
import { resolveServiceOwnership } from "../service/state";
import { inspectDesktopSupervision } from "../service/desktop-supervision.mjs";
import { detectInstallOwnership, defaultUpdateTag, latestVersion } from "./index";
import { parseOrchestratedUpdateArgs, type OrchestratedUpdateArgs } from "./orchestrated-arguments.mjs";
import { buildOrchestratedPlan, type PlanInputs } from "./orchestrated-plan";
import { inspectLiveOrchestratedIdentity } from "./orchestrated-live-identity";
import type { ServingIdentity } from "./orchestrated-identity";
import { planUpdateRuntimeHandling } from "./runtime-ownership.mjs";
import { isUpdateInFlight } from "./sync-update-mutex";

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
    const serviceInstalled = owner.kind === "owned" && owner.ownership.owner === "cli";
    const policy = planUpdateRuntimeHandling({ ownership: owner.kind === "owned" ? owner.ownership : null,
      ownershipUnknown: owner.kind === "unknown", serviceInstalled, supervision });
    const uncertain = owner.kind === "unknown" || supervision.kind === "unknown" || supervision.kind === "unsupported";
    const runtimeOwner = uncertain ? "unknown" : supervision.kind === "desktop" || (owner.kind === "owned" && owner.ownership.owner !== "cli")
      ? "desktop-app" : identity.kind === "absent" ? "none" : serviceInstalled ? "service" : "unmanaged";
    return { runtimeOwner, permits: !uncertain && policy.mayReplacePackage };
  },
  target: (selector, installer) => ["npm", "pnpm", "bun"].includes(installer) ? latestVersion(selector, installer as "npm" | "pnpm" | "bun") : null,
  inFlight: () => isUpdateInFlight(getConfigDir()),
};

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
  console.log(JSON.stringify({ schema: "ocx.update.result/1", applied: false, fromVersion: plan.currentVersion,
    toVersion: null, installer: plan.installer, restarted: false, healthy: false, rolledBack: false, error: plan.reason ?? "plan-unavailable" }));
  return 10;
}
