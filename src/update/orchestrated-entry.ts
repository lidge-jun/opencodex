import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageVersion } from "../lib/package-version";
import { getConfigDir } from "../config/paths";
import { detectInstallOwnership } from "./index";
import { parseOrchestratedUpdateArgs } from "./orchestrated-arguments.mjs";
import { buildOrchestratedPlan } from "./orchestrated-plan";
import { isUpdateInFlight } from "./sync-update-mutex";

/** Fail closed while the full installer and ownership observations are unavailable. */
export async function runOrchestratedUpdate(argv: string[]): Promise<number> {
  const parsed = parseOrchestratedUpdateArgs(argv);
  if (!parsed.ok) {
    console.log(JSON.stringify({ error: "usage" }));
    console.error("Usage: ocx update (--plan | --yes) --json [--tag latest|preview | --version <version>]");
    return 64;
  }
  const detected = detectInstallOwnership().installer;
  const installer = detected === "standalone"
    ? /(?:[\\/]\.opencodex-desktop[\\/]|\.app[\\/]Contents[\\/])/i.test(process.execPath) ? "desktop-app" : "unknown"
    : detected;
  let cliRoot: string;
  try {
    cliRoot = realpathSync.native(detected === "standalone" ? process.execPath : resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  } catch { cliRoot = detected === "standalone" ? process.execPath : resolve(dirname(fileURLToPath(import.meta.url)), "../.."); }
  const plan = buildOrchestratedPlan({ currentVersion: packageVersion(), targetVersion: null, installer,
    runtimeOwner: "unknown", cliRoot, identity: { kind: "unknown" }, ownershipPermits: false, updateInFlight: isUpdateInFlight(getConfigDir()) });
  const reason = ["npm", "pnpm", "bun"].includes(installer) ? "plan-unavailable" : plan.reason ?? "plan-unavailable";
  if (parsed.mode === "plan") {
    console.log(JSON.stringify({ ...plan, canApply: false, reason }));
    return 0;
  }
  console.log(JSON.stringify({ schema: "ocx.update.result/1", applied: false, fromVersion: plan.currentVersion,
    toVersion: null, installer, restarted: false, healthy: false, rolledBack: false, error: reason }));
  return 10;
}
