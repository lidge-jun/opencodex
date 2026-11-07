import type { CodexCliInstallProvenanceDeps } from "./cli-install-provenance";
import { observeCodexCliSelectedCommand } from "./cli-install-provenance";
import type { ResolveCodexRuntimeDeps, ResolveCodexRuntimeResult } from "./runtime";
import { trustedNodeLauncherContext } from "../cli/launcher-context";
import type { TrustedNodeLaunchContext } from "../cli/launcher-context";

/**
 * The allowlisted, immutable launcher snapshot an update worker may receive.
 * It is the proof-bound pre-dotenv capture validated and frozen by
 * initializeNodeLauncherContext; a Worker realm never reads the parent's
 * trustedContext, so the snapshot itself is the structured-clone payload.
 */
export type CodexCliUpdateInspectionSnapshot = TrustedNodeLaunchContext["codexCliInspectionEnv"];

/**
 * Build the updater's production inspection context from one supplied
 * launcher snapshot. The selected-command observation runs in the CALLING
 * realm: a worker receives only the frozen snapshot and must derive its own
 * fresh selector evidence rather than trust a parent's pre-computed value.
 * Missing fields are never backfilled from the ambient environment; an absent
 * or untrusted snapshot fails closed exactly like a direct Bun/source launch.
 */
export function codexCliUpdateInspectionDepsFromSnapshot(
  snapshot: CodexCliUpdateInspectionSnapshot,
  deps: {
    readonly resolveSelectedRuntime?: (deps: ResolveCodexRuntimeDeps) => ResolveCodexRuntimeResult;
  } = {},
): CodexCliInstallProvenanceDeps {
  const trusted = snapshot;
  if (!trusted || trusted.managerRoots === null) return { env: { PATH: "" }, configDir: "." };
  const selectedCommand = observeCodexCliSelectedCommand({
    env: { CODEX_CLI_PATH: trusted.codexCliPath ?? undefined, PATH: trusted.path ?? undefined, PATHEXT: trusted.pathExt ?? undefined },
    configDir: trusted.configDir,
  }, deps.resolveSelectedRuntime);
  return {
    env: { ...trusted.managerRoots, ...trusted.transportEnv, CODEX_CLI_PATH: trusted.codexCliPath ?? undefined,
      PATH: trusted.path ?? undefined, PATHEXT: trusted.pathExt ?? undefined,
      HOME: trusted.home ?? undefined, NODE_PATH: trusted.nodePath ?? undefined },
    configDir: trusted.configDir, arch: trusted.arch ?? undefined,
    selectionAttested: true, selectedCommand,
  };
}

/** Build the updater's only production inspection context from the Node launcher's proof-bound snapshot. */
export function codexCliUpdateInspectionDeps(deps: {
  readonly resolveSelectedRuntime?: (deps: ResolveCodexRuntimeDeps) => ResolveCodexRuntimeResult;
} = {}): CodexCliInstallProvenanceDeps {
  return codexCliUpdateInspectionDepsFromSnapshot(trustedNodeLauncherContext()?.codexCliInspectionEnv ?? null, deps);
}
