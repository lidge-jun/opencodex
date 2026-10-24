import type { CodexCliInstallProvenanceDeps } from "./cli-install-provenance";
import { observeCodexCliSelectedCommand } from "./cli-install-provenance";
import type { ResolveCodexRuntimeDeps, ResolveCodexRuntimeResult } from "./runtime";
import { trustedNodeLauncherContext } from "../cli/launcher-context";

/** Build the updater's only production inspection context from the Node launcher's proof-bound snapshot. */
export function codexCliUpdateInspectionDeps(deps: {
  readonly resolveSelectedRuntime?: (deps: ResolveCodexRuntimeDeps) => ResolveCodexRuntimeResult;
} = {}): CodexCliInstallProvenanceDeps {
  const trusted = trustedNodeLauncherContext()?.codexCliInspectionEnv;
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
